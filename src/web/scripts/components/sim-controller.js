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
// Whatever needs EVERY tick hears every tick: `chiphippo:sim-tick` (the logic
// analyzer's stream), the settle boundary, the debugger. An input (a switch,
// a signal key, an edit) first runs whatever is due, then ticks and publishes
// at once — the board answers on the same event, as it always has.

import { formatNumber, t } from "../i18n.js";
import { prepareCircuit } from "../sim/engine.js";
import { ENGINES, engineFor } from "../sim/engines.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";
import { familyParams } from "../sim/spice/params.js";
import { H, L } from "../sim/levels.js";
import { chipMarking, partDef } from "../catalog/index.js";
import { partTitle } from "../catalog/labels.js";
import { supplyText } from "../catalog/families.js";
import { restLevel } from "../model/signals.js";
import {
  isMemory,
  isVolatileMemory,
  isOscillator,
  memoryConfig,
} from "../sim/chip-eval.js";
import { framebufferOf } from "../sim/hd44780.js";
import {
  oscillationHz,
  timingProblemSentences,
} from "../model/timing-summary.js";
import { COINCIDENT_S, EdgeSchedule, halfPeriodOf } from "../sim/schedule.js";
import { MIN_SHOWN_S } from "../sim/timing.js";
import { NetlistCache } from "./netlist-cache.js";
import { BATCH_BUDGET_MS, FRAME_MS, RunMeter } from "./sim-pacer.js";

/** The wall clock, in ms — monotonic where the platform has one. */
const wallMs = () => globalThis.performance?.now?.() ?? Date.now();

/** The empty map a tick without Spice Lite's readings hands on — one, shared
    and only ever read, rather than a fresh one per tick at 8000 a second. */
const NO_READINGS = new Map();

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

/**
 * How many settles ONE tick request may chain through `{again: true}` before
 * it stops and waits for the next event. Each answer consumes the value that
 * prompted it, so a real chain is one or two long; the cap only guarantees a
 * misbehaving collaborator can never spin the renderer.
 */
const MAX_BOUNDARY_PASSES = 32;

