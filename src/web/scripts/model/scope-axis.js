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

// scope-axis.js — where the logic analyzer puts each recorded column across
// its lanes. Pure and DOM-free: the view hands it the recorder's columns and
// draws at the x positions it hands back. Two modes over the same columns:
//
//   timing       x IS simulated time — each column at its own `at` (the
//                moment its tick ran), at a per-division scale the user zooms
//                through a 1-2-5 ladder, or fitted to the panel. A level
//                holds from its sample to the next. A voltage is joined
//                straight to a CURVE sample (`joined`) — Spice Lite reads the
//                curves between two ticks as finely as they bend (spice/
//                sample.js `scopeSamples`), so the chords ARE the curve —
//                and held to a TICK's moment and stepped there: a tick is an
//                event, and whatever it moved, it moved at once.
//   transitions  x advances by CHANGE — the LOGIC view: a column where any
//                watched level or bus word changed gets a fixed slice; a run
//                of columns where none did folds into one narrow break,
//                marked so the eye knows time was cut out there. A voltage
//                is not drawn here (scope-view.js draws the level its inputs
//                read): spaced by change rather than time its curve says
//                nothing, and a voltage that moves at every sample would
//                never fold.
//
// The analyzer samples on the engine's own events (every tick, plus Spice
// Lite's curve samples between ticks — spice/sample.js `scopeSamples`),
// never on a clock of its own.

/** The two x-axis modes, the first the default. */
export const AXIS_MODES = Object.freeze(["timing", "transitions"]);

/** A stored mode, or the default for anything that is not one. */
export function normalizeAxisMode(mode) {
  return AXIS_MODES.includes(mode) ? mode : AXIS_MODES[0];
}

/** One division's width, CSS px (timing mode's grid). */
export const PX_PER_DIV = 100;

/** A transition's slice, and a folded steady run's break, CSS px. */
export const SLICE_PX = 10;
/** A drawn cycle's stretch in Transitions: one block, labelled with its true
    rate (scope-view.js), CSS px. */
export const BLOCK_PX = 64;
export const BREAK_PX = 4;

/** The widest the lanes may become, CSS px — under the 2^24 a browser lays
    out and scrolls without losing precision. A zoom that would pass it is
    refused, and a growing trace at a fixed scale steps the scale out. */
export const MAX_TRACK_PX = 16_000_000;

/** Seconds per division, 1-2-5 from 100 ns to 5000 s. */
export const SEC_PER_DIV = Object.freeze(
  (() => {
    const out = [];
    for (let e = -7; e <= 3; e += 1) {
      for (const m of [1, 2, 5]) out.push(Number((m * 10 ** e).toPrecision(1)));
    }
    return out;
  })(),
);

/** The ladder index at or above `secPerDiv` (the last for anything past it). */
function ladderIndex(secPerDiv) {
  const i = SEC_PER_DIV.findIndex((s) => s >= secPerDiv * (1 - 1e-9));
  return i === -1 ? SEC_PER_DIV.length - 1 : i;
}

/**
 * The finest ladder scale that shows `span` seconds within `widthPx` — what
 * Fit uses, and the floor a fixed scale is held to as the trace grows.
 * @param {number} span - seconds
 * @param {number} widthPx
 */
export function fitSecPerDiv(span, widthPx) {
  const divisions = Math.max(1, widthPx / PX_PER_DIV);
  if (!(span > 0)) return SEC_PER_DIV[0];
  return SEC_PER_DIV[ladderIndex(span / divisions)];
}

/** The finest scale a `span` may be drawn at within MAX_TRACK_PX. */
export function minSecPerDiv(span) {
  return fitSecPerDiv(span, MAX_TRACK_PX);
}

/**
 * One ladder step from `secPerDiv`: `+1` coarser (zoom out), `-1` finer (zoom
 * in), held to the ladder's ends and to `floor` (minSecPerDiv of the trace).
 */
