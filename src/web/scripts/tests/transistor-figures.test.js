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

// A transistor grade as its datasheet FIGURES, and a CUSTOM grade built from
// them (spice/transistor-figures.js): every grade's figures measured off its
// own model, a custom set put back exactly, and the catalog keeping a custom
// set only while it is not a grade's own.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BJT_GRADES,
  MOSFET_GRADES,
  bjtCurrents,
  transistorModel,
} from "../sim/spice/transistors.js";
import {
  FIGURE_FIELDS,
  customModel,
  figureKind,
  gradeFigures,
  measuredFigures,
  transistorModelFor,
} from "../sim/spice/transistor-figures.js";
import {
  TRANSISTOR_GRADES,
  transistorCustom,
  transistorGrade,
} from "../catalog/discretes.js";
import { partDef } from "../catalog/index.js";

const GRADES = { ...BJT_GRADES, ...MOSFET_GRADES };

const near = (got, want, rel, what) =>
  assert.ok(Math.abs(got - want) <= rel * Math.abs(want), `${what}: ${got} vs ${want}`); // prettier-ignore

test("every grade has its figures, measured off its model, within its fields' ranges", () => {
  for (const [type, grades] of Object.entries(TRANSISTOR_GRADES)) {
    for (const g of grades) {
      const f = gradeFigures(type, g.value);
      for (const { key, range } of FIGURE_FIELDS[figureKind(type)]) {
        assert.ok(f[key] >= range.min && f[key] <= range.max, `${type} ${g.value} ${key} ${f[key]}`); // prettier-ignore
      }
      const m = measuredFigures(GRADES[type][g.value]);
      for (const k of Object.keys(f)) near(f[k], m[k], 0.005, `${type} ${g.value} ${k}`); // prettier-ignore
    }
  }
  // The sheets' own figures, where the models read them straight.
  assert.equal(gradeFigures("nmos", "logic").vth, 2.1);
  assert.equal(gradeFigures("npn", "small-signal").vceo, 40);
  assert.equal(gradeFigures("npn", "darlington").icMax, 5);
});

test("a grade's own figures are that grade's model, untouched", () => {
  for (const [type, grades] of Object.entries(TRANSISTOR_GRADES)) {
    for (const g of grades) {
      const custom = { from: g.value, ...gradeFigures(type, g.value) };
      assert.equal(customModel(type, custom), transistorModel(type, g.value));
    }
  }
});

test("a custom BJT measures back to its figures, Darlington included", () => {
  for (const type of ["npn", "pnp"]) {
    for (const g of TRANSISTOR_GRADES[type]) {
      const own = gradeFigures(type, g.value);
      const want = { hfe: own.hfe * 2, vbeOn: own.vbeOn + 0.1, vceo: 75, icMax: own.icMax * 1.5 }; // prettier-ignore
      const m = customModel(type, { from: g.value, ...want });
      const got = measuredFigures(m, GRADES[type][g.value]);
      near(got.hfe, want.hfe, 1e-4, `${type} ${g.value} hFE`);
      assert.ok(Math.abs(got.vbeOn - want.vbeOn) < 1e-4, `${type} ${g.value} VBE ${got.vbeOn}`); // prettier-ignore
      assert.equal(got.vceo, 75);
      near(got.icMax, want.icMax, 1e-12, "IC max");
      // The smoke current keeps the base grade's ratio to the warning.
      const base = GRADES[type][g.value].limits;
      near(m.limits.smokeMa / m.limits.warnMa, base.smokeMa / base.warnMa, 1e-12, "smoke ratio"); // prettier-ignore
    }
  }
});

