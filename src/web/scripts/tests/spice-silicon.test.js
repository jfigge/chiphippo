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

// spice-silicon.test.js — the timing parts as their silicon under Spice Lite
// (spice/silicon.js, features/done/spice-lite-2-plan.md). Each is driven from its
// pins and held to its datasheet's formula — which nothing in it computes —
// and then to the circuits the formula never covered: RA as two resistors, a
// voltage on CONT, a trigger through a capacitor, a capacitor not empty when
// triggered, a discharge transistor asked for too much, an Rs left out, a
// value changed mid-run. Then the oscillations faster than the desk shows,
// drawn by their schedules (spice/cycles.js).

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { CHIP_STATUS } from "../sim/engine.js";
import {
  DISCH_OHMS,
  DIVIDER_OHMS,
  PIN,
  RESET_VOLTS,
  THRES_AMPS,
  TRIG_AMPS,
} from "../sim/timer-555.js";
import { partDef } from "../catalog/index.js";
import { stageCurrent } from "../sim/spice/output-stage.js";
import { isTimed } from "../sim/chip-eval.js";
import { PALETTE_DEFS } from "../catalog/index.js";
import { astable555, bench, runner } from "./timing-fixtures.js";
import { MIN_SHOWN_S, TIMING_CAP_HZ } from "../sim/timing.js";
import {
  MONO_LOW_REF,
  monoDischargeOhms,
  monoHighRef,
} from "../sim/monostable.js";

const spice = (doc) => runner(doc, { engine: "spice", spice: {} });

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

/**
 * Run a desk from 0 to `until` seconds, ticking at every moment it asks to
 * be woken and at each of `at` (an input changing), and record every change
 * of the level in `hole`: `[[t, level], …]`. `signals(t)` is the signal
 * levels a tick at `t` runs with.
 */
function edges(sim, hole, until, { signals = () => new Map(), at = [] } = {}) {
  let r = sim.run(0, signals(0)).result;
  let last = sim.level(hole);
  const out = [[0, last]];
  let t = 0;
  for (let i = 0; i < 5000; i++) {
    const next = Math.min(r.wakeAt ?? Infinity, ...at.filter((x) => x > t));
    if (!Number.isFinite(next) || next > until) break;
    t = next;
    r = sim.run(t, signals(t)).result;
    const level = sim.level(hole);
    if (level !== last) out.push([t, level]);
    last = level;
  }
  return { out, result: r };
}

/** The 555's comparator bias currents at 5 V, as the stages its silicon
    states (timer-555.js `thresInput`, `trigInput`). */
const BIAS = [PIN.THRES, PIN.TRIG].flatMap((pin) => partDef("NE555").silicon.inputs[pin](5)); // prettier-ignore

/**
 * How long a capacitor `c` fed through `r` from `vs` takes from `v0` to
 * `v1` while the 555's comparators draw their bias currents from it: piece
 * by piece between the stages' corners (each linear between them,
 * saturated or off past them), each piece an exponential of its own.
 */
function biasedTime({ c, r, vs, v0, v1, stages = BIAS }) {
  const corners = stages.flatMap(
    (st) =>
    st.sources ? [st.volts - st.limit * st.ohms, st.volts] : [st.volts, st.volts + st.limit * st.ohms], // prettier-ignore
  );
  const [lo, hi] = v0 < v1 ? [v0, v1] : [v1, v0];
  const cuts = [v0, ...corners.filter((v) => v > lo && v < hi).sort((a, b) => (v0 < v1 ? a - b : b - a)), v1]; // prettier-ignore
  let t = 0;
  for (let i = 1; i < cuts.length; i++) {
    const [a, b] = [cuts[i - 1], cuts[i]];
    const vm = (a + b) / 2;
    let g = 1 / r;
    let i0 = vs / r;
    for (const st of stages) {
      const push = st.sources ? st.volts - vm : vm - st.volts;
      if (!(push > 0)) continue;
      if (push / st.ohms >= st.limit) i0 += st.sources ? st.limit : -st.limit;
      else {
        g += 1 / st.ohms;
        i0 += st.volts / st.ohms;
      }
    }
    const vInf = i0 / g;
    t += (c / g) * Math.log((vInf - a) / (vInf - b));
  }
  return t;
}

/** The lengths of the stretches between successive edges. */
const stretches = (list) => list.slice(1).map(([t], i) => t - list[i][0]);

/** A 555 monostable (SLFS022K Figure 6-2) at e10: THRES and DISCH joined,
    C to GND and RA to VCC there; TRIG is the caller's. */
function monostable555({ ra = 10e3, c = 10e-6 } = {}) {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.link(u.get(6), u.get(7));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: c });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const rA = b.seat("r1", "resistor", "a40", { ohms: ra });
  b.link(rA.get(1), u.get(6));
  b.vcc(rA.get(2));
  return { b, u };
}

test("every timing part ships its silicon", () => {
  const timed = PALETTE_DEFS.filter(isTimed);
  assert.ok(timed.length >= 7, `${timed.length} timing parts`);
  for (const def of timed) {
    assert.ok(def.silicon, `${def.id} has a silicon block`);
    assert.equal(typeof def.silicon.step, "function", `${def.id} steps`);
    assert.equal(def.silicon.timing, undefined, `${def.id} recognises nothing`); // prettier-ignore
  }
});

test("a 555 astable runs at the sheet's rate from its pins, a long first HIGH from an empty capacitor", () => {
  const ra = 10e3;
  const rb = 10e3;
  const c = 10e-6;
  const { doc, b, u } = astable555({ ra, rb, c });
  const sim = spice(doc);
  const { out, result } = edges(sim, u.get(3), 1.2);
  const [first, low, high, low2] = stretches(out);
  const tau = (ra + rb) * c;
  // Charging from empty to ⅔ VCC is ln 3 · τ (the sheet's 1.1); from ⅓ to ⅔
  // it is ln 2 · τ (its 0.693) — with the comparators' bias currents drawn
  // only around their own trip points: TRIG's out of its pin below ⅓ VCC,
  // THRES's into its pin near ⅔.
  const charge = { c, r: ra + rb, vs: 5, v1: 10 / 3 };
  close(first, biasedTime({ ...charge, v0: 0 }), 1e-6, "first HIGH");
  close(high, biasedTime({ ...charge, v0: 5 / 3 }), 1e-6, "HIGH");
  close(first, Math.log(3) * tau, 5e-3, "first HIGH, against ln 3 · τ");
  close(high, Math.LN2 * tau, 5e-3, "HIGH, against tH = 0.693·(RA+RB)·C");
  // Discharging through RB into DISCH: its transistor (18.75 Ω) and RA
  // above it leave a floor of a few millivolts.
  const below = rb + (ra * DISCH_OHMS) / (ra + DISCH_OHMS);
  const floor = (5 * DISCH_OHMS) / (ra + DISCH_OHMS);
  close(low, biasedTime({ c, r: below, vs: floor, v0: 10 / 3, v1: 5 / 3 }), 1e-6, "LOW"); // prettier-ignore
  close(low, Math.LN2 * rb * c, 6e-3, "LOW, against tL = 0.693·RB·C");
  close(low2, low, 1e-6, "every LOW alike");
  assert.deepEqual(result.warnings, []);
  // The capacitor is a node: probed between the comparators' trip points
  // mid-HIGH…
  const mid = out[3][0] + high / 2;
  const again = spice(doc);
  const probe = edges(again, u.get(3), mid, { at: [mid] }).result;
  const thres = again.netlist.netOfPoint.get(b.at(u.get(6)));
  const v = probe.nodeVolts.get(thres);
  assert.ok(v > 5 / 3 && v < 10 / 3, `${v} V mid-HIGH`);
  // …and the divider holds CONT at ⅔ VCC.
  const cont = again.netlist.netOfPoint.get(b.at(u.get(5)));
  close(probe.nodeVolts.get(cont), 10 / 3, 1e-6, "CONT");
});

