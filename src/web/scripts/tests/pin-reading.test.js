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

// Every part's model reads a PinReading (sim/chip-eval.js, features/digital-
// event-tick.md C3) exactly as it read the Map it replaced: each sequential,
// timed and memory def in the catalog is driven through the same seeded
// random input sequence twice — once on Maps, once on PinReadings — and its
// state, outputs, memory output and memory writes compared at every step.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, X, Z } from "../sim/levels.js";
import { PALETTE_DEFS } from "../catalog/index.js";
import {
  PinReading,
  initialState,
  inputLevels,
  isMemory,
  isSequential,
  memoryOutputs,
  memoryWrite,
  outputsOf,
  readPinsOf,
  stepChip,
} from "../sim/chip-eval.js";

const STEPS = 400;
const LEVELS = [H, L, H, L, H, L, X, Z];

/** A seeded generator (mulberry32): the same sequence every run. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value as one canonical string: maps (and readings) by sorted key. */
function canon(v) {
  if (v === undefined) return "u";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (ArrayBuffer.isView(v)) return `[${Array.from(v).join(",")}]`;
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v instanceof Map || v instanceof PinReading) {
    const keys = [...v.keys()].sort((a, b) => String(a).localeCompare(String(b))); // prettier-ignore
    return `M{${keys.map((k) => `${JSON.stringify(k)}:${canon(v.get(k))}`).join(",")}}`; // prettier-ignore
  }
  return `{${Object.keys(v).sort().map((k) => `${k}:${canon(v[k])}`).join(",")}}`; // prettier-ignore
}

/** What a call comes to — its value, or the error it threw. */
function outcome(fn) {
  try {
    return canon(fn());
  } catch (err) {
    return `throws ${err?.message}`;
  }
}

const DEFS = PALETTE_DEFS.filter((def) => isSequential(def) || isMemory(def));

test("every sequential, timed and memory part is in the check", () => {
  assert.ok(DEFS.length > 50, `only ${DEFS.length} defs`);
});

for (const def of DEFS) {
  test(`${def.id}: a PinReading reads as the Map it replaced`, () => {
    const next = random([...def.id].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7)); // prettier-ignore
    const pins = readPinsOf(def);
    const memory = isMemory(def);
    const image = memory ? new Uint8Array(4096).map(() => Math.floor(next() * 256)) : null; // prettier-ignore
    let stateA = memory ? null : initialState(def);
    let stateB = stateA;
    let prevA = null;
    let prevB = null;
    for (let step = 0; step < STEPS; step++) {
      const raw = new Map();
      for (const pin of pins) raw.set(pin, LEVELS[Math.floor(next() * LEVELS.length)]); // prettier-ignore
      const insB = inputLevels(def, raw);
      assert.ok(insB instanceof PinReading);
      const insA = insB.toMap();
      const env = { now: step * 1e-4, timing: null };
      const where = `${def.id} step ${step}`;
      if (memory) {
        const img = image.subarray(0, image.length);
        assert.equal(outcome(() => memoryOutputs(def, insB, img)), outcome(() => memoryOutputs(def, insA, img)), `${where}: memory outputs`); // prettier-ignore
        assert.equal(outcome(() => memoryWrite(def, insB, img)), outcome(() => memoryWrite(def, insA, img)), `${where}: memory write`); // prettier-ignore
        continue;
      }
      let nextA;
      let nextB;
      const a = outcome(
        () => (nextA = stepChip(def, stateA, insA, prevA, env)),
      );
      const b = outcome(
        () => (nextB = stepChip(def, stateB, insB, prevB, env)),
      );
      assert.equal(b, a, `${where}: state`);
      if (nextA !== undefined) [stateA, stateB] = [nextA, nextB];
      assert.equal(outcome(() => outputsOf(def, stateB, insB)), outcome(() => outputsOf(def, stateA, insA)), `${where}: outputs`); // prettier-ignore
      [prevA, prevB] = [insA, insB];
    }
  });
}
