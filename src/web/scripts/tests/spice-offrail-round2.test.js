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

// Round 2 (2026-10-27): a chip off the rails with an input tied below its
// lifted ground, the meter's reading in its − lead, a meter's far rail
// placed before the first tick, and a chip whose supply pin floats.

import test from "node:test";
import assert from "node:assert/strict";

import { bench, runner } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { busyDocument } from "../bench/busy-circuit.js";
import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";
import { prepareCircuit } from "../sim/engine.js";
import { L } from "../sim/levels.js";

const meterOf = (id, params) => ({ id, kind: "meter", ref: "meter", x: 70, y: 0, params: partDef("meter").normalizeParams(params) }); // prettier-ignore

/** A 74LS04, VCC on +5 V, its ground lifted by a µA meter in its − lead (or
    the 100 Ω it is, `twin`), input 1 on the supply's −, its output lighting
    a red LED through 330 Ω back to its own ground — regrade 4's repro. */
function inputBelow(twin, ohms = 330) {
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "74LS04", "e20");
  b.vcc(u.get(14).replace(/^f/, "j"));
  b.gnd(u.get(1).replace(/^e/, "a"));
  b.link(u.get(7).replace(/^e/, "a"), "b58");
  const r = b.seat("rl", "resistor", "a40", { ohms });
  b.link(u.get(2).replace(/^e/, "c"), r.get(1).replace(/^a/, "c"));
  const d = b.seat("ld", "led", "f40", { color: "red" });
  b.link(r.get(2).replace(/^a/, "d"), d.get(1).replace(/^f/, "g"));
  b.link(d.get(2).replace(/^f/, "g"), "c58");
  if (twin) {
    const rr = b.seat("m1", "resistor", "f4", { ohms: 100 });
    b.link(rr.get(1).replace(/^f/, "g"), "d58");
    b.gnd(rr.get(2).replace(/^f/, "g"));
  } else {
    b.doc.components.push(meterOf("m1", { dial: "ua", jack: "ma", red: { at: b.at("d58") }, black: { at: "psu1.-" } })); // prettier-ignore
  }
  const run = runner(b.doc, { engine: "spice" });
  for (const t of [0, 0.01, 0.1]) run.run(t);
  const ground = run.result.nodeVolts.get(run.netlist.netOfPoint.get(b.at("e58"))); // prettier-ignore
  return { ground, amps: run.result.bench?.get("m1")?.amps, status: run.result.chipStatus.get("u1")?.status }; // prettier-ignore
}

// ngspice's "same" deck (scripts/spice-deck.mjs) on this desk: the lifted
// ground 0.4636030 V, so 4.636 mA through the 100 Ω.
const NG_GROUND_V = 0.463603;

test("an off-rail 74LS04 with an input below its lifted ground: its open inputs leave the solve, which balances (ngspice's ground)", () => {
  const { ground } = inputBelow(true);
  // It was 0.4153 V (−10.4 %): five open inputs stranded under the ground.
  assert.ok(Math.abs(ground / NG_GROUND_V - 1) < 0.002, `${ground} V`);
});

test("an off-rail 74LS04 held under its floor still draws its inputs' bias (a resistor and a diode from its own VCC)", () => {
  // Through 220 Ω its LED lifts the ground to 0.503 V: 4.497 V across it,
  // under the 74LS floor (4.5 V), held. Its inputs dropped with its logic,
  // the bias the grounded input carries past the 100 Ω went too and the
  // ground read 0.590 V (+17 %); ngspice's "same" deck, 0.5032460 V.
  for (const twin of [true, false]) {
    const { ground, status } = inputBelow(twin, 220);
    assert.equal(status, "underpowered");
    assert.ok(Math.abs(ground / 0.503246 - 1) < 0.002, `${twin} ${ground} V`);
  }
});

test("…and the meter in its place reads the current its own shunt's drop says", () => {
  const { ground, amps } = inputBelow(false);
  assert.ok(Math.abs(ground / NG_GROUND_V - 1) < 0.002, `${ground} V`);
  // It read 4.689 mA (+1.14 %): moved over the shunt alone, the balance
  // took the networks' current as fixed.
  assert.ok(Math.abs(amps / (ground / 100) - 1) < 1e-3, `${amps} A against ${ground / 100}`); // prettier-ignore
  assert.ok(Math.abs(amps / (NG_GROUND_V / 100) - 1) < 0.002, `${amps} A`);
});

