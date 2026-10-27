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
// (features/done/spice-lite-3-plan.md, Phase 2). Pure and DOM-free.
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

/** |a| with b's sign (Numerical Recipes' SIGN). */
const sign = (a, b) => (b >= 0 ? Math.abs(a) : -Math.abs(a));

/**
 * The eigenvalues of a small real matrix: reduced to Hessenberg form by
 * elimination, then Francis's double-shift QR (Numerical Recipes, 2nd ed.,
 * `elmhes` and `hqr`, kept 1-based as they are written there). Returns
 * `{re, im}`, complex pairs adjacent — or null where it does not converge.
 * @param {Float64Array[]} m
 */
export function eigenvalues(m) {
  const n = m.length;
  // 1-based copy, as Numerical Recipes writes it (elmhes + hqr).
  const a = Array.from({ length: n + 1 }, () => new Float64Array(n + 1));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) a[i + 1][j + 1] = m[i][j];
  for (let mm = 2; mm < n; mm++) {
    let x = 0;
    let i = mm;
    for (let j = mm; j <= n; j++) {
      if (Math.abs(a[j][mm - 1]) > Math.abs(x)) {
        x = a[j][mm - 1];
        i = j;
      }
    }
    if (i !== mm) {
      for (let j = mm - 1; j <= n; j++)
        [a[i][j], a[mm][j]] = [a[mm][j], a[i][j]];
      for (let j = 1; j <= n; j++) [a[j][i], a[j][mm]] = [a[j][mm], a[j][i]];
    }
    if (x) {
      for (i = mm + 1; i <= n; i++) {
        let y = a[i][mm - 1];
        if (y !== 0) {
          y /= x;
          a[i][mm - 1] = y;
          for (let j = mm; j <= n; j++) a[i][j] -= y * a[mm][j];
          for (let j = 1; j <= n; j++) a[j][mm] += y * a[j][i];
        }
      }
    }
  }
  for (let i = 3; i <= n; i++) for (let j = 1; j <= i - 2; j++) a[i][j] = 0;
  const wr = new Float64Array(n + 1);
  const wi = new Float64Array(n + 1);
  let anorm = 0;
  for (let i = 1; i <= n; i++)
    for (let j = Math.max(i - 1, 1); j <= n; j++) anorm += Math.abs(a[i][j]);
  let nn = n;
  let t = 0;
  let p = 0,
    q = 0,
    r = 0,
    s,
    w,
    x,
    y,
    z,
    u,
    v,
    l,
    mmm;
  while (nn >= 1) {
    let its = 0;
    do {
      for (l = nn; l >= 2; l--) {
        s = Math.abs(a[l - 1][l - 1]) + Math.abs(a[l][l]);
        if (s === 0) s = anorm;
        if (Math.abs(a[l][l - 1]) + s === s) {
          a[l][l - 1] = 0;
          break;
        }
      }
      x = a[nn][nn];
      if (l === nn) {
        wr[nn] = x + t;
        wi[nn--] = 0;
      } else {
        y = a[nn - 1][nn - 1];
        w = a[nn][nn - 1] * a[nn - 1][nn];
        if (l === nn - 1) {
          p = 0.5 * (y - x);
          q = p * p + w;
          z = Math.sqrt(Math.abs(q));
          x += t;
          if (q >= 0) {
            z = p + sign(z, p);
            wr[nn - 1] = wr[nn] = x + z;
            if (z) wr[nn] = x - w / z;
            wi[nn - 1] = wi[nn] = 0;
          } else {
            wr[nn - 1] = wr[nn] = x + p;
            wi[nn - 1] = -(wi[nn] = z);
          }
          nn -= 2;
        } else {
          if (its === 60) return null;
          if (its === 10 || its === 20) {
            t += x;
            for (let i = 1; i <= nn; i++) a[i][i] -= x;
            s = Math.abs(a[nn][nn - 1]) + Math.abs(a[nn - 1][nn - 2]);
            y = x = 0.75 * s;
            w = -0.4375 * s * s;
          }
          ++its;
          for (mmm = nn - 2; mmm >= l; mmm--) {
            z = a[mmm][mmm];
            r = x - z;
            s = y - z;
            p = (r * s - w) / a[mmm + 1][mmm] + a[mmm][mmm + 1];
            q = a[mmm + 1][mmm + 1] - z - r - s;
            r = a[mmm + 2][mmm + 1];
            s = Math.abs(p) + Math.abs(q) + Math.abs(r);
            p /= s;
            q /= s;
            r /= s;
            if (mmm === l) break;
            u = Math.abs(a[mmm][mmm - 1]) * (Math.abs(q) + Math.abs(r));
            v =
              Math.abs(p) *
              (Math.abs(a[mmm - 1][mmm - 1]) +
                Math.abs(z) +
                Math.abs(a[mmm + 1][mmm + 1]));
            if (u + v === v) break;
          }
          for (let i = mmm + 2; i <= nn; i++) {
            a[i][i - 2] = 0;
            if (i !== mmm + 2) a[i][i - 3] = 0;
          }
          for (let k = mmm; k <= nn - 1; k++) {
            if (k !== mmm) {
              p = a[k][k - 1];
              q = a[k + 1][k - 1];
              r = 0;
              if (k !== nn - 1) r = a[k + 2][k - 1];
              if ((x = Math.abs(p) + Math.abs(q) + Math.abs(r)) !== 0) {
                p /= x;
                q /= x;
                r /= x;
              }
            }
            if ((s = sign(Math.sqrt(p * p + q * q + r * r), p)) !== 0) {
              if (k === mmm) {
                if (l !== mmm) a[k][k - 1] = -a[k][k - 1];
              } else a[k][k - 1] = -s * x;
              p += s;
              x = p / s;
              y = q / s;
              z = r / s;
              q /= p;
              r /= p;
              for (let j = k; j <= nn; j++) {
                p = a[k][j] + q * a[k + 1][j];
                if (k !== nn - 1) {
                  p += r * a[k + 2][j];
                  a[k + 2][j] -= p * z;
                }
                a[k + 1][j] -= p * y;
                a[k][j] -= p * x;
              }
              const mmin = nn < k + 3 ? nn : k + 3;
              for (let i = l; i <= mmin; i++) {
                p = x * a[i][k] + y * a[i][k + 1];
                if (k !== nn - 1) {
                  p += z * a[i][k + 2];
                  a[i][k + 2] -= p * r;
                }
                a[i][k + 1] -= p * q;
                a[i][k] -= p;
              }
            }
          }
        }
      }
    } while (l < nn - 1);
  }
  return { re: Array.from(wr.slice(1)), im: Array.from(wi.slice(1)) };
}

