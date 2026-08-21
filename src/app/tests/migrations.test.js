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

const {
  DESK_DOC_VERSION,
  defaultDeskDocument,
  migrateDeskDocument,
} = require("../store/migrations");

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
const round2 = (n) => Math.round(n * 100) / 100;

test("v1 → v2: a full board becomes three grouped strips", () => {
  const doc = migrateDeskDocument(v1Doc());
  assert.equal(doc.version, DESK_DOC_VERSION); // brought fully current
  assert.equal(doc.boards.length, 3);

  // The pin-board KEEPS the original id, which is what lets grid addresses
  // and every component's board ref survive untouched.
  // NOTE these are the positions a v1 document arrives at FULLY CURRENT: the
  // v1 → v2 split put the strips at 20 / 23 / 36, and v10 → v11 re-flowed them
  // at the strips' measured heights (3.50 and 14.02). Every test here migrates
  // the whole chain, so it states the end of it.
  const pins = byId(doc, "bb1");
  assert.equal(pins.type, "pins-full");
  assert.deepEqual({ x: pins.x, y: pins.y }, { x: 10, y: 23.5 });

  const rails = doc.boards.filter((b) => b.type === "rail-full");
  assert.equal(rails.length, 2);
  assert.deepEqual(
    rails.map((r) => ({ x: r.x, y: r.y })).sort((a, b) => a.y - b.y),
    [
      { x: 10, y: 20 },
      { x: 10, y: 37.52 },
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

  // Heights are 3.50 / 14.02 / 3.50 (measured — 8.9 and 35.6 mm), so each
  // strip's bottom edge is the next one's top edge and the assembly reads as
  // one board with no seam of bare desk.
  // Rounded on both sides: the stack is stored on the 0.01 grid, and a sum of
  // two measured heights lands a hair off it in binary — which is precisely why
  // the live mating rule compares flush edges with a tolerance.
  assert.equal(round2(top.y + 3.5), pins.y);
  assert.equal(round2(pins.y + 14.02), bottom.y);
  assert.equal(round2(bottom.y + 3.5 - top.y), 21.02); // a full kit, 53.4 mm
  // Every strip shares the left edge, so the stack is flush.
  assert.equal(new Set(doc.boards.map((b) => b.x)).size, 1);
});

test("v1 → v2: rail and grid rows keep their order and spacing", () => {
  const doc = migrateDeskDocument(v1Doc());
  const pins = byId(doc, "bb1");
  const [top, bottom] = doc.boards
    .filter((b) => b.type === "rail-full")
    .sort((a, b) => a.y - b.y);

  // Absolute rows: a rail's `+`/`-` at strip+1.25/+2.25 (one pitch apart), grid
  // j…a at +1.51…+12.51 (board-types.js measures the plastic around them).
  const topMinus = top.y + 2.25;
  const rowJ = pins.y + 1.51;
  const rowA = pins.y + 12.51;
  const bottomPlus = bottom.y + 1.25;
  assert.ok(topMinus < rowJ, "top rail sits above the grid");
  assert.ok(rowA < bottomPlus, "bottom rail sits below the grid");
  assert.equal(round2(rowA - rowJ), 11); // ten rows plus the channel
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
  assert.equal(doc.version, DESK_DOC_VERSION);
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
  assert.equal(doc.version, DESK_DOC_VERSION);
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
  assert.equal(doc.version, DESK_DOC_VERSION);
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
  assert.equal(doc.version, DESK_DOC_VERSION);
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
  assert.equal(doc.version, DESK_DOC_VERSION);
  // Everything else passes through untouched — nothing to default.
  assert.deepEqual(doc.components, v4.components);
  assert.deepEqual(doc.boards, v4.boards);
});

// The LCD brick counter was added at v6 and retired at v10, when the HD44780
// stopped being a desk brick and became two board-seated modules. Both steps
// are history now, so what the chain has to get right is that a v5 document
// arrives with the field GONE — whether or not it was carrying one.
for (const [what, nextLcdId] of [
  ["never had one", undefined],
  ["was carrying one", 4],
]) {
  test(`v5 → current: the LCD brick counter is retired (doc ${what})`, () => {
    const doc = migrateDeskDocument({
      version: 5,
      boards: [],
      components: [],
      wires: [],
      buses: [],
      netNames: [],
      annotations: [],
      nextBoardId: 1,
      nextGroupId: 1,
      nextComponentId: 1,
      nextPsuId: 1,
      nextClockId: 1,
      ...(nextLcdId === undefined ? {} : { nextLcdId }),
      nextWireId: 1,
      nextBusId: 1,
      nextAnnotationId: 1,
    });
    assert.equal(doc.version, DESK_DOC_VERSION);
    assert.ok(!("nextLcdId" in doc));
  });
}

test("v9 → v10: drops nextLcdId and touches nothing else", () => {
  const v9 = {
    version: 9,
    boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }],
    components: [],
    wires: [],
    buses: [],
    netNames: [],
    annotations: [],
    nextBoardId: 2,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextLcdId: 7,
    nextWireId: 1,
    nextBusId: 1,
    nextAnnotationId: 1,
  };
  const doc = migrateDeskDocument(v9);
  assert.equal(doc.version, DESK_DOC_VERSION);
  assert.ok(!("nextLcdId" in doc));
  const { version: _v, nextLcdId: _n, ...restBefore } = v9;
  const { version: _v2, ...restAfter } = doc;
  assert.deepEqual(restAfter, restBefore);
});

