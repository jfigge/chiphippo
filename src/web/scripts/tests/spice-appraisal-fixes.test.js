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

// The 2026-10-21 appraisal's Spice Lite findings, each held here: a driven
// common voltage never left to the stray, curves never reused across two
// fresh voltage sides, and the rest as they were fixed.

import test from "node:test";
import assert from "node:assert/strict";

import { ENGINES } from "../sim/engines.js";
import { buildNetlist } from "../sim/netlist.js";
import { nextDisplayFrame, sampleAnalog } from "../sim/spice/sample.js";
import { waveGenerator, waveSwing } from "../sim/spice/waves.js";
import { MIN_SHOWN_S } from "../sim/timing.js";
import { AC_SUPPLY_DEF, acPeakOf } from "../catalog/ac-parts.js";
import { inductorOhms } from "../catalog/discretes.js";
import { astable555, bench, runner } from "./timing-fixtures.js";
import { driveSpice } from "../bench/drive-spice.js";

/** A Spice Lite run that carries its state, as SimController does: `run(doc,
    netlist, now)` ticks once. */
function spiceRun() {
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = null;
  return (doc, netlist, now) => {
    const r = ENGINES.spice.tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      signalLevels: new Map(),
      now,
      spice: { config: { enabled: true }, analog },
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    analog = r.analog;
    return r;
  };
}

const netlistOf = (doc) => buildNetlist(doc, new Map(), { inductors: "branch" }); // prettier-ignore

/** `atWakes` in a settle mode ("incremental" or "full"). */
function atWakesMode(doc, stop, mode, each) {
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = null;
  const netlist = netlistOf(doc);
  let now = 0;
  for (let ticks = 0; now <= stop && ticks < 5000; ticks++) {
    const r = ENGINES.spice.tick({ document: doc, netlist, warmStart: warm, state, prevPinLevels: prev, signalLevels: new Map(), now, mode, spice: { config: { enabled: true }, analog } }); // prettier-ignore
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    analog = r.analog;
    each(r, now, netlist);
    if (r.wakeAt == null) break;
    now = Math.max(r.wakeAt, now + MIN_SHOWN_S);
  }
}

/** Tick `doc` at its own wakes (no sooner than `MIN_SHOWN_S`) to `stop`,
    calling `each(result, now)`; the number of ticks. */
function atWakes(doc, stop, each) {
  const run = spiceRun();
  const netlist = netlistOf(doc);
  let now = 0;
  let ticks = 0;
  while (now <= stop && ticks < 5000) {
    const r = run(doc, netlist, now);
    ticks++;
    each(r, now, netlist);
    if (r.wakeAt == null) break;
    now = Math.max(r.wakeAt, now + MIN_SHOWN_S);
  }
  return ticks;
}

test("a 555 into a capacitor wired to nothing stays between its rails", () => {
  // The other plate floats, and the 555 hardly holds an unloaded HIGH: the
  // pair was given the stray, and its LOW side, sinking at its limit, ramped
  // the stray to −204 V (and its HIGH to +85 V) before a corner was read.
  for (const ohms of [null, 47]) {
    const { doc, b, u } = astable555({ ra: 1000, rb: 15000, c: 1e-7, capRef: "cap-ceramic" }); // prettier-ignore
    let lead = u.get(3);
    if (ohms) {
      const r = b.seat("r9", "resistor", "a55", { ohms });
      b.link(r.get(1), u.get(3));
      lead = r.get(2);
    }
    const c = b.seat("c9", "cap-electrolytic", "f55", { farads: 1e-4 });
    b.link(c.get(1), lead);
    b.link(c.get(2), "a60");
    let worst = 0;
    const ticks = atWakes(doc, 0.05, (r) => {
      for (const v of r.nodeVolts.values()) if (Math.abs(v) > Math.abs(worst)) worst = v; // prettier-ignore
    });
    assert.ok(ticks > 50, `${ticks} ticks`);
    assert.ok(
      worst > -1 && worst < 5.5,
      `${ohms ?? "no"} resistor: ${worst} V`,
    );
  }
});

test("two edits at one paused moment run on the second's network, not the first's", () => {
  const b = bench();
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 10e3 });
  const c1 = b.seat("c1", "cap-electrolytic", "a20", { farads: 10e-6 });
  const r2 = b.seat("r2", "resistor", "a30", { ohms: 10e3 });
  const c2 = b.seat("c2", "cap-electrolytic", "a40", { farads: 10e-6 });
  b.vcc(r1.get(1));
  b.link(r1.get(2), c1.get(1));
  b.gnd(c1.get(2));
  b.link(c1.get(1), r2.get(1));
  b.link(r2.get(2), c2.get(1));
  b.gnd(c2.get(2));
  const a = b.at(c1.get(1));
  const withR1 = (ohms) => {
    const d = structuredClone(b.doc);
    d.components.find((c) => c.id === "r1").params.ohms = ohms;
    return d;
  };
  const sampled = (edits) => {
    const run = spiceRun();
    const n0 = netlistOf(b.doc);
    run(b.doc, n0, 0);
    run(b.doc, n0, 0.05);
    let r = null;
    let n = null;
    for (const ohms of edits) {
      const d = withR1(ohms);
      n = netlistOf(d);
      r = run(d, n, 0.05);
    }
    return sampleAnalog(r.analog, 0.09).volts.get(n.netOfPoint.get(a));
  };
  const twice = sampled([1e3, 1e6]);
  const once = sampled([1e6]);
  assert.ok(Math.abs(twice - once) < 1e-4, `${twice} V after two edits, ${once} V after one`); // prettier-ignore
});

