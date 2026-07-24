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
    buses: [],
    netNames: [],
    annotations: [],
    scopeChannels: [],
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextLcdId: 1,
    nextWireId: 1,
    nextBusId: 1,
    nextAnnotationId: 1,
    nextScopeChannelId: 1,
  });
  assert.deepEqual(new DeskDoc(null).toJSON(), emptyDocument());
});

test("addBoard: fresh bb<n> ids and integer snapping", () => {
  const doc = new DeskDoc(null);
  const b1 = doc.addBoard("pins-full", 3.4, -2.6);
  assert.deepEqual(b1, {
    id: "bb1",
    type: "pins-full",
    x: 3,
    y: -3,
    rot: 0,
    group: null, // a strip added on its own is loose
  });
  const b2 = doc.addBoard("pins-tiny", 0.2, 30);
  assert.equal(b2.id, "bb2");
  assert.deepEqual(
    doc.boards.map((b) => b.id),
    ["bb1", "bb2"],
  );
});

test("addBoard: rejects junk types and non-finite positions", () => {
  const doc = new DeskDoc(null);
  assert.throws(() => doc.addBoard("mega", 0, 0), { code: "INVALID_TYPE" });
  assert.throws(() => doc.addBoard("full", 0, 0), { code: "INVALID_TYPE" }); // a kit
  assert.throws(() => doc.addBoard("pins-full", NaN, 0), {
    code: "INVALID_ARG",
  });
});

test("addBoard: rejects overlap with an existing board's outline", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // 65 × 14 at (0,0)
  assert.throws(() => doc.addBoard("pins-tiny", 10, 10), { code: "OVERLAP" });
  // Snapping happens BEFORE the check: 64.7 snaps to 65 → touching, allowed.
  const beside = doc.addBoard("pins-half", 64.7, 0);
  assert.deepEqual([beside.x, beside.y], [65, 0]);
  // Edge-to-edge below (14-tall outline → y 14 clears it).
  doc.addBoard("rail-full", 0, 14);
  assert.equal(doc.boards.length, 3);
});

test("removed ids are never reused, even across serialize + reload", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-tiny", 0, 0); // bb1
  doc.addBoard("pins-tiny", 30, 0); // bb2
  doc.removeBoard("bb2");
  assert.equal(doc.addBoard("pins-tiny", 60, 0).id, "bb3");

  // Round-trip through the persisted form: the counter survives.
  const reloaded = new DeskDoc(doc.toJSON());
  reloaded.removeBoard("bb3");
  assert.equal(reloaded.addBoard("pins-tiny", 90, 0).id, "bb4");
});

test("moveBoard: snaps, ignores its own footprint, rejects other overlaps", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-tiny", 0, 0);
  doc.addBoard("pins-tiny", 40, 0);
  // Nudge within its own footprint — fine.
  assert.deepEqual(doc.moveBoard("bb1", 1.2, 0.4), {
    id: "bb1",
    type: "pins-tiny",
    x: 1,
    y: 0,
    rot: 0,
    group: null,
  });
  // Onto the other board — rejected, position unchanged.
  assert.throws(() => doc.moveBoard("bb1", 39, 0), { code: "OVERLAP" });
  assert.deepEqual(doc.getBoard("bb1"), {
    id: "bb1",
    type: "pins-tiny",
    x: 1,
    y: 0,
    rot: 0,
    group: null,
  });
  assert.throws(() => doc.moveBoard("bb9", 0, 0), { code: "NOT_FOUND" });
});

test("moveBoard tears a grouped strip out and regroups the remainder", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16, one group
  const orig = doc.getBoard("bb2").group;
  assert.ok(orig != null, "kit strips start grouped");

  doc.moveBoard("bb1", 200, 200); // drag the top rail far off on its own

  const group = Object.fromEntries(doc.boards.map((b) => [b.id, b.group]));
  assert.equal(group.bb1, null, "the moved strip goes loose");
  assert.equal(
    group.bb2,
    group.bb3,
    "the still-flush remainder shares a group",
  );
  assert.ok(group.bb2 != null, "and it is a real group, not loose");
  assert.notEqual(group.bb2, orig, "a FRESH id, never the stale spanning one");
});

test("moveBoard: an upright rail is collision-checked at its TURNED size", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("rail-full", 0, 0, 90); // bb1: 3 wide × 64 tall
  doc.addBoard("pins-full", 10, 30); // bb2: 64 × 13, clear to the right
  // Sliding the upright rail so its 64-tall sweep crosses the pin-board must
  // be rejected. Checked flat (64×3) the boxes miss and it would wrongly pass,
  // writing an overlap into the document.
  assert.throws(() => doc.moveBoard("bb1", 8, 20), { code: "OVERLAP" });
  assert.deepEqual(doc.getBoard("bb1"), {
    id: "bb1",
    type: "rail-full",
    x: 0,
    y: 0,
    rot: 90,
    group: null,
  });
});

test("removeBoard: NOT_FOUND on unknown ids", () => {
  const doc = new DeskDoc(null);
  assert.throws(() => doc.removeBoard("bb1"), { code: "NOT_FOUND" });
});

test("removeBoard: pulling the middle strip re-derives the survivors' groups", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16, all g1
  doc.removeBoard("bb2"); // the two rails are now 13 pitch apart

  // They no longer touch, so they must no longer be one draggable unit — each
  // is loose, and a grab moves only itself.
  assert.equal(doc.getBoard("bb1").group, null);
  assert.equal(doc.getBoard("bb3").group, null);
  assert.deepEqual(
    doc.groupMembers("bb1").map((b) => b.id),
    ["bb1"],
  );
});

test("removeBoard: a still-mated run keeps a group; a lone survivor goes loose", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16, g1

  // Remove the TOP rail. The pin-board and bottom rail are still flush, so the
  // survivors stay one unit — under a freshly-derived id, not the old g1.
  doc.removeBoard("bb1");
  const g = doc.getBoard("bb2").group;
  assert.ok(g != null);
  assert.equal(doc.getBoard("bb3").group, g);
  assert.deepEqual(
    doc.groupMembers("bb2").map((b) => b.id),
    ["bb2", "bb3"],
  );

  // Remove the pin-board too: the last rail stands alone and goes loose.
  doc.removeBoard("bb2");
  assert.equal(doc.getBoard("bb3").group, null);
});

test("canPlace mirrors the add/move overlap rule", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  assert.equal(doc.canPlace("pins-tiny", 5, 5), false);
  assert.equal(doc.canPlace("pins-tiny", 0, 14), true);
  assert.equal(doc.canPlace("pins-full", 0.4, 0, { ignoreId: "bb1" }), true);
});

