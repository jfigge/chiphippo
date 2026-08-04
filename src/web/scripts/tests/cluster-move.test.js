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

// Tests for dragging a MULTI-SELECTION as one rigid group (model/cluster-move.js)
// and for the legality of the whole batch (DeskDoc.prepareClusterMove /
// moveClusterWithWires). The ride rule itself is part-move.test.js's.

import test from "node:test";
import assert from "node:assert/strict";

import {
  clusterDelta,
  clusterMembers,
  memberDragForm,
  partsRidingCluster,
  planClusterRiders,
  resolveClusterTargets,
  wiresRidingCluster,
} from "../model/cluster-move.js";
import { planPartMove } from "../model/part-move.js";
import { spec } from "../model/breadboard.js";
import { addressAtWorld, worldOfAddress } from "../model/occupancy.js";
import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";

// A rail dovetailed above a full pin-board — the vertical geometry is MEASURED,
// so the rail's holes sit 2.76 pitch above row j and nothing here may assume a
// whole-number offset between the two strips.
const RAIL = { id: "bb4", type: "rail-full", x: 0, y: 0 };
const FULL = { id: "bb1", type: "pins-full", x: 0, y: 3.5 };
const AWAY = { id: "bb2", type: "pins-full", x: 80, y: 3.5 };

const at = (boards, address) => worldOfAddress(boards, address);

/** A plain document from a list of components and wires. */
function scene({ boards = [RAIL, FULL], components = [], wires = [] } = {}) {
  return {
    boards,
    components,
    wires: wires.map((w, i) => ({ id: `w${i + 1}`, color: "red", ...w })),
  };
}

const chip = (id, anchor, board = "bb1") => ({
  id,
  kind: "chip",
  ref: "74LS00",
  board,
  anchor,
});
const button = (id, anchor, board = "bb1") => ({
  id,
  kind: "discrete",
  ref: "sw-push",
  board,
  anchor,
});
const led = (id, anchor, params = { rot: 0 }, board = "bb1") => ({
  id,
  kind: "discrete",
  ref: "led",
  board,
  anchor,
  params,
});
const psu = (id, x, y) => ({ id, kind: "psu", ref: "psu", x, y, params: {} });
/** A resistor on its two free ends: pin 1 in `anchor`, pin 2 `end` away. */
const resistor = (id, anchor, end, board = "bb1") => ({
  id,
  kind: "discrete",
  ref: "resistor",
  board,
  anchor,
  params: { rot: 90, end, ohms: 220 },
});

// ── memberDragForm ─────────────────────────────────────────────────────────

test("memberDragForm: a ROTATABLE part is a lead at any rotation", () => {
  // The one place this parts company with paste-cluster's memberForm, which
  // asks what to DRAW. #onPartPointerDown routes on def.rotatable alone, so a
  // rot-0 LED drags by its two ends exactly as a turned one does.
  assert.equal(memberDragForm(led("c1", "a5", { rot: 0 })), "lead");
  assert.equal(
    memberDragForm(led("c1", "a5", { rot: 90, end: { dx: 0, dy: 2 } })),
    "lead",
  );
  assert.equal(memberDragForm(chip("c1", "e5")), "footprint");
  assert.equal(memberDragForm(button("c1", "a5")), "footprint");
  assert.equal(memberDragForm(psu("psu1", 40, 0)), "brick");
  assert.equal(memberDragForm({ id: "c9", ref: "nonesuch" }), null);
});

// ── clusterMembers ─────────────────────────────────────────────────────────

test("clusterMembers: document order, whatever order the selection was built", () => {
  const doc = scene({
    components: [chip("c1", "e5"), button("c2", "a20"), psu("psu1", 40, 0)],
  });
  const members = clusterMembers(doc, ["psu1", "c2", "c1"]);
  assert.deepEqual(
    members.map((m) => m.id),
    ["c1", "c2", "psu1"],
  );
  assert.deepEqual(members[0].anchorWorld, at(doc.boards, "bb1.e5"));
  assert.deepEqual(members[2].anchorWorld, { x: 40, y: 0 });
});

