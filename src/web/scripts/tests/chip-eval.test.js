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

// Tests for the generic combinational evaluator (against a synthetic def).

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, X, Z } from "../sim/levels.js";
import { evaluate, hasLogic } from "../sim/chip-eval.js";

// A synthetic part exercising every unit kind at once.
const SYNTH = {
  id: "synth",
  pins: [],
  logic: {
    units: [
      { fn: "NAND", inputs: [1, 2], output: 3 },
      { fn: "INV", inputs: [4], output: 5 },
      { fn: "BUF3", inputs: [6], enable: 7, output: 8 },
    ],
  },
};

const levels = (obj) => new Map(Object.entries(obj).map(([k, v]) => [+k, v]));

test("hasLogic: true only for defs carrying units", () => {
  assert.equal(hasLogic(SYNTH), true);
  assert.equal(hasLogic({ pins: [] }), false);
  assert.equal(hasLogic(null), false);
});

test("evaluate drives every unit's output", () => {
  const out = evaluate(SYNTH, levels({ 1: H, 2: H, 4: H, 6: L, 7: L }));
  assert.equal(out.get(3), L); // NAND(H,H)
  assert.equal(out.get(5), L); // INV(H)
  assert.equal(out.get(8), L); // BUF3 enabled → passes L
  assert.equal(out.size, 3);
});

test("evaluate: a missing pin floats (Z → reads HIGH)", () => {
  // Pin 2 unset → floats → reads H, so NAND(H,H) = L.
  const out = evaluate(SYNTH, levels({ 1: H }));
  assert.equal(out.get(3), L);
  // BUF3 enable pin 7 unset → floats → H → disabled → Z.
  assert.equal(out.get(8), Z);
});

test("evaluate: X propagates unless a dominant input forces it", () => {
  assert.equal(evaluate(SYNTH, levels({ 1: X, 2: H })).get(3), X);
  assert.equal(evaluate(SYNTH, levels({ 1: X, 2: L })).get(3), H); // L dominates
});

test("evaluate: a def without logic yields nothing", () => {
  assert.equal(evaluate({ pins: [] }, new Map()).size, 0);
});

test("evaluate: an unknown fn throws INVALID_FN", () => {
  const bad = { logic: { units: [{ fn: "MUX", inputs: [1], output: 2 }] } };
  assert.throws(() => evaluate(bad, new Map()), { code: "INVALID_FN" });
});