test("the 555's comparators draw their bias currents only around their trip points", () => {
  const thres = partDef("NE555").silicon.inputs[PIN.THRES](5);
  const trig = partDef("NE555").silicon.inputs[PIN.TRIG](5);
  const into = (stages, v) => -stages.reduce((sum, st) => sum + stageCurrent(st, v), 0); // prettier-ignore
  // TRIG: the sheet's 0.5 µA at 0 V, OUT of the pin (a PNP input); nothing
  // once TRIG is clear of the lower tap.
  close(into(trig, 0), -TRIG_AMPS, 1e-12, "TRIG at 0 V");
  close(into(trig, 5 / 3), -TRIG_AMPS / 2, 1e-9, "TRIG at the tap");
  assert.ok(into(trig, 2.5) === 0, "TRIG mid-swing");
  // THRES: 30 nA INTO the pin past ⅔ VCC, half at it, none mid-swing.
  assert.ok(into(thres, 2.5) === 0, "THRES mid-swing");
  close(into(thres, 10 / 3), THRES_AMPS / 2, 1e-9, "THRES at CONT");
  close(into(thres, 5), THRES_AMPS, 1e-12, "THRES at VCC");
  // So RA = RB = 1 MΩ runs at the formula, where a bias drawn the whole
  // cycle aimed the capacitor 1.06 V short of VCC and stretched the period
  // 54 % (features/done/spice-lite-3-plan.md, D2).
  const { doc, u } = astable555({ ra: 1e6, rb: 1e6, c: 1e-6 });
  const [, low, high] = stretches(edges(spice(doc), u.get(3), 9).out);
  close(high + low, Math.LN2 * 3e6 * 1e-6, 0.01, "the period");
});

test("RA as two resistors in series runs as their sum — wiring the formula's reader refuses", () => {
  const single = astable555({ ra: 10e3, rb: 10e3, c: 10e-6 });
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.link(u.get(2), u.get(6));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: 10e-6 });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const rB = b.seat("r2", "resistor", "a40", { ohms: 10e3 });
  b.link(rB.get(1), u.get(7));
  b.link(rB.get(2), u.get(6));
  const rA1 = b.seat("r1", "resistor", "a50", { ohms: 4.7e3 });
  b.link(rA1.get(1), u.get(7));
  const rA2 = b.seat("r3", "resistor", "a56", { ohms: 5.3e3 });
  b.link(rA2.get(1), rA1.get(2));
  b.vcc(rA2.get(2));

  const digital = runner(b.doc).run(0).result;
  assert.equal(digital.timing.get("u1").sections[0].mode, null);
  assert.ok(
    digital.timing.get("u1").problems.length,
    "the digital 555 says so",
  );
  assert.ok(
    !spice(b.doc)
      .run(0)
      .result.warnings.some((w) => w.type === "timing"),
    "Spice Lite does not: it is only the reader that refuses",
  );

  const want = stretches(edges(spice(single.doc), single.u.get(3), 1.2).out);
  const got = stretches(edges(spice(b.doc), u.get(3), 1.2).out);
  for (let i = 0; i < 4; i++) close(got[i], want[i], 1e-6, `stretch ${i}`);
});

test("a voltage on CONT moves both trip points; a capacitor on it changes nothing", () => {
  const plain = stretches(edges(spice(astable555({ ra: 10e3, rb: 10e3, c: 10e-6 }).doc), "e12", 1.2).out); // prettier-ignore
  const bypassed = stretches(edges(spice(astable555({ ra: 10e3, rb: 10e3, c: 10e-6, cv: 10e-9 }).doc), "e12", 1.2).out); // prettier-ignore
  for (let i = 0; i < 4; i++) {
    close(bypassed[i], plain[i], 1e-3, `bypassed CONT, stretch ${i}`);
  }
  // 10 kΩ from CONT to GND puts it at 2.5 V and the lower trip point at
  // 1.25 V: charging from 1.25 toward 5 V to 2.5 V takes ln 1.5 · τ — shorter
  // than ln 2 · τ — and discharging from 2.5 to 1.25 V is still ln 2.
  const { b, u, doc } = astable555({ ra: 10e3, rb: 10e3, c: 10e-6 });
  const r = b.seat("r9", "resistor", "a20", { ohms: 10e3 });
  b.link(r.get(1), u.get(5));
  b.gnd(r.get(2));
  const sim = spice(doc);
  const moved = stretches(edges(sim, u.get(3), 1.2).out);
  const cont = sim.netlist.netOfPoint.get(b.at(u.get(5)));
  close(sim.result.nodeVolts.get(cont), 2.5, 1e-6, "CONT pulled to 2.5 V");
  // (The bias ramps stay at the divider's own ⅓ and ⅔ VCC: TRIG's current
  // flows below 1.72 V, not 1.25.)
  close(moved[2], biasedTime({ c: 10e-6, r: 20e3, vs: 5, v0: 1.25, v1: 2.5 }), 1e-6, "the shorter HIGH"); // prettier-ignore
  close(moved[2], Math.log(1.5) * 0.2, 5e-3, "the shorter HIGH, against ln 1.5 · τ"); // prettier-ignore
  close(moved[1], plain[1], 6e-3, "the LOW, ln 2 as before");
});

