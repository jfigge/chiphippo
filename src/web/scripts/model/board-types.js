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

// board-types.js — the data table for the breadboard STRIPS. Everything else
// (positions, counts, connectivity) derives from these specs in
// breadboard.js — no per-type code paths.
//
// A real breadboard is not one part: it is a centre PIN-BOARD plus one or two
// POWER-RAIL strips that dovetail onto its edges. Any strip mates with any
// other of matching width, which is why boards pushed together behave as one.
// We model that literally — each strip is its own entity in doc.boards, and
// BREADBOARD_KITS below describes the preset stacks the palette offers.
//
// All geometry is in PITCH UNITS (1 = 0.1 in = 2.54 mm), y increasing
// downward from the strip's top-left origin. Hole lattices are INTEGER
// offsets within the outline, and kit offsets are integers too, so a strip
// snapped to integers puts every hole on the global 0.1-in lattice.
//
// Layout (top → bottom):
//   rail strip: `+` (red) at y=1, `-` (blue) at y=2 — height 3.
//   pin-board:  rows j i h g f · trench (2 rows; DIP chips straddle it, pins
//               in f and e) · rows e d c b a — height 13.
//
// Rail holes come in groups of `railGroup` with ONE EXTRA pitch of gap
// between groups: hole k (1-based) sits at
//   x = railStartX + (k-1) + floor((k-1) / railGroup).
//
// Tie-point counts per kit (locked by tests):
//   Full 63×10 + 2×(2×50) = 830 · Half 30×10 + 2×(2×25) = 400 · Tiny 17×10 = 170.

/** Row letter → y, shared by every pin-board (they differ only in width). */
const PIN_ROW_Y = Object.freeze({
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
});

/** The trench, shared by every pin-board. */
const PIN_TRENCH = Object.freeze({ centerY: 6.5, height: 2 });

/**
 * A rail strip carries BOTH polarities, as the real part does — ids are the
 * bare polarity (`+`, `-`), so a rail hole address reads `bb2.+7`.
 */
const STRIP_RAILS = Object.freeze([
  Object.freeze({ id: "+", y: 1, polarity: "+" }),
  Object.freeze({ id: "-", y: 2, polarity: "-" }),
]);

/**
 * Heights chosen so the holes sit CENTRED in their plastic.
 *   Rail: rows at y=1,2 → midpoint 1.5 = 3/2. With the colour stripes (which
 *         reach 0.8 above the `+` row and 0.8 below the `-` row) the inked
 *         content spans 0.2 … 2.8, leaving equal 0.2 margins.
 *   Pins: rows at y=1…12 → midpoint 6.5 = 13/2, and the trench's centreY 6.5
 *         lands on the same axis.
 * A stacked kit is therefore 3 + 13 + 3 = 19 tall.
 */
const RAIL_HEIGHT = 3;
const PINS_HEIGHT = 13;

/** Fields a strip with no grid still has to carry for the derivations. */
const NO_GRID = Object.freeze({
  cols: 0,
  colStartX: 1,
  rowY: Object.freeze({}),
  trench: null,
});

/** Fields a strip with no rails still has to carry for the derivations. */
const NO_RAILS = Object.freeze({
  rails: Object.freeze([]),
  railHoles: 0,
  railGroup: 5,
  railStartX: 0,
});

export const BOARD_TYPES = Object.freeze({
  // ── Pin-boards (the centre strip) ──────────────────────────────────────
  // ~165 × 35 mm — 630 grid points.
  "pins-full": Object.freeze({
    key: "pins-full",
    label: "Full pin-board",
    kind: "pins",
    tiePoints: 630,
    width: 64,
    height: PINS_HEIGHT,
    cols: 63, // column c → x = colStartX + (c - 1)
    colStartX: 1,
    rowY: PIN_ROW_Y,
    trench: PIN_TRENCH,
    ...NO_RAILS,
  }),

  // ~82 × 35 mm — 300 grid points.
  "pins-half": Object.freeze({
    key: "pins-half",
    label: "Half pin-board",
    kind: "pins",
    tiePoints: 300,
    width: 31,
    height: PINS_HEIGHT,
    cols: 30,
    colStartX: 1,
    rowY: PIN_ROW_Y,
    trench: PIN_TRENCH,
    ...NO_RAILS,
  }),

  // ~45 × 35 mm — 170 grid points. The tiny board is a bare pin-board: the
  // real 170-point part ships with no rails at all.
  "pins-tiny": Object.freeze({
    key: "pins-tiny",
    label: "Tiny pin-board",
    kind: "pins",
    tiePoints: 170,
    width: 18,
    height: PINS_HEIGHT,
    cols: 17,
    colStartX: 1,
    rowY: PIN_ROW_Y,
    trench: PIN_TRENCH,
    ...NO_RAILS,
  }),

  // ── Power rails ────────────────────────────────────────────────────────
  // ~165 × 10 mm — 2 rails × 50 points.
  "rail-full": Object.freeze({
    key: "rail-full",
    label: "Full power rail",
    kind: "rail",
    tiePoints: 100,
    width: 64,
    height: RAIL_HEIGHT,
    rails: STRIP_RAILS,
    railHoles: 50, // per rail, in 10 groups of 5
    railGroup: 5,
    railStartX: 3,
    ...NO_GRID,
  }),

  // ~82 × 10 mm — 2 rails × 25 points.
  "rail-half": Object.freeze({
    key: "rail-half",
    label: "Half power rail",
    kind: "rail",
    tiePoints: 50,
    width: 31,
    height: RAIL_HEIGHT,
    rails: STRIP_RAILS,
    railHoles: 25, // per rail, in 5 groups of 5
    railGroup: 5,
    railStartX: 2,
    ...NO_GRID,
  }),
});

