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
// family-less part: 5 V only; CD4000: 3–18 V (catalog/families.js). A little
// under the range — down to the family's `floor`, 4.5 V for 74LS, 2.7 V for
// CD4000 — it still WORKS: "ok", with `margin` on its status and an
// `underpowered` warning saying so (Jason, 2026-10-27).
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
import { EARTHED_AC } from "../catalog/ac-parts.js";
import { floatingGrounds, stackedSupplies } from "./floating-grounds.js";
import {
  familyOf,
  floatsUnknown,
  limitsLedCurrent,
  lsFanoutOf,
  marginOf,
  supplyFloor,
  supplyRange,
} from "../catalog/families.js";
import { partPinAddresses } from "../model/occupancy.js";
import { formatAddress } from "../model/breadboard.js";
import { drivesPins } from "../model/integration.js";
import { regulatorFacts, regulatorSupplies } from "./regulators.js";
import { ASSERT_ANALYSIS } from "./assert-modes.js";

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
  floor = supply.min,
}) {
  if (damaged) return CHIP_STATUS.DAMAGED;
  if (overloaded) return CHIP_STATUS.OVERLOADED;
  // (Its VCC on a − that is a + too, or its GND on a + that is a − too, is
  // the rails shorted, not this chip turned round: every chip on them was
  // told its VCC and GND were swapped.)
  if (vccMinus) return gndVolts.length && !vccVolts.length && !gnd ? CHIP_STATUS.REVERSED : CHIP_STATUS.UNPOWERED; // prettier-ignore
  if (vccVolts.some((v) => v > supply.max)) return CHIP_STATUS.DAMAGED; // smoke
  // (Down to its floor: under its range's minimum but over that, it works —
  // the caller marks it `margin`.)
  if (gnd && vccVolts.some((v) => v >= floor)) return CHIP_STATUS.OK;
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
  if (volts >= supplyFloor(def)) return CHIP_STATUS.OK;
  return volts > FED_UNPOWERED_V
    ? CHIP_STATUS.UNDERPOWERED
    : CHIP_STATUS.UNPOWERED;
}

/**
 * Each supply net's potential, volts — the logic engine's reading of a chip
 * that is not across a + rail and ground (`supplySpan`): ground 0, a + rail
 * its supply's (the highest, should two meet on it), a stacked supply's −
 * rail below ground. A net both a + and a − (the rails shorted) has none.
 */
function supplyPotentials(supplyPlusVolts, supplyMinus, belowGround) {
  const out = new Map();
  for (const [net, volts] of supplyPlusVolts) {
    if (!supplyMinus.has(net)) out.set(net, Math.max(...volts));
  }
  for (const net of supplyMinus) {
    if (!supplyPlusVolts.has(net)) out.set(net, belowGround.get(net) ?? 0);
  }
  return out;
}

/** The volts across a chip's supply pins when each is on a supply net — its
    VCC's potential less its highest ground's, as Spice Lite's `chipVolts`
    reads them — else null. */
function supplySpan(potential, vccNet, gndNets) {
  const vcc = potential.get(vccNet);
  if (vcc == null || !gndNets.length) return null;
  let gnd = Number.NEGATIVE_INFINITY;
  for (const net of gndNets) {
    const v = potential.get(net);
    if (v == null) return null;
    gnd = Math.max(gnd, v);
  }
  return vcc - gnd;
}

/**
 * The supply nets a chip on a span of its own (`supplySpan`) reads the other
 * way to their level on the desk: a + rail at or below its ground is its
 * LOW (the lower supply's + under a chip across the upper of two stacked),
 * a ground at or above its VCC its HIGH (0 V to a chip on 0..−5 V). Read in
 * place of the net's level wherever the chip reads its pins; null for none.
 */
function railReadsOf(def, pinNet, potential, vccNet, gndNets, supplyMinus) {
  const hi = potential.get(vccNet);
  let lo = Number.NEGATIVE_INFINITY;
  for (const net of gndNets) lo = Math.max(lo, potential.get(net));
  let out = null;
  for (const p of def.pins) {
    if (p.role === "vcc" || p.role === "gnd") continue;
    const net = pinNet.get(p.n);
    const v = net == null ? undefined : potential.get(net);
    if (v == null) continue;
    const level = supplyMinus.has(net) ? L : H;
    const reads = v <= lo ? L : v >= hi ? H : level;
    if (reads !== level) (out ??= new Map()).set(net, reads);
  }
  return out;
}

/**
 * `supplies-meet` warnings: each `+` net that two or more PSUs feed at
 * different SET voltages — `{type, net, volts, psus}`, volts ascending and
 * each PSU named once. Two supplies at the same voltage in parallel are left
 * alone, and so is any `−` net (every supply shares a ground).
 */
