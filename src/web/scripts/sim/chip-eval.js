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
  H,
  Z,
  X,
  OC_X,
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

/** Is this a CPU the CPU monitor can watch — a core carrying a `cpu`
    descriptor (sim/cpu-cores.js)? */
export function isCpu(def) {
  return Boolean(def?.logic?.cpu);
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

/**
 * What a chip's outputs actually DRIVE: an open-collector pin's HIGH is no
 * drive at all (`def.openCollector` — 74LS01/03/05, the '181's A=B), so it
 * floats and a pull-up decides it, as on the bench. Every other pin, and
 * every level but H, as computed. The map is returned unchanged when there
 * is nothing to let go, so a chip with no open-collector pin pays nothing.
 * @param {object} def
 * @param {Map<number, string>} outMap
 * @returns {Map<number, string>}
 */
export function openCollectorDrive(def, outMap) {
  const oc = def?.openCollector;
  if (!oc?.length) return outMap;
  let out = outMap;
  for (const pin of oc) {
    if (outMap.get(pin) !== H) continue;
    if (out === outMap) out = new Map(outMap);
    out.set(pin, Z);
  }
  return out;
}

/** The level a chip's output `pin` puts in its net's driver list: its own,
    save an open-collector pin at X — which may sink or may float, `OC_X`
    (sim/levels.js), not a full X that fought a LOW beside it in a
    wired-AND. The logic engine's alone (`maybeSinks`): under Spice Lite the
    solve says whether the LOW holds the net (spice/engine.js `wiredLow` —
    a stiff pull-up it cannot hold, a Zener feeding in). */
export function driverLevel(def, pin, level, maybeSinks = true) {
  return maybeSinks && level === X && def?.openCollector?.includes(pin) ? OC_X : level; // prettier-ignore
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
 * @param {Map<number, string>} [out] - the map to write the outputs into:
 *   one an earlier evaluation of this very def filled (sim/incremental.js's
 *   spare), whose keys are set again in the same order — so it reads exactly
 *   as a fresh one would, without a new table. Fresh when not given.
 * @returns {Map<number, string>} output pin → driven level.
 */
export function evaluate(def, pinLevels, out = new Map()) {
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
 * writing, so their net level reflects the external driver. So is every pin a
 * timing part's silicon SENSES (`logic.sense` — a 555's THRES, a monostable's
 * RX CX: `timing` pins its comparators read; spice/silicon.js), whatever its
 * role.
 *
 * `prev`, an earlier reading of this def's (the engine's last sample of the
 * chip), is handed back ITSELF when every pin reads as it did — the same
 * keys in the same order and the same levels, so nobody can tell it from a
 * fresh map; nobody mutates one (a chip's sample is kept, as the next one's
 * `prev`, the result's `pinLevels`, the debugger's record).
 * @param {object} def
 * @param {Map<number, string>} pinLevels
 * @param {Map<number, string>|null} [prev]
 * @param {Map<number, string>|null} [alt]
 * @returns {Map<number, string>}
 */
export function inputLevels(def, pinLevels, prev = null, alt = null) {
  const read = readerFor(def);
  const pins = readPinsOf(def);
  // `alt`, another reading of this def's (the settle's beside the step's —
  // engine.js `samplePins`), is handed back in the same way when `prev` is
  // not it: one map for one reading, not one per reader.
  if (readsAs(def, read, pins, pinLevels, prev)) return prev;
  if (alt !== prev && readsAs(def, read, pins, pinLevels, alt)) return alt;
  const at = [];
  for (let k = 0; k < pins.length; k++) {
    at[pins[k]] = read(pinLevels.get(pins[k]) ?? Z);
  }
  const ins = new PinReading(pins, at);
  READ_BY.set(ins, def);
  return ins;
}

/**
 * A chip's input reading — what `inputLevels` builds and every model reads
 * (`step`, `outputs`, `read`, `write`) — held in an array by pin number, with
 * the part of a Map's surface the models use: `get`, `has`, `size`, `keys`,
 * `values`, `entries`, `forEach` and iteration, in pin order, as the Map it
 * replaces (features/digital-event-tick.md C3). Never mutated once built;
 * `toMap` for whatever must send one (a structured clone keeps no class).
 */
export class PinReading {
  constructor(pins, at) {
    this.pins = pins; // the def's read pins (`readPinsOf`), shared
    this.at = at; // level by pin number
  }
  get size() {
    return this.pins.length;
  }
  get(pin) {
    return this.at[pin];
  }
  has(pin) {
    return this.at[pin] !== undefined;
  }
  keys() {
    return this.pins.values();
  }
  values() {
    return this.pins.map((pin) => this.at[pin]).values();
  }
  entries() {
    return this.pins.map((pin) => [pin, this.at[pin]]).values();
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(fn, self) {
    for (const pin of this.pins) fn.call(self, this.at[pin], pin, this);
  }
  toMap() {
    return new Map(this.entries());
  }
}

/** The pins `inputLevels` reads, in pin order — input, io and sensed —
    worked out once per def (features/digital-event-tick.md B3). */
export function readPinsOf(def) {
  let pins = READ_PINS.get(def);
  if (!pins) {
    const sense = def.logic?.sense ?? null;
    pins = def.pins
      .filter((p) => p.role === "input" || p.role === "io" || sense?.[p.n])
      .map((p) => p.n);
    READ_PINS.set(def, pins);
  }
  return pins;
}

/** Each def → the pins it reads (`readPinsOf`). */
const READ_PINS = new WeakMap();

/** Whether `was`, a reading `inputLevels` built for `def`, is what its pins
    read in `pinLevels` now. */
function readsAs(def, read, pins, pinLevels, was) {
  if (!was || READ_BY.get(was) !== def) return false;
  const at = was.at;
  for (let k = 0; k < pins.length; k++) {
    if (read(pinLevels.get(pins[k]) ?? Z) !== at[pins[k]]) return false;
  }
  return true;
}

/** Each reading `inputLevels` built → the def it read (`prev`'s check). */
const READ_BY = new WeakMap();

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
