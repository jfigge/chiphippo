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

// The 2026-10-23 grade's Spice Lite findings, each held here against the
// ngspice answer the grade measured on the same circuit (scripts/spice-deck.mjs,
// "same" flavour): a MOSFET whose gate moves between events; and the
// analyzer's curve samples catching a hump that comes and goes between two
// ticks. Then the regrade's: an RC astable on a CD4007UB's bare pairs, and
// a half-bridge's off low side freewheeling a coil through its body diode.

import test from "node:test";
import assert from "node:assert/strict";

import { partDef } from "../catalog/index.js";
import { bench, runner } from "./timing-fixtures.js";
import { GOLDEN_CASES, lastCycle } from "./spice-golden-cases.js";
import { H, L } from "../sim/levels.js";
import { driveSpice } from "../bench/drive-spice.js";
import { SCOPE_TOLERANCE, scopeSamples } from "../sim/spice/sample.js";

const near = (got, want, rel, what) =>
  assert.ok(Math.abs(got / want - 1) <= rel, `${what}: ${got} for ${want}`);

test("a MOSFET whose gate charges through a resistor switches when its gate gets there", () => {
  // 1 MΩ from 5 V into 1 µF on the gate, the drain 1 kΩ to 5 V. Told its
  // gate only at a settle, nothing woke the desk and it never switched.
  for (const [grade, ngspice] of [
    ["logic", 0.586],
    ["power", 1.304],
  ]) {
    const b = bench({ volts: 5 });
    const rg = b.seat("rg", "resistor", "a1", { ohms: 1e6 });
    const cg = b.seat("cg", "cap-electrolytic", "a6", { farads: 1e-6 });
    const m = b.seat("m", "nmos", "a10", { grade });
    const rd = b.seat("rd", "resistor", "a20", { ohms: 1e3 });
    b.vcc(rg.get(1));
    b.link(rg.get(2), cg.get(1));
    b.gnd(cg.get(2));
    b.link(cg.get(1), m.get(2));
    b.gnd(m.get(1));
    b.vcc(rd.get(1));
    b.link(rd.get(2), m.get(3));
    let fell = null;
    driveSpice(b.doc, {
      seconds: 2,
      end: true,
      onTick(now, res, inp) {
        const v = res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(m.get(3))));
        if (fell == null && v < 2.5) fell = now;
      },
    });
    assert.ok(fell != null, `${grade}: never switched`);
    near(fell, ngspice, 0.01, `${grade}: drain under 2.5 V`);
  }
});

test("a MOSFET's gate on a 10 kHz wave runs its channel along the wave, not as a square", () => {
  // The wave on the gate, the drain 1 kΩ to 5 V, and 10 kΩ into 1 µF
  // integrating how far on it was: sampled at the settles the three waves
  // all read 0.4336 V at 2.05 ms. And past each crest or apex the channel
  // runs back through the pieces it rose by — no stuck corner (taken for
  // one, the sine read 3 % short and the triangle up to 12 %).
  for (const [wave, ngspice] of [
    ["trapezoid", 0.5073],
    ["triangle", 0.6177],
    ["sine", 0.5517],
  ]) {
    const b = bench({ volts: 5 });
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 80, y: 30, params: partDef("clock").normalizeParams({ hz: 10e3, wave }) }); // prettier-ignore
    b.doc.wires.push(
      { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
      { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
      { id: "wc3", from: "clk1.out", to: b.at("j50"), color: "blue" },
    );
    const m = b.seat("m", "nmos", "a10");
    const r = b.seat("r", "resistor", "a20", { ohms: 1e3 });
    const r2 = b.seat("r2", "resistor", "a30", { ohms: 10e3 });
    const c = b.seat("c", "cap-ceramic", "a40", { farads: 1e-6 });
    b.link("f50", m.get(2));
    b.gnd(m.get(1));
    b.vcc(r.get(1));
    b.link(r.get(2), m.get(3));
    b.link(m.get(3), r2.get(1));
    b.link(r2.get(2), c.get(1));
    b.gnd(c.get(2));
    let got = null;
    driveSpice(b.doc, {
      seconds: 2.05e-3,
      at: [2.05e-3],
      end: true,
      onTick(now, res, inp) {
        if (Math.abs(now - 2.05e-3) < 1e-12) got = res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(c.get(1)))); // prettier-ignore
      },
    });
    near(got, ngspice, 0.01, wave);
  }
});