export function stepSecPerDiv(secPerDiv, dir, floor = SEC_PER_DIV[0]) {
  const i = ladderIndex(secPerDiv) + Math.sign(dir);
  const next = SEC_PER_DIV[Math.max(0, Math.min(SEC_PER_DIV.length - 1, i))];
  return Math.max(next, floor);
}

/**
 * Each column's simulated moment, seconds, never going back: a column with
 * no `at` (a hand-fed recording; every run's columns carry one) sits at the
 * one before it.
 * @param {Array<{at?: number}>} columns
 * @returns {Float64Array}
 */
export function columnTimes(columns) {
  const times = new Float64Array(columns.length);
  let last = 0;
  columns.forEach((col, k) => {
    const at = Number.isFinite(col.at) ? col.at : last;
    last = k === 0 ? at : Math.max(last, at);
    times[k] = last;
  });
  return times;
}

/**
 * The timing axis: column k's left edge at its own moment, the trace's right
 * edge at `end` (the latest moment the run has reported, never before the
 * last column).
 * @param {Array<{at?: number}>} columns
 * @param {{secPerDiv: number, end?: number}} opts
 * @returns {{xs: Float64Array, width: number, t0: number, pxPerSec: number,
 *   times: Float64Array}} `xs` has one more entry than there are columns:
 *   the last is the right edge.
 */
export function timingAxis(columns, { secPerDiv, end = -Infinity }) {
  const times = columnTimes(columns);
  const n = columns.length;
  const xs = new Float64Array(n + 1);
  const t0 = n ? times[0] : 0;
  const tEnd = n ? Math.max(times[n - 1], Number.isFinite(end) ? end : -Infinity) : 0; // prettier-ignore
  const pxPerSec = PX_PER_DIV / secPerDiv;
  for (let k = 0; k < n; k += 1) xs[k] = (times[k] - t0) * pxPerSec;
  xs[n] = (tEnd - t0) * pxPerSec;
  return { xs, width: xs[n], t0, pxPerSec, times };
}

/** Whether a channel's cell (a level, a bus word) differs from the one last
    shown — by identity; a voltage is no change of its own here. */
function moved(shown, cell) {
  return !shown || cell !== shown.cell;
}

/**
 * The transitions axis: a column where any of `channelIds` changed level
 * (or bus word) gets `SLICE_PX`; a run of columns where none
 * did is FOLDED to nothing. A fold that stands for real time — more than
 * `MARK_STEPS` of the trace's typical step between samples — keeps a
 * `BREAK_PX` break and is listed in `breaks` with the stretch it stands for,
 * from the transition before it to the one after (or the trace's end). A
 * short one is a value sampled finer than it changed (a node creeping in
 * between two ticks, a fast clock under a slow signal's edge) and is folded
 * silently: marked, it would comb the lanes with breaks that say
 * nothing.
 * @param {Array<{at?: number, cells: Map}>} columns
 * @param {string[]} channelIds - the channels drawn
 * @param {{end?: number, periodic?: Map<string, object[]>|null}} [opts] -
 *   `periodic`: each channel's drawn-cycle stretches (model/scope-periodic.js)
 * @returns {{xs: Float64Array, width: number, times: Float64Array,
 *   breaks: Array<{x: number, from: number, to: number}>,
 *   changed: Uint8Array, blocks: Array<{id: string, span: object, k0: number,
 *   k1: number}>}}
 */
