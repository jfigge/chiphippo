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

// program.js — the Verilog subset's interpreter: a compiled module
// (analyze.js) run the way a Verilog simulator runs it, in the shape the
// Chip Hippo engine asks of a stateful part.
//
//   · STATE is the regs that hold a value between evaluations — the ones an
//     edge-triggered block drives, or only `initial` sets — as plain data
//     (`[[v, x, z], …]`), so the engine's structural state comparison works.
//   · `evaluate(ins, state)` settles the COMBINATIONAL part — every `assign`
//     and `always @(*)` — from the inputs and the state: a bounded fixpoint
//     over the blocks in dependency order (analyze.js has already refused a
//     true loop, so it settles; the bound is the promise that it ends).
//   · `step(state, ins, prev)` runs the EDGE-triggered blocks whose events
//     fired between `prev` and `ins` — blocking assignments at once,
//     non-blocking ones all together when every fired block has finished —
//     reading the combinational values as they stood at the edge. Off an edge
//     it returns `state` itself, which the engine's step fixpoint relies on.
//   · `initialState()` runs the declaration initialisers and `initial`
//     blocks with every input unknown; a reg nothing sets starts as x, as
//     Verilog's does.
//
// The trace methods run the SAME code with a callback before every
// statement, for the debugger: `traceComb` is event-driven (only the blocks
// a change reaches run, in order, as a simulator would schedule them), and
// `traceStep` adds the edge blocks and their non-blocking updates in front.
//
// An ARRAY's value is a memory (memory.js), not a vector, and is state like
// any edge-driven reg — held by reference, since a memory is immutable. Its
// writes go through a TRANSACTION (`ctx.tx`) while nothing is watching, so a
// loop filling 32K words copies each node once; while a trace records
// frames a write never changes a memory a frame already holds.

import * as V from "./values.js";
import {
  changedWords,
  isMemory,
  newMemory,
  newTx,
  sameMemory,
  writeWord,
} from "./memory.js";

/** One slot's value as state data: a vector as `[v, x, z]`, a memory as
    itself (it is immutable already). */
const packOne = (value) => (isMemory(value) ? value : V.pack(value));
/** Two slot values the same? (A memory compares its words.) */
const sameValue = (a, b) =>
  isMemory(a) || isMemory(b) ? sameMemory(a, b) : V.same(a, b);

/** Bits of a 1-bit-at-`pos` read: "0" | "1" | "x" | "z". */
function bitState(value, pos) {
  if (!value) return "x";
  if ((value.x >>> pos) & 1) return (value.z >>> pos) & 1 ? "z" : "x";
  return (value.v >>> pos) & 1 ? "1" : "0";
}

/** Does a transition from `a` to `b` fire this edge (IEEE 1364 §9.7.2)? */
function fires(edge, a, b) {
  if (a === b) return false;
  if (edge === "posedge") {
    return (a === "0" && b !== "0") || ((a === "x" || a === "z") && b === "1");
  }
  return (a === "1" && b !== "1") || ((a === "x" || a === "z") && b === "0");
}

export class Program {
  #m;
  #inputSlots; // input port index → slot
  #outputSlots; // output port index → slot
  #inputIndexOf = new Map(); // slot → input port index
  #maxPasses;
  #blanks = new Map(); // slot → an array's all-x memory
  #initial = null;
  #lines = null; // the lines a debugger can stop at (see executableLines)
  #readers; // slot → comb block indices reading it

