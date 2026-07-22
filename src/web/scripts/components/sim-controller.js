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

/** A blank byte image for a def: Uint16Array for a >8-bit data bus, else Uint8Array. */
function blankImage(def) {
  const { size, width } = memoryConfig(def);
  return width > 8 ? new Uint16Array(size) : new Uint8Array(size);
}

/**
 * A fresh run-volatile byte image for a memory chip (Feature 170's unbound
 * fallback): zero-filled and then seeded from the def's `initial` ROM data if
 * present. A file-bound chip (Feature 180) loads from disk instead.
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

/** Split one word write into its constituent byte writes (little-endian). */
function wordToBytes(width, addr, value) {
  if (width > 8) {
    return [
      { addr: 2 * addr, value: value & 0xff },
      { addr: 2 * addr + 1, value: (value >> 8) & 0xff },
    ];
  }
  return [{ addr, value: value & 0xff }];
}

/** A memory component's validated `{ path, mode }` binding, or null (unbound). */
function memStorage(comp) {
  const s = comp?.params?.storage;
  if (!s || typeof s.path !== "string" || !s.path) return null;
  return { path: s.path, mode: s.mode === "ram" ? "ram" : "rom" };
}

/** Debounce window for flushing accumulated RAM writes back to disk. */
const FLUSH_DEBOUNCE_MS = 250;

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
  #binding = new Map(); // memory compId → { path, mode, width, byteLength } (bound only)
  #memWidth = new Map(); // memory compId → data-bus width (all memory chips)
  #loadFailed = new Set(); // bound chips whose file load failed (never flushed)
  #romWarned = new Set(); // bound-rom chips already warned about a dropped write
  #pendingFlush = new Map(); // compId → queued byte writes awaiting a flush
  #flushTimer = null; // debounced flush handle (the ONLY disk-write timer)
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

  /**
   * Enter Run: reset run-volatile state, seed memory images (loading any
   * file-bound chip from disk first — Feature 180), cold-settle, start the
   * clocks. Seeding is async ONLY when a chip is file-bound; with none, Run
   * proceeds synchronously exactly as before. Returns a promise that resolves
   * once the first tick has run (tests await it; the UI ignores it).
   */
  start() {
    if (this.#mode !== TRANSPORT.STOPPED) return;
    this.#mode = TRANSPORT.RUNNING;
    this.#warm = new Map();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#clockPhase = new Map();
    for (const c of this.#clocks()) this.#clockPhase.set(c.id, L); // idle low
    this.#romWarned = new Set();
    this.#pendingFlush = new Map();
    this.#onTransportChange?.(this.#mode); // lock editing while files load
    const pending = this.#seedImages();
    if (pending) return pending.then(() => this.#afterSeed());
    this.#afterSeed();
  }

  /** First settle + clock start once memory images are seeded/loaded. */
  #afterSeed() {
    if (this.#mode !== TRANSPORT.RUNNING) return; // stopped during a load
    this.#tickNow();
    this.#scheduleClocks();
  }

  /** Freeze time (stop the clocks) but keep the state + live view. */
  pause() {
    if (this.#mode !== TRANSPORT.RUNNING) return;
    this.#mode = TRANSPORT.PAUSED;
    this.#clearTimers();
    this.#flushNow(); // a Pause commits any pending RAM writes to disk
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
    this.#flushNow(); // final flush of any pending RAM writes before we drop the image
    // Snapshot each memory's final bytes (while the images still exist) so an
    // open inspector shows the exact end-of-run contents with no file re-read.
    const finalImages = new Map();
    for (const compId of this.#images.keys()) {
      finalImages.set(compId, this.imageBytesOf(compId));
    }
    this.#mode = TRANSPORT.STOPPED;
    this.#warm = new Map();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#clockPhase = new Map();
    this.#images = new Map();
    this.#binding = new Map();
    this.#memWidth = new Map();
    this.#loadFailed = new Set();
    this.#notifications?.clear();
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

  // ── Memory images (Feature 170 volatile; Feature 180 file-backed) ─────────

  /**
   * Seed a fresh image per memory chip on Run. An UNBOUND chip gets Feature
   * 170's volatile seed (ROM `initial` data or zeros). A FILE-BOUND chip
   * (Feature 180) starts zeroed and then loads its `.bin` from disk over the
   * `mem:load` IPC. Returns a promise that resolves once every bound load has
   * settled, or null when nothing is bound (Run then stays fully synchronous).
   */
  #seedImages() {
    this.#images = new Map();
    this.#binding = new Map();
    this.#memWidth = new Map();
    this.#loadFailed = new Set();
    const loads = [];
    for (const c of this.#doc.toJSON().components) {
      const def = partDef(c.ref);
      if (!isMemory(def)) continue;
      this.#memWidth.set(c.id, memoryConfig(def).width);
      const storage = memStorage(c);
      if (storage) {
        this.#binding.set(c.id, {
          ...storage,
          width: memoryConfig(def).width,
          byteLength: byteLengthOf(def),
        });
        this.#images.set(c.id, blankImage(def)); // reads 0 until the load lands
        loads.push(this.#loadBinding(c.id, def, storage));
      } else {
        this.#images.set(c.id, seedImage(def));
      }
    }
    return loads.length ? Promise.all(loads) : null;
  }

  /** Load one file-bound chip's image from disk; a failure warns and zeros. */
  async #loadBinding(compId, def, storage) {
    try {
      const res = await window.chiphippo?.mem?.load(
        storage.path,
        byteLengthOf(def),
      );
      if (this.#mode === TRANSPORT.STOPPED) return; // run aborted mid-load
      if (!res || res.ok === false) {
        throw new Error(res?.error ?? "no memory bridge");
      }
      this.#images.set(compId, unpackImage(def, res.bytes));
    } catch (err) {
      // Blocks this chip's data (reads zeros) with a loud message rather than
      // silently zeroing; it is also excluded from flushes so a file we could
      // not read is never overwritten.
      this.#loadFailed.add(compId);
      this.#notifications?.notify({
        key: `mem-load:${compId}`,
        variant: "danger",
        sticky: true,
        title: "Memory not loaded",
        message: `${this.#refName(compId)}: ${err.message}. Running with zeros.`,
      });
    }
  }

  /**
   * Apply the tick's reported (word) writes to the in-RAM images and return the
   * per-component BYTE-level changes. A ROM-mode binding DROPS the write (a
   * one-time warning); a RAM-mode binding applies it and the change is queued
   * for a debounced disk flush; an unbound chip applies it (volatile). The
   * returned map drives both the flush queue and the live inspector broadcast.
   * @returns {Map<string, Array<[number, number]>>} compId → [[byteAddr, byteVal]]
   */
  #applyWrites(writes) {
    const changes = new Map();
    for (const { compId, addr, value } of writes ?? []) {
      const img = this.#images.get(compId);
      if (!img || addr < 0 || addr >= img.length) continue;
      const bind = this.#binding.get(compId);
      if (bind?.mode === "rom") {
        this.#warnRomWrite(compId); // read-only file — write dropped
        continue;
      }
      img[addr] = value;
      const width = this.#memWidth.get(compId) ?? 8;
      let arr = changes.get(compId);
      if (!arr) changes.set(compId, (arr = []));
      for (const bw of wordToBytes(width, addr, value))
        arr.push([bw.addr, bw.value]);
    }
    return changes;
  }

  /** Queue byte writes for a RAM-bound chip and (re)arm the debounced flush. */
  #queueFlush(compId, byteChanges) {
    if (byteChanges.length === 0) return;
    let arr = this.#pendingFlush.get(compId);
    if (!arr) this.#pendingFlush.set(compId, (arr = []));
    for (const [addr, value] of byteChanges) arr.push({ addr, value });
    if (this.#flushTimer == null) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null;
        this.#drainFlush();
      }, FLUSH_DEBOUNCE_MS);
    }
  }

  /** Flush every component's accumulated byte writes to disk (atomic in main). */
  #drainFlush() {
    for (const [compId, writes] of this.#pendingFlush) {
      const bind = this.#binding.get(compId);
      if (!bind || writes.length === 0) continue;
      window.chiphippo?.mem
        ?.flush(bind.path, writes, bind.byteLength)
        .then((res) => {
          if (res && res.ok === false) {
            this.#notifications?.notify({
              key: `mem-flush:${compId}`,
              variant: "danger",
              title: "Memory not saved",
              message: `${this.#refName(compId)}: ${res.error}`,
            });
          }
        })
        .catch(() => {});
    }
    this.#pendingFlush = new Map();
  }

  /** Cancel the debounce and flush immediately (Pause / Stop). */
  #flushNow() {
    if (this.#flushTimer != null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#drainFlush();
  }

  /** Warn once that a write to a read-only (ROM-mode) binding was ignored. */
  #warnRomWrite(compId) {
    if (this.#romWarned.has(compId)) return;
    this.#romWarned.add(compId);
    this.#notifications?.notify({
      key: `rom-write:${compId}`,
      variant: "warning",
      title: "Read-only memory",
      message: `${this.#refName(compId)} is bound read-only (ROM); writes are ignored.`,
    });
  }

  /** Broadcast this tick's byte changes to any open inspector windows. */
  #broadcastMemChanges(changes) {
    if (changes.size === 0) return;
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
    return packImage(this.#memWidth.get(compId) ?? 8, img);
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
      const changes = this.#applyWrites(result.memWrites);
      for (const [compId, byteChanges] of changes) {
        const bind = this.#binding.get(compId);
        if (bind?.mode === "ram" && !this.#loadFailed.has(compId)) {
          this.#queueFlush(compId, byteChanges);
        }
      }
      this.#broadcastMemChanges(changes);
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
