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

  clickAt(viewport, world, 10, 12); // anchor start on a10
  assert.equal(doc.wires.length, 0, "nothing laid on the first click");
  clickAt(viewport, world, 20, 12); // land the run on a20

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
  const { viewport, controller, world } = makeDesk(doc);

  controller.setBusName("D[2:0]"); // width 3 → a20, a21, a22
  controller.armBusTool();
  clickAt(viewport, world, 10, 12); // start a10
  clickAt(viewport, world, 20, 12); // a21 is taken → illegal, nothing lays

  assert.equal(doc.buses.length, 0);
  assert.equal(doc.wires.length, 1, "only the pre-existing wire remains");
});
