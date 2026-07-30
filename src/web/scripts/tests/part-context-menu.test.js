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
// discrete, PSU/clock/LCD brick, oscillator can, memory chip, board, wire —
// shows the SAME three items, in the SAME order: Pin Assignment / Properties…
// / Delete Component. A per-part picker (PSU volts, clock/oscillator rate,
// LCD size, a wire's Color) is a Properties-dialog field now, never its own
// menu item.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";
import { applyCatalog } from "../i18n.js";
import { DeskDoc, WIRE_COLORS } from "../model/desk-doc.js";

/** A shipped catalog, read the same way jsdom-setup reads en.json. */
const catalog = (lang) =>
  JSON.parse(
    fs.readFileSync(new URL(`../../locales/${lang}.json`, import.meta.url), "utf8"), // prettier-ignore
  );

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

const boardEl = (surface, id) =>
  surface.querySelector(`[data-board-id="${id}"]`);

const wireEl = (surface, id) => surface.querySelector(`[data-wire-id="${id}"]`);

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

const openProperties = (selector, surface) => {
  rightClick(surface.querySelector(selector));
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();
};

test("Properties… is always enabled — every part has Name/Description now", () => {
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
    false,
    "74LS00 has Name/Description even with no catalog properties",
  );
  assert.equal(propsItem(".part-discrete").disabled, false, "the LED too");
});

test("a chip's Properties dialog shows only Name/Description, no separator", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");
  const id = doc.components[0].id;

  openProperties(".part-chip", surface);
  assert.ok(document.querySelector(".properties-text-input"), "Name input");
  assert.ok(document.querySelector(".properties-textarea"), "Description");
  assert.equal(
    document.querySelector(".properties-separator"),
    null,
    "no separator when the def has no extra properties",
  );

  const [name, description] = [
    document.querySelector(".properties-text-input"),
    document.querySelector(".properties-textarea"),
  ];
  let changed = 0;
  window.addEventListener("chiphippo:doc-changed", () => changed++);
  name.value = "U1";
  name.dispatchEvent(new window.Event("change"));
  description.value = "the reset NAND";
  description.dispatchEvent(new window.Event("change"));

  assert.equal(doc.getComponent(id).name, "U1");
  assert.equal(doc.getComponent(id).description, "the reset NAND");
  assert.ok(changed > 0, "rides the doc-changed commit seam");
});

test("a part's Properties dialog is titled through the catalog, part name and all", (t) => {
  // It used to be built as `${def.title} Properties` — the def's `title` is the
  // ENGLISH SOURCE the catalog translates through, so a German user got an
  // English part name under an English word, in a dialog whose every other row
  // was translated. The BOARD dialog beside it had been doing this correctly
  // all along, which is the shape this now follows.
  const en = catalog("en");
  const de = catalog("de");
  resetDom();
  t.after(() => {
    PopupManager.close();
    applyCatalog({ active: "en", lang: "en", messages: en, fallback: en });
  });

  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");

  // The menu item is itself translated, so it cannot be found by an English
  // label once the catalog has moved — ask the catalog what it says.
  const openPropsIn = (cat) => {
    PopupManager.close();
    rightClick(surface.querySelector(".part-chip"));
    [...document.querySelectorAll(".popup-menu-item")]
      .find((b) => b.textContent.trim() === cat.desk.menu.properties)
      .click();
    return document.querySelector(".popup-title").textContent;
  };

  assert.equal(
    openPropsIn(en),
    "Quad 2-input NAND Properties",
    "English: the catalog's own wording, unchanged",
  );

  applyCatalog({ active: "de", lang: "de", messages: de, fallback: en });
  assert.equal(
    openPropsIn(de),
    "Eigenschaften: Vierfach-NAND, 2 Eingänge",
    "German: BOTH the part's name and the word around it",
  );
});

test("the annotation placement ghost is labelled in the catalog's words", (t) => {
  // The ghost is the palette pick the user just made, so it has to read as the
  // thing they clicked — it used to say a hardcoded "Label" / "Note" beside a
  // palette row that was translated.
  const en = catalog("en");
  const de = catalog("de");
  resetDom();
  t.after(() =>
    applyCatalog({ active: "en", lang: "en", messages: en, fallback: en }),
  );

  const { controller } = makeDesk(new DeskDoc(null));
  const ghostText = () =>
    document.querySelector(".annotation-ghost .annotation-text").textContent;

  controller.armAnnotationPlacement("label");
  assert.equal(ghostText(), en.palette.annotation.label);
  controller.armAnnotationPlacement("note");
  assert.equal(ghostText(), en.palette.annotation.note);

  applyCatalog({ active: "de", lang: "de", messages: de, fallback: en });
  controller.armAnnotationPlacement("label");
  assert.equal(ghostText(), "Beschriftung");
  controller.armAnnotationPlacement("note");
  assert.equal(ghostText(), "Notiz");
  controller.cancelPlacement();
});