test("a custom MOSFET puts each figure back exactly", () => {
  for (const type of ["nmos", "pmos"]) {
    for (const g of TRANSISTOR_GRADES[type]) {
      const want = { vth: 1.2, rdsOn: 0.5, vdsMax: 30, idMax: 2 };
      const m = customModel(type, { from: g.value, ...want });
      const got = measuredFigures(m);
      near(got.vth, 1.2, 1e-12, "VGS(th)");
      near(got.rdsOn, 0.5, 1e-12, "RDS(on)");
      assert.equal(got.vdsMax, 30);
      near(got.idMax, 2, 1e-12, "ID max");
    }
  }
});

test("a custom gain moves the collector current the solve sees", () => {
  const base = { from: "small-signal", ...gradeFigures("npn", "small-signal") };
  const lo = customModel("npn", base);
  const hi = customModel("npn", { ...base, hfe: base.hfe * 3 });
  // The same base current into each (well short of saturation): about three
  // times the gain, about three times the collector current — "about", away
  // from the test point the gain is the model's own curve.
  const ib = 50e-6;
  const ic = (m) => {
    let [v0, v1] = [0, 1.5];
    for (let i = 0; i < 80; i++) {
      const v = (v0 + v1) / 2;
      if (bjtCurrents(m, v, 5).ib < ib) v0 = v;
      else v1 = v;
    }
    return bjtCurrents(m, v0, 5).ic;
  };
  near(ic(hi) / ic(lo), 3, 0.15, "IC ratio");
});

test("the catalog stores a custom set whole, and a grade's own as that grade", () => {
  const npn = partDef("npn");
  const own = gradeFigures("npn", "general");
  const custom = { from: "general", ...own, hfe: 300 };
  assert.deepEqual(npn.normalizeParams({ grade: "custom", custom }), { grade: "custom", custom }); // prettier-ignore
  assert.deepEqual(npn.normalizeParams({ grade: "custom", custom: { from: "general", ...own } }), { grade: "general" }, "its own figures: that grade"); // prettier-ignore
  assert.deepEqual(npn.normalizeParams({ grade: "custom", custom: { from: "small-signal", ...gradeFigures("npn", "small-signal") } }), { grade: "small-signal" }, "the default grade's own figures: that grade, picked"); // prettier-ignore
  assert.deepEqual(npn.normalizeParams({ grade: "custom" }), {}, "no figures: no custom grade"); // prettier-ignore
  assert.deepEqual(npn.normalizeParams({ grade: "custom", custom: { from: "logic", ...own } }), {}, "a base the type has not"); // prettier-ignore
  // A figure out of its range, or missing, is the base grade's own.
  const fixed = npn.normalizeParams({ grade: "custom", custom: { from: "general", hfe: 300, vbeOn: 9, vceo: 40 } }); // prettier-ignore
  assert.deepEqual(fixed.custom, { from: "general", hfe: 300, vbeOn: own.vbeOn, vceo: 40, icMax: own.icMax }); // prettier-ignore
  // The readers.
  const params = npn.normalizeParams({ grade: "custom", custom });
  assert.equal(transistorGrade(npn, params), "general");
  assert.deepEqual(transistorCustom(npn, params), custom);
  assert.equal(transistorCustom(npn, { grade: "general" }), null);
  assert.equal(transistorModelFor("npn", "general", custom), customModel("npn", custom)); // prettier-ignore
  assert.equal(transistorModelFor("npn", "general", null), transistorModel("npn", "general")); // prettier-ignore
  // A listed part number brings a grade, which ends the custom one.
  assert.deepEqual(npn.normalizeParams({ ...params, grade: "darlington", case: "TO-220" }), { case: "TO-220", grade: "darlington" }); // prettier-ignore
});

test("a custom set crosses NPN ↔ PNP, but not BJT ↔ MOSFET", () => {
  const custom = { from: "general", ...gradeFigures("npn", "general"), hfe: 300 }; // prettier-ignore
  const params = { grade: "custom", custom };
  assert.deepEqual(partDef("pnp").adoptParams(params), params);
  assert.deepEqual(partDef("nmos").adoptParams(params), {});
});
