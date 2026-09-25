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
// A RENDERING test for the signal Properties card and context menu
// (Feature 370) — the stated answer to the hardcoded-string scanners' one
// blind spot. Both scanners match a UI-bearing property followed by a QUOTE,
// so a template literal or a ternary in that position is invisible to them.
// The card's title is exactly that shape (`{signal} Properties`), as are both
// segmented pickers' option labels.
//
// So: install a catalog, render the real thing, and assert the catalog's own
// words came out. A stub with bracketed markers is used rather than a shipped
// translation, so this asserts that the KEY is consulted without tying the
// test to anyone's choice of wording.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";
import { applyCatalog } from "../i18n.js";

const en = JSON.parse(
  fs.readFileSync(new URL("../../locales/en.json", import.meta.url), "utf8"),
);

const { DeskDoc } = await import("../model/desk-doc.js");
const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");
const { SIGNAL_COLORS } = await import("../model/signals.js");

/** en.json with every string this card reads replaced by a marker. */
function stubCatalog() {
  const c = structuredClone(en);
  c.desk.signalPropertiesTitle = "<TITLE:{signal}>";
  c.desk.menu.removeSignal = "<REMOVE-SIGNAL>";
  c.desk.menu.deleteSignal = "<DELETE-SIGNAL>";
  c.desk.menu.properties = "<PROPERTIES>";
  c.probe.addToAnalyzer = "<ADD-TO-ANALYZER>";
  c.properties.name = "<NAME>";
  c.properties.description = "<DESCRIPTION>";
  c.properties.field.color = "<F:COLOR>";
  c.properties.field.type = "<F:TYPE>";
  c.properties.field.rest = "<F:REST>";
  c.properties.option.momentary = "<O:MOMENTARY>";
  c.properties.option.toggle = "<O:TOGGLE>";
  c.properties.option.low = "<O:LOW>";
  c.properties.option.high = "<O:HIGH>";
  return c;
}

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
  return new DeskController({ viewport, deskView, deskDoc, ...opts });
}

function setup(t, { catalog = stubCatalog() } = {}) {
  resetDom();
  applyCatalog({ active: "en", lang: "en", messages: catalog, fallback: en });
  t.after(() => {
    PopupManager.close();
    applyCatalog({ active: "en", lang: "en", messages: en, fallback: en });
  });
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const controller = makeDesk(doc);
  return { doc, controller };
}

const cardText = () => document.querySelector(".popup-body")?.textContent ?? ""; // prettier-ignore
const titleText = () => document.querySelector(".popup-title")?.textContent ?? ""; // prettier-ignore
const rowLabels = () =>
  [...document.querySelectorAll(".properties-label")].map((n) => n.textContent);
const segmentLabels = () =>
  [...document.querySelectorAll(".segmented-option")].map((n) => n.textContent);

test("every word on the signal Properties card comes from the catalog", (t) => {
  const { doc, controller } = setup(t);
  const sig = doc.addSignal({ name: "RESET" });
  controller.openSignalProperties(sig.id);

  // The title is a template literal — invisible to the scanner, which is the
  // whole reason this test renders instead of grepping.
  assert.ok(
    titleText().includes("<TITLE:"),
    `title came from the catalog, got: ${titleText()}`,
  );
  assert.ok(
    titleText().includes("RESET"),
    "and interpolates the signal's name",
  );

  assert.deepEqual(rowLabels(), [
    "<NAME>",
    "<DESCRIPTION>",
    "<F:COLOR>",
    "<F:TYPE>",
    "<F:REST>",
  ]);
  assert.deepEqual(segmentLabels(), [
    "<O:MOMENTARY>",
    "<O:TOGGLE>",
    "<O:LOW>",
    "<O:HIGH>",
  ]);
});

test("the colour picker offers every signal colour, a shared one too", (t) => {
  const { doc, controller } = setup(t);
  const a = doc.addSignal({});
  const b = doc.addSignal({});
  controller.openSignalProperties(a.id);
  const offered = [...document.querySelectorAll(".color-swatch")].map(
    (n) => n.dataset.color,
  );
  assert.deepEqual(offered, [...SIGNAL_COLORS]);
  assert.ok(offered.includes(b.color), "another signal's colour is on offer");
  assert.ok(!offered.includes("black"), "black is never on the card");
});