/** e^x − 1 over x, and its limit 1 at 0: what a mode with no time constant
    (a capacitor fed by a current that does not change) ramps by. */
function phi(x) {
  return Math.abs(x) < 1e-8 ? 1 + x / 2 : Math.expm1(x) / x;
}

/**
 * The exact motion of `n` coupled RC nodes on one linear piece: from node
 * voltages `v0` (the plates' charges kept; a common mode re-balanced), with
 * capacitance matrix `c` and the network's i = i0 − Y·v. Where the system
 * carries inductors too (spice/engine.js `runGroup`), `c` is blockdiag(C, L)
 * and its first `nc` rows the capacitances': only those can be a null mode,
 * judged against the largest capacitance — never against a henry. Returns
 * `{curves, scale}`: each node's curve (spice/rc-curve.js reads it — a
 * `modal` sum of exponentials, or a `system` read through e^A), and the
 * system's time scales (`fast`, `slow` seconds; slow Infinity where a mode
 * ramps or never settles), which a crossing search samples by — and `grow`,
 * the e-folding time of its fastest GROWING mode (Infinity where none grows:
 * a piece that linearizes a device to a negative slope can have one, and
 * read far along it a curve runs off to Infinity).
 * @param {{c: Float64Array[], y: Float64Array[], i0: Float64Array,
 *   v0: Float64Array, t0: number}} sys
 */
export function rcSystem({ c, y, i0, v0, t0, nc = v0.length }) {
  return rcPrepare({ c, y, i0, nc }).at(v0, t0);
}

/**
 * `rcSystem` in two halves: everything its closed form needs from the system
 * alone — C's range and null space, the modes and their eigenvectors — and,
 * per start (`at(v0, t0)`), the curves from there. A group whose networks
 * come back to pieces it was linearized on (spice/engine.js `runGroup`: a
 * rectifier's reservoir, every cycle) keeps its system and pays only for
 * the second half.
 * @param {{c: Float64Array[], y: Float64Array[], i0: Float64Array,
 *   nc?: number}} sys
 * @returns {{at: (v0: Float64Array, t0: number) => {curves: object[],
 *   scale: object}}}
 */
