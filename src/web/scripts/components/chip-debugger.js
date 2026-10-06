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

// chip-debugger.js — the chip debugger's controller (the chip designer's
// debug mode): which custom chips are armed, the tabs the debugger window
// shows, and the SimController collaborator that stalls the board while a
// tick is replayed pass by pass (model/chip-debug.js says why replaying a
// pure engine's tick IS pausing it).
//
// Two kinds of breakpoint, and they belong to different things:
//
//   · A LINE breakpoint belongs to the chip's DESIGN — its code. Clicking a
//     line number in the designer's gutter sets one (a solid red circle),
//     and every placed instance of that chip stops when a change on its pins
//     makes its code execute that line. A line nothing can stop at (a
//     comment, a declaration, `end`) keeps its breakpoint but ignores it —
//     the window draws that circle hollow. Line breakpoints are kept for the
//     session, through Stop and Run and a desktop switch, and they follow
//     their lines as the code is edited (`shiftLines`).
//   · SETTLED belongs to one placed CHIP: pause when the board is quiescent
//     after a tick it changed in — from the debugger bar, or the chip's
//     right-click menu.
//
// Detach switches debugging off for one chip for the rest of the RUN — its
// line breakpoints ignored, its Settled cleared — and lets the board run on;
// switching Settled back on, or setting a breakpoint while its tab is shown,
// brings it back. Only the transport's Stop ends the simulation.
//
// Tabs are per chip, in the order changes ARRIVED (several in one pass:
// alphabetical, so the order is predictable); a tab that receives a new
// change moves to the end. A tab is Paused (stopped in its reaction, with a
// count of changes HELD for it by other chips' outputs), Idle (its reaction
// finished — its last values kept, nothing to step) or Detached (nothing
// would stop it: no breakpoint it can reach, and Settled off). A new pause
// never takes the focus from a tab the user is stepping.
//
// Everything it knows is published as ONE plain-data view (`state`) on a
// `chiphippo:chip-debug` event: the board draws its badges from it, and the
// designer bridge relays it to the window.

import { partDef, chipMarking } from "../catalog/index.js";
import {
  DebugSession,
  collectEvents,
  nextBreak,
  pinLevelsOf,
  recorder,
  seenFrom,
  shiftLines,
  watchRows,
} from "../model/chip-debug.js";

/** How often an idle tab's values follow the running board, at most. */
const LIVE_INTERVAL_MS = 100;

export class ChipDebugger {
  #doc;
  #sim = null;
  #breakpoints = new Map(); // design ref → Set of line numbers
  #codes = new Map(); // design ref → its code when its breakpoints were last placed
  #settled = new Set(); // compIds armed to break on settled
  #detached = new Set(); // compIds detached for the rest of the run
  #watch = null; // compIds the engine records (null: work it out again)
  #seen = new Map(); // compId → its values as last seen (chip-debug.js)
  #session = null;
  #release = null; // resolves the stall the session holds
  #show = null; // puts a pass's levels on the board
  #showFinal = null; // puts the settled board on it
  #tabs = new Map(); // compId → {state, seq, vals, unit}
  #seq = 0;
  #focus = null;
  #running = false;
  #emitQueued = false;
  #lastLive = -Infinity;

