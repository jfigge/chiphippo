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

// spice/leds.js — an LED as the part it is: how much current a voltage
// across it pushes through, how bright that is, and how hot it gets. Pure and
// DOM-free.
//
// A generic "red LED" must simulate with no manufacturer chosen, so each
// colour's numbers are ONE representative part's: Kingbright's WP7113 family,
// the ordinary 5 mm (T-1¾) diffused through-hole LED, every figure typical at
// 25 °C off its own datasheet (Absolute Maximum Ratings, Electrical / Optical
// Characteristics, and the "Forward Current vs. Forward Voltage" figure):
//
//   red     WP7113ID     High Efficiency Red, GaAsP/GaP, 627 nm
//   yellow  WP7113YD     Yellow, GaAsP/GaP, 590 nm
//   green   WP7113GD     Green, GaP, 565 nm
//   blue    WP7113QBC/D  Blue, InGaN, 460 nm
//   white   WP7113QWC/D  White, InGaN
//
// THE I–V MODEL is piecewise linear: nothing flows below the knee, and above
// it the voltage climbs by the dynamic resistance — V = V0 + rd·I, fitted
// through the sheet's typical VF at its test current with the slope its
// forward-current figure shows there. Red: 1.9 V at 10 mA, ~10 Ω (2.0 V at
// 20 mA), so its knee is 1.8 V. The exponential toe below the knee is not
// modelled: a red LED reads dark at 1.75 V, where the figure shows ~3 mA.
//
// HEAT is the sheet's own: the junction sits at Ta + RthJA · VF · IF
// (thermal resistance junction-to-ambient, on an FR4 board), and past its
// maximum junction temperature the LED is DESTROYED. That is the burn rule —
// a steady-state temperature, so it does not wait for the package to warm
// (a 5 mm LED takes seconds; nothing on the sheet says how many). It puts the
// burn at 71 mA for red, 60 yellow, 54 green, 39 blue and 41 white. Between
// the DC forward-current rating (30 mA; green 25) and that, the LED is
// OVERDRIVEN: the sheets' own note — "excess driving current … may result in
// severe light degradation or premature failure" — is a warning, not smoke.
//
// Every segment of a display and every bar of a bar graph is taken as its
// colour's 5 mm LED: those parts' own sheets differ by a few tenths of a volt
// and a few mA, and a generic "red 7-segment digit" names no maker either.

/** The ambient temperature every figure is quoted at, °C. */
export const AMBIENT_C = 25;

/** Below this an LED reads DARK, amps: 50 µA is a faint glow in a lit room
    (a presentation choice, not a datasheet figure). */
export const LIT_MIN_A = 50e-6;

/** The brightest a lit LED is drawn, relative to its sheet's normalising
    current (over it is the overdriven glow; past this it looks no brighter). */
export const MAX_LEVEL = 1.4;

/**
 * Each colour's numbers. Units are in the key: volts (`V`), mA, Ω, mW, °C,
 * °C/W. `vfV` is the typical forward voltage AT `atMa` (the sheet's test
 * current), `rdOhm` the slope of its forward-current figure there,
 * `ivAtMa` the current its luminous intensity is normalised at.
 */
