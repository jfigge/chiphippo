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
import { ALL_KIT_KEYS } from "../model/board-types.js";

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
  // Logic chips (catalog order, minus Memory), then Memory on its own, then the
  // COMPONENTS sub-groups in their shelf order.
  const chipGroupNames = [...new Set(CHIP_DEFS.map((d) => d.group))].filter(
    (g) => g !== "Memory",
  );
  assert.deepEqual(groups, [
    ...chipGroupNames,
    "Switches",
    "Resistors",
    "LEDs",
    "Displays",
    "Oscillators",
    "Power",
    "Memory",
  ]);

  host.querySelector('.palette-item[data-ref="74LS86"]').click();
  assert.deepEqual(picked, ["74LS86"]);
  assert.ok(panel.element);
});

test("logic chips nest under CHIPS; Memory + parts are their own sections", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  new PalettePanel(host, {});

  // Two folders, in order: CHIPS then COMPONENTS.
  const folders = [...host.querySelectorAll(".palette-folder")].map(
    (f) => f.textContent,
  );
  assert.deepEqual(folders, ["CHIPS", "COMPONENTS"]);

  const bodies = [...host.querySelectorAll(".palette-folder-groups")];
  const groupsIn = (root) =>
    [...root.querySelectorAll(".palette-group")].map((g) => g.textContent);

  // Logic chips (minus Memory) fill the CHIPS folder; the parts fill COMPONENTS.
  const chipGroupNames = [...new Set(CHIP_DEFS.map((d) => d.group))].filter(
    (g) => g !== "Memory",
  );
  assert.deepEqual(groupsIn(bodies[0]), chipGroupNames);
  assert.deepEqual(groupsIn(bodies[1]), [
    "Switches",
    "Resistors",
    "LEDs",
    "Displays",
    "Oscillators",
    "Power",
  ]);

  // Memory is pulled OUT of both folders into its own top-level group.
  assert.ok(!groupsIn(bodies[0]).includes("Memory"), "not under CHIPS");
  assert.ok(!groupsIn(bodies[1]).includes("Memory"), "not under COMPONENTS");
  assert.ok(groupsIn(host).includes("Memory"), "present at the top level");

  // The CHIPS folder holds exactly the non-memory chip items; memory items are
  // NOT under it (they moved to the top-level Memory group).
  const memIds = new Set(
    CHIP_DEFS.filter((d) => d.group === "Memory").map((d) => d.id),
  );
  const chipIds = new Set(
    CHIP_DEFS.map((d) => d.id).filter((id) => !memIds.has(id)),
  );
  const idsIn = (root) =>
    new Set(
      [...root.querySelectorAll(".palette-item")].map((i) => i.dataset.ref),
    );
  assert.deepEqual(idsIn(bodies[0]), chipIds);
  for (const id of memIds) {
    assert.ok(!idsIn(bodies[0]).has(id), `${id} not under CHIPS`);
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

  typeFilter(panel.element, "74LS00");
  assert.deepEqual(ids(), ["74LS00"]);

  typeFilter(panel.element, "nor"); // title match: 74LS02 + 74LS27
  assert.deepEqual(ids().sort(), ["74LS02", "74LS27"]);

  typeFilter(panel.element, "EXCLUSIVE"); // blurb-only match, case-insensitive
  assert.deepEqual(ids(), ["74LS86"]);

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

test("the board selector is pinned at the top and reports the kit key", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const picked = [];
  new PalettePanel(host, { onPickBoard: (kit) => picked.push(kit) });

  // "BOARDS" is the palette's first entry — above the Chips folder.
  const list = host.querySelector(".palette-list");
  assert.ok(list.firstElementChild.classList.contains("palette-boards-folder"));
  assert.equal(list.firstElementChild.textContent, "BOARDS");

  // Every kit — assembled boards then loose strips — in menu order.
  const kits = [...host.querySelectorAll(".palette-board-item")].map(
    (b) => b.dataset.kit,
  );
  assert.deepEqual(kits, [...ALL_KIT_KEYS]);
  // Board entries are NOT counted as parts (distinct class).
  assert.equal(
    host.querySelectorAll(".palette-item").length,
    PALETTE_DEFS.length,
  );

  host.querySelector('.palette-board-item[data-kit="full"]').click();
  assert.deepEqual(picked, ["full"]);
});

test("the Boards section starts folded and opens on click", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  new PalettePanel(host, {});

  const header = host.querySelector(".palette-boards-folder");
  const items = () => host.querySelector(".palette-boards-items");
  // Shut on arrival — like every other section.
  assert.equal(
    header.classList.contains("palette-boards-folder--collapsed"),
    true,
  );
  assert.equal(header.getAttribute("aria-expanded"), "false");
  assert.equal(items().hidden, true);

  header.click(); // open it
  const opened = host.querySelector(".palette-boards-folder");
  assert.equal(
    opened.classList.contains("palette-boards-folder--collapsed"),
    false,
  );
  assert.equal(opened.getAttribute("aria-expanded"), "true");
  assert.equal(items().hidden, false);

  opened.click(); // and fold it away again
  assert.equal(host.querySelector(".palette-boards-items").hidden, true);
});

