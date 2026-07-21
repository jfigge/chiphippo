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

// CHARACTERIZATION tests for the pointer-drag gestures (board drag, part drag,
// brick drag). These pin the CURRENT observable behaviour of the gesture state
// machines so the planned split of desk-controller.js into collaborator objects
// can be proven behaviour-preserving — they assert what the code does today,
// not what it ideally should. Everything is driven through real PointerEvents
// on the mounted board/part elements, exactly as the browser drives it.
//
// The DeskView stub reads a live `world` object for worldFromEvent(), so a test
// sets `world` to move the "cursor" in world space; the event's clientX/clientY
// is separate and only feeds the ~4px click-vs-drag threshold.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");

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

const boardEl = (surface, id) =>
  surface.querySelector(`[data-board-id="${id}"]`);
const partEl = (surface, id) =>
  surface.querySelector(`[data-component-id="${id}"]`);

/** Dispatch one pointer event of `type` on `el`, at client point + modifiers. */
function fire(el, type, { id = 3, client = [0, 0], mods = {} } = {}) {
  el.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: id,
      clientX: client[0],
      clientY: client[1],
      ...mods,
    }),
  );
}

/**
 * A full press → travel → release gesture on `el`. The cursor starts in world
 * `from` and ends in world `to`; `clientTravel` is how far the pointer moves in
 * client px (0 stays under the 4px threshold → a click, not a drag).
 */
function drag(
  el,
  world,
  from,
  to,
  { id = 3, mods = {}, clientTravel = 40 } = {},
) {
  world.x = from.x;
  world.y = from.y;
  fire(el, "pointerdown", { id, client: [0, 0], mods });
  world.x = to.x;
  world.y = to.y;
  const client = [clientTravel, clientTravel];
  fire(el, "pointermove", { id, client, mods });
  fire(el, "pointerup", { id, client, mods });
}

// ── Board drag ──────────────────────────────────────────────────────────────

test("board drag: the whole snapped group moves together and commits once", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const strips = controller.addKitAt("full", 0, 0); // bb1·bb2·bb3
  const startYs = Object.fromEntries(strips.map((s) => [s.id, s.y]));

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Grab the centre pin-board; travel +10 x, +40 y (clear of everything).
  drag(boardEl(surface, "bb2"), world, { x: 5, y: 8 }, { x: 15, y: 48 });

  for (const id of ["bb1", "bb2", "bb3"]) {
    assert.equal(doc.getBoard(id).x, 10, `${id} x`);
    assert.equal(doc.getBoard(id).y, startYs[id] + 40, `${id} y`);
  }
  assert.equal(changes, 1, "one batched doc-changed for the whole set");
});

test("board drag: a press that never crosses the threshold is a click, not a move", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Move the world a long way, but keep the client pointer still (travel 0).
  drag(
    boardEl(surface, "bb1"),
    world,
    { x: 5, y: 5 },
    { x: 40, y: 40 },
    {
      clientTravel: 0,
    },
  );

  assert.deepEqual([doc.getBoard("bb1").x, doc.getBoard("bb1").y], [0, 0]);
  assert.equal(changes, 0, "a click commits nothing");
  assert.equal(controller.selectedId, "bb1", "but it does select");
});

test("board drag: an illegal drop (onto another board) reverts, doc untouched", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0); // bb1
  controller.addBoardAt("pins-tiny", 40, 0); // bb2, clear to the right

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Drag bb1 right so it would land squarely on top of bb2.
  drag(boardEl(surface, "bb1"), world, { x: 2, y: 2 }, { x: 42, y: 2 });

  assert.deepEqual([doc.getBoard("bb1").x, doc.getBoard("bb1").y], [0, 0]);
  assert.equal(changes, 0, "an illegal drop writes nothing");
});

test("board drag: Option tears the forward chain off and re-groups both halves", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addKitAt("full", 0, 0); // bb1 rail@0 · bb2 pins@3 · bb3 rail@16
  const g0 = doc.getBoard("bb2").group;

  // Option-grab the pin-board: the forward chain (down/right) is bb2 + bb3;
  // bb1 (above) stays behind. Drag them 40 down.
  drag(
    boardEl(surface, "bb2"),
    world,
    { x: 5, y: 8 },
    { x: 5, y: 48 },
    {
      mods: { altKey: true },
    },
  );

  // bb1 left where it was and now loose; bb2+bb3 travelled as a fresh group.
  assert.equal(doc.getBoard("bb1").y, 0);
  assert.equal(doc.getBoard("bb1").group, null);
  assert.equal(doc.getBoard("bb2").y, 43);
  assert.equal(doc.getBoard("bb3").y, 56);
  const g = doc.getBoard("bb2").group;
  assert.ok(g != null && g !== g0, "torn-off pair minted a fresh group id");
  assert.equal(doc.getBoard("bb3").group, g);
});

test("board drag: the view tracks the pointer live, before the drop commits", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-tiny", 0, 0);
  const el = boardEl(surface, "bb1");

  world.x = 2;
  world.y = 2;
  fire(el, "pointerdown", { client: [0, 0] });
  world.x = 12;
  world.y = 22;
  fire(el, "pointermove", { client: [40, 40] });

  // Mid-drag: the element has moved but the document has NOT yet.
  assert.notEqual(el.style.left, "0px", "the view followed the pointer");
  assert.equal(
    doc.getBoard("bb1").x,
    0,
    "the document is untouched until drop",
  );

  fire(el, "pointerup", { client: [40, 40] });
  assert.equal(doc.getBoard("bb1").x, 10, "drop commits the delta");
});

