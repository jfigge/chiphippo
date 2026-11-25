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

// The shared either/or picker (components/segmented-picker.js) in jsdom: one
// tab stop, the arrow keys moving the choice as a native radio group's do,
// and a greyed option skipped.
import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { buildSegmented } from "../components/segmented-picker.js";

const key = (node, k) =>
  node.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true })); // prettier-ignore

test("a segmented picker is one tab stop, and the arrow keys move the choice", () => {
  resetDom();
  const picked = [];
  const track = buildSegmented({
    options: [
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
      { value: "c", label: "C" },
    ],
    value: "a",
    ariaLabel: "Pick",
    onPick: (v) => picked.push(v),
  });
  document.body.append(track);
  const [a, b, c] = track.querySelectorAll("button");
  assert.deepEqual([a.tabIndex, b.tabIndex, c.tabIndex], [0, -1, -1]);
  a.focus();
  key(a, "ArrowRight"); // over the greyed B
  assert.equal(document.activeElement, c);
  assert.equal(c.getAttribute("aria-checked"), "true");
  assert.deepEqual([a.tabIndex, c.tabIndex], [-1, 0]);
  key(c, "ArrowRight"); // wraps
  assert.equal(document.activeElement, a);
  key(a, "End");
  key(c, "Home");
  assert.deepEqual(picked, ["c", "a", "c", "a"]);
  // A key that is not a move is left alone.
  key(a, "x");
  assert.deepEqual(picked, ["c", "a", "c", "a"]);
});
