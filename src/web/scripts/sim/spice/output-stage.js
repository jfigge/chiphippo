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
// that load holds the pin at. Pure and DOM-free. The voltage solve (spice/
// voltages.js) drives every net through the stages of the outputs on it.
//
// A stage is an open-circuit level behind a resistance, optionally capped by
// a current the output transistor saturates at:
//
//   source (HIGH): I = min(limit, (Voc − V) / R) while V < Voc, else 0
//   sink   (LOW):  I = min(limit, (V − Vol) / R) while V > Vol, else 0
//
// — or, for a MOSFET whose stage says `curve`, the square law those two
// figures set: R is its slope at the rail and the limit where it saturates,
// so with d the volts the load holds it from its open-circuit level, its
// overdrive is vov = 2·R·limit and
//
//   I = limit · (2x − x²),  x = d / vov,   and the limit from x = 1 on
//
// — a level-1 channel with Vgs = VDD, no new figure in it. A square law is
// not straight, so it is drawn as chords between CURVE_CORNERS (tenths of
// the overdrive, finer near the rail — transistors.js re-linearizes a
// MOSFET's linear region by tenths too), each chord's end a corner. Two lines met 1.7 V from the rail at 5 V, where
// the channel delivers only 3.1 mA of the lines' 4.2: a capacitor charged
// too fast mid-ramp, the B ngspice graded (features/done/spice-lite-3-plan.md).
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
//           Between the two, the square law they set (a `curve`): an
//           overdrive of 3.36 / 6.08 / 11.2 V. Below 5 V the saturation current is taken down to nothing at
//           2 V, a B-series threshold (an assumption: no sheet curve goes
//           below VGS 5 V).
//
//   MOS     every part in NO family that states no stage of its own — the
//           memories, the CPUs and the 65xx peripherals, the HD44780 LCD
//           controller, the oscillator cans. They are CMOS (or NMOS) parts
//           with TTL-COMPATIBLE outputs: their sheets guarantee a TTL VOH
//           (2.4 V) and VOL (0.4 V) at a few milliamps, and draw no curve. One
//           common stage stands for all of them (Jason, 2026-10-07 — one
//           common set, never per part): rail to rail behind 100 Ω, with no
//           saturation. 100 Ω is an ASSUMPTION, bracketed by the TTL-
//           compatible CMOS logic sheets that do draw one (SN74HCT00,
//           SCLS062: VOH 3.98 V min at −4 mA, VCC 4.5 V — 130 Ω — and about
//           50 Ω typical; VOL 0.26 V max at 4 mA — 65 Ω).
//
// A part whose output stage is not its family's says so in the catalog
// (`def.outputStage`, either side or both): the NE555's bipolar output, the
// CD4511B's n-p-n segment drivers, the CD4049UB/CD4050B's high-current sink.
//
// STRENGTH. Settings ▸ Spice Lite's output source and sink currents (spice/
// params.js FAMILY_DEFAULTS `sourceMa`, `sinkMa`) are what each family's
// stage is built round: the current its representative output delivers at
// its sheet's VOH / VOL test point. A user's own figure scales the stage
// that derives from the family by its ratio to the default (`stageStrength`):
// twice the sink current is a LOW transistor twice as big — half the
// resistance, twice the saturation current — as a def's own `scale` is. A
// stage a def states outright (its own ohms, its own limit) is that part's,
// and no family figure moves it.

import { familyOf } from "../../catalog/families.js";

/** [volts, value] points, read by straight lines between them and held
    beyond the ends. */
export function interpolate(points, x) {
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
 * each `{volts(vcc), ohms(vcc), limitMa(vcc), channel?}` — the open-circuit
 * level, the resistance behind it, the most it delivers (Infinity: no
 * limit), and whether it is a MOSFET CHANNEL: an on transistor that conducts
 * either way. A CMOS LOW is an n-channel to ground, so a node pulled below
 * ground through a capacitor draws current back up through it, as a HIGH
 * takes current into VDD from a node pushed above it; a 74LS totem pole's
 * Darlington cannot sink and its saturated pull-down cannot source, so its
 * stages are one-way. One-way, a CMOS LOW let the far plate of a capacitor
 * fall 2.5 V below ground, and the two-gate RC oscillator chattered at its
 * first crossing.
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
      channel: true,
      curve: true,
    }),
    low: Object.freeze({
      volts: () => 0,
      ohms: (vcc) => interpolate(CMOS_ON_OHMS, vcc),
      limitMa: (vcc) => interpolate(CMOS_SATURATION_MA, vcc),
      channel: true,
      curve: true,
    }),
  }),
});

