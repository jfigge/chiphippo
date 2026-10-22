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

// A diode's Grade (catalog/discretes.js `DIODE_GRADES`, spice/diodes.js
// `DIODE_GRADE_SPECS`): which kind of diode it is under Spice Lite — the
// small-signal 1N4148 (the default), the 1 A 1N4001–1N4007 rectifier, the
// 3 A 1N5400–1N5408 and the 1N5817–1N5819 Schottky — each its forward drop
// and the current it burns at; and what the BOM says of one.

import test from "node:test";
import assert from "node:assert/strict";

import { partDef } from "../catalog/index.js";
import { DEFAULT_DIODE_GRADE, DIODE_GRADES } from "../catalog/discretes.js";
import {
  DIODE_GRADE_SPECS,
  DIODE_SPEC,
  BRIDGE_SPEC,
  diodeSpec,
  diodeVerdict,
} from "../sim/spice/diodes.js";
import { tableVolts } from "../sim/spice/junction-table.js";
import { acPeakOf } from "../catalog/ac-parts.js";
import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";
import { buildPlan } from "../model/build-plan.js";
import { bench, runner } from "./timing-fixtures.js";

const diode = partDef("diode");

test("a diode's Grade: four kinds, the small-signal one the default, stored only off it", () => {
  assert.deepEqual(DIODE_GRADES.map((g) => g.value), ["small-signal", "rectifier", "power", "schottky"]); // prettier-ignore
  assert.equal(DEFAULT_DIODE_GRADE, "small-signal");
  const field = diode.properties.find((f) => f.key === "grade");
  assert.equal(
    field.spiceOnly,
    true,
    "the digital engine's diode has no curve",
  );
  assert.equal(field.default, DEFAULT_DIODE_GRADE);
  assert.deepEqual(field.options.map((o) => o.detail), ["1N4148", "1N4001–1N4007", "1N5400–1N5408", "1N5817–1N5819"]); // prettier-ignore
  assert.equal(diode.normalizeParams({ grade: "schottky" }).grade, "schottky");
  assert.equal("grade" in diode.normalizeParams({ grade: "small-signal" }), false); // prettier-ignore
  assert.equal("grade" in diode.normalizeParams({ grade: "germanium" }), false);
  // A Zener is a Zener: no grade.
  assert.equal(partDef("zener").properties.some((f) => f.key === "grade"), false); // prettier-ignore
  assert.equal("grade" in partDef("zener").normalizeParams({ grade: "power" }), false); // prettier-ignore
});

test("each grade is its junction: a diode with none stored is the small-signal one it always was", () => {
  assert.equal(diodeSpec(diode, {}), DIODE_SPEC);
  assert.equal(diodeSpec(diode, { grade: "small-signal" }), DIODE_SPEC);
  // The die a bridge holds — on its full table: only the bridge's is simpler.
  const rectifier = diodeSpec(diode, { grade: "rectifier" });
  assert.equal(rectifier, DIODE_GRADE_SPECS.rectifier);
  for (const k of ["isA", "n", "rsOhm", "device", "tjMaxC"]) assert.equal(rectifier[k], BRIDGE_SPEC[k], k); // prettier-ignore
  assert.ok(rectifier.table.v.length > 2 * BRIDGE_SPEC.table.v.length);
  assert.equal(diodeSpec(diode, { grade: "power" }), DIODE_GRADE_SPECS.power);
  assert.equal(diodeSpec(diode, { grade: "schottky" }), DIODE_GRADE_SPECS.schottky); // prettier-ignore
  assert.equal(diodeSpec(partDef("zener"), { grade: "power" }), DIODE_SPEC);
});

test("each grade's forward drop is its sheet's: under each maximum, at each rated current", () => {
  const at = (grade, amps) => tableVolts(DIODE_GRADE_SPECS[grade].table, amps);
  // 1N4148: 0.75 V at 10 mA (its card), 1 V maximum there.
  assert.ok(Math.abs(at("small-signal", 0.01) - 0.75) < 0.02);
  // 1N4007: 1.1 V maximum at 1 A (MCC); the DB10x sheet's curve, 0.93 V.
  assert.ok(at("rectifier", 1) < 1.1 && Math.abs(at("rectifier", 1) - 0.93) < 0.05); // prettier-ignore
  // 1N5408: 1.2 V maximum at 3 A (Vishay 88516); its curve, 0.88 V.
  assert.ok(at("power", 3) < 1.2 && Math.abs(at("power", 3) - 0.88) < 0.05);
  // 1N5819: 0.60 V maximum at 1 A (Vishay 88525); the series' curve, 0.39 V.
  assert.ok(at("schottky", 1) < 0.6 && Math.abs(at("schottky", 1) - 0.39) < 0.03); // prettier-ignore
  // …and a Schottky drops less than the rest at every current.
  for (const amps of [0.001, 0.01, 0.1, 1]) {
    for (const g of ["small-signal", "rectifier", "power"]) assert.ok(at("schottky", amps) < at(g, amps), `${g} at ${amps} A`); // prettier-ignore
  }
});

test("each grade burns where its rating says: a 1N4148 past a third of an amp, the rest past their surge", () => {
  const burns = (grade, amps) => {
    const spec = DIODE_GRADE_SPECS[grade];
    return diodeVerdict(spec, amps, tableVolts(spec.table, amps)).burns;
  };
  assert.equal(burns("small-signal", 0.2), false);
  assert.equal(burns("small-signal", 0.5), true);
  assert.equal(burns("rectifier", 20), false);
  assert.equal(burns("rectifier", 35), true, "past its 30 A surge");
  assert.equal(burns("power", 150), false);
  assert.equal(burns("power", 250), true, "past its 200 A surge");
  assert.equal(burns("schottky", 20), false);
  assert.equal(burns("schottky", 30), true, "past its 25 A surge");
});

