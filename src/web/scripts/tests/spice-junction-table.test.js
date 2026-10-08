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

// A junction's exponential as Spice Lite's piecewise-linear table
// (spice/junction-table.js): close to the curve, monotone, off below its
// first point, on along its last, and its own inverse.

import test from "node:test";
import assert from "node:assert/strict";
import {
  RATIO,
  VT_V,
  junctionTable,
  shockleyVolts,
  tableCurrent,
  tableSegment,
  tableSlope,
  tableVolts,
} from "../sim/spice/junction-table.js";
import { DIODE_SPEC } from "../sim/spice/diodes.js";

const DIODE = { isA: 2.682e-9, n: 1.836, rsOhm: 0.5664, ikfA: 0.04417 };

test("Shockley's voltage, with series resistance and the high-injection knee", () => {
  // ngspice's operating points for the 1N4148 card (DC part).
  for (const [amps, volts] of [
    [1e-4, 0.502193],
    [1e-3, 0.616926],
    [1e-2, 0.7466176],
    [5e-2, 0.8717174],
  ]) {
    const v = shockleyVolts(DIODE, amps);
    assert.ok(Math.abs(v - volts) < 2e-4, `${amps} A: ${v} vs ${volts}`);
  }
  assert.equal(shockleyVolts(DIODE, 0), 0);
});

test("the table strays from the curve by a few millivolts at most", () => {
  const table = junctionTable(DIODE);
  // 0.06·n·Vt for a factor of 2 along an exponential; past its IKF knee
  // the curve's exponent doubles, and the bound with it.
  const bound = 0.06 * DIODE.n * VT_V * 2;
  for (let amps = 2e-6; amps < 2; amps *= 1.13) {
    const err = Math.abs(tableVolts(table, amps) - shockleyVolts(DIODE, amps));
    assert.ok(err <= bound, `${amps} A: ${err}`);
  }
  assert.equal(DIODE_SPEC.table.v.length, table.v.length, "the diode's own");
});

test("monotone, off below its first point, and its own inverse", () => {
  const table = junctionTable(DIODE);
  const { v, i } = table;
  assert.equal(i[0], 0);
  assert.equal(tableCurrent(table, v[0]), 0);
  assert.equal(tableCurrent(table, v[0] - 0.1), 0);
  assert.equal(tableSegment(table, v[0] - 0.1), -1);
  assert.equal(tableSlope(table, v[0] - 0.1), 0);
  for (let k = 1; k < i.length; k++) {
    assert.ok(v[k] > v[k - 1] && i[k] > i[k - 1]);
    if (k > 1) assert.ok(Math.abs(i[k] / i[k - 1] - RATIO) < 1e-9);
  }
  let last = -1;
  for (let vd = v[0]; vd < v.at(-1) + 0.5; vd += 0.003) {
    const amps = tableCurrent(table, vd);
    assert.ok(amps >= last, `rises at ${vd}`);
    last = amps;
    if (amps > 0) {
      assert.ok(Math.abs(tableVolts(table, amps) - vd) < 1e-9, `inverse at ${vd}`); // prettier-ignore
    }
  }
  // Past the last point it runs on along its last segment.
  const end = v.length - 1;
  const g = (i[end] - i[end - 1]) / (v[end] - v[end - 1]);
  assert.ok(Math.abs(tableSlope(table, v[end] + 1) - g) < 1e-9 * g);
  assert.ok(Math.abs(tableCurrent(table, v[end] + 1) - (i[end] + g)) < 1e-9);
});
