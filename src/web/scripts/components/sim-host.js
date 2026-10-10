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

// sim-host.js — WHERE the simulation runs (features/03-sim-worker.md). The
// app talks to one SimHost exactly as it talked to its SimController — the
// same public surface, method for method — and the host runs the run in one
// of two places:
//
//   · THE WORKER (the default): the very same SimController, on its own
//     thread (components/sim-worker.js, sim-worker-host.js), so the engine
//     can use most of a core and the renderer's frame is the views' alone.
//     Its board comes back as the events it dispatched (sim-state, sim-tick,
//     mem-state), re-dispatched here with this thread's netlist of the same
//     version put back; its toasts, damage latches and ROM loads cross back
//     as messages. The transport is answered HERE at once — Run, Pause,
//     Stop lock and unlock the desk on the press — and an input reaches the
//     board a message later: it shows on the next frame.
//   · THE MAIN THREAD (a local SimController): whenever the run needs what
//     only this thread has, at a cost Jason accepted (2026-10-09) —
//       an Arduino integration on the desk (its settle boundary sees every
//         tick, and may stall the board on the serial link);
//       a custom chip armed for debugging (the debugger watches every pass
//         and holds the board while it is read) — armed mid-run, the run is
//         handed over from the Worker (`exportRun`/`importRun`) and stays
//         here until Stop;
//       no Worker (Node, the tests' jsdom), or `localStorage
//         ["chiphippo.simWorker"] === "off"` (debugging).
//
// Stop is answered here entirely — the toasts dismissed, the damage latches
// cleared from the document, the views told — before anything else may run:
// a project switch stops the sim and loads another document straight after,
// and nothing the old run had in flight may land in it (every message names
// its run, and a stopped run's are dropped).

import { SimController, SPEEDS, TRANSPORT } from "./sim-controller.js";
import { engineFor } from "../sim/engines.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";
import { currentCatalog, t } from "../i18n.js";
import { customChipDefs } from "../catalog/index.js";

export { SPEEDS, TRANSPORT };

/** The bare board a stopped run publishes (SimController `#publish(null)`). */
function stoppedDetail() {
  return {
    running: false,
    mode: TRANSPORT.STOPPED,
    netLevels: new Map(),
    strongLevels: new Map(),
    chipStatus: new Map(),
    warnings: [],
    netlist: null,
    clockLevels: new Map(),
    pausedClocks: new Set(),
    signalLevels: new Map(),
    displayState: new Map(),
    timing: new Map(),
    channels: new Map(),
    nodeVolts: new Map(),
    supplies: new Map(),
    bench: new Map(),
    lamps: null,
    currents: new Map(),
    fastestHz: 0,
    replay: false,
    behind: null,
  };
}

/** The Worker, unless something says not to have one. */
export function defaultWorkerFactory() {
  if (typeof Worker === "undefined") return null;
  try {
    if (globalThis.localStorage?.getItem("chiphippo.simWorker") === "off") return null; // prettier-ignore
  } catch {
    /* no storage: the default */
  }
  return () =>
    new Worker(new URL("./sim-worker.js", import.meta.url), { type: "module" }); // prettier-ignore
}

export class SimHost {
  #doc;
  #netlist;
  #notifications;
  #onTransportChange;
  #integration;
  #debug;
  #local; // the main thread's SimController
  #makeWorker; // () => Worker, or null
  #worker = null;
  #inWorker = false; // the run under way is the Worker's
  #exporting = false; // a hand-over to the main thread is under way
  #held = []; // calls made while it is (replayed on the main thread)
  #run = 0;
  #nv = 0; // the netlist version last sent
  #netlists = new Map(); // version → this thread's netlist of it
  #mode = TRANSPORT.STOPPED;
  #speed = 1;
  #spice = normalizeSpiceConfig(null);
  #engineId = "digital";
  #pausedClocks = new Set();
  #snapshots = new Map(); // custom chip → {ins, state}, as last shown
  #images = new Map(); // memory chip → its live bytes
  #toastKeys = new Set();
  #suppress = false; // our own write to the document

