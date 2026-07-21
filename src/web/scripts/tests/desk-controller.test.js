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
import { DeskDoc } from "../model/desk-doc.js";
import {
  addressAtWorld,
  partPinAddresses,
  partPinHoles,
  worldOfAddress,
} from "../model/occupancy.js";
import { spec } from "../model/breadboard.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { OUTLINE_MARGIN } from "../components/board-outline.js";

const { DeskController } = await import("../components/desk-controller.js");

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
  };
  const controller = new DeskController({ viewport, deskView, deskDoc });
  return { viewport, surface, controller, world };
}

test("constructor creates the four layers in order and mounts doc boards", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addBoard("pins-tiny", 0, 30);
  const { surface } = makeDesk(doc);

  assert.deepEqual(
    [...surface.children].map((c) => c.className),
    ["layer-boards", "layer-parts", "layer-wires", "layer-overlay"],
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

  const board = controller.addBoardAt("pins-half", 2.4, 3.6);
  assert.deepEqual(board, {
    id: "bb1",
    type: "pins-half",
    x: 2,
    y: 4,
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
  controller.addComponentAt("7400", "bb1", "e5"); // cols 5–11
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
    ["7400", "7400"],
  );
});

test("Cmd+V carries the copied chip's orientation into the duplicate", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { viewport, controller, world } = makeDesk(doc);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("7400", "bb1", "e5");
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
  assert.equal(dupe.ref, "7400");
  assert.equal(dupe.params.rot, 180);
});

test("Cmd+V keeps a rotatable part's turned orientation and lead vector", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addBoard("rail-full", 0, 14); // bb2 — a rail below row a
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);

  // Source: a resistor stood on end, its lead reaching down onto the rail.
  const src = controller.addComponentAt("resistor", "bb1", "a10", {
    rot: 90,
    end: { dx: 0, dy: 3 },
  });
  assert.equal(doc.getComponent(src.id).params.rot, 90);

  accelKey(controller, "c");
  accelKey(controller, "v");
  assert.ok(controller.placementArmed);

  // Track + drop the duplicate a few columns over; pin 1 rides the cursor. Land
  // it on a column whose rail hole exists (rails skip every fifth position).
  world.x = 25;
  world.y = 12; // hole a25
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
  controller.addKitAt("half", 0, 0); // bb1..bb3, group g1 — spans y 0…19

  // A spare rail seated against the kit's bottom edge joins its group, so the
  // whole stack drags as one unit from here on.
  const [rail] = controller.addKitAt("rail-half", 0, 19);
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
  assert.ok(doc.canPlaceChip("7400", strips[0].id, "e2"));
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
  // 7400 at e5 spans columns 5–11 (x 5…11) across rows f (y 5) and e (y 8).
  const chip = controller.addComponentAt("7400", "bb1", "e5");
  // A second chip far to the right, well outside the box.
  const outside = controller.addComponentAt("7404", "bb1", "e20");

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
  const chip = controller.addComponentAt("7400", "bb1", "e5"); // cols 5–11

  // Box stops at column 8 — the right-hand pins fall outside.
  marquee(viewport, world, { x: 4, y: 4 }, { x: 8, y: 9 });
  assert.deepEqual(controller.multiSelectedIds, []);
  assert.ok(chip.id);
});

test("Delete removes the whole marquee selection in one doc-changed", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addComponentAt("7400", "bb1", "e5"); // cols 5–11
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
  const chip = controller.addComponentAt("7400", "bb1", "e5"); // cols 5–11
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
  controller.addComponentAt("7400", "bb1", "e5");

  marquee(viewport, world, { x: 4, y: 4 }, { x: 12, y: 9 });
  assert.equal(controller.multiSelectedIds.length, 1);
  controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Escape" }),
  );
  assert.deepEqual(controller.multiSelectedIds, []);
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
  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16

  const lit = dragBoard(surface, world, "bb2", 0, 30);
  assert.deepEqual(lit, ["bb1", "bb2", "bb3"]);
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y, b.group]),
    [
      ["bb1", 30, "g1"],
      ["bb2", 33, "g1"],
      ["bb3", 46, "g1"],
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

  assert.deepEqual(outlineBox(surface), expectedBox(doc, ["bb4"]));
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
  assert.deepEqual(outlineBox(surface), expectedBox(doc, ["bb2", "bb3"]));
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
  controller.addBoardAt("pins-full", 0, 0); // 64 wide, spans y 0…13
  controller.addBoardAt("rail-half", 0, 20); // only 31 wide

  // Dropped one pitch under the full board: flush would be y = 13, but a
  // half-width rail does not dovetail onto a full-width board at all.
  dragBoard(surface, world, "bb2", 0, -6);
  assert.equal(doc.getBoard("bb2").y, 14);
  assert.equal(doc.getBoard("bb2").group, null);
});

test("a whole kit dropped against another board mates, all six strips", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1…bb3, spanning y 0…19
  controller.addKitAt("full", 0, 30); // bb4…bb6, clear below it

  // Grab the second kit's pin-board and drop the kit two pitch shy of flush.
  dragBoard(surface, world, "bb5", 0, -9);
  assert.deepEqual(
    doc.boards.map((b) => b.y),
    [0, 3, 16, 19, 22, 35], // the second kit pulled up onto the first
  );
  assert.equal(new Set(doc.boards.map((b) => b.group)).size, 1);
  assert.equal(doc.groupMembers("bb1").length, 6);
});

