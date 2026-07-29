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

// Pure tests for the whole-design clip (Feature 240): a capture is total and
// relative, a wire that leaves the set is left behind, the verdict is
// all-or-nothing, and a paste re-stamps the arrangement with fresh ids.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import {
  captureDesign,
  clipScene,
  resolveDesign,
  shiftFor,
  snapDesign,
} from "../model/design-clip.js";
import { boardRect } from "../model/mating.js";

/** The plain `{boards, components, wires, …}` view captureDesign reads. */
const view = (doc) => ({
  boards: doc.boards,
  components: doc.components,
  wires: doc.wires,
  buses: doc.buses,
  netNames: doc.netNames,
  annotations: doc.annotations,
});

/** The placement predicates resolveDesign asks about the live document. */
const tests = (doc) => ({
  canPlaceBoard: (type, x, y, rot) => doc.canPlace(type, x, y, { rot }),
  canPlaceBrick: (ref, x, y) => doc.canPlaceBrick(ref, x, y),
});

/**
 * A small reference design on one pin-board: two chips, a wire between them,
 * and a PSU brick off to the side wired to the board.
 */
function sourceDesign() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "chip",
    ref: "74LS04",
    board: "bb1",
    anchor: "e20",
  });
  doc.addWire({ from: "bb1.a1", to: "bb1.a30", color: "red" });
  return doc;
}

test("captureDesign: a board brings everything seated on it and its wiring", () => {
  const doc = sourceDesign();
  const clip = captureDesign(view(doc), { boardIds: ["bb1"] });
  assert.equal(clip.boards.length, 1);
  // The parts came along without being named in the selection at all.
  assert.deepEqual(
    clip.parts.map((p) => p.ref),
    ["74LS00", "74LS04"],
  );
  assert.equal(clip.wires.length, 1);
  assert.deepEqual(clip.wires[0].from, { owner: "bb1", point: "a1" });
  // The grab reference is the middle of the board's own footprint.
  const rect = boardRect(doc.getBoard("bb1"));
  assert.deepEqual(clip.center, {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  });
});

test("captureDesign: nothing to copy without a board", () => {
  const doc = sourceDesign();
  assert.equal(captureDesign(view(doc), { boardIds: [] }), null);
  assert.equal(captureDesign(view(doc), { boardIds: ["nope"] }), null);
});

test("captureDesign: a wire with one end outside the set is left behind", () => {
  const doc = sourceDesign();
  doc.addBoard("pins-full", 0, 20); // bb2, a neighbour NOT being copied
  doc.addWire({ from: "bb1.a40", to: "bb2.a40", color: "blue" });
  const clip = captureDesign(view(doc), { boardIds: ["bb1"] });
  assert.equal(clip.wires.length, 1, "only the wire wholly inside the set");
  assert.equal(clip.wires[0].color, "red");
});

test("captureDesign: a selected brick travels, and its wires with it", () => {
  const doc = sourceDesign();
  const psu = doc.addPsu(-10, 0);
  doc.addWire({ from: `${psu.id}.+`, to: "bb1.a2", color: "black" });
  const bare = captureDesign(view(doc), { boardIds: ["bb1"] });
  assert.equal(bare.bricks.length, 0);
  assert.equal(bare.wires.length, 1, "the PSU wire has an end outside the set");
  const withPsu = captureDesign(view(doc), {
    boardIds: ["bb1"],
    componentIds: [psu.id],
  });
  assert.equal(withPsu.bricks.length, 1);
  assert.equal(withPsu.wires.length, 2, "now both ends are inside");
});

test("captureDesign: run-volatile and per-instance params are stripped", () => {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const chip = doc.addComponent({
    kind: "chip",
    ref: "74LS00",
    board: "bb1",
    anchor: "e5",
  });
  doc.setComponentParams(chip.id, { damaged: true });
  const clip = captureDesign(view(doc), { boardIds: ["bb1"] });
  assert.equal("damaged" in clip.parts[0].params, false);
  assert.equal("storage" in clip.parts[0].params, false);
});

