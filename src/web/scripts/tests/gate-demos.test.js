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

// gate-demos.test.js — the per-chip demonstration projects in demos/ (built by
// scripts/make-gate-demos.mjs, one per catalog group) must keep WORKING: each
// spec is rebuilt here and re-proved through the real engine — every switch
// combination of a combinational demo, every digit of the display demo, every
// clock edge of a sequential one — so a catalog or engine change that quietly
// breaks a demonstration fails CI instead of the user's evening.
//
// The shipped files are then checked against those builds: every group has its
// project, every chip in the group has its desktop, each loads with nothing
// dropped, and its size matches what the spec now produces (a stale committed
// file is a bug like any other).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEMOS } from "../../../../scripts/demo-specs.mjs";
import {
  assertComplete,
  buildDemo,
  catalogGroups,
  fileNameOf,
  validateDemo,
  PROGRAM_ONLY,
} from "../../../../scripts/demo-build.mjs";
import { CHIP_DEFS } from "../catalog/index.js";
import { normalizeDocument } from "../model/desk-doc.js";

const demoPath = (file) =>
  fileURLToPath(new URL(`../../../../demos/${file}`, import.meta.url));
const readProject = (file) => JSON.parse(readFileSync(demoPath(file), "utf8"));

const GROUPS = catalogGroups();
const SPECS = new Map(DEMOS.map((spec) => [spec.ref, spec]));

/** Assert the loader keeps every entity of a desktop's document. */
function assertLoadsClean(doc, label) {
  const norm = normalizeDocument(doc);
  for (const key of ["boards", "components", "wires", "annotations"]) {
    assert.equal(norm[key].length, doc[key].length, `${label} ${key}`);
  }
}

test("every benchable catalog chip has a demo spec", () => {
  assertComplete(GROUPS, SPECS);
});

for (const [group, ids] of GROUPS) {
  const file = fileNameOf(group);

  test(`${group}: ${ids.length} demo(s) build, and the engine proves them`, () => {
    const project = existsSync(demoPath(file)) ? readProject(file) : null;
    assert.ok(project, `${file} is missing — run \`make demos\``);
    assert.equal(project.name, group);
    assert.equal(project.tabs.length, ids.length);

    ids.forEach((id, index) => {
      const built = buildDemo(SPECS.get(id));
      // Throws with the failing input combination / clock edge if it regressed.
      assert.ok(validateDemo(built));

      const tab = project.tabs[index];
      assert.equal(tab.name, id, `${file} desktop ${index + 1}`);
      assertLoadsClean(tab.doc, `${group}/${id}`);
      // Not a byte comparison — a hand nudge to a label is fine — but a spec
      // that has grown a switch or an LED since the file was written is not.
      for (const key of ["components", "wires"]) {
        assert.equal(
          tab.doc[key].length,
          built.doc[key].length,
          `${group}/${id}: the shipped desktop has ${tab.doc[key].length} ` +
            `${key}, the spec now builds ${built.doc[key].length} — ` +
            `re-run \`make demos\``,
        );
      }
    });
  });
}

test("the program-only groups are left to the 65xx demos", () => {
  const skipped = CHIP_DEFS.filter((def) => PROGRAM_ONLY.has(def.group));
  assert.ok(skipped.length > 0, "nothing is program-only any more?");
  for (const def of skipped) {
    assert.ok(!SPECS.has(def.id), `${def.id} should have no bench demo`);
  }
  assert.ok(!existsSync(demoPath(fileNameOf("Memory"))));
});
