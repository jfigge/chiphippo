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

// The transistor grades (spice/transistors.js) against their own sheets'
// typical points — the grades fitted to a sheet rather than a vendor card
// (the cards' grades are graded against ngspice in spice-golden.test.js) —
// and the device mechanics the solve leans on.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BJT_GRADES,
  MOSFET_GRADES,
  bjtCurrents,
  bjtPiece,
  mosfetCurrent,
  mosfetPiece,
  transistorModel,
} from "../sim/spice/transistors.js";
import { partDef } from "../catalog/index.js";
import {
  TRANSISTOR_GRADES,
  defaultGrade,
  transistorGrade,
} from "../catalog/discretes.js";

/** Bisect a rising f to its root in [lo, hi]. */
function root(f, lo, hi) {
  for (let k = 0; k < 100; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** VBE and hFE at a collector current and VCE. */
function active(m, ic, vce) {
  const vbe = root((v) => bjtCurrents(m, v, vce).ic - ic, 0, 4);
  return { vbe, hfe: ic / bjtCurrents(m, vbe, vce).ib };
}

/** VCE(sat) at a collector current and a forced gain. */
function saturated(m, ic, forced) {
  const ib = ic / forced;
  const vbeFor = (vce) => root((v) => bjtCurrents(m, v, vce).ib - ib, 0, 4);
  return root((vce) => bjtCurrents(m, vbeFor(vce), vce).ic - ic, 0, 5);
}

const within = (got, want, rel, what) =>
  assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${what}: ${got} vs ${want}`); // prettier-ignore

test("every grade the catalog offers has its figures, and the default follows the package", () => {
  for (const [type, grades] of Object.entries(TRANSISTOR_GRADES)) {
    for (const g of grades) {
      const m = transistorModel(type, g.value);
      assert.ok(m, `${type} ${g.value}`);
      assert.equal(m.part, g.part, `${type} ${g.value}'s representative`);
    }
    assert.equal(defaultGrade(type, "TO-92"), grades[0].value);
    assert.equal(defaultGrade(type, "TO-220"), "power");
  }
  // None stored follows the package; one picked is stored — its package's
  // default included — and read back the same.
  const npn = partDef("npn");
  assert.equal(transistorGrade(npn, {}), "small-signal");
  assert.equal(transistorGrade(npn, { case: "TO-220" }), "power");
  assert.equal(transistorGrade(npn, { grade: "logic" }), "small-signal");
  assert.deepEqual(npn.normalizeParams({ grade: "small-signal" }), { grade: "small-signal" }); // prettier-ignore
  assert.deepEqual(npn.normalizeParams({ grade: "general" }), { grade: "general" }); // prettier-ignore
  assert.deepEqual(npn.normalizeParams({ case: "TO-220", grade: "power" }), { case: "TO-220", grade: "power" }); // prettier-ignore
  assert.deepEqual(npn.normalizeParams({ grade: "logic" }), {}, "not this type's"); // prettier-ignore
  // A grade picked keeps through a package change and back.
  let p = npn.normalizeParams({ case: "TO-220", grade: "small-signal" });
  p = npn.normalizeParams({ ...p, case: "TO-92" });
  p = npn.normalizeParams({ ...p, case: "TO-220" });
  assert.equal(transistorGrade(npn, p), "small-signal");
  assert.equal(partDef("nmos").normalizeParams({}).grade, undefined);
  assert.equal(transistorGrade(partDef("nmos"), partDef("nmos").normalizeParams({})), "power"); // prettier-ignore
});

test("TIP31C: its sheet's gain, base voltage and saturation", () => {
  const m = BJT_GRADES.npn.power;
  // Fig. 8 (VCE 2 V, 25 °C): ≈ 70 to 0.1 A, ≈ 45 at 1 A, ≈ 22 at 3 A.
  within(active(m, 0.1, 2).hfe, 70, 0.1, "hFE at 0.1 A");
  within(active(m, 1, 2).hfe, 45, 0.1, "hFE at 1 A");
  within(active(m, 3, 2).hfe, 22, 0.2, "hFE at 3 A");
  // Fig. 10: VBE 0.50 V at 3 mA, 0.63 V at 0.1 A, 0.82 V at 1 A.
  assert.ok(Math.abs(active(m, 0.003, 2).vbe - 0.5) < 0.02);
  assert.ok(Math.abs(active(m, 0.1, 2).vbe - 0.63) < 0.05);
  assert.ok(Math.abs(active(m, 1, 2).vbe - 0.82) < 0.08);
  // VCE(sat) at IC/IB = 10: ≈ 0.1 V to 0.3 A, 0.15 V at 1 A.
  assert.ok(Math.abs(saturated(m, 0.1, 10) - 0.1) < 0.05);
  assert.ok(Math.abs(saturated(m, 1, 10) - 0.15) < 0.05);
});

