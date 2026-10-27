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

// The 2026-10-23 grade's logic-engine findings, each held here: a CMOS ring
// oscillator said as one, a base divider fed from a pulled-up collector, a
// one-shot's new trigger on the tick its pulse ends, the VIA's pulse-counting
// T2, a CD4060 rewired between its oscillator and a clock, and a stuck loop's
// failed tie remembered per settle mode — and, from the 2026-10-26 review,
// per RUN, with a ring oscillator's raced tie remembered too.

import test from "node:test";
import assert from "node:assert/strict";

import { bench, runner } from "./timing-fixtures.js";
import { compareRuns } from "./incremental-fixtures.js";
import { H, L } from "../sim/levels.js";
import { chipDef } from "../catalog/index.js";
import { buildNetlist } from "../sim/netlist.js";
import { settle, tick, tieMemo } from "../sim/engine.js";

const powered = (b, id, ref, anchor) => {
  const u = b.seat(id, ref, anchor);
  const def = chipDef(ref);
  b.vcc(u.get(def.pins.find((p) => p.role === "vcc").n));
  b.gnd(u.get(def.pins.find((p) => p.role === "gnd").n));
  return u;
};

test("a ring of CMOS inverters is said to oscillate, as a ring of 74LS04s is", () => {
  // Three CD4069UB inverters read X, X, X and settled, silent — and an
  // idle latch beside the ring was named as the oscillation in its place.
  for (const latch of [false, true]) {
    const b = bench();
    const u = powered(b, "u1", "CD4069UB", "e2");
    b.link(u.get(2), u.get(3));
    b.link(u.get(4), u.get(5));
    b.link(u.get(6), u.get(1));
    if (latch) {
      const v = powered(b, "u2", "74LS02", "e11");
      b.link(v.get(10), u.get(11));
      b.link(u.get(10), v.get(8));
      b.link(u.get(10), v.get(9));
    }
    const sim = runner(b.doc);
    const ring = new Set([u.get(2), u.get(4), u.get(6)].map((h) => sim.netlist.netOfPoint.get(`bb1.${h}`))); // prettier-ignore
    for (const t of [0, 0.01, 0.02]) {
      const { result } = sim.run(t);
      const osc = result.warnings.filter((w) => w.type === "oscillation");
      assert.equal(result.settled, false, `${latch}: t=${t} settled`);
      assert.ok(osc.length && osc.every((w) => w.nets.every((n) => ring.has(n))), `${latch}: t=${t} ${JSON.stringify(osc)}`); // prettier-ignore
    }
  }
  // An RC relaxation oscillator (the logic engine cannot time one) is still
  // left X, unsaid, and not tried again every tick.
  const b = bench();
  const u = powered(b, "u1", "CD40106B", "e2");
  const r = b.seat("r", "resistor", "a20", { ohms: 100e3 });
  const c = b.seat("c", "cap-ceramic", "a30", { farads: 1e-6 });
  b.link(r.get(1), u.get(2));
  b.link(r.get(2), u.get(1));
  b.link(c.get(1), u.get(1));
  b.gnd(c.get(2));
  const sim = runner(b.doc);
  for (const t of [0, 0.01]) {
    const { result } = sim.run(t);
    assert.equal(result.settled, true);
    assert.ok(!result.warnings.some((w) => w.type === "oscillation"));
  }
});

