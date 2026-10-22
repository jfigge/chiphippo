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

// Where a floated slider's window opens (model/float-placement.js): off the
// circuit, as near its part as that allows.

import test from "node:test";
import assert from "node:assert/strict";

import { floatPlacement } from "../model/float-placement.js";

const size = { width: 280, height: 96 };
const within = { left: 0, top: 60, right: 1024, bottom: 768 };
const part = { left: 300, top: 300, right: 340, bottom: 320 };

test("below the circuit when there is room, centred on the part", () => {
  const clear = { left: 100, top: 200, right: 800, bottom: 500 };
  assert.deepEqual(floatPlacement({ size, part, clear, within }), { x: 180, y: 516 }); // prettier-ignore
});

test("else above it", () => {
  const clear = { left: 100, top: 200, right: 800, bottom: 700 };
  assert.deepEqual(floatPlacement({ size, part, clear, within }), { x: 180, y: 88 }); // prettier-ignore
});

test("else to its right, level with the part — the desk's own area, not the toolbar's", () => {
  const clear = { left: 100, top: 100, right: 600, bottom: 700 };
  assert.deepEqual(floatPlacement({ size, part, clear, within }), { x: 616, y: 262 }); // prettier-ignore
});

test("else to its left", () => {
  const clear = { left: 400, top: 100, right: 1000, bottom: 700 };
  const right = { left: 500, top: 300, right: 540, bottom: 320 };
  assert.deepEqual(floatPlacement({ size, part: right, clear, within }), { x: 104, y: 262 }); // prettier-ignore
});

test("no room anywhere, or nothing to keep clear of: beside the part", () => {
  const clear = { left: 10, top: 70, right: 1010, bottom: 760 };
  assert.deepEqual(floatPlacement({ size, part, clear, within }), { x: 356, y: 262 }); // prettier-ignore
  assert.deepEqual(floatPlacement({ size, part, within }), { x: 356, y: 262 });
  // …on its left where the right runs off the area.
  const edge = { left: 900, top: 300, right: 940, bottom: 320 };
  assert.deepEqual(floatPlacement({ size, part: edge, within }), { x: 604, y: 262 }); // prettier-ignore
});

test("it slides along a side to stay inside", () => {
  const clear = { left: 0, top: 200, right: 1024, bottom: 500 };
  const corner = { left: 0, top: 300, right: 20, bottom: 320 };
  assert.deepEqual(floatPlacement({ size, part: corner, clear, within }), { x: 0, y: 516 }); // prettier-ignore
});
