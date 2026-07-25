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

// jsdom tests for the design paste (Feature 240) through the controller: a
// marquee takes boards, ⌘C captures the whole sub-assembly, ⌘V arms a ghost
// that follows the cursor with no button held, a click drops it as one undo
// step — and the clip survives a document swap, which is what makes pasting
// from one project tab into another work at all.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");
const { HistoryStore } = await import("../model/history-store.js");

/** A viewport + DeskView stub; `world` is read live, so a test can move the
    "cursor" between dispatched events (mirrors desk-controller.test.js). */
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

/** Shift-drag a marquee from one world point to another. */
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

const accelKey = (controller, key) =>
  controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key, metaKey: true }),
  );

/** Click the viewport at a world point (drops an armed placement). */
function clickAt(viewport, world, x, y) {
  world.x = x;
  world.y = y;
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/**
 * A tiny board carrying a chip and a wire — a whole little design, built on
 * the DOCUMENT before the controller mounts, so it is the baseline the desk
 * (and its undo history) starts from rather than three recorded edits.
 */
function seedDesign() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-tiny", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addWire({ from: "bb1.a1", to: "bb1.a3", color: "red" });
  return doc;
}

/** A marquee big enough to swallow the tiny board at 0,0 whole. */
const AROUND_TINY = [
  { x: -3, y: -3 },
  { x: 24, y: 20 },
];

test("a marquee takes in the boards it fully encloses", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0);
  controller.addBoardAt("pins-tiny", 40, 0); // well outside the box

  marquee(viewport, world, ...AROUND_TINY);
  assert.deepEqual(controller.multiSelectedBoardIds, ["bb1"]);
});

test("a board only partly inside the marquee is left out", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0);

  marquee(viewport, world, { x: -3, y: -3 }, { x: 8, y: 20 });
  assert.deepEqual(controller.multiSelectedBoardIds, []);
});

test("⌘C over a design, ⌘V ghosts the whole thing — boards, parts, and wiring", () => {
  resetDom();
  const doc = seedDesign();
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);

  marquee(viewport, world, ...AROUND_TINY);
  assert.equal(accelKey(controller, "c"), true);
  assert.equal(accelKey(controller, "v"), true);
  assert.ok(controller.placementArmed);

  const ghost = surface.querySelector(".layer-overlay .design-ghost");
  assert.ok(ghost, "one rigid ghost for the whole design");
  assert.equal(ghost.querySelectorAll(".board-ghost-strip").length, 1);
  assert.equal(ghost.querySelectorAll(".part-ghost").length, 1);
  assert.equal(ghost.querySelectorAll(".design-ghost-wires .wire").length, 1);
});

test("a click drops the design: fresh boards, parts, and wires, in one step", () => {
  resetDom();
  const doc = seedDesign();
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);

  marquee(viewport, world, ...AROUND_TINY);
  accelKey(controller, "c");
  accelKey(controller, "v");

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  clickAt(viewport, world, 8, 40); // clear desk, well below the source

  assert.equal(changes, 1, "one doc-changed for the whole paste");
  assert.ok(!controller.placementArmed, "the ghost is put away");
  assert.equal(doc.boards.length, 2);
  assert.equal(doc.components.length, 2);
  assert.equal(doc.wires.length, 2);
  // The copy is its own hardware, wired to its own board.
  const pastedBoard = doc.boards[1];
  const pastedWire = doc.wires[1];
  assert.ok(pastedWire.from.startsWith(`${pastedBoard.id}.`));
  assert.equal(surface.querySelectorAll(".board").length, 2);
  assert.equal(surface.querySelectorAll(".part").length, 2);
});

test("the dropped design becomes the selection, ready to be moved or copied on", () => {
  resetDom();
  const doc = seedDesign();
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);

  marquee(viewport, world, ...AROUND_TINY);
  accelKey(controller, "c");
  accelKey(controller, "v");
  clickAt(viewport, world, 8, 40);

  assert.deepEqual(controller.multiSelectedBoardIds, [doc.boards[1].id]);
  assert.deepEqual(controller.multiSelectedIds, [doc.components[1].id]);
});

test("a click where the design does not fit is ignored — it stays armed", () => {
  resetDom();
  const doc = seedDesign();
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);

  marquee(viewport, world, ...AROUND_TINY);
  accelKey(controller, "c");
  accelKey(controller, "v");
  clickAt(viewport, world, 8, 6); // straight back on top of the source board

  assert.ok(
    controller.placementArmed,
    "still in hand, the tint explaining why",
  );
  assert.equal(doc.boards.length, 1, "nothing landed");
});

test("Escape throws the pasted design away, document untouched", () => {
  resetDom();
  const doc = seedDesign();
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);

  const before = JSON.stringify(doc.toJSON());

  marquee(viewport, world, ...AROUND_TINY);
  accelKey(controller, "c");
  accelKey(controller, "v");
  world.x = 8;
  world.y = 40;
  viewport.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true, pointerId: 1 }),
  );
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "Escape" })); // prettier-ignore

  assert.ok(!controller.placementArmed);
  assert.equal(surface.querySelector(".design-ghost"), null);
  assert.equal(JSON.stringify(doc.toJSON()), before);
});

test("a pasted design is one undo step", () => {
  resetDom();
  const doc = seedDesign();
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);

  marquee(viewport, world, ...AROUND_TINY);
  accelKey(controller, "c");
  accelKey(controller, "v");
  clickAt(viewport, world, 8, 40);
  assert.equal(doc.boards.length, 2);

  assert.equal(controller.undo(), true);
  assert.equal(doc.boards.length, 1, "the whole paste came back out at once");
  assert.equal(doc.components.length, 1);
  assert.equal(doc.wires.length, 1);
});

test("the clip survives a document swap — the cross-desktop paste", () => {
  resetDom();
  const doc = seedDesign();
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);

  marquee(viewport, world, ...AROUND_TINY);
  accelKey(controller, "c");

  // Another desktop entirely (what a tab switch does).
  const other = new DeskDoc(null);
  other.addBoard("pins-full", 0, 60);
  controller.loadDocument(other.toJSON());
  assert.equal(doc.boards.length, 1, "the desk now shows the other document");
  assert.equal(doc.boards[0].type, "pins-full");
  assert.equal(surface.querySelectorAll(".part").length, 0);

  // The design copied on the first desktop is still in hand.
  assert.equal(accelKey(controller, "v"), true);
  clickAt(viewport, world, 8, 8);
  assert.equal(doc.boards.length, 2);
  assert.deepEqual(
    doc.boards.map((b) => b.type),
    ["pins-full", "pins-tiny"],
  );
  assert.equal(doc.components.length, 1, "the chip came with its board");
  assert.equal(doc.wires.length, 1);
});

test("loadDocument adopts the tab's own history — ⌘Z undoes THAT desk's edit", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { controller } = makeDesk(doc);
  controller.addBoardAt("pins-tiny", 0, 0);
  assert.equal(controller.canUndo, true);

  const other = new HistoryStore();
  controller.loadDocument(new DeskDoc(null).toJSON(), { history: other });
  assert.equal(
    controller.canUndo,
    false,
    "a fresh desktop has nothing to undo",
  );

  controller.addBoardAt("pins-full", 0, 0);
  assert.equal(controller.canUndo, true);
  controller.undo();
  assert.equal(doc.boards.length, 0);
});
