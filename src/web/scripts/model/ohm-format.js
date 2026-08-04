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
// Deliberately NARROW: resistances only, formatting only. There is no parser
// here — a resistance is a plain number coerced by the catalog's own
// `normalizeParams` — and no other unit. Whatever needs one of those can add it
// when something actually reads it.

/** Prefix steps, largest first. */
const STEPS = Object.freeze([
  ["G", 1e9],
  ["M", 1e6],
  ["k", 1e3],
  ["", 1],
]);

/** A mantissa at three significant figures, trailing zeros dropped. */
function toThreeFigures(mantissa) {
  const digits = mantissa >= 100 ? 0 : mantissa >= 10 ? 1 : 2;
  // `+` drops the trailing zeros toFixed leaves behind ("4.70" → 4.7).
  return +mantissa.toFixed(digits);
}

/**
 * Format a resistance for printing — 4700 → "4.7k", 10000 → "10k", 220 → "220".
 *
 * Three significant figures, which is what a resistor's own colour code and a
 * parts list both speak, so a value carrying more is shown rounded rather than
 * spilling its full precision across a symbol ("4.753k" was the old schematic).
 *
 * ROUNDING CARRIES INTO THE NEXT PREFIX. 999999 Ω rounds to 1000 of the "k"
 * step, and "1000k" is not how anyone writes 1 MΩ — the old desk formatter
 * printed exactly that. ONE promotion is provably enough: the step chosen is
 * the largest that is ≤ the value, so the mantissa starts in [1, 1000) and
 * rounding can only reach exactly 1000; dividing by the next step leaves ~1.
 * The top of the table has nothing to promote into and is left alone.
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
  if (!Number.isFinite(ohms) || ohms <= 0) return "";
  let step = STEPS.findIndex(([, scale]) => ohms >= scale);
  if (step < 0) step = STEPS.length - 1; // below 1 Ω — no prefix to reach for
  let rounded = toThreeFigures(ohms / STEPS[step][1]);
  if (rounded >= 1000 && step > 0) {
    step -= 1;
    rounded = toThreeFigures(ohms / STEPS[step][1]);
  }
  return `${rounded}${STEPS[step][0]}`;
}
