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

// spice/transistor-figures.js — a transistor grade as the FIGURES a datasheet
// states, and a CUSTOM grade built from them (features/component-value-entry-
// spec.md §5, "Preset list + Custom…"). Pure and DOM-free.
//
// The grades (spice/transistors.js, named by catalog/discretes.js
// `TRANSISTOR_GRADES`) stay exactly as they are: a grade is still one
// representative part's model. What is new is a way to state a grade in the
// handful of numbers a person reads off a sheet — and to start from one and
// change them:
//
//   BJT     hFE · VBE(on) · VCEO · IC max
//   MOSFET  VGS(th) · RDS(on) at VGS 10 V · V(BR)DSS · ID max
//
// A grade's figures are MEASURED off its own model (`gradeFigures`), at three
// significant figures — so what the Custom fields open with is what the model
// does, never a second, hand-kept table that could disagree with it. A custom
// grade (`customModel`) is its BASE grade's model (the one it was started
// from, `custom.from`) with each figure put back exactly:
//
//   · hFE      — the base current scaled down (BF up, ISE down; a
//                Darlington's two transistors by its square root each),
//                solved so the measured gain is the figure;
//   · VBE(on)  — the saturation currents IS/ISE scaled (both transistors of
//                a Darlington), solved likewise; the two are solved
//                together, since each moves the other a little;
//   · VCEO, V(BR)DSS, VGS(th) — the model's own number;
//   · IC/ID max — the warning current, the smoke current keeping the base
//                grade's ratio to it;
//   · RDS(on)  — RD and 1/KP scaled together, so the on-resistance at
//                VGS 10 V is the figure and the square law keeps its shape.
//
// Every figure is a MAGNITUDE: the models are NPN- and N-channel-normalized,
// so a PNP's or a P-channel's figures are the same numbers.
//
// What is NOT a field, and why: VCE(sat). In the Gummel–Poon model it falls
// out of the reverse transistor (BR), the collector resistance and the base
// drive together — no one knob is it.
//
// A BJT's figures are measured at a fixed TEST POINT: VCE 5 V and a tenth of
// its BASE grade's rated current — fixed by the base, so changing IC max
// never moves what hFE and VBE(on) mean.

import {
  BJT_GRADES,
  MOSFET_GRADES,
  bjt,
  bjtCurrents,
  darlington,
  solveRising,
  transistorModel,
} from "./transistors.js";
import { VT_V } from "./junction-table.js";

/** The VCE a BJT's gain and turn-on are stated at, volts. */
export const TEST_VCE = 5;

/** The VGS a MOSFET's on-resistance is stated at, volts. */
export const RDS_ON_VGS = 10;

/**
 * Each kind's figures: the key a document stores, the unit the ONE value
 * parser reads it in (model/component-value.js), and its inclusive range.
 * Their labels are the catalog's (catalog/discretes.js `gradeField`).
 */
export const FIGURE_FIELDS = Object.freeze({
  bjt: Object.freeze([
    Object.freeze({ key: "hfe", unit: "ratio", range: Object.freeze({ min: 10, max: 100000 }) }), // prettier-ignore
    Object.freeze({ key: "vbeOn", unit: "volt", range: Object.freeze({ min: 0.3, max: 2.5 }) }), // prettier-ignore
    Object.freeze({ key: "vceo", unit: "volt", range: Object.freeze({ min: 5, max: 1000 }) }), // prettier-ignore
    Object.freeze({ key: "icMax", unit: "amp", range: Object.freeze({ min: 0.001, max: 100 }) }), // prettier-ignore
  ]),
  mosfet: Object.freeze([
    Object.freeze({ key: "vth", unit: "volt", range: Object.freeze({ min: 0.3, max: 8 }) }), // prettier-ignore
    Object.freeze({ key: "rdsOn", unit: "ohm", range: Object.freeze({ min: 0.001, max: 1000 }) }), // prettier-ignore
    Object.freeze({ key: "vdsMax", unit: "volt", range: Object.freeze({ min: 5, max: 1000 }) }), // prettier-ignore
    Object.freeze({ key: "idMax", unit: "amp", range: Object.freeze({ min: 0.001, max: 500 }) }), // prettier-ignore
  ]),
});

/** Which figure set a transistor type takes. */
export const figureKind = (type) =>
  type === "npn" || type === "pnp"
    ? "bjt"
    : type === "nmos" || type === "pmos"
      ? "mosfet"
      : null;

/** A figure as the fields show it: three significant figures. */
const three = (x) => Number(x.toPrecision(3));

/** A BJT's test current, amps: a tenth of its rated current. */
const testAmps = (m) => m.limits.warnMa / 10 / 1000;

/** The VBE that carries `amps` of collector current at TEST_VCE. */
function vbeAt(m, amps) {
  return solveRising((v) => bjtCurrents(m, v, TEST_VCE).ic - amps, 0, 3);
}

