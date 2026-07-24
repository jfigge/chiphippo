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

// jsdom test for the pin-assignments double-click: double-clicking ANY part —
// chip, discrete, or desk brick — requests its pinout window via onOpenPinout
// with a layout row count (DIP wraps to pins/2, discretes list every pin,
// bricks list every terminal).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");

function makeDesk(deskDoc, opts = {}) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  const controller = new DeskController({
    viewport,
    deskView,
    deskDoc,
    ...opts,
  });
  return { viewport, surface, controller };
}

const dblclick = (elem) =>
  elem.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));

test("double-clicking a DIP chip requests its pinout (rows = pins/2)", () => {
  resetDom();
  const opened = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc, {
    onOpenPinout: (ref, rows) => opened.push([ref, rows]),
  });
  controller.addComponentAt("74LS138", "bb1", "e5"); // DIP-16 → 8 rows

  dblclick(surface.querySelector(".part-chip"));
  assert.deepEqual(opened, [["74LS138", 8]]);
});

test("double-clicking a discrete requests its pinout (rows = pin count)", () => {
  resetDom();
  const opened = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc, {
    onOpenPinout: (ref, rows) => opened.push([ref, rows]),
  });
  controller.addComponentAt("led", "bb1", "a20", { color: "red" }); // 2 pins

  dblclick(surface.querySelector(".part-discrete"));
  assert.deepEqual(opened, [["led", 2]]);
});

test("double-clicking an oscillator can requests its pinout with its CURRENT rotation", () => {
  resetDom();
  const opened = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc, {
    onOpenPinout: (ref, rows, rot) => opened.push([ref, rows, rot]),
  });
  controller.addComponentAt("osc-full", "bb1", "e10"); // 4 pins, rot 0

  dblclick(surface.querySelector(".part-discrete"));
  controller.rotateComponent("c1"); // full-can: one call jumps straight to 180°
  dblclick(surface.querySelector(".part-discrete"));

  assert.deepEqual(opened, [
    ["osc-full", 4, 0],
    ["osc-full", 4, 180],
  ]);
});

test("double-clicking bar8iso (a package-footprint discrete) requests its pinout with its CURRENT rotation", () => {
  resetDom();
  const opened = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc, {
    onOpenPinout: (ref, rows, rot) => opened.push([ref, rows, rot]),
  });
  controller.addComponentAt("bar8iso", "bb1", "e5"); // DIP-16 → 8 rows

  dblclick(surface.querySelector(".part-discrete"));
  controller.rotateComponent("c1"); // chip-style half-lap flip
  dblclick(surface.querySelector(".part-discrete"));

  assert.deepEqual(opened, [
    ["bar8iso", 8, undefined],
    ["bar8iso", 8, 180],
  ]);
});

test("double-clicking a desk brick requests its terminal map", () => {
  resetDom();
  const opened = [];
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc, {
    onOpenPinout: (ref, rows) => opened.push([ref, rows]),
  });
  controller.addBrickAt("psu", 4, 4); // 2 terminals
  controller.addBrickAt("clock", 20, 4);

  dblclick(surface.querySelector(".part-psu"));
  dblclick(surface.querySelector(".part-clock"));
  assert.deepEqual(opened, [
    ["psu", 2],
    ["clock", 2],
  ]);
});
