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
//   tones      speaker id → {hz, vpp, watts, volume}: what each speaker
//              plays (spice/speakers.js), the silent ones left out
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
//     (`input-overvoltage`) and one held below ground warns as its clamp
//     diode conducts (`input-clamp`, past 18 mA; smoke past 50 — TTL_CLAMP),
//     a CD4000 or MOS input held past a rail warns as its protection diode
//     conducts (`input-clamp`) and smokes past 10 mA,
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
//     (`led-burnt`, once). That temperature LAGS what it carries (one thermal
//     lag, carried in `analog.ledHeats`), so a little over current, or a
//     short pulse of a lot, burns nothing. The burnt set rides
//     `analog.burnt` (a speaker's coil burnt open too, by its resistor's
//     key — spice/speakers.js); Stop clears it with the rest. The verdicts are the result's `lamps`, which the desk
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
  TTL_CLAMP,
  delayNs,
  familyParams,
  partParams,
} from "./params.js";
import {
  crossingTime,
  firstRoot,
  hasArrived,
  heading,
  rateOf,
  isCoupled,
  sampleTimes,
  valueAt,
} from "./rc-curve.js";
import { couplingSteps } from "./coupling.js";
import { awayAmps, shortedInductors } from "./inductors.js";
import { fallOffBalance, gaussSolve } from "./network.js";
import { coupledValue, coupledValues, curveRates, nullModes, rcPrepare } from "./dynamics.js"; // prettier-ignore
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
import {
  AMBIENT_C,
  LED_HEAT_STEP_S,
  LED_HEAT_TAU_S,
  junctionTemp,
  ledBurnIn,
  ledVoltage,
  ledHeatAfter,
  ledVerdict,
} from "./leds.js";
import { diodeVerdict } from "./diodes.js";
import { PSU_SOURCE_OHMS } from "./analog-devices.js";
import { createVoltages, freeSupplies, readerKey } from "./voltages.js";
import { supplySag } from "./sag.js";
import { partDef } from "../../catalog/index.js";
import { LEVEL_WAVES } from "../../catalog/parts.js";
import { isTimed, isVolatileMemory } from "../chip-eval.js";
import { timingProbe } from "../rc-trace.js";
import { measuredTiming, noteLevel, noteTone } from "./measure.js";
import {
  coilMeanWatts,
  noteCoil,
  speakerHeatAfter,
  speakerReadIn,
  speakerTones,
  speakerTopology,
  toneKey,
} from "./speakers.js";
import { SPEAKER_RATED_W, SPEAKER_SMOKE_W } from "../../catalog/speaker.js";
import {
  cycleStart,
  pushMoment,
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
import {
  acGenerator,
  acShiftAt,
  acSwing,
  waveGenerator,
  waveHeading,
  waveSwing,
} from "./waves.js";
import { acSupplies } from "./ac-supplies.js";
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

/** A supply on its limit is SETTLED when its load, at what it delivers,
    draws within this fraction of the limit (`droopMoving`). */
const DROOP_SETTLED = 0.01;

/** How soon a supply on its limit that has not settled is looked at again,
    seconds: a regulator charging its output capacitor through it moves the
    load it is set by (spice/supply.js `droopVolts`). An assumption — small
    beside a charge of milliseconds, large beside a tick. */
const DROOP_WAKE_S = 1e-4;

/** How soon after a supply comes on its limit the tick that lets the solve
    hold its + runs, seconds (`free`): the tick that found it there booked a
    proportional droop, a moment's stand-in. */
const FREE_WAKE_S = 1e-6;

/** A supply the solve holds goes back to being a rail once it delivers
    under this share of its limit, in its constant-voltage piece. */
const FREE_RELEASE = 0.9;

/** A supply with capacitors straight across it that its limit takes longer
    than this to charge, seconds, is freed for the next tick (`inrush`): the
    rail holding them at its voltage from the start had them charged in no
    time. An assumption — a decoupling capacitor's moment (100 nF to 5 V on
    1 A: 0.5 µs) is no charge worth watching. */
const INRUSH_S = 1e-6;

/** Each net's capacitance to earth where a group's capacitors leave a common
    voltage its networks hardly hold (`runGroup`), farads — a breadboard
    strip and its jumpers' — or `STRAY_REL` of the group's largest
    capacitance, if more. */
const STRAY_F = 1e-12;
const STRAY_REL = 1e-9;

/** A common voltage its networks hold by less than this, siemens (a
    megohm), is held by the stray capacitance instead (`runGroup`). */
const FLOATING_S = 1e-6;

/** …and only while its networks push it by less than this, amps (leakage),
    or toward a balance under `FLOATING_V` away. A common voltage a part
    DRIVES where it hardly holds it (a 555's output sinking into one plate,
    the other wired to nothing: a current limit, its slope nothing) heads
    for a balance hundreds of volts off — on the stray a ramp of 10¹⁰ V/s,
    past every corner before a search scaled to the piece's time constants
    reads one. Held as well as pushed (a rectifier's diodes conducting), it
    settles a volt or two off, as fast as its time constants say. */
const FLOATING_A = 1e-6;
const FLOATING_V = 10;

/** Each run's linearizations by what they were read on (`runGroup`'s
    `keptModel`), by the voltage side's `lineage`; and each linearization's
    prepared systems (spice/dynamics.js `rcPrepare`). */
const LINEARIZED = new WeakMap();
const PREPARED = new WeakMap();

/** How many linearizations a run keeps before it starts again. */
const MAX_LINEARIZED = 1024;

/** A run-on after a piece this short, seconds, is a group sliding along a
    corner (`runGroup`'s `sliding`) — not one stepping back down a diode's
    table, each step of which lasts a hundred microseconds. */
const SLIDE_S = 1e-6;

/** How finely a group's corner is found, as a share of the time to it
    (`groupCorner`): past it by a ten-millionth of the stretch, a node a
    kilovolt a second fast is a nanovolt on. */
const CORNER_REL = 1e-7;

/** How close past a group's corner a second one is taken with it, as a share
    of the stretch to the first (`groupCorner`). */
const CORNER_MERGE = 1e-4;

/** At most how many corners `groupCorner` takes as one. */
const MERGED_CORNERS = 4;

/** How far a run-on may carry any node past where it starts, volts
    (`runGroup`): a slide along a corner moves its nodes hardly at all, and
    one that is not a slide — a regulator's OUT re-entering its current
    limit after 15 µs out of it, a bridge's diodes cut off and conducting
    backwards along their last chord — carried a node hundreds of volts
    past where the true network would have stopped it (an unloaded 7805's
    output at 450 V). Capped at 0.1 V that output still stood 0.1 V high;
    at a millivolt, 2 mV. */
const RUN_ON_V = 1e-3;

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

/** A junction that burns by HEAT: every LED, and a diode whose junction
    lags (spice/diodes.js `heatTauS` — the small-signal grade and a Zener). */
const heated = (j) => !j.diode || j.spec.heatTauS != null;
/** Its heat's lag, seconds. */
const tauOf = (j) => j.spec.heatTauS ?? LED_HEAT_TAU_S;
/** What a junction dissipates carrying `f` ({amps, volts}), watts: an LED
    by its own curve's drop, a diode by what is across it (a Zener's
    breakdown too). */
const junctionWatts = (j, f) => {
  if (!f) return 0;
  if (j.diode) return Math.abs(f.volts * f.amps);
  return f.amps > 0 ? ledVoltage(j.spec, f.amps) * f.amps : 0;
};
/** The temperature a junction carrying `v` heads for, °C. */
const steadyTemp = (j, v) =>
  j.diode
    ? AMBIENT_C + j.spec.rthJA * Math.abs(v.volts * v.amps)
    : junctionTemp(j.spec, v.amps);
/** The part of its resistance to the air that LAGS, °C/W: a small-signal
    diode's die has a stage of its own, read at the instant (`rthFast`). */
const rthSlow = (j) => j.spec.rthJA - (j.spec.rthFast ?? 0);
/** The temperature its lagging stage heads for carrying `v`, °C. */
const slowTemp = (j, v) =>
  j.diode
    ? AMBIENT_C + rthSlow(j) * Math.abs(v.volts * v.amps)
    : junctionTemp(j.spec, v.amps);

/** How many values a drawn cycle's drop or supply is remembered at
    (`swingOf`). */
const SWING_KEPT = 8;

/** An LED is HOT — read at every settle, not only at a tick's end — once its
    current at a tick heads its junction this share of the way from ambient
    to its maximum, for `HOT_LED_HOLD_S` from then (`noteLedHeat`). */
const HOT_LED_SHARE = 0.5;
const HOT_LED_HOLD_S = 1;

/** How many times a speaker's voltage is read between two settles, at the
    least and at the most (`noteSpeakersBetween`). */
const SPEAKER_SAMPLES = 16;
const SPEAKER_SAMPLES_MAX = 256;

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
    identity; a function — `rail`, a closure over the data beside it — as
    a function: each analysis makes its own). */
