/*
 * Copyright 2025 Jason Figge
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

// "It only lands some of the time" — the DESK half of the follow-up
// bus-drag.test.js already covers for the wire/bus gestures. Every drag in
// DeskController used to hang its pointermove/up/cancel listeners on the
// DRAGGED ELEMENT in the bubble phase and commit whatever its last
// `pointermove` had computed. Both halves of that are wrong, independently:
//
//   • Chromium COALESCES pointermove at speed — one event per frame, the
//     samples in between folded into getCoalescedEvents(). So the last move
//     the app processed can be frames behind where the button actually came
//     up, and a drop resolved from it lands at a point the user had already
//     moved past. For the part drag it is worse than a near miss: the move
//     handler leaves d.legal false whenever its sample fell off-board while
//     KEEPING d.seat at the last good seat, so a release caught mid-flight
//     over the trench silently REVERTED a perfectly legal reseat.
//   • Element-scoped listeners make `setPointerCapture` the release's only
//     delivery route, with no backstop when it throws or is yanked.
//
// So these drive the three cases the old shape could not survive — a release
// point that disagrees with the last move, a release that never touches the
// dragged element, and a capture taken away with no up/cancel behind it —
// against every drag DeskController owns. See components/pointer-gesture.js.
//
// Note a thrown error inside these handlers is SWALLOWED (they run as window
// event listeners), so a broken release path shows up only as "nothing
// committed" — which is precisely what every assertion here is shaped to
// catch.

import test from "node:test";
import assert from "node:assert/strict";

import { spec } from "../model/breadboard.js";
import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { partPinAddresses } from "../model/occupancy.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

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
const annEl = (surface, id) => surface.querySelector(`[data-ann-id="${id}"]`);

/** Dispatch one pointer event of `type` on `el`, at client point + modifiers. */
function fire(el, type, { id = 5, client = [0, 0], mods = {} } = {}) {
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
 * Press on `el` at world `from`, let the app see ONE move at world `stale`,
 * then release at world `at` — the divergence a coalesced move stream causes.
 * `upOn` defaults to the grabbed element; pass the viewport to also prove the
 * release does not depend on the capture holding.
 */
function dragReleasingAt(
  el,
  world,
  { from, stale, at, upOn = el, id = 5, downMods = {} },
) {
  world.x = from.x;
  world.y = from.y;
  // `downMods` goes on the PRESS alone — every modifier a desk drag reads is
  // read there and frozen (the board drag's tear-off, the part drag's wiring).
  fire(el, "pointerdown", { id, client: [0, 0], mods: downMods });
  world.x = stale.x;
  world.y = stale.y;
  fire(el, "pointermove", { id, client: [40, 40] });
  world.x = at.x;
  world.y = at.y;
  fire(upOn, "pointerup", { id, client: [40, 40] });
}

// ── Board drag ──────────────────────────────────────────────────────────────

// Grid rows moved when the vertical geometry became MEASURED (board-types.js):
// a pin-board's plastic is 35.6 mm, so its rows sit 1.51 pitch below the top
// edge rather than 1, and row a is at 12.51. Fixtures name the row instead of
// its old integer y, so a re-measurement moves them all at once.
const ROW = spec("pins-full").rowY;

test("board drag: the drop lands at the RELEASE point, not the last move", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  assert.ok(controller);

  dragReleasingAt(boardEl(surface, "bb1"), world, {
    from: { x: 0, y: 0 },
    stale: { x: 5, y: 0 }, // the last frame the app got to process…
    at: { x: 8, y: 0 }, // …but the pointer was let go three pitches on
  });

  assert.equal(doc.getBoard("bb1").x, 8);
});

test("board drag: a release over the bare desk still drops the board", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, surface } = makeDesk(doc, world);

  dragReleasingAt(boardEl(surface, "bb1"), world, {
    from: { x: 0, y: 0 },
    stale: { x: 8, y: 0 },
    at: { x: 8, y: 0 },
    upOn: viewport, // never touches the board element
  });

  assert.equal(doc.getBoard("bb1").x, 8, "the release reached the gesture");
  assert.ok(!viewport.classList.contains("desk-viewport--dragging"));
});

test("board drag: a yanked capture aborts, and the next drag still works", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, surface } = makeDesk(doc, world);

  const el = boardEl(surface, "bb1");
  world.x = 0;
  world.y = 0;
  fire(el, "pointerdown");
  world.x = 8;
  fire(el, "pointermove", { client: [40, 40] });
  // The browser takes the pointer back with no up/cancel behind it.
  fire(el, "lostpointercapture");

  assert.equal(doc.getBoard("bb1").x, 0, "nothing committed");
  assert.ok(
    !viewport.classList.contains("desk-viewport--dragging"),
    "the gesture tore down rather than staying live",
  );

  dragReleasingAt(boardEl(surface, "bb1"), world, {
    from: { x: 0, y: 0 },
    stale: { x: 3, y: 0 },
    at: { x: 6, y: 0 },
  });
  assert.equal(doc.getBoard("bb1").x, 6, "a yanked capture did not wedge it");
});

