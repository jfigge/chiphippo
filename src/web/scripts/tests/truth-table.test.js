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

// The exhaustive truth-table harness: every catalog chip × every unit × every
// H/L input combination, checked against an independent reference expression —
// so adding a future chip means adding data, and this picks it up. Plus the
// TTL special cases: floating (Z) inputs read HIGH, X propagation, and 74125
// tri-state enable/disable.

import test from "node:test";
import assert from "node:assert/strict";

import { CHIP_DEFS } from "../catalog/index.js";
import { H, L, X, Z } from "../sim/levels.js";
import { evaluate, hasLogic } from "../sim/chip-eval.js";

/** The independent reference: what SHOULD a unit output for H/L inputs? */
function reference(unit, valueOf) {
  const hi = (pin) => valueOf(pin) === H;
  switch (unit.fn) {
    case "AND":
      return unit.inputs.every(hi) ? H : L;
    case "OR":
      return unit.inputs.some(hi) ? H : L;
    case "NAND":
      return unit.inputs.every(hi) ? L : H;
    case "NOR":
      return unit.inputs.some(hi) ? L : H;
    case "XOR":
      return unit.inputs.filter(hi).length % 2 === 1 ? H : L;
    case "INV":
      return hi(unit.inputs[0]) ? L : H;
    case "BUF3":
      // Active-low enable: enabled (L) passes the data level; disabled (H) → Z.
      return hi(unit.enable) ? Z : valueOf(unit.inputs[0]);
    default:
      throw new Error(`no reference for ${unit.fn}`);
  }
}

/** The pins a unit reads (data inputs + a tri-state enable). */
function unitPins(unit) {
  return unit.enable != null ? [...unit.inputs, unit.enable] : unit.inputs;
}

let totalCases = 0;

/** Gate vocabulary this exhaustive harness enumerates (decoder/mux `COMB`
    units and sequential defs are checked by their own fixture suites). */
const GATE_FNS = new Set(["AND", "OR", "NAND", "NOR", "XOR", "INV", "BUF3"]);
const GATE_DEFS = CHIP_DEFS.filter(
  (def) => hasLogic(def) && def.logic.units.some((u) => GATE_FNS.has(u.fn)),
);

for (const def of GATE_DEFS) {
  test(`${def.id}: exhaustive truth table on every unit`, () => {
    assert.ok(hasLogic(def), `${def.id} has no logic block`);
    for (const unit of def.logic.units) {
      if (!GATE_FNS.has(unit.fn)) continue; // COMB units: not this harness
      const pins = unitPins(unit);
      const combos = 1 << pins.length;
      for (let mask = 0; mask < combos; mask++) {
        const assign = new Map();
        pins.forEach((pin, i) => assign.set(pin, mask & (1 << i) ? H : L));
        const valueOf = (pin) => assign.get(pin);
        const expected = reference(unit, valueOf);
        const got = evaluate(def, assign).get(unit.output);
        assert.equal(
          got,
          expected,
          `${def.id} ${unit.fn}(${pins.map(valueOf).join(",")}) → pin ${unit.output}`,
        );
        totalCases++;
      }
    }
  });
}

test("the harness exercised a substantial case count (7430 alone is 256)", () => {
  // 7430's single 8-input gate contributes 2^8 = 256 on its own.
  assert.ok(totalCases >= 256 + 100, `only ${totalCases} cases ran`);
});

// ── TTL special cases ────────────────────────────────────────────────────────

const levels = (obj) => new Map(Object.entries(obj).map(([k, v]) => [+k, v]));
const chip = (id) => CHIP_DEFS.find((d) => d.id === id);

test("floating (Z) inputs read HIGH everywhere", () => {
  // 7408 AND unit [1,2] → 3: one input floating reads H.
  assert.equal(evaluate(chip("7408"), levels({ 1: Z, 2: H })).get(3), H);
  assert.equal(evaluate(chip("7408"), levels({ 1: Z, 2: L })).get(3), L);
  // 7404 inverter, floating input → H → output L.
  assert.equal(evaluate(chip("7404"), levels({ 1: Z })).get(2), L);
  // A fully-unset 7400 NAND reads all-H → L.
  assert.equal(evaluate(chip("7400"), new Map()).get(3), L);
});

test("X propagates except where a dominant input forces the output", () => {
  // 7400 NAND: X with H → X; X with L → H (L dominates).
  assert.equal(evaluate(chip("7400"), levels({ 1: X, 2: H })).get(3), X);
  assert.equal(evaluate(chip("7400"), levels({ 1: X, 2: L })).get(3), H);
  // 7427 NOR: X with L → X; X with H → L (H dominates).
  assert.equal(
    evaluate(chip("7427"), levels({ 1: X, 2: L, 13: L })).get(12),
    X,
  );
  assert.equal(
    evaluate(chip("7427"), levels({ 1: X, 2: H, 13: L })).get(12),
    L,
  );
});

test("7402: outputs are on the LOW pins (unit order proof)", () => {
  // Unit 1 reads 1A(2)/1B(3) and drives 1Y on pin 1 — not pin 3.
  assert.equal(evaluate(chip("7402"), levels({ 2: L, 3: L })).get(1), H);
  assert.equal(evaluate(chip("7402"), levels({ 2: H, 3: L })).get(1), L);
});

test("7430: the single 8-input NAND is L only when all eight are HIGH", () => {
  const all = chip("7430").logic.units[0].inputs;
  const allHigh = new Map(all.map((p) => [p, H]));
  assert.equal(evaluate(chip("7430"), allHigh).get(8), L);
  // Drop any one input to L → output H.
  const oneLow = new Map(allHigh);
  oneLow.set(all[3], L);
  assert.equal(evaluate(chip("7430"), oneLow).get(8), H);
});

test("74125: each buffer drives its output only when enabled (G low)", () => {
  const c = chip("74125");
  // Buffer 1: enable 1G(1), data 1A(2), out 1Y(3).
  assert.equal(evaluate(c, levels({ 1: L, 2: H })).get(3), H); // enabled → pass
  assert.equal(evaluate(c, levels({ 1: L, 2: L })).get(3), L);
  assert.equal(evaluate(c, levels({ 1: H, 2: H })).get(3), Z); // disabled → Z
  assert.equal(evaluate(c, levels({ 2: H })).get(3), Z); // floating G → H → Z
});
