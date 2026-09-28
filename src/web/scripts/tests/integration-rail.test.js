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
// jsdom tests for components/integration-rail.js — the Output/Input element
// cards under the signal buttons. A card is the placement readout: its head
// names the element, and under it wait exactly the tags that are NOT on the
// board yet — so a card is rebuilt on every doc change, and its selection
// highlight has to survive that rebuild.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { IntegrationRail } = await import("../components/integration-rail.js");
const { DeskDoc } = await import("../model/desk-doc.js");

function mount({ connectionName } = {}) {
  const win = resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const out = doc.addIntegration({ kind: "output", width: 4, name: "Lamps" });
  const inp = doc.addIntegration({
    kind: "input",
    width: 8,
    connection: "conn-a",
  });
  const column = win.document.createElement("div");
  win.document.body.append(column);
  const menus = [];
  const drags = [];
  const rail = new IntegrationRail(column, doc, {
    onContextMenu: (id) => menus.push(id),
    onTagPointerDown: (id, key) => drags.push(`${id}:${key}`),
    connectionName,
  });
  return { win, doc, rail, column, out, inp, menus, drags };
}

const cards = (column) => [...column.querySelectorAll(".integration-card")];
const chipKeys = (card) =>
  [...card.querySelectorAll(".integration-tag-chip")].map((c) => c.dataset.key);
const changed = (win) =>
  win.dispatchEvent(new win.CustomEvent("chiphippo:doc-changed"));

test("one card per element, in document order, headed by arrow, name and width", () => {
  const { column, out, inp } = mount();
  const built = cards(column);
  assert.deepEqual(
    built.map((c) => c.dataset.elementId),
    [out.id, inp.id],
  );
  const text = (card, cls) => card.querySelector(`.${cls}`).textContent;
  assert.equal(text(built[0], "integration-card-dir"), "←", "an Output leaves");
  assert.equal(text(built[1], "integration-card-dir"), "→", "an Input arrives");
  assert.equal(text(built[0], "integration-card-name"), "Lamps");
  assert.equal(
    text(built[1], "integration-card-name"),
    inp.id,
    "no name falls back to the id",
  );
  assert.equal(text(built[0], "integration-card-width"), "4");
  assert.equal(text(built[1], "integration-card-width"), "8");
});

test("a card carries its element's colour, and is marked while it has no connection", () => {
  const { column, out, inp } = mount();
  const [a, b] = cards(column);
  assert.equal(
    a.style.getPropertyValue("--signal-color"),
    `var(--color-wire-${out.color})`,
  );
  assert.equal(
    b.style.getPropertyValue("--signal-color"),
    `var(--color-wire-${inp.color})`,
  );
  assert.ok(a.classList.contains("integration-card--unassigned"));
  assert.ok(!b.classList.contains("integration-card--unassigned"));
});

test("the head's tooltip names the connection (or says there is none)", () => {
  const { column } = mount({
    connectionName: (id) => (id === "conn-a" ? "Nano" : null),
  });
  const [a, b] = cards(column).map((c) =>
    c.querySelector(".integration-card-head"),
  );
  assert.match(a.title, /no connection/);
  assert.match(b.title, /^Input — Nano/);
  assert.match(a.title, /Right-click for Properties/, "says where they went");
});

test("the waiting chips are exactly the unplanted keys — pins, then the trigger", () => {
  const { win, doc, column, out } = mount();
  assert.deepEqual(chipKeys(cards(column)[0]), ["1", "2", "3", "4", "T"]);
  const trigger = cards(column)[0].querySelector(
    ".integration-tag-chip--trigger",
  );
  assert.equal(trigger.dataset.key, "T");
  assert.equal(trigger.textContent, "↑", "a rising trigger prints its edge");

  doc.plantIntegrationTag(out.id, "2", "bb1.a5");
  doc.plantIntegrationTag(out.id, "T", "bb1.a9");
  changed(win);
  assert.deepEqual(chipKeys(cards(column)[0]), ["1", "3", "4"]);
});

test("a fully planted element shows no chip row at all", () => {
  const { win, doc, column, out } = mount();
  ["1", "2", "3", "4", "T"].forEach((key, i) =>
    doc.plantIntegrationTag(out.id, key, `bb1.a${2 + i * 3}`),
  );
  changed(win);
  assert.equal(cards(column)[0].querySelector(".integration-card-tags"), null);
});

test("a doc change rebuilds: a new element gains a card, a removed one loses it", () => {
  const { win, doc, column, out, inp } = mount();
  const extra = doc.addIntegration({ kind: "output" });
  changed(win);
  assert.deepEqual(
    cards(column).map((c) => c.dataset.elementId),
    [out.id, inp.id, extra.id],
  );
  doc.removeIntegration(out.id);
  changed(win);
  assert.deepEqual(
    cards(column).map((c) => c.dataset.elementId),
    [inp.id, extra.id],
  );
});

test("clicking the head does nothing; right-clicking opens the menu", () => {
  const { win, column, inp, menus } = mount();
  const [a, b] = cards(column).map((c) =>
    c.querySelector(".integration-card-head"),
  );
  a.click();
  assert.deepEqual(menus, [], "a primary click opens nothing");
  const ctx = new win.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  b.dispatchEvent(ctx);
  assert.deepEqual(menus, [inp.id]);
  assert.equal(ctx.defaultPrevented, true, "the native menu is suppressed");
});

test("a primary press on a chip starts that tag's drag; any other button does not", () => {
  const { win, column, inp, drags } = mount();
  const chip = cards(column)[1].querySelector('[data-key="3"]');
  chip.dispatchEvent(
    new win.PointerEvent("pointerdown", { bubbles: true, button: 2 }),
  );
  assert.deepEqual(drags, []);
  chip.dispatchEvent(
    new win.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
  assert.deepEqual(drags, [`${inp.id}:3`]);
});

test("setSelected lights one card, and the light survives a rebuild", () => {
  const { win, rail, column, out, inp } = mount();
  const lit = () =>
    cards(column)
      .filter((c) => c.classList.contains("integration-card--selected"))
      .map((c) => c.dataset.elementId);
  rail.setSelected(inp.id);
  assert.deepEqual(lit(), [inp.id]);
  changed(win);
  assert.deepEqual(lit(), [inp.id], "remembered across the rebuild");
  rail.setSelected(out.id);
  assert.deepEqual(lit(), [out.id]);
  rail.setSelected(null);
  assert.deepEqual(lit(), []);
});

test("the rail lives inside the column it is given, after what is there", () => {
  const { win, doc } = mount();
  const column = win.document.createElement("div");
  column.append(win.document.createElement("span"));
  const rail = new IntegrationRail(column, doc, {});
  assert.equal(column.lastElementChild, rail.element);
  rail.remove();
  assert.equal(column.querySelector(".integration-rail"), null);
});
