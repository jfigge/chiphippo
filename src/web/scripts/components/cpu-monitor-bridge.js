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

// cpu-monitor-bridge.js — the MAIN renderer's side of the CPU monitor window.
// The window is its own OS window and sandboxed renderer, so it reaches this
// one only through main's `cpumonitor:*` relay; this bridge answers it.
//
// It owns WHICH CPU the window shows (one at a time, from the CPUs on the
// desktop on screen — the window's tabs) and tells the simulation to build that one's summary
// (SimHost `monitorCpu`) — only while the window is open, so a closed monitor
// costs the run nothing beyond the per-tick record. Each `chiphippo:sim-state`
// carries the summary (sim/cpu-monitor.js); the bridge forwards it as ONE
// `state` message, no oftener than `SEND_MS` (the run publishes up to 25 a
// second, and a table of hex a person reads needs fewer), with a trailing
// send so the last board is always the one shown. Stopped, the last summary
// stays, marked as no longer running.
//
// It also owns the CPU BREAKPOINTS (compId → addresses) of the desktop on
// screen. They are kept IN THE PROJECT, per desktop (`store` — the
// workspace's `cpuBreakpoints`/`setCpuBreakpoints`): every change is handed
// over, so a save writes them and the project brings them back when it is
// opened again; a desktop that loads (a switch, New, Open) brings its own,
// since `c3` there is another chip. The simulation is told every
// change (SimHost `setCpuBreakpoints`), so a breakpoint fires with the window
// closed too — and a hit that PAUSES the run raises the window on that CPU,
// as a breakpoint brings the chip designer up.
//
// The box is only offered once there is something for it to decide: the
// `state` message's `romEdited` says a ROM has been edited during this run,
// and the window shows the box from then until Stop.
//
// The window says back `ready`, `select` (its tabs), `breakpoint` (one
// address on or off), `continue` (its Continue button or F8 while the run is
// paused: the run's own Resume), `step` (its Step button or F6 while paused:
// on to the CPU's next operation, SimHost `stepCpu`), `poke` (a byte typed
// into its memory block while the circuit runs — written to the run image,
// SimHost `pokeCpuMemory`) and `keep-edits` (its checkbox).
//
// KEEPING EDITS. A poke lands in the RUN image, so on its own an edit to a
// ROM is gone at Stop (a run never writes a chip's file). With the window's
// "keep edits" box ticked (`settings.cpuMonitorKeepEdits`), the ROMs edited
// during the run are SAVED at Stop, from the final images Stop hands out —
// through the memory inspector's own Save (`saveRom`, MemoryBridge
// `keepRunEdits`). Which ROMs were edited is read off `chiphippo:mem-state`:
// a run reports a byte change for a ROM only when one was poked, since the
// circuit's own writes to a ROM are dropped. An SRAM has no file and forgets
// everything at Stop, ticked or not.

import { chipMarking, partDef } from "../catalog/index.js";
import { isCpu, isRomChip } from "../sim/chip-eval.js";
import { t } from "../i18n.js";

/** The fewest milliseconds between two `state` messages to the window. */
export const SEND_MS = 100;

const DEFAULT_TIMERS = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h),
};

export class CpuMonitorBridge {
  #bridge;
  #deskDoc;
  #sim;
  #timers;
  #ready = false; // the window has announced itself since it last closed
  #compId = null; // the CPU shown
  #summary = null; // its last summary (kept through Stop)
  #running = false;
  #mode = "stopped";
  #lastSend = -Infinity;
  #timer = null;
  #breaks = new Map(); // compId → Set<number>
  #store; // where they are kept: {load(), save(map)} — the project
  #keepEdits; // keep ROM edits at Stop (the window's checkbox)
  #onKeepEdits;
  #saveRom;
  #notifications;
  #editedRoms = new Set(); // ROMs poked during this run
  #queued = false;

