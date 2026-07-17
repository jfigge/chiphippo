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
