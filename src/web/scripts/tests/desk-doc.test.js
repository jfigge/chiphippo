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

// Tests for the desk document model (model/desk-doc.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DOC_VERSION,
  DeskDoc,
  emptyDocument,
  normalizeDocument,
} from "../model/desk-doc.js";

test("a fresh DeskDoc serializes to the empty document shape", () => {
  assert.deepEqual(new DeskDoc(null).toJSON(), {
    version: DOC_VERSION,
    boards: [],
    components: [],
    wires: [],
    nextBoardId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
  });
  assert.deepEqual(new DeskDoc(null).toJSON(), emptyDocument());
});

test("addBoard: fresh bb<n> ids and integer snapping", () => {
  const doc = new DeskDoc(null);
  const b1 = doc.addBoard("full", 3.4, -2.6);
  assert.deepEqual(b1, { id: "bb1", type: "full", x: 3, y: -3 });
  const b2 = doc.addBoard("tiny", 0.2, 30);
  assert.equal(b2.id, "bb2");
  assert.deepEqual(
    doc.boards.map((b) => b.id),
    ["bb1", "bb2"],
  );
});

test("addBoard: rejects junk types and non-finite positions", () => {
  const doc = new DeskDoc(null);
  assert.throws(() => doc.addBoard("mega", 0, 0), { code: "INVALID_TYPE" });
  assert.throws(() => doc.addBoard("full", NaN, 0), { code: "INVALID_ARG" });
});

test("addBoard: rejects overlap with an existing board's outline", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0); // 65 × 21.7 at (0,0)
  assert.throws(() => doc.addBoard("tiny", 10, 10), { code: "OVERLAP" });
  // Snapping happens BEFORE the check: 64.7 snaps to 65 → touching, allowed.
  const beside = doc.addBoard("half", 64.7, 0);
  assert.deepEqual([beside.x, beside.y], [65, 0]);
  // Edge-to-edge below (21.7-tall outline → y 22 clears it).
  doc.addBoard("tiny", 0, 22);
  assert.equal(doc.boards.length, 3);
});

test("removed ids are never reused, even across serialize + reload", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("tiny", 0, 0); // bb1
  doc.addBoard("tiny", 30, 0); // bb2
  doc.removeBoard("bb2");
  assert.equal(doc.addBoard("tiny", 60, 0).id, "bb3");

  // Round-trip through the persisted form: the counter survives.
  const reloaded = new DeskDoc(doc.toJSON());
  reloaded.removeBoard("bb3");
  assert.equal(reloaded.addBoard("tiny", 90, 0).id, "bb4");
});

test("moveBoard: snaps, ignores its own footprint, rejects other overlaps", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("tiny", 0, 0);
  doc.addBoard("tiny", 40, 0);
  // Nudge within its own footprint — fine.
  assert.deepEqual(doc.moveBoard("bb1", 1.2, 0.4), {
    id: "bb1",
    type: "tiny",
    x: 1,
    y: 0,
  });
  // Onto the other board — rejected, position unchanged.
  assert.throws(() => doc.moveBoard("bb1", 39, 0), { code: "OVERLAP" });
  assert.deepEqual(doc.getBoard("bb1"), {
    id: "bb1",
    type: "tiny",
    x: 1,
    y: 0,
  });
  assert.throws(() => doc.moveBoard("bb9", 0, 0), { code: "NOT_FOUND" });
});

test("removeBoard: NOT_FOUND on unknown ids", () => {
  const doc = new DeskDoc(null);
  assert.throws(() => doc.removeBoard("bb1"), { code: "NOT_FOUND" });
});

test("canPlace mirrors the add/move overlap rule", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  assert.equal(doc.canPlace("tiny", 5, 5), false);
  assert.equal(doc.canPlace("tiny", 0, 22), true);
  assert.equal(doc.canPlace("full", 0.4, 0, { ignoreId: "bb1" }), true);
});