test("the board selector hides while a parts filter is active", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const panel = new PalettePanel(host, {});
  assert.ok(host.querySelector(".palette-boards-folder"));

  typeFilter(panel.element, "74LS00");
  assert.equal(host.querySelector(".palette-boards-folder"), null);
  assert.equal(host.querySelectorAll(".palette-board-item").length, 0);

  typeFilter(panel.element, ""); // clearing restores it
  assert.ok(host.querySelector(".palette-boards-folder"));
});

test("the annotations section is pinned at the bottom and reports the kind", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const picked = [];
  const panel = new PalettePanel(host, {
    onPickAnnotation: (kind) => picked.push(kind),
  });

  // ANNOTATIONS is the palette's LAST section (below every part group): its
  // items container is the list's final child, right after the folder header.
  const list = host.querySelector(".palette-list");
  const folder = host.querySelector(".palette-annotations-folder");
  assert.ok(folder, "annotations folder present");
  assert.equal(folder.textContent, "ANNOTATIONS");
  assert.ok(list.lastElementChild.classList.contains("palette-group-items"));
  assert.equal(list.lastElementChild.previousElementSibling, folder);

  // Label + Note, each reporting its kind — and NOT counted among catalog parts.
  const items = host.querySelectorAll(".palette-annotation-item");
  assert.equal(items.length, 2);
  host
    .querySelector('.palette-annotation-item[data-annotation="note"]')
    .click();
  assert.deepEqual(picked, ["note"]);

  // It hides while the (chip) filter is active, like the boards folder.
  typeFilter(panel.element, "74LS00");
  assert.equal(host.querySelector(".palette-annotations-folder"), null);
});

/** Drag the tray's right edge from `fromX` to `toX` and release there. The
    gesture's move/up listeners live on `window` (pointer-gesture.js), which is
    exactly what makes a release off the handle still land. */
function dragEdge(host, fromX, toX, { release = true } = {}) {
  const handle = host.querySelector(".palette-resize");
  const at = (type, clientX, target) =>
    target.dispatchEvent(
      new window.MouseEvent(type, { clientX, bubbles: true }),
    );
  at("pointerdown", fromX, handle);
  at("pointermove", toX, window);
  if (release) at("pointerup", toX, window);
  return handle;
}

test("the tray restores its width, and its right edge resizes it", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const widths = [];
  const panel = new PalettePanel(host, {
    width: 300,
    onWidthChange: (w) => widths.push(w),
  });

  // The restored width is applied, not merely remembered.
  assert.equal(panel.width, 300);
  assert.equal(panel.element.style.width, "300px");

  // Dragging the edge right widens the left-docked tray by the same delta…
  const handle = dragEdge(host, 300, 380, { release: false });
  assert.equal(panel.width, 380);
  assert.equal(panel.element.style.width, "380px");
  assert.ok(handle.classList.contains("palette-resize--active"));
  // …and nothing is persisted until the drag settles.
  assert.deepEqual(widths, []);

  window.dispatchEvent(
    new window.MouseEvent("pointerup", { clientX: 380, bubbles: true }),
  );
  assert.deepEqual(widths, [380]);
  assert.equal(handle.classList.contains("palette-resize--active"), false);
});

test("the width is clamped to a legible minimum and half the window", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const panel = new PalettePanel(host, { width: 300 });
  const half = Math.floor(window.innerWidth * 0.5);

  dragEdge(host, 300, 0); // dragged shut past the minimum
  assert.equal(panel.width, 180);

  dragEdge(host, 180, 5000); // dragged out past the desk
  assert.equal(panel.width, half);

  // A width restored from a session on a wider display is clamped on arrival.
  const host2 = document.createElement("div");
  document.body.append(host2);
  assert.equal(new PalettePanel(host2, { width: 4000 }).width, half);
  // …as is a garbled one, which falls back to the shipped default.
  const host3 = document.createElement("div");
  document.body.append(host3);
  assert.equal(new PalettePanel(host3, { width: null }).width, 232);
});

test("the width survives closing and reopening the tray", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const panel = new PalettePanel(host, { width: 320 });

  panel.setVisible(true);
  panel.setVisible(false); // shut: hidden, never rebuilt
  panel.setVisible(true);
  assert.equal(panel.width, 320);
  assert.equal(panel.element.style.width, "320px");
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
