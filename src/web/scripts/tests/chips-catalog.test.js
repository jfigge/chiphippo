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

// Catalog integrity: every def must be internally consistent — the catalog
// is data + this validation, never chip-specific code paths.

import test from "node:test";
import assert from "node:assert/strict";

import { CHIP_DEFS, chipDef } from "../catalog/index.js";
import { packageSpec } from "../model/footprints.js";

const ROLES = new Set(["input", "output", "vcc", "gnd", "nc"]);

const STARTER_SET = [
  "7400",
  "7402",
  "7404",
  "7408",
  "7410",
  "7411",
  "7420",
  "7427",
  "7430",
  "7432",
  "7486",
  "74125",
];

test("the starter catalog contains exactly the Feature 40 wave", () => {
  assert.deepEqual(CHIP_DEFS.map((d) => d.id).sort(), [...STARTER_SET].sort());
  for (const id of STARTER_SET) assert.ok(chipDef(id), id);
  assert.equal(chipDef("9999"), null);
});

for (const def of CHIP_DEFS) {
  test(`catalog def ${def.id} is valid`, () => {
    // Identity fields present.
    assert.ok(def.title.length > 0);
    assert.ok(def.blurb.length > 0);
    assert.ok(def.group.length > 0);

    // Pin count matches the package, numbered 1…2n exactly once.
    const { pins } = packageSpec(def.package);
    assert.equal(def.pins.length, pins);
    assert.deepEqual(
      def.pins.map((p) => p.n).sort((a, b) => a - b),
      Array.from({ length: pins }, (_, i) => i + 1),
    );

    // Roles valid; exactly one vcc + one gnd, at the standard corners.
    for (const p of def.pins) assert.ok(ROLES.has(p.role), `${def.id} ${p.n}`);
    const vcc = def.pins.filter((p) => p.role === "vcc");
    const gnd = def.pins.filter((p) => p.role === "gnd");
    assert.equal(vcc.length, 1);
    assert.equal(gnd.length, 1);
    assert.equal(vcc[0].n, pins);
    assert.equal(gnd[0].n, pins / 2);

    // Names unique among functional pins (NC may repeat).
    const names = def.pins.filter((p) => p.role !== "nc").map((p) => p.name);
    assert.equal(new Set(names).size, names.length, `${def.id} names`);
  });
}