test("a supply past its limit at Run burns no diode at its set voltage", () => {
  // 9 V (1 A) → rectifier → 470 µF → 7805 → 10 µF ‖ 1 kΩ: the reservoir
  // drew 94 A at the set voltage, judged before the limit held it.
  const b = bench({ volts: 9 });
  const d = b.seat("d1", "diode", "a5", { grade: "rectifier" });
  const reg = b.seat("u1", "LM7805", "a15");
  b.vcc(d.get(1));
  b.link(d.get(2), reg.get(1));
  b.gnd(reg.get(2));
  const c = b.seat("c1", "cap-electrolytic", "a10", { farads: 470e-6 });
  b.link(c.get(1), reg.get(1));
  b.gnd(c.get(2));
  const co = b.seat("c2", "cap-electrolytic", "a20", { farads: 10e-6 });
  b.link(co.get(1), reg.get(3));
  b.gnd(co.get(2));
  const r = b.seat("r1", "resistor", "a30", { ohms: 1000 });
  b.link(reg.get(3), r.get(1));
  b.gnd(r.get(2));
  const burns = [];
  let out = null;
  atWakes(b.doc, 0.1, (res, now, netlist) => {
    burns.push(...res.warnings.filter((w) => /burnt/.test(w.type)));
    out = res.nodeVolts.get(netlist.netOfPoint.get(b.at(reg.get(3))));
  });
  assert.deepEqual(burns, []);
  assert.ok(Math.abs(out - 5) < 0.1, `OUT ${out} V`);
});

test("a supply past its limit still burns a small-signal diode on the limit", () => {
  // A 1N4148 straight across a 5 V supply limited to 1 A: judged on the
  // limit, 1 A — its sheet's surge for 1 s — burns it a second on, by heat.
  const b = bench();
  const d = b.seat("d1", "diode", "a5");
  b.vcc(d.get(1));
  b.gnd(d.get(2));
  const burns = [];
  atWakes(b.doc, 1.5, (res, now) => burns.push(...res.warnings.filter((w) => w.type === "diode-burnt").map(() => now))); // prettier-ignore
  assert.equal(burns.length, 1);
  assert.ok(Math.abs(burns[0] - 1) < 0.1, `burnt at ${burns[0]} s`);
});

test("the tick a junction burns shows the voltages after it", () => {
  // 5 V → 10 Ω → red LED: the LED burns once its junction has heated (its
  // wakes, ~0.38 s); its anode stands at 5 V with it open, not at the
  // 3.26 V it was driven to.
  const b = bench();
  const r = b.seat("r1", "resistor", "a5", { ohms: 10 });
  const d = b.seat("d1", "led", "a12", { color: "red" });
  b.vcc(r.get(1));
  b.link(r.get(2), d.get(1));
  b.gnd(d.get(2));
  const run = runner(b.doc, { engine: "spice" });
  let res = run.run(0).result;
  for (
    let k = 0;
    k < 20 && !res.warnings.some((w) => w.type === "led-burnt");
    k++
  ) {
    res = run.run(res.wakeAt).result;
  }
  assert.ok(res.warnings.some((w) => w.type === "led-burnt"));
  const anode = res.nodeVolts.get(run.netlist.netOfPoint.get(b.at(r.get(2))));
  assert.ok(Math.abs(anode - 5) < 1e-3, `anode ${anode} V`);
});

test("a mains divider ticked a whole swing apart reads half of L", () => {
  // One unknown, solved from the trough to the crest in one tick: MAX_NEWTON
  // steps of LIMIT_V reached 120 V of the 339 it had to move.
  const b = bench();
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  const r2 = b.seat("r2", "resistor", "a20", { ohms: 1000 });
  b.doc.components.push({ id: "ac1", kind: "ac", ref: "ac", x: -20, y: 30, params: AC_SUPPLY_DEF.normalizeParams({ peak: acPeakOf(240), trough: -acPeakOf(240), hz: 50 }) }); // prettier-ignore
  b.doc.wires.push({ id: "wn", from: "ac1.N", to: "psu1.-", color: "black" });
  b.doc.wires.push({ id: "wl", from: "ac1.L", to: b.at("e10"), color: "red" });
  b.link(r1.get(2), r2.get(1));
  b.gnd(r2.get(2));
  const run = runner(b.doc, { engine: "spice" });
  const mid = run.netlist.netOfPoint.get(b.at(r1.get(2)));
  const l = run.netlist.netOfPoint.get(b.at("e10"));
  for (const t of [0, 0.015, 0.025]) {
    const res = run.run(t).result;
    const want = res.nodeVolts.get(l) / 2;
    assert.ok(Math.abs(res.nodeVolts.get(mid) - want) < 1e-3, `t ${t}: ${res.nodeVolts.get(mid)} V, want ${want}`); // prettier-ignore
  }
});

