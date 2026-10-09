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

// spice/transistors.js — every discrete transistor as the GRADE of part it is
// (features/done/spice-lite-3-plan.md, Phase 4). Pure and DOM-free.
//
// A transistor's Properties card picks its grade under Spice Lite
// (catalog/discretes.js `TRANSISTOR_GRADES`; the default follows its
// package), and each grade is ONE representative part's whole figure set —
// never one per part number (Jason, 2026-10-07: a common set per kind):
//
//   NPN       small signal 2N3904 · general purpose 2N2222A · Darlington
//             TIP120 · power TIP31C
//   PNP       small signal 2N3906 · general purpose 2N2907A · Darlington
//             TIP125 · power TIP32C
//   N-MOSFET  logic level 2N7000 · logic-level power IRLZ44N · power IRF540N
//   P-MOSFET  logic level BS250 · power IRF9540N
//
// A BIPOLAR transistor is the DC half of the Gummel–Poon model SPICE uses
// (its vendor cards' own parameters where the maker publishes one — the
// small-signal and general-purpose parts — and a fit to the sheet's typical
// curves where not): the transport current Is·e^(VBE/Vt) through the
// high-injection knee IKF and the Early voltage VAF, a base current of
// If/BF plus the low-current recombination ISE·e^(VBE/(NE·Vt)), the reverse
// transistor (BR) that IS saturation, the base resistance RB, and the
// collector's own RC, solved for inside the device. Each junction is a
// piecewise-linear table of its exponential (spice/junction-table.js's way),
// so the device is piecewise linear in its terminals save for the Early
// effect's small product, and its pieces are its tables' segments. A
// DARLINGTON is the two transistors its sheet draws (a driver and an output
// one, ~8 kΩ and 120 Ω across their base–emitter junctions), solved for the
// node between them inside the device.
//
// A MOSFET is SPICE's level-1 (square-law) channel — threshold VTO,
// transconductance KP, series drain resistance RD — fitted to its sheet's
// typical transfer and on-resistance figures; its pieces are its region and
// its overdrive on a geometric grid (a square law is not a straight line,
// so it is re-linearized every 10 % of its overdrive).
//
// Every one carries its sheet's breakdown (VCEO, V(BR)DSS) and its current
// rating (`limits`); what its PACKAGE dissipates is the package's
// (spice/params.js TRANSISTOR_LIMITS).

import { VT_V } from "./junction-table.js";

/** A junction table's first and last current, amps, and the factor between
    samples — a bipolar transistor's span (a nanoamp to tens of amps). */
const FROM_A = 1e-9;
const TO_A = 64;
const RATIO = 2;

/** Above this transport current a transistor CONDUCTS (what a net it alone
    ties to something is held by), amps. */
export const CONDUCTS_A = 1e-6;

/** Behind its breakdown a part carries what is pushed through it, Ω. */
export const BREAKDOWN_OHMS = 1;

/** The overdrive grid a MOSFET's pieces step along: its first corner and the
    factor between them. */
const VOV_FROM = 0.02;
const VOV_STEP = Math.log(1.1);

/**
 * A bipolar transistor's base–emitter side as one table over its EXTERNAL
 * VBE (the base resistance's drop at the forward base current folded in):
 * at each sample the base current (`ib`), the transport current through the
 * high-injection knee (`tf`), 1/qbf (`qi`, for the reverse current) and the
 * INTERNAL junction voltage (`vi`). And its base–collector side: the
 * reverse current over the internal VBC.
 */
