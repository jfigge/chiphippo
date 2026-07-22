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
  canMoveWire,
  canPlaceChip,
  canPlacePart,
  canPlaceWire,
  canReendWire,
  chipPinHoles,
  holeAtWorld,
  isFreeHole,
  partPinAddresses,
  partPinHoles,
} from "../model/occupancy.js";

function docWith({ boards, components = [] }) {
  return { boards, components };
}

const FULL = { id: "bb1", type: "pins-full", x: 0, y: 0 };
const TINY = { id: "bb2", type: "pins-tiny", x: 100, y: 0 };
const RAIL = { id: "bb3", type: "rail-full", x: 0, y: -4 };

test("chipPinHoles: derives the 14 seated holes of a 74LS00 at e5", () => {
  const pins = chipPinHoles("74LS00", "e5");
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
  assert.equal(chipPinHoles("74LS00", "f5"), null);
  assert.equal(chipPinHoles("74LS00", "+3"), null);
  assert.equal(chipPinHoles("74LS00", null), null);
});

test("partPinHoles: a rotated resistor derives a seated pin plus a free lead", () => {
  // Horizontal (no rot) still uses the footprint offsets.
  assert.deepEqual(partPinHoles("resistor", "a5"), [
    { pin: 1, hole: "a5" },
    { pin: 2, hole: "a8" },
  ]);
  // Rotated: pin 1 at the anchor hole, pin 2 a {dx, dy} BEND from it. Which
  // hole (or strip, or nothing) that reaches depends on the whole desk, so
  // this stops at the geometry — partPinAddresses resolves it.
  assert.deepEqual(
    partPinHoles("resistor", "j3", { rot: 90, end: { dx: 0, dy: -4 } }),
    [
      { pin: 1, hole: "j3" },
      { pin: 2, offset: { dx: 0, dy: -4 } },
    ],
  );
  // Rotated with no bend, or an off-lattice one → unresolvable.
  assert.equal(partPinHoles("resistor", "j3", { rot: 90, end: null }), null);
  assert.equal(
    partPinHoles("resistor", "j3", { rot: 90, end: { dx: 0.5, dy: 1 } }),
    null,
  );
  // A turned two-terminal part may ANCHOR on a rail too, so BOTH leads can
  // reach rails: pin 1 seats in the rail hole, pin 2 bends off it. (Whether
  // that rail hole actually exists is partPinAddresses' parseHole check.)
  assert.deepEqual(
    partPinHoles("resistor", "-3", { rot: 90, end: { dx: 0, dy: 3 } }),
    [
      { pin: 1, hole: "-3" },
      { pin: 2, offset: { dx: 0, dy: 3 } },
    ],
  );
  // A non-rotatable part ignores rot and keeps its footprint.
  assert.deepEqual(
    partPinHoles("sw-push", "a5", { rot: 90, end: { dx: 0, dy: -2 } }),
    [
      { pin: 1, hole: "a5" },
      { pin: 2, hole: "a7" },
    ],
  );
  // An LED is rotatable too, with its own free lead.
  assert.deepEqual(
    partPinHoles("led", "j2", { rot: 90, end: { dx: 1, dy: -3 } }),
    [
      { pin: 1, hole: "j2" },
      { pin: 2, offset: { dx: 1, dy: -3 } },
    ],
  );
});

test("canPlacePart / buildOccupancy: a rotated resistor's lead reaches the rail strip", () => {
  const doc = docWith({ boards: [FULL, RAIL] });
  // Pin 1 seats at j7 (world 7, 1); the lead bends 3 UP onto the rail strip
  // above (its `-` rail sits at world y −2, where hole −5 is at x 7).
  const rot = { rot: 90, end: { dx: 0, dy: -3 } };
  assert.equal(
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb1",
      anchor: "j7",
      params: rot,
    }),
    true,
  );
  // A rotated part pinned to ONE hole (a zero bend) is nonsense.
  assert.equal(
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb1",
      anchor: "j7",
      params: { rot: 90, end: { dx: 0, dy: 0 } },
    }),
    false,
  );
  // A lead landing on bare desk FLOATS — legal as a leftover when a strip is
  // pulled away, never as a deliberate placement.
  assert.equal(
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb1",
      anchor: "j7",
      params: { rot: 90, end: { dx: 0, dy: -8 } },
    }),
    false,
  );
  // …and so does one landing between a rail's hole groups (x 8 is the gap).
  assert.equal(
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb1",
      anchor: "j7",
      params: { rot: 90, end: { dx: 1, dy: -3 } },
    }),
    false,
  );
  // Occupancy records BOTH ends — the far one under its own strip's id.
  doc.components = [
    {
      id: "r1",
      kind: "discrete",
      ref: "resistor",
      board: "bb1",
      anchor: "j7",
      params: rot,
    },
  ];
  const occ = buildOccupancy(doc);
  assert.equal(occ.get("bb1.j7").componentId, "r1");
  assert.equal(occ.get("bb3.-5").componentId, "r1");
  // A second part cannot reuse either occupied end — here the rail hole,
  // reached from a different anchor (i7, world 7 2 → 4 up lands on bb3.-5).
  assert.equal(
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb1",
      anchor: "i7",
      params: { rot: 90, end: { dx: 0, dy: -4 } },
    }),
    false,
  );
});