  /**
   * @param {object} opts
   * @param {import('../model/desk-doc.js').DeskDoc} opts.deskDoc
   */
  constructor({ deskDoc }) {
    this.#doc = deskDoc;
    // A new document on the desk (a desktop switch, a project) is a new set
    // of chips: component ids mean something else now.
    window.addEventListener("chiphippo:desk-loaded", () => this.#forget());
    // A chip deleted, or no longer a custom chip, has nothing to debug.
    window.addEventListener("chiphippo:doc-changed", () => this.#prune());
    // A design edited moves its breakpoints with its lines; one deleted
    // takes them with it.
    window.addEventListener("chiphippo:custom-chips-changed", (e) =>
      this.#designsChanged(e.detail?.chips ?? []),
    );
    // While nothing is paused, an idle tab follows the board live.
    window.addEventListener("chiphippo:sim-state", () => this.#followLive());
  }

  /** The SimController (built after this, so handed in after). */
  setSim(sim) {
    this.#sim = sim;
  }

  // ── Breakpoints ─────────────────────────────────────────────────────────

  /** A design's line breakpoints, in order — reachable or not. */
  breakpointsOf(ref) {
    return [...(this.#breakpoints.get(ref) ?? [])].sort((a, b) => a - b);
  }

  /**
   * Set a line breakpoint on a design, or clear the one there. Setting one
   * from a chip's debugger tab (`compId`) brings that chip back if it was
   * detached — it is the user asking to stop in it.
   * @param {string} ref - the design (a custom chip's id).
   * @param {number} line - 1-based, in the code the user writes.
   * @param {string|null} [compId]
   */
  toggleBreakpoint(ref, line, compId = null) {
    const chip = partDef(ref)?.customChip;
    if (!chip || !Number.isInteger(line) || line < 1) return;
    const lines = new Set(this.#breakpoints.get(ref) ?? []);
    const adding = !lines.has(line);
    if (adding) lines.add(line);
    else lines.delete(line);
    if (lines.size) this.#breakpoints.set(ref, lines);
    else this.#breakpoints.delete(ref);
    this.#codes.set(ref, chip.code);
    if (adding && compId) this.#detached.delete(compId);
    this.#watchChanged();
    this.#afterCommand();
  }

  /** What a chip would stop at: `{lines, settled}` — a line breakpoint its
      code can reach, and Settled — both false when nothing would. */
  armedOf(compId) {
    return {
      lines: Boolean(this.#activeLines(compId)),
      settled: this.#settled.has(compId),
    };
  }

  /**
   * Switch a chip's Settled breakpoint on or off (`patch.settled`). Switching
   * it on brings back a detached chip.
   */
  setArmed(compId, patch) {
    if (!this.#isCustom(compId) || typeof patch?.settled !== "boolean") return;
    if (patch.settled) {
      this.#settled.add(compId);
      this.#detached.delete(compId);
    } else {
      this.#settled.delete(compId);
      if (!this.#activeLines(compId)) this.#session?.detach(compId);
    }
    this.#watchChanged();
    this.#afterCommand();
  }

  /** Flip a chip's Settled breakpoint (the right-click menu). */
  toggleArmed(compId, kind) {
    if (kind !== "settled") return;
    this.setArmed(compId, { settled: !this.#settled.has(compId) });
  }

  // ── The SimController collaborator ──────────────────────────────────────

  /** A run starts: nothing has been seen yet (so the first evaluation of an
      armed chip is the time-zero one). */
  begin() {
    this.#running = true;
    this.#seen = new Map();
    this.#emit();
  }

  /** The run ended (Stop): any held tick is let go of with it, and the
      debugger's tabs go — the window turns back into the designer. A chip
      detached in it is debugged again in the next. */
  end() {
    this.#running = false;
    this.#session = null;
    this.#release = null;
    this.#tabs.clear();
    this.#focus = null;
    this.#seen = new Map();
    this.#detached.clear();
    this.#watch = null;
    this.#emit();
  }

  /** The engine observer for the next tick, or null when nothing could stop
      (the engine then records nothing at all). */
  observer() {
    const watch = this.#watched();
    return watch.size ? recorder(watch) : null;
  }

  /**
   * A tick ran with the recorder on. Returns null when there is nothing in it
   * to stop at, or a promise — the stall — that resolves when the replay has
   * reached the end of the tick.
   */
  afterTick({ observer, show, showFinal }) {
    const { events, touched } = collectEvents({
      rounds: observer.rounds,
      seen: this.#seen,
      defOf: (id) => this.#defOf(id),
      labelOf: (id) => this.labelOf(id),
    });
    const settledFor = [...touched].filter((id) => this.#settled.has(id));
    // Idle tabs keep the values the chip ended the tick with.
    for (const id of touched) this.#remember(id, this.#seen.get(id));
    const linesOf = (id) => this.#activeLines(id);
    const breaks = events.some(
      (e) => nextBreak(e.frames, 0, linesOf(e.compId)) < e.frames.length,
    );
    if (!breaks && !settledFor.length) {
      this.#emit();
      return null;
    }
    this.#session = new DebugSession({
      rounds: observer.rounds,
      events,
      settledFor,
      linesOf,
    });
    this.#show = show;
    this.#showFinal = showFinal;
    const stall = new Promise((resolve) => {
      this.#release = resolve;
    });
    this.#enterPause();
    return stall;
  }

  // ── Commands (the debugger bar) ─────────────────────────────────────────

  /** Execute one statement of a paused chip. */
  step(compId) {
    this.#session?.step(compId);
    this.#afterCommand();
  }

  /** Finish a paused chip's reaction. */
  stepOut(compId) {
    this.#session?.stepOut(compId);
    this.#afterCommand();
  }

  /** Run on to the next breakpoint, on any chip. */
  continue() {
    this.#session?.continue();
    this.#afterCommand();
  }

  /** Run to the settled point, ignoring breakpoints, and stop there. */
  toSettled() {
    this.#session?.toSettled();
    this.#afterCommand();
  }

  /** Switch a chip's debugging off for the rest of the run and let it run
      (never stops the sim). */
  detach(compId) {
    this.#settled.delete(compId);
    this.#detached.add(compId);
    this.#session?.detach(compId);
    const tab = this.#tabs.get(compId);
    if (tab) tab.state = "detached";
    this.#watchChanged();
    this.#afterCommand();
  }

  /** Show a chip's tab (selecting the chip on the board does this). Only
      while the circuit runs — stopped, the window is the designer, whose
      tabs are designs rather than chips. */
  focusChip(compId) {
    if (!this.#running || !this.#isCustom(compId)) return;
    if (!this.#tabs.has(compId)) {
      this.#tabs.set(compId, { state: "idle", seq: ++this.#seq, vals: null, unit: 0 }); // prettier-ignore
      this.#seedTab(compId);
    }
    this.#focus = compId;
    this.#emit();
  }

  /** Close a tab (not a paused one — it is mid-reaction). */
  closeTab(compId) {
    if (this.#session?.isPaused(compId)) return;
    this.#tabs.delete(compId);
    if (this.#focus === compId) this.#focus = this.#order()[0] ?? null;
    this.#emit();
  }

  /** Which unit's values a tab's watch panel shows (a replicated chip). */
  setUnit(compId, unit) {
    const tab = this.#tabs.get(compId);
    if (!tab) return;
    tab.unit = unit;
    this.#emit();
  }

  // ── The view ────────────────────────────────────────────────────────────

  /** A placed component's catalog ref (null when there is none). */
  refOf(compId) {
    return this.#doc.getComponent(compId)?.ref ?? null;
  }

  /** The desk's placed instances of a custom chip, in id order (`c2` before
      `c10`). */
  instancesOf(ref) {
    return this.#doc.components
      .filter((comp) => comp.ref === ref)
      .map((comp) => comp.id)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  }

  /** A chip's tab label: its own Name, else its part number and id. */
  labelOf(compId) {
    const comp = this.#doc.getComponent(compId);
    if (comp?.name) return comp.name;
    return `${chipMarking(partDef(comp?.ref), comp?.ref ?? "")} · ${compId}`;
  }

  /**
   * Everything the debugger knows, as plain data: the transport, the
   * session, and each tab with what its watch panel and code view show.
   */
  get state() {
    const s = this.#session;
    const tabs = this.#order().map((compId) => this.#tabView(compId));
    const breakpoints = {};
    for (const ref of this.#breakpoints.keys()) {
      breakpoints[ref] = this.breakpointsOf(ref);
    }
    return {
      running: this.#running,
      paused: Boolean(s && !s.done),
      atSettled: Boolean(s?.atSettled),
      settled: !s || s.done || s.atSettled,
      focus: this.#focus,
      tabs,
      armed: [...this.#watched()].map((id) => [id, this.armedOf(id)]),
      breakpoints,
      pausedChips: s ? s.chips.filter((id) => s.isPaused(id)) : [],
    };
  }

  #tabView(compId) {
    const s = this.#session;
    const tab = this.#tabs.get(compId);
    const comp = this.#doc.getComponent(compId);
    const def = this.#defOf(compId);
    const program = def?.customRuntime?.program ?? null;
    const frame = s?.frameOf(compId) ?? null;
    const units = def?.customChip?.units.length ?? 1;
    // Detached is a fact about what would STOP it, not a history: a chip no
    // breakpoint can stop runs normally and never pauses, whether it was
    // detached a moment ago or simply never had one (a tab opened by
    // selecting it).
    const armed = this.armedOf(compId);
    let state = tab.state === "detached" ? "idle" : tab.state;
    if (s?.isPaused(compId)) state = "paused";
    else if (!armed.lines && !armed.settled) state = "detached";
    const unit = frame ? frame.unit : Math.min(tab.unit ?? 0, units - 1);
    let watch = [];
    if (program) {
      if (frame) watch = watchRows(program, frame.vals, frame.pending);
      else if (tab.vals?.[unit]) watch = watchRows(program, tab.vals[unit]);
    }
    // The package's pins: the paused unit's as the frame has them, every
    // other unit's as the tab last saw them.
    const unitVals = (tab.vals ?? []).slice();
    if (frame) unitVals[frame.unit] = frame.vals;
    return {
      compId,
      ref: comp?.ref ?? null,
      label: this.labelOf(compId),
      state,
      armed,
      held: frame ? s.heldOf(compId) : 0,
      units,
      unit,
      phase: frame?.phase ?? null,
      loc: frame?.loc ?? null,
      progress: frame ? s.progressOf(compId) : null,
      waitingAtSettled: Boolean(s?.atSettled && s.settledFor.includes(compId)),
      watch,
      pinLevels: def ? pinLevelsOf(def, unitVals) : [],
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #defOf(compId) {
    return partDef(this.#doc.getComponent(compId)?.ref);
  }

  #isCustom(compId) {
    return this.#defOf(compId)?.custom === true;
  }

  /**
   * The breakpoint lines a placed chip can stop at — its design's, less any
   * its code cannot reach — or null when there are none (or it is detached,
   * or its code does not run at all).
   */
  #activeLines(compId) {
    if (this.#detached.has(compId)) return null;
    const def = this.#defOf(compId);
    const lines = this.#breakpoints.get(def?.id);
    const reachable = def?.customRuntime?.program.executableLines;
    if (!lines?.size || !reachable) return null;
    const active = new Set([...lines].filter((n) => reachable.has(n)));
    return active.size ? active : null;
  }

  /** The chips the engine records: every placed custom chip that something
      could stop. Worked out again only after a change that could alter it. */
  #watched() {
    if (this.#watch) return this.#watch;
    const watch = new Set();
    if (this.#breakpoints.size || this.#settled.size) {
      for (const comp of this.#doc.components ?? []) {
        const { lines, settled } = this.armedOf(comp.id);
        if ((lines || settled) && this.#isCustom(comp.id)) watch.add(comp.id);
      }
    }
    this.#watch = watch;
    return watch;
  }

  /** Something that decides what is watched changed. A chip watched from
      now on, mid-run, takes its current values as its baseline — so the
      first thing it stops at is a real change. */
  #watchChanged() {
    const before = this.#watch ?? new Set();
    this.#watch = null;
    if (!this.#running) return;
    for (const id of this.#watched()) if (!before.has(id)) this.#seedSeen(id);
  }

  /** The designs changed: a deleted design's breakpoints go, and an edited
      one's move with the lines they were on. */
  #designsChanged(chips) {
    const byId = new Map(chips.map((c) => [c.id, c]));
    let changed = false;
    for (const [ref, lines] of [...this.#breakpoints]) {
      const chip = byId.get(ref);
      if (!chip) {
        this.#breakpoints.delete(ref);
        this.#codes.delete(ref);
        changed = true;
        continue;
      }
      const before = this.#codes.get(ref);
      if (before === chip.code) continue;
      const moved = shiftLines(before ?? chip.code, chip.code, lines);
      this.#codes.set(ref, chip.code);
      if (moved.join() !== [...lines].sort((a, b) => a - b).join()) {
        this.#breakpoints.set(ref, new Set(moved));
        changed = true;
      }
    }
    this.#watch = null;
    if (changed) this.#emit();
  }

  /** Tab ids in arrival order. */
  #order() {
    return [...this.#tabs.entries()]
      .sort((a, b) => a[1].seq - b[1].seq)
      .map(([id]) => id);
  }

  /** The session moved: put its board up, its tabs in order, and let the
      board go when it is done. */
  #afterCommand() {
    const s = this.#session;
    if (s) {
      // Finished reactions leave their final values on their tabs.
      for (const id of s.chips) {
        if (!s.isPaused(id)) this.#remember(id, s.eventOf(id));
      }
      if (s.done) {
        this.#finish();
        return;
      }
    }
    this.#enterPause();
  }

  /** Show the pass (or the settled point) the session is paused at. */
  #enterPause() {
    const s = this.#session;
    if (!s) {
      this.#emit();
      return;
    }
    if (s.done) {
      this.#finish();
      return;
    }
    if (s.atSettled) {
      this.#showFinal?.();
      const ids = s.settledFor;
      for (const id of ids) this.#ensureTab(id);
      if (ids.length && !ids.includes(this.#focus)) this.#focus = ids[0];
      this.#emit();
      return;
    }
    const board = s.boardLevels();
    if (board) this.#show?.(board.levels, board.strong);
    // A chip paused afresh arrives at the END of the strip; several in one
    // pass keep the alphabetical order the session gives them.
    const paused = s.chips.filter((id) => s.isPaused(id));
    for (const id of paused) {
      const tab = this.#ensureTab(id);
      if (tab.pass !== s.round) {
        tab.pass = s.round;
        tab.seq = ++this.#seq;
        tab.state = "paused";
      }
    }
    // Never take the focus from a tab being stepped.
    if (!s.isPaused(this.#focus) && paused.length) this.#focus = paused[0];
    this.#emit();
  }

  #finish() {
    const release = this.#release;
    this.#session = null;
    this.#release = null;
    for (const tab of this.#tabs.values()) {
      if (tab.state === "paused") tab.state = "idle";
      tab.pass = null;
    }
    this.#emit();
    release?.();
  }

  #ensureTab(compId) {
    let tab = this.#tabs.get(compId);
    if (!tab) {
      tab = {
        state: "idle",
        seq: ++this.#seq,
        vals: null,
        unit: 0,
        pass: null,
      };
      this.#tabs.set(compId, tab);
    }
    return tab;
  }

  /** Keep a chip's values (per unit) on its tab. */
  #remember(compId, seen) {
    const tab = this.#tabs.get(compId);
    if (!tab || !seen?.units) return;
    tab.vals = seen.units.map((u) => u.vals);
  }

  /** A chip armed mid-run: its current values are the baseline. */
  #seedSeen(compId) {
    const snap = this.#sim?.chipSnapshot?.(compId);
    if (!snap) return;
    const seen = seenFrom(this.#defOf(compId), snap.ins, snap.state);
    if (seen) this.#seen.set(compId, seen);
  }

  /** A tab opened mid-run shows the chip as it stands. */
  #seedTab(compId) {
    const snap = this.#sim?.chipSnapshot?.(compId);
    if (!snap) return;
    this.#remember(compId, seenFrom(this.#defOf(compId), snap.ins, snap.state));
  }

  /** Between pauses, an idle tab follows the board: its values are the
      chip's as the last tick left them. */
  #followLive() {
    if (this.#session || !this.#running || !this.#tabs.size) return;
    // A fast clock publishes hundreds of boards a second; a watch panel read
    // by a person needs a handful.
    const now = globalThis.performance?.now?.() ?? Date.now();
    if (now - this.#lastLive < LIVE_INTERVAL_MS) return;
    this.#lastLive = now;
    for (const [id, tab] of this.#tabs) {
      if (tab.state === "paused") continue;
      this.#seedTab(id);
    }
    this.#emit();
  }

  /** Another document: its component ids are other chips. (Line
      breakpoints are the designs', and stay.) */
  #forget() {
    this.#settled.clear();
    this.#detached.clear();
    this.#watch = null;
    this.#tabs.clear();
    this.#focus = null;
    this.#seen = new Map();
    this.#emit();
  }

  #prune() {
    let changed = false;
    // A chip placed or removed may change what is watched.
    this.#watch = null;
    for (const id of [...this.#settled, ...this.#detached]) {
      if (!this.#isCustom(id)) {
        this.#settled.delete(id);
        this.#detached.delete(id);
        changed = true;
      }
    }
    for (const id of [...this.#tabs.keys()]) {
      if (!this.#isCustom(id) && !this.#session?.isPaused(id)) {
        this.#tabs.delete(id);
        if (this.#focus === id) this.#focus = null;
        changed = true;
      }
    }
    if (changed) this.#emit();
  }

  /** Publish the view — once per frame at most, however many changes. */
  #emit() {
    if (this.#emitQueued) return;
    this.#emitQueued = true;
    const fire = () => {
      this.#emitQueued = false;
      window.dispatchEvent(
        new CustomEvent("chiphippo:chip-debug", { detail: this.state }),
      );
    };
    if (typeof queueMicrotask === "function") queueMicrotask(fire);
    else fire();
  }
}