/** A BJT's gain and turn-on at its test point, unrounded. */
function bjtPoint(m, amps) {
  const vbe = vbeAt(m, amps);
  const { ib, ic } = bjtCurrents(m, vbe, TEST_VCE);
  return { vbe, hfe: ic / ib };
}

/** A MOSFET's on-resistance at RDS_ON_VGS with VDS → 0, Ω. */
const rdsOnOf = (m) => (m.rdOhm ?? 0) + 1 / (m.kpA * (RDS_ON_VGS - m.vtoV));

const figureCache = new Map();

/**
 * A grade's figures, measured off its model (see the note at the top) and
 * held to three significant figures — what the Custom fields open with, and
 * what a custom set must equal to BE that grade.
 * @param {string} type - npn, pnp, nmos or pmos
 * @param {string} grade
 * @returns {Readonly<Record<string, number>>|null}
 */
export function gradeFigures(type, grade) {
  const key = `${type}:${grade}`;
  if (figureCache.has(key)) return figureCache.get(key);
  const m = (BJT_GRADES[type] ?? MOSFET_GRADES[type])?.[grade];
  let out = null;
  if (m && m.kind === "mosfet") {
    out = Object.freeze({
      vth: three(m.vtoV),
      rdsOn: three(rdsOnOf(m)),
      vdsMax: three(m.vbrV),
      idMax: three(m.limits.warnMa / 1000),
    });
  } else if (m) {
    const { vbe, hfe } = bjtPoint(m, testAmps(m));
    out = Object.freeze({
      hfe: three(hfe),
      vbeOn: three(vbe),
      vceo: three(m.vceoV),
      icMax: three(m.limits.warnMa / 1000),
    });
  }
  figureCache.set(key, out);
  return out;
}

/**
 * Whether a set of figures is a grade's own — every figure equal to its
 * three-figure value (what the fields show and store).
 */
export function isGradeFigures(type, grade, figures) {
  const own = gradeFigures(type, grade);
  if (!own || !figures) return false;
  return Object.keys(own).every((k) => figures[k] === own[k]);
}

/** A model's figures less its built tables: what a builder takes. */
function specOf(m) {
  const { kind: _kind, be: _be, bc: _bc, ...spec } = m;
  return spec;
}

/** The base's limits with a new warning current, the smoke ratio kept. */
const scaledLimits = (limits, amps) => ({
  ...limits,
  warnMa: amps * 1000,
  smokeMa: amps * 1000 * (limits.smokeMa / limits.warnMa),
});

/**
 * A BJT (or Darlington) with its gain scaled by `k` and its saturation
 * current by `s`. The gain is BOTH base-current terms scaled down together —
 * BF up by k and the recombination current ISE down by it — so the base
 * current at a given junction voltage falls by exactly k and the gain rises
 * by it, wherever the recombination term dominates (a 2N2907A's does). ISE
 * rides IS's scale too, so the turn-on moves the whole junction.
 */
function scaledBjt(base, k, s, rest) {
  const q = (spec, gain) => ({
    ...specOf(spec),
    bf: spec.bf * gain,
    isA: spec.isA * s,
    ...(spec.iseA ? { iseA: (spec.iseA * s) / gain } : {}),
  });
  if (base.kind === "darlington") {
    const g = Math.sqrt(k);
    return darlington({ ...base, ...rest, q1: q(base.q1, g), q2: q(base.q2, g) }); // prettier-ignore
  }
  return bjt({ ...q(base, k), ...rest });
}

/** How far a custom figure may sit from what its model measures: ten parts
    in a million of a gain, ten microvolts of a turn-on. */
const GAIN_TOL = 1e-5;
const VBE_TOL = 1e-5;

/** The furthest a custom gain is scaled from its base's, either way (ln) —
    a Darlington's shunt resistors cap what any gain can give it, and past a
    thousandth its model stops meaning anything. Past it the model stays at
    the nearest it reaches. */
const MAX_LN_GAIN = Math.log(1e3);

/** The furthest its saturation current is scaled, either way (ln): over
    2.5 V of turn-on per junction, past any figure the field takes. */
const MAX_LN_IS = 100;

const clamp = (x, m) => Math.max(-m, Math.min(m, x));

/**
 * A custom BJT: its base grade's model with hFE and VBE(on) put back. Each
 * is stepped along its own law in log space, in turn, until both stand: ln
 * hFE rises one for one with ln k (a Darlington's shunts bend that, so it
 * takes more rounds), and the junction's turn-on falls by Vt (2·Vt across a
 * Darlington's two) per e-fold of s. Each moves the other a little — the
 * base resistance's drop, the recombination term — which the next round
 * takes up. A figure the part cannot reach (a turn-on under what its base
 * resistance alone drops) is given as near as the bounds allow.
 */
