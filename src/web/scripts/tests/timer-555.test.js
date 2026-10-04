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

// The 555 in circuit (sim/timer-555.js), held to TI's NE555 datasheet
// (SLFS022K): it reads its own configuration off the wiring — astable,
// monostable, bistable, or none of them, said rather than guessed — and its
// output follows the datasheet's formulas in simulated time, shown at the
// desk's cap when the true rate is faster.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { settle } from "../sim/engine.js";
import { TIMING_CAP_HZ } from "../sim/timing.js";
import { partDef } from "../catalog/index.js";
import { supplyRange } from "../catalog/families.js";
import {
  timingCapped,
  timingDescription,
  timingReadout,
} from "../model/timing-summary.js";
import { astable555, bench, runner } from "./timing-fixtures.js";

// The 555 seated at e10: GND 1 e10, TRIG 2 e11, OUT 3 e12, RESET 4 e13,
// CONT 5 f13, THRES 6 f12, DISCH 7 f11, VCC 8 f10.
const OUT = "e12";

/** A 555 powered, RESET tied high, with nothing on its timing pins yet. */
function powered555(opts = {}) {
  const b = bench(opts);
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4)); // RESET unused → VCC, as §6.3.1 says
  return { b, u };
}

/** Figure 6-5: the astable circuit, RA from DISCH to VCC, RB from DISCH to
    TRIG+THRES, C from there to GND. */
const astable = (ra, rb, c, { capRef = "cap-electrolytic" } = {}) =>
  astable555({ ra, rb, c, capRef }).doc;

/** Figure 6-2: the monostable circuit, THRES+DISCH on C to GND and RA to VCC;
    TRIG on a signal flag resting HIGH. */
function monostable(ra, c) {
  const { b, u } = powered555();
  b.link(u.get(6), u.get(7)); // THRES ↔ DISCH
  const capHoles = b.seat("c1", "cap-electrolytic", "a30", { farads: c });
  b.link(capHoles.get(1), u.get(6));
  b.gnd(capHoles.get(2));
  const rA = b.seat("r1", "resistor", "a40", { ohms: ra });
  b.link(rA.get(1), u.get(6));
  b.vcc(rA.get(2));
  b.signal("trig", u.get(2), "high");
  return b.doc;
}

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

// ── Astable ─────────────────────────────────────────────────────────────────

test("astable: frequency and duty cycle are the datasheet's, for several R and C", () => {
  for (const [ra, rb, c] of [
    [1e3, 10e3, 10e-6],
    [10e3, 10e3, 100e-6],
    [4.7e3, 47e3, 1e-6],
    [5e3, 3e3, 0.15e-6], // Figure 6-6's own example
  ]) {
    const doc = astable(ra, rb, c);
    const r = runner(doc).run(0).result;
    const a = r.timing.get("u1");
    assert.deepEqual(a.problems, [], `${ra}/${rb}/${c}`);
    const s = a.sections[0];
    assert.equal(s.mode, "astable");
    // Equations 1–3 exactly; eq. 4's 1.44 is 1/0.693 to three figures.
    close(s.high, 0.693 * (ra + rb) * c, 1e-9, "tH (eq. 1)");
    close(s.low, 0.693 * rb * c, 1e-9, "tL (eq. 2)");
    close(s.period, 0.693 * (ra + 2 * rb) * c, 1e-9, "T (eq. 3)");
    close(s.frequency, 1.44 / ((ra + 2 * rb) * c), 0.003, "f (eq. 4)");
    close(s.duty, (ra + rb) / (ra + 2 * rb), 1e-9, "duty (eq. 6)");
  }
});

