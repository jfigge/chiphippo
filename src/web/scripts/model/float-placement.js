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

// float-placement.js — where a floated slider's window opens (main's
// openSliderWindow; components/slider-windows.js says what is where). Pure
// arithmetic on rectangles in one frame of reference, so main can run it in
// screen pixels and a test in anything.
//
// It opens OFF the circuit, as near its part as that allows — below the
// circuit, else above it, else to its right or left, the first of those with
// room inside `within` — and under, over or level with the part, sliding
// along that side to stay inside. With nothing to keep clear of (or no room
// anywhere) it opens beside the part, to its right unless that runs off
// `within`.

/** Gap between what is kept clear and the window, in the frame's units. */
export const FLOAT_GAP = 16;

/**
 * @typedef {{left: number, top: number, right: number, bottom: number}} Box
 * @param {object} opts
 * @param {{width: number, height: number}} opts.size - the window
 * @param {Box} opts.part - the part it turns
 * @param {Box} [opts.clear] - the circuit around it
 * @param {Box} opts.within - where it may open
 * @param {number} [opts.gap]
 * @returns {{x: number, y: number}} its top-left corner
 */
export function floatPlacement({ size, part, clear, within, gap = FLOAT_GAP }) {
  const { width, height } = size;
  const fitX = (x) => Math.min(Math.max(x, within.left), within.right - width);
  const fitY = (y) => Math.min(Math.max(y, within.top), within.bottom - height);
  const cx = (part.left + part.right) / 2 - width / 2;
  const cy = (part.top + part.bottom) / 2 - height / 2;
  if (clear) {
    // Each side wants room ACROSS it; along it, the window slides to fit.
    const rows = (y) => y >= within.top && y + height <= within.bottom;
    const cols = (x) => x >= within.left && x + width <= within.right;
    const below = clear.bottom + gap;
    const above = clear.top - gap - height;
    const right = clear.right + gap;
    const left = clear.left - gap - width;
    if (rows(below)) return { x: fitX(cx), y: below };
    if (rows(above)) return { x: fitX(cx), y: above };
    if (cols(right)) return { x: right, y: fitY(cy) };
    if (cols(left)) return { x: left, y: fitY(cy) };
  }
  const x =
    part.right + gap + width <= within.right
      ? part.right + gap
      : part.left - gap - width;
  return { x: fitX(x), y: fitY(cy) };
}
