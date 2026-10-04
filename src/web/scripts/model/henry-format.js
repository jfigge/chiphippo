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

// henry-format.js — an inductance as it is PRINTED on the desk, the schematic
// and the BOM, in one place, for the reason farad-format.js is one module.
// Pure and DOM-free; the SI rules underneath are si-value.js's. What a person
// TYPES is read by the one parser every value field shares
// (component-value.js).

import { formatWithPrefix } from "./si-value.js";

/** Prefix steps, largest first. */
const STEPS = Object.freeze([
  ["", 1],
  ["m", 1e-3],
  ["µ", 1e-6],
  ["n", 1e-9],
]);

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
