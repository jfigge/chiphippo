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

// spice/params.js — the per-family electrical numbers Spice Light simulates
// with, and the one place each is read (features/spice-light.md §5, §10).
// Pure and DOM-free.
//
// Every DEFAULT is a TYPICAL value at 25 °C off one TI datasheet, cited beside
// it — never a per-part figure: a generic "74LS00" must simulate with no
// manufacturer or part chosen, so a family's numbers are its representative
// gate's. The user may override any of them (Settings ▸ Spice Light, stored as
// overrides only — spice/config.js); `familyParams` merges the two.
//
//   74LS    SN74LS00, SDLS025D (§6.5 electrical characteristics, §6.9
//           switching characteristics)
//   CD4000  CD4001B, SCHS015C (static and dynamic electrical characteristics,
//           25 °C, VDD = 5 V unless a column says otherwise)
//
// A family-less part (memory, the CPUs, the 65xx peripherals, the 555) has
// no row: it reads its inputs at the 74LS thresholds (they are
// TTL-compatible inputs), loads a net as the MOS inputs they are
// (`inputLoadUa`), and switches in one pass (`delayNs` → the quantum).

import { familyOf } from "../../catalog/families.js";

/**
 * The defaults. Units are in the key: ns, mA, µA (`Ua`), volts (`V`).
 * CMOS voltages are stated AT VDD = 5 V and scale with the supply
 * (`inputThresholds`); CMOS delay is stated at 5 V and follows the sheet's
 * 5 / 10 / 15 V points (`delayNs`).
 */
export const FAMILY_DEFAULTS = Object.freeze({
  "74LS": Object.freeze({
    // SDLS025D §6.9: tPLH 9 ns typ, tPHL 10 ns typ — the slower edge.
    delayNs: 10,
    // §6.5, SN74LS00: IOH −0.4 mA (VOH test current), IOL 8 mA.
    sourceMa: 0.4,
    sinkMa: 8,
    // §6.5: IIH 20 µA max (VI = 2.7 V), IIL −0.4 mA max (VI = 0.4 V).
    inputHighUa: 20,
    inputLowUa: 400,
    // §6.5: ICCH 0.8 mA typ, ICCL 2.4 mA typ — per PACKAGE; their mean, for a
    // package whose gates sit half HIGH and half LOW.
    supplyMa: 1.6,
    // §6.3 recommended operating conditions: VIL 0.8 V max, VIH 2 V min.
    vilV: 0.8,
    vihV: 2,
    // §6.9 switching characteristics are timed into CL = 15 pF (RL = 2 kΩ):
    // the load an output charges each time it switches (spice/engine.js's
    // supply spike, CL·V over the gate's delay).
    loadPf: 15,
  }),
  CD4000: Object.freeze({
    // SCHS015C dynamic characteristics: tPHL, tPLH 125 ns typ at VDD 5 V
    // (60 at 10 V, 45 at 15 V — CMOS_DELAY_POINTS).
    delayNs: 125,
    // Static characteristics, VDD 5 V: IOH −1 mA typ (VO 4.6 V), IOL 1 mA typ
    // (VO 0.4 V).
    sourceMa: 1,
    sinkMa: 1,
    // IIN ±10⁻⁵ µA typ (±0.1 µA max) — no load anyone could measure.
    inputHighUa: 0.00001,
    inputLowUa: 0.00001,
    // IDD 0.01 µA typ quiescent, per package.
    supplyMa: 0.00001,
    // VIL 1.5 V max, VIH 3.5 V min at VDD 5 V (3 / 7 at 10 V, 4 / 11 at 15 V).
    vilV: 1.5,
    vihV: 3.5,
    // Dynamic characteristics are timed into CL = 50 pF.
    loadPf: 50,
  }),
});

/** SCHS015C's typical propagation delay against supply, [volts, ns]: the
    curve a CD4000 delay is scaled along (Jason, 2026-10-07: "scale by
    supply"). The user's `delayNs` is the 5 V point; the others keep their
    ratio to it. */
export const CMOS_DELAY_POINTS = Object.freeze([
  Object.freeze([5, 125]),
  Object.freeze([10, 60]),
  Object.freeze([15, 45]),
]);

/**
 * Forward voltage of a lit junction, volts — what an LED or diode takes out of
 * a supply (spice/supply.js). Typical figures for a 5 mm through-hole LED at
 * ~10–20 mA by colour (red GaAsP/AlGaInP ~1.8–2.0 V, yellow ~2.0 V, green
 * GaP ~2.1 V, blue and white InGaN ~3.0–3.2 V — the low end of each), and the
 * usual 0.7 V of a silicon diode such as the 1N4148.
 */
export const FORWARD_VOLTS = Object.freeze({
  red: 1.8,
  yellow: 2,
  green: 2.1,
  blue: 3,
  white: 3,
  diode: 0.7,
});

/** The family whose numbers a family-less part borrows for its inputs. */
const FALLBACK_FAMILY = "74LS";

/**
 * A family's numbers: its defaults with the user's overrides on top.
 * @param {ReturnType<import('./config.js').normalizeSpiceConfig>} config
 * @param {string} family
 */