export const LED_SPECS = Object.freeze({
  red: Object.freeze({
    part: "WP7113ID",
    // Electrical / Optical Characteristics: VF 1.9 V typ (2.3 max) at 10 mA.
    vfV: 1.9,
    atMa: 10,
    // Forward Current vs. Forward Voltage: 1.9 V → 2.0 V from 10 to 20 mA.
    rdOhm: 10,
    // Absolute Maximum Ratings: IF 30 mA DC; IFP 160 mA (1/10 duty, 0.1 ms);
    // PD 75 mW; VR 5 V; Tj 125 °C; RthJA 560 °C/W.
    ifMaxMa: 30,
    ifPeakMa: 160,
    pdMw: 75,
    vrMaxV: 5,
    tjMaxC: 125,
    rthJA: 560,
    // Iv is quoted at 10 mA, and Luminous Intensity vs. Forward Current is
    // normalised there (and a straight line through it).
    ivAtMa: 10,
  }),
  yellow: Object.freeze({
    part: "WP7113YD",
    // VF 1.95 V typ (2.4 max) at 10 mA; the figure's slope ~12 Ω (≈2.1 V at
    // 20 mA).
    vfV: 1.95,
    atMa: 10,
    rdOhm: 12,
    // IF 30 mA; IFP 140 mA; PD 75 mW; VR 5 V; Tj 110 °C; RthJA 560 °C/W.
    ifMaxMa: 30,
    ifPeakMa: 140,
    pdMw: 75,
    vrMaxV: 5,
    tjMaxC: 110,
    rthJA: 560,
    ivAtMa: 10,
  }),
  green: Object.freeze({
    part: "WP7113GD",
    // VF 2.0 V typ (2.4 max) at 10 mA; the figure's slope ~14 Ω (≈2.2 V at
    // 20 mA).
    vfV: 2,
    atMa: 10,
    rdOhm: 14,
    // IF 25 mA; IFM 140 mA; PD 62.5 mW; VR 5 V; Tj 110 °C; RthJA 600 °C/W.
    ifMaxMa: 25,
    ifPeakMa: 140,
    pdMw: 62.5,
    vrMaxV: 5,
    tjMaxC: 110,
    rthJA: 600,
    ivAtMa: 10,
  }),
  blue: Object.freeze({
    part: "WP7113QBC/D",
    // VF 3.3 V typ (4.0 max) at 20 mA; the figure's slope ~25 Ω (≈2.95 V at
    // 10 mA, 3.2 V at 20 mA, 3.5 V at 30 mA).
    vfV: 3.3,
    atMa: 20,
    rdOhm: 25,
    // IF 30 mA; IFP 150 mA; PD 120 mW; VR 5 V; Tj 115 °C; RthJA 610 °C/W.
    ifMaxMa: 30,
    ifPeakMa: 150,
    pdMw: 120,
    vrMaxV: 5,
    tjMaxC: 115,
    rthJA: 610,
    // Iv at 20 mA, and its intensity figure normalised there.
    ivAtMa: 20,
  }),
  white: Object.freeze({
    part: "WP7113QWC/D",
    // VF 3.3 V typ (4.0 max) at 20 mA; the figure's slope ~25 Ω (≈2.95 V at
    // 10 mA, 3.5 V at 30 mA).
    vfV: 3.3,
    atMa: 20,
    rdOhm: 25,
    // IF 30 mA; IFP 150 mA; PD 120 mW; VR 5 V; Tj 115 °C; RthJA 570 °C/W.
    ifMaxMa: 30,
    ifPeakMa: 150,
    pdMw: 120,
    vrMaxV: 5,
    tjMaxC: 115,
    rthJA: 570,
    ivAtMa: 20,
  }),
});

/** A colour's spec — red for a colour the table does not know, as the desk
    draws one. */
export function ledSpec(color) {
  return LED_SPECS[color] ?? LED_SPECS.red;
}

/** The knee, volts: where the model's straight line meets zero current. */
export function ledKnee(spec) {
  return spec.vfV - (spec.rdOhm * spec.atMa) / 1000;
}

/** The current, amps, that `vd` volts (anode less cathode) pushes through. */
export function ledCurrent(spec, vd) {
  const over = vd - ledKnee(spec);
  return over > 0 ? over / spec.rdOhm : 0;
}

/** The voltage across the LED, volts, while `amps` flows through it. */
export function ledVoltage(spec, amps) {
  return amps > 0 ? ledKnee(spec) + amps * spec.rdOhm : 0;
}

/** The junction's steady-state temperature, °C, carrying `amps`. */
export function junctionTemp(spec, amps, ambient = AMBIENT_C) {
  return ambient + spec.rthJA * ledVoltage(spec, amps) * amps;
}

/**
 * The steady current, amps, at which the junction reaches its maximum
 * temperature — where the LED burns: rd·I² + V0·I = (Tjmax − Ta) / RthJA.
 */
export function burnCurrent(spec, ambient = AMBIENT_C) {
  const power = (spec.tjMaxC - ambient) / spec.rthJA;
  const v0 = ledKnee(spec);
  return (-v0 + Math.sqrt(v0 * v0 + 4 * spec.rdOhm * power)) / (2 * spec.rdOhm);
}

/**
 * What one junction carrying `amps`, with `vd` volts across it, looks like:
 * lit, how bright (`level`, the cube root of its current against the sheet's
 * normalising one — roughly how an eye reads a point of light; 1 at that
 * current), overdriven past its DC rating, BURNING past its maximum junction
 * temperature, and reverse-biased past its rated reverse voltage.
 * @param {object} spec - a LED_SPECS entry
 * @param {number} amps
 * @param {number} vd - anode less cathode, volts
 */
export function ledVerdict(spec, amps, vd) {
  const tj = junctionTemp(spec, amps);
  const lit = amps >= LIT_MIN_A;
  return {
    amps,
    volts: vd,
    tj,
    lit,
    level: lit
      ? Math.min(MAX_LEVEL, Math.cbrt((amps * 1000) / spec.ivAtMa))
      : 0,
    overdriven: amps * 1000 > spec.ifMaxMa,
    burns: tj > spec.tjMaxC,
    reverse: -vd > spec.vrMaxV,
    // The two ratings a warning quotes: its DC current (amps), its reverse
    // voltage (volts).
    rating: spec.ifMaxMa / 1000,
    vrMax: spec.vrMaxV,
  };
}