test("a coil whose only loop a burn opens never reads NaN", () => {
  // 5 V → 10 mH → red LED, no resistor: the LED burns, and the coil's
  // current through what is left grew to Infinity, then NaN.
  const b = bench();
  const l = b.seat("l1", "inductor", "a2", { henries: 10e-3 });
  const d = b.seat("d1", "led", "a12", { color: "red" });
  b.vcc(l.get(1));
  b.link(l.get(2), d.get(1));
  b.gnd(d.get(2));
  const run = runner(b.doc, { engine: "spice" });
  for (let t = 0; t <= 0.5; t += 0.05) {
    const res = run.run(t).result;
    for (const [id, amps] of res.analog.coilAmps) assert.ok(Number.isFinite(amps), `${id} ${amps} A at ${t} s`); // prettier-ignore
    for (const [net, v] of res.nodeVolts) assert.ok(Number.isFinite(v), `${net} ${v} V at ${t} s`); // prettier-ignore
  }
  // …and settles where its supply puts it, not 12 V off: read at the 1e11 V
  // its kick reached, its straight piece ran on to 17.5 V for good.
  const far = run.result.nodeVolts.get(run.netlist.netOfPoint.get(b.at(l.get(2)))); // prettier-ignore
  assert.ok(Math.abs(far - 5) < 0.01, `${far} V`);
});

test("a wave clipped at its rails never hands out a piece that ends where it starts", () => {
  // Rounding put the walk a float's worth past the moment it left (or
  // reached) a rail: from 2^k seconds on, most halves came back with a piece
  // of no length — each its own settle, a desk fifteen times slower.
  for (const wave of [
    "trapezoid",
    "triangle",
    "sine",
    "ramp-up",
    "ramp-down",
  ]) {
    for (const [hz, from] of [
      [1000, 1],
      [1000, 8],
      [10000, 0.25],
    ]) {
      for (const amp of [50, 30, 8, 6]) {
        const swing = waveSwing({ amplitude: amp, offset: 2.5 }, 5);
        const half = 1 / (2 * hz);
        const first = Math.round(from / half);
        for (let k = first; k < first + 40; k++) {
          const since = k * half;
          let t = since;
          for (let j = 0; j < 12 && t < since + half; j++) {
            const g = waveGenerator(wave, k % 2 ? "H" : "L", { half, since }, swing, t); // prettier-ignore
            assert.ok(g.end > t, `${wave} ${hz} Hz ${amp} V at ${t} s`);
            t = g.end;
          }
        }
      }
    }
  }
});

test("a regulator back on after its shutdown runs until it heats again", () => {
  // 12 V (3 A) → 7805 → 0.5 Ω: it trips, cools for a second, and came back
  // for one millisecond — the second it spent off booked at half its watts.
  const b = bench({ volts: 12 });
  b.doc.components[0].params.currentLimit = 3;
  const u = b.seat("u1", "LM7805", "a10");
  b.vcc(u.get(1));
  b.gnd(u.get(2));
  const rl = b.seat("rl", "resistor", "a40", { ohms: 0.5 });
  b.link(u.get(3), rl.get(1));
  b.gnd(rl.get(2));
  const run = runner(b.doc, { engine: "spice" });
  let t = 0;
  let r = run.run(0).result;
  const flips = [];
  let was = false;
  for (let i = 0; i < 400 && t < 4; i++) {
    t = Math.min(r.wakeAt ?? t + 0.25, t + 0.25);
    r = run.run(t).result;
    const off = r.bench.get("u1").off;
    if (off !== was) flips.push(t);
    was = off;
  }
  // off, on, off, …: each stretch on is a heating's worth, not a moment.
  for (let k = 1; k + 1 < flips.length; k += 2) {
    assert.ok(flips[k + 1] - flips[k] > 0.05, `on ${flips[k]}–${flips[k + 1]} s`); // prettier-ignore
  }
  assert.ok(flips.length >= 3, flips.join());
});

test("an AC source's own frames are timed by its frequency", () => {
  // A 50 Hz adapter into an RC, the analyzer recording: framed as
  // SimController frames it from its period — not as a wave of no period.
  const b = bench();
  b.doc.components.push({ id: "ac1", kind: "adapter", ref: "adapter", x: -26, y: 9.5, params: { hz: 50, rms: 9 } }); // prettier-ignore
  const r = b.seat("r1", "resistor", "a10", { ohms: 1e3 });
  const c = b.seat("c1", "cap-ceramic", "a20", { farads: 1e-6 });
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  b.doc.wires.push({ id: "x1", from: "ac1.S1", to: b.at(r.get(1).replace(/^a/, "b")), color: "orange" }); // prettier-ignore
  b.doc.wires.push({ id: "x2", from: "ac1.S2", to: "psu1.-", color: "blue" });
  const netlist = netlistOf(b.doc);
  const res = ENGINES.spice.tick({ document: b.doc, netlist, warmStart: new Map(), state: new Map(), prevPinLevels: new Map(), signalLevels: new Map(), now: 0, spice: { config: { enabled: true }, analog: null, waveFrames: true } }); // prettier-ignore
  // As SimController frames it from the published analog state — whatever
  // frequency the supply is held to.
  const shown = nextDisplayFrame(res.analog, 0, res.analog.time, { gapPercent: 1, waveFrames: true }); // prettier-ignore
  assert.equal(res.frameAt, shown);
});