test("normalizeDocument: junk → empty; bad boards dropped; coords rounded", () => {
  assert.deepEqual(normalizeDocument(null), emptyDocument());
  assert.deepEqual(normalizeDocument("junk"), emptyDocument());
  assert.deepEqual(normalizeDocument([1, 2]), emptyDocument());

  const doc = normalizeDocument({
    version: DOC_VERSION,
    boards: [
      { id: "bb2", type: "pins-half", x: 3.6, y: 1.2 },
      { id: "bb2", type: "pins-tiny", x: 0, y: 0 }, // duplicate id — dropped
      { id: "nope", type: "pins-tiny", x: 0, y: 0 }, // bad id — dropped
      { id: "bb3", type: "mega", x: 0, y: 0 }, // bad type — dropped
      { id: "bb4", type: "full", x: 0, y: 0 }, // a kit, not a strip — dropped
      { id: "bb5", type: "pins-tiny", x: NaN, y: 0 }, // bad coords — dropped
    ],
    components: [
      { id: "c2", kind: "chip", ref: "74LS00", board: "bb2", anchor: "e3" },
      { id: "c2", kind: "chip", ref: "74LS04", board: "bb2", anchor: "e12" }, // dup id
      { id: "c3", kind: "chip", ref: "9999", board: "bb2", anchor: "e3" }, // bad ref
      { id: "c4", kind: "chip", ref: "74LS00", board: "bb9", anchor: "e3" }, // no board
      { id: "c5", kind: "blob", ref: "74LS00", board: "bb2", anchor: "e3" }, // bad kind
    ],
    wires: "not-an-array",
  });
  assert.deepEqual(doc.boards, [
    { id: "bb2", type: "pins-half", x: 4, y: 1, rot: 0, group: null },
  ]);
  assert.deepEqual(doc.components, [
    {
      id: "c2",
      kind: "chip",
      ref: "74LS00",
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
    boards: [{ id: "bb1", type: "pins-tiny", x: 0, y: 0 }],
    nextBoardId: 9,
  });
  assert.equal(doc.nextBoardId, 9);
});

test("normalizeDocument: group ids survive; junk groups degrade to loose", () => {
  const doc = normalizeDocument({
    boards: [
      { id: "bb1", type: "rail-full", x: 0, y: 0, rot: 0, group: "g4" },
      { id: "bb2", type: "pins-full", x: 0, y: 4, rot: 0, group: "g4" },
      { id: "bb3", type: "pins-tiny", x: 0, y: 40, rot: 0, group: "nope" }, // → loose
    ],
  });
  assert.deepEqual(
    doc.boards.map((b) => b.group),
    ["g4", "g4", null],
  );
  assert.equal(doc.nextGroupId, 5); // a group id is never reused either
});

test("normalizeDocument drops a wire whose endpoint sits on a chip pin", () => {
  const doc = normalizeDocument({
    boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }],
    components: [
      { id: "c1", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" },
    ],
    wires: [
      // bb1.e5 is c1's pin-1 hole — a wire may not share it (one lead/point).
      { id: "w1", from: "bb1.e5", to: "bb1.a20", color: "red" },
      { id: "w2", from: "bb1.a10", to: "bb1.a20", color: "red" }, // clean → kept
    ],
  });
  assert.deepEqual(
    doc.wires.map((w) => w.id),
    ["w2"],
    "the pin-colliding wire is dropped, the clean one survives",
  );
});

test("normalizeDocument keeps only the first of two wires sharing a hole", () => {
  const doc = normalizeDocument({
    boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }],
    wires: [
      { id: "w1", from: "bb1.a5", to: "bb1.a10", color: "red" },
      { id: "w2", from: "bb1.a5", to: "bb1.a20", color: "red" }, // shares a5 → dropped
    ],
  });
  assert.deepEqual(
    doc.wires.map((w) => w.id),
    ["w1"],
  );
});

test("toJSON is a deep copy — later mutations don't leak into it", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-tiny", 0, 0);
  const snapshot = doc.toJSON();
  doc.moveBoard("bb1", 5, 5);
  assert.deepEqual(snapshot.boards[0], {
    id: "bb1",
    type: "pins-tiny",
    x: 0,
    y: 0,
    rot: 0,
    group: null,
  });
});

// ── Breadboard kits & strip groups ───────────────────────────────────────────

test("kitPlacements / kitOutline describe a kit without touching the desk", () => {
  assert.deepEqual(DeskDoc.kitPlacements("half", 10.4, -2.6), [
    { type: "rail-half", x: 10, y: -3, rot: 0 },
    { type: "pins-half", x: 10, y: 0, rot: 0 },
    { type: "rail-half", x: 10, y: 13, rot: 0 },
  ]);
  // Rail (4) + pin-board (14) + rail (4) stacked.
  assert.deepEqual(DeskDoc.kitOutline("full"), { width: 64, height: 19 });
  assert.deepEqual(DeskDoc.kitOutline("tiny"), { width: 18, height: 13 });
  assert.throws(() => DeskDoc.kitPlacements("mega", 0, 0), {
    code: "INVALID_TYPE",
  });
});

test("addKit: seats every strip at its preset offset, sharing one group", () => {
  const doc = new DeskDoc(null);
  assert.deepEqual(doc.addKit("full", 2, 5), [
    { id: "bb1", type: "rail-full", x: 2, y: 5, rot: 0, group: "g1" },
    { id: "bb2", type: "pins-full", x: 2, y: 8, rot: 0, group: "g1" },
    { id: "bb3", type: "rail-full", x: 2, y: 21, rot: 0, group: "g1" },
  ]);
  // The next kit is its own rigid unit, with its own group id.
  assert.deepEqual(
    doc.addKit("half", 0, 40).map((b) => [b.id, b.type, b.group]),
    [
      ["bb4", "rail-half", "g2"],
      ["bb5", "pins-half", "g2"],
      ["bb6", "rail-half", "g2"],
    ],
  );
});

test("addKit: a tiny breadboard is a single loose strip", () => {
  const doc = new DeskDoc(null);
  // The real 170-point part is a bare pin-board — nothing to group it with.
  assert.deepEqual(doc.addKit("tiny", 0.4, -0.4), [
    { id: "bb1", type: "pins-tiny", x: 0, y: 0, rot: 0, group: null },
  ]);
  assert.equal(doc.toJSON().nextGroupId, 1); // no group id burned
});

test("addKit: all-or-nothing — nothing is added when one strip overlaps", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-tiny", 0, 20); // where the kit's pin-board would land
  assert.equal(doc.canPlaceKit("full", 0, 16), false);
  assert.throws(() => doc.addKit("full", 0, 16), { code: "OVERLAP" });
  // Not even the strips that WOULD have fitted are seated, and no id is spent.
  assert.deepEqual(
    doc.boards.map((b) => b.id),
    ["bb1"],
  );
  assert.equal(doc.toJSON().nextBoardId, 2);
  assert.equal(doc.toJSON().nextGroupId, 1);
  // Clear of it, the same kit seats fine.
  assert.equal(doc.canPlaceKit("full", 0, 40), true);
  assert.equal(doc.addKit("full", 0, 40).length, 3);
  assert.throws(() => doc.addKit("mega", 0, 0), { code: "INVALID_TYPE" });
  assert.throws(() => doc.addKit("full", NaN, 0), { code: "INVALID_ARG" });
});

test("addKit: a loose strip is placeable on its own, ungrouped", () => {
  const doc = new DeskDoc(null);
  // The bare parts out of the bag — each kit is exactly one strip.
  assert.deepEqual(doc.addKit("pins-full", 0, 0), [
    { id: "bb1", type: "pins-full", x: 0, y: 0, rot: 0, group: null },
  ]);
  assert.deepEqual(doc.addKit("rail-half", 0, 40), [
    { id: "bb2", type: "rail-half", x: 0, y: 40, rot: 0, group: null },
  ]);
  assert.equal(doc.toJSON().nextGroupId, 1); // no group id burned
});