  /**
   * @param {object} opts
   * @param {object} opts.bridge - window.chiphippo (`cpuMonitor.*`)
   * @param {{components: object[], getComponent: Function}} opts.deskDoc -
   *   the desktop on screen
   * @param {{monitorCpu: (id: string|null) => void}} opts.sim - the SimHost
   * @param {object} [opts.timers] - `{now, set, clear}` (tests)
   * @param {boolean} [opts.keepEdits] - the checkbox's saved setting
   * @param {(on: boolean) => void} [opts.onKeepEdits] - persist it
   * @param {(compId: string, bytes: Uint8Array) => Promise<boolean>} [opts.saveRom]
   *   - keep a ROM's final bytes (MemoryBridge `keepRunEdits`)
   * @param {import('./notification-stack.js').NotificationStack} [opts.notifications]
   * @param {{load: () => Record<string, number[]>,
   *   save: (map: Record<string, number[]>) => void}} [opts.store] - the
   *   breakpoints' home: the open project's active desktop
   */
  constructor({
    bridge,
    deskDoc,
    sim,
    timers = DEFAULT_TIMERS,
    keepEdits = false,
    onKeepEdits,
    saveRom,
    notifications,
    store,
  }) {
    this.#bridge = bridge;
    this.#deskDoc = deskDoc;
    this.#sim = sim;
    this.#timers = timers;
    this.#keepEdits = keepEdits === true;
    this.#onKeepEdits = onKeepEdits;
    this.#saveRom = saveRom;
    this.#notifications = notifications;
    this.#store = store;
    window.addEventListener("chiphippo:mem-state", (e) =>
      this.#onMemState(e.detail),
    );
    window.addEventListener("chiphippo:cpumonitor-host-inbound", (e) =>
      this.#receive(e.detail),
    );
    window.addEventListener("chiphippo:sim-state", (e) =>
      this.#onSimState(e.detail),
    );
    const onDesk = () => this.#onDeskChanged();
    window.addEventListener("chiphippo:doc-changed", onDesk);
    window.addEventListener("chiphippo:desk-loaded", () => {
      this.#loadBreakpoints();
      onDesk();
    });
    window.addEventListener("chiphippo:cpu-break", (e) =>
      this.#onBreak(e.detail),
    );
    // A window already open (this renderer reloaded under it) announced
    // itself to the renderer that went away: ask again. With no window, main
    // drops the message.
    Promise.resolve(bridge?.cpuMonitor?.toWindow?.({ kind: "hello" })).catch(
      () => {},
    );
    // The desktop already on the desk when this was built.
    this.#loadBreakpoints();
  }

  /** The CPU shown, or null. */
  get compId() {
    return this.#compId;
  }

