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

// Pure tests for the multi-selection cluster paste: capture strips run-state,
// a rigid integer shift preserves the arrangement, and each member is legal
// only when EVERY pin lands over a free hole of the live document.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import {
  captureCluster,
  memberAnchorWorld,
  memberForm,
  resolveCluster,
} from "../model/paste-cluster.js";

/** A `{boards, components, wires}` view + a canPlaceBrick predicate. */
function ctx(doc) {
  return {
    docLike: {
      boards: doc.boards,
      components: doc.components,
      wires: doc.wires,
    },
    canPlaceBrick: (ref, x, y) => doc.canPlaceBrick(ref, x, y),
  };
}

test("captureCluster: fresh members keep the arrangement, drop run-state", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  // A hand-built source carrying 12 V damage — a paste must never inherit it.
  const comps = [
    {
      kind: "chip",
      ref: "74LS00",
      board: "bb1",
      anchor: "e5",
      params: { damaged: true },
    },
    { kind: "chip", ref: "74LS04", board: "bb1", anchor: "e20", params: {} },
  ];
  const cluster = captureCluster(doc.boards, comps);
  assert.equal(cluster.members.length, 2);
  assert.equal(
    "damaged" in cluster.members[0].params,
    false,
    "damage stripped",
  );
  // Anchor world points are the source hole positions (col c → x = c, row e → y 8).
  assert.deepEqual(cluster.members[0].anchorWorld, { x: 5, y: 8 });
  assert.deepEqual(cluster.members[1].anchorWorld, { x: 20, y: 8 });
  // The grab reference is the arrangement's bounding-box centre.
  assert.deepEqual(cluster.center, { x: 12.5, y: 8 });
});

test("captureCluster returns null when nothing resolves", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  assert.equal(captureCluster(doc.boards, []), null);
  assert.equal(
    captureCluster(doc.boards, [
      { kind: "chip", ref: "not-a-part", board: "bb1", anchor: "e5" },
    ]),
    null,
  );
});

test("resolveCluster: a clear shift lands every member legally, arrangement intact", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "74LS04",
    board: "bb1",
    anchor: "e20",
  });
  const cluster = captureCluster(
    doc.boards,
    doc.components.filter((c) => c.kind === "chip"),
  );

  const { docLike, canPlaceBrick } = ctx(doc);
  // Slide the whole pair 25 columns right onto empty board.
  const results = resolveCluster(
    docLike,
    cluster.members,
    { dx: 25, dy: 0 },
    canPlaceBrick,
  );
  assert.deepEqual(
    results.map((r) => r.legal),
    [true, true],
  );
  assert.deepEqual(results[0].seat, { board: "bb1", anchor: "e30" });
  assert.deepEqual(results[1].seat, { board: "bb1", anchor: "e45" });
  // Their spacing (15 columns) is exactly the source spacing — rigid.
  assert.equal(results[1].anchorWorld.x - results[0].anchorWorld.x, 20 - 5);
});

test("resolveCluster: pasting onto the sources is illegal (holes occupied)", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "74LS04",
    board: "bb1",
    anchor: "e20",
  });
  const cluster = captureCluster(doc.boards, doc.components);

  const { docLike, canPlaceBrick } = ctx(doc);
  const results = resolveCluster(
    docLike,
    cluster.members,
    { dx: 0, dy: 0 },
    canPlaceBrick,
  );
  assert.deepEqual(
    results.map((r) => r.legal),
    [false, false],
  );
});

test("resolveCluster: a member shifted off the board is illegal, the rest legal", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "74LS04",
    board: "bb1",
    anchor: "e20",
  });
  const cluster = captureCluster(doc.boards, doc.components);

  const { docLike, canPlaceBrick } = ctx(doc);
  // +45 columns: the first (e5→e50) still fits; the second (e20→e65) runs off
  // the 63-column board — its anchor is over bare desk.
  const results = resolveCluster(
    docLike,
    cluster.members,
    { dx: 45, dy: 0 },
    canPlaceBrick,
  );
  assert.deepEqual(
    results.map((r) => r.legal),
    [true, false],
  );
  assert.deepEqual(results[0].seat, { board: "bb1", anchor: "e50" });
  assert.equal(results[1].seat, null);
});

test("resolveCluster: a chip nudged off row e (into the trench) is illegal", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  const cluster = captureCluster(doc.boards, doc.components);

  const { docLike, canPlaceBrick } = ctx(doc);
  // Down one row: the anchor leaves row e (y 8) for y 9 (row d) — a DIP can
  // only anchor across the trench at row e, so it can't seat.
  const results = resolveCluster(
    docLike,
    cluster.members,
    { dx: 25, dy: 1 },
    canPlaceBrick,
  );
  assert.equal(results[0].legal, false);
});

test("resolveCluster: a turned resistor translates rigidly, both leads re-checked", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("rail-full", 0, 14); // bb2 — a rail below row a
  // A resistor stood on end: pin 1 on the grid, pin 2 bent down onto the rail.
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "a10",
    params: { rot: 90, end: { dx: 0, dy: 3 } },
  });
  const cluster = captureCluster(doc.boards, doc.components);
  assert.equal(memberForm("resistor", cluster.members[0].params), "turned");

  const { docLike, canPlaceBrick } = ctx(doc);
  // 15 columns over: pin 1 → a25, pin 2 → the rail hole below it. Rails skip
  // every fifth position, so a25 is a column whose rail hole exists.
  const results = resolveCluster(
    docLike,
    cluster.members,
    { dx: 15, dy: 0 },
    canPlaceBrick,
  );
  assert.equal(results[0].legal, true);
  assert.deepEqual(results[0].seat, { board: "bb1", anchor: "a25" });
});

test("resolveCluster: a brick uses the passed canPlaceBrick predicate", () => {
  const doc = new DeskDoc(null);
  const psu = doc.addBrick("psu", 5, 5, { volts: 5 });
  const cluster = captureCluster(doc.boards, [psu]);
  assert.equal(memberForm(psu.ref, psu.params), "brick");
  assert.deepEqual(memberAnchorWorld(doc.boards, psu), { x: 5, y: 5 });

  // Predicate says "only (25,15) is clear".
  const canPlaceBrick = (_ref, x, y) => x === 25 && y === 15;
  const legal = resolveCluster(
    { boards: doc.boards, components: doc.components, wires: doc.wires },
    cluster.members,
    { dx: 20, dy: 10 },
    canPlaceBrick,
  );
  assert.equal(legal[0].legal, true);
  assert.deepEqual(legal[0].seat, { x: 25, y: 15 });

  const illegal = resolveCluster(
    { boards: doc.boards, components: doc.components, wires: doc.wires },
    cluster.members,
    { dx: 0, dy: 0 },
    canPlaceBrick,
  );
  assert.equal(illegal[0].legal, false);
});
