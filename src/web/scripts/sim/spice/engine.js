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

// spice/engine.js — Spice Light, the second simulation engine
// (features/spice-light.md). Pure and DOM-free, like sim/engine.js, and held
// to the SAME contract: `tick`/`settle` take the digital engine's options and
// return its result shape, plus fields of their own that a consumer may read
// and nothing is obliged to.
//
// IT IS THE DIGITAL ENGINE, DRIVEN. A Spice Light tick runs sim/engine.js's
// `tick` through its hooks (that file's header lists them) as many times as
// the analog side needs, and never re-implements a settle:
//
//   TIME.  Each pass is one QUANTUM — the shortest gate delay among the chips
//     on the desk (spice/params.js; a CD4000 part's follows its supply). A
//     slower chip HOLDS its outputs for round(delay / quantum) passes, and an
//     output that changes back before then never appears (inertial delay: a
//     glitch shorter than a gate is swallowed, as by the gate). On a desk of
//     one family every hold is 1 and the passes are the digital engine's own,
//     pass for pass (tests/engine-parity.test.js). The pass cap is lifted by
//     the longest hold, so the oscillation test still counts gate delays.
//
//   ANALOG NODES.  A net with a capacitor on it, no direct driver, and no
//     timed part owning it (a 555's capacitor is the 555's) is a NODE: its
//     voltage follows V∞ + (V0 − V∞)·e^(−t/τ), where V∞ and τ are the
//     Thévenin equivalent of the resistors around it (spice/rc-curve.js).
//     The curve is solved, never stepped: a node changes nothing until it
//     CROSSES the trigger point of an input listening to it, and that moment
//     is a logarithm. Each listener reads the node through its OWN threshold
//     (the `input` hook), so a 74LS and a CD4000 input on one node switch at
//     different moments, as they do. A crossing is a one-shot: the reading
//     flips once and re-arms only by crossing back — through the same point,
//     or, for a Schmitt-trigger input, through its OTHER one (VT− after VT+),
//     which is what lets an RC oscillator round a '14 or a 40106 run at the
//     period its hysteresis sets. A capacitor whose far lead goes nowhere is
//     no part of a node. Each capacitor's CHARGE is carried from tick to
//     tick, so a node that vanishes into a rail (a button pressed) comes
//     back holding what the rail left on it.
//
//   EVENTS.  After a settle, the next crossing is found. One within
//     FAST_WINDOW_S is jumped to at once and settled again, inside this tick;
//     one further off becomes `wakeAt`, and SimController ticks again then
//     (the same mechanism a 555 uses). A tick that arrives LATE first catches
//     up on the crossings it missed, in order. A node nobody listens to asks
//     for display frames (ANALOG_FRAME_S) until it is within the gap setting
//     of its asymptote — it never holds a tick open, and it is never frozen.
//
//   LIMITS.  At most MAX_ANALOG_EVENTS settles at the tick's own moment. A
//     node still crossing back and forth at the limit is an oscillator faster
//     than the desk can show: it is reported as `oscillation` and shown at no
//     more than TIMING_CAP_HZ's rate (sim/timing.js's rule for timed parts).
//     A node mid-charge produces no event at all, so it can never be mistaken
//     for one. Catching up is budgeted APART (MAX_CATCHUP_EVENTS): a late
//     tick replaying a slow oscillator's honest crossings is no evidence of a
//     fast one, and past its budget it skips the rest of the history rather
//     than warn.
//
// What it does not do (stated, not modelled): a resistor chain through an
// intermediate net is not followed (rc-trace.js's rule); a node's far side
// reads a chip's HIGH as that chip's whole supply (no output-stage model, no
// VOH); a step on a capacitor's far side does not couple through it (the
// node re-anchors where it was); an analog switch's control and a pull
// THROUGH a node read its published level.
//
// What Spice Light adds to a result:
//   analog     the run-volatile analog state, handed back in as
//              `spice.analog` (`{time, nodes, outputs, supplies, drops,
//              driven, caps, oscillating}`; null at Run)
//   nodeVolts  net → volts, for every net Spice Light knows a voltage of
//   supplies   PSU id → {set, volts, amps, demand, limit, limited, peak}
//              (spice/supply.js)
//   loads      each driving output pin's load against its budget
//              (spice/loads.js)
//   sag        chip id → {drop, volts}: what it loses in the wires to its
//              supply, and the supply it is left with (spice/sag.js)
//
//   CURRENT (Phase 4).  After the settle, each supply's demand is summed and,
//     past its current limit, its voltage droops (spice/supply.js). The
//     drooped voltage is carried in `analog.supplies` and handed back to the
//     engine through the `psuVolts` hook — at once, with one more settle, when
//     it moved this tick — so a chip whose supply sags out of range is
//     underpowered by the engine's own power check. Every output is then held
//     to its fan-out budget (spice/loads.js): a `brownout` warning past it,
//     and past twice it the chip is reported OVERLOADED (brown smoke) for
//     SimController to latch.
//
//   SAG (Phase 5).  Every wire is 24 AWG copper at its real length
//     (spice/sag.js); each draw is routed along its lowest-resistance path,
//     and a chip's drop (I·R over the wires its current shares, once over a
//     millivolt) is taken off the supply it sees through the `chipDrop`
//     hook — carried and re-settled exactly like the droop.
//
//   LEDS.  Every LED and display segment carries the current its network
//     pushes through it (spice/lamps.js, with each colour's datasheet in
//     spice/leds.js): dark below its knee, as bright as its milliamps, a
//     warning past its DC rating (`led-overdriven`), a reverse-voltage
//     warning past its rating (`led-reverse`), and BURNT — open, for the rest
//     of the run — once its junction passes its maximum temperature
//     (`led-burnt`, once). The burnt set rides `analog.burnt`; Stop clears it
//     with the rest. The verdicts are the result's `lamps`, which the desk
//     draws in place of the digital engine's junction rule; the current
//     through every lead the solve knows is `currents` (hole → amps), which
//     the probe reads out. No part shows a current of its own — only a
//     supply brick, its draw.
//
//   SPIKES & DECOUPLING (Phase 6).  An output that switches charges its load:
//     CL·V over the gate's delay, for the one pass it switches in (CL is the
//     datasheet's own test load — spice/params.js `loadPf`). Each pass sums
//     those spikes per supply, and the worst pass is the tick's PEAK. A chip
//     with a capacitor straight across its own supply pins' nets (+ to −: a
//     DECOUPLING capacitor; a timing capacitor always has a lead on a signal
//     net, so the two cannot be confused) draws its spikes from that
//     capacitor, and its supply sees none of them. A peak past a supply's
//     limit is warned about (`supply-spike`) — it does not glitch the logic
//     (features/spice-light.md Q4: warn only, until decided otherwise).

