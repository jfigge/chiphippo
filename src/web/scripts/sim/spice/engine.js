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
// (features/done/spice-lite.md). Pure and DOM-free, like sim/engine.js, and held
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
//     up on the crossings it missed, in order. Only what has an electrical or
//     digital consequence wakes the engine — a crossing, a corner, a timer,
//     a relay's contacts, a regulator cooling, the chatter back-off (and the
//     clock edges and inputs SimController ticks it for). A node still on its
//     way, a running wave, a coil still moving are REDRAWN, not ticked: the
//     result says when (`frameAt`, spice/sample.js `nextDisplayFrame`) and
//     the views read the carried curves at that moment (`sampleAnalog`) —
//     exact until the next wake, since every corner and crossing is one.
//     A capacitor's far side JUMPING carries through it (spice/coupling.js,
//     every node's charge conserved). Nodes that see each other — two in
//     one network, two a capacitor joins — move TOGETHER, exactly: one
//     linear system per piece, a lone capacitor's plates one charge and an
//     algebraic common voltage (spice/dynamics.js, `runGroup`), the curves
//     ending at the group's next corner in time. Each LISTENER — an input or a
//     comparator reading a node's network, a resistor away included — reads
//     its own crossings of it (spice/listeners.js), stated in the node curves
//     it moves with.
//
//   SILICON.  A timing part is evaluated as its silicon (spice/silicon.js,
//     the `logicOf` hook): comparators, internal resistors and a discharge
//     transistor on its pins, the voltage solve doing the timing. Its readout
//     is what it MEASURED (spice/measure.js).
//
//   LIMITS.  Each ISLAND (spice/islands.js — what shares nothing with the
//     rest of the desk but a rail) is budgeted on its own. A whole island's
//     analog side that comes round to a moment it has been at before, in
//     less than TIMING_CAP_HZ's period, is a CYCLE: drawn from then on by its
//     schedule at the cap, its duty kept, while time runs true
//     (spice/cycles.js; a counting part is told the true cycles through
//     `stepEnv`) — several islands each by its own. Otherwise at most
//     MAX_ANALOG_EVENTS settles per island at the tick's own moment: a node
//     still crossing back and forth at the limit is an oscillation the desk
//     cannot show (an RC round an ordinary inverter, two fast oscillators on
//     one island that never repeat together) — `oscillation`, shown at no
//     more than TIMING_CAP_HZ's rate, its island backing off alone.
//     A node mid-charge produces no event at all, so it can never be mistaken
//     for one. Catching up is budgeted APART (MAX_CATCHUP_EVENTS): a late
//     tick replaying a slow oscillator's honest crossings is no evidence of a
//     fast one, and past its budget it skips the rest of the history rather
//     than warn.
//
// (An analog switch's control reads its own pin's voltage, as any input
// does — spice/voltages.js — and the digital engine's channel joins read it
// the same way, through `input`.)
//
// What Spice Lite adds to a result:
//   analog     the run-volatile analog state, handed back in as
//              `spice.analog` (`{time, inputs, nodes, listen, capFar,
//              marks, outputs, supplies, drops, driven, caps, oscillating,
//              chatters, cycles, islands, burnt, voltages}`; null at Run)
//   nodeVolts  net → volts, for every net something holds (a floating one
//              has none)
//   currents   hole → amps through the lead in it, for every lead the solve
//              knows (the probe's readout)
//   lamps      every LED's and diode's verdict (below)
//   draws      what each supply delivers and where (spice/supply.js)
//   supplies   PSU id → {set, volts, amps, demand, limit, limited, peak}
//              (spice/supply.js)
//   loads      each output pin whose load holds its net where an input on
//              it no longer reads its level — a brownout (spice/loads.js)
//   sag        chip id → {drop, volts}: what it loses in the wires to its
//              supply, and the supply it is left with (spice/sag.js)
//
//   CURRENT (Phase 4).  After the settle, each supply's demand is summed and,
//     past its current limit, its voltage droops (spice/supply.js). The
//     drooped voltage is carried in `analog.supplies` and handed back to the
//     engine through the `psuVolts` hook — at once, with one more settle, when
//     it moved this tick — so a chip whose supply sags out of range is
//     underpowered by the engine's own power check. FAN-OUT is the solve's
//     own: every input draws what its stages say, so an output with too much
//     on it is a net its inputs no longer read as the level it drives — a
//     `brownout` warning (spice/loads.js), never smoke. What smokes is the
//     current through a pin: past its family's limit (spice/params.js
//     `outputLimits` — 20 mA on a 74LS output, 50 mW in a CD4000 one, the
//     CMOS buffers' and drivers' too) an `output-current` warning, past its
//     smoke limit (100 mA, 100 mW) brown smoke — the chip reported
//     OVERLOADED for SimController to latch. An analog switch channel past
//     10 mA warns and past 25 mA smokes (`switch-current`); a discrete
//     transistor past its kind's limits warns (`transistor-overload`). An
//     input is held to its own: a 74LS input past 7 V smokes
//     (`input-overvoltage`), a CD4000 or MOS input held past a rail warns as
//     its protection diode conducts (`input-clamp`) and smokes past 10 mA,
//     and a CD4000 input in its undefined band draws CMOS_BAND_MA from its
//     supply.
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
//     (features/done/spice-lite.md Q4: warn only, until decided otherwise).

import {
  tick as digitalTick,
  settle as digitalSettle,
  contextOf,
  CHIP_STATUS,
  MAX_ITERATIONS,
} from "../engine.js";
import { H, L, X, Z } from "../levels.js";
import { groupsOf } from "../settle-pass.js";
import { MIN_SHOWN_S } from "../timing.js";
import { normalizeSpiceConfig } from "./config.js";
import { ASSERT_ANALYSIS, ASSERT_REPLAY, UNSCOPED } from "../assert-modes.js";
import {
  CMOS_CLAMP,
  TTL_INPUT_MAX_V,
  delayNs,
  familyParams,
  partParams,
} from "./params.js";
import {
  crossingTime,
  firstRoot,
  heading,
  isCoupled,
  sampleTimes,
  valueAt,
} from "./rc-curve.js";
import { couplingSteps } from "./coupling.js";
import { awayAmps, shortedInductors } from "./inductors.js";
import { gaussSolve } from "./network.js";
import { coupledValue, nullModes, rcSystem } from "./dynamics.js";
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
import { LEVEL_WAVES } from "../../catalog/parts.js";
import { isTimed, isVolatileMemory } from "../chip-eval.js";
import { timingProbe } from "../rc-trace.js";
import { measuredTiming, noteLevel } from "./measure.js";
import {
  MAX_TIMELINE,
  cycleStart,
  sameDrive,
  scheduleAt as cycleAt,
  scheduleOf,
  segmentAt,
  signatureOf,
  trueCycles,
} from "./cycles.js";
import { TIMING_CAP_HZ } from "../timing.js";
import { partPinAddresses } from "../../model/occupancy.js";
import { linearBiasWarnings, selfBiasedGates } from "./linear-bias.js";
import { benchWarnings, TRIP_S } from "./bench-warnings.js";
import { waveGenerator, waveHeading } from "./waves.js";
import { ANALOG_FRAME_S, nextDisplayFrame } from "./sample.js";
import { islandsOf } from "./islands.js";

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

/** How often a node still on its way is redrawn, simulated seconds — a
    display frame, no wake (spice/sample.js). */
export { ANALOG_FRAME_S } from "./sample.js";

/** A wave's value moving by less than this between one generator and the
    next is no jump (volts): the two meet at an edge but for rounding. */
const WAVE_JUMP_EPS = 1e-6;

/** The most corners one tick re-linearizes curves at, with no settle between
    (a node's charge crosses a stage's knee or saturation corner). */
const MAX_CORNERS = 256;

/** A network giving way slower than this, siemens, gives no curve a time
    constant (ten times a junction's gigaohm leakage stand-in). */
const G_EPS = 1e-8;

/** A current under this, amps, charges nothing worth a curve (a tenth of a
    nanoamp moves 10 µF ten microvolts a second). */
const I_EPS = 1e-10;

/** How long a group stuck on a corner first runs on past it, seconds, when
    its last piece took no time at all (`runGroup`); it doubles from there. */
const STUCK_MIN_S = 1e-15;

/** How many of a group's latest pieces a corner coming round again is
    recognised among (`runGroup`). */
const RECENT_PIECES = 4;

/** A corner must lie this far ahead of a curve to be one, volts. */
const KINK_EPS = 1e-9;

/** A crossing must clear the trigger point by this much to count, volts — so
    a node resting ON its threshold does not chatter. */
const FLIP_EPS = 1e-9;

/** How far a listener's solved voltage must stand from what the nodes alone
    make it, volts, before a DRIVER is taken to have moved it (and the pin is
    read from the solve, not its crossings): far past the solve's own noise,
    far under any logic swing. */
const DRIVER_EPS = 1e-3;

/** The prefix an inductor's current takes among a listener's terms (its
    statement in the states it moves with — spice/voltages.js `affine`). */
const COIL = "coil:";

/** A relay's crossing, in `nextCrossing`'s list (its key's prefix). */
const RELAY = "relay:";

/** How close to its threshold a relay's coil current moves its contacts,
    relative: the settle its crossing asks for sits on the threshold. */
const RELAY_EPS = 1e-6;

/**
 * Every relay on a desk, by id: `{a, rated, pullIn, dropOut}` — its coil leg
 * read HIGH while it is pulled in, its rated coil current (amps) and the
 * fractions of it its contacts move at (catalog/bench-parts.js).
 * @param {object} doc
 */
function relaysOf(doc) {
  const cached = RELAYS.get(doc);
  if (cached) return cached;
  const out = new Map();
  for (const comp of doc.components ?? []) {
    const def = partDef(comp.ref);
    if (!def?.coil || !def.contacts) continue;
    const rated = def.coil.volts(comp.params) / def.coil.ohms(comp.params);
    out.set(comp.id, { a: def.coil.a, rated, pullIn: def.contacts.pullIn, dropOut: def.contacts.dropOut }); // prettier-ignore
  }
  RELAYS.set(doc, out);
  return out;
}

/** Each document's relays (`relaysOf`) — a snapshot is never edited, and a
    run hands every tick the same one until the desk changes. */
const RELAYS = new WeakMap();

/**
 * The per-tick analysis, cached by the CONTEXT it was made from
 * (features/09-cache-tick-analysis.md): `analyze`'s answer, and per context
 * its listeners, their keys and each node's own supply. A context under
 * Spice Lite is rebuilt only when the document, the netlist or a hook answer
 * it was built on changes (sim/engine.js `contextFor`), and each of these is
 * a pure function of it, the setting and the topology — so the same context
 * is the same analysis. `SPICE_ASSERT_ANALYSIS` recomputes and compares.
 */
const ANALYSES = new WeakMap(); // ctx → {configKey, s}
const HEARD = new WeakMap(); // ctx → {configKey, s, topo, heard, listenerOf, nodeHigh}

/** Assertion mode's comparison of a cached piece of analysis with the same
    computed afresh (both plain data, Maps and Sets; parts compared by
    identity). */
function assertSameAnalysis(what, a, b) {
  const seen = new Set();
  const same = (x, y) => {
    if (x === y) return true;
    if (typeof x !== "object" || typeof y !== "object" || !x || !y) return Number.isNaN(x) && Number.isNaN(y); // prettier-ignore
    if (seen.has(x)) return true;
    seen.add(x);
    if (x instanceof Map) return y instanceof Map && x.size === y.size && [...x].every(([k, v]) => y.has(k) && same(v, y.get(k))); // prettier-ignore
    if (x instanceof Set) return y instanceof Set && x.size === y.size && [...x].every((v) => y.has(v)); // prettier-ignore
    const kx = Object.keys(x);
    return kx.length === Object.keys(y).length && kx.every((k) => same(x[k], y[k])); // prettier-ignore
  };
  if (!same(a, b)) throw new Error(`SPICE_ASSERT_ANALYSIS: the cached ${what} differs from one computed afresh`); // prettier-ignore
}

/** Crossings this close together, seconds, happen at once. */
const SAME_TIME = 1e-15;

/** How many times a group of coupled nodes is linearized again where the
    solve moved a lone capacitor's common voltage to (`runGroup`). */
const GROUP_ROUNDS = 4;

/** A lone capacitor's plates balance to this, volts (`balance`), and its
    first bracketing step is this, volts. */
const BALANCE_V = 1e-9;
const BALANCE_STEP_V = 0.05;

/** The longest a circuit stuck chattering (`oscillating`) waits to be looked
    at again on its own, seconds. Each capped tick replays its whole event
    budget, so asking again every MIN_SHOWN_S spent tens of milliseconds a
    tick for nothing new; the wait doubles from MIN_SHOWN_S up to this. An
    input, a clock edge or an edit still ticks it at once. */
export const MAX_CAPPED_BACKOFF_S = 1;

/** How long a capped tick is remembered, seconds of simulated time: another
    within it doubles the wait; none, and the circuit is taken as quiet again.
    Capped means the tick spent its whole event budget at one moment without
    finding a cycle — chatter, not a circuit at work. */
export const CHATTER_MEMORY_S = 1;

/** The digital engine's structural warnings Spice Lite answers by
    measuring instead (see `tick`). */
const RETIRED = new Set(["ls-fanout", "marginal-high", "mixed-supply"]);

/** A short THROUGH a transistor or switch stands under Spice Lite only when
    what flows through it is a short's current, amps: as much as would smoke
    a 74LS output (OUTPUT_LIMITS in spice/params.js) — or whatever its supply
    is current-limited to. An NPN whose base is fed through 10 MΩ joins the
    rails in the digital reading, and passes 43 µA. */
const SHORT_AMPS = 0.1;

/**
 * The QUANTUM — a pass, nanoseconds: the shortest gate delay among `delays`
 * (chip id → ns), no shorter than the slowest over MAX_HOLD — and each
 * slower chip's HOLD (its delay in quanta, rounded; only those over one),
 * with the longest. With no delay at all, a 74LS gate's — and `bare` (an
 * island of chips with no gate delay of their own, a 555's, run with these)
 * counts that one in too, as that island alone would run at it.
 * @param {Map<string, number>} delays
 * @param {object} config
 * @param {boolean} [bare]
 */
function quantumOf(delays, config, bare = false) {
  let quantum = Number.POSITIVE_INFINITY;
  for (const d of delays.values()) quantum = Math.min(quantum, d);
  if (bare || !Number.isFinite(quantum)) quantum = Math.min(quantum, familyParams(config, "74LS").delayNs); // prettier-ignore
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
  return { quantum, holds, maxHold };
}

/** Pin roles that READ a net. */
const LISTENING = new Set(["input", "io"]);

/**
 * Each RC node's own supply — the highest voltage anything that can charge it
 * reaches: a + rail its resistive cluster touches, a capacitor's far lead on
 * a + rail, a chip driving a net of its cluster (at the chip's own supply).
 * Half of it is where a node nobody reads is shown to turn HIGH. A node that
 * reaches none of them is left out (the desk's highest supply stands in).
 * @returns {Map<string, number>} net → volts
 */