test("a transistor's base divider fed from a pulled-up collector turns it on", () => {
  // Q1 off; its collector 1 k to 5 V; 10 k from there to Q2's base, 10 k
  // from the base to ground: 2.4 V on the base, Q2 on, its collector LOW.
  // Read at the collector's level the base stood X and Q2 off.
  for (const [rc1, rs, rpd] of [
    [1e3, 10e3, 10e3],
    [4.7e3, 10e3, 10e3],
    [1e3, 22e3, 10e3],
  ]) {
    const b = bench();
    const q1 = b.seat("q1", "npn", "a5");
    const q2 = b.seat("q2", "npn", "a40");
    const rC1 = b.seat("rc1", "resistor", "f5", { ohms: rc1 });
    const rS = b.seat("rs", "resistor", "f20", { ohms: rs });
    const rc2 = b.seat("rc2", "resistor", "f40", { ohms: 1e3 });
    const rP = b.seat("rpd", "resistor", "a50", { ohms: rpd });
    b.gnd(q1.get(2));
    b.gnd(q1.get(1));
    b.vcc(rC1.get(1));
    b.link(rC1.get(2), q1.get(3));
    b.link(rS.get(1), q1.get(3));
    b.link(rS.get(2), q2.get(2));
    b.gnd(q2.get(1));
    b.vcc(rc2.get(1));
    b.link(rc2.get(2), q2.get(3));
    b.link(rP.get(1), q2.get(2));
    b.gnd(rP.get(2));
    const sim = runner(b.doc);
    sim.run(0);
    assert.equal(sim.level(q2.get(3)), L, `${rc1}/${rs}/${rpd}`);
    compareRuns(`${rc1}/${rs}/${rpd}`, b.doc, { ticks: 2 });
  }
});

test("a 555 one-shot fired again on the tick its last pulse ended runs a new pulse", () => {
  // w = 1.1·RC = 0.11 s. TRIG falls at 0.10, rises at 0.12, falls again at
  // 0.25 — after the first pulse's end at 0.21, with no tick there.
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.link(u.get(6), u.get(7));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: 10e-6 });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const ra = b.seat("r1", "resistor", "a40", { ohms: 10e3 });
  b.link(ra.get(1), u.get(6));
  b.vcc(ra.get(2));
  b.signal("trig", u.get(2), "high");
  const sim = runner(b.doc);
  const at = (t, v) => sim.run(t, new Map([["trig", v]])).level(u.get(3));
  at(0, H);
  assert.equal(at(0.1, L), H);
  at(0.12, H);
  assert.equal(at(0.25, L), H, "the new fall's pulse");
  assert.equal(at(0.3, H), H);
  assert.equal(at(0.37, H), L, "ended a width after the new fall");
  // …while a TRIG held LOW past the end still holds the output, as before.
  const held = runner(b.doc);
  held.run(0, new Map([["trig", H]]));
  held.run(0.1, new Map([["trig", L]]));
  assert.equal(held.run(0.25, new Map([["trig", L]])).level(u.get(3)), H);
  assert.equal(held.run(0.26, new Map([["trig", H]])).level(u.get(3)), L);
});

