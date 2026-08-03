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

// jsdom tests for the Properties dialog's WARNINGS section — the faults a part
// is showing on the desk, spelled out under everything the dialog can edit.
//
// Three things a scanner could never see are pinned here: that a healthy part
// gets NO section (it is the common case, and a card that always ended in an
// empty "Warnings" heading would be worse than none), that the section tracks a
// RUNNING circuit rather than the moment the card opened, and that its
// sim-state listener goes when the card does.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";
import { applyCatalog } from "../i18n.js";
import { DeskDoc } from "../model/desk-doc.js";

const catalog = (lang) =>
  JSON.parse(
    fs.readFileSync(new URL(`../../locales/${lang}.json`, import.meta.url), "utf8"), // prettier-ignore
  );

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

function makeDesk(deskDoc) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  return { surface, controller: new DeskController({ viewport, deskView, deskDoc }) }; // prettier-ignore
}

// The menu item is itself translated, so it cannot be found by an English
// label once the catalog has moved — ask the catalog what it says.
const openProperties = (surface, selector, label = "Properties…") => {
  PopupManager.close();
  surface.querySelector(selector).dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }),
  );
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === label)
    .click();
};

/** One published sim-state snapshot, as SimController would send it. */
const publish = (statuses, running = true) =>
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: {
        running,
        netLevels: new Map(),
        strongLevels: new Map(),
        chipStatus: new Map(
          Object.entries(statuses).map(([id, status]) => [id, { status }]),
        ),
        netlist: null,
        clockLevels: new Map(),
        displayState: new Map(),
      },
    }),
  );

const section = () => document.querySelector(".properties-warnings");
const lines = () =>
  [...document.querySelectorAll(".properties-warning-text")].map((n) =>
    n.textContent.trim(),
  );

test("a healthy part's Properties dialog carries no warnings section", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");

  openProperties(surface, ".part-chip");
  assert.equal(section().hidden, true, "hidden while the part is healthy");
  assert.deepEqual(lines(), []);
  // The rule above the section is the section's own border, so hiding it takes
  // the divider with it — nothing is left claiming to separate two things.
  assert.equal(
    document.querySelector(".properties-separator"),
    null,
    "and no stray <hr> under a chip with no catalog properties",
  );
});

test("a fault raised while the card is open appears, and clears with the run", () => {
  resetDom();
  const en = catalog("en");
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");
  const id = doc.components[0].id;

  openProperties(surface, ".part-chip");
  assert.equal(section().hidden, true, "healthy at open time");

  // The card was opened BEFORE the fault: it has to track the run, not the
  // moment it was built.
  publish({ [id]: "unpowered" });
  assert.equal(section().hidden, false);
  assert.deepEqual(lines(), [en.properties.warning.unpowered]);
  assert.equal(
    document.querySelectorAll(".properties-warning-icon").length,
    1,
    "each line carries the same warning sign the part draws",
  );

  publish({ [id]: "damaged" });
  assert.deepEqual(lines(), [en.properties.warning.damaged]);

  // "ok" is a status, not a fault — and a stopped sim reports nothing at all.
  publish({ [id]: "ok" });
  assert.equal(section().hidden, true, "a healthy chip says nothing");
  publish({ [id]: "damaged" }, false);
  assert.equal(section().hidden, true, "nor does a stopped one");
});

test("an unprogrammed ROM warns at design time, alongside a live fault", () => {
  resetDom();
  const en = catalog("en");
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("28C16", "bb1", "e5");
  const id = doc.components[0].id;

  // No sim has ever run: this one is derived from params alone, exactly as the
  // chip's own triangle is.
  openProperties(surface, ".part-chip");
  assert.deepEqual(lines(), [en.properties.warning.unprogrammed]);

  // The desk suppresses one triangle behind the other because it has one place
  // to draw. A list does not, so both facts are stated.
  publish({ [id]: "unpowered" });
  assert.deepEqual(lines(), [
    en.properties.warning.unpowered,
    en.properties.warning.unprogrammed,
  ]);

  controller.setMemoryProgrammed(id, true);
  publish({ [id]: "unpowered" });
  assert.deepEqual(lines(), [en.properties.warning.unpowered]);
});

test("the section's sim-state listener goes when the dialog does", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("74LS00", "bb1", "e5");
  const id = doc.components[0].id;

  openProperties(surface, ".part-chip");
  publish({ [id]: "damaged" });
  assert.equal(section().hidden, false);

  PopupManager.close();
  assert.equal(section(), null, "the card is gone");
  publish({ [id]: "damaged" }); // must not resurrect it or throw
  assert.equal(section(), null);

  // And the guard really did reset — a second open still builds a card.
  openProperties(surface, ".part-chip");
  assert.ok(section(), "reopens cleanly");
  PopupManager.close();
});

test("the warnings are written in the active catalog's words", (t) => {
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
  const id = doc.components[0].id;

  applyCatalog({ active: "de", lang: "de", messages: de, fallback: en });
  openProperties(surface, ".part-chip", de.desk.menu.properties);
  publish({ [id]: "reversed" });
  assert.deepEqual(lines(), [de.properties.warning.reversed]);
  assert.equal(
    document.querySelector(".properties-warnings-title").textContent,
    de.properties.warnings,
  );
});
