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

// spice/dynamics.js — several RC nodes coupled through their networks and
// their capacitors, solved EXACTLY on one linear piece
// (features/spice-lite-3-plan.md, Phase 2). Pure and DOM-free.
//
// One RC node is one exponential (spice/rc-curve.js). Two or more that see
// each other — a ladder, a high-pass, a capacitor alone between two gates —
// are one linear system: on a piece of the network (every stage, junction and
// device on its present segment) the currents into the nodes are an affine
// function of their voltages, i = i0 − Y·v (spice/voltages.js
// `linearizeNodes` reads Y off the solve, a node at a time), and the
// capacitors make that current a rate: C·v' = i0 − Y·v, C the nodes'
// capacitance matrix (a capacitor to a rail or a held net on its node's
// diagonal; one between two nodes off it, as a conductance would be).
//
// C may be SINGULAR: a capacitor alone between two nets has one charge, not
// two — its plates' common voltage is no state at all, but wherever the two
// networks balance the one current through it. So C is split by its own
// eigenvectors: the RANGE carries the charges (the states, x), the NULL space
// the plates' common modes, which are algebraic (z: Nᵀ(i0 − Y·v) = 0 — no
// current into a group of plates joined only by capacitors). Then
//
//   x' = A·x + b,    v = M·x + m.
//
// Where Y is symmetric (resistors, stages, junctions, switches — every
// two-terminal element is) A is similar to a symmetric matrix, its
// eigenvalues real: each node is then a sum of exponentials in CLOSED FORM
// (`modal`), as cheap to read at any time as one curve, the answer the same
// whenever it is read. A device (a transistor's gain) makes Y unsymmetric;
// those systems are read through the matrix exponential of the augmented
// [[A, b], [0, 0]] (Padé 13 with scaling and squaring, Higham 2005), exact
// all the same, and a little dearer.

/** A capacitance this small next to the largest is no capacitance (a
    numerical zero of C's eigen-decomposition). */
const NULL_REL = 1e-12;

/** Y counts as symmetric to this, relative to its largest entry. */
const SYMMETRIC_REL = 1e-9;

const zeros = (n) => new Float64Array(n);
const matrix = (rows, cols) => Array.from({ length: rows }, () => zeros(cols));

/** a·b, matrices as arrays of Float64Array rows. */
export function matMul(a, b) {
  const n = a.length;
  const k = b.length;
  const m = b[0]?.length ?? 0;
  const out = matrix(n, m);
  for (let i = 0; i < n; i++) {
    const row = out[i];
    const ai = a[i];
    for (let p = 0; p < k; p++) {
      const x = ai[p];
      if (x === 0) continue;
      const bp = b[p];
      for (let j = 0; j < m; j++) row[j] += x * bp[j];
    }
  }
  return out;
}

/** a·v. */
export function matVec(a, v) {
  const out = zeros(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) s += a[i][j] * v[j];
    out[i] = s;
  }
  return out;
}

/** aᵀ. */
export function transpose(a) {
  const n = a.length;
  const m = a[0]?.length ?? 0;
  const out = matrix(m, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out[j][i] = a[i][j];
  return out;
}

/** A⁻¹·B by Gaussian elimination with partial pivoting (B's columns at
    once) — null where A is singular. Neither is changed. */
export function solveMatrix(a, b) {
  const n = a.length;
  const m = b[0]?.length ?? 0;
  const lhs = a.map((row) => Float64Array.from(row));
  const rhs = b.map((row) => Float64Array.from(row));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(lhs[r][col]) > Math.abs(lhs[pivot][col])) pivot = r;
    }
    if (!(Math.abs(lhs[pivot][col]) > 0)) return null;
    if (pivot !== col) {
      [lhs[col], lhs[pivot]] = [lhs[pivot], lhs[col]];
      [rhs[col], rhs[pivot]] = [rhs[pivot], rhs[col]];
    }
    for (let r = col + 1; r < n; r++) {
      const f = lhs[r][col] / lhs[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) lhs[r][c] -= f * lhs[col][c];
      for (let c = 0; c < m; c++) rhs[r][c] -= f * rhs[col][c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    for (let c = 0; c < m; c++) {
      let s = rhs[r][c];
      for (let k = r + 1; k < n; k++) s -= lhs[r][k] * rhs[k][c];
      rhs[r][c] = s / lhs[r][r];
    }
  }
  return rhs;
}

