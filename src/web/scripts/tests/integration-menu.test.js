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

// Tests for an Output or Input element's context menu (integration-tools.js
// through DeskController): ONE shape — Properties… · Open Connection Window ·
// Add to analyzer · Remove Tag · Remove All Tags · Delete — with an item that
// does not apply present but disabled. "Open Connection Window" opens the
// window of the element's connection, and the menu opens while the circuit
// RUNS (when that window is most worth opening) with every editing item
// disabled.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { MOCK_CONNECTION } from "../model/serial-connections.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

function mount({ connections = [MOCK_CONNECTION], setup } = {}) {
  resetDom();
  const deskDoc = new DeskDoc(null);
  setup?.(deskDoc);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  const opened = [];
  const settings = [];
  const controller = new DeskController({
    viewport,
    deskView,
    deskDoc,
    getConnections: () => connections,
    onOpenConnectionWindow: (id) => opened.push(id),
    onOpenSettings: (tab) => settings.push(tab),
  });
  const items = () =>
    [...document.querySelectorAll(".popup-menu-item, [role=menuitem]")].map(
      (b) => ({ label: b.textContent.trim(), disabled: b.disabled, node: b }),
    );
  return { deskDoc, controller, opened, settings, items };
}

const LABELS = [
  "Properties…",
  "Open Connection Window",
  "Add to analyzer",
  "Remove Tag",
  "Remove All Tags",
  "Delete Output",
];

test("the menu's shape, and Open Connection Window opening that connection's window", () => {
  const { deskDoc, controller, opened, items } = mount();
  const out = deskDoc.addIntegration({ kind: "output", connection: "mock" });
  try {
    controller.openIntegrationMenu(out.id, 10, 10);
    assert.deepEqual(
      items().map((i) => i.label),
      LABELS,
    );
    const open = items().find((i) => i.label === "Open Connection Window");
    assert.equal(open.disabled, false);
    open.node.click();
    assert.deepEqual(opened, ["mock"]);
  } finally {
    while (PopupManager.isOpen()) PopupManager.close();
  }
});

test("with no connection — or one this computer does not know — there is no window to open", () => {
  const { deskDoc, controller, items } = mount();
  const loose = deskDoc.addIntegration({ kind: "output" });
  const orphan = deskDoc.addIntegration({
    kind: "input",
    connection: "conn-gone",
  });
  try {
    for (const id of [loose.id, orphan.id]) {
      controller.openIntegrationMenu(id, 10, 10);
      const open = items().find((i) => i.label === "Open Connection Window");
      assert.equal(open.disabled, true, id);
      PopupManager.close();
    }
  } finally {
    while (PopupManager.isOpen()) PopupManager.close();
  }
});

test("while the circuit runs the menu still opens — editing items disabled, the window not", () => {
  const { deskDoc, controller, items } = mount();
  const out = deskDoc.addIntegration({ kind: "output", connection: "mock" });
  controller.setEditingLocked(true);
  try {
    controller.openIntegrationMenu(out.id, 10, 10);
    const state = Object.fromEntries(items().map((i) => [i.label, i.disabled]));
    assert.equal(state["Open Connection Window"], false);
    assert.equal(state["Properties…"], true);
    assert.equal(state["Remove All Tags"], true);
    assert.equal(state["Delete Output"], true);
  } finally {
    while (PopupManager.isOpen()) PopupManager.close();
  }
});