test("the LED's Properties dialog shows Name/Description, a separator, then Color", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("led", "bb1", "a20", { color: "red" });

  openProperties(".part-discrete", surface);
  assert.ok(document.querySelector(".properties-text-input"), "Name input");
  assert.ok(document.querySelector(".properties-textarea"), "Description");
  assert.ok(
    document.querySelector(".properties-separator"),
    "a separator precedes the LED's own color field",
  );
  assert.ok(document.querySelector(".color-swatches"), "Color swatches");
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

test("a board's Properties… is live and opens with just Name/Description", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);

  rightClick(boardEl(surface, "bb1"));
  const propsItem = [...document.querySelectorAll(".popup-menu-item")].find(
    (b) => b.textContent.trim() === "Properties…",
  );
  assert.equal(propsItem.disabled, false, "a board has Name/Description too");
  propsItem.click();

  assert.ok(document.querySelector(".properties-text-input"), "Name input");
  assert.ok(document.querySelector(".properties-textarea"), "Description");
  assert.equal(
    document.querySelector(".properties-separator"),
    null,
    "a pin-board declares no extra properties",
  );

  const [name, description] = [
    document.querySelector(".properties-text-input"),
    document.querySelector(".properties-textarea"),
  ];
  let changed = 0;
  window.addEventListener("chiphippo:doc-changed", () => changed++);
  name.value = "Main board";
  name.dispatchEvent(new window.Event("change"));
  description.value = "holds the CPU";
  description.dispatchEvent(new window.Event("change"));

  assert.equal(doc.getBoard("bb1").name, "Main board");
  assert.equal(doc.getBoard("bb1").description, "holds the CPU");
  assert.ok(changed > 0, "rides the doc-changed commit seam");
});

/** A wire only renders once the WireLayer re-runs off doc-changed — direct
    DeskDoc mutations (bypassing the controller) don't trigger that on their
    own, so every wire test dispatches it manually after adding one. */
function addRenderedWire(doc, from, to) {
  const wire = doc.addWire({ from, to });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  return wire;
}

test("a wire's context menu matches too: Pin Assignment / Properties… / Delete Component", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);
  const wire = addRenderedWire(doc, "bb1.a6", "bb1.a9");

  rightClick(wireEl(surface, wire.id));
  assert.deepEqual(menuLabels(), CORE_MENU);
});

test("a wire's Properties dialog shows Name/Description, a separator, then all 8 Colors", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);
  const wire = addRenderedWire(doc, "bb1.a6", "bb1.a9");

  rightClick(wireEl(surface, wire.id));
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();

  assert.ok(document.querySelector(".properties-text-input"), "Name input");
  assert.ok(document.querySelector(".properties-textarea"), "Description");
  assert.ok(
    document.querySelector(".properties-separator"),
    "a separator precedes the wire's own Color field",
  );
  const swatches = [...document.querySelectorAll(".color-swatch")];
  assert.deepEqual(
    swatches.map((b) => b.dataset.color),
    [...WIRE_COLORS],
    "all 8 wire colors are offered",
  );

  const [name, description] = [
    document.querySelector(".properties-text-input"),
    document.querySelector(".properties-textarea"),
  ];
  let changed = 0;
  window.addEventListener("chiphippo:doc-changed", () => changed++);
  name.value = "reset line";
  name.dispatchEvent(new window.Event("change"));
  description.value = "pulls SR low on power-up";
  description.dispatchEvent(new window.Event("change"));
  document.querySelector('.color-swatch[data-color="blue"]').click();

  const updated = doc.getWire(wire.id);
  assert.equal(updated.name, "reset line");
  assert.equal(updated.description, "pulls SR low on power-up");
  assert.equal(updated.color, "blue", "Color still applies live too");
  assert.ok(changed > 0, "rides the doc-changed commit seam");
});

test("a wire's Properties dialog ends with the wire itself, drawn and dimensioned", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);
  // 20 pitch apart = 50.8 mm hole to hole; the sagging run it draws is a shade
  // over that, and 5 mm of stripped lead at each end makes the wire ~6.1 cm.
  const wire = addRenderedWire(doc, "bb1.a1", "bb1.a21");

  rightClick(wireEl(surface, wire.id));
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();

  // It is the LAST row: a picture belongs below everything editable.
  const rows = [...document.querySelectorAll(".properties-popup-body > *")];
  assert.ok(rows.at(-1).querySelector(".wire-gauge"), "the drawing comes last");
  const gauge = document.querySelector(".wire-gauge");
  assert.equal(
    gauge.style.getPropertyValue("--wire-color"),
    "var(--color-wire-red)",
    "drawn in the wire's own colour",
  );
  assert.match(
    gauge.querySelector(".wire-gauge-length").textContent,
    /^6\.[0-9] cm$/,
    "dimensioned in cm: the run the WireLayer draws, plus both stripped ends",
  );

  // Picking a colour repaints the drawing in place — the dialog applies live and
  // never rebuilds its rows, so nothing else would.
  document.querySelector('.color-swatch[data-color="blue"]').click();
  assert.equal(
    document
      .querySelector(".wire-gauge")
      .style.getPropertyValue("--wire-color"),
    "var(--color-wire-blue)",
  );
});