test("matingStrips: same width and left edge, edge-to-edge in y", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 4); // bb1 — spans y 4…17
  doc.addBoard("rail-full", 0, 1); // bb2 — abuts bb1's top edge
  doc.addBoard("rail-full", 0, 17); // bb3 — abuts bb1's bottom edge
  doc.addBoard("rail-full", 0, 21); // bb4 — one pitch of daylight below bb3
  doc.addBoard("rail-half", 70, 4); // bb5 — elsewhere entirely
  assert.deepEqual(
    doc.matingStrips("bb1").map((b) => b.id),
    ["bb2", "bb3"],
  );
  assert.deepEqual(
    doc.matingStrips("bb4").map((b) => b.id),
    [], // a gap is a gap, however small
  );
  // Width has to match, as the real dovetail does.
  doc.addBoard("pins-half", 0, -12); // bb6 — abuts bb2's top (y 1), wrong width
  assert.deepEqual(doc.matingStrips("bb6"), []);
  assert.deepEqual(doc.matingStrips("bb9"), []);
});

test("joinMatedGroup: a loose strip adopts the group it dovetails into", () => {
  const doc = new DeskDoc(null);
  doc.addKit("half", 0, 0); // bb1..bb3, group g1 — spans y 0…19
  doc.addBoard("rail-half", 0, 19); // bb4 — flush under the kit's bottom rail
  assert.equal(doc.joinMatedGroup("bb4"), "g1");
  assert.deepEqual(
    doc.groupMembers("bb4").map((b) => b.id),
    ["bb1", "bb2", "bb3", "bb4"], // it drags with the whole board now
  );
  assert.equal(doc.toJSON().nextGroupId, 2); // the existing group was reused
});

test("joinMatedGroup: loose strips mint a group; touching nothing is a no-op", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 4); // bb1, loose
  doc.addBoard("rail-full", 0, 1); // bb2, loose — flush above it
  doc.addBoard("rail-full", 40, 40); // bb3 — off on its own
  assert.equal(doc.joinMatedGroup("bb2"), "g1");
  assert.deepEqual(
    doc.groupMembers("bb1").map((b) => b.group),
    ["g1", "g1"],
  );
  assert.equal(doc.joinMatedGroup("bb3"), null);
  assert.equal(doc.getBoard("bb3").group, null);
  assert.equal(doc.toJSON().nextGroupId, 2); // no id burned on the no-op
});

test("joinMatedGroup: a strip bridging two groups merges them into one", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1..bb3, g1 — spans y 0…19
  doc.addKit("full", 0, 22); // bb4..bb6, g2 — spans y 22…41
  doc.addBoard("rail-full", 0, 19); // bb7 — fills the gap, touching both
  const group = doc.joinMatedGroup("bb7");
  assert.deepEqual(
    doc.groupMembers("bb7").map((b) => b.id),
    ["bb1", "bb2", "bb3", "bb4", "bb5", "bb6", "bb7"],
  );
  assert.equal(group, "g1"); // the oldest group absorbs the rest
  assert.equal(doc.toJSON().nextGroupId, 3); // and none is minted
});

test("matingStrips: boards dovetail side by side too, not just stacked", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1 — 64 wide, 13 tall (spans x 0…64)
  doc.addBoard("pins-full", 64, 0); // bb2 — flush against bb1's right edge
  doc.addBoard("pins-full", 129, 0); // bb3 — a pitch of daylight past bb2
  doc.addBoard("pins-half", 0, 13); // bb4 — below bb1 but half the width
  assert.deepEqual(
    doc.matingStrips("bb1").map((b) => b.id),
    ["bb2"], // bb4 is flush below, but too narrow to dovetail
  );
  // Side-by-side mating needs matching HEIGHT, as stacking needs matching
  // width — a rail never dovetails onto a pin-board's end.
  doc.addBoard("rail-full", 193, 0); // flush right of bb3, but 3 tall
  assert.deepEqual(doc.matingStrips("bb3"), []);
});

test("snapBoardsBy: the pull that lands a dragged set flush", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1 — spans x 0…64
  doc.addBoard("pins-full", 100, 1); // bb2 — the one being dragged

  // Dragged to x = 66, y = 0: two pitch of gap, and now aligned in y.
  assert.deepEqual(doc.snapBoardsBy(["bb2"], -34, -1), { dx: -2, dy: 0 });
  // Dropped exactly flush, there is nothing left to pull.
  assert.deepEqual(doc.snapBoardsBy(["bb2"], -36, -1), { dx: 0, dy: 0 });
  // Still four pitch out — beyond the magnet's reach.
  assert.deepEqual(doc.snapBoardsBy(["bb2"], -32, -1), { dx: 0, dy: 0 });
  // A strip is never pulled towards a board moving WITH it.
  assert.deepEqual(doc.snapBoardsBy(["bb1", "bb2"], -34, -1), { dx: 0, dy: 0 });
});

test("snapKitAt: the same pull, for a kit that is not placed yet", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1…bb3, spanning y 0…19

  assert.deepEqual(doc.snapKitAt("full", 0, 21), { dx: 0, dy: -2 });
  assert.deepEqual(doc.snapKitAt("full", 0, 19), { dx: 0, dy: 0 });
  assert.deepEqual(doc.snapKitAt("full", 0, 40), { dx: 0, dy: 0 });
  // A tiny board is the wrong width to stack under a full one.
  assert.deepEqual(doc.snapKitAt("tiny", 0, 21), { dx: 0, dy: 0 });
});

test("matedChain: walks one way only, and never leaves the group", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16, g1
  // Grabbing the pin-board takes what hangs BELOW it, or what sits ABOVE it.
  assert.deepEqual(
    doc.matedChain("bb2", "forward").map((b) => b.id),
    ["bb2", "bb3"],
  );
  assert.deepEqual(
    doc.matedChain("bb2", "backward").map((b) => b.id),
    ["bb1", "bb2"],
  );
  // The end of a stack takes nothing with it.
  assert.deepEqual(
    doc.matedChain("bb3", "forward").map((b) => b.id),
    ["bb3"],
  );
  // A strip resting flush but never snapped is NOT part of the chain.
  doc.addBoard("rail-full", 0, 19); // loose, mated geometrically to bb3
  assert.deepEqual(
    doc.matedChain("bb3", "forward").map((b) => b.id),
    ["bb3"],
  );
  assert.throws(() => doc.matedChain("bb2", "sideways"), {
    code: "INVALID_ARG",
  });
  assert.deepEqual(doc.matedChain("bb9", "forward"), []);
});

test("matedChain: forward means down AND right across a joined pair", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1..bb3, g1 — the left board
  doc.addKit("full", 64, 0); // bb4..bb6, g2 — flush to its right
  assert.equal(doc.joinMatedGroup("bb5"), "g1"); // one six-strip unit

  // From the left pin-board: down to its own bottom rail, right to the other
  // board's pin-board, and on down to that one's bottom rail. The two TOP
  // rails are above, so they stay.
  assert.deepEqual(
    doc.matedChain("bb2", "forward").map((b) => b.id),
    ["bb2", "bb3", "bb5", "bb6"],
  );
  assert.deepEqual(
    doc.matedChain("bb5", "backward").map((b) => b.id),
    ["bb1", "bb2", "bb4", "bb5"],
  );
});