export function rcPrepare({ c, y, i0, nc = c.length }) {
  const n = c.length;
  // C's range (the charges) and null space (the free common modes). Each
  // eigenvector lies in the capacitances' rows or an inductor's (C and L are
  // separate blocks): an inductor's is a state whatever its size, and a
  // capacitance is null only beside the other capacitances.
  const eig = symmetricEigen(c);
  const isCoil = Array.from({ length: n }, (_, j) => {
    let w = 0;
    for (let i = nc; i < n; i++) w += eig.vectors[i][j] ** 2;
    return w > 0.5;
  });
  let top = 0;
  for (let j = 0; j < n; j++) if (!isCoil[j]) top = Math.max(top, Math.abs(eig.values[j])); // prettier-ignore
  const range = [];
  const nulls = [];
  for (let j = 0; j < n; j++) {
    (isCoil[j] || eig.values[j] > NULL_REL * top ? range : nulls).push(j);
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
  if (!r) {
    // No charge at all: every node where the network holds it.
    return {
      at: (v0, t0) => ({
        curves: Array.from(m, (vk) => ({ t0, kind: "modal", base: vk, terms: [] })), // prettier-ignore
        scale: { fast: Number.POSITIVE_INFINITY, slow: 0 },
      }),
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
    const cj = zeros(r);
    for (let j = 0; j < r; j++) {
      let sc = 0;
      for (let i = 0; i < r; i++) sc += q[i][j] * sq[i] * bb[i];
      cj[j] = sc;
    }
    // v = m + M·Λ^(−½)·Q·y: each node's weight on each mode.
    const w = Array.from({ length: n }, (_, k) => {
      const row = zeros(r);
      for (let j = 0; j < r; j++) {
        let x = 0;
        for (let i = 0; i < r; i++) x += (mx[k][i] * q[i][j]) / sq[i];
        row[j] = x;
      }
      return row;
    });
    let fast = 0;
    let slowRate = Number.POSITIVE_INFINITY;
    let growRate = 0;
    for (const x of mu) {
      fast = Math.max(fast, Math.abs(x));
      slowRate = Math.min(slowRate, x < 0 ? -x : 0);
      growRate = Math.max(growRate, x);
    }
    const scale = {
      fast: fast > 0 ? 1 / fast : Number.POSITIVE_INFINITY,
      slow: slowRate > 0 ? 1 / slowRate : Number.POSITIVE_INFINITY,
      grow: growRate > 0 ? 1 / growRate : Number.POSITIVE_INFINITY,
    };
    return {
      at(v0, t0) {
        // Modal coordinates: y = Qᵀ·Λ^(½)·x, each y_j' = μ_j·y_j + c_j.
        const x0 = matVec(yrt, v0);
        const yj0 = zeros(r);
        for (let j = 0; j < r; j++) {
          let s0 = 0;
          for (let i = 0; i < r; i++) s0 += q[i][j] * sq[i] * x0[i];
          yj0[j] = s0;
        }
        // Each node a sum over the modes of a·e^(μt) + r·t·φ(μt).
        const curves = [];
        for (let k = 0; k < n; k++) {
          const terms = [];
          for (let j = 0; j < r; j++) {
            const wk = w[k][j];
            if (wk === 0) continue;
            const a = wk * yj0[j];
            const rr = wk * cj[j];
            if (a !== 0 || rr !== 0) terms.push({ k: mu[j], a, r: rr });
          }
          curves.push({ t0, kind: "modal", base: m[k], terms });
        }
        return { curves, scale };
      },
    };
  }
  // Unsymmetric: over its complex modes where they can be trusted, else
  // through e^(A·h) of the augmented system.
  const a = g.map((row, i) => row.map((x) => -x / lam[i]));
  const modal = complexPrepare(a, bb, mx, m);
  if (modal) {
    return { at: (v0, t0) => modal.at(matVec(yrt, v0), t0) };
  }
  const ainv = solveMatrix(a, a.map((_, i) => Float64Array.from({ length: r }, (_, j) => (i === j ? 1 : 0)))); // prettier-ignore
  const fastNorm = norm1(a);
  const scale = {
    fast: fastNorm > 0 ? 1 / fastNorm : Number.POSITIVE_INFINITY,
    slow: ainv ? norm1(ainv) : Number.POSITIVE_INFINITY,
  };
  return {
    at(v0, t0) {
      const sys = { a, b: bb, mx, m, x0: matVec(yrt, v0), cache: null };
      return {
        curves: Array.from({ length: n }, (_, k) => ({ t0, kind: "system", sys, idx: k })), // prettier-ignore
        scale,
      };
    },
  };
}

// ── Complex arithmetic, as [re, im] pairs ───────────────────────────────
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cabs = (a) => Math.hypot(a[0], a[1]);

/** A null vector of the complex matrix A − λI (A real, rows of numbers;
    λ = `lr` + i·`li`), by
    elimination with complete pivoting: its last pivot is the zero. Worked in
    two flat arrays, real and imaginary — every operation the one the pairs'
    `cmul`/`cdiv`/`cabs` make, in their order, so the answer is the same to
    the bit; the pairs were most of what a corner of a coupled group
    allocated. */
function nullVector(a, lr, li) {
  // (A − λI, read straight off A: the shifted pairs are never built.)
  const n = a.length;
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      re[i * n + j] = a[i][j] - (i === j ? lr : 0);
      im[i * n + j] = i === j ? -li : 0;
    }
  }
  const swap = (arr, x, y) => {
    const t = arr[x];
    arr[x] = arr[y];
    arr[y] = t;
  };
  const cols = Array.from({ length: n }, (_, i) => i);
  for (let k = 0; k < n - 1; k++) {
    let best = -1;
    let pr = k;
    let pc = k;
    for (let i = k; i < n; i++) {
      for (let j = k; j < n; j++) {
        const v = Math.hypot(re[i * n + j], im[i * n + j]);
        if (v > best) {
          best = v;
          pr = i;
          pc = j;
        }
      }
    }
    if (pr !== k) {
      for (let j = 0; j < n; j++) {
        swap(re, k * n + j, pr * n + j);
        swap(im, k * n + j, pr * n + j);
      }
    }
    if (pc !== k) {
      for (let i = 0; i < n; i++) {
        swap(re, i * n + k, i * n + pc);
        swap(im, i * n + k, i * n + pc);
      }
    }
    swap(cols, k, pc);
    if (!(best > 0)) break;
    const br = re[k * n + k];
    const bi = im[k * n + k];
    const d = br * br + bi * bi;
    for (let i = k + 1; i < n; i++) {
      const ar = re[i * n + k];
      const ai = im[i * n + k];
      const fr = (ar * br + ai * bi) / d;
      const fi = (ai * br - ar * bi) / d;
      for (let j = k; j < n; j++) {
        const mr = re[k * n + j];
        const mi = im[k * n + j];
        re[i * n + j] = re[i * n + j] - (fr * mr - fi * mi);
        im[i * n + j] = im[i * n + j] - (fr * mi + fi * mr);
      }
    }
  }
  // The last unknown free (1); the rest by back-substitution.
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  xr[n - 1] = 1;
  for (let i = n - 2; i >= 0; i--) {
    let sr = 0;
    let si = 0;
    for (let j = i + 1; j < n; j++) {
      const mr = re[i * n + j];
      const mi = im[i * n + j];
      sr = sr + (mr * xr[j] - mi * xi[j]);
      si = si + (mr * xi[j] + mi * xr[j]);
    }
    const br = re[i * n + i];
    const bi = im[i * n + i];
    if (Math.hypot(br, bi) > 0) {
      const d = br * br + bi * bi;
      xr[i] = (-sr * br + -si * bi) / d;
      xi[i] = (-si * br - -sr * bi) / d;
    }
  }
  const out = Array.from({ length: n }, () => [0, 0]);
  for (let i = 0; i < n; i++) out[cols[i]] = [xr[i], xi[i]];
  let norm = 0;
  for (const z of out) norm = Math.max(norm, cabs(z));
  return norm > 0 ? out.map((z) => [z[0] / norm, z[1] / norm]) : null;
}

