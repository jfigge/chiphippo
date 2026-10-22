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
