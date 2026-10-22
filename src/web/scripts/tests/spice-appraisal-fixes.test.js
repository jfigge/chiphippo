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
  // A 1N4148 straight across a 5 V supply limited to 1 A: 1 A is three times
  // its rating — judged on the limit, the tick after, it burns.
  const b = bench();
  const d = b.seat("d1", "diode", "a5");
  b.vcc(d.get(1));
  b.gnd(d.get(2));
  const burns = [];
  atWakes(b.doc, 0.01, (res) => burns.push(...res.warnings.filter((w) => w.type === "diode-burnt"))); // prettier-ignore
  assert.equal(burns.length, 1);
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
