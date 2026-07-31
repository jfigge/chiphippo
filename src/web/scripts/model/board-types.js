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
// downward from the strip's top-left origin. HORIZONTALLY everything is on the
// integer lattice — a column IS a pitch — which is why board origins stay
// integers and every hole in a row of strips lines up.
//
// VERTICALLY IT IS NOT, BECAUSE A REAL BREADBOARD IS NOT. The measurements
// below are off a physical 830 (see VERTICAL_MM): a rail is 8.9 mm tall and a
// pin-board 35.6 mm, neither of which is a whole number of pitches, and the
// channel is 2.3 mm — barely a third of the 7.62 mm between the hole rows it
// separates. Rounding those to 3 and 13 pitches (which is what this table used
// to do) compressed a 53.4 mm board into 48.3 mm: every hole was in the right
// place ACROSS the board and 5 mm out DOWN it, which is exactly what you see
// when you lay a real board against the screen.
//
// So the two axes are quantized differently, and only vertically is a strip's
// height fractional: heights and row offsets are exact multiples of 0.01 pitch
// (the same 2-decimal quantum wire waypoints use), so a stack of strips lands
// on values that survive a JSON round-trip and stay flush.
//
// WHAT STAYS INTEGER, DELIBERATELY: the pitch WITHIN a group of five rows (1),
// the spacing between a strip's two RAILS (1 = 2.54 mm), and the row spacing
// ACROSS the channel (3 = 7.62 mm = the 0.3-in row spacing every DIP is
// manufactured to — measured at 7.6, i.e. the same number). Every footprint
// that straddles the channel therefore stays exactly as it was; what moved is
// the plastic around the holes, not the holes.
//
// Layout (top → bottom), heights in pitch units (mm):
//   rail strip: `+` (red) at y=1.25, `-` (blue) at y=2.25 — height 3.50 (8.9).
//   pin-board:  rows j i h g f · channel (DIP chips straddle it, pins in f and
//               e) · rows e d c b a — height 14.02 (35.6).
//
// Rail holes come in groups of `railGroup` with ONE EXTRA pitch of gap
// between groups: hole k (1-based) sits at
//   x = railStartX + (k-1) + floor((k-1) / railGroup).
//
// Tie-point counts per kit (locked by tests):
//   Full 63×10 + 2×(2×50) = 830 · Half 30×10 + 2×(2×25) = 400 · Tiny 17×10 = 170.

import { MM_PER_UNIT } from "../desk/desk-geometry.js";

/**
 * The vertical geometry, MEASURED off a physical 830 breadboard in
 * millimetres — the form a ruler reads and the only form these can be checked
 * in. Everything below is derived from this block, so correcting a figure here
 * moves the drawing, the holes, the kit stack and the channel together.
 *
 *   total 53.4 = rail 8.9 + pinBoard 35.6 + rail 8.9 ✓
 *
 * THREE MEASUREMENTS, and the fourth number a ruler can reach — the 7.0 mm
 * between the closest pins either side of a rail↔pin-board join — is left
 * DERIVED, as the check that the two strips' margins agree with each other:
 * a rail's own margin (1.25) plus the pin-board's (1.51) is 2.76 pitch, 7.01 mm
 * (`tests/breadboard.test.js` holds it to that). It used to be an input, back
 * when the rail was 9.4 mm and its two rows fell out 3.05 mm apart; at 8.9 they
 * fall out exactly one pitch, which is what a rail really is.
 */
const VERTICAL_MM = Object.freeze({
  rail: 8.9,
  pinBoard: 35.6,
  channel: 2.3,
});

/** The 0.01-unit grid every vertical dimension here sits on (see the header: a
    fractional height has to survive a JSON round-trip and still leave a stack
    of strips flush). */
const q = (n) => Math.round(n * 100) / 100;

/** Millimetres → pitch units, on that grid. */
const u = (mm) => q(mm / MM_PER_UNIT);

/**
 * Heights are the measured plastic, not a count of pitches — 8.9 mm and
 * 35.6 mm, to the 0.01 unit. A stacked kit is 3.50 + 14.02 + 3.50 = 21.02
 * (53.39 mm against a real board's 53.4).
 */