test("astable: the output runs HIGH for tH, LOW for tL, and around again", () => {
  // RA 1k, RB 10k, C 10 µF: tH 76.23 ms, tL 69.3 ms — slower than the cap.
  const doc = astable(1e3, 10e3, 10e-6);
  const sim = runner(doc);
  const tH = 0.693 * 11e3 * 10e-6;
  const T = tH + 0.693 * 10e3 * 10e-6;
  const at = (now) => sim.run(now).level(OUT);
  assert.equal(at(0), H, "a discharged capacitor starts the cycle HIGH");
  assert.equal(at(tH - 0.001), H);
  assert.equal(at(tH + 0.001), L);
  assert.equal(at(T - 0.001), L);
  assert.equal(at(T + 0.001), H);
  assert.equal(at(3 * T + tH + 0.001), L, "and keeps its phase");
  // It asks to be woken at its next edge.
  const r = sim.run(3 * T + tH + 0.002).result;
  close(r.wakeAt, 4 * T, 1e-9, "wakeAt");
});

test("astable: an exact tick on a deadline is past it, not a hair short", () => {
  const doc = astable(1e3, 10e3, 10e-6);
  const sim = runner(doc);
  const first = sim.run(0).result.wakeAt;
  const second = sim.run(first).result;
  assert.equal(second.netLevels.get(sim.netlist.netOfPoint.get(`bb1.${OUT}`)), L); // prettier-ignore
  assert.ok(second.wakeAt > first + 1e-6, "the next deadline is a new one");
});

test("RESET LOW holds the output LOW; releasing it starts the cycle over", () => {
  const { b, u } = powered555();
  b.doc.wires.pop(); // un-tie RESET from VCC…
  b.signal("reset", u.get(4), "high"); // …and give it a flag instead
  b.link(u.get(2), u.get(6));
  const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 10e-6 });
  b.link(c.get(1), u.get(6));
  b.gnd(c.get(2));
  const rB = b.seat("r2", "resistor", "a40", { ohms: 10e3 });
  b.link(rB.get(1), u.get(7));
  b.link(rB.get(2), u.get(6));
  const rA = b.seat("r1", "resistor", "a50", { ohms: 1e3 });
  b.link(rA.get(1), u.get(7));
  b.vcc(rA.get(2));
  const sim = runner(b.doc);
  const low = new Map([["reset", L]]);
  const high = new Map([["reset", H]]);
  assert.equal(sim.run(0, high).level(OUT), H);
  assert.equal(sim.run(0.01, low).level(OUT), L, "RESET forces OUT LOW");
  assert.equal(sim.run(0.5, low).level(OUT), L, "…for as long as it is held");
  assert.equal(sim.result.wakeAt, null, "and nothing is pending");
  assert.equal(sim.run(0.6, high).level(OUT), H, "released: HIGH again");
  const tH = 0.693 * 11e3 * 10e-6;
  assert.equal(sim.run(0.6 + tH + 0.001, high).level(OUT), L, "from the top");
});

test("faster than the cap: drawn at the cap, duty kept, the TRUE rate reported", () => {
  // RA 1k, RB 1k, C 10 nF: 48 kHz — far past what the desk can show.
  const doc = astable(1e3, 1e3, 10e-9, { capRef: "cap-ceramic" });
  const sim = runner(doc);
  const a = sim.run(0).result.timing.get("u1");
  const f = a.sections[0].frequency;
  close(f, 1 / (0.693 * 3e3 * 10e-9), 1e-9, "the calculated frequency");
  assert.ok(f > 40e3);
  assert.equal(timingCapped(a), true);
  assert.equal(timingReadout(a), "48.1 kHz", "the true rate is what it says");
  // Shown at the cap: one cycle per 1/cap, HIGH for its duty share (2/3).
  const period = 1 / TIMING_CAP_HZ;
  assert.equal(sim.run(0).level(OUT), H);
  assert.equal(sim.run(period * 0.6).level(OUT), H);
  assert.equal(sim.run(period * 0.7).level(OUT), L);
  assert.equal(sim.run(period * 1.05).level(OUT), H, "and oscillating");
  close(sim.result.wakeAt, period * (1 + 2 / 3), 1e-9, "next shown edge");
});