function bjtTables(m) {
  const be = { v: [], ib: [], tf: [], qi: [], vi: [] };
  const bc = { v: [], i: [] };
  for (let i = FROM_A; i <= TO_A * (1 + 1e-9); i *= RATIO) {
    const vi = VT_V * Math.log1p(i / m.isA);
    const ib = i / m.bf + (m.iseA ? m.iseA * Math.expm1(vi / (m.ne * VT_V)) : 0); // prettier-ignore
    const qbf = (1 + Math.sqrt(1 + (4 * i) / m.ikfA)) / 2;
    be.v.push(vi + (m.rbOhm ?? 0) * ib);
    be.ib.push(ib);
    be.tf.push(i / qbf);
    be.qi.push(1 / qbf);
    be.vi.push(vi);
    bc.v.push(vi);
    bc.i.push(i);
  }
  // Below the first sample each runs down to nothing along its first chord
  // (the transport current's, for the base–emitter side's every column).
  const zero = (v, y) => v[0] - (y[0] * (v[1] - v[0])) / (y[1] - y[0]);
  const v0 = zero(be.v, be.tf);
  be.v.unshift(v0);
  be.ib.unshift(0);
  be.tf.unshift(0);
  be.qi.unshift(1);
  be.vi.unshift(v0);
  bc.v.unshift(zero(bc.v, bc.i));
  bc.i.unshift(0);
  const f = (o) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, a]) => [k, Float64Array.from(a)]))); // prettier-ignore
  return { be: f(be), bc: f(bc) };
}

/** The segment `x` is on in a table's `v`: −1 below it, the last running on. */
function segment(v, x) {
  if (!(x > v[0])) return -1;
  let lo = 0;
  let hi = v.length - 1;
  if (x >= v[hi]) return hi - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (v[mid] <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Column `col` of a table at `x`, along its segment `k` (`segment`). */
function along(t, col, k, x) {
  if (k < 0) return t[col][0];
  const f = (x - t.v[k]) / (t.v[k + 1] - t.v[k]);
  return t[col][k] + f * (t[col][k + 1] - t[col][k]);
}

/** A bipolar transistor's figures (NPN-normalized), its tables built on.
    Exported for a Custom grade (spice/transistor-figures.js), which builds
    its part the way a grade's is built. */
export function bjt(spec) {
  return Object.freeze({ kind: "bjt", ...spec, ...bjtTables(spec) });
}

/** A Darlington's figures: its two transistors and the resistors its sheet
    draws across their base–emitter junctions. */
export function darlington(spec) {
  return Object.freeze({
    kind: "darlington",
    ...spec,
    q1: bjt(spec.q1),
    q2: bjt(spec.q2),
  });
}

/**
 * A bipolar transistor's base and collector currents, amps, at its terminal
 * VBE and an INTERNAL VCE (NPN-normalized: an NPN's own, a PNP's negated),
 * with the pieces they are on.
 */
function core(m, vbe, vce) {
  const kb = segment(m.be.v, vbe);
  const ib0 = kb < 0 ? 0 : along(m.be, "ib", kb, vbe);
  const tf = kb < 0 ? 0 : along(m.be, "tf", kb, vbe);
  const qi = along(m.be, "qi", kb, vbe);
  const vi = kb < 0 ? vbe : along(m.be, "vi", kb, vbe);
  const vbc = vi - vce;
  const kc = segment(m.bc.v, vbc);
  const ir = kc < 0 ? 0 : along(m.bc, "i", kc, vbc);
  const ic = (tf - ir * qi) * (1 - vbc / m.vafV) - ir / m.br;
  return { ib: ib0 + ir / m.br, ic, tf, kb, kc };
}

/** Solve f(x) = 0 for x in [lo, hi], f rising, to a few ulps: the bracket
    widened until it holds the root, then Brent's method — inverse quadratic
    interpolation and the secant where they make progress, a bisection
    where they do not. */
export function solveRising(f, lo, hi) {
  let flo = f(lo);
  let fhi = f(hi);
  for (let k = 0; k < 60 && flo > 0; k++) {
    const w = hi - lo;
    hi = lo;
    fhi = flo;
    lo -= 2 * w + 1;
    flo = f(lo);
  }
  for (let k = 0; k < 60 && fhi < 0; k++) {
    const w = hi - lo;
    lo = hi;
    flo = fhi;
    hi += 2 * w + 1;
    fhi = f(hi);
  }
  if (flo === 0) return lo;
  if (fhi === 0) return hi;
  // Brent (Numerical Recipes' zbrent): `b` the best estimate, `c` the far
  // end of the bracket, `a` the estimate before `b`.
  let a = lo;
  let fa = flo;
  let b = hi;
  let fb = fhi;
  let c = b;
  let fc = fb;
  let d = 0;
  let e = 0;
  for (let k = 0; k < 200; k++) {
    if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) {
      c = a;
      fc = fa;
      d = b - a;
      e = d;
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b;
      b = c;
      c = a;
      fa = fb;
      fb = fc;
      fc = fa;
    }
    // A few ulps: closer than that the function is its own rounding, and
    // not monotone any more.
    const tol = 8e-16 * Math.max(1, Math.abs(b));
    const xm = (c - b) / 2;
    if (Math.abs(xm) <= tol || fb === 0) return b;
    if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa;
      let p;
      let q;
      if (a === c) {
        p = 2 * xm * s;
        q = 1 - s;
      } else {
        const r = fb / fc;
        const t = fa / fc;
        p = s * (2 * xm * t * (t - r) - (b - a) * (r - 1));
        q = (t - 1) * (r - 1) * (s - 1);
      }
      if (p > 0) q = -q;
      p = Math.abs(p);
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol * q), Math.abs(e * q))) {
        e = d;
        d = p / q;
      } else {
        d = xm;
        e = d;
      }
    } else {
      d = xm;
      e = d;
    }
    a = b;
    fa = fb;
    b += Math.abs(d) > tol ? d : Math.sign(xm) * tol;
    fb = f(b);
  }
  return b;
}