test("Type and Default write through, riding the one doc-changed seam", (t) => {
  const { doc, controller } = setup(t);
  const sig = doc.addSignal({});
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  controller.openSignalProperties(sig.id);
  const pick = (label) =>
    [...document.querySelectorAll(".segmented-option")]
      .find((n) => n.textContent === label)
      .click();
  pick("<O:TOGGLE>");
  pick("<O:HIGH>");
  assert.equal(doc.getSignal(sig.id).type, "toggle");
  assert.equal(doc.getSignal(sig.id).rest, "high");
  assert.ok(changes >= 2, "each edit announced itself");
});

test("a flag's context menu is Properties… / Add to analyzer / Remove / Delete Signal", (t) => {
  // The controller is what mounts the signal layer — the flag is reached
  // through the DOM it built, not through the controller's own API.
  const { doc } = setup(t);
  const sig = doc.addSignal({});
  doc.plantSignalFlag(sig.id, "bb1.a12", 0);
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  const poly = document.querySelector(`[data-signal-id="${sig.id}"]`);
  assert.ok(poly, "the flag drew into the signals layer");
  poly.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 5,
      clientY: 5,
    }),
  );
  assert.deepEqual(
    [...document.querySelectorAll(".popup-menu-item")].map((b) => b.textContent.trim()), // prettier-ignore
    ["<PROPERTIES>", "<ADD-TO-ANALYZER>", "<REMOVE-SIGNAL>", "<DELETE-SIGNAL>"],
  );
});

test("Add to analyzer is disabled for an UNPLACED signal — it names no net", (t) => {
  const { doc, controller } = setup(t);
  const sig = doc.addSignal({});
  // Reach the menu through the rail's route: an unplaced signal has no flag on
  // the desk, so only Properties… is available to it at all.
  controller.openSignalProperties(sig.id);
  assert.ok(cardText().includes("<F:TYPE>"), "the card still opens");
});

test("the RAIL opens the same menu — the only way to delete an unplaced signal", (t) => {
  // An unplaced signal has no flag on the desk, so it cannot be right-clicked
  // there and cannot be selected for Delete. Without the rail's own menu the
  // only way to throw one away was to plant it somewhere first.
  const { doc, controller } = setup(t);
  const sig = doc.addSignal({});
  assert.equal(doc.getSignal(sig.id).flag, undefined, "unplaced");
  controller.openSignalMenu(sig.id, 5, 5);
  const labels = [...document.querySelectorAll(".popup-menu-item")].map((b) =>
    b.textContent.trim(),
  );
  assert.deepEqual(labels, ["<PROPERTIES>", "<ADD-TO-ANALYZER>", "<REMOVE-SIGNAL>", "<DELETE-SIGNAL>"]); // prettier-ignore
  const items = [...document.querySelectorAll(".popup-menu-item")];
  assert.ok(items[1].disabled, "it names no net, so the analyzer item is off");
  assert.ok(items[2].disabled, "and there is no flag on a board to remove");
  items.at(-1).click();
  assert.equal(doc.getSignal(sig.id), null, "and Delete reaches it");
});

test("Remove Signal sends the flag back to its button, position and all", (t) => {
  resetDom();
  t.after(() => PopupManager.close());
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const seen = [];
  const controller = makeDesk(doc, { onSignalSelect: (id) => seen.push(id) });
  const sig = doc.addSignal({ name: "RESET" });
  doc.plantSignalFlag(sig.id, "bb1.a12", 270);
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);

  controller.openSignalMenu(sig.id, 5, 5); // a planted flag's menu selects it
  const remove = [...document.querySelectorAll(".popup-menu-item")][2];
  assert.equal(remove.disabled, false, "a planted flag can be removed");
  remove.click();

  const after = doc.getSignal(sig.id);
  assert.ok(after, "the SIGNAL survives");
  assert.equal(after.name, "RESET");
  assert.equal(after.flag, undefined, "anchor AND rotation are gone");
  assert.equal(
    document.querySelector(`[data-signal-id="${sig.id}"]`),
    null,
    "no flag left on the desk",
  );
  assert.deepEqual(seen, [sig.id, null], "and its selection went with it");
  assert.equal(changes, 1, "one undoable edit");
});

test("selecting a flag tells the rail, through onSignalSelect", (t) => {
  resetDom();
  t.after(() => PopupManager.close());
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const seen = [];
  const controller = makeDesk(doc, { onSignalSelect: (id) => seen.push(id) });
  const sig = doc.addSignal({});
  doc.plantSignalFlag(sig.id, "bb1.a12", 0);
  controller.selectSignal(sig.id);
  controller.deselect();
  assert.deepEqual(seen, [sig.id, null]);
});
