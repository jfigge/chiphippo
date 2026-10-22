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

// The 2026-10-21 Spice Lite review's smaller findings, each held here: a
// listener's crossing on a sum of single curves, the scalar Newton path's
// residual floor, a junction's piece as an interval (what lets a corner
// search see a graze), the corner search stepping over what no element can
// leave, a bipolar transistor's piece as straight quantities, and pieces
// compared element by element.

import test from "node:test";
import assert from "node:assert/strict";

import { firstCrossing } from "../sim/spice/listeners.js";
import { firstRoot, sampleTimes } from "../sim/spice/rc-curve.js";
import { coupledValue, coupledValues, curveRates } from "../sim/spice/dynamics.js"; // prettier-ignore
import { BJT_GRADES, bjtConstraints, bjtCurrents, bjtPiece } from "../sim/spice/transistors.js"; // prettier-ignore
import {
  junctionEdges,
  junctionPiece,
  newtonSolve,
  pieceList,
  touchingOf,
} from "../sim/spice/network.js";
import { DIODE_SPEC } from "../sim/spice/diodes.js";

test("a hump on a sum of single curves is seen, a microsecond into a second-long span", () => {
  // d = A − B + a hair of C: A rises with τ 1 µs, B further with τ 3 µs, C
  // with 1 s — d humps to 0.207 V at about 1 µs, then falls away.
  const nodes = {
    a: { curve: { t0: 0, v0: 0, vInf: 1, tau: 1e-6 } },
    b: { curve: { t0: 0, v0: 0, vInf: 1.5, tau: 3e-6 } },
    c: { curve: { t0: 0, v0: 0, vInf: 1, tau: 1 } },
  };
  const diff = {
    c: 0,
    terms: new Map([
      ["a", 1],
      ["b", -1],
      ["c", 1e-9],
    ]),
  };
  const when = firstCrossing(diff, 0.1657, 1, 0, (n) => nodes[n], Infinity, 1e-6); // prettier-ignore
  assert.ok(when > 4e-7 && when < 6e-7, `crossed at ${when} s`);
});

test("one unknown is balanced to what it can be, as many are: an isolated supply's L", () => {
  for (const nodes of [["L"], ["L", "X"]]) {
    const v = { kind: "v", w: "w", l: "L", n: "N", earth: "N", earthOhms: 1e9 };
    const branches = nodes.length === 1 ? [v, { kind: "r", a: "L", b: "G", ohms: 1000 }] : [v, { kind: "r", a: "L", b: "X", ohms: 1000 }, { kind: "r", a: "X", b: "G", ohms: 1000 }]; // prettier-ignore
    const nw = { nodes, touching: touchingOf(branches), drivers: new Map(), fixed: new Map([["w", 16.97], ["N", 0], ["G", 0]]), volts: new Map(nodes.map((x) => [x, 3])), tolerance: 1e-15 }; // prettier-ignore
    assert.equal(newtonSolve(nw), true, `${nodes.length} unknown(s)`);
  }
});

test("a junction's piece is an interval: its table's samples either side", () => {
  const br = { kind: "j", diode: true, spec: DIODE_SPEC };
  const { v } = DIODE_SPEC.table;
  // Off, below its table's start: the start is the edge above.
  assert.equal(junctionPiece(br, v[0] - 0.05), "0");
  assert.deepEqual(junctionEdges(br, v[0] - 0.05), { lo: -Infinity, hi: v[0] });
  // Between two samples: those two.
  assert.deepEqual(junctionEdges(br, v[3] + 0.25 * (v[4] - v[3])), { lo: v[3], hi: v[4] }); // prettier-ignore
  // On its last segment it runs on: only the sample below is an edge.
  const top = v[v.length - 1] + 1;
  assert.deepEqual(junctionEdges(br, top), { lo: v[v.length - 2], hi: Infinity }); // prettier-ignore
  // Always around the drop, and the same piece across the interval.
  for (let vd = -2; vd < 2; vd += 0.0137) {
    const { lo, hi } = junctionEdges(br, vd);
    assert.ok(lo <= vd && vd < hi, `${vd} V`);
    const inside = Math.max(lo, vd - 0.01) + 1e-9;
    assert.equal(junctionPiece(br, inside), junctionPiece(br, vd), `${vd} V`);
  }
});

test("a coupled curve's rates are its slope, mode by mode", () => {
  const curves = [
    { kind: "modal", t0: 0, base: 1, terms: [{ k: -1e3, a: 0.5, r: 2 }, { k: -2e2, ki: 3e3, a: 0.2, ai: -0.1, r: 0.3, ri: 0.4 }, { k: 0, a: 0, r: 5 }] }, // prettier-ignore
    { kind: "modal", t0: 0, base: 0, terms: [{ k: -2e2, ki: 3e3, a: -1, ai: 0.5, r: 0, ri: 0 }] }, // prettier-ignore
  ];
  const { modes, rates } = curveRates(curves);
  assert.equal(modes.length, 3);
  for (const dt of [0, 1e-4, 7e-4, 3e-3]) {
    curves.forEach((curve, c) => {
      let slope = 0;
      modes.forEach(([k, ki], m) => {
        const [re, im] = [rates[c][2 * m], rates[c][2 * m + 1]];
        slope += Math.exp(k * dt) * (re * Math.cos(ki * dt) - im * Math.sin(ki * dt)); // prettier-ignore
      });
      const h = 1e-9;
      const numeric = (coupledValue(curve, dt + h) - coupledValue(curve, dt - Math.min(h, dt))) / (h + Math.min(h, dt)); // prettier-ignore
      assert.ok(Math.abs(slope - numeric) < 1e-4 * Math.max(1, Math.abs(slope)), `curve ${c} at ${dt}: ${slope} vs ${numeric}`); // prettier-ignore
    });
  }
  assert.equal(curveRates([{ kind: "system" }]), null);
});