test("a gate's input below its threshold shows X where it reads X, with a capacitor on the desk", () => {
  // A 74LS04 input pulled down by 10 kΩ stands at 1.1 V — X to it. A desk
  // with an RC node (100 nF on a 74LS08 input) re-read it outside a pass,
  // and the incremental settle showed L for the whole run.
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const r = b.seat("r1", "resistor", "a40", { ohms: 10000 });
  b.link(r.get(1), u.get(1));
  b.gnd(r.get(2));
  const g = b.seat("u2", "74LS08", "e50");
  b.vcc(g.get(14));
  b.gnd(g.get(7));
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 1e-7 });
  b.link(c.get(1), g.get(1));
  b.gnd(c.get(2));
  for (const mode of ["incremental", "full"]) {
    const levels = [];
    atWakesMode(b.doc, 0.01, mode, (res, now, netlist) => levels.push(res.netLevels.get(netlist.netOfPoint.get(b.at(u.get(1)))))); // prettier-ignore
    assert.ok(
      levels.every((l) => l === "X"),
      `${mode}: ${levels.join()}`,
    );
  }
});

test("an unloaded regulator holds its output at its target", () => {
  // Sourcing only, every voltage at or above its target drew nothing: OUT
  // read 6.5 V off 9 V, 5.75 V off 7.5 V. Its divider says where it is.
  for (const volts of [7.5, 9, 12]) {
    const b = bench({ volts });
    const u = b.seat("u1", "LM7805", "a10");
    b.vcc(u.get(1));
    b.gnd(u.get(2));
    const run = runner(b.doc, { engine: "spice" });
    const res = run.run(0).result;
    const out = res.nodeVolts.get(run.netlist.netOfPoint.get(b.at(u.get(3))));
    assert.ok(Math.abs(out - 5) < 1e-3, `${volts} V in: OUT ${out} V`);
    assert.ok(Math.abs(res.bench.get("u1").volts - 5) < 1e-3);
  }
});

test("a supply pulled down for a moment is back at its set volts by the next wake", () => {
  // 9 V → 7805 → 100 nF, nothing else: the tick at Run drooped the supply
  // to 5.98 V charging the capacitor, then asked for no wake — and it read
  // that until something else ticked the desk.
  const b = bench({ volts: 9 });
  const u = b.seat("u1", "LM7805", "a10");
  b.vcc(u.get(1));
  b.gnd(u.get(2));
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 100e-9 });
  b.link(u.get(3), c.get(1));
  b.gnd(c.get(2));
  let last = null;
  atWakes(b.doc, 1, (res) => {
    last = res.supplies.get("psu1");
  });
  assert.ok(Math.abs(last.volts - 9) < 1e-3, `${last.volts} V`);
});

test("a slow sine's crest is found beside a fast ring, at any tick spacing", () => {
  // A 1 V~ adapter's ±1.4 V at 60 Hz through 1 µF onto a CD40106B held
  // mid-supply (1 MΩ to each rail), with 10 nF through 100 µH on its input:
  // the group rings at 159 kHz too, and was searched only at that — a crest
  // one period late when ticked at its wakes, on time at a 1 ms grid.
  const trips = [];
  for (const grid of [null, 1e-3]) {
    const b = bench();
    const u = b.seat("u1", "CD40106B", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
    const r1 = b.seat("r1", "resistor", "a50", { ohms: 1e6 });
    const r2 = b.seat("r2", "resistor", "a55", { ohms: 1e6 });
    b.link(u.get(1), c.get(2));
    b.link(u.get(1), r1.get(1));
    b.vcc(r1.get(2));
    b.link(u.get(1), r2.get(1));
    b.gnd(r2.get(2));
    b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -40, y: 30, params: { hz: 60, rms: 1 } }); // prettier-ignore
    b.doc.wires.push({ id: "wl", from: "adp1.S1", to: b.at(c.get(1)), color: "red" }); // prettier-ignore
    b.doc.wires.push({ id: "wn", from: "adp1.S2", to: "psu1.-", color: "black" }); // prettier-ignore
    const c2 = b.seat("c2", "cap-ceramic", "a30", { farads: 10e-9 });
    b.gnd(c2.get(2));
    const l = b.seat("l1", "inductor", "a20", { henries: 100e-6 });
    b.link(u.get(1), l.get(1));
    b.link(l.get(2), c2.get(1));
    const run = runner(b.doc, { engine: "spice" });
    const out = run.netlist.netOfPoint.get(b.at(u.get(2)));
    let t = 0;
    let trip = null;
    for (let ticks = 0; t <= 2 && ticks < 5000; ticks++) {
      const res = run.run(t).result;
      if (res.netLevels.get(out) === "L") {
        trip = t;
        break;
      }
      const wake = res.wakeAt ?? Infinity;
      t = grid ? Math.min(wake, (Math.floor(t / grid + 1e-9) + 1) * grid) : Math.min(wake, t + 0.25); // prettier-ignore
    }
    trips.push(trip);
  }
  assert.ok(trips[0] != null && Math.abs(trips[0] - trips[1]) < 1e-3, trips.join(" vs ")); // prettier-ignore
});