test("Properties: Manage connections is the gear beside the Connection picker, not a row of its own", () => {
  const { deskDoc, controller, settings } = mount();
  const out = deskDoc.addIntegration({ kind: "output", connection: "mock" });
  try {
    controller.openIntegrationMenu(out.id, 10, 10);
    [...document.querySelectorAll(".popup-menu-item, [role=menuitem]")]
      .find((b) => b.textContent.trim() === "Properties…")
      .click();
    assert.equal(
      document.querySelector(".properties-row--action"),
      null,
      "no full-width command row",
    );
    const gear = document.querySelector(".properties-icon-action");
    assert.ok(gear, "an icon button");
    assert.equal(gear.getAttribute("aria-label"), "Manage connections…");
    assert.ok(gear.querySelector("svg"), "drawn as a glyph");
    // It shares the Connection row, to the right of the picker.
    const group = gear.parentElement;
    assert.ok(group.classList.contains("properties-control-group"));
    assert.equal(group.firstElementChild.tagName, "SELECT");
    assert.equal(group.lastElementChild, gear);
    assert.equal(
      group.closest(".properties-row").querySelector(".properties-label")
        .textContent,
      "Connection",
    );
    gear.click();
    assert.deepEqual(settings, ["integration"]);
    assert.equal(PopupManager.isOpen(), false, "the card closes first");
  } finally {
    while (PopupManager.isOpen()) PopupManager.close();
  }
});

test("Properties: Auto leads the Trigger picker, and greys out Trigger starts", () => {
  let out;
  const { deskDoc, controller } = mount({
    setup: (doc) => {
      doc.addBoard("pins-full", 0, 0);
      out = doc.addIntegration({ kind: "output", connection: "mock" }).id;
      doc.plantIntegrationTag(out, "T", "bb1.a9");
    },
  });
  const row = (label) =>
    [...document.querySelectorAll(".properties-row")].find(
      (r) => r.querySelector(".properties-label")?.textContent === label,
    );
  const segment = (r, label) =>
    [...r.querySelectorAll(".segmented-option")].find(
      (b) => b.textContent === label,
    );
  try {
    // Right-click the planted trigger: the menu selects it, then Properties…
    document
      .querySelector(`[data-tag-id="${out}:T"]`)
      .dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true }));
    assert.equal(controller.selectedId, `${out}:T`);
    [...document.querySelectorAll(".popup-menu-item, [role=menuitem]")]
      .find((b) => b.textContent.trim() === "Properties…")
      .click();

    const trigger = row("Trigger");
    assert.deepEqual(
      [...trigger.querySelectorAll(".segmented-option")].map(
        (b) => b.textContent,
      ),
      ["Auto", "Rising", "Falling", "Either"],
    );
    const starts = row("Trigger starts");
    assert.ok(!starts.classList.contains("properties-row--disabled"));

    segment(trigger, "Auto").click();
    assert.ok(starts.classList.contains("properties-row--disabled"));
    assert.ok(
      [...starts.querySelectorAll("button")].every((b) => b.disabled),
      "its segments take no input",
    );
    const parked = deskDoc.getIntegration(out);
    assert.equal(parked.tags, undefined, "the trigger left the board");
    assert.equal(parked.parkedTrigger.anchor, "bb1.a9", "remembered");
    assert.equal(controller.selectedId, null, "and its selection with it");

    segment(trigger, "Falling").click();
    assert.ok(!starts.classList.contains("properties-row--disabled"));
    assert.ok([...starts.querySelectorAll("button")].every((b) => !b.disabled));
    assert.equal(deskDoc.getIntegration(out).tags.T.anchor, "bb1.a9", "back");
  } finally {
    while (PopupManager.isOpen()) PopupManager.close();
  }
});

test("Properties: an Input opens on Auto with Trigger starts already greyed", () => {
  const { deskDoc, controller } = mount();
  const inp = deskDoc.addIntegration({ kind: "input", connection: "mock" });
  try {
    controller.openIntegrationProperties(inp.id);
    const starts = [...document.querySelectorAll(".properties-row")].find(
      (r) =>
        r.querySelector(".properties-label")?.textContent === "Trigger starts",
    );
    assert.ok(starts.classList.contains("properties-row--disabled"));
    const active = document.querySelector(
      ".properties-row .segmented-option--active",
    );
    assert.equal(active.textContent, "Auto");
  } finally {
    while (PopupManager.isOpen()) PopupManager.close();
  }
});
