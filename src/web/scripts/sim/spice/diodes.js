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
// ONE COMMON SILICON JUNCTION per GRADE of diode (Jason, 2026-10-07: a
// common, reasonable value set per family, never one maker's or one part's
// figures; 2026-10-19: a range to pick from, a common diode the default —
// `DIODE_GRADE_SPECS`). The default, and every diode before grades, is the
// small-signal one below.
// Its curve is the small-signal diode's own (features/done/spice-lite-3-plan.md,
// Phase 4): the 1N4148's vendor SPICE card (ON Semiconductor / Fairchild —
// Is 2.682 nA, n 1.836, Rs 0.5664 Ω, and its high-injection knee IKF
// 44.17 mA), solved as spice/junction-table.js's piecewise-linear table:
// 0.50 V at 0.1 mA, 0.62 V at 1 mA, 0.75 V at 10 mA, 0.87 V at 50 mA. A
// ZENER conducts the same way forward and, backwards, past its Zener voltage
// (the part's own `zenerVolts` — a value the user sets, not a maker's
// figure) behind its dynamic impedance; a Zener whose voltage is not set has
// no breakdown to model and is a plain diode.
//
// A BRIDGE RECTIFIER's four diodes are the one other junction (BRIDGE_SPEC,
// below): a 1 A rectifier die is not a small-signal diode — at half an amp
// the 1N4148's curve is 0.2 V high and its heat burns it — so a bridge is its
// own kind, with one common set of its own: the rectifier grade's die on a
// SIMPLER table, since a bridge crosses every corner of it twice a
// half-cycle (`BRIDGE_FIT`).
//
// HEAT follows leds.js's rule: the junction sits at Ta + RthJA · |V·I|, and
// past its maximum temperature the diode is DESTROYED (open from then on) —
// one wired straight across the rails, or an output into ground. 150 °C and
// 300 °C/W (a small glass or epoxy body on a breadboard) put the burn at
// about a third of an amp forward.

import { AMBIENT_C } from "./leds.js";
import {
  fittedJunctionTable,
  junctionTable,
  tableCurrent,
  tableSlope,
  tableVolts,
} from "./junction-table.js";

/** The common junction's curve, the 1N4148 card's. Units are in the key:
    amps (`A`), Ω. */
const CURVE = Object.freeze({ isA: 2.682e-9, n: 1.836, rsOhm: 0.5664, ikfA: 0.04417 }); // prettier-ignore

/** The common junction. Units are in the key: volts (`V`), Ω, °C, °C/W.
    `kneeV` is the diode DROP other models quote a diode by (the CD4047B's
    idle pull-up, sim/monostable.js) — not this junction's curve. */
const SMALL_TABLE = junctionTable(CURVE);

/** The 1N4148's surge ratings (Vishay and Diodes Inc. agree; onsemi gives
    4 A at 1 µs): its non-repetitive peak forward current for a 1 µs pulse
    and for 1 s, amps. */
const SURGE_1US_A = 2;
const SURGE_1S_A = 1;

/**
 * The small-signal junction's heat, from its two surge ratings (the regrade,
 * 2026-10-22: an instant burn past a third of an amp took a 1N4148 in front
 * of a reservoir capacitor on a millisecond's charge its sheet allows). Two
 * stages to the air: the die's own, far faster than any tick (`rthFast`,
 * read at the instant: 2 A, 1 µs, takes it to Tj max), and the package's,
 * lagged (`heatTauS`: 1 A for 1 s takes it there) — the rest of its 300 °C/W
 * between them. DERIVED, flagged: the sheets give the two points, no curve.
 */
function smallSignalHeat(tjMaxC, rthJA) {
  const watts = (a) => a * tableVolts(SMALL_TABLE, a);
  const rise = tjMaxC - AMBIENT_C;
  const rthFast = rise / watts(SURGE_1US_A);
  const slow = rthJA - rthFast;
  const share = (rise - watts(SURGE_1S_A) * rthFast) / (watts(SURGE_1S_A) * slow); // prettier-ignore
  return { rthFast, heatTauS: -1 / Math.log(1 - share) };
}

export const DIODE_SPEC = Object.freeze({
  kind: "diode",
  ...CURVE,
  table: SMALL_TABLE,
  kneeV: 0.6,
  // Reverse breakdown's dynamic impedance, for a Zener.
  rzOhm: 5,
  tjMaxC: 150,
  rthJA: 300,
  ...smallSignalHeat(150, 300),
});

/** A 1 A glass-passivated rectifier die's curve — the 1N4007's vendor SPICE
    card (Is 7.028 nA, n 1.808, Rs 0.0342 Ω): 0.86 V at half an amp, under
    the DB10x bridge sheet's 1.0 V maximum there. The rectifier diode grade's,
    and the die a bridge rectifier holds. */