function suppliesMeet(components, netOf) {
  const byNet = new Map(); // netId → [{id, volts}]
  for (const comp of components) {
    if (comp.kind !== "psu" || !partDef(comp.ref)?.terminals) continue;
    const net = netOf(formatAddress(comp.id, "+"));
    if (!net) continue;
    if (!byNet.has(net)) byNet.set(net, []);
    byNet.get(net).push({ id: comp.id, volts: comp.params?.volts ?? 5 });
  }
  const out = [];
  for (const [net, feeds] of byNet) {
    const volts = [...new Set(feeds.map((f) => f.volts))].sort((a, b) => a - b);
    if (volts.length < 2) continue;
    out.push({
      type: "supplies-meet",
      net,
      volts,
      psus: feeds.map((f) => f.id),
    });
  }
  return out;
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
      // Its conductance weighs its pull against an opposing one
      // (resolve.js): a divider decides, as on the bench.
      resistors.push({ netA: netOf(aa), netB: netOf(ab), siemens: ohms != null ? 1 / Number(ohms) : null }); // prettier-ignore
    }
  }

  // Diodes: one-way couplers. A pair whose leads land in ONE net (a shorted
  // diode) or on nothing conducts nothing — the part stays, inert.
  const diodes = []; // { id, anode, cathode, zener }
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
      // (`zener`: it can also conduct cathode → anode, past its breakdown —
      // what Spice Lite's solve gives it and `wiredLow` has to know.)
      diodes.push({ id: comp.id, anode, cathode, zener: def.diode?.zener === true }); // prettier-ignore
    }
  }

  // The capacitors and resistors as a timing part reads them (and the one
  // thing the engine itself asks of them: is a pin whose net holds nothing
  // else really floating?).
  const trace = rcTrace(doc, netlist);

  // The linear regulators, whose outputs the logic engine makes supplies
  // (sim/regulators.js).
  const regulators = regulatorFacts(doc, netlist, trace);

  // Each AC adapter's floating circuit's ground (Spice Lite's alone).
  const floating = floatingGrounds(doc, netlist);

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
    regulators,
    floating,
    pinNets,
    timings: new Map(), // compId → {def, timing}
    index: null, // the catalog defs' settleIndex
    regulatedIndex: null, // …with the regulators' outputs as supplies
    groundedIndex: null, // …with the mains' N nets and floating grounds as rails
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
  const clocks = []; // { id, outNet, wired, volts } — outNet null while unpowered
  let acGrounded = false; // an AC supply's N is among the − nets
  // A supply STACKED on another (sim/floating-grounds.js — a ± rail, or one
  // on top of another): its end on the other's net is that net's, and its
  // own end a + rail at the stack's volts above ground, or a − below it —
  // read as one more ground, as an adapter's floating ground is (the
  // 2026-10-26 review: every − was ground, so a ± pair was a short). Its
  // delivered volts ride `stackedVolts` (Spice Lite's droop).
  const stacked = stackedSupplies(doc, netlist);
  const stackedVolts = new Map(); // psu id → the volts it delivers
  const belowGround = new Map(); // a stacked − rail → its volts (negative)
  for (const comp of components) {
    const def = partDef(comp.ref);
    if (comp.kind === "psu" && def?.terminals) {
      // Spice Lite: a supply past its current limit droops (`psuVolts`).
      const set = comp.params?.volts ?? 5;
      const volts = hooks?.psuVolts ? hooks.psuVolts(comp, set) : set;
      const st = stacked.get(comp.id);
      if (st) stackedVolts.set(comp.id, volts);
      for (const t of def.terminals) {
        const net = netOf(formatAddress(comp.id, t.id));
        if (!net) continue;
        if (st && net === st.shared) continue;
        if (st && net === st.rail) {
          if (st.volts > 0) {
            if (!supplyPlusVolts.has(net)) supplyPlusVolts.set(net, []);
            supplyPlusVolts.get(net).push(st.volts - set + volts);
          } else {
            supplyMinus.add(net);
            belowGround.set(net, st.volts + set - volts);
          }
          continue;
        }
        if (t.id === "+") {
          if (!supplyPlusVolts.has(net)) supplyPlusVolts.set(net, []);
          supplyPlusVolts.get(net).push(volts);
        } else {
          supplyMinus.add(net);
        }
      }
    }
    // The mains' N is a ground like a PSU's −
    // — to Spice Lite only (spice/ac-supplies.js): the logic engine has no
    // AC, so there the source is nothing at all.
    if (hooks && EARTHED_AC[comp.kind]) {
      const net = netOf(formatAddress(comp.id, EARTHED_AC[comp.kind].neutral));
      if (net) supplyMinus.add(net);
      acGrounded ||= net != null;
    }
  }
  // An AC adapter's circuit floats: its ground is where the
  // bench would put the black lead (sim/floating-grounds.js) — held at 0 V
  // as a PSU's − is. Held instead by a gigohm's tie to earth, every
  // capacitor on it was a common mode balanced afresh at every corner: a
  // third of an AC-to-5 V supply's run.
  if (hooks) {
    for (const net of fixed.floating.values()) {
      supplyMinus.add(net);
      acGrounded = true;
    }
  }
  // …and on a desk with nothing to say where ground is — no PSU, no mains,
  // no adapter's circuit — a breadboard's − rail strips are ground, as on
  // the bench where the meter's black lead goes (Spice Lite only). After the
  // adapters' grounds, so a rail never overrules the analyzer's ground lead
  // on an adapter's circuit (an adapter needs no mains brick, so its desk
  // may have no other ground at all).
  if (hooks && supplyMinus.size === 0 && supplyPlusVolts.size === 0) {
    for (const [id, net] of netlist.nets) {
      if (!net.rails?.some((r) => r.endsWith("-"))) continue;
      supplyMinus.add(id);
      acGrounded = true;
    }
  }

  // A regulator's OUT is a supply wherever its IN is one high enough — to
  // the logic engine only: under Spice Lite it is a device the voltage
  // solve holds OUT with (spice/analog-devices.js).
  const regulated =
    !hooks && fixed.regulators.length
      ? regulatorSupplies(fixed.regulators, supplyPlusVolts, supplyMinus)
      : null;

  // Two supplies set to DIFFERENT voltages on one `+` net — the halves of a
  // split rail jumpered together, or two PSUs on one rail. The engine still
  // runs the net at the highest (as before); this is what says it should not.
  // Judged on each PSU's SET voltage, not `psuVolts`: Spice Lite's droop
  // would part two equal supplies by millivolts. Shared grounds never clash.
  const supplyWarnings = suppliesMeet(components, netOf);

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
    let powered =
      supplied.length > 0 && gndNet != null && supplyMinus.has(gndNet);
    let volts = powered ? Math.max(...supplied) : null;
    // Spice Lite: one off the rails — its `vcc` past a multimeter's shunt in
    // its supply's lead, or through a resistor — runs at what reaches its
    // terminals (`clockVolts`, from its voltage solve), as a chip does.
    if (!powered && hooks?.clockVolts && vccNet && gndNet) {
      const fed = hooks.clockVolts(comp, vccNet, gndNet);
      if (fed > 0) {
        powered = true;
        volts = fed;
      }
    }
    clocks.push({
      id: comp.id,
      outNet: powered ? outNet : null,
      // …and the net it is wired to whatever its power: the settle index's
      // (settle-index.js `sources`), shared by contexts that power it
      // differently — a clock past a meter's shunt is fed off the rails
      // only once Spice Lite's solve says what reaches it.
      wired: outNet,
      volts,
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
  // every solve. A DATA bus's pins are the same flags pressed by hand (their
  // levels come from the card — SimController's `#driveLevels`). An Output's
  // tags and every trigger tag only LISTEN.
  for (const element of doc.integrations ?? []) {
    if (!drivesPins(element)) continue;
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
  let potential = null; // supply net → volts (`supplyPotentials`), when asked
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
    // (Its ground on a stacked supply's − rail, below ground: it runs on
    // the whole span — an LM358 on ±5 V sees 10 V.)
    let floor = 0;
    for (const net of gndNets) floor = Math.min(floor, belowGround.get(net) ?? 0); // prettier-ignore
    const vccVolts = drop || floor ? supplied.map((v) => v - drop - floor) : supplied; // prettier-ignore
    // Spice Lite: a chip NOT straight across the rails — fed through a
    // resistor, a diode, a transistor, another chip's output — runs at the
    // voltage that reaches its pins (`chipVolts`, from its voltage solve).
    const railFed =
      supplied.length > 0 &&
      gndNets.length > 0 &&
      gndNets.every((net) => supplyMinus.has(net));
    // The logic engine: one whose supply pins are all on supply nets runs
    // on the span between them (`supplySpan`) — across the upper of two
    // stacked supplies, or 0 V..−5 V of a ± pair — as Spice Lite's voltage
    // solve reads it (the regrade, 2026-10-26: the first read damaged at
    // 10 V, the second unpowered).
    const fed =
      passive || railFed
        ? null
        : hooks
          ? (hooks.chipVolts?.(comp, vccNet, gndNets) ?? null)
          : supplySpan((potential ??= supplyPotentials(supplyPlusVolts, supplyMinus, belowGround)), vccNet, gndNets); // prettier-ignore
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
            floor: supplyFloor(def),
          });
    // The supply the chip SAW (the highest, should two meet on one net) —
    // the number its underpowered/damaged message states. A chip whose VCC
    // is on a supply but whose ground floats has nothing ACROSS it: 0 V, as
    // Spice Lite's voltage solve reads it, not its VCC's 5.
    const grounded = gndNets.length > 0 && gndNets.every((net) => supplyMinus.has(net)); // prettier-ignore
    const volts =
      fed ??
      (!vccVolts.length ? null : !grounded && status === CHIP_STATUS.UNPOWERED ? 0 : Math.max(...vccVolts)); // prettier-ignore
    const supplyVolts = fed ?? (supplied.length ? Math.max(...supplied) : null); // prettier-ignore
    // Its (ground, VCC) POTENTIALS — the boundary warnings' key: two chips
    // each on 5 V, one on 0..5 and one across the upper of two stacked
    // supplies (5..10), are on different supplies though their spans agree.
    // (Under Spice Lite, a part fed off the rails reads from its ground;
    // those warnings are retired there.)
    let supplyLow = 0;
    if (!hooks && supplyVolts != null) {
      potential ??= supplyPotentials(supplyPlusVolts, supplyMinus, belowGround); // prettier-ignore
      supplyLow = Number.NEGATIVE_INFINITY;
      for (const net of gndNets) supplyLow = Math.max(supplyLow, potential.get(net) ?? 0); // prettier-ignore
      if (!Number.isFinite(supplyLow)) supplyLow = 0;
    }
    const supplyHigh =
      supplyVolts == null ? null : fed != null ? supplyLow + fed : supplyVolts;
    // Working, but under its range (down to its floor): it evaluates as any
    // "ok" chip does — every reader of "ok" is right about it — and is
    // marked, and warned of (`assemble`), as underpowered.
    const margin = !passive && status === CHIP_STATUS.OK && marginOf(def, volts); // prettier-ignore
    if (!passive) chipStatus.set(comp.id, margin ? { status, volts, margin } : { status, volts }); // prettier-ignore
    const oscillator = isOscillator(def);
    const analogSwitch = isAnalogSwitch(def);
    const timed = isTimed(def);
    chips.push({
      comp,
      def,
      pinNet,
      // …and the same as two parallel arrays, pin order: what each
      // evaluation and sample walks (a Map's `[pin, net]` entries are an
      // array each, every walk — a fifth of a busy tick's garbage).
      pinList: [...pinNet.keys()],
      netList: [...pinNet.values()],
      status,
      margin,
      passive,
      supplyVolts,
      supplyLow,
      supplyHigh,
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
      // The logic engine: a supply net a chip off the ground reads the other
      // way to its global level (`railReadsOf`), or null — nearly always.
      railReads:
        !hooks && fed != null && status === CHIP_STATUS.OK
          ? railReadsOf(def, pinNet, potential, vccNet, gndNets, supplyMinus)
          : null,
      // pin → the level it reads: a scratch map that each evaluation
      // (settle-pass.js `chipOutputs`) and each sample (`samplePins`) fills
      // in whole and never hands out — a fresh one per chip per pass was a
      // sixth of a busy tick's garbage.
      reads: null,
      // The reading its last evaluation made of its pins (`chipOutputs`),
      // handed back when they read the same (chip-eval.js `inputLevels`).
      lastIns: null,
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
    stackedVolts,
    clocks,
    clockWarnings,
    supplyWarnings,
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
    // A regulator's output is a supply here and not under Spice Lite, so a
    // desk with one powering something keeps an index of its own for each;
    // an AC supply's N is a rail under Spice Lite and not here, likewise.
    index: indexOf(
      fixed,
      swapped ? hooks.logicOf : null,
      regulated?.size > 0,
      acGrounded,
      () =>
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
    the catalog's own) — or, `regulated`, the logic engine's with its
    regulators' outputs as supplies (never swapped: that is Spice Lite's), or,
    `acGrounded`, Spice Lite's with its AC supplies' N nets as rails (an index
    per `logicOf` is only ever built under Spice Lite, so has them already). */
function indexOf(fixed, logicOf, regulated, acGrounded, build) {
  if (regulated) return (fixed.regulatedIndex ??= build());
  if (!logicOf && acGrounded) return (fixed.groundedIndex ??= build());
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
  for (const c of chips) key += `|${c.status}:${c.supplyVolts}:${c.supplyLow}:${c.supplyHigh}`; // prettier-ignore
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
  if (!same || !hooks) return buildContext(doc, netlist, hooks, same ? context : null); // prettier-ignore
  // Under hooks: the last context built under them, again, while every hook
  // it read answers as it did (features/09-cache-tick-analysis.md). A
  // context is a pure function of the document, the netlist, the def each
  // part is evaluated as (`logicOf`) and what `psuVolts`, `chipDrop` and
  // `chipVolts` say — the same answers, the same context.
  const fixed = context.fixed;
  const key = hookKey(fixed, doc, netlist, hooks);
  const memo = fixed.hooked;
  if (memo && memo.key === key && memo.logicOf === hooks.logicOf) {
    if (ASSERT_ANALYSIS) assertSameContext(memo.ctx, buildContext(doc, netlist, hooks, context)); // prettier-ignore
    return memo.ctx;
  }
  const ctx = buildContext(doc, netlist, hooks, context);
  fixed.hooked = { key, logicOf: hooks.logicOf, ctx };
  return ctx;
}

/** The context a `tick` with these options would settle in (`contextFor`) —
    for a caller that needs it without the settle (Spice Lite's skipped
    replay, features/05-skip-replay-settle.md). */
export function contextOf({
  context = null,
  document: doc,
  netlist,
  hooks = null,
}) {
  // prettier-ignore
  return contextFor(context, doc, netlist, hooks);
}

/** Every hook answer a context built under `hooks` reads (`buildContext`):
    each supply's delivered volts, each part's wire drop and — for a part
    not straight across the rails — the volts across its supply pins. */
function hookKey(fixed, doc, netlist, hooks) {
  const shape = (fixed.hookShape ??= hookShapeOf(fixed, doc, netlist));
  let key = "";
  for (const { comp, set } of shape.psus) {
    key += `${hooks.psuVolts ? hooks.psuVolts(comp, set) : set}|`;
  }
  for (const { comp, vccNet, gndNets, offRail } of shape.chips) {
    key += `${hooks.chipDrop ? hooks.chipDrop(comp.id) : 0}`;
    if (offRail && hooks.chipVolts) key += `:${hooks.chipVolts(comp, vccNet, gndNets)}`; // prettier-ignore
    key += "|";
  }
  for (const { comp, vccNet, gndNet } of shape.clocks) {
    if (hooks.clockVolts) key += `${comp.id}~${hooks.clockVolts(comp, vccNet, gndNet)}|`; // prettier-ignore
  }
  return key;
}

/** Where `buildContext` asks its hooks: the supplies, and every part with
    a pin map — with its supply nets, and whether it is fed off the rails
    (no supply on its VCC net, or a ground pin off the `−` nets: what the
    wiring says, whatever any supply delivers). */
function hookShapeOf(fixed, doc, netlist) {
  const netOf = (address) => netlist.netOfPoint.get(address) ?? null;
  const plus = new Set();
  const minus = new Set();
  const psus = [];
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (comp.kind !== "psu" || !def?.terminals) continue;
    psus.push({ comp, set: comp.params?.volts ?? 5 });
    for (const t of def.terminals) {
      const net = netOf(formatAddress(comp.id, t.id));
      if (net) (t.id === "+" ? plus : minus).add(net);
    }
  }
  const chips = [];
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def || comp.kind === "psu" || comp.kind === "clock" || !hasBehavior(def)) continue; // prettier-ignore
    const pinNet = fixed.pinNets.get(comp.id);
    if (!pinNet) continue;
    const passive = !def.pins.some((p) => p.role === "vcc" || p.role === "gnd");
    const vccNet = pinNet.get(def.pins.find((p) => p.role === "vcc")?.n);
    const gndNets = def.pins.filter((p) => p.role === "gnd").map((p) => pinNet.get(p.n)); // prettier-ignore
    const railFed = plus.has(vccNet) && gndNets.length > 0 && gndNets.every((net) => minus.has(net)); // prettier-ignore
    chips.push({ comp, vccNet, gndNets, offRail: !passive && !railFed });
  }
  // …and every clock brick off the rails (`clockVolts`).
  const clocks = [];
  for (const comp of doc.components ?? []) {
    if (comp.kind !== "clock") continue;
    const vccNet = netOf(formatAddress(comp.id, "vcc"));
    const gndNet = netOf(formatAddress(comp.id, "gnd"));
    if (vccNet && gndNet && !(plus.has(vccNet) && minus.has(gndNet))) clocks.push({ comp, vccNet, gndNet }); // prettier-ignore
  }
  return { psus, chips, clocks };
}