/** A 12 V~ adapter's ±17 V (its S2 on the supply's −) through one diode of
    `grade` into 1 mF and 1 kΩ back to S2, for 0.1 s — the adapter's own
    1.2 Ω takes a few cycles to fill the capacitor. */
function halfWave(grade) {
  const b = bench();
  b.doc.components.push(
    { id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: partDef("adapter").normalizeParams({ rms: 12, hz: 60 }) }, // prettier-ignore
    { id: "d1", kind: "discrete", ref: "diode", board: "bb1", anchor: "j1", params: diode.normalizeParams({ grade, rot: 90, end: { dx: 3, dy: 0 } }) }, // prettier-ignore
    { id: "c1", kind: "discrete", ref: "cap-electrolytic", board: "bb1", anchor: "f4", params: { farads: 1e-3, rot: 90, end: { dx: 3, dy: 0 } } }, // prettier-ignore
    { id: "r1", kind: "discrete", ref: "resistor", board: "bb1", anchor: "h4", params: { ohms: 1000, rot: 90, end: { dx: 3, dy: 0 } } }, // prettier-ignore
  );
  b.doc.wires.push(
    { id: "wl", from: "adp1.S1", to: "bb1.g1", color: "red" },
    { id: "wn", from: "adp1.S2", to: "bb1.g7", color: "black" },
    { id: "wg", from: "psu1.-", to: "bb1.i7", color: "black" },
  );
  const r = runner(b.doc, { engine: "spice" });
  const seen = [];
  let t = 0;
  r.run(0);
  while (t < 0.1) {
    t = Math.min(r.result.wakeAt ?? t + 0.001, t + 0.001);
    seen.push(...r.run(t).result.warnings);
  }
  const v = r.result.nodeVolts.get(r.netlist.netOfPoint.get("bb1.j4"));
  return { burnt: seen.some((w) => w.type === "diode-burnt"), v };
}

test("a reservoir capacitor charged through a diode: a 1N4148 burns, a rectifier fills it", () => {
  const peak = acPeakOf(12);
  const signal = halfWave("small-signal");
  assert.equal(signal.burnt, true, "the inrush is amps");
  for (const grade of ["rectifier", "power", "schottky"]) {
    const { burnt, v } = halfWave(grade);
    assert.equal(burnt, false, grade);
    assert.ok(v > peak - 1.6 && v < peak, `${grade}: ${v} V`);
  }
  // The Schottky's lower drop leaves the capacitor fuller.
  assert.ok(halfWave("schottky").v > halfWave("rectifier").v);
});

test("the BOM names a graded diode's parts where no part number does", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addComponent({ kind: "discrete", ref: "diode", board: "bb2", anchor: "a5", params: {} }); // prettier-ignore
  doc.addComponent({ kind: "discrete", ref: "diode", board: "bb2", anchor: "a15", params: { grade: "rectifier" } }); // prettier-ignore
  doc.addComponent({ kind: "discrete", ref: "diode", board: "bb2", anchor: "a25", params: { grade: "rectifier", partNumber: "1N4004" } }); // prettier-ignore
  const json = doc.toJSON();
  const lines = buildPlan(json, buildNetlist(json)).bom.discretes.filter((l) => l.key.startsWith("diode")); // prettier-ignore
  assert.deepEqual(lines.map((l) => [l.key, l.count]).sort(), [
    ["diode", 1],
    ["diode:1N4001–1N4007", 1],
    ["diode:1N4004", 1],
  ]);
  assert.ok(lines.find((l) => l.key === "diode:1N4001–1N4007").title.endsWith("1N4001–1N4007")); // prettier-ignore
});

test("a 1N4148 survives charging a capacitor at its supply's 1 A for a millisecond", () => {
  // It burnt on the instant's current past a third of an amp; its sheet
  // allows 1 A for a second, 2 A for a microsecond — it burns by heat now
  // (DIODE_SPEC `rthFast`, `heatTauS`), the die's own rise at the instant.
  const b = bench({ volts: 9 });
  const d = b.seat("d1", "diode", "f40", {});
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 1e-4 });
  b.vcc(d.get(1));
  b.link(d.get(2), c.get(1));
  b.gnd(c.get(2));
  const r = runner(b.doc, { engine: "spice" });
  let t = 0;
  const seen = [...r.run(0).result.warnings];
  while (t < 0.05) {
    t = Math.max(r.result.wakeAt ?? t + 1e-3, t + 5e-4);
    seen.push(...r.run(t).result.warnings);
  }
  assert.equal(
    seen.some((w) => w.type === "diode-burnt"),
    false,
  );
  const v = r.result.nodeVolts.get(r.netlist.netOfPoint.get(b.at(c.get(1))));
  assert.ok(v > 8, `${v} V`);
  // The ratings the heat is fitted to.
  const spec = DIODE_GRADE_SPECS["small-signal"];
  const at = (amps, tj) => diodeVerdict(spec, amps, tableVolts(spec.table, amps), tj).burns; // prettier-ignore
  assert.equal(at(1.9, 25), false, "under 2 A at once: no");
  assert.equal(at(2.1, 25), true, "past 2 A at once: yes");
});
