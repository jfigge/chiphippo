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
// THE I–V MODEL is the junction's own curve (features/done/spice-lite-3-plan.md,
// Phase 4): Shockley's exponential behind a series resistance, V = n·Vt·
// ln(I/Is + 1) + I·Rs, fitted by least squares to the sheet's "Forward
// Current vs. Forward Voltage" figure (read at 7–11 points from its toe to
// 20 or 30 mA) and passing within a few millivolts of its typical VF at its
// test current; solved as spice/junction-table.js's piecewise-linear table.
// The red part's fit lies within 27 mV of every point read; the InGaN blue
// and white within 51 mV (their figures bend the other way past 25 mA,
// which no single exponential does); the GaP yellow and green figures are
// all but straight past a sharp toe, which the fit meets with a low
// exponent (n = 1.5 — lower is closer to a straight line, but ngspice, the
// reference, will not take the saturation current it needs) and most of the
// slope in Rs (within 43 and 30 mV). The toe is
// modelled: a red LED carries ~1 mA at 1.67 V, where the knee it replaced
// said nothing flowed below 1.8 V.
//
// HEAT is the sheet's own: the junction sits at Ta + RthJA · VF · IF
// (thermal resistance junction-to-ambient, on an FR4 board), and past its
// maximum junction temperature the LED is DESTROYED. That is the burn rule —
// a steady-state temperature, so it does not wait for the package to warm
// (a 5 mm LED takes seconds; nothing on the sheet says how many). It puts the
// burn at 72 mA for red, 62 yellow, 54 green, 39 blue and 41 white. Between
// the DC forward-current rating (30 mA; green 25) and that, the LED is
// OVERDRIVEN: the sheets' own note — "excess driving current … may result in
// severe light degradation or premature failure" — is a warning, not smoke.
//
// Every segment of a display and every bar of a bar graph is taken as its
// colour's 5 mm LED: those parts' own sheets differ by a few tenths of a volt
// and a few mA, and a generic "red 7-segment digit" names no maker either.

import {
  junctionTable,
  tableCurrent,
  tableSlope,
  tableVolts,
} from "./junction-table.js";

/** The ambient temperature every figure is quoted at, °C. */
export const AMBIENT_C = 25;

/** Below this an LED reads DARK, amps: 50 µA is a faint glow in a lit room
    (a presentation choice, not a datasheet figure). */
export const LIT_MIN_A = 50e-6;

/** The brightest a lit LED is drawn, relative to its sheet's normalising
    current (over it is the overdriven glow; past this it looks no brighter). */
export const MAX_LEVEL = 1.4;

/** A colour's spec with its table (spice/junction-table.js) built on. */
const withTable = (spec) =>
  Object.freeze({ ...spec, table: junctionTable(spec) });

/**
 * Each colour's numbers. Units are in the key: volts (`V`), mA, Ω, mW, °C,
 * °C/W, amps (`A`). `vfV` is the typical forward voltage AT `atMa` (the
 * sheet's test current); `isA`, `n` and `rsOhm` the curve fitted to its
 * forward-current figure (above); `ivAtMa` the current its luminous
 * intensity is normalised at.
 */
