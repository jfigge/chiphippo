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

// farad-format.js — a capacitance as it is TYPED and PRINTED, in one place,
// for the same reason ohm-format.js is one module: the desk's label, the
// Properties field, the schematic, the BOM and the KiCad export must all say
// the same value the same way. Pure and DOM-free; the SI rules underneath are
// si-value.js's, shared with resistances.

import { formatWithPrefix, parseSi } from "./si-value.js";

/** Prefix steps, largest first. */
const STEPS = Object.freeze([
  ["", 1],
  ["m", 1e-3],
  ["µ", 1e-6],
  ["n", 1e-9],
  ["p", 1e-12],
]);

/**
 * The capacitances the Capacitance field accepts: 1 pF (below which a
 * breadboard's own stray capacitance is the bigger number) to 1 F — past the
 * largest electrolytic in any drawer, and short of a supercapacitor, which is
 * not a part a logic bench is built with.
 */
export const FARADS_RANGE = Object.freeze({ min: 1e-12, max: 1 });

/**
 * Format a capacitance for printing — 1e-7 → "100n", 4.7e-6 → "4.7µ",
 * 0.001 → "1m". Three significant figures, the next prefix taken when rounding
 * reaches 1000; no unit appended (callers add "F" where it reads better).
 * @param {number} farads
 * @returns {string} "" for anything but a positive finite number
 */
export function formatFarads(farads) {
  return formatWithPrefix(farads, STEPS);
}

/**
 * The same value with ASCII `u` for micro — for a file another program reads
 * (a KiCad Value field), where the micro sign is the one character in the set
 * a BOM script is likely to mangle.
 * @param {number} farads
 * @returns {string}
 */
export function formatFaradsAscii(farads) {
  return formatFarads(farads).replace("µ", "u");
}

/**
 * Read a typed capacitance, in farads, or null when it is not one (or lies
 * outside FARADS_RANGE). A prefix is REQUIRED — `p`, `n`, `u`/`µ`, `m` (an
 * optional trailing `F` either way) — or the unit itself (`1F`): a bare
 * number is refused rather than guessed at, because a bench reads "100" on a
 * ceramic as 100 pF and "0.1" on an old schematic as 0.1 µF, and storing
 * either as farads would be a value six to twelve orders of magnitude from the
 * one meant. An uppercase `M` is refused for the same reason: old parts print
 * "MF" for MICROfarads, and SI says mega.
 * @param {string} text
 * @returns {number|null}
 */
export function parseFarads(text) {
  return parseSi(text, {
    prefixes: {
      p: 1e-12,
      P: 1e-12,
      n: 1e-9,
      N: 1e-9,
      u: 1e-6,
      U: 1e-6,
      µ: 1e-6, // µ MICRO SIGN
      μ: 1e-6, // μ GREEK SMALL LETTER MU — what many keyboards type
      m: 1e-3,
    },
    unit: /[fF]$/,
    bare: false,
    range: FARADS_RANGE,
  });
}
