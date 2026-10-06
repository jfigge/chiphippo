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

// chip-debug.js — the chip debugger's model (the chip designer's debug
// mode), pure and DOM-free: what one engine tick did, read back as the
// pauses a debugger makes in it.
//
// THE ENGINE IS NEVER PAUSED. It is a pure, synchronous function, so a tick
// runs to its end exactly as it always does, with a RECORDER listening
// (`recorder`, handed to sim/engine.js `tick` as its observer): every pass's
// starting net levels, and every watched custom chip's inputs and state as
// that pass evaluated it. Because the engine is deterministic and nothing
// outside the board can reach it while the debugger holds the transport (the
// SimController stalls — a clock edge waits, an input waits), revealing that
// record pass by pass IS pausing it, observably. So a debug session is a
// REPLAY:
//
//   · `collectEvents` re-runs each watched chip's Verilog with a trace on
//     (hdl/program.js) wherever its pins or its state changed since the last
//     time it was seen, giving one EVENT per chip per pass — the statements
//     its reaction executes, as frames to step through.
//   · `DebugSession` walks those events pass by pass, stopping where a
//     BREAKPOINT is: a line of the chip's code the user marked, reached by a
//     statement its reaction executes. Every chip that reaches one in a pass
//     is paused AT ONCE (each its own tab, at its first such statement), all
//     reading the inputs as they were when the pass began — Verilog's
//     non-blocking rule. A change another chip's output makes to a paused
//     chip's input is HELD: it is the NEXT pass's input, and that chip
//     re-evaluates then only if it differs. Continue runs each paused chip on
//     to its next breakpoint, and when every chip paused in a pass has
//     finished, the board moves on to the next pass with a breakpoint in it,
//     and so on until the tick has settled. A chip being STEPPED is followed
//     into its next reaction whether or not that has a breakpoint, as a
//     debugger steps from one statement to the next one that runs.
//
// Frames, values and held counts are all this module's; which lines are
// breakpoints, which chips are watched, which tab has focus and how it is
// shown are the controller's (components/chip-debugger.js).

import * as V from "../hdl/values.js";
import { isMemory, readWords, sameMemory } from "../hdl/memory.js";

/**
 * An engine observer that records a tick: `rounds`, each `{phase, levels,
 * strong, evals: [{compId, ins, state, prev?, next?}]}`.
 * @param {Set<string>} watch - the component ids to record.
 */
export function recorder(watch) {
  const rounds = [];
  return {
    watch,
    rounds,
    round(phase, levels, strong) {
      rounds.push({ phase, levels, strong, evals: [] });
    },
    chip(compId, ins, state, prev = null, next = null) {
      rounds[rounds.length - 1]?.evals.push({ compId, ins, state, prev, next });
    },
  };
}

/** Two packed states the same? (An array's entry is its memory.) */
const samePacked = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((p, i) => {
    const q = b[i];
    if (isMemory(p) || isMemory(q)) return sameMemory(p, q);
    return p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
  });
};
const sameValues = (a, b) =>
  a.length === b.length && a.every((v, i) => V.same(v, b[i]));

/**
 * Turn a recorded tick into debugger events, updating `seen` (compId → the
 * chip's values as last seen, per unit) as it goes — so the next tick picks
 * up exactly where this one left off.
 *
 * A pass's event for a chip is its REACTION: on a settle pass the
 * combinational blocks its changed inputs (or state) reach; on a step pass
 * the edge-triggered blocks that fired, their non-blocking updates, and the
 * combinational blocks the new state reaches. A pass where nothing reached
 * any block is no event — the chip did nothing a debugger could show.
 *
 * @param {object} opts
 * @param {object[]} opts.rounds - `recorder(…).rounds`.
 * @param {Map<string, object>} opts.seen - updated in place.
 * @param {(compId: string) => object|null} opts.defOf - the chip's catalog
 *   def (only a custom chip's has a `customRuntime`).
 * @param {(compId: string) => string} opts.labelOf - the tab label (chips
 *   changing in the same pass are ordered by it, so the order is predictable).
 * @returns {{events: object[], touched: Set<string>}} `events` in pass order
 *   (`{round, compId, phase, frames, units}`, `units` each unit's values once
 *   the reaction is over) — every reaction of every recorded chip, since
 *   whether one is stopped in is the session's to decide (a breakpoint may be
 *   set while it is paused) — and `touched` every chip that changed at all.
 */