import {
  tick as digitalTick,
  settle as digitalSettle,
  CHIP_STATUS,
  MAX_ITERATIONS,
} from "../engine.js";
import { H, L, X } from "../levels.js";
import { MIN_SHOWN_S } from "../timing.js";
import { normalizeSpiceConfig } from "./config.js";
import {
  delayNs,
  familyParams,
  inputThresholds,
  partParams,
} from "./params.js";
import { hasArrived, timeToReach, valueAt } from "./rc-curve.js";
import { outputLoads } from "./loads.js";
import { DROOP_EPS, measureSupplies, supplyTopology } from "./supply.js";
import { solveLamps } from "./lamps.js";
import { supplySag } from "./sag.js";
import { partDef } from "../../catalog/index.js";
import { isVolatileMemory } from "../chip-eval.js";
import { partPinAddresses } from "../../model/occupancy.js";

/** The engine's identity — what SimController reports it is running. */
export const ID = "spice";

/** A crossing this close is settled inside the tick that finds it, seconds:
    fast settling (a pull on a small capacitor) never waits for a timer. */
export const FAST_WINDOW_S = 10e-6;

/** The most settles one tick runs for the analog side at its OWN moment
    (`now` and the fast window past it). A node still crossing back and forth
    at the limit is an oscillator faster than the desk can show. */
export const MAX_ANALOG_EVENTS = 32;

/** The most settles a LATE tick spends catching up on crossings it missed,
    in order, before it gives up on the history and jumps straight to `now`.
    Counted apart from MAX_ANALOG_EVENTS: a slow oscillator that a throttled
    timer left a few hundred milliseconds behind has many honest crossings to
    replay, and none of them is evidence of a FAST one. */
export const MAX_CATCHUP_EVENTS = 256;

/** The most passes the slowest gate on a desk is held for. A delay edited a
    thousand times shorter than the rest's (Settings ▸ Spice Light takes any
    positive number) would otherwise hold the slow gates a thousand passes
    each, and lift the pass cap with them — a tick of seconds. Past this the
    quantum grows instead, and the gates faster than it switch in one. */
export const MAX_HOLD = 64;

/** How many times a tick settles again after its supplies moved, while that
    keeps changing what a node reads; past it, the next tick carries on. */
const RESETTLE_ROUNDS = 3;

/** How often a node still on its way asks to be redrawn, simulated seconds. */
export const ANALOG_FRAME_S = 1 / 30;

/** A crossing must clear the trigger point by this much to count, volts — so
    a node resting ON its threshold does not chatter. */
const FLIP_EPS = 1e-9;

/** Crossings this close together, seconds, happen at once. */
const SAME_TIME = 1e-15;

/** Pin roles that READ a net. */
const LISTENING = new Set(["input", "io"]);

/** The parts of a frozen topology Spice Light needs, read once per tick from
    the first context the digital engine builds. */