  /** @param {object} module - analyze.js's `module`. */
  constructor(module) {
    this.#m = module;
    // An inout is read like an input (its pin's level) and drives like an
    // output (its driven slot), each in port order among its kind.
    this.#inputSlots = module.ports.filter((p) => p.dir === "input" || p.dir === "inout").map((p) => p.slot); // prettier-ignore
    this.#outputSlots = module.ports.filter((p) => p.dir === "output" || p.dir === "inout").map((p) => p.drive ?? p.slot); // prettier-ignore
    this.#inputSlots.forEach((slot, i) => this.#inputIndexOf.set(slot, i));
    let bits = 0;
    for (const slot of module.combSlots) bits += module.slots[slot].w;
    this.#maxPasses = Math.min(1024, bits + 2);
    this.#readers = new Map();
    module.comb.forEach((block, i) => {
      for (const r of block.reads) {
        if (!this.#readers.has(r.slot)) this.#readers.set(r.slot, new Set());
        this.#readers.get(r.slot).add(i);
      }
    });
  }

  /** Every signal: `{name, kind, w, msb, lsb, port}` by slot. */
  get signals() {
    return this.#m.slots;
  }

  /** The input ports, in port order (what `ins` arrays are aligned with) —
      an inout's pin among them. */
  get inputs() {
    return this.#inputSlots.map((s) => this.#m.slots[s]);
  }

  /** The output ports, in port order — an inout's driven value among them,
      under the inout's name. */
  get outputs() {
    return this.#outputSlots.map((s) => this.#m.slots[s]);
  }

  /** Which slots are state, in the order a state array holds them. */
  get stateSlots() {
    return this.#m.state;
  }

  /** The comb blocks (dependency order) and the edge blocks (source order),
      for the debugger: `{kind, loc}`. */
  get blocks() {
    return {
      comb: this.#m.comb.map((b) => ({ kind: b.kind, loc: b.loc })),
      edge: this.#m.edge.map((b) => ({ kind: b.kind, loc: b.loc })),
    };
  }

  /**
   * Every line a debugger can stop at: the first line of each statement the
   * combinational and edge-triggered blocks hold — an assignment, an `if`, a
   * `case` — which are exactly the lines a trace's frames name. An `initial`
   * block's are not among them: it has run before anything is watched. A
   * breakpoint on any other line (a comment, a declaration, `begin`, `end`,
   * a statement's second line) can never be reached.
   * @returns {Set<number>}
   */
  get executableLines() {
    if (this.#lines) return this.#lines;
    const lines = new Set();
    const walk = (stmt) => {
      switch (stmt?.kind) {
        case "block":
          for (const inner of stmt.stmts) walk(inner);
          return;
        case "assign":
          lines.add(stmt.loc.line);
          return;
        case "if":
          lines.add(stmt.loc.line);
          walk(stmt.then);
          walk(stmt.else);
          return;
        case "case":
          lines.add(stmt.loc.line);
          for (const item of stmt.items) walk(item.body);
          walk(stmt.default);
          return;
        case "for":
        case "repeat":
          lines.add(stmt.loc.line);
          walk(stmt.body);
          return;
        case "mark":
          lines.add(stmt.loc.line);
          return;
        default:
      }
    };
    for (const block of [...this.#m.comb, ...this.#m.edge]) walk(block.body);
    this.#lines = lines;
    return lines;
  }

  /** Does the module have edge-triggered blocks at all? */
  get sequential() {
    return this.#m.edge.length > 0;
  }

  /** The state a fresh run starts in (shared — state is never mutated). */
  initialState() {
    if (this.#initial) return this.#initial;
    const vals = this.#fresh(this.#inputSlots.map((s) => V.allX(this.#m.slots[s].w)), null); // prettier-ignore
    const ctx = { vals, nba: [], trace: null, tx: newTx() };
    for (const block of this.#m.initial) exec(block.body, ctx);
    applyNba(ctx);
    this.#initial = Object.freeze(this.#pack(vals));
    return this.#initial;
  }

  /**
   * Every signal's value with these inputs and this state, the combinational
   * part settled.
   * @param {V.Value[]} ins - one value per input port.
   * @param {Array} state - a state array (null: the initial state).
   * @returns {object[]} values by slot.
   */
  evaluate(ins, state) {
    const vals = this.#fresh(ins, state ?? this.initialState());
    this.#settle(vals);
    return vals;
  }

  /** Just the output ports' values (one per output port). */
  outputValues(ins, state) {
    const vals = this.evaluate(ins, state);
    return this.#outputSlots.map((s) => vals[s]);
  }

  /** The edge blocks the step from `prev` to `ins` fires. The first sample
      (`prev` null) is IEEE 1364's time zero, every input x a moment before:
      an asynchronous control already at its active level fires its block
      there (x→0 is a negedge, x→1 a posedge), so a reset held low from Run
      applies at once — as a built-in part's CLR does. The CLOCK does not:
      no part latches on its first sample. */
  firedBlocks(ins, prev) {
    if (!this.#m.edge.length) return [];
    return this.#m.edge.filter((block) =>
      block.events.some((e) => {
        const i = this.#inputIndexOf.get(e.slot);
        const now = bitState(ins[i], e.pos);
        if (!prev) {
          const clock = block.clock;
          const isClock = clock && clock.slot === e.slot && clock.pos === e.pos;
          return !isClock && fires(e.edge, "x", now);
        }
        return fires(e.edge, bitState(prev[i], e.pos), now);
      }),
    );
  }

  /**
   * Advance on whatever edges fired between `prev` and `ins`. Returns
   * `state` ITSELF when nothing fired or nothing changed.
   */
  step(state, ins, prev) {
    const fired = this.firedBlocks(ins, prev);
    if (!fired.length) return state;
    const vals = this.evaluate(ins, state);
    const ctx = { vals, nba: [], trace: null, tx: newTx() };
    for (const block of fired) exec(block.body, ctx);
    applyNba(ctx);
    const next = this.#pack(vals);
    return samePacked(next, state ?? this.initialState()) ? state : next;
  }

  // ── Tracing (the debugger) ─────────────────────────────────────────────

  /**
   * The combinational reaction to a change, as an event-driven simulator
   * schedules it: only the blocks a changed input or state bit reaches run,
   * each in dependency order, and each block's own changes reach the blocks
   * after it. `before` is the full value array of the last evaluation this
   * chip was seen at (null: none — every block runs, as at time zero).
   *
   * @returns {{frames: object[], vals: object[]}} `frames` one per statement
   *   about to execute: `{phase: "comb", block, loc, vals, pending}`.
   */
  traceComb(before, ins, state) {
    const st = state ?? this.initialState();
    let vals;
    let changed;
    if (!before) {
      vals = this.#fresh(ins, st);
      changed = null; // everything
    } else {
      vals = before.slice();
      const fresh = this.#fresh(ins, st);
      changed = new Set();
      for (const slot of [...this.#inputSlots, ...this.#m.state]) {
        if (!sameValue(vals[slot], fresh[slot])) {
          vals[slot] = fresh[slot];
          changed.add(slot);
        }
      }
    }
    const frames = [];
    this.#propagate(vals, changed, frames);
    return { frames, vals };
  }

  /**
   * An edge-triggered step, statement by statement: each fired block (its
   * blocking assignments taking effect as they run, its non-blocking ones
   * queued), then the non-blocking updates as one frame, then the
   * combinational reaction to the state that changed.
   *
   * @returns {{frames: object[], state: Array, vals: object[]}}
   */
  traceStep(state, ins, prev) {
    const st = state ?? this.initialState();
    const fired = this.firedBlocks(ins, prev);
    const vals = this.evaluate(ins, st);
    if (!fired.length) return { frames: [], state, vals };
    const frames = [];
    // No transaction while frames are taken: a memory a frame holds must
    // stay as it was. The non-blocking updates land after the last frame
    // before them, so they may share one.
    const ctx = { vals, nba: [], trace: null, tx: null };
    for (const block of fired) {
      const index = this.#m.edge.indexOf(block);
      ctx.trace = (stmt) =>
        frames.push(frame("edge", index, stmt.loc, vals, ctx.nba));
      exec(block.body, ctx);
    }
    if (ctx.nba.length) frames.push(frame("nba", -1, null, vals, ctx.nba));
    ctx.tx = newTx();
    applyNba(ctx);
    const next = this.#pack(vals);
    const changed = new Set();
    this.#m.state.forEach((slot, i) => {
      if (!samePackedOne(st[i], next[i])) changed.add(slot);
    });
    if (changed.size) this.#propagate(vals, changed, frames);
    return {
      frames,
      state: samePacked(next, st) ? state : next,
      vals,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** A value array: inputs, state, and every combinational signal at its
      starting point (an undriven wire is z, a comb reg x). */
  #fresh(ins, state) {
    const m = this.#m;
    const vals = new Array(m.slots.length);
    m.slots.forEach((s, slot) => {
      if (s.kind === "memory") {
        vals[slot] = this.#blank(slot);
        return;
      }
      vals[slot] = s.kind === "wire" || s.kind === "drive" || (s.kind === "output" && m.outputKind.get(s.name) === "wire") ? V.allZ(s.w) : V.allX(s.w); // prettier-ignore
    });
    this.#inputSlots.forEach((slot, i) => {
      vals[slot] = V.resize(ins?.[i] ?? V.allX(m.slots[slot].w), m.slots[slot].w); // prettier-ignore
    });
    if (state) {
      m.state.forEach((slot, i) => {
        const p = state[i];
        vals[slot] = isMemory(p) ? p : V.unpack(m.slots[slot].w, p);
      });
    }
    return vals;
  }

  /** An array's all-x memory — one per slot, shared (it is immutable). */
  #blank(slot) {
    let blank = this.#blanks.get(slot);
    if (!blank) {
      const s = this.#m.slots[slot];
      blank = newMemory(s.w, s.depth);
      this.#blanks.set(slot, blank);
    }
    return blank;
  }

  /** Settle the comb blocks in place: passes in dependency order until a
      pass changes nothing (bounded) — or ONE pass, when no block reads a
      block after it (analyze.js `orderComb`): a second could only confirm
      it, and it cost every evaluation a second run of every block. */
  #settle(vals) {
    const comb = this.#m.comb;
    if (this.#m.combAcyclic) {
      for (const block of comb) runComb(block, vals, null);
      return;
    }
    for (let pass = 0; pass < this.#maxPasses; pass++) {
      let changed = false;
      for (const block of comb) {
        if (runComb(block, vals, null)) changed = true;
      }
      if (!changed) return;
    }
  }

  /** Event-driven propagation from `changed` (null: everything), recording
      a frame per statement. */
  #propagate(vals, changed, frames) {
    const comb = this.#m.comb;
    const queued = new Set();
    const enqueueReaders = (slot) => {
      for (const i of this.#readers.get(slot) ?? []) queued.add(i);
    };
    if (changed == null) comb.forEach((_b, i) => queued.add(i));
    else for (const slot of changed) enqueueReaders(slot);
    let runs = 0;
    const limit = comb.length * this.#maxPasses;
    while (queued.size && runs < limit) {
      const i = Math.min(...queued);
      queued.delete(i);
      runs += 1;
      const block = comb[i];
      const record = (stmt, ctx) =>
        frames.push(frame("comb", i, stmt.loc, vals, ctx.nba));
      const writes = runComb(block, vals, record);
      if (writes) for (const slot of writes) enqueueReaders(slot);
    }
  }

  #pack(vals) {
    return this.#m.state.map((slot) => packOne(vals[slot]));
  }
}

/**
 * One debugger frame: where execution is about to go, and every value as it
 * stands — plus `pending`, what the queued non-blocking writes would make of
 * them: `[slot, value]` for a vector, `[slot, {mem: true, writes: [[addr,
 * value]]}]` for an array. Worked out only when asked for (a loop queueing
 * thousands of writes takes a frame per statement, and only the frame on
 * screen is ever read), from the queue as it stood: the frame keeps the
 * queue and its length, and the queue is only ever appended to.
 */
function frame(phase, block, loc, vals, nba) {
  const snapshot = vals.slice();
  const queued = nba?.length ?? 0;
  let pending;
  return {
    phase,
    block,
    loc,
    vals: snapshot,
    get pending() {
      if (pending === undefined) pending = pendingOf(snapshot, nba, queued);
      return pending;
    },
  };
}

/** What the first `count` queued writes would change, or null for none. */
function pendingOf(vals, nba, count) {
  if (!count) return null;
  const after = vals.slice();
  const tx = newTx();
  for (let k = 0; k < count; k++) writeSegments(after, nba[k][0], nba[k][1], tx); // prettier-ignore
  const out = [];
  after.forEach((v, slot) => {
    if (sameValue(v, vals[slot])) return;
    if (isMemory(v))
      out.push([slot, { mem: true, writes: changedWords(vals[slot], v) }]); // prettier-ignore
    else out.push([slot, v]);
  });
  return out.length ? out : null;
}

/**
 * Run one comb block in place. Returns the slots whose value it changed (a
 * Set, or null for none). `record` is called before each statement (the
 * debugger's frames).
 */
function runComb(block, vals, record) {
  const before = block.writes.map((w) => vals[w.slot]);
  const ctx = { vals, nba: [], trace: null, tx: null, written: null };
  if (record) {
    ctx.trace = (stmt) => record(stmt, ctx);
    ctx.written = new Map();
  }
  exec(block.body, ctx);
  applyNba(ctx);
  // A traced run starts from the values the chip was last seen at, where the
  // engine's evaluation starts every comb reg at x (`#fresh`): a bit the run
  // did not write — a full case meeting an x subject matches nothing, and has
  // no default — is x on the pins, so it is x here too. Otherwise the watch
  // shows the old value while the chip drives x.
  if (ctx.written) {
    for (const w of block.writes) {
      if (w.counter) continue;
      const unset = (w.mask & ~(ctx.written.get(w.slot) ?? 0)) >>> 0;
      if (unset) vals[w.slot] = withX(vals[w.slot], unset);
    }
  }
  let changed = null;
  block.writes.forEach((w, k) => {
    if (!sameValue(before[k], vals[w.slot])) (changed ??= new Set()).add(w.slot); // prettier-ignore
  });
  return changed;
}

/** Execute a compiled statement (analyze.js `compileStmt`). */
export function exec(stmt, ctx) {
  switch (stmt.kind) {
    case "null":
      return;
    case "block":
      for (const s of stmt.stmts) exec(s, ctx);
      return;
    case "assign": {
      ctx.trace?.(stmt);
      const value = V.resize(stmt.value(ctx.vals), stmt.w);
      const segments = stmt.target.resolve(ctx.vals);
      if (stmt.blocking) {
        writeSegments(ctx.vals, segments, value, ctx.tx, ctx.written);
      } else {
        ctx.nba.push([segments, value]);
      }
      return;
    }
    case "for": {
      // A loop the analyzer ran to its end already: it stops after the
      // number of passes it was proved to make (`max`), at the latest.
      ctx.trace?.(stmt);
      const segments = stmt.target.resolve(ctx.vals);
      writeSegments(ctx.vals, segments, V.resize(stmt.init(ctx.vals), stmt.w), ctx.tx); // prettier-ignore
      for (
        let n = 0;
        n < stmt.max && V.truthOf(stmt.cond(ctx.vals)) === "1";
        n++
      ) {
        // prettier-ignore
        exec(stmt.body, ctx);
        ctx.trace?.(stmt);
        writeSegments(ctx.vals, segments, V.resize(stmt.step(ctx.vals), stmt.w), ctx.tx); // prettier-ignore
      }
      return;
    }
    case "repeat": {
      ctx.trace?.(stmt);
      for (let n = 0; n < stmt.times; n++) {
        if (n) ctx.trace?.(stmt);
        exec(stmt.body, ctx);
      }
      return;
    }
    case "mark":
      // A loop's own line in an unrolled loop: somewhere to stop.
      ctx.trace?.(stmt);
      return;
    case "if": {
      ctx.trace?.(stmt);
      // An unknown condition takes the else branch, as Verilog's does.
      if (V.truthOf(stmt.cond(ctx.vals)) === "1") exec(stmt.then, ctx);
      else if (stmt.else) exec(stmt.else, ctx);
      return;
    }
    case "case": {
      ctx.trace?.(stmt);
      const subject = stmt.subject(ctx.vals);
      for (const item of stmt.items) {
        if (
          item.labels.some((label) =>
            matches(stmt.mode, subject, label(ctx.vals)),
          )
        ) {
          // prettier-ignore
          exec(item.body, ctx);
          return;
        }
      }
      if (stmt.default) exec(stmt.default, ctx);
      return;
    }
    default:
      return;
  }
}

/** Does a case label match its subject? `case` compares all four states
    exactly; `casez` ignores z (and ?) bits on either side; `casex` x and z. */
function matches(mode, a, b) {
  if (mode === "case") return V.same(a, b);
  const ignore = mode === "casez" ? (a.z | b.z) >>> 0 : (a.x | b.x) >>> 0;
  const m = (V.mask(a.w) & ~ignore) >>> 0;
  return ((a.v & m) >>> 0) === ((b.v & m) >>> 0) && ((a.x & m) >>> 0) === ((b.x & m) >>> 0); // prettier-ignore
}

/** Write a value across segments (most significant first); a `slot: -1`
    segment (an unknown index) consumes its bits and writes nothing, and an
    array word's segment (`mem`) writes that word. */
function writeSegments(vals, segments, value, tx = null, written = null) {
  let offset = value.w;
  for (const seg of segments) {
    offset -= seg.w;
    if (seg.slot < 0) continue;
    const bits = V.slice(value, offset, seg.w);
    if (seg.mem) vals[seg.slot] = writeWord(vals[seg.slot], seg.addr, bits, tx);
    else vals[seg.slot] = V.withBits(vals[seg.slot], seg.lo, bits);
    if (written && !seg.mem) {
      const bitsMask = (V.mask(seg.w) * 2 ** seg.lo) % 2 ** 32;
      written.set(seg.slot, ((written.get(seg.slot) ?? 0) | bitsMask) >>> 0);
    }
  }
}

/** `value` with the bits under `mask` made x. */
const withX = (value, mask) =>
  V.make(value.w, value.v & ~mask, value.x | mask, value.z & ~mask);

function applyNba(ctx) {
  if (!ctx.nba.length) return;
  const tx = ctx.tx ?? newTx();
  for (const [segments, value] of ctx.nba) writeSegments(ctx.vals, segments, value, tx, ctx.written); // prettier-ignore
  ctx.nba = [];
}

const samePackedOne = (a, b) => {
  if (isMemory(a) || isMemory(b)) return sameMemory(a, b);
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
};

function samePacked(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++)
    if (!samePackedOne(a[i], b[i])) return false;
  return true;
}
