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
// strength; Z contributes nothing. A clock source drives only while it is
// POWERED — its `vcc` terminal on a PSU `+` net, its `gnd` on a `−` one. Every ground-role pin must reach the
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
//
// HOOKS — the Spice Lite seam (sim/spice/engine.js, features/spice-lite.md).
// `tick` and `settle` take an optional `hooks` object; without one (every
// caller but Spice Lite) nothing below behaves any differently. With one,
// the second engine may: see each context as it is built (`context`), name
// the def a part is EVALUATED with (`logicOf` — a timing part as its silicon,
// features/done/spice-lite-2-plan.md; the digital engine evaluates every part by
// its catalog `logic`), add to what a stepping part is told (`stepEnv`),
// answer what
// a chip READS on a net (`input` — one RC node read through different input
// thresholds), hold back what a chip DRIVES (`outputs` — a gate delay longer
// than a pass), override a pass's resolved levels (`levels`, told the levels
// the pass began from and the parts' state), name the chips whose readings
// changed with no level changing (`reread` — the incremental settle evaluates
// them again), keep a settle going while outputs are still in flight or
// readings moved (`busy`), count passes (`pass`) and
// lift the pass cap (`maxIterations`), and say what a supply really delivers
// (`psuVolts` — one past its current limit droops), what a chip loses in
// the wires to it (`chipDrop`) and what reaches a chip NOT straight across
// the rails (`chipVolts`). Each is optional and pure
// from the engine's side: the engine never learns what an analog node is.
//
// THE SETTLE (`solve`) repeats a pass — every powered chip's outputs from the
// levels as the pass began, the channels' joins, every net resolved — until
// nothing changes. The pieces of a pass are settle-pass.js's. By default a
// pass does only the work its changes reach (sim/incremental.js: the chips
// whose inputs moved, the nets whose drivers did); `mode: "full"` does all of
// it every pass (`solveFull`). The two are the same passes with the same
// results, which tests/engine-incremental.test.js holds field by field.

import { H, L, Z, X } from "./levels.js";
import {
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
  memoryWrite,
} from "./chip-eval.js";
import { rcTrace, timingProbe } from "./rc-trace.js";
import { CHIP_STATUS } from "./chip-status.js";
import {
  channelGroups,
  driversFor,
  mapsEqual,
  resolveReadings,
} from "./settle-pass.js";
import { settleIndex } from "./settle-index.js";
import { solveIncremental } from "./incremental.js";
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

export { CHIP_STATUS };

/** Settle iteration cap — beyond this a still-changing net is oscillating. */
export const MAX_ITERATIONS = 200;

/**
 * Sequential-step fixpoint cap within a single `tick` (Feature 220). A ripple
 * chain settles in ~depth iterations; beyond this a self-clocking loop is
 * oscillating — its still-changing sequential nets are marked `X` and reported,
 * mirroring the combinational settle cap.
 */
export const MAX_TICK_ITERATIONS = 200;

/**
 * Reversal is STRICT — both power pins must be actively wrong: a PSU `−` on
 * the VCC pin's net AND a PSU `+` on the GND pin's net. One wrong pin (the
 * other floating) is ordinary `UNPOWERED`; calling that "backwards" would
 * accuse the user of a mistake they may not have made.
 */
function powerStatus({
  vccVolts,
  vccMinus,
  gndVolts,
  gnd,
  damaged,
  overloaded,
  supply,
}) {
  if (damaged) return CHIP_STATUS.DAMAGED;
  if (overloaded) return CHIP_STATUS.OVERLOADED;
  if (vccMinus && gndVolts.length) return CHIP_STATUS.REVERSED;
  if (vccVolts.some((v) => v > supply.max)) return CHIP_STATUS.DAMAGED; // smoke
  if (gnd && vccVolts.some((v) => v >= supply.min)) return CHIP_STATUS.OK;
  if (gnd && vccVolts.length) return CHIP_STATUS.UNDERPOWERED;
  return CHIP_STATUS.UNPOWERED;
}

