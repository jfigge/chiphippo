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

// default-names.test.js — the number a Properties card's Name placeholder
// carries: a subject's place among its own kind, in id order.

import test from "node:test";
import assert from "node:assert/strict";
import {
  idNumber,
  defaultOrdinal,
  partOrdinal,
} from "../model/default-names.js";

test("idNumber reads an id's trailing number", () => {
  assert.equal(idNumber("c12"), 12);
  assert.equal(idNumber("clk3"), 3);
  assert.equal(idNumber("w1"), 1);
  assert.equal(idNumber("bb"), null);
  assert.equal(idNumber(undefined), null);
});

test("a part counts among parts of its own ref, oldest first", () => {
  const parts = [
    { id: "c10", ref: "resistor" },
    { id: "c2", ref: "resistor" },
    { id: "c5", ref: "led" },
    { id: "clk1", ref: "clock" },
  ];
  assert.equal(partOrdinal(parts, parts[1]), 1); // c2 before c10, numerically
  assert.equal(partOrdinal(parts, parts[0]), 2);
  assert.equal(partOrdinal(parts, parts[2]), 1);
  assert.equal(partOrdinal(parts, parts[3]), 1);
});

test("an item not yet in the list counts as the next one", () => {
  const wires = [{ id: "w1" }, { id: "w4" }];
  assert.equal(defaultOrdinal(wires, { id: "w9" }), 3);
  assert.equal(defaultOrdinal([], { id: "w9" }), 1);
});