/**
 * The eigen-decomposition of a symmetric matrix by Jacobi rotations:
 * `{values, vectors}`, `vectors[i][j]` the i-th component of the j-th
 * (orthonormal) eigenvector. Small, exact to rounding, never fails.
 * @param {Float64Array[]} s
 */
export function symmetricEigen(s) {
  const n = s.length;
  const a = s.map((row) => Float64Array.from(row));
  const v = matrix(n, n);
  for (let i = 0; i < n; i++) v[i][i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    let scale = 0;
    for (let i = 0; i < n; i++) {
      scale += a[i][i] * a[i][i];
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    }
    if (!(off > 1e-30 * (scale + off))) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (a[p][q] === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const sn = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - sn * akq;
          a[k][q] = sn * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - sn * aqk;
          a[q][k] = sn * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - sn * vkq;
          v[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  return { values: Float64Array.from(a.map((row, i) => row[i])), vectors: v };
}

/** The 1-norm of a matrix: its largest column sum. */
function norm1(a) {
  let best = 0;
  for (let j = 0; j < (a[0]?.length ?? 0); j++) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i][j]);
    best = Math.max(best, s);
  }
  return best;
}

/** Padé 13's coefficients (Higham 2005, Table 2.3). */
const PADE13 = [
  64764752532480000, 32382376266240000, 7771770303897600, 1187353796428800,
  129060195264000, 10559470521600, 670442572800, 33522128640, 1323241920,
  40840800, 960960, 16380, 182, 1,
];

/** Past this 1-norm Padé 13 needs the matrix scaled down first. */
const THETA13 = 5.371920351148152;

/**
 * e^A for a small square matrix: Padé 13 with scaling and squaring
 * (Higham 2005, "The scaling and squaring method for the matrix exponential
 * revisited").
 * @param {Float64Array[]} a
 * @returns {Float64Array[]}
 */
export function expm(a) {
  const n = a.length;
  const nrm = norm1(a);
  const s = nrm > THETA13 ? Math.max(0, Math.ceil(Math.log2(nrm / THETA13))) : 0; // prettier-ignore
  const scale = 2 ** -s;
  const as = a.map((row) => row.map((x) => x * scale));
  const id = matrix(n, n);
  for (let i = 0; i < n; i++) id[i][i] = 1;
  const a2 = matMul(as, as);
  const a4 = matMul(a2, a2);
  const a6 = matMul(a4, a2);
  const b = PADE13;
  const lin = (terms) => {
    const out = matrix(n, n);
    for (const [coef, m] of terms) {
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] += coef * m[i][j]; // prettier-ignore
    }
    return out;
  };
  const inner1 = lin([[b[13], a6], [b[11], a4], [b[9], a2]]); // prettier-ignore
  const u = matMul(as, lin([[1, matMul(a6, inner1)], [b[7], a6], [b[5], a4], [b[3], a2], [b[1], id]])); // prettier-ignore
  const inner2 = lin([[b[12], a6], [b[10], a4], [b[8], a2]]); // prettier-ignore
  const v = lin([[1, matMul(a6, inner2)], [b[6], a6], [b[4], a4], [b[2], a2], [b[0], id]]); // prettier-ignore
  const p = lin([[1, v], [1, u]]); // prettier-ignore
  const q = lin([[1, v], [-1, u]]); // prettier-ignore
  let r = solveMatrix(q, p);
  for (let k = 0; k < s; k++) r = matMul(r, r);
  return r;
}

/**
 * The free common modes of a capacitance matrix: one unit vector per group
 * of plates joined to nothing fixed by their capacitors (a capacitor alone
 * between two nets: its plates' common voltage) — C's null space.
 * @param {Float64Array[]} c
 * @returns {Float64Array[]}
 */
export function nullModes(c) {
  const { values, vectors } = symmetricEigen(c);
  const top = Math.max(...values.map(Math.abs), 0);
  const out = [];
  for (let j = 0; j < values.length; j++) {
    if (!(values[j] > NULL_REL * top)) {
      out.push(Float64Array.from(vectors, (row) => row[j]));
    }
  }
  return out;
}

/** e^x − 1 over x, and its limit 1 at 0: what a mode with no time constant
    (a capacitor fed by a current that does not change) ramps by. */
function phi(x) {
  return Math.abs(x) < 1e-8 ? 1 + x / 2 : Math.expm1(x) / x;
}

