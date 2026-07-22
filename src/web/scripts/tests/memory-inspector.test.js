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

// jsdom tests for MemoryInspector — the virtualized hex/ASCII grid (Feature
// 190). A large image renders only a bounded pool of rows (not one per byte);
// editing a cell writes the RIGHT byte offset; fill-range + go-to are pure
// buffer ops; while running the grid is read-only and tints live writes.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { MemoryInspector } = await import("../components/memory-inspector.js");

const mount = (opts) => {
  const container = document.createElement("div");
  document.body.append(container);
  const grid = new MemoryInspector(container, opts);
  return { container, grid };
};
const rows = (container) => container.querySelectorAll(".mem-row");
const cell = (container, addr) =>
  container.querySelector(`.mem-hx[data-addr="${addr}"]`);
const mousedown = (elm, init = {}) =>
  elm.dispatchEvent(
    new window.MouseEvent("mousedown", { bubbles: true, ...init }),
  );

test("a large image renders only a bounded pool of rows, not one per byte", () => {
  resetDom();
  const { container, grid } = mount();
  grid.setBytes(new Uint8Array(32768)); // 2048 rows

  const pool = rows(container);
  assert.ok(pool.length < 64, `pooled ~viewport rows, got ${pool.length}`);
  const canvas = container.querySelector(".mem-grid-canvas");
  assert.equal(canvas.style.height, `${2048 * 22}px`, "spacer spans every row");
});

test("editing a hex cell writes the correct byte offset", () => {
  resetDom();
  const edits = [];
  const { container, grid } = mount({ onEdit: (c) => edits.push(c) });
  grid.setBytes(new Uint8Array(256));
  grid.setEditable(true);

  const target = cell(container, 0x25); // row 2, column 5
  assert.ok(target, "the target cell is rendered");
  mousedown(target);
  const input = target.querySelector(".mem-cell-edit");
  assert.ok(input, "clicking an editable cell opens an inline editor");
  input.value = "a5";
  input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));

  assert.deepEqual(edits, [{ type: "byte", addr: 0x25, value: 0xa5 }]);
  assert.equal(grid.getBytes()[0x25], 0xa5, "the buffer byte changed");
});

test("cells are inert (no editor) while read-only / running", () => {
  resetDom();
  const { container, grid } = mount();
  grid.setBytes(new Uint8Array(256));
  grid.setEditable(false);

  mousedown(cell(container, 3));
  assert.equal(
    container.querySelector(".mem-cell-edit"),
    null,
    "no editor opens",
  );
  assert.deepEqual(
    grid.selection,
    { start: 3, end: 3 },
    "but it still selects",
  );
});

test("fillRange fills the inclusive range and reports one edit", () => {
  resetDom();
  const edits = [];
  const { grid } = mount({ onEdit: (c) => edits.push(c) });
  grid.setBytes(new Uint8Array(256));

  grid.fillRange(0x10, 0x13, 0xff);
  const bytes = grid.getBytes();
  assert.deepEqual(
    [...bytes.slice(0x0f, 0x15)],
    [0, 0xff, 0xff, 0xff, 0xff, 0],
  );
  assert.deepEqual(edits, [
    { type: "fill", start: 0x10, end: 0x13, value: 0xff },
  ]);
});

test("gotoAddress selects the byte and scrolls its row into view", () => {
  resetDom();
  const { container, grid } = mount();
  grid.setBytes(new Uint8Array(4096));

  grid.gotoAddress(0x0800); // row 128
  assert.deepEqual(grid.selection, { start: 0x0800, end: 0x0800 });
  const scroll = container.querySelector(".mem-grid-scroll");
  assert.ok(scroll.scrollTop > 0, "scrolled down toward the target row");
});

test("applyChanges mutates + tints live writes while running", () => {
  resetDom();
  const { container, grid } = mount();
  grid.setBytes(new Uint8Array(256));
  grid.setEditable(false);

  grid.applyChanges([[0x05, 0x3c]]);
  assert.equal(grid.getBytes()[0x05], 0x3c, "the write lands in the buffer");
  assert.ok(
    cell(container, 0x05).classList.contains("mem-cell--written"),
    "and the cell is tinted as written",
  );
});