/** A plain bipolar transistor at its terminal VBE and VCE: the collector
    resistance's drop solved for (the internal VCE where the current through
    it agrees). */
function bjtAt(m, vbe, vce) {
  if (!(m.rcOhm > 0)) return core(m, vbe, vce);
  const x = solveRising((y) => y + m.rcOhm * core(m, vbe, y).ic - vce, vce - 1, vce + 1); // prettier-ignore
  return core(m, vbe, x);
}

/** A Darlington at its terminal VBE and an internal VCE: the node between
    its transistors (the output one's base) solved for by its current law. */
function darlingtonCore(d, vbe, vce) {
  // Current INTO the middle node: the driver's emitter and R1, less the
  // output transistor's base and R2 — falling as the node rises.
  const into = (vx) => {
    const a = core(d.q1, vbe - vx, vce - vx);
    const b = core(d.q2, vx, vce);
    return a.ib + a.ic + (vbe - vx) / d.r1Ohm - b.ib - vx / d.r2Ohm;
  };
  const vx = solveRising((x) => -into(x), Math.min(0, vbe) - 1, Math.max(0, vbe) + 1); // prettier-ignore
  const a = core(d.q1, vbe - vx, vce - vx);
  const b = core(d.q2, vx, vce);
  return {
    ib: a.ib + (vbe - vx) / d.r1Ohm,
    ic: a.ic + b.ic,
    tf: b.tf,
    kb: a.kb,
    kc: a.kc,
    kb2: b.kb,
    kc2: b.kc,
  };
}

/** A Darlington at its terminal VBE and VCE (its collector resistance's
    drop solved for). */
function darlingtonAt(d, vbe, vce) {
  if (!(d.rcOhm > 0)) return darlingtonCore(d, vbe, vce);
  const x = solveRising((y) => y + d.rcOhm * darlingtonCore(d, vbe, y).ic - vce, vce - 1, vce + 1); // prettier-ignore
  return darlingtonCore(d, vbe, x);
}

/**
 * A bipolar transistor's base and collector currents INTO it, amps, at VBE
 * and VCE (NPN-normalized), with its avalanche past VCEO, and the pieces
 * they are on.
 * @param {object} m - a BJT grade (`BJT_GRADES`)
 */
export function bjtCurrents(m, vbe, vce) {
  let byVbe = MEMO.get(m);
  if (!byVbe) MEMO.set(m, (byVbe = new Map()));
  let byVce = byVbe.get(vbe);
  const known = byVce?.get(vce);
  if (known) return known;
  const r = m.kind === "darlington" ? darlingtonAt(m, vbe, vce) : bjtAt(m, vbe, vce); // prettier-ignore
  const over = vce > m.vceoV ? (vce - m.vceoV) / BREAKDOWN_OHMS : 0;
  const out = Object.freeze({ ib: r.ib, ic: r.ic + over, tf: r.tf, over, r });
  if (byVbe.size >= MEMO_SIZE) byVbe.clear();
  if (!byVce) byVbe.set(vbe, (byVce = new Map()));
  byVce.set(vce, out);
  return out;
}

