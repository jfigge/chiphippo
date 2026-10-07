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

// spice/engine.js — Spice Lite, the second simulation engine
// (features/spice-lite.md). Pure and DOM-free, like sim/engine.js, and held
// to the SAME contract: `tick`/`settle` take the digital engine's options and
// return its result shape, plus fields of their own that a consumer may read
// and nothing is obliged to.
//
// IT IS THE DIGITAL ENGINE, DRIVEN. A Spice Lite tick runs sim/engine.js's
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
//   VOLTAGES.  Every pass, once the digital engine has resolved its levels,
//     every net the pass touched is SOLVED for its voltage — the outputs as
//     the stages they are, the inputs' own currents, every resistor, LED,
//     diode and switch channel (spice/voltages.js, through the one network
//     solve in spice/network.js) — and every input READS that voltage
//     through its own thresholds (the `input` hook): a divider, a diode-AND,
//     a 74LS HIGH into 12 V CMOS, two outputs fighting are what a bench
//     shows, not a strength rule's guess. The level a net is shown at is its
//     readers' (the `levels` hook); a chip whose reading changed with no
//     level changing is evaluated again (`reread`) and the settle runs on
//     while readings move (`busy`). On a desk whose voltages say what its
//     levels say, that is the digital engine pass for pass.
//
//   ANALOG NODES.  A net with a capacitor on it (a timing part's own
//     included — under Spice Lite such a part is its SILICON, below) is a
//     NODE: its
//     voltage follows V∞ + (V0 − V∞)·e^(−t/τ) — the network round it solved
//     with its capacitors open and LINEARIZED where the node stands
//     (spice/voltages.js `linearize`: resistor chains, output stages,
//     switches, the inputs' own currents all count), or, where nothing on it
//     gives way (an output saturated at its limit), a straight ramp at the
//     current it delivers (spice/rc-curve.js). Each curve runs to the next
//     CORNER ahead — a stage's knee or its saturation, a junction's — and is
//     linearized again there, with no settle (nothing reads anything new).
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
//     A capacitor's far side JUMPING carries through it (spice/coupling.js,
//     every node's charge conserved); a capacitor alone on both its nets is
//     one curve for both plates (`pairsOf`). Each LISTENER — an input or a
//     comparator reading a node's network, a resistor away included — reads
//     its own crossings of it (spice/listeners.js), stated in the node curves
//     it moves with.
//
//   SILICON.  A timing part is evaluated as its silicon (spice/silicon.js,
//     the `logicOf` hook): comparators, internal resistors and a discharge
//     transistor on its pins, the voltage solve doing the timing. Its readout
//     is what it MEASURED (spice/measure.js).
//
//   LIMITS.  A whole analog side that comes round to a moment it has been at
//     before, in less than TIMING_CAP_HZ's period, is a CYCLE: drawn from
//     then on by its schedule at the cap, its duty kept, while time runs
//     true (spice/cycles.js; a counting part is told the true cycles through
//     `stepEnv`). Otherwise at most MAX_ANALOG_EVENTS settles at the tick's
//     own moment: a node still crossing back and forth at the limit is an
//     oscillation the desk cannot show (an RC round an ordinary inverter,
//     two unrelated fast oscillators) — `oscillation`, shown at no more than
//     TIMING_CAP_HZ's rate.
//     A node mid-charge produces no event at all, so it can never be mistaken
//     for one. Catching up is budgeted APART (MAX_CATCHUP_EVENTS): a late
//     tick replaying a slow oscillator's honest crossings is no evidence of a
//     fast one, and past its budget it skips the rest of the history rather
//     than warn.
//
// What it does not do (stated, not modelled): a capacitor's far side moving
// smoothly carries only its steps; an analog switch's control reads its
// shown level.
//
// What Spice Lite adds to a result:
//   analog     the run-volatile analog state, handed back in as
//              `spice.analog` (`{time, inputs, nodes, listen, capFar,
//              marks, outputs, supplies, drops, driven, caps, oscillating,
//              cycle, cycleDone, burnt, voltages}`; null at Run)
//   nodeVolts  net → volts, for every net something holds (a floating one
//              has none)
//   currents   hole → amps through the lead in it, for every lead the solve
//              knows (the probe's readout)
//   lamps      every LED's and diode's verdict (below)
//   draws      what each supply delivers and where (spice/supply.js)
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
//     SimController to latch. And to what flows through it: past its
//     family's limit (spice/params.js `outputLimits` — 20 mA on a 74LS
//     output, 50 mW in a CD4000 one) an `output-current` warning, past its
//     smoke limit (100 mA, 100 mW) brown smoke. An input is held to its own:
//     a 74LS input past 7 V smokes (`input-overvoltage`), a CD4000 input held
//     past a rail warns as its protection diode conducts (`input-clamp`) and
//     smokes past 10 mA, and a CD4000 input in its undefined band draws
//     CMOS_BAND_MA from its supply.
//
//   SAG (Phase 5).  Every wire is 24 AWG copper at its real length
//     (spice/sag.js); each draw is routed along its lowest-resistance path,
//     and a chip's drop (I·R over the wires its current shares, once over a
//     millivolt) is taken off the supply it sees through the `chipDrop`
//     hook — carried and re-settled exactly like the droop.
//
//   LEDS.  Every LED and display segment carries the current the solve
//     pushes through it (spice/lamps.js reads them off the desk, each
//     colour's datasheet is spice/leds.js): dark below its knee, as bright
//     as its milliamps, a
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
//     (features/spice-lite.md Q4: warn only, until decided otherwise).

import {
  tick as digitalTick,
  settle as digitalSettle,
  CHIP_STATUS,
  MAX_ITERATIONS,
} from "../engine.js";
import { H, L, X, Z } from "../levels.js";
import { MIN_SHOWN_S } from "../timing.js";
import { normalizeSpiceConfig } from "./config.js";
import {
  CMOS_CLAMP,
  TTL_INPUT_MAX_V,
  delayNs,
  familyParams,
  partParams,
} from "./params.js";
import { crossingTime, hasArrived, heading, valueAt } from "./rc-curve.js";
import { couplingSteps, pairCurves, pairStand } from "./coupling.js";
import {
  differenceAt,
  differenceOf,
  firstCrossing,
  listenersOf,
  readingFor,
  windowLevel,
} from "./listeners.js";
import { siliconOf } from "./silicon.js";
import { outputLoads } from "./loads.js";
import { DROOP_EPS, measureSupplies, supplyTopology } from "./supply.js";
import { lampTopology } from "./lamps.js";
import { AMBIENT_C, ledVerdict } from "./leds.js";
import { diodeVerdict } from "./diodes.js";
import { createVoltages, readerKey } from "./voltages.js";
import { supplySag } from "./sag.js";
import { partDef } from "../../catalog/index.js";
import { isTimed, isVolatileMemory } from "../chip-eval.js";
import { timingProbe } from "../rc-trace.js";
import { measuredTiming, noteLevel } from "./measure.js";
import {
  MAX_TIMELINE,
  cycleStart,
  scheduleAt as cycleAt,
  scheduleOf,
  segmentAt,
  signatureOf,
  trueCycles,
} from "./cycles.js";
import { TIMING_CAP_HZ } from "../timing.js";
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
    thousand times shorter than the rest's (Settings ▸ Spice Lite takes any
    positive number) would otherwise hold the slow gates a thousand passes
    each, and lift the pass cap with them — a tick of seconds. Past this the
    quantum grows instead, and the gates faster than it switch in one. */