test("TIP120: a Darlington's gain, its two base drops and its saturation", () => {
  const m = BJT_GRADES.npn.darlington;
  // Fig. 9 (VCE 4 V): ≈ 2200 at 0.5 A, ≈ 3000 at 1 A; ≈ 800 at 0.1 A,
  // where R2 still takes most of the driver's current.
  within(active(m, 0.5, 4).hfe, 2200, 0.1, "hFE at 0.5 A");
  within(active(m, 1, 4).hfe, 3000, 0.1, "hFE at 1 A");
  within(active(m, 0.1, 4).hfe, 800, 0.2, "hFE at 0.1 A");
  // Fig. 11: VBE(on) ≈ 1.2 V at 0.1 A, 1.4 V at 1 A; VCE(sat) at
  // IC/IB = 250 ≈ 0.72 V at 0.1 A, 0.82 V at 1 A — it never saturates
  // below one junction's drop.
  assert.ok(Math.abs(active(m, 0.1, 4).vbe - 1.2) < 0.05);
  assert.ok(Math.abs(active(m, 1, 4).vbe - 1.4) < 0.05);
  assert.ok(Math.abs(saturated(m, 0.1, 250) - 0.72) < 0.05);
  assert.ok(Math.abs(saturated(m, 1, 250) - 0.82) < 0.08);
});

test("the MOSFET grades: their sheets' on-resistance and transfer", () => {
  const rds = (m, vgs) => 0.01 / mosfetCurrent(m, vgs, 0.01);
  // 2N7000: RDS(on) 1.2 Ω typ at 10 V (the fit 1.0).
  within(rds(MOSFET_GRADES.nmos.logic, 10), 1.2, 0.2, "2N7000 at 10 V");
  // IRLZ44N: 25 mΩ max at 5 V.
  assert.ok(rds(MOSFET_GRADES.nmos["logic-power"], 5) < 0.03);
  // IRF540N: 44 mΩ max at 10 V; ~30 A at 5 V (Fig. 3); off at 3 V — a
  // power part barely on from a logic output.
  assert.ok(rds(MOSFET_GRADES.nmos.power, 10) < 0.044);
  within(mosfetCurrent(MOSFET_GRADES.nmos.power, 5, 50), 30, 0.15, "IRF540N at 5 V"); // prettier-ignore
  assert.equal(mosfetCurrent(MOSFET_GRADES.nmos.power, 3, 5), 0);
  // BS250: RDS(on) 9 Ω typ at −10 V; IRF9540N: 117 mΩ max at −10 V.
  within(rds(MOSFET_GRADES.pmos.logic, 10), 9, 0.1, "BS250 at 10 V");
  assert.ok(rds(MOSFET_GRADES.pmos.power, 10) < 0.117);
});

test("a MOSFET's channel is continuous across its regions, and its pieces step with it", () => {
  for (const m of [
    ...Object.values(MOSFET_GRADES.nmos),
    ...Object.values(MOSFET_GRADES.pmos),
  ]) {
    // prettier-ignore
    const vgs = m.vtoV + 1;
    const vov = 1;
    const edge = vov + m.rdOhm * (m.kpA / 2) * vov * vov;
    const below = mosfetCurrent(m, vgs, edge * (1 - 1e-9));
    const above = mosfetCurrent(m, vgs, edge * (1 + 1e-9));
    assert.ok(Math.abs(below - above) <= 1e-6 * above, `${m.part}: ${below} vs ${above}`); // prettier-ignore
    assert.notEqual(mosfetPiece(m, vgs, edge / 2), mosfetPiece(m, vgs, edge * 2)); // prettier-ignore
    assert.equal(mosfetPiece(m, m.vtoV - 0.1, 1), "0");
  }
});

test("a bipolar transistor's currents are smooth enough to differentiate, its collector solved inside", () => {
  // The collector resistance is solved for inside the device: a microvolt's
  // nudge must move its currents by a microvolt's worth, not by the solve's
  // own error — the Newton step reads its slopes that way.
  for (const m of [
    BJT_GRADES.npn["small-signal"],
    BJT_GRADES.npn.power,
    BJT_GRADES.npn.darlington,
  ]) {
    // prettier-ignore
    const vbe = m.kind === "darlington" ? 1.3 : 0.7;
    for (const vce of [0.05, 0.3, 3]) {
      const a = bjtCurrents(m, vbe, vce).ic;
      const b = bjtCurrents(m, vbe, vce + 1e-6).ic;
      const c = bjtCurrents(m, vbe, vce + 2e-6).ic;
      assert.ok(b >= a && c >= b, `${m.part} rises with VCE at ${vce}`);
      assert.ok(Math.abs(c - 2 * b + a) <= 1e-6 * Math.max(Math.abs(c - a), 1e-12), `${m.part} at ${vce}: a straight line over 2 µV`); // prettier-ignore
    }
    // Saturated and active are different pieces; past VCEO it breaks down.
    assert.notEqual(bjtPiece(m, vbe, 0.05), bjtPiece(m, vbe, 3));
    assert.match(bjtPiece(m, vbe, m.vceoV + 1), /v$/);
  }
});