function customBjt(base, f) {
  const amps = testAmps(base);
  const rest = {
    vceoV: f.vceo,
    limits: scaledLimits(base.limits, f.icMax),
    part: null,
  };
  const junctions = base.kind === "darlington" ? 2 : 1;
  const at = (lk, ls) =>
    bjtPoint(scaledBjt(base, Math.exp(lk), Math.exp(ls), rest), amps);
  let lk = 0;
  let ls = 0;
  // The nearest stand yet — what is kept when the figures cannot both be
  // reached and the steps wander off into a part that means nothing.
  let best = { lk, ls, off: Infinity };
  for (let round = 0; round < 80; round++) {
    const p = at(lk, ls);
    const gainOff = Math.log(f.hfe / p.hfe);
    if (!Number.isFinite(gainOff) || !Number.isFinite(p.vbe)) break;
    const off = Math.abs(gainOff) + Math.abs(p.vbe - f.vbeOn) / VT_V;
    if (off < best.off) best = { lk, ls, off };
    const nlk = clamp(lk + gainOff, MAX_LN_GAIN);
    const q = nlk === lk ? p : at(nlk, ls);
    if (!Number.isFinite(q.vbe)) break;
    const vbeOff = q.vbe - f.vbeOn;
    const nls = clamp(ls + vbeOff / (junctions * VT_V), MAX_LN_IS);
    const settled =
      Math.abs(gainOff) <= GAIN_TOL && Math.abs(vbeOff) <= VBE_TOL;
    const stuck = nlk === lk && nls === ls;
    lk = nlk;
    ls = nls;
    if (settled || stuck) break;
  }
  const p = at(lk, ls);
  const off = Math.abs(Math.log(f.hfe / p.hfe)) + Math.abs(p.vbe - f.vbeOn) / VT_V; // prettier-ignore
  if (!(off <= best.off)) ({ lk, ls } = best);
  return scaledBjt(base, Math.exp(lk), Math.exp(ls), rest);
}

/** A custom MOSFET: its base grade's model with each figure put back. */
function customMosfet(base, f) {
  const r0 = (base.rdOhm ?? 0) + 1 / (base.kpA * (RDS_ON_VGS - f.vth));
  const scale = f.rdsOn / r0;
  return Object.freeze({
    ...base,
    part: null,
    vtoV: f.vth,
    rdOhm: (base.rdOhm ?? 0) * scale,
    kpA: base.kpA / scale,
    vbrV: f.vdsMax,
    limits: scaledLimits(base.limits, f.idMax),
  });
}

const modelCache = new Map();

/**
 * The model a CUSTOM grade simulates with: `custom.from`'s, its figures put
 * back exactly (see the note at the top). Cached by figures, so a running
 * circuit builds it once. A set that is its base grade's own figures is that
 * grade's model itself; one that will not read (no base, a figure missing)
 * is null.
 * @param {string} type - npn, pnp, nmos or pmos
 * @param {{from: string} & Record<string, number>} custom
 */
export function customModel(type, custom) {
  const base = (BJT_GRADES[type] ?? MOSFET_GRADES[type])?.[custom?.from];
  const kind = figureKind(type);
  if (!base || !kind) return null;
  const keys = FIGURE_FIELDS[kind].map((f) => f.key);
  if (!keys.every((k) => Number.isFinite(custom[k]) && custom[k] > 0)) {
    return null;
  }
  if (isGradeFigures(type, custom.from, custom)) return base;
  const key = `${type}:${custom.from}:${keys.map((k) => custom[k]).join(",")}`;
  if (modelCache.has(key)) return modelCache.get(key);
  const figures = Object.fromEntries(keys.map((k) => [k, custom[k]]));
  const model =
    kind === "mosfet" ? customMosfet(base, figures) : customBjt(base, figures);
  // A desk edited all evening could otherwise keep every set it tried.
  if (modelCache.size > 256) modelCache.clear();
  modelCache.set(key, model);
  return model;
}

/**
 * The model a transistor simulates with: its custom grade's, when it has
 * one, else its grade's (spice/transistors.js `transistorModel`). The ONE
 * read — the voltage solve and the ngspice deck both take it.
 * @param {string} type
 * @param {string} grade - catalog/discretes.js `transistorGrade`'s answer
 * @param {object|null} [custom] - catalog/discretes.js `transistorCustom`'s
 */
export function transistorModelFor(type, grade, custom = null) {
  return (custom && customModel(type, custom)) || transistorModel(type, grade);
}

/**
 * The figures a model MEASURES — what `gradeFigures` reads off a grade, for
 * any model (a custom one included), unrounded. For the tests, which hold a
 * custom model to the figures it was built from.
 * @param {object} m
 * @param {object} [base] - the grade it was built from (a BJT's test point)
 */
export function measuredFigures(m, base = m) {
  if (m.kind === "mosfet") {
    return {
      vth: m.vtoV,
      rdsOn: rdsOnOf(m),
      vdsMax: m.vbrV,
      idMax: m.limits.warnMa / 1000,
    };
  }
  const { vbe, hfe } = bjtPoint(m, testAmps(base));
  return { hfe, vbeOn: vbe, vceo: m.vceoV, icMax: m.limits.warnMa / 1000 };
}