function analyze(ctx, config, doc, netlist) {
  const { trace } = ctx;
  const railVolts = new Map();
  let vHigh = 0;
  for (const [net, volts] of ctx.supplyPlusVolts) {
    const v = Math.max(...volts);
    railVolts.set(net, v);
    vHigh = Math.max(vHigh, v);
  }
  if (!(vHigh > 0)) vHigh = 5;

  // A timed part keeps its own capacitor: a capacitor on one of its TIMING
  // pins' nets is its business (it reports the voltage itself —
  // `logic.nodeVolts`). Its other pins are ordinary inputs and outputs, so an
  // RC on one (a power-on reset on a 555's RESET) is a node like any other.
  // The CD4060B's and CD4541B's networks hang on their clock pins, which
  // DRIVE their capacitors: a driven node follows its driver, so it changes
  // nothing those parts do.
  const owned = new Set();
  const timed = [];
  for (const c of ctx.chips) {
    if (!c.timing) continue;
    timed.push(c);
    for (const p of c.def.pins) {
      if (p.role !== "timing") continue;
      const net = c.pinNet.get(p.n);
      if (net && trace.hasCapacitor(net)) owned.add(net);
    }
  }

  // What a HIGH on a net is, volts: the supply of the chip driving it (the
  // highest, should chips on two supplies share a bus) — so a 5 V output
  // charges a node toward 5 V on a desk that also has a 12 V supply. A net
  // no chip drives (a pull, a signal flag) reads HIGH as the desk's highest.
  const highOf = new Map();
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK || c.passive || c.analogSwitch) continue;
    const volts = ctx.chipStatus.get(c.comp.id)?.volts;
    if (!(volts > 0)) continue;
    for (const p of c.def.pins) {
      if (p.role !== "output" && p.role !== "io") continue;
      const net = c.pinNet.get(p.n);
      if (net) highOf.set(net, Math.max(highOf.get(net) ?? 0, volts));
    }
  }

  // A capacitor whose other lead goes nowhere — in the air, or alone in a
  // hole — holds no charge and times nothing; it is not part of the node.
  const reaches = (far) => far != null && (trace.rail(far) || trace.connected(far)); // prettier-ignore
  const candidates = new Map(); // net → {caps, res, listeners}
  for (const net of ctx.netIds) {
    if (owned.has(net) || trace.rail(net)) continue;
    const caps = trace.capacitors(net).filter((l) => l.far !== net && reaches(l.far)); // prettier-ignore
    if (!caps.length) continue;
    candidates.set(net, {
      caps,
      res: trace.resistors(net).filter((l) => l.far !== net),
      farads: caps.reduce((sum, l) => sum + l.value, 0),
      listeners: [],
    });
  }

  // Every powered chip's gate delay (a family-less part has none: it
  // switches in one pass), and every input listening to a node, through its
  // own thresholds (a family-less part's are 74LS's). An analog switch's
  // control reads its published level instead.
  const delays = new Map();
  let quantum = Number.POSITIVE_INFINITY;
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK) continue;
    const volts = ctx.chipStatus.get(c.comp.id)?.volts ?? null;
    const d = delayNs(config, c.def, volts);
    if (d != null) {
      delays.set(c.comp.id, d);
      quantum = Math.min(quantum, d);
    }
    if (c.analogSwitch) continue;
    const { up, down } = inputThresholds(config, c.def, volts);
    const seen = new Set();
    for (const p of c.def.pins) {
      if (!LISTENING.has(p.role)) continue;
      const net = c.pinNet.get(p.n);
      const cand = net ? candidates.get(net) : null;
      if (!cand || seen.has(net)) continue;
      seen.add(net);
      cand.listeners.push({ id: c.comp.id, up, down });
    }
  }
  if (!Number.isFinite(quantum)) quantum = familyParams(config, "74LS").delayNs;
  let slowest = 0;
  for (const d of delays.values()) slowest = Math.max(slowest, d);
  quantum = Math.max(quantum, slowest / MAX_HOLD);
  const holds = new Map();
  let maxHold = 1;
  for (const [id, d] of delays) {
    const hold = Math.max(1, Math.round(d / quantum));
    if (hold > 1) holds.set(id, hold);
    maxHold = Math.max(maxHold, hold);
  }
  // Each chip's switching spike, booked to its supply — none for a chip with
  // a capacitor across its own supply pins (it is decoupled).
  const { psuOfNet } = supplyTopology(doc, netlist);
  const spikes = new Map(); // compId → {psu, amps per switching output}
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK || c.passive || c.analogSwitch) continue;
    const vccNet = c.pinNet.get(c.def.pins.find((p) => p.role === "vcc")?.n);
    const psu = psuOfNet.get(vccNet);
    if (!psu) continue;
    const decoupled = trace
      .capacitors(vccNet)
      .some((l) => l.far && trace.rail(l.far) === "-");
    if (decoupled) continue;
    const p = partParams(config, c.def);
    const volts = ctx.chipStatus.get(c.comp.id)?.volts ?? 0;
    const ns = delays.get(c.comp.id) ?? p.delayNs;
    const amps = (p.loadPf * 1e-12 * volts) / (ns * 1e-9);
    if (amps > 0) spikes.set(c.comp.id, { psu, amps });
  }
  const capPins = capacitorNets(doc, netlist);
  return { trace, railVolts, vHigh, highOf, timed, candidates, quantum, holds, maxHold, spikes, capPins }; // prettier-ignore
}

/** Each netlist's capacitors (`capacitorNets`). */
const CAP_NETS = new WeakMap();