/** Assertion mode (SPICE_ASSERT_ANALYSIS): a context reused under hooks is
    held to one built afresh, in every field a settle reads. */
function assertSameContext(a, b) {
  const fail = (what) => {
    throw new Error(`SPICE_ASSERT_ANALYSIS: a reused context differs in ${what}`); // prettier-ignore
  };
  const sameMap = (x, y, eq = (u, v) => u === v) =>
    x.size === y.size && [...x].every(([k, v]) => y.has(k) && eq(v, y.get(k)));
  if (!sameMap(a.supplyPlusVolts, b.supplyPlusVolts, (u, v) => u.join() === v.join())) fail("supplyPlusVolts"); // prettier-ignore
  if ([...a.supplyMinus].join() !== [...b.supplyMinus].join()) fail("supplyMinus"); // prettier-ignore
  if (JSON.stringify(a.clocks) !== JSON.stringify(b.clocks)) fail("clocks");
  if (JSON.stringify(a.signals) !== JSON.stringify(b.signals)) fail("signals");
  if (!sameMap(a.chipStatus, b.chipStatus, (u, v) => u.status === v.status && u.volts === v.volts)) fail("chipStatus"); // prettier-ignore
  if (a.chips.length !== b.chips.length) fail("chips");
  a.chips.forEach((c, i) => {
    const d = b.chips[i];
    if (c.comp !== d.comp || c.def !== d.def || c.status !== d.status || c.supplyVolts !== d.supplyVolts || c.timing !== d.timing || [...c.limitsLevel].join() !== [...d.limitsLevel].join() || c.limitsChannel !== d.limitsChannel) fail(`chip ${c.comp.id}`); // prettier-ignore
  });
  if (a.limitsLed !== b.limitsLed) fail("limitsLed");
  if (a.index !== b.index) fail("index");
  if (JSON.stringify(a.boundaryWarnings) !== JSON.stringify(b.boundaryWarnings)) fail("boundaryWarnings"); // prettier-ignore
  if (JSON.stringify([a.clockWarnings, a.supplyWarnings]) !== JSON.stringify([b.clockWarnings, b.supplyWarnings])) fail("warnings"); // prettier-ignore
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
  // netId → { lsOut, cmosIn, lsIn, cmosOut[], supplies, driven, plain, above }
  // — a supply being a chip's (ground, VCC) potentials, keyed `lo:hi`.
  const byNet = new Map();
  const at = (net) => {
    if (!byNet.has(net)) {
      byNet.set(net, {
        lsOut: false,
        cmosIn: false,
        lsIn: 0,
        cmosOut: [],
        supplies: new Map(), // `lo:hi` → {lo, hi}, every chip's on it
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
    // The supply it is ON — never less a Spice Lite wire drop (buildContext)
    // — as its ground's and VCC's potentials.
    const supply = c.supplyHigh == null ? null : supplyOn(c.supplyLow, c.supplyHigh); // prettier-ignore
    const role = new Map(c.def.pins.map((p) => [p.n, p.role]));
    for (const [pin, net] of c.pinNet) {
      if (!net) continue;
      const r = role.get(pin);
      if (r !== "input" && r !== "output" && r !== "io") continue;
      // A switch terminal is neither: it passes another part's level. (A
      // CD4007UB's terminal on a channel from a rail is its OUTPUT — below.)
      if (c.analogSwitch && r === "io") continue;
      const entry = at(net);
      if (supply) {
        entry.supplies.set(supply.key, supply);
        if (r === "output" || r === "io") entry.driven.add(supply.key);
        if (r === "input" || r === "io") {
          (c.def.inputsAboveSupply ? entry.above : entry.plain).add(supply.key);
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
            const supply = supplyOn(c.supplyLow, v);
            at(net).supplies.set(supply.key, supply);
            at(net).driven.add(supply.key);
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
      warnings.push({ type: "mixed-supply", net, volts: clashVolts(e) });
    }
  }
  return warnings;
}

/** A chip's supply as its ground's and VCC's potentials, volts. */
function supplyOn(lo, hi) {
  return { key: `${lo}:${hi}`, lo, hi };
}

/**
 * Whether one net's chips disagree about its voltage. Its outputs, and every
 * ordinary input, need it at their OWN supply's levels, so two different
 * supplies among them clash — a different VCC, or the same span off a
 * different ground (0..5 V into the upper of two stacked, 5..10 V); a level
 * shifter's input needs only a HIGH at or above its supply's, so it clashes
 * only with a lower one, or another ground.
 */
function supplyClash({ supplies, driven, plain, above }) {
  const fixed = new Set([...driven, ...plain]);
  if (fixed.size > 1) return true;
  const [key] = fixed;
  if (key == null) return false;
  const level = supplies.get(key);
  return [...above].some((k) => {
    const s = supplies.get(k);
    return s.lo !== level.lo || s.hi > level.hi;
  });
}

/** The volts a mixed-supply warning states: each supply's VCC potential, or
    — when only the grounds differ — the span each runs on. */
function clashVolts({ supplies }) {
  const all = [...supplies.values()];
  let volts = new Set(all.map((s) => s.hi));
  if (volts.size < 2) volts = new Set(all.map((s) => s.hi - s.lo));
  return [...volts].sort((a, b) => a - b);
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
  { mode = "incremental", carry = null, stats = null, warm = null, ties = null } = {}, // prettier-ignore
) {
  const cap = hooks?.maxIterations ?? MAX_ITERATIONS;
  const once = (start, carried, warmed, owned = false) =>
    mode === "full"
      ? solveFull(ctx, start, state, clockPhase, images, signalLevels, observer, hooks, cap, stats) // prettier-ignore
      : solveIncremental(ctx, start, state, clockPhase, images, signalLevels, observer, hooks, cap, carried, stats, warmed, owned); // prettier-ignore
  const solved = once(warmStart, carry, warm);
  // A latch whose two inputs are idle at once — a cross-coupled pair settled
  // from all-floating at Run, or both of its inputs released in one tick —
  // has two steady states and no reason in a simultaneous update to pick
  // either: its gates flip together, L/L, H/H, … to the cap, and it was
  // reported oscillating, X until an input was pressed. Real silicon falls
  // one way. Break the tie once, deterministically: settle again from where
  // this one ended (the rails and everything else steady), the first racing
  // net in netId order — so both modes pick the same — taken LOW and the rest
  // HIGH, which is a cross-coupled pair's own resting state. Any settle that
  // comes of it IS a steady state of the circuit; a real ring oscillator
  // never settles from any start, and keeps its report. (The logic engine
  // only: Spice Lite's hooks own their own capped settles.)
  // Two such latches on one desk were both X for good: one LOW seed settles
  // one latch, and the other, all HIGH, raced on. So the tie is broken again
  // from the best settle so far, the next racing net LOW — up to
  // `MAX_TIE_BREAKS` times — and a settle that leaves fewer nets racing (a
  // latch settled beside a ring oscillator, which races on) is kept.
  // And ONE net LOW in each racing LOOP at once (`feedbackLoops`: the nets
  // a cycle of gates, channels, resistors and diodes runs through — never a
  // sequential chip, whose outputs are its state): one at a time, six idle
  // latches on three 74LS00s left two X past the fourth round, and a seed
  // per knot of everything a gate joined spent its rounds on the latch's
  // loads, never its loop (the regrades, 2026-10-22).
  // A settle that ENDS with a loop at X — every input reaching it from
  // outside definite — is the same tie at a standstill: a CMOS latch idle
  // at Run reads its floating nets X, and NAND(H, X) is X, so it never
  // raced and stayed X, silent; a TTL one raced once and then held X as a
  // fixed point (warm-started from it). It is broken the same way. A loop
  // whose X comes in from outside (a floating input, a fight) is left X.
  if (hooks) return solved;
  const loops = feedbackLoops(ctx);
  const racingOf = (s) => new Set(s.warnings.find((w) => w.type === "oscillation")?.nets ?? []); // prettier-ignore
  // A loop stuck as it was stuck before — the same nets X, the same entries
  // — when breaking it then came to nothing is not tried again: a loop that
  // is X for good (an RC oscillator the logic engine cannot time, an X
  // through a resistor round a gate) cost up to four settles to the cap on
  // every tick (the regrade, 2026-10-22: a 40106 relaxation oscillator
  // 0.1 → 1.2 ms a tick).
  // …and so in a settle a ring oscillator capped, for every loop it is not
  // racing in: a CMOS latch idle at Run beside one stood X for good, its
  // tie never tried, whatever the ring did (the fourth regrade, 2026-10-22).
  const stuckAll = (s) => {
    const racing = s.settled ? null : racingOf(s);
    return stuckLoops(loops, s.levels).filter((k) => !racing?.size || !k.some((id) => racing.has(id))); // prettier-ignore
  };
  // What this RUN has learnt (`ties`, `tieMemo()` — the caller's, one per
  // run, per settle mode; none: nothing is remembered from one call to the
  // next, and the engine stays a pure function of its arguments).
  // A new netlist (an edit, a bounce's gap) is a new circuit: what was learnt
  // of the old one's loops says nothing of it.
  if (ties && ties.netlist !== ctx.netlist) Object.assign(ties, tieMemo(), { netlist: ctx.netlist }); // prettier-ignore
  const memo = ties?.[mode === "full" ? "full" : "incremental"] ?? null;
  const failed = memo?.failed ?? NOTHING;
  const stuck = (s) => stuckAll(s).filter((k) => !failed.has(k.sig));
  if (solved.settled && !stuck(solved).length) return solved;
  // A ring oscillator this run has seen through a tie-break before — every
  // loop racing a loop whose seeded tie raced again, with the same entries
  // (`ringKey`), and no stuck loop left to try — races again whatever seed
  // it is given: its capped settle IS the report, without the rounds (a
  // 3-inverter ring beside the busy fixture spent four settles to the cap a
  // tick on them — the 2026-10-26 review: 0.29 → 2.06 ms a tick).
  const ringKey = (k, s) => `${k}|${loops.entries[k].map(({ net }) => s.levels.get(net) ?? Z).join("")}`; // prettier-ignore
  const racingLoops = (s) => {
    const racing = racingOf(s);
    return loops.members.flatMap((m, k) => (m.some((id) => racing.has(id)) ? [k] : [])); // prettier-ignore
  };
  if (memo && !solved.settled && !stuck(solved).length) {
    const ks = racingLoops(solved);
    if (ks.length && ks.every((k) => memo.rings.has(ringKey(k, solved)))) return solved; // prettier-ignore
  }
  const xOnLoops = (s) => stuckAll(s).reduce((n, k) => n + k.length, 0);
  // Whether loop `k` is gates alone — no capacitor on it (an RC
  // oscillator the logic engine cannot time) and no resistor between two of
  // its nets (an inverter biased by its own feedback resistor is an
  // amplifier, not a ring: it raced once seeded and warned every tick — the
  // regrade, 2026-10-23).
  const gatesOnly = (k) => {
    const m = new Set(loops.members[k] ?? []);
    if ([...m].some((id) => ctx.trace?.hasCapacitor(id))) return false;
    return !ctx.resistors.some((r) => m.has(r.netA) && m.has(r.netB));
  };
  // The nets of the stuck loops of gates alone.
  const ringNets = (knots) =>
    new Set(knots.filter((k) => gatesOnly(k.loop)).flat());
  // What is still stuck after every round it had: not tried again as is.
  // And every loop seeded that still races: a ring oscillator, not tried
  // again while its entries stand (above).
  const seededLoops = new Set();
  const remember = (s) => {
    if (!memo) return;
    for (const k of stuck(s)) failed.add(k.sig);
    if (s.settled) return;
    for (const k of racingLoops(s)) if (seededLoops.has(k)) memo.rings.add(ringKey(k, s)); // prettier-ignore
  };
  let best = solved;
  const tried = new Set();
  for (let round = 0; round < MAX_TIE_BREAKS; round++) {
    const racing = racingOf(best);
    const still = stuck(best);
    let knots = best.settled
      ? still
      : loops.members.map((m) => m.filter((id) => racing.has(id))).filter((m) => m.length); // prettier-ignore
    if (!best.settled && !knots.length) knots = [[...racing].sort((a, b) => loops.order.get(a) - loops.order.get(b))]; // prettier-ignore
    if (!best.settled) knots = [...knots, ...still];
    const picks = new Set();
    for (const knot of knots) {
      const pick = knot.find((id) => !tried.has(id));
      if (pick != null) picks.add(pick);
    }
    if (!picks.size) break;
    for (const id of picks) tried.add(id);
    loops.members.forEach((m, k) => {
      if (m.some((id) => picks.has(id))) seededLoops.add(k);
    });
    const seeded = new Map(best.levels);
    const loose = new Set(best.settled ? knots.flat() : [...racing, ...still.flat()]); // prettier-ignore
    for (const id of loose) seeded.set(id, picks.has(id) ? L : X);
    // The rest as the picks DRIVE them, gate by gate round each loop — HIGH
    // only where nothing says (a latch's other side either way). Seeded
    // HIGH everywhere, an even loop of inverters (six in a ring, a latch
    // with an inverter in each feedback) carried the one LOW round as a
    // defect for ever and was said to oscillate (the regrade, 2026-10-23).
    seedFromPicks(ctx, seeded, loose, picks);
    for (const id of loose) if (seeded.get(id) === X) seeded.set(id, H);
    const tie = once(seeded, null, null, true); // (`seeded` is its own)
    if (best.settled) {
      if (tie.settled && xOnLoops(tie) < xOnLoops(best)) best = tie;
      // A stuck loop of gates alone that RACES once seeded has no steady
      // state from any start — a ring oscillator whose X was its own (three
      // CD4069UB inverters in a ring read X, X, X and settled, silent, where
      // three 74LS04s raced and said so; the grade, 2026-10-23). The race
      // is its report. (A loop with a capacitor on it is an RC oscillator
      // this engine cannot time: left X, and not tried again, as before.)
      else if (!tie.settled && [...racingOf(tie)].some((id) => ringNets(still).has(id))) best = tie; // prettier-ignore
    } else if (tie.settled) {
      best = tie;
    } else {
      // Racing on no more than it did — but for a stuck loop seeded into a
      // race of its own, the ring that was X (above) — and either fewer of
      // its nets racing or fewer stuck at X beside the race.
      const now = racingOf(tie);
      const stuckNets = ringNets(still);
      const kept = [...now].filter((id) => racing.has(id)).length;
      if ([...now].every((id) => racing.has(id) || stuckNets.has(id)) && (kept < racing.size || xOnLoops(tie) < xOnLoops(best))) best = tie; // prettier-ignore
    }
    if (best.settled && !stuck(best).length) return best;
  }
  remember(best);
  return best;
}

/**
 * Fill a tie-break's seed (`solve`) from its picks: each combinational
 * gate driving a `loose` net is evaluated off the seed as it stands and its
 * definite outputs written in, round after round, until nothing more is
 * learnt — so a LOW pick runs round its loop as the gates would carry it,
 * and an even loop comes back to it agreeing. The picks themselves stay
 * put; a net no gate decides is left as it was (X).
 */
function seedFromPicks(ctx, seeded, loose, picks) {
  const drivers = [];
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK || c.sequential || c.memory || c.analogSwitch || !c.def.logic?.units) continue; // prettier-ignore
    if (c.def.logic.units.some((u) => loose.has(c.pinNet.get(u.output)))) drivers.push(c); // prettier-ignore
  }
  for (let round = 0; round <= loose.size; round++) {
    let changed = false;
    for (const c of drivers) {
      const pins = new Map();
      for (const [pin, net] of c.pinNet) pins.set(pin, net ? (c.railReads?.get(net) ?? seeded.get(net) ?? Z) : Z); // prettier-ignore
      for (const [pin, level] of evaluate(c.def, pins)) {
        const net = c.pinNet.get(pin);
        if (!loose.has(net) || picks.has(net) || (level !== H && level !== L)) continue; // prettier-ignore
        if (seeded.get(net) !== level) {
          seeded.set(net, level);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

/** How many times a capped settle's tie is broken (`solve`). */
const MAX_TIE_BREAKS = 4;

const LOOPS = new WeakMap();
const NOTHING = new Set();

/**
 * A run's memory of its tie-breaks (`solve`), handed to `tick`/`settle` as
 * `ties` by a caller ticking one run (SimController: one per Run; the CPU
 * monitor's what-if settles a fresh one each, so neither hears the other).
 * Per settle MODE, so a reference run beside the default never shares one:
 *   failed  the stuck loops tried and come to nothing, keyed by loop, X nets
 *           and entries' levels — not tried again as they stand;
 *   rings   the loops seeded that raced on — a ring oscillator — keyed by
 *           loop and entries' levels.
 * Both for the netlist they were learnt on (`netlist`), forgotten on a new
 * one. Kept per NETLIST once (a WeakMap), every settle on one netlist shared
 * it, and a run's results hung on what ran before it on that netlist: Stop →
 * Run, a desk review, a what-if (the 2026-10-26 review).
 */
export function tieMemo() {
  const one = () => ({ failed: new Set(), rings: new Set() });
  return { netlist: null, full: one(), incremental: one() };
}

/**
 * The circuit's feedback LOOPS (`solve`'s tie-break): the strongly connected
 * sets of nets — a powered gate unit's inputs and enable lead to its output;
 * a channel's control to its terminals, and its terminals to each other; a
 * resistor and a diode either way — less the rails, which are stiff. A
 * sequential chip leads nowhere: its outputs are its state. Each loop's nets
 * in netId order, and its ENTRIES: the nets outside it a gate in it reads,
 * with whether a CMOS input reads one (a floating entry is X there). Once per
 * context.
 * @param {object} ctx
 * @returns {{members: string[][], entries: Array<Array<{net: string, cmos: boolean}>>, order: Map<string, number>}}
 */
function feedbackLoops(ctx) {
  let found = LOOPS.get(ctx);
  if (found) return found;
  const order = new Map(ctx.netIds.map((id, k) => [id, k]));
  const rail = (n) => ctx.supplyPlusVolts.has(n) || ctx.supplyMinus.has(n);
  const next = new Map(); // net → Set of nets it leads to
  const reads = []; // [from, to, cmos] — a gate input's edge
  const edge = (a, b, cmos = null) => {
    if (a == null || b == null || rail(a) || rail(b)) return;
    if (!next.has(a)) next.set(a, new Set());
    next.get(a).add(b);
    if (cmos != null) reads.push([a, b, cmos]);
  };
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK || c.sequential || c.memory) continue;
    const cmos = floatsUnknown(c.def);
    for (const u of c.def.logic?.units ?? []) {
      const out = c.pinNet.get(u.output);
      for (const p of [...(u.inputs ?? []), u.enable]) {
        if (p != null) edge(c.pinNet.get(p), out, cmos);
      }
    }
    for (const ch of c.def.logic?.channels ?? []) {
      const a = c.pinNet.get(ch.a);
      const b = c.pinNet.get(ch.b);
      edge(a, b);
      edge(b, a);
      for (const p of ch.inputs ?? []) {
        edge(c.pinNet.get(p), a, cmos);
        edge(c.pinNet.get(p), b, cmos);
      }
    }
  }
  for (const r of ctx.resistors) {
    edge(r.netA, r.netB);
    edge(r.netB, r.netA);
  }
  for (const d of ctx.diodes) {
    edge(d.anode, d.cathode);
    edge(d.cathode, d.anode);
  }
  // Tarjan, iterative.
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const sccOf = new Map();
  const members = [];
  let counter = 0;
  for (const root of [...next.keys()].sort(
    (a, b) => order.get(a) - order.get(b),
  )) {
    if (index.has(root)) continue;
    const work = [[root, [...next.get(root)].values()]];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const [v, it] = work[work.length - 1];
      const step = it.next();
      if (!step.done) {
        const w = step.value;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push([w, [...(next.get(w) ?? [])].values()]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), index.get(w)));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const u = work[work.length - 1][0];
        low.set(u, Math.min(low.get(u), low.get(v)));
      }
      if (low.get(v) !== index.get(v)) continue;
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      // A loop: two nets or more, or a gate reading its own output.
      if (scc.length > 1 || next.get(v)?.has(v)) {
        scc.sort((a, b) => order.get(a) - order.get(b));
        for (const n of scc) sccOf.set(n, members.length);
        members.push(scc);
      }
    }
  }
  members.sort((a, b) => order.get(a[0]) - order.get(b[0]));
  sccOf.clear();
  members.forEach((m, k) => m.forEach((n) => sccOf.set(n, k)));
  const entries = members.map(() => new Map());
  for (const [from, to, cmos] of reads) {
    const k = sccOf.get(to);
    if (k == null || sccOf.get(from) === k) continue;
    entries[k].set(from, (entries[k].get(from) ?? false) || cmos);
  }
  found = {
    members,
    entries: entries.map((m) => [...m].map(([net, cmos]) => ({ net, cmos }))),
    order,
  };
  LOOPS.set(ctx, found);
  return found;
}

/**
 * The loops a settle left at X with every entry definite — a tie at a
 * standstill (`solve`): each loop's X nets, in netId order. An entry is
 * definite at H or L, or floating (Z) where only TTL inputs read it (a
 * floating TTL input reads HIGH).
 */
function stuckLoops(loops, levels) {
  const out = [];
  loops.members.forEach((m, k) => {
    const xs = m.filter((id) => levels.get(id) === X);
    if (!xs.length) return;
    const ins = loops.entries[k].map(({ net }) => levels.get(net) ?? Z);
    const definite = loops.entries[k].every(({ cmos }, i) => {
      const v = ins[i];
      return v === H || v === L || (v === Z && !cmos);
    });
    // `sig`: which loop, which of its nets X, what comes in — the memo of
    // a tie tried and failed (`solve`).
    if (definite) out.push(Object.assign(xs, { sig: `${m[0]}|${xs.join(",")}|${ins.join("")}`, loop: k })); // prettier-ignore
  });
  return out;
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
  let forced = null; // the self-fed transistors' controls (channelGroups)
  let biased = null; // …and the biased ones' (compId → level)
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
    const channels = channelGroups(ctx, levels, state, hooks?.input, drivers); // prettier-ignore
    forced = channels?.forced ?? null;
    biased = channels?.biased ?? null;
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
  return { levels, iterations, settled, warnings, strong: lastStrong, forced, biased }; // prettier-ignore
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
        // An op-amp's input on a resistor is wired too: an amplifier's or a
        // Schmitt trigger's divider resolves Z here only because the levels
        // it is fed from are unknown to a logic engine (a voltage is Spice
        // Lite's).
        if (net && c.def.opAmps && ctx.trace.resistors(net).length) return false; // prettier-ignore
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
function channelsOf(
  ctx,
  levels,
  state,
  hooks = null,
  forced = null,
  biased = null,
) {
  // prettier-ignore
  const out = new Map();
  for (const c of ctx.chips) {
    if (!c.analogSwitch || c.status !== CHIP_STATUS.OK) continue;
    const pinLevels = new Map();
    const rails = c.railReads;
    for (const [pin, net] of c.pinNet) {
      // Read as the settle's channels read it (`channelGroups`) — a
      // self-fed transistor's control as its last pass read it (`forced`),
      // a biased one's by its divider (`biased`).
      const level = net ? (rails?.get(net) ?? levels.get(net) ?? Z) : Z;
      const set = forced?.get(net ?? `${c.comp.id}#${pin}`) ?? (pin === controlPin(c) ? biased?.get(c.comp.id) : undefined); // prettier-ignore
      pinLevels.set(pin, set ?? (hooks?.input ? hooks.input(c, pin, net, level) : level)); // prettier-ignore
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
    } else if (c.margin) {
      // Working, under its range: said as underpowered, and that it runs.
      warnings.push({ type: "underpowered", chip: c.comp.id, volts, margin: true }); // prettier-ignore
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
  warnings.push(...ctx.supplyWarnings);
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
  // The strong levels, when the incremental settle left them in its cache,
  // are built only when read (`strongLater`): a map of every net, every
  // tick, that only an LED's rule reads. (An accessor of the literal's own,
  // which a spread or a clone reads through — a `defineProperty` cost a
  // tick that reads them more than the map it saved.)
  let later = solved.strongLater?.() ?? null;
  let strong = later ? null : solved.strong;
  return {
    netLevels: solved.levels,
    get strongLevels() {
      if (later) [strong, later] = [later(), null];
      return strong;
    },
    set strongLevels(value) {
      [strong, later] = [value, null];
    },
    // One net's strong level, `strongLevels.get(net)` without building the
    // map while it is still the cache's (the lamps' read, lamp-average.js:
    // busy8's 160 LEDs made every tick build all of it).
    strongAt(net) {
      if (later?.at) return later.at(net);
      if (later) [strong, later] = [later(), null];
      return strong?.get(net);
    },
    chipStatus: ctx.chipStatus,
    warnings: dedupe(warnings),
    iterations: solved.iterations,
    settled: solved.settled,
    timing,
    channels: channelsOf(ctx, solved.levels, state, hooks, solved.forced, solved.biased), // prettier-ignore
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
 * @param {object} [opts.hooks], [opts.context], [opts.mode], [opts.stats],
 *   [opts.ties] - as for `tick`.
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
  ties = null,
}) {
  const ctx = contextFor(context, doc, netlist, hooks);
  hooks?.context?.(ctx);
  return assemble(
    ctx,
    solve(ctx, warmStart, state, clockPhase, images, signalLevels, null, hooks, { mode, stats, ties }), // prettier-ignore
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

/** A transistor's base or gate pin, or null for any other part. */
const controlPin = (c) =>
  c.def.transistor ? c.def.logic.channels[0].inputs[0] : null;

/** Sample a chip's input pins from a settled net-level map (Z when floating)
    — a biased transistor's control by its divider (`biased`), as the
    settle read it: a MOSFET's held gate is stepped from what turned it on,
    or with the divider gone it held what the net last read. */
function samplePins(c, levels, hooks = null, biased = null, prev = null) {
  const raw = (c.reads ??= new Map()); // (scratch: `inputLevels` copies it)
  const set = biased?.get(c.comp.id);
  const rails = c.railReads;
  const { pinList, netList } = c;
  for (let k = 0; k < pinList.length; k++) {
    const pin = pinList[k];
    const net = netList[k];
    const level = net ? (rails?.get(net) ?? levels.get(net) ?? Z) : Z;
    if (set != null && pin === controlPin(c)) raw.set(pin, set);
    else raw.set(pin, hooks?.input ? hooks.input(c, pin, net, level) : level);
  }
  // (Its last sample itself, read the same: `inputLevels`' `prev`.)
  return inputLevels(c.def, raw, prev);
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
 * @param {object} [opts.ties] - the run's memory of its tie-breaks
 *   (`tieMemo()`), one per run; without one nothing is remembered between
 *   calls.
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
  warm = undefined,
  scope = null,
  ties = null,
}) {
  const ctx = contextFor(context, doc, netlist, hooks);
  hooks?.context?.(ctx);

  // ① Pre-settle: propagate the new clock phase / input changes with the OLD
  //    sequential state holding. (`warm`: the last tick's work, to start
  //    from rather than cold — sim/incremental.js `warmStartOf`.)
  let solved = solve(
    ctx,
    warmStart,
    state,
    clockPhase,
    images,
    signalLevels,
    observer,
    hooks,
    { mode, stats, warm, ties },
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
      // Outside `scope` (Spice Lite's islands this tick is not for —
      // features/12): nothing at its pins moved, so it reads what it read
      // and steps nowhere; its state and pins stand.
      if (
        scope &&
        !observer &&
        !scope(c.comp.id) &&
        prevPinLevels.has(c.comp.id)
      ) {
        // prettier-ignore
        finalIns.set(c.comp.id, prevPinLevels.get(c.comp.id));
        continue;
      }
      const before = prevIns.get(c.comp.id) ?? null;
      const ins = samplePins(c, solved.levels, hooks, solved.biased, before);
      sampled.set(c.comp.id, ins);
      finalIns.set(c.comp.id, ins);
      const current = curState.get(c.comp.id) ?? initialState(c.def);
      // A chip with no power (or its power backwards) keeps nothing: what it
      // counted or latched is gone, and power back it comes up as at Run —
      // a counter switched off and on again went on from its old count. One
      // only short of its range (underpowered, a sagging rail) holds.
      const lost = c.status === CHIP_STATUS.UNPOWERED || c.status === CHIP_STATUS.REVERSED; // prettier-ignore
      const next =
        c.status === CHIP_STATUS.OK
          ? stepChip(c.def, current, ins, before, {
              now,
              timing: c.timing,
              ...hooks?.stepEnv?.(c),
            })
          : lost
            ? initialState(c.def)
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
      { mode, stats, carry: solved.carry, ties },
    );
  }

  // The work the last solve ended with, for a caller that keeps it for its
  // next tick (`warm` given, even null — features/08-warm-incremental-
  // cache.md): with the levels it ended on, by net index, taken now, before
  // anything below marks them.
  // (The levels go into the array the warm this tick started from held —
  // read, and taken, by then: sim/incremental.js `warmStartOf`.)
  const keepLevels = (work) => {
    const { netIds } = ctx;
    const out = work.spareLevels?.length === netIds.length ? work.spareLevels : new Array(netIds.length); // prettier-ignore
    work.spareLevels = null;
    for (let i = 0; i < netIds.length; i++)
      out[i] = solved.levels.get(netIds[i]);
    return out;
  };
  const keep =
    warm !== undefined && mode !== "full" && !observer && solved.carry
      ? { work: solved.carry.work, levels: keepLevels(solved.carry.work), stale: [...solved.carry.stale], pending: solved.carry.pending } // prettier-ignore
      : null;

  // Memory: no clocked state — read its inputs from the FINAL settled levels and
  // REPORT any write op for the controller to apply (the engine never mutates
  // the image). Populate its pin levels for parity with sequential chips.
  const memWrites = [];
  for (const c of ctx.chips) {
    if (!c.memory) continue;
    const ins = samplePins(c, solved.levels, hooks, null, prevPinLevels.get(c.comp.id) ?? null); // prettier-ignore
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
  // (A capped solve's work too, on the logic engine: its marked nets ride
  // `pending` — Spice Lite's hooks keep their own counsel on a capped one.)
  if (warm !== undefined) result.warm = !oscillating && (result.settled || !hooks) ? keep : null; // prettier-ignore
  return result;
}
