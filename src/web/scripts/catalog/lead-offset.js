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

// lead-offset.js — the one coercion every two-free-ends part's bent lead
// passes through (the resistor, the LED, and every two-lead discrete). Its own
// module so both catalog/parts.js and catalog/discretes.js can read it
// without importing each other.

/**
 * Coerce a rotated part's far lead to a `{dx, dy}` PITCH OFFSET from its
 * anchor hole, or null when the shape is junk.
 *
 * A bent lead is geometry, not an address: which hole it touches is resolved
 * from where it lands on the desk (occupancy.js), because the far hole may
 * belong to a DIFFERENT strip — typically a power rail. Storing the offset is
 * what lets a part keep its position when that rail is moved or deleted: the
 * lead simply stops resolving to a hole and floats, exactly as a real leg
 * would when you pull the rail out from under it.
 *
 * Both components must be integers so the lead stays on the 0.1-in lattice,
 * and (0, 0) is rejected — a two-terminal device pinned to one hole is
 * nonsense.
 */
export function normalizeLeadOffset(raw) {
  const q = (n) => Math.round(n * 100) / 100;
  const dx = q(Number(raw?.dx));
  const dy = q(Number(raw?.dy));
  // Two decimals, not whole pitches. A bend is the vector between two HOLES,
  // and since board-types.js started measuring the vertical geometry that is
  // not always a whole number: row a to a dovetailed rail's nearest row is
  // 2.76 (7.0 mm on a real board). Rounding it to 3 drew the lead 0.6 mm past
  // the hole it is electrically in; REFUSING it (which this did) dropped the
  // bend altogether and stood the part back up. Horizontally the vector is
  // still whole, because columns are.
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dx === 0 && dy === 0) return null;
  // Rotating a bend negates a component, and negating zero gives -0: equal to
  // 0 under ===, distinct under Object.is, so it survives into the saved
  // document and then fails a deepStrictEqual round-trip. Fold it here, the
  // one chokepoint every stored bend passes through.
  return Object.freeze({ dx: dx === 0 ? 0 : dx, dy: dy === 0 ? 0 : dy });
}
