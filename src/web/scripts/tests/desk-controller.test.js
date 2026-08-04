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

// jsdom tests for DeskController: layer creation, mounting board views from
// the document, add/remove with doc-changed events, selection, placement
// arming, and keyboard handling. Pointer gestures (drag/hover) are exercised
// in the real app — here we cover the state machine's public surface.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc, WIRE_COLORS } from "../model/desk-doc.js";
import {
  addressAtWorld,
  partPinAddresses,
  partPinHoles,
  worldOfAddress,
} from "../model/occupancy.js";
import { spec } from "../model/breadboard.js";
import { deskBounds } from "../model/part-geometry.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { OUTLINE_MARGIN } from "../components/board-outline.js";
import { RING_RADIUS } from "../components/hole-rings.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

/** A viewport + DeskView stub good enough for the controller. `world` is read
    live, so a test can move the "cursor" between dispatched pointer events. */
function makeDesk(deskDoc, world = { x: 0, y: 0 }) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: world.x, y: world.y }),
    setCamera: (c) => Object.assign(deskView.camera, c),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc });
  return { viewport, surface, controller, deskView, world };
}

// Strip heights are MEASURED, not whole pitches (board-types.js): a rail is
// 3.70 units (9.4 mm), a pin-board 14.02 (35.6), so a kit stacks 0 · 3.70 ·
// 17.72 and stands 21.42 tall — and grid rows sit 1.51 below the board's top
// edge, not 1. Fixtures derive from the specs so a re-measurement moves them
// all together. `q` is the 0.01 grid a board origin is stored on.
const q = (n) => Math.round(n * 100) / 100;
const RAIL_H = spec("rail-full").height;
const PINS_H = spec("pins-full").height;
const KIT_H = q(2 * RAIL_H + PINS_H);
const PINS_Y = q(RAIL_H); // a kit's pin-board, relative to the kit origin
const LOW_RAIL_Y = q(RAIL_H + PINS_H); // and its bottom rail
const ROW = spec("pins-full").rowY; // row letter → y within a pin-board

/** World y of a rail strip's `+` / `-` row, for a rail placed at `boardY`. A
    rail is 3.70 tall and its rows sit 1.25 in from each edge — none of which is
    a whole pitch, so no fixture may compute one by hand. */
const railRowY = (boardY, id) =>
  q(boardY + spec("rail-full").rails.find((r) => r.id === id).y);

test("constructor creates the surface layers in order and mounts doc boards", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addBoard("pins-tiny", 0, 30);
  const { surface } = makeDesk(doc);

  assert.deepEqual(
    [...surface.children].map((c) => c.className),
    [
      "layer-boards",
      "layer-parts",
      "layer-wires",
      "layer-annotations",
      "layer-overlay",
    ],
  );
  assert.equal(surface.querySelectorAll(".board").length, 2);
  // Boards land in the boards layer specifically.
  assert.equal(
    surface.querySelector(".layer-boards").querySelectorAll(".board").length,
    2,
  );
});

test("addBoardAt mounts, selects, and emits chiphippo:doc-changed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);

  // x snaps to the column lattice; y keeps two decimals, there being no
  // vertical lattice to snap to any more (board-types.js).
  const board = controller.addBoardAt("pins-half", 2.4, 3.6);
  assert.deepEqual(board, {
    id: "bb1",
    type: "pins-half",
    x: 2,
    y: 3.6,
    rot: 0, // pin-boards never turn
    group: null, // a strip added on its own is loose
  });
  assert.equal(surface.querySelectorAll(".board").length, 1);
  assert.equal(controller.selectedId, "bb1");
  assert.ok(
    surface.querySelector(".board").classList.contains("board--selected"),
  );
  assert.equal(changes, 1);
});

test("addBoardAt propagates OVERLAP and mounts nothing", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);

  assert.throws(() => controller.addBoardAt("pins-tiny", 5, 5), {
    code: "OVERLAP",
  });
  assert.equal(surface.querySelectorAll(".board").length, 1);
});

test("removeBoard unmounts, clears selection, and emits", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addBoardAt("pins-tiny", 0, 0);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);

  controller.removeBoard("bb1");
  assert.equal(surface.querySelectorAll(".board").length, 0);
  assert.equal(controller.selectedId, null);
  assert.equal(doc.boards.length, 0);
  assert.equal(changes, 1);
});

test("Delete on a selected strip removes the whole snapped set", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail, one group
  assert.equal(doc.boards.length, 3);

  controller.selectBoard("bb2"); // selecting any strip highlights the whole set
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Delete" }),
  );
  assert.equal(consumed, true);
  assert.equal(doc.boards.length, 0, "all three strips removed");
  assert.equal(surface.querySelectorAll(".board").length, 0);
  assert.equal(controller.selectedId, null);
  assert.equal(changes, 1, "one batched doc-changed");
});

test("deleting a board set cascades its parts and every wire crossing out", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 · bb2 · bb3, one group
  controller.addBoardAt("pins-full", 0, 40); // bb4, loose and unselected
  const chip = controller.addComponentAt("74LS00", "bb2", "e5"); // seated on the kit
  // A wire from the kit's pin-board out to the unselected loose board…
  const crossing = doc.addWire({ from: "bb2.a20", to: "bb4.a20" });
  // …and one wholly on the loose board, which must survive.
  const kept = doc.addWire({ from: "bb4.a5", to: "bb4.a8" });

  controller.selectBoard("bb1"); // grab a rail; the whole kit is the set
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Delete" }),
  );
  // Parts/wires cascade, so a confirm is raised — accept it.
  const confirmBtn = document.querySelector(".popup-confirm .btn--danger");
  assert.ok(confirmBtn, "a confirm dialog was raised");
  confirmBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.deepEqual(
    doc.boards.map((b) => b.id),
    ["bb4"],
    "only the unselected loose board remains",
  );
  assert.equal(doc.getComponent(chip.id), null, "the seated chip cascaded");
  assert.equal(doc.getWire(crossing.id), null, "the crossing wire cascaded");
  assert.ok(doc.getWire(kept.id), "the loose board's own wire survived");
  assert.equal(surface.querySelectorAll(".part-chip").length, 0);
  assert.equal(changes, 1, "one batched doc-changed after confirm");
});

test("selection moves between boards; deselect clears", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addBoardAt("pins-tiny", 0, 0);
  controller.addBoardAt("pins-tiny", 30, 0); // selects bb2

  const [b1, b2] = surface.querySelectorAll(".board");
  assert.equal(controller.selectedId, "bb2");
  assert.ok(b2.classList.contains("board--selected"));

  controller.selectBoard("bb1");
  assert.ok(b1.classList.contains("board--selected"));
  assert.ok(!b2.classList.contains("board--selected"));

  controller.deselect();
  assert.equal(controller.selectedId, null);
  assert.ok(!b1.classList.contains("board--selected"));
});

test("armPlacement shows a ghost; cancel and Escape clear it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { viewport, surface, controller } = makeDesk(doc);

  controller.armPlacement("full");
  assert.ok(controller.placementArmed);
  assert.ok(surface.querySelector(".layer-overlay .board-ghost"));
  assert.ok(viewport.classList.contains("desk-viewport--placing"));

  // Re-arming with another size replaces the ghost, never stacks.
  controller.armPlacement("tiny");
  assert.equal(surface.querySelectorAll(".board-ghost").length, 1);

  assert.equal(
    controller.handleKeyDown(
      new window.KeyboardEvent("keydown", { key: "Escape" }),
    ),
    true,
  );
  assert.ok(!controller.placementArmed);
  assert.equal(surface.querySelector(".board-ghost"), null);
  assert.ok(!viewport.classList.contains("desk-viewport--placing"));
});

/** Fire a Cmd+<key> keydown at the controller; returns whether it consumed. */
function accelKey(controller, key) {
  return controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key, metaKey: true }),
  );
}

test("Cmd+C then Cmd+V arms a placement ghost that drops a duplicate", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { viewport, surface, controller, world } = makeDesk(doc);
  controller.addBoardAt("pins-full", 0, 0);
  // Seating a chip selects it; Cmd+C should copy that one part.
  controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  assert.equal(doc.components.length, 1);

  assert.equal(accelKey(controller, "c"), true);
  assert.equal(accelKey(controller, "v"), true);
  assert.ok(controller.placementArmed);
  assert.equal(
    surface.querySelectorAll(".layer-overlay .part-ghost").length,
    1,
  );

  // Drop the duplicate on a clear stretch of the same board.
  const seat = worldOfAddress(doc.boards, "bb1.e30");
  world.x = seat.x;
  world.y = seat.y;
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.ok(!controller.placementArmed);
  assert.equal(doc.components.length, 2);
  assert.deepEqual(
    doc.components.map((c) => c.ref),
    ["74LS00", "74LS00"],
  );
});

test("Cmd+V carries the copied chip's orientation into the duplicate", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { viewport, controller, world } = makeDesk(doc);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  // R flips a selected chip 180°; copy the flipped part.
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));
  assert.equal(doc.getComponent(chip.id).params.rot, 180);

  accelKey(controller, "c");
  accelKey(controller, "v");
  const seat = worldOfAddress(doc.boards, "bb1.e30");
  world.x = seat.x;
  world.y = seat.y;
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const dupe = doc.components.find((c) => c.id !== chip.id);
  assert.equal(dupe.ref, "74LS00");
  assert.equal(dupe.params.rot, 180);
});

test("Cmd+V keeps a rotatable part's turned orientation and lead vector", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("rail-full", 0, PINS_H); // bb2 — a rail below row a
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);

  // Source: a resistor stood on end, its lead reaching down onto the rail's
  // `+` row — a bend, so it is stated as the vector from row a to that row.
  const src = controller.addComponentAt("resistor", "bb1", "a10", {
    rot: 90,
    end: { dx: 0, dy: q(railRowY(PINS_H, "+") - ROW.a) },
  });
  assert.equal(doc.getComponent(src.id).params.rot, 90);

  accelKey(controller, "c");
  accelKey(controller, "v");
  assert.ok(controller.placementArmed);

  // Track + drop the duplicate a few columns over; pin 1 rides the cursor. Land
  // it on a column whose rail hole exists (rails skip every fifth position).
  world.x = 25;
  world.y = ROW.a; // hole a25
  viewport.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true }),
  );
  viewport.dispatchEvent(
    new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const dupe = doc.components.find((c) => c.id !== src.id);
  assert.ok(dupe, "a duplicate landed");
  assert.equal(dupe.ref, "resistor");
  assert.equal(dupe.params.rot, 90); // turned, exactly like the source
  assert.deepEqual(dupe.params.end, { dx: 0, dy: 3 });
  // Same shape as the source: pin 1 on the board, pin 2 down on the rail.
  assert.deepEqual(partPinAddresses(doc, dupe), [
    { pin: 1, address: "bb1.a25" },
    { pin: 2, address: "bb2.+20" },
  ]);
});

