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

// sim-controller.js — the renderer's transport + run-state owner. It bridges
// the pure two-phase engine (sim/engine.js `tick`) to the UI: Run / Pause /
// Step / speed, driving each free-running clock's edges off ONE pacing timer
// (see BATCHES below; the ENGINE stays pure and timerless — it only receives
// each clock's current output level via `clockPhase`). Sequential chip state and clock phases are
// RUN-VOLATILE (never serialized). It re-ticks on every input event (switch,
// button, PSU/clock change) warm-started from the previous stable state,
// publishes `chiphippo:sim-state` for the live views, persists 12 V damage
// through desk-doc, and routes warnings to the notification stack.
//
// Topology is FROZEN while running (the app locks editing tools); switch/clock
// changes are part state, not topology, so the netlist still rebuilds on them.
//
// THE SETTLE BOUNDARY. Every tick ends with the board settled, and that is the
// one moment an outside party may look at it or change it — the Arduino serial
// integration's whole timing model ("external data only enters or leaves the
// board at settle boundaries") rests on it. So an optional `integration`
// collaborator is told of every boundary (`settled`), and may answer with:
//   · nothing — the board carries on;
//   · `{again: true}` — it put new levels on the board (an Input's value), so
//     run one more settle straight away;
//   · a PROMISE — the INTEGRATION SETTLE: frames went out and the board STALLS
//     until they are acknowledged. Nothing advances while it does — a clock
//     edge due in the meantime is skipped (time is frozen, not queued), and an
//     input event is held and settled once, when the stall ends.
// The same collaborator may refuse a Run before it starts (`preflight`), gate
// the first tick the way a ROM load does (`begin`), add drivers of its own to
// every settle (`levels`), and hear Stop (`end`). The engine knows none of it.
//
// THE CHIP DEBUGGER (the chip designer's debug mode) is a second, optional
// collaborator, `debug`, and it acts one step EARLIER than the integration:
// before a tick's board is published. When a custom chip is armed it hands
// the engine an observer (`observer()`), and after the tick decides
// (`afterTick`) whether anything in it is worth stopping at. If so it answers
// a PROMISE and the board stalls exactly as for an integration settle —
// clocks skipped, inputs held — while the debugger replays the tick pass by
// pass, putting each pass's levels on the board (`show`) and finally the
// settled one (`showFinal`). When it lets go, the tick is published and
// reported, and the settle boundary happens, as if it had never stopped.
//
// SIMULATED TIME. A timed part (the 555, the RC-timed CD4000 parts —
// sim/timing.js) needs to know what time it is, and the engine keeps none, so
// this controller does: seconds since Run, advancing with the wall clock ×
// the speed multiplier, FROZEN while paused or stalled (time stops for the
// whole board, exactly as the clock bricks' edges do). Every tick is handed
// its reading (`now`), and the engine answers with `wakeAt` — when the next
// timed part next changes on its own — and it ticks again then, and only then.
//
// BATCHES (features/done/batched-ticks.md). The clock bricks' edges and the timed
// parts' wakes are one queue in SIMULATED time (sim/schedule.js), and ONE
// timer (#arm) wakes to run everything due — each event its own tick, handed
// its own exact moment as `now` — before the views hear of any of it: a
// batch publishes `chiphippo:sim-state` ONCE, for its last tick, and comes no
// oftener than every FRAME_MS (components/sim-pacer.js), since a display
// shows no more than that. So the edge rate is no longer capped by a timer,
// only by what a batch can do in BATCH_BUDGET_MS — past that the debt is
// dropped, time runs slower, and the run says so (`behind` on sim-state).
// Whatever needs EVERY tick hears every tick: the sim-ticks (the logic
// analyzer's stream, `chiphippo:sim-ticks` — a batch's in one event), the
// settle boundary, the debugger. An input (a switch,
// a signal key, an edit) first runs whatever is due, then ticks and publishes
// at once — the board answers on the same event, as it always has.
//
// WHAT A FRAME SHOWS OF A LAMP (sim/lamp-average.js). A frame shows each LED
// and segment at its brightness AVERAGED over the simulated time since the
// last frame — every tick booked for as long as it held — so an LED on a fast
// PWM clock looks steadily dim, as on a bench, rather than flickering with
// whichever edge the frame happened to land after (`lampGlow` on sim-state).
//
// SWITCH BOUNCE (sim/bounce.js; Settings ▸ Spice Lite ▸ Switch bounce, read
// at Run). Under Spice Lite with it on, a mechanical switch whose contacts
// close bounces for a few milliseconds: at each of its gaps the board ticks
// with a netlist of its own, the closing contacts open (`#bounceNetlist`) —
// each make and break a tick of the batch queue, beside the clocks' edges.
// Such a tick's board names its own netlist (`ownNetlist`), since the views'
// is the switch as it stands.

import { formatNumber, t } from "../i18n.js";
import { prepareCircuit, tieMemo } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { ContactBounce } from "../sim/bounce.js";
import {
  LampAverage,
  lampBrightness,
  lampJunctions,
} from "../sim/lamp-average.js";
import { ENGINES, engineFor } from "../sim/engines.js";
import { GAP_PERCENT, normalizeSpiceConfig } from "../sim/spice/config.js";
import { familyParams } from "../sim/spice/params.js";
import { H, L } from "../sim/levels.js";
import { CHIP_STATUS } from "../sim/chip-status.js";
import { chipMarking, partDef } from "../catalog/index.js";
import { partTitle } from "../catalog/labels.js";
import { LEVEL_WAVES } from "../catalog/parts.js";
import { supplyText } from "../catalog/families.js";
import { restLevel } from "../model/signals.js";
import { dataPinLevel } from "../model/integration.js";
import { formatAddress } from "../model/breadboard.js";
import {
  isMemory,
  isVolatileMemory,
  isOscillator,
  memoryConfig,
} from "../sim/chip-eval.js";
import { framebufferOf } from "../sim/hd44780.js";
import {
  cpuOf,
  cpuSummary,
  memBase,
  newTrack,
  observeTick,
} from "../sim/cpu-monitor.js";
import { CpuMemoryMap, pokeWord } from "../sim/cpu-memory-map.js";
import {
  oscillationHz,
  timingProblemSentences,
} from "../model/timing-summary.js";
import { COINCIDENT_S, EdgeSchedule, clockHalves } from "../sim/schedule.js";
import { MIN_SHOWN_S } from "../sim/timing.js";
import { NetlistCache } from "./netlist-cache.js";
import { RUN_LATCHES } from "../catalog/run-latches.js";
import {
  FUSE_HOLD_S,
  METER_FUSES,
  hzBands,
  meterSetup,
} from "../catalog/meter.js";
import {
  FUSE_SURGE_S,
  FUSE_TAU_S,
  coldFuse,
  fuseAmps,
  fuseBlown,
  heatFuse,
} from "../sim/meter-fuse.js";

import { meters as metersOf, probeNets } from "../model/meter-probes.js";
import { MeterAverage, cycleWindow } from "../sim/meter-average.js";
import {
  BATCH_BUDGET_MS,
  FRAME_MS,
  PUBLISH_MS,
  RunMeter,
} from "./sim-pacer.js";
import {
  SCOPE_TOLERANCE,
  cycleTemplates,
  nextDisplayFrame,
  sampleAnalog,
  scopeSamples,
} from "../sim/spice/sample.js";
import { fullScaleOf, onlyNets, scopeNets } from "../model/scope-recorder.js";
import { waveSwing } from "../sim/spice/waves.js";

/** A chip's supply volts in a toast: three figures in the locale's digits
    (Spice Lite's are the solve's, 2.9999903700308823), or "?". */
const voltsText = (v) =>
  typeof v === "number" && Number.isFinite(v)
    ? formatNumber(v, { maximumSignificantDigits: 3 })
    : (v ?? "?");

/** The wall clock, in ms — monotonic where the platform has one. */
const wallMs = () => globalThis.performance?.now?.() ?? Date.now();

/** The empty map a tick without Spice Lite's readings hands on — one, shared
    and only ever read, rather than a fresh one per tick at 8000 a second. */
const NO_READINGS = new Map();

/** A recorded sim-tick's lamps on the main thread (the analyzer reads only
    that there are some — scope-recorder.js `isSpiceRun`), as the Worker's. */
const NO_LAMPS = new Map();

/** How often a multimeter's display updates, wall ms: the BM235's "5 per
    second nominal". */
const METER_UPDATE_MS = 200;

/** How closely a meter's sampled curve follows the real one between ticks,
    as a share of what it reads (at least a volt): half a per cent. Its
    chords' error in a mean or an RMS is second order, far under that; at a
    tenth of a per cent a 60 Hz sine spent the samples' cap on its first
    cycles and held the rest of the window at the last one. */
const METER_TOLERANCE = 5e-3;

/** The most curve samples one meter stretch takes. */
const METER_MAX_SAMPLES = 8192;

/** No meter reads anything (stopped, or the logic engine). */
const NO_METERS = new Map();

/** A blank byte image for a def: Uint16Array for a >8-bit data bus, else Uint8Array. */
function blankImage(def) {
  const { size, width } = memoryConfig(def);
  return width > 8 ? new Uint16Array(size) : new Uint8Array(size);
}

/**
 * A fresh run-volatile byte image for a VOLATILE (SRAM) memory chip: zero-
 * filled (SRAM powers up cleared here — its contents are lost every Run). Only
 * volatile chips take this path; a non-volatile chip loads its file instead.
 */
function seedImage(def) {
  const { initial } = memoryConfig(def);
  const image = blankImage(def);
  if (initial == null) return image;
  const seed = typeof initial === "function" ? initial(image.length) : initial;
  const n = Math.min(image.length, seed?.length ?? 0);
  for (let i = 0; i < n; i++) image[i] = seed[i];
  return image;
}

/** Bytes per word for a def's data width (8-bit → 1, 16-bit → 2). */
function bytesPerWord(def) {
  return memoryConfig(def).width > 8 ? 2 : 1;
}

/** The backing file's byte length for a def (address space × bytes-per-word). */
function byteLengthOf(def) {
  return memoryConfig(def).size * bytesPerWord(def);
}

/** Unpack a raw byte buffer (from the backing file) into a def's word image. */
function unpackImage(def, bytes) {
  const image = blankImage(def);
  if (bytesPerWord(def) === 2) {
    for (let i = 0; i < image.length; i++) {
      image[i] = (bytes[2 * i] ?? 0) | ((bytes[2 * i + 1] ?? 0) << 8);
    }
  } else {
    for (let i = 0; i < image.length; i++) image[i] = bytes[i] ?? 0;
  }
  return image;
}

/** Pack a word image into a flat byte array (Uint8Array), little-endian. */
function packImage(width, image) {
  if (width > 8) {
    const out = new Uint8Array(image.length * 2);
    for (let i = 0; i < image.length; i++) {
      out[2 * i] = image[i] & 0xff;
      out[2 * i + 1] = (image[i] >> 8) & 0xff;
    }
    return out;
  }
  return Uint8Array.from(image);
}

/** The byte offsets a single word write touches (for the live inspector view). */
function wordToBytes(width, addr, value) {
  if (width > 8) {
    return [
      [2 * addr, value & 0xff],
      [2 * addr + 1, (value >> 8) & 0xff],
    ];
  }
  return [[addr, value & 0xff]];
}

/** A non-volatile memory chip's backing-file GUID, or null. */
function memGuid(comp) {
  const guid = comp?.params?.storage?.guid;
  return typeof guid === "string" && guid ? guid : null;
}

/** Transport modes. */
export const TRANSPORT = Object.freeze({
  STOPPED: "stopped",
  RUNNING: "running",
  PAUSED: "paused",
});

/** Speed multipliers the selector cycles. */
export const SPEEDS = Object.freeze([0.25, 1, 4]);

/** How long after Run a circuit is left to RISE before what rising looks
    like is said, simulated seconds: a regulator below its dropout while its
    input's reservoir capacitor charges, or at its current limit — and hot
    for the moment, by the instant's watts — while it charges its own
    output's (`SETTLING_WARNINGS`); and a chip underpowered while the rail
    behind them rises (#report's "underpowered"). Its heat is a lag of seconds
    (spice/bench-warnings.js), so a shutdown is said whenever it comes. One still standing — or
    met again — after it is said as ever. Half a second: a 60 Hz bridge
    fills its reservoir in the first quarter cycle; a 1 A supply 10 mF in
    about 50 ms. */
export const SETTLE_S = 0.5;

/** The warnings a circuit still rising gives for no fault of its own. */
const SETTLING_WARNINGS = new Set(["regulator-dropout", "regulator-limit", "regulator-hot"]); // prettier-ignore

/**
 * How many settles ONE tick request may chain through `{again: true}` before
 * it stops and waits for the next event. Each answer consumes the value that
 * prompted it, so a real chain is one or two long; the cap only guarantees a
 * misbehaving collaborator can never spin the renderer.
 */
const MAX_BOUNDARY_PASSES = 32;

/** No drawn cycle on the analyzer's nets (#scopeCycles). */
const NO_CYCLES = Object.freeze({});

/** The most display frames one batch steps through between ticks
    (#emitFrames) — past it, a long stretch's frames are skipped. */
const MAX_FRAMES_PER_BATCH = 1000;

/** The wait, wall ms, below which a timer set from inside a timer is held to
    4 ms once nested five deep (the HTML timer clamp) — the gap a run that is
    behind loses between two batches, unless it has `continuation` (#arm). */
const TIMER_CLAMP_MS = 4;

/** How long after an input a run that is behind keeps its batches short
    (`behindMs`, #arm), wall ms — someone is at the desk. An assumption. */
const INPUT_WINDOW_MS = 2000;

/** How far an underpowered chip's supply must move, volts, before it is
    said again (#warn's `reading`): a droop settling moves it by tenths. An
    assumption — a step a meter's second digit shows, and still under the
    width of a family's range. */
const UNDER_REPEAT_V = 0.5;

/** How long, simulated seconds, a chip must stand underpowered WITHOUT A
    BREAK before it is said (#report): a sag shorter than that — a load
    switched on for a moment, a reservoir's dip — says nothing, and one that
    lasts is said once it has (Jason, 2026-10-27: "delayed a little (maybe
    .5s) to allow for some settling and time for sag to be just as not just
    temporary"). In both engines, and under Spice Lite never inside Run's
    `SETTLE_S` either. */
export const UNDER_HOLD_S = 0.5;

/** How near its due time, simulated seconds, a held-back warning's tick may
    land and count as due: a wake set for 0.5 s lands on a sum of steps. */
const HOLD_EPS_S = 1e-9;

/** How long, simulated seconds, a warning must stay gone — no tick
    reporting it — before it is said afresh when it comes back (#report):
    a short that a button made, released and pressed again is news, a
    spike on every edge of a 1 Hz clock is not. An assumption — longer
    than a bench clock's half period, shorter than a hand pressing a button
    twice. */
const REARM_S = 1;

/** How far past the most it has said a number in a standing warning must
    grow, as a share of it, before the warning is said again (#warn). An
    LED on an AC adapter is read at a new phase every frame: said again at
    every new reading, "LED overdriven" was sent 360 times in 2 s and came
    straight back when clicked away (the regrade, 2026-10-23). An
    assumption — a reading a quarter worse is news; a wave's crest says it
    in the first period, the rest of the run says nothing new. */
const WARN_GROWTH = 0.25;

/** The numbers a warning's words state, and its words with them taken out
    (#warn): locale-formatted, so a comma may be the decimal point. */
const WARN_NUMBER = /\d+(?:[.,]\d+)?/g;
const numbersIn = (text) =>
  [...String(text ?? "").matchAll(WARN_NUMBER)].map((m) => Number(m[0].replace(",", "."))); // prettier-ignore
const wordsOf = (text) => String(text ?? "").replace(WARN_NUMBER, "#");

/** The most transport edges, and wall-clock ms, the CPU monitor's Step runs
    looking for the next operation (`stepCpu`) — a CPU that never starts one
    (WAI, STP, a clock the Step's edges do not reach) must not hang the
    window. */
const MAX_OP_EDGES = 4096;
const OP_STEP_BUDGET_MS = 500;
/** The most edges Step Over runs at once, inside the same wall-clock budget,
    before it hands the rest of the call to the run (`stepOverCpu`). */
const MAX_OVER_EDGES = 1_000_000;
/** The most bytes of inline argument a Step Over's call is taken to return
    past (`#cameBack`): a string or a parameter block, not a jump away. */
const MAX_INLINE_BYTES = 256;

/** How much SHALLOWER than the call found it a stack may be and still be
    that call's return (a routine that also drops a byte or two of its
    caller's): little, so a deep recursion — a 6502's stack is one page —
    never wraps round to read as shallow. */
const SHALLOW_SLACK = 16;

/** Is the stack no deeper than the call found it? (A pointer that grows
    down, compared within its width.) */
function unwound(over, cpu, state) {
  const deeper = (over.sp - cpu.spOf(state)) & over.mask;
  return deeper === 0 || deeper > over.mask - SHALLOW_SLACK;
}

/** Has a Step Over's call returned? `state` begins an instruction at the
    return address with the stack no deeper than the call found it. (A call
    that returns ELSEWHERE — past its inline arguments — is `#cameBack`.) */
export function returned(over, cpu, state) {
  return cpu.pcOf(state) === over.ret && unwound(over, cpu, state);
}

/**
 * An interrupt taken during a Step Over runs a handler whose instructions
 * would stand as the one "run last" (`over.prev`, `#cameBack`) when its
 * return lands back in the call — hiding the routine's own jump that came
 * before it. So the record is set aside as an interrupt sequence begins,
 * with the stack as it found it (`sp`, before the sequence pushes), and put
 * back at the first instruction that starts with the stack there again: the
 * handler has returned. Nested interrupts stack. One taken straight after
 * another's return, at the SAME stack (the line still asserted), is the
 * same set-aside — saving again would save the handler's own return. A
 * reset is not one; it forgets them.
 * Mutates `over`; called with each operation start, BEFORE `#cameBack`.
 */
export function carryAcrossInterrupt(over, started, sp) {
  if (started === "instr") {
    const top = over.held?.at(-1);
    if (top && top.sp === sp) {
      over.prev = top.prev;
      over.held.pop();
    }
  } else if (started === "reset") {
    over.held = null;
  } else if (started && over.held?.at(-1)?.sp !== sp) {
    (over.held ??= []).push({ prev: over.prev, sp });
  }
}

/**
 * A sim-tick's `netLevels`, read through the tick's result when it has a
 * record (the logic engine's in-place levels, features/digital-event-tick.md
 * A2): built only when read, a plain value once assigned (the cut), and its
 * `levelOf` beside it for a reader that wants a few nets.
 */
export function lazyTickLevels(detail, result) {
  if (typeof result.levelOf !== "function") {
    detail.netLevels = result.netLevels;
    return;
  }
  detail.levelOf = result.levelOf;
  Object.defineProperty(detail, "netLevels", {
    enumerable: true,
    configurable: true,
    get: () => result.netLevels,
    set(value) {
      Object.defineProperty(detail, "netLevels", { value, enumerable: true, configurable: true, writable: true }); // prettier-ignore
    },
  });
}

/** `levelOf` as the little of a Map that `onlyNets` reads. */
export function levelReader(levelOf) {
  return { has: (id) => levelOf(id) !== undefined, get: levelOf };
}