export function collectEvents({ rounds, seen, defOf, labelOf }) {
  const events = [];
  const touched = new Set();
  rounds.forEach((round, r) => {
    const found = [];
    for (const e of round.evals) {
      const rt = defOf(e.compId)?.customRuntime;
      if (!rt) continue;
      const before = seen.get(e.compId) ?? null;
      const units = [];
      const frames = [];
      let changed = false;
      rt.units.forEach((_u, u) => {
        const ins = rt.unitInputs(u, e.ins);
        const st = e.state?.[u] ?? rt.program.initialState();
        const prior = before?.units?.[u] ?? null;
        if (round.phase === "step") {
          const prevIns = e.prev ? rt.unitInputs(u, e.prev) : null;
          const t = rt.program.traceStep(st, ins, prevIns);
          for (const f of t.frames) frames.push({ ...f, unit: u });
          units.push({ ins, state: t.state ?? st, vals: t.vals });
          if (t.frames.length) changed = true;
          return;
        }
        if (
          prior &&
          sameValues(prior.ins, ins) &&
          samePacked(prior.state, st)
        ) {
          units.push(prior);
          return;
        }
        const t = rt.program.traceComb(prior?.vals ?? null, ins, st);
        for (const f of t.frames) frames.push({ ...f, unit: u });
        units.push({ ins, state: st, vals: t.vals });
        changed = true;
      });
      seen.set(e.compId, { units });
      if (changed) touched.add(e.compId);
      if (frames.length) {
        found.push({ round: r, compId: e.compId, phase: round.phase, frames, units }); // prettier-ignore
      }
    }
    found.sort((a, b) =>
      labelOf(a.compId).localeCompare(labelOf(b.compId), undefined, {
        numeric: true,
      }),
    );
    events.push(...found);
  });
  return { events, touched };
}

/**
 * The first frame at or after `from` whose statement is on a breakpoint line,
 * or `frames.length` when none is.
 * @param {object[]} frames
 * @param {number} from
 * @param {Set<number>|null} lines - the chip's breakpoint lines.
 */
export function nextBreak(frames, from, lines) {
  if (!lines?.size) return frames.length;
  for (let k = Math.max(0, from); k < frames.length; k++) {
    if (frames[k].loc && lines.has(frames[k].loc.line)) return k;
  }
  return frames.length;
}

/**
 * Where breakpoints go when a chip's code is edited: a line in the unchanged
 * text above the edit keeps its number, one in the unchanged text below it
 * moves with that text, and one inside the edited lines stays put (clamped to
 * the code's end). That is the difference of the two texts by their common
 * head and tail — the whole of what a single edit (typing, a paste, deleting
 * a line) does to the lines around it.
 * @param {string} before
 * @param {string} after
 * @param {Iterable<number>} lines - 1-based.
 * @returns {number[]} sorted, without duplicates.
 */