export const LED_SPECS = Object.freeze({
  red: withTable({
    part: "WP7113ID",
    // Electrical / Optical Characteristics: VF 1.9 V typ (2.3 max) at 10 mA.
    vfV: 1.9,
    atMa: 10,
    // Forward Current vs. Forward Voltage: 0.3 mA at 1.60 V, 2 mA at 1.70,
    // 4 mA at 1.78, 10 mA at 1.90, 20 mA at 2.00.
    isA: 1.076e-13,
    n: 2.8,
    rsOhm: 7.079,
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
  yellow: withTable({
    part: "WP7113YD",
    // VF 1.95 V typ (2.4 max) at 10 mA; the figure: 0.5 mA at 1.80 V, 3 mA
    // at 1.85, 7 mA at 1.90, 13.5 mA at 2.00, 20 mA at 2.10.
    vfV: 1.95,
    atMa: 10,
    isA: 1.197e-23,
    n: 1.5,
    rsOhm: 8.128,
    // IF 30 mA; IFP 140 mA; PD 75 mW; VR 5 V; Tj 110 °C; RthJA 560 °C/W.
    ifMaxMa: 30,
    ifPeakMa: 140,
    pdMw: 75,
    vrMaxV: 5,
    tjMaxC: 110,
    rthJA: 560,
    ivAtMa: 10,
  }),
  green: withTable({
    part: "WP7113GD",
    // VF 2.0 V typ (2.4 max) at 10 mA; the figure (which puts 10 mA at
    // 2.03 V): 0.7 mA at 1.85 V, 2.5 mA at 1.90, 8 mA at 2.00, 20 mA at
    // 2.20.
    vfV: 2,
    atMa: 10,
    isA: 3.642e-24,
    n: 1.5,
    rsOhm: 11.5,
    // IF 25 mA; IFM 140 mA; PD 62.5 mW; VR 5 V; Tj 110 °C; RthJA 600 °C/W.
    ifMaxMa: 25,
    ifPeakMa: 140,
    pdMw: 62.5,
    vrMaxV: 5,
    tjMaxC: 110,
    rthJA: 600,
    ivAtMa: 10,
  }),
  blue: withTable({
    part: "WP7113QBC/D",
    // VF 3.3 V typ (4.0 max) at 20 mA; the figure: 0.9 mA at 2.6 V, 4.8 mA
    // at 2.8, 9.8 mA at 3.0, 16.8 mA at 3.2, 30 mA at 3.5.
    vfV: 3.3,
    atMa: 20,
    isA: 3.93e-15,
    n: 3.8,
    rsOhm: 21.2,
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
  white: withTable({
    part: "WP7113QWC/D",
    // VF 3.3 V typ (4.0 max) at 20 mA; the figure: 0.9 mA at 2.6 V, 4.8 mA
    // at 2.8, 10 mA at 3.0, 16.5 mA at 3.2, 30 mA at 3.5.
    vfV: 3.3,
    atMa: 20,
    isA: 7.89e-15,
    n: 3.9,
    rsOhm: 20.93,
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

/** Each board's backlight spec, by colour and resistor (`backlightSpec`). */
const BACKLIGHTS = new Map();

/**
 * A character LCD's backlight (catalog/parts.js `LCD_BACKLIGHT`): its colour's
 * LED behind the module's own series resistor — the same curve, the resistor
 * added to its series resistance — whose rating is the module maker's and not
 * modelled: it never reads overdriven, reversed or burning.
 * @param {string} color
 * @param {number} ohms - the board's series resistor
 */
export function backlightSpec(color, ohms) {
  const key = `${color}:${ohms}`;
  const known = BACKLIGHTS.get(key);
  if (known) return known;
  const led = ledSpec(color);
  const spec = withTable({
    ...led,
    part: "backlight",
    rsOhm: led.rsOhm + ohms,
    ifMaxMa: Number.POSITIVE_INFINITY,
    vrMaxV: Number.POSITIVE_INFINITY,
    rthJA: 0,
  });
  BACKLIGHTS.set(key, spec);
  return spec;
}

/** The current, amps, that `vd` volts (anode less cathode) pushes through. */
export function ledCurrent(spec, vd) {
  return tableCurrent(spec.table, vd);
}

/** ∂(ledCurrent)/∂vd, siemens: what a Newton step reads. */
export function ledSlope(spec, vd) {
  return tableSlope(spec.table, vd);
}

/** The voltage across the LED, volts, while `amps` flows through it — the
    table's, so it is what the solve itself puts across it. */
export function ledVoltage(spec, amps) {
  return amps > 0 ? tableVolts(spec.table, amps) : 0;
}

/** The junction's steady-state temperature, °C, carrying `amps`. */
export function junctionTemp(spec, amps, ambient = AMBIENT_C) {
  return ambient + spec.rthJA * ledVoltage(spec, amps) * amps;
}

/**
 * The steady current, amps, at which the junction reaches its maximum
 * temperature — where the LED burns: V(I)·I = (Tjmax − Ta) / RthJA, found by
 * bisection (V·I only rises with I).
 */
export function burnCurrent(spec, ambient = AMBIENT_C) {
  const power = (spec.tjMaxC - ambient) / spec.rthJA;
  let lo = 0;
  let hi = 10;
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    if (ledVoltage(spec, mid) * mid < power) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
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