test("a CD4047B one-shot whose +TRIG rises on the tick its pulse ended runs a new pulse", () => {
  const b = bench();
  const u = powered(b, "u1", "CD4047B", "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.link(res.get(1), u.get(2));
  b.link(res.get(2), u.get(3));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
  b.link(cap.get(1), u.get(1));
  b.link(cap.get(2), u.get(3));
  for (const [pin, how] of [
    [4, "H"],
    [5, "L"],
    [6, "L"],
    [9, "L"],
    [12, "L"],
  ]) {
    // prettier-ignore
    if (how === "H") b.vcc(u.get(pin));
    else b.gnd(u.get(pin));
  }
  b.signal("trig", u.get(8), "low");
  const sim = runner(b.doc);
  const at = (t, v) => sim.run(t, new Map([["trig", v]])).level(u.get(10));
  at(0, L);
  assert.equal(at(0.1, H), H);
  at(0.11, L);
  // Its pulse is 2.48·RC = 24.8 ms: ended at 0.1248, a new rise just after.
  assert.equal(at(0.1258, H), H, "the new rise's pulse");
  assert.equal(at(0.13, H), H);
});

test("the VIA's T2 counting pulses sets its flag as the count reaches zero", () => {
  const PB6 = 16;
  const D = [33, 32, 31, 30, 29, 28, 27, 26];
  const RS = [38, 37, 36, 35];
  const [CS1, CS2B, RWB, PHI2, RESB] = [24, 23, 22, 25, 34];
  const logic = chipDef("W65C22").logic;
  let state = logic.state0();
  let prev = null;
  const pins = new Map();
  for (let n = 1; n <= 40; n++) pins.set(n, H);
  pins.set(PHI2, L);
  const tick = () => {
    const ins = new Map(pins);
    state = logic.step(state, ins, prev);
    prev = ins;
  };
  const write = (a, v) => {
    pins.set(CS1, H).set(CS2B, L).set(RWB, L);
    RS.forEach((p, i) => pins.set(p, (a >> i) & 1 ? H : L));
    D.forEach((p, i) => pins.set(p, (v >> i) & 1 ? H : L));
    pins.set(PHI2, H);
    tick();
    pins.set(PHI2, L);
    tick();
    pins.set(CS2B, H);
  };
  pins.set(RESB, L);
  tick();
  pins.set(RESB, H);
  write(0xb, 0x20); // ACR: T2 counts PB6 pulses
  write(0x8, 3);
  write(0x9, 0);
  const pulse = () => {
    pins.set(PB6, L).set(PHI2, H);
    tick();
    pins.set(PHI2, L);
    tick();
    pins.set(PB6, H).set(PHI2, H);
    tick();
    pins.set(PHI2, L);
    tick();
  };
  pulse();
  pulse();
  assert.equal(state.ifr & 0x20, 0, "two pulses");
  pulse();
  assert.equal(state.ifr & 0x20, 0x20, "the third pulse");
  assert.equal(state.t2c, 0);
});

test("a CD4060B rewired from its RC oscillator to a clock counts on from where it was", () => {
  // Rx 10 k, Cx 1 µF: a 22 ms period, 22 counts by 0.5 s (Q5 HIGH). Then
  // the RC parts come out and a flag clocks φI: one falling edge is 23,
  // Q5 still HIGH — zeroed, the count was 1.
  const b = bench();
  const u = powered(b, "u1", "CD4060B", "e10");
  const cap = b.seat("c1", "cap-ceramic", "a30", { farads: 1e-6 });
  b.link(cap.get(1), u.get(9));
  const rX = b.seat("r1", "resistor", "a40", { ohms: 10e3 });
  b.link(rX.get(1), u.get(10));
  b.link(rX.get(2), cap.get(2));
  const rS = b.seat("r2", "resistor", "a50", { ohms: 47e3 });
  b.link(rS.get(1), u.get(11));
  b.link(rS.get(2), cap.get(2));
  b.gnd(u.get(12));
  const sim = runner(b.doc);
  for (let t = 0; t <= 0.5; t += 0.01) sim.run(t);
  assert.equal(sim.level(u.get(5)), H, "22 counts: Q5 HIGH");
  const parts = new Set(["c1", "r1", "r2"]);
  b.doc.components = b.doc.components.filter((c) => !parts.has(c.id));
  b.doc.wires = b.doc.wires.filter((w) => ![w.from, w.to].some((a) => parts.has(a.split(".")[0]))); // prettier-ignore
  b.signal("clk", u.get(11), "low");
  sim.rebuild();
  sim.run(0.51, new Map([["clk", H]]));
  sim.run(0.52, new Map([["clk", L]]));
  assert.equal(sim.level(u.get(5)), H, "23 counts: Q5 still HIGH");
});

test("a stuck loop's failed tie is remembered per settle mode, so the two agree", () => {
  // Run on ONE netlist, the full settle's failed tie (remembered by
  // netlist) kept the incremental one from ever trying it: one settle
  // pass apart (the grade's fuzz, seed 251).
  const b = bench();
  powered(b, "u0", "74LS00", "e2");
  powered(b, "u1", "CD4001B", "e11");
  powered(b, "u2", "74LS14", "e20");
  b.seat("d2", "diode", "a56");
  b.seat("d3", "resistor", "a60", { ohms: 47e3 });
  for (const [from, to] of [
    ["bb1.g14", "bb1.a5"],
    ["bb1.b63", "bb1.a6"],
    ["bb1.a7", "bb1.g13"],
    ["bb1.b47", "bb1.a20"],
    ["psu1.-", "bb1.c47"],
    ["bb1.b60", "bb1.c56"],
    ["bb1.d47", "bb1.b59"],
    ["bb1.a21", "bb1.c60"],
  ]) {
    b.doc.wires.push({ id: `wx${b.doc.wires.length}`, from, to, color: "blue" }); // prettier-ignore
  }
  compareRuns("seed 251", b.doc, { ticks: 2 });
});

test("the read-through holds with a pull-down on the driving transistor's base", () => {
  // Its emitter on GND is no feedback: read as one, any base pull-down to
  // GND upstream looked like a flip-flop partner (the regrade).
  const b = bench();
  const q0 = b.seat("q0", "npn", "a2");
  const q1 = b.seat("q1", "npn", "a14");
  const rc0 = b.seat("rc0", "resistor", "f2", { ohms: 1e3 });
  const rc1 = b.seat("rc1", "resistor", "f14", { ohms: 1e3 });
  const rs = b.seat("rs", "resistor", "f7", { ohms: 10e3 });
  const rp1 = b.seat("rp1", "resistor", "a19", { ohms: 10e3 });
  const rin = b.seat("rin", "resistor", "a30", { ohms: 10e3 });
  const rp0 = b.seat("rp0", "resistor", "a40", { ohms: 1e6 });
  b.gnd(q0.get(1));
  b.gnd(q1.get(1));
  b.vcc(rc0.get(1));
  b.link(rc0.get(2), q0.get(3));
  b.vcc(rc1.get(1));
  b.link(rc1.get(2), q1.get(3));
  b.link(rs.get(1), q0.get(3));
  b.link(rs.get(2), q1.get(2));
  b.link(rp1.get(1), q1.get(2));
  b.gnd(rp1.get(2));
  b.signal("s", rin.get(1), "low");
  b.link(rin.get(2), q0.get(2));
  b.link(rp0.get(1), q0.get(2));
  b.gnd(rp0.get(2));
  const sim = runner(b.doc);
  sim.run(0, new Map([["s", L]]));
  assert.equal(sim.level(q0.get(3)), H);
  assert.equal(sim.level(q1.get(3)), L);
});

test("an inverter biased by its own feedback resistor is no ring: no oscillation said", () => {
  // 100 k from a CD4069UB's output to its own input, no capacitor: an
  // amplifier on a bench. Taken for a ring it warned every tick.
  const b = bench();
  const u = powered(b, "u1", "CD4069UB", "e2");
  for (const p of [3, 5, 9, 11, 13]) b.gnd(u.get(p));
  const r = b.seat("r", "resistor", "a20", { ohms: 100e3 });
  b.link(r.get(1), u.get(2));
  b.link(r.get(2), u.get(1));
  const sim = runner(b.doc);
  for (const t of [0, 0.01, 0.02]) {
    const { result } = sim.run(t);
    assert.ok(!result.warnings.some((w) => w.type === "oscillation"), `t=${t}`);
  }
});

test("an even loop of inverting gates settles: six in a ring, a latch with an inverter pair in each feedback", () => {
  // Seeded one LOW and every other net HIGH, the LOW ran round the loop as
  // a defect for ever and the loop was said to oscillate.
  const INV = [
    [1, 2],
    [3, 4],
    [5, 6],
    [9, 8],
    [11, 10],
    [13, 12],
  ];
  for (const ref of ["74LS04", "CD4069UB"]) {
    const b = bench();
    const u = powered(b, "u1", ref, "e2");
    INV.forEach(([, out], k) => b.link(u.get(out), u.get(INV[(k + 1) % 6][0])));
    const sim = runner(b.doc);
    for (const t of [0, 0.01]) {
      const { result } = sim.run(t);
      assert.equal(result.settled, true, `${ref} t=${t}`);
      assert.ok(!result.warnings.some((w) => w.type === "oscillation"), ref);
    }
    const levels = INV.map(([, out]) => sim.level(u.get(out)));
    levels.forEach((v, k) => assert.notEqual(v, levels[(k + 1) % 6], `${ref}: ${levels}`)); // prettier-ignore
  }
  const b = bench();
  const n = powered(b, "n", "74LS00", "e2");
  const u = powered(b, "u", "74LS04", "e11");
  for (const p of [9, 10, 12, 13]) b.gnd(n.get(p));
  for (const k of [4, 5]) b.gnd(u.get(INV[k][0]));
  b.vcc(n.get(1));
  b.vcc(n.get(5));
  const chain = (from, to, ks) => {
    let cur = from;
    for (const k of ks) {
      b.link(cur, u.get(INV[k][0]));
      cur = u.get(INV[k][1]);
    }
    b.link(cur, to);
  };
  chain(n.get(3), n.get(4), [0, 1]);
  chain(n.get(6), n.get(2), [2, 3]);
  const sim = runner(b.doc);
  const { result } = sim.run(0);
  assert.equal(result.settled, true);
  assert.notEqual(sim.level(n.get(3)), sim.level(n.get(6)));
  compareRuns("buffered latch", b.doc, { ticks: 2 });
});

test("a transistor flip-flop with 10 k base pull-downs comes up with one transistor on", () => {
  // Each base 10 k from the other collector and 10 k to ground: its
  // divider read X, both stood OFF, silent.
  for (const rp of [null, 10e3, 100e3]) {
    const b = bench();
    const q = [b.seat("q0", "npn", "a2"), b.seat("q1", "npn", "a14")];
    const rc = [b.seat("rc0", "resistor", "f2", { ohms: 1e3 }), b.seat("rc1", "resistor", "f14", { ohms: 1e3 })]; // prettier-ignore
    const rs = [b.seat("rs0", "resistor", "f7", { ohms: 10e3 }), b.seat("rs1", "resistor", "f19", { ohms: 10e3 })]; // prettier-ignore
    for (let k = 0; k < 2; k++) {
      b.gnd(q[k].get(1));
      b.vcc(rc[k].get(1));
      b.link(rc[k].get(2), q[k].get(3));
      b.link(rs[k].get(1), q[k].get(3));
      b.link(rs[k].get(2), q[1 - k].get(2));
      if (rp) {
        const p = b.seat(`rp${k}`, "resistor", `a${7 + 12 * k}`, { ohms: rp });
        b.link(p.get(1), q[k].get(2));
        b.gnd(p.get(2));
      }
    }
    const sim = runner(b.doc);
    sim.run(0);
    sim.run(0.01);
    const c = q.map((x) => sim.level(x.get(3)));
    assert.deepEqual(c, [H, L], `Rp ${rp}`);
    compareRuns(`flip-flop ${rp}`, b.doc, { ticks: 2 });
  }
});

test("a run's tie memory is its own: Run → Stop → Run, and a settle between, change nothing", () => {
  // The failed-tie memo was kept per NETLIST: a second Run on the cached
  // netlist, or a desk review's settle on it, skipped a tie the first had
  // given up on, and a MOSFET's held gate came out L one run and unknown the
  // next (the 2026-10-26 review, fuzz seed 41551). Now each run carries its
  // own (`tieMemo`), and a call without one remembers nothing.
  const b = bench();
  b.seat("u0", "CD4510B", "e1");
  b.seat("u1", "74LS283", "e10");
  b.seat("x0", "cap-ceramic", "a1", { farads: 1e-6 });
  b.seat("x1", "led", "a8", { color: "red" });
  b.seat("x2", "nmos", "a15", { case: "TO-220" });
  b.seat("x3", "led", "a21", { color: "red" });
  b.seat("x4", "pot", "j27", { ohms: 10e3, position: 50 });
  // prettier-ignore
  for (const [from, to] of [["psu1.-", "bb1.a8"], ["psu1.+", "bb1.g1"], ["psu1.-", "bb1.a17"], ["psu1.+", "bb1.g10"], ["psu1.+", "bb1.a7"], ["bb1.a13", "bb1.b15"], ["bb1.b8", "bb1.b13"], ["bb1.b17", "bb1.b21"], ["psu1.+", "bb1.g17"], ["psu1.-", "bb1.g11"], ["bb1.g2", "bb1.f27"], ["bb1.a14", "bb1.c8"], ["bb1.b16", "bb1.g13"], ["bb1.g27", "bb1.a6"], ["bb1.h11", "bb1.g16"], ["bb1.h13", "bb1.a11"], ["bb1.b14", "bb1.h16"], ["bb1.g5", "bb1.b2"], ["bb1.b9", "bb1.g12"], ["psu1.+", "bb1.a10"], ["bb1.a5", "bb1.c16"], ["bb1.c17", "bb1.g15"], ["bb1.g3", "bb1.b5"], ["bb1.d16", "bb1.h12"]]) {
    b.doc.wires.push({ id: `wx${b.doc.wires.length}`, from, to, color: "blue" }); // prettier-ignore
  }
  // prettier-ignore
  for (const [id, rest, anchor] of [["s6", "low", "bb1.a4"], ["s14", "low", "bb1.i16"], ["s17", "low", "bb1.c14"], ["s20", "high", "bb1.b11"], ["s23", "high", "bb1.d8"], ["s25", "low", "bb1.b7"]]) {
    b.doc.signals.push({ id, color: "red", type: "momentary", rest, flag: { anchor, rot: 0 } }); // prettier-ignore
  }
  const doc = b.doc;
  const netlist = buildNetlist(doc); // one netlist, as NetlistCache keeps it
  const signalLevels = new Map([["s6", L], ["s14", H], ["s17", L], ["s20", L], ["s23", H], ["s25", H]]); // prettier-ignore
  const run = (ties) => {
    let warmStart = new Map();
    let state = new Map();
    let prevPinLevels = new Map();
    const out = [];
    for (let i = 1; i <= 3; i++) {
      const r = tick({ document: doc, netlist, warmStart, state, prevPinLevels, signalLevels, now: i * 1e-3, ties }); // prettier-ignore
      ({ netLevels: warmStart, state, pinLevels: prevPinLevels } = r);
      out.push({ levels: r.netLevels, state: r.state, iterations: r.iterations }); // prettier-ignore
    }
    return out;
  };
  const first = run(tieMemo());
  assert.deepStrictEqual(run(tieMemo()), first, "Run → Stop → Run");
  settle({ document: doc, netlist, signalLevels }); // a desk review, say
  assert.deepStrictEqual(run(tieMemo()), first, "after a settle on the netlist"); // prettier-ignore
  assert.deepStrictEqual(run(null), run(null), "no memo: nothing remembered"); // prettier-ignore
  // (One memo shared by the two runs is what parted them.)
  const shared = tieMemo();
  run(shared);
  assert.notDeepStrictEqual(run(shared), first, "the desk still tells");
});

test("a ring oscillator's tie is not broken again every tick", () => {
  // Only a stuck loop was remembered, so a known ring was tie-broken anew
  // on every tick: four settles to the cap (the 2026-10-26 review: busy
  // fixture + a 74LS04 ring of three, 0.29 → 2.06 ms a tick). A loop seeded
  // that races on is remembered by its entries, per run.
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  b.link(u.get(2), u.get(3));
  b.link(u.get(4), u.get(5));
  b.link(u.get(6), u.get(1));
  const ring = new Set([2, 4, 6].map((p) => `bb1.${u.get(p)}`));
  const sim = runner(b.doc);
  const solves = [];
  for (let i = 0; i < 6; i++) {
    const stats = {};
    const { result } = sim.run(i * 5e-3, new Map(), { stats });
    const osc = result.warnings.find((w) => w.type === "oscillation");
    assert.ok(osc, `tick ${i}: said to oscillate`);
    assert.ok(osc.nets.every((n) => [...ring].some((h) => sim.netlist.netOfPoint.get(h) === n)), JSON.stringify(osc)); // prettier-ignore
    solves.push(stats.solves);
  }
  // Each tick's one solve, and no tie rounds, once the ring is known (the
  // ring falls into its all-X fixed point now and then, which is a stuck
  // loop, tried as before).
  assert.ok(solves.filter((n) => n === 1).length >= 3, JSON.stringify(solves)); // prettier-ignore
  compareRuns("ring of three", b.doc, { ticks: 6 });
});

test("a ring oscillator's capped solve skips the periods it repeats, its report the cap's own", () => {
  // A pass is a function of its starting levels, so a ring's capped solve
  // repeats its period to the cap: once it has come round, the whole
  // periods left are skipped (the regrade, 2026-10-26: two solves of 200
  // passes a tick beside the busy fixture). What it reports is the cap's.
  const b = bench();
  const u = powered(b, "u1", "74LS04", "e10");
  b.link(u.get(2), u.get(3));
  b.link(u.get(4), u.get(5));
  b.link(u.get(6), u.get(1));
  const sim = runner(b.doc);
  let passes = 0;
  let skipped = 0;
  for (let i = 0; i < 6; i++) {
    const stats = {};
    const { result } = sim.run(i * 5e-3, new Map(), { stats });
    assert.ok(result.warnings.some((w) => w.type === "oscillation"));
    assert.equal(result.settled, false);
    passes += stats.passes;
    skipped += stats.skippedPasses ?? 0;
  }
  assert.ok(skipped > 0 && passes < skipped, `${passes} passes run, ${skipped} skipped`); // prettier-ignore
  // …and the default (which skips) is held to the full loop (which never
  // does), field by field, tick by tick.
  compareRuns("ring of three, capped", b.doc, { ticks: 8 });
});

test("a diode into a shorted supply's rail pulls a fed anode LOW, as Spice Lite reads it", () => {
  // A rail both + and − (a supply's terminals joined) is a − rail still to
  // `diodeLows`: skipped as a + rail, the anode floated HIGH to a 74LS
  // input, where Spice Lite has the shorted supply at the bottom of its sag.
  const b = bench();
  const rd = powered(b, "u2", "74LS04", "e25");
  const d = b.seat("d1", "diode", "a45");
  b.link(d.get(1), rd.get(5));
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 40, y: 30, params: { volts: 5 } }); // prettier-ignore
  b.tie("psu2.+", d.get(2));
  b.tie("psu2.-", d.get(2));
  for (const engine of ["digital", "spice"]) {
    const { level } = runner(b.doc, { engine }).run(0.001);
    assert.equal(level(d.get(1)), L, `${engine}: the anode`);
    assert.equal(level(rd.get(6)), H, `${engine}: 3Y`);
  }
  compareRuns("diode into a shorted rail", b.doc, { ticks: 4 });
});