/** The valid strip-type keys. */
export const BOARD_TYPE_KEYS = Object.freeze(Object.keys(BOARD_TYPES));

/**
 * The preset breadboards the palette offers: a size key → the strips it is
 * built from, at integer offsets from the kit's origin. Placing a kit seats
 * every strip in one group, pre-snapped, exactly as a boxed breadboard
 * arrives assembled.
 *
 * The full/half offsets reproduce the classic rail rows — top `+` at y=1,
 * bottom `+` at y=19 — so a kit is visually identical to the old one-piece
 * board (22 tall rather than 21.7, which buys integer strip origins).
 */
export const BREADBOARD_KITS = Object.freeze({
  full: Object.freeze({
    key: "full",
    label: "Full-size",
    tiePoints: 830,
    strips: Object.freeze([
      Object.freeze({ type: "rail-full", dx: 0, dy: 0 }),
      Object.freeze({ type: "pins-full", dx: 0, dy: RAIL_HEIGHT }),
      Object.freeze({
        type: "rail-full",
        dx: 0,
        dy: RAIL_HEIGHT + PINS_HEIGHT,
      }),
    ]),
  }),

  half: Object.freeze({
    key: "half",
    label: "Half-size",
    tiePoints: 400,
    strips: Object.freeze([
      Object.freeze({ type: "rail-half", dx: 0, dy: 0 }),
      Object.freeze({ type: "pins-half", dx: 0, dy: RAIL_HEIGHT }),
      Object.freeze({
        type: "rail-half",
        dx: 0,
        dy: RAIL_HEIGHT + PINS_HEIGHT,
      }),
    ]),
  }),

  tiny: Object.freeze({
    key: "tiny",
    label: "Tiny",
    tiePoints: 170,
    strips: Object.freeze([Object.freeze({ type: "pins-tiny", dx: 0, dy: 0 })]),
  }),

  // ── Loose strips ───────────────────────────────────────────────────────
  // The parts on their own, as they come out of the bag: a bare pin-board to
  // dovetail rails onto, or a spare rail for a board that shipped without
  // enough of them. Each kit key matches its strip type — the kit IS that one
  // strip. (Tiny is absent: its bare pin-board is already the `tiny` kit.)
  "pins-full": Object.freeze({
    key: "pins-full",
    label: "Full pin-board",
    tiePoints: 630,
    strips: Object.freeze([Object.freeze({ type: "pins-full", dx: 0, dy: 0 })]),
  }),

  "pins-half": Object.freeze({
    key: "pins-half",
    label: "Half pin-board",
    tiePoints: 300,
    strips: Object.freeze([Object.freeze({ type: "pins-half", dx: 0, dy: 0 })]),
  }),

  "rail-full": Object.freeze({
    key: "rail-full",
    label: "Full power rail",
    tiePoints: 100,
    strips: Object.freeze([Object.freeze({ type: "rail-full", dx: 0, dy: 0 })]),
  }),

  "rail-half": Object.freeze({
    key: "rail-half",
    label: "Half power rail",
    tiePoints: 50,
    strips: Object.freeze([Object.freeze({ type: "rail-half", dx: 0, dy: 0 })]),
  }),
});

/** The assembled-breadboard kit keys, in menu order. */
export const KIT_KEYS = Object.freeze(["full", "half", "tiny"]);

/** The loose single-strip kit keys, in menu order. */
export const STRIP_KIT_KEYS = Object.freeze([
  "pins-full",
  "pins-half",
  "rail-full",
  "rail-half",
]);

/** Every placeable kit key — assembled breadboards first, then loose strips. */
export const ALL_KIT_KEYS = Object.freeze([...KIT_KEYS, ...STRIP_KIT_KEYS]);