test("Cmd+C with nothing selected and Cmd+V with an empty buffer no-op", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  controller.addBoardAt("pins-full", 0, 0);
  controller.deselect();

  // Not consumed → the native Edit-menu copy/paste still handles the key.
  assert.equal(accelKey(controller, "c"), false);
  assert.equal(accelKey(controller, "v"), false);
  assert.ok(!controller.placementArmed);
});

test("addKitAt: a loose strip dropped flush mates with the board it touches", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addKitAt("half", 0, 0); // bb1..bb3, group g1 — spans y 0…21.42

  // A spare rail seated against the kit's bottom edge joins its group, so the
  // whole stack drags as one unit from here on.
  const [rail] = controller.addKitAt("rail-half", 0, KIT_H);
  assert.equal(rail.type, "rail-half");
  assert.equal(controller.selectedId, rail.id); // the new strip is selected
  assert.deepEqual(
    doc.groupMembers(rail.id).map((b) => b.id),
    ["bb1", "bb2", "bb3", rail.id],
  );
  assert.equal(surface.querySelectorAll(".layer-boards .board").length, 4);

  // Dropped clear of everything it stays loose — mating is contact, not
  // proximity.
  const [loose] = controller.addKitAt("rail-half", 0, 40);
  assert.equal(doc.getBoard(loose.id).group, null);
});

test("addKitAt: a bare pin-board places on its own and takes a chip", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);

  const strips = controller.addKitAt("pins-full", 0, 0);
  assert.equal(strips.length, 1);
  assert.deepEqual(
    strips.map((s) => [s.type, s.group]),
    [["pins-full", null]],
  );
  // It is an ordinary pin-board: parts seat across its trench as always.
  assert.ok(doc.canPlaceChip("74LS00", strips[0].id, "e2"));
});

test("Delete/Backspace removes the selected board via handleKeyDown", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addBoardAt("pins-tiny", 0, 0);

  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Backspace" }),
  );
  assert.equal(consumed, true);
  assert.equal(surface.querySelectorAll(".board").length, 0);
  assert.equal(doc.boards.length, 0);

  // Nothing selected → the key is not consumed.
  assert.equal(
    controller.handleKeyDown(
      new window.KeyboardEvent("keydown", { key: "Delete" }),
    ),
    false,
  );
});

/** Shift-drag a marquee across the viewport from one world point to another. */
function marquee(viewport, world, from, to) {
  world.x = from.x;
  world.y = from.y;
  viewport.dispatchEvent(
    new window.PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 7,
      shiftKey: true,
      clientX: 0,
      clientY: 0,
    }),
  );
  world.x = to.x;
  world.y = to.y;
  for (const type of ["pointermove", "pointerup"]) {
    viewport.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId: 7,
        shiftKey: true,
        clientX: 60,
        clientY: 60,
      }),
    );
  }
}

test("shift-drag marquee selects only components fully inside the box", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  // 74LS00 at e5 spans columns 5–11 (x 5…11) across rows f (y 5) and e (y 8).
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  // A second chip far to the right, well outside the box.
  const outside = controller.addComponentAt("74LS04", "bb1", "e20");

  // Box covering columns 4–12, rows f..e — encloses every pin of the first.
  marquee(viewport, world, { x: 4, y: 4 }, { x: 12, y: 9 });
  assert.deepEqual(controller.multiSelectedIds, [chip.id]);
  assert.ok(!controller.multiSelectedIds.includes(outside.id));
});

test("a component only PARTLY inside the marquee is not selected", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11

  // Box stops at column 8 — the right-hand pins fall outside.
  marquee(viewport, world, { x: 4, y: 4 }, { x: 8, y: 9 });
  assert.deepEqual(controller.multiSelectedIds, []);
  assert.ok(chip.id);
});

// ── The Option-drag hint (Feature 290) ──────────────────────────────────────

/** Ring centres currently on the desk, as world points, sorted for comparison.
    The shared hover ring is the same `.hole-ring` class, so it would show up
    here too — these tests never hover, so it stays hidden. */
function ringCentres(surface) {
  return [...surface.querySelectorAll(".hole-ring:not([hidden])")]
    .map((r) => ({
      x: (parseFloat(r.style.left) + RING_RADIUS * PX_PER_UNIT) / PX_PER_UNIT,
      y: (parseFloat(r.style.top) + RING_RADIUS * PX_PER_UNIT) / PX_PER_UNIT,
    }))
    .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
    .sort();
}

const holeAt = (doc, address) =>
  (({ x, y }) => `${Math.round(x)},${Math.round(y)}`)(
    worldOfAddress(doc.boards, address),
  );

/** A chip at e5 with two riders (one end each) and one wire that doesn't ride. */
function wiredChipDesk() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const desk = makeDesk(doc, world);
  const chip = desk.controller.addComponentAt("74LS00", "bb1", "e5");
  doc.addWire({ from: "bb1.a5", to: "bb1.a40" }); // rides by `from`
  doc.addWire({ from: "bb1.j11", to: "bb1.j40" }); // rides by `from`
  doc.addWire({ from: "bb1.a20", to: "bb1.a30" }); // outside the chip's nodes
  return { ...desk, doc, chip };
}

test("Option over a selected part rings the wire ends that would ride", () => {
  resetDom();
  const { surface, controller, doc, chip } = wiredChipDesk();
  controller.selectComponent(chip.id);

  assert.deepEqual(ringCentres(surface), [], "nothing until Option is down");
  controller.setRidePreview(true);
  assert.deepEqual(
    ringCentres(surface),
    [holeAt(doc, "bb1.a5"), holeAt(doc, "bb1.j11")].sort(),
    "the two riding ends, and not their far ends",
  );

  controller.setRidePreview(false);
  assert.deepEqual(ringCentres(surface), [], "released, and put away");
});

test("a wire riding by BOTH ends gets two rings — which ends travel, which stay", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  doc.addWire({ from: "bb1.a5", to: "bb1.d9" }); // both ends in the chip's nodes

  controller.selectComponent(chip.id);
  controller.setRidePreview(true);
  assert.deepEqual(
    ringCentres(surface),
    [holeAt(doc, "bb1.a5"), holeAt(doc, "bb1.d9")].sort(),
  );
});

test("the hint answers only for a part that could actually be Option-dragged", () => {
  resetDom();
  const { surface, controller, doc, chip } = wiredChipDesk();
  controller.deselect(); // addComponentAt selects what it places
  controller.setRidePreview(true);
  assert.deepEqual(ringCentres(surface), [], "nothing is selected");

  controller.selectBoard("bb1");
  assert.deepEqual(ringCentres(surface), [], "a board carries no riders");

  controller.selectComponent(chip.id);
  assert.equal(ringCentres(surface).length, 2);

  // Topology is frozen while the circuit runs, so the hint must not offer it.
  controller.setEditingLocked(true);
  assert.deepEqual(ringCentres(surface), []);
  controller.setEditingLocked(false);
  assert.equal(ringCentres(surface).length, 2);

  // And it tracks the document: delete the wire it was ringing.
  controller.removeWire("w1");
  assert.deepEqual(ringCentres(surface), [holeAt(doc, "bb1.j11")]);
});

test("the hint stands down while the drag it describes is in flight", () => {
  resetDom();
  const { surface, controller, doc, chip, world } = wiredChipDesk();
  controller.selectComponent(chip.id);
  controller.setRidePreview(true);
  assert.equal(ringCentres(surface).length, 2);

  const el = surface.querySelector(`[data-component-id="${chip.id}"]`);
  world.x = 8;
  world.y = 6.5;
  el.dispatchEvent(
    new window.PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 5,
      altKey: true,
      clientX: 0,
      clientY: 0,
    }),
  );
  // From here the moving wires answer the question themselves; rings sitting on
  // the holes being vacated would say the opposite.
  assert.deepEqual(ringCentres(surface), []);

  world.x = 13;
  for (const type of ["pointermove", "pointerup"]) {
    el.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId: 5,
        clientX: 40,
        clientY: 0,
      }),
    );
  }
  // Option is still down, so the hint comes back — on the holes the wires
  // actually landed in.
  assert.deepEqual(
    ringCentres(surface),
    [holeAt(doc, "bb1.a10"), holeAt(doc, "bb1.j16")].sort(),
  );
});

test("Option over a MULTI-selection rings every member's riders", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  doc.addWire({ from: "bb1.a5", to: "bb1.b30" }); // rides BOTH, one end each
  doc.addWire({ from: "bb1.j11", to: "bb1.j40" }); // rides the chip alone
  doc.addWire({ from: "bb1.c20", to: "bb1.c25" }); // rides neither

  controller.deselect();
  controller.toggleComponentSelection(chip.id);
  controller.toggleComponentSelection(btn.id);
  controller.setRidePreview(true);
  assert.deepEqual(
    ringCentres(surface),
    [holeAt(doc, "bb1.a5"), holeAt(doc, "bb1.b30"), holeAt(doc, "bb1.j11")].sort(), // prettier-ignore
    "both ends of the wire between them, plus the chip's own rider",
  );
});

test("the multi-selection hint stays quiet when the press would REFUSE", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  doc.addWire({ from: "bb1.a5", to: "bb1.b30" });

  controller.deselect();
  controller.toggleComponentSelection(chip.id);
  controller.toggleComponentSelection(btn.id);
  controller.setRidePreview(true);
  assert.equal(ringCentres(surface).length, 2);

  // A board in the set refuses the press, so ringing wires it would carry is a
  // promise the app will not keep.
  controller.toggleBoardSelection("bb1");
  assert.deepEqual(ringCentres(surface), []);
});

test("a node two members share is ringed ONCE, not twice", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  // A chip pin at e5 and a button pin at a5 are both in bb1|c5L.
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a5");
  doc.addWire({ from: "bb1.c5", to: "bb1.c40" });

  controller.deselect();
  controller.toggleComponentSelection(chip.id);
  controller.toggleComponentSelection(btn.id);
  controller.setRidePreview(true);
  assert.deepEqual(ringCentres(surface), [holeAt(doc, "bb1.c5")]);
});

test("a marquee started ON a part is still a marquee — Shift is selection", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11

  // The part's pointerdown bails on Shift and lets it bubble to the viewport —
  // which is why Feature 290's wire-carrying drag took OPTION instead. A press
  // landing on the chip must not become a part drag.
  const el = surface.querySelector(`[data-component-id="${chip.id}"]`);
  marquee(el, world, { x: 4, y: 4 }, { x: 12, y: 9 });
  assert.deepEqual(controller.multiSelectedIds, [chip.id]);
});

