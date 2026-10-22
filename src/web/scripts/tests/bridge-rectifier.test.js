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

// The bridge rectifier (catalog/discretes.js bridge-rectifier, MCC's DB105 in
// its DB-1 package): seated across the channel on legs two columns apart,
// four one-way pairs in the logic engine, four rectifier junctions under
// Spice Lite (spice/diodes.js BRIDGE_SPEC) — full-wave off a transformer —
// drawn, and exported as the real part.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { H } from "../sim/levels.js";
import { partDef } from "../catalog/index.js";
import { TRANSFORMER_DEF, acPeakOf } from "../catalog/ac-parts.js";
import { partCoverHoles } from "../model/occupancy.js";
import { DeskDoc } from "../model/desk-doc.js";
import { exportDigital } from "../model/export/digital.js";
import { exportKicad } from "../model/export/kicad.js";
import { designatorPrefix } from "../model/export/designators.js";
import {
  BRIDGE_SPEC,
  BRIDGE_SURGE_A,
  DIODE_GRADE_SPECS,
  DIODE_SPEC,
  diodeSpec,
  diodeVerdict,
} from "../sim/spice/diodes.js";
import { shockleyVolts, tableVolts } from "../sim/spice/junction-table.js";
import { diodeKeys, lampTopology } from "../sim/spice/lamps.js";
import { buildNetlist } from "../sim/netlist.js";
import { bench, runner } from "./timing-fixtures.js";

const { buildDiscreteSvg } = await import("../components/discrete-view.js");

const REF = "bridge-rectifier";

test("the bridge is the DB105 by default, in the Diodes group, off the AI builder", () => {
  const def = partDef(REF);
  assert.equal(def.group, "Diodes");
  assert.equal(def.package, "DB-4");
  assert.equal(def.rectifier, true);
  assert.equal(def.countsAsConnection, true);
  assert.deepEqual(def.normalizeParams({}), { partNumber: "DB105" });
  assert.deepEqual(def.normalizeParams({ partNumber: " DB107 ", rot: 180 }), {
    partNumber: "DB107",
    rot: 180,
  });
  assert.deepEqual(
    def.pins.map((p) => p.name),
    ["+", "-", "~", "~"],
  );
});

test("it seats across the channel, legs two columns apart, the holes between them left free", () => {
  const b = bench();
  const pins = b.seat("br1", REF, "e10");
  // DIP order from the notched corner: + and − along row e, ~ ~ facing them.
  assert.deepEqual(Object.fromEntries(pins), { 1: "e10", 2: "e12", 3: "f12", 4: "f10" }); // prettier-ignore
  // The body stands between the rows, not over them (the tactile button's
  // plate covers e11/f11; this block does not).
  assert.deepEqual(partCoverHoles(REF, "e10"), []);

  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  doc.addComponent({ kind: "discrete", ref: REF, board: "bb2", anchor: "e10" }); // prettier-ignore
  assert.equal(doc.canPlaceWire("bb2.e11", "bb2.a20"), true);
  assert.equal(doc.canPlaceWire("bb2.f11", "bb2.a21"), true);
  assert.equal(doc.canPlaceWire("bb2.e10", "bb2.a22"), false, "pin 1's hole");
  assert.throws(
    () =>
    doc.addComponent({ kind: "discrete", ref: REF, board: "bb2", anchor: "a30" }), // prettier-ignore
  );
});

/** A bridge at e10 with a 1 kΩ load from + to GND. */
function loadedBridge() {
  const b = bench();
  b.seat("br1", REF, "e10");
  const r = b.seat("r1", "resistor", "a30", { ohms: 1000 });
  b.link("e10", r.get(1));
  b.gnd(r.get(2));
  return b;
}

test("logic engine: a HIGH on either AC pin reaches +; nothing passes back", () => {
  for (const ac of ["f10", "f12"]) {
    const b = loadedBridge();
    b.vcc(ac);
    b.gnd("e12"); // −
    const { level } = runner(b.doc).run(0);
    assert.equal(level("e10"), H, `${ac} → +`);
  }
  // + driven HIGH leaves both AC pins to themselves.
  const b = bench();
  b.seat("br1", REF, "e10");
  b.vcc("e10");
  const { level } = runner(b.doc).run(0);
  assert.notEqual(level("f10"), H);
  assert.notEqual(level("f12"), H);
});

test("logic engine: − passes a HIGH to both AC pins, as its two diodes do", () => {
  const b = bench();
  b.seat("br1", REF, "e10");
  b.vcc("e12"); // −
  const { level } = runner(b.doc).run(0);
  assert.equal(level("f10"), H);
  assert.equal(level("f12"), H);
});

