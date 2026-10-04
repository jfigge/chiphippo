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

// resistor-bands.js — a resistance as the COLOUR CODE printed round the body
// (IEC 60062), so the resistor on the desk can be read the way the one in the
// drawer is. Pure and DOM-free: it answers colour NAMES, and the view maps
// each name to a theme token.
//
// Which code a value gets follows what it needs, as the parts themselves do:
//   · two significant figures (every E12/E24 value — 470, 4.7k, 22k) → the
//     FOUR-band code: digit, digit, multiplier, and a gold 5 % tolerance band;
//   · a third significant figure (4.75k, 1.02M — the E96 values) → FIVE
//     bands: three digits, a multiplier, and a brown 1 % band, since a value
//     stated to three figures is a precision part.
// A value carrying more is rounded to three figures first, exactly as it is
// printed (ohm-format.js) — the bands and the label can never disagree.

/** Digit colours, 0–9. */
export const DIGIT_COLORS = Object.freeze([
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
  "grey",
  "white",
]);

/** Multiplier band, by power of ten: silver ×0.01 … white ×1e9. */
const MULTIPLIER = Object.freeze(
  new Map([
    [-2, "silver"],
    [-1, "gold"],
    ...DIGIT_COLORS.map((c, i) => [i, c]),
  ]),
);

/** Every colour a band can be, in no particular order — the stylesheet holds
    a token for each, and a test holds the two to one another. */
export const BAND_COLORS = Object.freeze([...DIGIT_COLORS, "gold", "silver"]);

/** The tolerance band each code closes with. */
const TOLERANCE = Object.freeze({ 4: "gold", 5: "brown" });

/** `value` to `n` significant figures, as an integer and a power of ten:
    figures(4753, 3) → { digits: 475, exp: 1 }. */
function figures(value, n) {
  let exp = Math.floor(Math.log10(value)) - (n - 1);
  let digits = Math.round(value / 10 ** exp);
  if (digits >= 10 ** n) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  return { digits, exp };
}

/**
 * The colour bands of a resistance, first band (the one nearer an end) first.
 * @param {number} ohms
 * @returns {string[]} 4 or 5 colour names, or [] for a value no code states
 *   (not positive, or outside 0.1 Ω – 99 GΩ).
 */
export function resistorBands(ohms) {
  if (!Number.isFinite(ohms) || ohms <= 0) return [];
  const three = figures(ohms, 3);
  // A trailing zero is a two-figure value (470 = 47 × 10), and so a four-band
  // part — as is a three-figure value whose multiplier would be past the
  // code's bottom end (silver, ×0.01): it is stated to the two figures the
  // code CAN carry there.
  const fiveBand = three.digits % 10 !== 0 && three.exp >= -2;
  const { digits, exp } = fiveBand ? three : figures(ohms, 2);
  const band = MULTIPLIER.get(exp);
  if (!band) return [];
  const shown = String(digits).split("").map(Number);
  return [
    ...shown.map((d) => DIGIT_COLORS[d]),
    band,
    TOLERANCE[shown.length + 2],
  ];
}