/**
 * Every capacitor's two nets: id → {a, b}, pin 1's net and pin 2's (null for
 * a lead over nothing). What a capacitor's remembered charge is stated
 * across — V(a) − V(b). Computed once per netlist, which a run changes only
 * by an edit or a switch.
 * @param {object} doc
 * @param {{netOfPoint: Map}} netlist
 * @returns {Map<string, {a: string|null, b: string|null}>}
 */
export function capacitorNets(doc, netlist) {
  const cached = CAP_NETS.get(netlist);
  if (cached) return cached;
  const out = new Map();
  for (const comp of doc.components ?? []) {
    if (comp.board == null || !partDef(comp.ref)?.capacitor) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const net = (pin) => {
      const address = pins.find((p) => p.pin === pin)?.address;
      return address ? (netlist.netOfPoint.get(address) ?? null) : null;
    };
    out.set(comp.id, { a: net(1), b: net(2) });
  }
  CAP_NETS.set(netlist, out);
  return out;
}

/** Two output maps that drive the same levels. */
function sameOutputs(a, b) {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [pin, level] of a) if (b.get(pin) !== level) return false;
  return true;
}

/** A node's voltage at `t`. */
const voltsOf = (node, t) => node.driven ?? valueAt(node.curve, t);

/**
 * Advance Spice Light one tick. Takes everything sim/engine.js `tick` takes,
 * plus `spice: {config, analog}` — the setting (spice/config.js's shape) and
 * the analog state the previous tick returned (null at Run).
 * @param {object} opts
 * @returns {object} the digital result plus `analog`, `nodeVolts`,
 *   `supplies` and `loads`.
 */
