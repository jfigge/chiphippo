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

// volt-format.js — a Zener's voltage as it is PRINTED on the desk, the
// schematic and the BOM. Pure and DOM-free; the SI rules underneath are
// si-value.js's. What a person TYPES (`5.1V`, `3.3`, and `5V1`, the form
// printed on the part) is read by the one parser every value field shares
// (component-value.js).

import { formatWithPrefix } from "./si-value.js";

/** Volts only: nothing a Zener is sold at needs a prefix. */
const STEPS = Object.freeze([["", 1]]);

/**
 * Format a voltage for printing — 5.1 → "5.1", 12 → "12". Three significant
 * figures; no unit appended (callers add "V").
 * @param {number} volts
 * @returns {string} "" for anything but a positive finite number
 */
export function formatVolts(volts) {
  return formatWithPrefix(volts, STEPS);
}
