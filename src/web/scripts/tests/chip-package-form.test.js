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

// The chip designer's package form (components/chip-package-form.js): its
// explanatory notes sit behind an (i) beside the control, as Settings' do —
// shut until asked for, floating over the rows below, and still open after
// the redraw every echo of an edit causes.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { newCustomChip } from "../model/custom-chip.js";

const { ChipPackageForm } = await import("../components/chip-package-form.js");

/** The row whose label reads `label`. */
const rowOf = (root, label) =>
  [...root.querySelectorAll(".cd-row")].find(
    (r) => r.querySelector(".cd-label").textContent === label,
  );

function mount(opts = {}) {
  resetDom();
  const form = new ChipPackageForm({ onChange: () => {} });
  document.body.append(form.element);
  const chip = newCustomChip([]);
  form.render(chip, opts);
  return { form, chip, root: form.element };
}

test("a note is an (i) beside the control, shut until asked for", () => {
  const { root } = mount();
  const row = rowOf(root, "Logic family");
  const info = row.querySelector(".cd-row-controls .info-btn");
  assert.ok(info, "the (i) sits with the controls");
  assert.equal(info.getAttribute("aria-label"), "More about Logic family");
  const card = row.querySelector(".cd-note");
  assert.equal(card.hidden, true, "no line of text under the row");
  assert.match(card.textContent, /inputs read when left open/);

  info.click();
  assert.equal(card.hidden, false);
  assert.equal(info.getAttribute("aria-expanded"), "true");
  info.click();
  assert.equal(card.hidden, true);
});

test("an open note survives the redraw an edit's echo causes", () => {
  const { form, chip, root } = mount();
  rowOf(root, "Units").querySelector(".info-btn").click();
  form.render({ ...chip, code: "assign Y = A & B;\n" });
  const card = rowOf(form.element, "Units").querySelector(".cd-note");
  assert.equal(card.hidden, false, "still open on the new rows");
});

test("a placed chip's locked size and width say why, behind the same (i)", () => {
  const { root } = mount({ placed: 2 });
  for (const label of ["Body width", "Pins per side"]) {
    const card = rowOf(root, label).querySelector(".cd-note");
    assert.ok(card, `${label} has a note`);
    assert.match(card.textContent, /placed \(2\)/);
  }
  // Unplaced, there is nothing to explain about them.
  const loose = mount();
  assert.equal(
    rowOf(loose.root, "Body width").querySelector(".info-btn"),
    null,
  );
});