test("normalizeDocument: junk → empty; bad boards dropped; coords rounded", () => {
  assert.deepEqual(normalizeDocument(null), emptyDocument());
  assert.deepEqual(normalizeDocument("junk"), emptyDocument());
  assert.deepEqual(normalizeDocument([1, 2]), emptyDocument());

  const doc = normalizeDocument({
    version: DOC_VERSION,
    boards: [
      { id: "bb2", type: "half", x: 3.6, y: 1.2 },
      { id: "bb2", type: "tiny", x: 0, y: 0 }, // duplicate id — dropped
      { id: "nope", type: "tiny", x: 0, y: 0 }, // bad id — dropped
      { id: "bb3", type: "mega", x: 0, y: 0 }, // bad type — dropped
      { id: "bb4", type: "tiny", x: NaN, y: 0 }, // bad coords — dropped
    ],
    components: [
      { id: "c2", kind: "chip", ref: "7400", board: "bb2", anchor: "e3" },
      { id: "c2", kind: "chip", ref: "7404", board: "bb2", anchor: "e12" }, // dup id
      { id: "c3", kind: "chip", ref: "9999", board: "bb2", anchor: "e3" }, // bad ref
      { id: "c4", kind: "chip", ref: "7400", board: "bb9", anchor: "e3" }, // no board
      { id: "c5", kind: "blob", ref: "7400", board: "bb2", anchor: "e3" }, // bad kind
    ],
    wires: "not-an-array",
  });
  assert.deepEqual(doc.boards, [{ id: "bb2", type: "half", x: 4, y: 1 }]);
  assert.deepEqual(doc.components, [
    {
      id: "c2",
      kind: "chip",
      ref: "7400",
      board: "bb2",
      anchor: "e3",
      params: {},
    },
  ]);
  assert.deepEqual(doc.wires, []);
  // Counters advance past the max surviving ids.
  assert.equal(doc.nextBoardId, 3);
  assert.equal(doc.nextComponentId, 3);
});

test("normalizeDocument: an explicit larger nextBoardId wins (never reuse)", () => {
  const doc = normalizeDocument({
    boards: [{ id: "bb1", type: "tiny", x: 0, y: 0 }],
    nextBoardId: 9,
  });
  assert.equal(doc.nextBoardId, 9);
});

test("toJSON is a deep copy — later mutations don't leak into it", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("tiny", 0, 0);
  const snapshot = doc.toJSON();
  doc.moveBoard("bb1", 5, 5);
  assert.deepEqual(snapshot.boards[0], { id: "bb1", type: "tiny", x: 0, y: 0 });
});

// ── Components (Feature 40) ──────────────────────────────────────────────────

function docWithFull() {
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  return doc;
}

test("addComponent: seats a chip with a fresh c<n> id", () => {
  const doc = docWithFull();
  const chip = doc.addComponent({
    kind: "chip",
    ref: "7400",
    board: "bb1",
    anchor: "e5",
  });
  assert.deepEqual(chip, {
    id: "c1",
    kind: "chip",
    ref: "7400",
    board: "bb1",
    anchor: "e5",
    params: {},
  });
  assert.equal(
    doc.addComponent({
      kind: "chip",
      ref: "7404",
      board: "bb1",
      anchor: "e20",
    }).id,
    "c2",
  );
  assert.equal(doc.components.length, 2);
});