test("canPlacePart: a resistor's ends must be at least minSpan apart", () => {
  const doc = docWith({ boards: [FULL] });
  const at = (anchor, end) =>
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb1",
      anchor,
      params: { rot: 90, end },
    });
  // a10 sits at (10, 12); the minimum span is 3 pitch units.
  assert.equal(at("a10", { dx: 3, dy: 0 }), true); // a13, exactly 3 → allowed
  assert.equal(at("a10", { dx: 2, dy: 0 }), false); // a12, 2 → too close
  assert.equal(at("a10", { dx: 1, dy: 0 }), false); // a11, 1 → too close
  // Diagonals use true distance, not row/column counts: a10→c12 is √8 ≈ 2.83.
  assert.equal(at("a10", { dx: 2, dy: -2 }), false);
  assert.equal(at("a10", { dx: 3, dy: -2 }), true); // c13, √13 ≈ 3.6 → allowed
  // Any distance BEYOND the minimum is fine — including clear across the trench.
  assert.equal(at("a10", { dx: -9, dy: -11 }), true); // j1
});

test("partPinAddresses: a lead whose strip went away floats, it doesn't vanish", () => {
  const comp = {
    id: "r1",
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "j7",
    params: { rot: 90, end: { dx: 0, dy: -3 } },
  };
  // With the rail strip present the lead resolves onto it.
  assert.deepEqual(partPinAddresses(docWith({ boards: [FULL, RAIL] }), comp), [
    { pin: 1, address: "bb1.j7" },
    { pin: 2, address: "bb3.-5" },
  ]);
  // Take the rail away and the SEATED pin is untouched; only the bend loses
  // its hole. The part is still fully resolvable — a null address, not null.
  assert.deepEqual(partPinAddresses(docWith({ boards: [FULL] }), comp), [
    { pin: 1, address: "bb1.j7" },
    { pin: 2, address: null },
  ]);
  // A floating lead occupies nothing, so the hole it used to hold is free.
  const doc = docWith({ boards: [FULL], components: [comp] });
  assert.equal(buildOccupancy(doc).size, 1);
  assert.equal(isFreeHole(doc, "bb1.j7"), false);
  // Only the part's own board must exist — a missing one is unresolvable.
  assert.equal(partPinAddresses(docWith({ boards: [RAIL] }), comp), null);
});

