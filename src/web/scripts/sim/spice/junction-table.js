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

// spice/junction-table.js — a junction's exponential I–V curve as the
// piecewise-linear TABLE Spice Lite solves with (features/done/spice-lite-3-plan.md,
// Phase 4). Pure and DOM-free.
//
// Spice Lite is a piecewise-linear simulator: within one PIECE every element
// is a straight line, so the network is solved exactly and an RC node runs in
// closed form; where any element changes piece is a CORNER. A diode used to
// be two pieces (nothing below a 0.6 V knee, 2 Ω above), which is a diode's
// shape only at one current. Here it is a curve — Shockley's, with its series
// resistance and SPICE's high-injection knee:
//
//   V(I) = n·Vt·ln(Id/Is + 1) + I·Rs,   I = Id / (1 + √(Id/IKF))
//
// sampled at currents a factor RATIO (2) apart, from FROM_A up, and joined by
// straight lines. Each sample is a corner. Between two, the line strays from
// the curve by at most n·Vt·0.06 (a 1N4148: 3 mV; a red LED: 4 mV), the
// error a factor of 2 in current costs; below the first sample the table
// runs straight down to zero current along its first chord, and past the
// last it carries on along its last. So a junction is still monotone and
// still piecewise linear — Newton's method and the corner search treat it as
// they always did — and reads its datasheet's curve over every current a
// breadboard asks of it.

/** kT/q at 27 °C, volts: SPICE's nominal temperature, the one the vendor
    cards and every fit here are stated at. */
export const VT_V = 0.025865;

/** The factor in current between two samples of a table. */
export const RATIO = 2;

/** Where a table's samples start and end, amps. Below FROM_A the junction
    is as good as off (the lowest current anything on a breadboard reads),
    and TO_A is past every part's smoke. */
export const FROM_A = 1e-6;
export const TO_A = 4;

/**
 * The voltage across a junction carrying `amps`: Shockley's with its series
 * resistance and high-injection knee (`ikfA`, none when 0).
 * @param {{isA: number, n: number, rsOhm?: number, ikfA?: number}} model
 * @param {number} amps
 */
export function shockleyVolts({ isA, n, rsOhm = 0, ikfA = 0 }, amps) {
  if (!(amps > 0)) return 0;
  let id = amps;
  if (ikfA > 0) {
    // I = Id / (1 + s), s = √(Id/IKF): IKF·s² − I·s − I = 0.
    const s = (amps + Math.sqrt(amps * amps + 4 * ikfA * amps)) / (2 * ikfA);
    id = ikfA * s * s;
  }
  return n * VT_V * Math.log1p(id / isA) + amps * rsOhm;
}

/**
 * A junction's table: its corners' voltages `v` and currents `i`, the first
 * at zero current. Built once per model (the callers keep it on the frozen
 * spec).
 * @param {(amps: number) => number} voltsAt - the curve, V(I)
 * @param {{fromA?: number, toA?: number, ratio?: number}} [range]
 * @returns {{v: Float64Array, i: Float64Array}}
 */
export function curveTable(
  voltsAt,
  { fromA = FROM_A, toA = TO_A, ratio = RATIO } = {},
) {
  // prettier-ignore
  const amps = [];
  for (let a = fromA; a <= toA * (1 + 1e-9); a *= ratio) amps.push(a);
  const volts = amps.map(voltsAt);
  // Down to zero current along the first chord.
  const first = (volts[1] - volts[0]) / (amps[1] - amps[0]);
  const v = Float64Array.from([volts[0] - amps[0] * first, ...volts]);
  const i = Float64Array.from([0, ...amps]);
  return Object.freeze({ v, i });
}

/** A Shockley junction's table (`shockleyVolts`). */
export function junctionTable(model, range) {
  return curveTable((amps) => shockleyVolts(model, amps), range);
}

/** The segment `vd` is on: −1 below the table (no current), else k with
    v[k] ≤ vd < v[k + 1] — the last segment running on past the end. */
export function tableSegment(table, vd) {
  const { v } = table;
  if (!(vd > v[0])) return -1;
  let lo = 0;
  let hi = v.length - 1;
  if (vd >= v[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (v[mid] <= vd) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The current, amps, `vd` volts pushes through: none at or below the
    table's start. */
export function tableCurrent(table, vd) {
  const k = tableSegment(table, vd);
  if (k < 0) return 0;
  const { v, i } = table;
  return i[k] + ((vd - v[k]) * (i[k + 1] - i[k])) / (v[k + 1] - v[k]);
}

/** ∂(tableCurrent)/∂vd, siemens: the slope of the segment `vd` is on. */
export function tableSlope(table, vd) {
  const k = tableSegment(table, vd);
  if (k < 0) return 0;
  const { v, i } = table;
  return (i[k + 1] - i[k]) / (v[k + 1] - v[k]);
}

/** The voltage, volts, at which the table carries `amps` — its inverse. */
export function tableVolts(table, amps) {
  const { v, i } = table;
  if (!(amps > 0)) return v[0];
  let k = 0;
  let hi = i.length - 1;
  if (amps >= i[hi]) k = hi - 1;
  else {
    while (hi - k > 1) {
      const mid = (k + hi) >> 1;
      if (i[mid] <= amps) k = mid;
      else hi = mid;
    }
  }
  return v[k] + ((amps - i[k]) * (v[k + 1] - v[k])) / (i[k + 1] - i[k]);
}