test("selectAll takes the WHOLE desk — boards, parts and wires alike", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addBoard("pins-full", 0, 30);
  const { controller } = makeDesk(doc);
  const a = controller.addComponentAt("74LS00", "bb1", "e5");
  const b = controller.addComponentAt("74LS04", "bb1", "e20");
  const wire = doc.addWire({ from: "bb1.a1", to: "bb1.a2" });

  assert.equal(controller.selectAll(), true);
  // The same set a marquee round everything would take, which is what makes
  // ⌘A then ⌘C copy the desktop as one design clip.
  assert.deepEqual(controller.multiSelectedIds.sort(), [a.id, b.id].sort());
  assert.deepEqual(controller.multiSelectedWireIds, [wire.id]);
  assert.deepEqual(
    controller.multiSelectedBoardIds.sort(),
    doc.boards.map((x) => x.id).sort(),
  );
});

test("selectAll on an empty desk selects nothing and says so", () => {
  resetDom();
  const { controller } = makeDesk(new DeskDoc(null));
  assert.equal(controller.selectAll(), false);
  assert.deepEqual(controller.multiSelectedIds, []);
  assert.deepEqual(controller.multiSelectedBoardIds, []);
});

test("selectAll is refused while the circuit runs, as a marquee is", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");
  controller.setEditingLocked(true);
  assert.equal(controller.selectAll(), false);
  assert.deepEqual(controller.multiSelectedIds, []);
  controller.setEditingLocked(false);
  assert.equal(controller.selectAll(), true);
});

test("selectAll replaces a single pick rather than adding to it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const other = controller.addComponentAt("74LS04", "bb1", "e20");
  controller.selectComponent(chip.id);
  assert.equal(controller.selectedId, chip.id);

  controller.selectAll();
  assert.equal(controller.selectedId, null, "the marquee owns the selection");
  assert.deepEqual(controller.multiSelectedIds.sort(), [chip.id, other.id].sort()); // prettier-ignore
  // Dropping the single pick un-highlights the part it was on, so it has to
  // happen BEFORE the set is highlighted — otherwise the already-selected
  // part is the one that comes out looking unselected.
  assert.deepEqual(
    [...surface.querySelectorAll(".layer-parts > .part--selected")].length,
    2,
    "every selected part is highlighted, the previous pick included",
  );
});

test("Delete removes the whole marquee selection in one doc-changed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  controller.addComponentAt("resistor", "bb1", "a6"); // a6 ── a9
  assert.equal(doc.components.length, 2);

  // A box enclosing both (rows f..a, columns 4–12).
  marquee(viewport, world, { x: 4, y: 4 }, { x: 12, y: 13 });
  assert.equal(controller.multiSelectedIds.length, 2);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Delete" }),
  );
  assert.equal(consumed, true);
  assert.equal(doc.components.length, 0, "both parts deleted");
  assert.equal(changes, 1, "one batched doc-changed");
  assert.deepEqual(controller.multiSelectedIds, []);
});

test("the marquee takes wires with BOTH ends inside, and Delete removes them", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  // Wholly inside the box below: a5 (x 5, y 12) → a8 (x 8, y 12).
  const held = doc.addWire({ from: "bb1.a5", to: "bb1.a8" });
  // Straddling it: a6 is inside, a40 (x 40) is far to the right.
  const straddling = doc.addWire({ from: "bb1.a6", to: "bb1.a40" });

  marquee(viewport, world, { x: 4, y: 10 }, { x: 12, y: 14 });
  assert.deepEqual(controller.multiSelectedWireIds, [held.id]);
  assert.ok(!controller.multiSelectedWireIds.includes(straddling.id));

  controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Delete" }),
  );
  assert.deepEqual(
    doc.wires.map((w) => w.id),
    [straddling.id],
    "only the fully-enclosed wire went",
  );
});

test("one marquee mixes parts and wires; Delete clears both at once", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  const wire = doc.addWire({ from: "bb1.a6", to: "bb1.a9" }); // y 12

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  marquee(viewport, world, { x: 4, y: 4 }, { x: 12, y: 13 });
  assert.deepEqual(controller.multiSelectedIds, [chip.id]);
  assert.deepEqual(controller.multiSelectedWireIds, [wire.id]);

  changes = 0;
  controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Delete" }),
  );
  assert.equal(doc.components.length, 0);
  assert.equal(doc.wires.length, 0);
  assert.equal(changes, 1, "one batched doc-changed for parts + wires");
});

test("the marquee shows a crosshair for the duration of the drag", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport } = makeDesk(doc, world);

  const send = (type, shiftKey = true) =>
    viewport.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId: 9,
        shiftKey,
        clientX: 0,
        clientY: 0,
      }),
    );

  send("pointerdown");
  assert.ok(viewport.classList.contains("desk-viewport--selecting"));

  send("pointermove");
  assert.ok(viewport.classList.contains("desk-viewport--selecting"));

  send("pointerup");
  assert.ok(!viewport.classList.contains("desk-viewport--selecting"), "reset");
});

test("Escape clears a marquee selection", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addComponentAt("74LS00", "bb1", "e5");

  marquee(viewport, world, { x: 4, y: 4 }, { x: 12, y: 9 });
  assert.equal(controller.multiSelectedIds.length, 1);
  controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Escape" }),
  );
  assert.deepEqual(controller.multiSelectedIds, []);
});

// ── Additive selection (⌘/Ctrl-click) ─────────────────────────────────────
//
// `window.chiphippo.platform` is unset under the test harness, so the desk
// answers to Ctrl here — the ⌘ half of the split is pinned by the pure
// predicate's own suite (selection-toggle.test.js).

/** Modifier-click an element: the press (parts, boards) and the click (wires,
    bus bands) both carry the chord, so one helper covers every target. */
function toggleClick(el, { pointerId = 21 } = {}) {
  for (const type of ["pointerdown", "click"]) {
    el.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId,
        ctrlKey: true,
        clientX: 0,
        clientY: 0,
      }),
    );
  }
}

test("Ctrl-click adds a part to the selection and takes it back out", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const a = controller.addComponentAt("74LS00", "bb1", "e5");
  const b = controller.addComponentAt("74LS04", "bb1", "e20");

  controller.selectComponent(a.id);
  assert.equal(controller.selectedId, a.id);

  // The single pick is what the chord EXTENDS — it has to end up in the set.
  toggleClick(partEl(surface, b.id));
  assert.deepEqual(controller.multiSelectedIds.sort(), [a.id, b.id].sort());
  assert.equal(controller.selectedId, null);

  // Clicked again it leaves, and the one item left COLLAPSES back to the
  // ordinary single pick — so R, Properties… and the Option hint still work.
  toggleClick(partEl(surface, b.id));
  assert.deepEqual(controller.multiSelectedIds, []);
  assert.equal(controller.selectedId, a.id);

  // The last one out leaves nothing selected at all.
  toggleClick(partEl(surface, a.id));
  assert.equal(controller.selectedId, null);
  assert.deepEqual(controller.multiSelectedIds, []);
});

test("Ctrl-clicking a part starts no drag — the press is the whole gesture", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const el = partEl(surface, chip.id);

  world.x = 8;
  world.y = 6.5;
  controller.deselect(); // addComponentAt selects what it placed
  toggleClick(el);
  assert.equal(controller.selectedId, chip.id); // one item → the single pick

  // A move + release with no drag in flight must leave the seat alone.
  world.x = 20;
  for (const type of ["pointermove", "pointerup"]) {
    el.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        button: 0,
        pointerId: 21,
        clientX: 200,
        clientY: 0,
      }),
    );
  }
  assert.equal(doc.getComponent(chip.id).anchor, "e5");
});

test("Ctrl-clicking one strip of a kit toggles the WHOLE snapped group", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  const kit = controller.addKitAt("full", 0, 0);
  const ids = kit.map((b) => b.id);
  assert.equal(ids.length, 3);
  controller.deselect(); // addKitAt selects the pin-board

  toggleClick(surface.querySelector(`[data-board-id="${ids[1]}"]`));
  assert.deepEqual(controller.multiSelectedBoardIds.sort(), [...ids].sort());

  toggleClick(surface.querySelector(`[data-board-id="${ids[1]}"]`));
  assert.deepEqual(controller.multiSelectedBoardIds, []);
  assert.equal(controller.selectedId, null);
});

test("Ctrl-click adds a wire, and a bus adds every member wire", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const loose = doc.addWire({ from: "bb1.a6", to: "bb1.a9" });
  const m0 = doc.addWire({ from: "bb1.b6", to: "bb1.b9" });
  const m1 = doc.addWire({ from: "bb1.c6", to: "bb1.c9" });
  const bus = doc.addBus("D[1:0]", [m0.id, m1.id]);
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed")); // draw

  toggleClick(surface.querySelector(`.wire[data-wire-id="${loose.id}"]`));
  assert.equal(controller.selectedId, loose.id); // one item → the single pick

  // A bus is metadata over wires, so it joins as its MEMBERS — the selection
  // has no bus set of its own, and the wires are what a delete would act on.
  toggleClick(surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`));
  assert.deepEqual(
    controller.multiSelectedWireIds.sort(),
    [loose.id, m0.id, m1.id].sort(),
  );

  toggleClick(surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`));
  assert.deepEqual(controller.multiSelectedWireIds, []);
  assert.equal(controller.selectedId, loose.id);
});

test("Ctrl-click on empty desk keeps the selection — a plain click clears it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { viewport, surface, controller } = makeDesk(doc);
  const a = controller.addComponentAt("74LS00", "bb1", "e5");
  const b = controller.addComponentAt("74LS04", "bb1", "e20");
  controller.selectComponent(a.id);
  toggleClick(partEl(surface, b.id));
  const both = [a.id, b.id].sort();
  assert.deepEqual(controller.multiSelectedIds.sort(), both);

  // An ADD that landed on nothing has nothing to add — which is not the same
  // as being asked to clear the selection.
  toggleClick(viewport);
  assert.deepEqual(controller.multiSelectedIds.sort(), both);

  pointerAt(viewport, "pointerdown", 0, 0);
  assert.deepEqual(controller.multiSelectedIds, []);
  assert.equal(controller.selectedId, null);
});

test("Ctrl-click is refused while the circuit runs, as the marquee is", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  controller.deselect(); // addComponentAt selects what it placed

  controller.setEditingLocked(true);
  toggleClick(partEl(surface, chip.id));
  assert.deepEqual(controller.multiSelectedIds, []);
  assert.equal(controller.selectedId, null);
});