/** The inverse of a complex matrix (rows of [re, im]), or null. */
function invertComplex(a) {
  const n = a.length;
  const m = a.map((row, i) => [
    ...row.map((z) => [z[0], z[1]]),
    ...Array.from({ length: n }, (_, j) => [i === j ? 1 : 0, 0]),
  ]);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (cabs(m[i][k]) > cabs(m[p][k])) p = i;
    if (!(cabs(m[p][k]) > 0)) return null;
    [m[k], m[p]] = [m[p], m[k]];
    const piv = m[k][k];
    for (let j = 0; j < 2 * n; j++) m[k][j] = cdiv(m[k][j], piv);
    for (let i = 0; i < n; i++) {
      if (i === k) continue;
      const f = m[i][k];
      if (f[0] === 0 && f[1] === 0) continue;
      for (let j = 0; j < 2 * n; j++) {
        const t = cmul(f, m[k][j]);
        m[i][j] = [m[i][j][0] - t[0], m[i][j][1] - t[1]];
      }
    }
  }
  return m.map((row) => row.slice(n));
}

/** How ill-conditioned an eigenvector basis may be before its modes are
    distrusted and the system is read through e^A instead. */
const MODAL_COND = 1e9;

/**
 * x' = A·x + b, v = M·x + m in closed form over A's (complex) modes: each
 * node `base` plus Re Σ (a·e^(λt) + r·t·φ(λt)), from each start x0
 * (`at(x0, t0)`). Null where the modes cannot be trusted (no convergence, a
 * repeated eigenvalue's missing eigenvector).
 */
