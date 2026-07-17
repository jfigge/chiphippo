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

// Tests for the occupancy index + chip placement legality (model/occupancy.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOccupancy,
  canPlaceChip,
  canPlacePart,
  canPlaceWire,
  chipPinHoles,
  isFreeHole,
  partPinHoles,
} from "../model/occupancy.js";

function docWith({ boards, components = [] }) {
  return { boards, components };
}

const FULL = { id: "bb1", type: "full", x: 0, y: 0 };
const TINY = { id: "bb2", type: "tiny", x: 100, y: 0 };

test("chipPinHoles: derives the 14 seated holes of a 7400 at e5", () => {
  const pins = chipPinHoles("7400", "e5");
  assert.equal(pins.length, 14);
  assert.deepEqual(pins[0], { pin: 1, hole: "e5" });
  assert.deepEqual(
    pins.find((p) => p.pin === 7),
    { pin: 7, hole: "e11" },
  );
  assert.deepEqual(
    pins.find((p) => p.pin === 8),
    { pin: 8, hole: "f11" },
  );
  assert.deepEqual(
    pins.find((p) => p.pin === 14),
    { pin: 14, hole: "f5" },
  );
});

test("chipPinHoles: unknown ref or non-e anchor is null", () => {
  assert.equal(chipPinHoles("9999", "e5"), null);
  assert.equal(chipPinHoles("7400", "f5"), null);
  assert.equal(chipPinHoles("7400", "t+3"), null);
  assert.equal(chipPinHoles("7400", null), null);
});

test("buildOccupancy: one entry per pin, addressed globally", () => {
  const doc = docWith({
    boards: [FULL],
    components: [
      { id: "c1", kind: "chip", ref: "7400", board: "bb1", anchor: "e5" },
    ],
  });
  const occ = buildOccupancy(doc);
  assert.equal(occ.size, 14);
  assert.deepEqual(occ.get("bb1.e5"), {
    kind: "pin",
    componentId: "c1",
    pin: 1,
  });
  assert.deepEqual(occ.get("bb1.f11"), {
    kind: "pin",
    componentId: "c1",
    pin: 8,
  });
  assert.equal(occ.get("bb1.e4"), undefined);
});

test("canPlaceChip: happy path on Full and Tiny", () => {
  const doc = docWith({ boards: [FULL, TINY] });
  assert.equal(
    canPlaceChip(doc, { ref: "7400", board: "bb1", anchor: "e5" }),
    true,
  );
  // A DIP-14 needs 7 columns: Tiny (17 cols) fits at e1…e11.
  assert.equal(
    canPlaceChip(doc, { ref: "74125", board: "bb2", anchor: "e11" }),
    true,
  );
});

test("canPlaceChip: rejects off-board, bad anchors, unknown boards/refs", () => {
  const doc = docWith({ boards: [FULL, TINY] });
  // Full has 63 columns: e58 puts pin 7 at e64 — off the board.
  assert.equal(
    canPlaceChip(doc, { ref: "7400", board: "bb1", anchor: "e58" }),
    false,
  );
  assert.equal(
    canPlaceChip(doc, { ref: "7400", board: "bb2", anchor: "e12" }),
    false, // Tiny: pin 7 would land at e18 (only 17 columns)
  );
  assert.equal(
    canPlaceChip(doc, { ref: "7400", board: "bb1", anchor: "f5" }),
    false, // anchor must be row e
  );
  assert.equal(
    canPlaceChip(doc, { ref: "7400", board: "bb9", anchor: "e5" }),
    false,
  );
  assert.equal(
    canPlaceChip(doc, { ref: "9999", board: "bb1", anchor: "e5" }),
    false,
  );
});

test("canPlaceChip: occupied holes block; ignoreId frees a chip's own pins", () => {
  const doc = docWith({
    boards: [FULL],
    components: [
      { id: "c1", kind: "chip", ref: "7400", board: "bb1", anchor: "e5" },
    ],
  });
  // Overlapping the seated 7400 (columns 5–11) fails…
  assert.equal(
    canPlaceChip(doc, { ref: "7404", board: "bb1", anchor: "e11" }),
    false,
  );
  // …the next free column succeeds…
  assert.equal(
    canPlaceChip(doc, { ref: "7404", board: "bb1", anchor: "e12" }),
    true,
  );
  // …and the chip itself may shift one column when its own pins are ignored.
  assert.equal(
    canPlaceChip(doc, {
      ref: "7400",
      board: "bb1",
      anchor: "e6",
      ignoreId: "c1",
    }),
    true,
  );
  assert.equal(
    canPlaceChip(doc, { ref: "7400", board: "bb1", anchor: "e6" }),
    false,
  );
});

// ── Wire ends in the shared index (Feature 50) ───────────────────────────────

