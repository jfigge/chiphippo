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

import {
  asInput,
  asCmosInput,
  and,
  or,
  nand,
  nor,
  xor,
  xnor,
  inv,
  buf,
  buf3,
  Z,
} from "./levels.js";
import { floatsUnknown } from "../catalog/families.js";

/** Gate fn name → n-ary primitive. INV/BUF/BUF3/COMB are handled specially. */
const GATES = Object.freeze({
  NAND: nand,
  NOR: nor,
  AND: and,
  OR: or,
  XOR: xor,
  XNOR: xnor,
});

/**
 * How this def reads a pin as an input: a TTL (or family-less) part pulls a
 * floating pin HIGH, a CMOS part reads it as unknown (Feature 400). The one
 * place the choice is made, for both the combinational and the stateful path.
 */
const readerFor = (def) => (floatsUnknown(def) ? asCmosInput : asInput);

/** Does this def carry combinational (unit-based) behavior? */
export function hasLogic(def) {
  return Boolean(def?.logic?.units?.length);
}

/** Does this def carry sequential (stateful) behavior? */
export function isSequential(def) {
  return typeof def?.logic?.step === "function";
}

/**
 * Is this an analog switch (CD4066B, CD4051B/52B/53B, and the transistors,
 * which a logic circuit uses as one)? Its channels JOIN nets rather than
 * driving them (sim/analog-switch.js), so it has no outputs at all.
 */
export function isAnalogSwitch(def) {
  return Array.isArray(def?.logic?.channels);
}

/**
 * The state of each of an analog switch's channels for the levels on its pins:
 * `[{a, b, on, held}]`, the terminals and H (joined), L (apart) or X (might be
 * either), and whether a part's own memory rather than its control decided it
 * (a MOSFET whose gate reads undefined — analog-switch.js `transistorSwitch`).
 * Its control pins are read through the family reader, so a floating CMOS
 * control is X.
 * @param {object} def
 * @param {Map<number, string>} pinLevels
 * @param {*} [state] - the part's own state, for the one kind that has any.
 */
export function channelStates(def, pinLevels, state = null) {
  const read = readerFor(def);
  return def.logic.channels.map((ch) => {
    const levels = ch.inputs.map((pin) => read(pinLevels.get(pin) ?? Z));
    return {
      a: ch.a,
      b: ch.b,
      on: ch.on(levels, state),
      held: ch.held?.(levels) === true,
    };
  });
}

/**
 * Does this def keep TIME (the 555, the RC-timed CD4000 parts)? A timed part
 * is sequential — it has the standard `{state0, step, outputs}` — plus a
 * `timing(probe)` that reads its R and C off the wiring (sim/rc-trace.js) and
 * a `wakeAt(state)` naming when it next changes by itself. Its `step` is
 * handed `{now, timing}` as a fourth argument (sim/timing.js).
 */
export function isTimed(def) {
  return isSequential(def) && typeof def.logic.timing === "function";
}

/** Does this def carry a memory image (ROM / SRAM / EEPROM — Feature 170)? */
export function isMemory(def) {
  return Boolean(def?.logic?.memory);
}

/**
 * Is this a self-clocking oscillator (a crystal-can part)? Its
 * output pin is driven from the engine's `clockPhase`, exactly like a clock
 * brick's terminal, but — unlike a brick — it is power-gated like any chip
 * (see sim/engine.js `driversFor`/`buildContext`).
 */
export function isOscillator(def) {
  return Boolean(def?.logic?.oscillator);
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

/** Is this a file-backed (non-volatile ROM/EPROM/EEPROM) memory chip? */
export function isRomChip(def) {
  return isMemory(def) && !isVolatileMemory(def);
}

/** Does this def carry ANY simulated behavior (combinational/sequential/
    memory/oscillator/analog switch)? */
export function hasBehavior(def) {
  return (
    hasLogic(def) ||
    isSequential(def) ||
    isMemory(def) ||
    isOscillator(def) ||
    isAnalogSwitch(def)
  );
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
 *   missing pin is treated as floating (`Z` → reads HIGH via asInput, or
 *   unknown via asCmosInput for a CMOS part).
 * @returns {Map<number, string>} output pin → driven level.
 */
export function evaluate(def, pinLevels) {
  const out = new Map();
  if (!hasLogic(def)) return out;

  // Every input pin is read through the def's family reader, so a floating
  // (Z) pin reads H (TTL) or X (CMOS) and Z never reaches a gate primitive.
  const read = readerFor(def);
  const level = (pin) => read(pinLevels.get(pin) ?? Z);

  for (const unit of def.logic.units) {
    let value;
    if (unit.fn === "INV") {
      value = inv(level(unit.inputs[0]));
    } else if (unit.fn === "BUF") {
      value = buf(level(unit.inputs[0]));
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
 * number and already read through the def's family reader (Z → H for TTL,
 * Z → X for CMOS) so `step`/`outputs`/`read`/`write` see only H/L/X. Bidirectional `io` pins (a memory's data bus, driven by the
 * unit AND read back during a write) are included — the unit floats them while
 * writing, so their net level reflects the external driver.
 * @param {object} def
 * @param {Map<number, string>} pinLevels
 * @returns {Map<number, string>}
 */
export function inputLevels(def, pinLevels) {
  const ins = new Map();
  const read = readerFor(def);
  for (const p of def.pins) {
    if (p.role === "input" || p.role === "io") {
      ins.set(p.n, read(pinLevels.get(p.n) ?? Z));
    }
  }
  return ins;
}

/**
 * Advance a sequential chip one tick: sample edges from `inputs` vs
 * `prevInputs` (null on the first tick — no edge) and compute the next state.
 * Pure — returns the new state, never mutates. `env` reaches a TIMED part
 * only (`{now, timing}` — see isTimed); every other step ignores it.
 * @returns {*} the def-specific next state
 */
export function stepChip(def, state, inputs, prevInputs, env) {
  return def.logic.step(state, inputs, prevInputs, env);
}

/**
 * When a timed chip next changes on its own, in simulated seconds, or null
 * when nothing is pending (an idle monostable, a held reset).
 */
export function wakeAtOf(def, state) {
  return isTimed(def) ? (def.logic.wakeAt?.(state) ?? null) : null;
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