test("a series RLC's resistance is its resistor's and its winding's, an ohm or under", () => {
  // A flag → R → 10 mH → 1 µF: the two modes' rates sum to −R/L. At 1 Ω
  // or less the resistor dropped out (6.015 Ω read where 7.015 was).
  for (const ohms of [0.5, 1, 10]) {
    const b = bench();
    const r = b.seat("r1", "resistor", "a10", { ohms });
    const l = b.seat("l1", "inductor", "a20", { henries: 0.01 });
    const c = b.seat("c1", "cap-ceramic", "a30", { farads: 1e-6 });
    b.signal("s1", r.get(1), "low");
    b.link(r.get(2), l.get(1));
    b.link(l.get(2), c.get(1));
    b.gnd(c.get(2));
    const run = runner(b.doc, { engine: "spice" });
    run.run(0, new Map([["s1", "L"]]));
    run.run(1e-3, new Map([["s1", "H"]]));
    const res = run.run(1e-3 + 1e-6, new Map([["s1", "H"]])).result;
    const sum = res.analog.coils.get("l1").terms.reduce((s, t) => s + t.k, 0);
    const want = ohms + inductorOhms({ henries: 0.01 });
    assert.ok(Math.abs(-sum * 0.01 - want) < 0.01 * want, `${ohms} Ω: ${-sum * 0.01} Ω, want ${want}`); // prettier-ignore
  }
});

test("a hard-saturated transistor's base stands where ngspice puts it", () => {
  // The base current through RB was only its forward part; saturated, the
  // reverse transistor's base current crosses RB too. ngspice (the device
  // deck, Gummel–Poon): 0.9545 V / 0.0488 V at 220 Ω / 470 Ω on a 2N3904,
  // 1.5529 V / 0.1209 V at 47 Ω / 47 Ω on a 2N2222A. It read 0.77 and 0.87.
  for (const [grade, rb, rc, vb, vc] of [
    ["small-signal", 220, 470, 0.9545, 0.0488],
    ["general", 47, 47, 1.5529, 0.1209],
  ]) {
    // prettier-ignore
    const b = bench();
    const r1 = b.seat("rb", "resistor", "a10", { ohms: rb });
    const q = b.seat("q1", "npn", "a20", { grade });
    const r2 = b.seat("rc", "resistor", "a30", { ohms: rc });
    b.vcc(r1.get(1));
    b.link(r1.get(2), q.get(2));
    b.gnd(q.get(1));
    b.vcc(r2.get(1));
    b.link(r2.get(2), q.get(3));
    const run = runner(b.doc, { engine: "spice" });
    const res = run.run(0).result;
    const at = (pin) => res.nodeVolts.get(run.netlist.netOfPoint.get(b.at(q.get(pin)))); // prettier-ignore
    assert.ok(Math.abs(at(2) - vb) < 5e-3, `${grade}: VB ${at(2)}, ngspice ${vb}`); // prettier-ignore
    assert.ok(Math.abs(at(3) - vc) < 5e-3, `${grade}: VC ${at(3)}, ngspice ${vc}`); // prettier-ignore
  }
});

/** A 1 kΩ/10 kΩ 555 on `farads` into a red LED through `ohms`, run for
    `seconds`: when its LED burnt (null if it never did) and the hottest
    junction a tick booked. */
function led555(farads, ohms, seconds) {
  const capRef = farads >= 1e-6 ? "cap-electrolytic" : "cap-ceramic";
  const { b, u } = astable555({ ra: 1e3, rb: 10e3, c: farads, capRef });
  const led = b.seat("d1", "led", "a58", { color: "red" });
  const r = b.seat("rr", "resistor", "f58", { ohms });
  b.link(u.get(3), r.get(1));
  b.link(r.get(2), led.get(1));
  b.gnd(led.get(2));
  let burnt = null;
  let hottest = 0;
  driveSpice(b.doc, {
    seconds,
    onTick(now, res) {
      if (burnt == null && res.warnings.some((w) => w.type === "led-burnt")) burnt = now; // prettier-ignore
      for (const h of res.analog?.ledHeats?.values() ?? []) hottest = Math.max(hottest, h.tj); // prettier-ignore
    },
  });
  return { burnt, hottest };
}

test("an LED on a fast 555 heats by its duty, drawn or not", () => {
  // A tick's end landed on whichever phase it landed on, and that phase's
  // current was booked for the whole tick: through 4.7 Ω an LED that sits
  // near 111 °C at every frequency burnt in 2 s at 2 kHz (a drawn cycle)
  // and, straight on the output, a 68 kHz one (not drawn — read only at
  // ticks' ends, nearly all HIGH) burnt in a third of a slower one's time.
  for (const farads of [33e-9, 1e-9]) {
    const warm = led555(farads, 4.7, 3);
    assert.equal(warm.burnt, null, `${farads} F through 4.7 Ω`);
    assert.ok(warm.hottest > 100 && warm.hottest < 120, `${farads} F: ${warm.hottest} °C`); // prettier-ignore
  }
  const slow = led555(1e-6, 0.01, 2).burnt;
  for (const farads of [33e-9, 1e-9]) {
    const { burnt } = led555(farads, 0.01, 2);
    assert.ok(burnt != null && Math.abs(burnt - slow) < 0.2, `${farads} F burnt at ${burnt} s, ${slow} s at 69 Hz`); // prettier-ignore
  }
});