test("every resistor renders as a span; rotateComponent swings the lead", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const r = controller.addComponentAt("resistor", "bb1", "e10"); // e10 ── e13

  // Even the horizontal form draws as a centred, angled span.
  const leadLine = () => surface.querySelector(".part-span-lead");
  assert.ok(surface.querySelector(".part-discrete-svg--rotated"));
  assert.equal(leadLine().getAttribute("x2"), "3"); // 3 units along +x
  assert.equal(leadLine().getAttribute("y2"), "0");

  controller.rotateComponent(r.id);
  assert.equal(doc.getComponent(r.id).params.rot, 90);
  // Now the lead runs 3 units down instead — same length, new angle.
  assert.equal(leadLine().getAttribute("x2"), "0");
  assert.equal(leadLine().getAttribute("y2"), "3");
});

/** Dispatch a pointer event at a client point on a part's element. */
function pointerAt(el, type, x, y, mods = {}) {
  el.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
      ...mods,
    }),
  );
}

const partEl = (surface, id) =>
  surface.querySelector(`[data-component-id="${id}"]`);

const boardEl = (surface, id) =>
  surface.querySelector(`[data-board-id="${id}"]`);

/** The ids currently lit as the set a grab will move. */
const dragSetIds = (surface) =>
  [...surface.querySelectorAll(".board--drag-set")].map(
    (b) => b.dataset.boardId,
  );

/** Grab `id`, slide the desk to (wx, wy), release. `mods` picks the chain. */
function dragBoard(surface, world, id, wx, wy, mods = {}) {
  const el = boardEl(surface, id);
  pointerAt(el, "pointerdown", 0, 0, mods);
  const lit = dragSetIds(surface); // captured mid-gesture, before release
  world.x = wx;
  world.y = wy;
  pointerAt(el, "pointermove", 40, 40, mods);
  pointerAt(el, "pointerup", 40, 40, mods);
  return lit;
}

test("a plain board grab lights and moves the whole snapped unit", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins@3.70 · bb3 @17.72

  const lit = dragBoard(surface, world, "bb2", 0, 30);
  assert.deepEqual(lit, ["bb1", "bb2", "bb3"]);
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y, b.group]),
    [
      ["bb1", 30, "g1"],
      ["bb2", q(PINS_Y + 30), "g1"],
      ["bb3", q(LOW_RAIL_Y + 30), "g1"],
    ],
  );
  assert.deepEqual(dragSetIds(surface), []); // the highlight clears on release
});

/** Every boundary point of the selection highlighter, in world px. */
function outlinePoints(surface) {
  const path = surface.querySelector(".board-outline-path");
  const d = path?.getAttribute("d") ?? "";
  const points = [];
  // Line/move targets, plus each arc's endpoint (the arc radii are skipped).
  const re =
    /[ML] (-?[\d.]+) (-?[\d.]+)|A [\d.]+ [\d.]+ 0 0 [01] (-?[\d.]+) (-?[\d.]+)/g;
  for (const m of d.matchAll(re)) {
    points.push({ x: Number(m[1] ?? m[3]), y: Number(m[2] ?? m[4]) });
  }
  return points;
}

/** The highlighter's extent (world px), or null when it is hidden. */
function outlineBox(surface) {
  const svg = surface.querySelector(".board-outline");
  if (!svg || svg.hidden) return null;
  const points = outlinePoints(surface);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/** The world-px extent of `ids`, grown by the highlighter's margin. */
/** Board geometry is fractional now, so a box derived two ways can differ in
    the last bit of a double. Compare at a thousandth of a pixel — far finer
    than anything drawn, far coarser than float noise. */
function boxNear(got, want, what = "outline") {
  assert.ok(got, `${what}: no box`);
  for (const k of ["x", "y", "right", "bottom"]) {
    assert.ok(
      Math.abs(got[k] - want[k]) < 1e-3,
      `${what}.${k}: ${got[k]} vs ${want[k]}`,
    );
  }
}

function expectedBox(doc, ids) {
  const boxes = ids.map((id) => {
    const b = doc.getBoard(id);
    const s = spec(b.type);
    return {
      x: b.x * PX_PER_UNIT - OUTLINE_MARGIN,
      y: b.y * PX_PER_UNIT - OUTLINE_MARGIN,
      right: (b.x + s.width) * PX_PER_UNIT + OUTLINE_MARGIN,
      bottom: (b.y + s.height) * PX_PER_UNIT + OUTLINE_MARGIN,
    };
  });
  return {
    x: Math.min(...boxes.map((b) => b.x)),
    y: Math.min(...boxes.map((b) => b.y)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

test("selecting one strip highlights the whole snapped set's outer edge", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  assert.equal(outlineBox(surface), null); // nothing selected, nothing drawn

  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16
  controller.selectBoard("bb2"); // the centre pin-board alone

  // The highlighter spans all three strips, not just the one picked.
  assert.deepEqual(
    outlineBox(surface),
    expectedBox(doc, ["bb1", "bb2", "bb3"]),
  );

  controller.deselect();
  assert.equal(outlineBox(surface), null);
});

test("a loose strip is highlighted on its own", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addKitAt("full", 0, 0);
  controller.addBoardAt("pins-tiny", 0, 40); // clear of the kit, ungrouped

  boxNear(outlineBox(surface), expectedBox(doc, ["bb4"]));
});

test("an Option grab re-traces the highlighter around the torn-off run", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0);

  // Mid-gesture: the set is bb2 + bb3, so the top rail is outside the edge.
  const el = boardEl(surface, "bb2");
  pointerAt(el, "pointerdown", 0, 0, { altKey: true });
  boxNear(outlineBox(surface), expectedBox(doc, ["bb2", "bb3"]));
  pointerAt(el, "pointerup", 0, 0, { altKey: true });
});

test("a board dropped beside another is pulled flush and mates with it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0); // bb1 spans x 0…18
  controller.addBoardAt("pins-tiny", 30, 0); // bb2, well clear of it

  // Dropped at x = 20 — two pitch shy of flush, inside the magnet's reach.
  dragBoard(surface, world, "bb2", -10, 0);
  assert.equal(doc.getBoard("bb2").x, 18); // pulled the rest of the way
  assert.deepEqual(
    doc.groupMembers("bb1").map((b) => b.id),
    ["bb1", "bb2"], // …and they drag as one unit from here on
  );
});

test("a board dropped out of reach keeps its position and stays loose", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0);
  controller.addBoardAt("pins-tiny", 40, 0);

  dragBoard(surface, world, "bb2", -18, 0); // lands at x = 22: four pitch shy
  assert.equal(doc.getBoard("bb2").x, 22); // exactly where it was dropped
  assert.equal(doc.getBoard("bb2").group, null);
});

test("strips that do not match across the edge never snap together", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0); // 64 wide, spans y 0…14.02
  controller.addBoardAt("rail-half", 0, 20); // only 31 wide

  // Dropped one pitch under the full board: flush would be y = 14.02, but a
  // half-width rail does not dovetail onto a full-width board at all.
  dragBoard(surface, world, "bb2", 0, -5);
  assert.equal(doc.getBoard("bb2").y, 15);
  assert.equal(doc.getBoard("bb2").group, null);
});

test("a whole kit dropped against another board mates, all six strips", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1…bb3, spanning y 0…21.42
  controller.addKitAt("full", 0, 30); // bb4…bb6, clear below it

  // Grab the second kit's pin-board and drop the kit two pitch shy of flush.
  dragBoard(surface, world, "bb5", 0, -7);
  assert.deepEqual(
    doc.boards.map((b) => b.y),
    // the second kit pulled up onto the first
    [0, PINS_Y, LOW_RAIL_Y, KIT_H, q(KIT_H + PINS_Y), q(KIT_H + LOW_RAIL_Y)],
  );
  assert.equal(new Set(doc.boards.map((b) => b.group)).size, 1);
  assert.equal(doc.groupMembers("bb1").length, 6);
});

test("placing a kit flush against a board mates it, exactly as a drop does", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  controller.addKitAt("full", 0, 0);
  controller.addKitAt("full", 0, KIT_H); // seated on the first kit's bottom edge // prettier-ignore

  assert.equal(doc.groupMembers("bb1").length, 6);
});

test("Option-drag takes the run BELOW the grab and tears off the rest", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins@3.70 · bb3 @17.72

  const lit = dragBoard(surface, world, "bb2", 0, 30, { altKey: true });
  assert.deepEqual(lit, ["bb2", "bb3"]); // the top rail is not in the set
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y]),
    [
      ["bb1", 0], // left exactly where it was
      ["bb2", q(PINS_Y + 30)],
      ["bb3", q(LOW_RAIL_Y + 30)],
    ],
  );
  // The snap is broken: the pair that travelled is its own unit now, and the
  // rail left behind is loose.
  assert.equal(doc.getBoard("bb1").group, null);
  assert.deepEqual(
    doc.groupMembers("bb2").map((b) => b.id),
    ["bb2", "bb3"],
  );
});

test("Option+Shift-drag takes the run ABOVE the grab instead", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0);

  const lit = dragBoard(surface, world, "bb2", 0, -30, {
    altKey: true,
    shiftKey: true,
  });
  assert.deepEqual(lit, ["bb1", "bb2"]);
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y]),
    [
      ["bb1", -30],
      ["bb2", q(PINS_Y - 30)],
      ["bb3", LOW_RAIL_Y], // the bottom rail stays put
    ],
  );
  assert.equal(doc.getBoard("bb3").group, null);
});

test("Shift alone on a board still falls through to the marquee", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0);

  const lit = dragBoard(surface, world, "bb2", 0, 30, { shiftKey: true });
  assert.deepEqual(lit, []); // no drag set — the board was never grabbed
  assert.deepEqual(
    doc.boards.map((b) => b.y),
    [0, PINS_Y, LOW_RAIL_Y], // nothing moved
  );
});

test("an Option-drag that lands illegally reverts and keeps the snap", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1..bb3, spans y 0…21.42
  controller.addKitAt("full", 0, 24); // bb4..bb6, spans y 24…45.42

  // Push the bottom run down onto the second board — no room, so nothing
  // commits and the group must survive intact.
  dragBoard(surface, world, "bb2", 0, 8, { altKey: true });
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y, b.group]),
    [
      ["bb1", 0, "g1"],
      ["bb2", PINS_Y, "g1"],
      ["bb3", LOW_RAIL_Y, "g1"],
      ["bb4", 24, "g2"],
      ["bb5", q(24 + PINS_Y), "g2"],
      ["bb6", q(24 + LOW_RAIL_Y), "g2"],
    ],
  );
});