test("v6 → v7: a pure version bump — Name/Description need no defaulting", () => {
  const v6 = {
    version: 6,
    boards: [
      {
        id: "bb1",
        type: "pins-full",
        x: 0,
        y: 0,
        rot: 0,
        group: null,
        name: "Main board",
      },
    ],
    components: [],
    wires: [],
    buses: [],
    netNames: [],
    annotations: [],
    nextBoardId: 2,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextLcdId: 1,
    nextWireId: 1,
    nextBusId: 1,
    nextAnnotationId: 1,
  };
  const doc = migrateDeskDocument(v6);
  assert.equal(doc.version, DESK_DOC_VERSION);
  // Everything else passes through untouched — nothing to default.
  assert.deepEqual(doc.boards, v6.boards);
});

test("v7 → v8: a pure version bump — wire Name/Description need no defaulting", () => {
  const v7 = {
    version: 7,
    boards: [],
    components: [],
    wires: [
      { id: "w1", from: "bb1.a1", to: "bb1.a5", color: "red", name: "reset" },
    ],
    buses: [],
    netNames: [],
    annotations: [],
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextLcdId: 1,
    nextWireId: 2,
    nextBusId: 1,
    nextAnnotationId: 1,
  };
  const doc = migrateDeskDocument(v7);
  assert.equal(doc.version, DESK_DOC_VERSION);
  // Everything else passes through untouched — nothing to default.
  assert.deepEqual(doc.wires, v7.wires);
});

test("v8 → v9: a pure version bump — a wire with no layout IS a direct wire", () => {
  const v8 = {
    version: 8,
    boards: [],
    components: [],
    wires: [{ id: "w1", from: "bb1.a1", to: "bb1.a5", color: "red" }],
    buses: [],
    netNames: [],
    annotations: [],
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextLcdId: 1,
    nextWireId: 2,
    nextBusId: 1,
    nextAnnotationId: 1,
  };
  const doc = migrateDeskDocument(v8);
  assert.equal(doc.version, DESK_DOC_VERSION);
  // Absence is the default, so the wire comes through with nothing added —
  // no `layout`, no `points`, exactly the sagging wire it has always been.
  assert.deepEqual(doc.wires, v8.wires);
});

// ── v10 → v11: the strips stopped being whole pitches tall ───────────────────

