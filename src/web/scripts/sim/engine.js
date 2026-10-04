/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// engine.js — the simulation engine. `settle` (Feature 90) resolves a purely
// combinational circuit to its stable net levels; `tick` (Feature 100) adds
// the synchronous two-phase step for stateful parts. Both are pure and
// DOM-free: no DOM, no IPC, and NO timers — the clock's timer lives in the
// renderer's SimController, which merely hands `tick` each clock's current
// output level (`clockPhase`).
//
// Power: a chip is POWERED iff its VCC net carries a PSU `+` inside its
// family's supply range and its GND net a PSU `−`; below the range it is
// underpowered (inert), above it damaged (magic smoke). 74LS and every
// family-less part: 5 V only; CD4000: 3–18 V (catalog/families.js).
// Digital abstraction with drive strengths (resolve.js): supply beats chip
// output; a clock source and a planted signal flag both drive at output
// strength; Z contributes nothing. Every ground-role pin must reach the
// supply's `−` — a CD405x's VEE as well as its VSS (single-supply use ties
// them together), an AM27C1024's two VSS pins both.
//
// Analog switches (CD4066B, CD405x) drive nothing: an ON channel JOINS two
// nets for the settle, so each resolves from the drivers of both (a supply
// crossing a switch at output strength). See `channelGroups`/`resolveAll`.
//
// The LED rule (sim/junction.js) reads a SECOND resolution, `strongLevels`:
// each net from the sources that could burn an LED — supplies and outputs,
// never a resistor's pull, and never a CD4000 output (or channel) running
// from a supply low enough that it limits the current itself
// (families.js `limitsLedCurrent`).
//
// Tick (Feature 100, extended for ripple in Feature 220):
//   ① pre-settle with the OLD sequential state (propagates the new clock phase
//      + any input change to every pin),
//   ② sample each sequential chip's inputs and `step` it, then RE-settle and
//      repeat until no chip's state changes (a bounded fixpoint) — so an
//      output→clock ripple (QA→CKB) cascades WITHIN one tick.
//   ③ the loop's final settle is the post-settle (NEW state drives outputs).
//
// Edge safety across the inner loop: every step detects edges against the
// tick's ENTRY inputs (`prevPinLevels`) plus a per-tick consumed-edge set — the
// external clock edge is consumed on the first pass (synchronous parts step
// exactly once, byte-for-byte the old two-phase result), yet a NEW internal
// edge that a just-updated output creates is still observed (ripple cascades).
//
// Timed parts (the 555, the RC-timed CD4000 parts — sim/timing.js): the engine
// still keeps no time. `tick` is handed `now` (simulated seconds, owned by
// SimController), each timed part reads its R and C off the wiring once per
// context (sim/rc-trace.js → the def's `timing`), its `step` sees
// `{now, timing}`, and the tick reports `wakeAt` — the earliest moment any of
// them next changes on its own — so the controller knows when to tick again.
// A capacitor joins no net and drives nothing; the one place the engine sees
// one is the floating-input check, where a CMOS input whose only company is a
// capacitor is not called floating.

import { H, L, Z, X } from "./levels.js";
import {
  evaluate,
  outputsOf,
  stepChip,
  inputLevels,
  initialState,
  hasBehavior,
  isSequential,
  isMemory,
  isOscillator,
  isAnalogSwitch,
  isTimed,
  wakeAtOf,
  channelStates,
  memoryOutputs,
  memoryWrite,
} from "./chip-eval.js";
import { rcTrace, timingProbe } from "./rc-trace.js";
import { resolveNet } from "./resolve.js";
import { UnionFind } from "./union-find.js";
import { partDef } from "../catalog/index.js";
import {
  familyOf,
  floatsUnknown,
  limitsLedCurrent,
  lsFanoutOf,
  supplyRange,
} from "../catalog/families.js";
import { partPinAddresses } from "../model/occupancy.js";
import { formatAddress } from "../model/breadboard.js";

/** Settle iteration cap — beyond this a still-changing net is oscillating. */
export const MAX_ITERATIONS = 200;

/**
 * Sequential-step fixpoint cap within a single `tick` (Feature 220). A ripple
 * chain settles in ~depth iterations; beyond this a self-clocking loop is
 * oscillating — its still-changing sequential nets are marked `X` and reported,
 * mirroring the combinational settle cap.
 */
export const MAX_TICK_ITERATIONS = 200;

/** Chip power/health states. Only "ok" chips drive their outputs. */
export const CHIP_STATUS = Object.freeze({
  OK: "ok",
  UNPOWERED: "unpowered",
  UNDERPOWERED: "underpowered",
  REVERSED: "reversed",
  DAMAGED: "damaged",
});

/**
 * Reversal is STRICT — both power pins must be actively wrong: a PSU `−` on
 * the VCC pin's net AND a PSU `+` on the GND pin's net. One wrong pin (the
 * other floating) is ordinary `UNPOWERED`; calling that "backwards" would
 * accuse the user of a mistake they may not have made.
 */