export function transitionAxis(
  columns,
  channelIds,
  { end = -Infinity, periodic = null } = {},
) {
  const times = columnTimes(columns);
  const n = columns.length;
  const changed = new Uint8Array(n);
  const wide = new Uint8Array(n); // a block begins: BLOCK_PX, not SLICE_PX
  const shown = new Map(); // channel id → {cell} last shown
  // A channel's drawn-cycle stretch (`periodic`: id → [{from, to, …}], model/
  // scope-periodic.js) is ONE block: its start a change, its slowed picture's
  // edges inside it none (they are no true moments), and no break marked
  // inside it — the block says what is there.
  const blocks = [];
  const inBlock = new Map(); // channel id → its block open at this column
  const spanOf = (id, at) => {
    for (const sp of periodic?.get(id) ?? []) if (at >= sp.from && at <= sp.to) return sp; // prettier-ignore
    return null;
  };
  // Which columns moved, and the folds between them: {at, from, to}, `at`
  // the fold's first column.
  const folds = [];
  let lastChange = null;
  let open = null;
  for (let k = 0; k < n; k += 1) {
    const col = columns[k];
    let any = k === 0;
    let blocked = false;
    for (const id of channelIds) {
      const cell = col.cells.get(id) ?? null;
      const sp = periodic ? spanOf(id, times[k]) : null;
      const was = inBlock.get(id);
      if (sp) {
        blocked = true;
        shown.set(id, { cell });
        if (was?.span === sp) {
          was.k1 = k;
          continue;
        }
        const block = { id, span: sp, k0: k, k1: k };
        blocks.push(block);
        inBlock.set(id, block);
        any = true;
        wide[k] = 1;
        continue;
      }
      if (was) {
        inBlock.delete(id);
        any = true; // the stretch ended: what follows is shown afresh
      }
      if (moved(shown.get(id), cell)) {
        shown.set(id, { cell });
        any = true;
      }
    }
    if (any) {
      if (open) open.to = times[k];
      open = null;
      changed[k] = 1;
      lastChange = times[k];
    } else if (!open) {
      open = { at: k, from: lastChange ?? times[k], to: times[k], blocked };
      folds.push(open);
    }
  }
  if (open) open.to = Math.max(open.to, times[n - 1] ?? 0, Number.isFinite(end) ? end : -Infinity); // prettier-ignore

  const markOver = MARK_STEPS * typicalStep(times);
  const marked = new Set(folds.filter((f) => !f.blocked && f.to - f.from > markOver)); // prettier-ignore
  const foldAt = new Map(folds.map((f) => [f.at, f]));
  const xs = new Float64Array(n + 1);
  const breaks = [];
  let x = 0;
  for (let k = 0; k < n; k += 1) {
    xs[k] = x;
    if (changed[k]) x += wide[k] ? BLOCK_PX : SLICE_PX;
    const fold = foldAt.get(k);
    if (fold && marked.has(fold)) {
      breaks.push({ x, from: fold.from, to: fold.to });
      x += BREAK_PX;
    }
  }
  xs[n] = x;
  return { xs, width: x, times, breaks, changed, blocks };
}

/** How many of the trace's typical steps a fold must stand for to be
    marked. */
export const MARK_STEPS = 4;

/** The median time between two samples that are not at the same moment
    (0 for a trace with none). */
function typicalStep(times) {
  const steps = [];
  for (let k = 1; k < times.length; k += 1) {
    const dt = times[k] - times[k - 1];
    if (dt > 0) steps.push(dt);
  }
  if (!steps.length) return 0;
  steps.sort((a, b) => a - b);
  return steps[steps.length >> 1];
}

/**
 * Whether column `k` continues the curve from the one before — a sample read
 * off the curves between two ticks (`curve`, the sim-tick's `sample`) — or
 * is a tick, the line held flat to its moment and stepped there.
 * @param {Array<{curve?: boolean}>} columns
 * @param {number} k
 */
export function joined(columns, k) {
  return k > 0 && columns[k]?.curve === true;
}

/**
 * The column under `x`: the last whose left edge is at or before it (a
 * folded column has no width, so a break reads as the transition it holds).
 * @param {Float64Array} xs - an axis's edges (one more than columns)
 * @param {number} x
 * @returns {number} a column index, 0 … n-1 (0 for an empty axis)
 */
export function columnAtX(xs, x) {
  const n = xs.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
