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

// jsdom tests for the parts palette panel.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { CHIP_DEFS, PALETTE_DEFS } from "../catalog/index.js";
import { hasBehavior } from "../sim/chip-eval.js";

const { PalettePanel } = await import("../components/palette-panel.js");

function typeFilter(panelEl, value) {
  const input = panelEl.querySelector(".palette-filter");
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("lists the whole catalog grouped by function; picks report the ref", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);

  const picked = [];
  const panel = new PalettePanel(host, {
    onPickChip: (ref) => picked.push(ref),
  });

  const items = host.querySelectorAll(".palette-item");
  assert.equal(items.length, PALETTE_DEFS.length);
  const groups = [...host.querySelectorAll(".palette-group")].map(
    (g) => g.textContent,
  );
  assert.deepEqual(groups, [...new Set(PALETTE_DEFS.map((d) => d.group))]);

  host.querySelector('.palette-item[data-ref="7486"]').click();
  assert.deepEqual(picked, ["7486"]);
  assert.ok(panel.element);

  // "sim-ready" badge (Feature 80): every chip with behavior shows it; the
  // discrete parts / PSU (no logic block) do not.
  const badgeRef = (sel) =>
    [...host.querySelectorAll(sel)].map(
      (b) => b.closest(".palette-item").dataset.ref,
    );
  const badged = new Set(badgeRef(".palette-item-badge"));
  for (const def of PALETTE_DEFS) {
    assert.equal(badged.has(def.id), hasBehavior(def), `${def.id} badge`);
  }
  assert.ok(badged.has("7400")); // combinational
  assert.ok(badged.has("7474")); // sequential
  assert.ok(!badged.has("led"));
  assert.ok(!badged.has("clock"));
});

test("all chip groups nest under one 'Chips' folder; parts stay top-level", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  new PalettePanel(host, {});

  // Exactly one folder, labelled "Chips", rendered before the top-level groups.
  const folders = [...host.querySelectorAll(".palette-folder")];
  assert.equal(folders.length, 1);
  assert.equal(folders[0].textContent, "Chips");

  const folderBody = host.querySelector(".palette-folder-groups");
  const groupsIn = (root) =>
    [...root.querySelectorAll(".palette-group")].map((g) => g.textContent);

  // Every chip group lives inside the folder; the discrete/power groups don't.
  const chipGroupNames = [...new Set(CHIP_DEFS.map((d) => d.group))];
  assert.deepEqual(groupsIn(folderBody), chipGroupNames);
  for (const name of ["Parts", "Power"]) {
    assert.ok(!groupsIn(folderBody).includes(name), `${name} nested wrongly`);
    assert.ok(
      groupsIn(host).includes(name), // still present, just at the top level
    );
  }

  // Every chip item sits under the folder; no part item does.
  const chipIds = new Set(CHIP_DEFS.map((d) => d.id));
  for (const item of host.querySelectorAll(".palette-item")) {
    const underFolder = folderBody.contains(item);
    assert.equal(underFolder, chipIds.has(item.dataset.ref), item.dataset.ref);
  }
});

test("the 'Chips' folder starts shut and toggles the whole chip section", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  new PalettePanel(host, {});

  // Shut on arrival — the palette always opens in this one known state.
  const folder = host.querySelector(".palette-folder");
  assert.equal(folder.classList.contains("palette-folder--collapsed"), true);
  assert.equal(folder.getAttribute("aria-expanded"), "false");
  assert.equal(host.querySelector(".palette-folder-groups").hidden, true);

  // Clicking opens the whole chip section…
  folder.click();
  const opened = host.querySelector(".palette-folder");
  assert.equal(opened.classList.contains("palette-folder--collapsed"), false);
  assert.equal(opened.getAttribute("aria-expanded"), "true");
  assert.equal(host.querySelector(".palette-folder-groups").hidden, false);

  // …and clicking again shuts it.
  opened.click();
  assert.equal(host.querySelector(".palette-folder-groups").hidden, true);
});

