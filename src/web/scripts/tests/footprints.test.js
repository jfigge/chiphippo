/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Tests for the pure DIP footprint derivation (model/footprints.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DIP_PACKAGES,
  allPinHoles,
  packageSpec,
  pinOffset,
} from "../model/footprints.js";

test("packageSpec: known packages; junk throws INVALID_PACKAGE", () => {
  assert.deepEqual(packageSpec("DIP-14"), { pins: 14, halfPins: 7 });
  assert.deepEqual(packageSpec("DIP-16"), { pins: 16, halfPins: 8 });
  assert.deepEqual(packageSpec("DIP-20"), { pins: 20, halfPins: 10 });
  assert.throws(() => packageSpec("DIP-8"), { code: "INVALID_PACKAGE" });
  assert.throws(() => packageSpec(undefined), { code: "INVALID_PACKAGE" });
});

test("pinOffset: standard counterclockwise DIP numbering, notch left", () => {
  // DIP-14: 1…7 left→right along e; 8…14 right→left along f.
  assert.deepEqual(pinOffset("DIP-14", 1), { row: "e", dcol: 0 });
  assert.deepEqual(pinOffset("DIP-14", 7), { row: "e", dcol: 6 });
  assert.deepEqual(pinOffset("DIP-14", 8), { row: "f", dcol: 6 });
  assert.deepEqual(pinOffset("DIP-14", 14), { row: "f", dcol: 0 });
  // Pin 14 sits directly above pin 1 (the notch end).
  assert.equal(pinOffset("DIP-14", 14).dcol, pinOffset("DIP-14", 1).dcol);
  // DIP-16/20 corners.
  assert.deepEqual(pinOffset("DIP-16", 8), { row: "e", dcol: 7 });
  assert.deepEqual(pinOffset("DIP-16", 9), { row: "f", dcol: 7 });
  assert.deepEqual(pinOffset("DIP-20", 20), { row: "f", dcol: 0 });
});

test("pinOffset: out-of-range pins are null", () => {
  assert.equal(pinOffset("DIP-14", 0), null);
  assert.equal(pinOffset("DIP-14", 15), null);
  assert.equal(pinOffset("DIP-14", 1.5), null);
});

test("allPinHoles: every pin exactly once, anchored at the given column", () => {
  for (const pkg of Object.keys(DIP_PACKAGES)) {
    const { pins, halfPins } = packageSpec(pkg);
    const holes = allPinHoles(pkg, 12);
    assert.equal(holes.length, pins);
    assert.equal(new Set(holes.map((h) => `${h.row}${h.col}`)).size, pins);
    // Row split: half in e, half in f; columns span 12 … 12+halfPins-1.
    assert.equal(holes.filter((h) => h.row === "e").length, halfPins);
    const cols = holes.map((h) => h.col);
    assert.equal(Math.min(...cols), 12);
    assert.equal(Math.max(...cols), 12 + halfPins - 1);
  }
});
