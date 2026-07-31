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

// jsdom tests for dragging an already-laid bus (Feature 130 follow-up): the
// ribbon's own body (grab anywhere along it) translates the WHOLE bus, both
// ends together; each of its two end handles translates just that one end's
// leads, in parallel, the other end staying put. A member wire's own cap
// re-routes exactly like any wire's EXCEPT right where it would be confused
// with that bus's end-handle: the handle's collar sits at a fixed offset
// from the bus's CENTROID, not from any particular member's hole, so most
// members' caps are nowhere near it — but the rare one that coincides
// (measured, not hypothetical: a collar can land within a couple of screen
// px of one member's own cap) would otherwise flip a coin between "grab the
// handle" and "re-route this one wire" every time it's pressed. So THAT one
// end, on THAT one member, declines its own drag — the far end of the same
// wire, and every other member, drag freely. Whole-body translate (grab the
// lead's middle to translate both its ends rigidly) stays off for every
// member regardless — a ~16px lead has little to translate, and it was
// never actually the source of the ambiguity (DOM z-order already puts the
// handle on top of a lead's hit-stroke).

import test from "node:test";
import assert from "node:assert/strict";

import { spec } from "../model/breadboard.js";
import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
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

/** Move the "cursor" to (x, y) pitch units and click the viewport there. */
function clickAt(viewport, world, x, y) {
  world.x = x;
  world.y = y;
  viewport.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true }),
  );
  viewport.dispatchEvent(
    new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/** Dispatch one pointer event of `type` on `el`, at client point + modifiers. */
function fire(el, type, { id = 9, client = [0, 0], mods = {} } = {}) {
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

const wireSvg = (surface) => surface.querySelector(".wire-svg");

/** Lay a 4-bit run bus on one board: bb1.a10..a13 -> bb1.a20..a23. */
function layBus(viewport, world, controller) {
  controller.setBusName("D[3:0]");
  controller.armBusTool();
  clickAt(viewport, world, 10, ROW.a); // anchor a10
  clickAt(viewport, world, 20, ROW.a); // land a20
  controller.disarmBusTool();
}

function pairsOf(doc, bus) {
  return bus.members.map((id) => {
    const w = doc.getWire(id);
    return [w.from, w.to];
  });
}

// Grid rows moved when the vertical geometry became MEASURED (board-types.js):
// a pin-board's plastic is 35.6 mm, so its rows sit 1.51 pitch below the top
// edge rather than 1, and row a is at 12.51. Fixtures name the row instead of
// its old integer y, so a re-measurement moves them all at once.
const ROW = spec("pins-full").rowY;

test("whole-bus drag (grab the ribbon body): both ends translate together", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];

  const band = surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`);
  assert.ok(band, "the ribbon rendered");

  // Anchor the press far from any real wire endpoint (wireEndNear has global
  // priority within its 0.6-pitch radius, so starting ON top of a hole would
  // grab that one wire instead) — only the START->MOVE delta matters, so any
  // safe anchor works. Shift three rows' worth up: a(y12) -> d(y9).
  world.x = 100;
  world.y = 100;
  fire(band, "pointerdown");
  world.x = 100;
  world.y = 97;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), [
    ["bb1.d10", "bb1.d20"],
    ["bb1.d11", "bb1.d21"],
    ["bb1.d12", "bb1.d22"],
    ["bb1.d13", "bb1.d23"],
  ]);
});

test("a bus drag released into a RUNNING circuit reverts instead of committing", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const before = pairsOf(doc, bus);

  const band = surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`);
  world.x = 100;
  world.y = 100;
  fire(band, "pointerdown");
  world.x = 100;
  world.y = 97;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });

  // Space / ⌘R reach the transport mid-gesture — app.js only declines them for
  // an armed TOOL, and a drag is not one. Every DeskController drag treats a
  // run starting under it as a cancel; this one used to commit anyway, moving
  // eight wire ends with the simulation already live.
  controller.setEditingLocked(true);
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), before, "topology is frozen while running"); // prettier-ignore
});

