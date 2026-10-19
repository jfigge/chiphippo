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

// footprints.js — pure pin→hole derivation for DIP packages. A DIP-2n seats
// across the trench with the standard counterclockwise numbering, notch LEFT
// (no rotation in v1):
//
//     f:  2n … n+1        ← pins n+1…2n run right→left along the UPPER row
//         ┌─────────┐
//       ◖ │  74xx   │      ← notch at the left end
//         └─────────┘
//     e:  1  2  …  n       ← pins 1…n run left→right along the LOWER row
//
// Pin 1 sits at the component's ANCHOR hole; every other pin position is
// DERIVED from the package + anchor — never stored.
//
// `body` is the package's real body width in mils, and it decides which two
// rows the pins take (`dipRows`). A 300-mil part (0.3-in row spacing — every
// logic DIP up to DIP-20, and the DIP switch banks) seats in rows e and f, the
// 3 pitches straight across the trench. A 600-mil part (DIP-24…40: the wide
// memories and the processors) is twice that, 6 pitches, and there are four
// pairs of rows that far apart across the trench: b/f, c/g, d/h and e/i. Its
// body stands over the three rows between its pins — holes nothing else may
// use (`coveredHoles`; occupancy.js claims them for the chip). Every one of
// those seats makes the same connections: each half-column is one strip, so
// only which holes are blocked differs.
//
// THE ANCHOR'S ROW SAYS WHICH — with one exception. A 600-mil part anchored in
// row e is the narrow e/f seat every DIP took before wide seating existed
// (2026-10-05): a desk saved then keeps it exactly, and the generators (the AI
// builder's compiler, the demo benches) still seat every DIP there. So the
// e/i seat is the one that has to say so: `params.wide` (`WIDE_PARAM`), kept
// only on a 600-mil chip in row e (`withSeat`). Placing a part, or moving one
// on its own, seats it at its true width in whichever of the four the pointer
// is nearest (seating.js); a selection dragged or pasted as a group moves
// rigidly, so each chip in it keeps the seat it had.

import { isVeroHoleId, shiftVeroHole } from "./breadboard.js";

/** The DIP packages the catalog may reference. `body` is the width in mils.
    DIP-2/DIP-4 began as the bodies the 1- and 2-position DIP switch banks
    come in (catalog/parts.js's dipSwitchBankDef) — a PC817 is a DIP-4 too,
    a 4N35 a DIP-6; every derivation below is generic over any even pin
    count. */
export const DIP_PACKAGES = Object.freeze({
  "DIP-2": Object.freeze({ pins: 2, body: 300 }),
  "DIP-4": Object.freeze({ pins: 4, body: 300 }),
  "DIP-6": Object.freeze({ pins: 6, body: 300 }),
  "DIP-8": Object.freeze({ pins: 8, body: 300 }),
  "DIP-14": Object.freeze({ pins: 14, body: 300 }),
  "DIP-16": Object.freeze({ pins: 16, body: 300 }),
  "DIP-20": Object.freeze({ pins: 20, body: 300 }),
  "DIP-24": Object.freeze({ pins: 24, body: 600 }),
  "DIP-28": Object.freeze({ pins: 28, body: 600 }),
  "DIP-32": Object.freeze({ pins: 32, body: 600 }),
  "DIP-40": Object.freeze({ pins: 40, body: 600 }),
  // A 6 mm tactile button (sw-tact): four legs on a 6.5 × 4.5 mm rectangle,
  // which a breadboard takes straddling the trench with its legs TWO columns
  // apart — the 4.5 mm side cannot go in neighbouring holes. `pitch` is the
  // column step between a row's pins (1 everywhere else); the column between
  // them lies under the body (`coveredHoles`).
  "TACT-4": Object.freeze({ pins: 4, body: 300, pitch: 2 }),
});

/**
 * A CUSTOM chip's package (the chip designer): any even pin count from 4 to
 * 40 at either body width, named with its width spelled out — `DIP-18-300`,
 * `DIP-14-600` — wherever the table above has no entry that means it. Parsed
 * rather than listed, so the table stays the catalog's own short list.
 */