test("moveBoardsBy: a partial move tears the snap and re-groups both halves", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16, g1
  const chain = doc.matedChain("bb2", "forward").map((b) => b.id);

  doc.moveBoardsBy(chain, 0, 30);
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y]),
    [
      ["bb1", 0], // left behind, exactly where it was
      ["bb2", 33],
      ["bb3", 46],
    ],
  );
  // Both halves are re-derived from what is still mated. The pair that
  // travelled stays a unit under a FRESH id; the strip left alone goes loose.
  assert.equal(doc.getBoard("bb1").group, null);
  assert.equal(doc.getBoard("bb2").group, "g2");
  assert.equal(doc.getBoard("bb3").group, "g2");
  assert.deepEqual(
    doc.groupMembers("bb2").map((b) => b.id),
    ["bb2", "bb3"],
  );
});

test("moveBoardsBy: a torn group never leaves both halves sharing an id", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1..bb3, g1
  doc.addBoard("rail-full", 0, 19); // bb4
  doc.joinMatedGroup("bb4"); // a four-strip stack, still g1

  // Tear it in the middle: two strips travel, two stay — and each pair is
  // still internally mated, so BOTH come out as groups of two.
  doc.moveBoardsBy(["bb3", "bb4"], 0, 40);
  const groups = doc.boards.map((b) => b.group);
  assert.equal(groups[0], groups[1]); // bb1 + bb2 still one unit
  assert.equal(groups[2], groups[3]); // bb3 + bb4 too
  assert.notEqual(groups[0], groups[2]); // but NOT the same unit
  assert.equal(doc.groupMembers("bb1").length, 2);
  assert.equal(doc.groupMembers("bb3").length, 2);
});

test("moveBoardsBy: moving a whole group leaves its id alone", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1..bb3, g1
  doc.moveBoardsBy(["bb1", "bb2", "bb3"], 5, 5);
  assert.deepEqual(
    doc.boards.map((b) => b.group),
    ["g1", "g1", "g1"], // nothing was torn, so no id is burned
  );
  assert.equal(doc.toJSON().nextGroupId, 2);
});

test("moveBoardsBy: guards unknown ids, junk deltas, and overlaps", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1..bb3
  doc.addBoard("pins-tiny", 0, 40); // bb4
  assert.throws(() => doc.moveBoardsBy(["bb1", "nope"], 0, 1), {
    code: "NOT_FOUND",
  });
  assert.throws(() => doc.moveBoardsBy([], 0, 1), { code: "NOT_FOUND" });
  assert.throws(() => doc.moveBoardsBy(["bb1"], NaN, 0), {
    code: "INVALID_ARG",
  });
  assert.throws(() => doc.moveBoardsBy(["bb3"], 0, 24), { code: "OVERLAP" });
  // A failed move changes nothing — not the positions, not the groups.
  assert.deepEqual(
    doc.boards.map((b) => [b.y, b.group]),
    [
      [0, "g1"],
      [3, "g1"],
      [16, "g1"],
      [40, null],
    ],
  );
});

test("groupMembers: the whole kit for a grouped strip, itself for a loose one", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1..bb3, group g1
  doc.addBoard("pins-tiny", 70, 0); // bb4, loose
  assert.deepEqual(
    doc.groupMembers("bb2").map((b) => b.id),
    ["bb1", "bb2", "bb3"],
  );
  assert.deepEqual(doc.groupMembers("bb4"), [
    { id: "bb4", type: "pins-tiny", x: 70, y: 0, rot: 0, group: null },
  ]);
  assert.deepEqual(doc.groupMembers("bb9"), []);
});

test("moveBoardBy: translates every member, preserving relative offsets", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // strips at y 0 / 4 / 18
  // Dragging ANY member drags the kit; the delta snaps to integers.
  assert.deepEqual(doc.moveBoardBy("bb2", 4, -3.4), [
    { id: "bb1", type: "rail-full", x: 4, y: -3, rot: 0, group: "g1" },
    { id: "bb2", type: "pins-full", x: 4, y: 0, rot: 0, group: "g1" },
    { id: "bb3", type: "rail-full", x: 4, y: 13, rot: 0, group: "g1" },
  ]);
  // The stack stays assembled — same offsets from the top strip as before.
  assert.deepEqual(
    doc.boards.map((b) => b.y - doc.getBoard("bb1").y),
    [0, 3, 16],
  );
  // A loose strip moves alone.
  doc.addBoard("pins-tiny", 70, 0); // bb4
  assert.deepEqual(
    doc.moveBoardBy("bb4", 1, 1).map((b) => b.id),
    ["bb4"],
  );
  assert.throws(() => doc.moveBoardBy("bb9", 1, 1), { code: "NOT_FOUND" });
  assert.throws(() => doc.moveBoardBy("bb1", NaN, 0), { code: "INVALID_ARG" });
});

test("canMoveBoardBy: fellow members never collide; outsiders do", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1..bb3 at y 0 / 4 / 18
  doc.addBoard("pins-tiny", 0, 30); // bb4, loose, y 30..44
  // A one-unit nudge slides each strip over a fellow member's OLD outline —
  // allowed, because the group translates as one rigid unit.
  assert.equal(doc.canMoveBoardBy("bb1", 0, 1), true);
  assert.deepEqual(
    doc.moveBoardBy("bb3", 0, 1).map((b) => b.y),
    [1, 4, 17],
  );
  // …but sliding the kit down onto the loose strip is rejected, unmoved.
  assert.equal(doc.canMoveBoardBy("bb2", 0, 12), false);
  assert.throws(() => doc.moveBoardBy("bb2", 0, 12), { code: "OVERLAP" });
  assert.deepEqual(
    doc.boards.map((b) => b.y),
    [1, 4, 17, 30],
  );
  assert.equal(doc.canMoveBoardBy("bb9", 0, 0), false);
});

// ── Components (Feature 40) ──────────────────────────────────────────────────

// bb1 is the full pin-board; tests that need rails add a rail strip as bb2.
function docWithFull() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  return doc;
}

test("addComponent: seats a chip with a fresh c<n> id", () => {
  const doc = docWithFull();
  const chip = doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e5",
  });
  assert.deepEqual(chip, {
    id: "c1",
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e5",
    params: {},
  });
  assert.equal(
    doc.addComponent({
      kind: "chip",
      ref: "74LS04",
      board: "bb1",
      anchor: "e20",
    }).id,
    "c2",
  );
  assert.equal(doc.components.length, 2);
});

test("setSchematicPos: sets, clears, and round-trips a Feature 150 nudge", () => {
  const doc = docWithFull();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });

  const set = doc.setSchematicPos("c1", 12.5, -8);
  assert.deepEqual(set.schematicPos, { x: 12.5, y: -8 });
  assert.deepEqual(doc.getComponent("c1").schematicPos, { x: 12.5, y: -8 });

  // It survives serialization AND a reload through normalizeDocument.
  const reloaded = normalizeDocument(doc.toJSON());
  assert.deepEqual(reloaded.components[0].schematicPos, { x: 12.5, y: -8 });

  // A non-finite coordinate clears the hint (resets the symbol to auto-layout).
  doc.setSchematicPos("c1", NaN, 0);
  assert.equal(doc.getComponent("c1").schematicPos, undefined);
  assert.ok(!("schematicPos" in normalizeDocument(doc.toJSON()).components[0]));

  assert.throws(() => doc.setSchematicPos("nope", 1, 1), /no component/);
});

