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

// custom-chips.js — a CUSTOM chip (the chip designer; model/custom-chip.js)
// as a catalog def, so every consumer of the catalog — occupancy, the engine,
// the views, the BOM — takes it exactly as it takes a 74LS00.
//
// Its behaviour is the user's Verilog (scripts/hdl/), compiled once per
// version of the chip and wrapped in the engine's ordinary stateful contract,
// `{state0, step, outputs}` — so a custom chip is "genuine per-part code
// behind the standard sequential contract", the CPUs' arrangement, with the
// code written by the user. Each UNIT (a replicated module) has its own state
// and reads and drives its own pins through the chip's pin map. An inout's
// pins are `io` pins, as a memory's data bus is: the engine hands the chip
// their level (what the board resolved) and takes back what it drives.
//
// A chip whose package is wrong or whose code does not compile is still a
// chip: it seats, it is powered, and it drives NOTHING (every output Z) —
// the designer says why, and Run says so too.

import { compileModule } from "../hdl/compile.js";
import { moduleName } from "../hdl/header.js";
import * as V from "../hdl/values.js";
import { H, L, X, Z } from "../sim/levels.js";
import { floatsUnknown } from "./families.js";
import {
  customChipProblems,
  customPackage,
  customPins,
  hasErrors,
  modulePorts,
} from "../model/custom-chip.js";

/** The palette group every custom chip shelves under. */
export const CUSTOM_GROUP = "Custom";

/** Built defs by the stored chip they came from, so the same chip always
    yields the same def object (views and caches key on it). */
const BUILT = new Map();
const BUILT_LIMIT = 1024;

/** A level as one bit of a value: [value bit, unknown bit]. */
const levelBit = (level) => (level === H ? [1, 0] : level === L ? [0, 0] : [0, 1]); // prettier-ignore

/** One bit of a value as a level to drive. */
function bitLevel(value, b) {
  if ((value.x >>> b) & 1) return (value.z >>> b) & 1 ? Z : X;
  return (value.v >>> b) & 1 ? H : L;
}

/**
 * The catalog def for a stored custom chip.
 * @param {object} chip - a normalised custom chip (model/custom-chip.js).
 * @param {(raw: object) => object} normalizeParams - the chips' shared one.
 */
export function customCatalogDef(chip, normalizeParams) {
  const key = JSON.stringify(chip);
  const hit = BUILT.get(key);
  if (hit) return hit;
  const pins = customPins(chip);
  const problems = customChipProblems(chip);
  const compiled = compileModule(chip.code, modulePorts(chip), {
    name: moduleName(chip.name),
  });
  const runtime =
    compiled.ok && !hasErrors(problems)
      ? customRuntime(chip, compiled.program, pins)
      : null;
  const def = Object.freeze({
    kind: "chip",
    id: chip.id,
    custom: true,
    // What is printed on the package — the part number the user chose. The id
    // is the ref, and never changes.
    marking: chip.name,
    title: chip.description || chip.name,
    blurb: chip.description,
    group: CUSTOM_GROUP,
    family: chip.family,
    package: customPackage(chip),
    pins: Object.freeze(pins.map(({ n, name, role }) => Object.freeze({ n, name, role }))), // prettier-ignore
    logic: runtime ? runtime.logic : inertLogic(pins),
    normalizeParams,
    customChip: chip,
    customProblems: problems,
    customCompiled: compiled,
    customRuntime: runtime,
  });
  BUILT.set(key, def);
  if (BUILT.size > BUILT_LIMIT) BUILT.delete(BUILT.keys().next().value);
  return def;
}

/** The behaviour of a chip that cannot run: holds nothing, drives Z. */
function inertLogic(pins) {
  const outs = pins.filter((p) => p.role === "output").map((p) => p.n);
  const none = new Map(outs.map((n) => [n, Z]));
  return {
    state0: () => [],
    step: (state) => state,
    outputs: () => none,
  };
}

/**
 * The running half: per unit, which pins its input and output ports read and
 * drive, and the `{state0, step, outputs}` the engine calls. Exposed (as
 * `def.customRuntime`) for the debugger, which re-runs the same program with
 * a trace on — it needs to split a chip's pin levels by unit exactly as the
 * engine's calls do.
 */
function customRuntime(chip, program, pins) {
  const inputs = program.inputs; // input (and inout) ports, in port order
  const outputs = program.outputs; // output (and inout) ports
  const units = chip.units.map((map) => ({
    ins: inputs.map((p) => map[p.name] ?? []),
    outs: outputs.map((p) => map[p.name] ?? []),
  }));
  // A port bit on no pin reads as the family reads a pin left open: a TTL
  // input floats HIGH, a CMOS one is unknown.
  const open = floatsUnknown({ family: chip.family }) ? [0, 1] : [1, 0];
  const inputPins = pins.filter((p) => p.role === "input" || p.role === "io").map((p) => p.n); // prettier-ignore

  /** One unit's input port values from the engine's pin levels. */
  const unitInputs = (u, ins) =>
    units[u].ins.map((pinList) => {
      let v = 0;
      let x = 0;
      pinList.forEach((pin, b) => {
        const [bv, bx] = pin ? levelBit(ins?.get(pin)) : open;
        v += bv * 2 ** b;
        x += bx * 2 ** b;
      });
      return V.make(pinList.length || 1, v, x);
    });

  // `outputs` is asked on every pass of every settle, mostly with the same
  // inputs and state it was last asked with: remember the answer per state
  // object (a state is never mutated — a change is a new object).
  const memo = new WeakMap();
  const insKey = (ins) => inputPins.map((n) => ins?.get(n) ?? "-").join("");

  const logic = {
    state0: () => chip.units.map(() => program.initialState()),
    step(state, ins, prev) {
      let next = null;
      chip.units.forEach((_m, u) => {
        const before = state?.[u] ?? program.initialState();
        const after = program.step(
          before,
          unitInputs(u, ins),
          prev ? unitInputs(u, prev) : null,
        );
        if (after !== before) (next ??= [...(state ?? [])])[u] = after;
      });
      return next ?? state;
    },
    outputs(state, ins) {
      const st = state ?? logic.state0();
      let byIns = memo.get(st);
      if (!byIns) memo.set(st, (byIns = new Map()));
      const key = insKey(ins);
      const hit = byIns.get(key);
      if (hit) return hit;
      const out = new Map();
      chip.units.forEach((_m, u) => {
        const values = program.outputValues(unitInputs(u, ins), st[u]);
        units[u].outs.forEach((pinList, k) => {
          pinList.forEach((pin, b) => {
            if (pin) out.set(pin, bitLevel(values[k], b));
          });
        });
      });
      if (byIns.size > 64) byIns.clear();
      byIns.set(key, out);
      return out;
    },
  };
  return { program, units, unitInputs, logic };
}