test("clusterMembers: ANY member that won't resolve refuses the whole drag", () => {
  const doc = scene({ components: [chip("c1", "e5")] });
  assert.equal(
    clusterMembers(doc, ["c1", "c9"]),
    null,
    "an id that isn't here",
  );
  assert.equal(
    clusterMembers(scene({ components: [chip("c1", "e5"), { id: "c2", kind: "discrete", ref: "nonesuch", board: "bb1", anchor: "a5" }] }), ["c1", "c2"]), // prettier-ignore
    null,
    "an unknown ref",
  );
  assert.equal(clusterMembers(doc, []), null, "nothing selected");
});

// ── clusterDelta ───────────────────────────────────────────────────────────

test("clusterDelta: a footprint grab reports the HOLE-to-hole vector", () => {
  const doc = scene({ components: [chip("c1", "e5")] });
  const grab = {
    form: "footprint",
    ref: "74LS00",
    params: {},
    anchorWorld: at(doc.boards, "bb1.e5"),
    startWorld: at(doc.boards, "bb1.e3"),
    grabOffsetCols: 2, // the press was 2 columns left of the anchor
  };
  assert.deepEqual(clusterDelta(doc.boards, grab, grab.startWorld), {
    dx: 0,
    dy: 0,
  });
  const moved = clusterDelta(doc.boards, grab, at(doc.boards, "bb1.e8"));
  assert.deepEqual(moved, { dx: 5, dy: 0 }, "e5 → e10");
});

test("clusterDelta: a footprint grab inherits partSeatAt's CLAMP", () => {
  // Dragged past the end of the strip the chip stops at the last column it
  // fits in, so the whole cluster stops with it rather than sliding off.
  const doc = scene({ components: [chip("c1", "e5")] });
  const grab = {
    form: "footprint",
    ref: "74LS00",
    params: {},
    anchorWorld: at(doc.boards, "bb1.e5"),
    startWorld: at(doc.boards, "bb1.e3"),
    grabOffsetCols: 2,
  };
  const far = clusterDelta(doc.boards, grab, at(doc.boards, "bb1.e62"));
  // A DIP-14 spans 7 columns, so the last anchor a 63-column strip can hold is
  // 57 — the delta is that, not the 64 the grab point asked for.
  assert.deepEqual(far, { dx: 52, dy: 0 });
});

test("clusterDelta: a LEAD grab lands the anchor exactly on a hole", () => {
  // The delta reported is the SNAPPED hole's own offset — which across a
  // dovetail is fractional (2.76 pitch from row j to the rail above it).
  // Rounding the delta instead would sit the whole cluster a quarter of a pitch
  // beside every hole.
  const doc = scene({ components: [led("c1", "j10")] });
  const anchorWorld = at(doc.boards, "bb1.j10");
  const grab = {
    form: "lead",
    ref: "led",
    params: { rot: 0 },
    anchorWorld,
    startWorld: anchorWorld,
  };
  const up = { x: anchorWorld.x, y: anchorWorld.y - 2.8 };
  const delta = clusterDelta(doc.boards, grab, up);
  assert.ok(delta, "it found the rail");
  assert.equal(
    Number.isInteger(delta.dy),
    false,
    "and the offset is fractional",
  );
  const landed = { x: anchorWorld.x + delta.dx, y: anchorWorld.y + delta.dy };
  assert.deepEqual(at(doc.boards, addressAtWorld(doc.boards, landed.x, landed.y)), landed); // prettier-ignore
});

test("clusterDelta: a LEAD grab crosses to the next board of a SPANNED run", () => {
  // A spanned run puts the next pin-board 17.52 pitch down, so the ROUNDED
  // travel lands the anchor 0.48 off the hole it aimed at — past holeAt's 0.45
  // radius, and the whole cluster could not cross at all. Rounding is a
  // HORIZONTAL rule: the vertical heights are measured, not typed.
  const MID = { id: "bb6", type: "rail-full", x: 0, y: FULL.y + 14.02 };
  const BELOW = { id: "bb5", type: "pins-full", x: 0, y: FULL.y + 17.52 };
  const doc = scene({
    boards: [RAIL, FULL, MID, BELOW],
    components: [led("c1", "a10")],
  });
  const from = at(doc.boards, "bb1.a10");
  const grab = {
    form: "lead",
    ref: "led",
    params: { rot: 0 },
    anchorWorld: from,
    startWorld: from,
  };
  const delta = clusterDelta(doc.boards, grab, at(doc.boards, "bb5.a10"));
  assert.ok(delta, "it reached the board below");
  assert.equal(
    addressAtWorld(doc.boards, from.x + delta.dx, from.y + delta.dy),
    "bb5.a10",
  );
});