test("dragging a resistor commits a legal drop (both ends translate rigidly)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "e10"); // e10 ── e13

  const el = partEl(surface, r.id);
  pointerAt(el, "pointerdown", 0, 0); // grab (world 0,0)
  world.x = 2; // cursor slid +2 pitch units right
  pointerAt(el, "pointermove", 50, 0); // past the 4 px threshold
  pointerAt(el, "pointerup", 50, 0);

  // Both ends shifted by the SAME delta — the bend is untouched, so length
  // and angle are preserved and the pair still spans e12 ── e15.
  const comp = doc.getComponent(r.id);
  assert.equal(comp.anchor, "e12");
  assert.deepEqual(comp.params.end, { dx: 3, dy: 0 });
  assert.deepEqual(partPinAddresses(doc, comp), [
    { pin: 1, address: "bb1.e12" },
    { pin: 2, address: "bb1.e15" },
  ]);
});

test("a resistor can be dragged onto another board (both ends must share it)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("pins-full", 0, 30); // bb2, directly below
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "e10");

  const el = partEl(surface, r.id);
  pointerAt(el, "pointerdown", 0, 0);
  world.y = 30; // slide the whole resistor down onto bb2
  pointerAt(el, "pointermove", 0, 60);
  pointerAt(el, "pointerup", 0, 60);

  const comp = doc.getComponent(r.id);
  assert.equal(comp.board, "bb2");
  assert.equal(comp.anchor, "e10");
  assert.deepEqual(comp.params.end, { dx: 3, dy: 0 });
});

test("a resistor dropped in an illegal position returns to its origin", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "e10");

  const el = partEl(surface, r.id);
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 500; // dragged far off every board — no holes under either end
  world.y = 500;
  pointerAt(el, "pointermove", 80, 80);
  pointerAt(el, "pointerup", 80, 80);

  // The document is untouched and the view is redrawn where it started.
  const comp = doc.getComponent(r.id);
  assert.equal(comp.anchor, "e10");
  assert.equal(comp.params.rot, 0); // still the original horizontal form
  assert.ok(partEl(surface, r.id), "the resistor is still mounted");
});

test("dragging ONE end reaches a NEIGHBOURING strip's rail; the other stays put", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("rail-full", 0, -RAIL_H); // bb2 — a rail flush above the board
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  // Pin 1 at a10 (row a, column 10); pin 2 at a13.
  const r = controller.addComponentAt("resistor", "bb1", "a10");

  const el = partEl(surface, r.id);
  // Grab pin 2's lead (a13 sits at world 13, 12), then haul it clear off this
  // strip onto the rail above — a span the fixed-length whole-drag could
  // never reach, and a hole this part is not even seated on.
  world.x = 13;
  world.y = ROW.a;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 10; // the `-` rail's hole 7 sits in this column
  world.y = railRowY(-RAIL_H, "-");
  pointerAt(el, "pointermove", 40, 40);
  pointerAt(el, "pointerup", 40, 40);

  const comp = doc.getComponent(r.id);
  assert.equal(comp.board, "bb1"); // still SEATED on the pin-board…
  assert.equal(comp.anchor, "a10"); // …and the untouched end never moved
  assert.equal(comp.params.rot, 90);
  // …while the lead is stored as a bend, and resolves onto the other strip.
  assert.deepEqual(comp.params.end, {
    dx: 0,
    dy: q(railRowY(-RAIL_H, "-") - ROW.a),
  });
  assert.deepEqual(partPinAddresses(doc, comp), [
    { pin: 1, address: "bb1.a10" },
    { pin: 2, address: "bb2.-7" },
  ]);
});

test("an end dropped closer than the minimum lead span springs back", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "a10"); // a10 ── a13

  const el = partEl(surface, r.id);
  world.x = 13; // grab pin 2
  world.y = ROW.a;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 11; // only 1 hole from pin 1 — inside the 3-unit minimum
  world.y = ROW.a;
  pointerAt(el, "pointermove", 40, 0);
  pointerAt(el, "pointerup", 40, 0);

  // Rejected: the document still describes the original horizontal resistor.
  const comp = doc.getComponent(r.id);
  assert.equal(comp.anchor, "a10");
  assert.equal(comp.params.rot, 0);
  assert.equal(comp.params.end, null);
});

test("an LED rotates and drags an end like a resistor", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("rail-full", 0, -RAIL_H); // bb2 — a rail flush above the board
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  // Pin 1 (anode) at a10; pin 2 (cathode) alongside at a11.
  const led = controller.addComponentAt("led", "bb1", "a10", {
    color: "green",
  });
  // It renders as a centred, angled span — dome included.
  assert.ok(surface.querySelector(".part-led-dome--green"));
  assert.ok(surface.querySelector(".part-span-lead"));

  // R rotates it in place, swinging the cathode's lead into the column. Row a
  // is the bottom row, so the CW swing lands off the strip and the CCW one
  // wins: one unit UP, to b10.
  controller.rotateComponent(led.id);
  const moved = doc.getComponent(led.id);
  assert.equal(moved.params.rot, 90);
  assert.deepEqual(moved.params.end, { dx: 0, dy: -1 });

  // Drag the cathode end up onto the rail strip.
  const el = partEl(surface, led.id);
  world.x = 10; // grab pin 2 (same column, one row up from a10 → world y 11)
  world.y = ROW.b;
  pointerAt(el, "pointerdown", 0, 0);
  world.y = railRowY(-RAIL_H, "-"); // the rail strip's `-` rail
  pointerAt(el, "pointermove", 0, 60);
  pointerAt(el, "pointerup", 0, 60);

  const after = doc.getComponent(led.id);
  assert.equal(after.board, "bb1"); // seated here, only REACHING the rail
  assert.equal(after.anchor, "a10"); // the anode never moved
  assert.deepEqual(after.params.end, {
    dx: 0,
    dy: q(railRowY(-RAIL_H, "-") - ROW.a),
  });
  assert.deepEqual(partPinAddresses(doc, after), [
    { pin: 1, address: "bb1.a10" },
    { pin: 2, address: "bb2.-7" },
  ]);
  // Colour/polarity survive the move.
  assert.equal(after.params.color, "green");
});

test("an LED's legs may sit side by side (no gap required)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const led = controller.addComponentAt("led", "bb1", "a10", { color: "red" });

  // Drag the cathode from a11 to the ADJACENT hole in the row above (b10) —
  // one pitch unit away, which an LED allows but a resistor would reject.
  const el = partEl(surface, led.id);
  world.x = 11;
  world.y = ROW.a;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 10;
  world.y = ROW.b; // b10 — adjacent to the anode at a10
  pointerAt(el, "pointermove", 40, 40);
  pointerAt(el, "pointerup", 40, 40);

  const after = doc.getComponent(led.id);
  assert.equal(after.anchor, "a10");
  assert.deepEqual(after.params.end, { dx: 0, dy: -1 }); // one hole away, b10
  assert.deepEqual(partPinAddresses(doc, after), [
    { pin: 1, address: "bb1.a10" },
    { pin: 2, address: "bb1.b10" },
  ]);
  // The same 1-unit span is illegal for a resistor (minSpan 3).
  assert.equal(
    doc.canPlacePart("resistor", "bb1", "j10", {
      params: { rot: 90, end: { dx: 0, dy: 1 } },
    }),
    false,
  );
});

test("R rotates a resistor freely mid-drag; the release commits it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "e10"); // e10 ── e13

  const el = partEl(surface, r.id);
  pointerAt(el, "pointerdown", 0, 0);
  // Rotate 90° while holding — no cursor travel needed.
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));
  pointerAt(el, "pointerup", 0, 0);

  // Pin 1 stayed; pin 2's lead swung into the same column three rows down.
  const comp = doc.getComponent(r.id);
  assert.equal(comp.anchor, "e10");
  assert.equal(comp.params.rot, 90);
  assert.deepEqual(comp.params.end, { dx: 0, dy: 3 });
  assert.deepEqual(partPinAddresses(doc, comp), [
    { pin: 1, address: "bb1.e10" },
    { pin: 2, address: "bb1.b10" },
  ]);
});

test("R during a non-rotatable part's drag does nothing and keeps the drag", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  // A push button neither rotates nor flips.
  const btn = controller.addComponentAt("sw-push", "bb1", "a10");

  const el = partEl(surface, btn.id);
  world.y = ROW.a; // row a
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 2;
  pointerAt(el, "pointermove", 50, 0);

  // R is swallowed — nothing rotates, and the element is NOT remounted.
  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "r" }),
  );
  assert.equal(consumed, false, "R not consumed for a non-rotatable part");
  assert.equal(partEl(surface, btn.id), el, "same element — drag intact");

  // The drag still completes normally.
  pointerAt(el, "pointerup", 50, 0);
  assert.equal(doc.getComponent(btn.id).anchor, "a12");
});

test("R while placing rotates the ghost and KEEPS the placement armed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 10, y: 12 }; // over hole a10
  const { surface, controller } = makeDesk(doc, world);

  controller.armPartPlacement("resistor");
  const move = () =>
    surface.dispatchEvent(
      new window.PointerEvent("pointermove", { bubbles: true, clientX: 1 }),
    );
  // The viewport owns pointermove; dispatch through it.
  const track = () => controller.onViewportChange?.() ?? move();
  track();

  const ghost = () => surface.querySelector(".part-ghost");
  assert.ok(controller.placementArmed, "armed");
  const R = () =>
    controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));

  assert.equal(R(), true, "R consumed");
  assert.ok(controller.placementArmed, "STILL armed — not cancelled");
  assert.ok(ghost(), "the ghost survives the rotation");
});

test("a ghost rotated with R places in the two-ends form", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("rail-full", 0, PINS_H); // bb2 — a rail flush below the board
  const world = { x: 10, y: ROW.a }; // hole a10
  const { viewport, controller } = makeDesk(doc, world);

  controller.armPartPlacement("resistor");
  viewport.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true }),
  );
  // One quarter turn: the span runs DOWN the column instead of along the row.
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));
  assert.ok(controller.placementArmed);

  // Click to drop it (pointerdown primes the click-vs-pan check).
  viewport.dispatchEvent(
    new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  const placed = doc.components[0];
  assert.ok(placed, "a resistor landed");
  assert.equal(placed.board, "bb1"); // seated on the pin-board it was over
  assert.equal(placed.anchor, "a10"); // pin 1 under the cursor
  assert.equal(placed.params.rot, 90);
  // The lead bends 3 units below row a (world y 12 → 15), which lands on the
  // NEIGHBOURING rail strip's + rail, right in the column: exactly the
  // pull-down arrangement, straight off the ghost.
  assert.deepEqual(placed.params.end, { dx: 0, dy: 3 });
  assert.deepEqual(partPinAddresses(doc, placed), [
    { pin: 1, address: "bb1.a10" },
    { pin: 2, address: "bb2.+7" },
  ]);
});

