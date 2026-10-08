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

// The RC-timed CD4000 parts in circuit, each held to its own datasheet: the
// CD4047B (SCHS044C), the CD4060B (SCHS049C), the CD4098B (SCHS065C), the
// CD4528B (HGSEMI V1.4), the CD4538B (SCHS093C) and the CD4541B (SCHS085E).
// Each reads its R and C off the wiring through the shared trace and turns
// them into time by its own formula.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, X } from "../sim/levels.js";
import { TIMING_CAP_HZ } from "../sim/timing.js";
import { chipDef } from "../catalog/index.js";
import { timingDescription } from "../model/timing-summary.js";
import { cd4541Stages } from "../sim/programmable-timer.js";
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

test("CD4047B retrigger mode: one more pulse adds one oscillator period — tRE = t1' + t1 + 2·t2", () => {
  // The retriggerable hook-up (Table: input to 8 AND 12), driven as one signal.
  const { b } = cd4047({ ties: { 4: "H", 5: "L", 6: "L", 9: "rst", 8: "in", 12: "in" } }); // prettier-ignore
  const sim = runner(b.doc);
  const rc = 10e-3;
  const lv = (input, rst = L) =>
    new Map([
      ["in", input],
      ["rst", rst],
    ]);
  sim.run(0, lv(L));
  // One input pulse: an ordinary 2.48·RC — the rise that starts it is the
  // trigger, not a retrigger.
  sim.run(0.1, lv(H));
  sim.run(0.105, lv(L));
  assert.equal(sim.run(0.1 + 2.48 * rc - 0.001, lv(L)).level(Q47), H);
  assert.equal(sim.run(0.1 + 2.48 * rc + 0.001, lv(L)).level(Q47), L);
  // Two input pulses: the second, inside the first period, buys one more
  // period of t1 + t2 = 2.2·RC.
  sim.run(0.2, lv(H));
  sim.run(0.205, lv(L));
  sim.run(0.21, lv(H));
  sim.run(0.215, lv(L));
  const tRE = (2.48 + 2.2) * rc;
  assert.equal(sim.run(0.2 + 2.48 * rc + 0.001, lv(L)).level(Q47), H, "extended"); // prettier-ignore
  // OSC OUT runs through the extension: HIGH for t1, then LOW for t2.
  assert.equal(sim.level(OSC47), H);
  assert.equal(sim.run(0.2 + (2.48 + 1.1) * rc + 0.001, lv(L)).level(OSC47), L);
  assert.equal(sim.run(0.2 + tRE - 0.001, lv(L)).level(Q47), H);
  assert.equal(sim.run(0.2 + tRE + 0.001, lv(L)).level(Q47), L);
  // Held HIGH, it retriggers "as long as the RETRIGGER input is high, with or
  // without transitions": the pulse outlasts it, ending at the period after.
  sim.run(0.4, lv(H));
  assert.equal(sim.run(0.4 + 10 * rc, lv(H)).level(Q47), H, "held");
  // Periods end at 2.48, 4.68, 6.88, 9.08, 11.28 RC; it falls inside the
  // fifth, which is the last.
  sim.run(0.4 + 10.5 * rc, lv(L));
  assert.equal(sim.run(0.4 + 11.2 * rc, lv(L)).level(Q47), H);
  assert.equal(sim.run(0.4 + 11.35 * rc, lv(L)).level(Q47), L);
  // EXT RESET ends a pulse at once.
  sim.run(0.6, lv(H));
  assert.equal(sim.level(Q47), H);
  assert.equal(sim.run(0.605, lv(H, H)).level(Q47), L, "EXT RESET ends it");
});

