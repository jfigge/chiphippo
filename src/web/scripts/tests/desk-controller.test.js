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

const { DeskController } = await import("../components/desk-controller.js");

/** A viewport + DeskView stub good enough for the controller. */
function makeDesk(deskDoc) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc });
  return { viewport, surface, controller };
}

test("constructor creates the four layers in order and mounts doc boards", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  doc.addBoard("tiny", 0, 30);
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

  const board = controller.addBoardAt("half", 2.4, 3.6);
  assert.deepEqual(board, { id: "bb1", type: "half", x: 2, y: 4 });
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
  doc.addBoard("full", 0, 0);
  const { surface, controller } = makeDesk(doc);

  assert.throws(() => controller.addBoardAt("tiny", 5, 5), {
    code: "OVERLAP",
  });
  assert.equal(surface.querySelectorAll(".board").length, 1);
});

test("removeBoard unmounts, clears selection, and emits", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addBoardAt("tiny", 0, 0);

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
  controller.addBoardAt("tiny", 0, 0);
  controller.addBoardAt("tiny", 30, 0); // selects bb2

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

test("Delete/Backspace removes the selected board via handleKeyDown", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addBoardAt("tiny", 0, 0);

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