test("clusterDelta: null over bare desk — the caller keeps its last delta", () => {
  const doc = scene({ components: [chip("c1", "e5")] });
  const grab = {
    form: "footprint",
    ref: "74LS00",
    params: {},
    anchorWorld: at(doc.boards, "bb1.e5"),
    startWorld: at(doc.boards, "bb1.e5"),
    grabOffsetCols: 2,
  };
  assert.equal(clusterDelta(doc.boards, grab, { x: -500, y: -500 }), null);
});

test("clusterDelta: a BRICK grab is whole units of free desk", () => {
  const grab = {
    form: "brick",
    ref: "psu",
    anchorWorld: { x: 40, y: 0 },
    startWorld: { x: 40, y: 0 },
  };
  assert.deepEqual(clusterDelta([], grab, { x: 43.4, y: -2.6 }), {
    dx: 3,
    dy: -3,
  });
});

test("clusterDelta: a BRICK grab snaps through a SEATED member when there is one", () => {
  // Two mated kits put their pin-boards 21.02 apart — the heights are measured,
  // not typed — so whole desk units, which is all a brick has of its own, can
  // never bridge them. A selection dragged BY ITS PSU has to travel on the
  // board's lattice, not the desk's.
  const BELOW = { id: "bb5", type: "pins-full", x: 0, y: FULL.y + 21.02 };
  const doc = scene({
    boards: [RAIL, FULL, BELOW],
    components: [button("c1", "a10", "bb5"), psu("psu1", 80, 30)],
  });
  const members = clusterMembers(doc, ["c1", "psu1"]);
  const grab = {
    form: "brick",
    ref: "psu",
    anchorWorld: { x: 80, y: 30 },
    startWorld: { x: 81, y: 31 },
  };
  const up = { x: 81, y: 31 - 21.02 };
  const snapped = clusterDelta(doc.boards, grab, up, members);
  assert.equal(snapped.dx, 0);
  // The exact board offset, not the whole unit nearest it (an ulp of binary
  // float either way — every consumer of a delta re-snaps through a hole).
  assert.ok(
    Math.abs(snapped.dy + 21.02) < 1e-9,
    `expected ≈ -21.02, got ${snapped.dy}`,
  );
  // …and with nothing seated in the selection there is no other lattice.
  const bricks = clusterMembers(doc, ["psu1"]);
  assert.deepEqual(clusterDelta(doc.boards, grab, up, bricks), {
    dx: 0,
    dy: -21,
  });
});

// ── resolveClusterTargets ──────────────────────────────────────────────────

test("resolveClusterTargets: every member lands on the corresponding hole", () => {
  const doc = scene({
    components: [chip("c1", "e5"), button("c2", "a20"), psu("psu1", 40, 0)],
  });
  const members = clusterMembers(doc, ["c1", "c2", "psu1"]);
  const { targets, resolved } = resolveClusterTargets(doc.boards, members, {
    dx: 3,
    dy: 0,
  });
  assert.equal(resolved, true);
  assert.deepEqual(targets, [
    { id: "c1", form: "footprint", board: "bb1", anchor: "e8" },
    { id: "c2", form: "footprint", board: "bb1", anchor: "a23" },
    { id: "psu1", form: "brick", x: 43, y: 0 },
  ]);
});

test("resolveClusterTargets: members crossing to ANOTHER strip re-address", () => {
  // Two boards at the same offset share a lattice, so one rigid delta carries
  // the whole group from one to the other.
  const doc = scene({
    boards: [RAIL, FULL, AWAY],
    components: [chip("c1", "e5"), button("c2", "a20")],
  });
  const members = clusterMembers(doc, ["c1", "c2"]);
  const { targets, resolved } = resolveClusterTargets(doc.boards, members, {
    dx: 80,
    dy: 0,
  });
  assert.equal(resolved, true);
  assert.deepEqual(targets, [
    { id: "c1", form: "footprint", board: "bb2", anchor: "e5" },
    { id: "c2", form: "footprint", board: "bb2", anchor: "a20" },
  ]);
});