test("addComponent: rejects bad kinds/refs/boards and illegal seats", () => {
  const doc = docWithFull();
  assert.throws(
    () =>
      doc.addComponent({
        kind: "psu",
        ref: "7400",
        board: "bb1",
        anchor: "e5",
      }),
    { code: "INVALID_KIND" },
  );
  assert.throws(
    () =>
      doc.addComponent({
        kind: "chip",
        ref: "9999",
        board: "bb1",
        anchor: "e5",
      }),
    { code: "INVALID_REF" },
  );
  assert.throws(
    () =>
      doc.addComponent({
        kind: "chip",
        ref: "7400",
        board: "bb9",
        anchor: "e5",
      }),
    { code: "NOT_FOUND" },
  );
  doc.addComponent({ kind: "chip", ref: "7400", board: "bb1", anchor: "e5" });
  assert.throws(
    () =>
      doc.addComponent({
        kind: "chip",
        ref: "7404",
        board: "bb1",
        anchor: "e8",
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
  // Rails / wrong rows are illegal anchors.
  assert.throws(
    () =>
      doc.addComponent({
        kind: "chip",
        ref: "7404",
        board: "bb1",
        anchor: "f20",
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
});

test("moveComponent: re-seats (same or other board), self-overlap allowed", () => {
  const doc = docWithFull();
  doc.addBoard("tiny", 0, 30);
  doc.addComponent({ kind: "chip", ref: "7400", board: "bb1", anchor: "e5" });
  // Shift one column into its own footprint.
  assert.deepEqual(doc.moveComponent("c1", "bb1", "e6").anchor, "e6");
  // Cross-board re-seat.
  const moved = doc.moveComponent("c1", "bb2", "e2");
  assert.equal(moved.board, "bb2");
  assert.throws(() => doc.moveComponent("c9", "bb1", "e5"), {
    code: "NOT_FOUND",
  });
  doc.addComponent({ kind: "chip", ref: "7404", board: "bb1", anchor: "e5" });
  assert.throws(() => doc.moveComponent("c1", "bb1", "e6"), {
    code: "ILLEGAL_PLACEMENT",
  });
});

test("removeComponent: removes; ids never reused across reload", () => {
  const doc = docWithFull();
  doc.addComponent({ kind: "chip", ref: "7400", board: "bb1", anchor: "e5" });
  doc.removeComponent("c1");
  assert.deepEqual(doc.components, []);
  assert.throws(() => doc.removeComponent("c1"), { code: "NOT_FOUND" });
  const reloaded = new DeskDoc(doc.toJSON());
  assert.equal(
    reloaded.addComponent({
      kind: "chip",
      ref: "7400",
      board: "bb1",
      anchor: "e5",
    }).id,
    "c2",
  );
});

test("removeBoard cascades its seated components", () => {
  const doc = docWithFull();
  doc.addBoard("tiny", 0, 30);
  doc.addComponent({ kind: "chip", ref: "7400", board: "bb1", anchor: "e5" });
  doc.addComponent({ kind: "chip", ref: "7404", board: "bb2", anchor: "e2" });
  assert.equal(doc.componentsOnBoard("bb1").length, 1);
  doc.removeBoard("bb1");
  assert.deepEqual(
    doc.components.map((c) => c.id),
    ["c2"],
  );
});

test("canPlaceChip mirrors occupancy through the document", () => {
  const doc = docWithFull();
  doc.addComponent({ kind: "chip", ref: "7400", board: "bb1", anchor: "e5" });
  assert.equal(doc.canPlaceChip("7404", "bb1", "e8"), false);
  assert.equal(doc.canPlaceChip("7404", "bb1", "e12"), true);
  assert.equal(doc.canPlaceChip("7400", "bb1", "e6", { ignoreId: "c1" }), true);
});

// ── Wires (Feature 50) ───────────────────────────────────────────────────────

test("addWire: connects two free holes with a fresh w<n> id", () => {
  const doc = docWithFull();
  const wire = doc.addWire({ from: "bb1.a1", to: "bb1.t+3", color: "blue" });
  assert.deepEqual(wire, {
    id: "w1",
    from: "bb1.a1",
    to: "bb1.t+3",
    color: "blue",
  });
  assert.equal(doc.addWire({ from: "bb1.a2", to: "bb1.a6" }).id, "w2");
  assert.equal(doc.wires.length, 2);
  // Both endpoints are now occupied.
  assert.equal(doc.isHoleFree("bb1.a1"), false);
  assert.equal(doc.isHoleFree("bb1.t+3"), false);
});

test("addWire: rejects occupied/self/unreal endpoints and junk colors", () => {
  const doc = docWithFull();
  doc.addComponent({ kind: "chip", ref: "7400", board: "bb1", anchor: "e5" });
  doc.addWire({ from: "bb1.a1", to: "bb1.a5" });
  // A chip pin's hole…
  assert.throws(() => doc.addWire({ from: "bb1.e5", to: "bb1.b1" }), {
    code: "ILLEGAL_PLACEMENT",
  });
  // …an existing wire end…
  assert.throws(() => doc.addWire({ from: "bb1.a1", to: "bb1.b1" }), {
    code: "ILLEGAL_PLACEMENT",
  });
  // …the same hole twice…
  assert.throws(() => doc.addWire({ from: "bb1.b1", to: "bb1.b1" }), {
    code: "ILLEGAL_PLACEMENT",
  });
  // …a hole that doesn't exist / a board that doesn't exist…
  assert.throws(() => doc.addWire({ from: "bb1.a99", to: "bb1.b1" }), {
    code: "ILLEGAL_PLACEMENT",
  });
  assert.throws(() => doc.addWire({ from: "bb9.a1", to: "bb1.b1" }), {
    code: "ILLEGAL_PLACEMENT",
  });
  // …and a color outside the palette.
  assert.throws(
    () => doc.addWire({ from: "bb1.b1", to: "bb1.b5", color: "cyan" }),
    { code: "INVALID_ARG" },
  );
});

test("self-wires within one internal node are allowed (a1 → b1)", () => {
  const doc = docWithFull();
  const wire = doc.addWire({ from: "bb1.a1", to: "bb1.b1" });
  assert.equal(wire.id, "w1"); // same node c1L — harmless, real boards do it
});

test("recolorWire / removeWire; ids never reused across reload", () => {
  const doc = docWithFull();
  doc.addWire({ from: "bb1.a1", to: "bb1.a5" });
  assert.equal(doc.recolorWire("w1", "purple").color, "purple");
  assert.throws(() => doc.recolorWire("w1", "cyan"), { code: "INVALID_ARG" });
  assert.throws(() => doc.recolorWire("w9", "red"), { code: "NOT_FOUND" });

  doc.removeWire("w1");
  assert.deepEqual(doc.wires, []);
  assert.equal(doc.isHoleFree("bb1.a1"), true); // hole freed
  assert.throws(() => doc.removeWire("w1"), { code: "NOT_FOUND" });

  const reloaded = new DeskDoc(doc.toJSON());
  assert.equal(reloaded.addWire({ from: "bb1.a1", to: "bb1.a5" }).id, "w2");
});

test("setWireEndpoint: re-addresses one end; frees the old hole", () => {
  const doc = docWithFull();
  doc.addWire({ from: "bb1.a1", to: "bb1.a10", color: "blue" }); // w1

  // Move the `from` end to a free hole; the wire keeps its id/color/other end.
  const moved = doc.setWireEndpoint("w1", "from", "bb1.a2");
  assert.deepEqual(moved, {
    id: "w1",
    from: "bb1.a2",
    to: "bb1.a10",
    color: "blue",
  });
  assert.equal(doc.isHoleFree("bb1.a1"), true); // old hole released
  assert.equal(doc.isHoleFree("bb1.a2"), false); // new hole occupied

  // Rejections: bad end, unknown wire, onto the other end, onto an occupied
  // hole (a second wire), and an unreal hole.
  assert.throws(() => doc.setWireEndpoint("w1", "middle", "bb1.a3"), {
    code: "INVALID_ARG",
  });
  assert.throws(() => doc.setWireEndpoint("w9", "from", "bb1.a3"), {
    code: "NOT_FOUND",
  });
  assert.throws(() => doc.setWireEndpoint("w1", "from", "bb1.a10"), {
    code: "ILLEGAL_PLACEMENT",
  });
  doc.addWire({ from: "bb1.b1", to: "bb1.b5" }); // w2 occupies bb1.b1
  assert.throws(() => doc.setWireEndpoint("w1", "from", "bb1.b1"), {
    code: "ILLEGAL_PLACEMENT",
  });
  assert.throws(() => doc.setWireEndpoint("w1", "to", "bb1.a99"), {
    code: "ILLEGAL_PLACEMENT",
  });
});

test("removeBoard cascades wires touching it (either endpoint)", () => {
  const doc = docWithFull();
  doc.addBoard("tiny", 0, 30); // bb2
  doc.addWire({ from: "bb1.a1", to: "bb2.a1" }); // cross-board
  doc.addWire({ from: "bb2.a3", to: "bb2.a7" }); // wholly on bb2
  doc.addWire({ from: "bb1.a5", to: "bb1.a9" }); // wholly on bb1
  assert.equal(doc.wiresOnBoard("bb2").length, 2);
  doc.removeBoard("bb2");
  assert.deepEqual(
    doc.wires.map((w) => w.id),
    ["w3"],
  );
});

test("normalizeDocument: junk wires dropped, junk colors coerced", () => {
  const doc = normalizeDocument({
    boards: [{ id: "bb1", type: "tiny", x: 0, y: 0 }],
    wires: [
      { id: "w2", from: "bb1.a1", to: "bb1.a5", color: "cyan" }, // color coerced
      { id: "w2", from: "bb1.b1", to: "bb1.b5", color: "red" }, // dup id
      { id: "x1", from: "bb1.c1", to: "bb1.c5", color: "red" }, // bad id
      { id: "w3", from: "bb1.a1", to: "bb1.a1", color: "red" }, // self hole
      { id: "w4", from: "bb9.a1", to: "bb1.d5", color: "red" }, // dangling board
      { id: "w5", from: "bb1.t+1", to: "bb1.d5", color: "red" }, // Tiny has no rails
    ],
  });
  assert.deepEqual(doc.wires, [
    { id: "w2", from: "bb1.a1", to: "bb1.a5", color: "red" },
  ]);
  assert.equal(doc.nextWireId, 3);
});

// ── Discrete parts & PSU bricks (Feature 60) ─────────────────────────────────

test("addComponent: discretes seat in ANY grid row with coerced params", () => {
  const doc = docWithFull();
  const sw = doc.addComponent({
    kind: "discrete",
    ref: "sw-slide",
    board: "bb1",
    anchor: "b10",
  });
  assert.deepEqual(sw.params, { pos: "1" }); // default via the def contract
  const led = doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: "bb1",
    anchor: "j20",
    params: { color: "blue", flip: true },
  });
  assert.deepEqual(led.params, { color: "blue", flip: true });
  // Kind/def mismatches are rejected.
  assert.throws(
    () =>
      doc.addComponent({
        kind: "chip",
        ref: "led",
        board: "bb1",
        anchor: "e30",
      }),
    { code: "INVALID_REF" },
  );
  assert.throws(
    () =>
      doc.addComponent({
        kind: "discrete",
        ref: "7400",
        board: "bb1",
        anchor: "e30",
      }),
    { code: "INVALID_REF" },
  );
});

test("discrete occupancy: pins occupy; overlaps rejected; rails illegal", () => {
  const doc = docWithFull();
  doc.addComponent({
    kind: "discrete",
    ref: "sw-slide",
    board: "bb1",
    anchor: "b10", // pins b10 b11 b12
  });
  assert.equal(doc.isHoleFree("bb1.b11"), false);
  assert.throws(
    () =>
      doc.addComponent({
        kind: "discrete",
        ref: "led",
        board: "bb1",
        anchor: "b12",
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
  // sw-push spans anchor/+2 — b13 is free even though b12 is taken? b13+b15.
  const push = doc.addComponent({
    kind: "discrete",
    ref: "sw-push",
    board: "bb1",
    anchor: "b13",
  });
  assert.equal(push.id.startsWith("c"), true);
  // Rail anchors never fit a discrete footprint.
  assert.throws(
    () =>
      doc.addComponent({
        kind: "discrete",
        ref: "led",
        board: "bb1",
        anchor: "t+3",
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
});

test("setComponentParams: switch toggles persist through the def contract", () => {
  const doc = docWithFull();
  doc.addComponent({
    kind: "discrete",
    ref: "sw-slide",
    board: "bb1",
    anchor: "b10",
  });
  assert.deepEqual(doc.setComponentParams("c1", { pos: "2" }).params, {
    pos: "2",
  });
  assert.deepEqual(doc.setComponentParams("c1", { pos: "junk" }).params, {
    pos: "1", // coerced by the def
  });
  assert.throws(() => doc.setComponentParams("c9", {}), { code: "NOT_FOUND" });
});

test("addPsu: psu<n> ids, snapping, board/psu overlap rejection", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("tiny", 0, 0);
  const psu = doc.addPsu(30.4, 0.6, { volts: 12 });
  assert.deepEqual(psu, {
    id: "psu1",
    kind: "psu",
    ref: "psu",
    x: 30,
    y: 1,
    params: { volts: 12 },
  });
  // Covering the board is rejected; covering another PSU too.
  assert.throws(() => doc.addPsu(5, 5), { code: "OVERLAP" });
  assert.throws(() => doc.addPsu(31, 2), { code: "OVERLAP" });
  // And a board can't land on a PSU either.
  assert.equal(doc.canPlace("tiny", 30, 1), false);
  // Ids advance independently of c<n>.
  doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: "bb1",
    anchor: "a1",
  });
  assert.equal(doc.addPsu(30, 20).id, "psu2");
});

test("movePsu + volts via setComponentParams", () => {
  const doc = new DeskDoc(null);
  doc.addPsu(0, 0);
  assert.deepEqual(doc.movePsu("psu1", 10.2, 3.8), {
    id: "psu1",
    kind: "psu",
    ref: "psu",
    x: 10,
    y: 4,
    params: { volts: 5 },
  });
  assert.equal(doc.setComponentParams("psu1", { volts: 3 }).params.volts, 3);
  assert.equal(doc.setComponentParams("psu1", { volts: 9 }).params.volts, 5);
  assert.throws(() => doc.movePsu("psu9", 0, 0), { code: "NOT_FOUND" });
  const led = doc.addBoard("tiny", 40, 0);
  assert.ok(led);
  assert.throws(() => doc.moveComponent("psu1", "bb1", "a1"), {
    code: "INVALID_KIND",
  });
});

test("PSU terminals wire like holes and removal cascades those wires", () => {
  const doc = docWithFull();
  doc.addPsu(80, 0);
  assert.equal(doc.isHoleFree("psu1.+"), true);
  assert.equal(doc.isHoleFree("psu1.x"), false); // no such terminal
  const wire = doc.addWire({ from: "psu1.+", to: "bb1.t+3", color: "red" });
  assert.ok(wire);
  assert.equal(doc.isHoleFree("psu1.+"), false); // one lead per terminal
  assert.throws(() => doc.addWire({ from: "psu1.+", to: "bb1.t+4" }), {
    code: "ILLEGAL_PLACEMENT",
  });
  doc.addWire({ from: "psu1.-", to: "bb1.t-3" });
  assert.equal(doc.wiresTouching("psu1").length, 2);
  doc.removeComponent("psu1");
  assert.deepEqual(doc.wires, []);
  assert.equal(doc.getComponent("psu1"), null);
});

test("normalizeDocument: discretes + PSUs survive; junk dropped/coerced", () => {
  const doc = normalizeDocument({
    boards: [{ id: "bb1", type: "tiny", x: 0, y: 0 }],
    components: [
      {
        id: "c1",
        kind: "discrete",
        ref: "sw-slide",
        board: "bb1",
        anchor: "b3",
        params: { pos: "2" },
      },
      {
        id: "c2",
        kind: "discrete",
        ref: "capacitor",
        board: "bb1",
        anchor: "b8",
      }, // bad ref
      {
        id: "psu2",
        kind: "psu",
        ref: "psu",
        x: 40.4,
        y: 1,
        params: { volts: 9 },
      },
      { id: "c3", kind: "psu", ref: "psu", x: 60, y: 0 }, // psu needs psu<n> id
    ],
    wires: [{ id: "w1", from: "psu2.+", to: "bb1.a1", color: "green" }],
  });
  assert.deepEqual(doc.components, [
    {
      id: "c1",
      kind: "discrete",
      ref: "sw-slide",
      board: "bb1",
      anchor: "b3",
      params: { pos: "2" },
    },
    { id: "psu2", kind: "psu", ref: "psu", x: 40, y: 1, params: { volts: 5 } },
  ]);
  // A wire onto a surviving PSU terminal is kept.
  assert.equal(doc.wires.length, 1);
  assert.equal(doc.nextPsuId, 3);
  assert.equal(doc.nextComponentId, 2);
});
