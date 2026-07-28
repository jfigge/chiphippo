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

// gate-demos.test.js — the per-chip demonstration desktops of
// demos/GateTests.chiphippo (built by scripts/make-gate-demos.mjs) must keep
// WORKING: each spec is rebuilt here and re-proved through the real engine —
// every switch combination of a combinational demo, every digit of the display
// demo, every clock edge of a sequential one — so a catalog or engine change
// that quietly breaks a demonstration fails CI instead of the user's evening.
//
// The shipped file is then checked against those builds: every demo has its
// desktop, each loads with nothing dropped, and its size matches what the spec
// now produces (a stale committed file is a bug like any other). The two
// HAND-BUILT desktops are only required to survive the loader — nothing here
// regenerates them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DEMOS } from "../../../../scripts/demo-specs.mjs";
import {
  buildDemo,
  validateDemo,
  HAND_BUILT,
  FIRST_GENERATED_TAB,
} from "../../../../scripts/demo-build.mjs";
import { normalizeDocument } from "../model/desk-doc.js";

const project = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../demos/GateTests.chiphippo", import.meta.url)), // prettier-ignore
    "utf8",
  ),
);
const tabOf = (id) => project.tabs.find((tab) => tab.id === id);

/** Assert the loader keeps every entity of a desktop's document. */
function assertLoadsClean(doc, label) {
  const norm = normalizeDocument(doc);
  for (const key of ["boards", "components", "wires", "annotations"]) {
    assert.equal(norm[key].length, doc[key].length, `${label} ${key}`);
  }
  return norm;
}

for (const [index, spec] of DEMOS.entries()) {
  test(`${spec.ref} demo: builds, and the engine proves it`, () => {
    const built = buildDemo(spec);
    // Throws with the failing input combination / clock edge if it regressed.
    assert.ok(validateDemo(built));

    const tab = tabOf(`t${FIRST_GENERATED_TAB + index}`);
    assert.ok(tab, `${spec.ref}: no desktop in the shipped project`);
    assert.equal(tab.name, spec.ref);
    assertLoadsClean(tab.doc, spec.ref);
    // Not a byte comparison — a hand nudge to a label is fine — but a spec
    // that has grown a switch or an LED since the file was written is not.
    for (const key of ["components", "wires"]) {
      assert.equal(
        tab.doc[key].length,
        built.doc[key].length,
        `${spec.ref}: the shipped desktop has ${tab.doc[key].length} ${key}, ` +
          `the spec now builds ${built.doc[key].length} — re-run \`make demos\``,
      );
    }
  });
}

test("the hand-built desktops are still there, and still load", () => {
  for (const [id, name] of HAND_BUILT) {
    const tab = tabOf(id);
    assert.ok(tab, `${id} (${name}) is missing from the shipped project`);
    assert.equal(tab.name, name);
    assertLoadsClean(tab.doc, name);
  }
});

test("every desktop has a unique id and a name", () => {
  const ids = new Set();
  for (const tab of project.tabs) {
    assert.ok(tab.name, `${tab.id} has no name`);
    assert.ok(!ids.has(tab.id), `duplicate desktop id ${tab.id}`);
    ids.add(tab.id);
  }
  assert.equal(project.tabs.length, HAND_BUILT.size + DEMOS.length);
});
