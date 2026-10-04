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

// si-value.js — the arithmetic under every typed component VALUE: how a
// number with an SI prefix is read off what a person typed, and how one is
// printed back. Pure and DOM-free.
//
// It exists so a resistance (ohm-format.js) and a capacitance
// (farad-format.js) are read and printed by ONE set of rules. The two units
// differ only in their TABLES — which prefix letters they take, and whether
// a bare number means anything — and the tables are theirs; the reading is
// here.
//
// Both forms a bench writes are accepted: the decimal one (`4.7k`, `100n`)
// and the IEC 60062 one, where the prefix letter stands where the decimal
// point would (`4k7`, `2M2`, `4u7`, `n47`) — the form printed on the parts
// themselves, because a dot rubs off a resistor and a letter does not.

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

/** An unsigned decimal: `470`, `4.7`, `.47`. */
const NUMBER = String.raw`(\d+(?:\.\d+)?|\.\d+)`;

/** Escape a prefix letter for a character class. */
const charClass = (letters) =>
  `[${letters.map((c) => c.replace(/[\]\\^-]/g, "\\$&")).join("")}]`;

/**
 * Read a typed value against a unit's table, or null.
 *
 * Accepted, with the unit's own letters:
 *   · `<number>`                 — only when `bare` (a resistance) or a unit
 *                                   suffix was given (`1F`);
 *   · `<number><prefix>`         — `4.7k`, `100n`;
 *   · `<digits><mark><digits>`   — the IEC form, `4k7`, `4u7`, and `R47`
 *                                   with no leading digits;
 *   · any of those followed by the unit (`470Ω`, `100nF`), and `<number><mark>`
 *     where the mark is the unit-letter decimal (`470R`).
 * Spaces anywhere are ignored ("4.7 kΩ").
 *
 * @param {string} text
 * @param {object} table
 * @param {Record<string, number>} table.prefixes - letter → scale.
 * @param {RegExp} table.unit - the unit suffix, matched at the END.
 * @param {string[]} [table.decimals] - letters that stand for a decimal
 *   point with NO scale (a resistance's `R`).
 * @param {boolean} [table.bare] - whether a plain number means the unit.
 * @param {{min: number, max: number}} table.range - inclusive.
 * @returns {number|null}
 */
export function parseSi(text, { prefixes, unit, decimals = [], bare, range }) {
  if (typeof text !== "string" && typeof text !== "number") return null;
  let s = String(text).replace(/\s+/g, "");
  if (!s) return null;
  const withUnit = unit.test(s);
  if (withUnit) s = s.replace(unit, "");
  if (!s) return null;

  const scaleOf = (letter) =>
    decimals.includes(letter) ? 1 : (prefixes[letter] ?? null);
  const marks = [...Object.keys(prefixes), ...decimals];
  let value = null;

  const plain = new RegExp(`^${NUMBER}$`).exec(s);
  const prefixed = new RegExp(`^${NUMBER}(${charClass(marks)})$`).exec(s);
  const infix = new RegExp(`^(\\d*)(${charClass(marks)})(\\d+)$`).exec(s);
  if (plain) {
    if (bare || withUnit) value = Number(plain[1]);
  } else if (prefixed) {
    value = Number(prefixed[1]) * scaleOf(prefixed[2]);
  } else if (infix) {
    const whole = infix[1] || "0";
    value = Number(`${whole}.${infix[3]}`) * scaleOf(infix[2]);
  }
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  value = tidy(value);
  if (value < range.min || value > range.max) return null;
  return value;
}