export function shiftLines(before, after, lines) {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const out = new Set();
  for (const line of lines) {
    let next = line;
    if (line > a.length - tail) next = line + (b.length - a.length);
    out.add(Math.min(Math.max(1, next), b.length));
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * A chip's values as last seen, from its pin levels and state alone — the
 * baseline for a chip armed while the circuit was already running (nothing
 * was recording it until then).
 */
export function seenFrom(def, ins, state) {
  const rt = def?.customRuntime;
  if (!rt) return null;
  return {
    units: rt.units.map((_u, u) => {
      const unitIns = rt.unitInputs(u, ins);
      const st = state?.[u] ?? rt.program.initialState();
      return {
        ins: unitIns,
        state: st,
        vals: rt.program.evaluate(unitIns, st),
      };
    }),
  };
}

/**
 * One tick's replay. Created when a tick produced something to stop at; the
 * controller drives it with the debugger bar's commands and reads it to
 * draw. `done` once the replay has reached the end of the tick and anything
 * waiting at the settled point has been let go.
 */
export class DebugSession {
  #rounds;
  #groups; // [{round, events}] in pass order
  #gi = -1; // the group the replay is paused in
  #current = new Map(); // compId → {event, k} for the paused group
  #dropped = new Set(); // detached chips: no more pauses this tick
  #stepping = new Set(); // chips being stepped: their next reaction pauses too
  #linesOf; // compId → its breakpoint lines (asked live: they can change)
  #settledFor; // chips waiting to be shown the settled board
  #forceSettled = false; // To Settled: stop at the settled point regardless
  #atSettled = false;
  #done = false;

  /**
   * @param {object} opts
   * @param {object[]} opts.rounds - the recorded passes.
   * @param {object[]} opts.events - `collectEvents(…).events`.
   * @param {Iterable<string>} [opts.settledFor] - chips armed to break on
   *   settled that changed this tick.
   * @param {(compId: string) => Set<number>|null} [opts.linesOf] - a chip's
   *   breakpoint lines, asked as the replay reaches each reaction (a
   *   breakpoint set while paused counts from then on).
   */
  constructor({ rounds, events, settledFor = [], linesOf = () => null }) {
    this.#rounds = rounds;
    this.#linesOf = linesOf;
    this.#settledFor = new Set(settledFor);
    const groups = new Map();
    for (const e of events) {
      if (!groups.has(e.round)) groups.set(e.round, []);
      groups.get(e.round).push(e);
    }
    this.#groups = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([round, list]) => ({ round, events: list }));
    this.#advance();
  }

  /** The replay has reached its end. */
  get done() {
    return this.#done;
  }

  /** Paused at the settled point (the tick's final board). */
  get atSettled() {
    return this.#atSettled;
  }

  /** The chips waiting at the settled point. */
  get settledFor() {
    return [...this.#settledFor];
  }

  /** The pass the board is paused at (an index into the rounds), or null. */
  get round() {
    return this.#gi >= 0 && this.#gi < this.#groups.length
      ? this.#groups[this.#gi].round
      : null;
  }

  /** The chips paused in this pass, in tab order — finished ones included. */
  get chips() {
    return [...this.#current.keys()];
  }

  /** Is this chip mid-reaction (paused with statements still to run)? */
  isPaused(compId) {
    const t = this.#current.get(compId);
    return Boolean(t) && t.k < t.event.frames.length;
  }

  /** This chip's reaction in the current pass, or null. */
  eventOf(compId) {
    return this.#current.get(compId)?.event ?? null;
  }

  /** The frame this chip is paused at — the statement about to execute and
      every value as it stands — or null when it is not paused. */
  frameOf(compId) {
    const t = this.#current.get(compId);
    if (!t || t.k >= t.event.frames.length) return null;
    return t.event.frames[t.k];
  }

  /** How far through its reaction a paused chip is: `{index, count}`. */
  progressOf(compId) {
    const t = this.#current.get(compId);
    return t ? { index: t.k, count: t.event.frames.length } : null;
  }

  /**
   * How many of a paused chip's input pins have a change HELD for it — a
   * level the next pass will read differently from the one it is
   * executing against.
   */
  heldOf(compId) {
    const t = this.#current.get(compId);
    if (!t || t.k >= t.event.frames.length) return 0;
    const now = this.#insAt(t.event.round, compId);
    for (let r = t.event.round + 1; r < this.#rounds.length; r++) {
      const next = this.#insAt(r, compId);
      if (!next) continue;
      let held = 0;
      for (const [pin, level] of next) if (now?.get(pin) !== level) held += 1;
      return held;
    }
    return 0;
  }

  #insAt(r, compId) {
    return this.#rounds[r]?.evals.find((e) => e.compId === compId)?.ins ?? null;
  }

  /**
   * The board as it stands at the paused pass: `{levels, strong}` — the
   * strong levels the latest pass that resolved any (null when none has: the
   * caller keeps what the board last showed).
   */
  boardLevels() {
    const r = this.round;
    if (r == null) return null;
    let strong = null;
    for (let i = r; i >= 0 && !strong; i--) strong = this.#rounds[i].strong;
    return { levels: this.#rounds[r].levels, strong };
  }

  /** Execute one statement of a paused chip. Stepping past the end of its
      reaction goes on to its NEXT one, breakpoint or not. */
  step(compId) {
    const t = this.#current.get(compId);
    if (!t || t.k >= t.event.frames.length) return;
    t.k += 1;
    this.#stepping.add(compId);
    this.#maybeAdvance();
  }

  /** Finish a paused chip's reaction: every remaining statement, its
      outputs written — and, as a step does, stop at its next one. */
  stepOut(compId) {
    const t = this.#current.get(compId);
    if (!t) return;
    t.k = t.event.frames.length;
    this.#stepping.add(compId);
    this.#maybeAdvance();
  }

  /** Run every paused chip on to its next breakpoint — later in the same
      reaction, or in another pass, on any chip — or to the settled point, or
      the end. At the settled point, carry on past it. */
  continue() {
    if (this.#atSettled) {
      this.#atSettled = false;
      this.#done = true;
      return;
    }
    this.#stepping.clear();
    for (const [compId, t] of this.#current) {
      t.k = nextBreak(t.event.frames, t.k + 1, this.#linesOf(compId));
    }
    this.#maybeAdvance();
  }

  /** Run to the settled point, ignoring the breakpoints on the way, and stop
      there. */
  toSettled() {
    if (this.#atSettled || this.#done) return;
    this.#stepping.clear();
    this.#forceSettled = true;
    this.#gi = this.#groups.length;
    this.#current = new Map();
    this.#atSettled = true;
  }

  /** Take a chip out of this tick's pauses (its debugging was switched off):
      its reaction finishes at once, and it stops nowhere else. */
  detach(compId) {
    this.#dropped.add(compId);
    this.#stepping.delete(compId);
    this.#settledFor.delete(compId);
    const t = this.#current.get(compId);
    if (t) t.k = t.event.frames.length;
    if (this.#atSettled && !this.#settledFor.size && !this.#forceSettled) {
      this.#atSettled = false;
      this.#done = true;
      return;
    }
    this.#maybeAdvance();
  }

  #maybeAdvance() {
    if (this.#atSettled || this.#done) return;
    for (const t of this.#current.values()) {
      if (t.k < t.event.frames.length) return;
    }
    this.#advance();
  }

  /** On to the next pass in which a chip stops: one that reaches a
      breakpoint (paused at the first it reaches), or one being stepped
      (paused at its first statement). */
  #advance() {
    for (this.#gi += 1; this.#gi < this.#groups.length; this.#gi += 1) {
      const current = new Map();
      for (const event of this.#groups[this.#gi].events) {
        const { compId, frames } = event;
        if (this.#dropped.has(compId)) continue;
        const k = this.#stepping.has(compId)
          ? 0
          : nextBreak(frames, 0, this.#linesOf(compId));
        if (k < frames.length) current.set(compId, { event, k });
      }
      if (current.size) {
        this.#current = current;
        return;
      }
    }
    this.#current = new Map();
    if (this.#settledFor.size || this.#forceSettled) this.#atSettled = true;
    else this.#done = true;
  }
}

/** How many of an array's queued writes a watch row spells out. */
const PENDING_WORDS_SHOWN = 4;

/**
 * A unit's values for the watch panel: every port, reg, integer and wire
 * with its value as Verilog prints it (and the value a queued non-blocking
 * write will give it, when there is one). An inout shows its pin's level
 * with what the chip drives onto it beside it (`drives`); an ARRAY is one
 * row saying its shape — its words are read on demand (`memoryWords`), never
 * carried here, since a 32K memory would ride every step to the window.
 * @param {object} program - hdl/program.js.
 * @param {object[]} vals - values by slot.
 * @param {Array<[number, object]>|null} [pending] - a frame's `pending`.
 * @returns {Array<{name: string, kind: string, value: string,
 *   decimal: number|null, pending: string|null, drives?: string,
 *   memory?: object}>}
 */
export function watchRows(program, vals, pending = null) {
  const after = new Map(pending ?? []);
  const signals = program.signals;
  const rows = [];
  signals.forEach((s, slot) => {
    if (s.hidden) return; // an inout's driven value — shown on its row
    const p = after.get(slot);
    if (s.kind === "memory") {
      const writes = p?.writes ?? [];
      rows.push({
        name: s.name,
        kind: "memory",
        value: `[${s.lo}:${s.hi}] × ${s.w}`,
        decimal: null,
        pending: null,
        memory: {
          slot,
          lo: s.lo,
          hi: s.hi,
          w: s.w,
          pendingCount: writes.length,
          pendingWords: writes
            .slice(0, PENDING_WORDS_SHOWN)
            .map(([addr, v]) => [addr + s.lo, V.format(v)]),
        },
      });
      return;
    }
    const v = vals?.[slot] ?? V.allX(s.w);
    const row = {
      name: s.name,
      kind: s.integer ? "integer" : s.kind,
      value: V.format(v),
      decimal: s.w > 1 ? (s.signed ? V.signedDecimal(v) : V.decimal(v)) : null,
      pending: p ? V.format(p) : null,
    };
    if (s.kind === "inout") {
      const drive = signals.findIndex((d) => d.hidden && d.name === s.name);
      if (drive >= 0) row.drives = V.format(vals?.[drive] ?? V.allZ(s.w));
    }
    rows.push(row);
  });
  return rows;
}

/**
 * Words of an array as a unit's values hold them, for a memory view:
 * `{from, words: [hex…], pending: [[index, hex]…]}` — `from` and the
 * pending writes' indices in the array's own numbering, the words in Verilog
 * `%h` digits. At most `count` words, from index `from`.
 * @param {object} program
 * @param {object[]} vals - values by slot.
 * @param {number} slot - the array's slot.
 * @param {number} from - the first index (as declared).
 * @param {number} count
 * @param {Array<[number, object]>|null} [pending] - a frame's `pending`.
 */
export function memoryWords(program, vals, slot, from, count, pending = null) {
  const s = program.signals[slot];
  const m = vals?.[slot];
  if (s?.kind !== "memory" || !isMemory(m)) return null;
  const start = Math.max(s.lo, Math.min(s.hi, Math.floor(from)));
  const n = Math.max(0, Math.min(count, s.hi - start + 1, 4096));
  const words = readWords(m, start - s.lo, n).map(V.hexDigits);
  const queued = new Map(pending ?? []).get(slot)?.writes ?? [];
  const inRange = queued
    .filter(([addr]) => addr >= start - s.lo && addr < start - s.lo + n)
    .map(([addr, v]) => [addr + s.lo, V.hexDigits(v)]);
  return { from: start, words, pending: inRange };
}

/**
 * Each pin's level as a chip's units hold them — what the designer's package
 * lights in the debugger: every port bit's value, on the pin the chip's map
 * puts it on (a pin two units share as an input shows the first).
 * @param {object} def - the chip's catalog def (with `customRuntime`).
 * @param {Array<object[]|null>} unitVals - per unit, its values by slot.
 * @returns {Array<[number, string]>} `[pin, "H"|"L"|"X"|"Z"]`.
 */
export function pinLevelsOf(def, unitVals) {
  const rt = def?.customRuntime;
  if (!rt) return [];
  const chip = def.customChip;
  // A port's own slot — an inout's PIN level, not the value it drives.
  const slotOf = new Map();
  rt.program.signals.forEach((s, slot) => {
    if (s.port) slotOf.set(s.name, slot);
  });
  const out = new Map();
  chip.units.forEach((map, u) => {
    const vals = unitVals?.[u];
    if (!vals) return;
    for (const port of chip.ports) {
      const v = vals[slotOf.get(port.name)];
      if (!v) continue;
      (map[port.name] ?? []).forEach((pin, b) => {
        if (!pin || out.has(pin)) return;
        const level = (v.x >>> b) & 1 ? ((v.z >>> b) & 1 ? "Z" : "X") : (v.v >>> b) & 1 ? "H" : "L"; // prettier-ignore
        out.set(pin, level);
      });
    }
  });
  return [...out];
}