/**
 * The exact motion of `n` coupled RC nodes on one linear piece: from node
 * voltages `v0` (the plates' charges kept; a common mode re-balanced), with
 * capacitance matrix `c` and the network's i = i0 − Y·v. Returns
 * `{curves, scale}`: each node's curve (spice/rc-curve.js reads it — a
 * `modal` sum of exponentials, or a `system` read through e^A), and the
 * system's time scales (`fast`, `slow` seconds; slow Infinity where a mode
 * ramps or never settles), which a crossing search samples by.
 * @param {{c: Float64Array[], y: Float64Array[], i0: Float64Array,
 *   v0: Float64Array, t0: number}} sys
 */
export function rcSystem({ c, y, i0, v0, t0 }) {
  const n = v0.length;
  // C's range (the charges) and null space (the free common modes).
  const eig = symmetricEigen(c);
  const top = Math.max(...eig.values.map(Math.abs), 0);
  const range = [];
  const nulls = [];
  for (let j = 0; j < n; j++) {
    (eig.values[j] > NULL_REL * top ? range : nulls).push(j);
  }
  const col = (j) => Float64Array.from(eig.vectors, (row) => row[j]);
  const yr = transpose(range.map(col)); // n × r
  const nn = nulls.length ? transpose(nulls.map(col)) : null; // n × k
  const lam = range.map((j) => eig.values[j]);
  const r = range.length;

  // The common modes: z = S⁻¹·Nᵀ·(i0 − Y·Yr·x), S = Nᵀ·Y·N.
  // So v = M·x + m, and the current the charges see is P·(i0 − Y·Yr·x) with
  // P = I − Y·N·S⁻¹·Nᵀ.
  let m = zeros(n);
  let mx = yr.map((row) => Float64Array.from(row)); // M, n × r
  let p = null; // P, n × n (identity when there is no null space)
  if (nn) {
    const nt = transpose(nn);
    const sMat = matMul(nt, matMul(y, nn));
    const sInvNt = solveMatrix(sMat, nt); // k × n
    if (sInvNt) {
      const zFromI = matMul(nn, sInvNt); // n × n: N·S⁻¹·Nᵀ
      m = matVec(zFromI, i0);
      const yyr = matMul(y, yr);
      const corr = matMul(zFromI, yyr);
      mx = yr.map((row, i) => row.map((x, j) => x - corr[i][j]));
      const yz = matMul(y, zFromI);
      p = matrix(n, n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) p[i][j] = (i === j ? 1 : 0) - yz[i][j];
      }
    }
  }
  const pi0 = p ? matVec(p, i0) : Float64Array.from(i0);
  const py = p ? matMul(p, y) : y;
  // G = Yrᵀ·P·Y·Yr (r × r); A = −Λ⁻¹·G, b = Λ⁻¹·Yrᵀ·P·i0.
  const yrt = transpose(yr);
  const g = matMul(yrt, matMul(py, yr));
  const bb = matVec(yrt, pi0).map((x, i) => x / lam[i]);
  const x0 = matVec(yrt, v0);
  if (!r) {
    // No charge at all: every node where the network holds it.
    const v = Float64Array.from(m);
    return {
      curves: Array.from(v, (vk) => ({ t0, kind: "modal", base: vk, terms: [] })), // prettier-ignore
      scale: { fast: Number.POSITIVE_INFINITY, slow: 0 },
    };
  }
  let top2 = 0;
  for (const row of y) for (const x of row) top2 = Math.max(top2, Math.abs(x));
  let symmetric = true;
  for (let i = 0; i < n && symmetric; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(y[i][j] - y[j][i]) > SYMMETRIC_REL * top2) {
        symmetric = false;
        break;
      }
    }
  }
  if (symmetric) {
    // B = −Λ^(−½)·G·Λ^(−½) is symmetric: B = Q·diag(μ)·Qᵀ, and A's
    // eigenvectors are Λ^(−½)·Q.
    const sq = lam.map(Math.sqrt);
    const bs = matrix(r, r);
    for (let i = 0; i < r; i++) {
      for (let j = 0; j < r; j++) bs[i][j] = -g[i][j] / (sq[i] * sq[j]);
    }
    for (let i = 0; i < r; i++) {
      for (let j = i + 1; j < r; j++) {
        const avg = (bs[i][j] + bs[j][i]) / 2;
        bs[i][j] = avg;
        bs[j][i] = avg;
      }
    }
    const { values: mu, vectors: q } = symmetricEigen(bs);
    // Modal coordinates: y = Qᵀ·Λ^(½)·x, each y_j' = μ_j·y_j + c_j.
    const yj0 = zeros(r);
    const cj = zeros(r);
    for (let j = 0; j < r; j++) {
      let s0 = 0;
      let sc = 0;
      for (let i = 0; i < r; i++) {
        s0 += q[i][j] * sq[i] * x0[i];
        sc += q[i][j] * sq[i] * bb[i];
      }
      yj0[j] = s0;
      cj[j] = sc;
    }
    // v = m + M·Λ^(−½)·Q·y: each node a sum over the modes of
    // a·e^(μt) + r·t·φ(μt).
    const curves = [];
    for (let k = 0; k < n; k++) {
      const terms = [];
      for (let j = 0; j < r; j++) {
        let w = 0;
        for (let i = 0; i < r; i++) w += (mx[k][i] * q[i][j]) / sq[i];
        if (w === 0) continue;
        const a = w * yj0[j];
        const rr = w * cj[j];
        if (a !== 0 || rr !== 0) terms.push({ k: mu[j], a, r: rr });
      }
      curves.push({ t0, kind: "modal", base: m[k], terms });
    }
    let fast = 0;
    let slowRate = Number.POSITIVE_INFINITY;
    for (const x of mu) {
      fast = Math.max(fast, Math.abs(x));
      slowRate = Math.min(slowRate, x < 0 ? -x : 0);
    }
    return {
      curves,
      scale: {
        fast: fast > 0 ? 1 / fast : Number.POSITIVE_INFINITY,
        slow: slowRate > 0 ? 1 / slowRate : Number.POSITIVE_INFINITY,
      },
    };
  }
  // Unsymmetric: read through e^(A·h) of the augmented system.
  const a = g.map((row, i) => row.map((x) => -x / lam[i]));
  const sys = { a, b: bb, mx, m, x0, cache: null };
  const ainv = solveMatrix(a, a.map((_, i) => Float64Array.from({ length: r }, (_, j) => (i === j ? 1 : 0)))); // prettier-ignore
  const fastNorm = norm1(a);
  return {
    curves: Array.from({ length: n }, (_, k) => ({ t0, kind: "system", sys, idx: k })), // prettier-ignore
    scale: {
      fast: fastNorm > 0 ? 1 / fastNorm : Number.POSITIVE_INFINITY,
      slow: ainv ? norm1(ainv) : Number.POSITIVE_INFINITY,
    },
  };
}