  /**
   * As SimController's constructor, plus `worker`: a factory for the
   * simulation Worker, or null for the main thread always (the default
   * `defaultWorkerFactory()`).
   */
  constructor({
    deskDoc,
    netlist,
    notifications,
    onTransportChange,
    integration,
    debug,
    clock,
    worker = defaultWorkerFactory(),
  }) {
    this.#doc = deskDoc;
    this.#netlist = netlist;
    this.#notifications = notifications;
    this.#onTransportChange = onTransportChange;
    this.#integration = integration ?? null;
    this.#debug = debug ?? null;
    this.#makeWorker = worker;
    this.#local = new SimController({ deskDoc, netlist, notifications, onTransportChange, integration, debug, clock }); // prettier-ignore
    window.addEventListener("chiphippo:doc-changed", () => {
      if (!this.#live() || this.#suppress) return;
      this.#post({ type: "doc", nv: this.#version(), doc: this.#doc.toJSON() }); // prettier-ignore
    });
    window.addEventListener("chiphippo:part-state", (e) => {
      if (!this.#live()) return;
      this.#post({ type: "part-state", nv: this.#version(), detail: e.detail }); // prettier-ignore
    });
  }

  // ── The SimController surface ────────────────────────────────────────────

  get mode() {
    return this.#inWorker ? this.#mode : this.#local.mode;
  }

  get running() {
    return this.mode !== TRANSPORT.STOPPED;
  }

  get speed() {
    return this.#inWorker ? this.#speed : this.#local.speed;
  }

  get engineId() {
    return this.#inWorker ? this.#engineId : this.#local.engineId;
  }

  /** Whether the run under way is on the simulation Worker's thread. */
  get inWorker() {
    return this.#inWorker;
  }

  get stalled() {
    return this.#inWorker ? false : this.#local.stalled;
  }

  setSpiceLite(config) {
    this.#spice = normalizeSpiceConfig(config);
    this.#local.setSpiceLite(config);
  }

  start() {
    if (this.running) return;
    const doc = this.#doc.toJSON();
    if (!this.#workerFor(doc)) return this.#local.start();
    this.#inWorker = true;
    this.#run += 1;
    this.#mode = TRANSPORT.RUNNING;
    this.#engineId = engineFor(this.#spice).id;
    this.#pausedClocks = new Set();
    this.#snapshots = new Map();
    this.#images = new Map();
    this.#netlists = new Map();
    try {
      this.#debug?.begin?.();
    } catch (err) {
      console.error("[renderer] chip debugger begin failed:", err);
    }
    this.#onTransportChange?.(this.#mode);
    this.#post({
      type: "start",
      nv: this.#version(),
      doc,
      partStates: this.#netlist.partStates?.() ?? [],
      spice: this.#spice,
      speed: this.#speed,
      catalog: currentCatalog(),
      customChips: customChipDefs().map((d) => d.customChip),
    });
  }

  stop() {
    if (!this.#inWorker) return this.#local.stop();
    // What the run still has in flight is dropped from here on.
    this.#run += 1;
    this.#post({ type: "call", method: "stop" }, true);
    this.#inWorker = false;
    this.#exporting = false;
    this.#held = [];
    this.#mode = TRANSPORT.STOPPED;
    const finalImages = this.#images;
    this.#images = new Map();
    this.#snapshots = new Map();
    this.#pausedClocks = new Set();
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
    for (const key of this.#toastKeys) this.#notifications?.dismiss?.(key);
    this.#toastKeys.clear();
    // The latches go BEFORE the transport change (SimController `stop` says
    // why: undo/redo re-baselines on it).
    this.#clearAllDamage();
    this.#onTransportChange?.(this.#mode);
    window.dispatchEvent(new CustomEvent("chiphippo:sim-state", { detail: stoppedDetail() })); // prettier-ignore
    window.dispatchEvent(
      new CustomEvent("chiphippo:mem-state", {
        detail: { running: false, images: finalImages },
      }),
    );
  }

  toggle() {
    if (this.mode === TRANSPORT.STOPPED) this.start();
    else this.stop();
  }

  togglePause() {
    if (this.mode === TRANSPORT.RUNNING) this.pause();
    else if (this.mode === TRANSPORT.PAUSED) this.resume();
  }

  pause() {
    if (!this.#inWorker) return this.#local.pause();
    if (this.#mode !== TRANSPORT.RUNNING) return;
    this.#mode = TRANSPORT.PAUSED;
    this.#call("pause");
    this.#onTransportChange?.(this.#mode);
  }

  resume() {
    if (!this.#inWorker) return this.#local.resume();
    if (this.#mode !== TRANSPORT.PAUSED) return;
    this.#mode = TRANSPORT.RUNNING;
    this.#onTransportChange?.(this.#mode);
    this.#call("resume");
  }

  step() {
    if (!this.#inWorker) return this.#local.step();
    if (this.#mode === TRANSPORT.STOPPED) return;
    if (this.#mode === TRANSPORT.RUNNING) {
      this.#mode = TRANSPORT.PAUSED;
      this.#onTransportChange?.(this.#mode);
    }
    this.#call("step");
  }

  setSpeed(multiplier) {
    if (!SPEEDS.includes(multiplier)) return;
    this.#speed = multiplier;
    this.#local.setSpeed(multiplier);
    if (this.#inWorker) this.#call("setSpeed", multiplier);
  }

  toggleClockPause(id) {
    if (!this.#inWorker) return this.#local.toggleClockPause(id);
    if (this.#mode === TRANSPORT.STOPPED) return;
    // As the Worker will (its next board says so for certain).
    if (!this.#pausedClocks.delete(id)) this.#pausedClocks.add(id);
    this.#call("toggleClockPause", id);
  }

  isClockPaused(id) {
    return this.#inWorker ? this.#pausedClocks.has(id) : this.#local.isClockPaused(id); // prettier-ignore
  }

  manualToggle(id) {
    if (!this.#inWorker) return this.#local.manualToggle(id);
    this.#call("manualToggle", id);
  }

  pressSignal(id, on) {
    if (!this.#inWorker) return this.#local.pressSignal(id, on);
    this.#call("pressSignal", id, on);
  }

  wake() {
    if (!this.#inWorker) return this.#local.wake();
    this.#call("wake");
  }

  /** As SimController's — on the Worker, as the last board left the chip. */
  chipSnapshot(compId) {
    if (!this.#inWorker) return this.#local.chipSnapshot(compId);
    if (this.#mode === TRANSPORT.STOPPED) return null;
    return this.#snapshots.get(compId) ?? null;
  }

  /** As SimController's — on the Worker, the bytes as last told. */
  imageBytesOf(compId) {
    if (!this.#inWorker) return this.#local.imageBytesOf(compId);
    return this.#images.get(compId)?.slice() ?? null;
  }

  // ── The Worker ───────────────────────────────────────────────────────────

  /** Whether `doc`'s run goes to the Worker (see the file header). */
  #workerFor(doc) {
    if (!this.#makeWorker) return false;
    if ((doc.integrations ?? []).length > 0) return false;
    try {
      if (this.#debug?.observer?.()) return false;
    } catch {
      return false;
    }
    if (!this.#worker) {
      try {
        this.#worker = this.#makeWorker();
      } catch (err) {
        console.error("[renderer] simulation worker failed to start:", err);
        this.#makeWorker = null;
        return false;
      }
      const worker = this.#worker;
      worker.addEventListener("message", (e) => this.#receive(e.data));
      // A Worker whose module failed to load, or that threw, says so ONLY
      // here — it answers nothing ever again, and a run left with it would
      // show "running" over a frozen board, every Run after it the same.
      worker.addEventListener("error", (e) => this.#workerFailed(worker, e));
      worker.addEventListener("messageerror", (e) => this.#workerFailed(worker, e)); // prettier-ignore
    }
    return true;
  }

  /** The Worker broke: never use it again, and carry the run on here. */
  #workerFailed(worker, e) {
    console.error("[renderer] simulation worker failed:", e?.message ?? e);
    if (worker !== this.#worker) return; // already given up on
    this.#worker = null;
    this.#makeWorker = null;
    try {
      worker.terminate?.();
    } catch {
      /* gone already */
    }
    if (!this.#inWorker) return;
    // What it held of the run is lost; the run starts afresh on this thread,
    // left paused if the user had paused it — and the user is told, since
    // every counter just went back to its power-on state.
    const paused = this.#mode === TRANSPORT.PAUSED;
    this.#run += 1;
    this.#inWorker = false;
    this.#exporting = false;
    this.#held = [];
    this.#mode = TRANSPORT.STOPPED;
    this.#local.start();
    if (paused) this.#local.pause();
    this.#notifications?.notify?.({
      key: "sim-worker-failed",
      variant: "warning",
      title: t("sim.workerFailedTitle"),
      message: t("sim.workerFailed"),
    });
  }

  #live() {
    return this.#inWorker && this.#mode !== TRANSPORT.STOPPED;
  }

  /** The next netlist version: an edit the Worker will build anew. */
  #version() {
    this.#nv += 1;
    return this.#nv;
  }

  /** This thread's netlist for a version the Worker's board was built on —
      the cache's while it is the latest; else as it was last handed out. */
  #netlistAt(nv) {
    if (nv === this.#nv) {
      const netlist = this.#netlist.get(this.#engineId === "spice" ? { inductors: "branch" } : undefined); // prettier-ignore
      this.#netlists.set(nv, netlist);
      for (const v of this.#netlists.keys()) if (v < nv - 4) this.#netlists.delete(v); // prettier-ignore
      return netlist;
    }
    return this.#netlists.get(nv) ?? this.#netlist.get(this.#engineId === "spice" ? { inductors: "branch" } : undefined); // prettier-ignore
  }

  #post(message, always = false) {
    if (!this.#worker || (!always && !this.#inWorker)) return;
    this.#worker.postMessage({ ...message, run: this.#run });
  }

  #call(method, ...args) {
    if (this.#exporting) {
      this.#held.push(() => this.#local[method](...args));
      return;
    }
    this.#post({ type: "call", method, args });
  }

  #receive(message) {
    if (message?.run !== this.#run || !this.#inWorker) return;
    switch (message.type) {
      case "events":
        this.#snapshots = message.snapshots ?? this.#snapshots;
        for (const { type, detail } of message.events) {
          if (type === "chiphippo:mem-state") this.#applyMem(detail);
          if (type === "chiphippo:sim-state") {
            this.#pausedClocks = new Set(detail.pausedClocks ?? []);
          }
          const shown = "netlist" in detail ? { ...detail, netlist: this.#netlistAt(message.nv) } : detail; // prettier-ignore
          window.dispatchEvent(new CustomEvent(type, { detail: shown }));
          if (!this.#inWorker) return; // a listener stopped the run
        }
        this.#maybeHandOver();
        break;
      case "notify":
        if (message.opts?.key) this.#toastKeys.add(message.opts.key);
        this.#notifications?.notify(message.opts);
        break;
      case "dismiss":
        this.#notifications?.dismiss?.(message.key);
        break;
      case "params":
        // A latch the run wrote (damage, a ROM's minted file id): into the
        // real document, and told as SimController tells it.
        this.#suppress = true;
        try {
          this.#doc.setComponentParams(message.id, message.patch);
          window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
        } finally {
          this.#suppress = false;
        }
        break;
      case "images":
        for (const [id, bytes] of message.images) this.#images.set(id, bytes);
        break;
      case "mem":
        this.#memRequest(message);
        break;
      case "exported":
        this.#takeOver(message.state);
        break;
    }
  }

  /** A memory inspector's byte changes, into the bytes it is shown. */
  #applyMem(detail) {
    for (const [id, list] of detail?.changes ?? []) {
      const bytes = this.#images.get(id);
      if (!bytes) continue;
      for (const [addr, value] of list) {
        if (addr >= 0 && addr < bytes.length) bytes[addr] = value;
      }
    }
  }

  /** The Worker's ROM loads, over this thread's bridge. */
  async #memRequest({ id, op, args }) {
    const run = this.#run;
    try {
      const value = await window.chiphippo?.mem?.[op]?.(...args);
      if (run === this.#run) this.#post({ type: "mem-reply", id, ok: true, value }); // prettier-ignore
    } catch (err) {
      if (run === this.#run) this.#post({ type: "mem-reply", id, ok: false, error: err.message }); // prettier-ignore
    }
  }

  /** A custom chip armed for debugging mid-run: the run comes here. */
  #maybeHandOver() {
    if (this.#exporting || this.#mode === TRANSPORT.STOPPED) return;
    let armed = false;
    try {
      armed = Boolean(this.#debug?.observer?.());
    } catch {
      armed = false;
    }
    if (!armed) return;
    this.#exporting = true;
    this.#post({ type: "export" });
  }

  #takeOver(state) {
    this.#exporting = false;
    this.#inWorker = false;
    if (!state) {
      // Nothing to carry on (the Worker's run had stalled or stopped):
      // start afresh here.
      this.#mode = TRANSPORT.STOPPED;
      this.#local.start();
    } else {
      this.#local.importRun(state);
    }
    for (const apply of this.#held.splice(0)) apply();
  }

  /** SimController `#clearAllDamage`, on the real document. */
  #clearAllDamage() {
    let changed = false;
    this.#suppress = true;
    try {
      for (const c of this.#doc.toJSON().components) {
        if (c.params?.damaged !== true && c.params?.overloaded !== true) continue; // prettier-ignore
        this.#doc.setComponentParams(c.id, { damaged: false, overloaded: false }); // prettier-ignore
        changed = true;
      }
      if (changed) window.dispatchEvent(new CustomEvent("chiphippo:doc-changed")); // prettier-ignore
    } finally {
      this.#suppress = false;
    }
  }
}