test("end-handle drag: grabbing the 'to' end moves only that side, in parallel", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];

  const handle = surface.querySelector(
    `.bus-end-handle[data-bus-id="${bus.id}"][data-end="to"]`,
  );
  assert.ok(handle, "the 'to' end handle rendered");

  // Anchor far from any real wire endpoint (see the whole-bus test above for
  // why) and shift by +2 columns; the 'from' side must stay untouched.
  world.x = 100;
  world.y = 100;
  fire(handle, "pointerdown");
  world.x = 102;
  world.y = 100;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), [
    ["bb1.a10", "bb1.a22"],
    ["bb1.a11", "bb1.a23"],
    ["bb1.a12", "bb1.a24"],
    ["bb1.a13", "bb1.a25"],
  ]);
});

test("end-handle drag: grabbing the 'from' end moves only that side", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];

  const handle = surface.querySelector(
    `.bus-end-handle[data-bus-id="${bus.id}"][data-end="from"]`,
  );
  assert.ok(handle, "the 'from' end handle rendered");

  // Anchor far from any real wire endpoint; shift the 'from' side up one
  // row: a(y12) -> b(y11). 'to' stays put.
  world.x = 100;
  world.y = 100;
  fire(handle, "pointerdown");
  world.x = 100;
  world.y = 99;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), [
    ["bb1.b10", "bb1.a20"],
    ["bb1.b11", "bb1.a21"],
    ["bb1.b12", "bb1.a22"],
    ["bb1.b13", "bb1.a23"],
  ]);
});

test("end-handle drag: a near-miss (one lead collides) snaps the whole batch to a nearby free row", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];

  // Occupy a24 (row a, col 24, via its own cross-trench wire) so a +4 shift
  // of the 'to' end (a20..a23 -> a24..a27) collides on bit0's target. The
  // nearest delta where ALL FOUR land free (SNAP_RADIUS recovery,
  // bus-tools.js) is one row up: b24..b27.
  doc.addWire({ from: "bb1.j24", to: "bb1.a24", color: "red" });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));

  const handle = surface.querySelector(
    `.bus-end-handle[data-bus-id="${bus.id}"][data-end="to"]`,
  );
  world.x = 100;
  world.y = 100;
  fire(handle, "pointerdown");
  world.x = 104;
  world.y = 100;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), [
    ["bb1.a10", "bb1.b24"],
    ["bb1.a11", "bb1.b25"],
    ["bb1.a12", "bb1.b26"],
    ["bb1.a13", "bb1.b27"],
  ]);
});

test("end-handle drag: a release well beyond SNAP_RADIUS still finds the nearest legal delta", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller); // D[3:0]: a10..a13 -> a20..a23
  const bus = doc.buses[0];

  // Shift the 'to' end by +50 columns — off the board's right edge (its
  // last column is 63), 10 columns past anything SNAP_RADIUS (2) — the
  // LIVE preview's own cheap search bound — could ever recover. The
  // nearest legal shift that keeps every member on the board is +40
  // (a60..a63, the board's last four columns), so landing there correctly
  // can only come from the one-time unbounded fallback #onBusUp runs when
  // the live preview found nothing, not the per-move search itself.
  const handle = surface.querySelector(
    `.bus-end-handle[data-bus-id="${bus.id}"][data-end="to"]`,
  );
  world.x = 100;
  world.y = 100;
  fire(handle, "pointerdown");
  world.x = 150;
  world.y = 100;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), [
    ["bb1.a10", "bb1.a60"],
    ["bb1.a11", "bb1.a61"],
    ["bb1.a12", "bb1.a62"],
    ["bb1.a13", "bb1.a63"],
  ]);
});

test("end-handle drag: dropped somewhere with nothing legal anywhere nearby reverts", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const before = pairsOf(doc, bus);

  // Drag the 'to' end far off the board entirely — a delta well beyond even
  // the end-handle's unbounded search's DEFAULT_SEARCH_RADIUS, so there's
  // genuinely nothing to recover onto.
  const handle = surface.querySelector(
    `.bus-end-handle[data-bus-id="${bus.id}"][data-end="to"]`,
  );
  world.x = 100;
  world.y = 100;
  fire(handle, "pointerdown");
  world.x = 1000;
  world.y = 1000;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), before, "nothing moved");
});