function complexPrepare(a, b, mx, m) {
  const r = a.length;
  const eig = eigenvalues(a);
  if (!eig) return null;
  const lam = eig.re.map((re, j) => [re, eig.im[j]]);
  const vecs = [];
  for (const l of lam) {
    const v = nullVector(a, l[0], l[1]);
    if (!v) return null;
    vecs.push(v);
  }
  const vm = Array.from({ length: r }, (_, i) => vecs.map((v) => v[i])); // r × r, columns the modes
  const vinv = invertComplex(vm);
  if (!vinv) return null;
  let nv = 0;
  let ni = 0;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < r; j++) {
      nv = Math.max(nv, cabs(vm[i][j]));
      ni = Math.max(ni, cabs(vinv[i][j]));
    }
  }
  if (!(nv * ni * r < MODAL_COND)) return null;
  const apply = (mat, x) =>
    mat.map((row) => row.reduce((s, z, j) => [s[0] + z[0] * x[j], s[1] + z[1] * x[j]], [0, 0])); // prettier-ignore
  const c = apply(vinv, b);
  const n = mx.length;
  // Each node's (complex) weight on each mode.
  const w = Array.from({ length: n }, (_, k) =>
    Array.from({ length: r }, (_, j) => {
      let x = [0, 0];
      for (let i = 0; i < r; i++) {
        x = [x[0] + mx[k][i] * vm[i][j][0], x[1] + mx[k][i] * vm[i][j][1]];
      }
      return x;
    }),
  );
  let fast = 0;
  let slowRate = Number.POSITIVE_INFINITY;
  let growRate = 0;
  let osc = 0;
  // Every oscillation, not only the fastest (`oscs`, rising): a driven 60 Hz
  // sine in a group with a 159 kHz LC was searched every eighth of the LC's
  // period for 2048 of them — 1.6 ms — and on the cubic grid's two points a
  // period after, a crest clearing a threshold by a hair went unseen.
  const oscs = [];
  for (const [re, im] of lam) {
    fast = Math.max(fast, Math.hypot(re, im));
    slowRate = Math.min(slowRate, re < 0 ? -re : 0);
    growRate = Math.max(growRate, re);
    osc = Math.max(osc, Math.abs(im));
    const w = Math.abs(im);
    if (w > 0 && !oscs.some((x) => Math.abs(x - w) <= 1e-9 * w)) oscs.push(w);
  }
  oscs.sort((x, y) => x - y);
  const scale = {
    fast: fast > 0 ? 1 / fast : Number.POSITIVE_INFINITY,
    slow: slowRate > 0 ? 1 / slowRate : Number.POSITIVE_INFINITY,
    grow: growRate > 0 ? 1 / growRate : Number.POSITIVE_INFINITY,
    osc,
    oscs,
  };
  return {
    at(x0, t0) {
      const y0 = apply(vinv, x0);
      const curves = [];
      for (let k = 0; k < n; k++) {
        const terms = [];
        for (let j = 0; j < r; j++) {
          const wk = w[k][j];
          const ac = cmul(wk, y0[j]);
          const rc = cmul(wk, c[j]);
          if (!ac[0] && !ac[1] && !rc[0] && !rc[1]) continue;
          terms.push({ k: lam[j][0], ki: lam[j][1], a: ac[0], ai: ac[1], r: rc[0], ri: rc[1] }); // prettier-ignore
        }
        curves.push({ t0, kind: "modal", base: m[k], terms });
      }
      return { curves, scale };
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
  for (const term of curve.terms) {
    if (term.ki) {
      v += complexTerm(term, dt);
      continue;
    }
    const x = term.k * dt;
    v += term.a * Math.exp(x) + term.r * dt * phi(x);
  }
  return v;
}

/**
 * Every curve of one system at `dt` (`coupledValue` each, into `out`), each
 * mode's exponential worked out once for all of them: a corner search reads
 * a group's every state at a hundred moments, and its states share their
 * modes — four states of five modes each worked twenty exponentials (and
 * a cosine and a sine for each ringing one) where five were enough. The
 * same arithmetic as `coupledValue`, term by term, so the same answer.
 * @param {object[]} curves
 * @param {number} dt
 * @param {Float64Array} out
 */
export function coupledValues(curves, dt, out) {
  const plan = modesOf(curves);
  const { k, ki, at } = plan;
  // Each mode's exponential (and a ringing one's cosine and sine), or its
  // φ, once for every curve.
  const e = plan.e;
  const c1 = plan.c1;
  const c2 = plan.c2;
  for (let m = 0; m < k.length; m++) {
    const x = k[m] * dt;
    e[m] = Math.exp(x);
    if (ki[m]) {
      c1[m] = Math.cos(ki[m] * dt);
      c2[m] = Math.sin(ki[m] * dt);
    } else c1[m] = phi(x);
  }
  for (let c = 0; c < curves.length; c++) {
    const curve = curves[c];
    if (curve.kind === "system") {
      out[c] = systemAt(curve.sys, dt)[curve.idx];
      continue;
    }
    let v = curve.base;
    const terms = curve.terms;
    const idx = at[c];
    for (let n = 0; n < terms.length; n++) {
      const term = terms[n];
      const m = idx[n];
      if (term.ki) {
        const km = k[m];
        const kim = ki[m];
        const er = e[m] * c1[m];
        const ei = e[m] * c2[m];
        const d = km * km + kim * kim;
        const pr = ((er - 1) * km + ei * kim) / d;
        v += term.a * er - term.ai * ei + (term.r * pr - term.ri * ((ei * km - (er - 1) * kim) / d)); // prettier-ignore
        continue;
      }
      v += term.a * e[m] + term.r * dt * c1[m];
    }
    out[c] = v;
  }
  return out;
}

/** The modes a set of curves share, kept per set (`coupledValues` reads one
    set a hundred times a corner): each term's mode, and scratch for each
    mode's exponential. */
const MODES = new WeakMap();
function modesOf(curves) {
  let plan = MODES.get(curves);
  if (plan) return plan;
  const k = [];
  const ki = [];
  const at = curves.map((curve) => {
    if (curve.kind === "system") return null;
    return curve.terms.map((term) => {
      const tk = term.k;
      const tki = term.ki ?? 0;
      for (let m = 0; m < k.length; m++) if (k[m] === tk && ki[m] === tki) return m; // prettier-ignore
      k.push(tk);
      ki.push(tki);
      return k.length - 1;
    });
  });
  const n = k.length;
  plan = { k, ki, at, e: new Float64Array(n), c1: new Float64Array(n), c2: new Float64Array(n) }; // prettier-ignore
  MODES.set(curves, plan);
  return plan;
}

/**
 * How fast each curve of one system moves, mode by mode: `{modes, rates,
 * decay}`, `modes[m]` = [k, ki] and `rates[c]` = [re, im] per mode, so that
 * curve `c`'s slope `dt` after its anchor is Re Σ (re + i·im)·e^((k + i·ki)·dt)
 * — the derivative of a·e^(λt) + r·t·φ(λt) is (a·λ + r)·e^(λt). `decay[m]` is
 * e^(k·dt) at the `dt` the last `coupledValues` over these curves read (the
 * same modes, in the same order). Null for a `system` curve (e^A, no modes
 * to read).
 * @param {object[]} curves
 */
export function curveRates(curves) {
  if (curves.some((curve) => curve.kind === "system")) return null;
  const plan = modesOf(curves);
  const modes = plan.k.map((k, m) => [k, plan.ki[m]]);
  const rates = curves.map((curve, c) => {
    const row = new Array(2 * modes.length).fill(0);
    curve.terms.forEach(({ k, ki = 0, a, ai = 0, r, ri = 0 }, n) => {
      const m = plan.at[c][n];
      row[2 * m] += a * k - ai * ki + r;
      row[2 * m + 1] += a * ki + ai * k + ri;
    });
    return row;
  });
  return { modes, rates, decay: plan.e, cos: plan.c1, sin: plan.c2 };
}

/** Re(a·e^(λt) + r·t·φ(λt)) for a complex mode λ = k + i·ki. */
function complexTerm({ k, ki, a, ai, r, ri }, dt) {
  const e = Math.exp(k * dt);
  const cos = Math.cos(ki * dt);
  const sin = Math.sin(ki * dt);
  // e^(λt) = e·(cos + i·sin); t·φ(λt) = (e^(λt) − 1)/λ.
  const er = e * cos;
  const ei = e * sin;
  const d = k * k + ki * ki;
  const pr = ((er - 1) * k + ei * ki) / d;
  return a * er - ai * ei + (r * pr - ri * ((ei * k - (er - 1) * ki) / d));
}

/** A coupled node's rate of change `dt` seconds after its anchor, V/s. */
export function coupledSlope(curve, dt) {
  if (curve.kind === "system") {
    const h = Math.max(1e-12, Math.abs(dt) * 1e-6);
    return (coupledValue(curve, dt + h) - coupledValue(curve, dt)) / h;
  }
  let s = 0;
  for (const { k, ki = 0, a, ai = 0, r, ri = 0 } of curve.terms) {
    // Re((a·λ + r)·e^(λt)).
    const e = Math.exp(k * dt);
    const er = e * Math.cos(ki * dt);
    const ei = e * Math.sin(ki * dt);
    const cr = a * k - ai * ki + r;
    const ci = a * ki + ai * k + ri;
    s += cr * er - ci * ei;
  }
  return s;
}

/**
 * How long after its anchor a coupled curve keeps, for good, the sign of
 * where it settles: `{sign, after}` (seconds), or null where that cannot be
 * said (an e^A curve, a mode that ramps or grows, a curve settling at
 * nothing). Each decaying mode's dying part — |a + R/λ|·e^(k·dt), what is
 * left of a·e^(λt) + r·t·φ(λt) once its constant −R/λ is taken out — bounds
 * how far the curve can stand from its final value; past where their sum,
 * each at the slowest of their rates, is half that value, it never crosses
 * zero again. (A coil's run-on looked for its zero crossing over 256
 * periods of a high-Q ring that never reached it — 150 s a simulated
 * second, the 2026-10-26 review.)
 */
export function signHeldAfter(curve) {
  if (curve.kind === "system") return null;
  const final = coupledFinal(curve);
  if (final == null || !(Math.abs(final) > 0)) return null;
  let sum = 0;
  let slowest = Number.NEGATIVE_INFINITY;
  for (const { k, ki = 0, a, ai = 0, r, ri = 0 } of curve.terms) {
    // (A term that does not decay is nothing here: `coupledFinal` has a
    // value only where every such term is.)
    if (!(k < 0)) continue;
    const d = k * k + ki * ki;
    const b = Math.hypot(a + (r * k + ri * ki) / d, ai + (ri * k - r * ki) / d);
    if (!(b > 0)) continue;
    sum += b;
    slowest = Math.max(slowest, k);
  }
  const half = Math.abs(final) / 2;
  const sign = Math.sign(final);
  if (!(sum > half)) return { sign, after: 0 };
  return { sign, after: Math.log(sum / half) / -slowest };
}

/** Where a coupled node settles, or null where it never does (a mode that
    ramps or grows). */
export function coupledFinal(curve) {
  if (curve.kind === "system") return null;
  let v = curve.base;
  for (const { k, ki = 0, a, ai = 0, r, ri = 0 } of curve.terms) {
    if (!(k < 0)) {
      if (a || ai || r || ri) return null;
      continue;
    }
    // Re(−r/λ).
    const d = k * k + ki * ki;
    v += -(r * k + ri * ki) / d;
  }
  return v;
}
