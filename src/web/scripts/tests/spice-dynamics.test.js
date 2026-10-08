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

// spice/dynamics.js — coupled RC nodes solved exactly on one linear piece
// (features/spice-lite-3-plan.md, Phase 2): the matrix exponential, the
// eigen-decomposition, and rcSystem's closed forms against independent
// answers (an analytic one where the circuit has it, a fine Runge–Kutta
// integration where it does not).

import test from "node:test";
import assert from "node:assert/strict";
import {
  coupledFinal,
  coupledSlope,
  coupledValue,
  expm,
  nullModes,
  rcSystem,
  symmetricEigen,
} from "../sim/spice/dynamics.js";
import { valueAt, hasArrived, heading } from "../sim/spice/rc-curve.js";

const rows = (m) => m.map((r) => Float64Array.from(r));
const vec = (v) => Float64Array.from(v);
const close = (actual, expected, tol, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: ${actual} vs ${expected}`,
  );

/** C·v' = i0 − Y·v integrated by classical Runge–Kutta (C invertible). */
function integrate(c, y, i0, v0, t, steps = 20000) {
  const n = v0.length;
  const inv = (() => {
    const a = c.map((r) => [...r]);
    const id = a.map((_, i) => a.map((_, j) => (i === j ? 1 : 0)));
    for (let k = 0; k < n; k++) {
      const d = a[k][k];
      for (let j = 0; j < n; j++) {
        a[k][j] /= d;
        id[k][j] /= d;
      }
      for (let r = 0; r < n; r++) {
        if (r === k) continue;
        const f = a[r][k];
        for (let j = 0; j < n; j++) {
          a[r][j] -= f * a[k][j];
          id[r][j] -= f * id[k][j];
        }
      }
    }
    return id;
  })();
  const f = (v) => {
    const i = i0.map((x, k) => x - y[k].reduce((s, yk, j) => s + yk * v[j], 0)); // prettier-ignore
    return inv.map((r) => r.reduce((s, x, j) => s + x * i[j], 0));
  };
  let v = [...v0];
  const h = t / steps;
  for (let s = 0; s < steps; s++) {
    const k1 = f(v);
    const k2 = f(v.map((x, i) => x + (h / 2) * k1[i]));
    const k3 = f(v.map((x, i) => x + (h / 2) * k2[i]));
    const k4 = f(v.map((x, i) => x + h * k3[i]));
    v = v.map((x, i) => x + (h / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  }
  return v;
}

test("expm: a scalar's exponential, and a rotation's", () => {
  close(expm(rows([[-2]]))[0][0], Math.exp(-2), 1e-15, "e^-2");
  close(expm(rows([[30]]))[0][0], Math.exp(30), Math.exp(30) * 1e-13, "e^30, scaled and squared"); // prettier-ignore
  const r = expm(rows([[0, 1], [-1, 0]])); // prettier-ignore
  close(r[0][0], Math.cos(1), 1e-15, "cos");
  close(r[0][1], Math.sin(1), 1e-15, "sin");
  close(r[1][0], -Math.sin(1), 1e-15, "−sin");
});

test("symmetricEigen: eigenpairs that rebuild the matrix", () => {
  const s = rows([[4, 1, 2], [1, 3, 0], [2, 0, 5]]); // prettier-ignore
  const { values, vectors } = symmetricEigen(s);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += vectors[i][k] * values[k] * vectors[j][k]; // prettier-ignore
      close(sum, s[i][j], 1e-12, `S[${i}][${j}]`);
    }
  }
});

test("an RC ladder's two nodes move together, exactly", () => {
  // 5 V through 10.4 kΩ (a CMOS output's 400 Ω and a 10 kΩ) onto 1 µF, then
  // 10 kΩ onto another 1 µF — the golden ladder, which ngspice puts at 1.036,
  // 2.227, 4.088 and 4.700 V on its last node.
  const c = rows([[1e-6, 0], [0, 1e-6]]); // prettier-ignore
  const g1 = 1 / 10400;
  const g2 = 1 / 10000;
  const y = rows([[g1 + g2, -g2], [-g2, g2]]); // prettier-ignore
  const i0 = vec([5 * g1, 0]);
  const { curves, scale } = rcSystem({ c, y, i0, v0: vec([0, 0]), t0: 0 });
  assert.equal(curves[1].kind, "modal");
  for (const t of [0.01, 0.02, 0.05, 0.08]) {
    const want = integrate(c, y, i0, [0, 0], t);
    close(coupledValue(curves[0], t), want[0], 1e-9, `first node at ${t}`);
    close(coupledValue(curves[1], t), want[1], 1e-9, `last node at ${t}`);
  }
  close(coupledValue(curves[1], 0.08), 4.7005, 1e-4, "ngspice's 4.700 V");
  close(coupledFinal(curves[1]), 5, 1e-9, "both settle at 5 V");
  assert.ok(scale.fast < scale.slow, "two time constants");
});

test("a capacitor alone between two nets: one charge, its plates' common voltage algebraic", () => {
  // Plate a 10 kΩ to 5 V, plate b 10 kΩ to ground, 1 µF between: u = va − vb
  // charges as 5·(1 − e^(−t/20 ms)), and one current flows, (5 − u)/20 kΩ.
  const c = rows([[1e-6, -1e-6], [-1e-6, 1e-6]]); // prettier-ignore
  const y = rows([[1e-4, 0], [0, 1e-4]]); // prettier-ignore
  const { curves } = rcSystem({ c, y, i0: vec([5e-4, 0]), v0: vec([0, 0]), t0: 0 }); // prettier-ignore
  for (const t of [0, 0.01, 0.02, 0.05]) {
    const u = 5 * (1 - Math.exp(-t / 0.02));
    close(coupledValue(curves[0], t), u + (5 - u) / 2, 1e-12, `plate a at ${t}`); // prettier-ignore
    close(coupledValue(curves[1], t), (5 - u) / 2, 1e-12, `plate b at ${t}`);
  }
  // Started from a common voltage the networks disagree with, the plates
  // jump together to where they balance: the charge (here none) is kept.
  const moved = rcSystem({ c, y, i0: vec([5e-4, 0]), v0: vec([4, 4]), t0: 0 }); // prettier-ignore
  close(coupledValue(moved.curves[0], 0), 2.5, 1e-12, "plate a balanced");
  close(coupledValue(moved.curves[1], 0), 2.5, 1e-12, "plate b balanced");
  const [mode] = nullModes(c);
  close(Math.abs(mode[0]), Math.SQRT1_2, 1e-12, "its common mode");
  close(mode[0], mode[1], 1e-12, "both plates alike");
});

test("a capacitor fed by a current source ramps — no time constant, no special case", () => {
  // 1 mA into 1 µF with nothing else on it but the solve's gigaohm: a ramp of
  // 1000 V/s for as long as a curve is read.
  const { curves } = rcSystem({ c: rows([[1e-6]]), y: rows([[1e-12]]), i0: vec([1e-3]), v0: vec([0]), t0: 0 }); // prettier-ignore
  close(coupledValue(curves[0], 0.001), 1, 1e-6, "1 V after 1 ms");
  close(coupledSlope(curves[0], 0), 1000, 1e-3, "1000 V/s");
});

test("a device's unsymmetric network: over its complex modes, exactly", () => {
  // A transconductance from node 0 into node 1 (as a transistor's gain is):
  // Y unsymmetric. The answer is held to a fine integration.
  const c = rows([[1e-6, 0], [0, 2e-6]]); // prettier-ignore
  const y = rows([[2e-4, 0], [-5e-4, 1e-4]]); // prettier-ignore
  const i0 = vec([1e-3, 0]);
  const { curves } = rcSystem({ c, y, i0, v0: vec([0, 0]), t0: 0 });
  assert.equal(curves[0].kind, "modal");
  for (const t of [0.001, 0.005, 0.02]) {
    const want = integrate(c, y, i0, [0, 0], t);
    close(coupledValue(curves[0], t), want[0], 1e-9, `node 0 at ${t}`);
    close(coupledValue(curves[1], t), want[1], 1e-9, `node 1 at ${t}`);
  }
});

test("a ringing system (an inductor's current against a capacitor's voltage) in closed form", () => {
  // Series RLC from 5 V: states [v_C, i_L], C·v' = i, L·i' = 5 − R·i − v.
  const C = 1e-6;
  const L = 0.1;
  const R = 50;
  const { curves, scale } = rcSystem({ c: rows([[C, 0], [0, L]]), y: rows([[0, -1], [1, R]]), i0: vec([0, 5]), v0: vec([0, 0]), t0: 0 }); // prettier-ignore
  const a = R / (2 * L);
  const wd = Math.sqrt(1 / (L * C) - a * a);
  close(scale.osc, wd, 1e-6, "its ringing, rad/s");
  for (const t of [1e-4, 5e-4, 1e-3, 3e-3, 1e-2]) {
    const vc = 5 * (1 - Math.exp(-a * t) * (Math.cos(wd * t) + (a / wd) * Math.sin(wd * t))); // prettier-ignore
    const i = C * 5 * Math.exp(-a * t) * ((a * a) / wd + wd) * Math.sin(wd * t);
    close(coupledValue(curves[0], t), vc, 1e-9, `v_C at ${t}`);
    close(coupledValue(curves[1], t), i, 1e-12, `i_L at ${t}`);
  }
  close(coupledFinal(curves[0]), 5, 1e-9, "it settles at 5 V");
  close(coupledSlope(curves[1], 0), 5 / L, 1e-6, "di/dt = V/L at the step");
});

test("a mode with no eigenvector of its own falls back to e^A, exactly all the same", () => {
  // A Jordan block: one eigenvalue twice, one eigenvector.
  const c = rows([[1, 0], [0, 1]]); // prettier-ignore
  const y = rows([[1, -1], [0, 1]]); // prettier-ignore
  const i0 = vec([0, 1]);
  const { curves } = rcSystem({ c, y, i0, v0: vec([0, 0]), t0: 0 });
  assert.equal(curves[0].kind, "system");
  for (const t of [0.5, 1, 3]) {
    const want = integrate(c, y, i0, [0, 0], t);
    close(coupledValue(curves[0], t), want[0], 1e-9, `node 0 at ${t}`);
    close(coupledValue(curves[1], t), want[1], 1e-9, `node 1 at ${t}`);
  }
});

test("rc-curve reads a coupled curve: up to its corner in time, its heading, its arrival", () => {
  const c = rows([[1e-6, 0], [0, 1e-6]]); // prettier-ignore
  const y = rows([[2e-4, -1e-4], [-1e-4, 1e-4]]); // prettier-ignore
  const { curves, scale } = rcSystem({ c, y, i0: vec([5e-4, 0]), v0: vec([0, 0]), t0: 1 }); // prettier-ignore
  const curve = { ...curves[1], tEnd: 1.01, scale };
  close(valueAt(curve, 1.005), coupledValue(curve, 0.005), 1e-12, "inside its piece"); // prettier-ignore
  close(valueAt(curve, 2), coupledValue(curve, 0.01), 1e-12, "held at its corner"); // prettier-ignore
  assert.equal(
    heading(curve, 1.5),
    1,
    "still rising, as it reached its corner",
  );
  const free = { ...curves[1], scale };
  assert.equal(hasArrived(free, 1.001, 1), false, "on its way");
  assert.equal(hasArrived(free, 1 + 100 * scale.slow, 1), true, "there");
});
