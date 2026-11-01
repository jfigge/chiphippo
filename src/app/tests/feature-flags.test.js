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

test("the gallery is a known flag", () => {
  assert.ok(FEATURES.includes("gallery"));
});

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
      argv: ["electron", "app/main.js", "--features=gallery"],
    }),
    ["gallery"],
  );
});

test("the environment switches a flag on", () => {
  assert.deepEqual(
    resolveFeatures({ env: { CHIPHIPPO_FEATURES: " Gallery " } }),
    ["gallery"],
  );
});

test("the stored list switches a flag on, as an array or a string", () => {
  assert.deepEqual(resolveFeatures({ stored: ["gallery"] }), ["gallery"]);
  assert.deepEqual(resolveFeatures({ stored: "gallery" }), ["gallery"]);
});

test("unknown names and junk are ignored, never refused", () => {
  assert.deepEqual(parseFeatureList("retired, gallery ,,"), ["gallery"]);
  assert.deepEqual(parseFeatureList([1, null, "nope"]), []);
  assert.deepEqual(parseFeatureList({ gallery: true }), []);
  assert.deepEqual(resolveFeatures({ argv: "--features=gallery" }), []);
});

test("the result is frozen, each flag once", () => {
  const on = resolveFeatures({
    argv: ["--features=gallery,gallery"],
    env: { CHIPHIPPO_FEATURES: "gallery" },
    stored: ["gallery"],
  });
  assert.deepEqual(on, ["gallery"]);
  assert.ok(Object.isFrozen(on));
});