export function familyParams(config, family) {
  const base = FAMILY_DEFAULTS[family];
  if (!base) return null;
  const own = config?.families?.[family];
  return own ? { ...base, ...own } : base;
}

/** Linear interpolation along [x, y] points, extrapolated from the end
    segments (a 3 V CMOS part is slower than at 5 V, by the 5–10 V slope). */
function along(points, x) {
  let i = 1;
  while (i < points.length - 1 && x > points[i][0]) i++;
  const [x0, y0] = points[i - 1];
  const [x1, y1] = points[i];
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * A part's numbers: its family's, or — for a part with no family (memory,
 * the CPUs, the 555) — the 74LS ones, as it is read and loaded like TTL.
 * @param {object} config - normalized
 * @param {object} def
 */
export function partParams(config, def) {
  return (
    familyParams(config, familyOf(def)) ?? familyParams(config, FALLBACK_FAMILY)
  );
}

/**
 * A part's propagation delay, ns — or null for a part with no family (it
 * switches in one pass). A CD4000 part's follows its supply.
 * @param {object} config - normalized
 * @param {object} def
 * @param {number|null} volts - the supply the part runs from
 */
export function delayNs(config, def, volts) {
  const family = familyOf(def);
  const p = familyParams(config, family);
  if (!p || !(p.delayNs > 0)) return null;
  if (family !== "CD4000" || !(volts > 0)) return p.delayNs;
  const ratio = along(CMOS_DELAY_POINTS, volts) / CMOS_DELAY_POINTS[0][1];
  return Math.max(p.delayNs * ratio, Number.EPSILON);
}

/**
 * The voltages a part's input switches at: `{vil, vih, up, down}`. An analog
 * node is read as having crossed when it rises through `up` or falls through
 * `down`, and a crossing re-arms only by crossing back the other way.
 *
 *   An ordinary input has ONE trigger point, the midpoint of its VIL/VIH band
 *   (`up === down` — features/spice-light.md §4, Q2).
 *   A SCHMITT input (`def.schmitt: {upV, downV}`, its sheet's VT+ / VT−) has
 *   two, and the gap between them is the whole point of the part: an RC
 *   relaxation oscillator built round one (the 74LS14's, the CD40106B's)
 *   swings its capacitor between them. With one trigger point it would turn
 *   straight back on the very next pass and read as an oscillation.
 *
 * A CD4000 part's voltages scale with its supply (the sheets' are at 5 V, and
 * the 10 / 15 V columns are in proportion); a 74LS or family-less part's are
 * absolute. The thresholds are the PART's, never a user setting: they are
 * what the part is.
 * @param {object} config - normalized
 * @param {object} def
 * @param {number|null} volts
 */
export function inputThresholds(config, def, volts) {
  const family = familyOf(def);
  const p = partParams(config, def);
  const scale = family === "CD4000" && volts > 0 ? volts / 5 : 1;
  const vil = p.vilV * scale;
  const vih = p.vihV * scale;
  if (def?.schmitt) {
    return {
      vil,
      vih,
      up: def.schmitt.upV * scale,
      down: def.schmitt.downV * scale,
    };
  }
  const trigger = (vil + vih) / 2;
  return { vil, vih, up: trigger, down: trigger };
}

/** What a family-less part's input draws, µA either way. Those parts are
    MOS (the memories, the CPUs, the 65xx peripherals: inputs of microamps of
    leakage, ±1–10 µA on their sheets) — loading them as 74LS inputs had a
    CD4000 output brown out driving three. The 555's are of the same order,
    bar RESET held LOW. */
export const MOS_INPUT_UA = 10;

/**
 * What one input pin of a part draws from the net holding it, µA: its
 * family's I_IH (HIGH) or I_IL (LOW), or a family-less part's MOS leakage.
 * @param {object} config - normalized
 * @param {object} def
 * @param {boolean} high
 */
export function inputLoadUa(config, def, high) {
  const p = familyParams(config, familyOf(def));
  if (!p) return MOS_INPUT_UA;
  return high ? p.inputHighUa : p.inputLowUa;
}

/**
 * What one output pin may source (HIGH) and sink (LOW), mA — the fan-out
 * budget (spice/loads.js). A part whose output stage is not its family's
 * representative gate states its own (`def.drive: {sinkMa?, sourceMa?,
 * pins?: {n: {sinkMa?, sourceMa?}}}`, cited at the def — the bus drivers'
 * 24 mA, the CD4049UB/CD4050B buffers' 3.3 mA, the '595's weaker QH′), and
 * anything it does not state is its family's (or, family-less, 74LS's).
 * @param {object} config - normalized
 * @param {object} def
 * @param {number} pin
 * @returns {{sourceMa: number, sinkMa: number}}
 */
export function outputDrive(config, def, pin) {
  const family = partParams(config, def);
  const own = def?.drive ?? null;
  const at = own?.pins?.[pin] ?? null;
  return {
    sourceMa: at?.sourceMa ?? own?.sourceMa ?? family.sourceMa,
    sinkMa: at?.sinkMa ?? own?.sinkMa ?? family.sinkMa,
  };
}