test("resolveClusterTargets: ONE member with nowhere to land refuses the lot", () => {
  const doc = scene({
    components: [chip("c1", "e5"), button("c2", "a62")],
  });
  const members = clusterMembers(doc, ["c1", "c2"]);
  const { targets, resolved } = resolveClusterTargets(doc.boards, members, {
    dx: 4,
    dy: 0,
  });
  assert.equal(resolved, false, "c2 would run off the end of the strip");
  assert.equal(targets[0].anchor, "e9", "c1 still reports where it WOULD go");
  assert.equal(targets[1].anchor, null);
});

// ── wiresRidingCluster ─────────────────────────────────────────────────────

test("wiresRidingCluster: one wire, two members, one end each", () => {
  // The ordinary case of a jumper between two parts selected together — and
  // exactly why the attribution is per END rather than per wire.
  const doc = scene({
    components: [chip("c1", "e5"), button("c2", "a20")],
    wires: [{ from: "bb1.a6", to: "bb1.b20" }],
  });
  assert.deepEqual(wiresRidingCluster(doc, ["c1", "c2"]), [
    {
      wireId: "w1",
      ends: [
        { end: "from", memberId: "c1" },
        { end: "to", memberId: "c2" },
      ],
    },
  ]);
});

test("wiresRidingCluster: a node two members share is claimed ONCE", () => {
  // A chip pin in e5 and a button pin in a5 are both in bb1|c5L. Document
  // order decides; under a rigid move they would carry it to the same place.
  const doc = scene({
    components: [chip("c1", "e5"), button("c2", "a5")],
    wires: [{ from: "bb1.c5", to: "bb1.c40" }],
  });
  assert.deepEqual(wiresRidingCluster(doc, ["c1", "c2"]), [
    { wireId: "w1", ends: [{ end: "from", memberId: "c1" }] },
  ]);
});

test("wiresRidingCluster: a wire touching NO member rides nothing", () => {
  const doc = scene({
    components: [chip("c1", "e5")],
    wires: [{ from: "bb1.a30", to: "bb1.a40" }],
  });
  assert.deepEqual(wiresRidingCluster(doc, ["c1"]), []);
});

// ── partsRidingCluster ─────────────────────────────────────────────────────

test("partsRidingCluster: a resistor leg in a member's node rides it", () => {
  // The screenshot case: an LED and a chip selected, a resistor plugged into
  // the same column-half as one of the LED's legs.
  const doc = scene({
    components: [chip("c1", "e5"), led("c2", "a20"), resistor("c3", "b21", { dx: 0, dy: -8 })], // prettier-ignore
  });
  assert.deepEqual(partsRidingCluster(doc, ["c1", "c2"]), [
    { id: "c3", pins: [{ pin: 1, memberId: "c2" }] },
  ]);
});

test("partsRidingCluster: a SELECTED part rides as a member, not as a leg", () => {
  const doc = scene({
    components: [led("c1", "a20"), resistor("c2", "b21", { dx: 0, dy: -8 })],
  });
  assert.deepEqual(partsRidingCluster(doc, ["c1", "c2"]), [], "both selected");
  assert.deepEqual(partsRidingCluster(doc, ["c1"]), [
    { id: "c2", pins: [{ pin: 1, memberId: "c1" }] },
  ]);
});

test("partsRidingCluster: a resistor bridging TWO members rides by both legs", () => {
  const doc = scene({
    components: [
      chip("c1", "e5"),
      led("c2", "a20"),
      // b7 is in the chip's c7L; b21 is in the LED's c21L.
      resistor("c3", "b7", { dx: 14, dy: 0 }),
    ],
  });
  assert.deepEqual(partsRidingCluster(doc, ["c1", "c2"]), [
    {
      id: "c3",
      pins: [
        { pin: 1, memberId: "c1" },
        { pin: 2, memberId: "c2" },
      ],
    },
  ]);
});

// ── planClusterRiders ───────────────────────────────────────────────────────

/** Plan `ids` shifted by `delta`, the way the gesture does. */
function planShift(doc, ids, delta) {
  const members = clusterMembers(doc, ids);
  const { targets } = resolveClusterTargets(doc.boards, members, delta);
  const riding = wiresRidingCluster(doc, ids);
  return { riding, plan: planClusterRiders(doc, { members, targets, riding }) };
}

test("planClusterRiders: a wire between two members is carried by both ends", () => {
  const doc = scene({
    components: [chip("c1", "e5"), button("c2", "a20")],
    wires: [{ from: "bb1.a6", to: "bb1.b20" }],
  });
  const { plan } = planShift(doc, ["c1", "c2"], { dx: 3, dy: 0 });
  assert.equal(plan.resolved, true);
  assert.deepEqual(plan.moves, [{ id: "w1", from: "bb1.a9", to: "bb1.b23" }]);
});

