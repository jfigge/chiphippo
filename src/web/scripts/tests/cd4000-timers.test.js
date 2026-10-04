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

// The RC-timed CD4000 parts in circuit, each held to its own TI datasheet:
// the CD4047B (SCHS044C), the CD4060B (SCHS049C), the CD4098B (SCHS065C) and
// the CD4538B (SCHS093C). Each reads its R and C off the wiring through the
// shared trace and turns them into time by its own formula.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, X } from "../sim/levels.js";
import { TIMING_CAP_HZ } from "../sim/timing.js";
import { chipDef } from "../catalog/index.js";
import { timingDescription } from "../model/timing-summary.js";
import { bench, runner } from "./timing-fixtures.js";

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

/** A CD4000 chip seated at `anchor`, powered from the PSU. */
function powered(b, id, ref, anchor) {
  const u = b.seat(id, ref, anchor);
  const def = chipDef(ref);
  b.vcc(u.get(def.pins.find((p) => p.role === "vcc").n));
  b.gnd(u.get(def.pins.find((p) => p.role === "gnd").n));
  return u;
}

// ── CD4047B ─────────────────────────────────────────────────────────────────

/** A 4047 at e10 with R between pins 2–3 and C between 1–3. ASTABLE (5),
    +TRIGGER (8), −TRIGGER (6) and RETRIGGER (12) come from the caller. */