test("a 555 monostable: a 1.1·RA·C pulse, and TRIG held LOW holds it HIGH", () => {
  const { b, u } = monostable555({ ra: 10e3, c: 10e-6 });
  b.signal("trig", u.get(2), "high");
  const pulse = (from, to) => (t) => new Map([["trig", t >= from && t < to ? L : H]]); // prettier-ignore
  const short = edges(spice(b.doc), u.get(3), 0.5, {
    signals: pulse(0.05, 0.06),
    at: [0.05, 0.06],
  }).out;
  assert.deepEqual(
    short.map(([, l]) => l),
    [L, H, L],
  );
  close(short[1][0], 0.05, 1e-9, "set by the trigger");
  // The capacitor starts from DISCH's floor, a few millivolts up.
  close(short[2][0] - short[1][0], 1.1 * 10e3 * 10e-6, 3e-3, "tw ≅ 1.1·RA·C"); // prettier-ignore

  const held = edges(spice(b.doc), u.get(3), 0.5, {
    signals: pulse(0.05, 0.3),
    at: [0.05, 0.3],
  }).out;
  assert.deepEqual(
    held.map(([, l]) => l),
    [L, H, L],
  );
  close(held[2][0], 0.3, 1e-6, "TRIG overrides THRES until it lets go");
});

test("a 555 triggered through a capacitor: the step on its far side carries through", () => {
  // TRIG held up by 10 kΩ, a button's flag driving it through 100 nF. The
  // flag falling 5 V takes TRIG with it — its charge cannot change in an
  // instant — and TRIG climbs back through 10 kΩ, crossing ⅓ VCC 0.405 ms on.
  const { b, u } = monostable555({ ra: 10e3, c: 10e-6 });
  const up = b.seat("r2", "resistor", "a46", { ohms: 10e3 });
  b.link(up.get(1), u.get(2));
  b.vcc(up.get(2));
  const coupling = b.seat("c2", "cap-ceramic", "a52", { farads: 100e-9 });
  b.link(coupling.get(1), u.get(2));
  b.signal("btn", coupling.get(2), "high");
  const signals = (t) => new Map([["btn", t >= 0.05 && t < 0.3 ? L : H]]);
  const sim = spice(b.doc);
  const { out } = edges(sim, u.get(3), 0.5, { signals, at: [0.05, 0.3] });
  assert.deepEqual(
    out.map(([, l]) => l),
    [L, H, L],
  );
  close(out[1][0], 0.05, 1e-9, "fired by the step");
  close(out[2][0] - out[1][0], 1.1 * 0.1, 3e-3, "and timed as ever");
  // In the digital engine a capacitor joins nothing: TRIG never moves.
  const digital = edges(runner(b.doc), u.get(3), 0.5, { signals, at: [0.05, 0.3] }); // prettier-ignore
  assert.deepEqual(
    digital.out.map(([, l]) => l),
    [L],
  );
});

test("a 555 monostable re-triggered before its capacitor has emptied times a shorter pulse", () => {
  // DISCH empties 10 µF in a fraction of a millisecond (18.75 Ω); a trigger
  // 20 µs after a pulse ends finds the capacitor still well up.
  const { b, u } = monostable555({ ra: 10e3, c: 10e-6 });
  b.signal("trig", u.get(2), "high");
  const first = edges(spice(b.doc), u.get(3), 0.3, {
    signals: (t) => new Map([["trig", t >= 0.01 && t < 0.011 ? L : H]]),
    at: [0.01, 0.011],
  }).out;
  const end = first[2][0];
  const again = end + 20e-6;
  const twice = edges(spice(b.doc), u.get(3), 0.5, {
    signals: (t) => new Map([["trig", (t >= 0.01 && t < 0.011) || (t >= again && t < again + 1e-3) ? L : H]]), // prettier-ignore
    at: [0.01, 0.011, again, again + 1e-3],
  }).out;
  assert.deepEqual(
    twice.map(([, l]) => l),
    [L, H, L, H, L],
  );
  // From where 20 µs of discharge left it: 10/3 · e^(−20 µs / (18.75 Ω ·
  // 10 µF)), toward 5 V through RA.
  const v0 = (10 / 3) * Math.exp(-20e-6 / (DISCH_OHMS * 10e-6));
  const width = 0.1 * Math.log((5 - v0) / (5 - 10 / 3));
  close(twice[4][0] - twice[3][0], width, 2e-2, "the shorter pulse");
  assert.ok(twice[4][0] - twice[3][0] < 0.5 * (first[2][0] - first[1][0]));
});

test("a 555's RESET reads its own 0.7 V and sources its own current: a power-on RC releases it", () => {
  // RESET at 0 V sources 0.4 mA and takes 0.1 mA at VCC (SLFS022K §5.5): a
  // straight line, 4 V behind 10 kΩ at VCC 5 V. With 100 kΩ up and 1 µF down
  // that is 4.09 V behind 9.09 kΩ — and 0.7 V comes in 1.7 ms, not the
  // 100 kΩ · 1 µF a reader of the formula would expect.
  const { b, u, doc } = astable555({ ra: 10e3, rb: 10e3, c: 10e-6, reset: false }); // prettier-ignore
  const res = b.seat("r9", "resistor", "a20", { ohms: 100e3 });
  b.link(res.get(1), u.get(4));
  b.vcc(res.get(2));
  const cap = b.seat("c9", "cap-electrolytic", "a25", { farads: 1e-6 });
  b.link(cap.get(1), u.get(4));
  b.gnd(cap.get(2));
  const vth = (5 / 100e3 + 4 / 10e3) / (1 / 100e3 + 1 / 10e3);
  const rth = 1 / (1 / 100e3 + 1 / 10e3);
  const release = rth * 1e-6 * Math.log(vth / (vth - RESET_VOLTS));
  const { out } = edges(spice(doc), u.get(3), 0.05);
  assert.equal(out[0][1], L, "held in reset at power-on");
  close(out[1][0], release, 1e-3, "released where RESET crosses 0.7 V");
  assert.equal(out[1][1], H, "and the astable starts");
});

test("a 555 bistable: TRIG sets it, RESET clears it, THRES on GND never does", () => {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.gnd(u.get(6));
  b.signal("set", u.get(2), "high");
  b.signal("clr", u.get(4), "high");
  const sim = spice(b.doc);
  const run = (t, set, clr) =>
    sim.run(t, new Map([["set", set], ["clr", clr]])).level(u.get(3)); // prettier-ignore
  assert.equal(run(0, H, H), L, "powers up LOW");
  assert.equal(run(1, L, H), H, "TRIG LOW sets");
  assert.equal(run(2, H, H), H, "and it holds");
  assert.equal(run(3, H, L), L, "RESET LOW clears");
  assert.equal(run(4, H, H), L, "and it holds");
});

