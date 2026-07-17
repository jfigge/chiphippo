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
