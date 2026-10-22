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

// The 2026-10-21 appraisal's logic-engine findings, each held here: two idle
// latches on one desk, a latch beside a ring oscillator, a schedule with no
// end, a timing part on a regulator's rail and a value the parser refused.

import test from "node:test";
import assert from "node:assert/strict";

import { buildNetlist } from "../sim/netlist.js";
import { settle } from "../sim/engine.js";
import { scheduleAt } from "../sim/timing.js";
import { rcTrace } from "../sim/rc-trace.js";
import { chipDef, partDef } from "../catalog/index.js";
import { evaluate } from "../sim/chip-eval.js";
import { framebufferOf, hd44780Unit } from "../sim/hd44780.js";
import { w65c21Unit } from "../sim/w65c21.js";
import { CGROM_A00 } from "../sim/hd44780-cgrom.js";
import { astable555, bench, runner } from "./timing-fixtures.js";
import { powered } from "./incremental-fixtures.js";

/** A cross-coupled NAND latch of a 74LS00's gates 1/2→3 and 4/5→6 (Q is
    pin 3) and, with `second`, another of 9/10→8 and 12/13→11 — every set
    and reset input tied HIGH, idle. */
function latches(b, second) {
  const n = powered(b, "u1", "74LS00", "e10");
  b.vcc(n.get(1));
  b.vcc(n.get(5));
  b.link(n.get(3), n.get(4));
  b.link(n.get(6), n.get(2));
  if (second) {
    b.vcc(n.get(9));
    b.vcc(n.get(13));
    b.link(n.get(8), n.get(12));
    b.link(n.get(11), n.get(10));
  }
  return n;
}

test("two idle latches on one desk each settle one way", () => {
  // One LOW seed settled the first latch; the second, all HIGH, raced on,
  // and the tie was given up: both X for good.
  for (const mode of ["incremental", "full"]) {
    const b = bench();
    const n = latches(b, true);
    const netlist = buildNetlist(b.doc);
    const r = settle({ document: b.doc, netlist, mode });
    assert.equal(r.settled, true, mode);
    const at = (pin) =>
      r.netLevels.get(netlist.netOfPoint.get(b.at(n.get(pin))));
    for (const [q, qb] of [
      [3, 6],
      [8, 11],
    ]) {
      assert.ok(["H", "L"].includes(at(q)), `${mode}: pin ${q} ${at(q)}`);
      assert.notEqual(at(q), at(qb), `${mode}: pins ${q} and ${qb}`);
    }
  }
});

test("a latch beside a ring oscillator settles, and the ring is still reported", () => {
  const b = bench();
  const n = latches(b, false);
  const inv = powered(b, "u2", "74LS04", "e30");
  b.link(inv.get(2), inv.get(1));
  const netlist = buildNetlist(b.doc);
  const r = settle({ document: b.doc, netlist });
  const at = (pin) => r.netLevels.get(netlist.netOfPoint.get(b.at(n.get(pin))));
  assert.ok(["H", "L"].includes(at(3)), `Q ${at(3)}`);
  assert.notEqual(at(3), at(6));
  const osc = r.warnings.find((w) => w.type === "oscillation");
  assert.deepEqual(osc?.nets, [netlist.netOfPoint.get(b.at(inv.get(1)))]);
});

test("a schedule with no end stands still rather than walking forever", () => {
  assert.deepEqual(scheduleAt({ cycle: [Infinity, Infinity], lead: [] }, 0, 1), { index: 0, next: Infinity }); // prettier-ignore
  // 1e200 Ω on 1e200 F: plain numbers a document can hold, an endless period.
  const { doc } = astable555({ ra: 1e200, rb: 1e200, c: 1e200 });
  const sim = runner(doc);
  sim.run(0);
  sim.run(1);
});

/** The 555 astable at RA 1 kΩ, RB 10 kΩ, 10 µF, its VCC, RESET and RA off
    a 7805 fed from 9 V. */
function regulated555() {
  const b = bench({ volts: 9 });
  const u = b.seat("u1", "NE555", "e10");
  const g = b.seat("g1", "LM7805", "a55");
  const p = partDef("LM7805").regulator.pins;
  b.vcc(g.get(p.inp));
  b.gnd(g.get(p.ref));
  const toVcc = (h) => b.link(g.get(p.out), h);
  toVcc(u.get(8));
  b.gnd(u.get(1));
  toVcc(u.get(4));
  b.link(u.get(2), u.get(6));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: 10e-6 });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const rB = b.seat("r2", "resistor", "a40", { ohms: 10000 });
  b.link(rB.get(1), u.get(7));
  b.link(rB.get(2), u.get(6));
  const rA = b.seat("r1", "resistor", "a47", { ohms: 1000 });
  b.link(rA.get(1), u.get(7));
  toVcc(rA.get(2));
  return { b, u };
}

test("a 555 on a regulator's rail times as one on a PSU's", () => {
  // Only a PSU's + counted as VCC: "no resistor to VCC", OUT stuck LOW.
  const { b, u } = regulated555();
  const sim = runner(b.doc);
  const levels = [0, 0.05, 0.1, 0.13, 0.15].map((t) => sim.run(t).level(u.get(3))); // prettier-ignore
  const timing = sim.result.chipStatus?.get?.("u1");
  assert.ok(levels.includes("H") && levels.includes("L"), levels.join());
  assert.notEqual(timing?.status, "unpowered");
  const trace = rcTrace(b.doc, sim.netlist);
  const out = sim.netlist.netOfPoint.get(b.at(u.get(8)));
  assert.equal(trace.toRail("+")(out), true);
  assert.equal(trace.supplyVolts(out), 5);
  // …but not a rail: under Spice Lite the solve holds it.
  assert.equal(trace.rail(out), null);
});

test("a capacitor value the parser refused times nothing", () => {
  // Kept as typed, "0x10" read through Number timed the 555 on 16 F.
  const { doc } = astable555({ ra: 1000, rb: 10000, c: 10e-6 });
  doc.components.find((c) => c.id === "c1").params.farads = "0x10";
  const netlist = buildNetlist(doc);
  const caps = [...rcTrace(doc, netlist).capacitors(netlist.netOfPoint.get("bb1.a30"))]; // prettier-ignore
  assert.deepEqual(caps, []);
});

test("the rails shorted say short, not every chip turned round", () => {
  // Its VCC net carried a − and its GND net a +, both through the short.
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  b.doc.wires.push({ id: "wx", from: "psu1.+", to: "psu1.-", color: "red" });
  const r = settle({ document: b.doc, netlist: buildNetlist(b.doc) });
  assert.ok(u);
  assert.equal(r.chipStatus.get("u1").status, "unpowered");
  assert.ok(r.warnings.some((w) => w.type === "short"));
  assert.ok(!r.warnings.some((w) => w.type === "reversed"));
});

test("an LM317 whose R2 is two resistors in series powers what is on OUT", () => {
  // 240 Ω and 330 + 390 Ω: 5.04 V. Read off its own resistors only, the
  // series pair set nothing, and the 74LS04 on OUT was unpowered unsaid.
  const b = bench({ volts: 9 });
  const g = b.seat("g1", "LM317", "a50"); // ADJ 1 · OUT 2 · IN 3
  b.vcc(g.get(3));
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 240 });
  b.link(r1.get(1), g.get(2));
  b.link(r1.get(2), g.get(1));
  const r2a = b.seat("r2a", "resistor", "a40", { ohms: 330 });
  const r2b = b.seat("r2b", "resistor", "f40", { ohms: 390 });
  b.link(r2a.get(1), g.get(1));
  b.link(r2a.get(2), r2b.get(1));
  b.gnd(r2b.get(2));
  const u = b.seat("u1", "74LS04", "e10");
  b.link(g.get(2), u.get(14));
  b.gnd(u.get(7));
  const r = runner(b.doc).run(0).result;
  assert.equal(r.chipStatus.get("u1").status, "ok");
});

