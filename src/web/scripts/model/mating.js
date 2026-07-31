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

// mating.js — how two breadboard strips dovetail, and the magnetic pull that
// helps a dragged one land that way.
//
// The rule is the real part's: strips mate only across an edge they MATCH on
// — same width when stacked, same height side by side — meeting flush, no gap
// and no overlap. Everything here is pure geometry in pitch units; who ends
// up in whose group is desk-doc's business.

import { boardSize } from "./breadboard.js";

/**
 * How close a dragged strip must come before it is pulled flush (pitch
 * units, on BOTH axes — a strip aligned in y but half a board away in x is
 * not "nearly mated", it is somewhere else).
 */
export const SNAP_RANGE = 2;

/**
 * A board's footprint on the desk, in pitch units — at its placed rotation,
 * so a rail stood on end is a tall thin rect. That is also what makes the
 * mating rule below orientation-aware for free: an upright rail (3 × 64) has
 * no edge that matches a flat one (64 × 3), so the two never snap together.
 */
export function boardRect(board) {
  const { width, height } = boardSize(board.type, board.rot ?? 0);
  return { x: board.x, y: board.y, width, height };
}

/**
 * How far apart two edges may be and still count as flush (pitch units).
 *
 * Flushness used to be exact `===`, which was safe while every strip height was
 * a whole pitch: a stack landed on integers and integers add exactly. Vertical
 * geometry is measured now (board-types.js), so a 3.70-tall rail under a
 * 14.02-tall board meets it at 17.72 — a sum of two values neither of which is
 * exactly representable in binary, and which can therefore land an ulp away
 * from the same number written down or read back from a file. A dovetail that
 * fails by 10^-15 of a millimetre is a kit that silently comes apart into
 * separate groups, so the test is a tolerance: far under a hole's own size, far
 * over any accumulation of float error.
 */
const FLUSH_EPS = 1e-6;

const near = (a, b) => Math.abs(a - b) <= FLUSH_EPS;

/**
 * Which edge of the rect `a` the rect `b` dovetails onto.
 *
 * @returns {"above"|"below"|"left"|"right"|null} null when they do not mate.
 */
export function rectMatingEdge(a, b) {
  if (near(a.x, b.x) && near(a.width, b.width)) {
    if (near(b.y + b.height, a.y)) return "above";
    if (near(a.y + a.height, b.y)) return "below";
  }
  if (near(a.y, b.y) && near(a.height, b.height)) {
    if (near(b.x + b.width, a.x)) return "left";
    if (near(a.x + a.width, b.x)) return "right";
  }
  return null;
}

/** `rectMatingEdge` for two boards (`{type, x, y}`). */
export function matingEdge(a, b) {
  return rectMatingEdge(boardRect(a), boardRect(b));
}

/**
 * Every way `m` could be nudged to dovetail onto `s`, as corrections to m's
 * position. Only edges the two MATCH on are offered, so a 400-point board
 * never snaps onto an 830's rail.
 */
function candidates(m, s) {
  const out = [];
  if (near(m.width, s.width)) {
    // Stacked: share the left edge, meet along one horizontal.
    out.push({ dx: s.x - m.x, dy: s.y + s.height - m.y }); // m below s
    out.push({ dx: s.x - m.x, dy: s.y - m.height - m.y }); // m above s
  }
  if (near(m.height, s.height)) {
    // Side by side: share the top edge, meet along one vertical.
    out.push({ dx: s.x + s.width - m.x, dy: s.y - m.y }); // m right of s
    out.push({ dx: s.x - m.width - m.x, dy: s.y - m.y }); // m left of s
  }
  return out;
}

/**
 * The magnetic pull on a set of moving strips: the smallest correction that
 * lands ONE of them flush against a stationary strip it can mate with, or
 * `{dx: 0, dy: 0}` when nothing is within `range` (or when a pair is already
 * flush — there is nothing to pull).
 *
 * The whole set moves by the winning correction, so a kit dragged near a
 * board snaps as one piece. The caller still owns legality: a pull that
 * would land the set on top of something is the caller's to reject.
 *
 * @param {Array<{x,y,width,height}>} moving - rects at the proposed position.
 * @param {Array<{x,y,width,height}>} stationary - every rect NOT moving.
 * @param {number} [range]
 * @returns {{dx: number, dy: number}}
 */
export function snapCorrection(moving, stationary, range = SNAP_RANGE) {
  const none = { dx: 0, dy: 0 };
  let best = null;
  let bestCost = Infinity;
  for (const m of moving) {
    for (const s of stationary) {
      for (const c of candidates(m, s)) {
        // The tolerance matters here too: a correction that lands a strip
        // flush against a MEASURED one is a difference of fractional heights,
        // so an exactly-in-range pull can come out as 2.0000000000000036 and
        // be discarded — the magnet silently dying at its own limit.
        if (
          Math.abs(c.dx) > range + FLUSH_EPS ||
          Math.abs(c.dy) > range + FLUSH_EPS
        )
          continue;
        // Already dovetailed: leave the drag exactly where the user put it.
        // Same tolerance as the flush test — a pair that `rectMatingEdge` calls
        // mated must not still read as pullable here, or a drag of an assembled
        // kit would be nudged by a rounding error every time it moved.
        if (near(c.dx, 0) && near(c.dy, 0)) return none;
        const cost = Math.abs(c.dx) + Math.abs(c.dy);
        if (cost < bestCost) {
          best = c;
          bestCost = cost;
        }
      }
    }
  }
  return best ?? none;
}