test("the analyzer's curve samples catch a hump that comes and goes between two ticks", () => {
  // A 1 Hz clock through 1 kΩ into 1 nF, and 10 nF from there into 1 kΩ
  // to ground: at each edge the far node humps to 2.225 V 1.87 µs on and is
  // gone. The stretch to the next tick's quarter points all lay on the
  // chord, and the analyzer recorded only 0 V.
  const b = bench({ volts: 5 });
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 80, y: 30, params: partDef("clock").normalizeParams({ hz: 1 }) }); // prettier-ignore
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 1e3 });
  const c1 = b.seat("c1", "cap-ceramic", "a20", { farads: 1e-9 });
  const c2 = b.seat("c2", "cap-ceramic", "a30", { farads: 10e-9 });
  const r2 = b.seat("r2", "resistor", "a40", { ohms: 1e3 });
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at("j10"), color: "blue" },
  );
  b.link("f10", r1.get(1));
  b.link(r1.get(2), c1.get(1));
  b.gnd(c1.get(2));
  b.link(c1.get(1), c2.get(1));
  b.link(c2.get(2), r2.get(1));
  b.gnd(r2.get(2));
  let edge = null;
  const run = driveSpice(b.doc, {
    seconds: 0.5,
    onTick(now, res, inp) {
      if (Math.abs(now - 0.5) < 1e-12) edge = { res, net: inp.netlist.netOfPoint.get(b.at(c2.get(2))) }; // prettier-ignore
    },
  });
  assert.ok(edge && run.ticks > 0, "no tick at the edge");
  const samples = scopeSamples(edge.res.analog, [edge.net], 0.5, 0.6, { tolerance: SCOPE_TOLERANCE * 5 }); // prettier-ignore
  const peak = Math.max(...samples.map((s) => s.volts.get(edge.net) ?? 0));
  // (2.169 V: the closed form with the brick's 50 Ω beside r1 — 2.225
  // from an ideal one; spice/output-stage.js `CLOCK_OHMS`.)
  near(peak, 2.169, 0.02, "the hump's peak");
});

test("a MOSFET's body diode is a junction's curve, not a 0.6 V knee behind 2 Ω", () => {
  // A PMOS with its source and gate on 5 V: its body diode (drain to
  // source) and an NPN's base–emitter in series to ground. ngspice with
  // the vendor cards read the node between at 4.152 V on the common body
  // diode; on the BS250's own (its sheet's curve, fitted — wave 2b,
  // spice/diodes.js MOSFET_BODIES) 4.264 V, which the solve's table reads
  // 0.9 % high. The old knee read its own 0.6 V drop and two ohms.
  const b = bench({ volts: 5 });
  b.doc.components[0].params.currentLimit = 5;
  const m = b.seat("m1", "pmos", "a1");
  const q = b.seat("q1", "npn", "a10");
  b.vcc(m.get(2));
  b.vcc(m.get(3));
  b.link(m.get(1), "f2");
  b.link(q.get(2), "f2");
  b.gnd(q.get(1));
  b.vcc(q.get(3));
  const { result, netlist } = driveSpice(b.doc, { seconds: 0 });
  near(
    result.nodeVolts.get(netlist.netOfPoint.get(b.at("f2"))),
    4.264,
    0.05,
    "between",
  );
});

test("a CD4007UB RC astable's period does not depend on how often it is ticked", () => {
  // Two of its pairs as inverters, 100 kΩ and 10 nF round them. Its flip was
  // found only at a settle — a corner where the node's group GROWS was run
  // past, the node frozen there until the next wake — so the period was the
  // wake hold's (MIN_SHOWN_S) as much as the RC's.
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "CD4007UB", "e30");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.vcc(u.get(11));
  b.gnd(u.get(9));
  b.link(u.get(8), u.get(13));
  b.link(u.get(8), u.get(10));
  b.gnd(u.get(3));
  b.vcc(u.get(2));
  b.gnd(u.get(4));
  const r = b.seat("r", "resistor", "a1", { ohms: 100e3 });
  const c = b.seat("c", "cap-ceramic", "a10", { farads: 10e-9 });
  b.link(r.get(1), u.get(8));
  b.link(r.get(2), c.get(1));
  b.link(c.get(2), u.get(12));
  b.link(r.get(2), u.get(6));
  const period = (at) => {
    const rises = [];
    let prev = null;
    driveSpice(structuredClone(b.doc), {
      seconds: 0.1,
      at,
      onTick(now, res, inp) {
        const v = res.nodeVolts.get(
          inp.netlist.netOfPoint.get(b.at(u.get(12))),
        );
        if (prev != null && prev < 2.5 && v >= 2.5) rises.push(now);
        prev = v;
      },
    });
    assert.ok(rises.length > 4, `${rises.length} rises`);
    return (rises.at(-1) - rises[1]) / (rises.length - 2);
  };
  const held = period([]);
  // A rise is seen at the tick after it, so ~55 periods over 0.1 s keep the
  // hold's 0.5 ms within half a percent (before: 2.000 ms held, 1.850 ticked).
  const dense = period(Array.from({ length: 2000 }, (_, i) => (i + 1) * 50e-6));
  near(held, dense, 0.01, "held against ticked every 50 µs");
  // ngspice 1.692 ms on the family channel's card, the gates' clamps
  // loaded (2026-10-26: the channels' square law; the straight line read
  // 1.819 ms, +7.5 %).
  near(held, 1.692e-3, 0.02, "the period");
});