export const MAX_HOLD = 64;

/** How many times a tick settles again after its supplies moved, while that
    keeps changing what a node reads; past it, the next tick carries on. */
const RESETTLE_ROUNDS = 3;

/** How often a node still on its way asks to be redrawn, simulated seconds. */
export const ANALOG_FRAME_S = 1 / 30;

/** The most corners one tick re-linearizes curves at, with no settle between
    (a node's charge crosses a stage's knee or saturation corner). */
const MAX_CORNERS = 256;

/** A network giving way slower than this, siemens, gives no curve a time
    constant (ten times a junction's gigaohm leakage stand-in). */
const G_EPS = 1e-8;

/** A current under this, amps, charges nothing worth a curve (a tenth of a
    nanoamp moves 10 µF ten microvolts a second). */
const I_EPS = 1e-10;

/** A corner must lie this far ahead of a curve to be one, volts. */
const KINK_EPS = 1e-9;

/** A crossing must clear the trigger point by this much to count, volts — so
    a node resting ON its threshold does not chatter. */
const FLIP_EPS = 1e-9;

/** Crossings this close together, seconds, happen at once. */
const SAME_TIME = 1e-15;

/** The digital engine's structural warnings Spice Lite answers by
    measuring instead (see `tick`). */
const RETIRED = new Set(["ls-fanout", "marginal-high", "mixed-supply"]);

/** Pin roles that READ a net. */
const LISTENING = new Set(["input", "io"]);