test("R flips a chip 180°: same holes, pin numbering reversed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // auto-selected
  const holesOf = () =>
    partPinHoles("74LS00", "e5", doc.getComponent(chip.id).params);

  // Unflipped: pin 1 bottom-left (e5), pin 14 top-left (f5).
  assert.equal(holesOf().find((p) => p.pin === 1).hole, "e5");
  assert.equal(holesOf().find((p) => p.pin === 14).hole, "f5");

  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "r" }),
  );
  assert.equal(consumed, true);
  assert.equal(doc.getComponent(chip.id).params.rot, 180);

  // Flipped: pin 1 swaps to the far corner; the SET of holes is unchanged.
  assert.equal(holesOf().find((p) => p.pin === 1).hole, "f11");
  assert.equal(holesOf().find((p) => p.pin === 8).hole, "e5");
  assert.deepEqual(
    holesOf()
      .map((p) => p.hole)
      .sort(),
    partPinHoles("74LS00", "e5")
      .map((p) => p.hole)
      .sort(),
    "occupies exactly the same holes",
  );

  // Flipping again returns it to the original orientation.
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));
  assert.equal(doc.getComponent(chip.id).params.rot, undefined);
  assert.equal(holesOf().find((p) => p.pin === 1).hole, "e5");
});

test("R flips bar8iso 180°, same as a chip: same holes, pin numbering reversed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc);
  const bar = controller.addComponentAt("bar8iso", "bb1", "e5"); // auto-selected
  const holesOf = () =>
    partPinHoles("bar8iso", "e5", doc.getComponent(bar.id).params);

  // Unflipped: pin 1 (A1) bottom-left (e5), pin 16 (K1) top-left (f5).
  assert.equal(holesOf().find((p) => p.pin === 1).hole, "e5");
  assert.equal(holesOf().find((p) => p.pin === 16).hole, "f5");

  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "r" }),
  );
  assert.equal(consumed, true);
  assert.equal(doc.getComponent(bar.id).params.rot, 180);

  // Flipped: pin 1 swaps to the far corner (pin 9's old hole); the SET of
  // holes is unchanged — a bar8iso flip never fails to fit.
  assert.equal(holesOf().find((p) => p.pin === 1).hole, "f12");
  assert.equal(holesOf().find((p) => p.pin === 9).hole, "e5");
  assert.deepEqual(
    holesOf()
      .map((p) => p.hole)
      .sort(),
    partPinHoles("bar8iso", "e5")
      .map((p) => p.hole)
      .sort(),
    "occupies exactly the same holes",
  );

  // Flipping again returns it to the original orientation.
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));
  assert.equal(doc.getComponent(bar.id).params.rot, undefined);
  assert.equal(holesOf().find((p) => p.pin === 1).hole, "e5");
});

test("R flips a DIP switch bank 180°, same as a chip", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc);
  const bank = controller.addComponentAt("sw-dip4", "bb1", "e5"); // auto-selected
  const holesOf = () =>
    partPinHoles("sw-dip4", "e5", doc.getComponent(bank.id).params);

  assert.equal(holesOf().find((p) => p.pin === 1).hole, "e5");
  assert.equal(
    controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" })),
    true,
  );
  assert.equal(doc.getComponent(bank.id).params.rot, 180);
  // Same holes occupied, pin numbering reversed (bar8iso's half-lap flip).
  assert.deepEqual(
    holesOf()
      .map((p) => p.hole)
      .sort(),
    partPinHoles("sw-dip4", "e5")
      .map((p) => p.hole)
      .sort(),
  );
});

test("clicking a DIP switch bank's actuator toggles only that position", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  const bank = controller.addComponentAt("sw-dip4", "bb1", "e5");

  const el = partEl(surface, bank.id);
  const actuator = (i) => el.querySelector(`[data-switch-index="${i}"]`);

  pointerAt(actuator(2), "pointerdown", 0, 0);
  pointerAt(actuator(2), "pointerup", 0, 0);
  assert.deepEqual(doc.getComponent(bank.id).params.states, [
    false,
    false,
    true,
    false,
  ]);

  // Click again: flips back off.
  pointerAt(actuator(2), "pointerdown", 0, 0);
  pointerAt(actuator(2), "pointerup", 0, 0);
  assert.deepEqual(doc.getComponent(bank.id).params.states, [
    false,
    false,
    false,
    false,
  ]);

  // A press that never leaves the body (no data-switch-index ancestor)
  // selects/drags the package but changes no position.
  pointerAt(actuator(1), "pointerdown", 0, 0);
  pointerAt(actuator(1), "pointerup", 0, 0);
  const bodyHit = el.querySelector(".part-body");
  pointerAt(bodyHit, "pointerdown", 0, 0);
  pointerAt(bodyHit, "pointerup", 0, 0);
  assert.deepEqual(doc.getComponent(bank.id).params.states, [
    false,
    true,
    false,
    false,
  ]);
});

test("a chip flipped mid-drag commits the flip with the move", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("74LS00", "bb1", "e10");

  const el = partEl(surface, chip.id);
  world.y = 6.5; // a chip only seats near the trench
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 2;
  pointerAt(el, "pointermove", 50, 0);
  assert.equal(
    controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" })),
    true,
    "R is consumed for a chip",
  );
  pointerAt(el, "pointerup", 50, 0);

  const after = doc.getComponent(chip.id);
  assert.equal(after.anchor, "e12", "moved");
  assert.equal(after.params.rot, 180, "and flipped");
});

test("R during a resistor END drag is a no-op, not a rotate-behind-the-drag", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "a10"); // a10 ── a13

  const el = partEl(surface, r.id);
  world.x = 13; // grab pin 2's lead
  world.y = ROW.a;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 16;
  pointerAt(el, "pointermove", 40, 0);

  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "r" }),
  );
  assert.equal(consumed, false);
  assert.equal(partEl(surface, r.id), el, "same element — drag intact");

  // Releasing still commits the end move, unrotated.
  pointerAt(el, "pointerup", 40, 0);
  const after = doc.getComponent(r.id);
  assert.equal(after.anchor, "a10"); // the anchored lead never moved
  assert.deepEqual(after.params.end, { dx: 6, dy: 0 }); // a16
});

test("R during a marquee drag leaves the selected part alone", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "a10"); // auto-selected
  assert.equal(doc.getComponent(r.id).params.rot, 0);

  // Start a marquee, then press R mid-drag.
  world.x = 40;
  world.y = ROW.i;
  viewport.dispatchEvent(
    new window.PointerEvent("pointerdown", {
      bubbles: true,
      button: 0,
      pointerId: 3,
      shiftKey: true,
      clientX: 0,
      clientY: 0,
    }),
  );
  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "r" }),
  );
  assert.equal(consumed, false);
  assert.equal(doc.getComponent(r.id).params.rot, 0, "not rotated behind it");
});

test("W during a board drag is inert, and the drag still commits cleanly", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const board = doc.addBoard("pins-full", 0, 0); // y=0
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);

  const el = boardEl(surface, board.id);
  pointerAt(el, "pointerdown", 0, 0); // grab at world (0,0)
  world.x = 0;
  world.y = 30;
  pointerAt(el, "pointermove", 40, 40);
  assert.deepEqual(dragSetIds(surface), [board.id], "drag set lit mid-gesture");

  // Press W mid-drag: it must NOT arm the wire tool (which would overwrite
  // #mode and make the pending pointerup bail before committing + cleaning up).
  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "w" }),
  );
  assert.equal(consumed, false, "W is inert mid-drag");
  assert.deepEqual(dragSetIds(surface), [board.id], "drag still intact");

  // Releasing commits the move and clears the highlight — proving #mode was a
  // live "drag" at pointerup, not clobbered to "wire".
  pointerAt(el, "pointerup", 40, 40);
  assert.equal(
    doc.boards.find((b) => b.id === board.id).y,
    30,
    "drag committed",
  );
  assert.deepEqual(dragSetIds(surface), [], "clean teardown, no stuck set");
});

test("a board drag interrupted by Run reverts instead of committing", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const board = doc.addBoard("pins-full", 0, 0); // y=0
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);

  const el = boardEl(surface, board.id);
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 0;
  world.y = 30;
  pointerAt(el, "pointermove", 40, 40);

  // Run starts mid-drag (Space → sim.toggle + setEditingLocked): editing freezes.
  controller.setEditingLocked(true);

  // Releasing must NOT commit the move into the frozen/running state — the
  // board snaps back to y=0 and the highlight clears cleanly.
  pointerAt(el, "pointerup", 40, 40);
  assert.equal(
    doc.boards.find((b) => b.id === board.id).y,
    0,
    "in-flight move reverted; no topology mutation while frozen",
  );
  assert.deepEqual(dragSetIds(surface), [], "clean teardown");
});

test("R rotates the selected resistor via handleKeyDown", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc);
  const r = controller.addComponentAt("resistor", "bb1", "e10"); // auto-selected
  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "r" }),
  );
  assert.equal(consumed, true);
  assert.equal(doc.getComponent(r.id).params.rot, 90);
});

test("R stands a rail on end while placing, and the placed strip stays upright", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 20, y: 20 };
  const { surface, controller } = makeDesk(doc, world);

  controller.armPlacement("rail-full");
  const move = () =>
    surface.dispatchEvent(
      new window.PointerEvent("pointermove", { bubbles: true, clientX: 1 }),
    );
  move();
  const R = () =>
    controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));

  const ghost = () => surface.querySelector(".board-ghost");
  // Flat to begin with: 64 wide, 3.70 tall (9.4 mm of plastic).
  assert.equal(ghost().style.width, `${64 * PX_PER_UNIT}px`);

  assert.equal(R(), true, "R consumed");
  assert.ok(controller.placementArmed, "STILL armed — rotating is not placing");
  // Turned: the ghost is now tall and thin, and its strip carries the spin.
  assert.equal(ghost().style.width, `${RAIL_H * PX_PER_UNIT}px`);
  assert.equal(ghost().style.height, `${64 * PX_PER_UNIT}px`);
  assert.match(
    ghost().querySelector(".board-ghost-strip").style.transform,
    /rotate\(90deg\)/,
  );

  const [rail] = controller.addKitAt("rail-full", 5, 5, 90);
  assert.equal(rail.rot, 90);
  assert.match(
    boardEl(surface, rail.id).style.transform,
    /rotate\(90deg\)/,
    "the placed strip renders turned",
  );
});

test("R does nothing to an assembled kit — it holds a pin-board", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc, { x: 20, y: 20 });

  controller.armPlacement("full");
  surface.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true, clientX: 1 }),
  );
  const before = surface.querySelector(".board-ghost").style.width;
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));
  assert.equal(surface.querySelector(".board-ghost").style.width, before);
  // …and the document refuses the rotation even if asked directly.
  assert.equal(controller.addKitAt("full", 0, 0, 90)[0].rot, 0);
});

