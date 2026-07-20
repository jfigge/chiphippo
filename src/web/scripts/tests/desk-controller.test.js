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

test("every resistor renders as a span; rotateComponent swings the lead", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
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
function pointerAt(el, type, x, y) {
  el.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
    }),
  );
}

const partEl = (surface, id) =>
  surface.querySelector(`[data-component-id="${id}"]`);

test("dragging a resistor commits a legal drop (both ends translate rigidly)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "e10"); // e10 ── e13

  const el = partEl(surface, r.id);
  pointerAt(el, "pointerdown", 0, 0); // grab (world 0,0)
  world.x = 2; // cursor slid +2 pitch units right
  pointerAt(el, "pointermove", 50, 0); // past the 4 px threshold
  pointerAt(el, "pointerup", 50, 0);

  // Both ends shifted by the SAME delta — length and angle preserved.
  const comp = doc.getComponent(r.id);
  assert.equal(comp.anchor, "e12");
  assert.equal(comp.params.end, "e15");
});

test("a resistor can be dragged onto another board (both ends must share it)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0); // bb1
  doc.addBoard("full", 0, 30); // bb2, directly below
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
  assert.equal(comp.params.end, "e13");
});

test("a resistor dropped in an illegal position returns to its origin", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
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

test("dragging ONE end reaches the far rail; the other end stays put", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  // Pin 1 at a10 (x 10, y 16); pin 2 at a13.
  const r = controller.addComponentAt("resistor", "bb1", "a10");

  const el = partEl(surface, r.id);
  // Grab pin 2's lead (a13 sits at world x 13, y 16), then haul it to the
  // FAR top rail — a span the fixed-length whole-drag could never reach.
  world.x = 13;
  world.y = 16;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 10; // t-1 sits at x 3… aim at the t- rail hole above column 10
  world.y = 2; // rail row `t-`
  pointerAt(el, "pointermove", 40, 40);
  pointerAt(el, "pointerup", 40, 40);

  const comp = doc.getComponent(r.id);
  assert.equal(comp.anchor, "a10"); // the untouched end never moved
  assert.equal(comp.params.rot, 90);
  assert.ok(
    comp.params.end.startsWith("t-"),
    `expected a t- rail hole, got ${comp.params.end}`,
  );
});

test("an end dropped closer than the minimum lead span springs back", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "a10"); // a10 ── a13

  const el = partEl(surface, r.id);
  world.x = 13; // grab pin 2
  world.y = 16;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 11; // only 1 hole from pin 1 — inside the 3-unit minimum
  world.y = 16;
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
  doc.addBoard("full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  // Pin 1 (anode) at a10 (x 10, y 16); pin 2 (cathode) alongside at a11.
  const led = controller.addComponentAt("led", "bb1", "a10", {
    color: "green",
  });
  // It renders as a centred, angled span — dome included.
  assert.ok(surface.querySelector(".part-led-dome--green"));
  assert.ok(surface.querySelector(".part-span-lead"));

  // R rotates it in place, pivoting the cathode into the column.
  controller.rotateComponent(led.id);
  assert.equal(doc.getComponent(led.id).params.rot, 90);

  // Drag the cathode end up to the far top rail.
  const el = partEl(surface, led.id);
  const moved = doc.getComponent(led.id);
  const end = moved.params.end; // wherever the rotate put pin 2
  assert.ok(end);
  world.x = 10; // grab pin 2 (same column, one row up from a10 → y 15)
  world.y = 15;
  pointerAt(el, "pointerdown", 0, 0);
  world.y = 2; // the far `t-` rail
  pointerAt(el, "pointermove", 0, 60);
  pointerAt(el, "pointerup", 0, 60);

  const after = doc.getComponent(led.id);
  assert.equal(after.anchor, "a10"); // the anode never moved
  assert.ok(
    after.params.end.startsWith("t-"),
    `expected a t- rail hole, got ${after.params.end}`,
  );
  // Colour/polarity survive the move.
  assert.equal(after.params.color, "green");
});

test("an LED's legs may sit side by side (no gap required)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const led = controller.addComponentAt("led", "bb1", "a10", { color: "red" });

  // Drag the cathode from a11 to the ADJACENT hole in the row above (b10) —
  // one pitch unit away, which an LED allows but a resistor would reject.
  const el = partEl(surface, led.id);
  world.x = 11;
  world.y = 16;
  pointerAt(el, "pointerdown", 0, 0);
  world.x = 10;
  world.y = 15; // b10 — adjacent to the anode at a10
  pointerAt(el, "pointermove", 40, 40);
  pointerAt(el, "pointerup", 40, 40);

  const after = doc.getComponent(led.id);
  assert.equal(after.anchor, "a10");
  assert.equal(after.params.end, "b10"); // committed one hole away
  // The same 1-unit span is illegal for a resistor (minSpan 3).
  assert.equal(
    doc.canPlacePart("resistor", "bb1", "j10", {
      params: { rot: 90, end: "i10" },
    }),
    false,
  );
});

test("R rotates a resistor freely mid-drag; the release commits it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "e10"); // e10 ── e13

  const el = partEl(surface, r.id);
  pointerAt(el, "pointerdown", 0, 0);
  // Rotate 90° while holding — no cursor travel needed.
  controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "r" }));
  pointerAt(el, "pointerup", 0, 0);

  // Pin 1 stayed; pin 2 swung into the same column three rows down.
  const comp = doc.getComponent(r.id);
  assert.equal(comp.anchor, "e10");
  assert.equal(comp.params.rot, 90);
  assert.equal(comp.params.end, "b10");
});

test("R rotates the selected resistor via handleKeyDown", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const { controller } = makeDesk(doc);
  const r = controller.addComponentAt("resistor", "bb1", "e10"); // auto-selected
  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "r" }),
  );
  assert.equal(consumed, true);
  assert.equal(doc.getComponent(r.id).params.rot, 90);
});