test("a 4047 astable let out of reset holds Q LOW until OSC next rises", () => {
  // 10 kΩ, 1 µF: OSC rose at 46.8 ms, rises next at 68.8 ms. RESET let go
  // at 50 ms put Q HIGH at once — half a cycle early — and inverted after.
  const b = bench();
  const u = b.seat("u1", "CD4047B", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.link(r.get(1), u.get(2));
  b.link(r.get(2), u.get(3));
  const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
  b.link(c.get(1), u.get(1));
  b.link(c.get(2), u.get(3));
  b.vcc(u.get(5));
  b.vcc(u.get(4));
  b.gnd(u.get(6));
  b.gnd(u.get(8));
  b.gnd(u.get(12));
  b.signal("rst", u.get(9), "low");
  const sim = runner(b.doc);
  const q = (t, rst) => sim.run(t, new Map([["rst", rst]])).level(u.get(10));
  for (const t of [0, 0.03, 0.047]) assert.equal(q(t, "H"), "L", `${t} s`);
  for (const t of [0.05, 0.06, 0.0687]) assert.equal(q(t, "L"), "L", `${t} s`);
  assert.equal(q(0.069, "L"), "H");
  assert.equal(q(0.08, "L"), "H");
  assert.equal(q(0.091, "L"), "L");
});

test("a 4060 counts its external clock with an indicator on φ̄O", () => {
  // Any resistor on φ̄O read as an oscillator half built: an LED there (and
  // its resistor) left it "incomplete", counting nothing.
  const b = bench();
  const u = b.seat("u1", "CD4060B", "e10");
  b.vcc(u.get(16));
  b.gnd(u.get(8));
  b.gnd(u.get(12));
  b.signal("clk", u.get(11), "low");
  const r = b.seat("r1", "resistor", "a30", { ohms: 1000 });
  b.link(r.get(1), u.get(10));
  const d = b.seat("d1", "led", "a40");
  b.link(d.get(1), r.get(2));
  b.gnd(d.get(2));
  const sim = runner(b.doc);
  let res;
  for (let k = 0; k < 16; k++) {
    sim.run(k * 0.01, new Map([["clk", "H"]]));
    res = sim.run(k * 0.01 + 0.005, new Map([["clk", "L"]])).result;
  }
  assert.equal(res.timing.get("u1").sections[0].mode, "external");
  assert.equal(sim.level(u.get(5)), "H"); // Q5: 16 counts
});

test("a 555 astable with a diode across RB is refused, not misread", () => {
  // The 50 % build: read as RA + RB it timed a duty of ⅔.
  const { doc, u, b } = astable555({ ra: 10000, rb: 10000, c: 10e-6 });
  const d = b.seat("d1", "diode", "a60");
  b.link(d.get(1), u.get(7));
  b.link(d.get(2), u.get(6));
  const t = runner(doc).run(0).result.timing.get("u1");
  assert.equal(t.sections[0].mode, null);
  assert.deepEqual(t.problems, [{ code: "ne555Unrecognised" }]);
});

test("a 74LS47 whose BI may be LOW lights nothing for certain, lamp test or not", () => {
  // BI beats LT on the sheet; an unknown BI with LT LOW lit every segment.
  const def = chipDef("74LS47");
  const pins = new Map([[7, "L"], [1, "L"], [2, "L"], [6, "L"], [3, "L"], [4, "X"], [5, "H"]]); // prettier-ignore
  const out = evaluate(def, pins);
  for (const seg of [13, 12, 11, 10, 9, 15, 14]) assert.equal(out.get(seg), "X", `pin ${seg}`); // prettier-ignore
});

test("an HD44780 left in 1-line mode shows one line of 80, and its second row dark", () => {
  // Function set N = 0: its one line is 0x00–0x4F; the panel's second row
  // was drawn from 0x40 as though N were 1.
  const pins = { rs: 1, rw: 2, e: 3, db: [11, 12, 13, 14, 15, 16, 17, 18] };
  const u = hd44780Unit(pins);
  let s = u.state0();
  const lv = new Map([[1, "L"], [2, "L"], [3, "L"]]); // prettier-ignore
  const xfer = (rs, byte) => {
    lv.set(1, rs ? "H" : "L");
    pins.db.forEach((p, i) => lv.set(p, (byte >> i) & 1 ? "H" : "L"));
    let prev = new Map(lv);
    lv.set(3, "H");
    s = u.step(s, lv, prev);
    prev = new Map(lv);
    lv.set(3, "L");
    s = u.step(s, lv, prev);
  };
  xfer(0, 0x30); // 8-bit, ONE line
  xfer(0, 0x0c);
  xfer(0, 0x01);
  const text =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()-=";
  for (const ch of text) xfer(1, ch.charCodeAt(0));
  const fb = framebufferOf(s, { cols: 16, rows: 2 });
  const row = (r) =>
    String.fromCharCode(...fb.chars.slice(r * 16, r * 16 + 16));
  assert.equal(row(0), "0123456789ABCDEF");
  assert.equal(row(1), " ".repeat(16));
  // A display shift turns the whole 80: 40 left shows the 41st character.
  for (let k = 0; k < 40; k++) xfer(0, 0x18);
  assert.equal(String.fromCharCode(...framebufferOf(s, { cols: 16, rows: 2 }).chars.slice(0, 4)), text.slice(40, 44)); // prettier-ignore
});

test("a W65C21's IRQA2 flag reads 0 once CA2 is made an output", () => {
  const pins = { pa: [1, 2, 3, 4, 5, 6, 7, 8], pb: [11, 12, 13, 14, 15, 16, 17, 18], d: [21, 22, 23, 24, 25, 26, 27, 28], ca1: 31, ca2: 32, cb1: 33, cb2: 34, rs0: 41, rs1: 42, cs0: 43, cs1: 44, cs2b: 45, rwb: 46, phi2: 47, resb: 48, irqab: 49, irqbb: 50 }; // prettier-ignore
  const u = w65c21Unit(pins);
  let s = u.state0();
  const lv = new Map();
  for (let p = 1; p <= 50; p++) lv.set(p, "H");
  lv.set(47, "L");
  lv.set(43, "L");
  const edge = (patch) => {
    const prev = new Map(lv);
    for (const [k, v] of Object.entries(patch)) lv.set(+k, v);
    s = u.step(s, lv, prev);
  };
  const cycle = (bus) => {
    const sel = { 43: "H", 44: "H", 45: "L", 46: bus.write ? "L" : "H", 41: bus.reg & 1 ? "H" : "L", 42: bus.reg & 2 ? "H" : "L" }; // prettier-ignore
    if (bus.write) pins.d.forEach((p, i) => (sel[p] = (bus.data >> i) & 1 ? "H" : "L")); // prettier-ignore
    edge(sel);
    edge({ 47: "H" });
    let v = null;
    if (!bus.write) {
      const o = u.outputs(s, lv);
      v = pins.d.reduce((n, p, i) => n | ((o.get(p) === "H" ? 1 : 0) << i), 0);
    }
    edge({ 47: "L" });
    return v;
  };
  cycle({ reg: 1, write: true, data: 0x04 }); // CA2 an input, falling edge
  edge({ 32: "L" });
  edge({ 32: "H" });
  assert.equal(cycle({ reg: 1 }) & 0x40, 0x40, "the edge flagged");
  cycle({ reg: 1, write: true, data: 0x3c }); // CA2 an output, held HIGH
  assert.equal(cycle({ reg: 1 }) & 0x40, 0);
});

test("no LCD font glyph draws on the cursor's row", () => {
  // g, p, q and y had their tails on the eighth row, under the cursor.
  for (const [code, rows] of Object.entries(CGROM_A00)) {
    assert.equal(rows[7], 0, `0x${Number(code).toString(16)}`);
  }
});

test("a counter that loses its power comes back at zero, not where it was", () => {
  const b = bench();
  const u = b.seat("u1", "74LS161", "e10");
  b.vcc(u.get(16));
  b.gnd(u.get(8));
  b.signal("clk", u.get(2), "low");
  const feed = b.doc.wires.find((w) => w.from === "psu1.+");
  const sim = runner(b.doc);
  const count = () => [14, 13, 12, 11].reduce((n, p, i) => n + (sim.level(u.get(p)) === "H" ? 1 << i : 0), 0); // prettier-ignore
  let t = 0;
  const pulse = () => {
    sim.run((t += 0.01), new Map([["clk", "H"]]));
    sim.run((t += 0.01), new Map([["clk", "L"]]));
  };
  sim.run(0, new Map([["clk", "L"]]));
  for (let i = 0; i < 5; i++) pulse();
  assert.equal(count(), 5);
  b.doc.wires = b.doc.wires.filter((w) => w !== feed); // power off
  sim.rebuild();
  assert.equal(sim.run((t += 0.01), new Map([["clk", "L"]])).result.chipStatus.get("u1").status, "unpowered"); // prettier-ignore
  b.doc.wires.push(feed); // and on again
  sim.rebuild();
  sim.run((t += 0.01), new Map([["clk", "L"]]));
  assert.equal(count(), 0);
});

test("an output driven against a supply rail is reported, wired or through a diode", () => {
  // The supply wins the level, as on the bench, but the output is fighting
  // it (Spice Lite: 152 mA into a 74LS04's LOW — its output overloaded, the
  // diode within its rating). A wire straight to the rail said nothing.
  for (const via of ["wire", "diode"]) {
    const b = bench();
    const u = powered(b, "u1", "74LS04", "e10");
    b.vcc(u.get(3)); // output 4 LOW
    if (via === "wire") b.vcc(u.get(4));
    else {
      const d = b.seat("d1", "diode", "a30");
      b.vcc(d.get(1));
      b.link(d.get(2), u.get(4));
    }
    const netlist = buildNetlist(b.doc);
    const net = netlist.netOfPoint.get(b.at(u.get(4)));
    for (const mode of ["incremental", "full"]) {
      const r = settle({ document: b.doc, netlist, mode });
      assert.ok(r.warnings.some((w) => w.type === "conflict" && w.net === net), `${via}, ${mode}: ${JSON.stringify(r.warnings)}`); // prettier-ignore
    }
  }
});

test("an unknown level through a resistor is unknown at the input behind it", () => {
  // Two signals fighting (X) feed a 74LS04 and a CD4069UB each through
  // 1 kΩ. Read as nothing pulling, the 74LS input read a clean HIGH and the
  // CMOS one was told it floated.
  for (const mode of ["incremental", "full"]) {
    const b = bench();
    const ls = powered(b, "u1", "74LS04", "e10");
    const cm = powered(b, "u2", "CD4069UB", "e20");
    const r1 = b.seat("r1", "resistor", "a40", { ohms: 1000 });
    const r2 = b.seat("r2", "resistor", "j40", { ohms: 1000 });
    b.signal("s1", r1.get(1), "low");
    b.signal("s2", r1.get(1), "high");
    b.link(r1.get(1), r2.get(1));
    b.link(r1.get(2), ls.get(1));
    b.link(r2.get(2), cm.get(1));
    const netlist = buildNetlist(b.doc);
    const r = settle({ document: b.doc, netlist, mode, signalLevels: new Map([["s1", "L"], ["s2", "H"]]) }); // prettier-ignore
    const at = (hole) => r.netLevels.get(netlist.netOfPoint.get(b.at(hole)));
    assert.equal(at(ls.get(1)), "X", mode);
    assert.equal(at(ls.get(2)), "X", mode);
    assert.equal(at(cm.get(1)), "X", mode);
    const floating = r.warnings.find((w) => w.type === "floating-input" && w.chip === "u2"); // prettier-ignore
    assert.ok(!floating?.pins.includes(1), `${mode}: ${JSON.stringify(floating)}`); // prettier-ignore
  }
});

test("a wired-AND with one open-collector output unknown and one LOW is LOW", () => {
  // A 74LS05 whose first input is fought (X) beside its second, sinking:
  // the net is LOW whether the unknown one sinks too or lets go — pulled up
  // or not. It read X with a conflict.
  for (const pullUp of [true, false]) {
    for (const mode of ["incremental", "full"]) {
      const b = bench();
      const u = powered(b, "u1", "74LS05", "e10");
      b.signal("s1", u.get(1), "low");
      b.signal("s2", u.get(1), "high");
      b.vcc(u.get(3));
      b.link(u.get(2), u.get(4));
      if (pullUp) {
        const r1 = b.seat("r1", "resistor", "a40", { ohms: 4700 });
        b.link(r1.get(1), u.get(2));
        b.vcc(r1.get(2));
      }
      const netlist = buildNetlist(b.doc);
      const r = settle({ document: b.doc, netlist, mode, signalLevels: new Map([["s1", "L"], ["s2", "H"]]) }); // prettier-ignore
      const net = netlist.netOfPoint.get(b.at(u.get(2)));
      assert.equal(r.netLevels.get(net), "L", `${mode}, pull-up ${pullUp}`);
      assert.ok(!r.warnings.some((w) => w.net === net), `${mode}, pull-up ${pullUp}`); // prettier-ignore
    }
  }
});

test("a resistor-feedback Schmitt trigger follows its input — its own X does not latch it", () => {
  // Two inverters of a 74LS04, the input through 10 kΩ to 1A, 2Y back
  // through 100 kΩ to 1A. With an X pulling X beside the input's H, the
  // net went X the first time the two disagreed and pulled itself X for
  // good: L, X, X, X, X.
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const ri = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  const rf = b.seat("r2", "resistor", "a40", { ohms: 100e3 });
  b.signal("s1", ri.get(1));
  b.link(ri.get(2), u.get(1));
  b.link(u.get(2), u.get(3));
  b.link(rf.get(1), u.get(4));
  b.link(rf.get(2), u.get(1));
  const r = runner(b.doc);
  const seq = ["L", "H", "L", "H", "L"];
  const got = seq.map((s, i) => {
    const run = r.run(i * 0.01, new Map([["s1", s]]));
    return `${run.level(u.get(1))}${run.level(u.get(4))}`;
  });
  assert.deepEqual(got, ["LL", "HH", "LL", "HH", "LL"]);
});

test("a 555 off an LM317 whose R2 is two resistors in series is timed, as the engine powers it", () => {
  // 12 V → LM317, R1 240 Ω, R2 330 + 390 Ω: 5.0 V. The engine read R2
  // through the trace and powered the 555; its timing read the rail without
  // it, found no supply on OUT, and said "no resistor DISCH → VCC".
  const b = bench({ volts: 12 });
  const reg = b.seat("q1", "LM317", "j3"); // ADJ, OUT, IN
  b.vcc(reg.get(3));
  const r1 = b.seat("r10", "resistor", "j10", { ohms: 240 });
  b.link(r1.get(1), reg.get(2));
  b.link(r1.get(2), reg.get(1));
  const ra = b.seat("r11", "resistor", "j20", { ohms: 330 });
  const rb = b.seat("r12", "resistor", "j30", { ohms: 390 });
  b.link(ra.get(1), reg.get(1));
  b.link(ra.get(2), rb.get(1));
  b.gnd(rb.get(2));
  const u = b.seat("u1", "NE555", "e40");
  b.link(u.get(8), reg.get(2));
  b.gnd(u.get(1));
  b.link(u.get(4), reg.get(2));
  b.link(u.get(2), u.get(6));
  const cap = b.seat("c1", "cap-electrolytic", "a50", { farads: 1e-5 });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const rB = b.seat("r2", "resistor", "a55", { ohms: 10000 });
  b.link(rB.get(1), u.get(7));
  b.link(rB.get(2), u.get(6));
  const rA = b.seat("r1", "resistor", "j45", { ohms: 10000 });
  b.link(rA.get(1), u.get(7));
  b.link(rA.get(2), reg.get(2));
  const run = runner(b.doc).run(0);
  assert.equal(run.result.chipStatus.get("u1").status, "ok");
  assert.deepEqual(run.result.timing.get("u1").problems, []);
  assert.equal(run.result.timing.get("u1").sections[0].mode, "astable");
  assert.equal(run.level(u.get(3)), "H", "its first HIGH");
});

test("a CD4060B clocked on φI with a load from φ̄O to GND still counts", () => {
  // A 10 k pull-down on φI and a 1 k load on φ̄O meet on the − rail, which
  // `halfBuilt` took for the junction between Rx and Rs: "incomplete", and
  // the external clock counted nothing.
  const b = bench();
  const u = b.seat("u1", "CD4060B", "e10");
  b.vcc(u.get(16));
  b.gnd(u.get(8));
  b.gnd(u.get(12));
  const pd = b.seat("r1", "resistor", "a40", { ohms: 10000 });
  b.link(pd.get(1), u.get(11));
  b.gnd(pd.get(2));
  b.signal("s1", u.get(11));
  const rl = b.seat("r2", "resistor", "a50", { ohms: 1000 });
  b.link(rl.get(1), u.get(10));
  b.gnd(rl.get(2));
  const r = runner(b.doc);
  let t = 0;
  for (let i = 0; i < 8; i++) {
    r.run((t += 0.01), new Map([["s1", "H"]]));
    r.run((t += 0.01), new Map([["s1", "L"]]));
  }
  assert.deepEqual(r.result.timing.get("u1").sections, [{ mode: "external", pin: "φI (11)" }]); // prettier-ignore
  assert.equal(r.level(u.get(7)), "H", "Q4 after eight counts");
});

test("an output's HIGH forward through a diode into the − rail is a fight, as + through one onto its LOW is", () => {
  // The output shorted to ground through the diode: silent, where the
  // mirror case (+ → diode → a LOW) said `conflict`. A clamp the right way
  // round (− → diode → the output, the output → diode → +) stays quiet.
  const desk = (wire, high) => {
    const b = bench();
    const u = b.seat("u1", "74LS04", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    (high ? b.gnd : b.vcc)(u.get(1));
    const d = b.seat("d1", "diode", "a30");
    wire(b, u, d);
    const run = runner(b.doc).run(0);
    return { level: run.level(u.get(2)), fight: run.result.warnings.some((w) => w.type === "conflict") }; // prettier-ignore
  };
  const intoGround = (b, u, d) => {
    b.link(d.get(1), u.get(2));
    b.gnd(d.get(2));
  };
  const fromPlus = (b, u, d) => {
    b.vcc(d.get(1));
    b.link(d.get(2), u.get(2));
  };
  assert.deepEqual(desk(intoGround, true), { level: "X", fight: true });
  assert.deepEqual(desk(fromPlus, false), { level: "X", fight: true });
  // The clamps: an output LOW into a diode to −, HIGH into one from +.
  assert.deepEqual(desk(intoGround, false), { level: "L", fight: false });
  assert.deepEqual(desk(fromPlus, true), { level: "H", fight: false });
});

test("ten idle NAND latches on five 74LS00s all settle — one tie broken in each knot at once", () => {
  // One racing net LOW a round, four rounds: six latches left two X for
  // good, the oscillation said on the first tick only.
  const b = bench();
  const chips = [];
  for (let k = 0; k < 5; k++) {
    const u = b.seat(`u${k}`, "74LS00", `e${5 + k * 12}`);
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    b.link(u.get(3), u.get(5));
    b.link(u.get(6), u.get(2));
    b.link(u.get(8), u.get(13));
    b.link(u.get(11), u.get(10));
    chips.push(u);
  }
  const r = runner(b.doc);
  for (const t of [0, 0.01]) {
    const { result, level } = r.run(t);
    assert.ok(!result.warnings.some((w) => w.type === "oscillation"), `at ${t}`); // prettier-ignore
    for (const u of chips) {
      for (const [p, q] of [
        [3, 6],
        [8, 11],
      ]) {
        // prettier-ignore
        const pair = [level(u.get(p)), level(u.get(q))].sort().join("");
        assert.equal(pair, "HL", `a latch at rest, ${t} s`);
      }
    }
  }
});

// ── Unknown triggers, read every way they could be (2026-10-22 regrade) ─────

test("a 555 monostable whose TRIG goes unknown mid-pulse keeps its pulse; one unknown while idle is a pulse in doubt, then LOW", () => {
  const logic = chipDef("NE555").logic;
  const env = (now) => ({ now, timing: { sections: [{ mode: "monostable", width: 0.1 }] } }); // prettier-ignore
  const pins = (trig) => new Map([[2, trig], [4, "H"]]); // prettier-ignore
  const out = (s) => logic.outputs(s).get(3);
  // Triggered, then TRIG unknown, then HIGH again: the pulse runs to 0.1 s.
  let s = logic.step(logic.state0(), pins("L"), pins("H"), env(0));
  s = logic.step(s, pins("H"), pins("L"), env(0.01));
  s = logic.step(s, pins("X"), pins("H"), env(0.03));
  assert.equal(out(s), "H", "still timing");
  s = logic.step(s, pins("H"), pins("X"), env(0.05));
  assert.equal(out(s), "H", "it was lost here");
  s = logic.step(s, pins("H"), pins("H"), env(0.1));
  assert.equal(out(s), "L", "and ends on time");
  // Idle, TRIG unknown at 1 s and HIGH from 1.02 s: a pulse may have started
  // as late as 1.02 s — X to 1.12 s, LOW from then.
  s = logic.step(s, pins("X"), pins("H"), env(1));
  assert.equal(out(s), "X");
  s = logic.step(s, pins("X"), pins("X"), env(1.02));
  s = logic.step(s, pins("H"), pins("X"), env(1.02));
  assert.equal(out(s), "X", "a pulse in doubt");
  assert.ok(Math.abs(logic.wakeAt(s) - 1.12) < 1e-9, `woken at ${logic.wakeAt(s)}`); // prettier-ignore
  s = logic.step(s, pins("H"), pins("H"), env(1.12));
  assert.equal(out(s), "L", "and over");
});

test("a CD4098B section: LOW, unknown, HIGH is a trigger; an unknown trigger mid-pulse may stretch it", () => {
  const logic = chipDef("CD4098B").logic;
  const timing = { sections: [{ mode: "monostable", width: 0.1 }, { mode: null }] }; // prettier-ignore
  const env = (now) => ({ now, timing });
  // Section 1: +TR 4, −TR 5 held HIGH (leading-edge), RESET 3 HIGH, Q 6.
  const pins = (plus) => new Map([[3, "H"], [4, plus], [5, "H"]]); // prettier-ignore
  const q = (s) => logic.outputs(s).get(6);
  let s = logic.step(logic.state0(), pins("L"), pins("L"), env(0));
  s = logic.step(s, pins("X"), pins("L"), env(0.01));
  assert.equal(q(s), "X", "a pulse in doubt");
  s = logic.step(s, pins("H"), pins("X"), env(0.02));
  assert.equal(q(s), "H", "it rose: a pulse");
  // An unknown trigger at 0.05 s may have retriggered it to 0.15 s.
  s = logic.step(s, pins("X"), pins("H"), env(0.05));
  s = logic.step(s, pins("H"), pins("X"), env(0.06));
  s = logic.step(s, pins("H"), pins("H"), env(0.12));
  assert.equal(q(s), "X", "past its own end, in doubt");
  s = logic.step(s, pins("H"), pins("H"), env(0.16));
  assert.equal(q(s), "L", "LOW for certain once that is up");
});

test("a CD4047B monostable: +TRIGGER LOW, unknown, HIGH starts a pulse", () => {
  const logic = chipDef("CD4047B").logic;
  const timing = { sections: [{ mode: "multivibrator", r: 10e3, c: 10e-6, width: 0.248 }] }; // prettier-ignore
  const env = (now) => ({ now, timing });
  // ASTABLE (5) LOW, ASTABLE̅ (4) HIGH: monostable. −TRIG (6) LOW, RESET (9)
  // LOW, RETRIGGER (12) LOW; +TRIG (8) the trigger. Q is 10.
  const pins = (trig) => new Map([[4, "H"], [5, "L"], [6, "L"], [8, trig], [9, "L"], [12, "L"]]); // prettier-ignore
  const q = (s) => logic.outputs(s).get(10);
  let s = logic.step(logic.state0(), pins("L"), pins("L"), env(0));
  s = logic.step(s, pins("X"), pins("L"), env(0.01));
  assert.equal(q(s), "X", "a pulse in doubt");
  s = logic.step(s, pins("H"), pins("X"), env(0.02));
  assert.equal(q(s), "H", "it rose: a pulse (it started none)");
});

test("a 555 monostable's TRIG unknown for a long stretch may start a pulse as late as its end", () => {
  // Ticked only where TRIG changes, as SimController ticks it: the doubt runs
  // to a pulse width past the moment TRIG is known again, not past the tick
  // the stretch began (it went LOW at 1.11 s, mid-doubt).
  const logic = chipDef("NE555").logic;
  const env = (now) => ({ now, timing: { sections: [{ mode: "monostable", width: 0.11 }] } }); // prettier-ignore
  const pins = (trig, reset = "H") => new Map([[2, trig], [4, reset]]); // prettier-ignore
  const out = (s) => logic.outputs(s).get(3);
  let s = logic.step(logic.state0(), pins("H"), pins("H"), env(0));
  s = logic.step(s, pins("X"), pins("H"), env(1));
  assert.equal(out(s), "X");
  s = logic.step(s, pins("H"), pins("X"), env(1.3));
  assert.equal(out(s), "X", "still in doubt when TRIG is known");
  assert.ok(Math.abs(logic.wakeAt(s) - 1.41) < 1e-9, `woken at ${logic.wakeAt(s)}`); // prettier-ignore
  s = logic.step(s, pins("H"), pins("H"), env(1.41));
  assert.equal(out(s), "L");
  // Out of the stretch LOW: HIGH while TRIG holds it, then X to a width past
  // the fall (it began somewhere in the stretch), then LOW.
  s = logic.step(s, pins("X"), pins("H"), env(2));
  s = logic.step(s, pins("L"), pins("X"), env(2.3));
  assert.equal(out(s), "H");
  s = logic.step(s, pins("H"), pins("L"), env(2.35));
  assert.equal(out(s), "X", "it may have begun at 2 s");
  s = logic.step(s, pins("H"), pins("H"), env(2.41));
  assert.equal(out(s), "L");
});

test("a 555 whose RESET may be held: X where the run would be HIGH, never certain after", () => {
  const logic = chipDef("NE555").logic;
  const mono = (now) => ({ now, timing: { sections: [{ mode: "monostable", width: 0.11 }] } }); // prettier-ignore
  const pins = (trig, reset) => new Map([[2, trig], [4, reset]]); // prettier-ignore
  const out = (s) => logic.outputs(s).get(3);
  // Mid-pulse: X from the unknown RESET to the pulse's own end, then LOW.
  let s = logic.step(logic.state0(), pins("L"), pins("H", "H"), mono(0.1));
  s = logic.step(s, pins("H", "H"), pins("L", "H"), mono(0.11));
  s = logic.step(s, pins("H", "X"), pins("H", "H"), mono(0.15));
  assert.equal(out(s), "X");
  s = logic.step(s, pins("H", "H"), pins("H", "X"), mono(0.17));
  assert.equal(out(s), "X", "the pulse may still be running");
  s = logic.step(s, pins("H", "H"), pins("H", "H"), mono(0.21));
  assert.equal(out(s), "L");
  // Idle: LOW either way.
  s = logic.step(s, pins("H", "X"), pins("H", "H"), mono(0.3));
  assert.equal(out(s), "L", "idle, held or not, it is LOW");
  // An astable may have been restarted at any moment: its phase is lost
  // until a clean RESET.
  const ast = (now) => ({ now, timing: { sections: [{ mode: "astable", high: 0.1, low: 0.07 }] } }); // prettier-ignore
  let a = logic.step(logic.state0(), pins("H", "H"), pins("H", "H"), ast(0));
  a = logic.step(a, pins("H", "X"), pins("H", "H"), ast(0.2));
  a = logic.step(a, pins("H", "H"), pins("H", "X"), ast(0.21));
  assert.equal(out(a), "X");
  a = logic.step(a, pins("H", "H"), pins("H", "H"), ast(1));
  assert.equal(out(a), "X", "still unknown");
  a = logic.step(a, pins("H", "L"), pins("H", "H"), ast(1.1));
  a = logic.step(a, pins("H", "H"), pins("H", "L"), ast(1.2));
  assert.equal(out(a), "H", "a clean RESET restarts it");
});

test("a CD4538B section whose RESET may be held: X to its pulse's end, LOW when idle", () => {
  const logic = chipDef("CD4538B").logic;
  const timing = { sections: [{ mode: "monostable", width: 0.1 }, { mode: null }] }; // prettier-ignore
  const env = (now) => ({ now, timing });
  // Section 1: RESET 3, +TR 4, −TR 5 HIGH, Q 6.
  const pins = (plus, reset) => new Map([[3, reset], [4, plus], [5, "H"]]); // prettier-ignore
  const q = (s) => logic.outputs(s).get(6);
  let s = logic.step(logic.state0(), pins("L", "H"), pins("L", "H"), env(0));
  s = logic.step(s, pins("X", "X"), pins("L", "H"), env(0.05));
  assert.equal(q(s), "X", "a trigger it may have taken");
  s = logic.step(s, pins("L", "H"), pins("X", "X"), env(0.06));
  s = logic.step(s, pins("L", "H"), pins("L", "H"), env(0.2));
  assert.equal(q(s), "L", "idle: LOW, not unknown for good");
  s = logic.step(s, pins("H", "H"), pins("L", "H"), env(1));
  s = logic.step(s, pins("H", "X"), pins("H", "H"), env(1.05));
  assert.equal(q(s), "X");
  s = logic.step(s, pins("H", "H"), pins("H", "X"), env(1.07));
  assert.equal(q(s), "X", "the pulse may still be running");
  s = logic.step(s, pins("H", "H"), pins("H", "H"), env(1.1));
  assert.equal(q(s), "L", "and is over at its own end");
});

test("a CD4098B rise through a long unknown stretch is certain only a width past its start", () => {
  const logic = chipDef("CD4098B").logic;
  const timing = { sections: [{ mode: "monostable", width: 0.1 }, { mode: null }] }; // prettier-ignore
  const env = (now) => ({ now, timing });
  const pins = (plus) => new Map([[3, "H"], [4, plus], [5, "H"]]); // prettier-ignore
  const q = (s) => logic.outputs(s).get(6);
  let s = logic.step(logic.state0(), pins("L"), pins("L"), env(0));
  s = logic.step(s, pins("X"), pins("L"), env(1));
  s = logic.step(s, pins("H"), pins("X"), env(1.05));
  assert.equal(q(s), "H", "it rose by 1.05 s: HIGH to 1.1 s for certain");
  s = logic.step(s, pins("H"), pins("H"), env(1.1));
  assert.equal(q(s), "X", "then perhaps to 1.15 s");
  s = logic.step(s, pins("H"), pins("H"), env(1.15));
  assert.equal(q(s), "L");
  // A stretch longer than the width: never certain.
  s = logic.step(s, pins("L"), pins("H"), env(2));
  s = logic.step(s, pins("X"), pins("L"), env(3));
  s = logic.step(s, pins("H"), pins("X"), env(3.3));
  assert.equal(q(s), "X");
});

test("a CD4047B's RETRIGGER unknown in a period may run the pulse on, in doubt", () => {
  const logic = chipDef("CD4047B").logic;
  const timing = { sections: [{ mode: "multivibrator", r: 10e3, c: 1e-6, width: 0.0248 }] }; // prettier-ignore
  const env = (now) => ({ now, timing });
  const pins = (trig, rt) => new Map([[4, "H"], [5, "L"], [6, "L"], [8, trig], [9, "L"], [12, rt]]); // prettier-ignore
  const q = (s) => logic.outputs(s).get(10);
  let s = logic.step(logic.state0(), pins("L", "L"), pins("L", "L"), env(0));
  s = logic.step(s, pins("H", "L"), pins("L", "L"), env(0.1));
  assert.equal(q(s), "H");
  s = logic.step(s, pins("H", "X"), pins("H", "L"), env(0.11));
  s = logic.step(s, pins("H", "L"), pins("H", "X"), env(0.115));
  assert.equal(q(s), "H", "inside its first period, still HIGH");
  s = logic.step(s, pins("H", "L"), pins("H", "L"), env(0.1248));
  assert.equal(q(s), "X", "it may have been retriggered");
  s = logic.step(s, pins("H", "L"), pins("H", "L"), env(0.1468));
  assert.equal(q(s), "L", "LOW once that period is up");
});

test("an idle latch whose loads lie to its left settles, tick after tick", () => {
  // Its loads' nets come first in netId order, and one seed per knot of all
  // a gate joined went to them, never the latch's loop: X for good, the X
  // then a settled fixed point.
  const b = bench();
  const lat = powered(b, "u9", "74LS00", "e50");
  b.vcc(lat.get(1));
  b.vcc(lat.get(5));
  b.link(lat.get(3), lat.get(4));
  b.link(lat.get(6), lat.get(2));
  const mid = powered(b, "i2", "74LS04", "e30");
  b.link(lat.get(3), mid.get(1));
  const left = powered(b, "i1", "74LS04", "e3");
  b.link(mid.get(2), left.get(1));
  b.link(left.get(2), left.get(3));
  b.link(left.get(4), left.get(5));
  b.link(left.get(6), left.get(9));
  const sim = runner(b.doc);
  for (const t of [0, 0.01]) {
    const { result, level } = sim.run(t);
    assert.equal(result.settled, true, `at ${t}`);
    const q = level(lat.get(3));
    assert.ok((q === "H" || q === "L") && level(lat.get(6)) === (q === "H" ? "L" : "H"), `at ${t}: ${q}`); // prettier-ignore
  }
});

test("idle latches feeding one register each settle — a register's pins join no loop", () => {
  const b = bench();
  const qs = [];
  for (let k = 0; k < 3; k++) {
    const u = powered(b, `u${k}`, "74LS00", `e${3 + k * 9}`);
    b.link(u.get(3), u.get(5));
    b.link(u.get(6), u.get(2));
    b.link(u.get(8), u.get(13));
    b.link(u.get(11), u.get(10));
    qs.push([u, 3, 6], [u, 8, 11]);
  }
  const reg = b.seat("reg", "74LS273", "e40");
  b.vcc(reg.get(20));
  b.gnd(reg.get(10));
  b.vcc(reg.get(1));
  const ds = [3, 4, 7, 8, 13, 14];
  qs.forEach(([u, q], i) => b.link(u.get(q), reg.get(ds[i])));
  const { result, level } = runner(b.doc).run(0);
  assert.equal(result.settled, true);
  for (const [u, q, qb] of qs) {
    assert.notEqual(level(u.get(q)), "X");
    assert.notEqual(level(u.get(q)), level(u.get(qb)));
  }
});

test("a CD4011B latch idle at Run falls one way; one whose input floats stays unknown", () => {
  // Every net starts floating, a CMOS gate reads that X, and NAND(H, X) is
  // X: a steady state with nothing racing, so no tie was ever broken.
  for (const pulled of [true, false]) {
    const b = bench();
    const u = powered(b, "u1", "CD4011B", "e10");
    for (const p of [8, 9, 12, 13]) b.gnd(u.get(p));
    // A: 1, 2 → 3 (Q); B: 5, 6 → 4 (Q̄). S̄ on 1, R̄ on 6.
    b.link(u.get(3), u.get(5));
    b.link(u.get(4), u.get(2));
    const r1 = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
    b.vcc(r1.get(2));
    b.link(r1.get(1), u.get(6));
    if (pulled) {
      const r2 = b.seat("r2", "resistor", "a40", { ohms: 10e3 });
      b.vcc(r2.get(2));
      b.link(r2.get(1), u.get(1));
    }
    const { level } = runner(b.doc).run(0);
    const q = level(u.get(3));
    if (pulled) {
      assert.ok(q === "H" || q === "L", q);
      assert.notEqual(level(u.get(4)), q);
    } else {
      assert.equal(q, "X", "S̄ floats, so it may be set");
    }
  }
});

test("a diode-AND: any cathode LOW takes the pulled-up anode LOW", () => {
  // A diode passed only a HIGH, so a diode-AND read HIGH whatever its inputs.
  for (const [a, bIn] of [
    ["H", "H"],
    ["L", "H"],
    ["H", "L"],
    ["L", "L"],
  ]) {
    const b = bench();
    const inv = powered(b, "u1", "74LS04", "e10");
    const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
    b.vcc(r.get(2));
    b.link(r.get(1), inv.get(1));
    const d1 = b.seat("d1", "diode", "a40");
    const d2 = b.seat("d2", "diode", "a50");
    b.link(d1.get(1), inv.get(1));
    b.link(d2.get(1), inv.get(1));
    b.signal("A", d1.get(2));
    b.signal("B", d2.get(2));
    const { level } = runner(b.doc).run(
      0,
      new Map([
        ["A", a],
        ["B", bIn],
      ]),
    );
    assert.equal(level(inv.get(1)), a === "H" && bIn === "H" ? "H" : "L", `${a}${bIn}`); // prettier-ignore
  }
  // A CMOS input alone on the anode: nothing pushes current in, so it floats.
  const b = bench();
  const u = powered(b, "u1", "CD4069UB", "e10");
  const d = b.seat("d1", "diode", "a40");
  b.link(d.get(1), u.get(1));
  b.gnd(d.get(2));
  assert.equal(runner(b.doc).run(0).level(u.get(1)), "Z");
});

test("a 74LS74 clocks an unknown D in as unknown, not a clean LOW", () => {
  const logic = chipDef("74LS74").logic;
  // Flop 1: D 2, CLK 3, PRE̅ 4, CLR̅ 1, Q 5.
  const pins = (d, clk) => new Map([[1, "H"], [2, d], [3, clk], [4, "H"]]); // prettier-ignore
  const q = (s) => logic.outputs(s, pins("H", "L")).get(5);
  let s = logic.step(logic.state0(), pins("H", "L"), pins("H", "L"));
  s = logic.step(s, pins("H", "H"), pins("H", "L"));
  assert.equal(q(s), "H");
  s = logic.step(s, pins("X", "L"), pins("H", "H"));
  s = logic.step(s, pins("X", "H"), pins("X", "L"));
  assert.equal(q(s), "X");
  s = logic.step(s, pins("L", "L"), pins("X", "H"));
  s = logic.step(s, pins("L", "H"), pins("L", "L"));
  assert.equal(q(s), "L", "a clean edge with a clean D knows again");
});

test("a chain of diodes: each drop up is LOW to what reads it as one, X to what does not", () => {
  // Three diodes in series to GND, each node pulled up by 10 k and read by a
  // 74LS04: one drop (0.7 V) is LOW, two and three are X to a TTL input.
  // Two drops was "never a LOW" — wrong for a CMOS input, to which 1.4 V at
  // 12 V is a solid LOW (the regrade, 2026-10-22).
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  const rs = [];
  const ds = [];
  for (let k = 0; k < 3; k++) {
    const r = b.seat(`r${k}`, "resistor", `${k ? "j" : "a"}${40 + k * 6}`, { ohms: 10e3 }); // prettier-ignore
    b.vcc(r.get(2));
    rs.push(r);
    ds.push(b.seat(`d${k}`, "diode", `a${52 + k * 4}`));
  }
  for (let k = 0; k < 3; k++) {
    b.link(ds[k].get(1), rs[k].get(1));
    if (k < 2) b.link(ds[k].get(2), rs[k + 1].get(1));
    else b.gnd(ds[k].get(2));
    b.link(rs[k].get(1), u.get([1, 3, 5][k]));
  }
  const { level } = runner(b.doc).run(0);
  assert.deepEqual(
    rs.map((r) => level(r.get(1))),
    ["X", "X", "L"],
  );
  // Two drops into a CD4069UB at 12 V: LOW.
  const c = bench({ volts: 12 });
  const inv = powered(c, "u2", "CD4069UB", "e30");
  for (const p of [5, 9, 11, 13]) c.gnd(inv.get(p));
  const r1 = c.seat("r1", "resistor", "a50", { ohms: 10e3 });
  const r2 = c.seat("r2", "resistor", "j50", { ohms: 10e3 });
  c.vcc(r1.get(2));
  c.vcc(r2.get(2));
  const d1 = c.seat("d1", "diode", "a56");
  const d2 = c.seat("d2", "diode", "j56");
  c.link(r1.get(1), d1.get(1));
  c.link(d1.get(2), r2.get(1));
  c.link(r2.get(1), d2.get(1));
  c.gnd(d2.get(2));
  c.link(r1.get(1), inv.get(1));
  c.link(r2.get(1), inv.get(3));
  const run = runner(c.doc).run(0);
  assert.equal(run.level(r1.get(1)), "L", "two drops");
  assert.equal(run.level(inv.get(2)), "H");
});

test("the 74LS573, '173 and '279 carry an unknown control as unknown, not a clean level", () => {
  // '573: D 2 HIGH latched, then LE 11 unknown with D LOW: Q (19) may follow.
  const l573 = chipDef("74LS573").logic;
  const pins573 = (le, d) => new Map([[1, "L"], [11, le], [2, d]]); // prettier-ignore
  let s = l573.step(l573.state0(), pins573("H", "H"), null);
  s = l573.step(s, pins573("L", "H"), null);
  assert.equal(l573.outputs(s, pins573("X", "L")).get(19), "X");
  assert.equal(
    l573.outputs(s, pins573("X", "H")).get(19),
    "H",
    "both readings HIGH",
  );
  // '173: Q 3 HIGH, then a clock edge with G1 (9) unknown and D (14) LOW.
  const r173 = chipDef("74LS173").logic;
  const pins173 = (clk, g1, d) => new Map([[1, "L"], [2, "L"], [7, clk], [9, g1], [10, "L"], [14, d], [15, "L"]]); // prettier-ignore
  let r = r173.step(r173.state0(), pins173("L", "L", "H"), null);
  r = r173.step(r, pins173("H", "L", "H"), pins173("L", "L", "H"));
  assert.equal(r173.outputs(r, pins173("H", "L", "H")).get(3), "H");
  r = r173.step(r, pins173("L", "X", "L"), pins173("H", "L", "H"));
  r = r173.step(r, pins173("H", "X", "L"), pins173("L", "X", "L"));
  assert.equal(r173.outputs(r, pins173("H", "X", "L")).get(3), "X");
  // '279: latch 1 set (S̄ 2 LOW), then R̄ (1) unknown: Q (4) may be reset.
  const l279 = chipDef("74LS279").logic;
  const pins279 = (s1, r1) => new Map([[1, r1], [2, s1], [3, "H"]]); // prettier-ignore
  let q = l279.step(l279.state0(), pins279("L", "H"), null);
  q = l279.step(q, pins279("H", "H"), null);
  assert.equal(l279.outputs(q, pins279("H", "H")).get(4), "H");
  q = l279.step(q, pins279("H", "X"), null);
  assert.equal(l279.outputs(q, pins279("H", "X")).get(4), "X");
});

test("the TTL counters and shift registers read an unknown input as HIGH, as its pull-up takes it", () => {
  // Jason, 2026-10-22: "TTL generally has pull up resistors". It read LOW:
  // an X clock never clocked, an X clear cleared, an X data bit shifted 0.
  // '161: CLK 2, CLR̅ 1, LOAD̅ 9, ENP 7, ENT 10, QA 14.
  const c161 = chipDef("74LS161").logic;
  const pins161 = (clk, clr, enp) => new Map([[1, clr], [2, clk], [7, enp], [9, "H"], [10, "H"], [3, "L"], [4, "L"], [5, "L"], [6, "L"]]); // prettier-ignore
  let s = c161.step(c161.state0(), pins161("L", "H", "H"), null);
  s = c161.step(s, pins161("X", "H", "H"), pins161("L", "H", "H"));
  assert.equal(
    c161.outputs(s, pins161("X", "H", "H")).get(14),
    "H",
    "LOW → X clocks",
  );
  s = c161.step(s, pins161("L", "X", "X"), pins161("X", "H", "H"));
  s = c161.step(s, pins161("H", "X", "X"), pins161("L", "X", "X"));
  assert.equal(c161.outputs(s, pins161("H", "X", "X")).get(13), "H", "an X clear clears nothing; an X enable counts"); // prettier-ignore
  // '164: A 1, B 2, CLK 8, CLR̅ 9, QA 3 — an X data bit shifts in HIGH.
  const r164 = chipDef("74LS164").logic;
  const pins164 = (a, clk) => new Map([[1, a], [2, "H"], [8, clk], [9, "H"]]); // prettier-ignore
  let r = r164.step(r164.state0(), pins164("X", "L"), null);
  r = r164.step(r, pins164("X", "H"), pins164("X", "L"));
  assert.equal(r164.outputs(r, pins164("X", "H")).get(3), "H");
});

test("a 555 whose RESET was in doubt while TRIG fell: certain to its first pulse's end, X to its second's", () => {
  const logic = chipDef("NE555").logic;
  const env = (now) => ({ now, timing: { sections: [{ mode: "monostable", width: 0.11 }] } }); // prettier-ignore
  const pins = (trig, reset) => new Map([[2, trig], [4, reset]]); // prettier-ignore
  const out = (s) => logic.outputs(s).get(3);
  let s = logic.step(logic.state0(), pins("H", "H"), pins("H", "H"), env(0));
  s = logic.step(s, pins("H", "X"), pins("H", "H"), env(0.05));
  s = logic.step(s, pins("L", "X"), pins("H", "X"), env(0.06));
  assert.equal(out(s), "X");
  s = logic.step(s, pins("L", "H"), pins("L", "X"), env(0.1));
  assert.equal(out(s), "H");
  s = logic.step(s, pins("H", "H"), pins("L", "H"), env(0.12));
  assert.equal(out(s), "H", "the pulse begun at 0.06 runs to 0.17");
  s = logic.step(s, pins("H", "H"), pins("H", "H"), env(0.17));
  assert.equal(out(s), "X", "one begun at 0.10 would run to 0.21");
  s = logic.step(s, pins("H", "H"), pins("H", "H"), env(0.21));
  assert.equal(out(s), "L");
});

test("a transistor switch biased by a divider switches: the pulls are weighed by their resistors", () => {
  // An output through 1 kΩ to the base, 10 kΩ from the base to ground —
  // the switch every transistor tutorial draws — read its base X (two pulls
  // that disagreed), and a transistor reads an X base as OFF: the LED it
  // drove stayed dark, unwarned, while Spice Lite lit it.
  for (const pulldown of [false, true]) {
    const b = bench();
    const u = powered(b, "u1", "74LS04", "e10");
    b.signal("in", u.get(1), "low");
    const rb = b.seat("r1", "resistor", "a40", { ohms: 1000 });
    b.link(rb.get(1), u.get(2));
    const q = b.seat("q1", "npn", "f50");
    b.link(rb.get(2), q.get(2));
    if (pulldown) {
      const rd = b.seat("r2", "resistor", "j40", { ohms: 10000 });
      b.gnd(rd.get(2));
      b.link(rd.get(1), q.get(2));
    }
    const rc = b.seat("r3", "resistor", "a30", { ohms: 1000 });
    b.vcc(rc.get(2));
    b.link(rc.get(1), q.get(3));
    b.gnd(q.get(1));
    for (const [input, y] of [
      ["L", "L"],
      ["H", "H"],
    ]) {
      const sim = runner(b.doc);
      const sig = new Map([["in", input]]);
      sim.run(0, sig);
      const run = sim.run(0.001, sig);
      assert.equal(run.level(q.get(3)), y, `pull-down ${pulldown}, input ${input}`); // prettier-ignore
    }
  }
});

test("a divider of two resistors reads the side it is two thirds of the way to, else X", () => {
  // 1 k against 10 k is 91 % of the way: that side. 10 k against 10 k is
  // half way: no level.
  for (const [up, down, level] of [
    [1e3, 10e3, "H"],
    [10e3, 1e3, "L"],
    [10e3, 10e3, "X"],
  ]) {
    // prettier-ignore
    const b = bench();
    const u = powered(b, "u1", "74LS04", "e10");
    const r1 = b.seat("r1", "resistor", "a30", { ohms: up });
    b.vcc(r1.get(1));
    b.link(r1.get(2), u.get(1));
    const r2 = b.seat("r2", "resistor", "a40", { ohms: down });
    b.link(r2.get(1), u.get(1));
    b.gnd(r2.get(2));
    assert.equal(runner(b.doc).run(0).level(u.get(1)), level, `${up} up, ${down} down`); // prettier-ignore
  }
});

test("a DTL NAND: its pull-up through two diodes outweighs its base's pull-down", () => {
  // 4.7 kΩ up to P, P → two diodes → the base, 10 kΩ from the base down:
  // a diode passes on the pull that reaches its anode, with that pull's
  // resistor (it passed an unweighed HIGH, and the base read X).
  const b = bench();
  const rp = b.seat("r1", "resistor", "a40", { ohms: 4700 });
  b.vcc(rp.get(2));
  const P = rp.get(1);
  const da = b.seat("d1", "diode", "j30");
  const db = b.seat("d2", "diode", "j34");
  b.link(da.get(1), P);
  b.link(db.get(1), P);
  b.signal("a", da.get(2), "high");
  b.signal("b", db.get(2), "high");
  const d3 = b.seat("d3", "diode", "a50");
  const d4 = b.seat("d4", "diode", "j50");
  b.link(d3.get(1), P);
  b.link(d4.get(1), d3.get(2));
  const q = b.seat("q1", "npn", "f58");
  b.link(d4.get(2), q.get(2));
  const rb = b.seat("r2", "resistor", "a20", { ohms: 10000 });
  b.gnd(rb.get(2));
  b.link(rb.get(1), q.get(2));
  const rc = b.seat("r3", "resistor", "j20", { ohms: 1000 });
  b.vcc(rc.get(2));
  b.link(rc.get(1), q.get(3));
  b.gnd(q.get(1));
  for (const [a, bb, y] of [
    ["H", "H", "L"],
    ["L", "H", "H"],
    ["H", "L", "H"],
  ]) {
    // prettier-ignore
    const sim = runner(b.doc);
    const sig = new Map([["a", a], ["b", bb]]); // prettier-ignore
    sim.run(0, sig);
    assert.equal(sim.run(0.001, sig).level(q.get(3)), y, `A ${a}, B ${bb}`);
  }
});
