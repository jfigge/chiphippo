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
// jsdom tests for components/pin-fields-editor.js — the Properties card's
// "Pins" control for an Output or Input element. The sixteen-pin cap is the
// rule it exists to hold, so the tests walk it from both sides: an Add that
// would overflow is disabled, a type change that would overflow is REFUSED
// (the old type put back) rather than dropping the fields after it. Every
// change reports the whole normalized list.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { buildPinFieldsEditor } =
  await import("../components/pin-fields-editor.js");

function mount(value) {
  const win = resetDom();
  const changes = [];
  const root = buildPinFieldsEditor({
    value,
    onChange: (fields) => changes.push(fields),
    ariaLabel: "Pins",
  });
  win.document.body.append(root);
  const rows = () => [...root.querySelectorAll(".pin-fields-row")];
  const pins = () =>
    rows().map((r) => r.querySelector(".pin-fields-pins").textContent);
  const addBtn = (label) =>
    [...root.querySelectorAll(".pin-fields-add-btn")].find(
      (b) => b.textContent === `+ ${label}`,
    );
  const fire = (node, type) =>
    node.dispatchEvent(new win.Event(type, { bubbles: true }));
  return { win, root, changes, rows, pins, addBtn, fire };
}

test("one row per field, each saying which pins it owns", () => {
  const { root, rows, pins } = mount([
    { type: "bit", name: "go" },
    { type: "byte", name: "data" },
    { type: "bit", name: "" },
  ]);
  assert.equal(root.getAttribute("aria-label"), "Pins");
  assert.equal(rows().length, 3);
  assert.deepEqual(pins(), ["1", "2–9", "10"]);
  assert.deepEqual(
    rows().map((r) => r.querySelector(".pin-fields-name").value),
    ["go", "data", "bit9"],
    "a blank name takes its default: its type and first value bit",
  );
  assert.equal(
    root.querySelector(".pin-fields-count").textContent,
    "10 of 16 pins",
  );
});

test("Add appends a field with a default name and reports the whole list", () => {
  const { changes, pins, addBtn } = mount([{ type: "bit", name: "a" }]);
  addBtn("Byte").click();
  assert.deepEqual(changes.at(-1), [
    { type: "bit", name: "a" },
    { type: "byte", name: "byte1" },
  ]);
  assert.deepEqual(pins(), ["1", "2–9"], "the editor re-renders from it");
});

test("an Add that would pass sixteen pins is disabled", () => {
  const { addBtn } = mount([{ type: "byte", name: "a" }]);
  assert.equal(addBtn("Bit").disabled, false);
  assert.equal(addBtn("Byte").disabled, false, "8 + 8 is exactly 16");
  assert.equal(addBtn("Word").disabled, true, "8 + 16 is not");
  addBtn("Byte").click();
  assert.equal(addBtn("Bit").disabled, true, "full");
  assert.equal(addBtn("Byte").disabled, true);
});

test("remove is disabled on the last field, and removes the right one otherwise", () => {
  const { changes, rows } = mount([
    { type: "bit", name: "a" },
    { type: "bit", name: "b" },
  ]);
  rows()[0].querySelector(".pin-fields-remove").click();
  assert.deepEqual(changes.at(-1), [{ type: "bit", name: "b" }]);
  const last = rows()[0].querySelector(".pin-fields-remove");
  assert.equal(last.disabled, true, "an element never has no pins");
});

test("a rename commits on change, trimmed, as the whole list", () => {
  const { rows, changes, fire } = mount([
    { type: "bit", name: "a" },
    { type: "byte", name: "b" },
  ]);
  const input = rows()[1].querySelector(".pin-fields-name");
  input.value = "  speed  ";
  fire(input, "change");
  assert.deepEqual(changes.at(-1), [
    { type: "bit", name: "a" },
    { type: "byte", name: "speed" },
  ]);
});

test("a rename rebuilds nothing, so the click that caused its blur still lands", () => {
  // A name commits on blur, and a press on "+ Byte" is what blurs it — at
  // MOUSEDOWN. Rebuilding the rows then replaces the button before its
  // mouseup and Chromium drops the click (checked in Electron), so the rows
  // must be the very nodes they were.
  const { root, rows, addBtn, changes, fire } = mount([
    { type: "bit", name: "a" },
  ]);
  const add = addBtn("Byte");
  const remove = rows()[0].querySelector(".pin-fields-remove");
  const input = rows()[0].querySelector(".pin-fields-name");
  input.value = "   ";
  fire(input, "change");
  assert.equal(addBtn("Byte"), add, "the same button, still under the finger");
  assert.equal(rows()[0].querySelector(".pin-fields-remove"), remove);
  assert.equal(input.value, "bit0", "a blank name shows the default it became");
  assert.deepEqual(changes.at(-1), [{ type: "bit", name: "bit0" }]);
  add.click();
  assert.deepEqual(changes.at(-1), [
    { type: "bit", name: "bit0" },
    { type: "byte", name: "byte1" },
  ]);
  assert.equal(root.querySelectorAll(".pin-fields-row").length, 2);
});

test("a type change re-spans the pins", () => {
  const { rows, pins, changes, fire } = mount([
    { type: "bit", name: "a" },
    { type: "bit", name: "b" },
  ]);
  const select = rows()[0].querySelector(".pin-fields-type");
  select.value = "byte";
  fire(select, "change");
  assert.deepEqual(changes.at(-1), [
    { type: "byte", name: "a" },
    { type: "bit", name: "b" },
  ]);
  assert.deepEqual(pins(), ["1–8", "9"]);
});

test("a type that would overflow is offered disabled, and refused if picked anyway", () => {
  const { rows, changes, fire } = mount([
    { type: "byte", name: "a" },
    { type: "bit", name: "b" },
  ]);
  const select = rows()[1].querySelector(".pin-fields-type");
  const option = (v) => [...select.options].find((o) => o.value === v);
  assert.equal(option("byte").disabled, false, "8 + 8 fits");
  assert.equal(option("word").disabled, true, "8 + 16 does not");
  select.value = "word";
  fire(select, "change");
  assert.equal(changes.length, 0, "nothing reported");
  assert.equal(select.value, "bit", "the old type is put back");
});

test("junk in, a valid list out: never empty, never past sixteen pins", () => {
  const { pins } = mount([{ type: "nibble" }, null]);
  assert.deepEqual(pins(), ["1"], "an empty list becomes one bit");
  const over = mount([
    { type: "word", name: "w" },
    { type: "bit", name: "x" },
  ]);
  assert.deepEqual(
    over.pins(),
    ["1–16"],
    "the field that overflows is dropped",
  );
});