export class SimController {
  #doc;
  #netlist;
  #notifications;
  #onTransportChange;
  #mode = TRANSPORT.STOPPED;
  #speed = 1;
  #warm = new Map(); // previous stable net levels (warm start)
  #state = new Map(); // per-component sequential state (run-volatile)
  #prevPins = new Map(); // last tick's sampled inputs (edge detection)
  #clockPhase = new Map(); // clockId → "H" | "L" (run-volatile)
  #pausedClocks = new Set(); // clockIds held by their OWN pause (run-volatile)
  #signalLevel = new Map(); // signalId → "H" | "L" (run-volatile, from `rest`)
  #images = new Map(); // memory compId → Uint8Array/Uint16Array (run-volatile)
  #memInfo = new Map(); // memory compId → { volatile, guid, width, byteLength }
  #dataLossWarned = new Set(); // programmed chips already warned of a missing file
  #toastKeys = new Set(); // the keys of the toasts this run has raised
  #schedule = new EdgeSchedule(); // the ticking clocks' edges, in sim time
  #pacer = null; // the ONE timer: it runs the next batch (#arm)
  #wall = wallMs; // the wall clock, ms (a test hands in its own)
  #timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) }; // prettier-ignore
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
  // the copy this run took.
  #spiceConfig = normalizeSpiceConfig(null);
  #runConfig = this.#spiceConfig;
  #engine = ENGINES.digital;
  #analog = null; // Spice Lite's carried analog state (run-volatile)
  #realAnchor = null; // wall-clock ms the sim clock last started from; null = frozen
  #wakeAt = null; // simulated seconds a timed part next changes at, or null
  #debug = null; // the chip debugger (see the file header)
  // The document as the engine reads it, and the engine's prepared context
  // for it — both kept from tick to tick until the document changes (every
  // change rides doc-changed or part-state; #forgetDocument). A snapshot of
  // the whole document per tick was 5% of a busy desk's main thread.
  #docSnap = null;
  #circuit = null;
  #debugStalled = false; // the stall is the debugger's (a person is reading it)
  #debugDeciding = false; // inside afterTick: what it shows is the debugger's
  #heldInputs = []; // input events made while the debugger held the board
  #shownStrong = new Map(); // the strong levels the board last showed

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
   */
  constructor({
    deskDoc,
    notifications,
    onTransportChange,
    netlist,
    integration,
    debug,
    clock,
  }) {
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
    window.addEventListener("chiphippo:part-state", this.#onPartState);
    window.addEventListener("chiphippo:doc-changed", this.#onDocChanged);
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
    this.#analog = null;
    this.#warm = new Map();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#clockPhase = new Map();
    for (const c of this.#clocks()) this.#clockPhase.set(c.id, L); // idle low
    this.#pausedClocks = new Set(); // every clock starts going
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
    this.#thaw();
    this.#tickNow();
    this.#scheduleClocks();
    // Tell any open inspector the run has begun, as Stop tells it the run has
    // ended: a window opened while stopped otherwise went on reading "Stopped ·
    // editable" all run, and an SRAM's showed deltas over a zeroed grid.
    window.dispatchEvent(
      new CustomEvent("chiphippo:mem-state", {
        detail: { running: true, started: true, changes: new Map() },
      }),
    );
  }

  /** Freeze time (stop the clocks) but keep the state + live view. */
  pause() {
    if (this.#mode !== TRANSPORT.RUNNING) return;
    this.#mode = TRANSPORT.PAUSED;
    this.#cancelPacer();
    this.#schedule.clear();
    this.#freeze();
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
    this.#analog = null;
    this.#forgetDocument();
    this.#warm = new Map();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#clockPhase = new Map();
    this.#pausedClocks = new Set();
    this.#signalLevel = new Map();
    this.#images = new Map();
    this.#memInfo = new Map();
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
    // BEFORE #onTransportChange: stopping re-baselines undo/redo against the
    // live document (`#history.sync`), so the chips have to be whole by the
    // time that runs — otherwise the baseline would hold the damage and a ⌘Z
    // would bring the magic smoke back.
    this.#clearAllDamage();
    this.#onTransportChange?.(this.#mode);
    this.#publish(null, null); // views clear from a not-running sim-state
    // Hand any open inspector windows the final image (→ back to editable).
    window.dispatchEvent(
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
    for (const c of ticking) this.#flip(c.id);
    // Simulated time moves on with the step, so a timed part steps too: by
    // the half-period the fastest clock just made (keeping it in step with the
    // edges the bricks produce), or — with no clock running — straight to the
    // next moment a timed part changes.
    const halves = ticking.map((c) => 1 / (2 * c.params.hz));
    if (halves.length) this.#simAnchor += Math.min(...halves);
    else if (this.#wakeAt != null) {
      this.#simAnchor = Math.max(this.#simAnchor, this.#wakeAt);
    }
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
    this.#timers.clear(this.#pacer);
    this.#pacer = null;
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
    if (!next) return;
    const now = this.#wall();
    const due = ((next.at - this.#simNow()) * 1000) / this.#speed;
    const frame = gate ? this.#lastPublishWall + FRAME_MS - now : 0;
    const ms = Math.max(0, due, frame);
    this.#pacer = this.#timers.set(() => {
      this.#pacer = null;
      this.#runBatch();
    }, ms);
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
  #runBatch({ flush = true } = {}) {
    if (this.#mode !== TRANSPORT.RUNNING || this.#stalled) return;
    // Re-entered from inside a batch (an input dispatched by a boundary or a
    // sim-tick listener): the batch running is already catching up, and a
    // nested one would end its batching early and split what it owes.
    if (this.#batchDepth > 0) return;
    this.#cancelPacer();
    const started = this.#wall();
    const target = this.#simNow();
    let ran = 0;
    this.#batchDepth += 1;
    try {
      for (;;) {
        const event = this.#nextEvent();
        if (!event || event.at > target + COINCIDENT_S) break;
        if (ran && this.#wall() - started >= BATCH_BUDGET_MS) {
          this.#simAnchor = this.#tickAt;
          this.#realAnchor = this.#wall();
          this.#meter.dropped(this.#realAnchor);
          break;
        }
        for (const id of event.clocks) this.#flip(id);
        this.#schedule.consume(event.clocks);
        // Time never runs backwards: an input may have ticked a hair past an
        // edge still queued.
        this.#tickNow(Math.max(event.at, this.#tickAt));
        ran += 1;
        if (this.#stalled || this.#mode !== TRANSPORT.RUNNING) break;
      }
    } finally {
      this.#batchDepth -= 1;
    }
    if (flush) this.#flushSoon();
    if (this.#mode === TRANSPORT.STOPPED) return;
    this.#meter.record(this.#wall(), this.#simNow());
    this.#arm();
  }

  /**
   * The earliest event due. A timed part's wake comes no sooner than
   * MIN_SHOWN_S after the last tick — nothing is drawn faster than the cap
   * (sim/timing.js), and Spice Lite asks for a wake at every CROSSING: ticked
   * at each one exactly, a tick would never span the crossings a cycle is
   * recognised by (spice/cycles.js), and a 48 kHz oscillator would be run
   * edge by edge. Clock edges keep their exact moments.
   */
  #nextEvent() {
    const wake =
      this.#wakeAt == null
        ? null
        : Math.max(this.#wakeAt, this.#tickAt + MIN_SHOWN_S);
    return this.#schedule.next(wake);
  }

  /** An input is about to tick the board: run what fell due before it, so it
      lands after the edges that came first. */
  #catchUp() {
    this.#runBatch({ flush: false });
    // A board that stalled on the way is shown now: the input waits.
    if (this.#stalled) this.#flushPublish();
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
    if (this.#pausedClocks.delete(id)) {
      if (this.#mode === TRANSPORT.RUNNING) {
        this.#schedule.set(id, halfPeriodOf(clock.params.hz), this.#simNow());
      }
    } else {
      this.#pausedClocks.add(id);
      this.#schedule.delete(id);
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
      oscillator cans — anything the engine reads via clockPhase. */
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
    const loads = [];
    for (const c of this.#doc.toJSON().components) {
      const def = partDef(c.ref);
      if (!isMemory(def)) continue;
      const info = {
        volatile: isVolatileMemory(def),
        guid: memGuid(c),
        width: memoryConfig(def).width,
        byteLength: byteLengthOf(def),
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
    const mem = window.chiphippo?.mem;
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
    window.dispatchEvent(
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
      this.#schedule.set(c.id, halfPeriodOf(c.params.hz), now);
    }
    this.#arm();
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
      this.#schedule.set(c.id, halfPeriodOf(c.params.hz), now);
    }
  }

  // ── Input events (re-settle without advancing the clock) ─────────────────

  // The edges that fell due BEFORE an input are caught up against the board
  // as it was before it: the document snapshot and the netlist prepared with
  // it (#tickOnce pairs them) are still the pre-edit ones until
  // #forgetDocument, so the catch-up runs first and the edit lands after it.

  #onPartState = () => {
    const live = this.running && !this.#suppress;
    if (live) this.#catchUp();
    this.#forgetDocument();
    if (!live) return;
    this.#tickNow();
  };

  #onDocChanged = () => {
    const live = this.running && !this.#suppress;
    if (live) this.#catchUp();
    this.#forgetDocument();
    if (!live) return;
    // A clock's rate may have changed via its menu, or a clock come or gone —
    // retime just those, then settle.
    this.#reconcileClocks();
    this.#tickNow();
  };

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

  /** The levels every planted driver holds: the signals' own, plus whatever
      the integration drives (an Input's pins), in the one map the engine
      reads. */
  #driveLevels() {
    const extra = this.#integration?.levels?.();
    if (!extra || extra.size === 0) return this.#signalLevel;
    return new Map([...this.#signalLevel, ...extra]);
  }

  /** The document changed: the next tick reads it afresh. */
  #forgetDocument() {
    this.#docSnap = null;
    this.#circuit = null;
  }

  /** The document as the run reads it: one snapshot, kept until it changes.
      Read-only — the engine, the clocks and the signals all share it. */
  #document() {
    return (this.#docSnap ??= this.#doc.toJSON());
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
      const netlist =
        this.#circuit?.doc === doc
          ? this.#circuit.netlist
          : this.#netlist.get();
      if (this.#circuit?.doc !== doc || this.#circuit?.netlist !== netlist) {
        this.#circuit = prepareCircuit(doc, netlist);
      }
      let observer = null;
      try {
        observer = this.#debug?.observer?.() ?? null;
      } catch (err) {
        console.error("[renderer] chip debugger observer failed:", err);
      }
      // Spice Lite's extra option; the digital engine takes no `spice`.
      const spice =
        this.#engine === ENGINES.spice
          ? { config: this.#runConfig, analog: this.#analog }
          : undefined;
      const result = this.#engine.tick({
        document: doc,
        netlist,
        warmStart: this.#warm,
        state: this.#state,
        prevPinLevels: this.#prevPins,
        clockPhase: this.#clockPhase,
        signalLevels: this.#driveLevels(),
        images: this.#images,
        now: (this.#tickAt = at ?? this.#simNow()),
        observer,
        spice,
        context: this.#circuit,
      });
      if (result.analog) this.#analog = result.analog;
      this.#warm = result.netLevels;
      this.#state = result.state;
      this.#prevPins = result.pinLevels;
      this.#wakeAt = result.wakeAt ?? null;
      if (this.#batchDepth === 0) this.#arm();
      // Volatile (SRAM) writes land in the run image + drive the live inspector;
      // ROM writes are dropped (read-only). No file is ever written while running.
      this.#oweMemChanges(this.#applyWrites(result.memWrites));
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
    if (changed) window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }

  /** What a batch owes: its memory writes, and its last tick's board.
      Whether a board was owed (and so published). */
  #flushPublish() {
    this.#flushMem();
    const owed = this.#owed;
    if (!owed) return false;
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
    if (!this.#owed) return;
    const wait = this.#lastPublishWall + FRAME_MS - this.#wall();
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

  /** The board last shown, again — for a transport change with no tick. */
  #republish() {
    const last = this.#lastShown;
    if (last) this.#publish(last.result, last.netlist, last.displays);
  }

  /**
   * `chiphippo:sim-tick` — ONE tick's board, for whatever must see every tick
   * however few of them the views are shown (the logic analyzer). The maps
   * are the tick's own, uncopied: a listener reads them in its handler.
   */
  #announceTick(result, netlist) {
    window.dispatchEvent(
      new CustomEvent("chiphippo:sim-tick", {
        detail: {
          running: true,
          mode: this.#mode,
          at: this.#tickAt,
          netlist,
          netLevels: result.netLevels,
          nodeVolts: result.nodeVolts ?? NO_READINGS,
          supplies: result.supplies ?? NO_READINGS,
          lamps: result.lamps ?? null,
        },
      }),
    );
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

  #publish(result, netlist, displays) {
    this.#owed = null;
    this.#timers.clear(this.#publishTimer);
    this.#publishTimer = null;
    this.#lastShown = result ? { result, netlist, displays } : null;
    this.#lastPublishWall = this.#wall();
    this.#shownStrong = result?.strongLevels ?? new Map();
    window.dispatchEvent(
      new CustomEvent("chiphippo:sim-state", {
        detail: {
          running: this.running,
          mode: this.#mode,
          netLevels: result?.netLevels ?? new Map(),
          // Levels from supplies/chip outputs ALONE (no resistor pulls) — the
          // views use these to spot an LED wired with no series resistor.
          strongLevels: result?.strongLevels ?? new Map(),
          chipStatus: result?.chipStatus ?? new Map(),
          warnings: result?.warnings ?? [],
          netlist: netlist ?? null,
          clockLevels: this.#shownClockLevels(result),
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
          supplies: result?.supplies ?? new Map(),
          // Spice Lite: every LED junction's current and fate (key `c4`, or
          // `c5#a` for a segment → {amps, lit, level, overdriven, burnt}) —
          // what the desk lights them from. NULL on the digital engine, whose
          // LEDs the junction rule lights instead.
          lamps: result?.lamps ?? null,
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
          // The speed the run is ACHIEVING when it cannot keep up with the
          // one asked (a batch out of budget — sim-pacer.js), else null.
          behind:
            this.#mode === TRANSPORT.RUNNING
              ? this.#meter.behind(this.#wall(), this.#speed)
              : null,
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
  #shownClockLevels(result) {
    const out = new Map(this.#clockPhase);
    for (const [id, volts] of result?.clockSupply ?? []) {
      if (volts == null) out.set(id, L);
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
    for (const w of warnings) {
      if (w.type === "short") {
        // Through an analog switch — or a transistor switched on — the two
        // rails are still two nets, and the part between them is the thing
        // to look at.
        this.#notify({
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
        this.#notify({
          key: `conflict:${w.net}`,
          variant: "warning",
          title: t("sim.conflict"),
          message: t("sim.conflictMessage", { net: w.net }),
        });
      } else if (w.type === "oscillation") {
        this.#notify({
          key: "oscillation",
          variant: "warning",
          title: t("sim.oscillation"),
          message: t("sim.oscillationMessage", { count: w.nets.length }),
        });
      } else if (w.type === "underpowered") {
        this.#notify({
          key: `under:${w.chip}`,
          variant: "warning",
          title: t("sim.underpowered"),
          message: t("sim.underpoweredMessage", {
            chip: this.#refName(w.chip),
            volts: w.volts ?? "?",
            rating: this.#rating(w.chip),
          }),
        });
      } else if (w.type === "reversed") {
        this.#notify({
          key: `reversed:${w.chip}`,
          variant: "danger",
          title: t("sim.reversed"),
          message: t("sim.reversedMessage", { chip: this.#refName(w.chip) }),
        });
      } else if (w.type === "damaged") {
        this.#notify({
          key: `smoke:${w.chip}`,
          variant: "danger",
          title: t("sim.damaged"),
          message: t("sim.damagedMessage", {
            chip: this.#refName(w.chip),
            volts: w.volts ?? "?",
            rating: this.#rating(w.chip),
          }),
        });
      } else if (w.type === "brownout") {
        // Spice Lite: an output whose load holds its net where the inputs on
        // it no longer read the level it drives (spice/loads.js) — a circuit
        // that does not work, never smoke.
        this.#notify({
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
        this.#notify({
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
        this.#notify({
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
      } else if (w.type === "supply-spike") {
        // Spice Lite: chips switching together asked more of a supply than
        // its limit, with nothing across the rails to supply the spike.
        this.#notify({
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
        this.#notify({
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
        this.#notify({
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
        this.#notify({
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
        this.#notify({
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
      } else if (w.type === "input-overvoltage") {
        // Spice Lite: a 74LS input held past its absolute maximum.
        this.#notify({
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
        // Spice Lite: a CD4000 or MOS input held past one of its rails, its
        // protection diode conducting — past its rating, brown smoke.
        const n = (x) => formatNumber(x, { maximumSignificantDigits: 3 });
        this.#notify({
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
        this.#notify({
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
        this.#notify({
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
        this.#notify({
          key: `brownout:${w.chip}`,
          variant: "danger",
          title: t("sim.brownSmoke"),
          message: t("sim.overloadedMessage", { chip: this.#refName(w.chip) }),
        });
      } else if (w.type === "floating-input") {
        // Feature 400: a CMOS input nothing drives reads unknown — quiet on
        // its own (an LED on an X net is just dark), so it is said.
        this.#notify({
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
        this.#notify({
          key: `marginal:${w.net}`,
          variant: "warning",
          title: t("sim.marginalHigh"),
          message: t("sim.marginalHighMessage", { net: w.net }),
        });
      } else if (w.type === "ls-fanout") {
        this.#notify({
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
        this.#notify({
          key: `timing:${w.chip}`,
          variant: "warning",
          title: t("sim.timing"),
          message: t("sim.timingMessage", {
            chip: this.#refName(w.chip),
            problems: timingProblemSentences(w).join("; "),
          }),
        });
      } else if (w.type === "mixed-supply") {
        this.#notify({
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
      if (c.params?.damaged !== true && c.params?.overloaded !== true) continue;
      this.#doc.setComponentParams(c.id, { damaged: false, overloaded: false });
      changed = true;
    }
    if (changed) window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }

  // `replaceChip(id)` used to live here — the single-chip version of
  // #clearAllDamage, kept as the manual recovery path for a 12 V kill. It never
  // had a UI caller, and a stop now clears every chip on its own, so there is
  // nothing left for it to be the answer to.
}
