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

// The launch's feature flags (app/feature-flags.js).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FEATURES,
  parseFeatureList,
  resolveFeatures,
} = require("../feature-flags");

// The flags this build knows. None today; the gallery's was retired when it
// shipped, so a `gallery` left in a settings file or typed on the command
// line is ignored.
test("no flag is known, and the retired gallery flag is ignored", () => {
  assert.deepEqual([...FEATURES], []);
  assert.deepEqual(
    resolveFeatures({
      argv: ["--features=demo"],
      env: { CHIPHIPPO_FEATURES: "demo" },
      stored: ["demo"],
    }),
    [],
  );
});

// The rest switch a stand-in flag, `demo`, as a build with one would.
const known = ["demo"];

test("nothing is on by default", () => {
  assert.deepEqual(resolveFeatures(), []);
  assert.deepEqual(
    resolveFeatures({ argv: ["electron", "app/main.js", "--dev"], env: {} }),
    [],
  );
});

test("the command line switches a flag on", () => {
  assert.deepEqual(
    resolveFeatures({
      argv: ["electron", "app/main.js", "--features=demo"],
      known,
    }),
    ["demo"],
  );
});

test("the environment switches a flag on", () => {
  assert.deepEqual(
    resolveFeatures({ env: { CHIPHIPPO_FEATURES: " Demo " }, known }),
    ["demo"],
  );
});

test("the stored list switches a flag on, as an array or a string", () => {
  assert.deepEqual(resolveFeatures({ stored: ["demo"], known }), ["demo"]);
  assert.deepEqual(resolveFeatures({ stored: "demo", known }), ["demo"]);
});

test("unknown names and junk are ignored, never refused", () => {
  assert.deepEqual(parseFeatureList("retired, demo ,,", known), ["demo"]);
  assert.deepEqual(parseFeatureList([1, null, "nope"], known), []);
  assert.deepEqual(parseFeatureList({ demo: true }, known), []);
  assert.deepEqual(resolveFeatures({ argv: "--features=demo", known }), []);
});

test("the result is frozen, each flag once", () => {
  const on = resolveFeatures({
    argv: ["--features=demo,demo"],
    env: { CHIPHIPPO_FEATURES: "demo" },
    stored: ["demo"],
    known,
  });
  assert.deepEqual(on, ["demo"]);
  assert.ok(Object.isFrozen(on));
});