// ── Part drag — the headline ────────────────────────────────────────────────

test("part drag: a stale OFF-BOARD move must not revert a legal drop", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11

  // The last move the app processed caught the chip mid-flight, off the board
  // entirely — #partSeatAt finds nothing there, so d.legal goes false while
  // d.seat stays where it was. Releasing over a legal hole must still land.
  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 60 }, // nowhere near a row
    at: { x: 13, y: 6.5 }, // e10 — free, legal
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
});

test("part drag: a release over BARE DESK does not commit a legal last move", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");

  // The inverse of the test above — the re-resolve has to flip legality BOTH
  // ways, or it would just be a different stale sample winning.
  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 6.5 }, // e10 — legal
    at: { x: 13, y: 60 }, // let go off the board
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "stayed put");
});

test("OPTION part drag: the riding wires land at the RELEASE point too", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  doc.addWire({ from: "bb1.a5", to: "bb1.a40" }); // rides under pin 1

  // The whole point of this suite, now with a batch behind it: the plan is
  // re-derived at the release point, so a stale off-board sample cannot commit
  // the wires to where the part merely passed through.
  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 60 }, // nowhere near a row
    at: { x: 13, y: 6.5 }, // e10 — five columns right
    downMods: { altKey: true },
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(doc.getWire("w1").from, "bb1.a10", "the rider came along");
  assert.equal(doc.getWire("w1").to, "bb1.a40", "the far end stayed put");
});

test("OPTION part drag: an unseatable rider reverts the WHOLE drop", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  doc.addWire({ from: "bb1.a11", to: "bb1.a40" }); // rides, from the last column
  doc.addWire({ from: "bb1.a16", to: "bb1.a41" }); // squarely where it would land

  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 6.5 },
    at: { x: 13, y: 6.5 }, // e10 — the rider would need a16
    downMods: { altKey: true },
  });

  // The chip's OWN seat is perfectly legal there; it is refused because its
  // wiring cannot follow, and half a move is no move.
  assert.equal(doc.getComponent(chip.id).anchor, "e5", "the part stayed put");
  assert.equal(doc.getWire("w1").from, "bb1.a11", "and so did its wire");
});

test("OPTION part drag: the modifier is read at PRESS, then frozen", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  doc.addWire({ from: "bb1.a5", to: "bb1.a40" });

  // Option down for the press, released before the move and the drop: the wiring
  // still comes, because what a drag carries is settled when it is picked up.
  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 6.5 },
    at: { x: 13, y: 6.5 },
    downMods: { altKey: true },
  });
  assert.equal(doc.getWire("w1").from, "bb1.a10");
});

test("part drag WITHOUT Option leaves the wiring where it was", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  doc.addWire({ from: "bb1.a5", to: "bb1.a40" });

  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 6.5 },
    at: { x: 13, y: 6.5 },
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(doc.getWire("w1").from, "bb1.a5", "a plain drag is unchanged");
});

test("part drag: a release over the bare desk viewport still re-seats", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");

  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 6.5 },
    at: { x: 13, y: 6.5 },
    upOn: viewport,
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
});

test("part drag: a yanked capture aborts without committing", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");

  const el = partEl(surface, chip.id);
  world.x = 8;
  world.y = 6.5;
  fire(el, "pointerdown");
  world.x = 13;
  fire(el, "pointermove", { client: [40, 40] });
  fire(el, "lostpointercapture");

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "nothing committed");
  assert.ok(!viewport.classList.contains("desk-viewport--dragging"));

  // …and the part is still draggable afterwards.
  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 10, y: 6.5 },
    at: { x: 13, y: 6.5 },
  });
  assert.equal(doc.getComponent(chip.id).anchor, "e10");
});

// ── Brick (PSU / clock) drag ────────────────────────────────────────────────

test("brick drag: the PSU lands at the release point, element included", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const psu = controller.addBrickAt("psu", 0, 0);
  const { x: x0, y: y0 } = doc.getComponent(psu.id);

  dragReleasingAt(partEl(surface, psu.id), world, {
    from: { x: 1, y: ROW.j },
    stale: { x: 11, y: 6 },
    at: { x: 21, y: ROW.b },
  });

  const moved = doc.getComponent(psu.id);
  assert.equal(moved.x, x0 + 20);
  assert.equal(moved.y, y0 + 10);
  // A part view is not re-rendered by doc-changed, so the DOM has to have been
  // pushed the re-resolved position explicitly — otherwise the document would
  // commit the release point while the brick sat at the stale one.
  const style = partEl(surface, psu.id).style;
  assert.equal(style.left, `${(x0 + 20) * PX_PER_UNIT}px`);
  assert.equal(style.top, `${(y0 + 10) * PX_PER_UNIT}px`);
});