test("a member's cap right at the bus's own collar still declines its drag", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller); // D[3:0]: a10..a13 -> a20..a23
  const bus = doc.buses[0];
  const bit0 = doc.getWire(bus.members[0]); // bb1.a10 -> bb1.a20

  // bit0's 'to' cap (a20) sits ~1 world px from the 'to' collar in this
  // layout (the centroid of a20..a23 is 21.5, and the collar sits 1.6 pitch
  // back from that, toward a20) — the exact overlap the handle must win.
  world.x = 20;
  world.y = ROW.a;
  fire(viewport, "pointerdown");
  world.x = 20;
  world.y = ROW.b;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.equal(doc.getWire(bit0.id).from, "bb1.a10");
  assert.equal(doc.getWire(bit0.id).to, "bb1.a20", "unchanged — no re-route");
});

test("a member's cap FAR from any collar drags exactly like an ordinary wire", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller); // D[3:0]: a10..a13 -> a20..a23
  const bus = doc.buses[0];
  const bit0 = doc.getWire(bus.members[0]); // bb1.a10 -> bb1.a20

  // bit0's 'from' cap (a10) sits ~31 world px from the 'from' collar (~13.1)
  // — well clear of HANDLE_HIT_RADIUS — so it re-routes like any wire's end.
  world.x = 10;
  world.y = ROW.a;
  fire(viewport, "pointerdown");
  world.x = 10;
  world.y = ROW.b;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.equal(doc.getWire(bit0.id).from, "bb1.b10", "re-routed");
  assert.equal(
    doc.getWire(bit0.id).to,
    "bb1.a20",
    "the other end is untouched",
  );
});

test("a member wire's body is no longer draggable (whole-wire translate is a no-op)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const bit0 = doc.getWire(bus.members[0]);
  const body = surface.querySelector(`.wire[data-wire-id="${bit0.id}"]`);

  // Grab the rendered lead's body (not either cap) and try to translate it.
  world.x = 15;
  world.y = ROW.a;
  fire(body, "pointerdown");
  world.x = 15;
  world.y = ROW.d;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(
    { from: doc.getWire(bit0.id).from, to: doc.getWire(bit0.id).to },
    { from: "bb1.a10", to: "bb1.a20" },
    "unchanged — no translate",
  );
});

test("a press on a member's cap re-routes the wire, never the board beneath it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const bit0 = doc.getWire(bus.members[0]);
  const board = surface.querySelector('[data-board-id="bb1"]');
  const y0 = doc.getBoard("bb1").y;

  // bit0's 'from' cap sits ON hole a10 — a press there lands on the board SVG
  // beneath (caps are pointer-events:none), the exact case #onBoardPointerDown
  // special-cases for wires: give the (far-from-any-collar, so undeclined)
  // wire endpoint priority over the board underneath it.
  world.x = 10;
  world.y = ROW.a;
  fire(board, "pointerdown");
  world.x = 10;
  world.y = ROW.d;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.equal(doc.getWire(bit0.id).from, "bb1.d10", "the wire re-routed");
  assert.equal(doc.getBoard("bb1").y, y0, "the board did not move");
});

test("a press on a NEAR-COLLAR member's cap absorbs without a board drag either", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const bit0 = doc.getWire(bus.members[0]);
  const board = surface.querySelector('[data-board-id="bb1"]');
  const y0 = doc.getBoard("bb1").y;

  // bit0's 'to' cap (a20) IS near the 'to' collar (see the decline test
  // above) — its own drag is declined, so #capNear must still absorb the
  // press (WireTools#capNear is membership-blind) rather than falling
  // through to a board drag.
  world.x = 20;
  world.y = ROW.a;
  fire(board, "pointerdown");
  world.x = 20;
  world.y = ROW.d;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.equal(doc.getWire(bit0.id).to, "bb1.a20", "the wire did not move");
  assert.equal(doc.getBoard("bb1").y, y0, "the board did not move either");
});

test("clicking a member wire still selects it (only dragging is disabled)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const bit0 = doc.getWire(bus.members[0]);
  const body = surface.querySelector(`.wire[data-wire-id="${bit0.id}"]`);

  body.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(controller.selectedId, bit0.id);
});