test("the shortest wires: one hole apart is 1.3 cm of wire, two holes 1.5 cm", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);
  // The bench figures, end to end through the real desk: a hop across ONE
  // 2.54 mm pitch is 2.54 + 2 × 5 mm of wire (12.7, so 1.3 cm), and across two
  // is 5.08 + 10 (15.2 → 1.5). Without the stripped ends these read 0.3 and 0.5,
  // which is the run alone and not a length anybody could cut to.
  for (const [to, expected] of [
    ["bb1.a2", "1.3 cm"],
    ["bb1.a3", "1.5 cm"],
  ]) {
    PopupManager.close();
    for (const w of doc.wires) doc.removeWire(w.id);
    const wire = addRenderedWire(doc, "bb1.a1", to);
    rightClick(wireEl(surface, wire.id));
    [...document.querySelectorAll(".popup-menu-item")]
      .find((b) => b.textContent.trim() === "Properties…")
      .click();
    assert.equal(
      document.querySelector(".wire-gauge-length").textContent,
      expected,
      `bb1.a1 → ${to}`,
    );
  }
});

test("the wire's drawing re-measures when a change in the dialog shortens it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);
  const wire = addRenderedWire(doc, "bb1.a1", "bb1.a21");
  // Bend it well below the run, so switching back to Direct visibly shortens it.
  doc.setWireLayout(wire.id, "routed");
  doc.addWirePoint(wire.id, 0, { x: 10, y: 60 });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));

  rightClick(wireEl(surface, wire.id));
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();
  const shown = () =>
    Number(
      document.querySelector(".wire-gauge-length").textContent.replace(/[^\d.]/g, ""), // prettier-ignore
    );
  const bent = shown();
  assert.ok(bent > 12, `${bent} cm: the detour is part of the wire`);

  // Direct throws the bend away — the dimension has to follow, in place.
  document
    .querySelector(
      '.segmented-picker[aria-label="Layout Method"] .segmented-option[data-value="direct"]',
    ) // prettier-ignore
    .click();
  assert.equal(doc.getWire(wire.id).points, undefined, "the bend is gone");
  assert.ok(shown() < bent / 2, `${shown()} cm: re-measured, not stale`);
});

test("a wire's Properties dialog switches its Layout Method both ways", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);
  const wire = addRenderedWire(doc, "bb1.a6", "bb1.a9");

  // The SAME segmented picker Settings ▸ Appearance offers the default with —
  // not a dropdown (components/segmented-picker.js).
  const openWireProps = () => {
    rightClick(wireEl(surface, wire.id));
    [...document.querySelectorAll(".popup-menu-item")]
      .find((b) => b.textContent.trim() === "Properties…")
      .click();
    return [
      ...document.querySelectorAll(
        '.segmented-picker[aria-label="Layout Method"] .segmented-option',
      ),
    ];
  };
  const chosen = (segments) =>
    segments.find((b) => b.classList.contains("segmented-option--active"));

  let segments = openWireProps();
  assert.equal(document.querySelector(".properties-select"), null, "no <select>"); // prettier-ignore
  assert.deepEqual(
    segments.map((b) => [b.getAttribute("data-value"), b.textContent]),
    [
      ["direct", "Direct"],
      ["routed", "Routed"],
    ],
  );
  assert.equal(chosen(segments).textContent, "Direct", "no layout → Direct");

  segments[1].click();
  assert.equal(doc.getWire(wire.id).layout, "routed");
  assert.equal(chosen(segments).textContent, "Routed", "the fill moves");
  assert.equal(segments[0].getAttribute("aria-checked"), "false");

  // Bend it, then switch back: the bends go with the layout that held them.
  doc.addWirePoint(wire.id, 0, { x: 7, y: 20 });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  PopupManager.close();
  segments = openWireProps();
  assert.equal(chosen(segments).textContent, "Routed", "seeded from the wire");
  segments[0].click();
  assert.equal(doc.getWire(wire.id).layout, undefined);
  assert.equal(doc.getWire(wire.id).points, undefined);
});

test("a wire's Delete Component removes it", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface } = makeDesk(doc);
  const wire = addRenderedWire(doc, "bb1.a6", "bb1.a9");

  rightClick(wireEl(surface, wire.id));
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Delete Component")
    .click();

  assert.equal(doc.getWire(wire.id), null);
});