test("an upright rail resolves its holes down the desk, and wires reach them", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  const [rail] = controller.addKitAt("rail-full", 10, 0, 90);

  // Hole +1 near the top, +50 far down it — a bus running past a board.
  const top = worldOfAddress(doc.boards, `${rail.id}.+1`);
  const bottom = worldOfAddress(doc.boards, `${rail.id}.+50`);
  assert.equal(top.x, bottom.x, "the rail runs straight down");
  assert.ok(bottom.y - top.y > 50, "and spans the strip's full length");
  // The same points hit-test back to their addresses.
  assert.equal(addressAtWorld(doc.boards, top.x, top.y), `${rail.id}.+1`);
  assert.equal(
    addressAtWorld(doc.boards, bottom.x, bottom.y),
    `${rail.id}.+50`,
  );
});

// ── Undo / redo (Feature 200) ──────────────────────────────────────────────

test("a single add is one undo step, reversed and replayed exactly", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  assert.equal(controller.canUndo, false); // a fresh baseline

  controller.addBoardAt("pins-tiny", 0, 0);
  assert.equal(doc.boards.length, 1);
  assert.equal(surface.querySelectorAll(".board").length, 1);
  assert.equal(controller.canUndo, true);
  assert.equal(controller.canRedo, false);

  // ONE undo empties the desk — the add was a single step, not many.
  assert.equal(controller.undo(), true);
  assert.equal(doc.boards.length, 0);
  assert.equal(surface.querySelectorAll(".board").length, 0);
  assert.equal(controller.canUndo, false);
  assert.equal(controller.canRedo, true);

  // Redo replays it, remounting the view from the restored document.
  assert.equal(controller.redo(), true);
  assert.equal(doc.boards.length, 1);
  assert.equal(surface.querySelectorAll(".board").length, 1);
});

test("a sequence of edits undoes/redoes to byte-identical documents", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);

  const empty = doc.toJSON();
  controller.addBoardAt("pins-full", 0, 0);
  const afterA = doc.toJSON();
  controller.addComponentAt("74LS00", "bb1", "e5");
  const afterB = doc.toJSON();

  controller.undo(); // back to afterA
  assert.deepEqual(doc.toJSON(), afterA);
  controller.undo(); // back to empty
  assert.deepEqual(doc.toJSON(), empty);
  assert.equal(controller.canUndo, false);

  controller.redo(); // forward to afterA
  assert.deepEqual(doc.toJSON(), afterA);
  controller.redo(); // forward to afterB
  assert.deepEqual(doc.toJSON(), afterB);
  assert.equal(controller.canRedo, false);
});

test("a new edit after undo drops the redo future", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  controller.addBoardAt("pins-tiny", 0, 0);
  controller.addBoardAt("pins-tiny", 0, 30);
  controller.undo(); // one board left
  assert.equal(controller.canRedo, true);
  controller.addBoardAt("pins-tiny", 0, 60); // a fresh branch
  assert.equal(controller.canRedo, false);
  assert.equal(doc.boards.length, 2);
});

test("undo restores through a full rebuild — selection is cleared", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addBoardAt("pins-full", 0, 0);
  controller.addComponentAt("74LS00", "bb1", "e5");
  assert.ok(controller.selectedId); // the add selected the new chip
  controller.undo(); // remove the chip
  assert.equal(controller.selectedId, null);
  assert.equal(surface.querySelectorAll(".chip").length, 0);
});

test("running freezes history; stopping restores it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  controller.addBoardAt("pins-tiny", 0, 0);
  assert.equal(controller.canUndo, true);

  // Enter Run: undo/redo are unavailable and edits don't record.
  controller.setEditingLocked(true);
  assert.equal(controller.canUndo, false);
  assert.equal(controller.canRedo, false);
  assert.equal(controller.undo(), false); // frozen — no-op

  // Stop: history is available again, right where it was.
  controller.setEditingLocked(false);
  assert.equal(controller.canUndo, true);
  assert.equal(controller.undo(), true);
  assert.equal(doc.boards.length, 0);
});

test("onHistoryChange fires with the current availability", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  const states = [];
  const controller = new DeskController({
    viewport,
    deskView,
    deskDoc: doc,
    onHistoryChange: (s) => states.push(s),
  });
  // Seeded at construction: nothing to undo yet.
  assert.deepEqual(states.at(-1), { canUndo: false, canRedo: false });
  controller.addBoardAt("pins-tiny", 0, 0);
  assert.deepEqual(states.at(-1), { canUndo: true, canRedo: false });
  controller.undo();
  assert.deepEqual(states.at(-1), { canUndo: false, canRedo: true });
});

test("Cmd+C on a marquee selection pastes the whole cluster onto clear holes", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  const a = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  const b = controller.addComponentAt("74LS04", "bb1", "e20"); // cols 20–26

  // Marquee both chips (rows f..e, columns 4..27).
  marquee(viewport, world, { x: 4, y: 4 }, { x: 27, y: 9 });
  assert.equal(controller.multiSelectedIds.length, 2);

  assert.equal(accelKey(controller, "c"), true);
  assert.equal(accelKey(controller, "v"), true);
  assert.ok(controller.placementArmed);
  // One translucent ghost per member.
  assert.equal(
    surface.querySelectorAll(".layer-overlay .part-ghost").length,
    2,
  );

  // Slide the pair 35 columns right (centre 12.5 → 47.5), onto empty board.
  world.x = 47.5;
  world.y = ROW.e;
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.ok(!controller.placementArmed);
  assert.equal(doc.components.length, 4, "both members pasted");
  const pasted = doc.components.filter((c) => c.id !== a.id && c.id !== b.id);
  const seats = pasted.map((c) => `${c.ref}@${c.anchor}`).sort();
  assert.deepEqual(seats, ["74LS00@e40", "74LS04@e55"]);
  // The fresh set is the new selection (draggable/deletable as a unit).
  assert.deepEqual(
    controller.multiSelectedIds.sort(),
    pasted.map((c) => c.id).sort(),
  );
});

test("a cluster paste including a DIP-packaged discrete doesn't throw (bar8iso/sw-dip* seat like a chip but aren't one)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  const bank = controller.addComponentAt("sw-dip4", "bb1", "e20"); // cols 20–27

  marquee(viewport, world, { x: 4, y: 4 }, { x: 30, y: 9 });
  assert.equal(controller.multiSelectedIds.length, 2);

  assert.equal(accelKey(controller, "c"), true);
  assert.equal(accelKey(controller, "v"), true);
  assert.ok(controller.placementArmed);
  assert.equal(
    surface.querySelectorAll(".layer-overlay .part-ghost").length,
    2,
    'both members ghost — memberForm("chip") for a def.package DISCRETE ' +
      "must draw via buildDiscreteSvg, not buildChipSvg",
  );

  world.x = 47.5;
  world.y = ROW.e;
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.ok(!controller.placementArmed);
  assert.equal(doc.components.length, 4, "both members pasted");
  const pasted = doc.components.filter(
    (c) => c.id !== chip.id && c.id !== bank.id,
  );
  assert.equal(pasted.length, 2);
  assert.ok(pasted.some((c) => c.ref === "74LS00"));
  assert.ok(pasted.some((c) => c.ref === "sw-dip4"));
});

test("a cluster paste seats the valid members and discards the invalid ones", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  const a = controller.addComponentAt("74LS00", "bb1", "e5");
  const b = controller.addComponentAt("74LS04", "bb1", "e20");

  marquee(viewport, world, { x: 4, y: 4 }, { x: 27, y: 9 });
  accelKey(controller, "c");
  accelKey(controller, "v");

  // Slide 45 columns right: the first (e5→e50) still fits the 63-column board;
  // the second (e20→e65) runs off the end and is discarded.
  world.x = 57.5;
  world.y = ROW.e;
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  assert.ok(!controller.placementArmed);
  assert.equal(doc.components.length, 3, "only the seatable member pasted");
  const pasted = doc.components.filter((c) => c.id !== a.id && c.id !== b.id);
  assert.equal(pasted.length, 1);
  assert.equal(`${pasted[0].ref}@${pasted[0].anchor}`, "74LS00@e50");
});

test("a cluster ghost shades an unseatable member red while dragging", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addComponentAt("74LS00", "bb1", "e5");
  controller.addComponentAt("74LS04", "bb1", "e20");

  marquee(viewport, world, { x: 4, y: 4 }, { x: 27, y: 9 });
  accelKey(controller, "c");
  accelKey(controller, "v");

  // Same off-the-end shift, but hovering — the first member seats (green), the
  // second is off the board (red). Ghost order follows member order.
  world.x = 57.5;
  world.y = ROW.e;
  viewport.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true }),
  );
  const ghosts = [...surface.querySelectorAll(".layer-overlay .part-ghost")];
  assert.equal(ghosts.length, 2);
  assert.ok(ghosts[0].classList.contains("part-ghost--legal"));
  assert.ok(ghosts[1].classList.contains("part-ghost--illegal"));
});

test("a fully-unseatable cluster drop stays armed (nothing pasted)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addComponentAt("74LS00", "bb1", "e5");
  controller.addComponentAt("74LS04", "bb1", "e20");

  marquee(viewport, world, { x: 4, y: 4 }, { x: 27, y: 9 });
  accelKey(controller, "c");
  accelKey(controller, "v");

  // Drop far off any board — nothing can seat, so the paste stays in hand.
  world.x = 400;
  world.y = 400;
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.ok(controller.placementArmed, "still armed to try again");
  assert.equal(doc.components.length, 2, "nothing pasted");
});

// ── Right-click while probing ─────────────────────────────────────────────

// PopupManager QUEUES a second popup rather than replacing it, so a wire menu
// that opens on the way to the probe's net menu isn't merely redundant — the
// user sees it FIRST and has to dismiss it. Wires/buses must stand aside while
// probing, exactly as boards, parts, and annotations already do.
test("right-clicking a wire while probing shows the net menu, not the wire menu", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const wire = doc.addWire({ from: "bb1.a6", to: "bb1.a9" });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed")); // draw it
  const at = worldOfAddress(doc.boards, "bb1.a6");
  world.x = at.x;
  world.y = at.y;

  controller.armProbe();
  PopupManager.close();
  surface.querySelector(`[data-wire-id="${wire.id}"]`).dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }),
  );

  assert.deepEqual(
    [...document.querySelectorAll(".popup-menu-item")].map((b) =>
      b.textContent.trim(),
    ),
    ["Name this net…"],
  );
});

test("right-clicking a wire with the probe disarmed shows the uniform part menu", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);
  const wire = doc.addWire({ from: "bb1.a6", to: "bb1.a9" });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed")); // draw it

  PopupManager.close();
  surface.querySelector(`[data-wire-id="${wire.id}"]`).dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }),
  );

  const labels = [...document.querySelectorAll(".popup-menu-item")].map((b) =>
    b.textContent.trim(),
  );
  assert.deepEqual(labels, [
    "Pin Assignment",
    "Properties…",
    "Delete Component",
  ]);
});