// ── A chip a little under its range still switches (2026-10-27) ───────────
// Jason: "keep a chip working a little below its documented range". A
// clocked 74LS04 fed through 100 Ω, its 1Y lighting an LED: lit, its VCC
// sits near 4.6 V — under the 4.75 V, over the 4.5 V floor — and it went
// on driving what it last drove, deaf to its input (the regrade's
// clocked-res.mjs: a real LS04 there switches). In its margin it is "ok",
// marked `margin`, and follows the clock.
test("Spice Lite: a clocked 74LS04 at 4.6 V follows its input, said underpowered", () => {
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "74LS04", "e20");
  const feed = b.seat("rs", "resistor", "a50", { ohms: 100 });
  b.vcc(feed.get(1));
  b.link(feed.get(2), u.get(14));
  b.gnd(u.get(7));
  b.signal("in", u.get(1), "low");
  const r = b.seat("r0", "resistor", "a30", { ohms: 680 });
  b.link(u.get(2), r.get(1));
  const led = b.seat("l0", "led", "f30", { color: "red" });
  b.link(r.get(2), led.get(1));
  b.gnd(led.get(2));
  const run = runner(b.doc, { engine: "spice" });
  for (let e = 0; e < 6; e++) {
    const high = e % 2 === 1;
    const res = run.run(e * 0.005, new Map([["in", high ? H : L]]));
    const st = run.result.chipStatus.get("u1");
    assert.equal(res.level(u.get(2)), high ? L : H, `edge ${e}: 1Y follows 1A`);
    assert.equal(st.status, "ok", `edge ${e}`);
    if (!high) {
      assert.ok(st.margin && st.volts > 4.5 && st.volts < 4.75, `edge ${e}: lit, in its margin at ${st.volts}`); // prettier-ignore
      assert.ok(run.result.warnings.some((w) => w.type === "underpowered" && w.margin), `edge ${e}: said`); // prettier-ignore
      assert.ok(
        run.result.lamps.get("l0").amps > 1e-3,
        `edge ${e}: the LED lit`,
      );
    } else {
      assert.equal(st.margin, undefined, `edge ${e}: dark, back in range`);
      assert.ok(
        run.result.lamps.get("l0").amps < 1e-4,
        `edge ${e}: the LED dark`,
      );
    }
  }
});