/** A v10 document holding `boards`, with every other field at its default. */
function v10With(boards) {
  return {
    version: 10,
    boards,
    components: [],
    wires: [],
    buses: [],
    netNames: [],
    annotations: [],
    nextBoardId: boards.length + 1,
    nextGroupId: 2,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
    nextBusId: 1,
    nextAnnotationId: 1,
  };
}

test("v10 → v11: an 830 kit is re-stacked at the strips' measured heights", () => {
  // The old stack: rail 3 tall, pin-board 13. Under the new heights (3.50 and
  // 14.02) the pin-board would reach straight through the bottom rail, and the
  // renderer drops a board that overlaps one already loaded — silently taking
  // its seated parts and wires with it.
  const doc = migrateDeskDocument(
    v10With([
      { id: "bb1", type: "rail-full", x: 10, y: 0, rot: 0, group: "g1" },
      { id: "bb2", type: "pins-full", x: 10, y: 3, rot: 0, group: "g1" },
      { id: "bb3", type: "rail-full", x: 10, y: 16, rot: 0, group: "g1" },
    ]),
  );
  assert.equal(doc.version, DESK_DOC_VERSION);
  // The top strip stays where the user put it; the rest re-flow under it.
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.x, b.y]),
    [
      ["bb1", 10, 0],
      ["bb2", 10, 3.5],
      ["bb3", 10, 17.52],
    ],
  );
  // Nothing else about a board is touched.
  assert.deepEqual(
    doc.boards.map((b) => b.group),
    ["g1", "g1", "g1"],
  );
});

test("v10 → v11: only FLUSH runs re-flow; a gap is a gap and stays one", () => {
  const doc = migrateDeskDocument(
    v10With([
      { id: "bb1", type: "pins-full", x: 0, y: 0, rot: 0, group: null },
      // Two pitch of daylight below it — not a dovetail, so not this step's
      // business. The strips' own growth (1.02) stays clear of it.
      { id: "bb2", type: "pins-full", x: 0, y: 15, rot: 0, group: null },
      // Side by side rather than stacked: same y, so nothing to re-flow.
      { id: "bb3", type: "pins-full", x: 64, y: 0, rot: 0, group: null },
    ]),
  );
  assert.deepEqual(
    doc.boards.map((b) => b.y),
    [0, 15, 0],
  );
});

test("v10 → v11: runs re-flow from their own top, wherever that is", () => {
  // A rail dovetailed ABOVE a pin-board: the rail is the head, so it keeps its
  // y and the board moves down to meet its new bottom edge.
  const doc = migrateDeskDocument(
    v10With([
      { id: "bb1", type: "pins-half", x: 0, y: 3, rot: 0, group: "g1" },
      { id: "bb2", type: "rail-half", x: 0, y: 0, rot: 0, group: "g1" },
    ]),
  );
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y]),
    [
      ["bb1", 3.5],
      ["bb2", 0],
    ],
  );
});

test("v10 → v11: idempotent, because a v10 dovetail cannot exist at v11", () => {
  // Every pair flush under the OLD heights OVERLAPS under the new ones, which
  // is exactly the breakage this step repairs — so a document already at the
  // new geometry has no run for it to find, and re-running changes nothing.
  const once = migrateDeskDocument(
    v10With([
      { id: "bb1", type: "rail-full", x: 0, y: 0, rot: 0, group: "g1" },
      { id: "bb2", type: "pins-full", x: 0, y: 3, rot: 0, group: "g1" },
      { id: "bb3", type: "rail-full", x: 0, y: 16, rot: 0, group: "g1" },
    ]),
  );
  const twice = migrateDeskDocument({ ...once, version: 10 });
  assert.deepEqual(twice.boards, once.boards);
});

