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

// board-types.js — the data table for the three breadboard types. Everything
// else (positions, counts, connectivity) derives from these specs in
// breadboard.js — no per-type code paths.
//
// All geometry is in PITCH UNITS (1 = 0.1 in = 2.54 mm), y increasing
// downward from the board's top-left origin. Hole lattices are INTEGER
// offsets within the outline, so a board whose desk position is snapped to
// integers puts every hole on the global 0.1-in lattice.
//
// Layout (top → bottom), matching the real parts:
//   Full/Half: rails `t+` (red), `t-` (blue) · gap · rows j i h g f ·
//              trench (2 rows; DIP chips straddle it, pins in f and e) ·
//              rows e d c b a · gap · rails `b+` (red), `b-` (blue).
//   Tiny:      rows j…f · trench · rows e…a — no rails.
//
// Rail holes come in groups of `railGroup` with ONE EXTRA pitch of gap
// between groups: hole k (1-based) sits at
//   x = railStartX + (k-1) + floor((k-1) / railGroup).
//
// Tie-point counts (locked by tests):
//   Full 63×10 + 4×50 = 830 · Half 30×10 + 4×25 = 400 · Tiny 17×10 = 170.

/** Row letter → y for the Full/Half vertical layout (55 mm ≈ 21.7 tall). */
const STANDARD_ROW_Y = Object.freeze({
  j: 5,
  i: 6,
  h: 7,
  g: 8,
  f: 9,
  e: 12,
  d: 13,
  c: 14,
  b: 15,
  a: 16,
});

/** Rail rows for the Full/Half layout (ids are ASCII: `t-`, not `t−`). */
const STANDARD_RAILS = Object.freeze([
  Object.freeze({ id: "t+", y: 1, polarity: "+" }),
  Object.freeze({ id: "t-", y: 2, polarity: "-" }),
  Object.freeze({ id: "b+", y: 19, polarity: "+" }),
  Object.freeze({ id: "b-", y: 20, polarity: "-" }),
]);

export const BOARD_TYPES = Object.freeze({
  // ~165 × 55 mm — 630 grid points + 200 rail points.
  full: Object.freeze({
    key: "full",
    label: "Full-size",
    tiePoints: 830,
    width: 65,
    height: 21.7,
    cols: 63,
    colStartX: 1, // column c → x = colStartX + (c - 1)
    rowY: STANDARD_ROW_Y,
    trench: Object.freeze({ centerY: 10.5, height: 2 }),
    rails: STANDARD_RAILS,
    railHoles: 50, // per rail, in 10 groups of 5
    railGroup: 5,
    railStartX: 3,
  }),

  // ~82 × 55 mm — 300 grid points + 100 rail points.
  half: Object.freeze({
    key: "half",
    label: "Half-size",
    tiePoints: 400,
    width: 32.3,
    height: 21.7,
    cols: 30,
    colStartX: 1,
    rowY: STANDARD_ROW_Y,
    trench: Object.freeze({ centerY: 10.5, height: 2 }),
    rails: STANDARD_RAILS,
    railHoles: 25, // per rail, in 5 groups of 5
    railGroup: 5,
    railStartX: 2,
  }),

  // ~45 × 34.5 mm — 170 grid points, no rails.
  tiny: Object.freeze({
    key: "tiny",
    label: "Tiny",
    tiePoints: 170,
    width: 17.7,
    height: 13.6,
    cols: 17,
    colStartX: 1,
    rowY: Object.freeze({
      j: 1,
      i: 2,
      h: 3,
      g: 4,
      f: 5,
      e: 8,
      d: 9,
      c: 10,
      b: 11,
      a: 12,
    }),
    trench: Object.freeze({ centerY: 6.5, height: 2 }),
    rails: Object.freeze([]),
    railHoles: 0,
    railGroup: 5,
    railStartX: 0,
  }),
});

/** The valid board-type keys, in menu order. */
export const BOARD_TYPE_KEYS = Object.freeze(["full", "half", "tiny"]);
