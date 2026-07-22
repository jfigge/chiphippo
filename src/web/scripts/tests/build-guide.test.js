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

// jsdom smoke tests for the build-guide panel (Feature 140): it FORMATS the
// pure plan — tabs render, the warning badge counts, and it refreshes live.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { BuildGuide } = await import("../components/build-guide.js");

/** A container + a DeskDoc with one board and an (unpowered) chip. */
function mount() {
  resetDom();
  const container = document.createElement("div");
  document.body.append(container);
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb2", anchor: "e5" });
  return { container, doc };
}

test("hidden until shown; toggling reports through onVisibilityChange", () => {
  const { container, doc } = mount();
  const seen = [];
  const guide = new BuildGuide(container, {
    deskDoc: doc,
    onVisibilityChange: (v) => seen.push(v),
  });
  assert.equal(guide.visible, false);
  guide.setVisible(true);
  assert.equal(guide.visible, true);
  guide.setVisible(false);
  assert.deepEqual(seen, [true, false]);
});

test("BOM tab lists the chip with a count; warning badge shows the count", () => {
  const { container, doc } = mount();
  const guide = new BuildGuide(container, { deskDoc: doc });
  guide.setVisible(true);
  const body = container.querySelector(".build-guide-body");
  assert.match(body.textContent, /Quad 2-input NAND/);
  assert.match(body.textContent, /×1/);
  // The unpowered chip raises a warning; the badge is shown with its count.
  const badge = container.querySelector(".build-guide-warn-badge");
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "1");
});

test("switching to the Wiring tab renders net members", () => {
  const { container, doc } = mount();
  doc.addComponent({
    kind: "chip",
    ref: "74LS04",
    board: "bb2",
    anchor: "e20",
  });
  doc.addWire({ from: "bb2.a5", to: "bb2.a20", color: "blue" });
  const guide = new BuildGuide(container, { deskDoc: doc });
  guide.setVisible(true);
  const wiringTab = [...container.querySelectorAll(".build-guide-tab")].find(
    (b) => b.textContent === "Wiring",
  );
  wiringTab.dispatchEvent(new window.Event("click"));
  const body = container.querySelector(".build-guide-body");
  assert.match(body.textContent, /74LS00 pin 1 \(1A\)/);
});

test("Steps tab groups the checklist and ticks a step visually", () => {
  const { container, doc } = mount();
  const guide = new BuildGuide(container, { deskDoc: doc });
  guide.setVisible(true);
  const stepsTab = [...container.querySelectorAll(".build-guide-tab")].find(
    (b) => b.textContent === "Steps",
  );
  stepsTab.dispatchEvent(new window.Event("click"));
  const check = container.querySelector(".build-guide-step-check");
  assert.ok(check, "expected at least one step checkbox");
  check.checked = true;
  check.dispatchEvent(new window.Event("change"));
  assert.ok(
    check
      .closest(".build-guide-step")
      .classList.contains("build-guide-step--done"),
  );
});

test("refreshes live when the document changes while open", () => {
  const { container, doc } = mount();
  const guide = new BuildGuide(container, { deskDoc: doc });
  guide.setVisible(true);
  const body = container.querySelector(".build-guide-body");
  assert.doesNotMatch(body.textContent, /74LS04/);
  doc.addComponent({
    kind: "chip",
    ref: "74LS04",
    board: "bb2",
    anchor: "e20",
  });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  // The BOM tab is active; the new chip appears without re-opening.
  assert.match(
    container.querySelector(".build-guide-body").textContent,
    /Hex inverter/,
  );
});