/** An LM358 on 9 V at e10 with IN+ held at 4.5 V by 10 k / 10 k, and with
    `feedback` 10 k more from OUT to IN+ (a Schmitt trigger: 3.0 / 5.5 V). */
function lm358(feedback) {
  const b = bench({ volts: 9 });
  const u = b.seat("u1", "LM358", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(4));
  const ra = b.seat("ra", "resistor", "a20", { ohms: 10e3 });
  const rb = b.seat("rb", "resistor", "a25", { ohms: 10e3 });
  b.vcc(ra.get(1));
  b.link(ra.get(2), u.get(3));
  b.link(rb.get(1), u.get(3));
  b.gnd(rb.get(2));
  if (feedback) {
    const rf = b.seat("rf", "resistor", "a30", { ohms: 10e3 });
    b.link(rf.get(1), u.get(1));
    b.link(rf.get(2), u.get(3));
  }
  // The second half a follower on IN+ (no input left floating).
  b.link(u.get(7), u.get(6));
  b.link(u.get(5), u.get(3));
  return { b, u };
}

test("an LM358 relaxation oscillator runs on, crossing after crossing", () => {
  // It stopped after two: at its threshold a millivolt's read spanned the
  // whole swing, a balance microseconds ahead that the node sat on for good.
  const { b, u } = lm358(true);
  const r = b.seat("r", "resistor", "a40", { ohms: 100e3 });
  const c = b.seat("c", "cap-ceramic", "a50", { farads: 100e-9 });
  b.link(r.get(1), u.get(1));
  b.link(r.get(2), u.get(2));
  b.link(c.get(1), u.get(2));
  b.gnd(c.get(2));
  const flips = [];
  let was = null;
  driveSpice(b.doc, {
    seconds: 0.2,
    onTick(now, res, inp) {
      const v = res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(u.get(1))));
      const hi = v > 4.5;
      if (was != null && hi !== was) flips.push(now);
      was = hi;
    },
  });
  assert.ok(flips.length > 20, `${flips.length} flips in 0.2 s`);
  const period = (flips.at(-1) - flips.at(-3)) * 1e3;
  assert.ok(Math.abs(period - 14.2) < 0.5, `${period} ms`);
});

/** `lm358(true)` as a relaxation oscillator: 10 k from OUT to IN−, `farads`
    from IN− to ground. */
function relaxation(farads) {
  const { b, u } = lm358(true);
  const r = b.seat("r", "resistor", "a40", { ohms: 10e3 });
  const c = b.seat("c", "cap-ceramic", "a50", { farads });
  b.link(r.get(1), u.get(1));
  b.link(r.get(2), u.get(2));
  b.link(c.get(1), u.get(2));
  b.gnd(c.get(2));
  return { b, u };
}

test("an LM358 relaxation oscillator faster than the desk shows is drawn, at its true period", () => {
  // No pin listens to it, so it was never recorded, never drawn: stepped
  // edge by edge, at 1 nF it took 2.4 s a frame. Its period, from its
  // thresholds (5.496 V and 3.006 V) and its swing (7.49 V, 0.02 V): 10 k ×
  // C × (ln(4.48 / 1.99) + ln(5.48 / 2.99)) — 141.8 µs at 10 nF.
  for (const [farads, us] of [
    [10e-9, 141.8],
    [1e-9, 14.18],
  ]) {
    // prettier-ignore
    const { b } = relaxation(farads);
    const stats = {};
    const { result } = driveSpice(b.doc, { seconds: 0.2, stats });
    const period = result.analog.cycle?.period * 1e6;
    assert.ok(Math.abs(period - us) < us * 0.005, `${farads} F: ${period} µs`);
    assert.ok(stats.settles < 200, `${farads} F: ${stats.settles} settles`);
  }
});

test("an LM358 relaxation oscillator between 1 and 2 kHz is drawn, and so is one with narrow hysteresis", () => {
  // At 1.5 kHz a period is longer than a tick (half a millisecond), and a
  // cycle was looked for only inside one: stepped edge by edge, 1.5 s a
  // simulated second. With 1 MΩ of feedback its capacitor swings 37 mV —
  // under the 1 % of the supply a cycle must swing — and it was stepped at
  // 20 to 2400 s a simulated second, its output frozen HIGH.
  const cases = [
    // 10 k × 47 nF × 1.4176 (thresholds 3.006 V / 5.496 V).
    [47e-9, 10e3, 666.3],
    // 10 k / 10 k / 1 MΩ: thresholds 4.4777 V and 4.5149 V, out 7.49 V
    // and about 0.02 V.
    [100e-9, 1e6, 20.7],
  ];
  for (const [farads, rf, us] of cases) {
    const { b, u } = lm358(false);
    const f = b.seat("rf", "resistor", "a30", { ohms: rf });
    b.link(f.get(1), u.get(1));
    b.link(f.get(2), u.get(3));
    const r = b.seat("r", "resistor", "a40", { ohms: 10e3 });
    const c = b.seat("c", "cap-ceramic", "a50", { farads });
    b.link(r.get(1), u.get(1));
    b.link(r.get(2), u.get(2));
    b.link(c.get(1), u.get(2));
    b.gnd(c.get(2));
    const stats = {};
    const { result } = driveSpice(b.doc, { seconds: 0.1, stats });
    const period = result.analog.cycle?.period * 1e6;
    assert.ok(Math.abs(period - us) < us * 0.01, `${farads} F, ${rf} Ω: ${period} µs`); // prettier-ignore
    assert.ok(stats.settles < 200, `${farads} F, ${rf} Ω: ${stats.settles} settles`); // prettier-ignore
  }
});

