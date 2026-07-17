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

// chip-eval.js — the ONE generic combinational evaluator. It walks a def's
// `logic.units` (pure data, see catalog/chips-gates.js) and drives each
// output pin from its input pins. There is deliberately NO per-chip code: a
// new 74xx part is new data; if a part can't be expressed, extend the gate
// vocabulary here — never fork the evaluator.
//
// This is zero-delay, power-agnostic pure combinational logic (v1). VCC/GND
// checking, supply voltages, timing, and damage are the engine's concern
// (Feature 90); Feature 100 adds `logic.state`/`step` for sequential parts.

import { asInput, and, or, nand, nor, xor, inv, buf3, Z } from "./levels.js";

/** Gate fn name → n-ary primitive. INV/BUF3 are handled specially below. */
const GATES = Object.freeze({
  NAND: nand,
  NOR: nor,
  AND: and,
  OR: or,
  XOR: xor,
});

/** Does this def carry combinational behavior? */
export function hasLogic(def) {
  return Boolean(def?.logic?.units?.length);
}

/**
 * Evaluate a powered chip: given the levels present on its pins, what does it
 * drive on its outputs?
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