test("clearSchematicPositions: drops every nudge and reports the count", () => {
  const doc = docWithFull();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "74LS04",
    board: "bb1",
    anchor: "e20",
  });
  doc.setSchematicPos("c1", 1, 2);
  doc.setSchematicPos("c2", 3, 4);
  assert.equal(doc.clearSchematicPositions(), 2);
  assert.equal(doc.getComponent("c1").schematicPos, undefined);
  assert.equal(doc.getComponent("c2").schematicPos, undefined);
  assert.equal(doc.clearSchematicPositions(), 0); // idempotent
});

test("addComponent: rejects bad kinds/refs/boards and illegal seats", () => {
  const doc = docWithFull();
  assert.throws(
    () =>
      doc.addComponent({
        kind: "psu",
        ref: "74LS00",
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
        ref: "74LS00",
        board: "bb9",
        anchor: "e5",
      }),
    { code: "NOT_FOUND" },
  );
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  assert.throws(
    () =>
      doc.addComponent({
        kind: "chip",
        ref: "74LS04",
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
        ref: "74LS04",
        board: "bb1",
        anchor: "f20",
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
});

test("moveComponent: re-seats (same or other board), self-overlap allowed", () => {
  const doc = docWithFull();
  doc.addBoard("pins-tiny", 0, 30);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  // Shift one column into its own footprint.
  assert.deepEqual(doc.moveComponent("c1", "bb1", "e6").anchor, "e6");
  // Cross-board re-seat.
  const moved = doc.moveComponent("c1", "bb2", "e2");
  assert.equal(moved.board, "bb2");
  assert.throws(() => doc.moveComponent("c9", "bb1", "e5"), {
    code: "NOT_FOUND",
  });
  doc.addComponent({ kind: "chip", ref: "74LS04", board: "bb1", anchor: "e5" });
  assert.throws(() => doc.moveComponent("c1", "bb1", "e6"), {
    code: "ILLEGAL_PLACEMENT",
  });
});

test("addComponent: seats a rotated resistor by an anchor plus a lead bend", () => {
  const doc = docWithFull();
  doc.addBoard("rail-full", 0, -4); // bb2 — a rail strip above the pin-board
  const r = doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "j7", // pin 1 above the trench, world (7, 1)
    params: { rot: 90, end: { dx: 0, dy: 11 } }, // the lead bends down to a7
  });
  assert.equal(r.params.rot, 90);
  assert.deepEqual(r.params.end, { dx: 0, dy: 11 });
  assert.equal(doc.isHoleFree("bb1.j7"), false); // both ends occupied
  assert.equal(doc.isHoleFree("bb1.a7"), false);
  // The lead may bend onto a NEIGHBOURING strip. The part stays seated on the
  // pin-board; 3 up from j10 (world 10, 1) is the rail strip's `-` hole 7.
  const rail = doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "j10",
    params: { rot: 90, end: { dx: 0, dy: -3 } },
  });
  assert.equal(rail.board, "bb1"); // seated here, only REACHING the rail
  assert.deepEqual(rail.params.end, { dx: 0, dy: -3 });
  assert.equal(doc.isHoleFree("bb1.j10"), false);
  assert.equal(doc.isHoleFree("bb2.-7"), false);
  // A lead bent onto bare desk would float — legal as a leftover when a strip
  // is pulled away, never as a deliberate placement.
  assert.throws(
    () =>
      doc.addComponent({
        kind: "discrete",
        ref: "resistor",
        board: "bb1",
        anchor: "j20",
        params: { rot: 90, end: { dx: 0, dy: -8 } }, // clear above the rail
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
  // Coincident ends (a zero bend) are nonsense.
  assert.throws(
    () =>
      doc.addComponent({
        kind: "discrete",
        ref: "resistor",
        board: "bb1",
        anchor: "c5",
        params: { rot: 90, end: { dx: 0, dy: 0 } },
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
  // An off-lattice bend never survives normalization.
  assert.throws(
    () =>
      doc.addComponent({
        kind: "discrete",
        ref: "resistor",
        board: "bb1",
        anchor: "c8",
        params: { rot: 90, end: { dx: 0.5, dy: 3 } },
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
});

test("movePartEnds: repositions BOTH ends atomically; guards bad targets", () => {
  const doc = docWithFull();
  doc.addBoard("rail-full", 0, -4); // bb2 — a rail strip above the pin-board
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "e10", // e10 ── e13
  });

  // Stand it up at j5 (world 5, 1) with the lead 3 up onto the rail strip's
  // `-` hole 3 (world 5, −2); both old holes are released.
  const moved = doc.movePartEnds("c1", "bb1", "j5", { dx: 0, dy: -3 });
  assert.equal(moved.board, "bb1");
  assert.equal(moved.anchor, "j5");
  assert.equal(moved.params.rot, 90);
  assert.deepEqual(moved.params.end, { dx: 0, dy: -3 });
  assert.equal(doc.isHoleFree("bb1.e10"), true);
  assert.equal(doc.isHoleFree("bb1.e13"), true);
  assert.equal(doc.isHoleFree("bb1.j5"), false);
  assert.equal(doc.isHoleFree("bb2.-3"), false);
  // Re-bending while keeping the anchor it already owns is fine (it ignores
  // itself): 1 across lands on the rail's next hole, `-4`.
  assert.deepEqual(
    doc.movePartEnds("c1", "bb1", "j5", { dx: 1, dy: -3 }).params.end,
    { dx: 1, dy: -3 },
  );
  assert.equal(doc.isHoleFree("bb2.-3"), true); // the old rail hole released
  assert.equal(doc.isHoleFree("bb2.-4"), false);

  // Unknown component / board.
  assert.throws(() => doc.movePartEnds("c9", "bb1", "a1", { dx: 3, dy: 0 }), {
    code: "NOT_FOUND",
  });
  assert.throws(() => doc.movePartEnds("c1", "bb9", "a1", { dx: 3, dy: 0 }), {
    code: "NOT_FOUND",
  });
  // Coincident ends, and a bend reaching nothing at all.
  assert.throws(() => doc.movePartEnds("c1", "bb1", "a1", { dx: 0, dy: 0 }), {
    code: "ILLEGAL_PLACEMENT",
  });
  assert.throws(() => doc.movePartEnds("c1", "bb1", "a1", { dx: 0, dy: 20 }), {
    code: "ILLEGAL_PLACEMENT",
  });
  // An end occupied by another part.
  doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: "bb1",
    anchor: "a1", // a1, a2
  });
  assert.throws(() => doc.movePartEnds("c1", "bb1", "a1", { dx: 4, dy: 0 }), {
    code: "ILLEGAL_PLACEMENT",
  });
  // Non-rotatable parts don't have two free ends to move.
  doc.addComponent({
    kind: "discrete",
    ref: "sw-push",
    board: "bb1",
    anchor: "j1",
  });
  assert.throws(() => doc.movePartEnds("c3", "bb1", "a5", { dx: 3, dy: 0 }), {
    code: "INVALID_REF",
  });
});

test("rotateComponent: swings pin 2's lead 90° around pin 1; guards non-rotatable", () => {
  const doc = docWithFull();
  // Horizontal resistor: pin 1 at e10, pin 2 at e13 (offsets 0, 3).
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "e10",
  });
  const rotated = doc.rotateComponent("c1");
  assert.equal(rotated.params.rot, 90);
  assert.equal(rotated.anchor, "e10"); // pin 1 fixed
  // The (3, 0) lead swings to (0, 3) — three rows down the same column, b10.
  assert.deepEqual(rotated.params.end, { dx: 0, dy: 3 });
  assert.equal(doc.isHoleFree("bb1.e10"), false);
  assert.equal(doc.isHoleFree("bb1.b10"), false);
  assert.equal(doc.isHoleFree("bb1.e13"), true); // old pin-2 hole freed

  // Unknown id and non-rotatable parts are guarded.
  assert.throws(() => doc.rotateComponent("c9"), { code: "NOT_FOUND" });
  doc.addComponent({
    kind: "discrete",
    ref: "sw-push",
    board: "bb1",
    anchor: "j1",
  });
  assert.throws(() => doc.rotateComponent("c2"), { code: "INVALID_REF" });
});

test("rotateComponent: a swung lead reaches a NEIGHBOURING strip's rail", () => {
  const doc = docWithFull();
  doc.addBoard("rail-full", 0, -4); // bb2 — a rail strip above the pin-board
  // Horizontal at j5 ── j8 (row j is world y 1, right under the rail strip),
  // with g5 — where the CW swing would land — already taken.
  doc.addComponent({
    kind: "discrete",
    ref: "sw-push",
    board: "bb1",
    anchor: "g5", // g5 and g7
  });
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "j5",
  });
  // So the CCW swing wins, and it takes the lead clean OFF this strip: (0, −3)
  // from world (5, 1) is the rail strip's `-` hole 3.
  const rotated = doc.rotateComponent("c2");
  assert.deepEqual(rotated.params.end, { dx: 0, dy: -3 });
  assert.equal(rotated.board, "bb1"); // still seated on the pin-board
  assert.equal(doc.isHoleFree("bb1.j5"), false);
  assert.equal(doc.isHoleFree("bb2.-3"), false);
  assert.equal(doc.isHoleFree("bb1.j8"), true); // the old pin-2 hole freed
});