const CUSTOM_PACKAGE_RE = /^DIP-(\d{1,2})-(300|600)$/;
export const MIN_CUSTOM_PINS = 4;
export const MAX_CUSTOM_PINS = 40;

/** The package name for a pin count and body width: the table's own name when
    it has one of that width, else the spelled-out form. */
export function packageName(pins, body) {
  const listed = `DIP-${pins}`;
  if (DIP_PACKAGES[listed]?.body === body) return listed;
  return `${listed}-${body}`;
}

function parsedPackage(pkg) {
  const m = CUSTOM_PACKAGE_RE.exec(String(pkg));
  if (!m) return null;
  const pins = Number(m[1]);
  if (pins % 2 || pins < MIN_CUSTOM_PINS || pins > MAX_CUSTOM_PINS) return null;
  return { pins, body: Number(m[2]) };
}

/**
 * The package table entry (throws code INVALID_PACKAGE on junk). `pitch` is
 * the column step between neighbouring pins of a row (1 but for the tactile
 * button's TACT-4) and `colSpan` the columns from pin 1 to the far end of its
 * row — `halfPins - 1` for every DIP, the extent a seat must clamp to.
 * @returns {{ pins: number, halfPins: number, body: number, pitch: number,
 *   colSpan: number }}
 */
export function packageSpec(pkg) {
  const p = DIP_PACKAGES[pkg] ?? parsedPackage(pkg);
  if (!p) {
    const err = new Error(`unknown package: ${pkg}`);
    err.code = "INVALID_PACKAGE";
    throw err;
  }
  const halfPins = p.pins / 2;
  const pitch = p.pitch ?? 1;
  return {
    pins: p.pins,
    halfPins,
    body: p.body,
    pitch,
    colSpan: (halfPins - 1) * pitch,
  };
}

/** The two pin rows of a DIP seated across the trench, the span between
    them in pitches (integer by design — one pitch per row, three across the
    channel), and the rows its body covers. */
const NARROW = Object.freeze({
  lower: "e",
  upper: "f",
  span: 3,
  covers: Object.freeze([]),
});
/** The 600-mil seats by pin 1's row: pins six pitches apart across the
    trench, the body over the three rows between. d/h is the one a new seat
    takes with nothing to say otherwise (`seatRow`). */
const wideSeat = (lower, upper, covers) =>
  Object.freeze({ lower, upper, span: 6, covers: Object.freeze(covers) });
const WIDE_SEATS = Object.freeze({
  b: wideSeat("b", "f", ["c", "d", "e"]),
  c: wideSeat("c", "g", ["d", "e", "f"]),
  d: wideSeat("d", "h", ["e", "f", "g"]),
  e: wideSeat("e", "i", ["f", "g", "h"]),
});
const WIDE = WIDE_SEATS.d;

/** The rows pin 1 of a 600-mil part may take at its true width. */
export const WIDE_SEAT_ROWS = Object.freeze(Object.keys(WIDE_SEATS));

/** The chip param that puts a 600-mil part anchored in row e in the wide e/i
    seat rather than the narrow e/f one. */
export const WIDE_PARAM = "wide";

/** Is this a 600-mil package (its pins six pitches apart, not three)? */
export function isWidePackage(pkg) {
  return packageSpec(pkg).body >= 600;
}

/**
 * The row pin 1 takes when a package is PLACED (or moved) with nothing to
 * choose between seats: d for a 600-mil package, e for everything else.
 * @returns {"d"|"e"}
 */
export function seatRow(pkg) {
  return isWidePackage(pkg) ? WIDE.lower : NARROW.lower;
}

/**
 * The rows a package's pins take with pin 1 anchored in `anchorRow` —
 * `{ lower, upper, span, covers }` — or null for a row it cannot anchor in.
 * Row e is every package's narrow seat, unless `wide` puts a 600-mil one in
 * rows e and i; rows b, c and d are a 600-mil package's other wide seats.
 */