test("Spice Lite: four junctions of their own, the rectifier's curve, keyed one by one", () => {
  const b = loadedBridge();
  const comp = b.doc.components.find((c) => c.id === "br1");
  assert.deepEqual(
    diodeKeys(partDef(REF), comp).map(([key]) => key),
    ["br1#d1", "br1#d2", "br1#d3", "br1#d4"],
  );
  const junctions = lampTopology(b.doc, buildNetlist(b.doc)).junctions.filter(
    (j) => j.comp === "br1",
  );
  assert.equal(junctions.length, 4);
  assert.ok(junctions.every((j) => j.diode && j.spec === BRIDGE_SPEC));
  // A plain diode keeps its one key and the common junction.
  assert.equal(diodeSpec(partDef("diode")), DIODE_SPEC);
  // The DB10x sheet: at most 1.0 V at half an amp.
  const at = (amps) => tableVolts(BRIDGE_SPEC.table, amps);
  assert.ok(at(0.5) > 0.8 && at(0.5) < 1.0, `${at(0.5)} V at 0.5 A`);
  // Its curve is the rectifier diode grade's die, on seven pieces instead
  // of 22, within 10 mV of it from 100 µA up (to the bisection's hair).
  const die = DIODE_GRADE_SPECS.rectifier;
  assert.equal(BRIDGE_SPEC.table.v.length - 1, 7);
  assert.equal(die.table.v.length - 1, 22);
  for (let amps = 1e-4; amps <= 4; amps *= 1.05) {
    const err = Math.abs(at(amps) - shockleyVolts(die, amps));
    assert.ok(err <= 0.01 * 1.001, `${amps} A: ${err} V`);
  }
  // It burns past its surge rating, not on a charging pulse.
  const burns = (amps) => diodeVerdict(BRIDGE_SPEC, amps, at(amps)).burns;
  assert.equal(burns(10), false);
  assert.equal(burns(BRIDGE_SURGE_A * 1.05), true);
});

test("Spice Lite: off a transformer's secondary it rectifies both halves", () => {
  const HZ = 60;
  const b = loadedBridge();
  b.doc.components.push(
    { id: "ac1", kind: "ac", ref: "ac", x: -40, y: 30, params: partDef("ac").normalizeParams({ peak: acPeakOf(120), trough: -acPeakOf(120), hz: HZ }) }, // prettier-ignore
    { id: "xfmr1", kind: "transformer", ref: "transformer", x: -20, y: 30, params: TRANSFORMER_DEF.normalizeParams({}) }, // prettier-ignore
  );
  b.doc.wires.push(
    { id: "wp1", from: "ac1.L", to: "xfmr1.P1", color: "red" },
    { id: "wp2", from: "ac1.N", to: "xfmr1.P2", color: "black" },
    { id: "wn", from: "ac1.N", to: "psu1.-", color: "black" },
    { id: "ws1", from: "xfmr1.S1", to: b.at("g10"), color: "blue" },
    { id: "ws2", from: "xfmr1.S2", to: b.at("g12"), color: "blue" },
  );
  b.gnd("e12"); // −
  const r = runner(b.doc, { engine: "spice" });
  r.run(0);
  r.run(0.1);
  const volts = (hole) =>
    r.result.nodeVolts.get(r.netlist.netOfPoint.get(b.at(hole)));
  let checked = 0;
  let sawEach = { pos: false, neg: false };
  const steps = 96;
  for (let k = 1; k <= steps; k++) {
    r.run(0.1 + k / (steps * HZ));
    const out = volts("e10");
    const secondary = volts("g10") - volts("g12");
    assert.ok(out > -0.05, `+ never goes below −: ${out} V`);
    if (Math.abs(secondary) < 6) continue;
    // Two drops below the secondary's magnitude, whichever way it swings.
    const drops = Math.abs(secondary) - out;
    assert.ok(drops > 1.2 && drops < 2, `${secondary} V in, ${out} V out`);
    sawEach[secondary > 0 ? "pos" : "neg"] = true;
    checked += 1;
  }
  assert.ok(sawEach.pos && sawEach.neg, "both halves conduct");
  assert.ok(checked > 20, `${checked} samples near the peaks`);
  const burnt = [...(r.result.lamps?.values() ?? [])].filter((v) => v.burnt);
  assert.deepEqual(burnt, [], "nothing burns");
});

test("the desk draws its block with its marks, turned whole by R", () => {
  resetDom();
  const svg = buildDiscreteSvg(REF, {});
  const texts = [...svg.querySelectorAll("text")].map((t) => t.textContent);
  assert.deepEqual(texts.sort(), ["+", "DB105", "~", "~", "−"].sort());
  assert.ok(svg.querySelector(".part-display-hit"), "only the block is hit");
  assert.ok(svg.querySelector(".part-burn"), "it can burn");
  assert.equal(svg.querySelector(".part-discrete-turned"), null);
  const turned = buildDiscreteSvg(REF, { rot: 180, partNumber: "DB107" });
  assert.ok(turned.querySelector(".part-discrete-turned"));
  assert.ok([...turned.querySelectorAll("text")].some((t) => t.textContent === "DB107")); // prettier-ignore
});

test("exports: KiCad's DB-1 footprint and a bridge symbol; Digital leaves it out as a diode", () => {
  const b = loadedBridge();
  b.vcc("f10");
  b.gnd("f12");
  b.gnd("e12");
  assert.equal(designatorPrefix({ kind: "discrete", ref: REF }), "D");
  const kicad = exportKicad(b.doc, { tabId: "t", name: "x" });
  const sheet = kicad.files.find((f) => f.name.endsWith(".kicad_sch")).text;
  assert.match(sheet, /Diode_THT:Diode_Bridge_DIP-4_W7\.62mm_P5\.08mm/);
  assert.match(sheet, /"DB105"/);
  const digital = exportDigital(b.doc, { tabId: "t", name: "x" });
  assert.ok(digital.report.some((e) => e.ref === REF && e.code === "diode"));
});