test("an LM358 relaxation oscillator's period is its thresholds', the + input's own", () => {
  // Every corner search pinned the capacitor from a guess its + input
  // disagreed with, and found a swing where the guess's + input stood — a
  // millivolt and a half early — then searched again from there; the
  // Schmitt's band held on the side it was at (`heldFall`) finds each
  // threshold the once. Guarded here: the period those thresholds make.
  const { b, u } = relaxation(100e-9);
  const flips = [];
  let was = null;
  driveSpice(b.doc, {
    seconds: 0.05,
    onTick(now, res, inp) {
      const v = res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(u.get(1))));
      const hi = v > 4.5;
      if (was != null && hi !== was) flips.push(now);
      was = hi;
    },
  });
  assert.ok(flips.length > 40, `${flips.length} flips`);
  // 1.4176 ms: 811 µs charging, 607 µs discharging.
  const period = (flips.at(-1) - flips.at(-3)) * 1e6;
  assert.ok(Math.abs(period - 1417.6) < 2, `${period} µs`);
});

test("a triangle generator's square output shows the side it swung to, every frame", () => {
  // Its integrator's capacitor joins two moving nets, a group: the group's
  // model was read across the Schmitt's swing, but nothing kept the swing,
  // and solved at the frame from where it had stood the square sat in its
  // band on the side it had left — LOW at every frame while the triangle
  // turned.
  const b = bench({ volts: 9 });
  const u = b.seat("u1", "LM358", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(4));
  const d1 = b.seat("d1", "resistor", "a20", { ohms: 10e3 });
  const d2 = b.seat("d2", "resistor", "a25", { ohms: 10e3 });
  b.vcc(d1.get(1));
  b.link(d1.get(2), d2.get(1));
  b.gnd(d2.get(2));
  b.link(d1.get(2), u.get(2));
  b.link(d1.get(2), u.get(5));
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  const r2 = b.seat("r2", "resistor", "a35", { ohms: 20e3 });
  b.link(r1.get(1), u.get(7));
  b.link(r1.get(2), u.get(3));
  b.link(r2.get(1), u.get(3));
  b.link(r2.get(2), u.get(1));
  const ri = b.seat("ri", "resistor", "a40", { ohms: 10e3 });
  const ci = b.seat("ci", "cap-ceramic", "a46", { farads: 47e-9 });
  b.link(ri.get(1), u.get(1));
  b.link(ri.get(2), u.get(6));
  b.link(ci.get(1), u.get(7));
  b.link(ci.get(2), u.get(6));
  const at = [];
  for (let k = 1; k <= 12; k++) at.push(k * 5e-4);
  const seen = [];
  driveSpice(b.doc, {
    seconds: 0.006,
    at,
    onTick(now, res, inp) {
      const v = (p) => res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(u.get(p)))); // prettier-ignore
      if (at.some((x) => Math.abs(x - now) < 1e-12)) seen.push([now, v(1), v(3)]); // prettier-ignore
    },
  });
  assert.ok(seen.length >= 10, `${seen.length} frames`);
  // The square on a rail, and on the side its + input agrees with: above
  // 4.5 V while HIGH, below while LOW — and it is HIGH at some of them.
  for (const [now, sq, inp] of seen) {
    assert.ok(sq < 0.1 || sq > 7, `${now}: square ${sq} V`);
    assert.equal(sq > 4.5, inp > 4.5, `${now}: square ${sq} V, IN+ ${inp} V`);
  }
  assert.ok(
    seen.some(([, sq]) => sq > 7),
    "never HIGH at a frame",
  );
});

