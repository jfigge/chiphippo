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

// hertz-format.js — a rate as it is PRINTED: a clock's or an oscillator can's
// badge ("250 Hz", "1 kHz"), the BOM and 3D labels, and a timed part's
// readout ("1.44 kHz"). ONE formatter, so a rate reads the same on the brick
// that sets it and on the chip that measures it. Pure and DOM-free; the SI
// rules underneath are si-value.js's.

import { formatWithPrefix } from "./si-value.js";

/** Frequency prefixes, largest first. */
const HZ_STEPS = Object.freeze([
  ["M", 1e6],
  ["k", 1e3],
  ["", 1],
]);

/**
 * "1.44 kHz", "437 Hz", "0.5 Hz", "1 kHz" — three significant figures, a
 * space before the prefixed unit.
 * @param {number} hz
 * @returns {string} "" for anything but a positive finite number
 */
export function formatHz(hz) {
  const formatted = formatWithPrefix(hz, HZ_STEPS);
  if (!formatted) return "";
  const m = /^([\d.]+)(\D*)$/.exec(formatted);
  return m ? `${m[1]} ${m[2]}Hz` : `${formatted}Hz`;
}
