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

// spice/output-stage.js — what a chip output can PUSH: the current it sources
// HIGH or sinks LOW into whatever hangs on it, as a function of the voltage
// that load holds the pin at. Pure and DOM-free. Spice Light reads it for one
// thing — the current through an LED (spice/lamps.js) — since an input load
// is microamps and the digital level is all the rest of the desk needs.
//
// A stage is an open-circuit level behind a resistance, optionally capped by
// a current the output transistor saturates at:
//
//   source (HIGH): I = min(limit, (Voc − V) / R) while V < Voc, else 0
//   sink   (LOW):  I = min(limit, (V − Vol) / R) while V > Vol, else 0
//
// Each family's numbers are its representative part's, typical at 25 °C:
//
//   74LS    SN74LS00 — SDLS025B's schematic puts the HIGH behind a Darlington
//           (two VBE, 1.4 V) and a 120 Ω collector resistor: VOH = VCC − 1.4 V
//           less 120 Ω, which is 3.3 V at VCC 4.75 V and 0.4 mA (§6.6: 3.4 V
//           typ) and shorts at 32 mA at 5.25 V (IOS 20–100 mA). LOW: §6.6
//           VOL 0.25 V typ at 4 mA, 0.35 V at 8 mA — 0.15 V behind 25 Ω, with
//           no limit (past IOL a real one is sinking more than it is rated
//           to, and its VOL climbs faster than this says).
//   CD4000  CD4029B (SCHS034C, the Harris scan: "typical output low (sink)
//           / high (source) current characteristics", Figs. 1 and 3, and the
//           static characteristics' IOL) — a MOSFET
//           that saturates at ~4.2 mA at VDD 5 V, ~16 mA at 10 V and ~28 mA
//           at 15 V (sink and source read alike), behind its linear-region
//           resistance: IOL 1 mA typ at VO 0.4 V (5 V), 2.6 mA at 0.5 V
//           (10 V) — 400 Ω and 190 Ω — and ~200 Ω at 15 V (Fig. 1's slope).
//           Below 5 V the saturation current is taken down to nothing at
//           2 V, a B-series threshold (an assumption: no sheet curve goes
//           below VGS 5 V).
//
// A part whose output stage is not its family's says so in the catalog
// (`def.outputStage`, either side or both): the NE555's bipolar output, the
// CD4511B's n-p-n segment drivers, the CD4049UB/CD4050B's high-current sink.
// A family-less part without one (memory, the CPUs, the 65xx peripherals, a
// designed chip with no family) takes the 74LS stage: their outputs are
// specified TTL-compatible, and none of them is wired to light an LED.

import { familyOf } from "../../catalog/families.js";

/** [volts, value] points, read by straight lines between them and held
    beyond the ends. */
