/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// The toolbar labels (Settings ▸ Appearance ▸ Toolbar labels): the helpers
// that put a word under an icon without disturbing the glyph, and the
// catalog's side of it — every label key carries a translator note, and every
// shipped translation stays short enough for one line under a 16 px icon.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";

const {
  setSegmentIcon,
  setSegmentLabel,
  showToolbarLabels,
  LABELS_CLASS,
  LABEL_CLASS,
} = await import("../components/toolbar-labels.js");

const catalog = (lang) =>
  JSON.parse(
    fs.readFileSync(new URL(`../../locales/${lang}.json`, import.meta.url), "utf8"), // prettier-ignore
  );
const LANGS = ["en", "de", "es", "fr", "it", "ja", "zh"];

const SVG_A = '<svg data-icon="a"></svg>';
const SVG_B = '<svg data-icon="b"></svg>';

test("a label goes after the glyph, once, and is rewritten in place", () => {
  resetDom();
  const btn = document.createElement("button");
  btn.innerHTML = SVG_A;
  setSegmentLabel(btn, "Fit");
  setSegmentLabel(btn, "Anpassen");
  const labels = btn.querySelectorAll(`.${LABEL_CLASS}`);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].textContent, "Anpassen");
  assert.equal(labels[0].getAttribute("aria-hidden"), "true");
  assert.equal(btn.firstElementChild.dataset.icon, "a");
});

test("swapping the glyph keeps the label and any readout beside it", () => {
  resetDom();
  const btn = document.createElement("button");
  btn.innerHTML = SVG_A;
  const dot = document.createElement("span");
  btn.append(dot);
  setSegmentLabel(btn, "Code");
  setSegmentIcon(btn, SVG_B);
  assert.equal(btn.querySelectorAll("svg").length, 1);
  assert.equal(btn.firstElementChild.dataset.icon, "b");
  assert.ok(btn.contains(dot));
  assert.equal(btn.querySelector(`.${LABEL_CLASS}`).textContent, "Code");
});

test("showing the labels is one class on the header", () => {
  resetDom();
  const header = document.createElement("header");
  showToolbarLabels(header, true);
  assert.ok(header.classList.contains(LABELS_CLASS));
  showToolbarLabels(header, "yes"); // anything but true is Off
  assert.ok(!header.classList.contains(LABELS_CLASS));
});

test("every toolbar label key carries a translator note, and no note is stale", () => {
  const en = catalog("en");
  const keys = Object.keys(en.toolbar.labels).map((k) => `toolbar.labels.${k}`);
  const notes = en._meta.notes ?? {};
  for (const key of keys) {
    assert.match(notes[key] ?? "", /8 characters/, `${key} has its note`);
  }
  for (const key of Object.keys(notes).filter((k) =>
    k.startsWith("toolbar.labels."),
  )) {
    assert.ok(keys.includes(key), `${key}: a note for a label that is gone`);
  }
});

test("every shipped label is short: one line under its icon", () => {
  // The brief's limit is ~8 characters; ten is the ceiling a test holds, so a
  // translation that grows past it is a decision, not a drift.
  for (const lang of LANGS) {
    for (const [key, word] of Object.entries(catalog(lang).toolbar.labels)) {
      assert.ok(
        [...word].length <= 10,
        `${lang} toolbar.labels.${key} "${word}" is ${[...word].length} characters`,
      );
    }
  }
});
