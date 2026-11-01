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

// The renderer's feature flags (feature-flags.js): asked once, read sync.
import test from "node:test";
import assert from "node:assert/strict";

import { featureEnabled, loadFeatures } from "../feature-flags.js";

test("every flag is off until main says otherwise", async () => {
  await loadFeatures({ getFeatures: async () => [] });
  assert.equal(featureEnabled("gallery"), false);
});

test("a flag main names is on", async () => {
  assert.deepEqual(
    await loadFeatures({ getFeatures: async () => ["gallery"] }),
    ["gallery"],
  );
  assert.equal(featureEnabled("gallery"), true);
  assert.equal(featureEnabled("other"), false);
});

test("a failed or junk answer leaves every flag off", async () => {
  await loadFeatures({ getFeatures: async () => ["gallery"] });
  await loadFeatures({
    getFeatures: async () => {
      throw new Error("no main");
    },
  });
  assert.equal(featureEnabled("gallery"), false);
  await loadFeatures({ getFeatures: async () => "gallery" });
  assert.equal(featureEnabled("gallery"), false);
  await loadFeatures({});
  assert.equal(featureEnabled("gallery"), false);
});
