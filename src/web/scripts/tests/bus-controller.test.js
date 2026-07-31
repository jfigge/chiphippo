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

// jsdom test for the bus TOOL driven through DeskController (Feature 130): arm,
// click a start hole then an end hole, and a whole bus + its member wires land
// in one gesture; the bundle band selects the bus.

import test from "node:test";
import assert from "node:assert/strict";

import { spec } from "../model/breadboard.js";
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

/** Move the "cursor" to (x, y) pitch units and click the viewport there. */
function clickAt(viewport, world, x, y) {
  hoverAt(viewport, world, x, y);
  viewport.dispatchEvent(
    new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
  viewport.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

/** Move the "cursor" to (x, y) pitch units without pressing. */
function hoverAt(viewport, world, x, y) {
  world.x = x;
  world.y = y;
  viewport.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true }),
  );
}

/** The rings currently drawn on the desk: how many, and how many read illegal
    (the bus tool rings EVERY hole its click would claim, so a count is the
    thing under test — one ring per bit, or one per bit that exists). */
function rings(surface) {
  const shown = [...surface.querySelectorAll(".hole-ring:not([hidden])")];
  return {
    count: shown.length,
    illegal: shown.filter((r) => r.classList.contains("hole-ring--illegal"))
      .length,
  };
}

// Grid rows moved when the vertical geometry became MEASURED (board-types.js):
// a pin-board's plastic is 35.6 mm, so its rows sit 1.51 pitch below the top
// edge rather than 1, and row a is at 12.51. Fixtures name the row instead of
// its old integer y, so a re-measurement moves them all at once.
const ROW = spec("pins-full").rowY;

test("arming the bus tool and clicking start→end lays width wires + a band", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1, row a at y=12
  const { viewport, surface, controller, world } = makeDesk(doc);

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);

  controller.setBusName("D[3:0]"); // width 4
  controller.toggleBusTool();
  assert.equal(controller.busToolArmed, true);

  clickAt(viewport, world, 10, ROW.a); // anchor start on a10
  assert.equal(doc.wires.length, 0, "nothing laid on the first click");
  clickAt(viewport, world, 20, ROW.a); // land the run on a20

  // Four member wires, one bus, wired a10→a20 … a13→a23 in order.
  assert.equal(doc.wires.length, 4);
  assert.equal(doc.buses.length, 1);
  const bus = doc.buses[0];
  assert.equal(bus.name, "D[3:0]");
  assert.equal(bus.width, 4);
  assert.equal(bus.members.length, 4);
  const pairs = bus.members.map((id) => {
    const w = doc.getWire(id);
    return [w.from, w.to];
  });
  assert.deepEqual(pairs, [
    ["bb1.a10", "bb1.a20"],
    ["bb1.a11", "bb1.a21"],
    ["bb1.a12", "bb1.a22"],
    ["bb1.a13", "bb1.a23"],
  ]);
  assert.equal(changes, 1, "the whole run is ONE doc change");
  assert.equal(controller.busToolArmed, true, "stays armed for the next bus");

  // The bundle band renders in the wire layer and selects the bus on click.
  const band = surface.querySelector(".bus-band");
  assert.ok(band, "a bundle band is drawn");
  assert.equal(band.dataset.busId, bus.id);
  controller.disarmBusTool();
  band.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(controller.selectedId, bus.id);
});

test("the bus tool refuses to lay onto occupied holes (illegal landing)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  // Occupy a21 so a width-3 run from a10→a20 collides on its second bit.
  doc.addWire({ from: "bb1.a21", to: "bb1.j21", color: "red" });
  const { viewport, surface, controller, world } = makeDesk(doc);

  controller.setBusName("D[2:0]"); // width 3 → a20, a21, a22
  controller.armBusTool();
  clickAt(viewport, world, 10, ROW.a); // start a10
  clickAt(viewport, world, 20, ROW.a); // a21 is taken → illegal, nothing lays

  assert.equal(doc.buses.length, 0);
  assert.equal(doc.wires.length, 1, "only the pre-existing wire remains");
  // All three destination holes ring, in the danger colour: the run is what
  // was refused, not the one hole under the cursor.
  assert.deepEqual(rings(surface), { count: 3, illegal: 3 });
});

