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
  buildHandBuilt,
  catalogGroups,
  fileNameOf,
  projectNameOf,
  validateDemo,
  validateHandBuilt,
  HAND_BUILT,
  PROGRAM_ONLY,
  TIMED_GROUPS,
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

/**
 * Assert a bundled document is already CENTRED, so opening it as a desktop is
 * framed by a plain camera fit: fitToScreen's recentre half finds a zero delta
 * and returns without emitting, leaving no undo step on a brand-new desk.
 */
function assertCentred(doc, label) {
  const b = deskBounds(doc.boards, doc.components, doc.wires);
  assert.equal(b.minX + b.maxX, 0, `${label}: not centred on x`);
  // y within one quantum: a board's y is stored to 0.01 (there is no
  // vertical lattice — board-types.js measures the strips), so a centre
  // that lands mid-quantum is as centred as the document can be, and
  // `translateAll` will report a zero delta for it exactly as x does.
  assert.ok(
    Math.abs(b.minY + b.maxY) <= 0.01,
    `${label}: not centred on y (${b.minY + b.maxY})`,
  );
}

test("every benchable catalog chip has a demo spec", () => {
  assertComplete(GROUPS, SPECS);
});

for (const [group, ids] of GROUPS) {
  const file = fileNameOf(group);

  test(`${group}: ${ids.length} demo(s) build, and the engine proves them`, () => {
    const project = existsSync(demoPath(file)) ? readProject(file) : null;
    assert.ok(project, `${file} is missing — run \`make demos\``);
    assert.equal(project.name, projectNameOf(group));
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
      // …and already centred.
      assertCentred(tab.doc, id);
    });
  });
}

// The examples drawn by hand (HAND_BUILT) are held to the bench's bars: every
// desktop loads with nothing dropped and every part legally seated
// (buildHandBuilt throws otherwise), the engine proves it, it is centred, and
// what ships is exactly what the project in demos/ now builds — a project
// edited and not re-shipped is a stale example like any other.
for (const ref of Object.keys(HAND_BUILT)) {
  test(`${ref}: the hand-built example works, and is what ships`, () => {
    const built = buildHandBuilt(ref);
    for (const desktop of built.desktops) {
      const label = `${ref} "${desktop.name}"`;
      assert.ok(validateHandBuilt(desktop, label));
      assert.equal(desktop.doc.version, DOC_VERSION, `${label}: doc version`);
      assertCentred(desktop.doc, label);
    }
    assert.ok(
      existsSync(webDemoPath(ref)),
      `src/web/demos/${ref}.json is missing — run \`make demos\``,
    );
    assert.deepEqual(
      JSON.parse(readFileSync(webDemoPath(ref), "utf8")),
      JSON.parse(JSON.stringify(built)),
      `${ref}: the bundled example is not what demos/${HAND_BUILT[ref]} ` +
        `builds — run \`make demos\``,
    );
  });
}

// What the 555's example is FOR: one desktop per mode the part reads off its
// wiring, each named for it — so a desktop that stopped being the circuit its
// tab promises (a lead moved, a value dropped) fails here by name.
test("the 555's example is its three modes, each reading as the one it is named for", () => {
  const built = buildHandBuilt("NE555");
  assert.deepEqual(
    built.desktops.map((d) => [d.name, validateHandBuilt(d, d.name)]),
    [
      ["Monostable", "monostable"],
      ["Bistable", "bistable"],
      ["Astable", "astable"],
    ],
  );
});

test("src/web/demos holds exactly one example per benchable chip", () => {
  const want = [
    ...[...GROUPS.values()].flat(),
    // …and one per hand-built example, which the sweep keeps.
    ...Object.keys(HAND_BUILT),
  ].map((id) => `${id}.json`);
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
  for (const where of ["Memory.chiphippo", "74LS/Memory.chiphippo"]) {
    assert.ok(!existsSync(demoPath(where)), `no ${where}`);
  }
});

test("the RC-timed groups have no bench demo yet", () => {
  // A bench states a truth table in levels; a 555 or a one-shot does a period,
  // which needs an RC network on the bench and a time-stepping check (see
  // TIMED_GROUPS). Until then: no spec, no project — and no example, unless
  // one was drawn by hand (HAND_BUILT).
  const skipped = CHIP_DEFS.filter((def) => TIMED_GROUPS.has(def.group));
  assert.ok(skipped.length > 0, "nothing is timed any more?");
  for (const def of skipped) {
    assert.ok(!SPECS.has(def.id), `${def.id} should have no bench demo`);
    assert.equal(
      existsSync(webDemoPath(def.id)),
      Object.hasOwn(HAND_BUILT, def.id),
      `${def.id} should have a bundled example exactly when it is hand-built`,
    );
  }
  for (const where of ["CD4000/Timer.chiphippo", "other/Timer.chiphippo"]) {
    assert.ok(!existsSync(demoPath(where)), `no ${where}`);
  }
});

test("the two families never share a group project, and none is left at the root", () => {
  // Feature 400: demos/74LS/ and demos/CD4000/. A project at the demos/ root
  // under a group's name is a stale copy from before the split — nothing
  // sweeps that folder, so this is the guard.
  for (const key of GROUPS.keys()) {
    const [family] = key.split("/");
    assert.ok(fileNameOf(key).startsWith(`${family}/`), key);
    const legacy = fileNameOf(key).split("/").pop();
    assert.ok(
      !existsSync(demoPath(legacy)),
      `demos/${legacy} is a stale copy — the group lives in demos/${family}/`,
    );
  }
  for (const [key, ids] of GROUPS) {
    const [family] = key.split("/");
    for (const id of ids) {
      assert.equal(
        CHIP_DEFS.find((d) => d.id === id).family,
        family,
        `${id} sits in a ${family} project`,
      );
    }
  }
});