function interpolate(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** A B-series output's saturation current, mA, at VDD (Figs. 1 and 3). */
const CMOS_SATURATION_MA = Object.freeze([
  Object.freeze([2, 0]),
  Object.freeze([5, 4.2]),
  Object.freeze([10, 16]),
  Object.freeze([15, 28]),
]);

/** A B-series output's linear-region resistance, Ω, at VDD. */
const CMOS_ON_OHMS = Object.freeze([
  Object.freeze([5, 400]),
  Object.freeze([10, 190]),
  Object.freeze([15, 200]),
]);

/**
 * Each family's stage, as functions of the chip's supply: `high` and `low`
 * each `{volts(vcc), ohms(vcc), limitMa(vcc)}` — the open-circuit level, the
 * resistance behind it and the most it delivers (Infinity: no limit).
 */
export const FAMILY_STAGES = Object.freeze({
  "74LS": Object.freeze({
    high: Object.freeze({
      volts: (vcc) => vcc - 1.4,
      ohms: () => 120,
      limitMa: () => Number.POSITIVE_INFINITY,
    }),
    low: Object.freeze({
      volts: () => 0.15,
      ohms: () => 25,
      limitMa: () => Number.POSITIVE_INFINITY,
    }),
  }),
  CD4000: Object.freeze({
    high: Object.freeze({
      volts: (vcc) => vcc,
      ohms: (vcc) => interpolate(CMOS_ON_OHMS, vcc),
      limitMa: (vcc) => interpolate(CMOS_SATURATION_MA, vcc),
    }),
    low: Object.freeze({
      volts: () => 0,
      ohms: (vcc) => interpolate(CMOS_ON_OHMS, vcc),
      limitMa: (vcc) => interpolate(CMOS_SATURATION_MA, vcc),
    }),
  }),
});

/** An analog switch channel's on-resistance, Ω, at VDD: the CD4066B/405xB
    sheets' 470 Ω typical at 5 V, 180 Ω at 10 V and 125 Ω at 15 V (as
    catalog/families.js's LED rule reads them). */
const SWITCH_ON_OHMS = Object.freeze([
  Object.freeze([5, 470]),
  Object.freeze([10, 180]),
  Object.freeze([15, 125]),
]);

/** A channel's on-resistance, Ω, for a part on `vcc` volts. A discrete
    transistor switched on is a closed switch (its VCE(sat), its gain and its
    base current are not modelled), so it has none — spice/lamps.js joins
    its two nets outright. */
export function channelOhms(def, vcc) {
  if (def?.transistor) return 0;
  return interpolate(SWITCH_ON_OHMS, Number.isFinite(vcc) ? vcc : 5);
}

/**
 * One output's stage while it drives `level` from a supply of `vcc` volts:
 * `{volts, ohms, limit, sources}` — the open-circuit level, the resistance,
 * the most it delivers in AMPS (Infinity: none), and whether it pushes
 * current OUT (HIGH) or takes it IN (LOW). Null for anything but H or L.
 * @param {object} def - the chip's catalog def
 * @param {number} vcc - the supply the chip sees, volts
 * @param {"H"|"L"} level
 */
export function outputStage(def, vcc, level) {
  if (level !== "H" && level !== "L") return null;
  const side = level === "H" ? "high" : "low";
  const family = FAMILY_STAGES[familyOf(def)] ?? FAMILY_STAGES["74LS"];
  const base = family[side];
  const own = def?.outputStage?.[side] ?? null;
  const volts = own?.volts ?? base.volts(vcc);
  // A `scale` is a transistor that many times its family's: that many times
  // the current, and a resistance that many times smaller.
  const scale = own?.scale ?? 1;
  const ohms = own?.ohms ?? base.ohms(vcc) / scale;
  const limitMa =
    (own?.limitMa != null ? interpolate(own.limitMa, vcc) : base.limitMa(vcc)) *
    scale;
  return {
    volts: typeof volts === "function" ? volts(vcc) : volts,
    ohms,
    limit: limitMa / 1000,
    sources: level === "H",
  };
}

/**
 * The current, amps, a stage puts INTO its net when that net sits at `v`
 * volts — positive while a HIGH sources, negative while a LOW sinks, and
 * never the other way (a TTL HIGH cannot sink, a LOW cannot source).
 */
export function stageCurrent(stage, v) {
  if (stage.sources) {
    const push = stage.volts - v;
    return push > 0 ? Math.min(stage.limit, push / stage.ohms) : 0;
  }
  const pull = v - stage.volts;
  return pull > 0 ? -Math.min(stage.limit, pull / stage.ohms) : 0;
}

/** ∂(stageCurrent)/∂v, siemens: −1/R where the stage is linear, 0 where it is
    saturated or off — the slope a Newton step reads (spice/lamps.js). */
export function stageSlope(stage, v) {
  if (stage.sources) {
    const push = stage.volts - v;
    return push > 0 && push / stage.ohms < stage.limit ? -1 / stage.ohms : 0;
  }
  const pull = v - stage.volts;
  return pull > 0 && pull / stage.ohms < stage.limit ? -1 / stage.ohms : 0;
}