/** Each model's last answers, by VBE and VCE: a solve asks the same point
    many times over — once for each terminal's current, again around each
    slope it reads — and a Darlington's answer is two nested solves, so a
    point answered once is answered from here. Pure, so any answer kept is
    the one it would compute again. */
const MEMO = new WeakMap();
const MEMO_SIZE = 512;

/** Which piece a bipolar transistor is on: its junctions' segments and
    whether it has broken down. */
export function bjtPiece(m, vbe, vce) {
  const { r, over } = bjtCurrents(m, vbe, vce);
  const ch = (k) => String.fromCharCode(97 + k + 1);
  let out = ch(r.kb) + ch(r.kc);
  if (r.kb2 != null) out += ch(r.kb2) + ch(r.kc2);
  return over > 0 ? `${out}v` : out;
}

/**
 * A MOSFET's channel current, amps, for its gate–source overdrive past its
 * threshold and |VDS| (an N-channel's own, a P-channel's negated; the source
 * the end that makes it so): SPICE's level-1 square law behind its series
 * drain resistance — in its linear region the internal VDS, x, where
 * I = KP(Vov·x − x²/2) = (VDS − x)/RD.
 * @param {object} m - a MOSFET grade
 * @param {number} vgs
 * @param {number} vds - ≥ 0
 */
export function mosfetCurrent(m, vgs, vds) {
  const vov = vgs - m.vtoV;
  if (!(vov > 0) || !(vds > 0)) return 0;
  const k = m.kpA;
  const r = m.rdOhm ?? 0;
  const sat = (k / 2) * vov * vov;
  if (vds >= vov + r * sat) return sat;
  const a = 1 + r * k * vov;
  // x = [a − √(a² − 2·R·K·VDS)] / (R·K), rationalized: exact as R → 0.
  const x = (2 * vds) / (a + Math.sqrt(Math.max(0, a * a - 2 * r * k * vds)));
  return k * (vov * x - (x * x) / 2);
}

/** Which piece a MOSFET's channel is on: off, or its region and its
    overdrive's step on the geometric grid. */
export function mosfetPiece(m, vgs, vds) {
  const vov = vgs - m.vtoV;
  if (!(vov > 0)) return "0";
  const step = vov <= VOV_FROM ? 0 : 1 + Math.floor(Math.log(vov / VOV_FROM) / VOV_STEP); // prettier-ignore
  const r = m.rdOhm ?? 0;
  const linear = Math.abs(vds) < vov + r * (m.kpA / 2) * vov * vov;
  // In its linear region the square law bends with VDS too: a corner every
  // tenth of the overdrive.
  const along = linear ? Math.min(9, Math.floor((10 * Math.abs(vds)) / vov)) : "s"; // prettier-ignore
  return `${step}${along}`;
}

/** Every bipolar grade, by type and grade (catalog/discretes.js
    `TRANSISTOR_GRADES` names them). Units are in the key: amps (`A`),
    volts (`V`), Ω, mA. */