// ── Monostable ──────────────────────────────────────────────────────────────

test("monostable: a falling TRIG starts one 1.1·RA·C pulse", () => {
  const ra = 10e3;
  const c = 10e-6;
  const doc = monostable(ra, c);
  const sim = runner(doc);
  const tw = 1.1 * ra * c; // 110 ms
  const a = sim.run(0, new Map([["trig", H]])).result.timing.get("u1");
  assert.equal(a.sections[0].mode, "monostable");
  close(a.sections[0].width, tw, 1e-9, "tw");
  assert.equal(sim.level(OUT), L, "idle LOW");
  const hi = new Map([["trig", H]]);
  const lo = new Map([["trig", L]]);
  assert.equal(sim.run(1, lo).level(OUT), H, "the falling edge sets it");
  close(sim.result.wakeAt, 1 + tw, 1e-9, "it will wake at the end");
  assert.equal(sim.run(1.02, hi).level(OUT), H, "TRIG back up: still timing");
  assert.equal(sim.run(1.05, lo).level(OUT), H, "not retriggered…");
  assert.equal(sim.run(1.06, hi).level(OUT), H);
  assert.equal(
    sim.run(1 + tw - 0.001, hi).level(OUT),
    H,
    "…so it ends on time",
  );
  assert.equal(sim.run(1 + tw + 0.001, hi).level(OUT), L);
  assert.equal(sim.result.wakeAt, null);
  assert.equal(sim.run(2, lo).level(OUT), H, "and fires again");
});

test("monostable: TRIG still LOW at the end holds the output HIGH until it lets go", () => {
  const doc = monostable(10e3, 10e-6);
  const sim = runner(doc);
  const lo = new Map([["trig", L]]);
  sim.run(0, new Map([["trig", H]]));
  sim.run(0.1, lo);
  assert.equal(sim.run(0.5, lo).level(OUT), H, "§6.3.1: TRIG must be high");
  assert.equal(sim.result.wakeAt, null, "nothing timed is pending");
  assert.equal(sim.run(0.6, new Map([["trig", H]])).level(OUT), L);
});

test("a pulse shorter than the desk can show is drawn at the shortest it can", () => {
  const doc = monostable(1e3, 1e-9); // 1.1 µs
  const sim = runner(doc);
  sim.run(0, new Map([["trig", H]]));
  sim.run(1, new Map([["trig", L]]));
  const r = sim.run(1.000001, new Map([["trig", H]]));
  assert.equal(r.level(OUT), H, "still showing: one edge lands on a counter");
  close(r.result.wakeAt, 1 + 1 / (2 * TIMING_CAP_HZ), 1e-9, "shown 5 ms");
  assert.equal(timingCapped(r.result.timing.get("u1")), true);
  assert.equal(timingReadout(r.result.timing.get("u1")), "1.1 µs");
});

// ── Bistable ────────────────────────────────────────────────────────────────

/** A set/reset latch: THRES on GND, TRIG and RESET each on a signal flag
    resting HIGH — to the 555, the same as a button to GND with a pull-up. */
function bistable() {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.gnd(u.get(6)); // THRES can never reach ⅔ VCC
  b.signal("set", u.get(2), "high");
  b.signal("reset", u.get(4), "high");
  return b.doc;
}

const latch = (set, reset) =>
  new Map([
    ["set", set],
    ["reset", reset],
  ]);