const RECTIFIER_CURVE = Object.freeze({ isA: 7.02767e-9, n: 1.80803, rsOhm: 0.0341512 }); // prettier-ignore

/** How closely a BRIDGE's simpler curve follows the die's (`fittedTable`):
    within 10 mV either side from 100 µA up — six pieces where the plain
    rectifier's table has 22. Every piece is a corner the solve stops at, and
    a bridge crosses each of them twice a half-cycle in each conducting diode;
    10 mV on a diode drop is under 0.15 % of a rectified 12 V~. Below 100 µA
    (a bridge into a megohm) it reads up to ~0.1 V high. */
const BRIDGE_FIT = Object.freeze({ tolV: 0.02, fromA: 1e-4 });

/** The surge a DB-1 bridge survives, amps: its non-repetitive peak forward
    current (MCC DB101–DB107, 8.3 ms half sine). */
export const BRIDGE_SURGE_A = 30;

/**
 * A rectifier junction whose HEAT is its surge rating (the burn is instant —
 * no thermal mass is modelled — and judged against a package's real
 * resistance to the air, a DB105's 40 °C/W, it would burn on the first
 * charging pulse into any reservoir capacitor, which the real part shrugs
 * off; what an instant CAN break is a surge past its rating): its maximum
 * junction temperature reached carrying `surgeA`.
 * @param {{isA: number, n: number, rsOhm: number, ikfA?: number}} curve
 * @param {number} surgeA - its non-repetitive peak forward current, amps
 * @param {number} tjMaxC
 * @param {string} device - the "device" deck's card (DEVICE_MODELS)
 * @param {{v: Float64Array, i: Float64Array}} [table] - its table, when not
 *   the curve's full one
 */
function surgeRated(
  curve,
  surgeA,
  tjMaxC,
  device,
  table = junctionTable(curve),
) {
  // prettier-ignore
  return Object.freeze({
    kind: "diode",
    ...curve,
    table,
    kneeV: 0.6,
    rzOhm: 5,
    tjMaxC,
    rthJA: (tjMaxC - AMBIENT_C) / (surgeA * tableVolts(table, surgeA)),
    device,
  });
}

/** The 1 A rectifier diode grade's junction (the 1N4001–1N4007). */
const RECTIFIER_SPEC = surgeRated(RECTIFIER_CURVE, BRIDGE_SURGE_A, 150, "D1N4007"); // prettier-ignore

/**
 * A BRIDGE RECTIFIER's junction: the rectifier die's curve, but SIMPLER
 * (`BRIDGE_FIT`) — one set for every bridge, whatever its part number (the
 * common-values rule: DB101–DB107 differ only in the reverse voltage, which
 * no plain diode here breaks down at). Its heat is its surge rating's, as
 * the rectifier's, on its own table.
 */
export const BRIDGE_SPEC = surgeRated(RECTIFIER_CURVE, BRIDGE_SURGE_A, 150, "D1N4007", fittedJunctionTable(RECTIFIER_CURVE, BRIDGE_FIT)); // prettier-ignore

/**
 * A discrete MOSFET's BODY DIODE (spice/network.js `bodyAmps`), where its
 * grade states none of its own (`MOSFET_BODIES`, below): the 1 A rectifier
 * die's curve on the bridge's simpler table (a body diode is a power
 * junction: a 2N7000's sheet gives 0.88 V at 115 mA, an IRF540N's 1.3 V max
 * at 16 A). It was a hard 0.6 V knee behind 2 Ω: a net only a body diode
 * held read exactly 0.600 V where ngspice reads near 0, and amps of flyback
 * came out volts off (the grade, 2026-10-23). Never judged for burning.
 */
export const BODY_SPEC = BRIDGE_SPEC;

/** A body diode's junction off its part's card, on the bridge's simpler
    table (its corners are every switching edge's). */
const bodySpec = (curve, device) =>
  Object.freeze({ kind: "diode", ...curve, table: fittedJunctionTable(curve, BRIDGE_FIT), device }); // prettier-ignore