test("buildOccupancy: wire ends occupy alongside pins", () => {
  const doc = docWith({
    boards: [FULL],
    components: [
      { id: "c1", kind: "chip", ref: "7400", board: "bb1", anchor: "e5" },
    ],
  });
  doc.wires = [{ id: "w1", from: "bb1.a1", to: "bb1.t+3", color: "red" }];
  const occ = buildOccupancy(doc);
  assert.equal(occ.size, 16); // 14 pins + 2 wire ends
  assert.deepEqual(occ.get("bb1.a1"), {
    kind: "wire",
    wireId: "w1",
    end: "from",
  });
  assert.deepEqual(occ.get("bb1.t+3"), {
    kind: "wire",
    wireId: "w1",
    end: "to",
  });
});

test("isFreeHole: real + unoccupied only", () => {
  const doc = docWith({ boards: [FULL] });
  doc.wires = [{ id: "w1", from: "bb1.a1", to: "bb1.a5", color: "red" }];
  assert.equal(isFreeHole(doc, "bb1.a2"), true);
  assert.equal(isFreeHole(doc, "bb1.a1"), false); // wire end
  assert.equal(isFreeHole(doc, "bb1.a99"), false); // no such hole
  assert.equal(isFreeHole(doc, "bb9.a1"), false); // no such board
  assert.equal(isFreeHole(doc, "junk"), false);
});

test("canPlaceWire: free + distinct endpoints", () => {
  const doc = docWith({ boards: [FULL] });
  doc.wires = [{ id: "w1", from: "bb1.a1", to: "bb1.a5", color: "red" }];
  assert.equal(canPlaceWire(doc, "bb1.b1", "bb1.b5"), true);
  assert.equal(canPlaceWire(doc, "bb1.a1", "bb1.b5"), false); // occupied
  assert.equal(canPlaceWire(doc, "bb1.b1", "bb1.b1"), false); // same hole
});

test("wire ends block chip placement through the shared index", () => {
  const doc = docWith({ boards: [FULL] });
  doc.wires = [{ id: "w1", from: "bb1.e8", to: "bb1.a1", color: "red" }];
  // A 7400 at e5 needs e5..e11 — e8 is a wire end.
  assert.equal(
    canPlaceChip(doc, { ref: "7400", board: "bb1", anchor: "e5" }),
    false,
  );
  assert.equal(
    canPlaceChip(doc, { ref: "7400", board: "bb1", anchor: "e20" }),
    true,
  );
});

// ── Discrete parts + PSU terminals (Feature 60) ──────────────────────────────

test("partPinHoles: linear discretes in any grid row", () => {
  assert.deepEqual(partPinHoles("sw-slide", "b10"), [
    { pin: 1, hole: "b10" },
    { pin: 2, hole: "b11" },
    { pin: 3, hole: "b12" },
  ]);
  assert.deepEqual(partPinHoles("sw-push", "j5"), [
    { pin: 1, hole: "j5" },
    { pin: 2, hole: "j7" },
  ]);
  assert.deepEqual(partPinHoles("led", "f1"), [
    { pin: 1, hole: "f1" },
    { pin: 2, hole: "f2" },
  ]);
  assert.equal(partPinHoles("led", "t+3"), null); // rails don't anchor parts
  assert.equal(partPinHoles("psu", "b1"), null); // psu has terminals, not pins
});

test("canPlacePart: discretes across rows; edges clip", () => {
  const doc = docWith({ boards: [TINY] });
  assert.equal(
    canPlacePart(doc, { ref: "sw-slide", board: "bb2", anchor: "a15" }),
    true, // a15..a17 fits 17 columns
  );
  assert.equal(
    canPlacePart(doc, { ref: "sw-slide", board: "bb2", anchor: "a16" }),
    false, // a18 is off the board
  );
});

test("isFreeHole resolves PSU terminals; wires occupy them", () => {
  const doc = docWith({ boards: [FULL] });
  doc.components = [
    { id: "psu1", kind: "psu", ref: "psu", x: 80, y: 0, params: { volts: 5 } },
  ];
  doc.wires = [];
  assert.equal(isFreeHole(doc, "psu1.+"), true);
  assert.equal(isFreeHole(doc, "psu1.-"), true);
  assert.equal(isFreeHole(doc, "psu1.?"), false);
  assert.equal(isFreeHole(doc, "psu9.+"), false);
  doc.wires = [{ id: "w1", from: "psu1.+", to: "bb1.a1", color: "red" }];
  assert.equal(isFreeHole(doc, "psu1.+"), false);
  assert.equal(canPlaceWire(doc, "psu1.-", "bb1.t-1"), true);
  assert.equal(canPlaceWire(doc, "psu1.+", "bb1.t+1"), false);
});