test("an LM358 comparator switches at its crossing, on a capacitor and on a triangle", () => {
  // On a capacitor it stood mid-swing from the crossing to the next
  // unrelated event; on a triangle it switched a display frame late, at
  // 6 V and 3 V for 4.5.
  const rc = lm358(false);
  rc.b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 80, y: 30, params: { hz: 10 } }); // prettier-ignore
  rc.b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
  );
  const rin = rc.b.seat("rin", "resistor", "a40", { ohms: 10e3 });
  const c = rc.b.seat("c", "cap-electrolytic", "a50", { farads: 1e-6 });
  rc.b.doc.wires.push({ id: "wc3", from: "clk1.out", to: rc.b.at(rin.get(1).replace(/^a/, "c")), color: "red" }); // prettier-ignore
  rc.b.link(rin.get(2), rc.u.get(2));
  rc.b.link(c.get(1), rc.u.get(2));
  rc.b.gnd(c.get(2));
  const seen = [];
  driveSpice(rc.b.doc, {
    seconds: 0.2,
    onTick(now, res, inp) {
      const at = (p) => res.nodeVolts.get(inp.netlist.netOfPoint.get(rc.b.at(rc.u.get(p)))); // prettier-ignore
      seen.push([now, at(1), at(2)]);
    },
  });
  // Every tick with IN− past IN+ by a millivolt shows OUT at a rail.
  for (const [now, out, inn] of seen) {
    if (Math.abs(inn - 4.5) > 1e-3) assert.ok(out < 0.1 || out > 7, `${now}: OUT ${out} V at IN− ${inn} V`); // prettier-ignore
  }
  const tri = lm358(true);
  tri.b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 80, y: 30, params: { hz: 10, wave: "triangle" } }); // prettier-ignore
  tri.b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
  );
  const r1 = tri.b.seat("rin", "resistor", "a40", { ohms: 1e3 });
  tri.b.doc.wires.push({ id: "wc3", from: "clk1.out", to: tri.b.at(r1.get(1).replace(/^a/, "c")), color: "red" }); // prettier-ignore
  tri.b.link(r1.get(2), tri.u.get(2));
  const flips = [];
  let was = null;
  driveSpice(tri.b.doc, {
    seconds: 0.2,
    onTick(now, res, inp) {
      const v = res.nodeVolts.get(inp.netlist.netOfPoint.get(tri.b.at(tri.u.get(1)))); // prettier-ignore
      const hi = v > 4.5;
      if (was != null && hi !== was) flips.push(now);
      was = hi;
    },
  });
  // A 0–9 V triangle at 10 Hz: 5.5 V rising at 30.6 ms, 3.0 V falling at
  // 83.3 ms (each a period on).
  assert.ok(Math.abs(flips[0] - 0.0306) < 2e-4, `${flips[0]}`);
  assert.ok(Math.abs(flips[1] - 0.0833) < 2e-4, `${flips[1]}`);
});

test("a capacitor across a supply on its limit runs down to the limit, the supply held all the way", () => {
  // Freed the moment it was overloaded, its + was the capacitor's, charged
  // to 5 V: the supply delivered nothing there, and was a rail again at
  // once — the overload held at 5 V for good. And the corner it fell
  // through a millivolt down went unseen, so nothing woke the desk.
  // 10 Ω on 0.1 A: 1 V, falling from 5 V with τ = 10 Ω × 1000 µF.
  const b = bench();
  b.doc.components[0].params.currentLimit = 0.1;
  const r = b.seat("rl", "resistor", "a20", { ohms: 10 });
  b.vcc(r.get(1));
  b.gnd(r.get(2));
  const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 1000e-6 });
  b.vcc(c.get(1));
  b.gnd(c.get(2));
  const seen = new Map();
  const run = driveSpice(b.doc, {
    seconds: 0.5,
    at: [0.005, 0.01],
    onTick(now, res, inp) {
      seen.set(+now.toFixed(6), res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(r.get(1))))); // prettier-ignore
    },
  });
  for (const [at, v] of [
    [0.005, 1 + 4 * Math.exp(-0.5)],
    [0.01, 1 + 4 * Math.exp(-1)],
  ]) {
    // prettier-ignore
    assert.ok(Math.abs(seen.get(at) - v) < 0.01, `${at} s: ${seen.get(at)} V, not ${v}`); // prettier-ignore
  }
  const rail = run.result.nodeVolts.get(run.netlist.netOfPoint.get(b.at(r.get(1)))); // prettier-ignore
  assert.ok(Math.abs(rail - 1) < 0.02, `${rail} V at the end`);
  const psu = run.result.analog.supplies.get("psu1");
  assert.ok(Math.abs(psu.volts - 1) < 0.02, `the supply reads ${psu.volts} V`);
});

test("an LM358 integrator leaving saturation ramps down from its rail, every net inside the supply", () => {
  // At the moment its − input came back to its + input the pieces it
  // headed into read the output at its sink limit — a fixed current that
  // holds neither of the capacitor's plates — and the linear piece put
  // them 195 V away: OUT read −188 V, then ran on to −560 V, unwarned.
  // 10 kΩ, 100 nF, + input at 4.5 V, a 500 Hz 0/9 V clock: saturated at
  // 7.51 V by 1 ms; from 1.248 ms (− input back at 4.5 V) it falls at
  // 4.5 V a millisecond.
  const { b, u } = lm358(false);
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 80, y: 30, params: { hz: 500 } }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
  );
  const ri = b.seat("ri", "resistor", "a40", { ohms: 10e3 });
  const ci = b.seat("ci", "cap-ceramic", "a46", { farads: 100e-9 });
  b.doc.wires.push({ id: "wc3", from: "clk1.out", to: b.at(ri.get(1).replace(/^a/, "c")), color: "red" }); // prettier-ignore
  b.link(ri.get(2), u.get(2));
  b.link(ci.get(1), u.get(2));
  b.link(ci.get(2), u.get(1));
  let lo = 0;
  let hi = 0;
  let at15 = null;
  driveSpice(b.doc, {
    seconds: 0.01,
    at: [0.0015],
    onTick(now, res, inp) {
      for (const v of res.nodeVolts.values()) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (Math.abs(now - 0.0015) < 1e-12) at15 = res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(u.get(1)))); // prettier-ignore
    },
  });
  assert.ok(lo > -0.05 && hi < 9.05, `nets read ${lo}…${hi} V`);
  assert.ok(Math.abs(at15 - 6.374) < 0.02, `OUT ${at15} V at 1.5 ms`);
});