test("buildOccupancy: one entry per pin, addressed globally", () => {
  const doc = docWith({
    boards: [FULL],
    components: [
      { id: "c1", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" },
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

test("canPlaceChip: happy path on the full and tiny pin-boards", () => {
  const doc = docWith({ boards: [FULL, TINY] });
  assert.equal(
    canPlaceChip(doc, { ref: "74LS00", board: "bb1", anchor: "e5" }),
    true,
  );
  // A DIP-14 needs 7 columns: the tiny pin-board (17 cols) fits it at e1…e11.
  assert.equal(
    canPlaceChip(doc, { ref: "74LS125", board: "bb2", anchor: "e11" }),
    true,
  );
});

test("canPlaceChip: rejects off-board, bad anchors, unknown boards/refs", () => {
  const doc = docWith({ boards: [FULL, TINY] });
  // The full pin-board has 63 columns: e58 puts pin 7 at e64 — off the board.
  assert.equal(
    canPlaceChip(doc, { ref: "74LS00", board: "bb1", anchor: "e58" }),
    false,
  );
  assert.equal(
    canPlaceChip(doc, { ref: "74LS00", board: "bb2", anchor: "e12" }),
    false, // tiny: pin 7 would land at e18 (only 17 columns)
  );
  assert.equal(
    canPlaceChip(doc, { ref: "74LS00", board: "bb1", anchor: "f5" }),
    false, // anchor must be row e
  );
  assert.equal(
    canPlaceChip(doc, { ref: "74LS00", board: "bb9", anchor: "e5" }),
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
      { id: "c1", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" },
    ],
  });
  // Overlapping the seated 74LS00 (columns 5–11) fails…
  assert.equal(
    canPlaceChip(doc, { ref: "74LS04", board: "bb1", anchor: "e11" }),
    false,
  );
  // …the next free column succeeds…
  assert.equal(
    canPlaceChip(doc, { ref: "74LS04", board: "bb1", anchor: "e12" }),
    true,
  );
  // …and the chip itself may shift one column when its own pins are ignored.
  assert.equal(
    canPlaceChip(doc, {
      ref: "74LS00",
      board: "bb1",
      anchor: "e6",
      ignoreId: "c1",
    }),
    true,
  );
  assert.equal(
    canPlaceChip(doc, { ref: "74LS00", board: "bb1", anchor: "e6" }),
    false,
  );
});

// ── Wire ends in the shared index (Feature 50) ───────────────────────────────

test("buildOccupancy: wire ends occupy alongside pins", () => {
  const doc = docWith({
    boards: [FULL, RAIL],
    components: [
      { id: "c1", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" },
    ],
  });
  // A cross-strip wire: pin-board hole → rail-strip hole.
  doc.wires = [{ id: "w1", from: "bb1.a1", to: "bb3.+3", color: "red" }];
  const occ = buildOccupancy(doc);
  assert.equal(occ.size, 16); // 14 pins + 2 wire ends
  assert.deepEqual(occ.get("bb1.a1"), {
    kind: "wire",
    wireId: "w1",
    end: "from",
  });
  assert.deepEqual(occ.get("bb3.+3"), {
    kind: "wire",
    wireId: "w1",
    end: "to",
  });
});

test("canReendWire: moves an end to a free point, ignoring the wire itself", () => {
  const doc = docWith({
    boards: [FULL],
    components: [
      { id: "c1", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" },
    ],
  });
  doc.wires = [
    { id: "w1", from: "bb1.a1", to: "bb1.a10", color: "red" },
    { id: "w2", from: "bb1.b1", to: "bb1.b10", color: "blue" },
  ];
  // Move w1.from to a free hole.
  assert.equal(canReendWire(doc, "w1", "from", "bb1.a2"), true);
  // Its own current endpoints don't block the move (from can land on w1.to's
  // node partner, or stay put) — the moving wire is ignored in occupancy.
  assert.equal(canReendWire(doc, "w1", "from", "bb1.a1"), true); // no-op onto itself
  // …but never onto the wire's OTHER (anchored) end.
  assert.equal(canReendWire(doc, "w1", "to", "bb1.a1"), false);
  // Occupied by a DIFFERENT wire or a chip pin → rejected.
  assert.equal(canReendWire(doc, "w1", "from", "bb1.b1"), false); // w2 end
  assert.equal(canReendWire(doc, "w1", "from", "bb1.e5"), false); // c1 pin 1
  // Unreal points and bad ids/ends → rejected.
  assert.equal(canReendWire(doc, "w1", "from", "bb1.a99"), false);
  assert.equal(canReendWire(doc, "w1", "middle", "bb1.a2"), false);
  assert.equal(canReendWire(doc, "w9", "from", "bb1.a2"), false);
});

test("canMoveWire: both ends must land on real, free points; ignores itself", () => {
  const doc = docWith({
    boards: [FULL],
    components: [
      { id: "c1", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" },
    ],
  });
  doc.wires = [
    { id: "w1", from: "bb1.a1", to: "bb1.a10", color: "red" },
    { id: "w2", from: "bb1.b1", to: "bb1.b10", color: "blue" },
  ];
  // Rigid translation onto two free holes.
  assert.equal(canMoveWire(doc, "w1", "bb1.a2", "bb1.a11"), true);
  // A no-op back onto its own two endpoints — the moving wire is ignored.
  assert.equal(canMoveWire(doc, "w1", "bb1.a1", "bb1.a10"), true);
  // Either end onto a DIFFERENT wire's end or a chip pin → rejected.
  assert.equal(canMoveWire(doc, "w1", "bb1.b1", "bb1.a11"), false); // w2 end
  assert.equal(canMoveWire(doc, "w1", "bb1.a2", "bb1.e5"), false); // c1 pin 1
  // Coincident, unreal, or malformed endpoints → rejected.
  assert.equal(canMoveWire(doc, "w1", "bb1.a2", "bb1.a2"), false); // same point
  assert.equal(canMoveWire(doc, "w1", "bb1.a99", "bb1.a2"), false); // unreal
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
  // A 74LS00 at e5 needs e5..e11 — e8 is a wire end.
  assert.equal(
    canPlaceChip(doc, { ref: "74LS00", board: "bb1", anchor: "e5" }),
    false,
  );
  assert.equal(
    canPlaceChip(doc, { ref: "74LS00", board: "bb1", anchor: "e20" }),
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
  assert.equal(partPinHoles("led", "+3"), null); // linear form is grid-only
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
  const doc = docWith({ boards: [FULL, RAIL] });
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
  assert.equal(canPlaceWire(doc, "psu1.-", "bb3.-1"), true);
  assert.equal(canPlaceWire(doc, "psu1.+", "bb3.+1"), false);
});

// ── holeAtWorld: the one "what is under this point" scan ────────────────────

test("holeAtWorld: reports the board, the hole, and its exact world position", () => {
  const hit = holeAtWorld([FULL, TINY], 5, 1);
  assert.equal(hit.board.id, "bb1");
  assert.equal(hit.hole, "j5");
  // The position is the HOLE's, snapped off the lattice — not the query point.
  assert.deepEqual({ x: hit.x, y: hit.y }, { x: 5, y: 1 });
  assert.equal(holeAtWorld([FULL], 5, 6.5), null); // the trench
  assert.equal(holeAtWorld([FULL], 500, 500), null); // bare desk
  assert.equal(holeAtWorld([], 5, 1), null);
});

test("holeAtWorld: a junk board type is skipped, not thrown over", () => {
  const junk = { id: "bb8", type: "not-a-board", x: 0, y: 0 };
  assert.equal(holeAtWorld([junk, FULL], 5, 1)?.hole, "j5");
});

test("a linear (footprint) part can never seat on a rail — the offsets are grid arithmetic", () => {
  // A NON-turned discrete lays out along grid columns, which the rail's grouped
  // lattice can't honour, so it stays pin-board only.
  const doc = docWith({ boards: [FULL, RAIL] });
  for (const anchor of ["+1", "-3"]) {
    assert.equal(
      canPlacePart(doc, { ref: "led", board: "bb3", anchor }),
      false,
      `a linear part must not seat on a rail at ${anchor}`,
    );
  }
  // The same LED seats happily along a pin-board row.
  assert.equal(
    canPlacePart(doc, { ref: "led", board: "bb1", anchor: "j5" }),
    true,
  );
});

test("a TURNED two-terminal part may anchor on a rail — both leads can reach rails", () => {
  // rail-full at (0,−4): + holes at world y −3, − at y −2; a second rail strip
  // sits below the pin-board so a resistor can bridge rail → rail across it.
  const RAIL2 = { id: "bb4", type: "rail-full", x: 0, y: 14 }; // + holes at y 15
  const doc = docWith({ boards: [FULL, RAIL, RAIL2] });

  // Pin 1 anchored on the top rail (bb3.-3 = world (5,−2)); the lead bends DOWN
  // to a grid hole (bb1.j5 = (5,1)) — 3 apart, exactly minSpan. This is the
  // case the old "parts belong to the pin-board" rule wrongly forbade.
  assert.equal(
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb3",
      anchor: "-3",
      params: { rot: 90, end: { dx: 0, dy: 3 } },
    }),
    true,
  );

  // BOTH leads on rails: pin 1 on the top rail (bb3.+3 = (5,−3)), lead bending
  // down 18 onto the bottom rail (bb4.+3 = (5,15)) — well past minSpan.
  assert.equal(
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb3",
      anchor: "+3",
      params: { rot: 90, end: { dx: 0, dy: 18 } },
    }),
    true,
  );

  // A LED (minSpan 1) bridges the + and − of ONE rail: bb3.+3 (5,−3) → the
  // lead down 1 to bb3.-3 (5,−2). A resistor's longer body couldn't (below).
  assert.equal(
    canPlacePart(doc, {
      ref: "led",
      board: "bb3",
      anchor: "+3",
      params: { rot: 90, end: { dx: 0, dy: 1 } },
    }),
    true,
  );
  assert.equal(
    canPlacePart(doc, {
      ref: "resistor",
      board: "bb3",
      anchor: "+3",
      params: { rot: 90, end: { dx: 0, dy: 1 } },
    }),
    false, // 1 < minSpan 3
  );
});
