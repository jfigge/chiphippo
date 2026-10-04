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
// A transistor is the same mechanism with one channel (analog-switch.js
// `transistorSwitch`) and no supply pins — a part with none needs no power,
// so it is always "ok" and never in `chipStatus`.
//
// Diodes are ONE-WAY bridges (a def's `oneWayBridges`): a HIGH on the anode
// net passes to the cathode net at the strength it arrived with — a strongly
// driven anode DRIVES the cathode at output strength, a pulled one PULLS it —
// and nothing passes back. It is resolved INSIDE each pass, from that pass's
// own drivers (`diodeDrive`), never from the last pass's levels: a ring of
// diodes with nothing driving it must not hold itself up.
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

  // Diodes: one-way couplers. A pair whose leads land in ONE net (a shorted
  // diode) or on nothing conducts nothing — the part stays, inert.
  const diodes = []; // { id, anode, cathode }
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (typeof def?.oneWayBridges !== "function" || comp.board == null) {
      continue;
    }
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const addressOfPin = new Map(pins.map((p) => [p.pin, p.address]));
    for (const [a, k] of def.oneWayBridges(comp.params)) {
      const anode = addressOfPin.get(a) ? netOf(addressOfPin.get(a)) : null;
      const cathode = addressOfPin.get(k) ? netOf(addressOfPin.get(k)) : null;
      if (!anode || !cathode || anode === cathode) continue;
      diodes.push({ id: comp.id, anode, cathode });
    }
  }

  // The capacitors and resistors as a timing part reads them (and the one
  // thing the engine itself asks of them: is a pin whose net holds nothing
  // else really floating?).
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
    // A part with no supply pins at all (a transistor) needs no power: it
    // is always "ok", and — not being a chip — has no status to report.
    const passive = !def.pins.some((p) => p.role === "vcc" || p.role === "gnd");
    const vccPin = def.pins.find((p) => p.role === "vcc")?.n;
    const vccNet = pinNet.get(vccPin);
    // EVERY ground pin: a 405x's VEE is a supply pin like its VSS, and a chip
    // with one of them left off does not run.
    const gndNets = def.pins
      .filter((p) => p.role === "gnd")
      .map((p) => pinNet.get(p.n));
    const vccVolts = (vccNet && supplyPlusVolts.get(vccNet)) || [];
    const status = passive
      ? CHIP_STATUS.OK
      : powerStatus({
          vccVolts,
          vccMinus: supplyMinus.has(vccNet),
          gndVolts: gndNets.flatMap(
            (net) => (net && supplyPlusVolts.get(net)) || [],
          ),
          gnd:
            gndNets.length > 0 && gndNets.every((net) => supplyMinus.has(net)),
          damaged: comp.params?.damaged === true,
          supply: supplyRange(def),
        });
    // The supply the chip SAW (the highest, should two meet on one net) —
    // the number its underpowered/damaged message states.
    const volts = vccVolts.length ? Math.max(...vccVolts) : null;
    if (!passive) chipStatus.set(comp.id, { status, volts });
    const oscillator = isOscillator(def);
    const analogSwitch = isAnalogSwitch(def);
    const timed = isTimed(def);
    chips.push({
      comp,
      def,
      pinNet,
      status,
      passive,
      // A timed part's reading of its own R and C — a fact about the frozen
      // topology (and the parts' values), so it is taken once per context.
      timing: timed ? def.logic.timing(timingProbe(trace, pinNet)) : null,
      sequential: isSequential(def),
      memory: isMemory(def),
      analogSwitch,
      // Its channels are TRANSISTORS (a discrete one, or a CD4007UB's), so
      // two rails meeting through one are said to meet through a transistor
      // rather than "an analog switch".
      transistor: Boolean(def.transistor || def.transistorArray),
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
    diodes,
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
      supplyMinus,
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
 *                   12 V output into a 5 V input, which needs a level shifter
 *                   (`supplyClash`). A level shifter's own inputs
 *                   (`def.inputsAboveSupply`, the CD4049UB/CD4050B) may sit
 *                   on a HIGHER supply's net; that is what they are for.
 *
 * Neither rail is a signal: a supply `+` net is skipped, and so is a ground
 * net — chips on two supplies share one by necessity.
 */
function boundaryWarnings(
  chips,
  chipStatus,
  supplyPlusVolts,
  supplyMinus,
  resistors,
) {
  // netId → { lsOut, cmosIn, lsIn, cmosOut[], volts, driven, plain, above }
  const byNet = new Map();
  const at = (net) => {
    if (!byNet.has(net)) {
      byNet.set(net, {
        lsOut: false,
        cmosIn: false,
        lsIn: 0,
        cmosOut: [],
        volts: new Set(),
        driven: new Set(), // the supplies of the outputs on it
        plain: new Set(), // …of the inputs that need their own supply's level
        above: new Set(), // …of the inputs that take anything up from theirs
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
      // A switch terminal is neither: it passes another part's level. (A
      // CD4007UB's terminal on a channel from a rail is its OUTPUT — below.)
      if (c.analogSwitch && r === "io") continue;
      const entry = at(net);
      if (volts != null) {
        entry.volts.add(volts);
        if (r === "output" || r === "io") entry.driven.add(volts);
        if (r === "input" || r === "io") {
          (c.def.inputsAboveSupply ? entry.above : entry.plain).add(volts);
        }
      }
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
  // A CD4007UB is built into gates by its wiring: a terminal whose channel
  // runs to a rail (its own VDD/VSS inside, or one wired to 11/9) is that
  // gate's output — HIGH at the `+` rail's voltage through a P-channel, LOW
  // through an N-channel, sinking what a B-series output sinks.
  for (const c of chips) {
    if (c.status !== CHIP_STATUS.OK || !c.def.transistorArray) continue;
    for (const ch of c.def.logic.channels) {
      for (const [near, far] of [
        [ch.a, ch.b],
        [ch.b, ch.a],
      ]) {
        const net = c.pinNet.get(near);
        const rail = c.pinNet.get(far);
        if (!net || !rail || net === rail) continue;
        if (supplyPlusVolts.has(net) || supplyMinus.has(net)) continue;
        if (supplyPlusVolts.has(rail)) {
          for (const v of supplyPlusVolts.get(rail)) {
            at(net).volts.add(v);
            at(net).driven.add(v);
          }
        } else if (supplyMinus.has(rail)) {
          const fanout = lsFanoutOf(c.def);
          const outs = at(net).cmosOut;
          if (!outs.some((o) => o.chip === c.comp.id)) {
            outs.push({ chip: c.comp.id, pin: near, fanout });
          }
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
    // A rail is not a signal.
    if (supplyPlusVolts.has(net) || supplyMinus.has(net)) continue;
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
    if (supplyClash(e)) {
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
 * Whether one net's chips disagree about its voltage. Its outputs, and every
 * ordinary input, need it at their OWN supply's level, so two different
 * supplies among them clash; a level shifter's input needs only a level at
 * or above its supply's, so it clashes only with a lower one.
 */
function supplyClash({ driven, plain, above }) {
  const fixed = new Set([...driven, ...plain]);
  if (fixed.size > 1) return true;
  const [level] = fixed;
  return level != null && [...above].some((v) => v > level);
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
 * The most unknown channel controls one pass tries every way round (2⁴
 * readings — a 405x's A, B, C and INH). Past it, every channel that MIGHT be
 * on is closed at once in one wide reading: more X than the truth, never less.
 */
const MAX_UNKNOWN_CONTROLS = 4;

/** A control pin's identity across parts: its net, or the pin itself when it
    is wired to nothing. */
const controlKey = (c, pin) => c.pinNet.get(pin) ?? `${c.comp.id}#${pin}`;

/**
 * Which nets the analog switches' channels JOIN for one pass, read off the
 * levels on their control pins (`levels`, the previous pass's — as every chip
 * output is computed). Only a POWERED switch conducts; `state` is the
 * per-part state map, read by the one channel part that keeps any (a
 * MOSFET's gate charge). Returns null when no channel conducts, else
 * `{ definite, readings }`, each reading a `{ on, hardOn }` pair of
 * `groupsOf` joins (`hardOn` minus the channels whose on-resistance limits an
 * LED's current: what the LED rule's resolution joins).
 *
 * `definite` closes only the channels that are certainly ON. A channel whose
 * control is UNKNOWN (floating, or fought over) might be either, so the
 * `readings` are every way those controls could read — each a real switch
 * position, so a mux with a floating select is never read as every channel
 * closed at once (two channels no select value joins, joined through COM).
 * The pass keeps the levels all readings agree on; with no unknown control
 * the one reading IS `definite`.
 */
function channelGroups(ctx, levels, state = new Map()) {
  const parts = ctx.chips.filter(
    (c) => c.analogSwitch && c.status === CHIP_STATUS.OK,
  );
  if (!parts.length) return null;
  // The pairs one reading joins: `overrides` sets controls (controlKey → H/L);
  // `unknown` collects the controls behind every channel that answered X.
  const pairsFor = (overrides, unknown) => {
    const on = [];
    const maybe = [];
    for (const c of parts) {
      const pinLevels = new Map();
      for (const [pin, net] of c.pinNet) {
        const level = net ? (levels.get(net) ?? Z) : Z;
        pinLevels.set(pin, overrides?.get(controlKey(c, pin)) ?? level);
      }
      const own = state.get(c.comp.id) ?? initialState(c.def);
      channelStates(c.def, pinLevels, own).forEach((ch, i) => {
        const a = c.pinNet.get(ch.a);
        const b = c.pinNet.get(ch.b);
        if (!a || !b || a === b || ch.on === L) return;
        const pair = {
          a,
          b,
          limited: c.limitsChannel,
          transistor: c.transistor,
        };
        if (ch.on === H) {
          on.push(pair);
          return;
        }
        maybe.push(pair);
        for (const pin of c.def.logic.channels[i].inputs) {
          const level = pinLevels.get(pin);
          if (level !== H && level !== L) unknown?.add(controlKey(c, pin));
        }
      });
    }
    return { on, maybe };
  };
  const reading = (pairs) => ({
    on: groupsOf(ctx, pairs),
    hardOn: groupsOf(
      ctx,
      pairs.filter((p) => !p.limited),
    ),
  });
  const unknown = new Set();
  const base = pairsFor(null, unknown);
  if (!base.on.length && !base.maybe.length) return null;
  const definite = reading(base.on);
  if (!base.maybe.length) return { definite, readings: [definite] };
  const keys = [...unknown];
  if (keys.length > MAX_UNKNOWN_CONTROLS) {
    return {
      definite,
      readings: [definite, reading([...base.on, ...base.maybe])],
    };
  }
  const readings = [];
  for (let bits = 0; bits < 2 ** keys.length; bits++) {
    const overrides = new Map(
      keys.map((key, i) => [key, (bits >> i) & 1 ? H : L]),
    );
    // A channel still answering X with every unknown control set has a
    // reason of its own; it is closed, the conservative reading.
    const { on, maybe } = pairsFor(overrides, null);
    readings.push(reading([...on, ...maybe]));
  }
  return { definite, readings };
}

/**
 * Net pairs → the joined groups: `{ byNet, all }`, `byNet` netId → its
 * group, `all` every group. A group is `{ members, via }` — its member nets
 * (one shared record per group) and whether a transistor's channel is among
 * its joins ("transistor") or only switches' ("switch").
 *
 * A SUPPLY net is never a union point. It is stiff: a net a channel joins to
 * a rail hears the rail (at output strength), but two nets each joined to the
 * same rail are not thereby joined to each other — a fight on one stays on
 * that one. So a rail is a MEMBER of each group that touches it (never a key:
 * it resolves as itself), and a channel straight between two rails is a group
 * of its own, there to be reported as the short it is.
 */
function groupsOf(ctx, pairs) {
  if (!pairs.length) return null;
  const isSupply = (id) =>
    ctx.supplyPlusVolts.has(id) || ctx.supplyMinus.has(id);
  const uf = new UnionFind();
  const rails = new Map(); // net → the supply nets channels join it to
  const all = [];
  for (const p of pairs) {
    const railA = isSupply(p.a);
    const railB = isSupply(p.b);
    if (railA && railB) {
      all.push({
        members: [p.a, p.b],
        via: p.transistor ? "transistor" : "switch",
      });
    } else if (railA || railB) {
      const [net, rail] = railA ? [p.b, p.a] : [p.a, p.b];
      uf.add(net);
      if (!rails.has(net)) rails.set(net, new Set());
      rails.get(net).add(rail);
    } else {
      uf.union(p.a, p.b);
    }
  }
  const viaTransistor = new Set(
    pairs
      .filter((p) => p.transistor)
      .map((p) => (isSupply(p.a) ? p.b : p.a))
      .filter((id) => !isSupply(id))
      .map((id) => uf.find(id)),
  );
  const byNet = new Map();
  for (const [root, members] of uf.groups()) {
    const supplies = new Set();
    for (const id of members) {
      for (const rail of rails.get(id) ?? []) supplies.add(rail);
    }
    const group = {
      members: [...members, ...supplies],
      via: viaTransistor.has(root) ? "transistor" : "switch",
    };
    all.push(group);
    for (const id of members) byNet.set(id, group);
  }
  return { byNet, all };
}

/** Two candidate level maps → what they agree on, X where they differ. */
function agreeing(a, b) {
  const out = new Map();
  for (const [id, lv] of a) out.set(id, b.get(id) === lv ? lv : X);
  return out;
}

/**
 * Resolve ONE net from supplies + `drivers` (+ the pulls `pullsOf` names),
 * across the channels `groups` joins (`groupsOf`; null for none). A joined
 * net hears every member's drivers and pulls — but a member RAIL only as its
 * supply, at OUTPUT strength: it arrives through a switch, so a rail through
 * a 4066 FIGHTS an output on the far side (a conflict there), where the same
 * rail wired straight on would simply win. (Whatever else sits on a rail is
 * overruled by it, so it travels no further.)
 */
function resolveIn(ctx, drivers, groups, id, pullsOf) {
  const group = groups?.byNet.get(id);
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
  for (const member of group.members) {
    if (ctx.supplyPlusVolts.has(member)) chipLevels.push(H);
    else if (ctx.supplyMinus.has(member)) chipLevels.push(L);
    else {
      chipLevels.push(...(drivers.get(member) ?? []));
      pullLevels.push(...pullsOf(member));
    }
  }
  return resolveNet({
    supplyPlus: ctx.supplyPlusVolts.has(id),
    supplyMinus: ctx.supplyMinus.has(id),
    chipLevels,
    pullLevels,
  });
}

const noPulls = () => [];

/** Does a diode whose anode net reads `level` pass a HIGH on? In the WIDE
    reading an unknown anode might be HIGH, so it does. */
const passesHigh = (level, wide) => level === H || (wide && level === X);

/**
 * Does a diode feed anything at all into its cathode net? Not when that net
 * is a supply's: the rail decides its own level, and a HIGH added to it
 * would only travel on — through a transistor or a switch joined to the
 * rail — as a driver the rail itself overrules. (One forward into ground is
 * burning, which the LED rule's levels still say: its anode is strongly HIGH,
 * its cathode the rail's LOW.)
 */
const feedsCathode = (ctx, d) =>
  !ctx.supplyPlusVolts.has(d.cathode) && !ctx.supplyMinus.has(d.cathode);

/** `drivers` plus `extra` (netId → how many diodes drive a HIGH onto it). */
function withExtraHighs(drivers, extra) {
  if (!extra.size) return drivers;
  const merged = new Map(drivers);
  for (const [net, count] of extra) {
    merged.set(net, [...(drivers.get(net) ?? []), ...Array(count).fill(H)]);
  }
  return merged;
}

/**
 * The DIODES' strong drive for one pass: every diode whose anode net is
 * STRONGLY HIGH — from a supply or an output, never a pull — drives its
 * cathode net HIGH at output strength, to a fixpoint (a chain of diodes passes
 * a level down it, one diode a round). It starts from no diode driving at all
 * and only ever adds a HIGH, so it is monotone, cannot hold itself up, and
 * settles within one round per diode.
 *
 * Returns the drivers with every diode's HIGH added, and the strong levels
 * they resolve to — or `levels: null` when there are no diodes, so a desk
 * without one pays nothing.
 */
function diodeDrive(ctx, drivers, groups, wide) {
  if (!ctx.diodes.length) return { drivers, levels: null };
  let extra = new Map();
  let merged = drivers;
  let levels = null;
  for (let round = 0; round <= ctx.diodes.length; round++) {
    levels = new Map();
    for (const id of ctx.netIds) {
      levels.set(id, resolveIn(ctx, merged, groups, id, noPulls).level);
    }
    const next = new Map();
    for (const d of ctx.diodes) {
      if (!feedsCathode(ctx, d) || !passesHigh(levels.get(d.anode), wide)) {
        continue;
      }
      next.set(d.cathode, (next.get(d.cathode) ?? 0) + 1);
    }
    if (mapsEqual(next, extra)) break;
    extra = next;
    merged = withExtraHighs(drivers, extra);
  }
  return { drivers: merged, levels };
}

/**
 * Resolve every net once (`resolveIn`) from supplies + the given drivers +
 * resistor pulls, across the channels `groups` joins, with every diode passing
 * its anode's HIGH on (`diodeDrive` for the strong half; the resistor
 * relaxation below for a HIGH that only arrived by a pull). A channel joining
 * the two rails themselves is a short through the switch, and said so.
 *
 * `burn` (null when no part limits an LED's current) is the `{drivers,
 * groups}` the LED rule's resolution reads instead: the drivers and joins
 * that could burn one (`driversFor`'s `hard`, `channelGroups`' `hardOn`).
 *
 * `wide` is the reading where an UNKNOWN anode passes its HIGH too. The
 * narrow reading reports `uncertain` when any anode was unknown, so the
 * caller resolves both and keeps what they agree on — as it does for a
 * channel that might be on.
 */
function resolveAll(ctx, drivers, groups = null, burn = null, wide = false) {
  const firm = diodeDrive(ctx, drivers, groups, wide);
  const all = firm.drivers;
  const resolveOne = (id, pullsOf) => resolveIn(ctx, all, groups, id, pullsOf);

  // With resistors present, first compute each net's STRONG level (supplies +
  // chip outputs + the diodes they feed, no pulls) — that's what a resistor
  // conducts, and (unless a part limits an LED's current — `burn`) it's also
  // what callers use to tell "driven directly" from "fed through a resistor"
  // (a lit LED vs. a burnt one), so it must never itself include a pull.
  let pulls = null;
  let strong = firm.levels;
  if (ctx.resistors.length) {
    if (!strong) {
      strong = new Map();
      for (const id of ctx.netIds) {
        strong.set(id, resolveOne(id, noPulls).level);
      }
    }

    // Relax the resistor network to a fixpoint: a net one resistor just
    // pulled to H/L can itself feed the NEXT resistor down the chain (R1
    // pulling netMid, netMid's own resistor R2 pulling netFar, and so on) —
    // a single pass off the bare `strong` levels only ever sees one hop.
    // `basis` starts at the strong levels and is refined each pass; a
    // resistor chain of N resistors fully propagates in at most N passes. A
    // diode whose anode is only PULLED high passes that on as a pull — the
    // resistor still limits it — so it is a link in the same chain.
    let basis = strong;
    const links = ctx.resistors.length + ctx.diodes.length;
    for (let pass = 0; pass <= links; pass++) {
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
      for (const d of ctx.diodes) {
        if (feedsCathode(ctx, d) && passesHigh(basis.get(d.anode), wide)) {
          addPull(d.cathode, H);
        }
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
    const group = groups?.byNet.get(id);
    if (group) {
      if (!said.has(res.warning)) said.set(res.warning, new Set());
      if (said.get(res.warning).has(group)) continue;
      said.get(res.warning).add(group);
    }
    warnings.push({ type: res.warning, net: id });
  }
  for (const { members, via } of groups?.all ?? []) {
    const plus = members.find((id) => ctx.supplyPlusVolts.has(id));
    if (plus && members.some((id) => ctx.supplyMinus.has(id))) {
      warnings.push({ type: "short", net: plus, via });
    }
  }
  // What the LED rule reads (sim/junction.js): the level each net would have
  // from the sources that can burn an LED. Without a limiting part that is
  // the strong level — and without resistors nothing is weakly pulled, so
  // the resolved level IS the strong one. With one, it is resolved again
  // from the hard drivers across the hard joins (diodes passing what THOSE
  // give them): a CD4000 output, or a channel, that limits the current is no
  // more a burn than a resistor is.
  let burning = strong ?? next;
  if (burn) {
    const hard = diodeDrive(ctx, burn.drivers, burn.groups, wide);
    burning =
      hard.levels ??
      new Map(
        ctx.netIds.map((id) => [
          id,
          resolveIn(ctx, burn.drivers, burn.groups, id, noPulls).level,
        ]),
      );
  }
  // An unknown anode passed nothing in this reading — it might have passed a
  // HIGH, so the caller has to try that too.
  const uncertain = !wide && ctx.diodes.some((d) => next.get(d.anode) === X);
  return { next, warnings, strong: burning, uncertain };
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
    const channels = channelGroups(ctx, levels, state);
    const burn = (joins) =>
      ctx.limitsLed ? { drivers: hard, groups: joins ?? null } : null;
    // Each way the channels could be set (`channelGroups`), and for each a
    // diode whose anode MIGHT be HIGH tried both ways: keep only what every
    // reading agrees on. The warnings are the certain channels' alone.
    const readingOf = (r, wide = false) =>
      resolveAll(ctx, drivers, r?.on ?? null, burn(r?.hardOn), wide);
    const definite = readingOf(channels?.definite);
    const { warnings } = definite;
    let next = null;
    let strong = null;
    for (const r of channels?.readings ?? [null]) {
      const narrow =
        r === (channels?.definite ?? null) ? definite : readingOf(r);
      const tried = narrow.uncertain ? [narrow, readingOf(r, true)] : [narrow];
      for (const t of tried) {
        next = next ? agreeing(next, t.next) : t.next;
        strong = strong ? agreeing(strong, t.strong) : t.strong;
      }
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
    // A transistor's base or gate is not a CMOS chip's input: what it does
    // undriven is defined (a BJT is off, a MOSFET holds), and shown.
    if (c.passive) continue;
    const pins = c.def.pins
      .filter((p) => p.role === "input")
      .filter((p) => {
        const net = c.pinNet.get(p.n);
        // A part that counts as a connection on the net — a capacitor, a
        // diode, a transistor — means the pin is wired, whatever level it
        // settles at and whether or not that part conducts right now.
        if (net && ctx.trace.connectedByPart(net)) return false;
        return !net || (levels.get(net) ?? Z) === Z;
      })
      .map((p) => p.n);
    if (pins.length) {
      warnings.push({ type: "floating-input", chip: c.comp.id, pins });
    }
  }
  return warnings;
}

/**
 * Every powered channel part's channels as the settle left them —
 * `compId → [{a, b, on, held}]` (chip-eval.js `channelStates`): what a
 * transistor draws itself conducting from, and whether a MOSFET is holding.
 */
function channelsOf(ctx, levels, state) {
  const out = new Map();
  for (const c of ctx.chips) {
    if (!c.analogSwitch || c.status !== CHIP_STATUS.OK) continue;
    const pinLevels = new Map();
    for (const [pin, net] of c.pinNet) {
      pinLevels.set(pin, net ? (levels.get(net) ?? Z) : Z);
    }
    const own = state.get(c.comp.id) ?? initialState(c.def);
    out.set(c.comp.id, channelStates(c.def, pinLevels, own));
  }
  return out;
}

/** Assemble the public result: net levels, chip status, deduped warnings. */
function assemble(ctx, solved, extra = {}, state = extra.state ?? new Map()) {
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
    channels: channelsOf(ctx, solved.levels, state),
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
 * @returns {{netLevels:Map, chipStatus:Map, warnings:Array, iterations:number,
 *   settled:boolean, channels:Map}} — `channels`: every powered channel part's
 *   channels, compId → `[{a, b, on, held}]` (a transistor's lamp).
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
    {},
    state,
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
 *   timing: Map, channels: Map, wakeAt: number|null}}
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
