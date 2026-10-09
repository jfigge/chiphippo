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
// memories and the processors) is twice that: rows d and h, 6 pitches apart,
// its body standing over rows e, f and g between them — holes nothing else may
// use (`coveredHoles`; occupancy.js claims them for the chip).
//
// THE ANCHOR'S ROW SAYS WHICH. A 600-mil part anchored in row e is the seat
// every DIP took before wide seating existed (2026-10-05), and a desk saved
// then keeps it exactly — there is no migration. Placing a part, or moving one
// on its own, seats it at its true width (`seatRow`); a selection dragged or
// pasted as a group moves rigidly, so each chip in it keeps the form it had;
// and the generators (the AI builder's compiler, the demo benches) still seat
// every DIP in rows e and f, which stays a legal seat.

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
 * The package table entry (throws code INVALID_PACKAGE on junk).
 * @returns {{ pins: number, halfPins: number, body: number }}
 */
export function packageSpec(pkg) {
  const p = DIP_PACKAGES[pkg] ?? parsedPackage(pkg);
  if (!p) {
    const err = new Error(`unknown package: ${pkg}`);
    err.code = "INVALID_PACKAGE";
    throw err;
  }
  return { pins: p.pins, halfPins: p.pins / 2, body: p.body };
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
const WIDE = Object.freeze({
  lower: "d",
  upper: "h",
  span: 6,
  covers: Object.freeze(["e", "f", "g"]),
});

/** Is this a 600-mil package (its pins six pitches apart, not three)? */
export function isWidePackage(pkg) {
  return packageSpec(pkg).body >= 600;
}

/**
 * The row pin 1 takes when a package is PLACED (or moved) now: d for a 600-mil
 * package, e for everything else.
 * @returns {"d"|"e"}
 */
export function seatRow(pkg) {
  return isWidePackage(pkg) ? WIDE.lower : NARROW.lower;
}

/**
 * The rows a package's pins take with pin 1 anchored in `anchorRow` —
 * `{ lower, upper, span, covers }` — or null for a row it cannot anchor in.
 * Row e is every package's narrow seat (a 600-mil one's only from a document
 * saved before wide seating); row d is a 600-mil package's true width.
 */
export function dipRows(pkg, anchorRow = seatRow(pkg)) {
  if (anchorRow === NARROW.lower) {
    packageSpec(pkg); // junk still throws INVALID_PACKAGE
    return NARROW;
  }
  if (anchorRow === WIDE.lower && isWidePackage(pkg)) return WIDE;
  return null;
}

/**
 * Row + column offset of one pin relative to the anchor column (pin 1's
 * column), for a package anchored in `anchorRow` (by default the row it is
 * placed in now — `seatRow`). Returns null for a pin number outside the
 * package, or an anchor row it cannot seat in.
 * @returns {{ row: string, dcol: number }|null}
 */
export function pinOffset(pkg, pin, anchorRow = seatRow(pkg)) {
  const { pins, halfPins } = packageSpec(pkg);
  const rows = dipRows(pkg, anchorRow);
  if (!rows) return null;
  if (!Number.isInteger(pin) || pin < 1 || pin > pins) return null;
  return pin <= halfPins
    ? { row: rows.lower, dcol: pin - 1 } // 1…n left→right along the lower row
    : { row: rows.upper, dcol: pins - pin }; // n+1…2n right→left along the upper
}

/**
 * Every pin's seated hole for a package anchored at `anchorCol` (pin 1's
 * column) in `anchorRow` — empty when it cannot anchor there.
 * @returns {Array<{ pin: number, row: string, col: number }>}
 */
export function allPinHoles(pkg, anchorCol, anchorRow = seatRow(pkg)) {
  const { pins } = packageSpec(pkg);
  if (!dipRows(pkg, anchorRow)) return [];
  const out = [];
  for (let pin = 1; pin <= pins; pin++) {
    const { row, dcol } = pinOffset(pkg, pin, anchorRow);
    out.push({ pin, row, col: anchorCol + dcol });
  }
  return out;
}

/**
 * The holes a seated package's BODY stands over — between its two pin rows, in
 * each of its columns: rows e, f and g under a 600-mil part at its true width,
 * nothing under a narrow seat (only the trench lies between rows e and f). A
 * real part's plastic is in the way of those holes, so nothing may be plugged
 * into one.
 * @returns {Array<{ row: string, col: number }>}
 */
export function coveredHoles(pkg, anchorCol, anchorRow = seatRow(pkg)) {
  const { halfPins } = packageSpec(pkg);
  const rows = dipRows(pkg, anchorRow);
  if (!rows) return [];
  const out = [];
  for (const row of rows.covers) {
    for (let dcol = 0; dcol < halfPins; dcol++) {
      out.push({ row, col: anchorCol + dcol });
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