test("planClusterRiders: EXACTLY one entry per riding wire, no-ops included", () => {
  // The button slides two rows down its own column-half: its pins move, its
  // riders don't. The entry is still named — that is what tells the batch check
  // the hole is spoken for.
  const doc = scene({
    components: [button("c1", "a20"), button("c2", "a30")],
    wires: [
      { from: "bb1.b20", to: "bb1.b40" },
      { from: "bb1.b30", to: "bb1.b45" },
    ],
  });
  // Row a is the BOTTOM of the grid, so two rows up is a → c.
  const { plan } = planShift(doc, ["c1", "c2"], { dx: 0, dy: -2 });
  assert.equal(plan.resolved, true);
  assert.deepEqual(plan.moves, [
    { id: "w1", from: "bb1.b20", to: "bb1.b40" },
    { id: "w2", from: "bb1.b30", to: "bb1.b45" },
  ]);
});

test("planClusterRiders: a RAIL-anchored lead carries its GRID pin's riders", () => {
  // An LED with pin 1 on the rail and pin 2 in row j: the rail owns no node, so
  // the ride is entirely pin 2's. Reading the shift off the part's ANCHOR — the
  // rail hole — had no answer at all, which is why the rule is stated per pin.
  const doc = scene({
    components: [led("c1", "-7", { rot: 90, end: { dx: 0, dy: 2.76 } }, "bb4")],
    wires: [{ from: "bb1.h10", to: "bb1.h40" }],
  });
  assert.deepEqual(wiresRidingCluster(doc, ["c1"]), [
    { wireId: "w1", ends: [{ end: "from", memberId: "c1" }] },
  ]);

  const members = clusterMembers(doc, ["c1"]);
  const riding = wiresRidingCluster(doc, ["c1"]);
  const targets = [{ id: "c1", form: "lead", board: "bb4", anchor: "-9" }];
  const plan = planClusterRiders(doc, { members, targets, riding });
  assert.equal(plan.resolved, true);
  assert.deepEqual(plan.moves, [{ id: "w1", from: "bb1.h12", to: "bb1.h40" }]);

  // And the SOLO Option-drag answers identically, because both are the one
  // rule in part-move.js rather than two implementations of it.
  assert.deepEqual(
    planPartMove(doc, { id: "c1", riding: [{ wireId: "w1", ends: ["from"] }], board: "bb4", anchor: "-9" }), // prettier-ignore
    plan,
  );
});

test("planClusterRiders: a rider with nowhere to land refuses the whole plan", () => {
  const doc = scene({
    components: [chip("c1", "e5"), button("c2", "a20")],
    // The second wire's riding end is in the chip's LAST column.
    wires: [{ from: "bb1.a11", to: "bb1.a40" }],
  });
  const { plan } = planShift(doc, ["c1", "c2"], { dx: 55, dy: 0 });
  assert.equal(plan.resolved, false);
});

test("planClusterRiders: bends travel only when BOTH ends ride and AGREE", () => {
  const routed = { layout: "routed", points: [{ x: 20, y: 30 }] };
  const both = scene({
    components: [chip("c1", "e5"), button("c2", "a20")],
    wires: [{ from: "bb1.a6", to: "bb1.b20", ...routed }],
  });
  assert.deepEqual(
    planShift(both, ["c1", "c2"], { dx: 3, dy: 0 }).plan.points,
    [{ id: "w1", dx: 3, dy: 0 }],
  );

  // One end pinned to a part that is NOT moving: the user's bend still belongs
  // where they drew it.
  const one = scene({
    components: [chip("c1", "e5"), button("c2", "a20")],
    wires: [{ from: "bb1.a6", to: "bb1.b40", ...routed }],
  });
  assert.deepEqual(planShift(one, ["c1"], { dx: 3, dy: 0 }).plan.points, []);
});

// ── Against the real document: legality and the netlist ─────────────────────

/** A full board with a PSU beside it, and two 74LS00s in adjacent columns. */
function pairDoc() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e13",
  });
  return doc;
}

