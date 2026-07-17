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

// chip-eval.js — the ONE generic evaluator. For combinational parts it walks a
// def's `logic.units` (pure data, see catalog/chips-gates.js) and drives each
// output pin from its input pins; for sequential parts (Feature 100) it
// dispatches to the def's `logic.step`/`logic.outputs` pure functions (built by
// sim/sequential.js). There is deliberately NO per-chip code: a new 74xx part
// is new data; if a part can't be expressed, extend the vocabulary here —
// never fork the evaluator.
//
// This is zero-delay, power-agnostic logic. VCC/GND checking, supply voltages,
// the tick pipeline, and damage are the engine's concern (Feature 90/100).

import { asInput, and, or, nand, nor, xor, inv, buf3, Z } from "./levels.js";

/** Gate fn name → n-ary primitive. INV/BUF3/COMB are handled specially. */
const GATES = Object.freeze({
  NAND: nand,
  NOR: nor,
  AND: and,
  OR: or,
  XOR: xor,
});

/** Does this def carry combinational (unit-based) behavior? */
export function hasLogic(def) {
  return Boolean(def?.logic?.units?.length);
}

/** Does this def carry sequential (stateful) behavior? */
export function isSequential(def) {
  return typeof def?.logic?.step === "function";
}

/** Does this def carry ANY simulated behavior (combinational or sequential)? */
export function hasBehavior(def) {
  return hasLogic(def) || isSequential(def);
}

/** The fresh per-component state for a sequential def (never in the doc). */
export function initialState(def) {
  return isSequential(def) ? def.logic.state0() : null;
}

/**
 * Evaluate a powered combinational chip: given the levels present on its pins,
 * what does it drive on its outputs? A `units` block may mix simple gates,
 * tri-state buffers, and `COMB` units (a pure `compute(levels)` fn over shared
 * inputs — the decoder/mux vocabulary, whose inputs legitimately fan out).
 *
 * @param {object} def - a catalog def with a `logic.units` block.
 * @param {Map<number, string>} pinLevels - pin number → level (H/L/Z/X). A
 *   missing pin is treated as floating (`Z` → reads HIGH via asInput).
 * @returns {Map<number, string>} output pin → driven level.
 */
export function evaluate(def, pinLevels) {
  const out = new Map();
  if (!hasLogic(def)) return out;

  // Every input pin is read through asInput, so a floating (Z) pin reads H
  // and Z never reaches a gate primitive.
  const level = (pin) => asInput(pinLevels.get(pin) ?? Z);

  for (const unit of def.logic.units) {
    let value;
    if (unit.fn === "INV") {
      value = inv(level(unit.inputs[0]));
    } else if (unit.fn === "BUF3") {
      value = buf3(level(unit.inputs[0]), level(unit.enable));
    } else if (unit.fn === "COMB") {
      value = unit.compute(unit.inputs.map(level));
    } else {
      const fn = GATES[unit.fn];
      if (!fn) {
        const err = new Error(`unknown logic fn: ${unit.fn}`);
        err.code = "INVALID_FN";
        throw err;
      }
      value = fn(...unit.inputs.map(level));
    }
    out.set(unit.output, value);
  }
  return out;
}

/**
 * The input-pin levels a sequential/latch chip reads, keyed by pin number and
 * already `asInput`'d (Z → H) so `step`/`outputs` see only H/L/X.
 * @param {object} def
 * @param {Map<number, string>} pinLevels
 * @returns {Map<number, string>}
 */
export function inputLevels(def, pinLevels) {
  const ins = new Map();
  for (const p of def.pins) {
    if (p.role === "input") ins.set(p.n, asInput(pinLevels.get(p.n) ?? Z));
  }
  return ins;
}

/**
 * Advance a sequential chip one tick: sample edges from `inputs` vs
 * `prevInputs` (null on the first tick — no edge) and compute the next state.
 * Pure — returns the new state, never mutates.
 * @returns {*} the def-specific next state
 */
export function stepChip(def, state, inputs, prevInputs) {
  return def.logic.step(state, inputs, prevInputs);
}

/**
 * What a sequential chip drives on its outputs given its current state and
 * (for transparent latches) its live input levels.
 * @returns {Map<number, string>} output pin → level
 */
export function outputsOf(def, state, inputs) {
  return def.logic.outputs(state, inputs);
}