export function dipRows(pkg, anchorRow = seatRow(pkg), wide = false) {
  const isWide = isWidePackage(pkg); // junk throws INVALID_PACKAGE
  if (anchorRow === NARROW.lower && !(wide && isWide)) return NARROW;
  return (isWide && WIDE_SEATS[anchorRow]) || null;
}

/** Does a chip's params ask for the wide e/i seat (`WIDE_PARAM`)? */
export function seatsWide(params) {
  return params?.[WIDE_PARAM] === true;
}

/**
 * `dipRows` for a SEATED chip: pin 1's row read off its anchor hole ("d12"),
 * the e/i marker off its params. Null when it cannot seat there.
 */
export function seatedRows(pkg, anchor, params) {
  return dipRows(pkg, String(anchor ?? "").charAt(0), seatsWide(params));
}

/**
 * A chip's params for a seat with pin 1 in `anchorRow`: the e/i marker set
 * when the seat is that one, and dropped everywhere else — the anchor row says
 * all the other seats by itself.
 * @returns {object} a copy
 */
export function withSeat(pkg, params, anchorRow, wide) {
  const { [WIDE_PARAM]: _was, ...rest } = params ?? {};
  return anchorRow === NARROW.lower && wide && isWidePackage(pkg)
    ? { ...rest, [WIDE_PARAM]: true }
    : rest;
}

/**
 * Row + column offset of one pin relative to the anchor column (pin 1's
 * column), for a package anchored in `anchorRow` (by default the row it is
 * placed in now — `seatRow`). Returns null for a pin number outside the
 * package, or an anchor row it cannot seat in. `wide` is the e/i seat's
 * marker (`dipRows`).
 * @returns {{ row: string, dcol: number }|null}
 */
export function pinOffset(pkg, pin, anchorRow = seatRow(pkg), wide = false) {
  const { pins, halfPins, pitch } = packageSpec(pkg);
  const rows = dipRows(pkg, anchorRow, wide);
  if (!rows) return null;
  if (!Number.isInteger(pin) || pin < 1 || pin > pins) return null;
  return pin <= halfPins
    ? { row: rows.lower, dcol: (pin - 1) * pitch } // 1…n left→right, lower row
    : { row: rows.upper, dcol: (pins - pin) * pitch }; // n+1…2n right→left
}

/**
 * Every pin's seated hole for a package anchored at `anchorCol` (pin 1's
 * column) in `anchorRow` (`wide`: the e/i seat — `dipRows`) — empty when it
 * cannot anchor there.
 * @returns {Array<{ pin: number, row: string, col: number }>}
 */
export function allPinHoles(
  pkg,
  anchorCol,
  anchorRow = seatRow(pkg),
  wide = false,
) {
  const { pins } = packageSpec(pkg);
  if (!dipRows(pkg, anchorRow, wide)) return [];
  const out = [];
  for (let pin = 1; pin <= pins; pin++) {
    const { row, dcol } = pinOffset(pkg, pin, anchorRow, wide);
    out.push({ pin, row, col: anchorCol + dcol });
  }
  return out;
}

/**
 * The holes a seated package's BODY stands over — between its two pin rows, in
 * each of its columns: the three rows between a 600-mil part's pins at its true
 * width (e, f and g in the d/h seat), nothing under a narrow seat (only the trench lies between rows e and f). A
 * real part's plastic is in the way of those holes, so nothing may be plugged
 * into one. A package whose pins are more than a column apart (`pitch`) also
 * stands over the holes BETWEEN its pins, in its own pin rows.
 * @returns {Array<{ row: string, col: number }>}
 */
export function coveredHoles(
  pkg,
  anchorCol,
  anchorRow = seatRow(pkg),
  wide = false,
) {
  const { pitch, colSpan } = packageSpec(pkg);
  const rows = dipRows(pkg, anchorRow, wide);
  if (!rows) return [];
  const out = [];
  for (const row of rows.covers) {
    for (let dcol = 0; dcol <= colSpan; dcol++) {
      out.push({ row, col: anchorCol + dcol });
    }
  }
  if (pitch > 1) {
    for (const row of [rows.lower, rows.upper]) {
      for (let dcol = 0; dcol <= colSpan; dcol++) {
        if (dcol % pitch) out.push({ row, col: anchorCol + dcol });
      }
    }
  }
  return out;
}