/**
 * Each N-MOSFET grade's body diode, its representative part's own (phase 7,
 * 2026-10-27 — one for every grade, the rectifier's, read 60–120 mV off
 * their cards): the source–drain diode of each vendor card, DC only —
 * IRF540N and IRLZ44N Infineon's (`D1 3 1 MD`), 2N7000 the Zetex card's
 * DIODE1. Keyed by the grade's part (spice/transistors.js MOSFET_GRADES
 * `body`). The P-channel grades publish no card, so each is FITTED (least
 * squares, Is · n · Rs, wave 2b 2026-10-27) to its sheet's typical
 * source–drain diode curve at 25 °C:
 *   BS250     Vishay Siliconix TP0610L/T, VP0610L/T, BS250 (document 70209,
 *             S-41260 Rev. H), "Source-Drain Diode Forward Voltage", 1 mA
 *             to 0.92 A — within 5 mV of it; 1.03 V at 0.5 A (its table:
 *             1.1 V typ, 1.4 V max). The figure's axis reads in mA though
 *             labelled A — the table's −0.5 A is its 500. (The Philips and
 *             Diodes Inc. BS250 sheets give no diode figures.)
 *   IRF9540N  International Rectifier PD-91437B, Fig. 7 "Typical
 *             Source-Drain Diode Forward Voltage", TJ = 25 °C, 0.14–73 A —
 *             within 13 mV of it; 0.90 V at 11 A (its table: 1.6 V max).
 */
export const MOSFET_BODIES = Object.freeze({
  "2N7000": bodySpec({ isA: 1.254e-13, n: 1.0207, rsOhm: 0.222 }, "DB2N7000"),
  IRLZ44N: bodySpec({ isA: 4.4574e-9, n: 1.40246, rsOhm: 0.007275 }, "DBIRLZ44N"), // prettier-ignore
  IRF540N: bodySpec({ isA: 1.565e-11, n: 1.1328, rsOhm: 0.006486 }, "DBIRF540N"), // prettier-ignore
  BS250: bodySpec({ isA: 1.179e-11, n: 1.3554, rsOhm: 0.34111 }, "DBBS250"),
  IRF9540N: bodySpec({ isA: 7.032e-11, n: 1.2198, rsOhm: 0.0080822 }, "DBIRF9540N"), // prettier-ignore
});

/** A 3 A power rectifier's curve (the 1N5400–1N5408): fitted, least
    squares, to Vishay's 1N5400 sheet (doc. 88516) Fig. 3 at 0.1–80 A — Is,
    n held to a silicon junction's 1.5–2, Rs and the high-injection knee
    IKF — within 22 mV of it: 0.73 V at 0.4 A, 0.89 V at its rated 3 A (the
    sheet's maximum 1.2 V), 1.03 V at 10 A. Its surge, 200 A; Tj max 150 °C. */
const POWER_CURVE = Object.freeze({ isA: 2.24e-7, n: 1.86, rsOhm: 0.0055, ikfA: 0.794 }); // prettier-ignore

/** A 1 A Schottky's curve (the 1N5817–1N5819): fitted, least squares, to
    Vishay's 1N5817 sheet (doc. 88525) Fig. 3, 25 °C, at 10 mA–20 A — the
    series' one typical curve — within 25 mV of it: 0.26 V at 0.1 A, 0.39 V
    at its rated 1 A (the 1N5819's maximum 0.60 V), 0.82 V at 10 A. Its
    surge, 25 A; Tj max 125 °C. Its reverse leakage (milliamps hot) and its
    40 V breakdown are not modelled. */
const SCHOTTKY_CURVE = Object.freeze({ isA: 2.99e-4, n: 1.7, rsOhm: 0.0359 }); // prettier-ignore

/**
 * Each diode GRADE's junction (catalog/discretes.js `DIODE_GRADES`): the
 * small-signal one every diode was before there were grades, the 1 A
 * rectifier — the very die a bridge holds — the 3 A power rectifier and the
 * Schottky. Each its representative part's, one set per grade, as the
 * transistors' grades are.
 */
export const DIODE_GRADE_SPECS = Object.freeze({
  "small-signal": DIODE_SPEC,
  rectifier: RECTIFIER_SPEC,
  power: surgeRated(POWER_CURVE, 200, 150, "D1N5408"),
  schottky: surgeRated(SCHOTTKY_CURVE, 25, 125, "D1N5819"),
});

/**
 * The junction a diode or Zener is: its grade's (a Zener is small-signal),
 * with a Zener's own breakdown voltage when it has one — or a bridge
 * rectifier's.
 * @param {object|null} def - the part's catalog def (`def.diode.zener`,
 *   `def.rectifier`)
 * @param {object} [params] - its params (`zenerVolts`, `grade`)
 */
export function diodeSpec(def, params = {}) {
  if (def?.rectifier) return BRIDGE_SPEC;
  const vz = Number(params?.zenerVolts);
  if (def?.diode?.zener) return vz > 0 ? Object.freeze({ ...DIODE_SPEC, zenerV: vz }) : DIODE_SPEC; // prettier-ignore
  // (catalog/discretes.js `normalizeParams` keeps only a known grade.)
  return Object.hasOwn(DIODE_GRADE_SPECS, params?.grade) ? DIODE_GRADE_SPECS[params.grade] : DIODE_SPEC; // prettier-ignore
}

