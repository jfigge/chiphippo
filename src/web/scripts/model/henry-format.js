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

// henry-format.js — an inductance as it is TYPED and PRINTED, in one place,
// for the reason farad-format.js is one module: the desk's label, the
// Properties field, the schematic, the BOM and the KiCad export must all say
// one value one way. Pure and DOM-free; the SI rules underneath are
// si-value.js's, shared with resistances and capacitances.

import { formatWithPrefix, parseSi } from "./si-value.js";

/** Prefix steps, largest first. */
const STEPS = Object.freeze([
  ["", 1],
  ["m", 1e-3],
  ["µ", 1e-6],
  ["n", 1e-9],
]);

/**
 * The inductances the Inductance field accepts: 1 nH (a few millimetres of
 * lead already measure that) to 100 H — past the largest choke or relay coil a
 * logic bench is built with.
 */
export const HENRIES_RANGE = Object.freeze({ min: 1e-9, max: 100 });

/**
 * Format an inductance for printing — 1e-5 → "10µ", 0.1 → "100m", 1 → "1".
 * Three significant figures, the next prefix taken when rounding reaches 1000;
 * no unit appended (callers add "H" where it reads better).
 * @param {number} henries
 * @returns {string} "" for anything but a positive finite number
 */
export function formatHenries(henries) {
  return formatWithPrefix(henries, STEPS);
}

/**
 * The same value with ASCII `u` for micro — for a file another program reads
 * (a KiCad Value field), as `formatFaradsAscii` is.
 * @param {number} henries
 * @returns {string}
 */
export function formatHenriesAscii(henries) {
  return formatHenries(henries).replace("µ", "u");
}

/**
 * Read a typed inductance, in henries, or null when it is not one (or lies
 * outside HENRIES_RANGE). The capacitance field's rules, for the capacitance
 * field's reason: a prefix is REQUIRED — `n`, `u`/`µ`, `m` (an optional
 * trailing `H` either way) — or the unit itself (`1H`), because a bare "10"
 * is 10 µH on a choke's datasheet and 10 H on nothing a bench holds. An
 * uppercase `M` is refused: SI says mega, and no inductor is a megahenry.
 * @param {string} text
 * @returns {number|null}
 */
export function parseHenries(text) {
  return parseSi(text, {
    prefixes: {
      n: 1e-9,
      N: 1e-9,
      u: 1e-6,
      U: 1e-6,
      µ: 1e-6, // µ MICRO SIGN
      μ: 1e-6, // μ GREEK SMALL LETTER MU — what many keyboards type
      m: 1e-3,
    },
    unit: /[hH]$/,
    bare: false,
    range: HENRIES_RANGE,
  });
}