// ── Escape recovers a stuck drag (a real pointerup the browser silently ────
// dropped is not hypothetical — see DeskController#cancelDragGesture) ───────

test("Escape mid end-handle drag aborts it, and a fresh drag works right after", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const before = pairsOf(doc, bus);

  const handle = surface.querySelector(
    `.bus-end-handle[data-bus-id="${bus.id}"][data-end="to"]`,
  );

  // Press and move past the threshold, but NEVER release — this is exactly
  // what a dropped pointerup leaves behind: a live drag with no way to reach
  // its own up-handler again.
  world.x = 100;
  world.y = 100;
  fire(handle, "pointerdown");
  world.x = 102;
  world.y = 100;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  assert.ok(
    viewport.classList.contains("desk-viewport--wire-dragging"),
    "the gesture is live",
  );

  const consumed = controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Escape" }),
  );
  assert.equal(consumed, true, "Escape aborts the stuck drag");
  assert.deepEqual(pairsOf(doc, bus), before, "nothing committed");
  assert.ok(
    !viewport.classList.contains("desk-viewport--wire-dragging"),
    "the dragging cursor/class cleared",
  );

  // The gesture system must be fully usable again — the exact complaint was
  // "can't get back to dragging or get out of the partial drag mode". The
  // abort's render() rebuilt the SVG, so re-query the (now different) handle
  // element rather than reuse the stale, detached reference.
  const handle2 = surface.querySelector(
    `.bus-end-handle[data-bus-id="${bus.id}"][data-end="to"]`,
  );
  world.x = 100;
  world.y = 100;
  fire(handle2, "pointerdown");
  world.x = 103;
  world.y = 100;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), [
    ["bb1.a10", "bb1.a23"],
    ["bb1.a11", "bb1.a24"],
    ["bb1.a12", "bb1.a25"],
    ["bb1.a13", "bb1.a26"],
  ]);
});

test("Escape mid whole-bus (ribbon) drag aborts it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const before = pairsOf(doc, bus);
  const band = surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`);

  world.x = 100;
  world.y = 100;
  fire(band, "pointerdown");
  world.x = 100;
  world.y = 97;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });

  controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Escape" }),
  );
  assert.deepEqual(pairsOf(doc, bus), before, "nothing committed");
  assert.ok(!viewport.classList.contains("desk-viewport--wire-dragging"));
});

test("Escape mid whole-wire (non-bus) drag aborts it — the shared plumbing", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  const wire = doc.addWire({ from: "bb1.a1", to: "bb1.a5" });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  const body = surface.querySelector(`.wire[data-wire-id="${wire.id}"]`);

  world.x = 3;
  world.y = ROW.a;
  fire(body, "pointerdown");
  world.x = 3;
  world.y = ROW.d;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });

  controller.handleKeyDown(
    new window.KeyboardEvent("keydown", { key: "Escape" }),
  );
  assert.deepEqual(
    { from: doc.getWire(wire.id).from, to: doc.getWire(wire.id).to },
    { from: "bb1.a1", to: "bb1.a5" },
    "nothing committed",
  );
});

// ── Not missing the drop (the "it only lands 50-70% of the time" follow-up) ──
// Two independent holes let a real drop vanish, both fixed here. One: the
// commit used to replay whatever the last pointermove had resolved, and moves
// are coalesced — the sample can be frames stale, and a stale sample sitting
// somewhere illegal silently reverted the whole drag. Two: the gesture's
// listeners hung on the wire SVG alone and rode on `setPointerCapture`
// holding, while app.css turns off every hit target inside that SVG for the
// duration of a drag — so a release that landed anywhere else (the bare desk
// under a bus dragged off the board, most obviously) reached no handler at
// all and left the drag live, Escape the only way out. See
// components/pointer-gesture.js.

test("the drop resolves at the RELEASE point, not at the last pointermove", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const band = surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`);

  world.x = 100;
  world.y = 100;
  fire(band, "pointerdown");
  // The last move the app got to process lands two rows up (a -> c) ...
  world.x = 100;
  world.y = 98;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  // ... but the pointer was actually let go one row further (a -> d). A
  // coalesced/stale move stream must not decide where the bus lands.
  world.y = 97;
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });

  assert.deepEqual(pairsOf(doc, bus), [
    ["bb1.d10", "bb1.d20"],
    ["bb1.d11", "bb1.d21"],
    ["bb1.d12", "bb1.d22"],
    ["bb1.d13", "bb1.d23"],
  ]);
});