test("resolveDesign: clear desk legal, overlapping board illegal — all or nothing", () => {
  const source = sourceDesign();
  const clip = captureDesign(view(source), { boardIds: ["bb1"] });

  const empty = new DeskDoc(null);
  assert.equal(resolveDesign(clip, { dx: 0, dy: 0 }, tests(empty)).legal, true);

  // A destination whose own board sits exactly where the design would land.
  const busy = new DeskDoc(null);
  busy.addBoard("pins-full", 0, 0);
  const onTop = resolveDesign(clip, { dx: 0, dy: 0 }, tests(busy));
  assert.equal(onTop.legal, false);
  assert.equal(onTop.boards[0].legal, false);
  // Clear of it, the same design lands fine.
  assert.equal(resolveDesign(clip, { dx: 0, dy: 40 }, tests(busy)).legal, true);
});

test("shiftFor rounds to the integer pitch lattice", () => {
  const clip = { center: { x: 10, y: 4 } };
  assert.deepEqual(shiftFor(clip, { x: 13.4, y: 4.6 }), { dx: 3, dy: 1 });
  assert.deepEqual(shiftFor(clip, { x: 10, y: 4 }), { dx: 0, dy: 0 });
});

test("snapDesign pulls a design flush onto a board it can dovetail with", () => {
  const source = sourceDesign();
  const clip = captureDesign(view(source), { boardIds: ["bb1"] });
  const dest = new DeskDoc(null);
  const anchor = dest.addBoard("pins-full", 0, 0);
  const rect = boardRect(anchor);
  const stationary = [rect];
  // Dropped one pitch short of flush below it: the pull closes the gap.
  const shift = { dx: 0, dy: rect.height - 1 };
  const pull = snapDesign(clip, shift, stationary);
  assert.deepEqual(pull, { dx: 0, dy: 1 });
  // Already flush: nothing to correct.
  assert.deepEqual(snapDesign(clip, { dx: 0, dy: rect.height }, stationary), {
    dx: 0,
    dy: 0,
  });
  // Far away: out of magnetic range.
  assert.deepEqual(snapDesign(clip, { dx: 0, dy: 60 }, stationary), {
    dx: 0,
    dy: 0,
  });
});

test("clipScene re-expresses a clip as a document the geometry helpers read", () => {
  const doc = sourceDesign();
  const clip = captureDesign(view(doc), { boardIds: ["bb1"] });
  const scene = clipScene(clip);
  assert.deepEqual(
    scene.boards.map((b) => b.id),
    ["bb1"],
  );
  assert.equal(scene.components.length, 2);
  assert.equal(scene.wires[0].from, "bb1.a1");
});

test("pasteDesign: fresh ids, remapped addresses, the source untouched", () => {
  const source = sourceDesign();
  const clip = captureDesign(view(source), { boardIds: ["bb1"] });
  const dest = new DeskDoc(null);
  dest.addBoard("pins-full", 0, 0); // bb1 is taken here
  const pasted = dest.pasteDesign(clip, { dx: 0, dy: 40 });

  assert.equal(pasted.boards.length, 1);
  assert.equal(pasted.boards[0].id, "bb2", "a fresh id from this document");
  assert.deepEqual({ x: pasted.boards[0].x, y: pasted.boards[0].y }, { x: 0, y: 40 }); // prettier-ignore
  assert.equal(pasted.components.length, 2);
  assert.equal(pasted.wires.length, 1);
  assert.equal(
    pasted.wires[0].from,
    "bb2.a1",
    "re-addressed onto its new board",
  );
  // The source document never learns it was copied.
  assert.equal(source.boards.length, 1);
  assert.equal(source.components.length, 2);
});