/** A `system` curve's node voltages `dt` seconds after its anchor. */
function systemAt(sys, dt) {
  if (sys.cache && sys.cache.dt === dt) return sys.cache.v;
  const r = sys.x0.length;
  const aug = matrix(r + 1, r + 1);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < r; j++) aug[i][j] = sys.a[i][j] * dt;
    aug[i][r] = sys.b[i] * dt;
  }
  const e = expm(aug);
  const x = zeros(r);
  for (let i = 0; i < r; i++) {
    let s = e[i][r];
    for (let j = 0; j < r; j++) s += e[i][j] * sys.x0[j];
    x[i] = s;
  }
  const v = matVec(sys.mx, x).map((vk, k) => vk + sys.m[k]);
  sys.cache = { dt, v };
  return v;
}

/** A coupled node's voltage `dt` (≥ 0) seconds after its curve's anchor. */
export function coupledValue(curve, dt) {
  if (curve.kind === "system") return systemAt(curve.sys, dt)[curve.idx];
  let v = curve.base;
  for (const { k, a, r } of curve.terms) {
    const x = k * dt;
    v += a * Math.exp(x) + r * dt * phi(x);
  }
  return v;
}

/** A coupled node's rate of change `dt` seconds after its anchor, V/s. */
export function coupledSlope(curve, dt) {
  if (curve.kind === "system") {
    const h = Math.max(1e-12, Math.abs(dt) * 1e-6);
    return (coupledValue(curve, dt + h) - coupledValue(curve, dt)) / h;
  }
  let s = 0;
  for (const { k, a, r } of curve.terms) {
    const e = Math.exp(k * dt);
    s += a * k * e + r * e;
  }
  return s;
}

/** Where a coupled node settles, or null where it never does (a mode that
    ramps or grows). */
export function coupledFinal(curve) {
  if (curve.kind === "system") return null;
  let v = curve.base;
  for (const { k, a, r } of curve.terms) {
    if (!(k < 0)) {
      if (a !== 0 || r !== 0) return null;
      continue;
    }
    v += -r / k;
  }
  return v;
}