// ── P / M / digit-key shortcuts ───────────────────────────────────────────

test("P toggles the probe tool, same as I", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);

  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "p" }),
  );
  assert.equal(consumed, true);
  assert.equal(controller.probeArmed, true);

  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "P" }));
  assert.equal(controller.probeArmed, false);
});

test("M disarms whichever of the wire/bus/probe tools is armed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);

  controller.armWireTool();
  assert.equal(controller.wireToolArmed, true);
  let consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "m" }),
  );
  assert.equal(consumed, true);
  assert.equal(controller.wireToolArmed, false);

  controller.armBusTool();
  assert.equal(controller.busToolArmed, true);
  consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "M" }),
  );
  assert.equal(consumed, true);
  assert.equal(controller.busToolArmed, false);

  controller.armProbe();
  assert.equal(controller.probeArmed, true);
  consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "m" }),
  );
  assert.equal(consumed, true);
  assert.equal(controller.probeArmed, false);
});

test("M is inert (returns false) when no tool is armed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);

  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "m" }),
  );
  assert.equal(consumed, false);
});

test("1-8 pick the wire color while the wire tool is armed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);

  controller.armWireTool();
  for (let n = 1; n <= 8; n++) {
    const consumed = controller.handleKeyDown(
      new window.KeyboardEvent("keydown", { key: String(n) }),
    );
    assert.equal(consumed, true);
    assert.equal(controller.wireColor, WIRE_COLORS[n - 1]);
  }
});

test("1-8 pick the bus width while the bus tool is armed; digits are inert otherwise", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);

  // Not armed: a digit is not consumed and doesn't touch the bus name.
  let consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "1" }),
  );
  assert.equal(consumed, false);

  controller.armBusTool();
  // 2–8 name their own width; 1 is the 16-bit bus.
  for (const [key, name] of [
    ["2", "D[1:0]"],
    ["3", "D[2:0]"],
    ["4", "D[3:0]"],
    ["5", "D[4:0]"],
    ["6", "D[5:0]"],
    ["7", "D[6:0]"],
    ["8", "D[7:0]"],
    ["1", "D[15:0]"],
  ]) {
    consumed = controller.handleKeyDown(
      new window.KeyboardEvent("keydown", { key }),
    );
    assert.equal(consumed, true);
    assert.equal(controller.busName, name);
  }

  // 9 has no preset — not consumed, and the width stands.
  consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "9" }),
  );
  assert.equal(consumed, false);
  assert.equal(controller.busName, "D[15:0]");
});

// ── Fit to screen (recentre + frame) ───────────────────────────────────────

test("fitToScreen slides the whole desk onto the origin and frames it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addKit("full", 400, 300); // bb1 rail · bb2 pins · bb3 rail
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" });
  doc.addPsu(480, 303);
  doc.addWire({ from: "psu1.+", to: "bb1.+3" });
  doc.addAnnotation("note", 402, 296, "adder");
  const { surface, controller, deskView } = makeDesk(doc);
  const before = doc.getBoard("bb2");
  const chip = surface.querySelector('[data-component-id="c1"]');
  const chipLeft = Number.parseFloat(chip.style.left);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  controller.fitToScreen();

  // Everything straddles the origin now — the camera lands there too.
  const bounds = deskBounds(doc.boards, doc.components, doc.wires);
  assert.ok(Math.abs(bounds.minX + bounds.maxX) <= 1, "centred on x");
  assert.ok(Math.abs(bounds.minY + bounds.maxY) <= 1, "centred on y");
  assert.ok(Math.abs(deskView.camera.cx) <= 1);
  assert.ok(Math.abs(deskView.camera.cy) <= 1);
  // Every kind of positioned thing moved by the SAME delta.
  const moved = doc.getBoard("bb2");
  const [dx, dy] = [moved.x - before.x, moved.y - before.y];
  assert.deepEqual(
    [doc.getComponent("psu1").x, doc.getComponent("psu1").y],
    [480 + dx, 303 + dy],
  );
  assert.deepEqual(
    [doc.annotations[0].x, doc.annotations[0].y],
    [402 + dx, 296 + dy],
  );
  // The views followed the document rather than staying where they were…
  const board = surface.querySelector('[data-board-id="bb2"]');
  assert.equal(board.style.left, `${moved.x * PX_PER_UNIT}px`);
  // …and the seated chip rode its board by the same delta.
  assert.equal(Number.parseFloat(chip.style.left), chipLeft + dx * PX_PER_UNIT);
  // One document edit — so it is one undo step, which puts the desk back.
  assert.equal(changes, 1);
  controller.undo();
  assert.deepEqual(doc.getBoard("bb2"), before);
});

test("fitToScreen is camera-only while the sim runs — topology stays put", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addKit("full", 400, 300);
  const { controller, deskView } = makeDesk(doc);
  controller.setEditingLocked(true);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  controller.fitToScreen();

  assert.equal(changes, 0);
  assert.deepEqual(
    [doc.getBoard("bb1").x, doc.getBoard("bb1").y],
    [400, 300],
    "a running circuit is never rearranged under the user",
  );
  assert.ok(deskView.camera.cx > 0, "but the camera still frames it");
});

test("fitLoadedDesk centres a just-loaded desk with nothing left to undo", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addKit("full", 400, 300);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" });
  const { controller, deskView } = makeDesk(doc);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  controller.fitLoadedDesk();

  // It really is the fit: the desk straddles the origin and the camera is on it.
  const bounds = deskBounds(doc.boards, doc.components, doc.wires);
  assert.ok(Math.abs(bounds.minX + bounds.maxX) <= 1, "centred on x");
  assert.ok(Math.abs(bounds.minY + bounds.maxY) <= 1, "centred on y");
  assert.ok(Math.abs(deskView.camera.cx) <= 1);
  // Everyone still hears about it — the dirty marker, the sim, the panels.
  assert.equal(changes, 1);
  // But it belongs to the LOAD, not to the user: there is no undo step, and
  // the history's baseline is the centred desk, not the one in the file.
  assert.equal(controller.canUndo, false);
  const centred = { ...doc.getBoard("bb2") };
  controller.addBoardAt("pins-half", 900, 900);
  controller.undo();
  assert.deepEqual(doc.getBoard("bb2"), centred, "undo lands on the centred desk"); // prettier-ignore
  assert.equal(doc.boards.length, 3, "and takes the edit off it");
});

test("fitToScreen on an empty desk changes nothing", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller, deskView } = makeDesk(doc);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  controller.fitToScreen();

  assert.equal(changes, 0);
  assert.deepEqual(deskView.camera, { cx: 0, cy: 0, zoom: 1 });
});

// ── A loaded ROM's backing store (the shipped 65xx demos) ────────────────────
// A ROM gets its GUID + noise file when it is PLACED or PASTED. A document read
// from a FILE was never either, so a chip in it may name no store — and without
// one main has no handle on the bytes, so MemoryBridge's programmer, Save and
// file-backed inspector path all fall silently through `if (!info) return`.
// That was a "Load image…" that did nothing, on every shipped 65xx demo.

/** A one-ROM document as `make-demos.mjs` writes it: no `params.storage`. */
const romDocument = () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  const rom = doc.addComponent({
    kind: "chip",
    ref: "rom-8k",
    board: "bb2",
    anchor: "e3",
    params: {},
  });
  const raw = doc.snapshot();
  // addComponent does NOT provision (that is the controller's job), so this is
  // the generator's shape exactly — assert it, or the fixture could go stale
  // and quietly stop testing anything.
  const seated = raw.components.find((c) => c.id === rom.id);
  assert.equal(seated.params?.storage, undefined, "fixture ROM has no store");
  return raw;
};

test("loadDocument gives a ROM that arrived without one its own backing store", () => {
  resetDom();
  const raw = romDocument();
  const doc = new DeskDoc(null);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const created = [];
  const controller = new DeskController({
    viewport,
    deskView: {
      surface,
      camera: { cx: 0, cy: 0, zoom: 1 },
      worldFromEvent: () => ({ x: 0, y: 0 }),
      setCamera: () => {},
    },
    deskDoc: doc,
    onCreateMemoryFile: (guid, byteLength) => created.push([guid, byteLength]),
  });

  controller.loadDocument(raw);

  const rom = doc.components.find((c) => c.ref === "rom-8k");
  const guid = rom.params?.storage?.guid;
  assert.ok(guid, "the loaded ROM was given a GUID");
  // Only a `true` is stored (omit-when-default), so "not programmed" is the
  // flag's ABSENCE — a fresh noise file has nothing in it to claim otherwise.
  assert.notEqual(rom.params.programmed, true, "not claimed as programmed");
  assert.deepEqual(
    created,
    [[guid, 8192]],
    "its noise-filled backing file was created, at the part's own size",
  );

  // The baseline is seeded AFTER the mint, so ⌘Z cannot unwind the desk to a
  // state whose ROM has no store again.
  assert.equal(controller.undo(), false, "the load left nothing to undo");
  assert.equal(
    doc.components.find((c) => c.ref === "rom-8k").params.storage.guid,
    guid,
  );
});

test("loadDocument leaves an existing store alone and never touches SRAM", () => {
  resetDom();
  const raw = romDocument();
  const rom = raw.components.find((c) => c.ref === "rom-8k");
  // A REAL UUID: the loader validates the shape (catalog `normalizeStorage`),
  // so a malformed one is dropped and would be re-minted here — correctly, but
  // it would stop this test from testing what it says it does.
  const KEPT = "11111111-2222-3333-4444-555555555555";
  rom.params = { storage: { guid: KEPT }, programmed: true };
  // A volatile SRAM is never file-backed, so it must not be given a store.
  raw.components.push({
    id: "c9",
    kind: "chip",
    ref: "HM62256",
    board: "bb2",
    anchor: "e30",
    params: {},
  });

  const doc = new DeskDoc(null);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const created = [];
  const controller = new DeskController({
    viewport,
    deskView: {
      surface,
      camera: { cx: 0, cy: 0, zoom: 1 },
      worldFromEvent: () => ({ x: 0, y: 0 }),
      setCamera: () => {},
    },
    deskDoc: doc,
    onCreateMemoryFile: (guid, byteLength) => created.push([guid, byteLength]),
  });

  controller.loadDocument(raw);

  const loaded = doc.components.find((c) => c.ref === "rom-8k");
  assert.equal(loaded.params.storage.guid, KEPT, "store untouched");
  assert.equal(loaded.params.programmed, true, "and still programmed");
  const sram = doc.components.find((c) => c.ref === "HM62256");
  assert.equal(sram.params?.storage, undefined, "volatile SRAM gets no store");
  assert.deepEqual(created, [], "nothing was created");
});