// ── Part drag ─────────────────────────────────────────────────────────────

test("part drag: a chip re-seats to the anchor under the pointer, once", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("7400", "bb1", "e5"); // cols 5–11

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Grab at column 8 (offset −3 from the e5 anchor) so it is a true drag, not
  // the recentre-on-grab special case; release five columns right.
  drag(partEl(surface, chip.id), world, { x: 8, y: 6.5 }, { x: 13, y: 6.5 });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(changes, 1);
});

test("part drag: a sub-threshold press selects the chip but does not move it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("7400", "bb1", "e5");
  controller.deselect();

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(
    partEl(surface, chip.id),
    world,
    { x: 8, y: 6.5 },
    { x: 13, y: 6.5 },
    {
      clientTravel: 0,
    },
  );

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "no move");
  assert.equal(changes, 0);
  assert.equal(controller.selectedId, chip.id, "but selected");
});

test("part drag: an illegal drop (onto another chip) springs back to the origin", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("7400", "bb1", "e5"); // cols 5–11
  controller.addComponentAt("7400", "bb1", "e12"); // cols 12–18, blocks e10

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  // Aim chip1 at e10 (cols 10–16) — overlaps the blocker at e12.
  drag(partEl(surface, chip.id), world, { x: 8, y: 6.5 }, { x: 13, y: 6.5 });

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "reverted");
  assert.equal(changes, 0);
});

test("brick drag: a PSU moves to the dropped position and commits once", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const psu = controller.addBrickAt("psu", 0, 0);
  const { x: x0, y: y0 } = doc.getComponent(psu.id);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  drag(partEl(surface, psu.id), world, { x: 1, y: 1 }, { x: 21, y: 11 });

  const moved = doc.getComponent(psu.id);
  assert.equal(moved.x, x0 + 20);
  assert.equal(moved.y, y0 + 10);
  assert.equal(changes, 1);
});

// ── Wire drag ───────────────────────────────────────────────────────────────

const wireSvg = (surface) => surface.querySelector(".wire-svg");

/** Add a wire straight into the doc and let WireLayer render it. */
function seedWire(doc, from, to) {
  const wire = doc.addWire({ from, to });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  return wire;
}

test("wire-endpoint drag: re-ends a grabbed cap onto a new free hole", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a20"); // (1,12) … (20,12)

  // Grab the 'from' cap: viewport pointerdown at world (1,12).
  world.x = 1;
  world.y = 12;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  // Drag it to the free hole b1 (1,11); move/up ride the persistent wire SVG.
  world.x = 1;
  world.y = 11;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.equal(doc.getWire(wire.id).from, "bb1.b1");
  assert.equal(
    doc.getWire(wire.id).to,
    "bb1.a20",
    "the other end is untouched",
  );
});

test("wire-endpoint drag: an illegal target (occupied) leaves the wire alone", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a20");
  // Drag 'to' (20,12) onto a1 (1,12) — the wire's own other end.
  world.x = 20;
  world.y = 12;
  fire(viewport, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 1;
  world.y = 12;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.equal(doc.getWire(wire.id).to, "bb1.a20", "reverted");
});

test("whole-wire drag: both ends translate rigidly onto new holes", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = seedWire(doc, "bb1.a1", "bb1.a5"); // (1,12) … (5,12)
  const body = surface.querySelector(`.wire[data-wire-id="${wire.id}"]`);

  // Grab the body at its midpoint (3,12) — clear of both caps — and shift it
  // three rows up: a(y12) → d(y9), so a1→d1 and a5→d5.
  world.x = 3;
  world.y = 12;
  fire(body, "pointerdown", { id: 9, client: [0, 0] });
  world.x = 3;
  world.y = 9;
  fire(wireSvg(surface), "pointermove", { id: 9, client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { id: 9, client: [40, 40] });

  assert.deepEqual(
    { from: doc.getWire(wire.id).from, to: doc.getWire(wire.id).to },
    { from: "bb1.d1", to: "bb1.d5" },
  );
});

// ── Placement (arm → click to commit) ───────────────────────────────────────

/** Arm a tool, then click at world `at` to commit — a placement gesture. */
function placeClick(viewport, world, at) {
  world.x = at.x;
  world.y = at.y;
  // pointerdown records the click origin (so the click isn't taken for a pan),
  // then the click commits at the armed ghost's seat.
  fire(viewport, "pointerdown", { id: 11, client: [5, 5] });
  viewport.dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }),
  );
}

test("placement: arming a kit and clicking drops it at the cursor", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);

  controller.armPlacement("full");
  assert.ok(controller.placementArmed);
  placeClick(viewport, world, { x: 20, y: 20 });

  assert.equal(doc.boards.length, 3, "the full kit's three strips landed");
  assert.ok(
    !controller.placementArmed,
    "and placement disarmed after the drop",
  );
});

test("placement: arming a part and clicking seats it on the board", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);

  controller.armChipPlacement("7400");
  // Click over the trench around column 8 (trench centre y 6.5).
  placeClick(viewport, world, { x: 8, y: 6.5 });

  assert.equal(doc.components.length, 1);
  assert.equal(doc.components[0].ref, "7400");
  assert.equal(doc.components[0].kind, "chip");
});