/** The common stage of a part in no family (the header's MOS). */
export const MOS_STAGE = Object.freeze({
  high: Object.freeze({
    volts: (vcc) => vcc,
    ohms: () => 100,
    limitMa: () => Number.POSITIVE_INFINITY,
    channel: true,
  }),
  low: Object.freeze({
    volts: () => 0,
    ohms: () => 100,
    limitMa: () => Number.POSITIVE_INFINITY,
    channel: true,
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

/** An analog switch channel's on-resistance, Ω, for a part on `vcc` volts.
    (A transistor — a discrete one, or one of a CD4007UB's — is no channel
    to Spice Lite but a device of the network solve: spice/network.js.) */
export function channelOhms(def, vcc) {
  return interpolate(SWITCH_ON_OHMS, Number.isFinite(vcc) ? vcc : 5);
}

/** The stages a def's outputs are built from: its family's, or — in no
    family — the common MOS one. */
export function stagesOf(def) {
  return FAMILY_STAGES[familyOf(def)] ?? MOS_STAGE;
}

/**
 * One output's stage while it drives `level` from a supply of `vcc` volts:
 * `{volts, ohms, limit, sources, channel}` — the open-circuit level, the
 * resistance, the most it delivers in AMPS (Infinity: none), whether it
 * pushes current OUT (HIGH) or takes it IN (LOW), and whether it conducts
 * the other way too (a MOSFET channel; a def's own side says so, or takes
 * its family's). Null for anything but H or L.
 * @param {object} def - the chip's catalog def
 * @param {number} vcc - the supply the chip sees, volts
 * @param {"H"|"L"} level
 * @param {number} [strength] - the family's figure against its default
 *   (spice/params.js `stageStrength`; 1 = the default)
 */
export function outputStage(def, vcc, level, strength = 1) {
  if (level !== "H" && level !== "L") return null;
  const side = level === "H" ? "high" : "low";
  const base = stagesOf(def)[side];
  const own = def?.outputStage?.[side] ?? null;
  const volts = own?.volts ?? base.volts(vcc);
  // A `scale` is a transistor that many times its family's: that many times
  // the current, and a resistance that many times smaller — as is a user's
  // own figure for the family (`strength`), on whatever derives from it.
  const scale = (own?.scale ?? 1) * strength;
  const ohms = own?.ohms ?? base.ohms(vcc) / scale;
  // A def's own limit is a [volts, mA] table, or one number at every supply
  // (Infinity: a stage nothing but its own resistance limits).
  const ownLimit = own?.limitMa;
  const limitMa =
    ownLimit == null
      ? base.limitMa(vcc) * scale
      : (typeof ownLimit === "number" ? ownLimit : interpolate(ownLimit, vcc)) *
        (own?.scale ?? 1);
  const limit = limitMa / 1000;
  const stage = {
    volts: typeof volts === "function" ? volts(vcc) : volts,
    ohms,
    limit,
    sources: level === "H",
    channel: own?.channel ?? base.channel ?? false,
  };
  // The family's square law, where the stage is still the family's MOSFET
  // (a `scale` keeps it: the current scales, the overdrive does not). A side
  // stating its own resistance or limit is some other transistor.
  const curved = base.curve && own?.ohms == null && ownLimit == null;
  if (curved && limit > 0 && Number.isFinite(limit)) stage.vov = 2 * ohms * limit; // prettier-ignore
  return stage;
}

/**
 * Where a curved stage's chords end, as fractions of its overdrive: tenths,
 * with the first tenth halved three times more — a chord there is nearly
 * the curve's own slope, and nearly every load on a desk (a pull-up, an
 * input, a 10 kΩ divider) sits within it. Past the last, saturated.
 */
export const CURVE_CORNERS = Object.freeze([
  0, 0.0125, 0.025, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
]);

/** The chords' ends on a curved stage, `[d, amps]` from 0 to its overdrive
    (the open-circuit level to saturation): ON the square law, but the first,
    which is on its tangent — so a load that draws little sees R exactly. */
export function stageCorners(stage) {
  return CURVE_CORNERS.map((x, k) => [
    x * stage.vov,
    stage.limit * (k === 1 ? 2 * x : x * (2 - x)),
  ]);
}

/** Each curved stage's chords' ends, by stage: a stage is built once per
    output per solve and read at every Newton step. */
const CORNERS = new WeakMap();

function cornersOf(stage) {
  let corners = CORNERS.get(stage);
  if (!corners) CORNERS.set(stage, (corners = stageCorners(stage)));
  return corners;
}

/** The chord `d` volts of drive is on (0…), or the corners' count less one
    once saturated. */
function chordOf(corners, d) {
  let k = 0;
  while (k < corners.length - 1 && d >= corners[k + 1][0]) k++;
  return k;
}

/** A chord's slope, siemens. */
function chordSiemens(corners, k) {
  const [d0, i0] = corners[k];
  const [d1, i1] = corners[k + 1];
  return (i1 - i0) / (d1 - d0);
}

/**
 * The current, amps, a stage delivers with its net held `d` volts from its
 * open-circuit level the way it drives (d > 0): along its resistance up to
 * its limit, or along its curve's chords.
 * @param {object} stage - an `outputStage`
 * @param {number} d
 */
export function stageDelivers(stage, d) {
  if (!(d > 0)) return 0;
  if (!stage.vov) return Math.min(stage.limit, d / stage.ohms);
  const corners = cornersOf(stage);
  const k = chordOf(corners, d);
  if (k >= corners.length - 1) return stage.limit;
  return corners[k][1] + (d - corners[k][0]) * chordSiemens(corners, k);
}

/** ∂(stageDelivers)/∂d at `d` ≥ 0, siemens: 1/R (or the chord's slope)
    where it is linear, 0 where it is saturated. */
function deliversSlope(stage, d) {
  if (!stage.vov) return d / stage.ohms < stage.limit ? 1 / stage.ohms : 0;
  const corners = cornersOf(stage);
  const k = chordOf(corners, d);
  return k >= corners.length - 1 ? 0 : chordSiemens(corners, k);
}

/**
 * The current, amps, a stage puts INTO its net when that net sits at `v`
 * volts — positive while a HIGH sources, negative while a LOW sinks, and
 * never the other way (a TTL HIGH cannot sink, a LOW cannot source) — except
 * through a channel, which carries either way, up to its limit each way.
 */
export function stageCurrent(stage, v) {
  if (stage.channel) {
    const d = stage.volts - v;
    return d < 0 ? -stageDelivers(stage, -d) : stageDelivers(stage, d);
  }
  if (stage.sources) return stageDelivers(stage, stage.volts - v);
  const pull = v - stage.volts;
  return pull > 0 ? -stageDelivers(stage, pull) : 0;
}

/** ∂(stageCurrent)/∂v, siemens: −1/R (or its chord's slope) where the stage
    is linear, 0 where it is saturated or off — the slope a Newton step reads
    (spice/lamps.js). */
export function stageSlope(stage, v) {
  const d = stage.sources || stage.channel ? stage.volts - v : v - stage.volts;
  const g = stage.channel || d > 0 ? deliversSlope(stage, Math.abs(d)) : 0;
  return g > 0 ? -g : 0;
}

/**
 * Which piece of its characteristic a stage is on at `v`, one character:
 * "0" off, "1" along its resistance (a curve: its chord, a letter — lower
 * case driving its own way, upper case driven back through a channel, the
 * chord through zero one straight line both ways), "2" saturated driving
 * its own way and "3" saturated the other (a channel).
 */
export function stagePiece(stage, v) {
  const d = stage.sources || stage.channel ? stage.volts - v : v - stage.volts;
  if (!stage.channel && !(d > 0)) return "0";
  const ahead = stage.channel ? d >= 0 : true;
  const along = Math.abs(d);
  if (stage.vov) {
    const corners = cornersOf(stage);
    const k = chordOf(corners, along);
    if (k >= corners.length - 1) return ahead ? "2" : "3";
    return String.fromCharCode((ahead || k === 0 ? 97 : 65) + k);
  }
  if (along / stage.ohms < stage.limit) return "1";
  return ahead ? "2" : "3";
}

/**
 * The voltages where a stage's slope changes: its open-circuit level, and
 * where it saturates — each chord's end along a curve — the way it drives
 * (a channel both ways).
 */
export function stageKinks(stage) {
  const out = [stage.volts];
  if (!Number.isFinite(stage.limit)) return out;
  const reach = stage.vov
    ? cornersOf(stage)
        .slice(1)
        .map(([d]) => d)
    : [stage.limit * stage.ohms];
  // A source falls below its level as it delivers; a sink rises above it.
  const dir = stage.sources ? -1 : 1;
  for (const d of reach) {
    out.push(stage.volts + dir * d);
    if (stage.channel) out.push(stage.volts - dir * d);
  }
  return out;
}
