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

// Every shipped example desktop run under Spice Lite exactly as the app runs
// it (bench/drive-spice.js: one prepared context kept, clocks on their edge
// schedule, the engine's own wakes) — the run the engines' ASSERTION MODES
// are switched on over (sim/assert-modes.js, features/spice-perf): with one
// set, every cache reused and every piece of work skipped is checked against
// the same done afresh, on every example. On its own it is a smoke run.
//
//   SPICE_ASSERT_ANALYSIS=1 SPICE_EXAMPLE_SECONDS=5 node --test …

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exampleDesktops } from "../model/example-desktops.js";
import { driveSpice } from "../bench/drive-spice.js";
import { FAST } from "./test-depth.js";

const DEMOS = fileURLToPath(new URL("../../demos/", import.meta.url));
const SECONDS = Number(process.env.SPICE_EXAMPLE_SECONDS ?? (FAST ? 0.05 : 0.2)); // prettier-ignore

const all = [];
for (const file of readdirSync(DEMOS).filter((f) => f.endsWith(".json"))) {
  const payload = JSON.parse(readFileSync(DEMOS + file, "utf8"));
  for (const { name, doc } of exampleDesktops(
    file.replace(/\.json$/, ""),
    payload,
  )) {
    all.push({ name, doc });
  }
}

test("the shipped examples are found", () => {
  assert.ok(all.length > 50, `${all.length} example desktops`);
});

for (const { name, doc } of all) {
  test(`Spice Lite runs ${name} for ${SECONDS} s as the app runs it`, () => {
    const { ticks, result } = driveSpice(structuredClone(doc), { seconds: SECONDS }); // prettier-ignore
    assert.ok(ticks >= 1);
    assert.ok(result.netLevels instanceof Map);
  });
}