test("rotateComponent: an oscillator can spins in place around its own centre — 180° per call for the non-square full-can, 90° for the square half-can", () => {
  const doc = docWithFull();
  // Full-can (6×3) at e10, rot 0 — see occupancy.test.js for the full corner
  // layout (e10/e16/f16/f10). One call jumps straight to the diagonally
  // opposite corner (where pin 3 sat) instead of stopping at 90°.
  doc.addComponent({
    kind: "discrete",
    ref: "osc-full",
    board: "bb1",
    anchor: "e10",
  });
  let rotated = doc.rotateComponent("c1");
  assert.equal(rotated.params.rot, 180);
  assert.equal(rotated.anchor, "f16");
  rotated = doc.rotateComponent("c1");
  assert.equal(rotated.params.rot, 0); // and back — never stops at 90/270
  assert.equal(rotated.anchor, "e10");

  // Half-can (3×3, square) at g10, rot 0 — a plain quarter-turn each call.
  doc.addComponent({
    kind: "discrete",
    ref: "osc-half",
    board: "bb1",
    anchor: "g10",
  });
  rotated = doc.rotateComponent("c2");
  assert.equal(rotated.params.rot, 90);
  assert.equal(rotated.anchor, "j10");
  rotated = doc.rotateComponent("c2");
  assert.equal(rotated.params.rot, 180);
});

test("removeComponent: removes; ids never reused across reload", () => {
  const doc = docWithFull();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.removeComponent("c1");
  assert.deepEqual(doc.components, []);
  assert.throws(() => doc.removeComponent("c1"), { code: "NOT_FOUND" });
  const reloaded = new DeskDoc(doc.toJSON());
  assert.equal(
    reloaded.addComponent({
      kind: "chip",
      ref: "74LS00",
      board: "bb1",
      anchor: "e5",
    }).id,
    "c2",
  );
});

test("removeBoard cascades its seated components", () => {
  const doc = docWithFull();
  doc.addBoard("pins-tiny", 0, 30);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({ kind: "chip", ref: "74LS04", board: "bb2", anchor: "e2" });
  assert.equal(doc.componentsOnBoard("bb1").length, 1);
  doc.removeBoard("bb1");
  assert.deepEqual(
    doc.components.map((c) => c.id),
    ["c2"],
  );
});

test("removeBoard leaves a part REACHING into it alone — the lead just floats", () => {
  const doc = docWithFull();
  doc.addBoard("rail-full", 0, -4); // bb2 — a rail strip above the pin-board
  // A rotated LED seated on the pin-board with its cathode lead bent 3 up onto
  // the rail strip: world (10, 1) → (10, −2), which is bb2.−7.
  const led = doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: "bb1",
    anchor: "j10",
    params: { color: "green", rot: 90, end: { dx: 0, dy: -3 } },
  });
  assert.equal(doc.isHoleFree("bb2.-7"), false);

  doc.removeBoard("bb2");

  // Removal keys on where a part is SEATED, never on where a lead lands: the
  // LED is untouched — same id, board, anchor and bend, so it keeps its exact
  // position and span. Only the connection is gone.
  assert.deepEqual(
    doc.components.map((c) => c.id),
    [led.id],
  );
  const after = doc.getComponent(led.id);
  assert.equal(after.board, "bb1");
  assert.equal(after.anchor, "j10");
  assert.deepEqual(after.params.end, { dx: 0, dy: -3 });
  assert.equal(after.params.color, "green");
  // The seated pin still occupies its hole; the floating lead occupies nothing.
  assert.equal(doc.isHoleFree("bb1.j10"), false);
  // …and floating is a leftover, not something you can place INTO: the same
  // bend is rejected now that there is nothing under it.
  assert.throws(
    () =>
      doc.addComponent({
        kind: "discrete",
        ref: "led",
        board: "bb1",
        anchor: "j20",
        params: { rot: 90, end: { dx: 0, dy: -3 } },
      }),
    { code: "ILLEGAL_PLACEMENT" },
  );
});

test("canPlaceChip mirrors occupancy through the document", () => {
  const doc = docWithFull();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  assert.equal(doc.canPlaceChip("74LS04", "bb1", "e8"), false);
  assert.equal(doc.canPlaceChip("74LS04", "bb1", "e12"), true);
  assert.equal(
    doc.canPlaceChip("74LS00", "bb1", "e6", { ignoreId: "c1" }),
    true,
  );
});

// ── Wires (Feature 50) ───────────────────────────────────────────────────────

test("addWire: connects two free holes with a fresh w<n> id", () => {
  const doc = docWithFull();
  doc.addBoard("rail-full", 0, -4); // bb2 — a rail strip above the pin-board
  // A jumper from the pin-board up to a rail strip: wires cross strips freely.
  const wire = doc.addWire({ from: "bb1.a1", to: "bb2.+3", color: "blue" });
  assert.deepEqual(wire, {
    id: "w1",
    from: "bb1.a1",
    to: "bb2.+3",
    color: "blue",
  });
  assert.equal(doc.addWire({ from: "bb1.a2", to: "bb1.a6" }).id, "w2");
  assert.equal(doc.wires.length, 2);
  // Both endpoints are now occupied.
  assert.equal(doc.isHoleFree("bb1.a1"), false);
  assert.equal(doc.isHoleFree("bb2.+3"), false);
});