/** Every member's target seat under a rigid `delta`, as the gesture builds it. */
function targetsFor(doc, ids, delta) {
  const members = doc.clusterMembers(ids);
  const { targets } = doc.resolveClusterTargets(members, delta);
  const riding = doc.wiresRidingCluster(ids);
  return {
    members,
    targets,
    riding,
    plan: doc.planClusterRiders(members, targets, riding),
  };
}

test("a member landing where a SIBLING is vacating is legal", () => {
  // Two chips 8 columns apart, both shifted +8: the first lands exactly on the
  // second's holes, which it is leaving. Occupancy lifts every mover out, so
  // this is the ordinary case rather than a collision.
  const doc = pairDoc();
  const { targets, plan } = targetsFor(doc, ["c1", "c2"], { dx: 8, dy: 0 });
  assert.deepEqual(
    targets.map((t) => t.anchor),
    ["e13", "e21"],
  );
  const check = doc.prepareClusterMove({ componentIds: ["c1", "c2"] });
  assert.equal(check(targets, plan.moves), true);
});

test("a member landing on a NON-moving part is refused", () => {
  const doc = pairDoc();
  const { targets, plan } = targetsFor(doc, ["c1"], { dx: 8, dy: 0 });
  const check = doc.prepareClusterMove({ componentIds: ["c1"] });
  assert.equal(check(targets, plan.moves), false, "c2 is not going anywhere");
});

test("a pin landing on a rider that is STAYING PUT is refused", () => {
  // The claim set's own case, and the reason a no-op wire entry has to be
  // named: the part slides two rows within its column-half, so its pins move
  // onto the rider's row while the rider — still on the same node — does not
  // move at all. Occupancy has lifted it out, so nothing else would notice.
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "discrete", ref: "sw-push", board: "bb1", anchor: "a20" }); // prettier-ignore
  doc.addComponent({ kind: "discrete", ref: "sw-push", board: "bb1", anchor: "a30" }); // prettier-ignore
  doc.addWire({ from: "bb1.c20", to: "bb1.c40" }); // rides c1, in row c

  const ids = ["c1", "c2"];
  const { targets, plan } = targetsFor(doc, ids, { dx: 0, dy: -2 }); // a → c
  assert.deepEqual(plan.moves, [{ id: "w1", from: "bb1.c20", to: "bb1.c40" }]);
  const check = doc.prepareClusterMove({ componentIds: ids, wireIds: ["w1"] });
  assert.equal(check(targets, plan.moves), false, "the pin wants c20 too");

  // One row up is fine: the pins land in row b and the rider keeps row c.
  const ok = targetsFor(doc, ids, { dx: 0, dy: -1 });
  assert.equal(check(ok.targets, ok.plan.moves), true);
});

test("two BRICKS moving together clear each other's OLD rectangles", () => {
  const doc = new DeskDoc(null);
  const a = doc.addPsu(0, 0);
  const size = 8; // whatever the def is, one step of it is enough to overlap
  const b = doc.addPsu(size, 0);
  const ids = [a.id, b.id];
  const members = doc.clusterMembers(ids);
  const { targets } = doc.resolveClusterTargets(members, { dx: 1, dy: 0 });
  const check = doc.prepareClusterMove({ componentIds: ids });
  assert.equal(check(targets, []), true, "a lands over b's old rect");
  // …and the single-brick check, which can only ignore ITSELF, would refuse it.
  assert.equal(doc.canPlaceBrick("psu", targets[0].x, targets[0].y, { ignoreId: a.id }), false); // prettier-ignore
});

test("a rider ending on a MOVING brick's terminal stays real", () => {
  // isRealPoint resolves `psu1.+` through the component list, so asking it of
  // the reduced document — where the moving PSU has been lifted out — would
  // refuse a perfectly ordinary power lead.
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  const brick = doc.addPsu(80, 0);
  doc.addWire({ from: "bb1.a5", to: `${brick.id}.+` });

  const ids = ["c1", brick.id];
  const { targets, plan } = targetsFor(doc, ids, { dx: 2, dy: 0 });
  assert.deepEqual(plan.moves, [{ id: "w1", from: "bb1.a7", to: `${brick.id}.+` }]); // prettier-ignore
  const check = doc.prepareClusterMove({
    componentIds: ids,
    wireIds: ["w1"],
  });
  assert.equal(check(targets, plan.moves), true);
});