const RAIL_HEIGHT = u(VERTICAL_MM.rail); // 3.50 — 8.9 mm
const PINS_HEIGHT = u(VERTICAL_MM.pinBoard); // 14.02 — 35.6 mm

/**
 * Row spacing ACROSS the channel, in pitch units. Integer on purpose: 3
 * pitches is 7.62 mm, which is the 0.3-in row spacing every DIP is made to and
 * (measured at 7.6 mm) what the board is drilled to. Keeping it whole is what
 * lets every trench-straddling footprint — the chips, the DIP switch banks,
 * bar8iso — stay exactly as they were while the plastic around them changes.
 */
const CHANNEL_SPAN = 3;

/** Plastic above row j / below row a: the pin-board's height less the 11
    pitches its ten rows span, halved — 1.51 units, 3.84 mm. */
const PIN_MARGIN = q((PINS_HEIGHT - (8 + CHANNEL_SPAN)) / 2);

/** Row letter → y, shared by every pin-board (they differ only in width). */
const PIN_ROW_Y = Object.freeze({
  j: PIN_MARGIN,
  i: PIN_MARGIN + 1,
  h: PIN_MARGIN + 2,
  g: PIN_MARGIN + 3,
  f: PIN_MARGIN + 4,
  e: PIN_MARGIN + 4 + CHANNEL_SPAN,
  d: PIN_MARGIN + 5 + CHANNEL_SPAN,
  c: PIN_MARGIN + 6 + CHANNEL_SPAN,
  b: PIN_MARGIN + 7 + CHANNEL_SPAN,
  a: PIN_MARGIN + 8 + CHANNEL_SPAN,
});

/**
 * The channel, shared by every pin-board: centred between rows f and e, and
 * only 2.3 mm wide — a THIRD of the 7.62 mm between those rows, where it used
 * to be drawn 5.08 mm and all but touch them. The rows do not move, so nothing
 * that straddles it moves either; there is simply plastic where there was a
 * groove.
 */
const PIN_TRENCH = Object.freeze({
  centerY: PIN_MARGIN + 4 + CHANNEL_SPAN / 2,
  height: u(VERTICAL_MM.channel), // 0.91 — 2.3 mm
});

/**
 * The two rails of a strip are ONE PITCH apart (2.54 mm) — whole, like the
 * spacing within a group of grid rows and across the channel, and for the same
 * reason: it is what the part is drilled to. Everything a user does between the
 * two rails then lands square, most visibly a resistor or LED bridging `+` to
 * `-`, whose one-pitch bend reaches the hole exactly rather than near it.
 */
const RAIL_SPAN = 1;

/** Plastic above the `+` row / below the `-` row: the rest of the strip's
    8.9 mm, halved, so the pair sits centred — 1.25 units, 3.18 mm. Which also
    settles the gap ACROSS a dovetail, this margin plus the pin-board's own:
    2.76 pitch, 7.01 mm, against 7.0 on the real part. */
const RAIL_MARGIN = q((RAIL_HEIGHT - RAIL_SPAN) / 2);

/**
 * A rail strip carries BOTH polarities, as the real part does — ids are the
 * bare polarity (`+`, `-`), so a rail hole address reads `bb2.+7`.
 */
const STRIP_RAILS = Object.freeze([
  Object.freeze({ id: "+", y: RAIL_MARGIN, polarity: "+" }),
  Object.freeze({ id: "-", y: q(RAIL_MARGIN + RAIL_SPAN), polarity: "-" }),
]);

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
 * built from, at offsets from the kit's origin. Placing a kit seats every strip
 * in one group, pre-snapped, exactly as a boxed breadboard arrives assembled.
 *
 * `dx` is an integer (the horizontal lattice); `dy` is each strip's measured
 * height, so the stack is 0 · 3.70 · 17.72 and the whole kit 21.42 units —
 * 54.41 mm, a real 830. Quantized through `q` so the stored value is the same
 * clean 2-decimal number whichever way it was summed.
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
        dy: q(RAIL_HEIGHT + PINS_HEIGHT),
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
        dy: q(RAIL_HEIGHT + PINS_HEIGHT),
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
