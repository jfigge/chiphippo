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
 * Which edge of the rect `a` the rect `b` dovetails onto.
 *
 * @returns {"above"|"below"|"left"|"right"|null} null when they do not mate.
 */
export function rectMatingEdge(a, b) {
  if (a.x === b.x && a.width === b.width) {
    if (b.y + b.height === a.y) return "above";
    if (a.y + a.height === b.y) return "below";
  }
  if (a.y === b.y && a.height === b.height) {
    if (b.x + b.width === a.x) return "left";
    if (a.x + a.width === b.x) return "right";
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
  if (m.width === s.width) {
    // Stacked: share the left edge, meet along one horizontal.
    out.push({ dx: s.x - m.x, dy: s.y + s.height - m.y }); // m below s
    out.push({ dx: s.x - m.x, dy: s.y - m.height - m.y }); // m above s
  }
  if (m.height === s.height) {
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
        if (Math.abs(c.dx) > range || Math.abs(c.dy) > range) continue;
        // Already dovetailed: leave the drag exactly where the user put it.
        if (c.dx === 0 && c.dy === 0) return none;
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