test("a 555's discharge transistor asked for too much: DISCH cannot pull the capacitor down, and says so", () => {
  // RA 5 Ω: DISCH on carries 5 V / 23.75 Ω = 210 mA — past the 200 mA the
  // sheet recommends, short of its 225 mA maximum — and sits at 3.95 V, above
  // the lower trip point: the capacitor never gets down to it, and the 555
  // stops after its first HIGH.
  const { doc, u } = astable555({ ra: 5, rb: 10e3, c: 10e-6 });
  const sim = spice(doc);
  const { out, result } = edges(sim, u.get(3), 2);
  assert.deepEqual(
    out.map(([, l]) => l),
    [H, L],
    "one HIGH, then stuck",
  );
  const w = result.warnings.find((x) => x.type === "output-current");
  assert.ok(w, "warned");
  assert.equal(w.pin, 7);
  assert.equal(w.smoke, false);
  close(w.amps, 5 / (5 + DISCH_OHMS), 1e-3, "DISCH's current");
});

test("a 555 output past its absolute maximum lets out the smoke", () => {
  // OUT HIGH into 10 Ω: VCC − 1.35 V behind 3.5 Ω (the def's stage) — 270 mA.
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.gnd(u.get(6));
  b.signal("set", u.get(2), "high");
  const load = b.seat("r1", "resistor", "a30", { ohms: 10 });
  b.link(load.get(1), u.get(3));
  b.gnd(load.get(2));
  const sim = spice(b.doc);
  sim.run(0, new Map([["set", H]]));
  const r = sim.run(1, new Map([["set", L]])).result;
  const w = r.warnings.find((x) => x.type === "output-current");
  assert.ok(w?.smoke, "smoke");
  close(w.amps, 3.65 / 13.5, 1e-3, "OUT's current");
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OVERLOADED);
});

test("a 555's supply current is its own sheet's, its divider and RA booked once", () => {
  // Held reset (RESET LOW): OUT LOW, DISCH on, sinking 5 V through RA.
  const { doc, u, b } = astable555({ ra: 10e3, rb: 10e3, c: 10e-6, reset: false }); // prettier-ignore
  b.gnd(u.get(4));
  const r = spice(doc).run(0).result;
  const supply = r.supplies.get("psu1");
  // ICC: 2.5 mA at 5 V less the divider's 0.33 mA; the divider itself; RA
  // into DISCH (RB carries nothing to an empty capacitor at DISCH's floor).
  const divider = 5 / (3 * DIVIDER_OHMS);
  const icc = 2.5e-3 - divider;
  const ra = 5 / (10e3 + DISCH_OHMS);
  close(supply.amps, icc + divider + ra, 2e-3, "what the supply delivers");
  assert.ok(partDef("NE555").silicon.iccMa(5) > 0);
});

// ── The CD4000 timers ────────────────────────────────────────────────────────

/** A CD4047B at e10: R from R (2) and C from C (1) to RC COMMON (3). */
function cd4047({ r = 100e3, c = 100e-9 } = {}) {
  const b = bench();
  const u = b.seat("u1", "CD4047B", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const cap = b.seat("c1", "cap-ceramic", "a30", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.link(cap.get(2), u.get(3));
  const res = b.seat("r1", "resistor", "a36", { ohms: r });
  b.link(res.get(1), u.get(2));
  b.link(res.get(2), u.get(3));
  return { b, u, rc: r * c };
}

/** Signal levels from `[name, from, to]` HIGH windows — a name may have
    several, and is LOW outside them. */
const windows =
  (...list) =>
  (t) => {
    const out = new Map();
    for (const [name, from, to] of list) {
      out.set(name, out.get(name) === H || (t >= from && t < to) ? H : L);
    }
    return out;
  };

test("a 4047 gated astable: Q at 4.40·RC, its first HIGH tM when the gate opens", () => {
  // SCHS044C §I.A: tA = 4.40 RC (each half t1 + t2 = 2.2 RC) and, the gate
  // opening on a capacitor charged while it was shut, a first positive half
  // of tM = 2.48 RC (t1' = 1.38 RC from 2·VDD). Its formulas are this very
  // swing; what is left is the outputs' own resistance beside R.
  const { b, u, rc } = cd4047();
  b.vcc(u.get(4));
  b.signal("ast", u.get(5), "low");
  b.gnd(u.get(6));
  b.gnd(u.get(8));
  b.gnd(u.get(9));
  b.gnd(u.get(12));
  const open = 5 * rc;
  const signals = windows(["ast", open, Infinity]);
  const { out, result } = edges(spice(b.doc), u.get(10), open + 5 * 4.4 * rc, { signals, at: [open] }); // prettier-ignore
  assert.equal(out[0][1], L, "shut: Q LOW");
  close(out[1][0], open, 1e-9, "Q rises as the gate opens");
  const [first, ...halves] = stretches(out.slice(1));
  close(first, 2.48 * rc, 1e-2, "the first HIGH, tM");
  for (const half of halves) close(half, 2.2 * rc, 5e-3, "every half after, tA/2"); // prettier-ignore
  assert.ok(halves.length >= 6);
  assert.deepEqual(result.warnings, []);
  const shown = result.timing.get("u1").sections[0];
  close(shown.period, 4.4 * rc, 5e-3, "the readout: the period it measured");
  assert.equal(shown.measured, true);
});

test("a 4047 one-shot: tM, run on by whole 2.2·RC periods by RETRIGGER, ended by EXT RESET", () => {
  const { b, u, rc } = cd4047();
  b.gnd(u.get(5));
  b.vcc(u.get(4));
  b.gnd(u.get(6));
  b.signal("trig", u.get(8), "low");
  b.signal("rst", u.get(9), "low");
  b.signal("re", u.get(12), "low");
  const t0 = 5 * rc;
  const run = (list, until) => {
    const at = list.flatMap(([, from, to]) => [from, to]);
    const all = [["trig", 0, 0], ["rst", 0, 0], ["re", 0, 0], ...list];
    return edges(spice(b.doc), u.get(10), until, { signals: windows(...all), at }).out; // prettier-ignore
  };
  const one = run([["trig", t0, t0 + 1e-4]], t0 + 4 * rc);
  assert.deepEqual(
    one.map(([, l]) => l),
    [L, H, L],
  );
  close(one[1][0], t0, 1e-9, "fired by +TRIGGER");
  close(one[2][0] - one[1][0], 2.48 * rc, 1e-2, "tM");
  // One RETRIGGER pulse during the first period: one more t1 + t2 (§III's
  // tRE = t1' + t1 + 2·t2).
  const re = run([["trig", t0, t0 + 1e-4], ["re", t0 + rc, t0 + rc + 1e-4]], t0 + 6 * rc); // prettier-ignore
  assert.deepEqual(
    re.map(([, l]) => l),
    [L, H, L],
  );
  close(re[2][0] - re[1][0], (2.48 + 2.2) * rc, 1e-2, "tRE");
  // EXT RESET HIGH ends it at once.
  const cut = run([["trig", t0, t0 + 1e-4], ["rst", t0 + rc, t0 + 2 * rc]], t0 + 4 * rc); // prettier-ignore
  assert.deepEqual(
    cut.map(([, l]) => l),
    [L, H, L],
  );
  close(cut[2][0], t0 + rc, 1e-9, "reset");
});

test("a silicon stage built from its family's follows the user's strength; one stated outright does not", () => {
  // The 4047's RC COMMON pull-up is a CD4000 HIGH a diode below VDD
  // (monostable.js cd4047Silicon): Settings ▸ Spice Lite's CMOS source
  // current moves it as it moves every CD4000 output. Gated shut, it pulls RC
  // COMMON up into 1 kΩ to GND: 4.4 V behind the stage's ohms.
  const rcCommon = (spiceConfig) => {
    const b = bench();
    const u = b.seat("u1", "CD4047B", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    b.vcc(u.get(4));
    for (const pin of [5, 6, 8, 9, 12]) b.gnd(u.get(pin));
    const load = b.seat("r1", "resistor", "a36", { ohms: 1000 });
    b.link(load.get(1), u.get(3));
    b.gnd(load.get(2));
    const sim = runner(b.doc, { engine: "spice", spice: spiceConfig });
    let r;
    for (const t of [0, 1e-3, 2e-3]) r = sim.run(t).result;
    return r.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(3))));
  };
  const base = rcCommon({});
  const stronger = rcCommon({ families: { CD4000: { sourceMa: 2 } } });
  // 400 Ω at 5 V (output-stage.js), halved by twice the source current.
  close(base, (4.4 * 1000) / (1000 + 400), 1e-3, "default strength");
  close(
    stronger,
    (4.4 * 1000) / (1000 + 200),
    1e-3,
    "twice the source current",
  );
  // A stage a part states outright — the 555's DISCH, a 4538's discharge on
  // RX CX — is its own ohms whatever the family's strength.
  for (const [ref, pin] of [
    ["NE555", 7],
    ["CD4538B", 2],
  ]) {
    const stage = partDef(ref).silicon.stages[pin];
    assert.deepEqual(stage(5, L, 2), stage(5, L, 1), `${ref} pin ${pin}`);
  }
});