// ── Ringing the whole run, at BOTH ends of the gesture ──────────────────────
// A bus lands `width` leads at once, so the single hover ring the wire tool
// uses can't state its case: it says "this hole" where the question is "these
// eight". Every refusal below used to be silent — the click simply did
// nothing — which is indistinguishable from a dead tool.

test("hovering a start rings every hole the bus would claim", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { viewport, surface, controller, world } = makeDesk(doc);

  controller.setBusName("D[7:0]"); // width 8
  controller.armBusTool();
  hoverAt(viewport, world, 10, ROW.a); // a10 … a17, all free

  assert.deepEqual(rings(surface), { count: 8, illegal: 0 });
});

test("a start run that walks off the strip is REFUSED, ringing the shortfall", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // 63 columns
  const { viewport, surface, controller, world } = makeDesk(doc);

  controller.setBusName("D[7:0]"); // width 8 from a60 → only a60…a63 exist
  controller.armBusTool();
  clickAt(viewport, world, 60, ROW.a);

  assert.deepEqual(
    rings(surface),
    { count: 4, illegal: 4 },
    "four rings where eight were asked for — the shortfall IS the explanation",
  );
  // Nothing anchored, so the next click anchors rather than landing a bus.
  clickAt(viewport, world, 20, ROW.a);
  assert.equal(doc.wires.length, 0);
  assert.equal(doc.buses.length, 0);
});

test("an occupied hole inside the start run refuses the anchor too", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addWire({ from: "bb1.a12", to: "bb1.j12", color: "red" }); // a12 taken
  const { viewport, surface, controller, world } = makeDesk(doc);

  controller.setBusName("D[3:0]"); // width 4 from a10 → a10, a11, a12, a13
  controller.armBusTool();
  clickAt(viewport, world, 10, ROW.a);

  assert.deepEqual(rings(surface), { count: 4, illegal: 4 });
  // a10 never anchored, so this second click ANCHORS rather than landing a
  // bus — which is the whole proof that the first one was refused.
  clickAt(viewport, world, 30, ROW.a);
  assert.equal(doc.wires.length, 1, "only the pre-existing wire");
  assert.equal(doc.buses.length, 0);

  // Starting past the collision is fine — a13 … a16 are all free.
  controller.disarmBusTool();
  controller.armBusTool();
  hoverAt(viewport, world, 13, ROW.a);
  assert.deepEqual(rings(surface), { count: 4, illegal: 0 });
});

test("a landing that walks off the strip rings the holes that exist", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { viewport, surface, controller, world } = makeDesk(doc);

  controller.setBusName("D[7:0]"); // width 8
  controller.armBusTool();
  clickAt(viewport, world, 10, ROW.a); // anchor a10 (a10…a17 free)
  assert.deepEqual(rings(surface), { count: 8, illegal: 0 }, "start is legal");

  hoverAt(viewport, world, 60, ROW.a); // j60…: only four columns left
  assert.deepEqual(rings(surface), { count: 4, illegal: 4 });
  clickAt(viewport, world, 60, ROW.a);
  assert.equal(doc.wires.length, 0, "an illegal landing lays nothing");

  // A legal landing rings all eight destination holes, and lays them.
  hoverAt(viewport, world, 30, ROW.a);
  assert.deepEqual(rings(surface), { count: 8, illegal: 0 });
  clickAt(viewport, world, 30, ROW.a);
  assert.equal(doc.wires.length, 8);
  assert.equal(doc.buses.length, 1);
});

test("the rings come off the desk when the pointer leaves the viewport", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { viewport, surface, controller, world } = makeDesk(doc);

  controller.setBusName("D[3:0]");
  controller.armBusTool();
  hoverAt(viewport, world, 10, ROW.a);
  assert.equal(rings(surface).count, 4);

  viewport.dispatchEvent(new window.PointerEvent("pointerleave"));
  assert.equal(rings(surface).count, 0);

  // Disarming clears them too, however the tool was left.
  hoverAt(viewport, world, 10, ROW.a);
  controller.disarmBusTool();
  assert.equal(rings(surface).count, 0);
});