test("a root search steps over what cannot reach zero, and finds the same root", () => {
  // A margin closing on its edge as 1 − 2·(1 − e^(−u)): zero at ln 2; the
  // most it closes a second from u on is 2·e^(−u).
  const f = (u) => -(1 - 2 * (1 - Math.exp(-u)));
  const times = [];
  for (let i = 1; i <= 400; i++) times.push(i * 0.005);
  let plain = 0;
  let stepped = 0;
  const a = firstRoot((u) => (plain++, f(u)), 0, times, 1e-9);
  const b = firstRoot((u) => (stepped++, f(u)), 0, times, 1e-9, (u) => -f(u) / (2 * Math.exp(-u))); // prettier-ignore
  assert.ok(Math.abs(a - Math.LN2) < 1e-8 && Math.abs(b - Math.LN2) < 1e-8, `${a} ${b}`); // prettier-ignore
  assert.ok(
    stepped < plain / 2,
    `${stepped} reads where sampling took ${plain}`,
  );
});

test("a coupled curve set read together is each curve read alone", () => {
  const curves = [
    { kind: "modal", t0: 0, base: 1, terms: [{ k: -1e3, a: 0.5, r: 2 }, { k: -2e2, ki: 3e3, a: 0.2, ai: -0.1, r: 0.3, ri: 0.4 }, { k: 0, a: 0, r: 5 }] }, // prettier-ignore
    { kind: "modal", t0: 0, base: 0, terms: [{ k: -2e2, ki: 3e3, a: -1, ai: 0.5, r: 0, ri: 0 }, { k: -1e3, a: 1, r: 0 }] }, // prettier-ignore
  ];
  const out = new Float64Array(2);
  for (const dt of [0, 1e-5, 3e-4, 2e-3]) {
    coupledValues(curves, dt, out);
    curves.forEach((curve, c) => assert.equal(out[c], coupledValue(curve, dt), `curve ${c} at ${dt}`)); // prettier-ignore
  }
});

test("a search's sample times rise, the three grids merged", () => {
  const grids = [[0, 0], [1e-6, 0], [1e-4, 2 * Math.PI * 50], [0, 2 * Math.PI * 1e3]]; // prettier-ignore
  for (const [fast, osc] of grids) {
    const times = sampleTimes(0.5, 1.5, fast, osc);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], `${fast} ${osc} at ${i}`); // prettier-ignore
  }
});

test("a bipolar transistor's piece is where its straight quantities say", () => {
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let checked = 0;
  for (const grades of Object.values(BJT_GRADES)) {
    for (const m of Object.values(grades)) {
      if (m.kind !== "bjt") {
        assert.equal(bjtConstraints(m, 0.7, 5), null, "a Darlington"); // prettier-ignore
        continue;
      }
      for (let k = 0; k < 400; k++) {
        const vbe = 0.2 + 0.8 * rnd();
        const vce = -0.3 + 12 * rnd() ** 3;
        const own = bjtConstraints(m, vbe, vce);
        const piece = bjtPiece(m, vbe, vce);
        // (Saturated behind its base resistance it is watched, not straight
        // — the appraisal's base current through RB.)
        if (!own) {
          assert.ok(m.rbOhm > 0 && bjtCurrents(m, vbe, vce).r.kc >= 0, `${m.part} ${vbe} ${vce}`); // prettier-ignore
          continue;
        }
        for (const reach of [1e-3, 1e-2, 0.1, 1]) {
          const v2 = vbe + reach * (rnd() - 0.5);
          const c2 = vce + 10 * reach * (rnd() - 0.5);
          const margin = Math.min(...own.map((c) => { const q = c.be * v2 + c.ce * c2; return Math.min(q - c.lo, c.hi - q); })); // prettier-ignore
          if (Math.abs(margin) < 1e-9) continue;
          assert.equal(margin > 0, bjtPiece(m, v2, c2) === piece, `${m.part} ${vbe} ${vce} → ${v2} ${c2}`); // prettier-ignore
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 5000, `${checked} points`);
});

test("pieces element by element: a device's fragment changing length shifts nothing after it", () => {
  const branches = [
    { kind: "g", inp: "i", ref: "g", out: "o", reg: { vref: 5, dropoutV: 2, rOut: 0.01, limitA: 1.5, quiescentA: 0.005 } }, // prettier-ignore
    { kind: "j", a: "o", b: "g", diode: true, spec: DIODE_SPEC },
  ];
  const at = (out) => pieceList({ drivers: new Map(), branches, fixed: new Map([["i", 9], ["g", 0], ["o", out]]), volts: new Map() }); // prettier-ignore
  const on = at(4.9);
  const off = at(5.1);
  assert.equal(on.length, 2);
  assert.equal(off.length, 2);
  assert.notEqual(on[0], off[0], "the regulator changed piece");
  assert.equal(on[1], off[1], "the diode, the same element after it, did not");
});