export function tick({ spice = null, ...opts }) {
  const config = normalizeSpiceConfig(spice?.config);
  const prior = spice?.analog ?? null;
  const target = opts.now ?? 0;
  // Copied, never mutated: the engine stays a pure function of its inputs.
  const nodes = new Map();
  for (const [net, node] of prior?.nodes ?? []) {
    nodes.set(net, { ...node, listeners: new Map(node.listeners) });
  }
  const committed = new Map(prior?.outputs ?? []);
  // Each supply's delivered voltage, and each chip's drop in the wires to it,
  // from the last tick that measured them.
  const delivered = new Map(prior?.supplies ?? []);
  const drops = new Map(prior?.drops ?? []);
  const pending = new Map();
  // What each chip last DROVE (its outputs as the pass let them through),
  // carried so the first pass of a tick compares with the last one's.
  const driven = new Map(prior?.driven ?? []);
  // Each capacitor's charge as the last tick left it: the voltage across it,
  // pin 1 less pin 2 (none at Run — every capacitor starts empty). A node
  // that vanishes (a button merged it into a rail) and comes back starts
  // from the charge its capacitors were left holding, as a real one does.
  const charge = new Map(prior?.caps ?? []);
  // The LEDs burnt so far this run (open from then on), and the voltages the
  // last LED solve settled on — its warm start.
  const burnt = new Set(prior?.burnt ?? []);
  let lampVolts = new Map(prior?.lampVolts ?? []);
  const burntNow = [];
  let spikeNow = new Map(); // psu → amps switched in this pass
  const spikePeak = new Map(); // psu → the worst pass this tick
  const foldSpikes = () => {
    for (const [psu, amps] of spikeNow) {
      spikePeak.set(psu, Math.max(spikePeak.get(psu) ?? 0, amps));
    }
    spikeNow = new Map();
  };

  let s = null; // analyze()'s answer, once the first context is built
  let lastCtx = null; // the context the latest settle ran in
  let view = new Map(); // net → {level, listeners: Map<compId, level>}
  let passes = 0;

  /** The levels the nodes present, from their listeners' flags. */
  const computeView = () => {
    const out = new Map();
    for (const [net, node] of nodes) {
      const cand = s.candidates.get(net);
      if (!cand) continue;
      const listeners = new Map();
      for (const { id } of cand.listeners) {
        listeners.set(id, node.listeners.get(id) ? H : L);
      }
      let level;
      if (listeners.size) {
        const levels = new Set(listeners.values());
        level = levels.size === 1 ? [...levels][0] : X;
      } else {
        level = voltsOf(node, t) >= s.vHigh / 2 ? H : L;
      }
      out.set(net, { level, listeners });
    }
    return out;
  };
  const sameView = (a, b) => {
    if (a.size !== b.size) return false;
    for (const [net, v] of a) {
      const w = b.get(net);
      if (!w || w.level !== v.level) return false;
      for (const [id, level] of v.listeners) {
        if (w.listeners.get(id) !== level) return false;
      }
    }
    return true;
  };

  /** A chip's outputs as its gate delay lets them through: a chip slower
      than the quantum holds what it drives for its hold count of passes, and
      a change that reverts before then never appears (inertial delay). */
  const holdOutputs = (c, outMap) => {
    const id = c.comp.id;
    const hold = s?.holds.get(id) ?? 1;
    const cur = committed.get(id);
    if (hold <= 1 || !cur) {
      if (hold > 1) committed.set(id, outMap);
      pending.delete(id);
      return outMap;
    }
    if (sameOutputs(outMap, cur)) {
      pending.delete(id);
      return cur;
    }
    const p = pending.get(id);
    if (p && sameOutputs(p.outs, outMap)) {
      p.left -= 1;
      if (p.left > 0) return cur;
      committed.set(id, outMap);
      pending.delete(id);
      return outMap;
    }
    pending.set(id, { outs: outMap, left: hold - 1 });
    return cur;
  };

  const hooks = {
    curves: true,
    context(ctx) {
      lastCtx = ctx;
      if (s) return;
      s = analyze(ctx, config, opts.document, opts.netlist);
      for (const net of [...nodes.keys()]) {
        if (!s.candidates.has(net)) nodes.delete(net);
      }
      view = computeView();
    },
    get maxIterations() {
      return MAX_ITERATIONS * (s?.maxHold ?? 1);
    },
    pass() {
      passes++;
      foldSpikes();
    },
    input(c, _pin, net, level) {
      const v = net ? view.get(net) : null;
      if (!v) return level;
      return v.listeners.get(c.comp.id) ?? v.level;
    },
    levels(next) {
      if (!view.size) return next;
      const out = new Map(next);
      for (const [net, v] of view) out.set(net, v.level);
      return out;
    },
    outputs(c, outMap) {
      const out = holdOutputs(c, outMap);
      // A switching output's spike, booked to its supply.
      const was = driven.get(c.comp.id);
      const spike = s?.spikes.get(c.comp.id);
      if (spike && was) {
        let switched = 0;
        for (const [pin, level] of out) {
          const before = was.get(pin);
          if ((level === H || level === L) && (before === H || before === L) && level !== before) switched++; // prettier-ignore
        }
        if (switched) {
          spikeNow.set(spike.psu, (spikeNow.get(spike.psu) ?? 0) + switched * spike.amps); // prettier-ignore
        }
      }
      driven.set(c.comp.id, out);
      return out;
    },
    busy() {
      return pending.size > 0;
    },
    psuVolts(comp, set) {
      const d = delivered.get(comp.id);
      return d && d.set === set ? d.volts : set;
    },
    chipDrop(id) {
      return drops.get(id) ?? 0;
    },
  };

  /** A far net's voltage, or null when nothing says. */
  const farVolts = (far, result, t) => {
    if (far == null) return null;
    if (s.railVolts.has(far)) return s.railVolts.get(far);
    if (s.trace.rail(far) === "-") return 0;
    const other = s.candidates.has(far) ? nodes.get(far) : null;
    if (other) return voltsOf(other, t);
    for (const level of [
      result.strongLevels.get(far),
      result.netLevels.get(far),
    ]) {
      if (level === H) return s.highOf.get(far) ?? s.vHigh;
      if (level === L) return 0;
    }
    return null;
  };

  /** Re-read every node's drive after a settle, re-anchoring a curve whose
      target or time constant moved at the voltage it had reached. */
  const updateNodes = (result, t) => {
    for (const [net, cand] of s.candidates) {
      const node = nodes.get(net);
      const strong = result.strongLevels.get(net);
      if (strong === H || strong === L) {
        const driven = strong === H ? (s.highOf.get(net) ?? s.vHigh) : 0;
        nodes.set(net, { driven, curve: null, listeners: node?.listeners ?? new Map() }); // prettier-ignore
        continue;
      }
      let g = 0;
      let gv = 0;
      for (const { far, value } of cand.res) {
        const v = farVolts(far, result, t);
        if (v == null) continue;
        g += 1 / value;
        gv += v / value;
      }
      let v0;
      if (!node) {
        // A new node starts where its capacitors' charge puts it: each holds
        // the voltage it was last left with across it (an empty one starts
        // its node where its far side is), parallel ones sharing theirs.
        let c = 0;
        let cv = 0;
        for (const { id, far, value } of cand.caps) {
          const v = farVolts(far, result, t);
          if (v == null) continue;
          const across = charge.get(id) ?? 0;
          const held = s.capPins.get(id)?.a === net ? across : -across;
          c += value;
          cv += (v + held) * value;
        }
        v0 = c > 0 ? cv / c : 0;
      } else {
        v0 = voltsOf(node, t);
      }
      const curve =
        g > 0
          ? { t0: t, v0, vInf: gv / g, tau: cand.farads / g }
          : { t0: t, v0, vInf: v0, tau: Number.POSITIVE_INFINITY };
      const old = node?.curve;
      const same =
        old &&
        node.driven == null &&
        Math.abs(old.vInf - curve.vInf) <= FLIP_EPS &&
        (old.tau === curve.tau ||
          Math.abs(old.tau - curve.tau) <=
            1e-12 * Math.max(old.tau, curve.tau));
      if (same) continue;
      nodes.set(net, { driven: null, curve, listeners: node?.listeners ?? new Map() }); // prettier-ignore
    }
  };

  /** Bring every listener's reading up to date with the voltage at `t`;
      count each flip at the tick's own moment against its net (a flip
      replayed while catching up is history, not evidence of a fast
      oscillator). A reading rises through `up` and falls through `down` —
      one point for an ordinary input, two for a Schmitt trigger's; a first
      reading between a Schmitt's two takes the nearer. */
  const flips = new Map();
  const countFlip = (net, at) => {
    if (at >= target) flips.set(net, (flips.get(net) ?? 0) + 1);
  };
  const detectFlips = (t) => {
    for (const [net, node] of nodes) {
      const cand = s.candidates.get(net);
      if (!cand) continue;
      const v = voltsOf(node, t);
      for (const { id, up, down } of cand.listeners) {
        const above = node.listeners.get(id);
        let next = above;
        if (above === undefined) {
          next = v >= up ? true : v <= down ? false : v >= (up + down) / 2;
        } else if (!above && v >= up + FLIP_EPS) next = true;
        else if (above && v <= down - FLIP_EPS) next = false;
        if (next !== above) {
          node.listeners.set(id, next);
          if (above !== undefined) countFlip(net, t);
        }
      }
    }
  };

  /** The earliest crossing still ahead of `t`: its time and every
      (node, listener) that crosses then — or null. */
  const nextCrossing = (t) => {
    let at = Number.POSITIVE_INFINITY;
    let who = [];
    for (const [net, node] of nodes) {
      if (node.driven != null) continue;
      const cand = s.candidates.get(net);
      if (!cand) continue;
      const v = valueAt(node.curve, t);
      const { vInf, tau } = node.curve;
      for (const { id, up, down } of cand.listeners) {
        const above = node.listeners.get(id);
        const trigger = above ? down : up;
        const heading = above ? vInf < trigger - FLIP_EPS : vInf > trigger + FLIP_EPS; // prettier-ignore
        if (!heading) continue; // released: it will never cross
        const when = t + timeToReach(v, vInf, tau, trigger);
        if (!Number.isFinite(when)) continue;
        if (when < at - SAME_TIME) {
          at = when;
          who = [{ net, id }];
        } else if (when <= at + SAME_TIME) {
          who.push({ net, id });
        }
      }
    }
    return Number.isFinite(at) ? { at, who } : null;
  };

  // A late tick catches up from where the last one left off — but only when
  // there is a curve to catch up on (otherwise it is simply at `now`), and
  // not after a tick that found an oscillator faster than the desk: its
  // history is crossings nobody will see, and replaying them would only
  // spend the catch-up budget every tick.
  let t =
    nodes.size && prior?.time != null && prior.time < target && !prior.oscillating // prettier-ignore
      ? prior.time
      : target;
  let warm = opts.warmStart;
  let state = opts.state;
  let prev = opts.prevPinLevels;
  let result = null;
  let lastAt = null;
  const memWrites = [];

  // The memory images each settle reads: the run's, with the writes an
  // earlier settle of THIS tick made applied first. The digital engine sees a
  // write on its next tick, once SimController has applied it; within a Spice
  // Light tick the next settle IS that next tick. A ROM's writes are dropped,
  // as SimController drops them. Copied only when a later settle reads them.
  let images = opts.images ?? new Map();
  let unapplied = [];
  const imagesNow = () => {
    if (!unapplied.length) return images;
    const comps = new Map((opts.document.components ?? []).map((c) => [c.id, c])); // prettier-ignore
    const next = new Map(images);
    const copied = new Set();
    for (const { compId, addr, value } of unapplied) {
      const img = next.get(compId);
      const def = partDef(comps.get(compId)?.ref);
      if (!img || !def || !isVolatileMemory(def)) continue;
      if (addr < 0 || addr >= img.length) continue;
      if (!copied.has(compId)) {
        next.set(compId, img.slice());
        copied.add(compId);
      }
      next.get(compId)[addr] = value;
    }
    unapplied = [];
    images = next;
    return images;
  };
  /** One digital tick at `at` on the current view, its state kept. */
  const settleAt = (at) => {
    passes = 0;
    result = digitalTick({
      ...opts,
      images: imagesNow(),
      warmStart: warm,
      state,
      prevPinLevels: prev,
      now: at,
      hooks,
    });
    lastAt = at;
    memWrites.push(...(result.memWrites ?? []));
    unapplied.push(...(result.memWrites ?? []));
    warm = result.netLevels;
    state = result.state;
    prev = result.pinLevels;
  };
  let events = 0; // settles at the tick's own moment (MAX_ANALOG_EVENTS)
  let caught = 0; // settles replaying a late tick's history (MAX_CATCHUP_EVENTS)
  let capped = false;

  for (;;) {
    if (s) {
      detectFlips(t);
      view = computeView();
    }
    settleAt(t);
    if (!s.candidates.size && !nodes.size && lastAt >= target) break;
    t += passes * s.quantum * 1e-9;

    updateNodes(result, t);
    detectFlips(t);
    if (!sameView(view, computeView())) {
      if (t < target) {
        // History: past the catch-up budget, the rest of it is skipped and
        // the tick jumps to its own moment (every reading is brought up to
        // date there, at the top of the loop).
        if (++caught >= MAX_CATCHUP_EVENTS) t = target;
      } else if (++events >= MAX_ANALOG_EVENTS) {
        capped = true;
        break;
      }
      continue;
    }
    const next = nextCrossing(t);
    if (
      next &&
      (next.at <= target || next.at - Math.max(t, target) <= FAST_WINDOW_S)
    ) {
      if (next.at < target) {
        if (++caught >= MAX_CATCHUP_EVENTS) {
          t = target;
          continue;
        }
      } else if (++events >= MAX_ANALOG_EVENTS) {
        capped = true;
        break;
      }
      t = Math.max(t, next.at);
      for (const { net, id } of next.who) {
        const node = nodes.get(net);
        node.listeners.set(id, !node.listeners.get(id));
        countFlip(net, t);
      }
      continue;
    }
    if (lastAt < target) {
      // Caught up: the tick's own moment still has to be settled.
      t = Math.max(t, target);
      continue;
    }
    break;
  }

  // ── Current: supply droop, then fan-out ────────────────────────────────
  const nodeVolts = new Map();
  const collectVolts = () => {
    nodeVolts.clear();
    if (!s) return;
    for (const [net, node] of nodes) nodeVolts.set(net, voltsOf(node, t));
    for (const c of s.timed) {
      if (c.status !== CHIP_STATUS.OK || !c.def.logic.nodeVolts) continue;
      const volts = result.chipStatus.get(c.comp.id)?.volts ?? null;
      const byPin = c.def.logic.nodeVolts(c.timing, state.get(c.comp.id), lastAt, volts); // prettier-ignore
      for (const [pin, v] of byPin ?? []) {
        const net = c.pinNet.get(pin);
        if (net) nodeVolts.set(net, v);
      }
    }
  };
  collectVolts();
  // The LEDs: judged at what the supplies deliver (burning any past their
  // maximum junction temperature), then solved again at the supplies' SET
  // voltages for the booking spice/supply.js measures demand at.
  let bookingVolts = new Map(prior?.bookingVolts ?? []);
  const lampsNow = () => {
    const lampOpts = {
      doc: opts.document,
      netlist: opts.netlist,
      ctx: lastCtx,
      result,
      nodeVolts,
      driven,
    };
    const solved = solveLamps({ ...lampOpts, burnt, warm: lampVolts });
    for (const b of solved.burnt) {
      burnt.add(b.key);
      burntNow.push(b);
    }
    lampVolts = solved.netVolts;
    const booked = solveLamps({ ...lampOpts, burnt, warm: bookingVolts, atSet: true, burns: false }); // prettier-ignore
    bookingVolts = booked.netVolts;
    return { lamps: solved.lamps, currents: solved.currents, draws: booked.draws, resistors: booked.resistors }; // prettier-ignore
  };
  let lamps = lampsNow();
  const measure = () =>
    measureSupplies({
      doc: opts.document,
      netlist: opts.netlist,
      ctx: lastCtx,
      netLevels: result.netLevels,
      strongLevels: result.strongLevels,
      nodeVolts,
      config,
      driven,
      channels: result.channels,
      lamps,
    });
  const measured = measure();
  let supplies = measured.supplies;
  let moved = false;
  // The wires' share: each chip's drop between its pins and its supply. A
  // drop under a millivolt — what a bench meter would not show, and what a
  // short jumper usually is — is not applied at all.
  const sag = supplySag(opts.document, opts.netlist, measured.draws);
  for (const [id, drop] of [...sag.drops]) {
    if (drop <= DROOP_EPS) sag.drops.delete(id);
  }
  for (const [id, drop] of sag.drops) {
    if (Math.abs((drops.get(id) ?? 0) - drop) > DROOP_EPS) moved = true;
  }
  for (const id of drops.keys()) {
    if (!sag.drops.has(id)) moved = true;
  }
  drops.clear();
  for (const [id, drop] of sag.drops) drops.set(id, drop);
  for (const [id, sup] of supplies) {
    const was = delivered.get(id);
    const used = was && was.set === sup.set ? was.volts : sup.set;
    if (Math.abs(used - sup.volts) > DROOP_EPS) moved = true;
    delivered.set(id, { set: sup.set, volts: sup.volts });
  }
  for (const id of [...delivered.keys()]) {
    if (!supplies.has(id)) delivered.delete(id);
  }
  let unsettled = false;
  if (moved) {
    // The supply moved: settle once more on what it now delivers, so a chip
    // it has dropped out of range is underpowered on THIS tick — and again
    // while that changes what a node reads (a chip gone quiet no longer
    // drives its RC). Past RESETTLE_ROUNDS the next tick, soon, carries on.
    unsettled = true;
    for (let round = 0; round < RESETTLE_ROUNDS; round++) {
      view = computeView();
      settleAt(lastAt);
      t += passes * s.quantum * 1e-9;
      updateNodes(result, t);
      detectFlips(t);
      if (sameView(view, computeView())) {
        unsettled = false;
        break;
      }
    }
    collectVolts();
    lamps = lampsNow();
    // Report what it delivers now (its demand, booked at the set voltage,
    // is unchanged by the droop itself).
    supplies = new Map(
      [...measure().supplies].map(([id, sup]) => [
        id,
        { ...sup, volts: delivered.get(id)?.volts ?? sup.volts },
      ]),
    );
  }
  // Each capacitor's charge as this tick leaves it, wherever both its nets
  // have a voltage; one with a lead floating keeps what it held.
  if (s) {
    const known = (net) =>
      net == null
        ? null
        : nodeVolts.has(net)
          ? nodeVolts.get(net)
          : farVolts(net, result, t);
    for (const [id, { a, b }] of s.capPins) {
      const va = known(a);
      const vb = known(b);
      if (va != null && vb != null) charge.set(id, va - vb);
    }
    for (const id of [...charge.keys()]) {
      if (!s.capPins.has(id)) charge.delete(id);
    }
  }

  // The worst pass's switching spikes on top of each supply's steady draw.
  foldSpikes();
  const spikeWarnings = [];
  for (const [id, sup] of supplies) {
    const spike = spikePeak.get(id) ?? 0;
    const peak = sup.amps + spike;
    supplies.set(id, { ...sup, peak });
    if (spike > 0 && peak > sup.limit) {
      spikeWarnings.push({ type: "supply-spike", psu: id, peak, limit: sup.limit }); // prettier-ignore
    }
  }
  const {
    loads,
    warnings: loadWarnings,
    overloaded,
  } = outputLoads(lastCtx, result.netLevels, config, driven);
  let chipStatus = result.chipStatus;
  if (overloaded.size) {
    chipStatus = new Map(chipStatus);
    for (const id of overloaded) {
      const entry = chipStatus.get(id);
      if (entry) chipStatus.set(id, { ...entry, status: CHIP_STATUS.OVERLOADED }); // prettier-ignore
    }
  }

  // The current budget REPLACES the standard engine's structural fan-out
  // rule (`ls-fanout`: a CD4000 output on more 74LS inputs than its sheet's
  // minimum sink guarantees). Both at once told the user two inputs were
  // fine and a fault; Spice Light's answer is the brownout, or none.
  const warnings = [
    ...result.warnings.filter((w) => w.type !== "ls-fanout"),
    ...loadWarnings,
    ...spikeWarnings,
    ...lampWarnings(lamps.lamps, burntNow),
  ];
  let wakeAt = result.wakeAt ?? null;
  const later = (at) => {
    if (at == null || !Number.isFinite(at)) return;
    wakeAt = wakeAt == null ? at : Math.min(wakeAt, at);
  };
  if (s && (s.candidates.size || nodes.size)) {
    const next = nextCrossing(t);
    if (capped) {
      const nets = [...flips].filter(([, n]) => n >= 3).map(([net]) => net);
      if (nets.length) warnings.push({ type: "oscillation", nets });
      later(Math.max(next?.at ?? target, target + MIN_SHOWN_S));
    } else {
      later(next?.at);
    }
    for (const node of nodes.values()) {
      if (
        node.driven == null &&
        !hasArrived(node.curve, t, config.gapPercent)
      ) {
        later(target + ANALOG_FRAME_S);
        break;
      }
    }
    if (unsettled) later(target + MIN_SHOWN_S);
  }

  return Object.assign(result, {
    chipStatus,
    memWrites,
    warnings,
    wakeAt,
    settled: result.settled && !capped,
    analog: {
      time: t,
      nodes,
      outputs: committed,
      supplies: delivered,
      drops,
      driven,
      caps: charge,
      oscillating: capped,
      burnt,
      lampVolts,
      bookingVolts,
    },
    nodeVolts,
    supplies,
    loads,
    lamps: lamps.lamps,
    currents: lamps.currents,
    sag: new Map(
      [...drops].map(([id, drop]) => [
        id,
        { drop, volts: chipStatus.get(id)?.volts ?? null },
      ]),
    ),
  });
}

