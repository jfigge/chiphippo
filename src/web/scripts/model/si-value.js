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

// si-value.js — the arithmetic under every component value PRINTED on the
// desk, the schematic and the BOM: a number against an SI prefix table, at
// three significant figures, as a part's own markings say it. Pure and
// DOM-free.
//
// It exists so a resistance (ohm-format.js), a capacitance (farad-format.js),
// an inductance and a voltage are printed by ONE set of rules; the units
// differ only in their prefix TABLES, which are theirs. What a person TYPES
// is read elsewhere, by the one parser every value field shares
// (component-value.js), which also prints a value to its full precision
// where nothing may be rounded — a Properties field, a KiCad Value.

/** Significant digits a parsed value keeps: enough for any value a part is
    sold in, few enough that `4.7 × 1e-6` reads back as 4.7e-6. */
const KEEP = 12;

/** Trim the binary noise multiplying by a prefix leaves (4.7 × 1e-6 is
    4.7000000000000005e-6), so a value round-trips and compares exactly. */
export function tidy(value) {
  return Number(value.toPrecision(KEEP));
}

/** A mantissa at three significant figures, trailing zeros dropped. */
export function toThreeFigures(mantissa) {
  const digits = mantissa >= 100 ? 0 : mantissa >= 10 ? 1 : 2;
  // `+` drops the trailing zeros toFixed leaves behind ("4.70" → 4.7).
  return +mantissa.toFixed(digits);
}

/**
 * Print `value` against a prefix table (largest scale first): the largest
 * step not above the value, three significant figures — which is what a
 * colour code, a capacitor's printed code and a parts list all speak.
 *
 * ROUNDING CARRIES INTO THE NEXT PREFIX: 999 999 rounds to 1000 of the "k"
 * step, and "1000k" is not how anyone writes 1 M. One promotion is provably
 * enough — the chosen step leaves a mantissa in [1, 1000), so rounding can
 * only reach exactly 1000, and the next step up leaves ~1. A value below the
 * smallest step is printed against it.
 *
 * @param {number} value
 * @param {ReadonlyArray<[string, number]>} steps - `[symbol, scale]`, largest
 *   scale first.
 * @returns {string} "" for anything but a positive finite number
 */
export function formatWithPrefix(value, steps) {
  if (!Number.isFinite(value) || value <= 0) return "";
  let step = steps.findIndex(([, scale]) => value >= scale * (1 - 1e-12));
  if (step < 0) step = steps.length - 1;
  let rounded = toThreeFigures(value / steps[step][1]);
  if (rounded >= 1000 && step > 0) {
    step -= 1;
    rounded = toThreeFigures(value / steps[step][1]);
  }
  return `${rounded}${steps[step][0]}`;
}