test("v10 → v11: an upright rail keeps its own footprint", () => {
  // A rail stood on end is 3.50 WIDE and 64 tall, so it stacks with nothing of
  // a pin-board's width — the size table has to honour the rotation, or the
  // step would invent a dovetail and shove a signal bus down the desk.
  const doc = migrateDeskDocument(
    v10With([
      { id: "bb1", type: "rail-full", x: 0, y: 0, rot: 90, group: null },
      { id: "bb2", type: "pins-full", x: 4, y: 0, rot: 0, group: null },
    ]),
  );
  assert.deepEqual(
    doc.boards.map((b) => b.y),
    [0, 0],
  );
});

// ── v11 → v12: the bussed resistor array's renumbering ──────────────────────

/** A v11 document holding the given components. */
function v11With(components) {
  return {
    ...defaultDeskDocument(),
    version: 11,
    boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0, rot: 0, group: null }],
    components,
    nextComponentId: components.length + 1,
  };
}

test("v11 → v12: every rnet9 is turned end-for-end, and nothing else moves", () => {
  // The renumbering moved the common bus from pin 9 to pin 1 — and since pin 1
  // is the ANCHOR hole, that also moved it from the far end of the nine to the
  // near one. A desk saved before the change has a wire running from a rail to
  // the hole that WAS the common. Stamping the half lap reverses the numbering
  // back over the same nine holes, so that wire still lands on the common and
  // every element still lands on the hole it was plugged into.
  const doc = migrateDeskDocument(
    v11With([
      {
        id: "c1",
        kind: "discrete",
        ref: "rnet9",
        board: "bb1",
        anchor: "a10",
        params: { ohms: 4700 },
      },
      {
        id: "c2",
        kind: "discrete",
        ref: "resistor",
        board: "bb1",
        anchor: "a30",
        params: { ohms: 220 },
      },
    ]),
  );
  assert.equal(doc.version, DESK_DOC_VERSION);
  assert.deepEqual(doc.components[0].params, { ohms: 4700, rot: 180 });
  assert.equal(doc.components[0].anchor, "a10", "it does not move a hole");
  assert.deepEqual(doc.components[1].params, { ohms: 220 }, "nothing else");
});

test("v11 → v12: an array already turned round stays turned; junk params survive", () => {
  // A v11 desk could not carry a rot on this part at all (normalizeParams
  // dropped it), so `rot: 180` is what EVERY one of them becomes — there is no
  // pre-existing orientation to preserve and none to double-flip.
  const doc = migrateDeskDocument(
    v11With([
      { id: "c1", kind: "discrete", ref: "rnet9", board: "bb1", anchor: "a1" },
      {
        id: "c2",
        kind: "discrete",
        ref: "rnet9",
        board: "bb1",
        anchor: "a20",
        params: { ohms: 1000, rot: 180 },
      },
    ]),
  );
  assert.deepEqual(doc.components[0].params, { rot: 180 });
  assert.deepEqual(doc.components[1].params, { ohms: 1000, rot: 180 });
});

test("v11 → v12: a document with no components is a plain version bump", () => {
  const doc = migrateDeskDocument({ ...defaultDeskDocument(), version: 11 });
  assert.equal(doc.version, DESK_DOC_VERSION);
  assert.deepEqual(doc.components, []);
  // …and junk in the field does not throw on the way through.
  const junk = migrateDeskDocument({
    ...defaultDeskDocument(),
    version: 11,
    components: [null, "nope", 7],
  });
  assert.equal(junk.version, DESK_DOC_VERSION);
});

test("the renderer stamps the SAME version main migrates to", () => {
  // These two numbers are one contract in two files, and they DRIFTED once —
  // the renderer sat at 6 while the chain reached 11, so every desk the app
  // saved re-entered the chain five steps back. That is invisible while the
  // steps between are pure bumps, and it makes a migration keyed on a version
  // fire on documents written AFTER the change it exists to repair.
  return import("../../web/scripts/model/desk-doc.js").then((m) => {
    assert.equal(m.DOC_VERSION, DESK_DOC_VERSION);
  });
});