/** A combinational settle — sim/engine.js `settle`, with Spice Light's
    fields, empty: a one-shot settle has no time for a curve to run in. */
export function settle({ spice: _spice = null, ...opts }) {
  return Object.assign(digitalSettle(opts), {
    analog: null,
    nodeVolts: new Map(),
    supplies: new Map(),
    loads: new Map(),
    lamps: new Map(),
    currents: new Map(),
  });
}

/**
 * The LEDs' warnings for one tick: each that burnt in it (once — a burnt LED
 * is open, so it never burns again), and each still lit past its DC rating
 * or held past its reverse rating (every tick; the toast is keyed per part).
 * A segment's warning names its display and its segment.
 */
function lampWarnings(lamps, burntNow) {
  const warnings = [];
  const partOf = (key) => {
    const at = key.indexOf("#");
    return at < 0
      ? { comp: key, seg: null }
      : { comp: key.slice(0, at), seg: key.slice(at + 1) };
  };
  for (const b of burntNow) {
    warnings.push({ type: "led-burnt", comp: b.comp, seg: b.seg, amps: b.amps, tj: b.tj, tjMax: b.tjMax }); // prettier-ignore
  }
  const burning = new Set(burntNow.map((b) => b.key));
  for (const [key, v] of lamps) {
    if (v.burnt || burning.has(key)) continue;
    if (v.overdriven) {
      warnings.push({ type: "led-overdriven", ...partOf(key), amps: v.amps, rating: v.rating }); // prettier-ignore
    }
    if (v.reverse) {
      warnings.push({ type: "led-reverse", ...partOf(key), volts: -v.volts, rating: v.vrMax }); // prettier-ignore
    }
  }
  return warnings;
}
