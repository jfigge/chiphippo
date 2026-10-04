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

// volt-format.js — a voltage as it is TYPED and PRINTED: what a Zener diode's
// Zener voltage field reads and what the desk, the schematic, the BOM and the
// KiCad export print, one rule for all of them. Pure and DOM-free; the SI
// rules underneath are si-value.js's.
//
// A Zener's voltage is written three ways on a bench — `5.1V`, `3.3` and the
// IEC 60062 form printed on the part itself, `5V1`, where the unit letter
// stands where the decimal point would (a BZX79-C5V1 is a 5.1 V part).

import { formatWithPrefix, parseSi } from "./si-value.js";

/** Volts only: nothing a Zener is sold at needs a prefix. */
const STEPS = Object.freeze([["", 1]]);

/**
 * The voltages the Zener voltage field accepts: 1 V to 200 V — the range the
 * Zener families are sold in, from the lowest-voltage parts to the
 * 200 V end of the 1N53xx series.
 */
export const VOLTS_RANGE = Object.freeze({ min: 1, max: 200 });

/**
 * Format a voltage for printing — 5.1 → "5.1", 12 → "12". Three significant
 * figures; no unit appended (callers add "V").
 * @param {number} volts
 * @returns {string} "" for anything but a positive finite number
 */
export function formatVolts(volts) {
  return formatWithPrefix(volts, STEPS);
}

/**
 * Read a typed voltage, in volts, or null when it is not one (or lies outside
 * VOLTS_RANGE). A bare number is volts; a trailing `V` is the unit; and in the
 * IEC form a `V` stands where the decimal point would (`5V1` is 5.1 V).
 * @param {string} text
 * @returns {number|null}
 */
export function parseVolts(text) {
  return parseSi(text, {
    prefixes: {},
    decimals: ["V", "v"],
    unit: /[vV]$/,
    bare: true,
    range: VOLTS_RANGE,
  });
}