test("a release outside the wire SVG (over the bare desk) still drops the bus", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const band = surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`);

  world.x = 100;
  world.y = 100;
  fire(band, "pointerdown");
  world.y = 97;
  fire(viewport, "pointermove", { client: [40, 40] });
  fire(viewport, "pointerup", { client: [40, 40] });

  assert.deepEqual(
    pairsOf(doc, bus),
    [
      ["bb1.d10", "bb1.d20"],
      ["bb1.d11", "bb1.d21"],
      ["bb1.d12", "bb1.d22"],
      ["bb1.d13", "bb1.d23"],
    ],
    "the release reached the gesture even though it never touched the SVG",
  );
  assert.ok(!viewport.classList.contains("desk-viewport--wire-dragging"));
});

test("a yanked pointer capture aborts the drag instead of leaving it live", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const before = pairsOf(doc, bus);
  const band = surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`);

  world.x = 100;
  world.y = 100;
  fire(band, "pointerdown");
  world.y = 97;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  // The browser takes the pointer back with no up/cancel behind it — the one
  // signal it gives for "this gesture is over and you'll hear nothing more".
  fire(wireSvg(surface), "lostpointercapture");

  assert.deepEqual(pairsOf(doc, bus), before, "nothing committed");
  assert.ok(
    !viewport.classList.contains("desk-viewport--wire-dragging"),
    "the gesture tore down rather than staying live",
  );

  // And the next drag works — a yanked capture must not wedge the app.
  const band2 = surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`);
  world.y = 100;
  fire(band2, "pointerdown");
  world.y = 98;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  fire(wireSvg(surface), "pointerup", { client: [40, 40] });
  assert.deepEqual(pairsOf(doc, bus), [
    ["bb1.c10", "bb1.c20"],
    ["bb1.c11", "bb1.c21"],
    ["bb1.c12", "bb1.c22"],
    ["bb1.c13", "bb1.c23"],
  ]);
});

test("a rigid whole-bus drag shifts the rendered nodes instead of rebuilding them", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const { viewport, surface, controller } = makeDesk(doc, world);
  controller.addBoardAt("pins-full", 0, 0);
  layBus(viewport, world, controller);
  const bus = doc.buses[0];
  const band = surface.querySelector(`.bus-band[data-bus-id="${bus.id}"]`);
  const memberId = bus.members[0];

  world.x = 100;
  world.y = 100;
  fire(band, "pointerdown");
  world.y = 99;
  fire(wireSvg(surface), "pointermove", { client: [40, 40] });
  const member = surface.querySelector(`.wire[data-wire-id="${memberId}"]`);
  assert.ok(
    member.getAttribute("transform"),
    "the first move renders + shifts",
  );

  // Every later move is a transform on the SAME nodes — no rebuild of every
  // wire in the document (with its listeners) per pointermove.
  world.y = 97;
  fire(wireSvg(surface), "pointermove", { client: [41, 41] });
  assert.equal(
    surface.querySelector(`.wire[data-wire-id="${memberId}"]`),
    member,
    "the member wire's group survived the move",
  );
  assert.equal(
    member.getAttribute("transform"),
    `translate(0 ${-3 * PX_PER_UNIT})`,
  );

  // Ending the drag clears the shift and redraws from the document.
  fire(wireSvg(surface), "pointerup", { client: [41, 41] });
  const settled = surface.querySelector(`.wire[data-wire-id="${memberId}"]`);
  assert.equal(settled.getAttribute("transform"), null);
  assert.equal(doc.getWire(memberId).from, "bb1.d10");
  assert.ok(!viewport.classList.contains("desk-viewport--wire-dragging"));
});