function powerStatus({ vccVolts, vccMinus, gndVolts, gnd, damaged, supply }) {
  if (damaged) return CHIP_STATUS.DAMAGED;
  if (vccMinus && gndVolts.length) return CHIP_STATUS.REVERSED;
  if (vccVolts.some((v) => v > supply.max)) return CHIP_STATUS.DAMAGED; // smoke
  if (gnd && vccVolts.some((v) => v >= supply.min)) return CHIP_STATUS.OK;
  if (gnd && vccVolts.length) return CHIP_STATUS.UNDERPOWERED;
  return CHIP_STATUS.UNPOWERED;
}

function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Collapse warnings so a net/chip is reported once per type. */
function dedupe(warnings) {
  const seen = new Set();
  const out = [];
  for (const w of warnings) {
    const key = `${w.type}:${w.net ?? w.chip ?? (w.nets ?? []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * Build the per-settle FIXED context from a document + netlist: supply drivers,
 * clock terminals, and the participating chips with their pin→net maps and
 * power status (all constant while the topology is frozen). Reused across a
 * tick's pre- and post-settles.
 */
function buildContext(doc, netlist) {
  const components = doc.components ?? [];
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  const netIds = [...netlist.nets.keys()];

  // Supply drivers per net.
  const supplyPlusVolts = new Map(); // netId → [volts…]
  const supplyMinus = new Set(); // netIds carrying a PSU `−`
  const clocks = []; // { id, outNet }
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (comp.kind === "psu" && def?.terminals) {
      const volts = comp.params?.volts ?? 5;
      for (const t of def.terminals) {
        const net = netOf(formatAddress(comp.id, t.id));
        if (!net) continue;
        if (t.id === "+") {
          if (!supplyPlusVolts.has(net)) supplyPlusVolts.set(net, []);
          supplyPlusVolts.get(net).push(volts);
        } else {
          supplyMinus.add(net);
        }
      }
    } else if (comp.kind === "clock" && def?.terminals) {
      clocks.push({
        id: comp.id,
        outNet: netOf(formatAddress(comp.id, "out")),
      });
    }
  }

  // External signals (Feature 370): bench stimulus. A signal is NOT a
  // component — it has no footprint and no catalog def — so it gets its own
  // pass over its own list. What it does have is a FLAG whose point is planted
  // in one hole, and that hole's net is the one it drives.
  const signals = []; // { id, net }
  for (const sig of doc.signals ?? []) {
    if (!sig?.flag?.anchor) continue; // an unplaced signal drives nothing
    signals.push({ id: sig.id, net: netOf(sig.flag.anchor) });
  }
  // An INPUT element's pin tags (the Arduino serial integration) are signal
  // flags the ARDUINO presses: each drives its own net, at the same strength,
  // with whatever level the last received value gave that pin — so they share
  // this list and the `signalLevels` map (keyed `<element>:<pin>`, which no
  // signal id can collide with) rather than threading a second map through
  // every solve. An Output's tags and every trigger tag only LISTEN.
  for (const element of doc.integrations ?? []) {
    if (element?.kind !== "input") continue;
    for (const [key, tag] of Object.entries(element.tags ?? {})) {
      if (key === "T" || typeof tag?.anchor !== "string") continue;
      signals.push({ id: `${element.id}:${key}`, net: netOf(tag.anchor) });
    }
  }

  // Resistors: weak two-terminal couplers (pull-ups / pull-downs / series R).
  // They never merge nets (that's a wire's job) — each conducts one terminal's
  // STRONG level to the other at the weakest strength (resolveAll, below).
  const resistors = []; // { netA, netB }
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (!def?.weakBridges || comp.board == null) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const addressOfPin = new Map(pins.map((p) => [p.pin, p.address]));
    for (const [a, b] of def.weakBridges(comp.params)) {
      const aa = addressOfPin.get(a);
      const ab = addressOfPin.get(b);
      // A lead resolving to nothing conducts nothing — the part stays, inert.
      if (!aa || !ab) continue;
      resistors.push({ netA: netOf(aa), netB: netOf(ab) });
    }
  }

  // The capacitors and resistors as a timing part reads them (and the one
  // thing the engine itself asks of a capacitor: is there one on this net?).
  const trace = rcTrace(doc, netlist);

  // Chips (combinational + sequential): pin→net maps + power status.
  const chips = [];
  const chipStatus = new Map();
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (
      !def ||
      comp.kind === "psu" ||
      comp.kind === "clock" ||
      !hasBehavior(def)
    ) {
      continue;
    }
    // Every behavioral part is a BOARD part: the only desk-level bricks left
    // are the PSU and the clock, and both are excluded above. (The HD44780 LCD
    // used to be the exception — a brick resolving its pins from terminal
    // addresses — until it became two seated modules.)
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const pinNet = new Map();
    for (const { pin, address } of pins) {
      // A floating lead maps to no net — the pin still exists, reading Z.
      pinNet.set(pin, address ? netOf(address) : null);
    }
    const vccPin = def.pins.find((p) => p.role === "vcc")?.n;
    const vccNet = pinNet.get(vccPin);
    // EVERY ground pin: a 405x's VEE is a supply pin like its VSS, and a chip
    // with one of them left off does not run.
    const gndNets = def.pins
      .filter((p) => p.role === "gnd")
      .map((p) => pinNet.get(p.n));
    const vccVolts = (vccNet && supplyPlusVolts.get(vccNet)) || [];
    const status = powerStatus({
      vccVolts,
      vccMinus: supplyMinus.has(vccNet),
      gndVolts: gndNets.flatMap(
        (net) => (net && supplyPlusVolts.get(net)) || [],
      ),
      gnd: gndNets.length > 0 && gndNets.every((net) => supplyMinus.has(net)),
      damaged: comp.params?.damaged === true,
      supply: supplyRange(def),
    });
    // The supply the chip SAW (the highest, should two meet on one net) —
    // the number its underpowered/damaged message states.
    const volts = vccVolts.length ? Math.max(...vccVolts) : null;
    chipStatus.set(comp.id, { status, volts });
    const oscillator = isOscillator(def);
    const analogSwitch = isAnalogSwitch(def);
    const timed = isTimed(def);
    chips.push({
      comp,
      def,
      pinNet,
      status,
      // A timed part's reading of its own R and C — a fact about the frozen
      // topology (and the parts' values), so it is taken once per context.
      timing: timed ? def.logic.timing(timingProbe(trace, pinNet)) : null,
      sequential: isSequential(def),
      memory: isMemory(def),
      analogSwitch,
      oscillator,
      // The output levels whose drive cannot burn an LED (families.js
      // `limitsLedCurrent`), and whether the channels cannot either.
      limitsLevel: new Set(
        analogSwitch
          ? []
          : [H, L].filter((lv) => limitsLedCurrent(def, volts, lv)),
      ),
      limitsChannel: analogSwitch && limitsLedCurrent(def, volts),
      // A can has exactly one output pin — resolved once here, not per drive.
      outputPin: oscillator
        ? def.pins.find((p) => p.role === "output")?.n
        : undefined,
    });
  }

  return {
    netIds,
    supplyPlusVolts,
    supplyMinus,
    clocks,
    signals,
    resistors,
    trace,
    chips,
    chipStatus,
    // Whether any part limits an LED's current — when none does, the LED
    // rule's resolution is the ordinary strong one and is not computed twice.
    limitsLed: chips.some((c) => c.limitsLevel.size > 0 || c.limitsChannel),
    boundaryWarnings: boundaryWarnings(
      chips,
      chipStatus,
      supplyPlusVolts,
      resistors,
    ),
  };
}

/**
 * The family-boundary facts of a frozen topology (Feature 400), as warnings.
 * The engine carries no voltages on a net, so none of these changes a level;
 * each is a STRUCTURAL fact about which pins share a net, stated once per net
 * with the fix. Only powered (`ok`) chips count — an unpowered part reads and
 * drives nothing, so it is on no boundary.
 *
 *   marginal-high   a 74LS output feeds a CD4000 input and no pull-up to a
 *                   supply `+` lifts the net. LS VOH is 2.7 V min / 3.4 V typ;
 *                   a CD4000B input at VDD 5 V needs VIH ≥ 3.5 V. Marginal,
 *                   usually works, out of spec — so a warning, never an X.
 *   ls-fanout       one CD4000 output holds more 74LS inputs than it can sink
 *                   (families.js `lsFanoutOf`: one, or a buffer's eight).
 *   mixed-supply    one net joins chips powered from different voltages — a
 *                   12 V output into a 5 V input, which needs a level shifter.
 */
function boundaryWarnings(chips, chipStatus, supplyPlusVolts, resistors) {
  const byNet = new Map(); // netId → { lsOut, cmosIn, lsIn, cmosOut[], volts }
  const at = (net) => {
    if (!byNet.has(net)) {
      byNet.set(net, {
        lsOut: false,
        cmosIn: false,
        lsIn: 0,
        cmosOut: [],
        volts: new Set(),
      });
    }
    return byNet.get(net);
  };
  for (const c of chips) {
    if (c.status !== CHIP_STATUS.OK) continue;
    const family = familyOf(c.def);
    const volts = chipStatus.get(c.comp.id)?.volts ?? null;
    const role = new Map(c.def.pins.map((p) => [p.n, p.role]));
    for (const [pin, net] of c.pinNet) {
      if (!net) continue;
      const r = role.get(pin);
      if (r !== "input" && r !== "output" && r !== "io") continue;
      // A switch terminal is neither: it passes another part's level.
      if (c.analogSwitch && r === "io") continue;
      const entry = at(net);
      if (volts != null) entry.volts.add(volts);
      if (family === "74LS") {
        if (r === "output" || r === "io") entry.lsOut = true;
        if (r === "input" || r === "io") entry.lsIn += 1;
      } else if (family === "CD4000") {
        if (r === "input" || r === "io") entry.cmosIn = true;
        if (r === "output" || r === "io") {
          entry.cmosOut.push({
            chip: c.comp.id,
            pin,
            fanout: lsFanoutOf(c.def),
          });
        }
      }
    }
  }
  // Nets a resistor ties to a supply `+` — a pull-up the LS output can lean on.
  const pulledUp = new Set();
  for (const r of resistors) {
    if (supplyPlusVolts.has(r.netB) && r.netA) pulledUp.add(r.netA);
    if (supplyPlusVolts.has(r.netA) && r.netB) pulledUp.add(r.netB);
  }
  const warnings = [];
  for (const [net, e] of byNet) {
    if (supplyPlusVolts.has(net)) continue; // a rail is not a signal
    if (e.lsOut && e.cmosIn && !pulledUp.has(net)) {
      warnings.push({ type: "marginal-high", net });
    }
    for (const out of e.cmosOut) {
      if (e.lsIn > out.fanout) {
        warnings.push({
          type: "ls-fanout",
          net,
          chip: out.chip,
          loads: e.lsIn,
          max: out.fanout,
        });
      }
    }
    if (e.volts.size > 1) {
      warnings.push({
        type: "mixed-supply",
        net,
        volts: [...e.volts].sort((a, b) => a - b),
      });
    }
  }
  return warnings;
}

/**
 * Every driver (clock + signal sources, and powered chip outputs) for a set
 * of levels: `drivers` netId → [levels], and `hard`, the same minus each
 * output whose drive cannot burn an LED (the very same map when no part on
 * the desk limits one — `ctx.limitsLed`).
 */
function driversFor(ctx, levels, state, clockPhase, images, signalLevels) {
  const drivers = new Map(); // netId → [levels]
  const hard = ctx.limitsLed ? new Map() : drivers;
  const add = (net, level, limited = false) => {
    if (!net) return;
    if (!drivers.has(net)) drivers.set(net, []);
    drivers.get(net).push(level);
    if (hard === drivers || limited) return;
    if (!hard.has(net)) hard.set(net, []);
    hard.get(net).push(level);
  };

  // Clock sources drive their output net at output strength.
  for (const clk of ctx.clocks) add(clk.outNet, clockPhase.get(clk.id) ?? Z);

  // A planted signal flag drives its net at OUTPUT strength — the same tier
  // and the same sentence as a clock source, because it is the same thing: a
  // lead from the bench holding a level. Being CHIP-tier rather than a fourth
  // strength of its own is what makes two signals fighting over one net, or a
  // signal fighting a chip output, report a conflict with no new code in
  // resolve.js. A level it has not been given contributes nothing.
  for (const sig of ctx.signals) add(sig.net, signalLevels.get(sig.id) ?? Z);

  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK) continue; // inert chips drive nothing
    if (c.analogSwitch) continue; // it joins nets (channelGroups); drives none
    const pinLevels = new Map();
    for (const [pin, net] of c.pinNet) {
      pinLevels.set(pin, net ? (levels.get(net) ?? Z) : Z);
    }
    let outMap;
    if (c.memory) {
      // A memory reads its image (a pure input) onto the data pins, or floats.
      outMap = memoryOutputs(
        c.def,
        inputLevels(c.def, pinLevels),
        images.get(c.comp.id),
      );
    } else if (c.sequential) {
      outMap = outputsOf(
        c.def,
        state.get(c.comp.id) ?? initialState(c.def),
        inputLevels(c.def, pinLevels),
      );
    } else if (c.oscillator) {
      // A board-seated crystal can: same free-running source as a clock
      // brick's terminal, but only while powered (the c.status check above).
      outMap = new Map([[c.outputPin, clockPhase.get(c.comp.id) ?? Z]]);
    } else {
      outMap = evaluate(c.def, pinLevels);
    }
    for (const [outPin, level] of outMap) {
      add(c.pinNet.get(outPin), level, c.limitsLevel.has(level));
    }
  }
  return { drivers, hard };
}

/**
 * Which nets the analog switches' channels JOIN for one pass, read off the
 * levels on their control pins (`levels`, the previous pass's — as every chip
 * output is computed). Returns null when no channel conducts, else
 * `{ on, wide, hardOn, hardWide }`: each a Map netId → the member list of its
 * joined group (itself included; one shared array per group), `on` over the
 * channels that are ON and `wide` over those that MIGHT be (a floating
 * control) as well — null when none might. `hardOn`/`hardWide` are the same
 * joins minus the channels whose on-resistance limits an LED's current: what
 * the LED rule's resolution joins. Only a POWERED switch conducts.
 */
function channelGroups(ctx, levels) {
  const on = [];
  const maybe = [];
  for (const c of ctx.chips) {
    if (!c.analogSwitch || c.status !== CHIP_STATUS.OK) continue;
    const pinLevels = new Map();
    for (const [pin, net] of c.pinNet) {
      pinLevels.set(pin, net ? (levels.get(net) ?? Z) : Z);
    }
    for (const ch of channelStates(c.def, pinLevels)) {
      const a = c.pinNet.get(ch.a);
      const b = c.pinNet.get(ch.b);
      if (!a || !b || a === b || ch.on === L) continue;
      (ch.on === H ? on : maybe).push({ a, b, limited: c.limitsChannel });
    }
  }
  if (!on.length && !maybe.length) return null;
  const hard = (pairs) => pairs.filter((p) => !p.limited);
  const all = [...on, ...maybe];
  return {
    on: groupsOf(on),
    wide: maybe.length ? groupsOf(all) : null,
    hardOn: groupsOf(hard(on)),
    hardWide: maybe.length ? groupsOf(hard(all)) : null,
  };
}

/** Net pairs → Map netId → its group's (shared) member list; null for none. */
function groupsOf(pairs) {
  if (!pairs.length) return null;
  const uf = new UnionFind();
  for (const { a, b } of pairs) uf.union(a, b);
  const byNet = new Map();
  for (const members of uf.groups().values()) {
    for (const id of members) byNet.set(id, members);
  }
  return byNet;
}

/** Two candidate level maps → what they agree on, X where they differ. */
function agreeing(a, b) {
  const out = new Map();
  for (const [id, lv] of a) out.set(id, b.get(id) === lv ? lv : X);
  return out;
}

/**
 * Resolve ONE net from supplies + `drivers` (+ the pulls `pullsOf` names),
 * across the channels `groups` joins (netId → its group's members; null for
 * none). A joined net hears every member's drivers and pulls — but another
 * member's SUPPLY only at OUTPUT strength: it arrives through a switch, so a
 * rail through a 4066 FIGHTS an output on the far side (a conflict there),
 * where the same rail wired straight on would simply win.
 */
function resolveIn(ctx, drivers, groups, id, pullsOf) {
  const group = groups?.get(id);
  if (!group) {
    return resolveNet({
      supplyPlus: ctx.supplyPlusVolts.has(id),
      supplyMinus: ctx.supplyMinus.has(id),
      chipLevels: drivers.get(id) ?? [],
      pullLevels: pullsOf(id),
    });
  }
  const chipLevels = [];
  const pullLevels = [];
  for (const member of group) {
    chipLevels.push(...(drivers.get(member) ?? []));
    pullLevels.push(...pullsOf(member));
    if (member === id) continue;
    if (ctx.supplyPlusVolts.has(member)) chipLevels.push(H);
    if (ctx.supplyMinus.has(member)) chipLevels.push(L);
  }
  return resolveNet({
    supplyPlus: ctx.supplyPlusVolts.has(id),
    supplyMinus: ctx.supplyMinus.has(id),
    chipLevels,
    pullLevels,
  });
}

const noPulls = () => [];

/**
 * Resolve every net once (`resolveIn`) from supplies + the given drivers +
 * resistor pulls, across the channels `groups` joins. A channel joining the
 * two rails themselves is a short through the switch, and said so.
 *
 * `burn` (null when no part limits an LED's current) is the `{drivers,
 * groups}` the LED rule's resolution reads instead: the drivers and joins
 * that could burn one (`driversFor`'s `hard`, `channelGroups`' `hardOn`).
 */
function resolveAll(ctx, drivers, groups = null, burn = null) {
  const resolveOne = (id, pullsOf) =>
    resolveIn(ctx, drivers, groups, id, pullsOf);

  // With resistors present, first compute each net's STRONG level (supplies +
  // chip outputs, no pulls) — that's what a resistor conducts, and (unless a
  // part limits an LED's current — `burn`) it's also what callers use to
  // tell "driven directly" from "fed through a resistor" (a lit LED vs. a
  // burnt one), so it must never itself include a pull.
  let pulls = null;
  let strong = null;
  if (ctx.resistors.length) {
    strong = new Map();
    for (const id of ctx.netIds) strong.set(id, resolveOne(id, noPulls).level);

    // Relax the resistor network to a fixpoint: a net one resistor just
    // pulled to H/L can itself feed the NEXT resistor down the chain (R1
    // pulling netMid, netMid's own resistor R2 pulling netFar, and so on) —
    // a single pass off the bare `strong` levels only ever sees one hop.
    // `basis` starts at the strong levels and is refined each pass; a
    // resistor chain of N resistors fully propagates in at most N passes.
    let basis = strong;
    for (let pass = 0; pass <= ctx.resistors.length; pass++) {
      const p = new Map(); // netId → [levels]
      const addPull = (net, level) => {
        if (!net || (level !== H && level !== L)) return;
        if (!p.has(net)) p.set(net, []);
        p.get(net).push(level);
      };
      for (const r of ctx.resistors) {
        addPull(r.netA, basis.get(r.netB));
        addPull(r.netB, basis.get(r.netA));
      }
      const nextBasis = new Map();
      for (const id of ctx.netIds) {
        nextBasis.set(id, resolveOne(id, (net) => p.get(net) ?? []).level);
      }
      pulls = p;
      if (mapsEqual(nextBasis, basis)) break;
      basis = nextBasis;
    }
  }

  const next = new Map();
  const warnings = [];
  // A joined group's fight is ONE fight, whichever member nets report it.
  const said = new Map(); // warning type → the groups it was said for
  for (const id of ctx.netIds) {
    const res = resolveOne(id, (net) => pulls?.get(net) ?? []);
    next.set(id, res.level);
    if (!res.warning) continue;
    const group = groups?.get(id);
    if (group) {
      if (!said.has(res.warning)) said.set(res.warning, new Set());
      if (said.get(res.warning).has(group)) continue;
      said.get(res.warning).add(group);
    }
    warnings.push({ type: res.warning, net: id });
  }
  for (const group of new Set(groups?.values() ?? [])) {
    const plus = group.find((id) => ctx.supplyPlusVolts.has(id));
    if (plus && group.some((id) => ctx.supplyMinus.has(id))) {
      warnings.push({ type: "short", net: plus, via: "switch" });
    }
  }
  // What the LED rule reads (sim/junction.js): the level each net would have
  // from the sources that can burn an LED. Without a limiting part that is
  // the strong level — and without resistors nothing is weakly pulled, so
  // the resolved level IS the strong one. With one, it is resolved again
  // from the hard drivers across the hard joins: a CD4000 output, or a
  // channel, that limits the current is no more a burn than a resistor is.
  const burning = burn
    ? new Map(
        ctx.netIds.map((id) => [
          id,
          resolveIn(ctx, burn.drivers, burn.groups, id, noPulls).level,
        ]),
      )
    : (strong ?? next);
  return { next, warnings, strong: burning };
}

/** Run the warm-started settle loop for a fixed state + clock phase + images
    + signal levels. */
function solve(ctx, warmStart, state, clockPhase, images, signalLevels) {
  let levels = new Map();
  for (const id of ctx.netIds) levels.set(id, warmStart.get(id) ?? Z);

  let iterations = 0;
  let settled = false;
  let lastWarnings = [];
  let lastStrong = new Map();
  let prev = levels;
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const { drivers, hard } = driversFor(
      ctx,
      levels,
      state,
      clockPhase,
      images,
      signalLevels,
    );
    const groups = channelGroups(ctx, levels);
    const burn = (joins) =>
      ctx.limitsLed ? { drivers: hard, groups: joins ?? null } : null;
    let { next, warnings, strong } = resolveAll(
      ctx,
      drivers,
      groups?.on,
      burn(groups?.hardOn),
    );
    // A channel that MIGHT be on: resolve with it too, and keep only what
    // both readings agree on.
    if (groups?.wide) {
      const wide = resolveAll(ctx, drivers, groups.wide, burn(groups.hardWide));
      next = agreeing(next, wide.next);
      strong = agreeing(strong, wide.strong);
    }
    lastWarnings = warnings;
    lastStrong = strong;
    if (mapsEqual(next, levels)) {
      levels = next;
      settled = true;
      break;
    }
    prev = levels;
    levels = next;
  }

  const warnings = [...lastWarnings];
  if (!settled) {
    const nets = ctx.netIds.filter((id) => prev.get(id) !== levels.get(id));
    for (const id of nets) levels.set(id, X);
    if (nets.length) warnings.push({ type: "oscillation", nets });
  }
  return { levels, iterations, settled, warnings, strong: lastStrong };
}

/**
 * The CMOS inputs a settle left FLOATING (Feature 400): per powered CD4000
 * chip, the input pins whose net resolved to `Z` — or that reach no net at
 * all. A floating CMOS input reads unknown, which on its own is quiet (an LED
 * on an X net is simply dark), so it is reported. Spare gates count: the
 * datasheets say to tie every unused input.
 */
function floatingInputWarnings(ctx, levels) {
  const warnings = [];
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK || !floatsUnknown(c.def)) continue;
    const pins = c.def.pins
      .filter((p) => p.role === "input")
      .filter((p) => {
        const net = c.pinNet.get(p.n);
        // A capacitor on the net counts as a connection: a pin wired to one
        // is wired, whatever DC level it settles at.
        if (net && ctx.trace.hasCapacitor(net)) return false;
        return !net || (levels.get(net) ?? Z) === Z;
      })
      .map((p) => p.n);
    if (pins.length) {
      warnings.push({ type: "floating-input", chip: c.comp.id, pins });
    }
  }
  return warnings;
}

/** Assemble the public result: net levels, chip status, deduped warnings. */
function assemble(ctx, solved, extra = {}) {
  const warnings = [...solved.warnings];
  for (const c of ctx.chips) {
    const volts = ctx.chipStatus.get(c.comp.id)?.volts ?? null;
    if (c.status === CHIP_STATUS.UNDERPOWERED) {
      warnings.push({ type: "underpowered", chip: c.comp.id, volts });
    } else if (c.status === CHIP_STATUS.REVERSED) {
      warnings.push({ type: "reversed", chip: c.comp.id });
    } else if (c.status === CHIP_STATUS.DAMAGED) {
      warnings.push({ type: "damaged", chip: c.comp.id, volts });
    }
  }
  warnings.push(...floatingInputWarnings(ctx, solved.levels));
  warnings.push(...ctx.boundaryWarnings);
  // A timed part whose wiring it cannot read says so rather than guess — and
  // holds its outputs at a defined level meanwhile (each def's own `step`).
  const timing = new Map();
  for (const c of ctx.chips) {
    if (!c.timing) continue;
    timing.set(c.comp.id, c.timing);
    if (c.status === CHIP_STATUS.OK && c.timing.problems?.length) {
      warnings.push({
        type: "timing",
        chip: c.comp.id,
        problems: c.timing.problems,
      });
    }
  }
  return {
    netLevels: solved.levels,
    strongLevels: solved.strong,
    chipStatus: ctx.chipStatus,
    warnings: dedupe(warnings),
    iterations: solved.iterations,
    settled: solved.settled,
    timing,
    ...extra,
  };
}

/**
 * Settle a purely combinational circuit (Feature 90). Sequential parts, if
 * present, are driven from their initial state and never advanced — use `tick`
 * to clock them.
 *
 * @param {object} opts
 * @param {{boards:Array, components:Array, wires:Array}} opts.document
 * @param {{netOfPoint: Map, nets: Map}} opts.netlist
 * @param {Map<string,string>} [opts.warmStart] - previous stable net levels.
 * @param {Map<string,object>} [opts.state] - per-component sequential state.
 * @param {Map<string,string>} [opts.clockPhase] - clock id → output level.
 * @param {Map<string,string>} [opts.signalLevels] - signal id → the level its
 *   planted flag is holding (run-volatile; SimController owns it).
 * @param {Map<string,Uint8Array|Uint16Array>} [opts.images] - per-memory byte
 *   images (read-only input; the engine never mutates them).
 * @returns {{netLevels:Map, chipStatus:Map, warnings:Array, iterations:number, settled:boolean}}
 */
export function settle({
  document: doc,
  netlist,
  warmStart = new Map(),
  state = new Map(),
  clockPhase = new Map(),
  signalLevels = new Map(),
  images = new Map(),
}) {
  const ctx = buildContext(doc, netlist);
  return assemble(
    ctx,
    solve(ctx, warmStart, state, clockPhase, images, signalLevels),
  );
}

/** Structural equality for plain-data sequential states (arrays/objects/scalars). */
function sameState(a, b) {
  if (a === b) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameState(a[k], b[k])) return false;
  return true;
}

/** Sample a chip's input pins from a settled net-level map (Z when floating). */
function samplePins(c, levels) {
  const raw = new Map();
  for (const [pin, net] of c.pinNet) {
    raw.set(pin, net ? (levels.get(net) ?? Z) : Z);
  }
  return inputLevels(c.def, raw);
}

/**
 * Advance the circuit one synchronous tick: pre-settle (old state), then iterate
 * sample→step→re-settle to a state fixpoint so an output→clock ripple cascades
 * within the tick, ending on the post-settle of the final state. A tick fires on
 * a clock transition OR any input event; each inner step detects edges against
 * the PREVIOUS inner iteration's sampled inputs (seeded, on the first pass, from
 * the tick's entry inputs `prevPinLevels`). An external clock net is fixed at
 * `clockPhase` for the whole tick, so its edge is seen once (byte-for-byte the
 * old two-phase result for synchronous designs); a clock net driven by another
 * chip's output re-transitions as that output updates, so a NEW internal edge
 * cascades the ripple (Feature 220).
 *
 * @param {object} opts
 * @param {{boards:Array, components:Array, wires:Array}} opts.document
 * @param {{netOfPoint: Map, nets: Map}} opts.netlist
 * @param {Map<string,string>} [opts.warmStart] - previous stable net levels.
 * @param {Map<string,object>} [opts.state] - per-component sequential state.
 * @param {Map<string,Map<number,string>>} [opts.prevPinLevels] - last tick's
 *   sampled input levels per component (for edge detection; empty → no edges).
 * @param {Map<string,string>} [opts.clockPhase] - clock id → current output.
 * @param {Map<string,string>} [opts.signalLevels] - signal id → the level its
 *   planted flag is holding (run-volatile; SimController owns it).
 * @param {Map<string,Uint8Array|Uint16Array>} [opts.images] - per-memory byte
 *   images (read-only input; writes are REPORTED via `memWrites`, not applied).
 * @param {number} [opts.now] - simulated seconds since Run, handed to every
 *   timed part's step (sim/timing.js). Nothing else reads it.
 * @returns {{netLevels, chipStatus, warnings, iterations, settled,
 *   state: Map, pinLevels: Map, memWrites: Array<{compId,addr,value}>,
 *   timing: Map, wakeAt: number|null}}
 */
export function tick({
  document: doc,
  netlist,
  warmStart = new Map(),
  state = new Map(),
  prevPinLevels = new Map(),
  clockPhase = new Map(),
  signalLevels = new Map(),
  images = new Map(),
  now = 0,
}) {
  const ctx = buildContext(doc, netlist);

  // ① Pre-settle: propagate the new clock phase / input changes with the OLD
  //    sequential state holding.
  let solved = solve(ctx, warmStart, state, clockPhase, images, signalLevels);

  // ② Sequential-step fixpoint: sample each sequential chip from the current
  //    settled levels, `step` it (edges vs the previous inner iteration), and
  //    re-settle around the new state — repeating until no chip's state changes.
  //    The first pass reproduces the old two-phase result; a further pass only
  //    fires a NEW edge that a just-updated output created (the ripple cascade).
  // Seed the state with every sequential chip's current-or-initial state so the
  // returned map always has an entry per chip (a no-change pass returns this),
  // and seed the edge-detection "prev" from the tick's entry inputs.
  const curStateSeed = new Map(state);
  const prevIns = new Map(); // compId → previous inner iteration's sampled inputs
  for (const c of ctx.chips) {
    if (!c.sequential) continue;
    if (!curStateSeed.has(c.comp.id)) {
      curStateSeed.set(c.comp.id, initialState(c.def));
    }
    const entry = prevPinLevels.get(c.comp.id);
    if (entry) prevIns.set(c.comp.id, entry);
  }
  let curState = curStateSeed;
  const finalIns = new Map(); // compId → last-sampled input levels
  let iterations = 0;
  let oscillating = false;
  let lastChanged = new Set();
  for (;;) {
    const changed = new Set();
    const nextState = new Map(curState);
    const sampled = new Map();
    for (const c of ctx.chips) {
      if (!c.sequential) continue;
      const ins = samplePins(c, solved.levels);
      sampled.set(c.comp.id, ins);
      finalIns.set(c.comp.id, ins);
      const current = curState.get(c.comp.id) ?? initialState(c.def);
      const next =
        c.status === CHIP_STATUS.OK
          ? stepChip(c.def, current, ins, prevIns.get(c.comp.id) ?? null, {
              now,
              timing: c.timing,
            })
          : current; // inert chip holds; drives nothing
      if (!sameState(next, current)) changed.add(c.comp.id);
      nextState.set(c.comp.id, next);
    }
    // Advance the edge-detection baseline to this iteration's samples: a pin
    // that has reached its stable level shows no edge next pass (so the external
    // clock fires once), while a still-rippling output keeps producing edges.
    for (const [id, ins] of sampled) prevIns.set(id, ins);
    if (changed.size === 0) break; // state fixpoint reached
    iterations++;
    curState = nextState;
    lastChanged = changed;
    if (iterations >= MAX_TICK_ITERATIONS) {
      oscillating = true;
      break;
    }
    solved = solve(
      ctx,
      solved.levels,
      curState,
      clockPhase,
      images,
      signalLevels,
    );
  }

  // Memory: no clocked state — read its inputs from the FINAL settled levels and
  // REPORT any write op for the controller to apply (the engine never mutates
  // the image). Populate its pin levels for parity with sequential chips.
  const memWrites = [];
  for (const c of ctx.chips) {
    if (!c.memory) continue;
    const ins = samplePins(c, solved.levels);
    finalIns.set(c.comp.id, ins);
    if (c.status === CHIP_STATUS.OK) {
      const op = memoryWrite(c.def, ins, images.get(c.comp.id));
      if (op) memWrites.push({ compId: c.comp.id, ...op });
    }
  }

  // A self-clocking ring that never settles: mark the still-changing sequential
  // nets `X` and report oscillation, exactly as the combinational settle does.
  const extraWarnings = [];
  if (oscillating) {
    const nets = new Set();
    for (const compId of lastChanged) {
      const c = ctx.chips.find((x) => x.comp.id === compId);
      if (!c) continue;
      const outs = outputsOf(
        c.def,
        curState.get(compId),
        finalIns.get(compId) ?? new Map(),
      );
      for (const pin of outs.keys()) {
        const net = c.pinNet.get(pin);
        if (net) nets.add(net);
      }
    }
    for (const id of nets) solved.levels.set(id, X);
    if (nets.size) extraWarnings.push({ type: "oscillation", nets: [...nets] });
  }

  // When the controller must tick again for a timed part to move on its own:
  // the earliest pending change across every powered one (null: none).
  let wakeAt = null;
  for (const c of ctx.chips) {
    if (!c.timing || c.status !== CHIP_STATUS.OK) continue;
    const at = wakeAtOf(c.def, curState.get(c.comp.id));
    if (at != null && Number.isFinite(at)) {
      wakeAt = wakeAt == null ? at : Math.min(wakeAt, at);
    }
  }

  const result = assemble(ctx, solved, {
    state: curState,
    pinLevels: finalIns,
    memWrites,
    wakeAt,
  });
  if (extraWarnings.length) {
    result.warnings = dedupe([...result.warnings, ...extraWarnings]);
    result.settled = false;
  }
  return result;
}