// ── Resistor drags (rigid body, and one end) ────────────────────────────────

test("resistor body drag: the rigid delta is taken at the release point", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "e10"); // e10 ── e13

  dragReleasingAt(partEl(surface, r.id), world, {
    from: { x: 0, y: 0 },
    stale: { x: 1, y: 0 }, // would land e11
    at: { x: 2, y: 0 }, // let go one pitch further
  });

  assert.equal(doc.getComponent(r.id).anchor, "e12");
});

test("resistor end drag: a stale sample INSIDE the minimum span must not revert it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const r = controller.addComponentAt("resistor", "bb1", "a10"); // a10 ── a13

  // The stale sample sits one hole from pin 1 — inside the 3-unit minimum lead
  // span, so canPlacePart rejects it and d.target goes null. This is the case
  // where a stale move doesn't merely misplace the lead: it fails the span
  // check and throws the whole drag away.
  dragReleasingAt(partEl(surface, r.id), world, {
    from: { x: 13, y: ROW.a }, // grab pin 2
    stale: { x: 11, y: ROW.a }, // illegal — too close
    at: { x: 15, y: ROW.a }, // released well clear
  });

  const comp = doc.getComponent(r.id);
  assert.equal(comp.anchor, "a10", "the untouched end never moved");
  assert.deepEqual(comp.params.end, { dx: 5, dy: 0 });
  assert.deepEqual(partPinAddresses(doc, comp), [
    { pin: 1, address: "bb1.a10" },
    { pin: 2, address: "bb1.a15" },
  ]);
});

// ── Annotation drag ─────────────────────────────────────────────────────────

test("annotation drag: the label lands where it was let go", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const ann = doc.addAnnotation("note", 0, 0, "hello");
  const world = { x: 0, y: 0 };
  const { surface } = makeDesk(doc, world);

  dragReleasingAt(annEl(surface, ann.id), world, {
    from: { x: 0, y: 0 },
    stale: { x: 4, y: ROW.g },
    at: { x: 9, y: 7 },
  });

  const moved = doc.getAnnotation(ann.id);
  assert.equal(moved.x, 9);
  assert.equal(moved.y, 7);
});

test("annotation drag: a release off the label still commits (no e.currentTarget)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const ann = doc.addAnnotation("note", 0, 0, "hello");
  const world = { x: 0, y: 0 };
  const { viewport, surface } = makeDesk(doc, world);

  // The up-handler used to read `e.currentTarget` for its teardown, which
  // under a window capture-phase listener is `window` — the one migration
  // step that changed a handler's data source, so it gets its own test.
  dragReleasingAt(annEl(surface, ann.id), world, {
    from: { x: 0, y: 0 },
    stale: { x: 9, y: 7 },
    at: { x: 9, y: 7 },
    upOn: viewport,
  });

  assert.equal(doc.getAnnotation(ann.id).x, 9);
  assert.ok(
    !viewport.classList.contains("desk-viewport--dragging"),
    "the drag is not still live",
  );
});

// ── Marquee ─────────────────────────────────────────────────────────────────

test("marquee: the band is re-drawn at the release point before selecting", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11

  const mods = { shiftKey: true };
  world.x = 4;
  world.y = ROW.g;
  fire(viewport, "pointerdown", { id: 7, mods });
  // The last move stops at column 8 — the chip's right-hand pins fall outside,
  // so a rect taken from it selects NOTHING.
  world.x = 8;
  world.y = ROW.d;
  fire(viewport, "pointermove", { id: 7, client: [60, 60], mods });
  // The band was actually let go past the chip's far edge.
  world.x = 12;
  fire(viewport, "pointerup", { id: 7, client: [60, 60], mods });

  assert.deepEqual(controller.multiSelectedIds, [chip.id]);
});

test("marquee: a release outside the viewport still applies the selection", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");

  const mods = { shiftKey: true };
  world.x = 4;
  world.y = ROW.g;
  fire(viewport, "pointerdown", { id: 7, mods });
  world.x = 12;
  world.y = ROW.d;
  fire(document.body, "pointermove", { id: 7, client: [60, 60], mods });
  fire(document.body, "pointerup", { id: 7, client: [60, 60], mods });

  assert.deepEqual(controller.multiSelectedIds, [chip.id]);
  assert.ok(!viewport.classList.contains("desk-viewport--selecting"));
});

// ── Cluster drag (a multi-selection moved as one) ───────────────────────────

/** ⌘/Ctrl-click each id in turn — from nothing, since placing a part leaves it
    selected and a toggle would take it back OUT of the set. */
function selectMany(controller, ids) {
  controller.deselect();
  for (const id of ids) controller.toggleComponentSelection(id);
}