test("a half-bridge freewheeling through its off side's body diode is no short", () => {
  // A PMOS high side on a 1 kHz trapezoid, its NMOS low side held off, into
  // 10 mH and 10 Ω. As the high side turns off the coil's current runs on
  // through the NMOS's body diode; read as a channel turned ON, the digital
  // side joined the rails through the two and warned a short and a conflict
  // at every tick in the edge. ngspice shows none.
  const b = bench({ volts: 12 });
  b.doc.components[0].params.currentLimit = 10;
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 80, y: 30, params: partDef("clock").normalizeParams({ hz: 1e3, wave: "trapezoid" }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at("j50"), color: "blue" },
  );
  const p = b.seat("p1", "pmos", "a10", { grade: "logic-power" });
  const n = b.seat("n1", "nmos", "a20", { grade: "logic-power" });
  const l = b.seat("l1", "inductor", "a30", { henries: 10e-3 });
  const r = b.seat("r1", "resistor", "a40", { ohms: 10 });
  b.vcc(p.get(1));
  b.link("f50", p.get(2));
  b.link(p.get(3), n.get(3));
  b.gnd(n.get(1));
  b.gnd(n.get(2));
  b.link(n.get(3), l.get(1));
  b.link(l.get(2), r.get(1));
  b.gnd(r.get(2));
  const warned = [];
  let low = Infinity;
  driveSpice(b.doc, {
    seconds: 0.012,
    at: Array.from({ length: 400 }, (_, i) => 0.01 + i * 5e-6),
    onTick(now, res, inp) {
      low = Math.min(
        low,
        res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(n.get(3)))),
      );
      for (const w of res.warnings ?? []) {
        if (/short|conflict/.test(w.type))
          warned.push(`${now}: ${w.type} ${w.net}`);
      }
    },
  });
  assert.ok(low < -0.5, `the body diode never carried the coil (${low} V)`);
  assert.deepEqual(warned.slice(0, 4), []);
});

test("a MOSFET ring ticked at its own wakes keeps ngspice's rhythm", () => {
  // Three 2N7000 inverters round 10 kΩ / 100 nF, a CD4069UB on q1's drain
  // (the golden suite's mosfet-ring-10k-100n). Ticked at its own wakes,
  // its gates came out of every channel piece GROWING — each a settle,
  // spent from the island's 32 a tick, so the tick capped and the island
  // backed off as a chatter (a period of 14.5 ms); and a crossing on the
  // drain after a run of corners was taken up to 58 µs past the tick that
  // showed it (the HIGH half −3.6 %). ngspice: HIGH 1.474 ms of 3.068.
  const c = GOLDEN_CASES.find((x) => x.id === "mosfet-ring-10k-100n");
  const { doc, at } = c.build();
  const sim = runner(doc, { engine: "spice" });
  const out = sim.netlist.netOfPoint.get(at.out);
  let t = 0;
  let r = sim.run(0).result;
  let level = null;
  const edges = [];
  while (r.wakeAt != null && r.wakeAt <= 0.015) {
    t = r.wakeAt;
    r = sim.run(t).result;
    assert.equal(r.analog.chatters?.length ?? 0, 0, `chattering at ${t}`);
    const now = r.netLevels.get(out);
    if ((now === H || now === L) && level != null && now !== level) edges.push([t, now === H]); // prettier-ignore
    if (now === H || now === L) level = now;
  }
  const cycle = lastCycle(edges);
  near(cycle.period, 3.068e-3, 0.01, "the period");
  near(cycle.high, 1.474e-3, 0.01, "the HIGH half");
});
