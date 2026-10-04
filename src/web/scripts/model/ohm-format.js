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

// ohm-format.js — a resistance as it is PRINTED, in one place. Pure and
// DOM-free.
//
// IT IS ONE MODULE BECAUSE IT WAS TWO, AND THEY DISAGREED. `discrete-view.js`
// (the silkscreen on a resistor array) and `schematic-view.js` (the value text
// beside a symbol) each carried a private `formatOhms`, and the same resistor
// read differently depending on which view you were looking at:
//
//     value      desk        schematic
//     4753       4.75k       4.753k
//     999999     1000k       999.999k
//     1000000    1M          1000k
//     undefined  undefined   (blank)
//
// A 1 MΩ resistor labelled "1M" on the desk and "1000k" on the schematic is one
// part stating two values, and "undefined" printed on a part is a bug the user
// gets to read. Two copies of a formatting rule will always end up like this;
// one cannot.
//
// Since resistors carry a typed value (the Resistance field in their
// Properties card), this is also where a typed resistance is READ: `parseOhms`
// accepts what a bench writes — `470`, `470R`, `470Ω`, `4.7k`, `4k7`, `1M`,
// `2M2`, `R47` — through the same SI rules a capacitance uses (si-value.js),
// so the two units can never disagree about what "4k7" means.

import { formatWithPrefix, parseSi } from "./si-value.js";

/** Prefix steps, largest first. */
const STEPS = Object.freeze([
  ["G", 1e9],
  ["M", 1e6],
  ["k", 1e3],
  ["", 1],
]);

/**
 * The resistances the Resistance field accepts: 0.1 Ω (`R1`, a gold band's
 * smallest multiplier, and the smallest value a colour code can state with two
 * digits) to 1 GΩ — past the largest any part in a bench drawer is sold in, and
 * still inside what four bands can say.
 */
export const OHMS_RANGE = Object.freeze({ min: 0.1, max: 1e9 });

/**
 * Format a resistance for printing — 4700 → "4.7k", 10000 → "10k", 220 → "220".
 *
 * Three significant figures, which is what a resistor's own colour code and a
 * parts list both speak, so a value carrying more is shown rounded rather than
 * spilling its full precision across a symbol ("4.753k" was the old schematic).
 * Rounding carries into the next prefix (999999 is "1M", never "1000k" — the
 * old desk formatter printed exactly that); see si-value.js.
 *
 * A value that is not a positive finite number formats as "" — nothing is
 * printed. `normalizeParams` guarantees a stored resistance is positive, so
 * this is unreachable through the catalog; it exists because the alternative
 * when it IS reached is drawing the word "undefined" onto a part.
 *
 * @param {number} ohms
 * @returns {string} the formatted resistance, with no unit appended
 */
export function formatOhms(ohms) {
  return formatWithPrefix(ohms, STEPS);
}

/**
 * Read a typed resistance, in ohms, or null when it is not one (or lies
 * outside OHMS_RANGE). A bare number is ohms; `k`/`K`, `M` and `G` scale it;
 * `R` (or `Ω`, `ohm`) marks the unit, and in the IEC form stands where the
 * decimal point would (`4R7` is 4.7 Ω, `R47` 0.47 Ω). A lowercase `m` is
 * REFUSED rather than guessed at: as SI it is a milliohm no breadboard part
 * is, and as shorthand for mega it is a typo for `M` — either reading would be
 * a value the user did not mean, stored without a word.
 * @param {string} text
 * @returns {number|null}
 */
export function parseOhms(text) {
  return parseSi(text, {
    prefixes: { k: 1e3, K: 1e3, M: 1e6, G: 1e9 },
    decimals: ["R", "r"],
    unit: /(\u03A9|\u2126|ohms?)$/i,
    bare: true,
    range: OHMS_RANGE,
  });
}