test("CD4047B: +TRIGGER alone is not retriggerable — RETRIGGER LOW, a second rise changes nothing", () => {
  const { b } = cd4047({ ties: { 4: "H", 5: "L", 6: "L", 8: "trig", 9: "L", 12: "L" } }); // prettier-ignore
  const sim = runner(b.doc);
  const rc = 10e-3;
  const lv = (v) => new Map([["trig", v]]);
  sim.run(0, lv(L));
  sim.run(0.1, lv(H));
  sim.run(0.11, lv(L));
  sim.run(0.115, lv(H));
  assert.equal(sim.run(0.1 + 2.48 * rc + 0.001, lv(H)).level(Q47), L);
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
 * RESET2 LOW, −TR2 HIGH — Table I's "unused section"). A CD4528B also has
 * both CX pins (T1A, T1B) wired to GND, as its sheet says to, unless
 * `groundCx` is false.
 */
function dual(
  ref,
  {
    r = 100e3,
    c = 1e-6,
    capTo = "cx",
    reset = "H",
    groundCx = true,
    volts,
  } = {},
) {
  const b = bench(volts ? { volts } : {});
  const u = powered(b, "u1", ref, "e10");
  if (ref === "CD4528B" && groundCx) {
    b.gnd(u.get(1));
    b.gnd(u.get(15));
  }
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

// The CD4528B's T = 0.2·Rx·Cx·ln(VDD − VSS), on the bench's 5 V supply.
const K4528 = 0.2 * Math.log(5);

for (const [ref, k, formula] of [
  ["CD4098B", 0.5, "½·Rx·Cx"],
  ["CD4528B", K4528, "0.2·Rx·Cx·ln(VDD)"],
  ["CD4538B", 1, "Rx·Cx"],
]) {
  test(`${ref}: a rising +TR gives a ${formula} pulse`, () => {
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

  test(`${ref}: Cx to GND is the same capacitor as Cx to CX`, () => {
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
    const [rxcx, cx] = ref === "CD4528B" ? ["T2A", "T1A"] : ["RX CX", "CX"];
    assert.ok(
      timingDescription(r.timing.get("u1")).includes(
        `Section 1: no timing capacitor from ${rxcx} (2) to ${cx} (1) / GND`,
      ),
    );
  });
}

test("CD4528B: T1 is not grounded inside the part — left off GND, it says so", () => {
  const { b } = dual("CD4528B", { groundCx: false });
  const sim = runner(b.doc);
  const r = sim.run(0, new Map([["trig", L]])).result;
  const analysis = r.timing.get("u1");
  assert.deepEqual(
    analysis.problems.map((p) => [p.code, p.section, p.pin]),
    [["notGrounded", 1, "T1A (1)"]],
  );
  assert.equal(analysis.sections[0].mode, null);
  assert.match(timingDescription(analysis), /T1A \(1\) must be wired to GND/);
  assert.equal(sim.run(1, new Map([["trig", H]])).level(Q1), L, "no pulse");
  // Nor does a capacitor straight to GND excuse it: T1 is part of the
  // circuit ("always connected to ground"), not merely where Cx may land.
  const { b: toGnd } = dual("CD4528B", { groundCx: false, capTo: "gnd" });
  const late = runner(toGnd.doc).run(0).result.timing.get("u1");
  assert.equal(late.sections[0].mode, null);
  assert.equal(late.problems[0]?.code, "notGrounded");
});

test("CD4528B: its pulse lengthens with the supply — 0.2·Rx·Cx·ln(VDD)", () => {
  for (const volts of [5, 9, 12, 15]) {
    const { b } = dual("CD4528B", { volts });
    const [s1] = runner(b.doc).run(0).result.timing.get("u1").sections;
    close(s1.width, 0.2 * 100e3 * 1e-6 * Math.log(volts), 1e-9, `${volts} V`);
  }
});

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
  // …and Q4 (a 3.5 ms period, 284 Hz) is slow enough for the 1 kHz cap to
  // show at its TRUE rate: half ITS period on it differs, half the cap's
  // does not. (t = 2 s falls 36% of the way through one of its halves.)
  const q4a = sim.run(2).level("e16");
  assert.equal(sim.run(2 + 1 / (2 * TIMING_CAP_HZ)).level("e16"), q4a, "not at the cap"); // prettier-ignore
  assert.notEqual(sim.run(2 + 8 * T).level("e16"), q4a, "Q4 at its true rate");
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

// ── CD4541B ─────────────────────────────────────────────────────────────────

// The 4541 at e10: RTC 1 → e10, CTC 2 → e11, RS 3 → e12, AUTO RESET 5 → e14,
// MASTER RESET 6 → e15; OUTPUT 8 → f16, Q/Q̄ SELECT 9 → f15, MODE 10 → f14,
// A 12 → f12, B 13 → f11.
const OUT41 = "f16";

/**
 * A 4541 with Fig. 2's network (Ctc from CTC to a junction, Rtc from RTC, Rs
 * from RS) unless `network` is false, and every control on a rail — by
 * default AUTO RESET and MASTER RESET LOW, Q/Q̄ SELECT LOW, MODE HIGH
 * (recycle), A HIGH and B LOW (2^8). `ties` overrides one: "H", "L", or a
 * signal id.
 */
function cd4541({
  rtc = 10e3,
  rs = 22e3,
  ctc = 10e-9,
  network = true,
  ties = {},
} = {}) {
  const b = bench();
  const u = powered(b, "u1", "CD4541B", "e10");
  if (network === true || network === "cap") {
    const cap = b.seat("c1", "cap-ceramic", "a30", { farads: ctc });
    b.link(cap.get(1), u.get(2));
    if (network === true) {
      const junction = cap.get(2);
      const rT = b.seat("r1", "resistor", "a40", { ohms: rtc });
      b.link(rT.get(1), u.get(1));
      b.link(rT.get(2), junction);
      const rS = b.seat("r2", "resistor", "a50", { ohms: rs });
      b.link(rS.get(1), u.get(3));
      b.link(rS.get(2), junction);
    }
  }
  const all = { 5: "L", 6: "L", 9: "L", 10: "H", 12: "H", 13: "L", ...ties };
  for (const [pin, how] of Object.entries(all)) {
    if (how === "H") b.vcc(u.get(Number(pin)));
    else if (how === "L") b.gnd(u.get(Number(pin)));
    else b.signal(how, u.get(Number(pin)), "low");
  }
  return { b, u };
}

// Fig. 2's oscillator at the defaults: T = 2.3 × 10 kΩ × 10 nF = 230 µs.
const T41 = 2.3 * 10e3 * 10e-9;
/** When the c-th count lands: the first rising clock edge is half a period in. */
const count41 = (c, t0 = 0) => t0 + T41 / 2 + (c - 1) * T41;

test("CD4541B: the Frequency Selection Table — A and B pick 2^13, 2^10, 2^8 or 2^16", () => {
  assert.equal(cd4541Stages(L, L), 13);
  assert.equal(cd4541Stages(L, H), 10);
  assert.equal(cd4541Stages(H, L), 8);
  assert.equal(cd4541Stages(H, H), 16);
  assert.equal(cd4541Stages(X, L), null);
});

test("CD4541B RC oscillator: f = 1/(2.3·Rtc·Ctc); recycling, the output is f/2^N", () => {
  const { b } = cd4541();
  const sim = runner(b.doc);
  const r = sim.run(0).result;
  const [s] = r.timing.get("u1").sections;
  assert.equal(s.mode, "oscillator");
  close(s.period, T41, 1e-9, "T");
  assert.deepEqual(r.timing.get("u1").problems, []);
  assert.match(
    timingDescription(r.timing.get("u1")),
    /RC oscillator — 4\.35 kHz/,
  );
  assert.ok(!r.warnings.some((w) => w.type === "floating-input"));
  // Stage 8 rises after 2^7 counts and falls after 2^8: a square wave of
  // 256 periods.
  assert.equal(sim.level(OUT41), L);
  assert.equal(sim.run(count41(128) - T41 / 10).level(OUT41), L);
  assert.equal(sim.run(count41(128) + T41 / 10).level(OUT41), H);
  assert.equal(sim.run(count41(256) - T41 / 10).level(OUT41), H);
  assert.equal(sim.run(count41(256) + T41 / 10).level(OUT41), L);
  assert.equal(sim.run(count41(384) + T41 / 10).level(OUT41), H, "and again");
});

test("CD4541B: A and B LOW pick 2^13 — 4096 counts to the first transition", () => {
  const { b } = cd4541({ ties: { 12: "L" } });
  const sim = runner(b.doc);
  sim.run(0);
  assert.equal(sim.run(count41(4096) - T41 / 10).level(OUT41), L);
  assert.equal(sim.run(count41(4096) + T41 / 10).level(OUT41), H);
});

test("CD4541B MODE LOW: ONE transition after 2^(N−1) counts, held", () => {
  const { b } = cd4541({ ties: { 10: "L" } });
  const sim = runner(b.doc);
  sim.run(0);
  assert.equal(sim.run(count41(128) - T41 / 10).level(OUT41), L);
  assert.equal(sim.run(count41(128) + T41 / 10).level(OUT41), H);
  assert.equal(sim.run(count41(256) + T41 / 10).level(OUT41), H, "held");
  assert.equal(sim.run(count41(1000)).level(OUT41), H);
});

test("CD4541B Q/Q̄ SELECT HIGH starts the output HIGH and inverts it", () => {
  const { b } = cd4541({ ties: { 9: "H" } });
  const sim = runner(b.doc);
  assert.equal(sim.run(0).level(OUT41), H);
  assert.equal(sim.run(count41(128) + T41 / 10).level(OUT41), L);
});

test("CD4541B MASTER RESET HIGH clears it and stops it; its fall starts it again", () => {
  const { b } = cd4541({ ties: { 6: "mr" } });
  const sim = runner(b.doc);
  const mr = (lv) => new Map([["mr", lv]]);
  sim.run(0, mr(L));
  assert.equal(sim.run(count41(130), mr(L)).level(OUT41), H, "counting");
  const held = count41(140);
  assert.equal(sim.run(held, mr(H)).level(OUT41), L, "cleared");
  assert.equal(sim.result.wakeAt, null, "the oscillator is stopped");
  const t0 = count41(400);
  sim.run(t0, mr(L));
  assert.equal(sim.run(count41(128, t0) - T41 / 10, mr(L)).level(OUT41), L);
  assert.equal(sim.run(count41(128, t0) + T41 / 10, mr(L)).level(OUT41), H);
});

test("CD4541B AUTO RESET HIGH: nothing counts until a MASTER RESET pulse", () => {
  const { b } = cd4541({ ties: { 5: "H", 6: "mr" } });
  const sim = runner(b.doc);
  const mr = (lv) => new Map([["mr", lv]]);
  sim.run(0, mr(L));
  assert.equal(sim.result.wakeAt, null, "waiting");
  assert.equal(sim.run(count41(500), mr(L)).level(OUT41), L);
  const t0 = count41(510);
  sim.run(count41(505), mr(H));
  sim.run(t0, mr(L));
  assert.equal(sim.run(count41(128, t0) + T41 / 10, mr(L)).level(OUT41), H);
});

test("CD4541B counts an external clock's FALLING edges on RS (its clock is RS inverted)", () => {
  const { b } = cd4541({ network: false, ties: { 3: "clk" } });
  const sim = runner(b.doc);
  const clk = (lv) => new Map([["clk", lv]]);
  const r = sim.run(0, clk(L)).result;
  assert.equal(r.timing.get("u1").sections[0].mode, "external");
  assert.match(
    timingDescription(r.timing.get("u1")),
    /Counting an external clock on RS \(3\)/,
  );
  let t = 0;
  for (let edge = 1; edge <= 128; edge++) {
    assert.equal(
      sim.run((t += 0.01), clk(H)).level(OUT41),
      L,
      "a rise counts nothing",
    );
    sim.run((t += 0.01), clk(L));
    assert.equal(
      sim.level(OUT41),
      edge < 128 ? L : H,
      `after falling edge ${edge}`,
    );
    // CTC is the clock — RS inverted — and RTC its complement.
    assert.equal(sim.level("e11"), H, "CTC");
    assert.equal(sim.level("e10"), L, "RTC");
  }
});

test("CD4541B with half an RC network says so instead of guessing", () => {
  const { b } = cd4541({ network: "cap" });
  const r = runner(b.doc).run(0).result;
  const analysis = r.timing.get("u1");
  assert.deepEqual(
    analysis.problems.map((p) => p.code),
    ["cd4541Incomplete"],
  );
  assert.match(
    timingDescription(analysis),
    /needs Ctc from CTC \(2\), Rtc from RTC \(1\) and Rs from RS \(3\)/,
  );
});

test("CD4541B: CTC drives the oscillator out, RTC its complement — drawn at the cap when too fast", () => {
  const { b } = cd4541();
  const sim = runner(b.doc);
  // The clock starts LOW and rises half a period in.
  assert.equal(sim.run(0).level("e11"), L, "CTC");
  assert.equal(sim.level("e10"), H, "RTC");
  // 4.35 kHz is past the cap: CTC shows the cap's half-period instead.
  const half = 1 / (2 * TIMING_CAP_HZ);
  assert.equal(sim.run(half + 1e-6).level("e11"), H);
  assert.match(
    timingDescription(sim.result.timing.get("u1")),
    /Faster than the desk can show: drawn at 1 kHz/,
  );
  // …while the counter keeps the TRUE count: stage 8 still rises 128 true
  // periods in.
  assert.equal(sim.run(count41(128) + T41 / 10).level(OUT41), H);
  // A slow oscillator is shown as it is.
  const slow = cd4541({ rtc: 1e6, ctc: 1e-6 });
  assert.doesNotMatch(
    timingDescription(runner(slow.b.doc).run(0).result.timing.get("u1")),
    /Faster than the desk can show/,
  );
});

// ── A value changed while the circuit runs ──────────────────────────────────

test("CD4060B: a value changed while it runs keeps the count — only the rate changes", () => {
  // T = 22 ms: slow enough that Q4 shows the true count, not the cap's wave.
  const { b } = rc4060({ cx: 1e-6 });
  const sim = runner(b.doc);
  const T = 2.2 * 10e3 * 1e-6;
  sim.run(0);
  const stages = () => ["e10", "e11", "e12", "e16"].map((h) => sim.level(h));
  const t = 1;
  sim.run(t);
  const before = stages();
  b.doc.components.find((c) => c.id === "r1").params.ohms = 20e3; // Rx doubled
  sim.run(t);
  assert.deepEqual(stages(), before, "the count did not jump");
  // Q4 (pin 7, e16) next flips at the next multiple of 8 counts — reached
  // from the same point in the current period, at twice the period.
  const position = t / T; // periods run so far
  const counts = Math.floor(position - 0.5) + 1;
  const target = counts + (8 - (counts % 8));
  const flip = t + (target - 0.5 - position) * 2 * T;
  assert.equal(sim.run(flip - T).level("e16"), before[3]);
  assert.notEqual(sim.run(flip + T / 2).level("e16"), before[3]);
});

test("CD4541B: a value changed while it runs keeps the count — only the rate changes", () => {
  const { b } = cd4541({ ties: { 10: "L" } }); // single transition at 128 counts
  const sim = runner(b.doc);
  sim.run(0);
  const t = count41(100);
  assert.equal(sim.run(t).level(OUT41), L);
  b.doc.components.find((c) => c.id === "r1").params.ohms = 20e3; // Rtc doubled
  assert.equal(
    sim.run(t).level(OUT41),
    L,
    "no transition from a rewritten count",
  );
  // 28 counts to go, each now twice as long.
  const at = t + 28 * 2 * T41;
  assert.equal(sim.run(at - T41).level(OUT41), L);
  assert.equal(sim.run(at + T41).level(OUT41), H);
});

test("CD4047B astable: a value changed while it runs carries the cycle on", () => {
  const { b } = cd4047({ ties: { 4: "H", 5: "H", 6: "L", 8: "L", 9: "L", 12: "L" } }); // prettier-ignore
  const sim = runner(b.doc);
  sim.run(0);
  let flips = 0;
  for (let k = 1; k <= 20; k++) {
    const t = 0.3 + k * 0.0037;
    const before = [Q47, OSC47].map((h) => sim.run(t).level(h));
    const r = b.doc.components.find((c) => c.id === "r1");
    r.params.ohms = r.params.ohms === 10e3 ? 15e3 : 10e3;
    const after = [Q47, OSC47].map((h) => sim.run(t).level(h));
    if (before.join() !== after.join()) flips++;
  }
  assert.equal(flips, 0, "no output jumped at the instant of a change");
});