export class SimController {
  #doc;
  #netlist;
  #notifications;
  #onTransportChange;
  #mode = TRANSPORT.STOPPED;
  #speed = 1;
  #warm = new Map(); // previous stable net levels (warm start)
  // The logic engine's last tick's work, its next tick's start (`warm`;
  // sim/incremental.js `warmStartOf` — a tick starting cold cost twice as
  // much, the 2026-10-26 review). Spice Lite carries its own in `analog`.
  #carry = null;
  #ties = tieMemo(); // this run's memory of its tie-breaks (sim/engine.js)
  #state = new Map(); // per-component sequential state (run-volatile)
  #prevPins = new Map(); // last tick's sampled inputs (edge detection)
  #clockPhase = new Map(); // clockId → "H" | "L" (run-volatile)
  #pausedClocks = new Set(); // clockIds held by their OWN pause (run-volatile)
  // Where each free-running clock is between its edges — what a Spice Lite
  // WAVE reads (sim/spice/waves.js): the sim time of its last edge, and for
  // one held by its own pause, how far into its half it was held.
  #clockSince = new Map(); // clockId → seconds (run-volatile)
  #clockHeld = new Map(); // clockId → 0…1 (run-volatile)
  #signalLevel = new Map(); // signalId → "H" | "L" (run-volatile, from `rest`)
  #images = new Map(); // memory compId → Uint8Array/Uint16Array (run-volatile)
  #memInfo = new Map(); // memory compId → { volatile, guid, width, byteLength, ref }
  #memLost = new Set(); // volatile chips a power loss has wiped, still unpowered
  #dataLossWarned = new Set(); // programmed chips already warned of a missing file
  #toastKeys = new Set(); // the keys of the toasts this run has raised
  // What each standing warning last SAID this run (key → its words): the
  // engine reports every warning on every tick, and a toast re-sent each
  // time never expired, came straight back when dismissed, and cost a
  // message a tick from the Worker. Said once, it is said again only when
  // its words change (#warn) — or once it has been gone REARM_S and comes
  // back (`clearedAt`, the first tick that did not report it).
  #warned = new Map();
  #reported = null; // the keys the #report under way has warned (a Set)
  /** A settling warning was held back (`SETTLE_S`): the board is ticked
      again when the window closes, so one that still stands is said even on
      a board nothing else wakes. */
  #settleCheck = false;
  // Each chip reported underpowered by every tick since (chipId → the sim
  // time of the first), held back until it has stood UNDER_HOLD_S; a tick
  // that does not report it ends the stretch. `#underDue` is when the
  // earliest one held back falls due, so a board nothing else ticks is
  // woken to say it (#nextEvent); `#underSeen` the chips this #report met.
  #underSince = new Map();
  #underDue = null;
  #underSeen = null;
  #schedule = new EdgeSchedule(); // the ticking clocks' edges, in sim time
  #pacer = null; // the ONE timer: it runs the next batch (#arm)
  #pacerSoon = false; // …set on `#continuation`, not `#timers`
  #wall = wallMs; // the wall clock, ms (a test hands in its own)
  #timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }; // prettier-ignore
  // An unclamped timer for a run that is behind, or null (the Worker's —
  // sim-worker-host.js `urgentTimer`): `{set(fn, ms), clear(handle)}`.
  #continuation = null;
  #dropped = false; // the last batch ran out of budget with events due
  #tickSink = null; // who hears each sim-tick instead of the scope (#announceTick)
  #ticksOut = []; // the sim-ticks not yet told, one sim-ticks a batch (#tellTicks)
  #tickCut = null; // the analyzer's nets the told ticks are cut to (#cutOf)
  #scopeEpoch = 0; // bumped on every edit: the analyzer's nets read again
  #batchDepth = 0; // >0 inside a batch: ticks publish once, at its end
  #publishTimer = null; // a batch's publish, put off to the next frame
  #lastShown = null; // the last board published {result, netlist, displays}
  #owed = null; // the batch's last unpublished tick {result, netlist, displays}
  #memOwed = new Map(); // the batch's memory writes, merged in order
  #lastPublishWall = -Infinity; // wall ms of the last sim-state
  #meter = new RunMeter(); // simulated vs wall time — is the run keeping up?
  #tickAt = 0; // the simulated moment of the tick running (or last run)
  #suppress = false; // ignore our own damage-persist writes
  #runToken = 0; // bumped on every start() — see #loadRom
  #integration = null; // the settle-boundary collaborator (see the file header)
  #stalled = false; // an integration settle is in progress — the board waits
  #pendingTick = false; // a tick asked for while stalled, or a boundary's `again`
  #startToken = 0; // bumped by every Run request, so a stale preflight stands down
  #simAnchor = 0; // simulated seconds at #realAnchor (see SIMULATED TIME above)
  // The engine this run ticks with, and the Spice Lite setting that picks it
  // (sim/engines.js). The setting is read at RUN, never mid-run — the whole
  // of it, numbers included: the two engines' run-volatile state is not
  // interchangeable, so a toggle flipped while running applies at the next
  // Run, and a budget edited mid-run must not brown-smoke a chip the circuit
  // did nothing to. `#spiceConfig` is the setting as it stands; `#runConfig`
  // the copy this run took. Until `setSpiceLite` says otherwise it is the
  // logic engine: the APP's default (Spice Lite) arrives through settings,
  // which app.js hands over before any Run.
  #spiceConfig = normalizeSpiceConfig({ enabled: false });
  #runConfig = this.#spiceConfig;
  #engine = ENGINES.digital;
  #analog = null; // Spice Lite's carried analog state (run-volatile)
  // Spice Lite: when the analog side next wants redrawing (sim seconds, its
  // last tick's `frameAt`, then each frame's own — spice/sample.js), or null
  // while nothing on the desk moves; and the last tick's board, which a
  // frame between ticks reads the moving curves over.
  #frameAt = null;
  // How far the analyzer's curve samples have reached since the last tick
  // (#sampleScope), simulated seconds; null before a run's first.
  #scopeAt = null;
  #scopeCyclesOf = null; // #scopeCycles' answer, kept
  #templates = new WeakMap(); // drawn cycle → its nets' true cycles
  #lastTick = null; // {result, netlist, nets} — nets: the analyzer's (Spice)
  #sampleOwed = false; // a moving desk is owed a redraw at the next frame
  #realAnchor = null; // wall-clock ms the sim clock last started from; null = frozen
  #wakeAt = null; // simulated seconds a timed part next changes at, or null
  // Simulated seconds a running AC wave next crosses a pin's threshold (or
  // reaches a corner on its way to one), or null — an EDGE, ticked at its
  // own moment as a clock's is (Spice Lite's `edgeAt`).
  #edgeAt = null;
  #frameNetsOf = null; // {doc, netlist, nets} — `#frameNets`' answer, kept
  // The multimeters' readings (Spice Lite): the voltage across each one's
  // probes averaged over its display's window (sim/meter-average.js), what
  // the curves have been sampled to for them, the window each display shows
  // now (sim-state's `meters`, taken every METER_UPDATE_MS of wall time),
  // the meters on the snapshot (#meterList), and each fuse's overload.
  #meters = new MeterAverage();
  #meterAt = null;
  #meterShown = new Map();
  #meterWall = null;
  #meterTaken = null; // the simulated moment the shown window ends at
  #meterFrom = null; // …and the one it starts at
  #meterListOf = null; // {doc, netlist, list}
  #meterKeys = new Map(); // meter id → what it reads (probes' nets, element)
  #meterCycles = new WeakMap(); // drawn cycle → its meters' windows (#cycleWindows)
  #fuseOver = new Map(); // meter id → its fuse's heat (sim/meter-fuse.js `heatFuse`, #checkFuses)
  #fuseAt = null; // when the next of those blows, simulated seconds
  #debug = null; // the chip debugger (see the file header)
  // The document as the engine reads it, and the engine's prepared context
  // for it — both kept from tick to tick until the document changes (every
  // change rides doc-changed or part-state; #forgetDocument). A snapshot of
  // the whole document per tick was 5% of a busy desk's main thread.
  #docSnap = null;
  #circuit = null;
  // The netlist the snapshot's switches stand as (#circuit's may be a
  // bounce's), the bounce's own last built, and every netlist a bounce built
  // (a board ticked on one names it — `ownNetlist`).
  #base = null; // {doc, netlist}
  #bounceNets = null; // {doc, key, netlist}
  #bounceBuilt = new WeakSet();
  #bounce = new ContactBounce(); // run-volatile (sim/bounce.js)
  #contactsSeen = null; // {doc, version}: what #bounce last looked at
  #partStateVersion = 0; // bumped by every part-state (a held button)
  // Each lamp's brightness over the frame (sim/lamp-average.js), and its
  // junctions for the document snapshot.
  #lamps = new LampAverage();
  // Each supply's current averaged over a frame, as the lamps are: a tick
  // ends wherever a switching load's cycle happens to stand, and a boost
  // converter's 5 A supply read 0–0.67 A by turns where it averaged 0.76
  // (the grade, 2026-10-23).
  #supplyAmps = new LampAverage();
  #lampJunctions = null; // {doc, list}
  // The last frame showed a lamp's AVERAGE (#publish's lampGlow): one more
  // frame is owed, so the picture lands on the lamps as they now stand.
  #glowShown = false;
  // The last frame showed the run behind (sim-state's `behind`): a desk that
  // goes quiet publishes nothing more, so one more frame is owed when the
  // meter's window closes, or the speed button kept its amber "×1 · ×0.13"
  // over a board doing nothing.
  #behindShown = false;
  // The lamps' averages the last frame showed (null: the ticks' own), and
  // those a run handed over showed last, for its first frame here to show
  // again (`importRun`).
  #shownGlow = null;
  #heldGlow = null;
  #debugStalled = false; // the stall is the debugger's (a person is reading it)
  #debugDeciding = false; // inside afterTick: what it shows is the debugger's
  #heldInputs = []; // input events made while the debugger held the board
  #shownStrong = new Map(); // the strong levels the board last showed
  // The CPU monitor (sim/cpu-monitor.js): every CPU's record, kept tick by
  // tick (run-volatile); which one the monitor window shows, if any — only
  // that one's summary is built, at publish; the CPUs on the document last
  // read; and the address map the summary reads memory through.
  #cpuTracks = new Map(); // compId → track
  #cpuWatch = null; // compId the monitor shows, or null
  #cpuView = { memAt: null }; // where its memory block starts (null: around PC)
  #cpuList = { doc: null, cpus: [] }; // [{id, cpu}] for that doc snapshot
  #cpuMap = new CpuMemoryMap();
  // The CPU monitor's breakpoints: compId → the addresses whose instruction
  // pauses the run as it begins (session state the bridge owns, kept through
  // Stop and Run), and the hit the last tick made, handled once it is done.
  #cpuBreaks = new Map(); // compId → Set<number>
  #breakHit = null; // {compId, addr}
  #opStep = null; // the CPU monitor's Step in progress: {compId, done, over, idleFrom}
  // Step Over's call, when it outran the Step's budget and the RUN carries on
  // to its return: {compId, ret, sp, mask} — a breakpoint of one use.
  #overStop = null;
  #pausing = false; // inside pause()'s catch-up batch
  #scope = globalThis.window; // what its events are heard and told on
  // How it paces its batches: the gap after a publish before the next, and
  // how long one may work (components/sim-pacer.js; the Worker's are its own).
  #frameMs = FRAME_MS;
  #budgetMs = BATCH_BUDGET_MS;
  #behindMs = BATCH_BUDGET_MS; // …a pacer's batch soon after an input (#arm)
  // How long a pacer's batch works before it lets the messages waiting for
  // the thread in, on the continuation, and carries on (`sliceMs`; 0 never —
  // the main thread, whose inputs a slice could not let in anyway).
  #sliceMs = 0;
  #slice = null; // a pacer's batch handed on to its next slice (#runBatch)
  #inputAt = Number.NEGATIVE_INFINITY; // the wall ms of the last input (#catchUp)

