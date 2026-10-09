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

// The ULN2003A (catalog/chips-drivers.js): seven Darlington sinks with clamp
// diodes to COM. The logic engine runs each channel as a switch to E; Spice
// Lite as the Darlington it is (spice/transistors.js ARRAY_MODELS) behind its
// 2.7 kΩ, and each output's diode to COM.

import test from "node:test";
import assert from "node:assert/strict";
import { H, L } from "../sim/levels.js";
import { chipDef } from "../catalog/index.js";
import { bench, runner } from "./timing-fixtures.js";

/** A ULN2003A on 12 V: E to GND, COM to + unless `com` is false, channel 1's
    output pulled up through `ohms`, its input on signal "in". */
function driver({ ohms = 1000, com = true, volts = 12 } = {}) {
  const b = bench({ volts });
  const u = b.seat("u1", "ULN2003A", "e10");
  b.gnd(u.get(8));
  if (com) b.vcc(u.get(9));
  const r = b.seat("r1", "resistor", "a30", { ohms });
  b.vcc(r.get(1));
  b.link(r.get(2), u.get(16));
  b.signal("in", u.get(1), "low");
  return { b, u, r };
}

test("ULN2003A: needs no supply, and its pins are the sheet's", () => {
  const def = chipDef("ULN2003A");
  assert.equal(def.package, "DIP-16");
  assert.equal(def.family, undefined);
  assert.ok(!def.pins.some((p) => p.role === "vcc" || p.role === "gnd"));
  assert.equal(def.pins.find((p) => p.n === 1).name, "1B");
  assert.equal(def.pins.find((p) => p.n === 16).name, "1C");
  assert.equal(def.pins.find((p) => p.n === 10).name, "7C");
  assert.equal(def.pins.find((p) => p.n === 8).name, "E");
  assert.equal(def.pins.find((p) => p.n === 9).name, "COM");
});

test("ULN2003A, logic engine: an input HIGH sinks its output; LOW leaves it to its load", () => {
  const { b, u } = driver();
  const sim = runner(b.doc);
  let r = sim.run(0, new Map([["in", H]])).result;
  assert.equal(sim.level(u.get(16)), L, "on: sunk to E");
  r = sim.run(0.01, new Map([["in", L]])).result;
  assert.equal(sim.level(u.get(16)), H, "off: the pull-up's");
  assert.ok(!r.warnings.some((w) => w.type === "unpowered"));
  // Another channel, untouched, stays open.
  assert.notEqual(sim.level(u.get(15)), L);
});

test("ULN2003A, Spice Lite: saturates at its sheet's typical VCE(sat)", () => {
  // SLRS027R §6.5: VCE(sat) 0.9 V at 100 mA (II 250 µA), 1.0 V at 200 mA
  // (350 µA), 1.2 V at 350 mA (500 µA) — each input fed through a resistor
  // that sets that input current.
  for (const [ohms, rext, want] of [
    [120, 39e3, 0.9],
    [60, 27.8e3, 1.0],
    [34, 18.3e3, 1.2],
  ]) {
    // prettier-ignore
    const b = bench({ volts: 12 });
    const u = b.seat("u1", "ULN2003A", "e10");
    b.gnd(u.get(8));
    b.vcc(u.get(9));
    const r = b.seat("r1", "resistor", "a30", { ohms });
    b.vcc(r.get(1));
    b.link(r.get(2), u.get(16));
    const rb = b.seat("r2", "resistor", "a45", { ohms: rext });
    b.vcc(rb.get(1));
    b.link(rb.get(2), u.get(1));
    const sim = runner(b.doc, { engine: "spice" });
    const res = sim.run(0).result;
    const vce = res.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(16))));
    assert.ok(Math.abs(vce - want) <= 0.05 * want, `${ohms} Ω: ${vce} V vs ${want}`); // prettier-ignore
  }
});