test("addWire: rejects occupied/self/unreal endpoints and junk colors", () => {
  const doc = docWithFull();
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
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

test("moveWire: re-addresses BOTH ends at once; frees both old holes", () => {
  const doc = docWithFull();
  doc.addWire({ from: "bb1.a1", to: "bb1.a10", color: "blue" }); // w1

  // Translate the whole wire; it keeps its id/color, both ends re-addressed.
  const moved = doc.moveWire("w1", "bb1.a2", "bb1.a11");
  assert.deepEqual(moved, {
    id: "w1",
    from: "bb1.a2",
    to: "bb1.a11",
    color: "blue",
  });
  assert.equal(doc.isHoleFree("bb1.a1"), true); // both old holes released
  assert.equal(doc.isHoleFree("bb1.a10"), true);
  assert.equal(doc.isHoleFree("bb1.a2"), false); // both new holes occupied
  assert.equal(doc.isHoleFree("bb1.a11"), false);

  // Rejections: unknown wire, coincident ends, onto another wire's hole, unreal.
  assert.throws(() => doc.moveWire("w9", "bb1.a3", "bb1.a4"), {
    code: "NOT_FOUND",
  });
  assert.throws(() => doc.moveWire("w1", "bb1.a3", "bb1.a3"), {
    code: "ILLEGAL_PLACEMENT",
  });
  doc.addWire({ from: "bb1.b1", to: "bb1.b5" }); // w2 occupies bb1.b1
  assert.throws(() => doc.moveWire("w1", "bb1.b1", "bb1.a3"), {
    code: "ILLEGAL_PLACEMENT",
  });
  assert.throws(() => doc.moveWire("w1", "bb1.a3", "bb1.a99"), {
    code: "ILLEGAL_PLACEMENT",
  });
});

test("removeBoard cascades wires touching it (either endpoint)", () => {
  const doc = docWithFull();
  doc.addBoard("pins-tiny", 0, 30); // bb2
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
    boards: [{ id: "bb1", type: "pins-tiny", x: 0, y: 0 }],
    wires: [
      { id: "w2", from: "bb1.a1", to: "bb1.a5", color: "cyan" }, // color coerced
      { id: "w2", from: "bb1.b1", to: "bb1.b5", color: "red" }, // dup id
      { id: "x1", from: "bb1.c1", to: "bb1.c5", color: "red" }, // bad id
      { id: "w3", from: "bb1.a1", to: "bb1.a1", color: "red" }, // self hole
      { id: "w4", from: "bb9.a1", to: "bb1.d5", color: "red" }, // dangling board
      { id: "w5", from: "bb1.+1", to: "bb1.d5", color: "red" }, // no rails on pins
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
  assert.deepEqual(led.params, {
    color: "blue",
    flip: true,
    rot: 0,
    end: null,
  });
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
        ref: "74LS00",
        board: "bb1",
        anchor: "e30",
      }),
    { code: "INVALID_REF" },
  );
});

test("discrete occupancy: pins occupy; overlaps rejected; rails illegal", () => {
  const doc = docWithFull();
  doc.addBoard("rail-full", 0, -4); // bb2 — a rail strip above the pin-board
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
  doc.addBoard("pins-tiny", 0, 0);
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
  assert.equal(doc.canPlace("pins-tiny", 30, 1), false);
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
  const led = doc.addBoard("pins-tiny", 40, 0);
  assert.ok(led);
  assert.throws(() => doc.moveComponent("psu1", "bb1", "a1"), {
    code: "INVALID_KIND",
  });
});

test("PSU terminals wire like holes and removal cascades those wires", () => {
  const doc = docWithFull();
  doc.addBoard("rail-full", 0, -4); // bb2 — the rails live on their own strip
  doc.addPsu(80, 0);
  assert.equal(doc.isHoleFree("psu1.+"), true);
  assert.equal(doc.isHoleFree("psu1.x"), false); // no such terminal
  const wire = doc.addWire({ from: "psu1.+", to: "bb2.+3", color: "red" });
  assert.ok(wire);
  assert.equal(doc.isHoleFree("psu1.+"), false); // one lead per terminal
  assert.throws(() => doc.addWire({ from: "psu1.+", to: "bb2.+4" }), {
    code: "ILLEGAL_PLACEMENT",
  });
  doc.addWire({ from: "psu1.-", to: "bb2.-3" });
  assert.equal(doc.wiresTouching("psu1").length, 2);
  doc.removeComponent("psu1");
  assert.deepEqual(doc.wires, []);
  assert.equal(doc.getComponent("psu1"), null);
});

test("normalizeDocument: discretes + PSUs survive; junk dropped/coerced", () => {
  const doc = normalizeDocument({
    boards: [{ id: "bb1", type: "pins-tiny", x: 0, y: 0 }],
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

// ── Snapshot / restore (Feature 200 undo/redo) ─────────────────────────────

test("snapshot is a deep copy that later mutations never touch", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const snap = doc.snapshot();
  doc.addBoard("pins-tiny", 0, 30);
  // The snapshot froze the one-board state.
  assert.equal(snap.boards.length, 1);
  assert.equal(doc.boards.length, 2);
});

test("restore swaps the whole document for a snapshot, byte-exact", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const before = doc.snapshot();
  doc.addBoard("pins-tiny", 0, 30);
  doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e5",
  });
  doc.restore(before);
  assert.deepEqual(doc.toJSON(), before);
  assert.equal(doc.components.length, 0);
  assert.equal(doc.boards.length, 1);
});

test("a snapshot→restore round-trip is idempotent", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  const a = doc.snapshot();
  doc.restore(a);
  const b = doc.snapshot();
  assert.deepEqual(a, b);
});

test("restore takes its own copy — the source snapshot stays reusable", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const snap = doc.snapshot();
  doc.restore(snap);
  doc.addBoard("pins-tiny", 0, 30); // mutating the live doc…
  // …must not have reached back into the snapshot we restored from.
  assert.equal(snap.boards.length, 1);
});

// ── Net names (Feature 120) ──────────────────────────────────────────────────

test("nameNet: upsert by address; clearNetName removes it", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  assert.deepEqual(doc.nameNet("bb1.a5", "VCC"), {
    address: "bb1.a5",
    name: "VCC",
  });
  assert.equal(doc.netNameAt("bb1.a5"), "VCC");
  // Naming the same address again replaces (upserts), never duplicates.
  doc.nameNet("bb1.a5", "GND");
  assert.equal(doc.netNames.length, 1);
  assert.equal(doc.netNameAt("bb1.a5"), "GND");
  assert.equal(doc.clearNetName("bb1.a5"), true);
  assert.equal(doc.netNameAt("bb1.a5"), null);
  assert.equal(doc.clearNetName("bb1.a5"), false); // idempotent
});

test("nameNet: trims the name and rejects junk", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  assert.equal(doc.nameNet("bb1.a5", "  CLK  ").name, "CLK");
  assert.throws(() => doc.nameNet("bb1.a5", "   "), { code: "INVALID_ARG" });
  assert.throws(() => doc.nameNet("bb1.a5", ""), { code: "INVALID_ARG" });
  assert.throws(() => doc.nameNet("no-dot", "X"), { code: "INVALID_ARG" });
});

test("normalizeDocument: drops a binding whose address does not parse", () => {
  const doc = normalizeDocument({
    ...emptyDocument(),
    netNames: [
      { address: "bb1.a5", name: "VCC" },
      { address: "no-dot", name: "BAD" }, // unparseable → dropped
      { address: "bb1.a5", name: "DUP" }, // duplicate address → dropped
      { address: "bb1.b7", name: "   " }, // empty name → dropped
    ],
  });
  assert.deepEqual(doc.netNames, [{ address: "bb1.a5", name: "VCC" }]);
});

// ── Annotations: labels & notes (Feature 120) ────────────────────────────────