/** Below this across its pins a chip fed off the rails is UNPOWERED rather
    than underpowered, volts. */
const FED_UNPOWERED_V = 0.5;

/**
 * The power state of a chip that is not straight across the rails, from the
 * voltage across its supply pins (Spice Lite's `chipVolts`): its latches
 * first, then its family's range, as `powerStatus` reads a rail.
 */
function fedStatus(volts, def, params) {
  if (params?.damaged === true) return CHIP_STATUS.DAMAGED;
  if (params?.overloaded === true) return CHIP_STATUS.OVERLOADED;
  const supply = supplyRange(def);
  if (volts < -FED_UNPOWERED_V) return CHIP_STATUS.REVERSED;
  if (volts > supply.max) return CHIP_STATUS.DAMAGED;
  if (volts >= supply.min) return CHIP_STATUS.OK;
  return volts > FED_UNPOWERED_V
    ? CHIP_STATUS.UNDERPOWERED
    : CHIP_STATUS.UNPOWERED;
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
 * The parts of a context that are a function of the document and netlist
 * ALONE — no hook reads into them: every net, each resistor's and diode's
 * nets, the RC trace, each behavioral part's pin→net map, and memos of what
 * is derived from those plus a few hook-read values (a timed part's reading
 * of its R and C, per def; the dependency index, per `logicOf`; the boundary
 * warnings, per the chips' power). Built once with the first context of a
 * document + netlist and handed on to every context built from the same two
 * objects — under Spice Lite that is every settle, and reading each part's
 * pins off the board's geometry again was a fifth of a tick (make bench).
 */
function fixedFacts(doc, netlist) {
  const components = doc.components ?? [];
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  const netIds = [...netlist.nets.keys()];

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
    for (const [a, b, own] of def.weakBridges(comp.params)) {
      const aa = addressOfPin.get(a);
      const ab = addressOfPin.get(b);
      // A lead resolving to nothing conducts nothing — the part stays, inert.
      if (!aa || !ab) continue;
      // Nor does a resistance that will not read (an older document's value
      // kept as its text): Spice Lite has no ohms to solve it with
      // (spice/lamps.js), and the two engines say the same of one desk.
      const ohms = own ?? comp.params?.ohms;
      if (ohms != null && !(Number(ohms) > 0)) continue;
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

  // Every behavioral part's pin→net map. Every behavioral part is a BOARD
  // part: the only desk-level bricks left are the PSU and the clock, and both
  // are excluded here. (The HD44780 LCD used to be the exception — a brick
  // resolving its pins from terminal addresses — until it became two seated
  // modules.) A floating lead maps to no net — the pin still exists,
  // reading Z.
  const pinNets = new Map(); // compId → Map<pin, net|null>
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (!def || comp.kind === "psu" || comp.kind === "clock" || !hasBehavior(def)) continue; // prettier-ignore
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const pinNet = new Map();
    for (const { pin, address } of pins) {
      pinNet.set(pin, address ? netOf(address) : null);
    }
    pinNets.set(comp.id, pinNet);
  }

  return {
    netIds,
    resistors,
    diodes,
    trace,
    pinNets,
    timings: new Map(), // compId → {def, timing}
    index: null, // the catalog defs' settleIndex
    indexes: new WeakMap(), // `logicOf` → its defs' settleIndex
    boundary: null, // {key, warnings}
  };
}

/**
 * Build the per-settle FIXED context from a document + netlist: supply drivers,
 * clock terminals, and the participating chips with their pin→net maps and
 * power status (all constant while the topology is frozen). Reused across a
 * tick's pre- and post-settles. What no hook can change (`fixedFacts`) — the
 * pin maps, the couplers, the RC trace, the dependency index — is taken from
 * `base`, a context built from the same two objects, rather than read again.
 */
function buildContext(doc, netlist, hooks = null, base = null) {
  const components = doc.components ?? [];
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  const fixed = base?.fixed ?? fixedFacts(doc, netlist);
  const { netIds, resistors, diodes, trace } = fixed;

  // Supply drivers per net.
  const supplyPlusVolts = new Map(); // netId → [volts…]
  const supplyMinus = new Set(); // netIds carrying a PSU `−`
  const clocks = []; // { id, outNet, volts } — outNet null while unpowered
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (comp.kind === "psu" && def?.terminals) {
      // Spice Lite: a supply past its current limit droops (`psuVolts`).
      const set = comp.params?.volts ?? 5;
      const volts = hooks?.psuVolts ? hooks.psuVolts(comp, set) : set;
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
    }
  }

  // A clock source is an instrument on the bench, and runs from a supply like
  // one (Jason, 2026-10-07): its `vcc` terminal on a PSU `+` net and its
  // `gnd` on a `−` net. Its HIGH is that supply's voltage (`volts`, which
  // Spice Lite reads); unpowered it drives nothing at all, and one whose
  // output is wired into the circuit says so (`clock-unpowered`). Read after
  // every supply, so a clock listed before its PSU is judged the same.
  const clockWarnings = [];
  for (const comp of components) {
    if (comp.kind !== "clock" || !partDef(comp.ref)?.terminals) continue;
    const outNet = netOf(formatAddress(comp.id, "out"));
    const vccNet = netOf(formatAddress(comp.id, "vcc"));
    const gndNet = netOf(formatAddress(comp.id, "gnd"));
    const supplied = (vccNet && supplyPlusVolts.get(vccNet)) || [];
    const powered =
      supplied.length > 0 && gndNet != null && supplyMinus.has(gndNet);
    clocks.push({
      id: comp.id,
      outNet: powered ? outNet : null,
      volts: powered ? Math.max(...supplied) : null,
    });
    const wired = (netlist.nets.get(outNet)?.points?.length ?? 0) > 1;
    if (!powered && wired) {
      clockWarnings.push({ type: "clock-unpowered", chip: comp.id });
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

  // Chips (combinational + sequential): pin→net maps + power status.
  const chips = [];
  const chipStatus = new Map();
  // Whether any part is evaluated by something other than its catalog
  // `logic` (`logicOf`): the dependency index is the catalog defs', so it is
  // built afresh for such a desk.
  let swapped = false;
  for (const comp of components) {
    const catalogDef = partDef(comp.ref);
    if (
      !catalogDef ||
      comp.kind === "psu" ||
      comp.kind === "clock" ||
      !hasBehavior(catalogDef)
    ) {
      continue;
    }
    // The def it is evaluated with: its own, or — under Spice Lite — a timing
    // part's silicon (`logicOf`). Pins, family and supply are the same.
    const def = hooks?.logicOf ? hooks.logicOf(catalogDef) : catalogDef;
    if (def !== catalogDef) swapped = true;
    // Its pin→net map (`fixedFacts`; none for a part whose footprint has no
    // seat — it takes no part).
    const pinNet = fixed.pinNets.get(comp.id);
    if (!pinNet) continue;
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
    // The supply its VCC net carries — and, under Spice Lite, less what the
    // chip loses in the wires to it (`chipDrop`). The drop is the POWER
    // check's and the voltage the chip is said to see; WHICH supply it is on
    // (the boundary warnings' question) is the undropped one, or two chips on
    // one supply at different distances from it read as a mixed supply.
    const supplied = (vccNet && supplyPlusVolts.get(vccNet)) || [];
    const drop = hooks?.chipDrop ? hooks.chipDrop(comp.id) : 0;
    const vccVolts = drop ? supplied.map((v) => v - drop) : supplied;
    // Spice Lite: a chip NOT straight across the rails — fed through a
    // resistor, a diode, a transistor, another chip's output — runs at the
    // voltage that reaches its pins (`chipVolts`, from its voltage solve).
    const railFed =
      supplied.length > 0 &&
      gndNets.length > 0 &&
      gndNets.every((net) => supplyMinus.has(net));
    const fed =
      !passive && !railFed && hooks?.chipVolts
        ? hooks.chipVolts(comp, vccNet, gndNets)
        : null;
    const status = passive
      ? CHIP_STATUS.OK
      : fed != null
        ? fedStatus(fed, def, comp.params)
        : powerStatus({
            vccVolts,
            vccMinus: supplyMinus.has(vccNet),
            gndVolts: gndNets.flatMap(
              (net) => (net && supplyPlusVolts.get(net)) || [],
            ),
            gnd:
              gndNets.length > 0 &&
              gndNets.every((net) => supplyMinus.has(net)),
            damaged: comp.params?.damaged === true,
            overloaded: comp.params?.overloaded === true,
            supply: supplyRange(def),
          });
    // The supply the chip SAW (the highest, should two meet on one net) —
    // the number its underpowered/damaged message states.
    const volts = fed ?? (vccVolts.length ? Math.max(...vccVolts) : null);
    const supplyVolts = fed ?? (supplied.length ? Math.max(...supplied) : null); // prettier-ignore
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
      supplyVolts,
      // A timed part's reading of its own R and C — a fact about the frozen
      // topology (and the parts' values), so it is taken once per def.
      timing: timed ? timingOf(fixed, comp.id, def, pinNet) : null,
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
    // What it was built from: `tick`/`settle` reuse a context handed back to
    // them only while both are still the very same objects.
    doc,
    netlist,
    netIds,
    supplyPlusVolts,
    supplyMinus,
    clocks,
    clockWarnings,
    signals,
    resistors,
    diodes,
    trace,
    chips,
    chipStatus,
    // Whether any part limits an LED's current — when none does, the LED
    // rule's resolution is the ordinary strong one and is not computed twice.
    limitsLed: chips.some((c) => c.limitsLevel.size > 0 || c.limitsChannel),
    boundaryWarnings: boundaryOf(
      fixed,
      swapped,
      chips,
      chipStatus,
      supplyPlusVolts,
      supplyMinus,
      resistors,
    ),
    // The dependency index is the defs' (sim/settle-index.js): one for the
    // catalog's, one per `logicOf` that evaluates a part as something else.
    index: indexOf(fixed, swapped ? hooks.logicOf : null, () =>
      settleIndex({
        netIds,
        supplyPlusVolts,
        supplyMinus,
        resistors,
        diodes,
        chips,
        clocks,
        signals,
      }),
    ),
    fixed,
  };
}

/** A timed part's reading of its R and C (`def.logic.timing`), once per
    def it is evaluated as. */
function timingOf(fixed, id, def, pinNet) {
  const memo = fixed.timings.get(id);
  if (memo?.def === def) return memo.timing;
  const timing = def.logic.timing(timingProbe(fixed.trace, pinNet));
  fixed.timings.set(id, { def, timing });
  return timing;
}

/** The dependency index for the defs `logicOf` evaluates the parts as (null:
    the catalog's own). */
function indexOf(fixed, logicOf, build) {
  if (!logicOf) return (fixed.index ??= build());
  let index = fixed.indexes.get(logicOf);
  if (!index) fixed.indexes.set(logicOf, (index = build()));
  return index;
}

/** The boundary warnings — the same while every chip's power and every
    supply's volts are (a Spice Lite droop or wire drop moves them). */
function boundaryOf(
  fixed,
  swapped,
  chips,
  chipStatus,
  supplyPlusVolts,
  supplyMinus,
  resistors,
) {
  let key = swapped ? "s" : "c";
  for (const c of chips) key += `|${c.status}:${c.supplyVolts}`;
  for (const [net, volts] of supplyPlusVolts) key += `|${net}=${volts.join(",")}`; // prettier-ignore
  if (fixed.boundary?.key === key) return fixed.boundary.warnings;
  const warnings = boundaryWarnings(chips, chipStatus, supplyPlusVolts, supplyMinus, resistors); // prettier-ignore
  fixed.boundary = { key, warnings };
  return warnings;
}

/**
 * The fixed context of a document + netlist, built ONCE and handed back to
 * `tick`/`settle` as `context` for as long as neither changes — rebuilding it
 * every tick (power status, every chip's pin map, the RC timing analyses,
 * the boundary warnings) was a quarter of a busy tick (make bench). It is
 * only ever reused for the very same `doc` and `netlist` OBJECTS, so a caller
 * that hands in a new snapshot or a rebuilt netlist gets a fresh one, and one
 * that edits a document IN PLACE must not pass a context at all. Read-only.
 * @param {object} doc
 * @param {{netOfPoint: Map, nets: Map}} netlist
 */
export function prepareCircuit(doc, netlist) {
  return buildContext(doc, netlist);
}

/**
 * The context for this call: the caller's, when it was built from these very
 * objects, else a fresh one. Never the caller's under HOOKS: Spice Lite's
 * `psuVolts`, `chipDrop` and `logicOf` are read while a context is built (a
 * drooping supply decides who is powered, a timer is evaluated as its
 * silicon), and
 * they change from tick to tick — so a context built with them is no pure
 * function of the document and netlist, and one built without them would
 * silently ignore them. What no hook reads (`fixedFacts`: the pin maps, the
 * couplers, the RC trace, the dependency index for each `logicOf`), though,
 * a fresh context under hooks still takes from the caller's.
 */
function contextFor(context, doc, netlist, hooks = null) {
  const same = context?.doc === doc && context?.netlist === netlist;
  if (same && !hooks) return context;
  return buildContext(doc, netlist, hooks, same ? context : null);
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
    // The supply it is ON — never less a Spice Lite wire drop (buildContext).
    const volts = c.supplyVolts ?? null;
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
 * Run the warm-started settle loop for a fixed state + clock phase + images
 * + signal levels. `observer` (the chip debugger's — see `tick`) hears each
 * pass begin, and every watched chip it evaluates. `mode` picks how a pass
 * does its work, never what it finds: "full" resolves every chip and every
 * net every pass (`solveFull`, the reference), anything else only what the
 * pass's changes reach (sim/incremental.js) — with `carry`, the previous
 * solve of the same tick's work. `stats` counts what was done.
 */
function solve(
  ctx,
  warmStart,
  state,
  clockPhase,
  images,
  signalLevels,
  observer = null,
  hooks = null,
  { mode = "incremental", carry = null, stats = null } = {},
) {
  const cap = hooks?.maxIterations ?? MAX_ITERATIONS;
  if (mode === "full") {
    return solveFull(ctx, warmStart, state, clockPhase, images, signalLevels, observer, hooks, cap, stats); // prettier-ignore
  }
  return solveIncremental(ctx, warmStart, state, clockPhase, images, signalLevels, observer, hooks, cap, carry, stats); // prettier-ignore
}

/** The settle loop as it always ran: every pass evaluates every chip and
    resolves every net. */
function solveFull(
  ctx,
  warmStart,
  state,
  clockPhase,
  images,
  signalLevels,
  observer,
  hooks,
  cap,
  stats,
) {
  let levels = new Map();
  for (const id of ctx.netIds) levels.set(id, warmStart.get(id) ?? Z);

  let iterations = 0;
  let settled = false;
  let lastWarnings = [];
  let lastStrong = new Map();
  let prev = levels;
  if (stats) stats.solves = (stats.solves ?? 0) + 1;
  while (iterations < cap) {
    // The pass's starting levels, and the strong levels that go with them
    // (resolved alongside them by the pass before — none yet on the first).
    observer?.round("settle", levels, iterations ? lastStrong : null);
    iterations++;
    hooks?.pass?.();
    const { drivers, hard } = driversFor(
      ctx,
      levels,
      state,
      clockPhase,
      images,
      signalLevels,
      observer,
      hooks,
    );
    const channels = channelGroups(ctx, levels, state, hooks?.input);
    const resolved = resolveReadings(ctx, drivers, hard, channels);
    let next = resolved.next;
    if (hooks?.levels) next = hooks.levels(next, { start: levels, state });
    lastWarnings = resolved.warnings;
    lastStrong = resolved.strong;
    if (stats) {
      stats.passes = (stats.passes ?? 0) + 1;
      stats.resolutions = (stats.resolutions ?? 0) + ctx.netIds.length;
      stats.evaluations = (stats.evaluations ?? 0) + ctx.chips.filter((c) => c.status === CHIP_STATUS.OK && !c.analogSwitch).length; // prettier-ignore
    }
    if (mapsEqual(next, levels) && !hooks?.busy?.()) {
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
function channelsOf(ctx, levels, state, hooks = null) {
  const out = new Map();
  for (const c of ctx.chips) {
    if (!c.analogSwitch || c.status !== CHIP_STATUS.OK) continue;
    const pinLevels = new Map();
    for (const [pin, net] of c.pinNet) {
      // Read as the settle's channels read it (`channelGroups`).
      const level = net ? (levels.get(net) ?? Z) : Z;
      pinLevels.set(pin, hooks?.input ? hooks.input(c, pin, net, level) : level); // prettier-ignore
    }
    const own = state.get(c.comp.id) ?? initialState(c.def);
    out.set(c.comp.id, channelStates(c.def, pinLevels, own));
  }
  return out;
}

/** Assemble the public result: net levels, chip status, deduped warnings. */
function assemble(
  ctx,
  solved,
  extra = {},
  state = extra.state ?? new Map(),
  hooks = null,
) {
  const warnings = [...solved.warnings];
  for (const c of ctx.chips) {
    const volts = ctx.chipStatus.get(c.comp.id)?.volts ?? null;
    if (c.status === CHIP_STATUS.UNDERPOWERED) {
      warnings.push({ type: "underpowered", chip: c.comp.id, volts });
    } else if (c.status === CHIP_STATUS.REVERSED) {
      warnings.push({ type: "reversed", chip: c.comp.id });
    } else if (c.status === CHIP_STATUS.DAMAGED) {
      warnings.push({ type: "damaged", chip: c.comp.id, volts });
    } else if (c.status === CHIP_STATUS.OVERLOADED) {
      warnings.push({ type: "overloaded", chip: c.comp.id });
    }
  }
  warnings.push(...floatingInputWarnings(ctx, solved.levels));
  warnings.push(...ctx.boundaryWarnings);
  warnings.push(...ctx.clockWarnings);
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
    channels: channelsOf(ctx, solved.levels, state, hooks),
    // Each clock source's supply, volts — null while it is unpowered (and
    // so stopped), which the desk's clock lamp reads.
    clockSupply: new Map(ctx.clocks.map((c) => [c.id, c.volts])),
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
 * @param {object} [opts.hooks], [opts.context], [opts.mode], [opts.stats] -
 *   as for `tick`.
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
  hooks = null,
  context = null,
  mode = "incremental",
  stats = null,
}) {
  const ctx = contextFor(context, doc, netlist, hooks);
  hooks?.context?.(ctx);
  return assemble(
    ctx,
    solve(ctx, warmStart, state, clockPhase, images, signalLevels, null, hooks, { mode, stats }), // prettier-ignore
    {},
    state,
    hooks,
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
function samplePins(c, levels, hooks = null) {
  const raw = new Map();
  for (const [pin, net] of c.pinNet) {
    const level = net ? (levels.get(net) ?? Z) : Z;
    raw.set(pin, hooks?.input ? hooks.input(c, pin, net, level) : level);
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
 * @param {object} [opts.observer] - the chip debugger's ear on the tick
 *   (components/chip-debugger.js): `{watch: Set<compId>, round(phase, levels,
 *   strong), chip(compId, ins, state, prev?, next?)}`. `round` is told as each
 *   pass begins — a settle pass ("settle", its starting net levels and the
 *   strong levels that go with them, null when not yet known) or a step pass
 *   ("step") — and `chip` of every WATCHED stateful chip that pass evaluates:
 *   the inputs it read and the state it read them with, plus, on a step pass,
 *   the previous inputs and the state it stepped to. An observer may also
 *   carry `evaluated(compId, pinLevels, outputs)`, told of EVERY chip a settle
 *   pass evaluates, watched or not — what the engine benchmark counts
 *   (bench/engine.bench.js). It changes nothing: the engine is exactly as pure
 *   with one as without.
 * @param {object} [opts.hooks] - the Spice Lite seam (see the file header);
 *   null — every caller but sim/spice/engine.js — is the digital engine.
 * @param {object} [opts.context] - `prepareCircuit(document, netlist)`, kept by
 *   a caller ticking the same document over and over (SimController); used
 *   only while it was built from these very objects, and never under hooks.
 * @param {"incremental"|"full"} [opts.mode] - how a settle pass does its work,
 *   never what it finds: "full" evaluates every chip and resolves every net
 *   every pass (the reference tests/engine-incremental.test.js holds the
 *   default to); the default does only what a pass's changes reach. For tests
 *   and the bench — nothing in the app passes it.
 * @param {object} [opts.stats] - counters the engine adds to (passes, chip
 *   evaluations, net resolutions, each fallback — sim/incremental.js); tests
 *   and the bench only.
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
  observer = null,
  hooks = null,
  context = null,
  mode = "incremental",
  stats = null,
}) {
  const ctx = contextFor(context, doc, netlist, hooks);
  hooks?.context?.(ctx);

  // ① Pre-settle: propagate the new clock phase / input changes with the OLD
  //    sequential state holding.
  let solved = solve(
    ctx,
    warmStart,
    state,
    clockPhase,
    images,
    signalLevels,
    observer,
    hooks,
    { mode, stats },
  );

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
    observer?.round("step", solved.levels, solved.strong);
    for (const c of ctx.chips) {
      if (!c.sequential) continue;
      const ins = samplePins(c, solved.levels, hooks);
      sampled.set(c.comp.id, ins);
      finalIns.set(c.comp.id, ins);
      const current = curState.get(c.comp.id) ?? initialState(c.def);
      const before = prevIns.get(c.comp.id) ?? null;
      const next =
        c.status === CHIP_STATUS.OK
          ? stepChip(c.def, current, ins, before, {
              now,
              timing: c.timing,
              ...hooks?.stepEnv?.(c),
            })
          : current; // inert chip holds; drives nothing
      if (c.status === CHIP_STATUS.OK && observer?.watch.has(c.comp.id)) {
        observer.chip(c.comp.id, ins, current, before, next);
      }
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
    // Each re-solve carries the last one's work on (sim/incremental.js):
    // the chips whose state this step replaced are evaluated again, and the
    // step pass itself moved no net.
    solved = solve(
      ctx,
      solved.levels,
      curState,
      clockPhase,
      images,
      signalLevels,
      observer,
      hooks,
      { mode, stats, carry: solved.carry },
    );
  }

  // Memory: no clocked state — read its inputs from the FINAL settled levels and
  // REPORT any write op for the controller to apply (the engine never mutates
  // the image). Populate its pin levels for parity with sequential chips.
  const memWrites = [];
  for (const c of ctx.chips) {
    if (!c.memory) continue;
    const ins = samplePins(c, solved.levels, hooks);
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

  const result = assemble(
    ctx,
    solved,
    { state: curState, pinLevels: finalIns, memWrites, wakeAt },
    undefined,
    hooks,
  );
  if (extraWarnings.length) {
    result.warnings = dedupe([...result.warnings, ...extraWarnings]);
    result.settled = false;
  }
  return result;
}
