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

// jsdom tests for the uniform part context menu: every part kind — chip,
// discrete, PSU/clock/LCD brick, oscillator can, memory chip — shows the
// SAME three items, in the SAME order: Pin Assignment / Properties… /
// Delete Component. A per-part picker (PSU volts, clock/oscillator rate,
// LCD size) is a Properties-dialog field now, never its own menu item.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

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
  return { surface, controller };
}

// PopupManager QUEUES a popup opened while one is already showing rather
// than replacing it, so a re-right-click without closing the last menu would
// silently read stale items — close first, every time.
const rightClick = (elem) => {
  PopupManager.close();
  elem.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }),
  );
};

const menuLabels = () =>
  [...document.querySelectorAll(".popup-menu-item")].map((b) =>
    b.textContent.trim(),
  );

const CORE_MENU = ["Pin Assignment", "Properties…", "Delete Component"];

test("a chip's context menu is exactly Pin Assignment / Properties… / Delete Component", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");

  rightClick(surface.querySelector(".part-chip"));
  assert.deepEqual(menuLabels(), CORE_MENU);
});

test("a PSU brick's context menu matches too, with no voltage picker of its own", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addBrickAt("psu", 4, 4);

  rightClick(surface.querySelector(".part-psu"));
  assert.deepEqual(menuLabels(), CORE_MENU);
});

test("a clock brick, an LCD brick, and an oscillator can all match too", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addBrickAt("clock", -12, 4);
  controller.addBrickAt("lcd", -12, 20);
  controller.addComponentAt("osc-half", "bb1", "g5");

  for (const selector of [".part-clock", ".part-lcd", ".part-discrete"]) {
    rightClick(surface.querySelector(selector));
    assert.deepEqual(menuLabels(), CORE_MENU, selector);
  }
});

test("Properties… is disabled for a part with no fields, enabled for the LED", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");
  controller.addComponentAt("led", "bb1", "a20", { color: "red" });

  const propsItem = (selector) => {
    rightClick(surface.querySelector(selector));
    return [...document.querySelectorAll(".popup-menu-item")].find(
      (b) => b.textContent.trim() === "Properties…",
    );
  };
  assert.equal(
    propsItem(".part-chip").disabled,
    true,
    "74LS00 has no properties",
  );
  assert.equal(
    propsItem(".part-discrete").disabled,
    false,
    "the LED has color",
  );
});

test("Delete Component is disabled while editing is locked (running)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");

  const deleteItem = () => {
    rightClick(surface.querySelector(".part-chip"));
    return [...document.querySelectorAll(".popup-menu-item")].find(
      (b) => b.textContent.trim() === "Delete Component",
    );
  };
  assert.equal(deleteItem().disabled, false, "editable by default");
  controller.setEditingLocked(true);
  assert.equal(deleteItem().disabled, true, "locked while the sim runs");
  controller.setEditingLocked(false);
  assert.equal(deleteItem().disabled, false, "editable again once stopped");
});

test("a PSU's Properties dialog shows Voltage as a live-applying select", () => {
  resetDom();
  const doc = new DeskDoc(null);
  const { surface, controller } = makeDesk(doc);
  controller.addBrickAt("psu", 4, 4);
  const id = doc.toJSON().components[0].id;

  rightClick(surface.querySelector(".part-psu"));
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();

  const select = document.querySelector(".properties-select");
  assert.ok(select, "the Voltage select is in the dialog");
  assert.deepEqual(
    [...select.options].map((o) => o.value),
    ["3", "5", "12"],
  );
  assert.equal(select.value, "5", "seeded from the current volts");

  let changed = 0;
  window.addEventListener("chiphippo:doc-changed", () => changed++);
  select.value = "12";
  select.dispatchEvent(new window.Event("change"));

  assert.equal(doc.getComponent(id).params.volts, 12, "applies live");
  assert.ok(changed > 0, "rides the doc-changed commit seam");
});