  /**
   * A CPU's "Open CPU Monitor": show it, and open (or raise) the window.
   * @param {string} compId
   */
  open(compId) {
    if (this.#isCpu(compId)) this.#select(compId);
    Promise.resolve(this.#bridge?.cpuMonitor?.open?.()).catch((err) =>
      console.error("[renderer] cpumonitor:open failed:", err),
    );
  }

  /**
   * A part selected on the desk: if it is a CPU and the window is open, the
   * window follows it. Never opens or raises the window.
   * @param {string} compId
   */
  focusComponent(compId) {
    if (!this.#ready || !this.#isCpu(compId)) return;
    this.#select(compId);
  }

  // ── The window's messages ──────────────────────────────────────────────────

  #receive(msg) {
    switch (msg?.kind) {
      case "ready":
        this.#ready = true;
        if (!this.#isCpu(this.#compId)) this.#compId = this.#cpus()[0]?.id ?? null; // prettier-ignore
        this.#sim?.monitorCpu?.(this.#compId);
        this.#sendNow();
        break;
      case "closed":
        this.#ready = false;
        this.#sim?.monitorCpu?.(null);
        break;
      case "select":
        if (this.#isCpu(msg.compId)) this.#select(msg.compId);
        break;
      case "breakpoint":
        this.#setBreakpoint(msg.compId, msg.addr, msg.on);
        break;
      case "keep-edits":
        this.#keepEdits = msg.on === true;
        this.#onKeepEdits?.(this.#keepEdits);
        this.#sendNow();
        break;
      case "continue":
        if (this.#mode === "paused") this.#sim?.resume?.();
        break;
      case "step":
        if (this.#mode !== "paused" || msg.compId !== this.#compId) break;
        this.#sim?.stepCpu?.(msg.compId);
        break;
      case "poke":
        if (!this.#running || msg.compId !== this.#compId) break;
        if (!Number.isInteger(msg.addr) || !Number.isInteger(msg.value)) break;
        this.#sim?.pokeCpuMemory?.(msg.compId, msg.addr & 0xffff, msg.value & 0xff); // prettier-ignore
        break;
    }
  }

  // ── Keeping edits ──────────────────────────────────────────────────────────

  /** Whether ROM edits are kept at Stop. */
  get keepEdits() {
    return this.#keepEdits;
  }

  /** A run's byte changes (a ROM's mean a poke), and its Stop. */
  #onMemState(detail) {
    if (detail?.running) {
      if (detail.started) this.#editedRoms = new Set();
      const before = this.#editedRoms.size;
      for (const compId of detail.changes?.keys() ?? []) {
        const comp = this.#deskDoc?.getComponent?.(compId);
        if (comp && isRomChip(partDef(comp.ref))) this.#editedRoms.add(compId);
      }
      // The first ROM edit of a run brings the box up.
      if (before === 0 && this.#editedRoms.size > 0) this.#sendSoon();
      return;
    }
    const edited = this.#editedRoms;
    this.#editedRoms = new Set();
    if (edited.size) this.#sendSoon();
    if (!this.#keepEdits || !this.#saveRom) return;
    for (const compId of edited) {
      const bytes = detail?.images?.get(compId);
      if (bytes) this.#keep(compId, bytes);
    }
  }

  async #keep(compId, bytes) {
    let kept = false;
    try {
      kept = await this.#saveRom(compId, bytes);
    } catch (err) {
      console.error("[renderer] keeping CPU monitor edits failed:", err);
    }
    if (!kept) return;
    const comp = this.#deskDoc?.getComponent?.(compId);
    const def = comp ? partDef(comp.ref) : null;
    this.#notifications?.notify?.({
      key: `cpumon-kept:${compId}`,
      variant: "info",
      title: t("cpumonitor.keptTitle"),
      message: t("cpumonitor.keptMessage", {
        chip: comp?.name || `${chipMarking(def, comp?.ref ?? "")} · ${compId}`,
      }),
    });
  }

  // ── Breakpoints ────────────────────────────────────────────────────────────

  /** The breakpoint addresses of a CPU, ascending. */
  breakpointsOf(compId) {
    return [...(this.#breaks.get(compId) ?? [])].sort((a, b) => a - b);
  }

  #setBreakpoint(compId, addr, on) {
    if (!this.#isCpu(compId) || !Number.isInteger(addr)) return;
    const set = this.#breaks.get(compId) ?? new Set();
    if (on) set.add(addr & 0xffff);
    else set.delete(addr & 0xffff);
    if (set.size) this.#breaks.set(compId, set);
    else this.#breaks.delete(compId);
    this.#sim?.setCpuBreakpoints?.(compId, this.breakpointsOf(compId));
    this.#saveBreakpoints();
    this.#sendNow();
  }

  /** Hand the desktop's breakpoints to the project — only its CPUs', so one
      deleted takes its own with it at the next change. */
  #saveBreakpoints() {
    const map = {};
    for (const compId of this.#breaks.keys()) {
      if (this.#isCpu(compId)) map[compId] = this.breakpointsOf(compId);
    }
    try {
      this.#store?.save?.(map);
    } catch (err) {
      console.error("[renderer] keeping CPU breakpoints failed:", err);
    }
  }

  /** A desktop arrived: drop the last one's breakpoints and take up its own,
      telling the simulation both. */
  #loadBreakpoints() {
    for (const id of this.#breaks.keys()) this.#sim?.setCpuBreakpoints?.(id, []); // prettier-ignore
    this.#breaks = new Map();
    let kept = {};
    try {
      kept = this.#store?.load?.() ?? {};
    } catch (err) {
      console.error("[renderer] reading CPU breakpoints failed:", err);
    }
    for (const [compId, addrs] of Object.entries(kept)) {
      if (!this.#isCpu(compId) || !Array.isArray(addrs)) continue;
      const set = new Set(addrs.filter((a) => Number.isInteger(a)).map((a) => a & 0xffff)); // prettier-ignore
      if (!set.size) continue;
      this.#breaks.set(compId, set);
      this.#sim?.setCpuBreakpoints?.(compId, this.breakpointsOf(compId));
    }
  }

  /** A breakpoint hit: show that CPU, and raise the window if it paused. */
  #onBreak(detail) {
    if (!this.#isCpu(detail?.compId)) return;
    if (detail.paused) this.open(detail.compId);
    else if (this.#ready) this.#select(detail.compId);
  }

  // ── What changes what is shown ─────────────────────────────────────────────

  #select(compId) {
    if (compId !== this.#compId) {
      this.#compId = compId;
      this.#summary = null;
    }
    if (this.#ready) this.#sim?.monitorCpu?.(compId);
    this.#sendNow();
  }

  #onSimState(detail) {
    this.#running = Boolean(detail?.running);
    this.#mode = detail?.mode ?? (this.#running ? "running" : "stopped");
    const summary = detail?.cpuMonitor;
    if (summary && summary.compId === this.#compId) this.#summary = summary;
    this.#sendSoon();
  }

  /** An edit or another desktop: the CPU shown may have gone. */
  #onDeskChanged() {
    if (this.#compId != null && !this.#isCpu(this.#compId)) {
      this.#compId = this.#cpus()[0]?.id ?? null;
      this.#summary = null;
      if (this.#ready) this.#sim?.monitorCpu?.(this.#compId);
    } else if (this.#compId == null && this.#ready) {
      this.#compId = this.#cpus()[0]?.id ?? null;
      if (this.#compId) this.#sim?.monitorCpu?.(this.#compId);
    }
    this.#sendSoon();
  }

  // ── Sending ────────────────────────────────────────────────────────────────

  /** As soon as the last send allows; one trailing send at most. */
  #sendSoon() {
    if (!this.#ready || this.#timer != null) return;
    const wait = this.#lastSend + SEND_MS - this.#timers.now();
    if (wait <= 0) {
      this.#sendNow();
      return;
    }
    this.#timer = this.#timers.set(() => {
      this.#timer = null;
      this.#sendNow();
    }, wait);
  }

  /** Now (well — this microtask's end, so a burst of changes is one send). */
  #sendNow() {
    if (!this.#ready || this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      if (!this.#ready) return;
      if (this.#timer != null) {
        this.#timers.clear(this.#timer);
        this.#timer = null;
      }
      this.#lastSend = this.#timers.now();
      const msg = {
        kind: "state",
        cpus: this.#cpus(),
        compId: this.#compId,
        running: this.#running,
        mode: this.#mode,
        summary: this.#summary,
        breakpoints: this.breakpointsOf(this.#compId),
        keepEdits: this.#keepEdits,
        romEdited: this.#editedRoms.size > 0,
      };
      Promise.resolve(this.#bridge?.cpuMonitor?.toWindow?.(msg)).catch(
        () => {},
      );
    });
  }

  // ── The desktop's CPUs ─────────────────────────────────────────────────────

  /** Every CPU on the desktop, as the window's tabs list it. */
  #cpus() {
    const out = [];
    for (const comp of this.#deskDoc?.components ?? []) {
      const def = comp.kind === "chip" ? partDef(comp.ref) : null;
      if (!isCpu(def)) continue;
      out.push({
        id: comp.id,
        label: comp.name || `${chipMarking(def, comp.ref)} · ${comp.id}`,
      });
    }
    return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  #isCpu(compId) {
    if (compId == null) return false;
    const comp = this.#deskDoc?.getComponent?.(compId);
    return comp?.kind === "chip" && isCpu(partDef(comp.ref));
  }
}