function ownHigh(ctx, s, topo) {
  const out = new Map();
  const byCluster = new Map(); // cluster index → volts
  const clusterHigh = (k) => {
    if (byCluster.has(k)) return byCluster.get(k);
    const cl = topo.clusters[k];
    let high = 0;
    for (const rail of cl?.rails ?? []) high = Math.max(high, s.railVolts.get(rail) ?? 0); // prettier-ignore
    for (const net of cl?.nets ?? []) {
      for (const d of topo.drivers?.get(net) ?? []) {
        high = Math.max(high, ctx.chipStatus.get(d.comp)?.volts ?? 0);
      }
    }
    byCluster.set(k, high);
    return high;
  };
  for (const [net, cand] of s.candidates) {
    const k = topo.clusterOf.get(net);
    let high = k == null ? 0 : clusterHigh(k);
    for (const cap of cand.caps) high = Math.max(high, s.railVolts.get(cap.far) ?? 0); // prettier-ignore
    if (high > 0) out.set(net, high);
  }
  return out;
}

/** Each topology's dynamic groups (`dynamicGroups`). */
const DYNAMIC = new WeakMap();

/**
 * The states whose motion is ONE linear system (spice/dynamics.js): the RC
 * nodes in one voltage network (they see each other through it), those
 * joined by a capacitor between them (a rail is never a join — a capacitor
 * to it is to a fixed voltage), and every inductor with them, in the network
 * it is a branch of (spice/inductors.js). `{groups: [{nets, coils}]}` — a
 * group of two or more nodes, or of any node and an inductor, or of
 * inductors alone. Fixed for a topology and its RC nodes.
 */
function dynamicGroups(candidates, topo) {
  const cached = DYNAMIC.get(topo);
  if (cached?.candidates === candidates) return cached;
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const next = parent.get(x);
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const clusterKey = (k) => `#cluster${k}`;
  const add = (x) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const net of candidates.keys()) add(net);
  for (const [net, cand] of candidates) {
    for (const cap of cand.caps) if (candidates.has(cap.far)) union(net, cap.far); // prettier-ignore
    const k = topo.clusterOf.get(net);
    if (k == null) continue;
    add(clusterKey(k));
    union(net, clusterKey(k));
  }
  const coilKey = (l) => `#coil${l.id}`;
  for (const l of topo.coils ?? []) {
    add(coilKey(l));
    for (const net of [l.a, l.b]) {
      const k = topo.clusterOf.get(net);
      if (k == null) continue;
      add(clusterKey(k));
      union(coilKey(l), clusterKey(k));
    }
  }
  const members = new Map();
  const at = (x) => {
    const r = find(x);
    if (!members.has(r)) members.set(r, { nets: [], coils: [] });
    return members.get(r);
  };
  for (const net of candidates.keys()) at(net).nets.push(net);
  for (const l of topo.coils ?? []) at(coilKey(l)).coils.push(l);
  const groups = [...members.values()].filter((g) => g.coils.length || g.nets.length > 1); // prettier-ignore
  const out = { candidates, groups };
  DYNAMIC.set(topo, out);
  return out;
}

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

  // A clock brick putting out a WAVE (spice/waves.js) holds its net at a
  // voltage that moves between events: the net is a node too, run along the
  // wave's own generator rather than its capacitors (`runGroup`), so every
  // input on it is read by its crossings and every capacitor it feeds moves
  // with it.
  const waves = new Map(); // net → {id, wave, volts}
  const clockDef = partDef("clock");
  const byId = new Map((doc.components ?? []).map((c) => [c.id, c]));
  for (const clk of ctx.clocks ?? []) {
    const net = clk.outNet;
    if (!net || waves.has(net) || trace.rail(net)) continue;
    const wave = clockDef.waveOf(byId.get(clk.id)?.params);
    // A square or a PWM is a LEVEL, driven like any output.
    if (LEVEL_WAVES.includes(wave)) continue;
    waves.set(net, { id: clk.id, wave, volts: clk.volts });
    const had = candidates.get(net);
    candidates.set(net, { caps: had?.caps ?? [], farads: had?.farads ?? 0, wave: clk.id }); // prettier-ignore
  }

  // Every powered chip's gate delay (a family-less part has none: it
  // switches in one pass), and the desk's QUANTUM and holds (`quantumOf`).
  const delays = new Map();
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK) continue;
    const volts = ctx.chipStatus.get(c.comp.id)?.volts ?? null;
    const d = delayNs(config, c.def, volts);
    if (d != null) delays.set(c.comp.id, d);
  }
  const { quantum, holds, maxHold } = quantumOf(delays, config);
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
  return { trace, railVolts, vHigh, candidates, waves, quantum, holds, maxHold, delays, spikes, capPins }; // prettier-ignore
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

/** Two sets (either may be null) as one, or null. */
function union(a, b) {
  if (!a?.size) return b?.size ? b : null;
  if (!b?.size) return a;
  return new Set([...a, ...b]);
}

/** Whether two pieces of plain run state are alike, all the way down (a
    part's sequential state, a map of pin levels). */
function sameData(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false; // prettier-ignore
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false; // prettier-ignore
    for (const [k, v] of a) if (!b.has(k) || !sameData(v, b.get(k))) return false; // prettier-ignore
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false; // prettier-ignore
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.length !== b.length) return false; // prettier-ignore
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!sameData(a[k], b[k])) return false;
  return true;
}

/**
 * Advance Spice Lite one tick. Takes everything sim/engine.js `tick` takes,
 * plus `spice: {config, analog, waveFrames, replay}` — the setting
 * (spice/config.js's shape), the analog state the previous tick returned
 * (null at Run), whether something records the desk tick by tick (the
 * analyzer: a running wave's frames, a drawn cycle woken segment by segment;
 * default true) and whether a drawn cycle's segments may be replayed from
 * their record (default true; false settles every one — the reference).
 * @param {object} opts
 * @returns {object} the digital result plus `analog`, `nodeVolts`,
 *   `supplies` and `loads`.
 */
/**
 * `+ net → whether a short the channel joins make on it stands`: the joins
 * the digital settle left ON (its `channels`), grouped as it groups them
 * (settle-pass.js `groupsOf`), and the current the solve put through the
 * leads of the group joining that `+` rail to a `−` one. A group whose
 * current the solve does not know (a lead in no hole) stands — the digital
 * reading is all there is.
 */
function viaShortMeter(ctx, channels, opts, currents, supplies) {
  if (!ctx || !channels?.size) return () => true;
  const { psuOfNet, terminals } = supplyTopology(opts.document, opts.netlist);
  const byId = new Map(ctx.chips.map((c) => [c.comp.id, c]));
  const pairs = [];
  for (const [id, states] of channels) {
    const c = byId.get(id);
    if (!c) continue;
    for (const ch of states) {
      if (ch.on !== H) continue;
      const a = c.pinNet.get(ch.a);
      const b = c.pinNet.get(ch.b);
      if (!a || !b || a === b) continue;
      pairs.push({ a, b, comp: id, pins: [ch.a, ch.b] });
    }
  }
  const groups = groupsOf(ctx, pairs)?.all ?? [];
  const amps = (p) => {
    const at = terminals.get(p.comp);
    let best = null;
    for (const pin of p.pins) {
      const flow = currents?.get(at?.get(pin));
      if (flow != null) best = Math.max(best ?? 0, Math.abs(flow));
    }
    return best;
  };
  return (plus) => {
    if (supplies?.get(psuOfNet.get(plus))?.limited) return true;
    let found = false;
    for (const { members } of groups) {
      if (!members.includes(plus)) continue;
      if (!members.some((net) => ctx.supplyMinus.has(net))) continue;
      found = true;
      const inside = new Set(members);
      let most = null;
      for (const p of pairs) {
        if (!inside.has(p.a) || !inside.has(p.b)) continue;
        const flow = amps(p);
        if (flow == null) return true;
        most = Math.max(most ?? 0, flow);
      }
      if (most == null || most >= SHORT_AMPS) return true;
    }
    return !found;
  };
}