  /**
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./notification-stack.js').NotificationStack} [opts.notifications]
   * @param {(mode: string) => void} [opts.onTransportChange]
   * @param {object} [opts.integration] - the settle-boundary collaborator:
   *   `{preflight?, begin?, settled?, levels?, end?}` (see the file header).
   * @param {object} [opts.debug] - the chip debugger:
   *   `{begin?, observer?, afterTick?, end?}` (see the file header).
   * @param {object} [opts.clock] - the wall clock and the pacer's timer,
   *   `{now(), setTimeout(fn, ms), clearTimeout(handle)}` — the platform's
   *   unless a test drives time itself.
   * @param {{frameMs: number, budgetMs: number, behindMs?: number}} [opts.pacing]
   *   - its batch cadence, where no display shares its thread (the
   *   Worker's); `behindMs` a pacer batch's budget soon after an input
   * @param {{set: Function, clear: Function}} [opts.continuation] - a timer
   *   the 4 ms clamp does not hold back, for the next batch of a run that is
   *   behind (#arm) — the Worker's
   * @param {(detail: object) => void} [opts.tickSink] - handed each
   *   sim-tick's detail INSTEAD of its being told on `scope` (the Worker's
   *   host, its one listener)
   * @param {EventTarget} [opts.scope] - where it hears doc-changed /
   *   part-state and tells sim-state, sim-tick and mem-state (the window).
   */
  constructor({
    deskDoc,
    notifications,
    onTransportChange,
    netlist,
    integration,
    debug,
    clock,
    scope,
    pacing,
    continuation,
    tickSink,
  }) {
    if (pacing) {
      this.#frameMs = pacing.frameMs;
      this.#budgetMs = pacing.budgetMs;
      this.#behindMs = pacing.behindMs ?? pacing.budgetMs;
      this.#sliceMs = pacing.sliceMs ?? 0;
    }
    this.#continuation = continuation ?? null;
    this.#tickSink = tickSink ?? null;
    // The window — or, run on the simulation Worker, that thread's own
    // scope (components/sim-worker-host.js).
    if (scope) this.#scope = scope;
    if (clock) {
      this.#wall = () => clock.now();
      this.#timers = {
        set: (fn, ms) => clock.setTimeout(fn, ms),
        clear: (h) => clock.clearTimeout(h),
      };
    }
    this.#doc = deskDoc;
    this.#netlist = netlist ?? new NetlistCache(deskDoc);
    this.#notifications = notifications;
    this.#onTransportChange = onTransportChange;
    this.#integration = integration ?? null;
    this.#debug = debug ?? null;
    this.#scope.addEventListener("chiphippo:part-state", this.#onPartState);
    this.#scope.addEventListener("chiphippo:doc-changed", this.#onDocChanged);
  }

  get mode() {
    return this.#mode;
  }

  get running() {
    return this.#mode !== TRANSPORT.STOPPED;
  }

  get speed() {
    return this.#speed;
  }

  /** Which engine the run ticks with ("digital" | "spice") — the one the
      setting asked for at the last Run, or the digital engine while stopped
      before any. */
  get engineId() {
    return this.#engine.id;
  }

  /**
   * Keep the Spice Lite setting current (Settings ▸ Spice Lite). It takes
   * effect at the next Run, numbers and all — see `#engine`.
   * @param {unknown} config - `settings.spiceLite`
   */
  setSpiceLite(config) {
    this.#spiceConfig = normalizeSpiceConfig(config);
  }

  // ── Transport ────────────────────────────────────────────────────────────

  /**
   * Enter Run: reset run-volatile state, seed memory images (loading any
   * non-volatile ROM chip from its file first — Feature 190), cold-settle,
   * start the clocks. Seeding is async ONLY when a ROM chip is present; with
   * none (or only volatile SRAM), Run proceeds synchronously. Returns a promise
   * that resolves once the first tick has run (tests await it; the UI ignores it).
   *
   * An integration collaborator may REFUSE the run first (`preflight` — its
   * connections need verifying), in which case nothing starts at all: no
   * transport change, no locked desk, nothing to stop.
   *
   * While an ASYNC preflight is still checking (a live port scan), the run
   * has not started: the transport still reads stopped and the desk is not
   * locked. So a Stop meanwhile — a tab switch, New, Open — cancels it
   * (`stop()` bumps the start token even when stopped), and a desk edited
   * meanwhile is checked again rather than run unchecked.
   */
  start() {
    if (this.#mode !== TRANSPORT.STOPPED) return;
    const token = ++this.#startToken;
    this.#scopeEpoch += 1; // the channels as this run finds them
    const doc = this.#doc.toJSON();
    let verdict;
    try {
      verdict = this.#integration?.preflight?.(doc);
    } catch (err) {
      console.error("[renderer] integration preflight failed:", err);
      return;
    }
    if (verdict && typeof verdict.then === "function") {
      const checked = JSON.stringify(doc);
      return verdict.then(
        (ok) => {
          // A second Run press, or a Stop, while this was checking wins.
          if (!ok || token !== this.#startToken) return;
          if (this.#mode !== TRANSPORT.STOPPED) return;
          // What was checked is no longer what is on the desk: check that.
          if (JSON.stringify(this.#doc.toJSON()) !== checked) {
            return this.start();
          }
          return this.#beginRun();
        },
        (err) => console.error("[renderer] integration preflight failed:", err),
      );
    }
    if (verdict === false) return;
    return this.#beginRun();
  }

  /** The run itself, once nothing has refused it. */
  #beginRun() {
    this.#mode = TRANSPORT.RUNNING;
    this.#forgetDocument();
    this.#stalled = false;
    this.#debugStalled = false;
    this.#heldInputs = [];
    this.#pendingTick = false;
    const token = ++this.#runToken;
    this.#runConfig = this.#spiceConfig;
    this.#engine = engineFor(this.#runConfig);
    this.#bounce.reset();
    this.#contactsSeen = null;
    this.#lamps.reset();
    this.#supplyAmps.reset();
    this.#resetMeters();
    this.#shownGlow = null;
    this.#heldGlow = null;
    this.#analog = null;
    this.#frameAt = null;
    this.#scopeAt = null;
    this.#edgeAt = null;
    this.#lastTick = null;
    this.#sampleOwed = false;
    this.#warm = new Map();
    this.#carry = null;
    this.#ties = tieMemo();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#cpuTracks = new Map();
    this.#cpuMap.clear();
    this.#breakHit = null;
    this.#overStop = null;
    this.#clockPhase = new Map();
    for (const c of this.#clocks()) this.#clockPhase.set(c.id, L); // idle low
    this.#pausedClocks = new Set(); // every clock starts going
    this.#clockSince = new Map();
    this.#clockHeld = new Map();
    // A signal starts at its RESTING level, the way a clock starts idle low.
    // Run-volatile like everything above it: `rest` is the ONE durable answer
    // to "what is this signal holding", so a latched toggle deliberately does
    // not survive a Run — a second stored level would be a second source of
    // truth for the same question.
    this.#signalLevel = new Map();
    for (const sig of this.#signals()) {
      this.#signalLevel.set(sig.id, restLevel(sig) === "high" ? H : L);
    }
    this.#dataLossWarned = new Set();
    this.#warned.clear();
    this.#settleCheck = false;
    this.#underSince.clear();
    this.#underDue = null;
    try {
      this.#debug?.begin?.();
    } catch (err) {
      console.error("[renderer] chip debugger begin failed:", err);
    }
    // The sim clock starts at 0 and stays there until the first tick: a ROM
    // load or a board's handshake is not time the circuit lived through.
    this.#cancelPacer();
    this.#schedule.clear();
    this.#owed = null;
    this.#memOwed = new Map();
    this.#simAnchor = 0;
    this.#realAnchor = null;
    this.#tickAt = 0;
    this.#onTransportChange?.(this.#mode); // lock editing while files load
    const gates = [this.#seedImages(token), this.#beginIntegration(token)];
    const pending = gates.filter(Boolean);
    if (this.#mode === TRANSPORT.STOPPED) return; // the integration refused
    if (pending.length) {
      return Promise.all(pending).then(() => this.#afterSeed(token));
    }
    this.#afterSeed(token);
  }

  /**
   * Let the integration open what the run needs (ports, and each board's
   * HELLO) before the first tick — the ROM load's gate, one collaborator over.
   * An answer of `false` stops the run; saying WHY is the collaborator's job,
   * since only it knows. Returns a promise to wait on, or null.
   */
  #beginIntegration(token) {
    let gate;
    try {
      gate = this.#integration?.begin?.(this.#doc.toJSON());
    } catch (err) {
      console.error("[renderer] integration begin failed:", err);
      gate = false;
    }
    const refuse = () => {
      if (token === this.#runToken && this.#mode !== TRANSPORT.STOPPED) {
        this.stop();
      }
    };
    if (gate === false) {
      refuse();
      return null;
    }
    if (!gate || typeof gate.then !== "function") return null;
    return gate.then(
      (ok) => {
        if (ok === false) refuse();
      },
      (err) => {
        console.error("[renderer] integration begin failed:", err);
        refuse();
      },
    );
  }

  /** First settle + clock start once memory images are seeded/loaded. */
  #afterSeed(token) {
    // `token` guards a fast Stop→Start on this SAME instance: a straggling
    // async load from a PRIOR run must never act once a NEWER run has begun,
    // even though `#mode` alone reads RUNNING again by then (see #loadRom).
    if (token !== this.#runToken || this.#mode !== TRANSPORT.RUNNING) return;
    // The first tick is AT 0 — Run's own moment — and the wall clock starts
    // after it. Read off the wall, it landed a few milliseconds in (the
    // snapshot and netlist it builds first): an AC supply was switched on
    // part-way up its sine, the step charged a reservoir capacitor through a
    // bridge at tens of amps, and the bridge burnt at Run.
    this.#tickNow(0);
    this.#thaw();
    this.#scheduleClocks();
    // Tell any open inspector the run has begun, as Stop tells it the run has
    // ended: a window opened while stopped otherwise went on reading "Stopped ·
    // editable" all run, and an SRAM's showed deltas over a zeroed grid.
    this.#scope.dispatchEvent(
      new CustomEvent("chiphippo:mem-state", {
        detail: { running: true, started: true, changes: new Map() },
      }),
    );
  }

  /** Freeze time (stop the clocks) but keep the state + live view. */
  pause() {
    if (this.#mode !== TRANSPORT.RUNNING) return;
    // Time stops AT THE PRESS, so first run what fell due before it, as every
    // input catches up (#catchUp). Up to a frame of edges can be owed between
    // batches, and frozen unrun they were left to the first Step — which then
    // only caught up to the press (no edge, or several) instead of moving one
    // edge on. A batch out of budget drops its debt and re-anchors behind the
    // press: time stops there instead, never past an edge it did not run.
    const pressed = this.#simNow();
    this.#dropped = false; // (the catch-up's own, below)
    this.#pausing = true;
    try {
      this.#runBatch({ flush: false, budget: this.#cutBudget() });
    } finally {
      this.#pausing = false;
    }
    // A breakpoint reached on the way paused it there already (#breakAt).
    if (this.#mode !== TRANSPORT.RUNNING) return;
    // A Step Over still running to its call's return ends where it is.
    this.#overStop = null;
    this.#mode = TRANSPORT.PAUSED;
    this.#cancelPacer();
    this.#schedule.clear();
    // (Its debt dropped, the clock was put back at the last tick run — and
    // stops exactly there: read again, it had moved on by the work since,
    // past edges never run at a fast clock's rate ×4.)
    this.#freeze(this.#dropped ? this.#tickAt : Math.max(this.#tickAt, Math.min(pressed, this.#simNow()))); // prettier-ignore
    // The views hear of the pause on the board itself: a batch's last tick if
    // one is still owed, else the board as last shown — so the speed button
    // drops its "behind" and the lamps their flat face (#publish) at once,
    // not at whatever tick comes next.
    if (!this.#flushPublish()) this.#republish();
    this.#onTransportChange?.(this.#mode);
  }

  /** Resume free-running from the paused state. */
  resume() {
    if (this.#mode !== TRANSPORT.PAUSED) return;
    this.#mode = TRANSPORT.RUNNING;
    this.#onTransportChange?.(this.#mode);
    // Time stays stopped while a stall holds the board; its end thaws it.
    if (!this.#stalled) this.#thaw();
    this.#scheduleClocks();
  }

  /** Return to editing: clear every scrap of run state, damage included. */
  stop() {
    // A Run still in its async preflight has not started, but it is cancelled
    // all the same — whoever stops the sim means nothing to run after it.
    this.#startToken++;
    if (this.#mode === TRANSPORT.STOPPED) return;
    this.#cancelPacer();
    this.#schedule.clear();
    this.#owed = null;
    this.#lastShown = null;
    this.#memOwed = new Map();
    this.#simAnchor = 0;
    this.#realAnchor = null;
    // Snapshot each memory's final bytes (while the images still exist) so an
    // open inspector shows the exact end-of-run contents with no file re-read.
    const finalImages = new Map();
    for (const compId of this.#images.keys()) {
      finalImages.set(compId, this.imageBytesOf(compId));
    }
    this.#mode = TRANSPORT.STOPPED;
    this.#bounce.reset();
    this.#contactsSeen = null;
    this.#lamps.reset();
    this.#supplyAmps.reset();
    this.#resetMeters();
    this.#shownGlow = null;
    this.#heldGlow = null;
    this.#analog = null;
    this.#frameAt = null;
    this.#scopeAt = null;
    this.#edgeAt = null;
    this.#lastTick = null;
    this.#sampleOwed = false;
    this.#forgetDocument();
    this.#warm = new Map();
    this.#carry = null;
    this.#ties = tieMemo();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#cpuTracks = new Map();
    this.#cpuMap.clear();
    this.#breakHit = null;
    this.#overStop = null;
    this.#clockPhase = new Map();
    this.#pausedClocks = new Set();
    this.#clockSince = new Map();
    this.#clockHeld = new Map();
    this.#signalLevel = new Map();
    this.#images = new Map();
    this.#memInfo = new Map();
    this.#memLost = new Set();
    // A stall still waiting on an ACK is abandoned: the run token it carries
    // no longer matches anything once the mode is STOPPED.
    this.#stalled = false;
    this.#debugStalled = false;
    this.#heldInputs = [];
    this.#pendingTick = false;
    try {
      this.#integration?.end?.();
    } catch (err) {
      console.error("[renderer] integration end failed:", err);
    }
    try {
      this.#debug?.end?.();
    } catch (err) {
      console.error("[renderer] chip debugger end failed:", err);
    }
    // Only this controller's own toasts: the stack is the app's, and clearing
    // it whole took the updater's sticky Restart offer and the auto-route
    // Cancel button down with every short and oscillation of the run.
    for (const key of this.#toastKeys) this.#notifications?.dismiss?.(key);
    this.#toastKeys.clear();
    this.#warned.clear();
    this.#underSince.clear();
    this.#underDue = null;
    // BEFORE #onTransportChange: stopping re-baselines undo/redo against the
    // live document (`#history.sync`), so the chips have to be whole by the
    // time that runs — otherwise the baseline would hold the damage and a ⌘Z
    // would bring the magic smoke back.
    this.#clearAllDamage();
    this.#onTransportChange?.(this.#mode);
    this.#publish(null, null); // views clear from a not-running sim-state
    // Hand any open inspector windows the final image (→ back to editable).
    this.#scope.dispatchEvent(
      new CustomEvent("chiphippo:mem-state", {
        detail: { running: false, images: finalImages },
      }),
    );
  }

  /** Run ⇄ Stop (the primary toggle). */
  toggle() {
    if (this.#mode === TRANSPORT.STOPPED) this.start();
    else this.stop();
  }

  /** Pause ⇄ Resume (no-op while stopped). */
  togglePause() {
    if (this.#mode === TRANSPORT.RUNNING) this.pause();
    else if (this.#mode === TRANSPORT.PAUSED) this.resume();
  }

  /** Advance one half-period: toggle every free-running clock once, then tick.
      A clock paused on its own is passed by — it is HELD, and a Step is the
      transport's edge, not a way round that clock's own pause. */
  step() {
    if (this.#mode === TRANSPORT.STOPPED) return;
    if (this.#mode === TRANSPORT.RUNNING) this.pause(); // stepping implies paused
    if (this.#hold(() => this.#advance())) return;
    this.#advance();
    this.#tickNow();
  }

  /** A Step's edge: every free-running clock flipped once, and simulated
      time moved on with it. */
  #advance() {
    const ticking = this.#tickingClocks();
    // Simulated time moves on with the step, so a timed part steps too: by
    // the shortest half a clock just made (keeping it in step with the edges
    // the bricks produce — a PWM's is the half it was in), or — with no clock
    // running — straight to the next moment a timed part changes.
    const halves = ticking.map((c) => this.#presentHalf(c));
    for (const c of ticking) this.#flip(c.id);
    if (halves.length) this.#simAnchor += Math.min(...halves);
    else if (this.#wakeAt != null) {
      this.#simAnchor = Math.max(this.#simAnchor, this.#wakeAt);
    }
    for (const c of ticking) this.#clockSince.set(c.id, this.#simNow());
  }

  /**
   * While the chip debugger holds the board, an input event is QUEUED rather
   * than applied: a person may press Step twice, or a momentary signal down
   * and up, before letting go, and applying each to the live levels at once
   * would merge them into one tick that sees no edge at all. Each is replayed
   * as its own tick once the board is let go (`#replayHeld`). Returns whether
   * it was held. (An integration stall lasts milliseconds and keeps the old
   * rule: the levels move, one tick follows.)
   */
  #hold(apply) {
    if (!this.#debugStalled) return false;
    this.#heldInputs.push(apply);
    return true;
  }

  /** The held inputs, one tick each and in order, until one of those ticks
      stalls again (the rest wait for that stall to end). Whether any ran. */
  #replayHeld() {
    let ran = false;
    while (
      this.#heldInputs.length &&
      !this.#stalled &&
      this.#mode !== TRANSPORT.STOPPED
    ) {
      this.#heldInputs.shift()();
      this.#pendingTick = false;
      this.#tickNow();
      ran = true;
    }
    return ran;
  }

  /** Set the speed multiplier (applies to every free-running clock). */
  setSpeed(multiplier) {
    if (!SPEEDS.includes(multiplier)) return;
    // Re-anchor the sim clock, so the time already lived through keeps the
    // rate it was lived at.
    const running = this.#realAnchor != null;
    this.#freeze();
    this.#speed = multiplier;
    if (running) this.#thaw();
    // The schedule is in simulated time, so a new speed moves no edge — only
    // how soon, in wall time, the next one comes round.
    if (this.#mode === TRANSPORT.RUNNING) this.#arm();
  }

  // ── Simulated time (see the file header) ─────────────────────────────────

  /** The sim clock's reading, in seconds. */
  #simNow() {
    if (this.#realAnchor == null) return this.#simAnchor;
    return (
      this.#simAnchor + ((this.#wall() - this.#realAnchor) / 1000) * this.#speed
    );
  }

  /** Stop the sim clock where it is (pause, a speed change) — or, for a
      stall, at the moment of the tick that stalled (`at`): inside a batch
      the wall clock has run on past it, and the edges in between must wait
      for the stall like every other. A pause or a person reading the
      debugger is a frozen stretch, not a slow one, so the meter forgets it;
      an integration stall (`meter: false`) is the board waiting on a
      device, and that IS the run going slower than asked. */
  #freeze(at = this.#simNow(), { meter = true } = {}) {
    this.#simAnchor = at;
    this.#realAnchor = null;
    if (meter) this.#meter.reset();
  }

  /** Start the sim clock again from where it stopped. */
  #thaw({ meter = true } = {}) {
    if (this.#realAnchor == null) this.#realAnchor = this.#wall();
    if (meter) this.#meter.reset();
  }

  #cancelPacer() {
    if (this.#pacerSoon) this.#continuation.clear(this.#pacer);
    else this.#timers.clear(this.#pacer);
    this.#pacer = null;
    this.#pacerSoon = false;
    this.#slice = null; // (a batch handed on is ended with its next slice)
  }

  /**
   * Wake for the next batch: when the earliest clock edge or timed-part wake
   * falls due, but no sooner than FRAME_MS after the views were last told —
   * they would not show an earlier one. Only while running and time is
   * flowing; a stall's end, a resume, a speed change and every batch or
   * input tick re-arm it.
   *
   * A stall's end re-arms UNGATED (`gate: false`): the board spent its frame
   * waiting on the device, and an Arduino answering every edge would
   * otherwise be held to one edge per frame. Its batches still publish no
   * oftener than every FRAME_MS (#flushSoon).
   */
  #arm({ gate = true } = {}) {
    this.#cancelPacer();
    if (this.#mode !== TRANSPORT.RUNNING || this.#stalled) return;
    if (this.#realAnchor == null) return;
    const next = this.#nextEvent();
    const now = this.#wall();
    let ms = Number.POSITIVE_INFINITY;
    let behind = false;
    if (next) {
      const due = ((next.at - this.#simNow()) * 1000) / this.#speed;
      const frame = gate ? this.#lastPublishWall + this.#frameMs - now : 0;
      ms = Math.max(0, due, frame);
      // An event already due, or the last batch out of budget: the run is
      // behind, and the next batch wants the thread at once. Not the whole
      // meter's window after a drop (N3's first try): a wait for an edge
      // not yet due went on the continuation too, and each early wake ran a
      // batch with nothing in it — 35–70k a second (runtime regrade NEW-1).
      behind = due <= 0 || this.#dropped;
    }
    // A frame that showed a lamp's average is followed by one more, though
    // nothing falls due (#glowShown).
    if (this.#glowShown) {
      ms = Math.min(ms, Math.max(0, this.#lastPublishWall + PUBLISH_MS - now));
    }
    // A desk whose analog side is still moving (spice/sample.js) is redrawn
    // every PUBLISH_MS though no event falls due: nothing ticks for it — the
    // views read the curves where the sim clock has got to.
    if (this.#frameAt != null) {
      ms = Math.min(ms, Math.max(0, this.#lastPublishWall + PUBLISH_MS - now));
    }
    // A frame that showed the run behind is followed by one when it no
    // longer is (#behindShown).
    if (this.#behindShown) {
      ms = Math.min(ms, Math.max(0, this.#meter.clearsAt() - now));
    }
    // A meter whose display has not shown the readings booked since its
    // last window gets the next one, though nothing ticks (#meterOwed).
    const meterDue = this.#meterOwed();
    if (meterDue != null) ms = Math.min(ms, Math.max(0, meterDue - now));
    if (!Number.isFinite(ms)) return;
    // Behind, a short wait goes on the continuation (the Worker's): a timer
    // set from the batch that a timer ran is held to 4 ms once nested, and
    // a run that cannot keep up slept that long after every 30 ms batch —
    // ×4 ran at ×2.25 with the thread 15 % idle (runtime review R2,
    // 2026-10-26). A run keeping up keeps the plain timer, whose clamp
    // gathers a fast clock's edges into fewer batches.
    // Back to back they leave an input no gap but the one between two, so
    // while someone is at the desk — an input within INPUT_WINDOW_MS — a
    // pacer's batch, on either, works `behindMs` only (WORKER_PACING, N3):
    // 30 ms ones kept a clock's pause waiting 15–20 ms where it had waited
    // 6–9. Not always: each batch costs, and 10 ms ones ran busy16 at 1 kHz
    // ×3.80, not ×3.90.
    const budget = now - this.#inputAt < INPUT_WINDOW_MS ? this.#behindMs : this.#budgetMs; // prettier-ignore
    const run = () => {
      this.#pacer = null;
      this.#pacerSoon = false;
      this.#runBatch({ budget });
    };
    if (this.#continuation && behind && ms < TIMER_CLAMP_MS) {
      this.#pacerSoon = true;
      this.#pacer = this.#continuation.set(run, ms);
      return;
    }
    this.#pacer = this.#timers.set(run, ms);
    this.#pacer?.unref?.();
  }

  /**
   * Run every event due by now — each clock edge and timed-part wake its own
   * tick, at its own simulated moment — then publish once (unless `flush` is
   * false: an input's catch-up, whose own tick publishes straight after).
   * Stops early at a stall, at Stop, or when BATCH_BUDGET_MS runs out — and
   * then the debt is dropped: the sim clock goes back to the last edge run,
   * so the run goes slower instead of bunching edges up, and says so.
   */
  #runBatch({ flush = true, budget = this.#budgetMs, slice = null } = {}) {
    if (this.#mode !== TRANSPORT.RUNNING || this.#stalled) return;
    // Re-entered from inside a batch (an input dispatched by a boundary or a
    // sim-tick listener): the batch running is already catching up, and a
    // nested one would end its batching early and split what it owes.
    if (this.#batchDepth > 0) return;
    // A pacer's batch carried on from its last slice (below) — or, when
    // anything else runs first, ended there: a batch of its own begins.
    const resumed = slice != null && slice === this.#slice;
    this.#cancelPacer();
    const started = resumed ? slice.started : this.#wall();
    const asked = resumed ? slice.asked : this.#simNow(); // the moment the batch set out for
    let target = resumed ? slice.target : asked;
    const moving = resumed ? slice.moving : this.#frameAt != null;
    let ran = resumed ? slice.ran : 0;
    let left = null; // an event due that the batch ended before (its debt kept)
    // A pacer's batch on the Worker lets the thread go every `sliceMs` of
    // work — a Pause, an input, an edit sent meanwhile is let in between two
    // ticks, not after the batch's whole 30 ms (it waited 13–27 ms, p50) —
    // and carries on where it was: the same budget, target, debt and frame,
    // as one batch (the runtime round, 2026-10-28).
    const sliced = flush && this.#sliceMs > 0 && this.#continuation != null;
    const sliceFrom = this.#wall();
    let ranHere = 0;
    let handOn = false;
    this.#dropped = false;
    this.#batchDepth += 1;
    try {
      for (;;) {
        const event = this.#nextEvent();
        // The pacer's batch, with budget left, runs on into what fell due
        // while it worked (R2): ended at the moment it set out for, a run
        // that is behind spent its budget's remainder waiting for a timer.
        // (A catch-up — an input's, Pause's — runs to its moment only.)
        if (flush && event && event.at > target + COINCIDENT_S && this.#wall() - started < budget) target = Math.max(target, this.#simNow()); // prettier-ignore
        if (!event || event.at > target + COINCIDENT_S) break;
        if (ran && this.#wall() - started >= budget) {
          // Debt is dropped only for what was due when the batch began: what
          // fell due as it ran on waits for the next one, as it always did
          // — dropped, a desk at the edge of keeping up ran ×3.95 of ×4.
          if (event.at > asked + COINCIDENT_S) {
            left = event;
            break;
          }
          this.#simAnchor = this.#tickAt;
          this.#realAnchor = this.#wall();
          this.#meter.dropped(this.#realAnchor);
          this.#dropped = true;
          break;
        }
        // A frame put off to now (#flushSoon) ends the batch, its debt kept:
        // run back to back, a behind run's batches left the publish timer
        // no gap to fire in, and the desk drew at 15 fps, not 25. A pacer's
        // batch only: a catch-up publishes straight after — its input's
        // tick, or the board Pause freezes — and cut short with edges due
        // before the moment it ran for, Pause froze at the press past edges
        // it never ran (the first Step then caught up to the press, not one
        // edge on) and an input ticked ahead of edges due before it (the
        // runtime round, 2026-10-28).
        if (flush && ran && this.#publishTimer != null && this.#wall() >= this.#lastPublishWall + PUBLISH_MS) { left = event; break; } // prettier-ignore
        // A slice's work done, with more due: the thread is let go between
        // two ticks, and the batch goes on in its next slice.
        if (sliced && ranHere && this.#wall() - sliceFrom >= this.#sliceMs) {
          handOn = true;
          break;
        }
        // The analyzer's columns between the last tick and this one: the
        // moving curves read at their display frames (no tick).
        this.#emitFrames(Math.min(event.at, target), false);
        for (const id of event.clocks) this.#flip(id);
        this.#schedule.consume(event.clocks);
        // Time never runs backwards: an input may have ticked a hair past an
        // edge still queued.
        const at = Math.max(event.at, this.#tickAt);
        for (const id of event.clocks) this.#clockSince.set(id, at);
        this.#tickNow(at);
        ran += 1;
        ranHere += 1;
        if (this.#stalled || this.#mode !== TRANSPORT.RUNNING) break;
      }
      if (handOn) return;
      // …and the frames up to where the sim clock has got to — which, when
      // the budget ran out, is back at the last tick run, not the `target`
      // the batch set out for. Read past it, the frames held every net no
      // node makes at the last tick's value across events still unrun, and
      // the ticks that ran them next batch went BACK in time under them: the
      // analyzer's voltage lanes drew flat stretches (2026-10-22).
      // (Ended with an event due, never past it: its tick comes first.)
      if (!this.#stalled && this.#mode === TRANSPORT.RUNNING) {
        if (left)
          this.#emitFrames(Math.min(left.at, target, this.#simNow()), false); // prettier-ignore
        else this.#emitFrames(Math.min(target, this.#simNow()), true);
      }
    } finally {
      this.#batchDepth -= 1;
      if (handOn) this.#handOn({ started, asked, target, moving, ran, budget });
    }
    if (this.#batchDepth === 0) this.#tellTicks();
    // A desk still moving is redrawn though nothing ticked — and one that
    // came to rest in this batch once more, as it rests (#publish): the last
    // frame it was redrawn at stood on its views for good.
    if ((moving || this.#frameAt != null) && !this.#owed) this.#sampleOwed = true; // prettier-ignore
    // …and so is one whose last frame showed a lamp's average.
    if (this.#glowShown && !this.#owed) this.#sampleOwed = true;
    // …and so is one whose last frame said it was behind, once it is not.
    if (this.#behindShown && !this.#owed && this.#behind() == null) this.#sampleOwed = true; // prettier-ignore
    // …and so is one whose meters are owed their next window.
    const meterDue = this.#meterOwed();
    if (!this.#owed && meterDue != null && meterDue <= this.#wall()) this.#sampleOwed = true; // prettier-ignore
    if (flush) this.#flushSoon();
    if (this.#mode === TRANSPORT.STOPPED) return;
    this.#meter.record(this.#wall(), this.#simNow());
    this.#arm();
  }

  /** A pacer's batch, between two of its slices: its next is the
      continuation's, at once — after whatever the thread was sent
      meanwhile, which may end it (#cancelPacer: Pause, an input, Stop, a
      speed change all do; the next batch is then one of its own). */
  #handOn(slice) {
    this.#tellTicks();
    this.#slice = slice;
    this.#pacerSoon = true;
    this.#pacer = this.#continuation.set(() => {
      this.#pacer = null;
      this.#pacerSoon = false;
      this.#runBatch({ budget: slice.budget, slice });
    }, 0);
  }

  /** The budget of a catch-up (an input's, Pause's) that comes between two
      of a sliced run's batches back to back — between two slices of one,
      or before the next on the continuation (a batch that ended with its
      debt kept, a frame due): one slice. Its debt is what the batches had
      still to run — on a desk that cannot keep up, a whole batch of work —
      so it runs as much as a slice would have, then drops the rest as a
      batch out of budget does (the sim clock back at the last tick run).
      Otherwise a batch's whole budget, as ever. */
  #cutBudget() {
    const between = this.#slice != null || this.#pacerSoon;
    return this.#sliceMs > 0 && between ? this.#sliceMs : this.#budgetMs;
  }

  /**
   * The earliest event due. A timed part's wake comes no sooner than
   * MIN_SHOWN_S after the last tick — nothing is drawn faster than the cap
   * (sim/timing.js), and Spice Lite asks for a wake at every CROSSING: ticked
   * at each one exactly, a tick would never span the crossings a cycle is
   * recognised by (spice/cycles.js), and a 48 kHz oscillator would be run
   * edge by edge. Clock edges keep their exact moments — and so does a
   * running AC wave's crossing of a pin's threshold (`edgeAt`, Jason
   * 2026-10-22): a sine into a 74LS14 is edges the desk must show, and held
   * back to MIN_SHOWN_S a fast one's every tick landed on one phase of it
   * and read its output as steady. Like a fast clock, it runs slowed when
   * the desk cannot keep up. Under the LOGIC engine a timed part's wake is
   * its own moment: its schedule is already held to the cap
   * (sim/timing.js `capSchedule`, `shownPulse`), and clamped after ANY tick
   * a one-shot's end less than MIN_SHOWN_S past a clock edge merged into
   * the next edge — a 0.7 ms one-shot on a 1 kHz trigger never went LOW, a
   * counter after it counted one pulse in twenty (the grade, 2026-10-23).
   */
  #nextEvent() {
    const clamp = this.#engine === ENGINES.spice ? MIN_SHOWN_S : 0;
    let wake =
      this.#wakeAt == null
        ? null
        : Math.max(this.#wakeAt, this.#tickAt + clamp);
    if (this.#edgeAt != null && this.#edgeAt > this.#tickAt) {
      wake = wake == null ? this.#edgeAt : Math.min(wake, this.#edgeAt);
    }
    // A bouncing contact's next make or break, at its own moment: a bounce
    // is faster than anything the cap draws (sim/bounce.js).
    const bounce = this.#bounce.active ? this.#bounce.nextAt(this.#tickAt) : null; // prettier-ignore
    if (bounce != null) wake = wake == null ? bounce : Math.min(wake, bounce);
    // The end of the settling window, while a warning waits on it.
    if (this.#settleCheck && this.#tickAt < SETTLE_S) wake = wake == null ? SETTLE_S : Math.min(wake, SETTLE_S); // prettier-ignore
    // …and of an underpowered chip's hold (UNDER_HOLD_S).
    if (this.#underDue != null && this.#underDue > this.#tickAt) wake = wake == null ? this.#underDue : Math.min(wake, this.#underDue); // prettier-ignore
    // A meter's fuse that has been past its rating long enough to blow.
    if (this.#fuseAt != null && this.#fuseAt > this.#tickAt) wake = wake == null ? this.#fuseAt : Math.min(wake, this.#fuseAt); // prettier-ignore
    return this.#schedule.next(wake);
  }

  /** An input is about to tick the board: run what fell due before it, so it
      lands after the edges that came first. */
  #catchUp() {
    this.#inputAt = this.#wall();
    this.#runBatch({ flush: false, budget: this.#cutBudget() });
    // A board that stalled on the way is shown now: the input waits.
    if (this.#stalled) this.#flushPublish();
  }

  /**
   * An edit is about to change the board under Spice Lite: tick the board AS
   * IT STOOD at the edit's moment first. The engine catches a late tick up
   * from the last one on the board it is HANDED (spice/engine.js — the
   * history replayed on the prior tick's clocks and signals, but on this
   * tick's document), so handed the edited board it replayed the whole quiet
   * stretch since the last tick as if the edit had been made then: a switch
   * thrown after three seconds with no tick charged its RC across all three
   * (the cap-electrolytic Timer read 5(1 − e^−3) = 4.75 V on the spot, its
   * Schmitt tripping at once). Run on here, the history is the old board's
   * and the edited one starts at the edit. Owed, not shown: the edit's own
   * tick follows at once. Nothing to do where there is no history (the logic
   * engine has none; a tick at this very moment needs none).
   */
  #runOnTo() {
    if (this.#engine !== ENGINES.spice || this.#stalled || !this.#base) return;
    const now = this.#simNow();
    if (!(now > this.#tickAt)) return;
    this.#batchDepth += 1;
    try {
      this.#tickOnce(now);
    } finally {
      this.#batchDepth -= 1;
    }
    if (this.#batchDepth === 0) this.#tellTicks();
  }

  /**
   * Pause or resume ONE free-running clock while the rest of the circuit runs
   * on — its own transport, beside the header's. A paused clock HOLDS the level
   * it was at (no edge is made on the way in or out), so its lamp and every
   * net it drives stay put while switches, signals and the other clocks carry
   * on. Only its own timer is started or stopped: re-scheduling the lot would
   * restart every other clock's half-period and delay its next edge.
   *
   * Run-volatile like the phase itself — Run starts every clock going and Stop
   * forgets. It is independent of the transport's Pause: a clock paused here
   * stays held when the transport resumes, and Step passes it by. A manual
   * clock has no timer to pause, so it is refused.
   */
  toggleClockPause(id) {
    if (this.#mode === TRANSPORT.STOPPED) return;
    const clock = this.#autoClocks().find((c) => c.id === id);
    if (!clock) return;
    this.#catchUp();
    const half = this.#presentHalf(clock);
    const now = this.#simNow();
    if (this.#pausedClocks.delete(id)) {
      // A wave picks up where it was held; a square's half starts afresh.
      const held = this.#clockHeld.get(id) ?? 0;
      this.#clockHeld.delete(id);
      const elapsed = this.#keepsPhase(clock) ? held * half : 0;
      this.#clockSince.set(id, now - elapsed);
      if (this.#mode === TRANSPORT.RUNNING) {
        this.#schedule.set(id, this.#halvesOf(clock), now, elapsed);
      }
    } else {
      this.#pausedClocks.add(id);
      this.#schedule.delete(id);
      const since = this.#clockSince.get(id) ?? now;
      this.#clockHeld.set(id, Math.min(1, Math.max(0, (now - since) / half)));
    }
    // No edge was made, so this settle changes nothing — it is how the new
    // paused set reaches the views, which render only from sim-state.
    this.#tickNow();
  }

  /** Is this clock held by its own pause? (False whenever stopped.) */
  isClockPaused(id) {
    return this.#pausedClocks.has(id);
  }

  /** Manually toggle one clock (a manual clock's click, or programmatic). */
  manualToggle(id) {
    if (this.#mode === TRANSPORT.STOPPED) return;
    if (this.#hold(() => this.#flip(id))) return;
    this.#catchUp();
    this.#flip(id);
    this.#tickNow();
  }

  /**
   * A signal button went down (`on`) or came up. The ONE entry point for both
   * the rail's pointer press and the digit keys, and the one place that knows
   * what momentary and toggle mean — deliberately, because if the two callers
   * each decided, a key and a click could come to disagree about what a press
   * does. Both simply report down → true, up → false.
   *
   * A MOMENTARY signal asserts the opposite of its resting level while held; a
   * TOGGLE flips on the press and ignores the release.
   */
  pressSignal(id, on) {
    if (this.#mode === TRANSPORT.STOPPED) return;
    const sig = this.#signals().find((s) => s.id === id);
    if (!sig) return;
    if (sig.type === "toggle" && !on) return; // a toggle acts on the PRESS only
    if (this.#hold(() => this.#setSignal(sig, on))) return;
    this.#catchUp();
    this.#setSignal(sig, on);
    this.#tickNow();
  }

  /** A signal's level after a press (`on`) or a release. */
  #setSignal(sig, on) {
    const rest = restLevel(sig) === "high" ? H : L;
    if (sig.type === "toggle") {
      this.#signalLevel.set(
        sig.id,
        (this.#signalLevel.get(sig.id) ?? rest) === H ? L : H,
      );
    } else {
      this.#signalLevel.set(sig.id, on ? (rest === H ? L : H) : rest);
    }
  }

  /** The desk's signals, live off the document (the shape #clocks() has). */
  #signals() {
    return this.#document().signals ?? [];
  }

  // ── Clock scheduling (the ONLY timer — the engine stays timerless) ────────

  /** Free-running edge sources: clock bricks (`kind:"clock"`) and board-seated
      oscillator cans — anything the engine reads via clockPhase. (An AC
      supply is none: its sine is the simulated time's alone, spice/waves.js
      `acGenerator`.) */
  #clocks() {
    return this.#document().components.filter(
      (c) => c.kind === "clock" || isOscillator(partDef(c.ref)),
    );
  }

  // ── Memory images (Feature 190: volatile SRAM vs file-backed ROM) ─────────

  /**
   * Seed a fresh image per memory chip on Run. A VOLATILE (SRAM) chip gets a
   * cleared run-volatile image (no file). A NON-VOLATILE (ROM/EPROM/EEPROM)
   * chip loads its `.bin` from the app working folder over the GUID-keyed
   * `mem:load` IPC — after ensuring the file exists (created noise-filled if
   * missing, which for a chip flagged `programmed` means its data was lost).
   * Returns a promise that resolves once every ROM load has settled, or null
   * when there is no ROM (Run then stays fully synchronous).
   */
  #seedImages(token) {
    this.#images = new Map();
    this.#memInfo = new Map();
    this.#memLost = new Set();
    const loads = [];
    for (const c of this.#doc.toJSON().components) {
      const def = partDef(c.ref);
      if (!isMemory(def)) continue;
      const info = {
        volatile: isVolatileMemory(def),
        guid: memGuid(c),
        width: memoryConfig(def).width,
        byteLength: byteLengthOf(def),
        ref: c.ref,
      };
      this.#memInfo.set(c.id, info);
      if (info.volatile) {
        this.#images.set(c.id, seedImage(def)); // SRAM: cleared, no file
      } else {
        this.#images.set(c.id, blankImage(def)); // reads 0 until the load lands
        loads.push(this.#loadRom(c.id, c, def, info, token));
      }
    }
    return loads.length ? Promise.all(loads) : null;
  }

  /** Load a ROM chip's image from its backing file (creating the file first).
      `token` is this call's #runToken snapshot — a fast Stop→Start on this
      SAME controller instance re-arms #mode to RUNNING before this straggling
      load resolves, so #mode alone can't tell a superseded run from the
      current one; only a token mismatch can. */
  async #loadRom(compId, comp, def, info, token) {
    const stale = () => token !== this.#runToken || this.#mode === TRANSPORT.STOPPED; // prettier-ignore
    const mem = this.#scope.chiphippo?.mem;
    try {
      // A ROM should have a GUID from placement; mint one defensively if not.
      if (!info.guid) {
        info.guid = crypto.randomUUID();
        this.#doc.setComponentParams(compId, { storage: { guid: info.guid } });
      }
      const created = await mem?.create(info.guid, info.byteLength);
      if (stale()) return; // run aborted, or superseded by a newer run
      // A programmed chip whose file had to be recreated lost its data (the
      // classic delete-then-undo). It now holds random noise — say so loudly.
      if (created?.created && comp.params?.programmed === true) {
        this.#warnDataLoss(compId);
      }
      const res = await mem?.load(info.guid, info.byteLength);
      if (stale()) return;
      if (!res || res.ok === false) {
        throw new Error(res?.error ?? "no memory bridge");
      }
      this.#images.set(compId, unpackImage(def, res.bytes));
    } catch (err) {
      if (stale()) return; // a superseded run's own failure is nobody's business
      this.#notify({
        key: `mem-load:${compId}`,
        variant: "danger",
        sticky: true,
        title: t("sim.memNotLoaded"),
        message: t("sim.memNotLoadedMessage", {
          chip: this.#refName(compId),
          error: err.message,
        }),
      });
    }
  }

  /**
   * Apply the tick's reported (word) writes and return per-component BYTE-level
   * changes (for the live inspector). A VOLATILE chip's writes land in its
   * run-volatile image; a NON-VOLATILE (ROM) chip is read-only in this app — the
   * circuit cannot drive a write cycle, so any reported write is DROPPED.
   * @returns {Map<string, Array<[number, number]>>} compId → [[byteAddr, byteVal]]
   */
  #applyWrites(writes) {
    const changes = new Map();
    for (const { compId, addr, value } of writes ?? []) {
      const info = this.#memInfo.get(compId);
      if (!info || !info.volatile) continue; // ROM is read-only → drop
      const img = this.#images.get(compId);
      if (!img || addr < 0 || addr >= img.length) continue;
      img[addr] = value;
      let arr = changes.get(compId);
      if (!arr) changes.set(compId, (arr = []));
      for (const bw of wordToBytes(info.width, addr, value)) arr.push(bw);
    }
    return changes;
  }

  /**
   * A VOLATILE chip that has lost its power has lost its contents: its image
   * goes back to what Run seeds (`seedImage`), once — while it stays
   * unpowered — as the engine puts every sequential chip back to its
   * power-up state (sim/engine.js, the tick's step loop). Kept, an SRAM
   * switched off and on again still held what the program wrote. Returns the
   * byte changes for the live inspector.
   * @returns {Map<string, Array<[number, number]>>}
   */
  #forgetUnpowered(chipStatus) {
    const changes = new Map();
    for (const [compId, info] of this.#memInfo) {
      if (!info.volatile) continue;
      const status = chipStatus?.get(compId)?.status;
      if (status !== CHIP_STATUS.UNPOWERED && status !== CHIP_STATUS.REVERSED) {
        this.#memLost.delete(compId);
        continue;
      }
      if (this.#memLost.has(compId)) continue;
      this.#memLost.add(compId);
      const img = this.#images.get(compId);
      const def = partDef(info.ref);
      if (!img || !def) continue;
      const fresh = seedImage(def);
      const list = [];
      for (let addr = 0; addr < img.length; addr++) {
        if (img[addr] === fresh[addr]) continue;
        for (const bw of wordToBytes(info.width, addr, fresh[addr])) list.push(bw); // prettier-ignore
      }
      this.#images.set(compId, fresh);
      if (list.length) changes.set(compId, list);
    }
    return changes;
  }

  /** Warn once that a programmed chip's backing file was missing (data lost). */
  #warnDataLoss(compId) {
    if (this.#dataLossWarned.has(compId)) return;
    this.#dataLossWarned.add(compId);
    this.#notify({
      key: `mem-lost:${compId}`,
      variant: "danger",
      sticky: true,
      title: t("sim.memLost"),
      message: t("sim.memLostMessage", { chip: this.#refName(compId) }),
    });
  }

  /** Keep this tick's byte changes for the inspector windows, behind any the
      batch already holds (a later write to a byte lands after an earlier). */
  #oweMemChanges(changes) {
    for (const [compId, list] of changes) {
      const owed = this.#memOwed.get(compId);
      if (owed) owed.push(...list);
      else this.#memOwed.set(compId, list);
    }
  }

  /** Broadcast the byte changes owed to any open inspector windows. */
  #flushMem() {
    if (this.#memOwed.size === 0) return;
    const changes = this.#memOwed;
    this.#memOwed = new Map();
    this.#tellTicks(); // whatever this thread tells, in the order it ran
    this.#scope.dispatchEvent(
      new CustomEvent("chiphippo:mem-state", {
        detail: { running: true, changes },
      }),
    );
  }

  /**
   * A flat little-endian byte snapshot of a memory chip's live image, or null
   * when it is not running / not a memory chip. The memory-bridge hands this to
   * a newly-opened inspector so it shows the running contents at once.
   */
  imageBytesOf(compId) {
    const img = this.#images.get(compId);
    if (!img) return null;
    return packImage(this.#memInfo.get(compId)?.width ?? 8, img);
  }

  /** Raise a toast, remembering its key so Stop takes down exactly these. */
  #notify(opts) {
    if (opts?.key) this.#toastKeys.add(opts.key);
    this.#notifications?.notify(opts);
  }

  /**
   * A circuit warning (#report): raised the first time the run meets it, and
   * again only when what it says changes — never once a tick. A DANGER one
   * (a short, smoke, reversed power, supplies fighting) stays until it is
   * clicked away or the run stops, so a fault does not vanish while it
   * stands; the rest go after the stack's usual few seconds.
   */
  #warn(opts) {
    // One that states a reading (`reading`: {value, within}) is the same
    // warning while the reading has moved less than `within` since it was
    // said: a chip underpowered by a droop still settling was said at 3.82,
    // 3.69 and 3.70 V, three toasts in as many ticks (the fourth regrade,
    // 2026-10-22).
    const kind = `${opts.variant}\u0000${opts.title ?? ""}`;
    let was = this.#warned.get(opts.key);
    this.#reported?.add(opts.key);
    // Gone and back: after REARM_S, said as if for the first time; sooner,
    // the same warning still standing.
    // (Measured to when it came BACK — `since`, a warning held back
    // before it is said — not to when it is said.)
    if (was?.clearedAt != null) {
      if ((opts.since ?? this.#tickAt) - was.clearedAt >= REARM_S)
        was = undefined; // prettier-ignore
      else was.clearedAt = null;
    }
    if (opts.reading) {
      const { value, within } = opts.reading;
      if (was?.kind === kind && Math.abs(was.value - value) < within) return;
      this.#warned.set(opts.key, { kind, value });
    } else {
      // The rest are the same warning while their words are, numbers aside,
      // and no number has grown past the most said by WARN_GROWTH.
      const words = `${kind}\u0000${wordsOf(opts.message)}`;
      const numbers = numbersIn(opts.message);
      if (was?.words === words && was.most.length === numbers.length) {
        const grew = numbers.some((x, i) => x > was.most[i] * (1 + WARN_GROWTH)); // prettier-ignore
        if (!grew) return;
        this.#warned.set(opts.key, { words, most: numbers.map((x, i) => Math.max(x, was.most[i])) }); // prettier-ignore
      } else this.#warned.set(opts.key, { words, most: numbers });
    }
    const { reading: _reading, since: _since, ...toast } = opts;
    this.#notify(toast.variant === "danger" ? { ...toast, sticky: true } : toast); // prettier-ignore
  }

  #autoClocks() {
    // A clock brick may be in manual mode; an oscillator can never is — a
    // real crystal has no click-to-toggle pin.
    return this.#clocks().filter((c) =>
      c.kind === "clock" ? partDef("clock").isAuto(c.params) : true,
    );
  }

  /** The free-running clocks actually advancing: every auto clock bar the
      ones paused on their own. The timers and Step both read this. */
  #tickingClocks() {
    return this.#autoClocks().filter((c) => !this.#pausedClocks.has(c.id));
  }

  #flip(id) {
    this.#clockPhase.set(id, this.#clockPhase.get(id) === H ? L : H);
  }

  /** Every ticking clock's edges afresh from now (Run, resume), and the
      pacer armed for the first of them. */
  #scheduleClocks() {
    this.#schedule.clear();
    if (this.#mode !== TRANSPORT.RUNNING) return;
    const now = this.#simNow();
    for (const c of this.#tickingClocks()) {
      // A wave resumes where it was paused, its next edge as far off as it
      // was; a square's half starts afresh, as it always has.
      const half = this.#presentHalf(c);
      const since = this.#clockSince.get(c.id);
      const elapsed =
        since != null && this.#keepsPhase(c)
          ? Math.min(half, Math.max(0, now - since))
          : 0;
      this.#schedule.set(c.id, this.#halvesOf(c), now, elapsed);
      this.#clockSince.set(c.id, now - elapsed);
    }
    this.#arm();
  }

  /** Whether a clock's place between its edges is part of what it puts out
      — a Spice Lite wave's is (sim/spice/waves.js); a level's (a square, a
      PWM) is not. */
  #keepsPhase(c) {
    return (
      this.#engine === ENGINES.spice &&
      c.kind === "clock" &&
      !LEVEL_WAVES.includes(partDef("clock").waveOf(c.params))
    );
  }

  /** A free-running clock's LOW and HIGH halves (sim/schedule.js): a PWM
      brick's by its pulse width, every other clock's (an oscillator can's
      too) equal. */
  #clockHalves(c) {
    const duty = c.kind === "clock" ? partDef("clock").dutyOf(c.params) : 0.5;
    return clockHalves(c.params.hz, duty);
  }

  /** The half a clock stands in now — by its level — in seconds. */
  #presentHalf(c) {
    const { low, high } = this.#clockHalves(c);
    return this.#clockPhase.get(c.id) === H ? high : low;
  }

  /** What the schedule runs a clock at from its level now: one half for a
      square, `[present, next]` for a PWM (EdgeSchedule.set). */
  #halvesOf(c) {
    const { low, high } = this.#clockHalves(c);
    if (low === high) return low;
    return this.#clockPhase.get(c.id) === H ? [high, low] : [low, high];
  }

  /** Each free-running clock's half-period and last edge (or, held by its
      own pause, how far into its half it stands): where a Spice Lite wave
      is between edges. */
  #clockTimes() {
    const out = new Map();
    for (const c of this.#autoClocks()) {
      const half = this.#presentHalf(c);
      const held = this.#clockHeld.get(c.id);
      out.set(
        c.id,
        held != null
          ? { half, frac: held }
          : { half, since: this.#clockSince.get(c.id) ?? this.#tickAt },
      );
    }
    return out;
  }

  /**
   * Bring the schedule in line with the document WITHOUT touching a clock
   * that has not changed: start the new or re-rated ones, drop the ones gone.
   * A doc change fires on every switch flip, and restarting every clock on
   * each one delayed every clock's next edge — flip a switch more often than
   * a slow clock's half-period and that clock never ticked at all.
   */
  #reconcileClocks() {
    if (this.#mode !== TRANSPORT.RUNNING) return;
    const ticking = this.#tickingClocks();
    const wanted = new Set(ticking.map((c) => c.id));
    for (const id of this.#schedule.halves.keys()) {
      if (!wanted.has(id)) this.#schedule.delete(id);
    }
    const now = this.#simNow();
    for (const c of ticking) {
      // A PWM whose pulse width moved — the same period, split anew — keeps
      // its place in its half (the slider applies as it is dragged, and a
      // restart on every step of it would hold a slow clock's edge off for
      // as long as the drag lasts); a re-rated clock starts afresh.
      const halves = this.#halvesOf(c);
      const period = this.#schedule.periodOf(c.id);
      const { low, high } = this.#clockHalves(c);
      const since = this.#clockSince.get(c.id);
      const elapsed =
        period != null &&
        since != null &&
        Math.abs(period - (low + high)) <= COINCIDENT_S
          ? Math.max(0, now - since)
          : 0;
      if (this.#schedule.set(c.id, halves, now, elapsed)) {
        this.#clockSince.set(c.id, now - elapsed);
      }
    }
  }

  // ── Input events (re-settle without advancing the clock) ─────────────────

  // The edges that fell due BEFORE an input are caught up against the board
  // as it was before it: the document snapshot and the netlist prepared with
  // it (#tickOnce pairs them) are still the pre-edit ones until
  // #forgetDocument, so the catch-up runs first and the edit lands after it.
  // Under Spice Lite the board as it was also runs ON to the edit's moment
  // (#runOnTo): time passed on it since the last tick too.

  #onPartState = () => {
    const live = this.running && !this.#suppress;
    if (live && this.#holdBoard()) {
      this.#partStateVersion += 1;
      return;
    }
    if (live) this.#catchUp();
    if (live) this.#runOnTo();
    // (Bumped after the board as it was has run on: the bounce reads a new
    // version as a contact that moved.)
    this.#partStateVersion += 1;
    this.#forgetDocument();
    if (!live) return;
    this.#tickNow();
  };

  #onDocChanged = () => {
    this.#scopeEpoch += 1; // a channel may have come, gone or moved
    const live = this.running && !this.#suppress;
    if (live && this.#holdBoard(() => this.#reconcileClocks())) return;
    if (live) this.#catchUp();
    if (live) this.#runOnTo();
    this.#forgetDocument();
    if (!live) return;
    // A clock's rate may have changed via its menu, or a clock come or gone —
    // retime just those, then settle.
    this.#reconcileClocks();
    this.#tickNow();
  };

  /**
   * A switch flipped or a button pressed while the chip debugger holds the
   * board is an input like a signal key, and is HELD like one (`#hold`): a
   * press and its release inside one stall would otherwise both land before
   * the one tick after it, which then sees no edge at all. The desk has
   * already moved on, so what is queued is the board AS IT STOOD — the
   * document and the netlist built with it, taken now — and each replays as
   * its own tick. (`after` is the doc-change's clock retiming.)
   * @returns {boolean} whether it was held
   */
  #holdBoard(after = null) {
    if (!this.#debugStalled) return false;
    const doc = this.#doc.toJSON();
    const netlist = this.#netlist.get(this.#engine === ENGINES.spice ? { inductors: "branch" } : undefined); // prettier-ignore
    return this.#hold(() => {
      this.#docSnap = doc;
      this.#base = { doc, netlist };
      this.#contactsSeen = null;
      this.#circuit = prepareCircuit(doc, netlist);
      after?.();
    });
  }

  /**
   * Something outside the board changed — an Arduino's value arrived — and it
   * may be applied at the next boundary. A tick provides one: while the board
   * is quiet that is now, and while it is stalled it is when the stall ends.
   */
  wake() {
    this.#catchUp();
    this.#tickNow();
  }

  /** Is the board waiting on an integration settle (or the chip debugger)
      right now? */
  get stalled() {
    return this.#stalled;
  }

  /**
   * The whole of a run as plain data, for another SimController to carry on
   * from exactly where this one is (`importRun`) — a run moved from the sim
   * Worker to the main thread when a custom chip is armed for debugging
   * (components/sim-host.js). Null while stopped or stalled.
   */
  exportRun() {
    if (this.#mode === TRANSPORT.STOPPED || this.#stalled) return null;
    this.#catchUp();
    return {
      mode: this.#mode,
      speed: this.#speed,
      runConfig: this.#runConfig,
      engine: this.#engine.id,
      simNow: this.#simNow(),
      tickAt: this.#tickAt,
      wakeAt: this.#wakeAt,
      edgeAt: this.#edgeAt,
      frameAt: this.#frameAt,
      scopeAt: this.#scopeAt,
      warm: this.#warm,
      state: this.#state,
      prevPins: this.#prevPins,
      cpuTracks: this.#cpuTracks,
      overStop: this.#overStop,
      clockPhase: this.#clockPhase,
      pausedClocks: this.#pausedClocks,
      clockSince: this.#clockSince,
      clockHeld: this.#clockHeld,
      signalLevel: this.#signalLevel,
      images: this.#images,
      memInfo: this.#memInfo,
      dataLossWarned: this.#dataLossWarned,
      // What it has said, what it is holding back till the circuit has
      // risen, and the volatile memories a power loss has wiped: carried, or
      // the other side says every standing warning again — and never one
      // held back past SETTLE_S on a desk nothing else wakes.
      warned: new Map(this.#warned),
      settleCheck: this.#settleCheck,
      underSince: new Map(this.#underSince),
      underDue: this.#underDue,
      memLost: new Set(this.#memLost),
      schedule: this.#schedule.export(),
      // A switch's bounce under way and the moves its seed counts, and the
      // lamps' averaging window: dropped, a press just before the hand-over
      // closed solid at once, and the next frame showed a PWM LED's bare
      // tick (the fourth regrade, 2026-10-22).
      bounce: this.#bounce.export(),
      lamps: this.#lamps.export(),
      supplyAmps: this.#supplyAmps.export(),
      // The meters' windows, and what their displays show now.
      meters: { windows: this.#meters.export(), at: this.#meterAt, shown: [...this.#meterShown], fuseOver: [...this.#fuseOver].map(([id, f]) => [id, { ...f }]), fuseAt: this.#fuseAt, keys: [...this.#meterKeys] }, // prettier-ignore
      glow: this.#shownGlow,
      // Its curves and charges, less a drawn cycle (whose record names the
      // document and netlist objects it was drawn on: it is found again).
      analog: this.#analog ? { ...this.#analog, cycle: null, cycles: null, ran: null, warm: null, settledAt: null, voltages: null } : null, // prettier-ignore
    };
  }

  /**
   * Carry on a run `exportRun` gave — this controller stopped, never run.
   * Its collaborators were told of the run's start by whoever ran it; the
   * board is published at once.
   * @param {object} run
   */
  importRun(run) {
    if (this.#mode !== TRANSPORT.STOPPED || !run) return;
    this.#mode = run.mode;
    this.#speed = run.speed;
    this.#runConfig = run.runConfig;
    this.#engine = run.engine === ENGINES.spice.id ? ENGINES.spice : ENGINES.digital; // prettier-ignore
    this.#forgetDocument();
    this.#runToken++;
    this.#warm = run.warm;
    this.#carry = null;
    this.#state = run.state;
    this.#prevPins = run.prevPins;
    this.#cpuTracks = run.cpuTracks ?? new Map();
    this.#overStop = run.overStop ?? null;
    this.#clockPhase = run.clockPhase;
    this.#pausedClocks = run.pausedClocks;
    this.#clockSince = run.clockSince;
    this.#clockHeld = run.clockHeld;
    this.#signalLevel = run.signalLevel;
    this.#images = run.images;
    this.#memInfo = run.memInfo;
    this.#dataLossWarned = run.dataLossWarned;
    this.#warned = new Map(run.warned ?? []);
    this.#settleCheck = run.settleCheck === true;
    this.#underSince = new Map(run.underSince ?? []);
    this.#underDue = run.underDue ?? null;
    this.#memLost = new Set(run.memLost ?? []);
    this.#analog = run.analog;
    this.#tickAt = run.tickAt;
    this.#wakeAt = run.wakeAt;
    this.#edgeAt = run.edgeAt ?? null;
    this.#frameAt = run.frameAt;
    this.#scopeAt = run.scopeAt ?? null;
    this.#schedule.import(run.schedule);
    this.#bounce.import(run.bounce);
    this.#lamps.import(run.lamps);
    this.#supplyAmps.import(run.supplyAmps);
    this.#meters.import(run.meters?.windows);
    this.#meterAt = run.meters?.at ?? null;
    this.#meterShown = new Map(run.meters?.shown ?? []);
    this.#fuseOver = new Map((run.meters?.fuseOver ?? []).map(([id, f]) => [id, { ...f }])); // prettier-ignore
    this.#fuseAt = run.meters?.fuseAt ?? null;
    // What each window was opened on: without it the first #meterList here
    // took every imported window for a meter whose probes had moved.
    this.#meterKeys = new Map(run.meters?.keys ?? []);
    this.#heldGlow = run.glow ?? null;
    this.#simAnchor = run.simNow;
    this.#realAnchor = null;
    if (this.#mode === TRANSPORT.RUNNING) this.#thaw();
    this.#tickNow();
  }

  /**
   * Which CPU the CPU monitor shows (a component id, or null for none): its
   * summary rides every `sim-state` from now on. Every CPU's record is kept
   * whether it is shown or not, so one opened mid-run has its history.
   * `view.memAt` is where its memory block starts — a row the window went
   * to — or null to follow PC.
   * @param {string|null} compId
   * @param {{memAt?: number|null}|null} [view]
   */
  monitorCpu(compId, view = null) {
    const id = typeof compId === "string" ? compId : null;
    const memAt = Number.isInteger(view?.memAt) ? memBase(view.memAt) : null;
    if (id === this.#cpuWatch && memAt === this.#cpuView.memAt) return;
    this.#cpuWatch = id;
    this.#cpuView = { memAt };
    if (this.#mode !== TRANSPORT.STOPPED && !this.#stalled) this.#republish();
  }

  /** The CPUs on `doc` (a snapshot — so this is worked out once per edit). */
  #cpusOn(doc) {
    if (this.#cpuList.doc !== doc) {
      const cpus = [];
      for (const c of doc.components ?? []) {
        const cpu = c.kind === "chip" ? cpuOf(partDef(c.ref)) : null;
        if (cpu) cpus.push({ id: c.id, cpu });
      }
      this.#cpuList = { doc, cpus };
    }
    return this.#cpuList.cpus;
  }

  /**
   * A Step Over's call has come back, if not to the instruction after it: a
   * routine that reads its arguments from the bytes after the call (the
   * 6502's `JSR PRIMM / .byte "text",0`, a Z80 `RST` that steps over its
   * operand) comes back PAST them, so `returned` alone would leave the run
   * going until Pause. Back is an instruction starting
   *   · a little past the return address (within MAX_INLINE_BYTES),
   *   · with the stack where the call found it (`unwound`, as `returned`
   *     takes it — a routine may drop a byte or two of its caller's too),
   *   · NOTHING run between the return address and here since the Step
   *     Over began (`over.ran`, the nearest instruction start in that window
   *     — `#noteRan`): what lies there is the arguments, never executed,
   *   · and, when the instruction just run lies further into the window (a
   *     routine placed right after its own call site), not arrived at by a
   *     jump that NAMES its target (`isJump`: JMP/JP nn, JR, a branch) —
   *     that is the routine going to a helper below its entry, which meets
   *     the three tests above as well. A return or a computed jump (`JP
   *     (HL)`, `JMP (ptr)` — the inline-argument routine's own way back)
   *     still counts. Only that one case reads memory: the instruction run
   *     last, decoded through the circuit as the monitor does.
   * Such a routine pops its return address, so inside it the stack stands at
   * the call's level too — but a stop there would be somewhere code HAS run
   * since: a routine near the call site has run its own instructions, a
   * nested call ran its CALL, an untaken RET cc ran itself; one far away is
   * out of the window. What the bytes before here LOOK like no longer
   * matters (an argument ending in an RST opcode, a string with a space —
   * JSR — two from its end, both read as "a call returning here" once), nor
   * how it got here (a RET, an interrupt's return after it, a computed jump
   * past the arguments).
   */
  #cameBack(over, cpu, state) {
    const past = (cpu.pcOf(state) - over.ret) & 0xffff;
    if (past === 0 || past > MAX_INLINE_BYTES) return false;
    if (!unwound(over, cpu, state)) return false;
    if (over.ran != null && over.ran < past) return false;
    const prev = over.prev;
    if (prev != null && prev > past && prev <= MAX_INLINE_BYTES) {
      return !this.#jumpedFrom(over, cpu, (over.ret + prev) & 0xffff);
    }
    return true;
  }

  /** Is the instruction at `pc` a jump that names its target (`isJump`)?
      Read through the circuit as the last tick left it; unreadable is no. */
  #jumpedFrom(over, cpu, pc) {
    const tick = this.#lastTick;
    if (!cpu.isJump || !tick) return false;
    const env = this.#cpuEnv(over.compId, tick.result, tick.netlist);
    if (!env) return false;
    return cpu.isJump(cpu.disassemble(this.#cpuMap.reader(env), pc));
  }

  /** An instruction began at `pc` while Step Over `over` ran: kept as the
      nearest start at or past its return address, within the window, and
      as the one run last (`over.prev`, its offset). */
  #noteRan(over, pc) {
    const at = (pc - over.ret) & 0xffff;
    if (at <= MAX_INLINE_BYTES && (over.ran == null || at < over.ran)) {
      over.ran = at;
    }
    over.prev = at;
  }

  /** One tick, into every CPU's record — and a breakpoint, if one was hit. */
  #observeCpus(doc, result) {
    for (const { id, cpu } of this.#cpusOn(doc)) {
      let track = this.#cpuTracks.get(id);
      if (!track) this.#cpuTracks.set(id, (track = newTrack()));
      const state = result.state.get(id);
      const started = observeTick(track, cpu, state, result.pinLevels.get(id));
      const step = this.#opStep;
      if (step?.compId === id && !step.over) {
        // A waiting CPU's Step: one bus cycle. And a Step that STARTS one
        // waiting — the HALT or WAI it began on has run, and nothing starts
        // after it until an interrupt — ends there, the CPU shown waiting.
        if (
          step.idleFrom != null
            ? track.cycles > step.idleFrom
            : cpu.waiting?.(state)
        ) {
          // prettier-ignore
          step.done = true;
        }
      }
      if (!started) continue;
      const sp = cpu.spOf(state);
      if (step?.compId === id && step.over) carryAcrossInterrupt(step.over, started, sp); // prettier-ignore
      if (this.#overStop?.compId === id && this.#overStop !== step?.over) {
        carryAcrossInterrupt(this.#overStop, started, sp);
      }
      const back = (o) =>
        started === "instr" &&
        (returned(o, cpu, state) || this.#cameBack(o, cpu, state));
      if (step?.compId === id && (!step.over || back(step.over))) {
        step.done = true;
      }
      const addr = cpu.pcOf(state);
      const over = this.#overStop;
      if (over?.compId === id && back(over)) {
        this.#overStop = null;
        this.#breakHit ??= { compId: id, addr, over: true };
      }
      // What ran, for `#cameBack` — noted AFTER it asked about this start.
      if (started === "instr") {
        const running = step?.compId === id ? step.over : null;
        if (running) this.#noteRan(running, addr);
        if (over?.compId === id && over !== running) this.#noteRan(over, addr);
      }
      if (started !== "instr" || this.#breakHit) continue;
      if (this.#cpuBreaks.get(id)?.has(addr)) this.#breakHit = { compId: id, addr }; // prettier-ignore
    }
  }

  /**
   * The CPU monitor's breakpoints for one CPU: the addresses whose
   * instruction pauses the run the moment it begins (its opcode fetch, before
   * any of it has run). An empty list clears them.
   * @param {string} compId
   * @param {number[]} addrs
   */
  setCpuBreakpoints(compId, addrs) {
    const set = new Set((addrs ?? []).filter((a) => Number.isInteger(a)).map((a) => a & 0xffff)); // prettier-ignore
    if (set.size) this.#cpuBreaks.set(compId, set);
    else this.#cpuBreaks.delete(compId);
    // The monitor lists them decoded: a paused board says so at once.
    if (compId === this.#cpuWatch && this.#mode !== TRANSPORT.STOPPED && !this.#stalled) this.#republish(); // prettier-ignore
  }

  /**
   * The CPU monitor's Step: transport Steps, one edge each, until `compId`
   * STARTS its next operation — an instruction's opcode fetch (the moment a
   * breakpoint stops at) or a reset/interrupt sequence — or reaches a
   * breakpoint, and the board stays paused there. Paused only, and not while
   * a stall holds the board. The ticks are one batch: each is heard on
   * `sim-tick` as ever, the views are told once, at the end. Gives up after
   * MAX_OP_EDGES edges or OP_STEP_BUDGET_MS, and at once with nothing to
   * step (no free-running clock and no timed part to wake — a manual clock
   * is the user's to click). Whether it reached an operation's start.
   * @param {string} compId - the CPU
   */
  stepCpu(compId) {
    if (this.#mode !== TRANSPORT.PAUSED || this.#stalled) return false;
    const entry = this.#cpusOn(this.#document()).find((c) => c.id === compId);
    if (!entry) return false;
    // A CPU waiting for an interrupt (HALT, WAI, STP) starts nothing until
    // one comes — and the Step's whole budget, the board run on thousands of
    // clocks, was what a press cost. There a Step is ONE bus cycle (`idleFrom`:
    // the cycle count it began at), or less if an interrupt starts something.
    const state = this.#lastShown?.result.state.get(compId);
    const track = this.#cpuTracks.get(compId);
    const idleFrom =
      state && track && entry.cpu.waiting?.(state) ? track.cycles : null;
    return this.#runCpuStep({ compId, done: false, over: null, idleFrom }, MAX_OP_EDGES); // prettier-ignore
  }

  /**
   * The CPU monitor's Step Over, offered while `compId` is at a CALL (a
   * JSR, CALL or RST — the core's `isCall`): the board runs on until the
   * instruction after it begins with the stack back where the call found it
   * (so a recursive call's inner return does not count), or a breakpoint is
   * reached. As Step, the edges are run at once — but a call can take far
   * longer than a Step's budget (a delay loop), so what is left when the
   * budget runs out is handed to the RUN: it resumes with the return armed
   * as a breakpoint of one use (`#overStop`), paced as any run, and pauses
   * there (`chiphippo:cpu-break` with `over`). Pause cancels it. `"done"`
   * (stopped at the return or a breakpoint), `"running"` (handed to the run)
   * or false (not paused, not a CPU, not at a call).
   * @param {string} compId
   */
  stepOverCpu(compId) {
    if (this.#mode !== TRANSPORT.PAUSED || this.#stalled || !this.#lastShown) return false; // prettier-ignore
    const env = this.#cpuEnv(compId, this.#lastShown.result, this.#lastShown.netlist); // prettier-ignore
    const state = env?.state.get(compId);
    if (!state || !env.cpu.isCall) return false;
    const pc = env.cpu.pcOf(state);
    const line = env.cpu.disassemble(this.#cpuMap.reader(env), pc);
    if (!env.cpu.isCall(line)) return false;
    const over = {
      compId,
      ret: (pc + line.length) & 0xffff,
      sp: env.cpu.spOf(state),
      mask: env.cpu.spMask,
      ran: null, // see #cameBack
      prev: null, // …and the instruction run last
      held: null, // …set aside while an interrupt runs (carryAcrossInterrupt)
    };
    if (this.#runCpuStep({ compId, done: false, over }, MAX_OVER_EDGES)) {
      return "done";
    }
    if (this.#mode !== TRANSPORT.PAUSED || this.#stalled) return false;
    this.#overStop = over;
    this.resume();
    // The Worker's host answers the transport itself: it hears of this.
    this.#tellTicks();
    this.#scope.dispatchEvent(
      new CustomEvent("chiphippo:cpu-resumed", { detail: { compId } }),
    );
    return "running";
  }

  /** Run edges, as one batch, until `op` is done (Step, Step Over) — or the
      edge cap or the wall-clock budget is reached, or there is nothing to
      step. Whether it got there. */
  #runCpuStep(op, maxEdges) {
    this.#opStep = op;
    const started = this.#wall();
    this.#batchDepth += 1;
    try {
      for (let n = 0; n < maxEdges && !op.done; n++) {
        if (!this.#tickingClocks().length && this.#wakeAt == null) break;
        if (n && this.#wall() - started >= OP_STEP_BUDGET_MS) break;
        this.#advance();
        this.#tickNow();
        if (this.#stalled || this.#mode !== TRANSPORT.PAUSED) break;
      }
    } finally {
      this.#batchDepth -= 1;
      this.#opStep = null;
    }
    if (this.#batchDepth === 0) this.#tellTicks();
    if (this.#mode !== TRANSPORT.STOPPED) this.#flushPublish();
    return op.done;
  }

  /**
   * A breakpoint was hit by the tick just run: a running board PAUSES there
   * — time frozen at that tick, the rest of the batch left unrun, exactly
   * as Pause leaves it — and `chiphippo:cpu-break` says where (with
   * `paused`: whether this is what paused it; a Step onto one was already
   * paused).
   */
  #breakAt() {
    const hit = this.#breakHit;
    this.#breakHit = null;
    // A CPU Step stops at any breakpoint it reaches, another CPU's included,
    // and a Step Over running on to its return ends there too.
    if (this.#opStep) this.#opStep.done = true;
    this.#overStop = null;
    const paused = this.#mode === TRANSPORT.RUNNING;
    if (paused) {
      this.#mode = TRANSPORT.PAUSED;
      this.#cancelPacer();
      this.#schedule.clear();
      this.#freeze(this.#tickAt);
      if (!this.#flushPublish()) this.#republish();
      this.#onTransportChange?.(this.#mode);
    }
    // `paused` says the BREAK paused the run (the monitor raises its window
    // on that) — not a Pause pressed, whose catch-up merely reached one.
    this.#tellTicks();
    this.#scope.dispatchEvent(
      new CustomEvent("chiphippo:cpu-break", {
        detail: { ...hit, paused: paused && !this.#pausing },
      }),
    );
  }

  /**
   * Write one byte where a CPU reads it — the CPU monitor's edit — into the
   * RUN image of whichever memory chip answers `addr` (sim/cpu-memory-map.js
   * `locate`). Run-volatile, ROM included: a run never writes a chip's file
   * (the document is locked while it runs), so an edit to a ROM lasts until
   * Stop, like the program counter. Open inspectors hear of it as of any
   * write, and the board is ticked so the bus carries it at once. Whether
   * anything was written.
   * @param {string} compId - the CPU
   * @param {number} addr
   * @param {number} value
   */
  pokeCpuMemory(compId, addr, value) {
    if (this.#mode === TRANSPORT.STOPPED || !this.#lastShown) return false;
    if (!Number.isInteger(addr) || !Number.isInteger(value)) return false;
    const env = this.#cpuEnv(compId, this.#lastShown.result, this.#lastShown.netlist); // prettier-ignore
    const where = env && this.#cpuMap.locate(env, addr);
    const img = where && this.#images.get(where.compId);
    if (!img || where.offset >= img.length) return false;
    const word = pokeWord(where, img[where.offset], value & 0xff);
    img[where.offset] = word;
    const width = this.#memInfo.get(where.compId)?.width ?? 8;
    this.#oweMemChanges(new Map([[where.compId, wordToBytes(width, where.offset, word)]])); // prettier-ignore
    this.wake();
    return true;
  }

  /**
   * Change one of a CPU's registers — the CPU monitor's edit, made while the
   * run is PAUSED at an instruction's start (the core's `canEdit`: there its
   * committed registers are the live ones, and nothing of the instruction
   * has run). The flags are a register too (`P`, `F`). A new PC moves the
   * opcode fetch on the bus with it, and the record's note of the
   * instruction starting is moved there too, so the pipeline does not list
   * an instruction that never ran. The board is ticked so the pins carry it.
   * Whether it was changed.
   * @param {string} compId
   * @param {string} name - as the monitor lists it (`A`, `HL'`, `PC`, …)
   * @param {number} value
   */
  setCpuRegister(compId, name, value) {
    if (this.#mode !== TRANSPORT.PAUSED || this.#stalled) return false;
    const cpu = this.#cpusOn(this.#document()).find((c) => c.id === compId)?.cpu; // prettier-ignore
    const state = this.#state.get(compId);
    const next = cpu && state ? cpu.setRegister?.(state, name, value) : null;
    if (!next) return false;
    this.#state = new Map(this.#state).set(compId, next);
    const last = this.#cpuTracks.get(compId)?.history.at(-1);
    const was = cpu.pcOf(state);
    if (last?.kind === "instr" && last.pc === was) last.pc = cpu.pcOf(next);
    this.wake();
    return true;
  }

  /** The summary of the CPU the monitor shows, for a board being published. */
  #cpuMonitorOf(result, netlist) {
    const id = this.#cpuWatch;
    if (!id || !result || !netlist || this.#mode === TRANSPORT.STOPPED) return null; // prettier-ignore
    try {
      const env = this.#cpuEnv(id, result, netlist);
      if (!env) return null;
      return cpuSummary({
        compId: id,
        ref: env.ref,
        cpu: env.cpu,
        state: env.state.get(id),
        ins: (result.pinLevels ?? this.#prevPins).get(id),
        track: this.#cpuTracks.get(id),
        read: this.#cpuMap.reader(env),
        memAt: this.#cpuView.memAt,
        breaks: [...(this.#cpuBreaks.get(id) ?? [])].sort((a, b) => a - b),
      });
    } catch (err) {
      console.error("[renderer] CPU monitor summary failed:", err);
      return null;
    }
  }

  /** What the address map reads a CPU's memory with, for a board — or null
      when `compId` is not a CPU on the document. */
  #cpuEnv(compId, result, netlist) {
    const doc = this.#document();
    const comp = doc.components.find((c) => c.id === compId);
    const cpu = comp?.kind === "chip" ? cpuOf(partDef(comp.ref)) : null;
    if (!cpu || !netlist) return null;
    const context =
      this.#circuit?.doc === doc && this.#circuit?.netlist === netlist
        ? this.#circuit
        : prepareCircuit(doc, netlist);
    return {
      cpuId: compId,
      cpu,
      ref: comp.ref,
      doc,
      netlist,
      context,
      state: result?.state ?? this.#state,
      warm: result?.netLevels ?? this.#warm,
      clockPhase: this.#clockPhase,
      signalLevels: this.#driveLevels(),
      images: this.#images,
    };
  }

  /**
   * What a chip last read and holds — its sampled input levels and its state
   * as the last tick left them — or null when stopped. The chip debugger's
   * baseline for a chip armed mid-run.
   * @param {string} compId
   */
  chipSnapshot(compId) {
    if (this.#mode === TRANSPORT.STOPPED) return null;
    return {
      ins: this.#prevPins.get(compId) ?? null,
      state: this.#state.get(compId) ?? null,
    };
  }

  /**
   * Run one engine tick from the current phase + state, publish, and hand the
   * settled board to the integration — repeating while it answers `again`,
   * and deferring altogether while it is stalled. `at` is the simulated
   * moment a batch's event falls at; an input's tick reads the sim clock.
   */
  #tickNow(at = null) {
    if (this.#mode === TRANSPORT.STOPPED) return;
    if (this.#stalled) {
      this.#pendingTick = true;
      return;
    }
    for (let pass = 0; pass < MAX_BOUNDARY_PASSES; pass++) {
      this.#pendingTick = false;
      const settled = this.#tickOnce(at);
      if (settled) this.#boundary(settled);
      if (this.#breakHit) {
        this.#breakAt();
        return;
      }
      if (!this.#pendingTick || this.#stalled) return;
      if (this.#mode === TRANSPORT.STOPPED) return;
    }
  }

  /** The thresholds a board element reads a voltage at: the 74LS input's,
      as this run's Spice Lite numbers state them. */
  #boardThresholds() {
    const p = familyParams(this.#runConfig, "74LS");
    return { vil: p.vilV, vih: p.vihV };
  }

  /**
   * The settle boundary: tell the integration the board has settled, and act
   * on its answer (see the file header).
   */
  #boundary({ doc, netlist, result }) {
    if (!this.#integration?.settled) return;
    let verdict;
    try {
      verdict = this.#integration.settled({
        document: doc,
        netlist,
        netLevels: result.netLevels,
        // Under Spice Lite an Output's pins and its trigger read their own
        // pin's voltage, as an input does — at 74LS thresholds, a 5 V
        // board's logic input (the Arduino's own pins are near enough).
        nodeVolts: result.nodeVolts ?? null,
        thresholds: this.#engine === ENGINES.spice ? this.#boardThresholds() : null, // prettier-ignore
      });
    } catch (err) {
      console.error("[renderer] integration settle failed:", err);
      return;
    }
    if (!verdict) return;
    if (typeof verdict.then === "function") {
      this.#stalled = true;
      // Time stops for the whole board while it waits, timed parts included —
      // at the tick that stalled it, however far a batch's wall clock ran on.
      // The meter keeps counting: waiting on a device is the run going slow.
      this.#freeze(this.#tickAt, { meter: false });
      this.#cancelPacer();
      const token = this.#runToken;
      verdict.then(
        (v) => this.#endStall(token, v?.again === true),
        (err) => {
          console.error("[renderer] integration settle failed:", err);
          if (token === this.#runToken) this.stop();
        },
      );
      return;
    }
    if (verdict.again === true) this.#pendingTick = true;
  }

  /** The integration settle is over: the board may advance again, and settles
      once for whatever was held back while it waited. */
  #endStall(token, again) {
    if (token !== this.#runToken || this.#mode === TRANSPORT.STOPPED) return;
    this.#stalled = false;
    if (this.#mode === TRANSPORT.RUNNING) {
      this.#thaw({ meter: false });
      // The edges due while it waited were skipped: debt dropped, as when a
      // batch runs out of budget — so a run held back by its device says so.
      this.#meter.dropped(this.#wall());
    }
    if (again || this.#pendingTick) {
      this.#pendingTick = false;
      this.#tickNow();
    }
    // Inputs held by a debug stall this settle followed: their turn now.
    if (this.#replayHeld() || again) return;
    if (!this.#stalled) this.#arm({ gate: false });
  }

  /** The levels every planted driver holds: the signals' own, whatever the
      integration drives (an Input's pins), and each data bus's planted pins
      as its card is set — read off the document, since a data pin's level is
      DURABLE, like a switch's position (a click is a doc change) — in the
      one map the engine reads. */
  #driveLevels() {
    const extra = this.#integration?.levels?.();
    const data = this.#dataLevels();
    if (!extra?.size && !data.size) return this.#signalLevel;
    return new Map([...this.#signalLevel, ...(extra ?? []), ...data]);
  }

  /** Each planted data-bus pin → H / L / Z, keyed as the engine lists it
      (`data1:3`, `buildContext`'s signals). */
  #dataLevels() {
    const levels = new Map();
    for (const e of this.#document().integrations ?? []) {
      if (e?.kind !== "data") continue;
      for (const [key, tag] of Object.entries(e.tags ?? {})) {
        if (typeof tag?.anchor !== "string") continue;
        levels.set(`${e.id}:${key}`, dataPinLevel(e, key));
      }
    }
    return levels;
  }

  /** The document changed: the next tick reads it afresh. */
  #forgetDocument() {
    this.#docSnap = null;
    this.#circuit = null;
    this.#base = null;
    this.#bounceNets = null;
    this.#contactsSeen = null;
    this.#lampJunctions = null;
  }

  /** The document as the run reads it: one snapshot, kept until it changes.
      Read-only — the engine, the clocks and the signals all share it. */
  #document() {
    return (this.#docSnap ??= this.#doc.toJSON());
  }

  /** Have the run's bounce look at the switches, when the document or a
      held button has changed since it last did. */
  #watchContacts(doc, at) {
    const seen = this.#contactsSeen;
    if (seen?.doc === doc && seen.version === this.#partStateVersion) return;
    this.#contactsSeen = { doc, version: this.#partStateVersion };
    const states = new Map(this.#netlist.partStates?.() ?? []);
    const bounce = this.#engine === ENGINES.spice && this.#runConfig.bounce;
    this.#bounce.watch(doc, states, at, bounce);
  }

  /** The netlist of the snapshot with the switches in `gaps` (compId → the
      contacts each keeps) caught open — built once per set of gaps. */
  #bounceNetlist(doc, gaps) {
    const key = JSON.stringify([...gaps]);
    const kept = this.#bounceNets;
    if (kept?.doc === doc && kept.key === key) return kept.netlist;
    const states = new Map(this.#netlist.partStates?.() ?? []);
    for (const [id, contacts] of gaps) {
      states.set(id, { ...states.get(id), contacts });
    }
    const netlist = buildNetlist(doc, states, this.#engine === ENGINES.spice ? { inductors: "branch" } : {}); // prettier-ignore
    this.#bounceBuilt.add(netlist);
    this.#bounceNets = { doc, key, netlist };
    return netlist;
  }

  /** The nets the analyzer draws a voltage of (its net channels and its
      ground lead) — the ones a display frame reads between ticks, so the
      engine states the non-node ones in the nodes (spice/engine.js
      `statements`). Null with nothing recorded; built once per snapshot. */
  #frameNets(doc, netlist) {
    const kept = this.#frameNetsOf;
    if (kept?.doc === doc && kept.netlist === netlist) return kept.nets;
    const nets = new Set();
    const add = (address) => {
      const net = address ? netlist.netOfPoint.get(address) : null;
      if (net) nets.add(net);
    };
    for (const ch of doc.scopeChannels ?? [])
      if (ch.kind === "net") add(ch.ref);
    if (nets.size) add(doc.scopeGround);
    // …and the nets every multimeter's probes are on, which its reading is
    // sampled at between ticks (#sampleMeters).
    for (const m of this.#meterList(doc, netlist)) {
      nets.add(m.pos);
      nets.add(m.neg);
    }
    this.#frameNetsOf = { doc, netlist, nets: nets.size ? nets : null };
    return this.#frameNetsOf.nets;
  }

  /** Every LED's and segment's junction on the snapshot. */
  #junctionsOf(doc) {
    if (this.#lampJunctions?.doc !== doc) {
      this.#lampJunctions = { doc, list: lampJunctions(doc) };
    }
    return this.#lampJunctions.list;
  }

  /** One engine tick + publish (or, inside a batch, owed to its end).
      Returns what the boundary needs, or null (nothing to settle, or the
      chip debugger has stalled the board). */
  #tickOnce(at = null) {
    this.#suppress = true;
    try {
      const doc = this.#document();
      // The netlist that goes WITH the snapshot: the one it was prepared with
      // while it lasts (the cache has already moved on when an edit's
      // catch-up runs — see #onDocChanged), else the cache's.
      // Spice Lite's carries every inductor as a branch of its own.
      if (this.#base?.doc !== doc) {
        const netlist =
          this.#circuit?.doc === doc
            ? this.#circuit.netlist
            : this.#netlist.get(this.#engine === ENGINES.spice ? { inductors: "branch" } : undefined); // prettier-ignore
        this.#base = { doc, netlist };
      }
      const now = at ?? this.#simNow();
      // The analyzer's curve up to this moment, read off the last tick's
      // curves before this one replaces them: what a tick moves, it moves at
      // once, so the sample at its own moment is the step's foot.
      this.#sampleScope(now);
      this.#sampleMeters(now);
      // A switch caught in a bounce's gap: the board as it is then.
      this.#watchContacts(doc, now);
      const gaps = this.#bounce.active ? this.#bounce.gapsAt(now) : null;
      const netlist = gaps?.size ? this.#bounceNetlist(doc, gaps) : this.#base.netlist; // prettier-ignore
      if (this.#circuit?.doc !== doc || this.#circuit?.netlist !== netlist) {
        this.#circuit = prepareCircuit(doc, netlist);
      }
      let observer = null;
      try {
        observer = this.#debug?.observer?.() ?? null;
      } catch (err) {
        console.error("[renderer] chip debugger observer failed:", err);
      }
      // Spice Lite's extra option; the digital engine takes no `spice`. A
      // wave's shape is drawn by frames only the analyzer records (it records
      // while it has channels, shown or not): each is a whole tick.
      const spice =
        this.#engine === ENGINES.spice
          ? {
              config: this.#runConfig,
              analog: this.#analog,
              waveFrames: this.#doc.scopeChannels?.length > 0,
              frameNets: this.#frameNets(doc, netlist),
            }
          : undefined;
      const result = this.#engine.tick({
        document: doc,
        netlist,
        warmStart: this.#warm,
        state: this.#state,
        prevPinLevels: this.#prevPins,
        clockPhase: this.#clockPhase,
        ...(this.#engine === ENGINES.spice ? { clockTimes: this.#clockTimes() } : {}), // prettier-ignore
        signalLevels: this.#driveLevels(),
        images: this.#images,
        now: (this.#tickAt = now),
        observer,
        spice,
        context: this.#circuit,
        // The logic engine updates the levels in place, each tick's own
        // read through its record (features/digital-event-tick.md A2).
        ...(this.#engine === ENGINES.spice ? {} : { warm: this.#carry, inPlace: true }), // prettier-ignore
        ties: this.#ties,
      });
      if (result.analog) this.#analog = result.analog;
      this.#carry = result.warm ?? null;
      this.#lastTick = { result, netlist, nets: spice?.frameNets ?? null };
      this.#scopeAt = now;
      this.#lamps.record(now, lampBrightness(this.#junctionsOf(doc), netlist, result, this.#lamps.spare())); // prettier-ignore
      if (result.supplies) this.#supplyAmps.record(now, new Map([...result.supplies].map(([id, sup]) => [id, sup.amps ?? 0]))); // prettier-ignore
      this.#bookMeters(doc, netlist, result, now);
      this.#frameAt = result.frameAt ?? null;
      this.#sampleOwed = false;
      // (The live map itself, not a built copy: A2.)
      this.#warm = result.liveLevels ?? result.netLevels;
      this.#state = result.state;
      this.#prevPins = result.pinLevels;
      this.#observeCpus(doc, result);
      this.#wakeAt = result.wakeAt ?? null;
      this.#edgeAt = result.edgeAt ?? null;
      if (this.#batchDepth === 0) this.#arm();
      // Volatile (SRAM) writes land in the run image + drive the live inspector;
      // ROM writes are dropped (read-only). No file is ever written while running.
      this.#oweMemChanges(this.#applyWrites(result.memWrites));
      this.#oweMemChanges(this.#forgetUnpowered(result.chipStatus));
      this.#persistDamage(result.chipStatus);
      this.#announceTick(result, netlist);
      if (observer) {
        // The debugger reads boards a tick at a time, so while it watches,
        // every tick is shown: what a batch still owes goes out first.
        this.#flushPublish();
        const displays = this.#displayState(doc, result.state);
        const settled = { doc, netlist, result, displays };
        if (this.#debugStall(observer, settled)) return null;
        this.#publish(result, netlist, displays);
        this.#report(result.warnings);
        return settled;
      }
      if (this.#batchDepth > 0) {
        this.#owed = { doc, netlist, result };
      } else {
        this.#flushMem();
        this.#publish(result, netlist, this.#displayState(doc, result.state));
      }
      this.#report(result.warnings);
      return { doc, netlist, result };
    } finally {
      this.#suppress = false;
    }
  }

  /**
   * Hand a recorded tick to the chip debugger. When it answers a promise the
   * board STALLS (as for an integration settle) until it lets go; the tick is
   * then published, reported and given its boundary. Returns whether it
   * stalled.
   */
  #debugStall(observer, settled) {
    const { result, netlist, displays } = settled;
    let wait;
    // The debugger puts its first pass on the board before it answers, so
    // the board is the debugger's from here, not only once it has stalled.
    this.#debugDeciding = true;
    try {
      wait = this.#debug.afterTick?.({
        observer,
        result,
        // A pass of the replay: its levels on the board, and the strong ones
        // that go with them (the last shown, while no pass has said).
        // `replay` tells the desk these levels are a pass's, while Spice
        // Lite's lamps are the settled tick's: it lights LEDs by the levels.
        show: (levels, strong) =>
          this.#publish(
            {
              ...result,
              netLevels: levels,
              strongLevels: strong ?? this.#shownStrong,
              warnings: [],
              replay: true,
            },
            netlist,
            displays,
          ),
        // The settled point: the tick's own board.
        showFinal: () => this.#publish(result, netlist, displays),
      });
    } catch (err) {
      console.error("[renderer] chip debugger failed:", err);
      return false;
    } finally {
      this.#debugDeciding = false;
    }
    if (!wait || typeof wait.then !== "function") return false;
    this.#stalled = true;
    this.#debugStalled = true;
    this.#freeze(this.#tickAt);
    this.#cancelPacer();
    const token = this.#runToken;
    const finish = () => this.#endDebugStall(token, settled);
    wait.then(finish, (err) => {
      console.error("[renderer] chip debugger failed:", err);
      finish();
    });
    return true;
  }

  /** The debugger let the board go: publish the tick it held, give it its
      boundary, and pick up whatever waited meanwhile. */
  #endDebugStall(token, settled) {
    if (token !== this.#runToken || this.#mode === TRANSPORT.STOPPED) return;
    this.#stalled = false;
    this.#debugStalled = false;
    this.#publish(settled.result, settled.netlist, settled.displays);
    this.#report(settled.result.warnings);
    this.#boundary(settled);
    if (this.#stalled) return; // the integration took the board over
    if (this.#mode === TRANSPORT.RUNNING) this.#thaw();
    // What was pressed while the board was held, one tick each. A tick
    // asked for meanwhile (a pending one) is folded into the first of them.
    if (this.#replayHeld()) return;
    if (this.#pendingTick) {
      this.#pendingTick = false;
      this.#tickNow();
    } else {
      this.#arm();
    }
  }

  /**
   * The per-LCD framebuffer (visible chars + cursor) derived from the engine's
   * sequential state — the "display output" the live views paint. Run-volatile:
   * the state resets on start()/stop(), so the screen blanks/re-inits on its own.
   */
  #displayState(doc, state) {
    const displays = new Map();
    for (const c of doc.components) {
      // The def's data hook, never a kind or ref test — a character display is
      // an ordinary seated discrete that happens to have a screen.
      const grid = partDef(c.ref)?.characterDisplay;
      if (!grid) continue;
      displays.set(c.id, framebufferOf(state.get(c.id), grid));
    }
    return displays;
  }

  /**
   * Latch a 12 V kill into params.damaged FOR THE REST OF THE RUN.
   *
   * The document is where it goes because the document is what the engine
   * reads (`engine.js` `powerStatus`), and a chip that let its smoke out at
   * tick 5 has to stay dead at tick 6 — a pure, timerless solver has nowhere
   * else to remember that. It is not a saved property: `stop()` clears it and
   * the load path drops it, so damage lives exactly as long as the run does,
   * like sequential state and clock phase.
   *
   * "reversed" is deliberately NOT latched at all — swapped power wires are an
   * editing mistake, so fixing the wiring and re-running clears it.
   */
  #persistDamage(chipStatus) {
    let changed = false;
    for (const [id, { status }] of chipStatus) {
      // 12 V's magic smoke, and Spice Lite's brown smoke (an output driven
      // past twice its budget) — one latch each, the same lifecycle.
      const key =
        status === "damaged" ? "damaged" : status === "overloaded" ? "overloaded" : null; // prettier-ignore
      if (!key) continue;
      if (this.#doc.getComponent(id)?.params?.[key] === true) continue;
      this.#doc.setComponentParams(id, { [key]: true });
      // Only a latch that HELD is a change: a part whose normalizer dropped
      // it would otherwise announce a document change on every tick (and
      // rebuild the netlist each time) without ever staying dead.
      if (this.#doc.getComponent(id)?.params?.[key] === true) changed = true;
    }
    // The engine must read the damage next tick (the doc-changed below says
    // so too, but this is the one write the controller makes itself).
    if (changed) this.#forgetDocument();
    if (changed) this.#tellTicks();
    if (changed)
      this.#scope.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }

  /** What a batch owes: its memory writes, and its last tick's board.
      Whether a board was owed (and so published). */
  #flushPublish() {
    this.#flushMem();
    const owed = this.#owed;
    if (!owed) {
      // Nothing ticked, but the desk moves: its curves, redrawn.
      if (!this.#sampleOwed || !this.#lastShown) return false;
      this.#republish();
      return true;
    }
    this.#publish(
      owed.result,
      owed.netlist,
      this.#displayState(owed.doc, owed.result.state),
    );
    return true;
  }

  /** A batch's end: publish what it owes now if a frame has passed since
      the views were last told, else at the frame — a run whose every batch
      ends early (a device stalling it on each edge) still tells the views
      no oftener than a display shows. */
  #flushSoon() {
    this.#flushMem();
    if (!this.#owed && !this.#sampleOwed) return;
    const wait = this.#lastPublishWall + PUBLISH_MS - this.#wall();
    if (wait <= 0) {
      this.#flushPublish();
      return;
    }
    if (this.#publishTimer != null) return;
    this.#publishTimer = this.#timers.set(() => {
      this.#publishTimer = null;
      this.#flushPublish();
    }, wait);
    this.#publishTimer?.unref?.();
  }

  /** The speed the run is achieving when it falls short of the one asked
      (sim-pacer.js), else null — and null whenever it is not running. */
  #behind() {
    if (this.#mode !== TRANSPORT.RUNNING) return null;
    return this.#meter.behind(this.#wall(), this.#speed);
  }

  /** The board last shown, again — for a transport change with no tick. */
  #republish() {
    const last = this.#lastShown;
    if (last) this.#publish(last.result, last.netlist, last.displays);
  }

  /**
   * A sim-tick — ONE tick's board (or curve sample), for whatever must see
   * every tick however few of them the views are shown (the logic analyzer).
   * The Worker's host is handed each; on the main thread they are told as
   * `chiphippo:sim-ticks` (#tellTicks).
   */
  #announceTick(result, netlist, at = this.#tickAt, sample = false) {
    const detail = {
      running: true,
      mode: this.#mode,
      at,
      netlist,
      // A bounce's netlist travels with its board (sim-worker-host.js).
      ownNetlist: this.#bounceBuilt.has(netlist),
      nodeVolts: result.nodeVolts ?? NO_READINGS,
      supplies: result.supplies ?? NO_READINGS,
      lamps: result.lamps ?? null,
      // Read off the curves between two ticks (#sampleScope), no tick.
      ...(sample ? { sample: true } : {}),
      // The cycles drawn slowed that the analyzer's nets are on.
      ...this.#scopeCycles(netlist),
    };
    lazyTickLevels(detail, result);
    // The Worker's host, its only listener, is handed it straight: an event
    // dispatched per tick and per curve sample was 3 % of a busy Worker
    // (runtime review R9, 2026-10-26).
    if (this.#tickSink) {
      this.#tickSink(detail);
      return;
    }
    const cut = this.#cutOf(netlist);
    if (!cut.recording) {
      // Nothing recorded: told at once with the tick's own maps, which the
      // next tick may update in place (the analyzer only hears a run is on).
      this.#ticksOut.push(detail);
      this.#tellTicks();
      return;
    }
    // Recorded: cut to the analyzer's nets as the Worker cuts them, so a
    // batch's ticks can wait for its end (one event, not one a column — the
    // main thread's cost of a recording, scope batch 2026-10-26). A tick's
    // levels are cut afresh; its curve samples share that cut.
    if (detail.levelOf) {
      // (One net at a time off the tick's record — no whole map built: A2.)
      cut.from = null;
      cut.levels = onlyNets(levelReader(detail.levelOf), cut.nets);
      delete detail.levelOf;
      detail.netLevels = cut.levels;
    } else {
      const map = detail.netLevels;
      if (map && (!sample || cut.from !== map)) {
        cut.from = map;
        cut.levels = onlyNets(map, cut.nets);
      }
      if (map) detail.netLevels = cut.levels;
    }
    detail.nodeVolts = onlyNets(detail.nodeVolts, cut.nets);
    detail.lamps = detail.lamps ? NO_LAMPS : null;
    this.#ticksOut.push(detail);
    if (this.#batchDepth === 0 && !sample) this.#tellTicks();
  }

  /** The analyzer's nets on `netlist` (scope-recorder.js `scopeNets`, off
      the live document's channels — as the Worker reads its newest
      snapshot's), kept until an edit or another netlist. */
  #cutOf(netlist) {
    const kept = this.#tickCut;
    if (kept?.epoch === this.#scopeEpoch && kept.netlist === netlist) return kept; // prettier-ignore
    const recording = this.#doc.scopeChannels?.length > 0;
    const nets = recording ? scopeNets(this.#doc, netlist) : null;
    this.#tickCut = { epoch: this.#scopeEpoch, netlist, recording, nets, from: null, levels: null }; // prettier-ignore
    return this.#tickCut;
  }

  /** `chiphippo:sim-ticks` — the sim-ticks not yet told, in order, as ONE
      event `{ticks}`: before any other event this controller tells (a
      sim-state — #publish — mem-state, cpu-break, doc-changed), at a
      batch's end, and at once outside one. */
  #tellTicks() {
    if (!this.#ticksOut.length) return;
    const ticks = this.#ticksOut;
    this.#ticksOut = [];
    this.#scope.dispatchEvent(new CustomEvent("chiphippo:sim-ticks", { detail: { ticks } })); // prettier-ignore
  }

  /**
   * The analyzer's nets on each cycle Spice Lite DRAWS slowed (spice/
   * cycles.js — faster than TIMING_CAP_HZ, shown at the cap): `{cycles:
   * [{id, start, shown, period, nets, templates}]}` for a sim-tick, or
   * nothing — `templates` each net's one TRUE cycle (spice/sample.js
   * `cycleTemplates`, built once per cycle), which the analyzer draws
   * repeated at its true rate (model/scope-periodic.js). Kept per analog
   * state and netlist.
   */
  #scopeCycles(netlist) {
    const analog = this.#analog;
    const nets = this.#lastTick?.nets;
    if (!nets || !analog?.cycles?.size) return NO_CYCLES;
    const kept = this.#scopeCyclesOf;
    if (kept?.analog === analog && kept.nets === nets && kept.netlist === netlist) return kept.out; // prettier-ignore
    const isl = analog.islands;
    const list = [];
    for (const [key, { cycle }] of analog.cycles) {
      if (!(cycle.shown > cycle.period * (1 + 1e-9))) continue; // at its own rate
      const on = [...nets].filter((net) => !isl || isl.islandOf.get(net) === key); // prettier-ignore
      if (!on.length) continue;
      let kept = this.#templates.get(cycle);
      if (kept?.nets !== nets) {
        const scale = Math.max(fullScaleOf(this.#lastTick.result) || 5, 1);
        kept = { nets, templates: cycleTemplates(cycle, on, { tolerance: SCOPE_TOLERANCE * scale }) }; // prettier-ignore
        this.#templates.set(cycle, kept);
      }
      const { templates } = kept;
      const known = on.filter((net) => templates.has(net));
      if (!known.length) continue;
      list.push({ id: cycle.id, start: cycle.start, shown: cycle.shown, period: cycle.period, nets: known, templates }); // prettier-ignore
    }
    const out = list.length ? { cycles: list } : NO_CYCLES;
    this.#scopeCyclesOf = { analog, nets, netlist, out };
    return out;
  }

  /**
   * The display frames a moving desk asks for BETWEEN ticks (Spice Lite,
   * features/01-display-wakes.md), stepped through up to `until` — short of
   * it, or at it too when `inclusive` (a frame at an event's own moment is
   * that event's tick) — so a desk that has arrived stops being redrawn.
   * While the analyzer records, its curve is read up to each frame
   * (#sampleScope): the frames fall where the ticks put them, never where a
   * batch happened to end, so a run samples alike on the Worker and here.
   */
  #emitFrames(until, inclusive) {
    if (this.#frameAt == null || !this.#lastTick) return;
    const recording = this.#doc.scopeChannels?.length > 0;
    const opts = { gapPercent: GAP_PERCENT, waveFrames: recording };
    for (let n = 0; this.#frameAt != null; n++) {
      const at = this.#frameAt;
      if (inclusive ? at > until : at >= until) return;
      if (n >= MAX_FRAMES_PER_BATCH) {
        // A long stretch at once (a stall's end): its frames are skipped.
        this.#frameAt = nextDisplayFrame(this.#analog, until, until, opts);
        return;
      }
      if (recording) this.#sampleScope(at);
      this.#frameAt = nextDisplayFrame(this.#analog, at, at, opts);
    }
  }

  /**
   * The analyzer's voltage lanes BETWEEN ticks (Spice Lite): the last tick's
   * curves read for its nets from where the trace has reached to `until` —
   * never past the engine's next wake or edge, where the curves stop being
   * exact — as finely as they bend (spice/sample.js `scopeSamples`), each
   * sample announced as a `sim-tick` marked `sample`, which the analyzer
   * joins straight to the column before. Only while it records; a desk at
   * rest adds nothing. The display frames are the desk's redraws and no
   * sample rate: read at them, a 1 ms RC behind a clock edge was a 33 ms
   * ramp and a 500 Hz sine a triangle.
   */
  #sampleScope(until) {
    const last = this.#lastTick;
    if (!last?.nets || !this.#analog || this.#scopeAt == null) return;
    if (!(this.#doc.scopeChannels?.length > 0)) return;
    const from = this.#scopeAt;
    let to = until;
    if (this.#wakeAt != null && this.#wakeAt > from) to = Math.min(to, this.#wakeAt); // prettier-ignore
    if (this.#edgeAt != null && this.#edgeAt > from) to = Math.min(to, this.#edgeAt); // prettier-ignore
    if (!(to > from)) return;
    const { result, netlist, nets } = last;
    const seen = result.nodeVolts ?? NO_READINGS;
    // A lane's scale: the highest supply set, or what its nets reach past it.
    let scale = fullScaleOf(result) || 5;
    for (const net of nets) scale = Math.max(scale, Math.abs(seen.get(net) ?? 0)); // prettier-ignore
    const samples = scopeSamples(this.#analog, nets, from, to, {
      tolerance: SCOPE_TOLERANCE * scale,
    });
    for (const { at, volts } of samples) {
      const nodeVolts = new Map();
      for (const net of nets) {
        const v = volts.get(net) ?? seen.get(net);
        if (v != null) nodeVolts.set(net, v);
      }
      const board = { netLevels: result.netLevels, nodeVolts, supplies: result.supplies, lamps: result.lamps }; // prettier-ignore
      this.#announceTick(board, netlist, at, true);
    }
    if (samples.length) this.#scopeAt = samples.at(-1).at;
  }

  // ── Multimeters (catalog/meter.js) ──────────────────────────────────────
  // A meter's reading is the voltage across its probes — its element is a
  // device of the solve (spice/bench-parts.js), so the tick's `bench` says it
  // — averaged over its display's window: booked at every tick and along the
  // curves between ticks (#sampleMeters), taken five times a second
  // (#publish). The logic engine reads nothing.

  /** Every meter off for a new run (or a stop). */
  #resetMeters() {
    this.#meters.reset();
    this.#meterAt = null;
    this.#meterShown = new Map();
    this.#meterWall = null;
    this.#meterTaken = null;
    this.#meterFrom = null;
    this.#meterListOf = null;
    this.#meterKeys = new Map();
    this.#fuseOver = new Map();
    this.#fuseAt = null;
  }

  /** The meters on a snapshot that read something under Spice Lite: `[{id,
      pos, neg, element}]` — both probes on a net, an element between them;
      both on ONE net is a dead short across the probes, read as 0 V (the
      solve puts no element there, spice/bench-parts.js). A meter whose probes moved or whose function changed starts a
      new window. Built once per snapshot and netlist. */
  #meterList(doc, netlist) {
    const kept = this.#meterListOf;
    if (kept?.doc === doc && kept.netlist === netlist) return kept.list;
    const list = [];
    const keys = new Map();
    if (this.#engine === ENGINES.spice) {
      for (const meter of metersOf(doc)) {
        const setup = meterSetup(meter.params);
        const { element } = setup;
        const { red, black } = probeNets(meter, netlist);
        if (!element || !red || !black) continue;
        const key = `${red}\u0000${black}\u0000${element.volts}\u0000${element.ohms}`; // prettier-ignore
        keys.set(meter.id, key);
        if (this.#meterKeys.get(meter.id) !== key) this.#meters.forget(meter.id); // prettier-ignore
        this.#meters.bands(meter.id, hzBands(setup));
        list.push({ id: meter.id, pos: red, neg: black, element });
      }
    }
    for (const id of this.#meterKeys.keys()) {
      if (!keys.has(id)) {
        this.#meters.forget(id);
        this.#fuseOver.delete(id);
      }
    }
    this.#meterKeys = keys;
    this.#meterListOf = { doc, netlist, list };
    return list;
  }

  /** The meters' voltages BETWEEN ticks, off the last tick's curves, from
      where they were last booked to `until` (never past the engine's next
      wake or edge) — as finely as they bend (spice/sample.js
      `scopeSamples`): a sine's RMS, a PWM's mean. Nothing while the desk
      is at rest. Each fused meter's current heats its fuse along them
      (#heatFuse); one that would blow stops the samples where it does — the
      wake (#fuseAt) that blows it there — and that moment is returned. */
  #sampleMeters(until) {
    const list = this.#meterListOf?.list;
    if (!list?.length || !this.#analog || this.#meterAt == null) return null;
    const from = this.#meterAt;
    let to = until;
    if (this.#wakeAt != null && this.#wakeAt > from) to = Math.min(to, this.#wakeAt); // prettier-ignore
    if (this.#edgeAt != null && this.#edgeAt > from) to = Math.min(to, this.#edgeAt); // prettier-ignore
    if (!(to > from)) return null;
    const nets = new Set();
    let scale = 1;
    for (const m of list) {
      nets.add(m.pos);
      nets.add(m.neg);
      scale = Math.max(scale, Math.abs(this.#meters.last(m.id) ?? 0));
    }
    const seen = this.#lastTick?.result?.nodeVolts ?? NO_READINGS;
    const samples = scopeSamples(this.#analog, nets, from, to, {
      tolerance: METER_TOLERANCE * scale,
      maxSamples: METER_MAX_SAMPLES,
    });
    let cut = null;
    for (const { at, volts } of samples) {
      for (const m of list) {
        const a = volts.get(m.pos) ?? seen.get(m.pos);
        const b = volts.get(m.neg) ?? seen.get(m.neg);
        if (a == null || b == null) continue;
        this.#meters.record(m.id, at, a - b);
        const fuse = m.element.fuse ? METER_FUSES[m.element.fuse] : null;
        if (!fuse) continue;
        const amps = Math.abs((a - b - (m.element.volts ?? 0)) / m.element.ohms); // prettier-ignore
        if (fuseBlown(this.#heatFuse(m.id, fuse, at, amps, true), at)) cut = at;
      }
      if (cut != null) break;
    }
    if (cut != null) {
      to = cut;
      this.#fuseAt = this.#fuseAt == null ? cut : Math.min(this.#fuseAt, cut);
    }
    // Whatever did not move held its value up to here: a level stands until
    // the tick that changes it, and is no ramp towards it.
    for (const m of list) this.#meters.hold(m.id, to);
    this.#meterAt = to;
    return cut;
  }

  /** A tick's meter readings at `now`: each booked, and each fuse past its
      rating timed (#checkFuses). */
  #bookMeters(doc, netlist, result, now) {
    const list = this.#meterList(doc, netlist);
    if (!list.length) {
      this.#fuseAt = null;
      return;
    }
    const amps = new Map();
    for (const m of list) {
      const reading = result.bench?.get(m.id);
      const v =
        reading?.volts ??
        (result.nodeVolts?.get(m.pos) ?? 0) - (result.nodeVolts?.get(m.neg) ?? 0); // prettier-ignore
      this.#meters.record(m.id, now, v);
      amps.set(m.id, reading?.amps ?? 0);
    }
    this.#meterAt = now;
    this.#checkFuses(list, amps, now);
  }

  /** A meter fuse's heat carried on to `t`, and `amps` from there
      (sim/meter-fuse.js `heatFuse`). Fed in time order — every tick
      (#checkFuses) and every sample between ticks (#sampleMeters), since a
      wave between ticks is what heats it on an AC desk. */
  #heatFuse(id, fuse, t, amps, ramp = false) {
    const f = this.#fuseOver.get(id) ?? coldFuse(t);
    heatFuse(f, fuse, t, amps, ramp);
    this.#fuseOver.set(id, f);
    return f;
  }

  /**
   * Blow a meter's fuse whose HEAT has stood for more than its rating for
   * `FUSE_HOLD_S`, or at once when the instant's current is past
   * `FUSE_INSTANT` times it for `FUSE_SURGE_S` — a run latch, as a chip's
   * smoke is (#persistDamage): its shunt opens from the next tick, and the
   * toast says so. The heat is I² through `FUSE_TAU_S`'s lag, each tick's
   * current held to the next (so a steady DC past the rating blows a
   * fraction of the lag after the hold, an AC one by its RMS: the timer
   * stops only when the heat's mean is under the rating too —
   * sim/meter-fuse.js). One still on
   * its way sets `#fuseAt`, the wake that blows it if nothing else ticks
   * first.
   */
  #checkFuses(list, ampsOf, now) {
    this.#fuseAt = null;
    let changed = false;
    const due = (at) => {
      this.#fuseAt = this.#fuseAt == null ? at : Math.min(this.#fuseAt, at);
    };
    for (const m of list) {
      const fuse = m.element.fuse ? METER_FUSES[m.element.fuse] : null;
      if (!fuse) continue;
      const amps = Math.abs(ampsOf.get(m.id) ?? 0);
      const rated = fuse.amps * fuse.amps;
      const f = this.#heatFuse(m.id, fuse, now, amps);
      const { heat } = f;
      if (!fuseBlown(f, now)) {
        if (f.surge != null) due(f.surge + FUSE_SURGE_S);
        if (f.over != null) due(f.over + FUSE_HOLD_S);
        else if (amps > fuse.amps) due(now + FUSE_TAU_S * Math.log((amps * amps - heat) / (amps * amps - rated)) + FUSE_HOLD_S); // prettier-ignore
        // Cool, and nothing on it: forgotten.
        if (amps <= fuse.amps && heat < rated * 1e-3 && f.mean < rated * 1e-3) this.#fuseOver.delete(m.id); // prettier-ignore
        continue;
      }
      this.#fuseOver.delete(m.id);
      this.#doc.setComponentParams(m.id, { [fuse.latch]: true });
      if (this.#doc.getComponent(m.id)?.params?.[fuse.latch] !== true) continue;
      changed = true;
      const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
      this.#warn({
        key: `meter:${m.id}:${m.element.fuse}`,
        variant: "danger",
        title: t("sim.meterFuse"),
        message: t("sim.meterFuseMessage", {
          part: this.#brickName(m.id),
          fuse: m.element.fuse.toUpperCase(),
          rating: n(fuse.amps),
          // (What it carried: the RMS over the overload — a DC current's
          // own, an AC one's RMS, never a sine's peak or zero at the tick.)
          amps: n(fuseAmps(f, now)),
        }),
      });
    }
    if (changed) {
      this.#forgetDocument();
      this.#tellTicks();
      this.#scope.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    }
  }

  /** The wall time a meter's display is owed its next window — readings
      have been booked past the one it shows (a tick that ran after it was
      taken: a desk that came to rest between windows, its last stretch
      never shown), or the one it shows began before the last tick (taken
      at an edge, it is the level BEFORE it: a 1 Hz clock's display stood a
      half-cycle behind, a held signal's at the old level until release —
      the regrade, 2026-10-27) — else null. Once a window wholly after the
      last tick is shown, nothing is owed until the next. */
  #meterOwed() {
    if (this.#meterWall == null || this.#meterAt == null) return null;
    const unshown = this.#meterAt > (this.#meterTaken ?? -Infinity);
    if (!unshown && this.#meterFrom != null && this.#meterFrom >= this.#tickAt) return null; // prettier-ignore
    return this.#meterWall + METER_UPDATE_MS;
  }

  /** What each meter's display shows: a new window every METER_UPDATE_MS
      of wall time while the run moves, else the last one taken (a step or
      a pause shows the window up to its last tick). */
  #meterReadings(moving) {
    if (this.#mode === TRANSPORT.STOPPED) return NO_METERS;
    const wall = this.#wall();
    const due = this.#meterWall == null || wall - this.#meterWall >= METER_UPDATE_MS; // prettier-ignore
    const unshown = this.#meterAt != null && !(this.#meterAt <= (this.#meterTaken ?? -Infinity)); // prettier-ignore
    if (moving ? due : unshown) {
      // Never past the next event still to run (a clock edge due but not yet
      // ticked): held across it, the last level would read for time it did
      // not stand, and a PWM's mean wandered a tenth either way.
      const next = moving ? this.#nextEvent()?.at : null;
      let at = moving ? Math.max(this.#meterAt ?? this.#tickAt, Math.min(this.#shownAt(), next ?? Infinity)) : this.#tickAt; // prettier-ignore
      // (Short of `at` where a fuse blows: the tick there comes next.)
      const blownAt = this.#sampleMeters(at);
      if (blownAt != null) at = blownAt;
      this.#meterShown = this.#cycleWindows(this.#meters.take(at));
      if (this.#meterAt != null) this.#meterAt = Math.max(this.#meterAt, at);
      this.#meterFrom = this.#meterTaken ?? at;
      this.#meterTaken = at;
      this.#meterWall = wall;
    }
    return this.#meterShown;
  }

  /**
   * The windows of the meters on an island whose cycle is drawn slowed
   * (spice/cycles.js — past TIMING_CAP_HZ, drawn at the cap, its duty kept):
   * read off one TRUE cycle of it (sim/meter-average.js `cycleWindow`, on
   * the cycle's templates — the analyzer's), since a curve between ticks
   * does not follow a schedule and the ticks fall where they fall in it. The
   * wave repeats exactly, so one cycle is every window's: its mean and RMS,
   * and its Hz the TRUE rate — the analyzer's amber rate, read the same way.
   */
  #cycleWindows(windows) {
    const cycles = this.#analog?.cycles;
    const isl = this.#analog?.islands;
    const list = this.#meterListOf?.list;
    if (!cycles?.size || !list?.length) return windows;
    const seen = this.#lastTick?.result?.nodeVolts ?? NO_READINGS;
    for (const m of list) {
      if (!windows.has(m.id)) continue;
      const island = isl?.islandOf.get(m.pos) ?? isl?.islandOf.get(m.neg);
      for (const [key, { cycle }] of cycles) {
        if (isl && key !== island) continue;
        if (!(cycle.shown > cycle.period * (1 + 1e-9))) continue;
        let kept = this.#meterCycles.get(cycle);
        if (!kept) this.#meterCycles.set(cycle, (kept = new Map()));
        const bands = this.#meters.bandsOf(m.id);
        const memo = `${m.pos}\u0000${m.neg}\u0000${bands.join()}`;
        let figures = kept.get(memo);
        if (!figures) {
          const scale = Math.max(fullScaleOf(this.#lastTick.result) || 5, 1);
          const templates = cycleTemplates(cycle, [m.pos, m.neg], { tolerance: METER_TOLERANCE * scale }); // prettier-ignore
          figures = cycleWindow({ pos: templates.get(m.pos) ?? null, neg: templates.get(m.neg) ?? null, posV: seen.get(m.pos) ?? 0, negV: seen.get(m.neg) ?? 0, period: cycle.period, bands }); // prettier-ignore
          kept.set(memo, figures);
        }
        windows.set(m.id, figures);
        break;
      }
    }
    return windows;
  }

  /**
   * A Spice Lite tick's board as it stands at `at` (simulated seconds, after
   * that tick and before the engine's next wake): its RC nodes, waves and
   * coils read off the carried curves (spice/sample.js), every other net as
   * the tick left it. The tick's own result when nothing on it moves.
   */
  #sampled(result, at, settled = false) {
    if (!this.#analog || result !== this.#lastTick?.result) return result;
    const arrived = settled ? GAP_PERCENT : null;
    const { volts } = sampleAnalog(this.#analog, at, { arrived });
    if (!volts.size) return result;
    const nodeVolts = new Map(result.nodeVolts ?? NO_READINGS);
    for (const [net, v] of volts) if (nodeVolts.has(net)) nodeVolts.set(net, v); // prettier-ignore
    // A supply on its limit, which the solve holds (spice/engine.js `free`),
    // reads what its + node does: read at its last tick, its own readout
    // trailed the rail it was holding, and stood short of it for good.
    const free = this.#analog.free;
    if (!free?.size || !result.supplies) return { ...result, nodeVolts };
    const { netlist } = this.#lastTick;
    const across = (id, terminal) => {
      const net = netlist.netOfPoint.get(formatAddress(id, terminal));
      return net == null ? null : (volts.get(net) ?? nodeVolts.get(net) ?? null); // prettier-ignore
    };
    const supplies = new Map(result.supplies);
    for (const id of free) {
      const sup = supplies.get(id);
      const plus = across(id, "+");
      if (sup && plus != null) supplies.set(id, { ...sup, volts: plus - (across(id, "-") ?? 0) }); // prettier-ignore
    }
    return { ...result, nodeVolts, supplies };
  }

  /** The moment a board published now shows: the sim clock's, never before
      the tick it comes from nor past the engine's next wake (the curves are
      exact up to it). */
  #shownAt() {
    const now = Math.max(this.#simNow(), this.#analog?.time ?? this.#tickAt);
    return this.#wakeAt == null ? now : Math.min(now, Math.max(this.#wakeAt, this.#tickAt)); // prettier-ignore
  }

  /**
   * The fastest thing on the desk toggles at, in WALL Hz: the ticking clocks
   * and every timed part's oscillation as drawn (sim/timing.js's cap), times
   * the speed. What the desk decides the LED glow by (sim-overlay.js).
   */
  #fastestHz(result) {
    if (!result) return 0;
    let hz = 0;
    for (const c of this.#tickingClocks()) hz = Math.max(hz, c.params.hz);
    for (const analysis of result.timing?.values() ?? []) {
      hz = Math.max(hz, oscillationHz(analysis));
    }
    return hz * this.#speed;
  }

  #publish(tick, netlist, displays) {
    this.#tellTicks(); // the ticks before the board they led to
    this.#owed = null;
    this.#sampleOwed = false;
    this.#timers.clear(this.#publishTimer);
    this.#publishTimer = null;
    this.#lastShown = tick ? { result: tick, netlist, displays } : null;
    // A moving desk is shown where the sim clock has got to, not where its
    // last tick left it (Spice Lite; spice/sample.js) — and one at rest,
    // redrawn no more, where its nodes come to rest.
    const settled = this.#frameAt == null && !this.#analog?.chatter;
    const result =
      tick && !tick.replay && this.#mode !== TRANSPORT.STOPPED
        ? this.#sampled(tick, this.#shownAt(), settled)
        : tick;
    this.#lastPublishWall = this.#wall();
    this.#shownStrong = result?.strongLevels ?? new Map();
    // Each lamp's brightness over the time this frame covers — only a
    // moving run's: a step, a pause or the debugger shows the tick itself.
    // A run just handed over shows what its last frame did: the time since
    // that frame is a few milliseconds of a PWM, its average dark or lit,
    // and it is the next frame's to average (#lamps carried it).
    const moving = tick && !tick.replay && this.#mode === TRANSPORT.RUNNING && !this.#debugStalled; // prettier-ignore
    const lampGlow = moving ? (this.#heldGlow ?? this.#lamps.take(this.#shownAt())) : null; // prettier-ignore
    this.#heldGlow = null;
    this.#shownGlow = lampGlow;
    const meanAmps = moving ? this.#supplyAmps.take(this.#shownAt()) : null;
    // An average covers the time since the last frame, and a desk with
    // nothing moving publishes only when something changes — so the frame
    // after a switch is thrown is mostly the time BEFORE it, and no frame
    // follows to correct it: the LED stood showing the state it had left
    // (lit after the switch opened, dim after it closed). Owe one more frame;
    // nothing changes within it, so it takes no average and shows the lamps
    // as they stand.
    this.#glowShown = lampGlow != null;
    const behind = this.#behind();
    this.#behindShown = behind != null;
    if ((this.#glowShown || this.#behindShown) && this.#batchDepth === 0) this.#arm(); // prettier-ignore
    this.#scope.dispatchEvent(
      new CustomEvent("chiphippo:sim-state", {
        detail: {
          running: this.running,
          mode: this.#mode,
          // The simulated moment this board stands at (seconds; null when
          // stopped or replaying) — how far the run has got, for the
          // analyzer's time axis.
          at: tick && !tick.replay && this.#mode !== TRANSPORT.STOPPED ? this.#shownAt() : null, // prettier-ignore
          netLevels: result?.netLevels ?? new Map(),
          // Levels from supplies/chip outputs ALONE (no resistor pulls) — the
          // views use these to spot an LED wired with no series resistor.
          strongLevels: result?.strongLevels ?? new Map(),
          chipStatus: result?.chipStatus ?? new Map(),
          warnings: result?.warnings ?? [],
          netlist: netlist ?? null,
          // A bounce's netlist: it travels with the board (sim-worker-host.js).
          ownNetlist: netlist ? this.#bounceBuilt.has(netlist) : false,
          clockLevels: this.#shownClockLevels(result, netlist),
          // Clocks held by their own pause (not the transport's) — each
          // clock brick's pause button shows resume for these. Empty when
          // not running.
          pausedClocks: new Set(this.#pausedClocks),
          // Signal id → the level its button is holding, so the rail lights up
          // from this ONE broadcast; views never query the engine. Empty when
          // not running, which returns every button to showing its `rest`.
          signalLevels: new Map(this.#signalLevel),
          // Per-LCD framebuffers (compId → { chars, cursor, … }); empty when
          // not running, which blanks every LCD screen.
          displayState: displays ?? new Map(),
          // Each timed part's reading of its own R and C (compId → analysis,
          // sim/timing.js) — what its readout and any wiring warning show.
          // Empty when not running.
          timing: result?.timing ?? new Map(),
          // Every channel part's channels (compId → [{on, held}]) — what a
          // transistor's lamp lights from, and whether a MOSFET is holding.
          // Empty when not running.
          channels: this.#shownChannels(result),
          // Spice Lite: net → volts for every net it knows a voltage of —
          // every net something holds (spice/voltages.js), RC nodes
          // included. Empty on the digital engine and when not running.
          nodeVolts: result?.nodeVolts ?? new Map(),
          // Spice Lite: each PSU's delivered voltage and current (psuId →
          // {volts, amps, limit, limited}) — the brick's readout. Empty on the
          // digital engine and when not running.
          // A moving run's current is its mean over the frame.
          supplies: meanAmps && result?.supplies ? new Map([...result.supplies].map(([id, sup]) => [id, meanAmps.has(id) ? { ...sup, amps: meanAmps.get(id) } : sup])) : (result?.supplies ?? new Map()), // prettier-ignore
          // Spice Lite: each regulator's and electronic load's reading
          // (compId → {volts, amps, watts, …}, spice/bench-warnings.js) —
          // the load's readout and the regulator's hover. Empty on the
          // digital engine and when not running.
          bench: result?.bench ?? new Map(),
          // Spice Lite: what each speaker is playing (compId → {hz, vpp,
          // watts, volume}, spice/speakers.js) — while the run MOVES: paused,
          // stepped by hand or held by the debugger, nothing sounds. What
          // components/speaker-audio.js plays and the speaker's hover says.
          tones:
            this.#mode === TRANSPORT.RUNNING &&
            !this.#debugStalled &&
            !this.#debugDeciding
              ? (result?.tones ?? new Map())
              : new Map(),
          // Spice Lite: every LED junction's current and fate (key `c4`, or
          // `c5#a` for a segment → {amps, lit, level, overdriven, burnt}) —
          // what the desk lights them from. NULL on the digital engine, whose
          // LEDs the junction rule lights instead.
          lamps: result?.lamps ?? null,
          // Each LED's and segment's brightness averaged over the simulated
          // time this frame covers (sim/lamp-average.js: key → mean, 0 dark,
          // a lit lamp's level, 1 on the digital engine) — or null when
          // nothing changed in it, and the tick's own lamps are the picture.
          lampGlow,
          // Each multimeter's reading over its display's window (meter id →
          // {mean, rms, min, max, last, span}, volts across its probes —
          // sim/meter-average.js), taken five times a second while the run
          // moves. Empty when stopped and on the digital engine.
          meters: this.#meterReadings(moving),
          // Spice Lite: the current through every lead it knows one for
          // (hole address → amps) — what the probe reads out. No part shows
          // a current of its own. Empty on the digital engine.
          currents: result?.currents ?? new Map(),
          // The fastest toggle on the desk, wall Hz (#fastestHz) — while it
          // is RUNNING: paused, stepped by hand or held by the debugger,
          // nothing toggles on its own, and the lamps glow again.
          fastestHz:
            this.#mode === TRANSPORT.RUNNING &&
            !this.#debugStalled &&
            !this.#debugDeciding
              ? this.#fastestHz(result)
              : 0,
          // A debugger replay pass (#debugStall): the levels are a pass's.
          replay: result?.replay === true,
          // The CPU monitor's picture of the CPU it shows (sim/cpu-monitor.js
          // `cpuSummary`), or null — none shown, or not running.
          cpuMonitor: this.#cpuMonitorOf(result, netlist),
          // The speed the run is ACHIEVING when it cannot keep up with the
          // one asked (a batch out of budget — sim-pacer.js), else null.
          behind,
        },
      }),
    );
  }

  /** Every channel part's channels as the desk shows them — under Spice
      Lite a transistor's from the voltage solve (`transistors`: whether it
      conducts at the voltages on its pins, and whether a MOSFET's gate is
      floating), in place of the digital engine's switch. */
  #shownChannels(result) {
    const channels = result?.channels ?? new Map();
    if (!result?.transistors?.size) return channels;
    const out = new Map(channels);
    for (const [id, { on, held }] of result.transistors) {
      const was = channels.get(id)?.[0] ?? {};
      out.set(id, [{ ...was, on: on ? H : L, held }]);
    }
    return out;
  }

  /** Each clock's level as the desk shows it. An unpowered clock brick is
      stopped whatever its timer says (the engine drives nothing from it), so
      its lamp stays dark. */
  #shownClockLevels(result, netlist) {
    const out = new Map(this.#clockPhase);
    for (const [id, volts] of result?.clockSupply ?? []) {
      if (volts == null) out.set(id, L);
    }
    // A Spice Lite wave's lamp is lit while its output stands above the
    // middle of its swing (its Offset, held to its rails), not by the square
    // its edges keep.
    const volts = result?.nodeVolts;
    if (!volts || !netlist) return out;
    for (const c of this.#clocks()) {
      if (!this.#keepsPhase(c)) continue;
      const supply = result.clockSupply?.get(c.id);
      const v = volts.get(netlist.netOfPoint.get(formatAddress(c.id, "out")));
      if (!(supply > 0) || v == null) continue;
      const sw = waveSwing(c.params, supply);
      const centre = Math.min(sw.ceil, Math.max(sw.floor, (sw.lo + sw.hi) / 2));
      out.set(c.id, v >= centre ? H : L);
    }
    return out;
  }

  #refName(id) {
    const comp = this.#doc.getComponent(id);
    // A designed chip is named by its part number; its ref is an opaque id.
    return comp ? `${chipMarking(partDef(comp.ref), comp.ref)} (${id})` : id;
  }

  /** An LED, or one segment of a display, named in a sentence: "LED (c4)",
      "8-segment digit (common cathode) (c5), segment a". */
  #lampName(id, seg) {
    const def = partDef(this.#doc.getComponent(id)?.ref);
    const part = def ? `${partTitle(def)} (${id})` : id;
    return seg == null ? part : t("sim.ledSegment", { part, segment: seg });
  }

  /** A regulator's, an electronic load's or a speaker's warning (Spice
      Lite), keyed per part and said through `#warn`, so a condition that
      holds tick after tick says so once — again only when its words change
      (it was re-raised every tick, and one clicked away came straight
      back). */
  #benchWarning(w) {
    const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
    const part = this.#brickName(w.comp);
    const say = {
      "regulator-dropout": [
        "sim.regulatorDropout",
        { part, volts: n(w.volts) },
      ],
      "regulator-limit": ["sim.regulatorLimit", { part, milliamps: n(w.amps * 1000) }], // prettier-ignore
      "regulator-hot": ["sim.regulatorHot", { part, watts: n(w.watts), limit: n(w.limit) }], // prettier-ignore
      "regulator-shutdown": [
        "sim.regulatorShutdown",
        { part, watts: n(w.watts) },
      ],
      "regulator-open": ["sim.regulatorOpen", { part, volts: n(w.volts) }],
      "load-power": ["sim.loadPower", { part, watts: n(w.watts), limit: n(w.limit) }], // prettier-ignore
      "speaker-power": ["sim.speakerPower", { part, watts: n(w.watts), limit: n(w.limit) }], // prettier-ignore
      "speaker-burnt": ["sim.speakerBurnt", { part, watts: n(w.watts), limit: n(w.limit) }], // prettier-ignore
    }[w.type];
    if (!say) return;
    const [key, params] = say;
    // A speaker's two say one thing each about its coil: the burn replaces
    // the warning that came before it.
    const about = w.type.startsWith("speaker-") ? "speaker" : w.type;
    // (A danger one — shut down hot, a coil burnt open — stays until it is
    // clicked away or the run stops, as an LED's burn does.)
    this.#warn({
      key: `${about}:${w.comp}`,
      variant: w.type === "regulator-shutdown" || w.type === "speaker-burnt" ? "danger" : "warning", // prettier-ignore
      title: t(key),
      message: t(`${key}Message`, params),
    });
  }

  /** A brick named in a sentence — its part's title, not its ref ("Power
      supply (psu1)"); a chip's marking is what `#refName` gives. */
  #brickName(id) {
    const def = partDef(this.#doc.getComponent(id)?.ref);
    return def ? `${partTitle(def)} (${id})` : id;
  }

  /** The supply a chip is rated for ("5 V", "3–18 V") — its family's. */
  #rating(id) {
    return supplyText(partDef(this.#doc.getComponent(id)?.ref));
  }

  #report(warnings) {
    if (!this.#notifications) return;
    this.#reported = new Set();
    this.#underSeen = new Set();
    const dueBefore = this.#underDue;
    this.#underDue = null;
    try {
      this.#reportEach(warnings);
    } finally {
      // A chip this tick did not report underpowered has broken its stretch.
      for (const chip of this.#underSince.keys()) {
        if (!this.#underSeen.has(chip)) this.#underSince.delete(chip);
      }
      this.#underSeen = null;
      // A hold begun by this tick wants its wake: the tick armed the next
      // one before it was reported.
      if (this.#underDue != null && this.#underDue !== dueBefore && this.#batchDepth === 0) this.#arm(); // prettier-ignore
      // Every warning said before and not reported by this tick has cleared
      // — from this tick on, unless it has already (#warn's REARM_S).
      for (const [key, was] of this.#warned) {
        if (!this.#reported.has(key)) was.clearedAt ??= this.#tickAt;
      }
      this.#reported = null;
    }
  }

  #reportEach(warnings) {
    for (const w of warnings) {
      if (w.type === "short") {
        // Through an analog switch — or a transistor switched on — the two
        // rails are still two nets, and the part between them is the thing
        // to look at.
        this.#warn({
          key: `short:${w.net}`,
          variant: "danger",
          title: t("sim.short"),
          message: t(
            w.via === "transistor"
              ? "sim.shortThroughTransistorMessage"
              : w.via === "switch"
                ? "sim.shortThroughSwitchMessage"
                : "sim.shortMessage",
            { net: w.net },
          ),
        });
      } else if (w.type === "conflict") {
        this.#warn({
          key: `conflict:${w.net}`,
          variant: "warning",
          title: t("sim.conflict"),
          message: t("sim.conflictMessage", { net: w.net }),
        });
      } else if (w.type === "oscillation") {
        this.#warn({
          key: "oscillation",
          variant: "warning",
          title: t("sim.oscillation"),
          message: t("sim.oscillationMessage", { count: w.nets.length }),
        });
      } else if (w.type === "underpowered") {
        // Said once it has stood UNDER_HOLD_S without a break — a shorter
        // sag says nothing — and under Spice Lite never inside Run's
        // `SETTLE_S`, where a chip's rail rises like everything else: an
        // LM358 behind a 7805 and a bridge's reservoir passes 2.25 V on its
        // way to 5 V, 1.5 ms in, and was said underpowered for it.
        this.#underSeen?.add(w.chip);
        const since = this.#underSince.get(w.chip) ?? this.#tickAt;
        this.#underSince.set(w.chip, since);
        const due = Math.max(since + UNDER_HOLD_S, this.#engine === ENGINES.spice ? SETTLE_S : 0); // prettier-ignore
        if (this.#tickAt < due - HOLD_EPS_S) {
          this.#underDue = this.#underDue == null ? due : Math.min(this.#underDue, due); // prettier-ignore
          continue;
        }
        // A chip in its margin (under its range, over its floor —
        // families.js `supplyFloor`) is working, and says so.
        this.#warn({
          key: `under:${w.chip}`,
          variant: "warning",
          title: t("sim.underpowered"),
          reading: { value: w.volts ?? 0, within: UNDER_REPEAT_V },
          since,
          message: t(
            w.margin
              ? "sim.underpoweredMarginMessage"
              : "sim.underpoweredMessage",
            {
              chip: this.#refName(w.chip),
              volts: voltsText(w.volts),
              rating: this.#rating(w.chip),
            },
          ),
        });
      } else if (w.type === "reversed") {
        this.#warn({
          key: `reversed:${w.chip}`,
          variant: "danger",
          title: t("sim.reversed"),
          message: t("sim.reversedMessage", { chip: this.#refName(w.chip) }),
        });
      } else if (w.type === "damaged") {
        this.#warn({
          key: `smoke:${w.chip}`,
          variant: "danger",
          title: t("sim.damaged"),
          message: t("sim.damagedMessage", {
            chip: this.#refName(w.chip),
            volts: voltsText(w.volts),
            rating: this.#rating(w.chip),
          }),
        });
      } else if (w.type === "brownout") {
        // Spice Lite: an output whose load holds its net where the inputs on
        // it no longer read the level it drives (spice/loads.js) — a circuit
        // that does not work, never smoke.
        this.#warn({
          key: `brownout:${w.chip}`,
          variant: "warning",
          title: t("sim.brownout"),
          message: t("sim.brownoutMessage", {
            chip: this.#refName(w.chip),
            pin: w.pin,
            level: w.level === H ? "HIGH" : "LOW",
            volts: formatNumber(w.volts, { maximumSignificantDigits: 3 }),
            count: w.misread,
          }),
        });
      } else if (w.type === "switch-current") {
        // Spice Lite: an analog switch channel past its sheet's rating — past
        // its smoke limit, brown smoke (latched like any other).
        const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
        this.#warn({
          key: `switch:${w.chip}`,
          variant: w.smoke ? "danger" : "warning",
          title: t(w.smoke ? "sim.brownSmoke" : "sim.switchCurrent"),
          message: t(
            w.smoke ? "sim.switchCurrentSmokeMessage" : "sim.switchCurrentMessage", // prettier-ignore
            {
              chip: this.#refName(w.chip),
              current: n(w.amps * 1000),
              limit: n(w.limit),
            },
          ),
        });
      } else if (w.type === "transistor-overload") {
        // Spice Lite: a discrete transistor past its kind's common current or
        // power limits. It carries on (nothing latches a part with no
        // supply), and the warning says a real one would not.
        const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
        const byPower = w.unit === "mW";
        this.#warn({
          key: `transistor:${w.comp}`,
          variant: w.smoke ? "danger" : "warning",
          title: t("sim.transistorOverload"),
          message: t(
            byPower
              ? w.smoke
                ? "sim.transistorPowerSmokeMessage"
                : "sim.transistorPowerMessage"
              : w.smoke
                ? "sim.transistorCurrentSmokeMessage"
                : "sim.transistorCurrentMessage",
            {
              part: this.#brickName(w.comp),
              current: n(w.amps * 1000),
              power: n(w.watts * 1000),
              limit: n(w.limit),
            },
          ),
        });
      } else if (w.type === "opto-led") {
        // Spice Lite: an optocoupler's LED past its rating (OPTO_LIMITS).
        const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
        this.#warn({
          key: `transistor:${w.comp}`,
          variant: w.smoke ? "danger" : "warning",
          title: t("sim.optoLedOverload"),
          message: t(
            w.smoke ? "sim.optoLedSmokeMessage" : "sim.optoLedMessage",
            {
              part: this.#brickName(w.comp),
              current: n(w.amps * 1000),
              limit: n(w.limit),
            },
          ),
        });
      } else if (w.type === "linear-bias") {
        // Spice Lite: a gate its own feedback resistor biases half way up its
        // transfer curve — an amplifier, which Spice Lite does not model.
        this.#warn({
          key: `bias:${w.chip}`,
          variant: "warning",
          title: t("sim.linearBias"),
          message: t("sim.linearBiasMessage", {
            chip: this.#refName(w.chip),
            pin: w.pin,
          }),
        });
      } else if (w.type === "inductive-kick") {
        // Spice Lite: an inductor's current, its path opened, found none but
        // through a transistor's breakdown — no flyback diode across it. The
        // transistor carries on (nothing latches a part with no supply).
        // Past what its package absorbs in one (`limit`, mJ), it says so —
        // and past its smoke figure that a real one would have failed.
        const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
        const over = w.limit != null;
        this.#warn({
          key: `kick:${w.comp}`,
          variant: w.smoke ? "danger" : "warning",
          title: t("sim.inductiveKick"),
          message: t(
            !over
              ? "sim.inductiveKickMessage"
              : w.smoke
                ? "sim.inductiveKickSmokeMessage"
                : "sim.inductiveKickHotMessage",
            {
              part: this.#brickName(w.comp),
              volts: n(w.volts),
              energy: n(w.joules * 1000),
              limit: over ? n(w.limit) : "",
            },
          ),
        });
      } else if (
        w.type.startsWith("regulator-") ||
        w.type.startsWith("speaker-") ||
        w.type === "load-power"
      ) {
        // Spice Lite: a linear regulator out of its depth, or an electronic
        // load past its rating (spice/bench-warnings.js), or a speaker's
        // coil past its own (spice/speakers.js) — but not what a circuit
        // still rising after Run looks like (`SETTLE_S`).
        if (SETTLING_WARNINGS.has(w.type) && this.#tickAt < SETTLE_S) {
          this.#settleCheck = true;
          continue;
        }
        this.#benchWarning(w);
      } else if (w.type === "supply-spike") {
        // Spice Lite: chips switching together asked more of a supply than
        // its limit, with nothing across the rails to supply the spike.
        this.#warn({
          key: `spike:${w.psu}`,
          variant: "warning",
          title: t("sim.supplySpike"),
          message: t("sim.supplySpikeMessage", {
            psu: this.#brickName(w.psu),
            peak: formatNumber(w.peak * 1000, { maximumSignificantDigits: 3 }),
            limit: formatNumber(w.limit * 1000, {
              maximumSignificantDigits: 3,
            }),
          }),
        });
      } else if (w.type === "led-burnt") {
        // Spice Lite: an LED's junction passed its maximum temperature. One
        // key per part, so it replaces that LED's overdriven warning.
        this.#warn({
          key: `led:${w.comp}`,
          variant: "danger",
          title: t("sim.ledBurnt"),
          message: t("sim.ledBurntMessage", {
            led: this.#lampName(w.comp, w.seg),
            current: formatNumber(w.amps * 1000, { maximumSignificantDigits: 3 }), // prettier-ignore
            tj: formatNumber(w.tj, { maximumFractionDigits: 0 }),
            max: formatNumber(w.tjMax, { maximumFractionDigits: 0 }),
          }),
        });
      } else if (w.type === "clock-unpowered") {
        // A clock runs from a supply like any instrument on the bench.
        this.#warn({
          key: `clock-power:${w.chip}`,
          variant: "warning",
          title: t("sim.clockUnpowered"),
          message: t("sim.clockUnpoweredMessage", {
            clock: this.#brickName(w.chip),
          }),
        });
      } else if (w.type === "diode-burnt") {
        // Spice Lite: a diode's junction passed its maximum temperature —
        // one straight across the rails, or an output into ground.
        this.#warn({
          key: `diode:${w.comp}`,
          variant: "danger",
          title: t("sim.diodeBurnt"),
          message: t("sim.diodeBurntMessage", {
            diode: this.#brickName(w.comp),
            current: formatNumber(w.amps * 1000, { maximumSignificantDigits: 3 }), // prettier-ignore
            tj: formatNumber(w.tj, { maximumFractionDigits: 0 }),
            max: formatNumber(w.tjMax, { maximumFractionDigits: 0 }),
          }),
        });
      } else if (w.type === "output-current") {
        // Spice Lite: an output carrying more than its family is made for —
        // a current for a 74LS part, the power in its output transistor for
        // a CD4000 one — and past its smoke limit, brown smoke.
        const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
        const byPower = w.unit === "mW";
        this.#warn({
          key: `output:${w.chip}`,
          variant: w.smoke ? "danger" : "warning",
          title: t(w.smoke ? "sim.brownSmoke" : "sim.outputCurrent"),
          message: t(
            byPower
              ? w.smoke
                ? "sim.outputPowerSmokeMessage"
                : "sim.outputPowerMessage"
              : w.smoke
                ? "sim.outputCurrentSmokeMessage"
                : "sim.outputCurrentMessage",
            {
              chip: this.#refName(w.chip),
              pin: w.pin,
              current: n(w.amps * 1000),
              power: n(w.watts * 1000),
              limit: n(w.limit),
            },
          ),
        });
      } else if (w.type === "rx-current") {
        // Spice Lite: a monostable's discharge transistor holding more than
        // its sheet's least timing resistor lets through — Rx too small.
        const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
        this.#warn({
          key: `output:${w.chip}`,
          variant: "warning",
          title: t("sim.rxCurrent"),
          message: t("sim.rxCurrentMessage", {
            chip: this.#refName(w.chip),
            pin: w.pin,
            current: n(w.amps * 1000),
            limit: n(w.limit),
            rxMin: n(w.rxMin / 1000),
          }),
        });
      } else if (w.type === "input-overvoltage") {
        // Spice Lite: a 74LS input held past its absolute maximum.
        this.#warn({
          key: `input:${w.chip}`,
          variant: "danger",
          title: t("sim.brownSmoke"),
          message: t("sim.inputOvervoltageMessage", {
            chip: this.#refName(w.chip),
            pin: w.pin,
            volts: formatNumber(w.volts, { maximumSignificantDigits: 3 }),
            max: formatNumber(w.max, { maximumSignificantDigits: 3 }),
          }),
        });
      } else if (w.type === "input-clamp") {
        // Spice Lite: a CD4000 or MOS input held past one of its rails, or a
        // 74LS input held below its ground (an AC source wired straight on),
        // its protection or clamp diode conducting — past its rating, brown
        // smoke.
        const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
        this.#warn({
          key: `input:${w.chip}`,
          variant: w.smoke ? "danger" : "warning",
          title: t(w.smoke ? "sim.brownSmoke" : "sim.inputClamp"),
          message: t(
            w.smoke ? "sim.inputClampSmokeMessage" : "sim.inputClampMessage",
            {
              chip: this.#refName(w.chip),
              pin: w.pin,
              volts: n(w.volts),
              current: n(w.amps * 1000),
              max: n(w.max * 1000),
            },
          ),
        });
      } else if (w.type === "led-overdriven") {
        this.#warn({
          key: `led:${w.comp}`,
          variant: "warning",
          title: t("sim.ledOverdriven"),
          message: t("sim.ledOverdrivenMessage", {
            led: this.#lampName(w.comp, w.seg),
            current: formatNumber(w.amps * 1000, { maximumSignificantDigits: 3 }), // prettier-ignore
            rating: formatNumber(w.rating * 1000, { maximumSignificantDigits: 3 }), // prettier-ignore
          }),
        });
      } else if (w.type === "led-reverse") {
        this.#warn({
          key: `led-reverse:${w.comp}`,
          variant: "warning",
          title: t("sim.ledReverse"),
          message: t("sim.ledReverseMessage", {
            led: this.#lampName(w.comp, w.seg),
            volts: formatNumber(w.volts, { maximumSignificantDigits: 3 }),
            rating: formatNumber(w.rating, { maximumSignificantDigits: 3 }),
          }),
        });
      } else if (w.type === "overloaded") {
        this.#warn({
          key: `brownout:${w.chip}`,
          variant: "danger",
          title: t("sim.brownSmoke"),
          message: t("sim.overloadedMessage", { chip: this.#refName(w.chip) }),
        });
      } else if (w.type === "floating-input") {
        // Feature 400: a CMOS input nothing drives reads unknown — quiet on
        // its own (an LED on an X net is just dark), so it is said.
        this.#warn({
          key: `floating:${w.chip}`,
          variant: "warning",
          title: t("sim.floatingInput"),
          message: t("sim.floatingInputMessage", {
            chip: this.#refName(w.chip),
            pins: w.pins.join(", "),
            count: w.pins.length,
          }),
        });
      } else if (w.type === "marginal-high") {
        this.#warn({
          key: `marginal:${w.net}`,
          variant: "warning",
          title: t("sim.marginalHigh"),
          message: t("sim.marginalHighMessage", { net: w.net }),
        });
      } else if (w.type === "ls-fanout") {
        this.#warn({
          key: `fanout:${w.net}`,
          variant: "warning",
          title: t("sim.lsFanout"),
          message: t("sim.lsFanoutMessage", {
            chip: this.#refName(w.chip),
            net: w.net,
            loads: w.loads,
            count: w.max,
          }),
        });
      } else if (w.type === "timing") {
        // A timed part that cannot read its own R and C: it says what is
        // missing rather than guess, and holds its output (sim/timing.js).
        this.#warn({
          key: `timing:${w.chip}`,
          variant: "warning",
          title: t("sim.timing"),
          message: t("sim.timingMessage", {
            chip: this.#refName(w.chip),
            problems: timingProblemSentences(w).join("; "),
          }),
        });
      } else if (w.type === "supplies-meet") {
        // Two PSUs at different voltages feed one `+` net — the halves of a
        // split rail jumpered together, say. Danger, like a short: one
        // supply is driving current back into the other.
        this.#warn({
          key: `supplies:${w.net}`,
          variant: "danger",
          title: t("sim.suppliesMeet"),
          message: t("sim.suppliesMeetMessage", {
            net: w.net,
            volts: w.volts.map((v) => `${v} V`).join(" / "),
          }),
        });
      } else if (w.type === "mixed-supply") {
        this.#warn({
          key: `mixed:${w.net}`,
          variant: "warning",
          title: t("sim.mixedSupply"),
          message: t("sim.mixedSupplyMessage", {
            net: w.net,
            volts: w.volts.map((v) => `${v} V`).join(" / "),
          }),
        });
      }
    }
  }

  /**
   * Every damaged chip made whole again — the other end of `#persistDamage`.
   *
   * A 12 V mistake is a WIRING mistake, and the circuit on the desk is the
   * thing being edited: leaving a dead chip behind would mean an experiment
   * could permanently spoil the design it was run on, recoverable only by
   * deleting the chip and re-wiring it. So the smoke clears when the run ends.
   * The warning it raised has already been seen, which is the part that was
   * ever meant to teach anything.
   */
  #clearAllDamage() {
    let changed = false;
    for (const c of this.#doc.toJSON().components) {
      // Every run latch: a chip's smoke, a meter's blown fuse.
      const held = RUN_LATCHES.filter((key) => c.params?.[key] === true);
      if (!held.length) continue;
      this.#doc.setComponentParams(c.id, Object.fromEntries(held.map((key) => [key, false]))); // prettier-ignore
      changed = true;
    }
    if (changed) this.#tellTicks();
    if (changed)
      this.#scope.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }

  // `replaceChip(id)` used to live here — the single-chip version of
  // #clearAllDamage, kept as the manual recovery path for a 12 V kill. It never
  // had a UI caller, and a stop now clears every chip on its own, so there is
  // nothing left for it to be the answer to.
}