test("bistable: TRIG LOW latches OUT HIGH, RESET LOW latches it LOW", () => {
  const sim = runner(bistable());
  const a = sim.run(0, latch(H, H)).result.timing.get("u1");
  assert.deepEqual(a, { sections: [{ mode: "bistable" }], problems: [] });
  assert.equal(sim.level(OUT), L, "it powers up LOW");
  assert.equal(sim.run(1, latch(L, H)).level(OUT), H, "§6.4 row 2: TRIG sets");
  assert.equal(sim.run(2, latch(H, H)).level(OUT), H, "row 4: it holds…");
  assert.equal(sim.run(60, latch(H, H)).level(OUT), H, "…for as long as it likes"); // prettier-ignore
  assert.equal(sim.result.wakeAt, null, "nothing timed, so it never wakes");
  assert.equal(sim.run(61, latch(H, L)).level(OUT), L, "row 1: RESET clears");
  assert.equal(sim.run(62, latch(H, H)).level(OUT), L, "and LOW holds too");
  assert.equal(sim.run(63, latch(L, H)).level(OUT), H, "and it sets again");
  assert.ok(!sim.result.warnings.some((w) => w.type === "timing"));
});

test("bistable: RESET wins while both are held; a TRIG still held sets it after", () => {
  const sim = runner(bistable());
  sim.run(0, latch(H, H));
  assert.equal(sim.run(1, latch(L, L)).level(OUT), L, "§6.4 row 1 comes first");
  assert.equal(sim.run(2, latch(L, H)).level(OUT), H, "then row 2");
});

test("bistable: says what it is, and prints no rate on the chip", () => {
  const a = runner(bistable()).run(0, latch(H, H)).result.timing.get("u1");
  assert.equal(timingReadout(a), "");
  assert.equal(timingCapped(a), false);
  assert.equal(
    timingDescription(a),
    "Bistable — TRIG LOW sets the output HIGH, RESET LOW clears it",
  );
});

test("bistable as built on a bench: pull-ups, buttons to GND, DISCH grounded, CONT bypassed", () => {
  // The way it is usually drawn. Grounding DISCH beside THRES puts the two on
  // ONE net — a monostable's tell — and a closed SET button puts TRIG on it
  // too — an astable's — so neither may be asked before the bistable is.
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.gnd(u.get(6));
  b.gnd(u.get(7));
  const cv = b.seat("c1", "cap-ceramic", "a20", { farads: 10e-9 });
  b.link(cv.get(1), u.get(5));
  b.gnd(cv.get(2));
  const pullSet = b.seat("r1", "resistor", "a25", { ohms: 10e3 });
  b.link(pullSet.get(1), u.get(2));
  b.vcc(pullSet.get(2));
  const pullReset = b.seat("r2", "resistor", "a30", { ohms: 10e3 });
  b.link(pullReset.get(1), u.get(4));
  b.vcc(pullReset.get(2));
  const set = b.seat("s1", "sw-toggle", "a35");
  b.link(set.get(1), u.get(2));
  b.gnd(set.get(2));
  const reset = b.seat("s2", "sw-toggle", "a40");
  b.link(reset.get(1), u.get(4));
  b.gnd(reset.get(2));
  const led = b.seat("d1", "led", "a45");
  b.link(led.get(1), u.get(3));
  const rLed = b.seat("r3", "resistor", "a50", { ohms: 470 });
  b.link(led.get(2), rLed.get(1));
  b.gnd(rLed.get(2));

  const sim = runner(b.doc);
  const press = (now, { s1 = false, s2 = false }) => {
    for (const [id, on] of [
      ["s1", s1],
      ["s2", s2],
    ]) {
      b.doc.components.find((c) => c.id === id).params.on = on;
    }
    sim.rebuild();
    const r = sim.run(now);
    assert.deepEqual(r.result.timing.get("u1").problems, [], `at ${now}`);
    return r.level(OUT);
  };
  assert.equal(press(0, {}), L, "the pull-ups hold TRIG and RESET HIGH");
  assert.equal(press(1, { s1: true }), H, "SET pressed");
  assert.equal(press(2, {}), H, "SET released: latched");
  assert.equal(press(3, { s2: true }), L, "RESET pressed");
  assert.equal(press(4, {}), L, "RESET released: still LOW");
  assert.equal(
    sim.result.timing.get("u1").sections[0].mode,
    "bistable",
    "and it never stopped reading itself as a bistable",
  );
});