// ── On a veroboard ──────────────────────────────────────────────────────────
// No trench and no lettered rows: a DIP sits across the copper strips with
// every pin on a strip of its own (the strip between its two rows is the
// builder's to cut). Pin 1 anchors at its hole (`C14`) in the LOWER row, pins
// 1…n run left→right along it, n+1…2n right→left along the row the package's
// width puts above — 3 holes up for a 300-mil body, 6 for a 600-mil one. The
// width is the package's own: there is no seat to choose.

/** What a DIP's "seat" is on a veroboard, where the seat is not a row: any
    hole will do, and the width is the package's. A group move keeps a
    chip's seat (cluster-move.js, paste-cluster.js) — on a veroboard that is
    simply staying on a veroboard. */
export const VERO_SEAT = "vero";

/**
 * The seat a chip anchored at `anchor` is in, as a group move compares it:
 * pin 1's ROW on a pin-board (which says its width — `dipRows`), VERO_SEAT on
 * a veroboard.
 */
export function seatClassOf(anchor) {
  return isVeroHoleId(anchor) ? VERO_SEAT : String(anchor ?? "").charAt(0);
}

/** Holes between a package's two pin rows on a veroboard. */
export function veroRowSpan(pkg) {
  return isWidePackage(pkg) ? WIDE.span : NARROW.span;
}

/**
 * Every pin's hole for a package anchored at veroboard hole `anchor` — `[]`
 * when the anchor is not a veroboard hole or the package runs off the top or
 * left of the lattice (whether the board is big enough is the caller's
 * `parseHole`).
 * @returns {Array<{ pin: number, hole: string }>}
 */
export function veroPinHoles(pkg, anchor) {
  const { pins, halfPins, pitch } = packageSpec(pkg);
  const span = veroRowSpan(pkg);
  const out = [];
  for (let pin = 1; pin <= pins; pin++) {
    const hole =
      pin <= halfPins
        ? shiftVeroHole(anchor, (pin - 1) * pitch, 0)
        : shiftVeroHole(anchor, (pins - pin) * pitch, -span);
    if (!hole) return [];
    out.push({ pin, hole });
  }
  return out;
}

/**
 * The holes a package's body stands over on a veroboard: every hole between
 * its two pin rows (a 300-mil body's two, a 600-mil one's five — a breadboard
 * hides the first two in its trench, a stripboard has holes there), and those
 * between pins more than a pitch apart.
 * @returns {string[]}
 */
export function veroCoveredHoles(pkg, anchor) {
  const { pitch, colSpan } = packageSpec(pkg);
  const span = veroRowSpan(pkg);
  const out = [];
  for (let dcol = 0; dcol <= colSpan; dcol++) {
    for (let up = 1; up < span; up++) {
      const hole = shiftVeroHole(anchor, dcol, -up);
      if (hole) out.push(hole);
    }
    if (pitch > 1 && dcol % pitch) {
      for (const up of [0, span]) {
        const hole = shiftVeroHole(anchor, dcol, -up);
        if (hole) out.push(hole);
      }
    }
  }
  return out;
}

/**
 * The pin number that CURRENTLY occupies the position pin `pin` held at rot 0,
 * after flipping a DIP-packaged part 180° in place. A DIP's footprint maps
 * onto itself under a half lap (same two rows, same columns — at either
 * width) — only the pin
 * numbering turns half the package, so pin `p` trades places with pin
 * `p ± halfPins`. Its own inverse: applying it twice returns the original.
 * Shared by model/occupancy.js's `def.package` rotate (which hole a pin
 * lands in) and components/chip-pinout.js's flipped dialog (which pin a
 * drawn position shows) — the same physical fact, read two ways.
 * @returns {number}
 */
export function flippedPin(pkg, pin) {
  const { pins, halfPins } = packageSpec(pkg);
  return ((pin + halfPins - 1) % pins) + 1;
}
