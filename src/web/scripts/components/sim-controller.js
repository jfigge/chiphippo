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
import {
  isMemory,
  isVolatileMemory,
  isOscillator,
  memoryConfig,
} from "../sim/chip-eval.js";
import { framebufferOf } from "../sim/hd44780.js";
import { NetlistCache } from "./netlist-cache.js";

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
  #memInfo = new Map(); // memory compId → { volatile, guid, width, byteLength }
  #dataLossWarned = new Set(); // programmed chips already warned of a missing file
  #timers = new Map(); // clockId → interval handle
  #suppress = false; // ignore our own damage-persist writes

  /**
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   * @param {import('./notification-stack.js').NotificationStack} [opts.notifications]
   * @param {(mode: string) => void} [opts.onTransportChange]
   */
  constructor({ deskDoc, notifications, onTransportChange, netlist }) {
    this.#doc = deskDoc;
    this.#netlist = netlist ?? new NetlistCache(deskDoc);
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
   * non-volatile ROM chip from its file first — Feature 190), cold-settle,
   * start the clocks. Seeding is async ONLY when a ROM chip is present; with
   * none (or only volatile SRAM), Run proceeds synchronously. Returns a promise
   * that resolves once the first tick has run (tests await it; the UI ignores it).
   */
  start() {
    if (this.#mode !== TRANSPORT.STOPPED) return;
    this.#mode = TRANSPORT.RUNNING;
    this.#warm = new Map();
    this.#state = new Map();
    this.#prevPins = new Map();
    this.#clockPhase = new Map();
    for (const c of this.#clocks()) this.#clockPhase.set(c.id, L); // idle low
    this.#dataLossWarned = new Set();
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
    this.#memInfo = new Map();
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

  /** Free-running edge sources: clock bricks (`kind:"clock"`) and board-seated
      oscillator cans — anything the engine reads via clockPhase. */
  #clocks() {
    return this.#doc
      .toJSON()
      .components.filter(
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
  #seedImages() {
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
        loads.push(this.#loadRom(c.id, c, def, info));
      }
    }
    return loads.length ? Promise.all(loads) : null;
  }

  /** Load a ROM chip's image from its backing file (creating the file first). */
  async #loadRom(compId, comp, def, info) {
    const mem = window.chiphippo?.mem;
    try {
      // A ROM should have a GUID from placement; mint one defensively if not.
      if (!info.guid) {
        info.guid = crypto.randomUUID();
        this.#doc.setComponentParams(compId, { storage: { guid: info.guid } });
      }
      const created = await mem?.create(info.guid, info.byteLength);
      if (this.#mode === TRANSPORT.STOPPED) return; // run aborted mid-load
      // A programmed chip whose file had to be recreated lost its data (the
      // classic delete-then-undo). It now holds random noise — say so loudly.
      if (created?.created && comp.params?.programmed === true) {
        this.#warnDataLoss(compId);
      }
      const res = await mem?.load(info.guid, info.byteLength);
      if (this.#mode === TRANSPORT.STOPPED) return;
      if (!res || res.ok === false) {
        throw new Error(res?.error ?? "no memory bridge");
      }
      this.#images.set(compId, unpackImage(def, res.bytes));
    } catch (err) {
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
    this.#notifications?.notify({
      key: `mem-lost:${compId}`,
      variant: "danger",
      sticky: true,
      title: "Memory data lost",
      message: `${this.#refName(compId)} was programmed, but its data file was missing — it now holds random noise. Re-load an image.`,
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
    return packImage(this.#memInfo.get(compId)?.width ?? 8, img);
  }

  #autoClocks() {
    // A clock brick may be in manual mode; an oscillator can never is — a
    // real crystal has no click-to-toggle pin.
    return this.#clocks().filter((c) =>
      c.kind === "clock" ? partDef("clock").isAuto(c.params) : true,
    );
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
      // Volatile (SRAM) writes land in the run image + drive the live inspector;
      // ROM writes are dropped (read-only). No file is ever written while running.
      this.#broadcastMemChanges(this.#applyWrites(result.memWrites));
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
