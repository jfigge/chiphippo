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
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { DOC_VERSION, normalizeDocument } from "../model/desk-doc.js";
import { deskBounds } from "../model/part-geometry.js";

const demoPath = (file) =>
  fileURLToPath(new URL(`../../../../demos/${file}`, import.meta.url));
const readProject = (file) => JSON.parse(readFileSync(demoPath(file), "utf8"));

// The copy that ships INSIDE the app — one document per chip under
// src/web/demos/, which a pin-assignments window opens as its example circuit.
const WEB_DEMO_DIR = fileURLToPath(new URL("../../demos/", import.meta.url));
const webDemoPath = (ref) => `${WEB_DEMO_DIR}${ref}.json`;

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

      // The BUNDLED copy is held to a stricter bar than the shipped-vs-rebuilt
      // comparison above: these two came from one buildDemo call in one pass,
      // so anything less than byte-for-byte means one of them was hand-edited.
      assert.ok(
        existsSync(webDemoPath(id)),
        `src/web/demos/${id}.json is missing — run \`make demos\``,
      );
      const bundled = JSON.parse(readFileSync(webDemoPath(id), "utf8"));
      assert.equal(bundled.ref, id);
      assert.equal(bundled.title, SPECS.get(id).title);
      assert.deepEqual(
        bundled.doc,
        tab.doc,
        `${id}: the bundled example and the group desktop have drifted apart`,
      );

      // The renderer canonicalizes whatever arrives, but a bundled document
      // skips main's migrations — so it must already be at the renderer's own
      // version, not merely loadable.
      assert.equal(tab.doc.version, DOC_VERSION, `${id}: doc version`);

      // …and already CENTRED, so opening one as a desktop is framed by a plain
      // camera fit: fitToScreen's recentre half finds a zero delta and returns
      // without emitting, leaving no undo step on a brand-new desk.
      const b = deskBounds(tab.doc.boards, tab.doc.components, tab.doc.wires);
      assert.equal(b.minX + b.maxX, 0, `${id}: not centred on x`);
      // y within one quantum: a board's y is stored to 0.01 (there is no
      // vertical lattice — board-types.js measures the strips), so a centre
      // that lands mid-quantum is as centred as the document can be, and
      // `translateAll` will report a zero delta for it exactly as x does.
      assert.ok(
        Math.abs(b.minY + b.maxY) <= 0.01,
        `${id}: not centred on y (${b.minY + b.maxY})`,
      );
    });
  });
}

test("src/web/demos holds exactly one example per benchable chip", () => {
  const want = [...GROUPS.values()].flat().map((id) => `${id}.json`);
  const have = readdirSync(WEB_DEMO_DIR).filter((f) => f.endsWith(".json"));
  // A chip dropped from the catalog leaves a document that would still put an
  // example button on a pin-assignments window; make-gate-demos.mjs sweeps the
  // directory, and this is the guard that the sweep ran.
  assert.deepEqual(have.sort(), want.sort());
});

test("the program-only groups are left to the 65xx demos", () => {
  const skipped = CHIP_DEFS.filter((def) => PROGRAM_ONLY.has(def.group));
  assert.ok(skipped.length > 0, "nothing is program-only any more?");
  for (const def of skipped) {
    assert.ok(!SPECS.has(def.id), `${def.id} should have no bench demo`);
    // …and therefore no bundled example either, so a RAM or a CPU's pinout
    // window offers no button rather than a circuit that cannot demonstrate it.
    assert.ok(
      !existsSync(webDemoPath(def.id)),
      `${def.id} should have no bundled example`,
    );
  }
  assert.ok(!existsSync(demoPath(fileNameOf("Memory"))));
});