export const BJT_GRADES = Object.freeze({
  npn: Object.freeze({
    // ON Semiconductor / Fairchild's 2N3904 card (Q2N3904). VCEO 40 V;
    // IC 200 mA.
    "small-signal": bjt({
      part: "2N3904",
      isA: 6.734e-15,
      bf: 416.4,
      ne: 1.259,
      iseA: 6.734e-15,
      ikfA: 0.06678,
      vafV: 74.03,
      br: 0.7371,
      rbOhm: 10,
      rcOhm: 1,
      vceoV: 40,
      limits: { warnMa: 200, smokeMa: 600 },
    }),
    // The 2N2222 card (Q2N2222). 2N2222A: VCEO 40 V; IC 600 mA.
    general: bjt({
      part: "2N2222A",
      isA: 14.34e-15,
      bf: 255.9,
      ne: 1.307,
      iseA: 14.34e-15,
      ikfA: 0.2847,
      vafV: 74.03,
      br: 6.092,
      rbOhm: 10,
      rcOhm: 1,
      vceoV: 40,
      limits: { warnMa: 600, smokeMa: 1800 },
    }),
    // TIP120 (ON Semiconductor TIP120/D): a driver and an output transistor,
    // ~8 kΩ and ~120 Ω across their base–emitter junctions (the sheet's
    // schematic), fitted to its typical figures at 25 °C — hFE ≈ 800 at
    // 0.1 A, ≈ 2200 at 0.5 A, ≈ 3000 at 1 A (VCE 4 V, Fig. 9), VBE(on)
    // ≈ 1.2 V at 0.1 A and 1.4 V at 1 A, VCE(sat) ≈ 0.72 V at 0.1 A and
    // 0.82 V at 1 A (IC/IB = 250, Fig. 11).
    // VCEO 60 V; IC 5 A.
    darlington: darlington({
      part: "TIP120",
      q1: { isA: 5e-13, bf: 90, ikfA: 1, vafV: 100, br: 1 },
      q2: { isA: 5e-12, bf: 70, ikfA: 8, vafV: 100, br: 1, rbOhm: 5 },
      r1Ohm: 8e3,
      r2Ohm: 120,
      rcOhm: 0.08,
      vceoV: 60,
      limits: { warnMa: 5000, smokeMa: 15000 },
    }),
    // TIP31C (ON Semiconductor TIP31A/D), fitted to its typical figures at
    // 25 °C: hFE ≈ 70 to 0.1 A, ≈ 45 at 1 A, ≈ 22 at 3 A (VCE 2 V, Fig. 8);
    // VBE 0.50 V at 3 mA, 0.63 V at 0.1 A (Fig. 10); VCE(sat) ≈ 0.1 V to
    // 0.3 A, 0.15 V at 1 A (IC/IB = 10). VCEO 100 V; IC 3 A.
    power: bjt({
      part: "TIP31C",
      isA: 1.2e-11,
      bf: 75,
      ikfA: 1.5,
      vafV: 100,
      br: 1,
      rbOhm: 4,
      rcOhm: 0.08,
      vceoV: 100,
      limits: { warnMa: 3000, smokeMa: 9000 },
    }),
  }),
  pnp: Object.freeze({
    // The 2N3906 card (Q2N3906). VCEO 40 V; IC 200 mA.
    "small-signal": bjt({
      part: "2N3906",
      isA: 1.41e-15,
      bf: 180.7,
      ne: 1.5,
      iseA: 0,
      ikfA: 0.08,
      vafV: 18.7,
      br: 4.977,
      rbOhm: 10,
      rcOhm: 2.5,
      vceoV: 40,
      limits: { warnMa: 200, smokeMa: 600 },
    }),
    // The 2N2907A card (Q2N2907A). VCEO 60 V; IC 600 mA.
    general: bjt({
      part: "2N2907A",
      isA: 650.6e-18,
      bf: 231.7,
      ne: 1.829,
      iseA: 54.81e-15,
      ikfA: 1.079,
      vafV: 115.7,
      br: 3.563,
      rbOhm: 10,
      rcOhm: 0.715,
      vceoV: 60,
      limits: { warnMa: 600, smokeMa: 1800 },
    }),
    // TIP125, the TIP120's complement: the same sheet, the same figures.
    darlington: darlington({
      part: "TIP125",
      q1: { isA: 5e-13, bf: 90, ikfA: 1, vafV: 100, br: 1 },
      q2: { isA: 5e-12, bf: 70, ikfA: 8, vafV: 100, br: 1, rbOhm: 5 },
      r1Ohm: 8e3,
      r2Ohm: 120,
      rcOhm: 0.08,
      vceoV: 60,
      limits: { warnMa: 5000, smokeMa: 15000 },
    }),
    // TIP32C, the TIP31C's complement on the same sheet.
    power: bjt({
      part: "TIP32C",
      isA: 1.2e-11,
      bf: 75,
      ikfA: 1.5,
      vafV: 100,
      br: 1,
      rbOhm: 4,
      rcOhm: 0.08,
      vceoV: 100,
      limits: { warnMa: 3000, smokeMa: 9000 },
    }),
  }),
});