/** The current, amps, that `vd` volts (anode less cathode) pushes through —
    negative while a Zener conducts backwards. */
export function diodeCurrent(spec, vd) {
  if (vd > 0) return tableCurrent(spec.table, vd);
  if (spec.zenerV > 0 && -vd > spec.zenerV) return (vd + spec.zenerV) / spec.rzOhm; // prettier-ignore
  return 0;
}

/** ∂(diodeCurrent)/∂vd, siemens: what a Newton step reads. */
export function diodeSlope(spec, vd) {
  if (vd > 0) return tableSlope(spec.table, vd);
  if (spec.zenerV > 0 && -vd > spec.zenerV) return 1 / spec.rzOhm;
  return 0;
}

/**
 * Where a junction with a die stage of its own (`rthFast`) BURNS, its
 * package at `tjC`: the voltage across it (anode less cathode) at which its
 * die's rise this instant takes it to its maximum — `up` forward, and for a
 * Zener `down` backwards, through its breakdown — and the sample of its
 * table below `up` (`near`, its breakdown's knee for `down`): it cannot reach
 * either without first crossing that, a corner of its network (spice/
 * engine.js times the burn as a crossing from there). Null for a junction
 * with no die stage, or a package already at its maximum (the tick's own
 * verdict burns it).
 * @param {object} spec
 * @param {number} tjC - its package's temperature, °C
 */
export function burnVolts(spec, tjC) {
  if (!(spec.rthFast > 0)) return null;
  // (Asked each tick of every such diode, and nearly always at ambient.)
  let known = BURN_VOLTS.get(spec);
  if (!known) BURN_VOLTS.set(spec, (known = new Map()));
  if (known.has(tjC)) return known.get(tjC);
  if (known.size >= BURN_VOLTS_KEPT) known.clear();
  const out = burnVoltsOf(spec, tjC);
  known.set(tjC, out);
  return out;
}

/** `burnVolts`' answers, by spec and package temperature. */
const BURN_VOLTS = new WeakMap();
const BURN_VOLTS_KEPT = 64;

function burnVoltsOf(spec, tjC) {
  // (As `diodeVerdict` judges it: past this, it burns.)
  const watts = (spec.tjMaxC * (1 - 1e-9) - tjC) / spec.rthFast;
  if (!(watts > 0)) return null;
  const power = (vd) => vd * tableCurrent(spec.table, vd);
  let lo = 0;
  let hi = spec.table.v.at(-1);
  while (power(hi) < watts) hi *= 2;
  for (let k = 0; k < 200 && hi - lo > 1e-12; k++) {
    const mid = (lo + hi) / 2;
    if (power(mid) < watts) lo = mid;
    else hi = mid;
  }
  const v = spec.table.v;
  let near = v[0];
  for (const sample of v) if (sample <= hi) near = sample;
  const out = { up: hi, near };
  if (spec.zenerV > 0) {
    // Backwards past VZ: |vd| · (|vd| − VZ) / RZ watts.
    const x = (spec.zenerV + Math.sqrt(spec.zenerV ** 2 + 4 * watts * spec.rzOhm)) / 2; // prettier-ignore
    out.down = -x;
    out.nearDown = -spec.zenerV;
  }
  return Object.freeze(out);
}

/**
 * One diode carrying `amps` with `vd` across it: its junction temperature,
 * and whether that burns it. Shaped like leds.js's `ledVerdict` (a diode is
 * never lit, never overdriven, never warned for its reverse voltage) so the
 * one solve hands both back alike. A junction that burns by heat
 * (`heatTauS`) is judged at its package's lagged temperature `tj` (when the
 * caller has one, spice/engine.js) plus its die's rise this instant
 * (`rthFast`); else — and a surge-rated grade always — at the steady
 * temperature this instant.
 */
export function diodeVerdict(spec, amps, vd, tj = null) {
  const watts = Math.abs(vd * amps);
  const steady = AMBIENT_C + spec.rthJA * watts;
  const lagged = spec.heatTauS != null && tj != null;
  // Lagged, `tj` is the package's; the die's own stage is the instant's.
  const now = lagged ? tj + spec.rthFast * watts : steady;
  return {
    amps,
    volts: vd,
    tj: now,
    lit: false,
    level: 0,
    overdriven: false,
    // (A wake timed to the burn lands on it to the last few ulps.)
    burns: lagged ? now >= spec.tjMaxC * (1 - 1e-9) : steady > spec.tjMaxC,
    reverse: false,
    diode: true,
  };
}