/** The parts of a frozen topology Spice Lite needs, read once per tick from
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

  // Every net with a capacitor on it is an RC node — a timing part's own
  // capacitor included: under Spice Lite such a part is its silicon
  // (spice/silicon.js), which senses its timing pins' voltages like any input
  // reads one. A capacitor whose other lead goes nowhere — in the air, or
  // alone in a hole — holds no charge and times nothing; it is not part of
  // the node.
  const reaches = (far) => far != null && (trace.rail(far) || trace.connected(far)); // prettier-ignore
  const candidates = new Map(); // net → {caps, farads}
  for (const net of ctx.netIds) {
    if (trace.rail(net)) continue;
    const caps = trace.capacitors(net).filter((l) => l.far !== net && reaches(l.far)); // prettier-ignore
    if (!caps.length) continue;
    candidates.set(net, {
      caps,
      farads: caps.reduce((sum, l) => sum + l.value, 0),
    });
  }

  // Every powered chip's gate delay (a family-less part has none: it
  // switches in one pass).
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
  return { trace, railVolts, vHigh, candidates, quantum, holds, maxHold, spikes, capPins }; // prettier-ignore
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

const EMPTY_MAP = new Map();

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
 * Advance Spice Lite one tick. Takes everything sim/engine.js `tick` takes,
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
  for (const [net, node] of prior?.nodes ?? []) nodes.set(net, { ...node });
  // What each listener last read (key → true above, false below — spice/
  // listeners.js), and each capacitor's far side as last seen from each of
  // its nodes (`<cap>@<net>` → volts — spice/coupling.js).
  const listen = new Map(prior?.listen ?? []);
  const capFar = new Map(prior?.capFar ?? []);
  // Each timing part's readout outputs' edges, timed (spice/measure.js).
  const marks = new Map(prior?.marks ?? []);
  // An oscillation faster than the desk shows, drawn by its schedule
  // (spice/cycles.js) — for as long as the circuit it was recorded on stands.
  let cycle =
    prior?.cycle?.netlist === opts.netlist && prior.cycle.document === opts.document // prettier-ignore
      ? prior.cycle
      : null;
  // The last of its segments this run has been through (cycles.js
  // `scheduleAt`'s count).
  let cycleDone = cycle ? (prior.cycleDone ?? 0) : 0;
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
  // The LEDs burnt so far this run (open from then on).
  const burnt = new Set(prior?.burnt ?? []);
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
  // Every net's voltage, every pass, and what each input reads from it
  // (spice/voltages.js) — carried from tick to tick like the levels.
  const volt = createVoltages({
    doc: opts.document,
    netlist: opts.netlist,
    config,
    prior: prior?.voltages ?? null,
    clockPhase: opts.clockPhase ?? new Map(),
    signalLevels: opts.signalLevels ?? new Map(),
    // The settle's reference mode is the voltage side's too, and so are its
    // counters.
    full: opts.mode === "full",
    stats: opts.stats ?? null,
  });
  volt.setBurnt(burnt);
  let settleTime = target; // the moment the settle under way runs at
  let heard = null; // the listeners (spice/listeners.js), per context
  let diffs = new Map(); // listener key → what it reads, as node curves
  let view = new Map(); // net → the level it is shown at
  let passes = 0;

  /** A node's state as spice/listeners.js reads it. */
  const nodeAt = (net) => {
    const node = nodes.get(net);
    if (!node) return null;
    return node.driven != null ? { value: node.driven } : { curve: node.curve };
  };
  const curveOf = (net, t) => {
    const node = nodes.get(net);
    return node ? voltsOf(node, t) : 0;
  };

  /** The level each listened-to net is shown at — its listeners' agreement
      (X when they differ) — and each node nobody reads, by half the desk's
      supply. */
  const computeView = (t) => {
    const out = new Map();
    for (const [net, keys] of heard?.viewNets ?? []) {
      let level = null;
      for (const key of keys) {
        const above = listen.get(key);
        if (above === undefined) continue;
        const lv = above ? H : L;
        level = level == null || level === lv ? lv : X;
      }
      if (level != null) out.set(net, level);
    }
    for (const [net, node] of nodes) {
      if (out.has(net) || !s?.candidates.has(net)) continue;
      out.set(net, voltsOf(node, t) >= s.vHigh / 2 ? H : L);
    }
    return out;
  };
  const sameView = (a, b) => {
    if (a.size !== b.size) return false;
    for (const [net, level] of a) if (b.get(net) !== level) return false;
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
    logicOf: siliconOf,
    context(ctx) {
      lastCtx = ctx;
      if (!s) {
        s = analyze(ctx, config, opts.document, opts.netlist);
        for (const net of [...nodes.keys()]) {
          if (!s.candidates.has(net)) nodes.delete(net);
        }
      }
      volt.context(ctx);
      const topo = volt.topology();
      const nodeClusters = new Set();
      for (const net of s.candidates.keys()) {
        const k = topo.clusterOf.get(net);
        if (k != null) nodeClusters.add(k);
      }
      heard = listenersOf(ctx, config, s.candidates, topo.clusterOf, nodeClusters, topo.rails); // prettier-ignore
      volt.setOwned(heard.owned);
      if (!view.size) view = computeView(settleTime);
      const rc = new Map();
      for (const [net, node] of nodes) rc.set(net, voltsOf(node, settleTime));
      volt.setNodes(s.candidates, rc);
      primeListeners(settleTime);
    },
    get maxIterations() {
      return MAX_ITERATIONS * (s?.maxHold ?? 1);
    },
    pass() {
      passes++;
      foldSpikes();
    },
    input(c, pin, net, level) {
      if (!net) return level;
      const key = readerKey(c.comp.id, pin);
      if (heard?.owned.has(key)) {
        const above = listen.get(key);
        const low = heard.windows.get(key);
        if (low != null) {
          const aboveLow = listen.get(low);
          if (above !== undefined && aboveLow !== undefined) return windowLevel(above, aboveLow); // prettier-ignore
        } else if (above !== undefined) {
          return above ? H : L;
        }
      }
      const shown = view.get(net);
      if (shown) return shown;
      // The voltage decides, wherever there is one — two outputs fighting
      // included (the stronger LOW wins, as on a bench).
      return volt.reading(c.comp.id, pin, net) ?? level;
    },
    levels(next, info) {
      let out = info ? volt.pass(next, info) : next;
      if (!view.size) return out;
      if (out === next) out = new Map(next);
      for (const [net, level] of view) {
        // A node no pin reads is shown by its voltage — unless nothing the
        // digital engine sees holds it at all (a CONT pin only the part's
        // own divider holds), which it shows as it always has.
        if ((out.get(net) ?? Z) === Z && !heard?.viewNets.has(net)) continue;
        out.set(net, level);
      }
      return out;
    },
    reread() {
      return volt.takeReread();
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
      volt.outputs(c, out);
      return out;
    },
    busy() {
      return pending.size > 0 || volt.moved;
    },
    psuVolts(comp, set) {
      const d = delivered.get(comp.id);
      return d && d.set === set ? d.volts : set;
    },
    chipDrop(id) {
      return drops.get(id) ?? 0;
    },
    chipVolts(_comp, vccNet, gndNets) {
      return volt.chipVolts(vccNet, gndNets);
    },
    // A part counting an oscillation drawn by its schedule is told how many
    // TRUE cycles have passed (spice/cycles.js), pin by pin.
    stepEnv(c) {
      const pins = cycle?.pins.get(c.comp.id);
      if (!pins) return null;
      const fast = new Map();
      const at = { id: cycle.id, cycles: trueCycles(cycle, settleTime), period: cycle.period }; // prettier-ignore
      for (const pin of pins) fast.set(pin, at);
      return { fast };
    },
  };

  /** A net's voltage at `t` where something states one — a rail, another
      node's curve, a net the voltage solve holds — or null. */
  const voltsAt = (net, t) => {
    if (net == null) return null;
    if (s.railVolts.has(net)) return s.railVolts.get(net);
    if (s.trace.rail(net) === "-") return 0;
    const other = s.candidates.has(net) ? nodes.get(net) : null;
    if (other) return voltsOf(other, t);
    return volt.voltOf(net);
  };

  /** A capacitor's far side at `t` as the settle just run left it: a node on
      its curve (a held one where the solve holds it — a bench source
      switched, a switch closed onto a rail), else the net's voltage. */
  const farNow = (net, t) => {
    const node = nodes.get(net);
    if (node && node.driven == null) return voltsOf(node, t);
    if (node) return volt.voltOf(net) ?? node.driven;
    return voltsAt(net, t);
  };

  /** The curve an RC node runs along from `v0` at `t`, from its network
      linearized there (spice/voltages.js `linearize`): toward the voltage
      that network would settle the node at with its capacitors open, at the
      rate its slope sets — or, where nothing on it gives way (an output
      saturated at its limit), a straight ramp at the current it delivers.
      Either way it ends at the next corner ahead (`until`), where it is
      linearized again. */
  const curveFrom = (lin, v0, t, farads) => {
    if (!lin || (!(lin.siemens > G_EPS) && !(Math.abs(lin.amps) > I_EPS))) {
      return { t0: t, v0, vInf: v0, tau: Number.POSITIVE_INFINITY };
    }
    const curve =
      lin.siemens > G_EPS
        ? { t0: t, v0, vInf: v0 + lin.amps / lin.siemens, tau: farads / lin.siemens } // prettier-ignore
        : { t0: t, v0, vInf: v0, tau: Number.POSITIVE_INFINITY, rate: lin.amps / farads }; // prettier-ignore
    return withCorner(curve, lin.kinks);
  };
  /** A curve, ended at the nearest of `kinks` ahead of it that it reaches. */
  const withCorner = (curve, kinks) => {
    const dir = heading(curve);
    let until = null;
    for (const k of kinks) {
      if (!((k - curve.v0) * dir > KINK_EPS)) continue; // behind it, or where it is
      if (!curve.rate && !((curve.vInf - k) * dir > KINK_EPS)) continue; // never reached
      if (until == null || (k - until) * dir < 0) until = k;
    }
    if (until != null) curve.until = until;
    return curve;
  };
  const sameCurve = (a, b) => {
    if (!a) return false;
    const near = (x, y) => x === y || Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y)); // prettier-ignore
    if ((a.until ?? null) !== (b.until ?? null)) return false;
    // A ramp is its rate (its anchor says where it is); a curve its target
    // and its time constant.
    if (a.rate || b.rate) return near(a.rate ?? 0, b.rate ?? 0);
    return Math.abs(a.vInf - b.vInf) <= FLIP_EPS && near(a.tau, b.tau);
  };

  /** Re-read every node after a settle (`settled`) or at a corner,
      re-anchoring a curve whose target, time constant, rate or next corner
      moved at the voltage it had reached — and, after a settle, first
      stepping each by what its capacitors carried in from a far side that
      switched (spice/coupling.js). Then every listener's voltage is stated
      again as the node curves it moves with (spice/voltages.js `affine`). */
  const updateNodes = (t, settled) => {
    // Where every node stands now, before anything steps.
    const before = new Map();
    for (const [net, node] of nodes) before.set(net, voltsOf(node, t));
    const pairs = pairsOf();
    let steps = EMPTY_MAP;
    if (settled) {
      const stepping = new Map();
      for (const [net, cand] of s.candidates) {
        const node = nodes.get(net);
        if (pairs.has(net)) continue;
        if (node && node.driven == null) stepping.set(net, { caps: cand.caps });
      }
      if (stepping.size) {
        steps = couplingSteps(stepping, (cap, net) => {
          const seen = capFar.get(`${cap.id}@${net}`);
          if (seen == null) return null;
          const now = farNow(cap.far, t);
          return now == null ? null : now - seen;
        });
      }
    }
    // The other nodes stand where their curves (and steps) have them now.
    const rc = new Map();
    for (const [net, v] of before) rc.set(net, v + (steps.get(net) ?? 0));
    volt.setNodes(s.candidates, rc);
    // A capacitor alone on both its nets first: its plates stand where its
    // voltage and both their networks put them (spice/coupling.js).
    for (const [a, { b, cap }] of pairs) {
      if (a > b) continue; // each pair once
      runPair(a, b, cap, t);
      for (const net of [a, b]) {
        const node = nodes.get(net);
        rc.set(net, node.driven ?? node.curve.v0);
      }
    }
    if (pairs.size) volt.setNodes(s.candidates, rc);
    for (const [net, cand] of s.candidates) {
      if (pairs.has(net)) continue;
      const node = nodes.get(net);
      const v0 = node ? rc.get(net) : chargedTo(net, cand, t);
      const lin = volt.linearize(net, v0);
      if (lin?.driven != null) {
        nodes.set(net, { driven: lin.driven, curve: null });
        continue;
      }
      const curve = curveFrom(lin, v0, t, cand.farads);
      if (node && node.driven == null && !steps.has(net) && sameCurve(node.curve, curve)) continue; // prettier-ignore
      nodes.set(net, { driven: null, curve });
    }
    // Each capacitor's far side as it stands now, for the next step.
    for (const [net, cand] of s.candidates) {
      for (const cap of cand.caps) {
        const far = farNow(cap.far, t);
        if (far != null) capFar.set(`${cap.id}@${net}`, far);
      }
    }
    restate(t);
  };

  /** The capacitors that are the ONLY one on both their nets, each plate's
      net → `{b, cap}` (the other plate's), and not bridged by a resistance
      of their own network (both plates in one: the step through it would be
      shared). Read once per tick. */
  let pairCache = null;
  const pairsOf = () => {
    if (pairCache) return pairCache;
    pairCache = new Map();
    const { clusterOf } = volt.topology();
    for (const [net, cand] of s.candidates) {
      if (cand.caps.length !== 1) continue;
      const [cap] = cand.caps;
      const other = s.candidates.get(cap.far);
      if (other?.caps.length !== 1 || other.caps[0].id !== cap.id) continue;
      const k = clusterOf.get(net);
      if (k != null && k === clusterOf.get(cap.far)) continue;
      pairCache.set(net, { b: cap.far, cap });
    }
    return pairCache;
  };

  /** The voltage across a capacitor, plate on `net` less the other, as the
      last tick left it. */
  const acrossFrom = (cap, net) => {
    const across = charge.get(cap.id) ?? 0;
    return s.capPins.get(cap.id)?.a === net ? across : -across;
  };

  /** Re-anchor a capacitor alone on both its nets (`pairsOf`): the voltage
      across it is what it was; each plate is solved where its own network
      and the current that drives through the capacitor put it, a few rounds
      (each network linearized where its plate then stands); both run along
      the capacitor's one curve. A plate held outright (a bench source) is a
      fixed far side, and the other runs as an ordinary node; a side giving
      no way at all (a saturated output) leaves both plates to the ordinary
      rule. */
  const runPair = (a, b, cap, t) => {
    const na = nodes.get(a);
    const nb = nodes.get(b);
    const u0 = na && nb ? voltsOf(na, t) - voltsOf(nb, t) : acrossFrom(cap, a);
    const guess = na ? voltsOf(na, t) : chargedTo(a, s.candidates.get(a), t);
    const fa = volt.linearize(a, guess);
    const fb = volt.linearize(b, guess - u0);
    if (fa?.driven != null || fb?.driven != null || !fa || !fb) {
      // One plate held outright (a bench source): the other keeps the voltage
      // across, and runs as an ordinary node.
      const aHeld = fa?.driven != null;
      const hv = aHeld ? fa.driven : fb?.driven;
      if (hv == null) {
        for (const net of [a, b]) {
          const v = net === a ? guess : guess - u0;
          nodes.set(net, { driven: null, curve: curveFrom(net === a ? fa : fb, v, t, cap.value) }); // prettier-ignore
        }
        return;
      }
      const [held, free] = aHeld ? [a, b] : [b, a];
      nodes.set(held, { driven: hv, curve: null });
      const fv = aHeld ? hv - u0 : hv + u0;
      const lin = volt.linearize(free, fv);
      nodes.set(free, lin?.driven != null ? { driven: lin.driven, curve: null } : { driven: null, curve: curveFrom(lin, fv, t, cap.value) }); // prettier-ignore
      return;
    }
    const { va, vb } = pairStand(
      u0,
      (v) => volt.current(a, v),
      (v) => volt.current(b, v),
      guess,
      s.vHigh,
    );
    const la = volt.linearize(a, va);
    const lb = volt.linearize(b, vb);
    const curves = pairCurves(t, va, vb, la, lb, cap.value);
    if (!curves) {
      nodes.set(a, { driven: null, curve: curveFrom(la, va, t, cap.value) });
      nodes.set(b, { driven: null, curve: curveFrom(lb, vb, t, cap.value) });
      return;
    }
    nodes.set(a, { driven: null, curve: withCorner(curves.a, la.kinks) });
    nodes.set(b, { driven: null, curve: withCorner(curves.b, lb.kinks) });
  };

  /** Each listener's reading, stated again as the node curves it moves with
      (spice/voltages.js `affine`) — what every crossing is timed off. */
  const restate = (t) => {
    const at = new Map();
    const dirs = new Map();
    for (const [net, node] of nodes) {
      at.set(net, voltsOf(node, t));
      if (node.curve) dirs.set(net, heading(node.curve));
    }
    const watch = [...heard.watch].filter((net) => !s.candidates.has(net));
    const signals = volt.affine(watch, at, dirs);
    const signalOf = (net) =>
      s.candidates.has(net)
        ? nodes.has(net)
          ? { c0: 0, terms: new Map([[net, 1]]) }
          : null
        : (signals.get(net) ?? null);
    diffs = new Map();
    for (const l of heard.list) {
      const diff = differenceOf(l, signalOf);
      if (diff) diffs.set(l.key, diff);
    }
  };

  /** A listener with nothing read yet — every one at Run, one a chip just
      powered — reads its voltage BEFORE the settle: on the digital level of
      a net a capacitor holds, a 555's comparators would chase their own
      discharge transistor round the step loop. Every network is solved as
      it stands, a node not yet seen stands where its capacitors' charge
      puts it, and each reading is taken. */
  let primed = false;
  const primeListeners = (t) => {
    if (heard.list.every((l) => listen.has(l.key))) return;
    if (!primed) {
      volt.prime();
      primed = true;
    }
    let added = false;
    for (const [net, cand] of s.candidates) {
      if (nodes.has(net)) continue;
      const v0 = chargedTo(net, cand, t);
      nodes.set(net, { driven: null, curve: { t0: t, v0, vInf: v0, tau: Number.POSITIVE_INFINITY } }); // prettier-ignore
      added = true;
    }
    if (added) {
      const rc = new Map();
      for (const [net, node] of nodes) rc.set(net, voltsOf(node, t));
      volt.setNodes(s.candidates, rc);
    }
    restate(t);
    detectFlips(t);
    view = computeView(t);
  };

  /** Where a node not yet seen starts: where its capacitors' charge puts it
      — each holds the voltage it was last left with across it (an empty one
      starts its node where its far side is), parallel ones sharing theirs. */
  const chargedTo = (net, cand, t) => {
    let c = 0;
    let cv = 0;
    for (const { id, far, value } of cand.caps) {
      const v = voltsAt(far, t);
      if (v == null) continue;
      const across = charge.get(id) ?? 0;
      const held = s.capPins.get(id)?.a === net ? across : -across;
      c += value;
      cv += (v + held) * value;
    }
    return c > 0 ? cv / c : 0;
  };

  /** Bring every listener's reading up to date with its voltage at `t` —
      true when one changed; count each flip at the tick's own moment against
      its net (a flip replayed while catching up is history, not evidence of
      a fast oscillator). */
  const flips = new Map();
  const countFlip = (net, at) => {
    if (at >= target) flips.set(net, (flips.get(net) ?? 0) + 1);
  };
  const detectFlips = (t) => {
    let any = false;
    for (const l of heard?.list ?? []) {
      const diff = diffs.get(l.key);
      if (!diff) continue;
      const was = listen.get(l.key);
      const next = readingFor(l, differenceAt(diff, t, curveOf), was, FLIP_EPS);
      if (next === was) continue;
      listen.set(l.key, next);
      any = true;
      if (was !== undefined) countFlip(l.net, t);
    }
    return any;
  };

  /** The earliest crossing still ahead of `t`: its time and every listener
      that crosses then — `key` null for a curve reaching its next corner —
      or null. */
  const nextCrossing = (t) => {
    let at = Number.POSITIVE_INFINITY;
    let who = [];
    const consider = (when, entry) => {
      if (!Number.isFinite(when)) return;
      if (when < at - SAME_TIME) {
        at = when;
        who = [entry];
      } else if (when <= at + SAME_TIME) {
        who.push(entry);
      }
    };
    const cornerOf = new Map(); // node → when its curve reaches its corner
    for (const [net, node] of nodes) {
      if (node.driven != null || node.curve.until == null) continue;
      const when = t + crossingTime(node.curve, t, node.curve.until);
      cornerOf.set(net, when);
      consider(when, { net, key: null });
    }
    for (const l of heard?.list ?? []) {
      const diff = diffs.get(l.key);
      const above = listen.get(l.key);
      if (!diff || above === undefined) continue;
      let horizon = Number.POSITIVE_INFINITY;
      for (const node of diff.terms.keys()) {
        horizon = Math.min(horizon, cornerOf.get(node) ?? Number.POSITIVE_INFINITY); // prettier-ignore
      }
      const when = above
        ? firstCrossing(diff, l.down, -1, t, nodeAt, horizon, FLIP_EPS)
        : firstCrossing(diff, l.up, 1, t, nodeAt, horizon, FLIP_EPS);
      consider(when, { net: l.net, key: l.key });
    }
    return Number.isFinite(at) ? { at, who } : null;
  };

  // A late tick catches up from where the last one left off — but only when
  // there is a curve to catch up on (otherwise it is simply at `now`), and
  // not after a tick that found an oscillator faster than the desk: its
  // history is crossings nobody will see, and replaying them would only
  // spend the catch-up budget every tick.
  let t =
    nodes.size && prior?.time != null && prior.time < target && !prior.oscillating && !cycle // prettier-ignore
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
  // Lite tick the next settle IS that next tick. A ROM's writes are dropped,
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
  // What the bench held: a late tick's history ran on the LAST tick's clock
  // phases and signal levels (an input that changed did so at this tick's
  // own moment, not when the history it replays began).
  const own = {
    clockPhase: opts.clockPhase ?? new Map(),
    signalLevels: opts.signalLevels ?? new Map(),
  };
  const before = prior?.inputs ?? own;
  /** One digital tick at `at` on the current view, its state kept. */
  const settleAt = (at) => {
    passes = 0;
    settleTime = at;
    const inputs = at < target ? before : own;
    volt.sources(inputs.clockPhase, inputs.signalLevels);
    result = digitalTick({
      ...opts,
      clockPhase: inputs.clockPhase,
      signalLevels: inputs.signalLevels,
      images: imagesNow(),
      warmStart: warm,
      state,
      prevPinLevels: prev,
      now: at,
      hooks,
    });
    lastAt = at;
    // The edges a timing part's readout is measured from.
    for (const c of lastCtx.chips) {
      const readout = c.def.logic?.readout;
      if (!readout) continue;
      const out = driven.get(c.comp.id);
      for (const { pin } of readout) {
        noteLevel(marks, readerKey(c.comp.id, pin), out?.get(pin), at, cycle?.scale ?? 1); // prettier-ignore
      }
    }
    memWrites.push(...(result.memWrites ?? []));
    unapplied.push(...(result.memWrites ?? []));
    warm = result.netLevels;
    state = result.state;
    prev = result.pinLevels;
  };
  // ── Fast oscillations (spice/cycles.js) ──────────────────────────────────
  // What the chips on the nodes' networks drive there and read anywhere, and
  // every supply's volts: half of a moment's signature, and what a schedule
  // checks it still drives (a RESET raised on an oscillator is a read).
  const driveSig = () => {
    const { clusterOf } = volt.topology();
    const ks = new Set();
    for (const net of nodes.keys()) {
      const k = clusterOf.get(net);
      if (k != null) ks.add(k);
    }
    const parts = [];
    for (const c of lastCtx?.chips ?? []) {
      const onNodes = (net) => net && (nodes.has(net) || ks.has(clusterOf.get(net))); // prettier-ignore
      if (![...c.pinNet.values()].some(onNodes)) continue;
      parts.push(`${c.comp.id}:${c.status}`);
      const read = result?.pinLevels?.get(c.comp.id);
      for (const p of c.def.pins) {
        if (LISTENING.has(p.role)) parts.push(`${c.comp.id}<${p.n}=${read?.get(p.n)}`); // prettier-ignore
      }
      for (const [pin, level] of driven.get(c.comp.id) ?? []) {
        if (onNodes(c.pinNet.get(pin))) parts.push(`${c.comp.id}#${pin}=${level}`); // prettier-ignore
      }
    }
    for (const [id, d] of delivered) parts.push(`${id}=${d.volts}`);
    return parts.join(",");
  };
  // The moments after each crossing (and each corner) this tick, for a
  // cycle to be recognised in.
  const timeline = [];
  const record = (crossing) => {
    if (!heard?.list.length || !nodes.size) return;
    const drive = driveSig();
    timeline.push({
      t,
      crossing,
      sig: signatureOf(nodes, (n) => voltsOf(n, t), listen, drive),
      listen: new Map(listen),
      nodes: new Map(nodes),
      capFar: new Map(capFar),
      drive,
    });
    if (timeline.length > MAX_TIMELINE) timeline.shift();
  };
  /** Draw the cycle from timeline moment `j` to now by its schedule. */
  const enterCycle = (j) => {
    const next = scheduleOf(timeline, j, timeline.length - 1, t, TIMING_CAP_HZ);
    // The listeners the cycle moves — what a counting part is told about.
    const moving = new Set();
    for (const seg of next.segs) {
      for (const [key, v] of seg.listen) {
        if (next.segs[0].listen.get(key) !== v) moving.add(key);
      }
    }
    const pins = new Map();
    for (const l of heard.list) {
      if (!moving.has(l.key)) continue;
      if (!pins.has(l.comp)) pins.set(l.comp, []);
      pins.get(l.comp).push(l.pin);
    }
    cycle = { ...next, pins, netlist: opts.netlist, document: opts.document };
    cycleDone = 0; // it stands at its first segment's start
    marks.clear(); // measured again, in the schedule's time
  };
  /** Stand every node and listener where segment `seg` has them at its own
      clock's `trueAt`, shown at `at`. */
  const applySeg = (seg, trueAt, at) => {
    listen.clear();
    for (const [key, v] of seg.listen) listen.set(key, v);
    nodes.clear();
    for (const [net, node] of seg.nodes) {
      if (node.driven != null) {
        nodes.set(net, node);
        continue;
      }
      const v = valueAt(node.curve, trueAt);
      nodes.set(net, { driven: null, curve: { t0: at, v0: v, vInf: v, tau: Number.POSITIVE_INFINITY } }); // prettier-ignore
    }
    capFar.clear();
    for (const [key, v] of seg.capFar) capFar.set(key, v);
    if (s) {
      const rc = new Map();
      for (const [net, node] of nodes) rc.set(net, voltsOf(node, at));
      volt.setNodes(s.candidates, rc);
    }
    if (heard) view = computeView(at);
  };
  /** Draw the schedule up to `target`: every segment the shown wave has
      begun since the last tick, in order (at most one whole cycle — a later
      tick skips the rest), each settled at the moment it begins, then the
      moment itself. False where a segment no longer drives what it recorded
      — `t` is then that segment's moment, and the nodes run on from it. */
  const runCycle = () => {
    const p = cycleAt(cycle, target);
    const n = cycle.segs.length;
    for (let a = Math.max(cycleDone + 1, p.abs - n + 1); a <= p.abs; a++) {
      const q = segmentAt(cycle, a);
      t = Math.min(Math.max(q.time, lastAt ?? q.time), target);
      applySeg(q.seg, q.seg.t, t);
      settleAt(t);
      cycleDone = a;
      if (driveSig() !== q.seg.drive) return false;
    }
    t = target;
    applySeg(p.seg, p.at, t);
    settleAt(t);
    return driveSig() === p.seg.drive;
  };

  let events = 0; // settles at the tick's own moment (MAX_ANALOG_EVENTS)
  let corners = 0; // curves linearized again at a corner (MAX_CORNERS)
  let caught = 0; // settles replaying a late tick's history (MAX_CATCHUP_EVENTS)
  let capped = false;

  for (;;) {
    if (cycle) {
      // Drawn by its schedule, while each moment it shows still drives what
      // the cycle recorded.
      if (runCycle()) break;
      // Something outside the cycle changed: the nodes run on from here.
      cycle = null;
      marks.clear();
      timeline.length = 0;
    } else {
      if (s) {
        detectFlips(t);
        view = computeView(t);
      }
      settleAt(t);
    }
    if (!s.candidates.size && !nodes.size && lastAt >= target) break;
    t += passes * s.quantum * 1e-9;

    updateNodes(t, true);
    const flipped = detectFlips(t);
    if (flipped || !sameView(view, computeView(t))) {
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
    // A moment just after a crossing: has the analog side come round?
    record(true);
    const from = cycleStart(timeline, TIMING_CAP_HZ, s.vHigh);
    if (from >= 0) {
      enterCycle(from);
      continue;
    }
    let next = nextCrossing(t);
    // A curve reaching a corner (and nothing reading anything new there) is
    // linearized again where it is, with no settle: nothing changed but the
    // slope it runs at.
    const due = (n) =>
      n.at <= target || n.at - Math.max(t, target) <= FAST_WINDOW_S;
    while (next && due(next) && next.who.every((w) => w.key == null)) {
      if (++corners > MAX_CORNERS) break;
      t = Math.max(t, next.at);
      updateNodes(t, false);
      record(false);
      next = nextCrossing(t);
    }
    if (next && due(next)) {
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
      for (const { net, key } of next.who) {
        if (key == null) continue; // a corner, linearized again by the settle
        listen.set(key, !listen.get(key));
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
  // The capacitors' voltages — the RC nodes' curves and the timed parts' own
  // — which the LED and supply readings take as given; and every voltage the
  // desk has, which the probe and the analyzer read.
  const capVolts = new Map();
  const nodeVolts = new Map();
  const collectVolts = () => {
    capVolts.clear();
    nodeVolts.clear();
    if (!s) return;
    for (const [net, node] of nodes) capVolts.set(net, voltsOf(node, t));
    for (const [net, v] of volt.volts()) {
      if (volt.voltOf(net) != null) nodeVolts.set(net, v);
    }
    for (const [net, v] of capVolts) nodeVolts.set(net, v);
  };
  collectVolts();
  // The LEDs and diodes: each judged by the current the solve puts through
  // it at what the supplies deliver — and one past its maximum junction
  // temperature BURNS: it is opened and the solve run again without it (so
  // the segments sharing its resistor take its current, as they do), until
  // nothing more burns.
  const junctionList = lampTopology(opts.document, opts.netlist).junctions;
  const lampsNow = () => {
    for (let round = 0; ; round++) {
      const rep = volt.report();
      const burning = [];
      for (const j of junctionList) {
        const f = burnt.has(j.key) ? null : rep.junctions.get(j.key);
        if (!f) continue;
        const v = j.diode ? diodeVerdict(j.spec, f.amps, f.volts) : ledVerdict(j.spec, f.amps, f.volts); // prettier-ignore
        if (v.burns) burning.push({ j, v });
      }
      if (!burning.length || round > junctionList.length) return verdicts(rep);
      for (const { j, v } of burning) {
        burnt.add(j.key);
        burntNow.push({ key: j.key, comp: j.comp, seg: j.seg, diode: j.diode, amps: v.amps, tj: v.tj, tjMax: j.spec.tjMaxC }); // prettier-ignore
      }
      volt.setBurnt(burnt);
      volt.resolve();
    }
  };
  /** Every junction's verdict, from what flows (burnt ones dark and open). */
  const verdicts = (rep) => {
    const lamps = new Map();
    for (const j of junctionList) {
      const off = { amps: 0, volts: 0, tj: AMBIENT_C, lit: false, level: 0, overdriven: false, burns: false, reverse: false, burnt: burnt.has(j.key), ...(j.diode ? { diode: true } : {}) }; // prettier-ignore
      const f = burnt.has(j.key) ? null : rep.junctions.get(j.key);
      if (!f) {
        lamps.set(j.key, off);
        continue;
      }
      const v = j.diode ? diodeVerdict(j.spec, f.amps, f.volts) : ledVerdict(j.spec, f.amps, f.volts); // prettier-ignore
      lamps.set(j.key, { ...v, burnt: false });
    }
    return { lamps, currents: rep.currents, draws: rep.draws, outputs: rep.outputs, stress: rep.stress, transistors: rep.transistors }; // prettier-ignore
  };
  let lamps = lampsNow();
  // Demand is measured with every supply at its SET voltage (spice/supply.js
  // — measured at a drooped one, the droop would chase its own tail): the
  // passes' own solution while nothing droops or sags, else a fresh one.
  const bookAtSet = () =>
    [...delivered.values()].some((d) => Math.abs(d.volts - d.set) > DROOP_EPS) || // prettier-ignore
    drops.size > 0 ||
    [...lastCtx.chipStatus.values()].some((st) => st.status === CHIP_STATUS.UNDERPOWERED); // prettier-ignore
  const measure = () =>
    measureSupplies({
      doc: opts.document,
      netlist: opts.netlist,
      ctx: lastCtx,
      config,
      draws: bookAtSet() ? volt.report({ atSet: true }).draws : lamps.draws,
    });
  const measured = measure();
  let supplies = measured.supplies;
  let moved = false;
  // The wires' share: each chip's drop between its pins and its supply. A
  // drop under a millivolt — what a bench meter would not show, and what a
  // short jumper usually is — is not applied at all.
  let lastDraws = measured.draws;
  const sag = supplySag(opts.document, opts.netlist, measured.draws);
  for (const [id, drop] of [...sag.drops]) {
    if (drop <= DROOP_EPS) sag.drops.delete(id);
  }
  // A drop or a droop that moved by no more than DROOP_EPS has not moved:
  // the value the passes ran on STANDS, rather than being replaced by one a
  // microvolt off it. Replaced, it changed every chip's supply on the next
  // tick, and with it the voltage side's plan — which re-solved every net on
  // the desk, every other tick, for a change no meter shows (make bench).
  const held = new Map();
  for (const [id, drop] of sag.drops) {
    const was = drops.get(id);
    if (was != null && Math.abs(was - drop) <= DROOP_EPS) held.set(id, was);
    else {
      // New, or moved (every drop left is past DROOP_EPS, so one from
      // nothing has moved too).
      held.set(id, drop);
      moved = true;
    }
  }
  for (const id of drops.keys()) {
    if (!sag.drops.has(id)) moved = true;
  }
  drops.clear();
  for (const [id, drop] of held) drops.set(id, drop);
  for (const [id, sup] of supplies) {
    const was = delivered.get(id);
    const used = was && was.set === sup.set ? was.volts : sup.set;
    if (Math.abs(used - sup.volts) > DROOP_EPS) {
      moved = true;
      delivered.set(id, { set: sup.set, volts: sup.volts });
    } else {
      delivered.set(id, { set: sup.set, volts: used });
    }
  }
  for (const id of [...delivered.keys()]) {
    if (!supplies.has(id)) delivered.delete(id);
  }
  // A chip off the rails runs at what reaches its pins: if that moved in
  // this settle, settle again on it, as for a droop.
  const fedMoved = () => {
    for (const c of lastCtx.chips) {
      if (c.passive) continue;
      const pins = (role) => c.def.pins.filter((p) => p.role === role).map((p) => c.pinNet.get(p.n) ?? null); // prettier-ignore
      const [vccNet] = pins("vcc");
      const gndNets = pins("gnd");
      const railFed =
        lastCtx.supplyPlusVolts.has(vccNet) &&
        gndNets.length > 0 &&
        gndNets.every((net) => lastCtx.supplyMinus.has(net));
      if (railFed) continue;
      const now = volt.chipVolts(vccNet, gndNets);
      const was = lastCtx.chipStatus.get(c.comp.id)?.volts ?? null;
      if ((now == null) !== (was == null)) return true;
      if (now != null && Math.abs(now - was) > DROOP_EPS) return true;
    }
    return false;
  };
  if (fedMoved()) moved = true;
  let unsettled = false;
  if (moved && cycle) {
    // A schedule records one supply's worth of cycle: the nodes run on.
    cycle = null;
    marks.clear();
  }
  if (moved) {
    // The supply moved: settle once more on what it now delivers, so a chip
    // it has dropped out of range is underpowered on THIS tick — and again
    // while that changes what a node reads (a chip gone quiet no longer
    // drives its RC). Past RESETTLE_ROUNDS the next tick, soon, carries on.
    unsettled = true;
    for (let round = 0; round < RESETTLE_ROUNDS; round++) {
      view = computeView(t);
      settleAt(lastAt);
      t += passes * s.quantum * 1e-9;
      updateNodes(t, true);
      if (!detectFlips(t) && sameView(view, computeView(t))) {
        unsettled = false;
        break;
      }
    }
    collectVolts();
    lamps = lampsNow();
    // Report what it delivers now (its demand, booked at the set voltage,
    // is unchanged by the droop itself).
    const again = measure();
    lastDraws = again.draws;
    supplies = new Map(
      [...again.supplies].map(([id, sup]) => [
        id,
        { ...sup, volts: delivered.get(id)?.volts ?? sup.volts },
      ]),
    );
  }
  // Each capacitor's charge as this tick leaves it, wherever both its nets
  // have a voltage; one with a lead floating keeps what it held.
  if (s) {
    const known = (net) =>
      net == null ? null : (capVolts.get(net) ?? voltsAt(net, t));
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
  const stressWarnings = stressOf(lamps, overloaded);
  let chipStatus = result.chipStatus;
  if (overloaded.size) {
    chipStatus = new Map(chipStatus);
    for (const id of overloaded) {
      const entry = chipStatus.get(id);
      if (entry) chipStatus.set(id, { ...entry, status: CHIP_STATUS.OVERLOADED }); // prettier-ignore
    }
  }

  // The digital engine's STRUCTURAL warnings say what it cannot measure;
  // Spice Lite measures it, so they are retired here:
  //   · `ls-fanout` (a CD4000 output on more 74LS inputs than its sheet's
  //     minimum sink guarantees) — the current budget's brownout says it, or
  //     nothing does; both at once told the user two inputs were fine and a
  //     fault;
  //   · `marginal-high` (a 74LS output into a CD4000 input, no pull-up) and
  //     `mixed-supply` (chips on different supplies sharing a net) — every
  //     input READS the voltage now, so a HIGH that is no HIGH to it is
  //     undefined at that input, and an input pulled past its own supply
  //     says so (`input-clamp`, `input-overvoltage`).
  const warnings = [
    ...result.warnings.filter((w) => !RETIRED.has(w.type)),
    ...loadWarnings,
    ...stressWarnings,
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
    if (cycle) {
      later(cycleAt(cycle, target).next);
    } else if (capped) {
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
  // A timing part as its silicon times nothing: its readout is what it was
  // measured doing (spice/measure.js).
  let timing = result.timing;
  for (const c of lastCtx?.chips ?? []) {
    const readout = c.def.logic?.readout;
    if (!readout) continue;
    if (timing === result.timing) timing = new Map(timing);
    const own = partDef(c.comp.ref);
    const analysis = isTimed(own) ? own.logic.timing(timingProbe(lastCtx.trace, c.pinNet)) : null; // prettier-ignore
    timing.set(c.comp.id, measuredTiming(analysis, readout, (pin) => marks.get(readerKey(c.comp.id, pin)), target)); // prettier-ignore
  }

  return Object.assign(result, {
    chipStatus,
    memWrites,
    warnings,
    wakeAt,
    timing,
    settled: result.settled && !capped,
    analog: {
      time: t,
      inputs: own,
      nodes,
      listen,
      capFar,
      marks,
      outputs: committed,
      supplies: delivered,
      drops,
      driven,
      caps: charge,
      oscillating: capped,
      cycle,
      cycleDone,
      burnt,
      voltages: volt.snapshot(),
    },
    nodeVolts,
    supplies,
    loads,
    lamps: lamps.lamps,
    currents: lamps.currents,
    draws: lastDraws,
    transistors: lamps.transistors,
    sag: new Map(
      [...drops].map(([id, drop]) => [
        id,
        { drop, volts: chipStatus.get(id)?.volts ?? null },
      ]),
    ),
  });
}

/**
 * What the solve says the chips' pins are put through: each chip's worst
 * output past its family's limit (`output-current` — a current for a 74LS
 * part, the power in the output transistor for a CD4000 one; spice/params.js
 * `outputLimits`), a 74LS input past its absolute maximum
 * (`input-overvoltage`) and a CD4000 input held past a rail (`input-clamp`,
 * its protection diode's current). Past the smoke limit the chip joins
 * `overloaded` — brown smoke, latched for the run like a fan-out overload.
 * One warning per chip and kind, its worst.
 */
function stressOf({ outputs, stress }, overloaded) {
  const worst = new Map(); // `${kind}:${chip}` → warning
  const keep = (key, w, rank) => {
    const was = worst.get(key);
    if (!was || rank > was.rank) worst.set(key, { ...w, rank });
  };
  for (const o of outputs) {
    const byPower = o.limits.warnMw != null;
    const value = byPower ? o.watts * 1000 : o.amps * 1000;
    const warnAt = byPower ? o.limits.warnMw : o.limits.warnMa;
    const smokeAt = byPower ? o.limits.smokeMw : o.limits.smokeMa;
    if (!(value > warnAt)) continue;
    const smoke = value > smokeAt;
    if (smoke) overloaded.add(o.comp);
    keep(`out:${o.comp}`, { type: "output-current", chip: o.comp, pin: o.pin, amps: o.amps, watts: o.watts, unit: byPower ? "mW" : "mA", limit: smoke ? smokeAt : warnAt, smoke }, (smoke ? 1e9 : 0) + value); // prettier-ignore
  }
  for (const st of stress) {
    if (st.family === "74LS") {
      overloaded.add(st.comp);
      keep(`in:${st.comp}`, { type: "input-overvoltage", chip: st.comp, pin: st.pin, volts: st.volts, max: TTL_INPUT_MAX_V, smoke: true }, 1e9 + st.volts); // prettier-ignore
    } else {
      if (st.smoke) overloaded.add(st.comp);
      keep(`in:${st.comp}`, { type: "input-clamp", chip: st.comp, pin: st.pin, volts: st.volts, amps: st.amps, max: CMOS_CLAMP.smokeMa / 1000, smoke: st.smoke }, (st.smoke ? 1e9 : 0) + st.amps); // prettier-ignore
    }
  }
  return [...worst.values()].map(({ rank: _rank, ...w }) => w);
}

/** A combinational settle — sim/engine.js `settle`, with Spice Lite's
    fields, empty: a one-shot settle has no time for a curve to run in. */
export function settle({ spice: _spice = null, ...opts }) {
  return Object.assign(digitalSettle(opts), {
    analog: null,
    nodeVolts: new Map(),
    supplies: new Map(),
    loads: new Map(),
    // Null, as the digital engine's: a settle has no time, so it has no
    // verdict — and an EMPTY map would read as every LED dark.
    lamps: null,
    currents: new Map(),
    transistors: null,
  });
}

/**
 * The LEDs' (and diodes') warnings for one tick: each that burnt in it (once
 * — a burnt junction is open, so it never burns again), and each LED still
 * lit past its DC rating
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
    warnings.push({ type: b.diode ? "diode-burnt" : "led-burnt", comp: b.comp, seg: b.seg, amps: b.amps, tj: b.tj, tjMax: b.tjMax }); // prettier-ignore
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
