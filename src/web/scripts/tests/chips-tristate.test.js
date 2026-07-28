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

// chips-tristate.test.js — `outputEnable` is DECLARED data, so this is what
// keeps it true.
//
// A tri-state part floats its outputs unless something enables them, and the
// catalog expresses that behaviour FOUR different ways: a `BUF3` unit ('125,
// '244), a `COMB` unit returning Z ('240, '245, '257), a sequential `outputs()`
// returning Z ('173, '533, '573), and a memory image ('rom-8k and friends).
// Only the first is introspectable, so "which pin enables these outputs" cannot
// simply be read off the logic block — and it is exactly what the AI prompt has
// to say and what the verifier has to name when a design leaves an output
// floating.
//
// So each part DECLARES it, and this proves the declaration against the real
// evaluator rather than trusting it. Declared-and-verified, not derived, and
// not merely asserted: the failure mode this exists to prevent is a second copy
// of a fact drifting from the first.

import test from "node:test";
import assert from "node:assert/strict";

import { CHIP_DEFS } from "../catalog/index.js";
import {
  evaluate,
  hasLogic,
  isMemory,
  isSequential,
} from "../sim/chip-eval.js";
import { H, L, Z } from "../sim/levels.js";

/** Pins a caller can drive: everything but power and no-connects. */
const drivable = (def) =>
  def.pins.filter((p) => !["vcc", "gnd", "nc"].includes(p.role));

/** Pins that can float: real outputs, plus a transceiver's io pins. */
const outputsOf = (def) =>
  def.pins
    .filter((p) => p.role === "output" || p.role === "io")
    .map((p) => p.n);

/** Every drivable pin at `L`, except `high`, which is at `H`. */
function vector(def, high = []) {
  const m = new Map();
  for (const p of drivable(def)) m.set(p.n, high.includes(p.n) ? H : L);
  return m;
}

/**
 * The output levels a def produces for one input vector, or null when this
 * harness cannot drive it (a memory part needs an image).
 */
function outputsAt(def, high) {
  const inputs = vector(def, high);
  if (isMemory(def)) return null;
  if (hasLogic(def)) return evaluate(def, inputs);
  if (isSequential(def)) return def.logic.outputs(def.logic.state0(), inputs);
  return null;
}

/** Which output pins are floating for a given vector. */
function floating(def, high) {
  const out = outputsAt(def, high);
  if (!out) return null;
  return new Set(outputsOf(def).filter((n) => out.get(n) === Z));
}

const TRISTATE = CHIP_DEFS.filter((d) => d.outputEnable?.length);

test("every declared output enable is one — and it is ACTIVE LOW", () => {
  // The claim the prompt makes to the model and the verifier makes to the user:
  // drive this pin HIGH and outputs that were driving stop driving.
  assert.ok(TRISTATE.length >= 8, `${TRISTATE.length} parts declare one`);
  for (const def of TRISTATE) {
    const outs = outputsOf(def);
    assert.ok(outs.length, `${def.id} has outputs to enable`);
    for (const pin of def.outputEnable) {
      const p = def.pins.find((q) => q.n === pin);
      assert.ok(p, `${def.id} pin ${pin} exists`);
      assert.equal(p.role, "input", `${def.id}.${p.name} is an input`);

      const low = floating(def, []);
      const high = floating(def, [pin]);
      if (low === null) continue; // memory: proved by its own suites
      const stopped = [...high].filter((n) => !low.has(n));
      assert.ok(
        stopped.length,
        `${def.id}: driving ${p.name} (pin ${pin}) HIGH should float an ` +
          `output that drives when it is LOW`,
      );
    }
  }
});

/**
 * The groups whose parts float a pin for reasons no single enable explains.
 *
 * A CPU or a PIA floats its data bus on a BUS PROTOCOL — chip select, R/W and
 * the clock phase together — and its port lines on a direction REGISTER the
 * program writes, neither of which is a pin anyone can tie. An open-drain IRQ
 * floats as one of its two ordinary logic states. `outputEnable` would be a
 * lie on all of them, so the sweep below stops at the 74xx logic family: the
 * parts the AI builder actually composes, and the ones whose demos this
 * catalog carries. (The demos README draws the same line — the Memory and
 * Interface groups have no bench project, for the same reason.)
 */
const PROTOCOL_GROUPS = new Set(["Memory", "Interface"]);

test("a part that can float an output DECLARES what enables it", () => {
  // The anti-drift half, and the one that matters when a new tri-state part
  // lands: a behavioural sweep rather than a wording check. Any def that floats
  // an output under a plain vector — all inputs LOW, all HIGH, or one HIGH at a
  // time — owes the catalog an `outputEnable`, because without it the model is
  // told nothing and the verifier can only say "nothing drives it".
  //
  // It earned its keep immediately: the '595 floats its eight latched outputs
  // on OE and says nothing about it in its title, so every wording-based check
  // would have missed it.
  for (const def of CHIP_DEFS) {
    if (def.outputEnable?.length || isMemory(def)) continue;
    if (PROTOCOL_GROUPS.has(def.group)) continue;
    if (!hasLogic(def) && !isSequential(def)) continue;
    const vectors = [[], drivable(def).map((p) => p.n)];
    for (const p of drivable(def)) vectors.push([p.n]);
    for (const high of vectors) {
      const z = floating(def, high);
      assert.equal(
        z?.size ?? 0,
        0,
        `${def.id} floats pin(s) ${[...(z ?? [])].join(", ")} with ` +
          `${high.length ? `pin(s) ${high.join(", ")} HIGH` : "every input LOW"}` +
          ` — declare its outputEnable`,
      );
    }
  }
});

test("a tri-state title is backed by a declaration", () => {
  // Cheap second net over the sweep above: the sweep only sees what a plain
  // vector reaches, and a part gated by some combination it does not try would
  // slip through. A datasheet title that says "tri-state" never should.
  for (const def of CHIP_DEFS) {
    if (!/tri-state|3-state/i.test(def.title)) continue;
    assert.ok(
      def.outputEnable?.length || isMemory(def),
      `${def.id} ("${def.title}") declares no outputEnable`,
    );
  }
});

test("the 245's DIR is NOT an output enable — it picks a side", () => {
  // The distinction the declaration exists to make. DIR changes WHICH port
  // drives; only OE stops both. A checker that guessed "any pin that floats
  // something" would call DIR an enable and tell the user to tie it low, which
  // would silently pick a direction for them.
  const def = CHIP_DEFS.find((d) => d.id === "74LS245");
  assert.deepEqual([...def.outputEnable], [19], "OE alone");
  const dirLow = floating(def, []);
  const dirHigh = floating(def, [1]);
  assert.ok(dirLow.size && dirHigh.size, "one side listens either way");
  assert.notDeepEqual(
    [...dirLow].sort(),
    [...dirHigh].sort(),
    "DIR swaps which side that is",
  );
  const oeHigh = floating(def, [19]);
  assert.equal(oeHigh.size, outputsOf(def).length, "OE floats everything");
});