function cd4047({ r = 10e3, c = 1e-6, ties = {} } = {}) {
  const b = bench();
  const u = powered(b, "u1", "CD4047B", "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(2));
  b.link(res.get(2), u.get(3));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.link(cap.get(2), u.get(3));
  for (const [pin, how] of Object.entries(ties)) {
    if (how === "H") b.vcc(u.get(Number(pin)));
    else if (how === "L") b.gnd(u.get(Number(pin)));
    else b.signal(how, u.get(Number(pin)), "low");
  }
  return { b, u };
}

// The 4047 at e10: Q 10 → f14, Q̄ 11 → f13, OSC OUT 13 → f11.
const Q47 = "f14";
const QN47 = "f13";
const OSC47 = "f11";

test("CD4047B astable: Q square-waves at 4.40·RC, the first half-cycle 2.48·RC", () => {
  // R 10k, C 1 µF: RC = 10 ms — tA 44 ms, tM 24.8 ms, OSC period 22 ms.
  const { b } = cd4047({ ties: { 4: "H", 5: "H", 6: "L", 8: "L", 9: "L", 12: "L" } }); // prettier-ignore
  const sim = runner(b.doc);
  const s = sim.run(0).result.timing.get("u1").sections[0];
  assert.equal(s.mode, "multivibrator");
  close(s.period, 4.4 * 10e-3, 1e-9, "tA");
  close(s.oscPeriod, 2.2 * 10e-3, 1e-9, "OSC OUT period");
  close(s.width, 2.48 * 10e-3, 1e-9, "tM");
  const rc = 10e-3;
  const at = (now, hole) => sim.run(now).level(hole);
  // Fig. 32: Q's first positive half-cycle is tM, every one after it tA/2.
  assert.equal(at(0, Q47), H);
  assert.equal(at(0, QN47), L);
  assert.equal(at(2.48 * rc - 0.001, Q47), H);
  assert.equal(at(2.48 * rc + 0.001, Q47), L);
  assert.equal(at(2.48 * rc + 2.2 * rc - 0.001, Q47), L);
  assert.equal(at(2.48 * rc + 2.2 * rc + 0.001, Q47), H);
  // OSC OUT: t1' (1.38 RC) HIGH, t2 LOW, then t1/t2 of 1.1 RC each.
  assert.equal(at(1.38 * rc - 0.001, OSC47), H);
  assert.equal(at(1.38 * rc + 0.001, OSC47), L);
  assert.equal(at(2.48 * rc + 1.1 * rc - 0.001, OSC47), H);
  assert.equal(at(2.48 * rc + 1.1 * rc + 0.001, OSC47), L);
});

test("CD4047B astable is gated by ASTABLE HIGH or ASTABLĒ LOW", () => {
  // Pin 4 LOW alone enables it, with pin 5 LOW too.
  const { b } = cd4047({ ties: { 4: "L", 5: "L", 6: "L", 8: "L", 9: "L", 12: "L" } }); // prettier-ignore
  const sim = runner(b.doc);
  assert.equal(sim.run(0).level(Q47), H);
  assert.equal(sim.run(0.03).level(Q47), L, "running");
});

test("CD4047B one-shot: +TRIGGER rising gives one 2.48·RC pulse", () => {
  const { b } = cd4047({ ties: { 4: "H", 5: "L", 6: "L", 8: "trig", 9: "L", 12: "L" } }); // prettier-ignore
  const sim = runner(b.doc);
  const rc = 10e-3;
  const lo = new Map([["trig", L]]);
  const hi = new Map([["trig", H]]);
  assert.equal(sim.run(0, lo).level(Q47), L, "idle: Q LOW");
  assert.equal(sim.level(QN47), H);
  assert.equal(sim.run(0.1, hi).level(Q47), H, "the rising edge fires it");
  assert.equal(sim.level(OSC47), H, "the oscillator's long first half");
  assert.equal(sim.run(0.1 + 1.38 * rc + 0.001, hi).level(OSC47), L);
  assert.equal(sim.run(0.11, lo).level(Q47), H);
  assert.equal(sim.run(0.115, hi).level(Q47), H, "not retriggered…");
  assert.equal(sim.run(0.1 + 2.48 * rc + 0.001, hi).level(Q47), L, "…ends on time"); // prettier-ignore
});

test("CD4047B one-shot: RETRIGGER during the pulse restarts it; EXT RESET ends it", () => {
  const { b } = cd4047({ ties: { 4: "H", 5: "L", 6: "L", 8: "trig", 9: "rst", 12: "re" } }); // prettier-ignore
  const sim = runner(b.doc);
  const rc = 10e-3;
  const lv = (trig, re, rst = L) =>
    new Map([
      ["trig", trig],
      ["re", re],
      ["rst", rst],
    ]);
  sim.run(0, lv(L, L));
  sim.run(0.1, lv(H, L));
  sim.run(0.11, lv(H, H)); // retrigger 10 ms in
  assert.equal(sim.run(0.1 + 2.48 * rc + 0.002, lv(H, H)).level(Q47), H, "extended"); // prettier-ignore
  assert.equal(sim.run(0.11 + 2.48 * rc + 0.001, lv(H, H)).level(Q47), L);
  sim.run(0.2, lv(L, L));
  sim.run(0.21, lv(H, L));
  assert.equal(sim.level(Q47), H);
  assert.equal(sim.run(0.215, lv(H, L, H)).level(Q47), L, "EXT RESET ends it");
});

test("CD4047B with no R or no C says which", () => {
  const b = bench();
  powered(b, "u1", "CD4047B", "e10");
  const r = runner(b.doc).run(0).result;
  assert.deepEqual(
    r.timing.get("u1").problems.map((p) => p.code),
    ["noResistor", "noCapacitor"],
  );
  assert.ok(r.warnings.some((w) => w.type === "timing" && w.chip === "u1"));
});

// ── CD4098B / CD4538B ───────────────────────────────────────────────────────

/**
 * A dual one-shot at e10: section 1 with Rx to VDD and Cx from RX CX to CX,
 * RESET1 and −TR1 tied HIGH, +TR1 on a signal; section 2 unused (+TR2 and
 * RESET2 LOW, −TR2 HIGH — Table I's "unused section").
 */
function dual(ref, { r = 100e3, c = 1e-6, capTo = "cx", reset = "H" } = {}) {
  const b = bench();
  const u = powered(b, "u1", ref, "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(2));
  b.vcc(res.get(2));
  if (c) {
    const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
    b.link(cap.get(1), u.get(2));
    if (capTo === "cx") b.link(cap.get(2), u.get(1));
    else b.gnd(cap.get(2));
  }
  if (reset === "H") b.vcc(u.get(3));
  else b.signal("rst", u.get(3), "high");
  b.signal("trig", u.get(4), "low");
  b.vcc(u.get(5));
  b.gnd(u.get(12));
  b.gnd(u.get(13));
  b.vcc(u.get(11));
  return { b, u };
}

// The dual one-shot at e10: Q1 6 → e15, Q̄1 7 → e16.
const Q1 = "e15";
const QN1 = "e16";

for (const [ref, k] of [
  ["CD4098B", 0.5],
  ["CD4538B", 1],
]) {
  test(`${ref}: a rising +TR gives a ${k === 1 ? "" : "½·"}Rx·Cx pulse`, () => {
    const { b } = dual(ref);
    const sim = runner(b.doc);
    const lo = new Map([["trig", L]]);
    const hi = new Map([["trig", H]]);
    const r = sim.run(0, lo).result;
    const [s1, s2] = r.timing.get("u1").sections;
    assert.equal(s1.mode, "monostable");
    close(s1.width, k * 100e3 * 1e-6, 1e-9, "T");
    assert.equal(s2.mode, "unused", "an unused section says nothing");
    assert.deepEqual(r.timing.get("u1").problems, []);
    assert.ok(!r.warnings.some((w) => w.type === "timing"));
    assert.ok(!r.warnings.some((w) => w.type === "floating-input"));
    const T = s1.width;
    assert.equal(sim.level(Q1), L);
    assert.equal(sim.level(QN1), H);
    assert.equal(sim.run(1, hi).level(Q1), H);
    assert.equal(sim.level(QN1), L);
    close(sim.result.wakeAt, 1 + T, 1e-9, "wakeAt");
    assert.equal(sim.run(1 + T - 0.001, hi).level(Q1), H);
    assert.equal(sim.run(1 + T + 0.001, hi).level(Q1), L);
  });

  test(`${ref}: retriggerable — each trigger extends the pulse a full period`, () => {
    const { b } = dual(ref);
    const sim = runner(b.doc);
    const T = k * 100e3 * 1e-6;
    const lo = new Map([["trig", L]]);
    const hi = new Map([["trig", H]]);
    sim.run(0, lo);
    sim.run(1, hi);
    sim.run(1 + T / 2, lo);
    sim.run(1 + T * 0.6, hi); // retrigger
    assert.equal(sim.run(1 + T + 0.001, hi).level(Q1), H, "still going");
    assert.equal(sim.run(1 + T * 1.6 + 0.001, hi).level(Q1), L);
  });

  test(`${ref}: RESET LOW ends a pulse at once and blocks triggers`, () => {
    const { b } = dual(ref, { reset: "flag" });
    const sim = runner(b.doc);
    const lv = (trig, rst) =>
      new Map([
        ["trig", trig],
        ["rst", rst],
      ]);
    sim.run(0, lv(L, H));
    assert.equal(sim.run(1, lv(H, H)).level(Q1), H);
    assert.equal(sim.run(1.01, lv(H, L)).level(Q1), L, "ended");
    sim.run(1.02, lv(L, L));
    assert.equal(sim.run(1.03, lv(H, L)).level(Q1), L, "no trigger taken");
  });

  test(`${ref}: Cx to GND is the same capacitor (CX is VSS inside the part)`, () => {
    const { b } = dual(ref, { capTo: "gnd" });
    const s1 = runner(b.doc).run(0).result.timing.get("u1").sections[0];
    assert.equal(s1.mode, "monostable");
    close(s1.width, k * 100e3 * 1e-6, 1e-9, "T");
  });

  test(`${ref}: a section in use with no capacitor says so, and holds Q LOW`, () => {
    const { b } = dual(ref, { c: 0 });
    const sim = runner(b.doc);
    const r = sim.run(0, new Map([["trig", L]])).result;
    const problems = r.timing.get("u1").problems;
    assert.deepEqual(
      problems.map((p) => [p.code, p.section]),
      [["noCapacitor", 1]],
    );
    assert.equal(sim.run(1, new Map([["trig", H]])).level(Q1), L);
    assert.match(
      timingDescription(r.timing.get("u1")),
      /Section 1: no timing capacitor from RX CX \(2\) to CX \(1\) \/ GND/,
    );
  });
}

test("−TR falling (with +TR LOW) fires a 4098 too: +TR OR NOT −TR, rising", () => {
  const b = bench();
  const u = powered(b, "u1", "CD4098B", "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: 100e3 });
  b.link(res.get(1), u.get(2));
  b.vcc(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: 1e-6 });
  b.link(cap.get(1), u.get(2));
  b.link(cap.get(2), u.get(1));
  b.vcc(u.get(3));
  b.gnd(u.get(4)); // +TR LOW
  b.signal("ntr", u.get(5), "high");
  for (const pin of [12, 13]) b.gnd(u.get(pin));
  b.vcc(u.get(11));
  const sim = runner(b.doc);
  sim.run(0, new Map([["ntr", H]]));
  assert.equal(sim.run(1, new Map([["ntr", L]])).level(Q1), H);
});

// ── CD4060B ─────────────────────────────────────────────────────────────────

// The 4060 at e10: Q12 1 → e10, Q13 2 → e11, Q14 3 → e12, Q4 7 → e16;
// φO 9 → f17, φ̄O 10 → f16, φI 11 → f15, RESET 12 → f14.

/** Fig. 12: Cx from φO to a junction, Rx from φ̄O, Rs from φI. */
function rc4060({ rx = 10e3, rs = 47e3, cx = 10e-9, withRs = true } = {}) {
  const b = bench();
  const u = powered(b, "u1", "CD4060B", "e10");
  const cap = b.seat("c1", "cap-ceramic", "a30", { farads: cx });
  b.link(cap.get(1), u.get(9));
  const junction = cap.get(2);
  const rX = b.seat("r1", "resistor", "a40", { ohms: rx });
  b.link(rX.get(1), u.get(10));
  b.link(rX.get(2), junction);
  if (withRs) {
    const rS = b.seat("r2", "resistor", "a50", { ohms: rs });
    b.link(rS.get(1), u.get(11));
    b.link(rS.get(2), junction);
  }
  b.gnd(u.get(12)); // RESET LOW: counting
  return { b, u };
}

test("CD4060B RC oscillator: T = 2.2·Rx·Cx, and the counter divides it down", () => {
  const { b } = rc4060();
  const sim = runner(b.doc);
  const r = sim.run(0).result;
  const s = r.timing.get("u1").sections[0];
  assert.equal(s.mode, "oscillator");
  const T = 2.2 * 10e3 * 10e-9; // 220 µs → 4.55 kHz
  close(s.period, T, 1e-9, "T");
  close(s.frequency, 1 / T, 1e-9, "f");
  assert.ok(
    !r.warnings.some((w) => w.type === "floating-input"),
    "φI is wired",
  );
  // The slow stages read the TRUE count: at 0.5 s, 2273 falling edges —
  // Q12 (2048s) set, Q13 (4096s) clear.
  sim.run(0.5);
  assert.equal(sim.level("e10"), H, "Q12");
  assert.equal(sim.level("e11"), L, "Q13");
  sim.run(1.0); // 4546 edges: Q13 set, Q12 clear (4546 = 4096 + 450)
  assert.equal(sim.level("e10"), L, "Q12");
  assert.equal(sim.level("e11"), H, "Q13");
  // …while Q4 (a 3.5 ms period) is too fast to show, and oscillates at the cap.
  const half = 1 / (2 * TIMING_CAP_HZ);
  const q4a = sim.run(2).level("e16");
  const q4b = sim.run(2 + half).level("e16");
  assert.notEqual(q4a, q4b, "Q4 shown oscillating at the cap");
});

test("CD4060B RESET HIGH clears every stage and stops the oscillator", () => {
  const b = bench();
  const u = powered(b, "u1", "CD4060B", "e10");
  const cap = b.seat("c1", "cap-ceramic", "a30", { farads: 10e-9 });
  b.link(cap.get(1), u.get(9));
  const rX = b.seat("r1", "resistor", "a40", { ohms: 10e3 });
  b.link(rX.get(1), u.get(10));
  b.link(rX.get(2), cap.get(2));
  const rS = b.seat("r2", "resistor", "a50", { ohms: 47e3 });
  b.link(rS.get(1), u.get(11));
  b.link(rS.get(2), cap.get(2));
  b.signal("rst", u.get(12), "low");
  const sim = runner(b.doc);
  sim.run(0, new Map([["rst", L]]));
  sim.run(0.5, new Map([["rst", L]]));
  assert.equal(sim.level("e10"), H, "Q12 counted up");
  const held = sim.run(0.6, new Map([["rst", H]]));
  for (const hole of ["e10", "e11", "e12", "e16"]) {
    assert.equal(held.level(hole), L, hole);
  }
  assert.equal(held.result.wakeAt, null, "the oscillator has stopped");
});

test("CD4060B counts an external clock on φI's falling edges", () => {
  const b = bench();
  const u = powered(b, "u1", "CD4060B", "e10");
  b.signal("clk", u.get(11), "low");
  b.gnd(u.get(12));
  const sim = runner(b.doc);
  const r = sim.run(0, new Map([["clk", L]])).result;
  assert.equal(r.timing.get("u1").sections[0].mode, "external");
  assert.equal(r.wakeAt, null, "nothing timed");
  // 8 falling edges → Q4 (bit 3) HIGH.
  for (let i = 0; i < 8; i++) {
    sim.run(0, new Map([["clk", H]]));
    sim.run(0, new Map([["clk", L]]));
  }
  assert.equal(sim.level("e16"), H, "Q4 after 8 counts");
  // φO follows φI, φ̄O is it inverted.
  sim.run(0, new Map([["clk", H]]));
  assert.equal(sim.level("f17"), H, "φO");
  assert.equal(sim.level("f16"), L, "φ̄O");
});

test("CD4060B with half an RC network says so instead of guessing", () => {
  const { b } = rc4060({ withRs: false });
  const r = runner(b.doc).run(0).result;
  assert.deepEqual(
    r.timing.get("u1").problems.map((p) => p.code),
    ["cd4060Incomplete"],
  );
  assert.ok(r.warnings.some((w) => w.type === "timing" && w.chip === "u1"));
});

test("a floating trigger on a CMOS one-shot is unknown, not a pulse", () => {
  const b = bench();
  const u = powered(b, "u1", "CD4098B", "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: 100e3 });
  b.link(res.get(1), u.get(2));
  b.vcc(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: 1e-6 });
  b.link(cap.get(1), u.get(2));
  b.link(cap.get(2), u.get(1));
  b.vcc(u.get(3));
  b.vcc(u.get(5));
  // +TR1 (4) left floating.
  for (const pin of [12, 13]) b.gnd(u.get(pin));
  b.vcc(u.get(11));
  const sim = runner(b.doc);
  const r = sim.run(0).result;
  assert.ok(r.warnings.some((w) => w.type === "floating-input"));
  assert.notEqual(sim.level(Q1), H);
  assert.ok([L, X].includes(sim.level(Q1)));
});