export function tick({ spice = null, ...opts }) {
  const config = normalizeSpiceConfig(spice?.config);
  const configKey = JSON.stringify(config);
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
  // Each island's oscillation faster than the desk shows, drawn by its
  // schedule (spice/cycles.js) — for as long as the circuit it was recorded
  // on stands. One per ISLAND (spice/islands.js, features/04-island-analog-
  // bookkeeping.md): two oscillators that cannot see each other are two
  // cycles, each drawn by its own schedule. Island → `{cycle, done, memo,
  // memoOwned, steady}`: `done` the last of its segments this run has been
  // through (cycles.js `scheduleAt`'s count); `memo` what settling each of
  // its segments did, once the cycle has shown it is periodic (`replaySeg`;
  // features/02-cycle-replay.md) — by segment index, replaced (never edited)
  // as it grows; `steady` how many segments in a row have been replayed: a
  // whole cycle's worth is a STEADY cycle, which needs no wake per segment
  // (`wakeAt`). A tick that did not end settled hands on neither.
  const drawn = new Map();
  for (const [key, st] of prior?.cycles ?? []) {
    if (st.cycle.netlist !== opts.netlist || st.cycle.document !== opts.document) continue; // prettier-ignore
    drawn.set(key, {
      cycle: st.cycle,
      done: st.done ?? 0,
      memo: prior.quiet ? (st.memo ?? null) : null,
      memoOwned: false,
      steady: prior.quiet ? (st.steady ?? 0) : 0,
    });
  }
  // The desk's islands (spice/islands.js): this tick's from its first
  // context on — until then the last tick's, which are this desk's wherever
  // a cycle was carried (only ever on the very same desk).
  let isl = drawn.size || prior?.islandNext ? (prior.islands ?? null) : null;
  /** The island a net is on (null: a rail, or none known yet). */
  const islandOf = (net) => (net == null ? null : (isl?.islandOf.get(net) ?? null)); // prettier-ignore
  /** Whether everything the analog side carries is ONE island's — the
      commonest desk, kept whole rather than sorted into islands (and so
      exactly as it was before there were islands). */
  const oneIsland = () => !isl || isl.analog.length <= 1;
  /** Whether `net` is island `key`'s — or on none known, which every island
      keeps (a rail; a listener a context no longer has). */
  const onIsland = (net, key) => {
    if (oneIsland()) return true;
    const i = islandOf(net);
    return i == null || i === key;
  };
  /** Whether a drawn cycle has `net`: its nodes stand where their
      schedule has them, and only it moves them. */
  const isDrawn = (net) => {
    if (!drawn.size && !due) return false;
    const i = islandOf(net);
    return drawn.has(i) || (due != null && i != null && !due.has(i));
  };
  /** Whether `net` is on an island this tick is not for (`due`): it stands
      on its curve, untouched — its networks keep the voltages they were
      last solved at (spice/voltages.js `nodeVoltUsed`). */
  const paused = (net) => {
    if (!due) return false;
    const i = islandOf(net);
    return i != null && !due.has(i) && !drawn.has(i);
  };
  /** Whether island `st`'s cycle is STEADY and nothing records it: every
      segment of its last whole cycle replayed (`replaySeg`) and the analyzer
      not listening (`spice.waveFrames`) — so it is woken a display frame at
      a time, not a segment at a time (`wakeAt`), each tick walking what the
      shown wave did since from its record. */
  const steadyFramed = (st) =>
    Boolean(st.cycle.scope) &&
    st.steady >= st.cycle.segs.length &&
    spice?.waveFrames === false;
  // The islands stuck chattering lately (`chatter` at the tick's end), each
  // `{key, nets, at, backoff}`.
  const chatters = prior?.chatters ?? [];
  /** What the last tick remembered of island `key`'s chatter — by its name,
      or, on a desk an edit has changed, by any net the two share. */
  const chatterOf = (key) => {
    for (const c of chatters) if (c.key === key) return c;
    const mine = isl?.nets.get(key);
    if (!mine || !chatters.length) return null;
    const set = new Set(mine);
    let found = null;
    for (const c of chatters) {
      if (c.nets.some((net) => set.has(net)) && (!found || c.at > found.at)) found = c; // prettier-ignore
    }
    return found;
  };
  // Islands are budgeted apart (features/04-island-analog-bookkeeping.md):
  // the ones that spent their whole event budget at this tick's own moment
  // (`capped`), and — on a late tick — the ones catching up on its history
  // (`catchUp`, null until the first context names them; one past its
  // MAX_CATCHUP_EVENTS leaves it and waits for the tick's own moment).
  // `resettling`: the settles a moved supply asks for, once every cycle has
  // ended — every island is read there.
  const capped = new Set();
  let catchUp = null;
  let resettling = false;
  // The islands this tick is FOR (features/12-island-scheduling.md, the
  // scoped form): those with an event due by now, those a bench source on
  // them changed, and every island that shares a supply with one; null —
  // every island (one island, a new desk, a timer or a regulator due, …).
  // Every other island stands on its curves, untouched: nothing on it
  // happens before its own next event, nothing outside reaches it.
  let due = null;
  /** Whether island `key` is stepped crossing by crossing at the moment the
      tick has reached (`t`): not drawn, not capped, and — before the tick's
      own moment — catching up. Null (no island known) always is. */
  const live = (key) =>
    key == null ||
    ((!due || due.has(key)) &&
      !drawn.has(key) &&
      (resettling ||
        (!capped.has(key) && (t >= target || !catchUp || catchUp.has(key)))));
  /** Whether some analog island is stepped at all this tick (not drawn,
      not capped) — and whether one is at the moment reached. */
  const anySteps = () => (isl?.analog ?? []).some((k) => (!due || due.has(k)) && !drawn.has(k) && !capped.has(k)); // prettier-ignore
  const anyLive = () => (isl?.analog ?? []).some(live);
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
  // The regulators shut down hot, each until the moment it has cooled
  // (spice/bench-warnings.js): off for this tick while that is still ahead.
  const thermal = new Map(
    [...(prior?.thermal ?? [])].filter(([, until]) => until > target),
  );
  const burntNow = [];
  const kicksNow = new Map(); // transistor → {volts, joules} (`inductive-kick`)
  let spikeNow = new Map(); // psu → amps switched in this pass
  const spikePeak = new Map(); // psu → the worst pass this tick
  let settlePeak = new Map(); // psu → the worst pass of the settle under way
  const foldSpikes = () => {
    for (const [psu, amps] of spikeNow) {
      spikePeak.set(psu, Math.max(spikePeak.get(psu) ?? 0, amps));
      settlePeak.set(psu, Math.max(settlePeak.get(psu) ?? 0, amps));
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
  volt.setThermal(new Set(thermal.keys()));
  // The relays: each one's contacts follow its coil's CURRENT, pulled in
  // past `pullIn` of its rating and let go under `dropOut` of it — carried
  // tick to tick, and read by its channels through the `input` hook (its
  // coil leg `a` HIGH while pulled in, its leg `b` LOW: the logic engine's
  // own "energized" reading).
  const relays = relaysOf(opts.document);
  const relayOn = new Map(prior?.relays ?? []);
  /** Each relay's contacts as its coil's current at `at` puts them. */
  const syncRelays = (at) => {
    for (const [id, relay] of relays) {
      const curve = coils.get(id);
      const away = coilsAway.get(id);
      const amps = Math.abs(curve ? valueAt(curve, at) : away ? awayAmps(away, at) : (coilAmps.get(id) ?? 0)); // prettier-ignore
      const on = relayOn.get(id) === true;
      // A hair inside each threshold: the settle a crossing asks for sits
      // ON it.
      if (!on && amps >= relay.pullIn * relay.rated * (1 - RELAY_EPS)) relayOn.set(id, true); // prettier-ignore
      else if (on && amps <= relay.dropOut * relay.rated * (1 + RELAY_EPS)) relayOn.set(id, false); // prettier-ignore
    }
  };
  let settleTime = target; // the moment the settle under way runs at
  let heard = null; // the listeners (spice/listeners.js), per context
  let listenerOf = new Map(); // key → its listener, per context
  // Whether this settle has solved its voltages yet: before its first pass's
  // solve, a net's voltage is the LAST settle's — its drivers then, its
  // nodes where they stood then (`rereadListener` must not read it).
  let solvedYet = false;
  let diffs = new Map(); // listener key → what it reads, as node curves
  let view = new Map(); // net → the level it is shown at
  // Each RC node's own supply, per context: what a node nobody reads is
  // judged against (half of it), so a 5 V RC on a desk that also holds a
  // 12 V supply still reads HIGH at 5 V (`ownHigh`).
  let nodeHigh = new Map();
  // The RC nodes that may have to move together, per context
  // (`dynamicGroups`).
  let dynamic = { groups: [] };
  // Each inductor's current, as the curve it runs along (spice/inductors.js):
  // carried tick to tick like the nodes, and its current at the last
  // tick's end (`amps`) by inductor id, as `charge` is.
  const coils = new Map();
  for (const [id, curve] of prior?.coils ?? []) coils.set(id, curve);
  const coilAmps = new Map(prior?.coilAmps ?? []);
  // Each inductor that is no branch any more — shorted by a switch, or a
  // lead off — by id: its current and when it left (spice/inductors.js
  // `awayAmps`); and each one's L/R, as it last was a branch.
  const coilsAway = new Map(prior?.coilsAway ?? []);
  const coilTau = new Map(prior?.coilTau ?? []);
  const ampsAt = (t) => {
    const out = new Map(coilAmps);
    for (const [id, curve] of coils) out.set(id, valueAt(curve, t));
    return out;
  };
  let passes = 0;

  /** A node's state as spice/listeners.js reads it. */
  const nodeAt = (net) => {
    if (net.startsWith(COIL)) {
      const curve = coils.get(net.slice(COIL.length));
      return curve ? { curve } : null;
    }
    const node = nodes.get(net);
    if (!node) return null;
    return node.driven != null ? { value: node.driven } : { curve: node.curve };
  };
  const curveOf = (net, t) => {
    if (net.startsWith(COIL)) {
      const curve = coils.get(net.slice(COIL.length));
      return curve ? valueAt(curve, t) : 0;
    }
    const node = nodes.get(net);
    return node ? voltsOf(node, t) : 0;
  };

  // ── Waves (spice/waves.js) ────────────────────────────────────────────
  /** A wave net's generator at `t`, on the bench's inputs at that moment
      (a late tick's history on the last tick's, as `settleAt` runs it). */
  const generatorOf = (net, t, inputs = t < target ? before : own) => {
    const w = s.waves.get(net);
    return waveGenerator(w.wave, inputs.clockPhase.get(w.id), inputs.clockTimes.get(w.id), w.volts ?? s.vHigh, t); // prettier-ignore
  };
  // What each wave jumped by at this tick's own moment — its edge, where the
  // bench's inputs change (a sawtooth dropping back) — not yet carried
  // through a capacitor into the nodes it feeds (`updateNodes`); and the
  // waves whose jump has been taken. Only an edge jumps: between edges a
  // wave moves, and its group carries that (`runGroup`).
  const waveJumps = new Map();
  const jumped = new Set();
  /** Each wave's node from its generator at `t`: a straight ramp until
      `runGroup` puts it in its group's system, or held where a clock held on
      its own (or an edge overdue) leaves it. */
  const refreshWaves = (t) => {
    for (const net of s?.waves.keys() ?? []) {
      const gen = generatorOf(net, t);
      if (t >= target && !jumped.has(net)) {
        jumped.add(net);
        const jump = gen.value - generatorOf(net, target, before).value;
        if (Math.abs(jump) > WAVE_JUMP_EPS) waveJumps.set(net, jump);
      }
      nodes.set(
        net,
        gen.running
          ? { driven: null, curve: { t0: t, v0: gen.value, vInf: gen.value, tau: Number.POSITIVE_INFINITY, ...(gen.slope ? { rate: gen.slope } : {}) } } // prettier-ignore
          : { driven: gen.value, curve: null },
      );
    }
  };
  /** Whether a wave net runs now (its node a curve, not held). */
  const waveRuns = (net) => s.waves.has(net) && nodes.get(net)?.driven == null;
  /** Each wave net's clock, for the analog state (spice/sample.js). */
  const waveIds = () => new Map([...(s?.waves ?? [])].map(([net, w]) => [net, w.id])); // prettier-ignore

  /** The level each listened-to net is shown at — its listeners' agreement
      (X when they differ) — and each node nobody reads, by half its own
      supply (`ownHigh`). */
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
      const high = nodeHigh.get(net) ?? s.vHigh;
      out.set(net, voltsOf(node, t) >= high / 2 ? H : L);
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
    const hold = pace()?.holds.get(id) ?? 1;
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

  /** A context's listeners (spice/listeners.js), their keys, and each RC
      node's own supply (`ownHigh`). */
  const listenFor = (ctx, topo) => {
    const nodeClusters = new Set();
    for (const net of s.candidates.keys()) {
      const k = topo.clusterOf.get(net);
      if (k != null) nodeClusters.add(k);
    }
    // A network an inductor is a branch of moves between events too: its
    // readers are read by their crossings, as a node's are.
    for (const l of topo.coils ?? []) {
      const k = topo.clusterOf.get(l.a) ?? topo.clusterOf.get(l.b);
      if (k != null) nodeClusters.add(k);
    }
    const nodeHigh = ownHigh(ctx, s, topo);
    const heard = listenersOf(ctx, config, s.candidates, topo.clusterOf, nodeClusters, topo.rails); // prettier-ignore
    const listenerOf = new Map(heard.list.map((l) => [l.key, l]));
    return { heard, listenerOf, nodeHigh };
  };

  const hooks = {
    logicOf: siliconOf,
    context(ctx) {
      lastCtx = ctx;
      if (!s) {
        const memo = ANALYSES.get(ctx);
        if (memo?.configKey === configKey) {
          s = memo.s;
          if (ASSERT_ANALYSIS) assertSameAnalysis("analysis", s, analyze(ctx, config, opts.document, opts.netlist)); // prettier-ignore
        } else {
          s = analyze(ctx, config, opts.document, opts.netlist);
          ANALYSES.set(ctx, { configKey, s });
        }
        for (const net of [...nodes.keys()]) {
          if (!s.candidates.has(net)) nodes.delete(net);
        }
      }
      volt.context(ctx);
      const topo = volt.topology();
      dynamic = dynamicGroups(s.candidates, topo);
      const coilIds = new Set((topo.coils ?? []).map((l) => l.id));
      // A coil the wiring took out of the network keeps its current only
      // round a loop: shorted, it dies away through the winding; opened, it
      // is gone. Back in, it starts from what is left — never from what it
      // carried when it left.
      const shorted = shortedInductors(opts.document, opts.netlist);
      for (const id of [...coils.keys()]) {
        if (coilIds.has(id)) continue;
        const amps = valueAt(coils.get(id), settleTime);
        coilsAway.set(id, { at: settleTime, amps, tau: shorted.has(id) ? (coilTau.get(id) ?? 0) : 0 }); // prettier-ignore
        coilAmps.set(id, awayAmps(coilsAway.get(id), settleTime));
        coils.delete(id);
      }
      for (const l of topo.coils ?? []) {
        coilTau.set(l.id, l.ohms > 0 ? l.henries / l.ohms : Number.POSITIVE_INFINITY); // prettier-ignore
        const away = coilsAway.get(l.id);
        if (!away) continue;
        coilAmps.set(l.id, awayAmps(away, settleTime));
        coilsAway.delete(l.id);
      }
      const memo = HEARD.get(ctx);
      if (memo?.configKey === configKey && memo.s === s && memo.topo === topo) {
        ({ heard, listenerOf, nodeHigh } = memo);
        if (ASSERT_ANALYSIS) {
          const fresh = listenFor(ctx, topo);
          assertSameAnalysis("listeners", heard, fresh.heard);
          assertSameAnalysis("nodes' supplies", nodeHigh, fresh.nodeHigh);
        }
      } else {
        ({ heard, listenerOf, nodeHigh } = listenFor(ctx, topo));
        HEARD.set(ctx, { configKey, s, topo, heard, listenerOf, nodeHigh });
      }
      // The desk's islands, and — the first time they are known — which of
      // them catch up on a late tick's history: every one not drawn and not
      // chattering lately.
      isl = islandsOf(s, ctx, topo);
      if (ASSERT_ANALYSIS) assertSameAnalysis("islands", isl, islandsOf(s, ctx, topo, { fresh: true })); // prettier-ignore
      catchUp ??= new Set(isl.analog.filter((k) => !drawn.has(k) && !chatterOf(k))); // prettier-ignore
      volt.setOwned(heard.owned);
      refreshWaves(settleTime);
      if (!view.size) view = computeView(settleTime);
      const rc = new Map();
      for (const [net, node] of nodes) rc.set(net, rcOf(net, node, settleTime));
      volt.setNodes(s.candidates, rc);
      volt.setCoils(ampsAt(settleTime));
      solvedYet = false;
      primeListeners(settleTime);
    },
    get maxIterations() {
      return MAX_ITERATIONS * (pace()?.maxHold ?? 1);
    },
    pass() {
      passes++;
      foldSpikes();
    },
    input(c, pin, net, level) {
      if (!net) return level;
      const relay = relays.get(c.comp.id);
      if (relay) return pin === relay.a && relayOn.get(c.comp.id) ? H : L;
      const key = readerKey(c.comp.id, pin);
      if (heard?.owned.has(key)) {
        rereadListener(key);
        const low = heard.windows.get(key);
        if (low != null) rereadListener(low);
        const above = listen.get(key);
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
      let out = info ? volt.pass(next, { ...info, read: hooks.input }) : next;
      if (info) solvedYet = true;
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
    // What changed outside the digital settle since the last one ended, in
    // how a chip reads its pins or what it was last let drive
    // (sim/incremental.js `warmStartOf`): the chips whose listener reading,
    // relay or voltage reading moved, or whose outputs a replay put back,
    // and the nets whose shown level (`view`) moved. Null: start cold.
    warmDirty() {
      if (!settledAt) return null;
      const comp = (key) => key.slice(0, key.lastIndexOf("#"));
      const chips = new Set(drivenMoved);
      for (const [key, v] of listen) if (settledAt.listen.get(key) !== v) chips.add(comp(key)); // prettier-ignore
      for (const key of settledAt.listen.keys()) if (!listen.has(key)) chips.add(comp(key)); // prettier-ignore
      for (const [id, on] of relayOn) if (settledAt.relays.get(id) !== on) chips.add(id); // prettier-ignore
      for (const id of settledAt.relays.keys()) if (!relayOn.has(id)) chips.add(id); // prettier-ignore
      for (const id of readMoved ?? []) chips.add(id);
      readMoved = null;
      const nets = new Set();
      if (settledAt.view !== view) {
        for (const [net, level] of view) if (settledAt.view.get(net) !== level) nets.add(net); // prettier-ignore
        for (const net of settledAt.view.keys()) if (!view.has(net)) nets.add(net); // prettier-ignore
      }
      return { chips, nets };
    },
    // `levels`, as only what it changes (sim/incremental.js applies it to
    // its map in place — features/07-delta-level-maps.md): each net it
    // shows otherwise than `next` says, or null where it would hand `next`
    // back as it is (`next` need only answer `get`).
    levelsDelta(next, info) {
      let over = volt.passOverrides(next, { ...info, read: hooks.input });
      solvedYet = true;
      if (!view.size) return over;
      over ??= new Map();
      for (const [net, level] of view) {
        const now = over.has(net) ? over.get(net) : next.get(net);
        if ((now ?? Z) === Z && !heard?.viewNets.has(net)) continue;
        over.set(net, level);
      }
      return over;
    },
    reread() {
      return volt.takeReread();
    },
    // The chips holding an output back (sim/incremental.js visits them every
    // pass, beside the ones it evaluated again).
    holding() {
      return pending;
    },
    outputs(c, outMap, quiet = false) {
      if (opts.stats) opts.stats.outputsCalls = (opts.stats.outputsCalls ?? 0) + 1; // prettier-ignore
      // (`SPICE_ASSERT_OUTPUTS`: a call the sparse walk skips, made anyway,
      // must change nothing.)
      const before = quiet ? { driven: driven.get(c.comp.id), committed: committed.get(c.comp.id), spikes: new Map(spikeNow) } : null; // prettier-ignore
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
      if (before) {
        const same = out === before.driven && committed.get(c.comp.id) === before.committed && !pending.has(c.comp.id) && spikeNow.size === before.spikes.size && [...spikeNow].every(([k, v]) => before.spikes.get(k) === v); // prettier-ignore
        if (!same) throw new Error(`SPICE_ASSERT_OUTPUTS: a skipped outputs call for ${c.comp.id} would have changed something`); // prettier-ignore
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
      for (const { cycle } of drawn.values()) {
        const pins = cycle.pins.get(c.comp.id);
        if (!pins) continue;
        const fast = new Map();
        const at = { id: cycle.id, cycles: trueCycles(cycle, settleTime), period: cycle.period }; // prettier-ignore
        for (const pin of pins) fast.set(pin, at);
        return { fast };
      }
      return null;
    },
  };

  /** This tick's pace: its quantum, holds and longest hold
      (features/13-per-island-quantum.md) — the islands it is FOR alone
      decide them, so a CD4000 circuit ticked on its own runs at its own
      gates' delay, not cut into a 74LS board's 10 ns. A desk not yet
      sorted into islands has the whole desk's (`analyze`'s). */
  let paceMemo = null;
  const pace = () => {
    if (!s) return null;
    if (!isl?.chipIsland.size) return s;
    if (paceMemo?.s !== s) {
      // The shortest of the tick's islands' own quanta — counting an island
      // of chips with no gate delay (a 555's) at the one it runs at alone —
      // and each chip's hold in it: a chip's delay is the same nanoseconds
      // whichever islands share its tick.
      const own = new Map();
      const timed = new Set();
      const keys = new Set();
      for (const [id, key] of isl.chipIsland) {
        if (due && !due.has(key)) continue;
        keys.add(key);
        if (s.delays.has(id)) timed.add(key);
      }
      for (const [id, d] of s.delays) if (!due || inScope(id)) own.set(id, d);
      const bare = [...keys].some((k) => !timed.has(k));
      paceMemo = { s, ...quantumOf(own, config, bare) };
    }
    return paceMemo;
  };
  /** Whether a chip is on an island this tick is for (or on none). */
  const inScope = (id) => {
    const i = isl.chipIsland.get(id);
    return i == null || due.has(i);
  };
  /** The islands this tick is for (`due`), or null for every one: each
      island whose own next event (`islandNext`, the last tick's) is due by
      now, each a bench source on it moved since (a clock edge, a signal, a
      clock re-rated) — and every island one of those shares a supply with
      (its droop and its wires' sag are theirs too). Every island, wherever
      anything is not this simple: a new desk, a part's timer or a regulator
      due (`globalNext`), a slow gate's settle running past now, an island
      holding a coil (its current is no node a frozen network can stand
      on), `SPICE_UNSCOPED`. */
  function dueIslands() {
    if (UNSCOPED || spice?.scoped === false || !isl || !prior?.islandNext) return null; // prettier-ignore
    if (prior.time == null || prior.time > target) return null;
    if (prior.globalNext != null && prior.globalNext <= target) return null;
    if (isl.coilIsland.size) return null;
    const out = new Set();
    for (const [key, at] of prior.islandNext) if (at <= target) out.add(key);
    let unknown = false;
    const touch = (kind, id) => {
      const k = `${kind}:${id}`;
      if (!isl.sourceIsland.has(k)) unknown = true;
      const island = isl.sourceIsland.get(k);
      if (island != null) out.add(island);
    };
    const ids = (a, b) => new Set([...(a?.keys() ?? []), ...(b?.keys() ?? [])]);
    for (const id of ids(before.clockPhase, own.clockPhase)) {
      if (before.clockPhase.get(id) !== own.clockPhase.get(id)) touch("clock", id); // prettier-ignore
    }
    for (const id of ids(before.signalLevels, own.signalLevels)) {
      if (before.signalLevels.get(id) !== own.signalLevels.get(id)) touch("signal", id); // prettier-ignore
    }
    for (const id of ids(before.clockTimes, own.clockTimes)) {
      const a = before.clockTimes?.get(id);
      const b = own.clockTimes?.get(id);
      if (a?.half !== b?.half || a?.since !== b?.since || a?.frac !== b?.frac) touch("clock", id); // prettier-ignore
    }
    // A tick for no island in particular (a look at the desk — a test's
    // grid, a run's last moment, a transport catching up) is one for all.
    if (unknown || !out.size) return null;
    for (const group of new Set([...out].map((k) => isl.groupOf.get(k)))) {
      for (const k of isl.members.get(group)) out.add(k);
    }
    if (out.size === isl.groupOf.size) return null;
    return out;
  }

  /** What the voltage side is told an RC node stands at, at `t`: on its
      curve — but on an island this tick is not for, where it was last
      solved, so its networks are not solved again for it (`paused`). */
  const rcOf = (net, node, t) =>
    paused(net) ? (volt.nodeVoltUsed(net) ?? voltsOf(node, t)) : voltsOf(node, t); // prettier-ignore

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
      switched (spice/coupling.js). Nodes that move TOGETHER — two or more
      that no source holds, in one network or joined by a capacitor — run
      along their exact coupled curves instead (`runGroup`). Then every
      listener's voltage is stated again as the node curves it moves with
      (spice/voltages.js `affine`). */
  const updateNodes = (t, settled) => {
    // Each wave where its generator has it now (and what it jumped by, which
    // its capacitors carry like any far side's step — its steady motion is
    // its group's to carry, `runGroup`).
    refreshWaves(t);
    const jumps = new Map(waveJumps);
    waveJumps.clear();
    // Where every node stands now, before anything steps.
    const before = new Map();
    for (const [net, node] of nodes) before.set(net, rcOf(net, node, t));
    let steps = EMPTY_MAP;
    if (settled || jumps.size) {
      const stepping = new Map();
      for (const [net, cand] of s.candidates) {
        if (cand.wave != null || isDrawn(net)) continue;
        const node = nodes.get(net);
        if (node && node.driven == null) stepping.set(net, { caps: cand.caps });
      }
      if (stepping.size) {
        steps = couplingSteps(stepping, (cap, net) => {
          if (s.waves.has(cap.far)) return jumps.get(cap.far) ?? null;
          if (!settled) return null;
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
    const amps = ampsAt(t);
    volt.setCoils(amps);
    const groups = movingTogether(t, rc);
    const grouped = new Set(groups.flatMap((g) => g.nets));
    for (const [net, cand] of s.candidates) {
      if (grouped.has(net) || cand.wave != null || isDrawn(net)) continue;
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
    for (const group of groups) runGroup(group, rc, amps, t);
    volt.setCoils(ampsAt(t));
    // A transistor an inductor has driven into breakdown, its coils' energy
    // with it (`inductive-kick`).
    if (groups.some((g) => g.coils.length)) {
      const { coils: all, clusterOf } = volt.topology();
      for (const kick of volt.kicks()) {
        let joules = 0;
        for (const l of all) {
          if ((clusterOf.get(l.a) ?? clusterOf.get(l.b)) !== kick.cluster)
            continue;
          joules += 0.5 * l.henries * (amps.get(l.id) ?? 0) ** 2;
        }
        const was = kicksNow.get(kick.comp);
        if (!was || kick.volts > was.volts) kicksNow.set(kick.comp, { volts: kick.volts, joules: Math.max(joules, was?.joules ?? 0) }); // prettier-ignore
      }
    }
    // Each capacitor's far side as it stands now, for the next step (a drawn
    // cycle's are its segment's).
    for (const [net, cand] of s.candidates) {
      if (isDrawn(net)) continue;
      for (const cap of cand.caps) {
        const far = farNow(cap.far, t);
        if (far != null) capFar.set(`${cap.id}@${net}`, far);
      }
    }
    restate(t);
  };

  /** The states that must move together now: each dynamic group's
      (`dynamic`) nodes that no source holds, with its inductors — where
      there are two or more nodes, or any inductor. A node not yet seen
      starts where its charge puts it (`chargedTo`), entered in `rc` as it
      is. One node free in a group without an inductor runs on its own
      curve, exactly: the rest of its group is held. */
  const movingTogether = (t, rc) => {
    const out = [];
    let added = false;
    const placed = new Set();
    for (const group of dynamic.groups) {
      // (A drawn cycle's nodes are its schedule's.)
      if (drawn.size && group.nets.some(isDrawn)) continue;
      // A running wave is a state of its group (`runGroup`); one held is a
      // fixed voltage like any source's.
      const waves = group.nets.filter(waveRuns);
      const free = group.nets.filter((net) => !s.waves.has(net) && volt.heldAt(net) == null); // prettier-ignore
      if (free.length < 2 && !group.coils.length && !waves.length) continue;
      const unseen = free.filter((net) => !rc.has(net));
      for (const [net, v0] of chargedNets(unseen, t)) {
        rc.set(net, v0);
        added = true;
      }
      for (const net of waves) placed.add(net);
      out.push({ nets: free, waves, coils: group.coils });
    }
    // A wave with no capacitor or coil in its network runs on its own — its
    // network's corners (a junction it lights, a clamp it reaches) still end
    // its curve, for the inputs reading through it.
    for (const net of s.waves.keys()) {
      if (waveRuns(net) && !placed.has(net) && !isDrawn(net)) out.push({ nets: [], waves: [net], coils: [] }); // prettier-ignore
    }
    if (added) volt.setNodes(s.candidates, rc);
    return out;
  };

  /** A group of states moving together (spice/dynamics.js) — RC nodes and
      inductors — run along their exact coupled curves from where `rc` and
      `amps` have them, to the first corner any of their networks reaches
      (`groupCorner`). A lone capacitor's plates have one charge, not two:
      their common voltage is wherever their networks balance, so the solve
      may move it — and is then read again where it moved to, until the two
      agree. */
  const runGroup = ({ nets, waves = [], coils: group }, rc, amps, t) => {
    // The states, in order: the free RC nodes (`nc`), the running waves, the
    // inductors — what the networks see — and then each sine's quadrature
    // (spice/waves.js), which nothing but its own wave sees.
    const nc = nets.length;
    const nw = waves.length;
    const gens = waves.map((net) => generatorOf(net, t));
    const quad = new Map(); // wave index → its quadrature's offset past `ns`
    gens.forEach((g, k) => {
      if (g.wave === "sine") quad.set(k, quad.size);
    });
    const ns = nc + nw + group.length;
    const n = ns + quad.size;
    const index = new Map(nets.map((net, i) => [net, i]));
    const c = nets.map(() => new Float64Array(nc));
    nets.forEach((net, i) => {
      for (const cap of s.candidates.get(net).caps) {
        c[i][i] += cap.value;
        const j = index.get(cap.far);
        if (j != null) c[i][j] -= cap.value;
      }
    });
    // The whole system's: the capacitances, then each inductor's L — and a
    // wave's own states, each of which moves at its own rate (unit weight:
    // they are never a capacitance, so never a null mode either).
    const e = Array.from({ length: n }, (_, i) => {
      const row = new Float64Array(n);
      if (i < nc) row.set(c[i]);
      else if (i >= nc + nw && i < ns) row[i] = group[i - nc - nw].henries;
      else row[i] = 1;
      return row;
    });
    const dirs = new Map();
    for (const net of nets) {
      const curve = nodes.get(net)?.curve;
      const d = curve ? heading(curve, t) : 0;
      if (d) dirs.set(net, d);
    }
    gens.forEach((g, k) => {
      const d = waveHeading(g);
      if (d) dirs.set(waves[k], d);
    });
    for (const l of group) {
      const curve = coils.get(l.id);
      const d = curve ? heading(curve, t) : 0;
      if (d) dirs.set(l.id, d);
    }
    const modes = nc ? nullModes(c) : [];
    let v = Float64Array.from(nets, (net) => rc.get(net));
    const state = () => Float64Array.from([...v, ...gens.map((g) => g.value), ...group.map((l) => amps.get(l.id) ?? 0), ...gens.filter((_, k) => quad.has(k)).map((g) => g.aux)]); // prettier-ignore
    // The networks linearized with the waves free to move (their columns:
    // how each node's current follows them); then each wave's own rows
    // replaced by its generator, and a capacitor from a node to a wave
    // carrying C times the wave's rate into the node (its plate is driven).
    const linearized = () => {
      const model = volt.linearizeGroup([...nets, ...waves], group, rc, amps, dirs, waves); // prettier-ignore
      if (!nw) return { model, y: model.y, i0: model.i0 };
      const y = Array.from({ length: n }, (_, i) => {
        const row = new Float64Array(n);
        if (i < ns) row.set(model.y[i]);
        return row;
      });
      const i0 = new Float64Array(n);
      i0.set(model.i0);
      gens.forEach((g, k) => {
        const w = nc + k;
        y[w].fill(0);
        i0[w] = 0;
        if (quad.has(k)) {
          const u = ns + quad.get(k);
          y[w][u] = -g.omega;
          y[u][w] = g.omega;
          i0[u] = g.omega * g.mid;
        } else i0[w] = g.slope;
      });
      nets.forEach((net, i) => {
        for (const cap of s.candidates.get(net).caps) {
          const k = waves.indexOf(cap.far);
          if (k < 0) continue;
          const w = nc + k;
          i0[i] += cap.value * i0[w];
          for (let j = 0; j < n; j++) y[i][j] += cap.value * y[w][j];
        }
      });
      return { model, y, i0 };
    };
    let model = null;
    let sys = null;
    for (let round = 0; round < GROUP_ROUNDS; round++) {
      if (modes.length) {
        v = balance(nets, modes, v, rc, amps);
        nets.forEach((net, i) => rc.set(net, v[i]));
        volt.setNodes(s.candidates, rc);
      }
      const lin = linearized();
      model = lin.model;
      sys = rcSystem({ c: e, y: lin.y, i0: lin.i0, v0: state(), t0: t, nc }); // prettier-ignore
      // The linear piece agrees with where the plates balanced: done.
      let moved = 0;
      for (let i = 0; i < nc; i++) moved = Math.max(moved, Math.abs(coupledValue(sys.curves[i], 0) - v[i])); // prettier-ignore
      if (!(moved > BALANCE_V)) break;
    }
    // A coil read the way it WAS going, that now heads the other way (one
    // stopped where its current reached nothing, and coming back): read
    // again the way it goes, or its slope is the other side's, and it
    // settles where that side would have it (a relay's collector resting a
    // volt short of its supply).
    let turned = false;
    group.forEach((l, j) => {
      const d = heading(sys.curves[nc + nw + j], t);
      if (d && dirs.has(l.id) && d !== dirs.get(l.id)) {
        dirs.set(l.id, d);
        turned = true;
      }
    });
    if (turned) {
      const lin = linearized();
      model = lin.model;
      sys = rcSystem({ c: e, y: lin.y, i0: lin.i0, v0: state(), t0: t, nc }); // prettier-ignore
    }
    // A wave's piece ends at its next edge, whatever its network does.
    let limit = Number.POSITIVE_INFINITY;
    for (const g of gens) limit = Math.min(limit, g.end);
    const corner = groupCorner(sys, model, t, limit);
    let tEnd = corner.tEnd;
    // Stuck on a corner: linearized again where its last piece ended, the
    // group finds itself still in that piece — the solve places the state
    // within its own tolerance of the corner, on the old side — and the same
    // corner comes round again a few float steps later: every corner of a
    // tick spent and no time gained (a relay coil's current decaying to
    // nothing through a transistor's junction). Or it SLIDES along one: two
    // pieces each heading into the other, A, B, A, B, picoseconds apart (a
    // Darlington in breakdown). Each time it repeats it runs on along the
    // piece for twice as long as the last before it looks again (never past
    // its slowest time constant: a stuck coil's fastest is the transistor's
    // leakage, and capped there it took 19 000 corners to run a relay's kick
    // out), a hair past a corner the two pieces meet at continuously.
    const prev = group.length ? coils.get(group[0].id) : nodes.get(nets[0] ?? waves[0])?.curve; // prettier-ignore
    const recent = prev?.recent ?? [];
    // (A group whose last piece a wave's edge ended is not stuck: it moved
    // on to the wave's next piece.)
    const repeat =
      !prev?.byWave &&
      prev?.tEnd != null &&
      prev.tEnd <= t &&
      (prev.pieces === corner.now || recent.includes(corner.now));
    let run = 0;
    if (repeat) {
      const slow = Number.isFinite(sys.scale.slow) ? sys.scale.slow : Infinity;
      run = Math.min(2 * Math.max(prev.run ?? 0, t - prev.t0, STUCK_MIN_S), slow); // prettier-ignore
      const runTo = t + run;
      // …but never carries a coil's current through zero: a current dying
      // into a one-way path (a transistor's breakdown, a diode) stops there,
      // and run on past it, the piece pulled it backwards through the very
      // clamp that had stopped conducting (a relay's coil with no diode).
      let end = runTo;
      group.forEach((l, j) => {
        const curve = sys.curves[nc + j];
        const i0 = coupledValue(curve, 0);
        if (!(Math.abs(i0) > 0)) return;
        const f = (u) => -Math.sign(i0) * valueAt(curve, u);
        end = Math.min(end, firstRoot(f, t, sampleTimes(t, runTo, sys.scale.fast))); // prettier-ignore
      });
      tEnd = Math.min(Math.max(tEnd, end), limit);
    }
    const own = { tEnd, scale: sys.scale, pieces: corner.now, recent: [corner.now, ...recent.filter((p) => p !== corner.now)].slice(0, RECENT_PIECES), run, ...(nw && tEnd >= limit ? { byWave: true } : {}) }; // prettier-ignore
    nets.forEach((net, i) => {
      nodes.set(net, { driven: null, curve: { ...sys.curves[i], ...own } });
    });
    waves.forEach((net, k) => {
      nodes.set(net, { driven: null, curve: { ...sys.curves[nc + k], ...own } }); // prettier-ignore
    });
    group.forEach((l, j) => {
      coils.set(l.id, { ...sys.curves[nc + nw + j], ...own });
    });
  };

  /** A group's free common modes (`modes`: its capacitance's null space —
      the plates of a lone capacitor) moved to where their networks balance:
      no current into any set of plates its capacitors join to nothing
      fixed, the voltage across each capacitor kept. Solved on the TRUE
      networks, mode by mode (the current into a set of plates falls as they
      rise): bracketed, then Illinois. On a linear piece's guess, a common
      mode can land past a corner — a stage saturating, a clamp — where that
      piece no longer holds, and step straight back. */
  const balance = (nets, modes, v0, rc, amps) => {
    let v = Float64Array.from(v0);
    const at = new Map(rc);
    const into = (mode, z) => {
      nets.forEach((net, i) => at.set(net, v[i] + z * mode[i]));
      const cur = volt.currentsAt(nets, at, amps);
      let sum = 0;
      for (let i = 0; i < nets.length; i++) sum += mode[i] * cur[i];
      return sum;
    };
    const sweeps = modes.length > 1 ? 4 : 1;
    for (let sweep = 0; sweep < sweeps; sweep++) {
      for (const mode of modes) {
        let a = 0;
        let fa = into(mode, a);
        if (fa === 0) continue;
        // Out from where it stands, the way the current pushes, doubling.
        let b = a;
        let fb = fa;
        let step = Math.sign(fa) * BALANCE_STEP_V;
        for (let k = 0; k < 60 && Math.sign(fb) === Math.sign(fa); k++) {
          a = b;
          fa = fb;
          b += step;
          fb = into(mode, b);
          step *= 2;
        }
        if (Math.sign(fb) === Math.sign(fa)) continue;
        // Illinois.
        let side = 0;
        let z = b;
        for (let k = 0; k < 100 && Math.abs(b - a) > BALANCE_V; k++) {
          z = (a * fb - b * fa) / (fb - fa);
          const fz = into(mode, z);
          if (fz === 0) break;
          if (Math.sign(fz) === Math.sign(fb)) {
            b = z;
            fb = fz;
            if (side === -1) fa /= 2;
            side = -1;
          } else {
            a = z;
            fa = fz;
            if (side === 1) fb /= 2;
            side = 1;
          }
        }
        v = v.map((x, i) => x + z * mode[i]);
      }
    }
    return v;
  };

  /** When a group's coupled curves first reach a corner (`tEnd`) — any of
      their networks changing piece (spice/voltages.js `linearizeNodes`'
      `piecesAt`), sampled over its time constants and bisected — or
      Infinity where none does; and the pieces they start on (`now`). A
      network with no pieces at all (`linear`) has no corner to search for —
      a wave through an RC spent most of its tick sampling one. */
  const groupCorner = (sys, model, t, limit = Number.POSITIVE_INFINITY) => {
    const piecesAt = (u) =>
      model.piecesAt(Float64Array.from(sys.curves, (curve) => coupledValue(curve, Math.max(0, u - t)))); // prettier-ignore
    const now = piecesAt(t);
    if (model.linear) return { tEnd: limit, now };
    const slow = sys.scale.slow;
    const end = Math.min(limit, t + (Number.isFinite(slow) && slow > 0 ? 50 * slow : 86400)); // prettier-ignore
    const tEnd = firstRoot((u) => (piecesAt(u) === now ? -1 : 1), t, sampleTimes(t, end, sys.scale.fast)); // prettier-ignore
    return { tEnd: Math.min(tEnd, limit), now };
  };

  /** Each listener's reading, stated again as the node curves it moves with
      (spice/voltages.js `affine`) — what every crossing is timed off. */
  const restate = (t) => {
    const at = new Map();
    const dirs = new Map();
    for (const [net, node] of nodes) {
      at.set(net, voltsOf(node, t));
      if (node.curve) dirs.set(net, heading(node.curve, t));
    }
    for (const [id, curve] of coils)
      dirs.set(`${COIL}${id}`, heading(curve, t));
    const watch = [...heard.watch].filter((net) => !s.candidates.has(net) && !paused(net)); // prettier-ignore
    const signals = volt.affine(watch, at, dirs, ampsAt(t));
    const signalOf = (net) =>
      s.candidates.has(net)
        ? nodes.has(net)
          ? { c0: 0, terms: new Map([[net, 1]]) }
          : null
        : (signals.get(net) ?? null);
    const kept = diffs;
    diffs = new Map();
    for (const l of heard.list) {
      // (An island this tick is not for keeps its statements: its curves
      // stand.)
      const diff = paused(l.net) ? kept.get(l.key) : differenceOf(l, signalOf); // prettier-ignore
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
    const fresh = [...s.candidates.keys()].filter((net) => !nodes.has(net));
    for (const [net, v0] of chargedNets(fresh, t)) {
      nodes.set(net, { driven: null, curve: { t0: t, v0, vInf: v0, tau: Number.POSITIVE_INFINITY } }); // prettier-ignore
      added = true;
    }
    if (added) {
      const rc = new Map();
      for (const [net, node] of nodes) rc.set(net, rcOf(net, node, t));
      volt.setNodes(s.candidates, rc);
    }
    restate(t);
    detectFlips(t, true);
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

  /** Where nodes not yet seen start, together: each capacitor holds the
      voltage it was last left with (none at Run), so a node is where the
      charges between it and its far sides put it — and where a far side is
      another of them, the two are solved at once (`chargedTo`, one at a
      time, would start a plate where its partner's network holds it, its
      capacitor open). A group joined to nothing fixed by its capacitors
      (two plates of one) stands where the solve holds it, an attofarad's
      worth. */
  const chargedNets = (nets, t) => {
    const out = new Map();
    if (!nets.length) return out;
    const index = new Map(nets.map((net, i) => [net, i]));
    const n = nets.length;
    const a = nets.map(() => new Float64Array(n));
    const b = new Array(n).fill(0);
    nets.forEach((net, i) => {
      a[i][i] += 1e-18;
      b[i] += 1e-18 * (volt.voltOf(net) ?? 0);
      for (const { id, far, value } of s.candidates.get(net).caps) {
        const across = charge.get(id) ?? 0;
        const held = s.capPins.get(id)?.a === net ? across : -across;
        const j = index.get(far);
        if (j != null) {
          a[i][i] += value;
          a[i][j] -= value;
          b[i] += held * value;
          continue;
        }
        const v = voltsAt(far, t);
        if (v == null) continue;
        a[i][i] += value;
        b[i] += (v + held) * value;
      }
    });
    const x = gaussSolve(a, b);
    nets.forEach((net, i) => out.set(net, x ? x[i] : chargedTo(net, s.candidates.get(net), t))); // prettier-ignore
    return out;
  };

  /** Bring every listener's reading up to date with its voltage at `t` —
      on every island stepped now (`live`), or on `all` — and say on which
      islands one changed; count each flip at the tick's own moment against
      its net (a flip replayed while catching up is history, not evidence of
      a fast oscillator). */
  const flips = new Map();
  const countFlip = (net, at) => {
    if (at >= target) flips.set(net, (flips.get(net) ?? 0) + 1);
  };
  const detectFlips = (t, all = false) => {
    const hit = new Set();
    for (const l of heard?.list ?? []) {
      const diff = diffs.get(l.key);
      if (!diff) continue;
      const key = islandOf(l.net);
      if (!all && !live(key)) continue;
      const was = listen.get(l.key);
      const next = readingFor(l, differenceAt(diff, t, curveOf), was, FLIP_EPS);
      if (next === was) continue;
      listen.set(l.key, next);
      hit.add(key);
      if (was !== undefined) countFlip(l.net, t);
    }
    return hit;
  };

  /** A listener whose own net is NO node — a pin a resistor or more away in
      a node's network — re-read from the voltage the pass under way solved
      it at, so what a DRIVER on that net does in the middle of a settle
      reaches the pin at once (between settles its crossings are
      nextCrossing's, exactly as before). Without it the pin read only the
      node: a gate whose input sits on its neighbour's output, in a
      capacitor's network, saw that neighbour switch only at the next event —
      and the two-gate RC oscillator flipped every two quanta and never ran.
      A pin ON a node is left alone: within a settle a node stands still. So
      is every pin until the settle's first solve: the voltage before it is
      the last settle's, with the nodes where they stood then — read at a
      crossing, it undid the crossing it was called for.
      And so is one whose solved voltage is still what the nodes alone make
      it (its statement, `diffs`): there its reading is its crossings', and
      at the very moment of one the solve sits ON the trip point, a hair to
      either side — re-read there, it undid the crossing and chattered. */
  const rereadListener = (key) => {
    const l = listenerOf.get(key);
    if (!l || !solvedYet || s?.candidates.has(l.net)) return;
    const v = voltsAt(l.net, settleTime);
    const ref = l.ref == null ? 0 : voltsAt(l.ref, settleTime);
    if (v == null || ref == null) return;
    const diff = diffs.get(key);
    if (diff && Math.abs(v - ref - differenceAt(diff, settleTime, curveOf)) <= DRIVER_EPS) return; // prettier-ignore
    const was = listen.get(key);
    const next = readingFor(l, v - ref, was, FLIP_EPS);
    if (next !== was) listen.set(key, next);
  };

  /** The earliest crossing still ahead of `t` on the islands `keep` keeps
      (by default those stepped now): its time and every listener that
      crosses then — `key` null for a curve reaching its next corner — each
      with its `island`, or null. */
  const nextCrossing = (t, keep = live) => {
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
      if (node.driven != null) continue;
      const island = islandOf(net);
      if (!keep(island)) continue;
      let when;
      if (isCoupled(node.curve)) {
        // A coupled group's corner is a moment, the same for all of it.
        when = node.curve.tEnd ?? Number.POSITIVE_INFINITY;
        if (!Number.isFinite(when)) continue;
      } else {
        if (node.curve.until == null) continue;
        when = t + crossingTime(node.curve, t, node.curve.until);
      }
      cornerOf.set(net, when);
      consider(when, { net, key: null, island });
    }
    for (const [id, curve] of coils) {
      const island = isl?.coilIsland.get(id) ?? null;
      if (!keep(island)) continue;
      const when = curve.tEnd ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(when)) continue;
      cornerOf.set(`${COIL}${id}`, when);
      consider(when, { net: null, key: null, island });
    }
    // A relay's coil current reaching the point its contacts move at.
    for (const [id, relay] of relays) {
      const curve = coils.get(id);
      if (!curve) continue;
      const island = isl?.coilIsland.get(id) ?? isl?.chipIsland.get(id) ?? null; // prettier-ignore
      if (!keep(island)) continue;
      const on = relayOn.get(id) === true;
      const amps = (on ? relay.dropOut : relay.pullIn) * relay.rated;
      const now = valueAt(curve, t);
      const when = on
        ? t + crossingTime(curve, t, Math.sign(now || 1) * amps)
        : t + Math.min(crossingTime(curve, t, amps), crossingTime(curve, t, -amps)); // prettier-ignore
      // Past its corner the curve is another one: asked again there.
      if (when <= (curve.tEnd ?? Number.POSITIVE_INFINITY)) consider(when, { net: null, key: `${RELAY}${id}`, island }); // prettier-ignore
    }
    for (const l of heard?.list ?? []) {
      const diff = diffs.get(l.key);
      const above = listen.get(l.key);
      if (!diff || above === undefined) continue;
      const island = islandOf(l.net);
      if (!keep(island)) continue;
      let horizon = Number.POSITIVE_INFINITY;
      for (const node of diff.terms.keys()) {
        horizon = Math.min(horizon, cornerOf.get(node) ?? Number.POSITIVE_INFINITY); // prettier-ignore
      }
      const when = above
        ? firstCrossing(diff, l.down, -1, t, nodeAt, horizon, FLIP_EPS)
        : firstCrossing(diff, l.up, 1, t, nodeAt, horizon, FLIP_EPS);
      consider(when, { net: l.net, key: l.key, island });
    }
    return Number.isFinite(at) ? { at, who } : null;
  };

  // A late tick catches up from where the last one left off — but only when
  // there is a curve to catch up on (otherwise it is simply at `now`), and
  // only on an island that neither found an oscillator faster than the desk
  // (its history is crossings nobody will see, and replaying them would only
  // spend the catch-up budget every tick) nor chattered lately (the quiet
  // ticks between two capped ones replayed the very chatter the back-off was
  // skipping). No island left to catch up, the tick is simply at `now`. (The
  // islands here are the last tick's: this one has built no context yet.)
  const catchesUp = () => {
    const keys = prior?.islands?.analog;
    if (!keys) return true;
    return keys.some((k) => !drawn.has(k) && !chatters.some((c) => c.key === k)); // prettier-ignore
  };
  let t =
    (nodes.size || coils.size) && prior?.time != null && prior.time < target && catchesUp() // prettier-ignore
      ? prior.time
      : target;
  // And never from BEFORE where the last one left off: a settle runs on past
  // the moment it began by its passes' gate delays, so a slow gate (a delay
  // edited to milliseconds) can end a tick after the next one's `now`.
  // Started back at `now`, every curve would be read before its own anchor —
  // where it stands still — and every node froze.
  if (!drawn.size && prior?.time != null && prior.time > t) t = prior.time;
  let warm = opts.warmStart;
  let state = opts.state;
  let prev = opts.prevPinLevels;
  // Whether `warm`, `state` and `prev` are copies a replay may write into
  // (`replaySeg`), and whether the board's last word was a settle's (the
  // result the tick returns is the last settle's).
  let replayOwns = false;
  let settledLast = true;
  // The digital settle's work as the last settle left it — this tick's, or
  // the last tick's (sim/incremental.js `warmStartOf`) — and how every pin
  // read when it ended: the listeners, the relays, the view
  // (`hooks.warmDirty`); the chips whose outputs a replay put back since
  // (`replaySeg`); and the chips whose voltage readings moved after the last
  // tick's last settle.
  let digitalWarm = prior?.warm ?? null;
  let settledAt = prior?.settledAt ?? null;
  let drivenMoved = new Set();
  let readMoved = prior?.reread ?? null;
  let cyclesMoved = false; // a cycle began or ended this tick
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
    // Each free-running clock's half-period and last edge (spice/waves.js):
    // where its wave is between edges.
    clockTimes: opts.clockTimes ?? new Map(),
  };
  const before = prior?.inputs?.clockTimes ? prior.inputs : { ...(prior?.inputs ?? own), clockTimes: own.clockTimes }; // prettier-ignore
  due = dueIslands();
  if (opts.stats && due)
    opts.stats.scopedTicks = (opts.stats.scopedTicks ?? 0) + 1;
  /** The edges a timing part's readout is measured from, as its outputs
      stand at `at` (spice/measure.js). */
  const noteReadouts = (at) => {
    for (const c of lastCtx.chips) {
      const readout = c.def.logic?.readout;
      if (!readout) continue;
      const out = driven.get(c.comp.id);
      // (On a drawn cycle's island, in the schedule's time.)
      const scale = !drawn.size ? 1 : oneIsland() ? drawn.values().next().value.cycle.scale : (drawn.get(isl.chipIsland.get(c.comp.id))?.cycle.scale ?? 1); // prettier-ignore
      for (const { pin } of readout) {
        noteLevel(marks, readerKey(c.comp.id, pin), out?.get(pin), at, scale); // prettier-ignore
      }
    }
  };
  /** One digital tick at `at` on the current view, its state kept. */
  const settleAt = (at) => {
    if (opts.stats) opts.stats.settles = (opts.stats.settles ?? 0) + 1;
    // The last settle's last pass is its own: folded before this one starts
    // (a fold of nothing after it changes nothing), so `settlePeak` is this
    // settle's alone (a drawn cycle's replay books it — `replaySeg`).
    foldSpikes();
    settlePeak = new Map();
    passes = 0;
    settleTime = at;
    syncRelays(at);
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
      warm: digitalWarm,
      // (Only the chips on the islands this tick is for are stepped.)
      scope: due ? inScope : null,
    });
    // The work its last solve ended with, for the next settle's first
    // (features/08), and how every pin read at its end (`warmDirty`).
    digitalWarm = result.warm;
    delete result.warm;
    settledAt = { listen: new Map(listen), relays: new Map(relayOn), view };
    drivenMoved = new Set();
    lastAt = at;
    foldSpikes();
    noteReadouts(at);
    memWrites.push(...(result.memWrites ?? []));
    unapplied.push(...(result.memWrites ?? []));
    warm = result.netLevels;
    state = result.state;
    prev = result.pinLevels;
    replayOwns = false;
    settledLast = true;
  };
  /**
   * Whether this tick's first settle — a late tick's replay of the last
   * tick's own final moment, on that tick's inputs — could change nothing
   * (features/05-skip-replay-settle.md): the last tick ended RESTED (settled,
   * nothing capped, resettling, chattering, holding or written, no memory on
   * the desk, no cycle drawn), on this very desk. Whatever the bench does at
   * THIS tick's moment (a clock edge, a signal) is no part of the replay: it
   * runs on the last tick's inputs (`before`), the very ones that tick ended
   * on. (A relay whose coil reached a threshold in between asks for the
   * settle.) Such a settle runs one pass
   * and hands back the levels, state and pins it was given
   * (`SPICE_ASSERT_REPLAY` runs it anyway and holds it to that). Its
   * passes are taken as one; now and then it would have run two (a voltage
   * solve settling its last digits), and events move by that gate delay
   * (features/spice-perf/RESULTS.md, step 05).
   */
  const quietReplay = () => {
    if (lastAt != null || !prior?.rested || prior.time !== t || t >= target || drawn.size) return false; // prettier-ignore
    if (prior.ran?.document !== opts.document || prior.ran?.netlist !== opts.netlist) return false; // prettier-ignore
    const relaysWere = new Map(relayOn);
    syncRelays(t);
    return relaysWere.size === relayOn.size && [...relaysWere].every(([id, on]) => relayOn.get(id) === on); // prettier-ignore
  };
  /** What settling at `at` does beside the digital tick, where that settle
      would change nothing (`quietReplay`): the moment, the relays, the
      bench's sources, the context (and everything the analog side builds on
      it) — and the one pass it takes, which still moves time on by a gate
      delay, exactly as the settle would. */
  const restAt = (at) => {
    foldSpikes();
    settlePeak = new Map();
    settleTime = at;
    syncRelays(at);
    volt.sources(before.clockPhase, before.signalLevels);
    hooks.context(contextOf({ ...opts, hooks }));
    passes = 1;
    lastAt = at;
  };
  /** `SPICE_ASSERT_REPLAY`: the settle `quietReplay` skips, run, changed
      no level, state or read pin. (Its passes may be two: a voltage solve
      still settling its last digits keeps a settle busy one pass more — the
      gate delay of time that skipping it moves events by, and the solve it
      leaves to the next settle, are the step's bounded shift.) */
  const assertQuietReplay = (was) => {
    if (opts.stats) opts.stats.replayPasses = (opts.stats.replayPasses ?? 0) + (passes !== 1 ? 1 : 0); // prettier-ignore
    const fail = (what) => {
      throw new Error(`SPICE_ASSERT_REPLAY: a skipped replay settle would have changed ${what}`); // prettier-ignore
    };
    const same = (a, b, eq = (x, y) => x === y) =>
      a.size === b.size && [...a].every(([k, v]) => b.has(k) && eq(v, b.get(k))); // prettier-ignore
    if (!same(warm, was.warm)) fail("the levels");
    if (!same(state, was.state, sameData)) fail("the state");
    if (!same(prev, was.prev, (x, y) => same(x, y))) fail("the read pins");
  };
  // ── Fast oscillations (spice/cycles.js) ──────────────────────────────────
  // Island by island (spice/islands.js): what one island does is no part of
  // another's moment.
  //
  // What the chips on an island's nodes' networks drive there and read
  // anywhere, and every supply's volts: half of a moment's signature, and
  // what a schedule checks it still drives (a RESET raised on an oscillator
  // is a read) — `key`. And `volts`: every net a listener reads, or reads
  // AGAINST, that stands outside the nodes' networks (a 555's CONT, which a
  // counter moves through a resistor): it moves nothing the cycle recorded,
  // yet it moves every trip point, so a schedule drawn on with it moved draws
  // the old frequency. Compared within a tolerance (spice/cycles.js
  // `sameDrive`).
  const driveSig = (island) => {
    const { clusterOf } = volt.topology();
    const ks = new Set();
    for (const net of nodes.keys()) {
      if (!onIsland(net, island)) continue;
      const k = clusterOf.get(net);
      if (k != null) ks.add(k);
    }
    const onNodes = (net) => net && ((nodes.has(net) && onIsland(net, island)) || ks.has(clusterOf.get(net))); // prettier-ignore
    const parts = [];
    for (const c of lastCtx?.chips ?? []) {
      if (![...c.pinNet.values()].some(onNodes)) continue;
      parts.push(`${c.comp.id}:${c.status}`);
      const read = prev?.get(c.comp.id);
      for (const p of c.def.pins) {
        if (LISTENING.has(p.role)) parts.push(`${c.comp.id}<${p.n}=${read?.get(p.n)}`); // prettier-ignore
      }
      for (const [pin, level] of driven.get(c.comp.id) ?? []) {
        if (onNodes(c.pinNet.get(pin))) parts.push(`${c.comp.id}#${pin}=${level}`); // prettier-ignore
      }
    }
    for (const [id, d] of delivered) parts.push(`${id}=${d.volts}`);
    const volts = [];
    for (const net of [...(heard?.watch ?? [])].sort()) {
      if (onNodes(net) || !onIsland(net, island)) continue;
      volts.push([net, volt.voltOfNet(net)]);
    }
    return { key: parts.join(","), volts };
  };
  /** Island `key`'s part of a map (every entry, on a desk of one island) —
      and the entries on no island known, which every island keeps. */
  const partOf = (map, key, keyIsland) => {
    if (oneIsland()) return new Map(map);
    const out = new Map();
    for (const [k, v] of map) {
      const i = keyIsland(k);
      if (i == null || i === key) out.set(k, v);
    }
    return out;
  };
  /** Island `key`'s part of a map replaced by `entries` (`partOf`'s). */
  const replacePart = (map, key, keyIsland, entries) => {
    const kept = [];
    if (!oneIsland()) {
      for (const [k, v] of map) {
        const i = keyIsland(k);
        if (i != null && i !== key) kept.push([k, v]);
      }
    }
    map.clear();
    for (const [k, v] of kept) map.set(k, v);
    for (const [k, v] of entries) map.set(k, v);
  };
  const listenIsland = (k) => islandOf(listenerOf.get(k)?.net);
  const capFarIsland = (k) => islandOf(k.slice(k.indexOf("@") + 1));
  // The moments after each crossing (and each corner) this tick, each
  // island's, for a cycle to be recognised in — its OWN: a moment another
  // island's crossing settled at is no moment of this one's cycle (it would
  // only add segments to its schedule). `touched`: the islands something
  // happened on since the last moment recorded (null: every one — the
  // tick's first moment, its own after catching up).
  const timelines = new Map(); // island → its moments
  let touched = null;
  /** Record the moment on each island stepped now that `keys` names (null:
      every one; on a desk of one island, always it). Returns the islands
      recorded. */
  const record = (crossing, keys = touched) => {
    const out = [];
    if (!heard?.list.length || !nodes.size) return out;
    for (const key of isl?.analog ?? []) {
      if (!live(key)) continue;
      if (keys && !keys.has(key) && !oneIsland()) continue;
      // A cycle's signature says nothing of an inductor's current: with one
      // moving, the island is never taken to have come round.
      if (oneIsland() ? coils.size : [...coils.keys()].some((id) => isl.coilIsland.get(id) === key)) continue; // prettier-ignore
      const own = partOf(nodes, key, islandOf);
      if (!oneIsland() && (!own.size || !heard.list.some((l) => islandOf(l.net) === key))) continue; // prettier-ignore
      const ownListen = partOf(listen, key, listenIsland);
      const drive = driveSig(key);
      if (!timelines.has(key)) timelines.set(key, []);
      const timeline = timelines.get(key);
      timeline.push({
        t,
        crossing,
        sig: signatureOf(own, (n) => voltsOf(n, t), ownListen, drive),
        listen: ownListen,
        nodes: own,
        capFar: partOf(capFar, key, capFarIsland),
        drive,
      });
      if (timeline.length > MAX_TIMELINE) timeline.shift();
      out.push(key);
    }
    return out;
  };
  /** Forget the readout edges timed on island `key` (spice/measure.js) —
      and those of a part on no analog island (every one, on a desk of one
      island). */
  const clearMarks = (key) => {
    if (oneIsland()) return marks.clear();
    for (const k of [...marks.keys()]) {
      const i = isl.chipIsland.get(k.slice(0, k.lastIndexOf("#")));
      if (i == null || i === key || !isl.analogSet.has(i)) marks.delete(k);
    }
  };
  /** Draw island `key`'s cycle from its timeline moment `j` to now by its
      schedule. */
  const enterCycle = (key, j) => {
    const timeline = timelines.get(key);
    const next = scheduleOf(timeline, j, timeline.length - 1, t, TIMING_CAP_HZ); // prettier-ignore
    // The listeners the cycle moves — what a counting part is told about.
    const moving = new Set();
    for (const seg of next.segs) {
      for (const [k, v] of seg.listen) {
        if (next.segs[0].listen.get(k) !== v) moving.add(k);
      }
    }
    const pins = new Map();
    for (const l of heard.list) {
      if (!moving.has(l.key)) continue;
      if (!pins.has(l.comp)) pins.set(l.comp, []);
      pins.get(l.comp).push(l.pin);
    }
    const cycle = { ...next, pins, netlist: opts.netlist, document: opts.document, scope: cycleScope(key) }; // prettier-ignore
    // It stands at its first segment's start.
    drawn.set(key, { cycle, done: 0, memo: null, memoOwned: false, steady: 0 }); // prettier-ignore
    cyclesMoved = true;
    clearMarks(key); // measured again, in the schedule's time
  };
  /** Island `key`'s cycle ended — something outside it changed: its nodes
      run on from where its schedule stood. */
  const endCycle = (key) => {
    drawn.delete(key);
    cyclesMoved = true;
    clearMarks(key);
    timelines.delete(key);
  };
  /** Stand island `key`'s nodes and listeners where segment `seg` has them
      at its own clock's `trueAt`, shown at `at`. */
  const applySeg = (key, seg, trueAt, at) => {
    replacePart(listen, key, listenIsland, seg.listen);
    const own = new Map();
    for (const [net, node] of seg.nodes) {
      if (node.driven != null) {
        own.set(net, node);
        continue;
      }
      const v = valueAt(node.curve, trueAt);
      own.set(net, { driven: null, curve: { t0: at, v0: v, vInf: v, tau: Number.POSITIVE_INFINITY } }); // prettier-ignore
    }
    replacePart(nodes, key, islandOf, own);
    replacePart(capFar, key, capFarIsland, seg.capFar);
    if (s) {
      const rc = new Map();
      for (const [net, node] of nodes) rc.set(net, rcOf(net, node, at));
      volt.setNodes(s.candidates, rc);
    }
    if (heard) view = computeView(at);
  };
  /**
   * What island `key`'s drawn cycle's segments may be REPLAYED over
   * (features/02-cycle-replay.md): its chips — every one on the nodes'
   * networks, as the drive signature counts them — and every net their pins
   * are on, rails aside. Null when a segment must always be settled: a
   * memory chip on the desk (each settle reports its writes), or a CONSUMER
   * — any other chip with an input on one of those nets, or anywhere in a
   * voltage cluster one of them is in (it would act on what the cycle
   * drives, and only a settle says how).
   */
  const cycleScope = (key) => {
    // (`spice.replay: false` settles every segment, as before replay was —
    // the reference tests/spice-cycle-replay.test.js holds it to.)
    if (spice?.replay === false) return null;
    if (!lastCtx || lastCtx.chips.some((c) => c.memory)) return null;
    const { clusterOf, clusters } = volt.topology();
    const ks = new Set();
    for (const net of nodes.keys()) {
      if (!onIsland(net, key)) continue;
      const k = clusterOf.get(net);
      if (k != null) ks.add(k);
    }
    const onNodes = (net) => net && ((nodes.has(net) && onIsland(net, key)) || ks.has(clusterOf.get(net))); // prettier-ignore
    const chips = new Set();
    const nets = new Set();
    for (const c of lastCtx.chips) {
      if (![...c.pinNet.values()].some(onNodes)) continue;
      chips.add(c.comp.id);
      for (const net of c.pinNet.values()) {
        if (net && !s.trace.rail(net)) nets.add(net);
      }
    }
    const reach = new Set(nets);
    for (const net of nets) {
      const k = clusterOf.get(net);
      for (const other of k == null ? [] : clusters[k].nets) reach.add(other);
    }
    for (const c of lastCtx.chips) {
      if (chips.has(c.comp.id)) continue;
      for (const p of c.def.pins) {
        if (LISTENING.has(p.role) && reach.has(c.pinNet.get(p.n))) return null;
      }
    }
    return { chips: [...chips], nets: [...nets] };
  };
  const sameMap = (a, b) => {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const [k, v] of a) if (!sameData(v, b.get(k))) return false;
    return true;
  };
  /** A cycle's part of the board as a settle finds it: its nets' levels,
      its chips' state, read pins, driven outputs and held outputs. (A clock
      or a signal reaches its chips only through those nets — a segment's
      settle runs on the inputs the last tick's own settle ran on, and its
      levels already say what they drive.) */
  const segmentState = (st) => {
    const { chips, nets } = st.cycle.scope;
    return {
      levels: nets.map((net) => warm.get(net)),
      state: chips.map((id) => state.get(id)),
      pins: chips.map((id) => prev.get(id)),
      driven: chips.map((id) => driven.get(id)),
      committed: chips.map((id) => committed.get(id)),
    };
  };
  const sameSegmentState = (a, b) =>
    a.levels.every((lv, i) => lv === b.levels[i]) &&
    a.state.every((st, i) => sameData(st, b.state[i])) &&
    a.pins.every((m, i) => sameMap(m, b.pins[i])) &&
    a.driven.every((m, i) => sameMap(m, b.driven[i])) &&
    a.committed.every((m, i) => sameMap(m, b.committed[i]));
  /**
   * Island `key`'s segment `i` at `at` from what settling it did before,
   * instead of settling it — when the cycle's part of the board stands
   * exactly where it stood then (nothing else on the desk reads it:
   * `cycleScope`), so the settle could only do it again. Its nets, state,
   * pins, outputs and holds are put back, its readouts noted, its spikes
   * booked; then the drive it shows is checked as a settle's is. False
   * (nothing changed) where there is no such record or any of that fails —
   * the segment is then settled.
   */
  const replaySeg = (key, st, i, at) => {
    const m = st.memo?.[i];
    // (Never before this tick's first settle: the board's context — its
    // chips, the voltage topology the drive is read through — is the
    // settle's to build.)
    // (Recorded at another pace — the cycle's island ticked together with
    // another, or apart: its holds are others — a record is no answer.)
    if (!m || !st.cycle.scope || !lastCtx || m.quantum !== pace().quantum) return false; // prettier-ignore
    if (!sameSegmentState(segmentState(st), m.pre)) return false;
    const { chips, nets } = st.cycle.scope;
    // The board's maps are a settle's (or the caller's): copied once after
    // each settle, then put back into in place.
    if (!replayOwns) {
      warm = new Map(warm);
      state = new Map(state);
      prev = new Map(prev);
      replayOwns = true;
    }
    const was = segmentState(st);
    const put = (map, id, v) => (v === undefined ? map.delete(id) : map.set(id, v)); // prettier-ignore
    nets.forEach((net, k) => warm.set(net, m.post.levels[k]));
    chips.forEach((id, k) => {
      put(state, id, m.post.state[k]);
      put(prev, id, m.post.pins[k]);
      put(driven, id, m.post.driven[k]);
      put(committed, id, m.post.committed[k]);
      drivenMoved.add(id);
    });
    if (!sameDrive(driveSig(key), m.drive, s.vHigh)) {
      nets.forEach((net, k) => put(warm, net, was.levels[k]));
      chips.forEach((id, k) => {
        put(state, id, was.state[k]);
        put(prev, id, was.pins[k]);
        put(driven, id, was.driven[k]);
        put(committed, id, was.committed[k]);
      });
      return false;
    }
    if (opts.stats) opts.stats.replays = (opts.stats.replays ?? 0) + 1;
    settleTime = at;
    lastAt = at;
    settledLast = false;
    for (const [psu, amps] of m.spikes) {
      spikePeak.set(psu, Math.max(spikePeak.get(psu) ?? 0, amps));
    }
    noteReadouts(at);
    return true;
  };
  /** Settle island `key`'s segment `i` at `at`, and keep what it did for
      `replaySeg`. `{ok}` — it still drives what the cycle recorded — and
      `{same}`: it did exactly what its record says (which counts toward a
      steady cycle as a replay does). */
  const settleSeg = (key, st, i, at, seg) => {
    const pre = st.cycle.scope ? segmentState(st) : null;
    settleAt(at);
    const drive = driveSig(key);
    const ok = sameDrive(drive, seg.drive, s.vHigh);
    let same = false;
    if (pre && ok && result.settled && !result.memWrites?.length) {
      const post = segmentState(st);
      const m = st.memo?.[i];
      same = Boolean(m) && m.quantum === pace().quantum && sameSegmentState(pre, m.pre) && sameSegmentState(post, m.post) && sameDrive(drive, m.drive, s.vHigh); // prettier-ignore
      if (!same) {
        if (!st.memoOwned) {
          st.memo = st.memo ? st.memo.slice() : new Array(st.cycle.segs.length); // prettier-ignore
          st.memoOwned = true;
        }
        st.memo[i] = { pre, post, drive, spikes: new Map(settlePeak), quantum: pace().quantum }; // prettier-ignore
      }
    }
    return { ok, same };
  };
  /** The segments of island `st`'s schedule this tick still has to walk:
      every one the shown wave has begun since the last tick, from `from` to
      `p.abs` (`p` where it stands at the tick's own moment) — at most one
      whole cycle (a later tick skips the rest). A steady cycle wakes once a
      frame, not once a segment (`wakeAt`): over a cycle of it is walked, so
      a readout still times a rise from the one before it (spice/measure.js)
      — replayed, the segments cost next to nothing. */
  const walkOf = (st) => {
    const p = cycleAt(st.cycle, target);
    const n = st.cycle.segs.length;
    let from = Math.max(st.done + 1, p.abs - n + 1);
    if (steadyFramed(st)) {
      // Skipping whole cycles, the walk takes up at the segment after the
      // last one shown (the board stands where IT left it), at least TWO
      // cycles back from now: a readout's period runs from one rise to the
      // one before it, and a walk of one cycle and a bit holds a second rise
      // only in some phases — in the rest the period ran back to the last
      // tick's rise, a frame away (features/04: a 48 kHz 555's readout read
      // 33× its period on one tick in three).
      from = st.done + 1;
      if (from < p.abs - 3 * n + 1) from += n * Math.ceil((p.abs - 3 * n + 1 - from) / n); // prettier-ignore
    }
    return { from, p };
  };
  /** Island `key`'s schedule into its segment `a`, at `at`: put back from
      its record where it can be (`replaySeg`), else settled there. `{ok}`
      false where it no longer drives what it recorded; `{replayed}`. */
  const stepSeg = (key, st, a, at) => {
    const n = st.cycle.segs.length;
    const q = segmentAt(st.cycle, a);
    applySeg(key, q.seg, q.seg.t, at);
    st.done = a;
    if (replaySeg(key, st, a % n, at)) {
      st.steady += 1;
      return { ok: true, replayed: true };
    }
    const { ok, same } = settleSeg(key, st, a % n, at, q.seg);
    st.steady = same ? st.steady + 1 : 0;
    return { ok, replayed: false };
  };
  /** Draw every schedule up to `target` — EVERY analog island drawn (or
      done for this tick): each segment the shown waves have begun since the
      last tick, in time order, each at the moment it begins, then the
      moment itself. The islands whose cycle no longer drives what it
      recorded — at a segment (`t` is then that segment's moment, and its
      nodes run on from it), or at the tick's own moment. */
  const runCycles = () => {
    const walk = [];
    const ps = new Map();
    for (const [key, st] of drawn) {
      if (due && !due.has(key)) continue;
      const { from, p } = walkOf(st);
      ps.set(key, p);
      for (let a = from; a <= p.abs; a++) walk.push({ key, st, a, time: segmentAt(st.cycle, a).time }); // prettier-ignore
    }
    if (drawn.size > 1) walk.sort((x, y) => x.time - y.time || (x.key < y.key ? -1 : x.key > y.key ? 1 : x.a - y.a)); // prettier-ignore
    for (const { key, st, a, time } of walk) {
      t = Math.min(Math.max(time, lastAt ?? time), target);
      if (!stepSeg(key, st, a, t).ok) return [key];
    }
    t = target;
    for (const [key, p] of ps) applySeg(key, p.seg, p.at, t);
    settleAt(t);
    for (const key of ps.keys()) stood.add(key);
    return [...ps].filter(([key, p]) => !sameDrive(driveSig(key), p.seg.drive, s.vHigh)).map(([key]) => key); // prettier-ignore
  };
  // The drawn islands stood where their schedule has them at the tick's own
  // moment (`runCycles`, or — beside islands stepped crossing by crossing —
  // at the first settle there).
  const stood = new Set();
  /** The next segment a drawn island's schedule begins at or before the
      tick's own moment, beside islands stepped crossing by crossing: the
      earliest, `{key, st, a, time}`, or null. */
  const nextSeg = () => {
    let best = null;
    for (const [key, st] of drawn) {
      if (due && !due.has(key)) continue;
      const { from, p } = walkOf(st);
      if (from > p.abs) continue;
      const time = segmentAt(st.cycle, from).time;
      if (!best || time < best.time || (time === best.time && key < best.key)) best = { key, st, a: from, time }; // prettier-ignore
    }
    return best;
  };
  /** Islands whose shown levels differ between two views. */
  const viewChanges = (a, b) => {
    const out = new Set();
    for (const [net, level] of a) if (b.get(net) !== level) out.add(islandOf(net)); // prettier-ignore
    for (const net of b.keys()) if (!a.has(net)) out.add(islandOf(net));
    return out;
  };

  // Settles at the tick's own moment (MAX_ANALOG_EVENTS), and replaying a
  // late tick's history (MAX_CATCHUP_EVENTS) — each island's.
  const events = new Map();
  const caught = new Map();
  const bump = (map, key) => {
    const n = (map.get(key) ?? 0) + 1;
    map.set(key, n);
    return n;
  };
  let corners = 0; // curves linearized again at a corner (MAX_CORNERS)
  let pendingSeg = null; // a drawn island's segment, due now beside stepped ones

  outer: for (;;) {
    let settled = true; // this moment settled, stepped islands and all
    // Beside islands stepped crossing by crossing, a drawn island's segment
    // that begins at or before the moment reached comes first — at its own
    // moment, never one before the last settle's (the walk `runCycles`
    // takes, interleaved with the stepped islands' events).
    if (!pendingSeg && drawn.size && anySteps()) {
      const seg = nextSeg();
      if (seg && seg.time <= t) pendingSeg = seg;
    }
    if (
      drawn.size &&
      !anySteps() &&
      [...drawn.keys()].some((k) => !due || due.has(k))
    ) {
      // Every analog island drawn by its schedule, while each moment it
      // shows still drives what its cycle recorded.
      const failed = runCycles();
      if (!failed.length) break;
      // Something outside a cycle changed: its nodes run on from here.
      for (const key of failed) endCycle(key);
      touched = null;
    } else if (pendingSeg) {
      // A drawn island's segment, beside islands stepped crossing by
      // crossing: nothing the islands stepped read moves at it (they cannot
      // see it), so they are not re-read — only an island whose cycle no
      // longer drives what it recorded runs on from here.
      const { key, st, a, time } = pendingSeg;
      pendingSeg = null;
      const step = stepSeg(key, st, a, Math.min(Math.max(time, lastAt ?? time), Math.max(t, time))); // prettier-ignore
      if (step.ok) settled = false;
      else {
        endCycle(key);
        t = Math.max(t, lastAt);
      }
    } else {
      // At the tick's own moment a drawn island stands where its schedule
      // has it then — and is checked to drive what it recorded.
      const standing = [];
      if (drawn.size && t >= target) {
        for (const [key, st] of drawn) {
          if (stood.has(key) || (due && !due.has(key))) continue;
          const { from, p } = walkOf(st);
          if (from <= p.abs) continue; // (its walk comes first)
          stood.add(key);
          applySeg(key, p.seg, p.at, t);
          standing.push([key, p]);
        }
      }
      if (s) {
        detectFlips(t);
        view = computeView(t);
      }
      const quiet = quietReplay();
      if (quiet && !ASSERT_REPLAY) restAt(t);
      else {
        const was = quiet ? { warm, state, prev } : null;
        settleAt(t);
        if (was) assertQuietReplay(was);
      }
      for (const [key, p] of standing) {
        if (!sameDrive(driveSig(key), p.seg.drive, s.vHigh)) endCycle(key);
      }
    }
    if (!s.candidates.size && !nodes.size && !(volt.topology()?.coils.length) && lastAt >= target) break; // prettier-ignore
    if (settled) {
      t += passes * pace().quantum * 1e-9;
      updateNodes(t, true);
      const hit = detectFlips(t);
      for (const key of viewChanges(view, computeView(t))) {
        if (live(key)) hit.add(key);
      }
      for (const key of hit) touched?.add(key);
      if (hit.size) {
        if (t < target) {
          // History: an island past its catch-up budget skips the rest of
          // it and waits for the tick's own moment — and with none left to
          // catch up, the tick jumps there (every reading is brought up to
          // date there, at the top of the loop).
          for (const key of hit) {
            if (bump(caught, key) >= MAX_CATCHUP_EVENTS) catchUp?.delete(key);
          }
          if (!anyLive()) {
            t = target;
            touched = null;
          }
          continue;
        }
        for (const key of hit) {
          if (bump(events, key) >= MAX_ANALOG_EVENTS) capped.add(key);
        }
        if (!anySteps()) break;
        if ([...hit].some((key) => !capped.has(key))) continue;
      }
      {
        // A moment just after a crossing: has an island come round?
        const recorded = record(true);
        touched = new Set();
        const entered = [];
        for (const key of recorded) {
          const from = cycleStart(timelines.get(key), TIMING_CAP_HZ, s.vHigh);
          if (from < 0) continue;
          enterCycle(key, from);
          entered.push(key);
        }
        // Every island drawn: the schedules draw the rest of the tick.
        if (entered.length && !anySteps()) continue;
        // Beside islands still stepped, one just drawn stands at its first
        // segment now.
        for (const key of entered) {
          const seg = drawn.get(key).cycle.segs[0];
          applySeg(key, seg, seg.t, t);
          if (t >= target) stood.add(key);
        }
      }
    }
    choose: for (;;) {
      let next = nextCrossing(t);
      // A curve reaching a corner (and nothing reading anything new there)
      // is linearized again where it is, with no settle: nothing changed
      // but the slope it runs at.
      const due = (n) =>
        n.at <= target || n.at - Math.max(t, target) <= FAST_WINDOW_S;
      while (next && due(next) && next.who.every((w) => w.key == null)) {
        if (++corners > MAX_CORNERS) break;
        t = Math.max(t, next.at);
        updateNodes(t, false);
        record(false, new Set(next.who.map((w) => w.island)));
        next = nextCrossing(t);
      }
      // A drawn island's segment that begins first comes first.
      const seg = drawn.size ? nextSeg() : null;
      if (seg && !(next && due(next) && next.at < seg.time)) {
        pendingSeg = seg;
        continue outer;
      }
      if (next && due(next)) {
        const keys = new Set(next.who.map((w) => w.island));
        if (next.at < target) {
          for (const key of keys) {
            if (bump(caught, key) >= MAX_CATCHUP_EVENTS) catchUp?.delete(key);
          }
          if (!anyLive()) {
            t = target;
            touched = null;
            continue outer;
          }
        } else {
          for (const key of keys) {
            if (bump(events, key) >= MAX_ANALOG_EVENTS) capped.add(key);
          }
          if (!anySteps()) break outer;
        }
        // (An island that just spent its budget crosses no more.)
        const who = next.who.filter((w) => live(w.island));
        if (!who.length) continue choose;
        t = Math.max(t, next.at);
        for (const w of who) touched?.add(w.island);
        for (const { net, key } of who) {
          if (key == null) continue; // a corner, linearized again by the settle
          if (key.startsWith(RELAY)) continue; // its settle reads its coil
          listen.set(key, !listen.get(key));
          countFlip(net, t);
        }
        continue outer;
      }
      if (lastAt < target || !settledLast) {
        // Caught up: the tick's own moment still has to be settled (and the
        // board a replay left is what it returns).
        t = Math.max(t, target);
        touched = null;
        continue outer;
      }
      break outer;
    }
  }

  // ── Current: supply droop, then fan-out ────────────────────────────────
  // The capacitors' voltages — the RC nodes' curves and the timed parts' own
  // — which the LED and supply readings take as given; and every voltage the
  // desk has, which the probe and the analyzer read.
  // The networks as the tick leaves its states: a corner moves a node or an
  // inductor with no settle after it, so whatever the last ones moved is
  // solved again here — or the probe reads the voltages from before them
  // for as long as the circuit then rests.
  // …the coils at the moment the tick leaves them, too: the voltages the
  // probe reads and the currents the tick reports must be one moment's.
  if (s && coils.size) volt.setCoils(ampsAt(t));
  if (s) volt.resolve();
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
    return { lamps, currents: rep.currents, draws: rep.draws, outputs: rep.outputs, stress: rep.stress, transistors: rep.transistors, switches: rep.switches, devices: rep.devices, brownouts: rep.brownouts, analog: rep.analog }; // prettier-ignore
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
  if (moved && drawn.size) {
    // A schedule records one supply's worth of cycle: the nodes run on.
    drawn.clear();
    cyclesMoved = true;
    marks.clear();
  }
  if (moved) {
    // The supply moved: settle once more on what it now delivers, so a chip
    // it has dropped out of range is underpowered on THIS tick — and again
    // while that changes what a node reads (a chip gone quiet no longer
    // drives its RC). Past RESETTLE_ROUNDS the next tick, soon, carries on.
    unsettled = true;
    resettling = true;
    for (let round = 0; round < RESETTLE_ROUNDS; round++) {
      view = computeView(t);
      settleAt(lastAt);
      t += passes * pace().quantum * 1e-9;
      updateNodes(t, true);
      // …and while a chip off the rails is still said to run at another
      // voltage than the one this settle left on its pins (its outputs came
      // on in it, and draw through its feed — a resistor-fed chip at Run).
      if (
        !detectFlips(t).size &&
        sameView(view, computeView(t)) &&
        !fedMoved()
      ) {
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
  // Each inductor's current as this tick leaves it.
  for (const [id, curve] of coils) coilAmps.set(id, valueAt(curve, t));
  for (const [id, away] of coilsAway) coilAmps.set(id, awayAmps(away, t));
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
  // The regulators and electronic loads: what each shows, what each warns,
  // and a regulator past its dissipation shut down from the next tick until
  // it has cooled.
  const bench = benchWarnings(lamps.analog, thermal, target);
  const { loads, warnings: loadWarnings, overloaded } = outputLoads(lamps);
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
  //     minimum sink guarantees) — the solve's brownout says it, or nothing
  //     does; both at once told the user two inputs were fine and a fault;
  //   · `marginal-high` (a 74LS output into a CD4000 input, no pull-up) and
  //     `mixed-supply` (chips on different supplies sharing a net) — every
  //     input READS the voltage now, so a HIGH that is no HIGH to it is
  //     undefined at that input, and an input pulled past its own supply
  //     says so (`input-clamp`, `input-overvoltage`).
  //   · a `short` THROUGH a transistor or switch (`via`) — the joins said a
  //     rail meets a rail; the solve says what flows, and it stands only as
  //     a short's current (`SHORT_AMPS`). A short with no `via` (two
  //     supplies on one net) is said as it is.
  const shortStands = viaShortMeter(lastCtx, result.channels, opts, lamps.currents, supplies); // prettier-ignore
  const warnings = [
    ...result.warnings.filter(
      (w) =>
        !RETIRED.has(w.type) &&
        !(w.type === "short" && w.via && !shortStands(w.net)),
    ),
    ...loadWarnings,
    ...stressWarnings,
    ...spikeWarnings,
    ...lampWarnings(lamps.lamps, burntNow),
    ...[...kicksNow].map(([comp, k]) => ({ type: "inductive-kick", comp, volts: k.volts, joules: k.joules })), // prettier-ignore
    ...bench.warnings,
  ];
  // A circuit stuck chattering waits MIN_SHOWN_S before it is looked at
  // again, then twice as long each time it is still stuck, up to
  // MAX_CAPPED_BACKOFF_S. "Still": capped again within CHATTER_MEMORY_S (or
  // four waits, if longer) — a chattering node runs quiet ticks between its
  // capped ones, and they wait too. Island by island: one island's chatter
  // holds back its own wakes, not a healthy island's crossings.
  const analogNow = isl?.analog ?? [];
  const chatterNow = new Map(); // island → {at, backoff}
  for (const key of analogNow) {
    const was = chatterOf(key);
    const recent = was && target - was.at <= Math.max(CHATTER_MEMORY_S, 4 * was.backoff) ? was : null; // prettier-ignore
    const c = capped.has(key)
      ? { at: target, backoff: recent ? Math.min(MAX_CAPPED_BACKOFF_S, 2 * recent.backoff) : MIN_SHOWN_S } // prettier-ignore
      : recent && { at: recent.at, backoff: recent.backoff };
    if (c) chatterNow.set(key, c);
  }
  const chatterAll = analogNow.length > 0 && analogNow.every((k) => chatterNow.has(k)); // prettier-ignore
  let wakeAt = result.wakeAt ?? null;
  let frameAt = null;
  const later = (at) => {
    if (at == null || !Number.isFinite(at)) return;
    wakeAt = wakeAt == null ? at : Math.min(wakeAt, at);
  };
  // A regulator shut down comes back on once it has cooled; one just
  // tripped goes off at once.
  for (const until of thermal.values()) later(until);
  if (bench.tripped) later(target + TRIP_S);
  // Each analog island's own next event (features/12): what the next tick
  // reads to know which islands it is for. An island this tick was not for
  // keeps the one it had — nothing on it moved.
  const islandNext = new Map();
  const scheduled = !UNSCOPED && spice?.scoped !== false && isl != null && isl.groupOf.size > 1; // prettier-ignore
  if (s && (s.candidates.size || nodes.size || coils.size) && scheduled) {
    for (const key of analogNow) {
      if (due && !due.has(key)) {
        const was = prior.islandNext?.get(key);
        if (was != null) islandNext.set(key, was);
        later(was);
        continue;
      }
      const c = chatterNow.get(key);
      const st = drawn.get(key);
      let at;
      if (st) {
        // A steady cycle nothing records is drawn a display frame at a time.
        const next = cycleAt(st.cycle, target).next;
        at = steadyFramed(st) ? Math.max(next, target + ANALOG_FRAME_S) : next; // prettier-ignore
        if (c) at = Math.max(at, target + c.backoff);
      } else {
        if (c && capped.has(key)) {
          const nets = [...flips].filter(([net, n]) => n >= 3 && islandOf(net) === key).map(([net]) => net); // prettier-ignore
          if (nets.length) warnings.push({ type: "oscillation", nets });
        }
        const next = nextCrossing(t, (k) => k === key);
        at = c ? Math.max(next?.at ?? target, target + c.backoff) : next?.at;
      }
      if (at != null && Number.isFinite(at)) islandNext.set(key, at);
      later(at);
    }
  }
  if (s && (s.candidates.size || nodes.size || coils.size) && !scheduled) {
    // A steady cycle nothing records is drawn a display frame at a time.
    for (const [key, st] of drawn) {
      const next = cycleAt(st.cycle, target).next;
      const at = steadyFramed(st) ? Math.max(next, target + ANALOG_FRAME_S) : next; // prettier-ignore
      const c = chatterNow.get(key);
      later(c ? Math.max(at, target + c.backoff) : at);
    }
    const calm = (key) => oneIsland() || (!drawn.has(key) && !chatterNow.has(key)); // prettier-ignore
    if (!(drawn.size && oneIsland()) && !chatterAll) later(nextCrossing(t, (k) => k == null || calm(k))?.at); // prettier-ignore
    for (const [key, c] of chatterNow) {
      if (drawn.has(key)) continue;
      if (capped.has(key)) {
        const nets = [...flips].filter(([net, n]) => n >= 3 && (oneIsland() || islandOf(net) === key)).map(([net]) => net); // prettier-ignore
        if (nets.length) warnings.push({ type: "oscillation", nets });
      }
      const next = nextCrossing(t, (k) => oneIsland() || k === key);
      later(Math.max(next?.at ?? target, target + c.backoff));
    }
  }
  if (s && (s.candidates.size || nodes.size || coils.size)) {
    // A node still on its way, a running wave, a coil still moving: the
    // views want them redrawn every so often (spice/sample.js
    // `nextDisplayFrame`) — but nothing ELECTRICAL happens at a frame, so it
    // is no wake. It is reported beside `wakeAt` as `frameAt`, and the views
    // read the carried curves there (`sampleAnalog`) without a tick. Not
    // while an island chatters: its own nodes are left out (all of them
    // chattering, nothing is redrawn).
    const quiet = (map, keyIsland) => {
      if (!chatterNow.size || chatterAll) return map;
      const out = new Map();
      for (const [k, v] of map) if (!chatterNow.has(keyIsland(k))) out.set(k, v); // prettier-ignore
      return out;
    };
    frameAt = nextDisplayFrame({ nodes: quiet(nodes, islandOf), coils: quiet(coils, (id) => isl?.coilIsland.get(id) ?? null), waves: quiet(waveIds(), islandOf), chatter: chatterAll ? chatterNow.values().next().value : null, inputs: own }, target, t, { gapPercent: config.gapPercent, waveFrames: spice?.waveFrames !== false }); // prettier-ignore
    if (unsettled) later(target + MIN_SHOWN_S);
  }
  // Stuck chattering, nothing wakes the tick sooner than its back-off — not
  // the settle's own wake, not a timer elsewhere on the desk: a circuit that
  // can only be reported as oscillating must not cost a capped tick (its
  // whole event budget) every half millisecond. Clock edges and inputs
  // still tick it at once (SimController). (Every island chattering: one
  // island alone holds back only its own wakes, above.)
  if (chatterAll && wakeAt != null) {
    const backoff = Math.min(...[...chatterNow.values()].map((c) => c.backoff)); // prettier-ignore
    wakeAt = Math.max(wakeAt, target + backoff);
  }
  // What wakes the desk that is no island's own: a part's timer, a
  // regulator cooling or tripping, a settle left unfinished — every island
  // is ticked then (`dueIslands`).
  let globalNext = result.wakeAt ?? null;
  const globalLater = (at) => {
    if (at != null && Number.isFinite(at)) globalNext = globalNext == null ? at : Math.min(globalNext, at); // prettier-ignore
  };
  for (const until of thermal.values()) globalLater(until);
  if (bench.tripped) globalLater(target + TRIP_S);
  if (unsettled) globalLater(target + MIN_SHOWN_S);
  // A timing part as its silicon times nothing: its readout is what it was
  // measured doing (spice/measure.js).
  // (A part on an island this tick was not for says what it said at that
  // island's own last tick: its edges were timed there, and none came since
  // — read at this moment it would look stopped.)
  let timing = result.timing;
  const readouts = new Map();
  for (const c of lastCtx?.chips ?? []) {
    const readout = c.def.logic?.readout;
    if (!readout) continue;
    if (timing === result.timing) timing = new Map(timing);
    const own = partDef(c.comp.ref);
    const analysis = isTimed(own) ? own.logic.timing(timingProbe(lastCtx.trace, c.pinNet)) : null; // prettier-ignore
    const measured =
      due && !inScope(c.comp.id) && prior?.readouts?.has(c.comp.id)
        ? prior.readouts.get(c.comp.id)
        : measuredTiming(analysis, readout, (pin) => marks.get(readerKey(c.comp.id, pin)), target); // prettier-ignore
    timing.set(c.comp.id, measured);
    readouts.set(c.comp.id, measured);
    // A wiring fault it cannot time through is said, as the digital engine
    // says it (sim/engine.js) — for a part that is powered to time at all.
    if (
      measured.problems.length &&
      chipStatus.get(c.comp.id)?.status === CHIP_STATUS.OK
    ) {
      warnings.push({ type: "timing", chip: c.comp.id, problems: measured.problems }); // prettier-ignore
    }
  }

  // A gate its own feedback resistor biases into its linear region has no
  // logic answer: said as that (spice/linear-bias.js), in place of the
  // chatter or the floating input its loop raises.
  const biasedWarnings = linearBiasWarnings(
    warnings,
    selfBiasedGates(opts.document, opts.netlist),
    result.netLevels,
    (chip) => chipStatus.get(chip)?.status === CHIP_STATUS.OK,
  );

  return Object.assign(result, {
    chipStatus,
    memWrites,
    warnings: biasedWarnings,
    wakeAt,
    // When the views next want this desk redrawn (a node still moving, a
    // running wave) — no wake: nothing happens there but the curves, which
    // spice/sample.js reads (null: nothing moves).
    frameAt,
    timing,
    settled: result.settled && !capped.size,
    analog: {
      time: t,
      // What the bench held for this tick, as it held it: the next tick
      // replays its history on these (`before`). Copied — a caller flips its
      // clocks and presses its signals IN PLACE (SimController does), and a
      // map kept by reference had already turned to the next tick's inputs
      // when that tick replayed the stretch before them: a square clock into
      // an RC charged it from the last tick on, not from its edge.
      inputs: {
        clockPhase: new Map(own.clockPhase),
        signalLevels: new Map(own.signalLevels),
        clockTimes: own.clockTimes,
      },
      nodes,
      listen,
      capFar,
      marks,
      outputs: committed,
      supplies: delivered,
      drops,
      driven,
      caps: charge,
      coils,
      coilAmps,
      coilsAway,
      coilTau,
      oscillating: capped.size > 0,
      // Each island stuck chattering lately (`chatterNow`), and the first
      // of them (`chatter`) — what a one-island desk's tests read.
      chatters: [...chatterNow].map(([key, c]) => ({ key, nets: isl.nets.get(key) ?? [], at: c.at, backoff: c.backoff })), // prettier-ignore
      chatter: chatterNow.values().next().value ?? null,
      // Each island's cycle drawn by its schedule, and the first of them.
      cycles: new Map([...drawn].map(([key, st]) => [key, { cycle: st.cycle, done: st.done, memo: st.memo, steady: st.steady }])), // prettier-ignore
      cycle: drawn.values().next().value?.cycle ?? null,
      islands: isl,
      // Whether this tick ended settled (not capped, nothing left to settle
      // again): only then is a drawn cycle's record carried on.
      quiet: result.settled && !capped.size && !unsettled,
      // …and RESTED: nothing held, chattering or written either, no memory
      // on the desk — the next tick's replay of this moment, on these very
      // inputs, could change nothing (`quietReplay`). On this desk (`ran`).
      // (Nor any cycle drawn, begun or ended: a counting part's state keeps
      // what its schedule told it until a settle without one.)
      rested: result.settled && !capped.size && !unsettled && !pending.size && !chatterNow.size && !memWrites.length && !lastCtx?.chips.some((c) => c.memory) && !drawn.size && !cyclesMoved && !prior?.cycles?.size, // prettier-ignore
      ran: { document: opts.document, netlist: opts.netlist },
      // The digital settle's work for the next tick's first (features/08),
      // how every pin read when it ended, and the chips whose voltage
      // readings moved since.
      warm: digitalWarm,
      settledAt,
      // Each analog island's next event, and the next that is no island's
      // (features/12) — kept only where islands are scheduled apart.
      islandNext: scheduled ? islandNext : null,
      globalNext,
      readouts: scheduled ? readouts : null,
      reread: digitalWarm ? union(readMoved, volt.takeReread()) : null,
      burnt,
      thermal,
      relays: relayOn,
      waves: waveIds(),
      voltages: volt.snapshot(),
    },
    nodeVolts,
    supplies,
    loads,
    lamps: lamps.lamps,
    currents: lamps.currents,
    draws: lastDraws,
    transistors: lamps.transistors,
    bench: bench.readings,
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
    if (o.limits.sustained) {
      // A monostable's discharge transistor, at what it sustains (spice/
      // voltages.js `sustainedFlow`): past what an Rx at its sheet's least
      // lets through (spice/params.js `limitsAt` — the transistor's own
      // resistance in series), the timing resistor is under that least
      // (`rx-current`); past the family's 100 mW in the transistor, brown
      // smoke. An Rx exactly at the least carries exactly the limit, so the
      // comparison forgives the solve's last few ulps.
      const mw = o.watts * 1000;
      const ma = o.amps * 1000;
      if (mw > o.limits.smokeMw) {
        overloaded.add(o.comp);
        keep(`out:${o.comp}`, { type: "output-current", chip: o.comp, pin: o.pin, amps: o.amps, watts: o.watts, unit: "mW", limit: o.limits.smokeMw, smoke: true }, 1e9 + mw); // prettier-ignore
      } else if (ma > o.limits.warnMa * (1 + 1e-9)) {
        keep(`out:${o.comp}`, { type: "rx-current", chip: o.comp, pin: o.pin, amps: o.amps, limit: o.limits.warnMa, rxMin: o.limits.rxMinOhms, smoke: false }, ma); // prettier-ignore
      }
      continue;
    }
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