test("bistable with TRIG unconnected: the missing pin is named", () => {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.gnd(u.get(6));
  const { result, level } = runner(b.doc).run(0);
  assert.deepEqual(result.timing.get("u1").problems, [
    { code: "notConnected", pin: "TRIG (2)" },
  ]);
  assert.equal(level(OUT), L, "and OUT stays LOW");
});

// ── Not recognised ──────────────────────────────────────────────────────────

test("no capacitor: the 555 says so, and holds OUT LOW", () => {
  const { b, u } = powered555();
  b.link(u.get(2), u.get(6));
  const rB = b.seat("r2", "resistor", "a40", { ohms: 10e3 });
  b.link(rB.get(1), u.get(7));
  b.link(rB.get(2), u.get(6));
  const rA = b.seat("r1", "resistor", "a50", { ohms: 1e3 });
  b.link(rA.get(1), u.get(7));
  b.vcc(rA.get(2));
  const sim = runner(b.doc);
  const r = sim.run(0).result;
  assert.equal(sim.level(OUT), L);
  assert.equal(r.wakeAt, null);
  const w = r.warnings.find((x) => x.type === "timing");
  assert.ok(w, "a timing warning");
  assert.equal(w.chip, "u1");
  assert.deepEqual(
    w.problems.map((p) => p.code),
    ["noCapacitor"],
  );
});

test("each missing astable resistor is named", () => {
  const { b, u } = powered555();
  b.link(u.get(2), u.get(6));
  const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 1e-6 });
  b.link(c.get(1), u.get(6));
  b.gnd(c.get(2));
  const problems = runner(b.doc).run(0).result.timing.get("u1").problems;
  assert.deepEqual(
    problems.map((p) => [p.code, p.to]),
    [
      ["noResistor", "TRIG/THRES (2, 6)"],
      ["noResistor", "VCC"],
    ],
  );
});

test("wiring that is none of the three circuits is reported, not guessed at", () => {
  const { b, u } = powered555();
  // TRIG, THRES and DISCH each on a net of their own: neither figure.
  const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 1e-6 });
  b.link(c.get(1), u.get(6));
  b.gnd(c.get(2));
  const r = runner(b.doc).run(0).result;
  assert.deepEqual(
    r.timing.get("u1").problems.map((p) => p.code),
    ["ne555Unrecognised"],
  );
  assert.ok(r.warnings.some((w) => w.type === "timing" && w.chip === "u1"));
});

test("an unpowered 555 reports power, not timing", () => {
  const b = bench();
  b.seat("u1", "NE555", "e10");
  const r = settle({ document: b.doc, netlist: runner(b.doc).netlist });
  assert.equal(r.chipStatus.get("u1").status, "unpowered");
  assert.ok(!r.warnings.some((w) => w.type === "timing"));
});

// ── The part itself ─────────────────────────────────────────────────────────

test("the 555 runs from 4.5–16 V, its own range rather than a family's", () => {
  const def = partDef("NE555");
  assert.deepEqual(supplyRange(def), { min: 4.5, max: 16 });
  assert.equal(def.family, undefined);
  assert.equal(def.kind, "chip");
  assert.equal(def.group, "Oscillators");
  // At 12 V it runs (a 74LS part beside it would smoke).
  const doc = astable(1e3, 10e3, 10e-6);
  doc.components[0].params.volts = 12;
  const r = runner(doc).run(0).result;
  assert.equal(r.chipStatus.get("u1").status, "ok");
});

test("the pinout is SLFS022K's, and its RC terminals are neither input nor output", () => {
  const pins = partDef("NE555").pins.map((p) => [p.n, p.name, p.role]);
  assert.deepEqual(pins, [
    [1, "GND", "gnd"],
    [2, "TRIG", "input"],
    [3, "OUT", "output"],
    [4, "RESET", "input"],
    [5, "CONT", "timing"],
    [6, "THRES", "timing"],
    [7, "DISCH", "timing"],
    [8, "VCC", "vcc"],
  ]);
});
