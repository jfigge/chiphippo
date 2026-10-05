/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// Tests for 600-mil DIP seating across the document (footprints.js `dipRows`):
// a wide part seats six pitches across at rows d/h, its body covering rows
// e–g; a desk saved before wide seating keeps its narrow (e/f) seats exactly;
// moving one alone re-seats it at its true width, carrying its wiring out from
// under the body; and a group moves rigidly, keeping every chip's width.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { captureCluster, resolveCluster } from "../model/paste-cluster.js";
import { clusterDelta } from "../model/cluster-move.js";
import { buildOccupancy, worldOfAddress } from "../model/occupancy.js";
import { buildNetlist } from "../sim/netlist.js";

const BOARD = { id: "bb1", type: "pins-full", x: 0, y: 0 };
const chip = (id, ref, anchor) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params: {},
});
const wire = (id, from, to) => ({ id, from, to, color: "red" });

/** A raw document, as a file would carry it. */
const raw = ({ components = [], wires = [] } = {}) => ({
  version: 14,
  boards: [BOARD],
  components,
  wires,
});

test("a desk saved before wide seating loads exactly as it was", () => {
  const doc = normalizeDocument(
    raw({
      components: [chip("c1", "HM62256", "e5")],
      // Row g beside a NARROW seat was a perfectly good hole, and still is.
      wires: [wire("w1", "bb1.g8", "bb1.a40")],
    }),
  );
  assert.deepEqual(
    doc.components.map((c) => c.anchor),
    ["e5"],
  );
  assert.deepEqual(
    doc.wires.map((w) => w.id),
    ["w1"],
  );
});

test("the loader holds a wide chip's body to one hole, one lead", () => {
  // A hand-edited file with a wire end, and a part's lead, under the body:
  // the wide chip came first, so both lose — as any two leads in one hole do.
  const doc = normalizeDocument(
    raw({
      components: [
        chip("c1", "HM62256", "d5"),
        {
          id: "c2",
          kind: "discrete",
          ref: "led",
          board: "bb1",
          anchor: "f30",
          params: {},
        }, // clear of it
        {
          id: "c3",
          kind: "discrete",
          ref: "led",
          board: "bb1",
          anchor: "f10",
          params: {},
        }, // under it
      ],
      wires: [
        wire("w1", "bb1.g8", "bb1.a40"), // under it
        wire("w2", "bb1.c8", "bb1.a41"), // row c, beside its lower pins
      ],
    }),
  );
  assert.deepEqual(
    doc.components.map((c) => c.id),
    ["c1", "c2"],
  );
  assert.deepEqual(
    doc.wires.map((w) => w.id),
    ["w2"],
  );
});

test("a wide chip is placed over rows d–h, and the holes under it refuse a wire", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "W65C02", board: "bb1", anchor: "d5" });
  assert.throws(() => doc.addWire({ from: "bb1.f10", to: "bb1.a40" }), {
    code: "ILLEGAL_PLACEMENT",
  });
  assert.equal(doc.isHoleFree("bb1.e5"), false);
  assert.equal(doc.isHoleFree("bb1.c5"), true);
  // Each pin is still wired through the rows outside it: a–c below, i–j above.
  doc.addWire({ from: "bb1.c5", to: "bb1.i5" });
  const netlist = buildNetlist(doc.toJSON());
  const net = (hole) => netlist.netOfPoint.get(`bb1.${hole}`);
  assert.equal(net("c5"), net("d5"), "pin 1's node");
  assert.equal(net("i5"), net("h5"), "pin 40's node");
});

test("moving a narrow-seated 600-mil chip alone re-seats it at its true width", () => {
  const doc = new DeskDoc(raw({ components: [chip("c1", "HM62256", "e5")] }));
  doc.moveComponent("c1", "bb1", "d7");
  assert.equal(doc.getComponent("c1").anchor, "d7");
  const occ = buildOccupancy(doc.toJSON());
  assert.equal(occ.get("bb1.f10")?.kind, "body");
});

test("its riders come out from under the body when it re-seats wide", () => {
  // Narrow at e5/f5: a wire in g5 rides pin 28 (f5's node), one in d5 rides
  // pin 1 (e5's node). Re-seated wide at d5/h5, g5 is under the plastic and d5
  // is pin 1's own hole — each rider travels with its pin instead: g → i, d → c.
  const doc = new DeskDoc(
    raw({
      components: [chip("c1", "HM62256", "e5")],
      wires: [wire("w1", "bb1.g5", "bb1.a40"), wire("w2", "bb1.d6", "bb1.a41")],
    }),
  );
  const riding = doc.wiresRidingPart("c1");
  const plan = doc.planPartMove("c1", { board: "bb1", anchor: "d5", riding });
  assert.equal(plan.resolved, true);
  const to = new Map(plan.moves.map((m) => [m.id, m.from]));
  assert.equal(to.get("w1"), "bb1.i5");
  assert.equal(to.get("w2"), "bb1.c6");
  doc.moveComponentWithWires("c1", "bb1", "d5", plan);
  assert.equal(doc.getComponent("c1").anchor, "d5");
});

test("a group moves rigidly: a narrow-seated chip in it keeps its width", () => {
  const doc = new DeskDoc(
    raw({
      components: [
        chip("c1", "HM62256", "e5"),
        { id: "c2", kind: "discrete", ref: "led", board: "bb1", anchor: "a30", params: {} }, // prettier-ignore
      ],
    }),
  );
  const members = doc.clusterMembers(["c1", "c2"]);
  const grab = members.find((m) => m.id === "c1");
  const boards = doc.boards;
  // Dragged three columns right by the chip: the delta is a pure column shift,
  // not the row down a wide re-seat would have dragged the whole group by.
  const delta = clusterDelta(
    boards,
    { ...grab, startWorld: grab.anchorWorld, grabOffsetCols: 0 },
    worldOfAddress(boards, "bb1.e15"),
  );
  assert.equal(delta.dy, 0);
  const { targets, resolved } = doc.resolveClusterTargets(members, delta);
  assert.equal(resolved, true);
  assert.equal(targets.find((t) => t.id === "c1").anchor.charAt(0), "e");
  // …and carried a row by a SIBLING, a chip leaves the row it was in, which no
  // rigid move does: nowhere to seat.
  assert.equal(
    doc.resolveClusterTargets(members, { dx: 0, dy: 1 }).resolved,
    false,
  );
});

test("a pasted chip lands at the width it was copied at, or nowhere", () => {
  const source = new DeskDoc(
    raw({ components: [chip("c1", "HM62256", "d5")] }),
  ).toJSON();
  const cluster = captureCluster(source.boards, source.components);
  assert.equal(cluster.members[0].chipRow, "d");
  const target = normalizeDocument(raw());
  const canBrick = () => true;
  const [same] = resolveCluster(target, cluster.members, { dx: 10, dy: 0 }, canBrick); // prettier-ignore
  assert.equal(same.seat.anchor, "d15");
  assert.equal(same.legal, true);
  // A row up would be row e — the narrow seat. Refused rather than re-seated.
  const [up] = resolveCluster(target, cluster.members, { dx: 10, dy: -1 }, canBrick); // prettier-ignore
  assert.equal(up.legal, false);
});