/**
 * What each WIRE connects — the component pins on the net at each of its ends,
 * keyed by wire id. Keyed by id rather than by an address, because in a cluster
 * a wire between two members moves at BOTH ends, so neither of them is the
 * stable label part-move.test.js's fixture can use.
 */
function wiringOf(doc) {
  const json = doc.toJSON();
  const netlist = buildNetlist(json);
  const pinsAt = (address) => {
    const net = netlist.nets.get(netlist.netOfPoint.get(address));
    return (net?.pins ?? []).map((p) => `${p.componentId}:${p.pin}`).sort();
  };
  const out = {};
  for (const wire of json.wires) out[wire.id] = [pinsAt(wire.from), pinsAt(wire.to)]; // prettier-ignore
  return out;
}

/** A chip and a button wired to each other and to two fixed far ends. */
function wiredPair() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({ kind: "discrete", ref: "sw-push", board: "bb1", anchor: "a20" }); // prettier-ignore
  doc.addWire({ from: "bb1.a5", to: "bb1.b20" }); // chip pin 1 ↔ the button
  doc.addWire({ from: "bb1.a6", to: "bb1.a40" }); // chip pin 2 ↔ a fixed far end
  doc.addWire({ from: "bb1.b22", to: "bb1.b41" }); // the button's other side
  return doc;
}

test("THE POINT OF THE FEATURE: a cluster's wiring survives the move", () => {
  const doc = wiredPair();
  const before = wiringOf(doc);
  // Sanity: the fixture really does join the two parts, and does reach a pin.
  assert.deepEqual(before.w1[0], ["c1:1", "c2:1"]);
  assert.deepEqual(before.w2[0], ["c1:2"]);

  const ids = ["c1", "c2"];
  const { targets, plan } = targetsFor(doc, ids, { dx: -2, dy: 0 });
  doc.moveClusterWithWires(targets, plan);

  assert.equal(doc.getComponent("c1").anchor, "e3");
  assert.equal(doc.getComponent("c2").anchor, "a18");
  assert.deepEqual(wiringOf(doc), before);
});

test("…and the SAME move without Option repartitions it", () => {
  const doc = wiredPair();
  const before = wiringOf(doc);

  const members = doc.clusterMembers(["c1", "c2"]);
  const { targets } = doc.resolveClusterTargets(members, { dx: -2, dy: 0 });
  doc.moveClusterWithWires(targets, null); // no riders: a plain group drag

  const after = wiringOf(doc);
  assert.notDeepEqual(
    after,
    before,
    "wires left behind repartition the circuit",
  );
  // Two columns left, and the wire that fed pin 2 now feeds pin 4 — a working
  // circuit quietly computing something else, which is the whole motivation.
  assert.deepEqual(before.w2[0], ["c1:2"]);
  assert.deepEqual(after.w2[0], ["c1:4"]);
});

/** Do these two pins share a net right now? */
function joined(doc, a, b) {
  const netlist = buildNetlist(doc.toJSON());
  const netOf = (pin) => {
    for (const net of netlist.nets.values()) {
      if (net.pins.some((p) => p.componentId === pin[0] && p.pin === pin[1])) {
        return net.id;
      }
    }
    return null;
  };
  const x = netOf(a);
  return x != null && x === netOf(b);
}

test("THE SCREENSHOT: a resistor's leg travels with the LED it is plugged into", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({ kind: "discrete", ref: "led", board: "bb1", anchor: "a20" }); // prettier-ignore
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "b21", // the LED's second leg's column-half…
    params: { rot: 90, end: { dx: 0, dy: -8 }, ohms: 220 }, // …up to row g
  });
  // The LED's cathode and the resistor's near leg are one net; the resistor's
  // far leg is somewhere else entirely, and stays there.
  assert.ok(
    joined(doc, ["c2", 2], ["c3", 1]),
    "the fixture really is plugged in",
  );
  const farBefore = doc.getComponent("c3").params.end;

  const ids = ["c1", "c2"]; // the chip and the LED are selected
  const members = doc.clusterMembers(ids);
  const { targets } = doc.resolveClusterTargets(members, { dx: 3, dy: 0 });
  const ridingParts = doc.partsRidingCluster(ids);
  assert.equal(ridingParts.length, 1, "the resistor rides by one leg");
  const plan = doc.planClusterRiders(members, targets, [], ridingParts);
  doc.moveClusterWithWires([...targets, ...plan.parts], plan);

  assert.equal(doc.getComponent("c2").anchor, "a23", "the LED moved");
  assert.equal(
    doc.getComponent("c3").anchor,
    "b24",
    "and the leg came with it",
  );
  assert.ok(joined(doc, ["c2", 2], ["c3", 1]), "still the same connection");
  // The far leg did not budge: the bend simply grew by what the near one moved.
  assert.deepEqual(doc.getComponent("c3").params.end, {
    dx: farBefore.dx - 3,
    dy: farBefore.dy,
  });
});

