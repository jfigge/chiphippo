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

// Tests for the pure desk geometry + hit-testing (model/part-geometry.js) —
// the world positions the desk controller draws and hit-tests from.

import test from "node:test";
import assert from "node:assert/strict";

import {
  addressWorld,
  componentsInRect,
  connectionPointAt,
  hoverHitAt,
  partPinsWorld,
  wireEndNear,
  wiresInRect,
} from "../model/part-geometry.js";

const BOARDS = [{ id: "bb1", type: "pins-full", x: 0, y: 0 }];
// 7400 at e5: pin 1 in hole e5 (world 5, 8). A PSU brick with + / − terminals.
const CHIP = {
  id: "c1",
  kind: "chip",
  ref: "7400",
  board: "bb1",
  anchor: "e5",
};
const PSU = {
  id: "psu1",
  kind: "psu",
  ref: "psu",
  x: 80,
  y: 0,
  params: { volts: 5 },
};

test("partPinsWorld: pin 1 sits in its seated hole", () => {
  const pins = partPinsWorld(BOARDS, CHIP);
  const p1 = pins.find((p) => p.pin === 1);
  assert.deepEqual(
    { address: p1.address, x: p1.x, y: p1.y },
    { address: "bb1.e5", x: 5, y: 8 },
  );
  assert.equal(partPinsWorld(BOARDS, { ...CHIP, ref: "nope" }), null);
});

test("addressWorld: holes resolve rotation-aware; brick terminals resolve too", () => {
  assert.deepEqual(addressWorld(BOARDS, [], "bb1.a1"), { x: 1, y: 12 });
  // The + terminal sits at the brick origin + its offset (2, 4).
  assert.deepEqual(addressWorld(BOARDS, [PSU], "psu1.+"), { x: 82, y: 4 });
  assert.equal(addressWorld(BOARDS, [], "bb1.zz9"), null);
  assert.equal(addressWorld(BOARDS, [], "nope.a1"), null);
});

test("connectionPointAt: a hole wins; a terminal matches within the radius", () => {
  assert.deepEqual(connectionPointAt(BOARDS, [], { x: 1, y: 12 }), {
    address: "bb1.a1",
    x: 1,
    y: 12,
  });
  // Just off the + terminal (52, 4) but within PIN_HIT_RADIUS.
  assert.equal(
    connectionPointAt(BOARDS, [PSU], { x: 82.3, y: 4 })?.address,
    "psu1.+",
  );
  assert.equal(connectionPointAt(BOARDS, [PSU], { x: 500, y: 500 }), null);
});

test("componentsInRect: a component counts only when EVERY pin is inside", () => {
  // 7400 at e5 spans columns 5–11 across rows e (y 8) and f (y 5).
  const all = { minX: 0, minY: 0, maxX: 20, maxY: 20 };
  const partial = { minX: 0, minY: 0, maxX: 8, maxY: 20 }; // clips cols 9–11
  assert.deepEqual(componentsInRect(BOARDS, [CHIP], all), ["c1"]);
  assert.deepEqual(componentsInRect(BOARDS, [CHIP], partial), []);
});

test("wiresInRect: a wire counts only when BOTH ends are inside", () => {
  const wires = [{ id: "w1", from: "bb1.a1", to: "bb1.a5" }]; // (1,12)…(5,12)
  const both = { minX: 0, minY: 10, maxX: 10, maxY: 14 };
  const one = { minX: 0, minY: 10, maxX: 3, maxY: 14 }; // excludes a5
  assert.deepEqual(wiresInRect(BOARDS, [], wires, both), ["w1"]);
  assert.deepEqual(wiresInRect(BOARDS, [], wires, one), []);
});

test("wireEndNear: grabs the nearest endpoint within reach, else null", () => {
  const wires = [{ id: "w1", from: "bb1.a1", to: "bb1.a20" }]; // (1,12),(20,12)
  const grab = wireEndNear(BOARDS, [], wires, { x: 1.1, y: 12 });
  assert.equal(grab.wireId, "w1");
  assert.equal(grab.end, "from");
  assert.equal(wireEndNear(BOARDS, [], wires, { x: 10, y: 12 }), null);
});

test("hoverHitAt: a pin outranks the hole under it; else the bare hole", () => {
  // Over pin 1 of the chip (world 5, 8 = hole e5): the pin wins, and names it.
  const onPin = hoverHitAt(BOARDS, [CHIP], { x: 5, y: 8 });
  assert.equal(onPin.key, "c1#1");
  assert.equal(onPin.address, "bb1.e5");
  assert.match(onPin.label, /7400 pin 1/);
  // Over an empty hole: the bare address.
  const onHole = hoverHitAt(BOARDS, [CHIP], { x: 1, y: 12 });
  assert.deepEqual(
    { key: onHole.key, address: onHole.address },
    { key: "bb1.a1", address: "bb1.a1" },
  );
  assert.equal(hoverHitAt(BOARDS, [], { x: 500, y: 500 }), null);
});

test("hoverHitAt: a brick terminal is hoverable and labelled with its voltage", () => {
  const hit = hoverHitAt(BOARDS, [PSU], { x: 82, y: 4 });
  assert.equal(hit.key, "psu1#+");
  assert.equal(hit.address, "psu1.+");
  assert.match(hit.label, /\+5 V/);
});
