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

// spice-config.test.js — the Spice Lite setting's one reader
// (sim/spice/config.js) and the engine seam it drives (sim/engines.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_GAP_PERCENT,
  DEFAULT_SPICE_CONFIG,
  FIELD_RANGES,
  GAP_PERCENT_RANGE,
  normalizeSpiceConfig,
} from "../sim/spice/config.js";
import { FAMILY_DEFAULTS } from "../sim/spice/params.js";
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
  // Under the range: its nearest end, as over it.
  for (const gapPercent of [0, -1, 0.01]) {
    assert.equal(
      normalizeSpiceConfig({ gapPercent }).gapPercent,
      GAP_PERCENT_RANGE.min,
      String(gapPercent),
    );
  }
  for (const gapPercent of [Number.NaN, "x", null, "2"]) {
    assert.equal(
      normalizeSpiceConfig({ gapPercent }).gapPercent,
      DEFAULT_GAP_PERCENT,
      String(gapPercent),
    );
  }
});

test("normalizeSpiceConfig: overrides keep known families' known keys, as finite numbers", () => {
  const config = normalizeSpiceConfig({
    families: {
      "74LS": { delayNs: 12, sinkMa: "8", vilV: 0, unknown: 3 },
      CD4000: { delayNs: Number.NaN, vihV: Number.POSITIVE_INFINITY },
      "74HC": { delayNs: 8 },
    },
  });
  // VIL 0 is under its range: its least, 0.01 V (still a band under VIH).
  assert.deepEqual(config.families, { "74LS": { delayNs: 12, vilV: 0.01 } });
  assert.ok(Object.isFrozen(config.families["74LS"]));
});

test("normalizeSpiceConfig: a number outside its range is set to the nearest end of it", () => {
  // A delay of milliseconds once ran every tick's analog time ahead of the
  // clock that drove it, and froze every RC node on the desk: it is the
  // longest delay there is instead.
  const config = normalizeSpiceConfig({
    families: {
      "74LS": { delayNs: 1e7, sinkMa: 4, loadPf: 1e6, sourceMa: 1e-9 },
      CD4000: { vihV: 12, supplyMa: 5000, delayNs: 10_000 },
    },
  });
  assert.deepEqual(config.families, {
    "74LS": { delayNs: 10_000, sinkMa: 4, loadPf: 10_000, sourceMa: 0.001 },
    CD4000: { vihV: 5, supplyMa: 1000, delayNs: 10_000 },
  });
});

test("every family default sits inside its range, and every field has one", () => {
  for (const [family, defaults] of Object.entries(FAMILY_DEFAULTS)) {
    for (const [key, value] of Object.entries(defaults)) {
      const range = FIELD_RANGES[key];
      assert.ok(range, `${key} has a range`);
      assert.ok(value >= range.min && value <= range.max, `${family} ${key} ${value}`); // prettier-ignore
    }
  }
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

test("engineFor: the digital engine unless Spice Lite is switched on", () => {
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