/** The busy fixture (4 slices) with the mA meter in psu1's − lead, or none:
    the clusters its first tick solves. */
function firstTickSolves(meter) {
  const doc = busyDocument(4);
  if (meter) {
    const feed = doc.wires.find((w) => w.from === "psu1.-" && /^bb\d+\.-/.test(w.to)); // prettier-ignore
    doc.wires = doc.wires.filter((w) => w.id !== feed.id);
    doc.components.push(meterOf("dmm2", { dial: "ma", jack: "ma", red: { at: feed.to }, black: { at: "psu1.-" } })); // prettier-ignore
  }
  const netlist = buildNetlist(doc, new Map(), { inductors: "branch" });
  const stats = {};
  const r = ENGINES.spice.tick({ document: doc, netlist, warmStart: new Map(), state: new Map(), prevPinLevels: new Map(), clockPhase: new Map([["clk1", L]]), context: prepareCircuit(doc, netlist), now: 0, spice: { config: { enabled: true }, analog: null }, stats }); // prettier-ignore
  return { solves: stats.clusterSolves, statuses: [...r.chipStatus.values()].map((s) => s.status) }; // prettier-ignore
}

test("a meter's far rail is placed before the first context: the first tick solves no more than the board without it", () => {
  const plain = firstTickSolves(false);
  const metered = firstTickSolves(true);
  // From the supply's own rail, its chips unpowered at the first context,
  // it solved every cluster twice and moved the rail once (501 for 223).
  assert.equal(metered.solves, plain.solves);
  assert.ok(
    metered.statuses.every((s) => s === "ok"),
    metered.statuses.join(),
  );
});

test("a chip whose ground, or a CD4051B whose VEE, floats is unpowered in both engines", () => {
  const cases = [
    ["CD4069UB", (b, u) => b.vcc(u.get(14))],
    ["74LS04", (b, u) => b.vcc(u.get(14))],
    ["CD4051B", (b, u) => (b.vcc(u.get(16)), b.gnd(u.get(8)))], // VEE (7) open
  ];
  for (const [ref, wire] of cases) {
    for (const engine of ["digital", "spice"]) {
      const b = bench();
      const u = b.seat("u1", ref, "e1");
      wire(b, u);
      const { result } = runner(b.doc, { engine }).run(0.001);
      // Under Spice Lite its own protection diodes lifted the floating pin
      // to 0.5 V under VCC: "underpowered at 0.50 V".
      assert.deepEqual(result.chipStatus.get("u1"), { status: "unpowered", volts: 0 }, `${ref} ${engine}`); // prettier-ignore
    }
  }
});

test("…and the floating ground of an unpowered CD4069UB stands where its ICC pulls it: ngspice's 4.9975 V (the 2026-10-28 regrade)", () => {
  // ngspice's "same" deck (scripts/spice-deck.mjs): the ICC's 500 MΩ from
  // VCC against GMIN's teraohm — the 74LS04's 2.5 kΩ, 5.0000 V. Guessed at
  // mid-supply, the 2 V Newton step landed it at 4.50 V, a nanoamp (the
  // tolerance) short through 500 MΩ, and the solve stopped there.
  for (const [ref, ng] of [
    ["CD4069UB", 4.997501249],
    ["74LS04", 4.999999984],
  ]) {
    const b = bench({ volts: 5 });
    const u = b.seat("u1", ref, "e20");
    b.vcc(u.get(14).replace(/^f/, "j"));
    b.gnd(u.get(1).replace(/^e/, "a"));
    const run = runner(b.doc, { engine: "spice" });
    for (const t of [0, 0.01, 0.1]) run.run(t);
    const ground = run.result.nodeVolts.get(run.netlist.netOfPoint.get(b.at(u.get(7)))); // prettier-ignore
    assert.ok(Math.abs(ground / ng - 1) < 1e-3, `${ref}: ${ground} V against ${ng}`); // prettier-ignore
    assert.deepEqual(run.result.chipStatus.get("u1"), { status: "unpowered", volts: 0 }, ref); // prettier-ignore
  }
});
