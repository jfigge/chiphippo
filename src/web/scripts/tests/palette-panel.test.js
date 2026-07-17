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