test("placing a kit flush against a board mates it, exactly as a drop does", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  controller.addKitAt("full", 0, 0);
  controller.addKitAt("full", 0, 19); // seated on the first kit's bottom edge

  assert.equal(doc.groupMembers("bb1").length, 6);
});

test("Option-drag takes the run BELOW the grab and tears off the rest", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16

  const lit = dragBoard(surface, world, "bb2", 0, 30, { altKey: true });
  assert.deepEqual(lit, ["bb2", "bb3"]); // the top rail is not in the set
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y]),
    [
      ["bb1", 0], // left exactly where it was
      ["bb2", 33],
      ["bb3", 46],
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
      ["bb2", -27],
      ["bb3", 16], // the bottom rail stays put
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
    [0, 3, 16], // nothing moved
  );
});

test("an Option-drag that lands illegally reverts and keeps the snap", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1..bb3, spans y 0…19
  controller.addKitAt("full", 0, 22); // bb4..bb6, spans y 22…41

  // Push the bottom run down onto the second board — no room, so nothing
  // commits and the group must survive intact.
  dragBoard(surface, world, "bb2", 0, 8, { altKey: true });
  assert.deepEqual(
    doc.boards.map((b) => [b.id, b.y, b.group]),
    [
      ["bb1", 0, "g1"],
      ["bb2", 3, "g1"],
      ["bb3", 16, "g1"],
      ["bb4", 22, "g2"],
      ["bb5", 25, "g2"],
      ["bb6", 38, "g2"],
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
  doc.addBoard("rail-full", 0, -4); // bb2 — a rail strip along the top edge
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  // Pin 1 at a10 (world 10, 12); pin 2 at a13.
  const r = controller.addComponentAt("resistor", "bb1", "a10");

  const el = partEl(surface, r.id);
  // Grab pin 2's lead (a13 sits at world 13, 12), then haul it clear off this
  // strip onto the rail above — a span the fixed-length whole-drag could
  // never reach, and a hole this part is not even seated on.
  world.x = 13;
  world.y = 12;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 10; // the `-` rail's hole 7 sits at world (10, −2)
  world.y = -2;
  pointerAt(el, "pointermove", 40, 40);
  pointerAt(el, "pointerup", 40, 40);

  const comp = doc.getComponent(r.id);
  assert.equal(comp.board, "bb1"); // still SEATED on the pin-board…
  assert.equal(comp.anchor, "a10"); // …and the untouched end never moved
  assert.equal(comp.params.rot, 90);
  // …while the lead is stored as a bend, and resolves onto the other strip.
  assert.deepEqual(comp.params.end, { dx: 0, dy: -14 });
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
  world.y = 12;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 11; // only 1 hole from pin 1 — inside the 3-unit minimum
  world.y = 12;
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
  doc.addBoard("rail-full", 0, -4); // bb2 — a rail strip along the top edge
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  // Pin 1 (anode) at a10 (world 10, 12); pin 2 (cathode) alongside at a11.
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
  world.y = 11;
  pointerAt(el, "pointerdown", 0, 0);
  world.y = -2; // the rail strip's `-` rail
  pointerAt(el, "pointermove", 0, 60);
  pointerAt(el, "pointerup", 0, 60);

  const after = doc.getComponent(led.id);
  assert.equal(after.board, "bb1"); // seated here, only REACHING the rail
  assert.equal(after.anchor, "a10"); // the anode never moved
  assert.deepEqual(after.params.end, { dx: 0, dy: -14 });
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
  world.y = 12;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 10;
  world.y = 11; // b10 — adjacent to the anode at a10
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
  world.y = 12; // row a
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
  doc.addBoard("rail-full", 0, 14); // bb2 — a rail strip along the bottom edge
  const world = { x: 10, y: 12 }; // hole a10
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
  const chip = controller.addComponentAt("7400", "bb1", "e5"); // auto-selected
  const holesOf = () =>
    partPinHoles("7400", "e5", doc.getComponent(chip.id).params);

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
    partPinHoles("7400", "e5")
      .map((p) => p.hole)
      .sort(),
    "occupies exactly the same holes",
  );

  // Flipping again returns it to the original orientation.
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));
  assert.equal(doc.getComponent(chip.id).params.rot, undefined);
  assert.equal(holesOf().find((p) => p.pin === 1).hole, "e5");
});

test("a chip flipped mid-drag commits the flip with the move", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("7400", "bb1", "e10");

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
  world.y = 12;
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
  world.y = 2;
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
  // Flat to begin with: 64 wide, 3 tall.
  assert.equal(ghost().style.width, `${64 * PX_PER_UNIT}px`);

  assert.equal(R(), true, "R consumed");
  assert.ok(controller.placementArmed, "STILL armed — rotating is not placing");
  // Turned: the ghost is now tall and thin, and its strip carries the spin.
  assert.equal(ghost().style.width, `${3 * PX_PER_UNIT}px`);
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