/** A dual monostable's first section at e10: Rx from RX CX (2) to VDD, Cx
    from RX CX to CX (1), +TR (4) a signal, −TR (5) and RESET (3) HIGH or a
    signal; the second section's inputs tied off. */
function monostable({
  ref = "CD4538B",
  volts = 5,
  r = 100e3,
  c = 100e-9,
  reset = false,
} = {}) {
  // prettier-ignore
  const b = bench({ volts });
  const u = b.seat("u1", ref, "e10");
  b.vcc(u.get(16));
  b.gnd(u.get(8));
  const cap = b.seat("c1", "cap-ceramic", "a30", { farads: c });
  b.link(cap.get(1), u.get(2));
  b.link(cap.get(2), u.get(1));
  // The 4528's T1 is grounded outside the part, as its sheet says.
  if (ref === "CD4528B") {
    b.gnd(u.get(1));
    b.gnd(u.get(15));
  }
  const res = b.seat("r1", "resistor", "a36", { ohms: r });
  b.link(res.get(1), u.get(2));
  b.vcc(res.get(2));
  if (reset) b.signal("rst", u.get(3), "high");
  else b.vcc(u.get(3));
  b.vcc(u.get(5));
  b.signal("trig", u.get(4), "low");
  b.vcc(u.get(13));
  b.gnd(u.get(12));
  b.vcc(u.get(11));
  return { b, u, rc: r * c };
}

const PERIOD_K = {
  CD4098B: () => 0.5,
  CD4528B: (volts) => 0.2 * Math.log(volts),
  CD4538B: () => 1,
};

test("the dual monostables time their sheets' K·Rx·Cx through RX CX, at every supply", () => {
  // The comparators' references are derived from each formula (the lower at
  // 5 % of VDD, the upper where a charge from it reaches in K time
  // constants), so what is left is the discharge's own few microseconds.
  for (const [ref, k] of Object.entries(PERIOD_K)) {
    for (const volts of [5, 10, 15]) {
      const { b, u, rc } = monostable({ ref, volts });
      const t0 = 0.01;
      const { out, result } = edges(spice(b.doc), u.get(6), t0 + 3 * rc, {
        signals: windows(["trig", t0, t0 + 1e-4]),
        at: [t0, t0 + 1e-4],
      });
      assert.deepEqual(out.map(([, l]) => l), [L, H, L], `${ref} at ${volts} V`); // prettier-ignore
      close(out[1][0], t0, 1e-9, `${ref} fired by +TR`);
      close(out[2][0] - out[1][0], k(volts) * rc, 1.5e-2, `${ref} at ${volts} V`); // prettier-ignore
      close(result.timing.get("u1").sections[0].width, out[2][0] - out[1][0], 1e-9, "its readout"); // prettier-ignore
      assert.deepEqual(result.warnings, []);
    }
  }
  // RX CX is a node: mid-pulse it sits between the two references.
  const { b, u, rc } = monostable();
  const sim = spice(b.doc);
  const mid = 0.01 + rc / 2;
  const r = edges(sim, u.get(6), mid, { signals: windows(["trig", 0.01, 0.0101]), at: [0.01, 0.0101, mid] }).result; // prettier-ignore
  const v = r.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(2))));
  assert.ok(v > MONO_LOW_REF * 5 && v < monoHighRef(1) * 5, `${v} V mid-pulse`); // prettier-ignore
});

test("a dual monostable retriggered runs one period past the last trigger; RESET LOW ends it", () => {
  const { b, u, rc } = monostable({ reset: true });
  const t0 = 0.01;
  const again = t0 + rc / 2;
  const re = edges(spice(b.doc), u.get(6), again + 3 * rc, {
    signals: (t) => new Map([["trig", (t >= t0 && t < t0 + 1e-4) || (t >= again && t < again + 1e-4) ? H : L], ["rst", H]]), // prettier-ignore
    at: [t0, t0 + 1e-4, again, again + 1e-4],
  }).out;
  assert.deepEqual(
    re.map(([, l]) => l),
    [L, H, L],
  );
  close(re[2][0] - again, rc, 1.5e-2, "one period after the second trigger");
  const cut = edges(spice(b.doc), u.get(6), t0 + 3 * rc, {
    signals: (t) => new Map([["trig", t >= t0 && t < t0 + 1e-4 ? H : L], ["rst", t >= again && t < again + 1e-3 ? L : H]]), // prettier-ignore
    at: [t0, t0 + 1e-4, again, again + 1e-3],
  }).out;
  assert.deepEqual(
    cut.map(([, l]) => l),
    [L, H, L],
  );
  close(cut[2][0], again, 1e-9, "RESET LOW ends it at once");
});