test("…and the same move WITHOUT Option leaves the resistor behind", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "discrete", ref: "led", board: "bb1", anchor: "a20" }); // prettier-ignore
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "b21",
    params: { rot: 90, end: { dx: 0, dy: -8 }, ohms: 220 },
  });
  assert.ok(joined(doc, ["c1", 2], ["c3", 1]));

  const members = doc.clusterMembers(["c1", "c2"]);
  const { targets } = doc.resolveClusterTargets(members, { dx: 3, dy: 0 });
  doc.moveClusterWithWires(targets, null); // a plain group drag

  assert.equal(doc.getComponent("c3").anchor, "b21", "it stayed put");
  assert.ok(!joined(doc, ["c1", 2], ["c3", 1]), "and the connection is gone");
});

test("ACROSS THE TRENCH: a group carries its wiring into the other half", () => {
  // The two halves of a column are separate nodes, so a rider that only kept
  // its row was stranded the moment its pin crossed — and the drop reddened
  // over a top half with plenty of room in it.
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "discrete", ref: "sw-push", board: "bb1", anchor: "a10" }); // prettier-ignore
  doc.addComponent({ kind: "discrete", ref: "sw-push", board: "bb1", anchor: "a20" }); // prettier-ignore
  doc.addWire({ from: "bb1.c10", to: "bb1.c40" }); // rides c1
  doc.addWire({ from: "bb1.b20", to: "bb1.b45" }); // rides c2
  const before = wiringOf(doc);

  const ids = ["c1", "c2"];
  const members = doc.clusterMembers(ids);
  // Row a to row g — same columns, opposite half.
  const rows = spec("pins-full").rowY;
  const { targets, resolved } = doc.resolveClusterTargets(members, {
    dx: 0,
    dy: rows.g - rows.a,
  });
  assert.equal(resolved, true);
  assert.deepEqual(
    targets.map((t) => t.anchor),
    ["g10", "g20"],
  );

  const riding = doc.wiresRidingCluster(ids);
  const plan = doc.planClusterRiders(members, targets, riding, []);
  assert.equal(plan.resolved, true, "the wires can cross too");
  // Row a to row g is six rows, so every rider travels six too — c to i, b to
  // h. Each keeps exactly the spacing from its own pin that it had.
  assert.deepEqual(plan.moves, [
    { id: "w1", from: "bb1.i10", to: "bb1.c40" },
    { id: "w2", from: "bb1.h20", to: "bb1.b45" },
  ]);

  doc.moveClusterWithWires(targets, plan);
  assert.deepEqual(wiringOf(doc), before, "and the circuit is unchanged");
});

test("an illegal cluster move throws and changes NOTHING", () => {
  const doc = pairDoc();
  const untouched = JSON.stringify(doc.toJSON());
  const { targets, plan } = targetsFor(doc, ["c1"], { dx: 8, dy: 0 });
  assert.throws(() => doc.moveClusterWithWires(targets, plan), {
    code: "ILLEGAL_PLACEMENT",
  });
  assert.equal(JSON.stringify(doc.toJSON()), untouched);
});

test("a cluster move keeps a rotatable member's stored FORM", () => {
  // A solo body drag converts a rot-0 LED to the two-free-ends form; a group
  // drag writes board and anchor only, so the LED comes out as it went in.
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({
    kind: "discrete",
    ref: "led",
    board: "bb1",
    anchor: "a5",
  });
  doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e20",
  });
  assert.equal(doc.getComponent("c1").params.rot, 0);

  const { targets, plan } = targetsFor(doc, ["c1", "c2"], { dx: 2, dy: 0 });
  doc.moveClusterWithWires(targets, plan);
  assert.equal(doc.getComponent("c1").anchor, "a7");
  assert.equal(
    doc.getComponent("c1").params.rot,
    0,
    "still the footprint form",
  );
  assert.equal(doc.getComponent("c1").params.end, null);
});
