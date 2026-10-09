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

// engine-parity.test.js — Spice Lite's oracle (features/spice-lite.md §1, §3).
//
// On a circuit with nothing analog in it, Spice Lite must give EXACTLY what
// the digital engine gives. In Phase 1 it delegates, so this holds trivially;
// it is written now so that every later phase is held to it. Every shipped
// example circuit (src/web/demos/ — a bench per benchable part, plus the
// hand-built multi-desktop ones) is run through both engines tick for tick —
// clocks toggling, simulated time advancing — and every digital-shaped field
// of every result must agree.
//
// An example with something analog to do is EXEMPT, with its reason, and the
// Spice Lite tests take over its proof (tests/spice-engine.test.js).

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

/** The fields that are a part's OWN business — its state, the pins it last
    sampled — which a part evaluated as its silicon under Spice Lite keeps in
    its silicon's shape (spice/silicon.js): compared for every other part,
    and for those left out. Everything they DO — every level, every warning,
    the timing readout — is compared like the rest. So is the settle's pass
    count, except on a desk with such a part: its silicon steps in its own
    shape, so WHICH solve is a tick's last (the one `iterations` counts) is
    its own business too. */
const PER_PART = new Set(["state", "pinLevels"]);

/** Whether a desk has a part evaluated as its silicon under Spice Lite. */
const hasSilicon = (doc) => doc.components.some((c) => partDef(c.ref)?.silicon);

/** A result field with every silicon part's entry left out. */
function comparable(doc, key, value) {
  if (!PER_PART.has(key) || !(value instanceof Map)) return value;
  const silicon = new Set(
    doc.components.filter((c) => partDef(c.ref)?.silicon).map((c) => c.id),
  );
  if (!silicon.size) return value;
  return new Map([...value].filter(([id]) => !silicon.has(id)));
}

/** Examples Spice Lite is MEANT to run differently. */
const SILICON =
  "the 555 is its silicon under Spice Lite (spice/silicon.js): its timing " +
  "is its capacitor's real curve, its discharge transistor really pulls " +
  "DISCH low, and its own divider holds CONT";
const REGULATOR =
  "a regulator's output is a supply to the logic engine and a device the " +
  "voltage solve holds to Spice Lite (spice/analog-devices.js): the chips " +
  "it powers are rail-fed in one and fed off the rails in the other";
const OP_AMP =
  "an op-amp is a comparator of levels to the logic engine and an " +
  "amplifier of voltages to Spice Lite: its output is the voltage solve's";
const RELAY =
  "a relay's contacts follow its coil's levels in the logic engine and its " +
  "coil's CURRENT under Spice Lite (an inductor's, milliseconds behind)";
const DARLINGTON =
  "a ULN2003A channel is a switch to the logic engine and a Darlington " +
  "under Spice Lite, a volt above E when on — and the relay it drives " +
  "follows its coil's current";
const EXEMPT = new Map([
  ["NE555 Astable example", SILICON],
  ["NE555 Monostable example", SILICON],
  ["NE555 Bistable example", SILICON],
  ["LM358 Comparator example", OP_AMP],
  ["LM358 Amplifier example", OP_AMP],
  ["LM7805 9 V to 5 V example", REGULATOR],
  ["LM7805 Under load example", REGULATOR],
  ["LM317 3.3 V example", REGULATOR],
  ["relay Transistor driver example", RELAY],
  ["relay No flyback diode example", RELAY],
  ["ULN2003A Relay driver example", DARLINGTON],
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
        if (key === "iterations" && hasSilicon(doc)) continue;
        assert.deepEqual(
          comparable(doc, key, spice[i][key]),
          comparable(doc, key, digital[i][key]),
          `tick ${i}: ${key}`,
        );
      }
    }
  });
}