/** Every warning a run raises, from 0 to `until` — ticking where it asks to
    be woken and at each of `at`. */
function warningsOver(sim, until, { signals = () => new Map(), at = [] } = {}) {
  const seen = [];
  let r = sim.run(0, signals(0)).result;
  seen.push(...r.warnings);
  let t = 0;
  for (let i = 0; i < 5000; i++) {
    const next = Math.min(r.wakeAt ?? Infinity, ...at.filter((x) => x > t));
    if (!Number.isFinite(next) || next > until) break;
    t = next;
    r = sim.run(t, signals(t)).result;
    seen.push(...r.warnings);
  }
  return { seen, result: r };
}

/** Each dual monostable's least Rx (its sheet's; the 4528's from its tests). */
const RX_MIN = { CD4098B: 5e3, CD4528B: 5e3, CD4538B: 4e3 };

test("a monostable's discharge dumping a large Cx at every trigger, Rx at its least, says nothing", () => {
  // The discharge empties Cx through its ≈83/50/33 Ω — 60/200/450 mA at the
  // instant, 0.3–6.8 W — and real silicon does too: the sheets bound it by
  // Cx (≤ 100 µF), not a rating. What it is held to is what it SUSTAINS.
  for (const ref of Object.keys(RX_MIN)) {
    for (const volts of [5, 15]) {
      const { b, u, rc } = monostable({ ref, volts, r: RX_MIN[ref], c: 10e-6 }); // prettier-ignore
      const period = rc * PERIOD_K[ref](volts);
      const at = [];
      for (let i = 0; i < 6; i++) at.push((0.1 + 1.5 * i) * period, (0.1 + 1.5 * i) * period + 1e-4); // prettier-ignore
      const signals = (t) => new Map([["trig", at.some((x, i) => i % 2 === 0 && t >= x && t < at[i + 1]) ? H : L]]); // prettier-ignore
      const { seen, result } = warningsOver(spice(b.doc), 9 * period, { signals, at }); // prettier-ignore
      assert.deepEqual(
        seen.map((w) => w.type),
        [],
        `${ref} at ${volts} V`,
      );
      assert.equal(result.chipStatus.get("u1").status, CHIP_STATUS.OK);
      // …and it timed, every time.
      const q = edges(spice(b.doc), u.get(6), 9 * period, { signals, at }).out;
      assert.equal(q.filter(([, l]) => l === H).length, 6, `${ref}: six pulses`); // prettier-ignore
    }
  }
});

test("a monostable's discharge held by RESET against too small an Rx warns, and past 100 mW smokes", () => {
  // RESET LOW holds the discharge on: the current through Rx is what the
  // transistor sustains. The sheets' least Rx sets what it is made to hold —
  // VDD / Rx_min — and the family's 100 mW per output transistor its smoke.
  // What these checks raise (a 4098's spare section's ties are the
  // fixture's own business).
  const rated = (w) => w.type === "rx-current" || w.type === "output-current";
  const held = (ref, volts, r) => {
    const { b } = monostable({ ref, volts, r, c: 1e-6, reset: true });
    const signals = () => new Map([["rst", L]]);
    return warningsOver(spice(b.doc), 5e-3, { signals, at: [1e-3, 2e-3] });
  };
  for (const ref of Object.keys(RX_MIN)) {
    const { seen } = held(ref, 5, 1e3);
    const w = seen.find((x) => x.type === "rx-current");
    assert.ok(w, `${ref}: 1 kΩ is under ${RX_MIN[ref]} Ω`);
    close(w.limit, (5 / (RX_MIN[ref] + monoDischargeOhms(5))) * 1000, 1e-9, "VDD / (Rx_min + R_discharge), mA"); // prettier-ignore
    assert.equal(w.rxMin, RX_MIN[ref]);
    assert.equal(w.pin, 2);
    assert.ok(w.amps * 1000 > w.limit);
    assert.equal(
      seen.some((x) => x.smoke),
      false,
      "a warning, not smoke",
    );
    assert.deepEqual(held(ref, 5, 10e3).seen.filter(rated), [], `${ref}: 10 kΩ is fine`); // prettier-ignore
    // Exact at the sheet's least: an Rx AT it is silent at every supply, one
    // ohm under it warns.
    for (const volts of [5, 10, 15]) {
      assert.deepEqual(held(ref, volts, RX_MIN[ref]).seen.filter(rated), [], `${ref}: Rx_min at ${volts} V`); // prettier-ignore
      const under = held(ref, volts, RX_MIN[ref] - 1).seen;
      assert.ok(under.some((x) => x.type === "rx-current"), `${ref}: 1 Ω under Rx_min at ${volts} V`); // prettier-ignore
    }
  }
  const { seen, result } = held("CD4538B", 15, 100);
  const smoke = seen.find((x) => x.type === "output-current" && x.smoke);
  assert.ok(smoke, "100 Ω at 15 V: smoke");
  assert.equal(smoke.unit, "mW");
  assert.ok(smoke.watts * 1000 > 100);
  assert.equal(result.chipStatus.get("u1").status, CHIP_STATUS.OVERLOADED);
});

test("a monostable with a Cx past its sheet's 100 µF says so, in both engines", () => {
  for (const ref of ["CD4098B", "CD4538B"]) {
    const { b } = monostable({ ref, c: 220e-6 });
    for (const engine of ["digital", "spice"]) {
      const sim = runner(b.doc, { engine, spice: {} });
      const timing = sim.run(0).result.warnings.filter((w) => w.type === "timing"); // prettier-ignore
      assert.deepEqual(
        timing.flatMap((w) => w.problems.map((p) => [p.code, p.max])),
        [["cxTooLarge", "100µF"]],
        `${ref}, ${engine}`,
      );
    }
    const ok = monostable({ ref, c: 100e-6 }).b.doc;
    const said = spice(ok).run(0).result.warnings.filter((w) => w.type === "timing"); // prettier-ignore
    assert.deepEqual(said, [], `${ref}: 100 µF is fine`);
  }
});