test("addAnnotation: fresh an<n> ids, then round-trips through toJSON", () => {
  const doc = new DeskDoc(null);
  const a = doc.addAnnotation("label", 3, 4, "clock divider");
  assert.match(a.id, /^an[1-9]\d*$/);
  assert.deepEqual(a, {
    id: "an1",
    kind: "label",
    x: 3,
    y: 4,
    text: "clock divider",
  });
  const b = doc.addAnnotation("note", 10, 12, "", {
    color: "#f00",
    anchor: "c1",
  });
  assert.equal(b.id, "an2");
  assert.equal(b.color, "#f00");
  assert.equal(b.anchor, "c1");
  // The document round-trips the annotations + the id counter verbatim.
  const round = normalizeDocument(doc.toJSON());
  assert.deepEqual(round.annotations, doc.toJSON().annotations);
  assert.equal(round.nextAnnotationId, 3);
});

test("updateAnnotation: patches x/y/text/color/anchor; clears with null", () => {
  const doc = new DeskDoc(null);
  const a = doc.addAnnotation("note", 0, 0, "hi", {
    color: "#0f0",
    anchor: "c1",
  });
  const u = doc.updateAnnotation(a.id, { x: 5, y: 6, text: "bye" });
  assert.deepEqual(
    { x: u.x, y: u.y, text: u.text },
    { x: 5, y: 6, text: "bye" },
  );
  const cleared = doc.updateAnnotation(a.id, { color: null, anchor: "" });
  assert.equal("color" in cleared, false);
  assert.equal("anchor" in cleared, false);
  assert.throws(() => doc.updateAnnotation("an99", { x: 1 }), {
    code: "NOT_FOUND",
  });
});

test("removeAnnotation: removes, then throws NOT_FOUND", () => {
  const doc = new DeskDoc(null);
  const a = doc.addAnnotation("label", 0, 0, "x");
  doc.removeAnnotation(a.id);
  assert.equal(doc.annotations.length, 0);
  assert.throws(() => doc.removeAnnotation(a.id), { code: "NOT_FOUND" });
});

test("addAnnotation: rejects a bad kind or non-finite position", () => {
  const doc = new DeskDoc(null);
  assert.throws(() => doc.addAnnotation("scribble", 0, 0), {
    code: "INVALID_KIND",
  });
  assert.throws(() => doc.addAnnotation("label", NaN, 0), {
    code: "INVALID_ARG",
  });
});

test("normalizeDocument: repairs annotations and advances the counter", () => {
  const doc = normalizeDocument({
    ...emptyDocument(),
    annotations: [
      { id: "an1", kind: "label", x: 1, y: 2, text: "ok" },
      { id: "an5", kind: "note", x: 3, y: 4 }, // missing text → ""
      { id: "bad", kind: "label", x: 0, y: 0 }, // bad id → dropped
      { id: "an2", kind: "scribble", x: 0, y: 0 }, // bad kind → dropped
      { id: "an3", kind: "label", x: NaN, y: 0 }, // bad coords → dropped
    ],
  });
  assert.equal(doc.annotations.length, 2);
  assert.equal(doc.annotations[1].text, ""); // defaulted
  assert.equal(doc.nextAnnotationId, 6); // past an5
});

test("removing an anchored part detaches the annotation, keeping its spot", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const chip = doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e5",
  });
  const label = doc.addAnnotation("label", 2, 2, "U1", { anchor: chip.id });
  doc.removeComponent(chip.id);
  const still = doc.getAnnotation(label.id);
  assert.equal(still.anchor, undefined); // detached
  assert.deepEqual({ x: still.x, y: still.y }, { x: 2, y: 2 }); // stayed put
});

// ── Scope channels (Feature 210) ─────────────────────────────────────────────

test("addScopeChannel: fresh sc<n> ids, kind/ref, and dedupe check", () => {
  const doc = new DeskDoc(null);
  const a = doc.addScopeChannel("net", "bb1.f12", { color: "#0af" });
  const b = doc.addScopeChannel("bus", "bus1", { label: "ADDR" });
  assert.equal(a.id, "sc1");
  assert.equal(b.id, "sc2");
  assert.deepEqual(
    doc.scopeChannels.map((c) => c.id),
    ["sc1", "sc2"],
  );
  assert.equal(a.kind, "net");
  assert.equal(a.color, "#0af");
  assert.equal(b.label, "ADDR");
  assert.ok(doc.hasScopeChannel("net", "bb1.f12"));
  assert.ok(!doc.hasScopeChannel("net", "bb1.f13"));
  // Survives a JSON round-trip with the counter reconciled past the max id.
  const round = normalizeDocument(doc.toJSON());
  assert.equal(round.scopeChannels.length, 2);
  assert.equal(round.nextScopeChannelId, 3);
});

test("addScopeChannel: rejects a bad kind or empty ref", () => {
  const doc = new DeskDoc(null);
  assert.throws(() => doc.addScopeChannel("wat", "bb1.a1"), {
    code: "INVALID_KIND",
  });
  assert.throws(() => doc.addScopeChannel("net", ""), { code: "INVALID_ARG" });
});

test("updateScopeChannel: patches label/color, clears with null", () => {
  const doc = new DeskDoc(null);
  const a = doc.addScopeChannel("net", "bb1.f12", {
    label: "Q",
    color: "#f00",
  });
  const u = doc.updateScopeChannel(a.id, { label: "Q0" });
  assert.equal(u.label, "Q0");
  assert.equal(u.color, "#f00");
  const cleared = doc.updateScopeChannel(a.id, { color: null, label: "" });
  assert.equal(cleared.color, undefined);
  assert.equal(cleared.label, undefined);
  assert.throws(() => doc.updateScopeChannel("sc99", { label: "x" }), {
    code: "NOT_FOUND",
  });
});

test("removeScopeChannel + moveScopeChannel reorder", () => {
  const doc = new DeskDoc(null);
  const a = doc.addScopeChannel("net", "bb1.a1");
  const b = doc.addScopeChannel("net", "bb1.a2");
  const c = doc.addScopeChannel("net", "bb1.a3");
  doc.moveScopeChannel(c.id, 0); // move last to front
  assert.deepEqual(
    doc.scopeChannels.map((x) => x.id),
    [c.id, a.id, b.id],
  );
  doc.removeScopeChannel(a.id);
  assert.deepEqual(
    doc.scopeChannels.map((x) => x.id),
    [c.id, b.id],
  );
  assert.throws(() => doc.removeScopeChannel(a.id), { code: "NOT_FOUND" });
});

test("normalizeDocument: drops junk scope channels and advances the counter", () => {
  const doc = normalizeDocument({
    scopeChannels: [
      { id: "sc2", kind: "net", ref: "bb1.f12", color: "#0af" },
      { id: "sc3", kind: "bus", ref: "bus1" },
      { id: "sc4", kind: "wat", ref: "bb1.a1" }, // bad kind → dropped
      { id: "sc5", kind: "net", ref: "" }, // empty ref → dropped
      { id: "junk", kind: "net", ref: "bb1.a1" }, // bad id → dropped
      { id: "sc2", kind: "net", ref: "dup" }, // duplicate id → dropped
    ],
  });
  assert.deepEqual(
    doc.scopeChannels.map((c) => c.id),
    ["sc2", "sc3"],
  );
  assert.equal(doc.nextScopeChannelId, 4); // past sc3
});
