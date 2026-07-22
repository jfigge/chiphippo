/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// sim-controller.js — the renderer's transport + run-state owner. It bridges
// the pure two-phase engine (sim/engine.js `tick`) to the UI: Run / Pause /
// Step / speed, driving each free-running clock's edges from a `setInterval`
// (the ENGINE stays pure and timerless — it only receives each clock's current
// output level via `clockPhase`). Sequential chip state and clock phases are
// RUN-VOLATILE (never serialized). It re-ticks on every input event (switch,
// button, PSU/clock change) warm-started from the previous stable state,
// publishes `chiphippo:sim-state` for the live views, persists 12 V damage
// through desk-doc, and routes warnings to the notification stack.
//
// Topology is FROZEN while running (the app locks editing tools); switch/clock
// changes are part state, not topology, so the netlist still rebuilds on them.

import { tick } from "../sim/engine.js";
import { H, L } from "../sim/levels.js";
import { partDef } from "../catalog/index.js";
import { isMemory, memoryConfig } from "../sim/chip-eval.js";
import { framebufferOf } from "../sim/hd44780.js";
import { NetlistCache } from "./netlist-cache.js";

/**
 * A fresh run-volatile byte image for a memory chip: a typed array sized to the
 * def's address space (Uint16Array for a >8-bit data bus, else Uint8Array),
 * zero-filled and then seeded from the def's `initial` ROM data if present.
 */
function seedImage(def) {
  const { size, width, initial } = memoryConfig(def);
  const image = width > 8 ? new Uint16Array(size) : new Uint8Array(size);
  if (initial == null) return image;
  const seed = typeof initial === "function" ? initial(size) : initial;
  const n = Math.min(size, seed?.length ?? 0);
  for (let i = 0; i < n; i++) image[i] = seed[i];
  return image;
}

/** Transport modes. */
export const TRANSPORT = Object.freeze({
  STOPPED: "stopped",
  RUNNING: "running",
  PAUSED: "paused",
});

/** Speed multipliers the selector cycles. */
export const SPEEDS = Object.freeze([0.25, 1, 4]);