test("a CD4541B with AUTO RESET enabled draws its sheet's extra supply current", () => {
  // SCHS085E Note 2: 7 / 30 / 80 µA typical at 5 / 10 / 15 V — on AUTO
  // RESET LOW (enabled), on top of its 0.04 µA quiescent.
  const draw = (arLow, volts) => {
    const b = bench({ volts });
    const u = b.seat("u1", "CD4541B", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    if (arLow) b.gnd(u.get(5));
    else b.vcc(u.get(5));
    for (const p of [3, 6, 9, 10, 12, 13]) b.gnd(u.get(p));
    const sim = spice(b.doc);
    sim.run(0);
    return sim.run(1e-3).result.supplies.get("psu1").amps;
  };
  for (const [volts, ua] of [
    [5, 7],
    [10, 30],
    [15, 80],
  ]) {
    close((draw(true, volts) - draw(false, volts)) * 1e6, ua, 1e-6, `${volts} V`); // prettier-ignore
  }
  close(draw(false, 5) * 1e6, 0.04, 1e-6, "quiescent, AUTO RESET off");
});

/** The two-inverter RC oscillator of a CD4060B (Fig. 12) or a CD4541B
    (Fig. 2) at e10, running, with Rx, Cx and Rs on one junction. */
function rcCounter(ref, { rx = 10e3, cx = 1e-6, rs = 20e3 } = {}) {
  const b = bench();
  const u = b.seat("u1", ref, "e10");
  const p =
    ref === "CD4060B"
      ? { vdd: 16, vss: 8, o: 9, on: 10, i: 11 }
      : { vdd: 14, vss: 7, o: 2, on: 1, i: 3 };
  b.vcc(u.get(p.vdd));
  b.gnd(u.get(p.vss));
  if (ref === "CD4060B") b.signal("rst", u.get(12), "low");
  else {
    for (const n of [5, 9, 12, 13]) b.gnd(u.get(n)); // AR, Q/Q̄, A, B
    b.signal("rst", u.get(6), "low"); // MR
    b.vcc(u.get(10)); // MODE: recycle
  }
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: cx });
  b.link(c.get(1), u.get(p.o));
  const r1 = b.seat("r1", "resistor", "a36", { ohms: rx });
  b.link(r1.get(1), u.get(p.on));
  b.link(r1.get(2), c.get(2));
  const r2 = b.seat("r2", "resistor", "a44", { ohms: rs });
  b.link(r2.get(1), u.get(p.i));
  b.link(r2.get(2), c.get(2));
  // RESET (MASTER RESET) is a flag, LOW unless a test says otherwise.
  return { b, u, out: u.get(p.o), signals: windows(["rst", 0, 0]) };
}

/** Rising edge to rising edge, after the first. */
const periodsOf = (out) => {
  const rises = out.filter(([, l]) => l === H).map(([t]) => t);
  return rises.slice(2).map((t, i) => t - rises[i + 1]);
};

test("the 4060 and 4541 oscillate from their sheets' networks: 2.2 and 2.3·Rx·Cx", () => {
  // The junction steps past a rail each time the C-side output switches
  // (spice/coupling.js), Rs keeping the input's clamp off it. The one
  // network gives both parts one period — 2.23·Rx·Cx at Rs = 2·Rx — which is
  // 1.5 % over the 4060 sheet's 2.2 and 2.9 % under the 4541's 2.3.
  for (const [ref, k, tol] of [
    ["CD4060B", 2.2, 2e-2],
    ["CD4541B", 2.3, 3e-2],
  ]) {
    // prettier-ignore
    const { b, out, signals } = rcCounter(ref);
    const { out: seen, result } = edges(spice(b.doc), out, 0.25, { signals });
    const periods = periodsOf(seen);
    assert.ok(periods.length >= 6, ref);
    for (const p of periods) close(p, k * 10e3 * 1e-6, tol, ref);
    assert.deepEqual(result.warnings, [], `${ref}: Rs keeps the clamp quiet`); // prettier-ignore
  }
  // Rs left out (1 Ω): the input's protection diode holds the junction a
  // diode past the rail, and the period is visibly shorter.
  const { b, out, signals } = rcCounter("CD4060B", { rs: 1 });
  const short = periodsOf(edges(spice(b.doc), out, 0.25, { signals }).out);
  assert.ok(short[0] < 0.9 * 2.2 * 10e-3, `${short[0]} s without Rs`);
});

test("a value changed mid-run carries on from where the capacitor stands", () => {
  // RB doubled mid-HIGH: the capacitor keeps its charge, and the HIGH ends
  // where it climbs from there to ⅔ VCC with the new time constant.
  const { doc, b, u } = astable555({ ra: 10e3, rb: 10e3, c: 10e-6 });
  const sim = spice(doc);
  const first = edges(sim, u.get(3), 0.6).out;
  assert.equal(first[2][1], H);
  const midHigh = first[2][0] + 0.05;
  const again = spice(doc);
  const before = edges(again, u.get(3), midHigh, { at: [midHigh] }).result;
  const thres = again.netlist.netOfPoint.get(b.at(u.get(6)));
  const v = before.nodeVolts.get(thres);
  assert.equal(again.level(u.get(3)), H);
  doc.components.find((c) => c.id === "r2").params.ohms = 20e3; // RB
  again.rebuild();
  let r = again.run(midHigh).result;
  assert.equal(again.level(u.get(3)), H, "no jump at the change");
  close(r.nodeVolts.get(thres), v, 1e-6, "the capacitor kept its charge");
  let t = midHigh;
  while (again.level(u.get(3)) === H) {
    t = r.wakeAt;
    r = again.run(t).result;
  }
  close(t - midHigh, biasedTime({ c: 10e-6, r: 30e3, vs: 5, v0: v, v1: 10 / 3 }), 1e-3, "the rest of the HIGH, at the new rate"); // prettier-ignore
});

// ── Faster than the desk shows ───────────────────────────────────────────────

/** Tick as SimController does: at each wake, but no sooner than MIN_SHOWN_S
    after the last (`floor`, simulated seconds — its #nextEvent), recording
    the shown level's changes in `hole`. */
function paced(
  sim,
  hole,
  until,
  { floor = MIN_SHOWN_S, signals = () => new Map(), at = [] } = {},
) {
  // prettier-ignore
  let r = sim.run(0, signals(0)).result;
  let last = sim.level(hole);
  const out = [[0, last]];
  let t = 0;
  let ticks = 0;
  while (t < until && ticks < 2000) {
    let next = Math.max(r.wakeAt ?? Infinity, t + floor);
    for (const x of at) if (x > t && x < next) next = x;
    if (!Number.isFinite(next)) break;
    t = next;
    r = sim.run(t, signals(t)).result;
    ticks++;
    const level = sim.level(hole);
    if (level !== last) out.push([t, level]);
    last = level;
  }
  return { out, result: r, ticks };
}