/** Every MOSFET grade, by type and grade. KP in A/V². */
export const MOSFET_GRADES = Object.freeze({
  nmos: Object.freeze({
    // 2N7000: VGS(th) 2.1 V typ, ID 75 mA at VGS 4.5 V, RDS(on) 1.2 Ω typ at
    // 10 V (ON Semiconductor 2N7000/D) — a level-1 fit. V(BR)DSS 60 V;
    // ID 200 mA (500 mA pulsed).
    logic: Object.freeze({ kind: "mosfet", part: "2N7000", vtoV: 2.1, kpA: 0.38, rdOhm: 0.7, vbrV: 60, limits: { warnMa: 200, smokeMa: 500 } }), // prettier-ignore
    // IRLZ44N: RDS(on) 22 mΩ at VGS 10 V, 25 mΩ at 5 V; VGS(th) 1–2 V; its
    // transfer figure (Fig. 3) ~20 A at 3 V. V(BR)DSS 55 V; ID 47 A.
    "logic-power": Object.freeze({ kind: "mosfet", part: "IRLZ44N", vtoV: 1.5, kpA: 13, rdOhm: 0.005, vbrV: 55, limits: { warnMa: 47000, smokeMa: 160000 } }), // prettier-ignore
    // IRF540N: VGS(th) 2–4 V; its transfer figure (Fig. 3, VDS 50 V) ~12 A
    // at 4.5 V, ~55 A at 5.5 V; RDS(on) 44 mΩ max at 10 V. Barely on from a
    // 5 V output. V(BR)DSS 100 V; ID 33 A.
    power: Object.freeze({ kind: "mosfet", part: "IRF540N", vtoV: 3.63, kpA: 31, rdOhm: 0.03, vbrV: 100, limits: { warnMa: 33000, smokeMa: 110000 } }), // prettier-ignore
  }),
  pmos: Object.freeze({
    // BS250 (Philips): −VGS(th) 1–3.5 V; |Yfs| 125 mS at −200 mA; RDS(on)
    // 9 Ω typ at −10 V. −V(BR)DSS 45 V; −ID 250 mA (500 mA peak).
    logic: Object.freeze({ kind: "mosfet", part: "BS250", vtoV: 2.2, kpA: 0.039, rdOhm: 5.7, vbrV: 45, limits: { warnMa: 250, smokeMa: 500 } }), // prettier-ignore
    // IRF9540N: −VGS(th) 2–4 V; its transfer figure (Fig. 3, −VDS 25 V)
    // ~5 A at −5 V, ~20 A at −7 V; RDS(on) 117 mΩ max at −10 V.
    // −V(BR)DSS 100 V; −ID 23 A.
    power: Object.freeze({ kind: "mosfet", part: "IRF9540N", vtoV: 2.93, kpA: 2.33, rdOhm: 0.04, vbrV: 100, limits: { warnMa: 23000, smokeMa: 76000 } }), // prettier-ignore
  }),
});

/**
 * The figures a transistor simulates with: its type's grade (`grade`, from
 * catalog/discretes.js `transistorGrade`) — or the type's first when the
 * grade is unknown.
 * @param {string} type - npn, pnp, nmos or pmos
 * @param {string} grade
 */
export function transistorModel(type, grade) {
  const table = BJT_GRADES[type] ?? MOSFET_GRADES[type];
  if (!table) return null;
  return table[grade] ?? Object.values(table)[0];
}

/**
 * The transistors of a chip that is an ARRAY of them (a def's
 * `bipolarArray`), by name: each channel's NPN-normalized model, its base
 * behind the def's own resistor (catalog `internals`).
 *
 *   uln2003a  a ULN2003A channel (TI SLRS027R): a driver and an output
 *             transistor, 7.2 kΩ and 3 kΩ across their base–emitter
 *             junctions as its schematic draws them, fitted to its typical
 *             VCE(sat) — 0.9 V at 100 mA (IB 250 µA), 1.0 V at 200 mA
 *             (IB 350 µA), 1.2 V at 350 mA (IB 500 µA) — and its hFE of
 *             1000 or more. VCEO 50 V; 500 mA a channel.
 */
export const ARRAY_MODELS = Object.freeze({
  uln2003a: darlington({
    part: "ULN2003A",
    q1: { isA: 1e-14, bf: 120, ikfA: 0.1, vafV: 100, br: 1 },
    q2: { isA: 1e-13, bf: 100, ikfA: 1, vafV: 100, br: 1, rbOhm: 5 },
    r1Ohm: 7.2e3,
    r2Ohm: 3e3,
    rcOhm: 1.1,
    vceoV: 50,
    limits: { warnMa: 500, smokeMa: 1500 },
  }),
});
