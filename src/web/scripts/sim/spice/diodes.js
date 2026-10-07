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

// spice/diodes.js — a diode or a Zener as the junction it is, beside the
// LEDs of spice/leds.js. Pure and DOM-free.
//
// ONE COMMON SILICON JUNCTION for every diode on the desk (Jason, 2026-10-07:
// a common, reasonable value set per family, never one maker's or one part's
// figures — a "1N4148" and a "1N4001" on the desk are the same diode here).
// The I–V model is leds.js's piecewise line: nothing below the knee, then
// the knee plus the dynamic resistance — 0.6 V and 2 Ω, which reads 0.62 V
// at 10 mA and 0.8 V at 100 mA, between a small-signal diode's curve and a
// rectifier's. A ZENER conducts the same way forward and, backwards, past
// its Zener voltage (the part's own `zenerVolts` — a value the user sets, not
// a maker's figure) behind the same kind of slope, its dynamic impedance; a
// Zener whose voltage is not set has no breakdown to model and is a plain
// diode.
//
// HEAT follows leds.js's rule: the junction sits at Ta + RthJA · |V·I|, and
// past its maximum temperature the diode is DESTROYED (open from then on) —
// one wired straight across the rails, or an output into ground. 150 °C and
// 300 °C/W (a small glass or epoxy body on a breadboard) put the burn at
// about a third of an amp forward.

import { AMBIENT_C } from "./leds.js";

/** The common junction. Units are in the key: volts (`V`), Ω, °C, °C/W. */
export const DIODE_SPEC = Object.freeze({
  kind: "diode",
  kneeV: 0.6,
  rdOhm: 2,
  // Reverse breakdown's dynamic impedance, for a Zener.
  rzOhm: 5,
  tjMaxC: 150,
  rthJA: 300,
});

/**
 * The junction a diode or Zener is: the common spec, with a Zener's own
 * breakdown voltage when it has one.
 * @param {object|null} def - the part's catalog def (`def.diode.zener`)
 * @param {object} [params] - its params (`zenerVolts`)
 */
export function diodeSpec(def, params = {}) {
  const vz = Number(params?.zenerVolts);
  if (def?.diode?.zener && vz > 0) return Object.freeze({ ...DIODE_SPEC, zenerV: vz }); // prettier-ignore
  return DIODE_SPEC;
}

/** The current, amps, that `vd` volts (anode less cathode) pushes through —
    negative while a Zener conducts backwards. */
export function diodeCurrent(spec, vd) {
  const over = vd - spec.kneeV;
  if (over > 0) return over / spec.rdOhm;
  if (spec.zenerV > 0 && -vd > spec.zenerV) return (vd + spec.zenerV) / spec.rzOhm; // prettier-ignore
  return 0;
}

/** ∂(diodeCurrent)/∂vd, siemens: what a Newton step reads. */
export function diodeSlope(spec, vd) {
  if (vd > spec.kneeV) return 1 / spec.rdOhm;
  if (spec.zenerV > 0 && -vd > spec.zenerV) return 1 / spec.rzOhm;
  return 0;
}

/**
 * One diode carrying `amps` with `vd` across it: its junction temperature,
 * and whether that burns it. Shaped like leds.js's `ledVerdict` (a diode is
 * never lit, never overdriven, never warned for its reverse voltage) so the
 * one solve hands both back alike.
 */
export function diodeVerdict(spec, amps, vd) {
  const tj = AMBIENT_C + spec.rthJA * Math.abs(vd * amps);
  return {
    amps,
    volts: vd,
    tj,
    lit: false,
    level: 0,
    overdriven: false,
    burns: tj > spec.tjMaxC,
    reverse: false,
    diode: true,
  };
}