test("a routed wire travels routed, and its bends ride the paste shift", () => {
  const source = sourceDesign();
  source.setWireLayout("w1", "routed");
  source.addWirePoint("w1", 0, { x: 15, y: 30 });
  const clip = captureDesign(view(source), { boardIds: ["bb1"] });
  // The clip carries the shape as it stands; the ghost draws from it.
  assert.equal(clip.wires[0].layout, "routed");
  assert.deepEqual(clip.wires[0].points, [{ x: 15, y: 30 }]);
  assert.deepEqual(clipScene(clip).wires[0].points, [{ x: 15, y: 30 }]);

  const dest = new DeskDoc(null);
  dest.addBoard("pins-full", 0, 0); // bb1 is taken here
  const pasted = dest.pasteDesign(clip, { dx: 0, dy: 40 });
  assert.equal(pasted.wires[0].layout, "routed");
  assert.deepEqual(
    pasted.wires[0].points,
    [{ x: 15, y: 70 }],
    "a waypoint is a desk coordinate, so it moves with the design",
  );
  // The clip is reusable: the shift must not have been written into it.
  assert.deepEqual(clip.wires[0].points, [{ x: 15, y: 30 }]);
});

test("pasteDesign: an illegal landing changes nothing at all", () => {
  const source = sourceDesign();
  const clip = captureDesign(view(source), { boardIds: ["bb1"] });
  const dest = new DeskDoc(null);
  dest.addBoard("pins-full", 0, 0);
  const before = JSON.stringify(dest.toJSON());
  assert.throws(() => dest.pasteDesign(clip, { dx: 0, dy: 0 }), /OVERLAP|overlap/); // prettier-ignore
  assert.equal(JSON.stringify(dest.toJSON()), before, "rolled fully back");
});

test("pasteDesign: a kit's strips keep travelling as one group", () => {
  const source = new DeskDoc(null);
  const strips = source.addKit("full", 0, 0);
  assert.ok(strips[0].group, "the kit arrives grouped");
  const clip = captureDesign(view(source), {
    boardIds: strips.map((s) => s.id),
  });
  const dest = new DeskDoc(null);
  const existing = dest.addKit("full", 0, 40); // a kit already on this desk
  const pasted = dest.pasteDesign(clip, { dx: 0, dy: 0 });
  const groups = new Set(pasted.boards.map((b) => b.group));
  assert.equal(groups.size, 1, "one group across the pasted strips");
  assert.equal(
    groups.has(existing[0].group),
    false,
    "minted here, never merged into a group already on this desk",
  );
});

test("pasteDesign: buses, net names, and anchored labels ride along", () => {
  const source = sourceDesign();
  const wire = source.wires[0];
  source.addBus("D[7:0]", [wire.id], { color: "red" });
  source.nameNet("bb1.a1", "CLK");
  const chip = source.components[0];
  source.addAnnotation("label", 1, 1, "gate", { anchor: chip.id });
  const clip = captureDesign(view(source), { boardIds: ["bb1"] });

  const dest = new DeskDoc(null);
  const pasted = dest.pasteDesign(clip, { dx: 0, dy: 0 });
  assert.equal(dest.buses.length, 1);
  assert.deepEqual(dest.buses[0].members, [pasted.wires[0].id]);
  assert.equal(dest.netNameAt("bb1.a1"), "CLK");
  assert.equal(dest.annotations.length, 1);
  assert.equal(
    dest.annotations[0].anchor,
    pasted.components[0].id,
    "re-anchored onto the pasted part",
  );
});

test("pasteDesign: a free-floating label is NOT part of the design", () => {
  const source = sourceDesign();
  source.addAnnotation("note", 2, 2, "desk note");
  const clip = captureDesign(view(source), { boardIds: ["bb1"] });
  assert.equal(clip.annotations.length, 0);
});

test("DeskDoc.load normalizes an untrusted document", () => {
  const doc = sourceDesign();
  doc.load({ boards: [{ id: "bb9", type: "pins-tiny", x: 3, y: 4 }] });
  assert.equal(doc.boards.length, 1);
  assert.equal(doc.components.length, 0);
  assert.equal(doc.getBoard("bb9").type, "pins-tiny");
  // Junk is dropped rather than trusted through.
  doc.load({ boards: [{ id: "bb1", type: "not-a-board", x: 0, y: 0 }] });
  assert.equal(doc.boards.length, 0);
});