test("filter matches id, title, and blurb (case-insensitive)", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const panel = new PalettePanel(host, {});
  const ids = () =>
    [...host.querySelectorAll(".palette-item")].map((i) => i.dataset.ref);

  typeFilter(panel.element, "7400");
  assert.deepEqual(ids(), ["7400"]);

  typeFilter(panel.element, "nor"); // title match: 7402 + 7427
  assert.deepEqual(ids().sort(), ["7402", "7427"]);

  typeFilter(panel.element, "TRI-STATE"); // blurb match, case-insensitive
  assert.deepEqual(ids(), ["74125"]);

  typeFilter(panel.element, "zzz");
  assert.deepEqual(ids(), []);
  assert.ok(host.querySelector(".palette-empty"));

  typeFilter(panel.element, "");
  assert.equal(ids().length, PALETTE_DEFS.length);
});

test("group titles expand/collapse the parts beneath them", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  new PalettePanel(host, {});

  const firstGroup = host.querySelector(".palette-group");
  const itemsFor = (headerEl) => headerEl.nextElementSibling;

  // Shut by default, like every other section.
  assert.equal(firstGroup.classList.contains("palette-group--collapsed"), true);
  assert.equal(firstGroup.getAttribute("aria-expanded"), "false");
  assert.equal(itemsFor(firstGroup).hidden, true);

  // Clicking the header reveals the group's items (the header stays put).
  firstGroup.click();
  const openedHeader = host.querySelector(".palette-group");
  assert.equal(
    openedHeader.classList.contains("palette-group--collapsed"),
    false,
  );
  assert.equal(openedHeader.getAttribute("aria-expanded"), "true");
  assert.equal(itemsFor(openedHeader).hidden, false);

  // Clicking again shuts it.
  openedHeader.click();
  const reclosed = host.querySelector(".palette-group");
  assert.equal(reclosed.classList.contains("palette-group--collapsed"), true);
  assert.equal(itemsFor(reclosed).hidden, true);
});

test("an active filter forces collapsed groups open so matches show", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const panel = new PalettePanel(host, {});

  // Everything starts shut, so a filter has to override that to show a hit.
  const header = host.querySelector(".palette-group");
  const groupName = header.textContent;
  const memberRef =
    header.nextElementSibling.querySelector(".palette-item").dataset.ref;
  assert.equal(header.classList.contains("palette-group--collapsed"), true);

  typeFilter(panel.element, memberRef);
  const filteredHeader = host.querySelector(".palette-group");
  assert.equal(filteredHeader.textContent, groupName);
  assert.equal(
    filteredHeader.classList.contains("palette-group--collapsed"),
    false,
  );
  assert.ok(host.querySelector(`.palette-item[data-ref="${memberRef}"]`));

  // Clearing the filter shuts it again.
  typeFilter(panel.element, "");
  assert.equal(
    host
      .querySelector(".palette-group")
      .classList.contains("palette-group--collapsed"),
    true,
  );
});

test("every section starts collapsed, and opening one is session-only", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  new PalettePanel(host, {});

  // No section — folder or group — is open on arrival.
  const sections = [
    ...host.querySelectorAll(".palette-folder, .palette-group"),
  ];
  assert.ok(sections.length > 1, "there are sections to collapse");
  assert.deepEqual(
    sections.filter((h) => h.getAttribute("aria-expanded") === "true"),
    [],
  );
  // Every group name in the catalog is represented.
  const groups = new Set(PALETTE_DEFS.map((d) => d.group));
  assert.equal(host.querySelectorAll(".palette-group").length, groups.size);

  // Opening one sticks for this panel…
  host.querySelector(".palette-group").click();
  assert.equal(
    host
      .querySelector(".palette-group")
      .classList.contains("palette-group--collapsed"),
    false,
  );

  // …but a fresh panel — i.e. the next launch — is shut again.
  const host2 = document.createElement("div");
  document.body.append(host2);
  new PalettePanel(host2, {});
  assert.equal(
    host2
      .querySelector(".palette-group")
      .classList.contains("palette-group--collapsed"),
    true,
  );
});

test("setVisible toggles the hidden attribute", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const panel = new PalettePanel(host, {});
  assert.equal(panel.visible, false); // hidden until app.js applies settings
  panel.setVisible(true);
  assert.equal(panel.visible, true);
  assert.equal(panel.element.hidden, false);
  panel.setVisible(false);
  assert.equal(panel.element.hidden, true);
});
