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

// engine-parity.test.js — Spice Light's oracle (features/spice-light.md §1, §3).
//
// On a circuit with nothing analog in it, Spice Light must give EXACTLY what
// the digital engine gives. In Phase 1 it delegates, so this holds trivially;
// it is written now so that every later phase is held to it. Every shipped
// example circuit (src/web/demos/ — a bench per benchable part, plus the
// hand-built multi-desktop ones) is run through both engines tick for tick —
// clocks toggling, simulated time advancing — and every digital-shaped field
// of every result must agree.
//
// An example with something analog to do is EXEMPT, with its reason, and the
// Spice Light tests take over its proof (tests/spice-engine.test.js).

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ENGINES } from "../sim/engines.js";
import { buildNetlist } from "../sim/netlist.js";
import { H, L } from "../sim/levels.js";
import { partDef } from "../catalog/index.js";
import { isOscillator } from "../sim/chip-eval.js";
import { exampleDesktops } from "../model/example-desktops.js";

const DEMOS = fileURLToPath(new URL("../../demos/", import.meta.url));

/** The result fields both engines share — everything a consumer of the
    digital engine reads. */
const SHARED = [
  "netLevels",
  "strongLevels",
  "chipStatus",
  "warnings",
  "iterations",
  "settled",
  "state",
  "pinLevels",
  "memWrites",
  "timing",
  "channels",
  "wakeAt",
];

/** Examples Spice Light is MEANT to run differently. */
const EXEMPT = new Map([
  // Spice Light times a 555 by its capacitor's curve: ln 2 for the sheet's
  // 0.693, ln 3 for its 1.1, and a long first HIGH from an empty capacitor.
  ["NE555 Astable example", "the 555 times by its capacitor's real curve"],
  ["NE555 Monostable example", "the 555 times by its capacitor's real curve"],
]);

const TICKS = 24;
const STEP_S = 0.005;

/** Every desktop of every shipped example, labelled. */
function examples() {
  const out = [];
  for (const file of readdirSync(DEMOS).filter((f) => f.endsWith(".json"))) {
    const payload = JSON.parse(readFileSync(DEMOS + file, "utf8"));
    const ref = file.replace(/\.json$/, "");
    for (const { name, doc } of exampleDesktops(ref, payload)) {
      out.push({ name, doc });
    }
  }
  return out;
}

/** Run one engine over a desk for TICKS ticks: clocks toggling every tick,
    simulated time advancing, state carried exactly as SimController does. */
function run(engine, doc) {
  const netlist = buildNetlist(doc);
  const clocks = doc.components.filter(
    (c) => c.kind === "clock" || isOscillator(partDef(c.ref)),
  );
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = new Map();
  const results = [];
  for (let i = 0; i < TICKS; i++) {
    const level = i % 2 === 0 ? H : L;
    const r = engine.tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map(clocks.map((c) => [c.id, level])),
      now: i * STEP_S,
      spice: engine === ENGINES.spice ? { config: null, analog } : undefined,
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    if (r.analog) analog = r.analog;
    results.push(r);
  }
  return results;
}

const all = examples();

test("engine parity: the shipped examples are found", () => {
  assert.ok(all.length > 50, `${all.length} example desktops`);
});

for (const { name, doc } of all) {
  if (EXEMPT.has(name)) continue;
  test(`engine parity: ${name} runs identically on both engines`, () => {
    const digital = run(ENGINES.digital, doc);
    const spice = run(ENGINES.spice, doc);
    for (let i = 0; i < TICKS; i++) {
      for (const key of SHARED) {
        assert.deepEqual(spice[i][key], digital[i][key], `tick ${i}: ${key}`);
      }
    }
  });
}
