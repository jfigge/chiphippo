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
import { PALETTE_DEFS } from "../catalog/index.js";
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

test("group titles collapse/expand the parts beneath them", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  new PalettePanel(host, {});

  const firstGroup = host.querySelector(".palette-group");
  const itemsFor = (headerEl) => headerEl.nextElementSibling;

  // Open by default.
  assert.equal(
    firstGroup.classList.contains("palette-group--collapsed"),
    false,
  );
  assert.equal(firstGroup.getAttribute("aria-expanded"), "true");
  assert.equal(itemsFor(firstGroup).hidden, false);

  // Clicking the header collapses the group's items (but keeps the header).
  firstGroup.click();
  const collapsedHeader = host.querySelector(".palette-group");
  assert.equal(
    collapsedHeader.classList.contains("palette-group--collapsed"),
    true,
  );
  assert.equal(collapsedHeader.getAttribute("aria-expanded"), "false");
  assert.equal(itemsFor(collapsedHeader).hidden, true);

  // Clicking again re-opens it.
  collapsedHeader.click();
  const reopened = host.querySelector(".palette-group");
  assert.equal(reopened.classList.contains("palette-group--collapsed"), false);
  assert.equal(itemsFor(reopened).hidden, false);
});

test("an active filter forces collapsed groups open so matches show", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const panel = new PalettePanel(host, {});

  // Collapse the first group, then filter to a member of it.
  const header = host.querySelector(".palette-group");
  const groupName = header.textContent;
  const memberRef =
    header.nextElementSibling.querySelector(".palette-item").dataset.ref;
  header.click();
  assert.equal(
    host
      .querySelector(".palette-group")
      .classList.contains("palette-group--collapsed"),
    true,
  );

  typeFilter(panel.element, memberRef);
  const filteredHeader = host.querySelector(".palette-group");
  assert.equal(filteredHeader.textContent, groupName);
  assert.equal(
    filteredHeader.classList.contains("palette-group--collapsed"),
    false,
  );
  assert.ok(host.querySelector(`.palette-item[data-ref="${memberRef}"]`));

  // Clearing the filter restores the remembered collapsed state.
  typeFilter(panel.element, "");
  assert.equal(
    host
      .querySelector(".palette-group")
      .classList.contains("palette-group--collapsed"),
    true,
  );
});

test("collapsedGroups restores state and onCollapseChange reports toggles", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);

  const firstName = [...new Set(PALETTE_DEFS.map((d) => d.group))][0];
  const changes = [];
  const panel = new PalettePanel(host, {
    collapsedGroups: [firstName],
    onCollapseChange: (groups) => changes.push(groups),
  });

  // The restored group starts collapsed.
  const header = host.querySelector(".palette-group");
  assert.equal(header.textContent, firstName);
  assert.equal(header.classList.contains("palette-group--collapsed"), true);
  assert.equal(header.nextElementSibling.hidden, true);

  // Toggling reports the full collapsed set each time (not a delta).
  header.click(); // expand → now empty
  assert.deepEqual(changes.at(-1), []);
  host.querySelector(".palette-group").click(); // collapse again
  assert.deepEqual(changes.at(-1), [firstName]);
  assert.ok(panel.element);
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
