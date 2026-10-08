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

// spice/params.js — the per-family electrical numbers Spice Lite simulates
// with, and the one place each is read (features/spice-lite.md §5, §10).
// Pure and DOM-free.
//
// Every DEFAULT is a TYPICAL value at 25 °C off one TI datasheet, cited beside
// it — never a per-part figure: a generic "74LS00" must simulate with no
// manufacturer or part chosen, so a family's numbers are its representative
// gate's. The user may override any of them (Settings ▸ Spice Lite, stored as
// overrides only — spice/config.js); `familyParams` merges the two.
//
//   74LS    SN74LS00, SDLS025D (§6.5 electrical characteristics, §6.9
//           switching characteristics)
//   CD4000  CD4001B, SCHS015C (static and dynamic electrical characteristics,
//           25 °C, VDD = 5 V unless a column says otherwise)
//
// A family-less part (memory, the CPUs, the 65xx peripherals, the LCD
// controller, the 555) has no row: it reads its inputs at the 74LS thresholds
// (they are TTL-compatible inputs), its inputs are MOS ones (they draw
// nothing, and a protection diode to each rail clamps them — `inputStages`),
// its outputs are the common MOS stage (spice/output-stage.js) and it
// switches in one pass (`delayNs` → the quantum).
//
// Every number in the table is one the engine RUNS on: the gate delay, the
// thresholds, the switching load and the supply current directly; the output
// source and sink currents as the strength of each family's output stage
// (`stageStrength` — the stage is built round them, and a user's own figure
// scales it); the input current as each input's own stage (a 74LS input's
// bias pushes out its IIL; a CMOS input leaks its IIN out below its
// switching point — `inputStages`).

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
    // §6.5, SN74LS00: IOH −0.4 mA (VOH test current), IOL 8 mA — the points
    // its output stage (spice/output-stage.js) is drawn through.
    sourceMa: 0.4,
    sinkMa: 8,
    // §6.5: IIL −0.4 mA max (VI = 0.4 V), the sheet's only figure. The
    // input's bias (`TTL_INPUT`) pushes out about half of it at 0.4 V,
    // typical. (Its IIH, 20 µA max at 2.7 V, is a diode's reverse leakage —
    // typically a small fraction of that, and nothing the solve draws: no
    // field.)
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
    // IIN ±10⁻⁵ µA typ (±0.1 µA max) — no load anyone could measure: under
    // `LEAK_FLOOR_UA`, so no stage (`inputStages`) unless a user sets one.
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
 * THE transistors: one common, reasonable set of figures for every BJT and
 * one for every MOSFET on the desk, whatever its type or part number (Jason,
 * 2026-10-07 — a "2N3904" and a "2N2222" are the same NPN here, as a generic
 * "74LS00" is every maker's; per-part settings may come later). The CD4007UB's
 * six channels are MOSFETs too, and take the MOSFET's. Each is a device of
 * the network solve (spice/network.js):
 *
 *   BJT     its base–emitter junction conducts past VBE 0.65 V (then rises
 *           `rbeOhm` per amp — the junction's slope, the common diode's 2 Ω),
 *           and its collector carries β (100) times the base current, as far
 *           as the circuit lets it: in SATURATION the collector sits at
 *           VCE(sat) 0.2 V behind `satOhm` 1 Ω (a numerical figure, the
 *           slope that keeps the solve well-posed), carrying only what the
 *           load allows. The middle of the small-signal parts' sheets
 *           (2N3904/2N3906, 2N2222).
 *   MOSFET  a 2 V gate threshold, measured from the SOURCE (for an
 *           N-channel part its lower-voltage channel end, for a P-channel its
 *           higher), its channel opening in a straight line from there to
 *           fully on (RDS(on) 1 Ω — between a 2N7000's few ohms and a power
 *           part's milliohms) `fullOnV` 2 V past it — so a 5 V gate drive
 *           turns a logic-level part fully on. Its gate draws nothing, and is
 *           a capacitance: driven, it follows at once; left floating, it keeps
 *           the voltage it was last driven to.
 */
export const BJT = Object.freeze({
  vbeV: 0.65,
  beta: 100,
  vceSatV: 0.2,
  rbeOhm: 2,
  satOhm: 1,
});
export const MOSFET = Object.freeze({ vthV: 2, rdsOnOhm: 1, fullOnV: 2 });

/**
 * A 74LS input as the circuit it is (spice/network.js's one-terminal
 * driver): while it is held LOW it pushes current OUT of the pin — from VCC
 * through its own input resistor and a Schottky diode — and lets go as the
 * pin rises past its threshold. One common figure for the family (Jason,
 * 2026-10-07): 1.3 V behind 4.5 kΩ, current out of the pin only. That is
 * 0.2 mA at VIL's 0.4 V test point (SN74LS00, SDLS025: IIL −0.4 mA max,
 * about half that typical) and nothing past 1.3 V, the gate's typical
 * switching point. So a pull-down of 1 kΩ holds the pin at 0.24 V (LOW),
 * 2 kΩ at 0.4 V, and 10 kΩ only at 0.9 V — inside the undefined band, which
 * is why a 74LS input is never pulled down through 10 kΩ on a real bench. A
 * CMOS or MOS input draws next to nothing, and has no such stage.
 *
 * The 4.5 kΩ is at the family's default IIL; a user's own IIL (Settings ▸
 * Spice Lite) scales the current, and so divides the resistance by its
 * ratio to the default (`inputStages`).
 */
export const TTL_INPUT = Object.freeze({ volts: 1.3, ohms: 4500 });

/**
 * A CMOS input's leakage: below its switching point (half its supply) it
 * pushes its family's `inputLowUa` OUT of the pin — a current that rises to
 * it over `LEAK_RAMP_V` (a stage of spice/network.js's shape: that
 * resistance, saturating at that current) and stays there. A figure under
 * `LEAK_FLOOR_UA` is no stage at all: the sheet's 10 pA typical moves
 * nothing a meter shows, and would cost a branch on every net — so it is a
 * stage only where a user sets one.
 */
export const LEAK_RAMP_V = 0.2;
export const LEAK_FLOOR_UA = 0.001;

/**
 * The current, mA, a CMOS input draws from its own supply while the voltage
 * on it sits in the undefined band between VIL and VIH (both transistors of
 * its input stage partly on). One common value for every CD4000 part
 * (Jason, 2026-10-07) — booked to the supply, never read as logic.
 */
export const CMOS_BAND_MA = 0.5;

/**
 * A CD4000 input's protection: a diode from the pin to each supply rail,
 * behind the input's own series resistance. Held past VDD + 0.5 V (or below
 * VSS − 0.5 V) the diode conducts and the pin draws current — the sheets'
 * "input voltage range, all inputs: −0.5 V to VDD + 0.5 V", and their DC
 * input current of ±10 mA, any one input, the most it survives. One common
 * figure for the series resistance, 200 Ω (an assumption: the B-series sheets
 * draw the network without a value). A level shifter's input
 * (`def.inputsAboveSupply` — the CD4049UB/CD4050B) has no diode to VDD,
 * which is what lets it take a higher voltage than its own supply.
 */
export const CMOS_CLAMP = Object.freeze({ overV: 0.5, ohms: 200, smokeMa: 10 });

/** A 74LS input's absolute maximum, volts (SDLS025: VI 7 V) — past it, the
    input's emitter breaks down. */
export const TTL_INPUT_MAX_V = 7;

/** A leakage stage: `ua` microamps out of the pin below `volts` — or
    nothing, under the floor. */
function leak(volts, ua) {
  if (!(ua >= LEAK_FLOOR_UA)) return null;
  const limit = ua / 1e6;
  return { volts, ohms: LEAK_RAMP_V / limit, limit, sources: true };
}

/**
 * An input's own stages on its net, as spice/network.js reads drivers. A
 * 74LS input's bias (`TTL_INPUT`, scaled by the IIL in force); a CD4000
 * input's two protection diodes (`CMOS_CLAMP`), which carry nothing while it
 * sits between its rails, and its leakage where it is set to anything
 * measurable; a family-less (MOS) part's two protection diodes alone — a
 * memory's, a CPU's — as the CMOS clamp (their sheets' absolute maximum is
 * the same −0.5 V to VCC + 0.5 V). Only a powered part has any.
 * @param {object} def
 * @param {number} vcc - its supply, volts
 * @param {object|null} [config] - normalized (the user's family figures);
 *   null reads the defaults
 */
export function inputStages(def, vcc, config = null) {
  const family = familyOf(def);
  if (family === "74LS") {
    const p = familyParams(config, family);
    const base = FAMILY_DEFAULTS["74LS"];
    return [
      {
        volts: TTL_INPUT.volts,
        ohms: TTL_INPUT.ohms * (base.inputLowUa / p.inputLowUa),
        limit: Number.POSITIVE_INFINITY,
        sources: true,
      },
    ];
  }
  const stages = [
    {
      volts: -CMOS_CLAMP.overV,
      ohms: CMOS_CLAMP.ohms,
      limit: Number.POSITIVE_INFINITY,
      sources: true,
      clamp: true,
    },
  ];
  if (!def.inputsAboveSupply) {
    stages.push({
      volts: vcc + CMOS_CLAMP.overV,
      ohms: CMOS_CLAMP.ohms,
      limit: Number.POSITIVE_INFINITY,
      sources: false,
      clamp: true,
    });
  }
  if (family === "CD4000") {
    const out = leak(vcc / 2, familyParams(config, family).inputLowUa);
    if (out) stages.push(out);
  }
  return stages;
}

/**
 * One input PIN's own stages: a timing part's silicon states some of its
 * pins' own (`logic.inputs` — a 555's THRES bias current, a 4047's RC COMMON
 * with no clamp to its rails; spice/silicon.js), and every other pin is its
 * family's (`inputStages`).
 * @param {object} def - the evaluated def
 * @param {number} vcc
 * @param {number} pin
 * @param {object|null} [config] - normalized
 */
export function pinInputStages(def, vcc, pin, config = null) {
  const own = def?.logic?.inputs?.[pin];
  return own ? own(vcc) : inputStages(def, vcc, config);
}

/**
 * How strong a part's output stage is against its family's default, on one
 * side: the user's source (HIGH) or sink (LOW) current over the default's —
 * 1 for a family at its defaults, and for a part in no family (its MOS stage
 * is no family's).
 * @param {object|null} config - normalized
 * @param {object} def
 * @param {"H"|"L"} level
 */
export function stageStrength(config, def, level) {
  const family = familyOf(def);
  const base = FAMILY_DEFAULTS[family];
  if (!base) return 1;
  const p = familyParams(config, family);
  return level === "H" ? p.sourceMa / base.sourceMa : p.sinkMa / base.sinkMa;
}

/**
 * What one OUTPUT PIN is held to: the silicon's own for that pin
 * (`logic.limits` — null where none applies), else its part's.
 * @param {object} def - the evaluated def
 * @param {number} pin
 */
export function pinOutputLimits(def, pin) {
  const own = def?.logic?.limits;
  if (own && pin in own) return own[pin];
  return outputLimits(def);
}

/**
 * A part's supply current, mA, at `vcc`: its silicon's own figure
 * (`logic.iccMa`, from its sheet), else its family's (a family-less part,
 * 74LS's).
 * @param {object} config - normalized
 * @param {object} def - the evaluated def
 * @param {number} vcc
 */
export function supplyMaOf(config, def, vcc) {
  const own = def?.logic?.iccMa;
  return typeof own === "function" ? own(vcc) : partParams(config, def).supplyMa; // prettier-ignore
}

/**
 * What one output may carry before Spice Lite warns, and past what it lets
 * out the brown smoke — one common pair per family (Jason, 2026-10-07):
 *
 *   74LS     by CURRENT: 20 mA warns — the least short-circuit current
 *            (IOS) the SN74LS00 sheet guarantees, so more than any load it
 *            is meant to drive — and 100 mA, its most, smokes.
 *   CD4000   by the POWER in the output transistor (its current times the
 *            voltage across it): 50 mW warns, and 100 mW — the B-series
 *            absolute maximum per output transistor — smokes.
 *
 * A family-less part takes the 74LS pair (its outputs are TTL-compatible).
 * A part with an output stage of its own is made to drive more, but not
 * past its family's absolute maximum: the CD4049UB/CD4050B buffers and the
 * CD4511B's segment drivers are B-series parts, and their sheets give them
 * the same 100 mW per output transistor (SCHS046L, SCHS053C). A timing
 * part's silicon states its pins' own (`pinOutputLimits` — the NE555's).
 * @param {object} def
 * @returns {{warnMa?: number, smokeMa?: number, warnMw?: number,
 *   smokeMw?: number}|null}
 */
export function outputLimits(def) {
  return OUTPUT_LIMITS[familyOf(def)] ?? OUTPUT_LIMITS["74LS"];
}

/**
 * What one ANALOG SWITCH channel may carry — the CD4066B and CD4051B–53B
 * alike, one common CMOS figure (Jason, 2026-10-07): their sheets' ±10 mA
 * switch current (SCHS051D, SCHS047H: absolute maximum ratings, "DC current
 * through any switch"). Past it, a warning; past 25 mA — two and a half
 * times it, a channel burning several times its rated power in its
 * on-resistance — brown smoke.
 */
export const SWITCH_LIMITS = Object.freeze({ warnMa: 10, smokeMa: 25 });

/**
 * What a discrete transistor may carry — ONE common figure set per kind
 * (Jason, 2026-10-07: a "2N3904" and a "2N2222" are the same NPN here), each
 * flagged as the common figure it is rather than any one part's:
 *
 *   BJT     a TO-92 small-signal part (2N3904/2N2222/2N3906): its collector
 *           current warns past 200 mA (the 2N3904's absolute maximum, the
 *           weaker of the two) and smokes past 600 mA (the 2N2222's, which
 *           no common TO-92 part survives); its dissipation — VCE·IC plus
 *           VBE·IB — warns past 312 mW and smokes past 625 mW (a TO-92's
 *           PD at 25 °C, both sheets).
 *   MOSFET  by its package, the one thing the desk says about it: a TO-92
 *           (2N7000/BS170) warns past 200 mW and smokes past 400 mW (the
 *           2N7000's PD); a TO-220 standing on a breadboard with no heatsink
 *           warns past 1 W and smokes past 2 W (a TO-220 in free air,
 *           RθJA ≈ 62 °C/W: about 2.4 W lifts its junction to 175 °C).
 */
export const TRANSISTOR_LIMITS = Object.freeze({
  bjt: Object.freeze({ warnMa: 200, smokeMa: 600, warnMw: 312, smokeMw: 625 }),
  "TO-92": Object.freeze({ warnMw: 200, smokeMw: 400 }),
  "TO-220": Object.freeze({ warnMw: 1000, smokeMw: 2000 }),
});

/** The pairs `outputLimits` hands out. */
export const OUTPUT_LIMITS = Object.freeze({
  "74LS": Object.freeze({ warnMa: 20, smokeMa: 100 }),
  CD4000: Object.freeze({ warnMw: 50, smokeMw: 100 }),
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
 * the CPUs, the 555) — the 74LS ones: its inputs are read at TTL levels, and
 * its supply current is booked at 74LS's.
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
 *   (`up === down` — features/spice-lite.md §4, Q2).
 *   A SCHMITT input (`def.schmitt: {upV, downV}`, its sheet's VT+ / VT−) has
 *   two, and the gap between them is the whole point of the part: an RC
 *   relaxation oscillator built round one (the 74LS14's, the CD40106B's)
 *   swings its capacitor between them. With one trigger point it would turn
 *   straight back on the very next pass and read as an oscillation.
 *
 * A CD4000 part's voltages scale with its supply (the sheets' are at 5 V, and
 * the 10 / 15 V columns are in proportion); a 74LS or family-less part's are
 * absolute. They are its family's (the user may set a family's own — Settings
 * ▸ Spice Lite); a Schmitt part's trip points are its own sheet's, which no
 * family figure moves.
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
