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

// migrations.test.js — the v1 → v2 desk upgrade (Feature 110), where a
// one-piece breadboard becomes three strips. These tests guard REAL user
// data: a saved desk must come back with every wire, chip and discrete still
// attached to the hole it was in.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { migrateDeskDocument } = require("../store/migrations");

/** A v1 document with one full board, wires on both rails, and parts. */
function v1Doc() {
  return {
    version: 1,
    boards: [{ id: "bb1", type: "full", x: 10, y: 20 }],
    components: [
      { id: "c1", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" },
      {
        id: "c2",
        kind: "discrete",
        ref: "resistor",
        board: "bb1",
        anchor: "a10",
        // v1 stored the far lead as a hole on the same board — here the
        // bottom − rail, the classic pull-down.
        params: { ohms: 10000, rot: 90, end: "b-3" },
      },
    ],
    wires: [
      { id: "w1", from: "bb1.t+7", to: "bb1.j7", color: "red" },
      { id: "w2", from: "bb1.b-2", to: "bb1.a2", color: "black" },
      { id: "w3", from: "bb1.a1", to: "bb1.j1", color: "blue" },
    ],
    nextBoardId: 2,
    nextComponentId: 3,
    nextPsuId: 1,
    nextWireId: 4,
  };
}

const byId = (doc, id) => doc.boards.find((b) => b.id === id);

test("v1 → v2: a full board becomes three grouped strips", () => {
  const doc = migrateDeskDocument(v1Doc());
  assert.equal(doc.version, 5); // migrateDeskDocument brings v1 fully current
  assert.equal(doc.boards.length, 3);

  // The pin-board KEEPS the original id, which is what lets grid addresses
  // and every component's board ref survive untouched.
  const pins = byId(doc, "bb1");
  assert.equal(pins.type, "pins-full");
  assert.deepEqual({ x: pins.x, y: pins.y }, { x: 10, y: 23 });

  const rails = doc.boards.filter((b) => b.type === "rail-full");
  assert.equal(rails.length, 2);
  assert.deepEqual(
    rails.map((r) => ({ x: r.x, y: r.y })).sort((a, b) => a.y - b.y),
    [
      { x: 10, y: 20 },
      { x: 10, y: 36 },
    ],
  );

  // All three share one group, so they drag as a unit.
  const groups = new Set(doc.boards.map((b) => b.group));
  assert.equal(groups.size, 1);
  assert.match([...groups][0], /^g[1-9]\d*$/);
});

test("v1 → v2: the three strips tile without gap or overlap", () => {
  const doc = migrateDeskDocument(v1Doc());
  const pins = byId(doc, "bb1");
  const [top, bottom] = doc.boards
    .filter((b) => b.type === "rail-full")
    .sort((a, b) => a.y - b.y);

  // Heights are 3 / 13 / 3, so each strip's bottom edge is the next one's
  // top edge — the assembly reads as one board with no seam of bare desk.
  assert.equal(top.y + 3, pins.y);
  assert.equal(pins.y + 13, bottom.y);
  assert.equal(bottom.y + 3 - top.y, 19); // a full kit is 19 tall
  // Every strip shares the left edge, so the stack is flush.
  assert.equal(new Set(doc.boards.map((b) => b.x)).size, 1);
});

test("v1 → v2: rail and grid rows keep their order and spacing", () => {
  const doc = migrateDeskDocument(v1Doc());
  const pins = byId(doc, "bb1");
  const [top, bottom] = doc.boards
    .filter((b) => b.type === "rail-full")
    .sort((a, b) => a.y - b.y);

  // Absolute rows after centring: `+`/`-` at strip+1/+2, grid j…a at +1…+12.
  const topMinus = top.y + 2;
  const rowJ = pins.y + 1;
  const rowA = pins.y + 12;
  const bottomPlus = bottom.y + 1;
  assert.ok(topMinus < rowJ, "top rail sits above the grid");
  assert.ok(rowA < bottomPlus, "bottom rail sits below the grid");
  assert.equal(rowA - rowJ, 11); // ten rows plus the two-pitch trench
});

test("v1 → v2: rail wire endpoints re-owner; grid endpoints do not", () => {
  const doc = migrateDeskDocument(v1Doc());
  const [top, bottom] = doc.boards
    .filter((b) => b.type === "rail-full")
    .sort((a, b) => a.y - b.y);
  const wire = (id) => doc.wires.find((w) => w.id === id);

  assert.equal(wire("w1").from, `${top.id}.+7`);
  assert.equal(wire("w1").to, "bb1.j7"); // grid end untouched
  assert.equal(wire("w2").from, `${bottom.id}.-2`);
  assert.equal(wire("w2").to, "bb1.a2");
  // A wire with no rail end is byte-for-byte unchanged.
  assert.deepEqual(wire("w3"), {
    id: "w3",
    from: "bb1.a1",
    to: "bb1.j1",
    color: "blue",
  });
});

test("v1 → v2: components keep their board and anchor", () => {
  const doc = migrateDeskDocument(v1Doc());
  const chip = doc.components.find((c) => c.id === "c1");
  assert.equal(chip.board, "bb1"); // the pin-board
  assert.equal(chip.anchor, "e5");
});

test("v1 → v2: a rotated lead's hole becomes a geometric bend", () => {
  const doc = migrateDeskDocument(v1Doc());
  const resistor = doc.components.find((c) => c.id === "c2");
  // Resolved in the v2 kit frame: anchor a10 on the pin-board (origin +3) is
  // at (10, 15); the far lead in b-3 on the bottom rail (origin +16) is at
  // (5, 18) — rail holes run in groups of five from railStartX 3. Bend (-5, +3).
  assert.deepEqual(resistor.params.end, { dx: -5, dy: 3 });
  assert.equal(resistor.params.rot, 90);
  assert.equal(resistor.params.ohms, 10000);
  assert.equal(resistor.anchor, "a10"); // the part has not moved
});

test("v1 → v2: an unconvertible lead drops the bend, keeping the seat", () => {
  const raw = v1Doc();
  raw.components[1].params.end = "zz99";
  const doc = migrateDeskDocument(raw);
  const resistor = doc.components.find((c) => c.id === "c2");
  assert.equal(resistor.params.end, null);
  assert.equal(resistor.anchor, "a10");
});

test("v1 → v2: a tiny board just renames — it never had rails", () => {
  const doc = migrateDeskDocument({
    version: 1,
    boards: [{ id: "bb1", type: "tiny", x: 4, y: 5 }],
    components: [],
    wires: [{ id: "w1", from: "bb1.a1", to: "bb1.j1", color: "red" }],
    nextBoardId: 2,
  });
  assert.deepEqual(doc.boards, [
    { id: "bb1", type: "pins-tiny", x: 4, y: 5, group: null },
  ]);
  assert.equal(doc.wires[0].from, "bb1.a1");
});

test("v1 → v2: id counters clear every id the split allocated", () => {
  const doc = migrateDeskDocument({
    version: 1,
    boards: [
      { id: "bb1", type: "full", x: 0, y: 0 },
      { id: "bb7", type: "half", x: 0, y: 40 },
    ],
    components: [],
    wires: [],
    nextBoardId: 8,
  });
  const ids = doc.boards.map((b) => Number(/^bb(\d+)$/.exec(b.id)[1]));
  assert.ok(doc.nextBoardId > Math.max(...ids));
  assert.equal(new Set(doc.boards.map((b) => b.id)).size, 6);
  // Two boards → two distinct groups, three strips each.
  const groups = doc.boards.map((b) => b.group);
  assert.equal(new Set(groups).size, 2);
  assert.ok(doc.nextGroupId > 2);
});

test("v1 → v2 is not applied twice", () => {
  const once = migrateDeskDocument(v1Doc());
  const twice = migrateDeskDocument(once);
  assert.deepEqual(twice, once);
});

test("v2 → v3: net names + annotations arrays are added (additive)", () => {
  const v2 = {
    version: 2,
    boards: [{ id: "bb1", type: "pins-tiny", x: 0, y: 0, group: null }],
    components: [],
    wires: [],
    nextBoardId: 2,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
  };
  const doc = migrateDeskDocument(v2);
  assert.equal(doc.version, 5);
  assert.deepEqual(doc.netNames, []);
  assert.deepEqual(doc.annotations, []);
  assert.equal(doc.nextAnnotationId, 1);
  // Boards/wires are untouched — a pure additive step, no address rewriting.
  assert.deepEqual(doc.boards, v2.boards);
});

test("v2 → v3: preserves already-present names + annotations", () => {
  const doc = migrateDeskDocument({
    version: 2,
    boards: [],
    components: [],
    wires: [],
    netNames: [{ address: "bb1.a5", name: "VCC" }],
    annotations: [{ id: "an1", kind: "label", x: 1, y: 2, text: "hi" }],
    nextAnnotationId: 2,
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
  });
  assert.equal(doc.version, 5);
  assert.deepEqual(doc.netNames, [{ address: "bb1.a5", name: "VCC" }]);
  assert.equal(doc.annotations.length, 1);
  assert.equal(doc.nextAnnotationId, 2);
});

test("v3 → v4: buses array + id counter are added (additive)", () => {
  const doc = migrateDeskDocument({
    version: 3,
    boards: [],
    components: [],
    wires: [],
    netNames: [],
    annotations: [],
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
    nextAnnotationId: 1,
  });
  assert.equal(doc.version, 5);
  assert.deepEqual(doc.buses, []);
  assert.equal(doc.nextBusId, 1);
});

test("v3 → v4: preserves already-present buses + counter", () => {
  const doc = migrateDeskDocument({
    version: 3,
    boards: [],
    components: [],
    wires: [{ id: "w1", from: "bb1.a1", to: "bb1.a2", color: "red" }],
    buses: [
      { id: "bus1", name: "D[1:0]", width: 2, color: "blue", members: ["w1"] },
    ],
    nextBusId: 2,
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 2,
    nextAnnotationId: 1,
  });
  assert.equal(doc.version, 5);
  assert.equal(doc.buses.length, 1);
  assert.equal(doc.buses[0].id, "bus1");
  assert.equal(doc.nextBusId, 2);
});

test("v4 → v5: a pure version bump (schematic hints need no doc-level state)", () => {
  const v4 = {
    version: 4,
    boards: [{ id: "bb1", type: "pins-tiny", x: 0, y: 0, group: null }],
    components: [
      { id: "c1", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" },
    ],
    wires: [],
    buses: [],
    netNames: [],
    annotations: [],
    nextBoardId: 2,
    nextGroupId: 1,
    nextComponentId: 2,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
    nextBusId: 1,
    nextAnnotationId: 1,
  };
  const doc = migrateDeskDocument(v4);
  assert.equal(doc.version, 5);
  // Everything else passes through untouched — nothing to default.
  assert.deepEqual(doc.components, v4.components);
  assert.deepEqual(doc.boards, v4.boards);
});
