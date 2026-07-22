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

/** Does this def carry a memory image (ROM / SRAM / EEPROM — Feature 170)? */
export function isMemory(def) {
  return Boolean(def?.logic?.memory);
}

/**
 * Is this memory chip VOLATILE (SRAM)? Volatile memory is never file-backed —
 * it is run-volatile only (Feature 190). A NON-volatile chip (ROM/EPROM/EEPROM)
 * carries a `.bin` backing file and, in this app, cannot be written by the
 * circuit (there is no way to drive a valid write cycle) — so it reads as ROM.
 */
export function isVolatileMemory(def) {
  return isMemory(def) && def.logic.memory.volatile === true;
}

/** Does this def carry ANY simulated behavior (combinational/sequential/memory)? */
export function hasBehavior(def) {
  return hasLogic(def) || isSequential(def) || isMemory(def);
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
 * The input-pin levels a sequential/latch/memory chip reads, keyed by pin
 * number and already `asInput`'d (Z → H) so `step`/`outputs`/`read`/`write`
 * see only H/L/X. Bidirectional `io` pins (a memory's data bus, driven by the
 * unit AND read back during a write) are included — the unit floats them while
 * writing, so their net level reflects the external driver.
 * @param {object} def
 * @param {Map<number, string>} pinLevels
 * @returns {Map<number, string>}
 */
export function inputLevels(def, pinLevels) {
  const ins = new Map();
  for (const p of def.pins) {
    if (p.role === "input" || p.role === "io") {
      ins.set(p.n, asInput(pinLevels.get(p.n) ?? Z));
    }
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

/**
 * What a memory chip drives on its data pins for the given inputs + byte image:
 * the addressed word (per bit) while selected & output-enabled, else `Z`. Reads
 * the image, never mutates it (the engine stays pure).
 * @param {object} def   a def with a `logic.memory` block
 * @param {Map<number, string>} inputs  asInput'd address/control/data levels
 * @param {Uint8Array|Uint16Array} [image]  the run-volatile byte image
 * @returns {Map<number, string>} data pin → level
 */
export function memoryOutputs(def, inputs, image) {
  return def.logic.read(inputs, image);
}

/**
 * The write op a memory chip commits this tick, or null (idle / read-only ROM).
 * Reported to the caller — the engine never applies it (SimController does).
 * @returns {{ addr: number, value: number }|null}
 */
export function memoryWrite(def, inputs, image) {
  return def.logic.write(inputs, image);
}

/** A memory def's config (size/width/pins/initial), for seeding + tests. */
export function memoryConfig(def) {
  return def.logic.memory;
}