/** A chip, a push button, and a wire joining them. */
function clusterDesk(surface, controller, doc) {
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5"); // cols 5–11
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  doc.addWire({ from: "bb1.a5", to: "bb1.b30" }); // rides BOTH members
  selectMany(controller, [chip.id, btn.id]);
  return { chip, btn, el: partEl(surface, chip.id) };
}

test("cluster drag: the whole group lands at the RELEASE point", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const { chip, btn, el } = clusterDesk(surface, controller, doc);

  dragReleasingAt(el, world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 11, y: 6.5 }, // the last frame the app got to process…
    at: { x: 13, y: 6.5 }, // …but it was let go two columns further on
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(doc.getComponent(btn.id).anchor, "a35");
});

test("cluster drag: a release over bare desk commits nothing at all", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const { chip, btn, el } = clusterDesk(surface, controller, doc);

  dragReleasingAt(el, world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 6.5 }, // e10 — legal
    at: { x: 13, y: 60 }, // let go off the board
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e5", "stayed put");
  assert.equal(doc.getComponent(btn.id).anchor, "a30");
});

test("OPTION cluster drag: the riding wires land at the RELEASE point too", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  const { chip, btn, el } = clusterDesk(surface, controller, doc);

  dragReleasingAt(el, world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 60 }, // nowhere near a row
    at: { x: 13, y: 6.5 }, // e10 — five columns right
    downMods: { altKey: true },
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(doc.getComponent(btn.id).anchor, "a35");
  assert.equal(doc.getWire("w1").from, "bb1.a10");
  assert.equal(doc.getWire("w1").to, "bb1.b35", "carried by both members");
});

test("OPTION cluster drag: an unseatable rider reverts the WHOLE group", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const chip = controller.addComponentAt("74LS00", "bb1", "e5");
  const btn = controller.addComponentAt("sw-push", "bb1", "a30");
  doc.addWire({ from: "bb1.a11", to: "bb1.a40" }); // rides the chip's last column
  doc.addWire({ from: "bb1.a16", to: "bb1.a41" }); // squarely where it would land
  selectMany(controller, [chip.id, btn.id]);

  dragReleasingAt(partEl(surface, chip.id), world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 13, y: 6.5 },
    at: { x: 13, y: 6.5 }, // e10 — the rider would need a16
    downMods: { altKey: true },
  });

  // Every member's OWN seat is legal there; the group is refused because one
  // wire cannot follow, and half a move is no move.
  assert.equal(doc.getComponent(chip.id).anchor, "e5");
  assert.equal(
    doc.getComponent(btn.id).anchor,
    "a30",
    "and the button with it",
  );
  assert.equal(doc.getWire("w1").from, "bb1.a11");
});

test("cluster drag: the release still lands when the CAPTURE is yanked", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  const { chip, btn, el } = clusterDesk(surface, controller, doc);

  dragReleasingAt(el, world, {
    from: { x: 8, y: 6.5 },
    stale: { x: 11, y: 6.5 },
    at: { x: 13, y: 6.5 },
    upOn: viewport, // the release never reaches the grabbed part
  });

  assert.equal(doc.getComponent(chip.id).anchor, "e10");
  assert.equal(doc.getComponent(btn.id).anchor, "a35");
});

test("cluster drag: a scene rebuild mid-drag kills the gesture", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  const { chip, el } = clusterDesk(surface, controller, doc);

  world.x = 8;
  world.y = 6.5;
  fire(el, "pointerdown");
  world.x = 13;
  fire(el, "pointermove", { client: [40, 40] });

  controller.undo(); // unmounts every view the gesture was drawing into
  assert.ok(!viewport.classList.contains("desk-viewport--dragging"));

  world.x = 20;
  fire(viewport, "pointerup", { client: [40, 40] });
  assert.equal(doc.getComponent(chip.id)?.anchor, "e5", "no late commit");
});

// ── The risk the migration itself introduces ────────────────────────────────

test("a scene rebuild mid-drag kills the gesture before its views go", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);

  const el = boardEl(surface, "bb1");
  world.x = 0;
  world.y = 0;
  fire(el, "pointerdown");
  world.x = 8;
  fire(el, "pointermove", { client: [40, 40] });

  // Undo mid-drag unmounts every view. The gesture's listeners live on
  // `window` now, so unlike the old element-scoped ones they would SURVIVE
  // that and later commit against views that no longer exist.
  controller.undo();
  assert.equal(doc.boards.length, 0);
  assert.ok(!viewport.classList.contains("desk-viewport--dragging"));

  // The release that arrives afterwards must be inert, not a throw and not a
  // commit against the torn-down scene.
  world.x = 20;
  fire(viewport, "pointerup", { client: [40, 40] });
  assert.equal(doc.boards.length, 0);
});