function assertSameAnalysis(what, a, b) {
  const seen = new Set();
  const same = (x, y) => {
    if (x === y) return true;
    if (typeof x === "function") return typeof y === "function";
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

/** A voltage no bench reaches, volts: a group read there is read again
    once it has settled (`runGroup`). */
const WILD_V = 1e6;

/** How many times a group of coupled nodes is linearized again where the
    solve moved a lone capacitor's common voltage to (`runGroup`). */
const GROUP_ROUNDS = 4;

/** A lone capacitor's plates balance to this, volts (`balance`), and its
    first bracketing step is this, volts. */
const BALANCE_V = 1e-9;
const BALANCE_STEP_V = 0.05;

/** Newton's steps at most, and the nudge each slope is read over, volts,
    when common modes balance together (`balanceTogether`). */
const BALANCE_STEPS = 40;
const BALANCE_SLOPE_V = 1e-6;

/** The current a balanced set of plates may still carry, amps
    (`fallOffBalance`). */
const BALANCE_A = 1e-12;

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

/**
 * Is `net` a WIRED-AND held LOW — every output driving it open-collector, at
 * least one of them sinking, the rest unknown (X: sinking or let go, which
 * a LOW holds the net through either way) — and does the SOLVE agree, the
 * net under `vil`? Nothing else may reach it: no bench source, no diode
 * feeding it (its CATHODE on the net: a HIGH fed through one is a driver the
 * outputs cannot see — one leading OUT of it, its anode here, can only sink
 * more of what the LOW already holds; but a ZENER's anode is a way in too,
 * past its breakdown from a higher cathode) and no channel
 * that might be on (a joined group's fight is said on one member net only,
 * and the far side's drivers are not this net's).
 * @param {object|null} ctx - the latest settle's context
 * @param {Map<string, Map<number, string>>} driven - each chip's outputs as
 *   the pass let them through (an open-collector HIGH already Z)
 * @param {string} net
 * @param {{channels?: Map, volts?: number|null, vil?: number, signalLevels?: Map}} [solve] - the
 *   tick's channel states, the net's solved voltage, the reading's VIL and
 *   the bench sources' levels
 */
export function wiredLow(ctx, driven, net, solve = {}) {
  if (!ctx || net == null) return false;
  const { channels = null, volts = null, vil = 0.8, signalLevels = null } = solve; // prettier-ignore
  if (volts == null || !(volts <= vil)) return false;
  if (ctx.clocks?.some((c) => c.outNet === net)) return false;
  // A bench source driving the net — a data-bus pin left open (Z) drives
  // nothing, and is none.
  const drives = (sig) => (signalLevels?.get(sig.id) ?? "H") !== "Z";
  if (ctx.signals?.some((sig) => sig.net === net && drives(sig))) return false;
  if (
    ctx.diodes?.some((d) => d.cathode === net || (d.zener && d.anode === net))
  ) {
    // prettier-ignore
    return false;
  }
  let low = false;
  for (const c of ctx.chips) {
    if (c.status !== CHIP_STATUS.OK) continue;
    if (c.analogSwitch) {
      const states = channels?.get(c.comp.id) ?? [];
      for (const ch of states) {
        if (ch.on === L) continue;
        if (c.pinNet.get(ch.a) === net || c.pinNet.get(ch.b) === net) {
          return false;
        }
      }
    }
    for (const [pin, level] of driven.get(c.comp.id) ?? []) {
      if (level === Z || c.pinNet.get(pin) !== net) continue;
      if (!c.def.openCollector?.includes(pin)) return false; // a real driver
      if (level === L) low = true;
      else if (level !== X) return false;
    }
  }
  return low;
}

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
  // A transformer's two windings move as one system, whatever their wiring
  // keeps apart: their currents are coupled through its core.
  for (const l of topo.coils ?? []) {
    if (!l.couple) continue;
    add(`#coil${l.couple.id}`);
    union(coilKey(l), `#coil${l.couple.id}`);
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
function analyze(ctx, config, doc, netlist, freeNets = new Set()) {
  const { trace } = ctx;
  // Which rail a net is — none for the + of a supply on its limit, which
  // the voltage solve holds (`free`).
  const rail = (net) => (freeNets.has(net) ? null : (trace.rail(net) ?? (ctx.supplyMinus.has(net) ? "-" : null))); // prettier-ignore
  const railVolts = new Map();
  let vHigh = 0;
  for (const [net, volts] of ctx.supplyPlusVolts) {
    if (freeNets.has(net)) continue;
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
  const reaches = (far) => far != null && (rail(far) || trace.connected(far)); // prettier-ignore
  const candidates = new Map(); // net → {caps, farads}
  for (const net of ctx.netIds) {
    if (rail(net)) continue;
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
    if (!net || waves.has(net) || rail(net)) continue;
    const wave = clockDef.waveOf(byId.get(clk.id)?.params);
    // A square or a PWM is a LEVEL, driven like any output.
    if (LEVEL_WAVES.includes(wave)) continue;
    const { amplitude, offset } = byId.get(clk.id)?.params ?? {};
    waves.set(net, { id: clk.id, wave, volts: clk.volts, amplitude, offset });
    const had = candidates.get(net);
    candidates.set(net, { caps: had?.caps ?? [], farads: had?.farads ?? 0, wave: clk.id }); // prettier-ignore
  }
  // An AC supply's L terminal is a sine the same way — from its negative
  // peak to its positive one, about its N (a − rail: sim/engine.js), never
  // clipped (`acSwing`) — told its phase by the time alone (`acGenerator`):
  // it has no square for SimController to tick. With N unwired there is no
  // return for its current, so L drives nothing (as a clock brick's out
  // with no ground).
  // An ISOLATED one's sine runs on the net inside it (`source`), L held at
  // N plus that by its "v" device (spice/analog-devices.js) — with L or N
  // unwired, or the two one net, it drives nothing.
  for (const ac of acSupplies(doc, netlist)) {
    if (ac.isolated && (!ac.line || !ac.neutral || ac.line === ac.neutral)) continue; // prettier-ignore
    const net = ac.isolated ? ac.source : ac.line;
    if (!net || !ac.neutral || waves.has(net) || rail(net)) continue;
    waves.set(net, { id: ac.id, wave: "sine", swing: acSwing(ac.params), hz: ac.params.hz, ac: true }); // prettier-ignore
    const had = candidates.get(net);
    candidates.set(net, { caps: had?.caps ?? [], farads: had?.farads ?? 0, wave: ac.id }); // prettier-ignore
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
  return { trace, rail, railVolts, vHigh, candidates, waves, quantum, holds, maxHold, delays, spikes, capPins }; // prettier-ignore
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
const EMPTY_SET = new Set();

/** An inductive kick's warning, its energy against what its package absorbs
    in one (spice/params.js KICK_LIMITS): `limit`/`smoke` past its warning
    figure, mJ. */
function kickWarning(comp, { volts, joules, energy }) {
  const mj = joules * 1000;
  const out = { type: "inductive-kick", comp, volts, joules };
  if (!energy || !(mj > energy.warnMj)) return out;
  const smoke = mj > energy.smokeMj;
  return { ...out, smoke, limit: smoke ? energy.smokeMj : energy.warnMj };
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
  // Where the speakers' nodes ran from since the last settle — the last
  // tick's last, at first (`noteSpeakersBetween`).
  let ranFrom = null;
  // What each listener last read (key → true above, false below — spice/
  // listeners.js), and each capacitor's far side as last seen from each of
  // its nodes (`<cap>@<net>` → volts — spice/coupling.js).
  const listen = new Map(prior?.listen ?? []);
  const capFar = new Map(prior?.capFar ?? []);
  // Each timing part's readout outputs' edges, timed (spice/measure.js).
  const marks = new Map(prior?.marks ?? []);
  // …and the voltage across each speaker, timed the same way into the tone
  // it plays (spice/speakers.js).
  const tones = new Map(prior?.tones ?? []);
  const speakers = speakerTopology(opts.document, opts.netlist);
  if (speakers.length && prior?.time != null) ranFrom = { at: prior.time, ends: speakerEnds() }; // prettier-ignore
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
      // What each LED on it dissipates at each segment's start (`settleSeg`):
      // its heat is booked at the cycle's mean (below).
      ledPower: st.ledPower ?? null,
      ledAmps: st.ledAmps ?? null,
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
  // A cycle slower than the cap is drawn at its own rate only while nothing
  // records the desk (spice/cycles.js SLOW_CYCLE_S); one drawn so when the
  // analyzer starts recording runs on from where it stands, stepped.
  const slowDrawn = spice?.waveFrames === false;
  const tooSlow = (st) => !slowDrawn && st.cycle.period > 1 / TIMING_CAP_HZ; // prettier-ignore
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
  // …and, while a cycle is drawn, every drop and delivered voltage each has
  // been read at (key → volts[]): one read at whichever phase a tick ends
  // in is the cycle, not a move (`swingOf`).
  const swing = new Map(prior?.swing ?? []);
  // What each chip off the rails ran at as the last tick ended (`chipVolts`).
  const fedBefore = prior?.fed ?? EMPTY_MAP;
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
  // Each regulator's heat (spice/bench-warnings.js): carried, so a burst
  // heats it only as long as it lasts.
  const heats = new Map(prior?.heats ?? []);
  // Each LED junction's temperature as its last tick left it, and the one it
  // was heading for (spice/leds.js): carried, so a pulse heats it only for as
  // long as it lasts, and a current past its burn figure burns it in time.
  const ledHeats = new Map(prior?.ledHeats ?? []);
  // …and a HOT one's energy since its last tick, its power read at every
  // settle (`noteLedHeat`): key → {from, t, w, e}, watts and joules.
  const ledEnergy = new Map(prior?.ledEnergy ?? []);
  // …and each speaker's coil (spice/speakers.js): its heat, watts, as its
  // last tick left it, and the power it then carried.
  const speakerHeats = new Map(prior?.speakerHeats ?? []);
  // …and the energy in each coil since that tick: the voltage across it
  // read wherever its tone is (`noteSpeaker`), v² integrated (`noteCoil`).
  const speakerEnergy = new Map(prior?.speakerEnergy ?? []);
  // The supplies on their current limit (PSU ids): the + of each is a net of
  // the voltage solve, held by its "p" device (spice/analog-devices.js), for
  // as long as it stays there (`measure`).
  const free = new Set(prior?.free ?? []);
  let freeNext = free;
  const burntNow = [];
  const kicksNow = new Map(); // transistor → {volts, joules} (`inductive-kick`)
  // The transistors the last tick left in breakdown: a kick still under way
  // as this tick starts is the one it said, not another — its energy read
  // again a hair lower ("0.0901 mJ", then "0.09 mJ"), every turn-off was
  // two toasts (the fourth regrade, 2026-10-22).
  const kickedBefore = prior?.kicking ?? EMPTY_SET;
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
    free,
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
  // The op-amps: a corner on one's island may be its output swinging
  // (`cornerWaits`).
  const opAmpChips = (opts.document?.components ?? []).filter((c) => partDef(c.ref)?.opAmps).map((c) => c.id); // prettier-ignore
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
  /** Each AC supply's phase shift (turns): carried tick to tick, and moved
      at a tick whose Frequency was edited, so its sine carries on from the
      angle it stood at (`acShiftAt`) instead of jumping. */
  const acShift = new Map();
  /** Fill `acShift` from the last tick's, once `analyze` has said this
      tick's waves. */
  const noteAcShifts = () => {
    for (const [net, w] of s.waves) {
      if (!w.ac) continue;
      const was = prior?.waveKinds?.get(net);
      if (!was?.ac) continue;
      const shift = was.shift ?? 0;
      acShift.set(net, was.hz === w.hz ? shift : acShiftAt(was.hz, shift, w.hz, target)); // prettier-ignore
    }
  };
  /** A wave net's generator at `t`, on the bench's inputs at that moment
      (a late tick's history on the last tick's, as `settleAt` runs it). */
  const generatorOf = (net, t, inputs = t < target ? before : own) =>
    waveAt(s.waves.get(net), inputs, t, acShift.get(net));
  /** A wave entry's generator at `t`: an AC supply's by the time alone (and
      its phase `shift`), a clock's by its square's edges (`inputs`). */
  const waveAt = (w, inputs, t, shift = 0) =>
    w.ac
      ? acGenerator(w.swing, w.hz, t, shift)
      : waveGenerator(w.wave, inputs.clockPhase.get(w.id), inputs.clockTimes.get(w.id), w.swing ?? waveSwing(w, w.volts ?? s.vHigh), t); // prettier-ignore
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
        // Where the wave stood just before: the last tick's SHAPE and SWING
        // when an edit changed them (a triangle switched to a ramp, or its
        // amplitude turned, jumps by the gap).
        const w = s.waves.get(net);
        const was = prior?.waveKinds?.get(net);
        const changed = was && (was.wave !== w.wave || was.amplitude !== w.amplitude || was.offset !== w.offset || was.swing?.lo !== w.swing?.lo || was.swing?.hi !== w.swing?.hi || was.hz !== w.hz); // prettier-ignore
        const from = changed
          ? waveAt({ ...w, ...was, ac: w.ac && was.ac }, before, target, was.shift) // prettier-ignore
          : generatorOf(net, target, before);
        // …against where it stands at that same moment on this tick's
        // inputs. Read at `t` instead, a tick whose first look past its
        // moment was a corner a few microseconds on (its own settle
        // skipped, a quiet replay) took those microseconds of the wave's
        // MOTION as a jump, and stepped every capacitor on it by that: an
        // AC supply through 1 µF onto a CMOS input stepped its node 19 mV
        // the wrong way at each clamp, and ticked every 20 µs the input
        // never charged up to trip.
        const jump = (t === target ? gen : generatorOf(net, target)).value - from.value; // prettier-ignore
        if (Math.abs(jump) > WAVE_JUMP_EPS) waveJumps.set(net, jump);
      }
      // Still on its group's curve (`runGroup`'s, `made`), which states it
      // exactly: kept, so the group may run on it — the group's own run puts
      // its generator back if anything changed.
      const kept = nodes.get(net)?.curve;
      if (gen.running && kept?.made && kept.t0 <= t && t < kept.tEnd && !waveJumps.has(net)) continue; // prettier-ignore
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
      // Driven straight through, nothing is held: a commitment kept from a
      // tick that DID hold (an island ticked with a faster one) would be a
      // stale output map the next holding tick drove for its hold count.
      if (hold > 1) committed.set(id, outMap);
      else committed.delete(id);
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
        const freeNets = new Set(freeSupplies(opts.document, opts.netlist, free).map((p) => p.plus)); // prettier-ignore
        const freeKey = [...freeNets].sort().join(",");
        if (memo?.configKey === configKey && memo.freeKey === freeKey) {
          s = memo.s;
          if (ASSERT_ANALYSIS) assertSameAnalysis("analysis", s, analyze(ctx, config, opts.document, opts.netlist, freeNets)); // prettier-ignore
        } else {
          s = analyze(ctx, config, opts.document, opts.netlist, freeNets);
          ANALYSES.set(ctx, { configKey, freeKey, s });
        }
        for (const net of [...nodes.keys()]) {
          if (!s.candidates.has(net)) nodes.delete(net);
        }
        noteAcShifts();
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
      // A discrete transistor's base or gate: whether the solve has it
      // conducting — read at its net's level, a transistor feeding its own
      // base, or a pair feeding each other's, looped on and off until the
      // settle gave up (spice/voltages.js `selfControlled`).
      if (c.def.transistor && pin === c.def.logic?.channels?.[0]?.inputs?.[0]) {
        const self = volt.selfControl(c.comp.id);
        if (self != null) return self;
      }
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
    // A chip off the rails at what reaches its pins — held where the last
    // tick ended with it while that moves by no more than DROOP_EPS, as a
    // supply's droop is (`fedMoved` settles again past it): read to the last
    // bit, a chip on a regulator's rippling output made every tick's context
    // a new one (sim/engine.js `hookKey`), and with it the analysis.
    chipVolts(comp, vccNet, gndNets) {
      const now = volt.chipVolts(vccNet, gndNets);
      const was = fedBefore.get(comp.id);
      return now != null && was != null && Math.abs(now - was) <= DROOP_EPS ? was : now; // prettier-ignore
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
    // The islands (and their next events) are the LAST tick's, so they speak
    // for this desk only while it is the very same one: a switch flipped or a
    // part edited mid-run can split off an island no `islandNext` knows, and
    // a tick for the others would leave it frozen for as long as they stay
    // busy. One tick for every island re-sorts them and gives each its own.
    if (prior.ran?.document !== opts.document || prior.ran?.netlist !== opts.netlist) return null; // prettier-ignore
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
    if (s.rail(net) === "-") return 0;
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
    const stepped = (net) => steps.has(net) || jumps.has(net);
    for (const group of groups) runGroup(group, rc, amps, t, stepped);
    volt.setCoils(ampsAt(t));
    // A transistor an inductor has driven into breakdown, its coils' energy
    // with it (`inductive-kick`).
    if (groups.some((g) => g.coils.length)) {
      const { coils: all, clusterOf } = volt.topology();
      for (const kick of volt.kicks()) {
        // The coils in its cluster, and a transformer winding's partner
        // wherever it is solved (P2 on a rail parts the two clusters, but
        // the energy is the pair's).
        const feeding = new Set();
        for (const l of all) {
          if ((clusterOf.get(l.a) ?? clusterOf.get(l.b)) !== kick.cluster)
            continue;
          feeding.add(l.id);
          if (l.couple) feeding.add(l.couple.id);
        }
        let joules = 0;
        for (const l of all) {
          if (!feeding.has(l.id)) continue;
          const i = amps.get(l.id) ?? 0;
          joules += 0.5 * l.henries * i ** 2;
          // A transformer's: ½·iᵀ·L·i — each winding's half of the M term.
          if (l.couple) joules += 0.5 * l.couple.henries * i * (amps.get(l.couple.id) ?? 0); // prettier-ignore
        }
        const was = kicksNow.get(kick.comp);
        if (!was || kick.volts > was.volts) kicksNow.set(kick.comp, { volts: kick.volts, joules: Math.max(joules, was?.joules ?? 0), energy: kick.energy }); // prettier-ignore
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
  const runGroup = (
    { nets, waves = [], coils: group },
    rc,
    amps,
    t,
    stepped = null,
  ) => {
    // prettier-ignore
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
    // Its curves still run where they were made — the same states, the same
    // networks (the voltage side's `epoch`: no output, channel, source,
    // burn, shutdown or supply has changed them since), the same waves, and
    // no step at a far plate since: they are the exact answer still, and
    // made again here they come out the same (a settle with nothing in its
    // networks moved re-ran every group — at the replayed start, at its
    // corner and after its settle: two thirds of a rectifier's runs). Made
    // on this voltage side (`lineage`): a fresh side's statement starts
    // "fresh" whatever its netlist, so two edits at one paused moment, each
    // its own netlist of the same chips and sources, stated alike — and the
    // second ran on the first's curves (a resistor changed twice, charging
    // at the first value).
    const members = `${volt.epoch()}#${nets.join()}|${waves.join()}|${group.map((l) => l.id).join()}`; // prettier-ignore
    const shapes = gens.map((g) => `${g.wave}:${g.mid}:${g.omega}:${g.slope}:${g.running}`).join(); // prettier-ignore
    const made = `${members}#${shapes}#${gens.map((g) => g.end).join()}`;
    const last = group.length ? coils.get(group[0].id) : nodes.get(nets[0] ?? waves[0])?.curve; // prettier-ignore
    if (last?.made === made && last.lineage === volt.lineage() && last.t0 <= t && t < last.tEnd && !(stepped && (nets.some(stepped) || waves.some(stepped)))) return; // prettier-ignore
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
    // The whole system's: the capacitances, then each inductor's L — a
    // transformer's two windings their mutual inductance M off the diagonal
    // (spice/inductors.js `couple`), so the block stays symmetric — and a
    // wave's own states, each of which moves at its own rate (unit weight:
    // they are never a capacitance, so never a null mode either).
    const coilAt = new Map(group.map((l, j) => [l.id, nc + nw + j]));
    const e = Array.from({ length: n }, (_, i) => {
      const row = new Float64Array(n);
      if (i < nc) row.set(c[i]);
      else if (i >= nc + nw && i < ns) {
        const l = group[i - nc - nw];
        row[i] = l.henries;
        const k = l.couple ? coilAt.get(l.couple.id) : null;
        if (k != null) row[k] = l.couple.henries;
      } else row[i] = 1;
      return row;
    });
    const dirs = new Map();
    // …and how fast each is going, so the linearization can read where they
    // go TOGETHER (spice/voltages.js `linearizeGroup`).
    const rates = new Map();
    for (const net of nets) {
      const curve = nodes.get(net)?.curve;
      const d = curve ? heading(curve, t) : 0;
      if (d) {
        dirs.set(net, d);
        rates.set(net, rateOf(curve, t));
      }
    }
    gens.forEach((g, k) => {
      const d = waveHeading(g);
      if (d) {
        dirs.set(waves[k], d);
        rates.set(waves[k], g.wave === "sine" ? g.omega * g.aux : g.slope);
      }
    });
    for (const l of group) {
      const curve = coils.get(l.id);
      const d = curve ? heading(curve, t) : 0;
      if (d) {
        dirs.set(l.id, d);
        rates.set(l.id, rateOf(curve, t));
      }
    }
    let modes = nc ? nullModes(c) : [];
    let v = Float64Array.from(nets, (net) => rc.get(net));
    const state = () => Float64Array.from([...v, ...gens.map((g) => g.value), ...group.map((l) => amps.get(l.id) ?? 0), ...gens.filter((_, k) => quad.has(k)).map((g) => g.aux)]); // prettier-ignore
    // The networks linearized with the waves free to move (their columns:
    // how each node's current follows them); then each wave's own rows
    // replaced by its generator, and a capacitor from a node to a wave
    // carrying C times the wave's rate into the node (its plate is driven).
    // A group's networks back on pieces it was linearized on before (in this
    // run, the same networks — `members`): every element there is a straight line,
    // so its linearization is the same one, read again — and kept, with its
    // prepared system, under what it would be read on (`volt.groupKey`: the
    // pieces its states enter together, one solve where the reading took
    // one a state and its system an eigen-decomposition). A rectifier's
    // reservoir comes round the same two dozen piece sets every cycle. Not
    // while a free common mode is balanced (`modes`: the balance moves the
    // states it was read at), nor where a cluster's state is alone or at
    // rest (`groupKey` null: its read is its own).
    // A group that ran on along a corner last time (`run`), its last piece
    // under `SLIDE_S` long, is SLIDING along it — the regulator catching an
    // unloaded output: OUT at its target,
    // sourcing nothing, the piece each side heading into the other. Read
    // exactly on either piece it chattered between them, a millivolt a run
    // (the reservoir took seconds to fill); read by each state's own secant,
    // half on each side, the model slides as the circuit does. Nor is such
    // a read kept.
    const sliding = last?.run > 0 && last.tEnd - last.t0 < SLIDE_S;
    const keptModel = () => {
      if (modes.length || sliding) return null;
      let kept = LINEARIZED.get(volt.lineage());
      if (!kept) LINEARIZED.set(volt.lineage(), (kept = new Map()));
      // (A network with no pieces at all is one straight law: its read,
      // once, is the read.)
      const straight = kept.get(`${members}#linear`);
      if (straight) return straight;
      const key = volt.groupKey([...nets, ...waves], group, rc, amps, dirs, rates); // prettier-ignore
      if (key == null) return null;
      const at = `${members}#${key}`;
      let model = kept.get(at);
      if (!model) {
        model = volt.linearizeGroup([...nets, ...waves], group, rc, amps, dirs, waves, rates); // prettier-ignore
        if (model.linear && model.pure) {
          if (kept.size >= MAX_LINEARIZED) kept.clear();
          kept.set(`${members}#linear`, model);
          return model;
        }
        // Kept only where every state was read on those pieces: one read
        // across a corner its group does not cross is the model of a group
        // SLIDING along it (a regulator just catching its output, OUT a
        // microvolt from where it stops sourcing), not of the pieces —
        // kept, it ran the reservoir's charge on the wrong side of it.
        if (!model.pure) return model;
        if (kept.size >= MAX_LINEARIZED) kept.clear();
        kept.set(at, model);
      }
      return model;
    };
    const linearized = () => {
      volt.adoptGroupSwing([...nets, ...waves], group, rc, amps, dirs, rates);
      const model = keptModel() ?? volt.linearizeGroup([...nets, ...waves], group, rc, amps, dirs, waves, rates, !sliding); // prettier-ignore
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
    // Plates joined to nothing fixed by their capacitors have a common
    // voltage no capacitance holds — C's null space, which the networks
    // alone place (`balance`: Newton on the true networks at every corner).
    // Where they hold it hardly at all — a bridge's DC side off an earthed
    // AC supply, its diodes off: four junctions' leakage, a few nanosiemens
    // — that was a third of the desk's run, the balance a nanoamp's worth
    // of volts that moved at every corner, and with no capacitor on the
    // regulator's OUT the desk ran at a twentieth of real time. Every net
    // has some capacitance to earth (its strips, its jumpers): there each
    // is given `STRAY_F`, and the common voltage is a state like any other,
    // carried on its curve between corners. Held by anything real (a
    // resistor, a conducting junction, an output) it is balanced as before:
    // given the stray there, the coupled oscillators and the flasher, whose
    // capacitors' common modes resistors hold, timed differently. Once found
    // floating, a group keeps its stray for as long as it stands (its
    // curves say so, `floating`) and nothing drives it far (`FLOATING_A`) —
    // the rectifier's diodes conducting hold it for a moment each
    // half-cycle, and switching to the balance there and back cost what the
    // stray saved.
    const groupKey = `${nets.join()}|${waves.join()}`;
    const before = nodes.get(nets[0])?.curve;
    let first = null;
    let floating = false;
    if (modes.length) {
      // Floating before, it is read as the stray holds it (`keptModel`
      // keeps no read a balance moves), and only let go if now pushed.
      const nulls = modes;
      const was = before?.floating === groupKey;
      if (was) modes = [];
      first = linearized();
      modes = nulls;
      const { y, i0 } = first;
      const at = state();
      const held = (m) => {
        let g = 0;
        for (let i = 0; i < nc; i++) for (let j = 0; j < nc; j++) g += m[i] * y[i][j] * m[j]; // prettier-ignore
        return g;
      };
      const pushed = (m) => {
        let a = 0;
        for (let i = 0; i < nc; i++) {
          let into = i0[i];
          for (let j = 0; j < at.length; j++) into += y[i][j] * at[j];
          a += m[i] * into;
        }
        return Math.abs(a);
      };
      floating = modes.every((m) => {
        const g = held(m);
        return pushed(m) < FLOATING_A + g * FLOATING_V && (was || g < FLOATING_S); // prettier-ignore
      });
      if (floating) {
        const stray = Math.max(STRAY_F, STRAY_REL * Math.max(...c.map((row, i) => row[i]))); // prettier-ignore
        for (let i = 0; i < nc; i++) {
          c[i][i] += stray;
          e[i][i] += stray;
        }
        modes = nullModes(c);
      }
      if (modes.length) first = null;
    }
    let model = null;
    let sys = null;
    // The system a linearization makes, prepared once per linearization
    // (spice/dynamics.js `rcPrepare`) and kept with it — the stray, when
    // given, its own: what the curves from each start are read off.
    const system = (lin) => {
      const key = `${floating ? "floating" : ""}#${shapes}`;
      let preps = PREPARED.get(lin.model);
      if (!preps) PREPARED.set(lin.model, (preps = new Map()));
      let prep = preps.get(key);
      if (!prep) preps.set(key, (prep = rcPrepare({ c: e, y: lin.y, i0: lin.i0, nc }))); // prettier-ignore
      return prep.at(state(), t);
    };
    let disagree = 0;
    let strayOnly = false;
    for (let round = 0; round < GROUP_ROUNDS; round++) {
      if (modes.length) {
        v = balance(nets, modes, v, rc, amps);
        nets.forEach((net, i) => rc.set(net, v[i]));
        volt.setNodes(s.candidates, rc);
      }
      const lin = first ?? linearized();
      first = null;
      model = lin.model;
      sys = system(lin);
      // The linear piece agrees with where the plates balanced: done.
      let moved = 0;
      for (let i = 0; i < nc; i++) moved = Math.max(moved, Math.abs(coupledValue(sys.curves[i], 0) - v[i])); // prettier-ignore
      if (!(moved > BALANCE_V)) break;
      disagree = moved;
      if (round === GROUP_ROUNDS - 1) break;
      disagree = 0;
    }
    // Still not where the plates balanced: the pieces the states head into
    // leave their common mode held by nothing — an integrator's op-amp
    // leaving saturation reads its output at its sink limit, a fixed
    // current that holds neither plate — and its linear piece balanced them
    // 195 V away: the integrator read −188 V and ran on to −560 (the
    // regrade, 2026-10-22). Read with each plate's stray capacitance (as a
    // floating group is) the common mode is one more state, a fast one, and
    // the piece starts where the plates stand; its corner — the op-amp back
    // in its band — comes nanoseconds on.
    if (disagree > BALANCE_V && modes.length) {
      const stray = Math.max(STRAY_F, STRAY_REL * Math.max(...c.map((row, i) => row[i]))); // prettier-ignore
      for (let i = 0; i < nc; i++) {
        c[i][i] += stray;
        e[i][i] += stray;
      }
      floating = true;
      strayOnly = true;
      modes = nullModes(c);
      const lin = linearized();
      model = lin.model;
      sys = system(lin);
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
      sys = system(lin);
    }
    // A wave's piece ends at its next edge, whatever its network does.
    let limit = Number.POSITIVE_INFINITY;
    for (const g of gens) limit = Math.min(limit, g.end);
    const corner = groupCorner(sys, model, t, limit);
    let tEnd = corner.tEnd;
    // Straight (no corner to end it), but read where its networks stand at a
    // voltage no bench reaches — a coil whose only loop a burn opened kicked
    // its far end to 1e11 V: its read there is the difference of numbers
    // eleven places long, and run on for good it settled 12 V off (17.5 V on
    // a 5 V desk). Read again once it has run its slowest time constants,
    // where the numbers are a bench's.
    if (model.linear && !(tEnd < limit) && Number.isFinite(sys.scale.slow)) {
      const ends = [...nets, ...waves, ...group.flatMap((l) => [l.a, l.b])];
      if (ends.some((net) => Math.abs(volt.voltOf(net) ?? 0) > WILD_V)) {
        tEnd = Math.min(limit, t + 50 * sys.scale.slow);
      }
    }
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
      // Nor, along a piece with a GROWING mode (a device linearized to a
      // negative slope), past one e-fold of it: run on unchecked it carried a
      // coil's current to e^4600 — Infinity, then NaN for the rest of the run.
      const slow = Number.isFinite(sys.scale.slow) ? sys.scale.slow : Infinity;
      const grow = sys.scale.grow ?? Infinity;
      // From a piece that was itself no stuck run, twice the hair to the
      // corner it found, not twice that whole piece: a coil decaying through
      // a diode's table, ticked where a piece ended, was re-linearized a
      // hair short of its corner, and ran on along the OLD piece for twice
      // the half millisecond the last took — past the next corner unseen,
      // its current 0.13 % off ngspice's, as the ticks happened to fall (the
      // fourth regrade, 2026-10-22).
      const last = prev.run > 0 ? Math.max(prev.run, t - prev.t0) : corner.tEnd - t; // prettier-ignore
      run = Math.min(2 * Math.max(last, STUCK_MIN_S), slow, grow);
      const runTo = t + run;
      // …but never carries a coil's current through zero: a current dying
      // into a one-way path (a transistor's breakdown, a diode) stops there,
      // and run on past it, the piece pulled it backwards through the very
      // clamp that had stopped conducting (a relay's coil with no diode).
      let end = runTo;
      group.forEach((l, j) => {
        const curve = sys.curves[nc + nw + j]; // the coils come after the waves
        const i0 = coupledValue(curve, 0);
        if (!(Math.abs(i0) > 0)) return;
        const f = (u) => -Math.sign(i0) * valueAt(curve, u);
        end = Math.min(end, firstRoot(f, t, sampleTimes(t, runTo, sys.scale.fast, sys.scale.oscs ?? sys.scale.osc))); // prettier-ignore
      });
      // …nor past where its networks leave the pieces it is sliding among:
      // run on past that corner, the linear piece carries on where the true
      // network has stopped — a bridge's diodes, cut off, conducting
      // backwards along their last chord, pumped a regulator's output a volt
      // past its 5 V in half a nanosecond.
      end = Math.min(end, movesPast(sys, t, end, nc, RUN_ON_V));
      tEnd = Math.min(Math.max(tEnd, end), limit);
    }
    const own = { made, lineage: volt.lineage(), ...(floating && !strayOnly ? { floating: groupKey } : {}), tEnd, scale: sys.scale, pieces: corner.now, recent: [corner.now, ...recent.filter((p) => p !== corner.now)].slice(0, RECENT_PIECES), run, ...(nw && tEnd >= limit ? { byWave: true } : {}) }; // prettier-ignore
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
    // Two or more modes: Newton's steps together from where they stand
    // first, which keeps them on the balance they are near. A flasher's two
    // plate pairs, the voltage across each capacitor held, ARE a flip-flop —
    // two balances — and the sweeps' bracket, doubling out one mode at a time,
    // stepped clean over the near one to the far one: the transistor that was
    // on switched off at a corner, and back on at the next, every 1.5 ms.
    // Only if that does not settle, the sweeps, and Newton from where they
    // leave it.
    if (modes.length > 1) {
      const near = balanceTogether(nets, modes, v0, new Map(rc), amps);
      if (near.balanced) return near.v;
    }
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
    return modes.length > 1 ? balanceTogether(nets, modes, v, at, amps).v : v;
  };

  /** Two or more common modes balanced TOGETHER, by Newton's steps on the
      true networks (each slope read a hair off, every mode at once):
      `{v, balanced}`. Where the modes pull on each other through a gain —
      the two capacitors of a transistor flasher, each plate pair on one
      transistor's base and the other's collector — mode-by-mode sweeps creep
      (or swing) and stop short of the balance; the linear piece then put the
      gap's current into its algebraic modes at once, and a collector landed
      at −43 V. */
  const balanceTogether = (nets, modes, v0, at, amps) => {
    const k = modes.length;
    let v = Float64Array.from(v0);
    const residual = (w) => {
      nets.forEach((net, i) => at.set(net, w[i]));
      const cur = volt.currentsAt(nets, at, amps);
      return modes.map((mode) => mode.reduce((sum, m, i) => sum + m * cur[i], 0)); // prettier-ignore
    };
    const size = (f) => f.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    const along = (w, dz) => w.map((x, i) => x + modes.reduce((sum, mode, j) => sum + dz[j] * mode[i], 0)); // prettier-ignore
    let f = residual(v);
    let balanced = false;
    for (let step = 0; step < BALANCE_STEPS; step++) {
      const jacobian = modes.map(() => new Float64Array(k));
      for (let j = 0; j < k; j++) {
        const dz = new Array(k).fill(0);
        dz[j] = BALANCE_SLOPE_V;
        const fj = residual(along(v, dz));
        for (let r = 0; r < k; r++) jacobian[r][j] = (fj[r] - f[r]) / BALANCE_SLOPE_V; // prettier-ignore
      }
      const dz = gaussSolve(
        jacobian,
        f.map((x) => -x),
      );
      if (!dz) break;
      // Never a step that leaves it further from balance: halved until it
      // gains, as the solve's own Newton steps are.
      const before = size(f);
      let t = 1;
      let next = null;
      let w = null;
      for (let h = 0; h < 30; h++) {
        w = along(
          v,
          dz.map((x) => x * t),
        );
        next = residual(w);
        if (size(next) < before) break;
        t /= 2;
      }
      if (!(size(next) < before)) break;
      v = w;
      f = next;
      if (size(dz) * t < BALANCE_V) {
        balanced = true;
        break;
      }
    }
    // A balance the plates would fall OFF (the flasher powered up even, both
    // transistors half on): onto one that holds, the same way every Run.
    if (balanced) {
      const base = v;
      const fell = fallOffBalance(
        (z) => residual(along(base, z)),
        new Float64Array(k),
        { dx: BALANCE_SLOPE_V, tolerance: BALANCE_A },
      );
      if (fell) v = along(base, fell);
    }
    nets.forEach((net, i) => at.set(net, v[i]));
    return { v, balanced };
  };

  /** When a group's coupled curves first reach a corner (`tEnd`) — any of
      their networks' elements leaving its piece (spice/voltages.js
      `linearizeGroup`'s `constraints`), sampled over its time constants,
      stepped over where nothing can be left, and bisected — or
      Infinity where none does; and the pieces they start on (`now`). A
      network with no pieces at all (`linear`) has no corner to search for —
      a wave through an RC spent most of its tick sampling one. */
  const groupCorner = (sys, model, t, limit = Number.POSITIVE_INFINITY) => {
    const states = new Float64Array(sys.curves.length);
    const piecesAt = (u) => model.piecesAt(coupledValues(sys.curves, Math.max(0, u - t), states)); // prettier-ignore
    const now = piecesAt(t);
    // (Straight, it runs to the wave's next edge — but not past one e-fold
    // of a GROWING mode: a coil whose only loop a burn had opened, read
    // through a gigaohm, grew to Infinity, then NaN for the rest of the run.)
    if (model.linear) return { tEnd: Math.min(limit, t + (sys.scale.grow ?? Infinity)), now }; // prettier-ignore
    const slow = sys.scale.slow;
    const end = Math.min(limit, t + (Number.isFinite(slow) && slow > 0 ? 50 * slow : 86400)); // prettier-ignore
    // Every element's piece is a quantity between two edges
    // (`model.constraints` — a transistor's, an off-rail stage's, its piece
    // itself): how far inside them all the states stand is the search.
    // Continuous, so `firstRoot`'s look between samples at a crest sees an
    // element come up to an edge and fall back — a rectifier's diode grazing
    // its knee at a trough, a conduction angle shorter than the sampling —
    // which a step (−1 inside, 1 out) never showed; and read in a few
    // multiplications a constraint, where the pieces took a pass over every
    // element of every network. Each one's distance over the most it can
    // move a second says how long nothing can be left (`clear`): the search
    // steps over that stretch unread.
    const held = model.constraints(coupledValues(sys.curves, 0, states), curveRates(sys.curves)); // prettier-ignore
    const clear = held.clear ? () => held.clear() : null;
    const off = (u) => {
      const m = held.margin(coupledValues(sys.curves, Math.max(0, u - t), states)); // prettier-ignore
      return m !== 0 ? -m : Number.MIN_VALUE;
    };
    let tEnd = firstRoot(off, t, sampleTimes(t, end, sys.scale.fast, sys.scale.oscs ?? sys.scale.osc), CORNER_REL, clear); // prettier-ignore
    // Corners a hair apart are taken as one (`CORNER_MERGE` of the stretch
    // to the first): a bridge's two conducting diodes carry one current and
    // cross each point of their table nanoseconds apart — each its own
    // re-linearization of the whole group. Ended past both, the second is
    // run on its old piece for that hair, which moves nothing a reading
    // shows.
    if (tEnd < limit) {
      for (let k = 0; k < MERGED_CORNERS; k++) {
        const past = tEnd + CORNER_MERGE * (tEnd - t);
        if (!(past < limit)) break;
        const there = piecesAt(past);
        if (there === now || there === piecesAt(tEnd)) break;
        tEnd = past;
      }
    }
    return { tEnd: Math.min(tEnd, limit), now };
  };

  /** When any of a group's first `nc` curves (its RC nodes) first lies
      `limit` volts from where it starts, by `end` at the latest. */
  const movesPast = (sys, t, end, nc, limit) => {
    const v0 = sys.curves.slice(0, nc).map((curve) => coupledValue(curve, 0));
    const far = (u) => {
      for (let i = 0; i < nc; i++) if (Math.abs(coupledValue(sys.curves[i], u - t) - v0[i]) > limit) return 1; // prettier-ignore
      return -1;
    };
    return Math.min(end, firstRoot(far, t, sampleTimes(t, end, sys.scale.fast, sys.scale.oscs ?? sys.scale.osc))); // prettier-ignore
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
  /** Whether the next event `n` is only corners on islands a running wave
      drives and nothing listens on: no event at all, but a curve's slope
      changing — run in order by the next tick, which wakes no sooner than
      its display frame (`wakeFor`). A wave never arrives, so its corners
      come round every cycle for as long as it runs (a rectifier's
      reservoir, ~15 a half-cycle, each a tick of the whole desk); a
      transient's end, and is timed as before. Not where a pin listens (a
      crossing past a corner is timed only once the corner is reached, and
      must not wait for a frame), nor where a relay's coil moves, nor once
      the tick has spent half its corner budget (a fast AC supply's corners
      outrun the frames). */
  const cornerWaits = (n) => {
    if (corners > MAX_CORNERS / 2) return false;
    let driven = null;
    for (const w of n.who) {
      if (w.key != null) return false;
      if (!driven) {
        driven = new Set();
        for (const net of s?.waves.keys() ?? []) if (waveRuns(net)) driven.add(islandOf(net)); // prettier-ignore
      }
      if (!driven.has(w.island)) return false;
      for (const l of heard?.list ?? []) if (islandOf(l.net) === w.island) return false; // prettier-ignore
      for (const id of relays.keys()) if ((isl?.coilIsland.get(id) ?? isl?.chipIsland.get(id) ?? null) === w.island) return false; // prettier-ignore
      // …nor where an op-amp is: its swing's edges are corners, and an
      // output that swings there is the whole point of it (the regrade,
      // 2026-10-22: a comparator on a 10 Hz triangle switched at 6 V and
      // 3 V for 4.5 V, a display frame late).
      for (const id of opAmpChips) if ((isl?.chipIsland.get(id) ?? null) === w.island) return false; // prettier-ignore
    }
    return true;
  };
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
  // The history is replayed on the board this tick is HANDED: a caller that
  // edits the board runs the old one on to the edit's moment first
  // (SimController's #runOnTo), or the stretch since the last tick runs as if
  // the edit had been made at its start.
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
    if (!s) return;
    for (const sp of speakers) noteSpeaker(sp, at);
    ranFrom = { at, ends: speakerEnds() };
  };
  /** The voltage across a speaker at `at`, into its tone (spice/measure.js)
      — read off `ends` (its two nets' nodes, an RC node's as the curve it
      ran on) where given. */
  const noteSpeaker = (sp, at, ends = null) => {
    const a = ends?.[0] ? voltsOf(ends[0], at) : voltsAt(sp.a, at);
    const b = ends?.[1] ? voltsOf(ends[1], at) : voltsAt(sp.b, at);
    if (a == null || b == null) return;
    const island = islandOf(sp.a) ?? islandOf(sp.b);
    const scale = !drawn.size ? 1 : oneIsland() ? drawn.values().next().value.cycle.scale : (drawn.get(island)?.cycle.scale ?? 1); // prettier-ignore
    noteTone(tones, toneKey(sp.id), a - b, at, scale);
    noteCoil(speakerEnergy, sp.id, a - b, at, ends != null);
  };
  /** Each speaker's two RC nodes as they stand: the curves they run on
      from here to the next settle. */
  function speakerEnds() {
    const out = new Map();
    for (const sp of speakers) {
      const ends = [nodes.get(sp.a) ?? null, nodes.get(sp.b) ?? null];
      if (ends.some((node) => node?.curve)) out.set(sp.id, ends);
    }
    return out;
  }
  /** Each speaker's voltage BETWEEN the last settle and this one, along the
      curves its nodes ran on (`ranFrom`, kept as that one left them: by
      this one's start they have run on to here). Read at settles alone (a
      clock's edges), a smooth drive was read where its edges fall, never at
      its crests: a 440 Hz sine through a 1 µF capacitor played nothing, and
      swings came out short by the cosine of their phase. Every eighth of
      its fastest ringing, and at least SPEAKER_SAMPLES across the span. */
  const noteSpeakersBetween = (to) => {
    const from = ranFrom?.at;
    // (Before this tick's first context there are no rails to read a lead
    // on one off: a drawn cycle's first segment, its nodes stood still.)
    if (!s || from == null || !(to > from)) return;
    for (const sp of speakers) {
      const ends = ranFrom.ends.get(sp.id);
      if (!ends) continue; // nothing moved along a curve
      let osc = 0;
      for (const node of ends)
        osc = Math.max(osc, node?.curve?.scale?.osc ?? 0);
      const per = osc > 0 ? Math.ceil(((to - from) * 4 * osc) / Math.PI) : 0;
      const n = Math.min(SPEAKER_SAMPLES_MAX, Math.max(SPEAKER_SAMPLES, per));
      for (let k = 1; k < n; k++) noteSpeaker(sp, from + ((to - from) * k) / n, ends); // prettier-ignore
    }
  };
  /** Whether a speaker is on an island this tick is for (or on none). */
  const speakerInScope = (sp) => {
    if (!due) return true;
    const i = islandOf(sp.a) ?? islandOf(sp.b);
    return i == null || due.has(i);
  };
  /** One digital tick at `at` on the current view, its state kept. */
  // The bench sources' levels the last settle (or rest) ran on — what a
  // cycle's drive signature reads them from (`driveSig`). Until this tick's
  // first settle, the board stands on the inputs it was left on: `before`
  // (null here once read the sources as unknown, and a replay walked before
  // that first settle could never match its record).
  let benchIn = before;
  const settleAt = (at) => {
    if (opts.stats) opts.stats.settles = (opts.stats.settles ?? 0) + 1;
    // The last settle's last pass is its own: folded before this one starts
    // (a fold of nothing after it changes nothing), so `settlePeak` is this
    // settle's alone (a drawn cycle's replay books it — `replaySeg`).
    foldSpikes();
    settlePeak = new Map();
    passes = 0;
    noteSpeakersBetween(at);
    settleTime = at;
    syncRelays(at);
    const inputs = at < target ? before : own;
    benchIn = inputs;
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
    noteLedHeat(at);
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
    benchIn = before;
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
      // An op-amp whose inputs both stand on the nodes' networks is part of
      // the cycle, not a drive of it: its output is solved there with the
      // nodes, and read as a level at its swing — the very moment a schedule
      // stands on — it came out H at one settle and X at the next (the
      // regrade, 2026-10-22: a relaxation oscillator's cycle ended at every
      // other frame).
      const inside = new Set();
      for (const u of c.def.opAmps?.units ?? []) {
        if (onNodes(c.pinNet.get(u.inp)) && onNodes(c.pinNet.get(u.inn))) inside.add(u.out); // prettier-ignore
      }
      for (const [pin, level] of driven.get(c.comp.id) ?? []) {
        if (inside.has(pin)) continue;
        if (onNodes(c.pinNet.get(pin))) parts.push(`${c.comp.id}#${pin}=${level}`); // prettier-ignore
      }
    }
    for (const [id, d] of delivered) parts.push(`${id}=${d.volts}`);
    // A bench source on the nodes' networks — a flag through a diode, a
    // clock through a resistor into the timing capacitor — moves the curves
    // as surely as a chip's output does: a schedule drawn on past its change
    // draws the old frequency.
    for (const c of lastCtx?.clocks ?? []) {
      if (onNodes(c.outNet)) parts.push(`${c.id}~${benchIn?.clockPhase?.get(c.id)}`); // prettier-ignore
    }
    for (const sig of lastCtx?.signals ?? []) {
      if (onNodes(sig.net)) parts.push(`${sig.id}~${benchIn?.signalLevels?.get(sig.id)}`); // prettier-ignore
    }
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
  // Carried from the last tick on this very desk, settled: a cycle slower
  // than a tick is long (the frame's half millisecond) never came round
  // inside one, so an oscillator between 1 and 2 kHz — faster than the desk
  // shows, slower than a tick — was stepped edge by edge and never drawn
  // (the regrade, 2026-10-22: an LM358 at 1.5 kHz, 1.5 s a simulated
  // second). A moment of another drive never matches one of this (`drive`).
  const timelines = new Map(
    prior?.quiet && prior.ran?.document === opts.document && prior.ran?.netlist === opts.netlist // prettier-ignore
      ? [...(prior.timelines ?? [])].map(([key, moments]) => [
          key,
          moments.slice(),
        ])
      : [],
  ); // island → its moments
  let touched = null;
  /** Record the moment on each island stepped now that `keys` names (null:
      every one; on a desk of one island, always it). Returns the islands
      recorded. */
  const record = (crossing, keys = touched) => {
    const out = [];
    if (!nodes.size) return out;
    for (const key of isl?.analog ?? []) {
      if (!live(key)) continue;
      if (keys && !keys.has(key) && !oneIsland()) continue;
      // A cycle's signature says nothing of an inductor's current: with one
      // moving, the island is never taken to have come round.
      if (oneIsland() ? coils.size : [...coils.keys()].some((id) => isl.coilIsland.get(id) === key)) continue; // prettier-ignore
      const own = partOf(nodes, key, islandOf);
      if (!oneIsland() && !own.size) continue;
      const ownListen = partOf(listen, key, listenIsland);
      // An island no pin listens to — an op-amp's relaxation oscillator, a
      // transistor astable — has no crossings, only corners: its moments are
      // those, and what turns round its cycle is which way each node is
      // headed (`headings`). Never recorded, it was never drawn, and stepped
      // edge by edge a 1 nF oscillator ran at a hundredth of true time (the
      // regrade, 2026-10-22).
      const heardHere = oneIsland() ? heard?.list.length : heard?.list.some((l) => islandOf(l.net) === key); // prettier-ignore
      const drive = driveSig(key);
      if (!timelines.has(key)) timelines.set(key, []);
      const timeline = timelines.get(key);
      pushMoment(timeline, {
        t,
        crossing: crossing || !heardHere,
        unheard: !heardHere,
        sig: signatureOf(own, (n) => voltsOf(n, t), heardHere ? ownListen : headings(own), drive), // prettier-ignore
        listen: ownListen,
        nodes: own,
        capFar: partOf(capFar, key, capFarIsland),
        drive,
      }, TIMING_CAP_HZ, slowDrawn); // prettier-ignore
      out.push(key);
    }
    return out;
  };
  /** Which way each of `own`'s nodes is headed now (net → rising), as a
      signature's reads — an unheard island's (`record`). */
  const headings = (own) => {
    const out = new Map();
    for (const [net, n] of own) {
      if (n.driven == null && n.curve) out.set(net, heading(n.curve, t) > 0);
    }
    return out;
  };
  /** Forget the readout edges timed on island `key` (spice/measure.js) —
      and those of a part on no analog island (every one, on a desk of one
      island) — and the tones of the speakers on it. Only ON it: a speaker
      on an island of its own (a square clock through a resistor) is timed
      in true time whatever the others' cycles do, and forgetting its tone
      whenever one of them started or ended silenced it for two periods. */
  const clearMarks = (key) => {
    if (oneIsland()) {
      marks.clear();
      tones.clear();
      return;
    }
    for (const k of [...marks.keys()]) {
      const i = isl.chipIsland.get(k.slice(0, k.lastIndexOf("#")));
      if (i == null || i === key || !isl.analogSet.has(i)) marks.delete(k);
    }
    for (const sp of speakers) {
      const i = islandOf(sp.a) ?? islandOf(sp.b);
      if (i == null || i === key) tones.delete(toneKey(sp.id));
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
    const cycle = { ...next, pins, netlist: opts.netlist, document: opts.document, scope: cycleScope(key), unheard: next.segs.every((seg) => seg.unheard) }; // prettier-ignore
    // It stands at its first segment's start.
    drawn.set(key, { cycle, done: 0, memo: null, memoOwned: false, steady: 0, ledPower: null, ledAmps: null }); // prettier-ignore
    cyclesMoved = true;
    clearMarks(key); // measured again, in the schedule's time
    // Its moments so far are the schedule's now: once it stops being drawn
    // its timeline starts again — one carried across a drawn stretch it has
    // no moments of matched a moment from before it (a 2 kHz 555 drawn at
    // 1.6 periods).
    timelines.delete(key);
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
        if (net && !s.rail(net)) nets.add(net);
      }
    }
    // A chip that reads what the cycle drives — a MOSFET a 555 switches, a
    // gate on its output — is taken INTO the scope, and what it drives with
    // it, until nothing more reads in: its state, pins and outputs are then
    // recorded and put back like the cycle's own (the regrade, 2026-10-22:
    // a 555 into a MOSFET's gate, the commonest PWM there is, was never
    // replayed and woke the desk at every segment). A memory chip is still
    // no part of one.
    const reach = new Set();
    const spread = (list) => {
      for (const net of list) {
        reach.add(net);
        const k = clusterOf.get(net);
        for (const other of k == null ? [] : clusters[k].nets) reach.add(other);
      }
    };
    spread(nets);
    for (let grew = true; grew;) {
      grew = false;
      for (const c of lastCtx.chips) {
        if (chips.has(c.comp.id)) continue;
        if (!c.def.pins.some((p) => LISTENING.has(p.role) && reach.has(c.pinNet.get(p.n)))) continue; // prettier-ignore
        if (c.memory) return null;
        chips.add(c.comp.id);
        const more = [...c.pinNet.values()].filter((net) => net && !s.rail(net) && !nets.has(net)); // prettier-ignore
        for (const net of more) nets.add(net);
        spread(more);
        grew = true;
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
    sameChipState(a, b) &&
    a.levels.every((lv, i) => lv === b.levels[i]) &&
    a.driven.every((m, i) => sameMap(m, b.driven[i])) &&
    a.committed.every((m, i) => sameMap(m, b.committed[i]));
  const sameChipState = (a, b) =>
    a.state.every((st, i) => sameData(st, b.state[i])) &&
    a.pins.every((m, i) => sameMap(m, b.pins[i]));
  /** Whether a segment begins where its record did (`m.pre`). On an island
      no pin listens to (`unheard` — an op-amp relaxation oscillator, a
      transistor astable), the logic levels its nets and outputs stand at as
      it begins are no reading of anything — only what each net is shown
      as — and at a swing's corner they come in as X or as the level, as the
      last settle happened to leave them: matched on them, the cycle drawn at
      its own rate never went steady (the fourth regrade, 2026-10-22). Its
      chips' own state and the pins they read still must match. */
  const sameStart = (st, a, b) =>
    st.cycle.unheard ? sameChipState(a, b) : sameSegmentState(a, b);
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
    if (!sameStart(st, segmentState(st), m.pre)) return false;
    const { chips, nets } = st.cycle.scope;
    // A chip in scope still HOLDING an output change (a capped settle left
    // one in `pending`) is not in any recorded "before": its record ends with
    // nothing held, and putting it back would leave the hold to land later,
    // on top of the replay. Settle it.
    if (pending.size && chips.some((id) => pending.has(id))) return false;
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
    // A record is of a scope with nothing HELD at either end — what
    // `replaySeg` puts back assumes it (a hold that lands inside the settle
    // would be replayed later as if it were still to come).
    const holding = () => pending.size > 0 && st.cycle.scope.chips.some((id) => pending.has(id)); // prettier-ignore
    const pre = st.cycle.scope && !holding() ? segmentState(st) : null;
    settleAt(at);
    noteLedPower(key, st, i);
    const drive = driveSig(key);
    const ok = sameDrive(drive, seg.drive, s.vHigh);
    let same = false;
    if (
      pre &&
      ok &&
      result.settled &&
      !result.memWrites?.length &&
      !holding()
    ) {
      const post = segmentState(st);
      const m = st.memo?.[i];
      same = Boolean(m) && m.quantum === pace().quantum && sameStart(st, pre, m.pre) && sameSegmentState(post, m.post) && sameDrive(drive, m.drive, s.vHigh); // prettier-ignore
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
  /** What each LED on island `key` dissipates as its drawn cycle's segment
      `i` begins, watts — read off the solve this segment's settle left, so
      a cycle drawn slower than it runs heats its LEDs by its own duty, not
      by whichever segment a tick lands on (a fast 555 into an LED it should
      only warm burnt it in 2 s, the regrade, 2026-10-22). Kept per segment
      (a new array each time: the last tick's analog shares the old one). */
  const noteLedPower = (key, st, i) => {
    const leds = lampTopology(opts.document, opts.netlist).junctions.filter((j) => heated(j) && (islandOf(j.anode) === key || islandOf(j.cathode) === key)); // prettier-ignore
    if (!leds.length) return;
    const flows = volt.report().junctions;
    const watts = new Map();
    const amps = new Map();
    for (const j of leds) {
      watts.set(j.key, burnt.has(j.key) ? 0 : junctionWatts(j, flows.get(j.key))); // prettier-ignore
      if (!j.diode) amps.set(j.key, burnt.has(j.key) ? 0 : (flows.get(j.key)?.amps ?? 0)); // prettier-ignore
    }
    const next = st.ledPower ? st.ledPower.slice() : new Array(st.cycle.segs.length); // prettier-ignore
    next[i] = watts;
    st.ledPower = next;
    const lit = st.ledAmps ? st.ledAmps.slice() : new Array(st.cycle.segs.length); // prettier-ignore
    lit[i] = amps;
    st.ledAmps = lit;
  };
  /** The LEDs hot enough to be heading for a burn (`hotUntil`, set at a
      tick's end): read at every settle this tick, not only at its end. */
  const hotLeds = lampTopology(opts.document, opts.netlist).junctions.filter((j) => heated(j) && ledHeats.get(j.key)?.hotUntil > target); // prettier-ignore
  /** Each hot LED's power at a settle's end, `at`, into its energy since its
      last tick — held from one settle to the next, as its current is. A
      tick spans many cycles of an oscillator the desk does not draw (a 555
      at 68 kHz), and booked at its end alone the heat took whatever phase
      the tick landed on for the whole half millisecond: such an LED burnt
      in a third of the time a slower one did (the regrade, 2026-10-22). One
      on a drawn cycle is booked by its cycle's mean instead (`drawnSteady`). */
  const noteLedHeat = (at) => {
    if (!hotLeds.length) return;
    let flows = null;
    for (const j of hotLeds) {
      if (drawn.has(islandOf(j.anode) ?? islandOf(j.cathode))) continue;
      flows ??= volt.report().junctions;
      const w = burnt.has(j.key) ? 0 : junctionWatts(j, flows.get(j.key));
      const was = ledEnergy.get(j.key);
      if (!was) ledEnergy.set(j.key, { from: at, t: at, w, e: 0 });
      else if (at >= was.t) ledEnergy.set(j.key, { from: was.from, t: at, w, e: was.e + was.w * (at - was.t), read: true }); // prettier-ignore
    }
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
    return [...ps].filter(([key, p]) => tooSlow(drawn.get(key)) || !sameDrive(driveSig(key), p.seg.drive, s.vHigh)).map(([key]) => key); // prettier-ignore
  };
  // The drawn islands stood where their schedule has them at the tick's own
  // moment (`runCycles`, or — beside islands stepped crossing by crossing —
  // at the first settle there).
  const stood = new Set();
  /** Each island in `recorded` come round to a moment it has been at: drawn
      by its schedule from now (`enterCycle`) — standing at its first segment
      now, beside islands still stepped. Returns the islands entered. */
  const comeRound = (recorded) => {
    const entered = [];
    for (const key of recorded) {
      const from = cycleStart(timelines.get(key), TIMING_CAP_HZ, s.vHigh, slowDrawn); // prettier-ignore
      if (from < 0) continue;
      enterCycle(key, from);
      entered.push(key);
    }
    if (!entered.length || !anySteps()) return entered;
    for (const key of entered) {
      const seg = drawn.get(key).cycle.segs[0];
      applySeg(key, seg, seg.t, t);
      if (t >= target) stood.add(key);
    }
    return entered;
  };
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
        if (tooSlow(drawn.get(key)) || !sameDrive(driveSig(key), p.seg.drive, s.vHigh)) endCycle(key); // prettier-ignore
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
        const entered = comeRound(record(true));
        touched = new Set();
        // Every island drawn: the schedules draw the rest of the tick.
        if (entered.length && !anySteps()) continue;
      }
    }
    choose: for (;;) {
      let next = nextCrossing(t);
      // A curve reaching a corner (and nothing reading anything new there)
      // is linearized again where it is, with no settle: nothing changed
      // but the slope it runs at.
      const due = (n) =>
        n.at <= target || n.at - Math.max(t, target) <= FAST_WINDOW_S;
      let jumped = false;
      let spent = false;
      // (A corner past the moment that waits for the next frame waits:
      // run on to it here, the tick's readings were of a moment past the
      // one asked for — `cornerWaits`.)
      const ahead = (n) => n.at > target && cornerWaits(n);
      while (
        next &&
        due(next) &&
        !ahead(next) &&
        next.who.every((w) => w.key == null)
      ) {
        // prettier-ignore
        if (++corners > MAX_CORNERS) {
          spent = true;
          break;
        }
        t = Math.max(t, next.at);
        updateNodes(t, false);
        const recorded = record(false, new Set(next.who.map((w) => w.island)));
        // …unless the corner is a regenerative one: an op-amp with positive
        // feedback (a Schmitt trigger) entering its linear region swings to
        // its other rail in the solve at the corner, and a pin reading its
        // output finds its statement on the far side of its threshold with
        // no crossing ahead to tell it — it read the swing only at the next
        // event, half a cycle late. Read like a crossing, it is settled here.
        const hit = detectFlips(t);
        if (hit.size) {
          for (const key of hit) touched?.add(key);
          // Spent from its island's budget as a crossing is, so a Schmitt
          // that chatters at its corner is capped and backs off.
          if (t < target) {
            for (const key of hit) {
              if (bump(caught, key) >= MAX_CATCHUP_EVENTS) catchUp?.delete(key); // prettier-ignore
            }
            if (!anyLive()) {
              t = target;
              touched = null;
            }
          } else {
            for (const key of hit) {
              if (bump(events, key) >= MAX_ANALOG_EVENTS) capped.add(key);
            }
            if (!anySteps()) break outer;
          }
          jumped = true;
          break;
        }
        // An unheard island's corner is its moment (`record`): come round,
        // it is drawn from here — and with every island drawn, the
        // schedules draw the rest of the tick.
        if (comeRound(recorded).length && !anySteps()) {
          jumped = true;
          break;
        }
        next = nextCrossing(t);
      }
      if (jumped) continue outer;
      // The corner budget spent past the tick's own moment: the corners
      // still ahead are the next tick's (it wakes for them). Taken as
      // crossings, each was a settle that spent its island's event budget,
      // which capped it and backed it off as a chatter — on a board that
      // was not oscillating at all. (Short of the moment, a corner past
      // the budget is still settled, spending the catch-up budget, which
      // bounds a late tick's history.)
      if (next && ((spent && next.at >= target) || ahead(next))) next = null;
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
  // An LED's junction temperature NOW: what it was heading for since its
  // last tick, lagged (`ledHeats`) — ambient when it carried nothing.
  // A hot one read at every settle since then heads for its MEAN power's
  // temperature over the stretch (`ledEnergy`), not its last tick's.
  const heatNow = (j) => {
    const was = ledHeats.get(j.key);
    if (!was) return AMBIENT_C;
    const dt = Math.max(0, target - was.at);
    let steady = was.steady;
    const e = ledEnergy.get(j.key);
    if (
      e?.read &&
      dt > 0 &&
      Math.abs(e.from - was.at) < 1e-12 &&
      target >= e.t
    ) {
      const mean = (e.e + e.w * (target - e.t)) / dt;
      steady = AMBIENT_C + rthSlow(j) * mean;
    }
    return ledHeatAfter(was.tj, steady, dt, tauOf(j));
  };
  const verdictOf = (j, f) =>
    j.diode
      ? diodeVerdict(j.spec, f.amps, f.volts, heated(j) ? heatNow(j) : null)
      : ledVerdict(j.spec, f.amps, f.volts, heatNow(j));
  const lampsNow = (judged = true) => {
    for (let round = 0; ; round++) {
      const rep = volt.report();
      if (!judged) return verdicts(rep);
      const burning = [];
      for (const j of junctionList) {
        const f = burnt.has(j.key) ? null : rep.junctions.get(j.key);
        if (!f) continue;
        const v = verdictOf(j, f);
        if (v.burns) burning.push({ j, v });
      }
      if (!burning.length || round > junctionList.length) return verdicts(rep);
      for (const { j, v } of burning) {
        burnt.add(j.key);
        // (An LED's `tj` is the one its current heads for — what the
        // warning says it "would heat its junction to" — not the maximum its
        // lag has just reached.)
        const tj = heated(j) ? steadyTemp(j, v) : v.tj;
        burntNow.push({ key: j.key, comp: j.comp, seg: j.seg, diode: j.diode, amps: v.amps, tj, tjMax: j.spec.tjMaxC }); // prettier-ignore
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
      lamps.set(j.key, { ...verdictOf(j, f), burnt: false });
    }
    return { lamps, currents: rep.currents, draws: rep.draws, outputs: rep.outputs, stress: rep.stress, transistors: rep.transistors, switches: rep.switches, devices: rep.devices, brownouts: rep.brownouts, analog: rep.analog }; // prettier-ignore
  };
  // A supply past its limit at its set voltage is freed for the NEXT tick
  // (`measure`, below): what a junction carries at the set voltage until
  // then is not what it carries — a reservoir charging through a rectifier
  // at Run drew 94 A from a supply limited to 1 A, and burnt the diode. So
  // a tick that frees a supply judges no junction; the next, soon
  // (`FREE_WAKE_S`), judges each on the limit.
  const freeing = () => [...freeNext].some((id) => !free.has(id));
  let lamps = lampsNow(false);
  // Demand is measured with every supply at its SET voltage (spice/supply.js
  // — measured at a drooped one, the droop would chase its own tail): the
  // passes' own solution while nothing droops or sags, else a fresh one.
  const bookAtSet = () =>
    [...delivered.values()].some((d) => Math.abs(d.volts - d.set) > DROOP_EPS) || // prettier-ignore
    drops.size > 0 ||
    [...lastCtx.chipStatus.values()].some((st) => st.status === CHIP_STATUS.UNDERPOWERED); // prettier-ignore
  const measure = () => {
    // A supply the solve holds (on its limit — `free`) delivers what its
    // own device reads, every draw on it included.
    const held = new Map();
    for (const [id, a] of lamps.analog ?? []) if (a.kind === "psu") held.set(id, a); // prettier-ignore
    const out = measureDroop(held);
    // Which supplies the next tick lets the solve hold: one past its limit
    // at its set voltage (it drooped this tick, a moment's stand-in), and
    // one held still on its limit, or near it (`FREE_RELEASE`). Under it, in
    // its constant-voltage piece, it is a rail again.
    const next = new Set();
    inrushCaps.clear();
    const freeable = new Map(freeSupplies(opts.document, opts.netlist, new Set(out.supplies.keys())).map((p) => [p.id, p.plus])); // prettier-ignore
    for (const [id, sup] of out.supplies) {
      if (!freeable.has(id)) continue;
      const h = held.get(id);
      if (h ? h.limited || h.amps + capsCarry(freeable.get(id)) >= FREE_RELEASE * sup.limit : inrush(id, freeable.get(id), sup) || sup.limited) next.add(id); // prettier-ignore
    }
    freeNext = next.size === free.size && [...next].every((id) => free.has(id)) ? free : next; // prettier-ignore
    return out;
  };
  /** Does a supply's + have capacitors straight across to a rail that are
      short of the voltage it stands at, by more charge than its limit (less
      its load) delivers in `INRUSH_S`? Held at the rail's voltage, they
      jumped to it — 1000 µF across a 0.1 A supply was at its full 5 V from
      Run on, not 50 ms later. Freed, the next tick charges them from the
      charge they held (`inrushCaps`, which keep it; none at Run) — and so
      for a supply freed by its load alone (`sup.limited`), whose capacitors
      have no current to spare at all. */
  const inrushCaps = new Set();
  const inrush = (id, plus, sup) => {
    const room = sup.limit - sup.amps;
    if (!s || free.has(id)) return false;
    const vp = voltsAt(plus, t);
    if (vp == null) return false;
    // A held supply stands up to its limit's worth of `PSU_SOURCE_OHMS` under
    // its set voltage: what its capacitors were left at, gone back to a rail,
    // is no charge to make (it was freed again on the next tick, every tick).
    const floor = sup.limit * PSU_SOURCE_OHMS + DROOP_EPS;
    const caps = [];
    let coulombs = 0;
    for (const l of s.trace.capacitors(plus)) {
      if (l.far === plus || !s.rail(l.far) || !(l.value > 0)) continue;
      const vf = voltsAt(l.far, t);
      if (vf == null) continue;
      const across = charge.get(l.id) ?? 0;
      const held = s.capPins.get(l.id)?.a === plus ? across : -across;
      const rise = vp - vf - held;
      if (rise > floor) coulombs += rise * l.value;
      caps.push(l.id);
    }
    if (!(coulombs > 0) || (room > 0 && !(coulombs / room > INRUSH_S))) return false; // prettier-ignore
    for (const c of caps) inrushCaps.add(c);
    return true;
  };
  /** What the capacitors on a held supply's + deliver to its loads as it
      stands, amps (none while they charge): its loads draw that beside the
      supply. A capacitor across it, charged to the set voltage the moment
      it was freed, carries the load for now — read by what the supply
      delivered then, it was a rail again at once, its limit gone and the
      overload held at 5 V for good (the regrade, 2026-10-22). */
  const capsCarry = (plus) => {
    const n = nodes.get(plus);
    const cand = s?.candidates.get(plus);
    if (!n?.curve || !cand) return 0;
    return Math.max(0, -rateOf(n.curve, t) * cand.farads);
  };
  const measureDroop = (held) => {
    const base = { doc: opts.document, netlist: opts.netlist, ctx: lastCtx, config, held }; // prettier-ignore
    if (!bookAtSet()) return measureSupplies({ ...base, draws: lamps.draws });
    // …and, while a supply droops, its demand at what it delivered too: a
    // load that is not resistive needs both to find where it meets its
    // limit (spice/supply.js `droopVolts`). Only where a regulator stands
    // STARVED — on, sourcing nothing — which the proportional droop can hold
    // it at for good (its input pulled to what its output already stands
    // at). Every other load keeps the proportional droop, which a chip that
    // turns on as its supply rises (and off as it falls) needs to stay put.
    let starved = false;
    let pinched = false;
    for (const [, a] of lamps.analog ?? []) {
      if (a.kind !== "regulator") continue;
      starved ||= Boolean(a.starved);
      pinched ||= Boolean(a.starved || a.dropout);
    }
    const at = new Map();
    const atDelivered = measureSupplies({ ...base, draws: lamps.draws });
    for (const [id, sup] of atDelivered.supplies) {
      const d = delivered.get(id);
      if (d && d.set === sup.set) at.set(id, { volts: d.volts, demand: sup.demand }); // prettier-ignore
    }
    const out = measureSupplies({ ...base, draws: volt.report({ atSet: true }).draws, delivered: starved ? at : null }); // prettier-ignore
    // A supply on its limit whose load, at what it delivers, draws other
    // than its limit has not found its place where a regulator is pinched
    // by it (in dropout, or starved): the load moves (its output capacitor
    // charging), so it is looked at again soon.
    droopMoving = pinched && [...out.supplies].some(([id, sup]) => sup.limited && at.has(id) && Math.abs(at.get(id).demand - sup.limit) > DROOP_SETTLED * sup.limit); // prettier-ignore
    return out;
  };
  let droopMoving = false;
  let measured = measure();
  // (Judged only where the read so far has one burning: most ticks none.)
  if (!freeing() && [...lamps.lamps.values()].some((v) => v.burns)) {
    const burns = burntNow.length;
    lamps = lampsNow();
    // (A burn re-solves the networks: the voltages shown are those after
    // it, beside the currents — the anode of an LED burnt off 5 V through
    // 10 Ω read the 3.26 V it stood at before.)
    if (burntNow.length > burns) {
      collectVolts();
      measured = measure();
    }
  }
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
  // A value a DRAWN cycle has been read at before is no move either: a
  // tick ends in whichever phase it lands on, and an oscillator drawing
  // 120 mA in one phase read its own wire's drop as 1.17 mV, then none,
  // every other tick — and every move ended the schedule (the regrade,
  // 2026-10-22: a 6.8 kHz 555 into 22 Ω ran slower than real time).
  // …but only while nothing OUTSIDE the drawn cycles moved: a load switched
  // on beside a drawn 555 and off again took the supply back to a value
  // seen before it came on, and that real move was hidden — the rail stood
  // at its loaded volts for good (the third regrade, 2026-10-22).
  const outsideMoved = () => {
    const before = opts.warmStart;
    if (!before || !result?.netLevels) return true;
    for (const [net, lv] of result.netLevels) {
      if (before.get(net) === lv) continue;
      const k = islandOf(net);
      if (k == null || !drawn.has(k)) return true;
    }
    return false;
  };
  if (!drawn.size || outsideMoved()) swing.clear();
  const swingOf = (key, v) => {
    if (!drawn.size) return false;
    const seen = swing.get(key) ?? [];
    const known = seen.some((x) => Math.abs(x - v) <= DROOP_EPS);
    if (!known) swing.set(key, [...seen, v].slice(-SWING_KEPT));
    return known;
  };
  const held = new Map();
  for (const [id, drop] of sag.drops) {
    const was = drops.get(id);
    swingOf(`drop:${id}`, was ?? 0);
    if (was != null && Math.abs(was - drop) <= DROOP_EPS) held.set(id, was);
    else if (swingOf(`drop:${id}`, drop)) {
      if (was != null) held.set(id, was);
    } else {
      // New, or moved (every drop left is past DROOP_EPS, so one from
      // nothing has moved too).
      held.set(id, drop);
      moved = true;
    }
  }
  for (const [id, was] of drops) {
    if (sag.drops.has(id)) continue;
    swingOf(`drop:${id}`, was);
    if (swingOf(`drop:${id}`, 0)) held.set(id, was);
    else moved = true;
  }
  drops.clear();
  for (const [id, drop] of held) drops.set(id, drop);
  for (const [id, sup] of supplies) {
    const was = delivered.get(id);
    const used = was && was.set === sup.set ? was.volts : sup.set;
    swingOf(`psu:${id}`, used);
    if (
      Math.abs(used - sup.volts) > DROOP_EPS &&
      !swingOf(`psu:${id}`, sup.volts)
    ) {
      moved = true;
      delivered.set(id, { set: sup.set, volts: sup.volts });
    } else if (free.has(id) && !freeNext.has(id)) {
      // A held supply going back to a rail is one at what the solve held it
      // at: kept at the corner it was last moved to, a millivolt down
      // (`PSU_SOURCE_OHMS` × its limit), it stood there for good.
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
    tones.clear();
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
    const burns = burntNow.length;
    collectVolts();
    lamps = lampsNow(!freeing());
    if (burntNow.length > burns) collectVolts();
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
  // A junction burnt at the tick's end opened its networks after every
  // curve was made: they run on as though it conducted (an RC node an LED
  // clamped sat at its 2.55 V, nothing waking it), so the next tick, soon,
  // makes them again.
  if (burntNow.length) unsettled = true;
  // Each LED's heat as this tick leaves it: where it stands now, and what it
  // heads for from here on — its current as the tick ends, booked until the
  // next (exact for a square drive, its PWM edges ticks). One heading past its
  // maximum is woken when it gets there, or sooner to read its current again
  // (`LED_HEAT_STEP_S`); one cold and dark is forgotten. (`burnWakeAt` is
  // the speakers' wake too, below.)
  let burnWakeAt = null;
  /** An LED on a drawn cycle: the temperature its cycle's MEAN power heads
      for — each segment's power from its start to the next, over the
      period — once every segment has been read (`noteLedPower`); else null. */
  /** The lamps as a frame should show them: an LED on a DRAWN cycle at its
      brightness over the cycle — each segment's from its start to the
      next, over the period — not the phase this tick ended in (the third
      regrade, 2026-10-22: woken a frame at a time, a 6.8 kHz PWM LED behind
      a MOSFET showed 1.11, 1.03, 0.08 by turns where it should glow 0.56).
      Its current and verdicts stay the tick's. */
  const drawnLamps = (map) => {
    if (!drawn.size) return map;
    let out = map;
    for (const j of junctionList) {
      if (j.diode || burnt.has(j.key)) continue;
      const st = drawn.get(islandOf(j.anode) ?? islandOf(j.cathode));
      const segs = st?.cycle.segs;
      const v = map.get(j.key);
      if (!segs || !st.ledAmps || !v) continue;
      let sum = 0;
      let complete = true;
      for (let k = 0; k < segs.length && complete; k++) {
        const amps = st.ledAmps[k]?.get(j.key);
        if (amps == null) complete = false;
        else {
          const end = k + 1 < segs.length ? segs[k + 1].at : st.cycle.period;
          const seen = ledVerdict(j.spec, amps, 0);
          sum += (seen.lit ? seen.level : 0) * (end - segs[k].at);
        }
      }
      if (!complete) continue;
      const level = sum / st.cycle.period;
      if (out === map) out = new Map(map);
      out.set(j.key, { ...v, lit: level > 0, level });
    }
    return out;
  };
  const drawnSteady = (j) => {
    const st = drawn.get(islandOf(j.anode) ?? islandOf(j.cathode));
    const segs = st?.cycle.segs;
    if (!segs || !st.ledPower) return null;
    let energy = 0;
    for (let k = 0; k < segs.length; k++) {
      const w = st.ledPower[k]?.get(j.key);
      if (w == null) return null;
      const end = k + 1 < segs.length ? segs[k + 1].at : st.cycle.period;
      energy += w * (end - segs[k].at);
    }
    return AMBIENT_C + rthSlow(j) * (energy / st.cycle.period);
  };
  for (const j of junctionList) {
    if (!heated(j)) continue;
    const v = lamps.lamps.get(j.key);
    if (!v || v.burnt) {
      ledHeats.delete(j.key);
      ledEnergy.delete(j.key);
      continue;
    }
    const tj = heatNow(j);
    const steady = drawnSteady(j) ?? slowTemp(j, v);
    const was = ledHeats.get(j.key);
    ledEnergy.delete(j.key);
    if (
      tj - AMBIENT_C < 1e-3 &&
      steady - AMBIENT_C < 1e-3 &&
      !(was?.hotUntil > target)
    ) {
      ledHeats.delete(j.key);
      continue;
    }
    // Hot — its current, at some tick, heading past half way to its maximum
    // — it is read at every settle for a second from then (`noteLedHeat`).
    const hotUntil = steady - AMBIENT_C >= HOT_LED_SHARE * (j.spec.tjMaxC - AMBIENT_C) ? target + HOT_LED_HOLD_S : (was?.hotUntil ?? null); // prettier-ignore
    ledHeats.set(j.key, { tj, steady, at: target, ...(hotUntil > target ? { hotUntil } : {}) }); // prettier-ignore
    // Held until the next settle at the power `steady` stands for: a drawn
    // cycle's mean, not the phase this tick ended in, should the island
    // stop being drawn before then.
    if (hotUntil > target) ledEnergy.set(j.key, { from: target, t: target, w: (steady - AMBIENT_C) / rthSlow(j), e: 0 }); // prettier-ignore
    // (A diode's die adds its own rise at the instant: its package burns it
    // that much short of Tj max.)
    const die = j.diode ? (j.spec.rthFast ?? 0) * Math.abs(v.volts * v.amps) : 0; // prettier-ignore
    const dt = ledBurnIn(tj, steady, j.spec.tjMaxC - die, tauOf(j));
    if (Number.isFinite(dt)) burnWakeAt = Math.min(burnWakeAt ?? Infinity, target + Math.min(dt, LED_HEAT_STEP_S)); // prettier-ignore
  }
  // Each speaker's coil as this tick leaves it: its heat, the MEAN power in
  // it since its last tick (`coilMeanWatts` — the voltage across it read at
  // every settle and along its curves between, so a PWM is its duty and a
  // capacitor's kick its energy), lagged. Past its rating it warns; at twice
  // it the coil burns OPEN for the rest of the run — in `burnt`, so open
  // from the next tick, which comes soon. One on an island this tick is not
  // for keeps what it had.
  const speakerWarnings = [];
  for (const sp of speakers) {
    if (burnt.has(sp.key)) {
      speakerEnergy.delete(sp.id);
      continue;
    }
    if (!speakerInScope(sp)) continue;
    const was = speakerHeats.get(sp.id);
    const va = nodeVolts.get(sp.a);
    const vb = nodeVolts.get(sp.b);
    const across = va != null && vb != null ? va - vb : (speakerEnergy.get(sp.id)?.v ?? 0); // prettier-ignore
    // (Booked over the stretch the energy spans — from its last tick, or
    // from its first reading: a coil that had cooled to nothing was
    // forgotten, and its next stretch is booked all the same.)
    const mean = coilMeanWatts(speakerEnergy, sp, across, target);
    const watts = mean?.watts ?? across ** 2 / sp.impedance;
    const heat = mean ? speakerHeatAfter(was?.heat ?? 0, watts, mean.span) : (was?.heat ?? 0); // prettier-ignore
    // (A wake timed to the burn lands on it to the last few ulps.)
    if (heat >= SPEAKER_SMOKE_W * (1 - 1e-9)) {
      burnt.add(sp.key);
      speakerHeats.delete(sp.id);
      speakerEnergy.delete(sp.id);
      unsettled = true;
      speakerWarnings.push({ type: "speaker-burnt", comp: sp.id, watts, limit: SPEAKER_SMOKE_W }); // prettier-ignore
      continue;
    }
    if (heat < 1e-9 && watts < 1e-9) {
      speakerHeats.delete(sp.id);
      continue;
    }
    speakerHeats.set(sp.id, { heat, watts, at: target });
    // Warm past its rating, and still carrying more than it: a moment's
    // surge into the capacitor before it says nothing.
    if (heat >= SPEAKER_RATED_W * (1 - 1e-9) && watts > SPEAKER_RATED_W) {
      speakerWarnings.push({ type: "speaker-power", comp: sp.id, watts, limit: SPEAKER_RATED_W }); // prettier-ignore
    }
    // Woken by the larger of the mean and the moment's power: a stretch
    // that only began at its end (the supply coming up a few ns into the
    // first tick) books nothing, and 3 W across the coil from then on must
    // still wake it.
    const dt = speakerReadIn(heat, Math.max(watts, across ** 2 / sp.impedance)); // prettier-ignore
    if (Number.isFinite(dt)) burnWakeAt = Math.min(burnWakeAt ?? Infinity, target + dt); // prettier-ignore
  }
  for (const id of [...speakerEnergy.keys()]) {
    if (!speakers.some((sp) => sp.id === id)) speakerEnergy.delete(id);
  }
  // Each inductor's current as this tick leaves it.
  for (const [id, curve] of coils) coilAmps.set(id, valueAt(curve, t));
  for (const [id, away] of coilsAway) coilAmps.set(id, awayAmps(away, t));
  // Each capacitor's charge as this tick leaves it, wherever both its nets
  // have a voltage; one with a lead floating keeps what it held, and one a
  // supply is being freed to charge (`inrush`) what it held before the rail.
  if (s) {
    const known = (net) =>
      net == null ? null : (capVolts.get(net) ?? voltsAt(net, t));
    const charging = freeing() ? inrushCaps : EMPTY_SET;
    for (const [id, { a, b }] of s.capPins) {
      if (charging.has(id)) continue;
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
    // Not a supply already on its limit by its steady draw: any spike at all
    // passed it, and the advice — a 100 nF beside the chips — is no answer
    // to a load too big for it, which the supply's own warning says (the
    // fourth regrade, 2026-10-22: a 555 into 8 Ω on 250 mA).
    if (spike > 0 && peak > sup.limit && !sup.limited) {
      spikeWarnings.push({ type: "supply-spike", psu: id, peak, limit: sup.limit }); // prettier-ignore
    }
  }
  // The regulators and electronic loads: what each shows, what each warns,
  // and a regulator past its dissipation shut down from the next tick until
  // it has cooled.
  const bench = benchWarnings(lamps.analog, thermal, target, heats);
  // A speaker burnt open says so where its hover and its smoke read it.
  for (const sp of speakers) {
    if (burnt.has(sp.key)) bench.readings.set(sp.id, { burnt: true });
  }
  const { loads, warnings: loadWarnings, overloaded } = outputLoads(lamps, kicksNow); // prettier-ignore
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
  //   · a `conflict` that is only OPEN-COLLECTOR outputs, one sinking and the
  //     rest unknown (`wiredLow`) — a wired-AND: an unknown open-collector
  //     output either sinks too or lets go, and the LOW one holds the net
  //     either way. The solve reads it LOW, as the logic engine now does
  //     (sim/levels.js `OC_X`, its alone — under these hooks the digital
  //     solve still fights it, so the solve can say where the LOW does NOT
  //     hold: a stiff pull-up, a Zener feeding in).
  const shortStands = viaShortMeter(lastCtx, result.channels, opts, lamps.currents, supplies); // prettier-ignore
  const wiredVil = familyParams(config, "74LS").vilV;
  const wiredNets = new Set(
    result.warnings
      .filter(
        (w) =>
          w.type === "conflict" &&
          wiredLow(lastCtx, driven, w.net, {
            channels: result.channels,
            volts: nodeVolts.get(w.net) ?? null,
            vil: wiredVil,
            signalLevels: opts.signalLevels,
          }),
      )
      .map((w) => w.net),
  );
  const warnings = [
    ...result.warnings.filter(
      (w) =>
        !RETIRED.has(w.type) &&
        !(w.type === "short" && w.via && !shortStands(w.net)) &&
        !(w.type === "conflict" && wiredNets.has(w.net)),
    ),
    ...loadWarnings,
    ...stressWarnings,
    ...spikeWarnings,
    ...lampWarnings(lamps.lamps, burntNow),
    ...speakerWarnings,
    ...[...kicksNow].filter(([comp]) => !kickedBefore.has(comp)).map(([comp, k]) => kickWarning(comp, k)), // prettier-ignore
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
  // tripped goes off at once; one heating is woken when its heat reaches
  // its shutdown.
  for (const until of thermal.values()) later(until);
  if (bench.tripped) later(target + TRIP_S);
  later(bench.tripAt);
  later(burnWakeAt);
  if (droopMoving) later(target + DROOP_WAKE_S);
  // A supply drooped this tick that, measured again, is under its limit
  // (a regulator's output capacitor charged in the tick that pulled it down)
  // is put back at its set volts by the next — soon, or it read 5.98 V of
  // its 9 until something else ticked the desk.
  const droopStale = [...supplies.values()].some((sup) => !sup.limited && Math.abs(sup.volts - sup.set) > DROOP_EPS); // prettier-ignore
  if (droopStale) later(target + DROOP_WAKE_S);
  // A network first left out of balance is solved again soon (only once —
  // one that never balances must not tick the desk every half millisecond).
  const imbalanced = Boolean(s && volt.newlyUnsettled());
  if (imbalanced) later(target + MIN_SHOWN_S);
  // A supply come on its limit: held by the solve from the next tick, soon.
  if ([...freeNext].some((id) => !free.has(id))) later(target + FREE_WAKE_S);
  // A supply held on its limit whose + is still on its way along its
  // capacitors' curve: what it delivers moves with it, and so does its
  // readout — read again a display frame on, or a capacitor across one
  // overloaded showed the set voltage it fell from until something else
  // ticked the desk.
  const heldMoving = freeSupplies(opts.document, opts.netlist, freeNext).some(
    (p) => {
      const n = nodes.get(p.plus);
      return n?.curve != null && n.driven == null && !hasArrived(n.curve, target, config.gapPercent); // prettier-ignore
    },
  );
  if (heldMoving) later(target + ANALOG_FRAME_S);
  // A relay pulled in whose coil a switch has shorted out of the network:
  // its current dies away round the loop through its winding (`coilsAway`),
  // with no curve left for a crossing to be timed on — so its drop-out is
  // timed in closed form, or it held its contacts until something else
  // ticked the desk.
  for (const [id, relay] of relays) {
    const away = coilsAway.get(id);
    if (!away || relayOn.get(id) !== true) continue;
    if (!(away.tau > 0) || !Number.isFinite(away.tau)) continue;
    const drop = relay.dropOut * relay.rated;
    const amps = Math.abs(away.amps);
    if (!(drop > 0) || !(amps > drop)) continue;
    const at = away.at + away.tau * Math.log(amps / drop);
    if (at > target) later(at);
  }
  // Each analog island's own next event (features/12): what the next tick
  // reads to know which islands it is for. An island this tick was not for
  // keeps the one it had — nothing on it moved.
  const islandNext = new Map();
  const scheduled = !UNSCOPED && spice?.scoped !== false && isl != null && isl.groupOf.size > 1; // prettier-ignore
  // A corner that waits (`cornerWaits`) wakes the desk no sooner than its
  // next display frame — which a sample would otherwise read past the
  // corner, on a curve no longer true there: the frame is a tick.
  // What each wave is (the analyzer's, and the frames' own: an AC supply's
  // period is its frequency's — read as a clock's, it framed 6× too often).
  const waveKindsNow = () => new Map([...(s?.waves ?? [])].map(([net, w]) => [net, { wave: w.wave, amplitude: w.amplitude, offset: w.offset, ...(w.ac ? { swing: w.swing, hz: w.hz, ac: true, shift: acShift.get(net) ?? 0 } : {}) }])); // prettier-ignore
  const cornerFrame = nextDisplayFrame({ nodes, coils, waves: waveIds(), waveKinds: waveKindsNow(), inputs: own }, target, t, { gapPercent: config.gapPercent, waveFrames: spice?.waveFrames !== false }) ?? target + ANALOG_FRAME_S; // prettier-ignore
  const wakeFor = (next) => {
    if (!next) return null;
    return cornerWaits(next) ? Math.max(next.at, cornerFrame) : next.at;
  };
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
        at = c
          ? Math.max(next?.at ?? target, target + c.backoff)
          : wakeFor(next);
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
    if (!(drawn.size && oneIsland()) && !chatterAll) later(wakeFor(nextCrossing(t, (k) => k == null || calm(k)))); // prettier-ignore
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
    frameAt = nextDisplayFrame({ nodes: quiet(nodes, islandOf), coils: quiet(coils, (id) => isl?.coilIsland.get(id) ?? null), waves: quiet(waveIds(), islandOf), chatter: chatterAll ? chatterNow.values().next().value : null, waveKinds: waveKindsNow(), inputs: own }, target, t, { gapPercent: config.gapPercent, waveFrames: spice?.waveFrames !== false }); // prettier-ignore
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
  globalLater(bench.tripAt);
  globalLater(burnWakeAt);
  if (droopMoving || droopStale) globalLater(target + DROOP_WAKE_S);
  if (imbalanced) globalLater(target + MIN_SHOWN_S);
  if ([...freeNext].some((id) => !free.has(id))) globalLater(target + FREE_WAKE_S); // prettier-ignore
  if (heldMoving) globalLater(target + ANALOG_FRAME_S);
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
  // What each speaker plays — timed as a readout is, and on an island this
  // tick was not for, what it played at that island's own last tick.
  // A coil burnt open plays nothing, whatever stands across its legs.
  const sounding = speakerTones(speakers.filter((sp) => speakerInScope(sp) && !burnt.has(sp.key)), tones, target); // prettier-ignore
  for (const sp of speakers) {
    if (speakerInScope(sp) || burnt.has(sp.key)) continue;
    const was = prior?.sounding?.get(sp.id);
    if (was) sounding.set(sp.id, was);
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

  // A wired-AND held LOW is SHOWN low where the digital engine's X is all
  // that stands — a net nothing reads. A net its readers read is shown as
  // they read it already, and that agreement is the solve's, not ours.
  const unread = [...wiredNets].filter((net) => result.netLevels.get(net) === X); // prettier-ignore
  if (unread.length) {
    result.netLevels = new Map(result.netLevels);
    for (const net of unread) result.netLevels.set(net, L);
  }
  // A running AC wave crossing a pin's threshold is an EDGE (Jason,
  // 2026-10-22): SimController ticks it at its own moment, as it ticks a
  // clock's, where every other wake waits MIN_SHOWN_S — so a signal
  // generator's 4 kHz sine into a 74LS14 is seen flipping at each crossing,
  // not sampled on one phase of it every half millisecond. The earliest
  // event on an island a running AC wave drives and a pin listens on; a
  // corner there counts too (a crossing past a corner is timed only once
  // the corner is reached). Not an island drawn by its schedule or
  // chattering: those keep their own pacing.
  let edgeAt = null;
  if (s && heard?.list?.length) {
    const acIslands = new Set();
    for (const [net, w] of s.waves) if (w.ac && waveRuns(net)) acIslands.add(islandOf(net)); // prettier-ignore
    const heardOn = new Set();
    for (const l of heard.list) {
      const key = islandOf(l.net);
      if (acIslands.has(key) && !drawn.has(key) && !chatterNow.has(key) && !capped.has(key)) heardOn.add(key); // prettier-ignore
    }
    if (heardOn.size) {
      const next = nextCrossing(t, (k) => heardOn.has(k));
      if (next && next.at > target) edgeAt = next.at;
    }
  }
  // …and a supply come on its limit is held by the solve from a microsecond
  // on, not half a millisecond: a 7805's output capacitor charged at Run
  // drooped its 9 V supply to 5.98 V, and that stood, the regulator in
  // dropout, until the clamped wake (the regrade, 2026-10-22).
  // So is a supply left drooped by a moment that has passed (`droopStale`:
  // the capacitor that pulled it down charged within the tick) — once: a
  // droop still standing at the next tick is the clamped wake's.
  if (freeing() || (droopStale && !prior?.staleEdge)) edgeAt = Math.min(edgeAt ?? Number.POSITIVE_INFINITY, target + FREE_WAKE_S); // prettier-ignore
  // What the analyzer's nets that are NO node read between ticks (an
  // adapter's S1, an op-amp's output, a divider's tap): each net as the
  // nodes make it — `c0 + Σ coef·state`, the solve's affine map
  // (spice/voltages.js `affine`), exact until a piece changes, which is the
  // next event — so a display frame (spice/sample.js `sampleAnalog`) reads
  // it moving instead of the last tick's value held flat. Only while frames
  // will come before the next tick (the earliest that can be is the edge,
  // or the wake held to MIN_SHOWN_S), and never for an island drawn by its
  // schedule (its frames stand where the schedule has them).
  let statements = null;
  const frameNets = spice?.frameNets;
  if (s && frameAt != null && frameNets?.size) {
    const wakeSoonest = wakeAt == null ? Number.POSITIVE_INFINITY : Math.max(wakeAt, target + MIN_SHOWN_S); // prettier-ignore
    const nextTick = Math.min(edgeAt ?? Number.POSITIVE_INFINITY, wakeSoonest);
    const watch = [...frameNets].filter((net) => !nodes.has(net) && !drawn.has(islandOf(net))); // prettier-ignore
    if (frameAt < nextTick && watch.length) {
      const at = new Map();
      for (const [net, node] of nodes) at.set(net, voltsOf(node, t));
      statements = new Map();
      for (const [net, st] of volt.affine(watch, at, undefined, ampsAt(t))) {
        if (st && st.terms.size) statements.set(net, st);
      }
    }
  }
  return Object.assign(result, {
    chipStatus,
    memWrites,
    warnings: biasedWarnings,
    wakeAt,
    // When a running AC wave next crosses a pin's threshold, or a supply
    // just come on its limit is to be held by the solve (above), or null —
    // a moment SimController ticks unclamped.
    edgeAt,
    // When the views next want this desk redrawn (a node still moving, a
    // running wave) — no wake: nothing happens there but the curves, which
    // spice/sample.js reads (null: nothing moves).
    frameAt,
    timing,
    settled: result.settled && !capped.size,
    analog: {
      time: t,
      // The analyzer's non-node nets as the nodes make them (above), or null.
      statements,
      // What the bench held for this tick, as it held it: the next tick
      // replays its history on these (`before`). Copied — a caller may flip
      // its clocks, re-time them and press its signals IN PLACE, and a
      // map kept by reference had already turned to the next tick's inputs
      // when that tick replayed the stretch before them: a square clock into
      // an RC charged it from the last tick on, not from its edge.
      inputs: {
        clockPhase: new Map(own.clockPhase),
        signalLevels: new Map(own.signalLevels),
        clockTimes: new Map(own.clockTimes),
      },
      nodes,
      listen,
      capFar,
      marks,
      tones,
      sounding,
      outputs: committed,
      supplies: delivered,
      drops,
      swing,
      staleEdge: droopStale,
      fed: new Map([...(lastCtx?.chipStatus ?? [])].filter(([, st]) => st.volts != null).map(([id, st]) => [id, st.volts])), // prettier-ignore
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
      cycles: new Map([...drawn].map(([key, st]) => [key, { cycle: st.cycle, done: st.done, memo: st.memo, steady: st.steady, ledPower: st.ledPower, ledAmps: st.ledAmps }])), // prettier-ignore
      cycle: drawn.values().next().value?.cycle ?? null,
      timelines,
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
      heats,
      ledHeats,
      ledEnergy,
      speakerHeats,
      speakerEnergy,
      free: freeNext,
      kicking: kicksNow.size ? new Set(kicksNow.keys()) : EMPTY_SET,
      relays: relayOn,
      waves: waveIds(),
      // Each wave net's shape, so a shape changed mid-run jumps from where
      // the OLD one stood (`refreshWaves`).
      waveKinds: waveKindsNow(),
      voltages: volt.snapshot(),
    },
    nodeVolts,
    supplies,
    loads,
    lamps: drawnLamps(lamps.lamps),
    currents: lamps.currents,
    tones: sounding,
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
 * (`input-overvoltage`) or below its ground (`input-clamp`, its clamp
 * diode's current) and a CD4000 input held past a rail (`input-clamp`,
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
    if (st.family === "74LS" && st.amps != null) {
      // Its clamp diode, below ground (spice/params.js TTL_CLAMP).
      if (st.smoke) overloaded.add(st.comp);
      keep(`in:${st.comp}`, { type: "input-clamp", chip: st.comp, pin: st.pin, volts: st.volts, amps: st.amps, max: (st.smoke ? TTL_CLAMP.smokeMa : TTL_CLAMP.warnMa) / 1000, smoke: st.smoke }, (st.smoke ? 1e9 : 0) + st.amps); // prettier-ignore
    } else if (st.family === "74LS") {
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