test("a 4060 oscillating faster than the desk is drawn at the cap, counting at its true rate", () => {
  const { b, out, signals } = rcCounter("CD4060B", { rx: 1e3, cx: 100e-9, rs: 2.2e3 }); // prettier-ignore
  const sim = spice(b.doc);
  const { out: seen, result } = paced(sim, out, 0.5, { signals });
  const cycle = result.analog.cycle;
  assert.ok(cycle, "a schedule");
  // True: 2.2·RC and the outputs' resistance beside a 1 kΩ Rx — 0.27 ms;
  // shown at the cap with its duty kept.
  close(cycle.period, 0.27e-3, 1e-2, "its true period");
  for (const p of periodsOf(seen).slice(-5)) close(p, 1 / TIMING_CAP_HZ, 1e-9, "shown at the cap"); // prettier-ignore
  assert.ok(!result.warnings.some((w) => w.type === "oscillation"));
  const shown = result.timing.get("u1").sections[0];
  close(shown.period, cycle.period, 1e-6, "the readout says the true rate");
  close(shown.duty, 0.5, 1e-2, "duty kept");
  // The counter counted every true cycle, not the shown ones.
  const count = result.state.get("u1").count;
  assert.ok(Math.abs(count - 0.5 / cycle.period) <= 2, `${count} counts in 0.5 s`); // prettier-ignore
  // RESET raised: the schedule ends there; lowered, it starts again.
  const sim2 = spice(b.doc);
  const pulse = windows(["rst", 0.2, 0.3]);
  const reset = paced(sim2, out, 0.25, { signals: pulse, at: [0.2] }).result;
  assert.equal(reset.analog.cycle, null, "stopped by RESET");
  assert.equal(reset.state.get("u1").count, 0);
  const resumed = paced(sim2, out, 0.4, { signals: pulse, at: [0.3] }).result;
  assert.ok(resumed.analog.cycle, "running again");
});

test("a 555 and a 4541 faster than the desk: schedules too, with their true rates read out", () => {
  // The 555: 1.44 / ((RA + 2·RB)·C) = 6.86 kHz on the formula; RA 1 kΩ
  // leaves its discharge transistor a few percent of the LOW (as at any rate).
  const { doc, u } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9 });
  const r = paced(spice(doc), u.get(3), 0.3).result;
  assert.ok(r.analog.cycle);
  const shown = r.timing.get("u1").sections[0];
  close(shown.frequency, 1.44 / (21e3 * 10e-9), 3e-2, "the 555's true rate");
  close(shown.duty, 11 / 21, 3e-2, "and its duty");
  assert.deepEqual(r.warnings, []);
  const { b, out, signals } = rcCounter("CD4541B", { rx: 1e3, cx: 100e-9, rs: 2.2e3 }); // prettier-ignore
  const t = paced(spice(b.doc), out, 0.3, { signals }).result;
  assert.ok(t.analog.cycle);
  assert.ok(Math.abs(t.state.get("u1").count - 0.3 / t.analog.cycle.period) <= 2); // prettier-ignore
});

test("an RC round an ordinary inverter is still the logic loop it is, not a schedule", () => {
  // It chatters a hair either side of one trip point; nothing swings.
  const b = bench();
  const u = b.seat("u1", "CD4069UB", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  for (const n of [3, 5, 9, 11, 13]) b.gnd(u.get(n));
  const res = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(2));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: 10e-9 });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  for (let i = 0; i < 20 && !r.analog.oscillating; i++) r = sim.run(r.wakeAt).result; // prettier-ignore
  assert.equal(r.analog.cycle, null);
  assert.ok(r.warnings.some((w) => w.type === "oscillation"));
});

test("a fast 555 drawn by its schedule follows a voltage moved on CONT", () => {
  // CONT is no part of the timing capacitor's network (a comparator joins
  // them, and nothing else), so the schedule's record of what drives the
  // cycle once left it out: a flag swinging CONT through 10 kΩ moved both
  // trip points, and the schedule drew on at the old frequency.
  const { doc, b, u } = astable555({ ra: 1e3, rb: 10e3, c: 10e-9 });
  const r = b.seat("r3", "resistor", "a60", { ohms: 10e3 });
  b.link(r.get(2), u.get(5));
  b.signal("fm", r.get(1), "low");
  const sim = spice(doc);
  const at = (level) => new Map([["fm", level]]);
  let res = sim.run(0, at(L)).result;
  let t = 0;
  const runFor = (n, level) => {
    for (let i = 0; i < n; i++) {
      t = Math.max(res.wakeAt ?? Number.POSITIVE_INFINITY, t + MIN_SHOWN_S);
      res = sim.run(t, at(level)).result;
    }
    return res.analog.cycle?.period ?? null;
  };
  const low = runFor(40, L);
  const high = runFor(40, H);
  assert.ok(low && high, "both drawn by a schedule");
  // CONT pulled to ~2.5 V, then to ~3.7 V: a lower trip pair, a longer swing
  // (a static 10 kΩ to VCC runs at 173 µs).
  assert.ok(high > low * 1.3, `the period follows CONT: ${low} → ${high}`);
  close(high, 173.06e-6, 1e-3, "CONT pulled high through 10 kΩ");
  assert.ok(runFor(40, L) < low * 1.01, "and back");
});

test("a timing part's structural wiring faults are said under Spice Lite too", () => {
  // A CD4528B's T1 is grounded on no other part inside: left unwired, its
  // capacitor's far plate goes nowhere and the section never times. The
  // digital engine says so; Spice Lite, which drops the problems that are
  // only about what the digital reading recognises, once said nothing.
  const build = (grounded) => {
    const b = bench();
    const u = b.seat("u1", "CD4528B", "e10");
    b.vcc(u.get(16));
    b.gnd(u.get(8));
    const c = b.seat("c1", "cap-ceramic", "a30", { farads: 100e-9 });
    b.link(c.get(1), u.get(2));
    b.link(c.get(2), u.get(1));
    const r = b.seat("r1", "resistor", "a40", { ohms: 10e3 });
    b.link(r.get(1), u.get(2));
    b.vcc(r.get(2));
    if (grounded) b.gnd(u.get(1));
    b.vcc(u.get(3));
    b.gnd(u.get(4));
    b.vcc(u.get(5));
    for (const p of [15, 13, 12]) b.gnd(u.get(p));
    b.vcc(u.get(11));
    return b.doc;
  };
  const timingOf = (doc) => spice(doc).run(0).result.warnings.filter((w) => w.type === "timing"); // prettier-ignore
  const said = timingOf(build(false));
  assert.equal(said.length, 1);
  assert.deepEqual(
    said[0].problems.map((p) => p.code),
    ["notGrounded"],
  );
  assert.deepEqual(timingOf(build(true)), [], "wired right, nothing to say");
});
