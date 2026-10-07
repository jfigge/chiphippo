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

// spice-config.test.js — the Spice Light setting's one reader
// (sim/spice/config.js) and the engine seam it drives (sim/engines.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GAP_PERCENT,
  DEFAULT_SPICE_CONFIG,
  GAP_PERCENT_RANGE,
  normalizeSpiceConfig,
} from "../sim/spice/config.js";
import { ENGINES, engineFor } from "../sim/engines.js";
import { tick, settle } from "../sim/engine.js";

test("normalizeSpiceConfig: anything not an object is the default — off", () => {
  for (const raw of [undefined, null, 1, "on", true, []]) {
    assert.deepEqual(normalizeSpiceConfig(raw), DEFAULT_SPICE_CONFIG);
  }
  assert.equal(DEFAULT_SPICE_CONFIG.enabled, false);
  assert.equal(DEFAULT_SPICE_CONFIG.gapPercent, DEFAULT_GAP_PERCENT);
});

test("normalizeSpiceConfig: enabled only when exactly true", () => {
  assert.equal(normalizeSpiceConfig({ enabled: true }).enabled, true);
  for (const enabled of [1, "true", "yes", {}, false]) {
    assert.equal(normalizeSpiceConfig({ enabled }).enabled, false);
  }
});

test("normalizeSpiceConfig: the gap threshold is clamped, junk is the default", () => {
  assert.equal(normalizeSpiceConfig({ gapPercent: 2.5 }).gapPercent, 2.5);
  assert.equal(
    normalizeSpiceConfig({ gapPercent: 50 }).gapPercent,
    GAP_PERCENT_RANGE.max,
  );
  for (const gapPercent of [0, -1, 0.01, Number.NaN, "x", null]) {
    assert.equal(
      normalizeSpiceConfig({ gapPercent }).gapPercent,
      DEFAULT_GAP_PERCENT,
      String(gapPercent),
    );
  }
});

test("normalizeSpiceConfig: overrides keep known families' known keys, positive and finite", () => {
  const config = normalizeSpiceConfig({
    families: {
      "74LS": { delayNs: 12, sinkMa: "8", vilV: 0, unknown: 3 },
      CD4000: { delayNs: Number.NaN, vihV: Number.POSITIVE_INFINITY },
      "74HC": { delayNs: 8 },
    },
  });
  assert.deepEqual(config.families, { "74LS": { delayNs: 12 } });
  assert.ok(Object.isFrozen(config.families["74LS"]));
});

test("normalizeSpiceConfig: thresholds that leave no band are dropped together", () => {
  // A hand-edited settings file the panel would have refused.
  const config = normalizeSpiceConfig({
    families: {
      "74LS": { vilV: 2.5, sinkMa: 4 }, // over the default VIH of 2
      CD4000: { vilV: 2, vihV: 3 }, // a band: kept
    },
  });
  assert.deepEqual(config.families, {
    "74LS": { sinkMa: 4 },
    CD4000: { vilV: 2, vihV: 3 },
  });
});

test("engineFor: the digital engine unless Spice Light is switched on", () => {
  assert.equal(engineFor(undefined), ENGINES.digital);
  assert.equal(engineFor({ enabled: false }), ENGINES.digital);
  assert.equal(engineFor({ enabled: true }), ENGINES.spice);
  // The digital entry IS sim/engine.js — not a wrapper that could drift.
  assert.equal(ENGINES.digital.tick, tick);
  assert.equal(ENGINES.digital.settle, settle);
  assert.equal(ENGINES.digital.id, "digital");
  assert.equal(ENGINES.spice.id, "spice");
});

test("spice engine: a desk with nothing analog reports empty analog fields", () => {
  const empty = {
    document: { boards: [], components: [], wires: [] },
    netlist: { netOfPoint: new Map(), nets: new Map() },
  };
  const r = ENGINES.spice.tick({ ...empty, spice: { analog: null } });
  assert.equal(r.analog.nodes.size, 0);
  assert.equal(r.analog.outputs.size, 0);
  for (const key of ["nodeVolts", "supplies", "loads"]) {
    assert.ok(r[key] instanceof Map, key);
    assert.equal(r[key].size, 0, key);
  }
  assert.equal(r.wakeAt, null);
  assert.equal(ENGINES.spice.settle(empty).analog, null);
});