test("ULN2003A, Spice Lite: its input draws through 2.7 kΩ and two junctions", () => {
  // SLRS027R §6.5: II(on) 0.93 mA typ at VI 3.85 V.
  const b = bench({ volts: 3.85 });
  const u = b.seat("u1", "ULN2003A", "e10");
  b.gnd(u.get(8));
  b.vcc(u.get(1));
  const res = runner(b.doc, { engine: "spice" }).run(0).result;
  const amps = res.currents.get(b.at(u.get(1)));
  assert.ok(Math.abs(amps - 0.93e-3) <= 0.15 * 0.93e-3, `${amps * 1e3} mA`);
});

test("ULN2003A, Spice Lite: past 500 mA an output warns", () => {
  const { b } = driver({ ohms: 15 });
  const r = runner(b.doc, { engine: "spice" }).run(0, new Map([["in", H]])).result; // prettier-ignore
  const w = r.warnings.find((x) => x.type === "output-current");
  assert.ok(w, r.warnings.map((x) => x.type).join());
  assert.equal(w.chip, "u1");
});

/** A relay coil (100 mH can) from + to channel 1's output. */
function coilDriver(com) {
  const b = bench({ volts: 12 });
  const u = b.seat("u1", "ULN2003A", "e10");
  b.gnd(u.get(8));
  if (com) b.vcc(u.get(9));
  const coil = b.seat("l1", "inductor", "a40", { henries: 0.1, style: "can" });
  b.vcc(coil.get(1));
  b.link(coil.get(2), u.get(16));
  b.signal("in", u.get(1), "low");
  return { b, u };
}

const runTo = (sim, from, until, levels) => {
  let r = sim.run(from, levels).result;
  const seen = [r];
  for (let i = 0; i < 400 && r.wakeAt != null && r.wakeAt < until; i++) {
    r = sim.run(r.wakeAt, levels).result;
    seen.push(r);
  }
  return seen;
};

test("ULN2003A, Spice Lite: an input taken LOW lets its output go", () => {
  // Off from the start, on, then off again: the Darlington's base is
  // emptied through its 2.7 kΩ and the load pulls the output to its supply.
  const { b, u } = driver({ ohms: 100 });
  const sim = runner(b.doc, { engine: "spice" });
  const out = () => sim.result.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(16)))); // prettier-ignore
  for (const [t, level, high] of [
    [0, L, true],
    [0.01, H, false],
    [0.02, L, true],
  ]) {
    // prettier-ignore
    sim.run(t, new Map([["in", level]]));
    if (high) assert.ok(out() > 11.9, `${t}: off, ${out()} V`);
    else assert.ok(out() < 1.2, `${t}: on, ${out()} V`);
  }
});

test("ULN2003A, Spice Lite: COM left open, the coil kicks the output into breakdown", () => {
  const { b } = coilDriver(false);
  const sim = runner(b.doc, { engine: "spice" });
  runTo(sim, 0, 0.02, new Map([["in", H]]));
  const seen = runTo(sim, 0.02, 0.05, new Map([["in", L]]));
  const kick = seen.flatMap((x) => x.warnings).find((w) => w.type === "inductive-kick"); // prettier-ignore
  assert.ok(kick, "an inductive-kick warning");
  assert.equal(kick.comp, "u1");
  assert.ok(kick.volts > 50, `past its 50 V: ${kick.volts} V`);
});

test("ULN2003A, Spice Lite: COM on the coil's supply catches the kick", () => {
  const { b, u } = coilDriver(true);
  const sim = runner(b.doc, { engine: "spice" });
  runTo(sim, 0, 0.02, new Map([["in", H]]));
  const seen = runTo(sim, 0.02, 0.05, new Map([["in", L]]));
  assert.ok(!seen.some((x) => x.warnings.some((w) => w.type === "inductive-kick")), "no kick"); // prettier-ignore
  // The coil's current runs round its diode: the output sits a diode above
  // COM while it does, never at the transistor's breakdown.
  const out = sim.netlist.netOfPoint.get(b.at(u.get(16)));
  const peak = Math.max(...seen.map((x) => x.nodeVolts.get(out) ?? 0));
  assert.ok(peak < 14, `${peak} V`);
});