/** A clock timer never fires faster than this (keeps 10 Hz × 4 sane). */
const MIN_HALF_PERIOD_MS = 20;

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
  #images = new Map(); // memory compId → Uint8Array/Uint16Array (run-volatile)
  #timers = new Map(); // clockId → interval handle
  #suppress = false; // ignore our own damage-persist writes

  /**
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./notification-stack.js').NotificationStack} [opts.notifications]
   * @param {(mode: string) => void} [opts.onTransportChange]
   */
  constructor({ deskDoc, notifications, onTransportChange }) {
    this.#doc = deskDoc;
    this.#netlist = new NetlistCache(deskDoc);
    this.#notifications = notifications;
    this.#onTransportChange = onTransportChange;
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

  // ── Transport ────────────────────────────────────────────────────────────

  /** Enter Run: reset run-volatile state, cold-settle, start the clocks. */
  start() {
    if (this.#mode !== TRANSPORT.STOPPED) return;
    this.#mode = TRANSPORT.RUNNING;
    this.#warm = new Map();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#clockPhase = new Map();
    for (const c of this.#clocks()) this.#clockPhase.set(c.id, L); // idle low
    this.#seedImages();
    this.#onTransportChange?.(this.#mode);
    this.#tickNow();
    this.#scheduleClocks();
  }

  /** Freeze time (stop the clocks) but keep the state + live view. */
  pause() {
    if (this.#mode !== TRANSPORT.RUNNING) return;
    this.#mode = TRANSPORT.PAUSED;
    this.#clearTimers();
    this.#onTransportChange?.(this.#mode);
  }

  /** Resume free-running from the paused state. */
  resume() {
    if (this.#mode !== TRANSPORT.PAUSED) return;
    this.#mode = TRANSPORT.RUNNING;
    this.#onTransportChange?.(this.#mode);
    this.#scheduleClocks();
  }

  /** Return to editing: clear run-volatile state, keep persisted damage. */
  stop() {
    if (this.#mode === TRANSPORT.STOPPED) return;
    this.#clearTimers();
    this.#mode = TRANSPORT.STOPPED;
    this.#warm = new Map();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#clockPhase = new Map();
    this.#images = new Map();
    this.#notifications?.clear();
    this.#onTransportChange?.(this.#mode);
    this.#publish(null, null); // views clear from a not-running sim-state
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

  /** Advance one half-period: toggle every free-running clock once, then tick. */
  step() {
    if (this.#mode === TRANSPORT.STOPPED) return;
    if (this.#mode === TRANSPORT.RUNNING) this.pause(); // stepping implies paused
    for (const c of this.#autoClocks()) this.#flip(c.id);
    this.#tickNow();
  }

  /** Set the speed multiplier (applies to every free-running clock). */
  setSpeed(multiplier) {
    if (!SPEEDS.includes(multiplier)) return;
    this.#speed = multiplier;
    if (this.#mode === TRANSPORT.RUNNING) this.#scheduleClocks();
  }

  /** Manually toggle one clock (a manual clock's click, or programmatic). */
  manualToggle(id) {
    if (this.#mode === TRANSPORT.STOPPED) return;
    this.#flip(id);
    this.#tickNow();
  }

  // ── Clock scheduling (the ONLY timer — the engine stays timerless) ────────

  #clocks() {
    return this.#doc.toJSON().components.filter((c) => c.kind === "clock");
  }

  // ── Memory images (run-volatile; Feature 180 makes them file-backed) ──────

  /** Seed a fresh image per memory chip on Run (ROM data or zeros). */
  #seedImages() {
    this.#images = new Map();
    for (const c of this.#doc.toJSON().components) {
      const def = partDef(c.ref);
      if (isMemory(def)) this.#images.set(c.id, seedImage(def));
    }
  }

  /** Apply the tick's reported writes into the images (read-only ROMs report none). */
  #applyWrites(writes) {
    for (const { compId, addr, value } of writes ?? []) {
      const img = this.#images.get(compId);
      if (img && addr >= 0 && addr < img.length) img[addr] = value;
    }
  }

  #autoClocks() {
    return this.#clocks().filter((c) => partDef("clock").isAuto(c.params));
  }

  #flip(id) {
    this.#clockPhase.set(id, this.#clockPhase.get(id) === H ? L : H);
  }

  #scheduleClocks() {
    this.#clearTimers();
    if (this.#mode !== TRANSPORT.RUNNING) return;
    for (const c of this.#autoClocks()) {
      const halfMs = Math.max(
        MIN_HALF_PERIOD_MS,
        Math.round(1000 / (2 * c.params.hz * this.#speed)),
      );
      const handle = setInterval(() => {
        this.#flip(c.id);
        this.#tickNow();
      }, halfMs);
      this.#timers.set(c.id, handle);
    }
  }

  #clearTimers() {
    for (const handle of this.#timers.values()) clearInterval(handle);
    this.#timers.clear();
  }

  // ── Input events (re-settle without advancing the clock) ─────────────────

  #onPartState = () => {
    if (this.running && !this.#suppress) this.#tickNow();
  };

  #onDocChanged = () => {
    if (!this.running || this.#suppress) return;
    // A clock's rate may have changed via its menu — reschedule, then settle.
    if (this.#mode === TRANSPORT.RUNNING) this.#scheduleClocks();
    this.#tickNow();
  };

  /** Run one engine tick from the current phase + state, and publish. */
  #tickNow() {
    if (this.#mode === TRANSPORT.STOPPED) return;
    this.#suppress = true;
    try {
      const doc = this.#doc.toJSON();
      const netlist = this.#netlist.get();
      const result = tick({
        document: doc,
        netlist,
        warmStart: this.#warm,
        state: this.#state,
        prevPinLevels: this.#prevPins,
        clockPhase: this.#clockPhase,
        images: this.#images,
      });
      this.#warm = result.netLevels;
      this.#state = result.state;
      this.#prevPins = result.pinLevels;
      this.#applyWrites(result.memWrites);
      this.#persistDamage(result.chipStatus);
      this.#publish(result, netlist, this.#displayState(doc, result.state));
      this.#report(result.warnings);
    } finally {
      this.#suppress = false;
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
      if (c.kind !== "lcd") continue;
      displays.set(c.id, framebufferOf(state.get(c.id), c.params));
    }
    return displays;
  }

  /**
   * Persist a 12 V kill into params.damaged (inert until "Replace chip").
   * "reversed" is deliberately NOT persisted — swapped power wires are an
   * editing mistake, so fixing the wiring and re-running clears it.
   */
  #persistDamage(chipStatus) {
    let changed = false;
    for (const [id, { status }] of chipStatus) {
      if (status !== "damaged") continue;
      if (this.#doc.getComponent(id)?.params?.damaged === true) continue;
      this.#doc.setComponentParams(id, { damaged: true });
      changed = true;
    }
    if (changed) window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }

  #publish(result, netlist, displays) {
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
          clockLevels: new Map(this.#clockPhase),
          // Per-LCD framebuffers (compId → { chars, cursor, … }); empty when
          // not running, which blanks every LCD screen.
          displayState: displays ?? new Map(),
        },
      }),
    );
  }

  #refName(id) {
    const comp = this.#doc.getComponent(id);
    return comp ? `${comp.ref} (${id})` : id;
  }

  #report(warnings) {
    if (!this.#notifications) return;
    for (const w of warnings) {
      if (w.type === "short") {
        this.#notifications.notify({
          key: `short:${w.net}`,
          variant: "danger",
          title: "Short circuit",
          message: `Opposing supplies meet on one net (${w.net}).`,
        });
      } else if (w.type === "conflict") {
        this.#notifications.notify({
          key: `conflict:${w.net}`,
          variant: "warning",
          title: "Driver conflict",
          message: `Two outputs are fighting on one net (${w.net}).`,
        });
      } else if (w.type === "oscillation") {
        this.#notifications.notify({
          key: "oscillation",
          variant: "warning",
          title: "Oscillation",
          message: `The circuit won't settle (${w.nets.length} unstable nets).`,
        });
      } else if (w.type === "underpowered") {
        this.#notifications.notify({
          key: `under:${w.chip}`,
          variant: "warning",
          title: "Underpowered",
          message: `${this.#refName(w.chip)} is at 3 V — running inert.`,
        });
      } else if (w.type === "reversed") {
        this.#notifications.notify({
          key: `reversed:${w.chip}`,
          variant: "danger",
          title: "Power reversed",
          message: `${this.#refName(w.chip)} has VCC and GND swapped.`,
        });
      } else if (w.type === "damaged") {
        this.#notifications.notify({
          key: `smoke:${w.chip}`,
          variant: "danger",
          title: "Magic smoke!",
          message: `${this.#refName(w.chip)} was damaged by 12 V. Replace it to continue.`,
        });
      }
    }
  }

  /** Reset a damaged chip (context-menu "Replace chip"). */
  replaceChip(id) {
    this.#doc.setComponentParams(id, { damaged: false });
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  }
}
