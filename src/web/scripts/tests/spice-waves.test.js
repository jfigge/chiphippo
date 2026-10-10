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

// A clock brick's wave under Spice Lite (sim/spice/waves.js): a triangle,
// either sawtooth or a sine from 0 V to its supply, between the edges its
// square still keeps. Held against the closed forms: an RC low-pass fed a
// triangle or a sine, a high-pass taking a sawtooth's drop, a Schmitt input
// switching where the wave crosses its thresholds — and the digital engine
// still running every clock square.

import test from "node:test";
import assert from "node:assert/strict";
import { H, L } from "../sim/levels.js";
import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";
import { partDef } from "../catalog/index.js";
import { CLOCK_WAVES, LEVEL_WAVES } from "../catalog/parts.js";
import {
  TRAPEZOID_RAMP,
  cyclePhase,
  waveGenerator,
  waveVolts,
} from "../sim/spice/waves.js";
import { EdgeSchedule } from "../sim/schedule.js";
import { bench } from "./timing-fixtures.js";
import { driveSpice } from "../bench/drive-spice.js";

const clockDef = partDef("clock");

/** A desk with a clock putting out `wave` at `hz`, its `out` on a5's node. */
function clockDesk({ wave, hz, volts = 5 }) {
  const b = bench({ volts });
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: clockDef.normalizeParams({ hz, wave }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at("a5"), color: "blue" },
  );
  return b;
}

/**
 * Run a desk as SimController does: the clock's edges every half period,
 * the engine's own wakes between them, each tick handed the clock's level and
 * its timing (`clockTimes`). `sample(now, result, netlist)` sees every tick.
 * `held` holds the clock by its own pause at that fraction of its half.
 */
function run(doc, { hz, until, engine = "spice", mode, held = null, sample }) {
  const { tick } = ENGINES[engine];
  const netlist = buildNetlist(doc, new Map(), { inductors: "branch" });
  const half = 1 / (2 * hz);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  let analog = null;
  let level = L;
  let since = 0;
  let now = 0;
  const results = [];
  for (let k = 0; k < 5000; k++) {
    const timing = held == null ? { half, since } : { half, frac: held };
    const r = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", level]]),
      clockTimes: new Map([["clk1", timing]]),
      signalLevels: new Map(),
      now,
      mode,
      ...(engine === "spice" ? { spice: { config: { enabled: true }, analog } } : {}), // prettier-ignore
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    analog = r.analog ?? null;
    results.push({ now, r });
    sample?.(now, r, netlist);
    const edge = held == null ? since + half : Number.POSITIVE_INFINITY;
    // Its wakes and its display frames (spice/sample.js), as the transport
    // ticked it before the frames stopped being wakes: these tests read the
    // waves at the moments they always did.
    const due = Math.min(r.wakeAt ?? Infinity, r.frameAt ?? Infinity);
    const wake = Number.isFinite(due) ? Math.max(due, now + 1e-4) : Number.POSITIVE_INFINITY; // prettier-ignore
    const next = Math.min(edge, wake);
    if (!(next <= until)) break;
    now = next;
    if (now === edge) {
      level = level === H ? L : H;
      since = now;
    }
  }
  return { netlist, results };
}

/** An RC low-pass on the clock: 10 kΩ from a5's node to a 1 µF at a20. */
function lowPass(b) {
  const r = b.seat("r1", "resistor", "c5", { ohms: 10000 });
  const c = b.seat("c1", "cap-ceramic", "a20", { farads: 1e-6 });
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
}

const near = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (±${tol})`);

test("the wave list: square first, and stored only off it", () => {
  assert.equal(CLOCK_WAVES[0], "square");
  assert.deepEqual(clockDef.normalizeParams({ hz: 5 }), { hz: 5 });
  assert.deepEqual(clockDef.normalizeParams({ hz: 5, wave: "square" }), { hz: 5 }); // prettier-ignore
  assert.deepEqual(clockDef.normalizeParams({ hz: 5, wave: "sine" }), { hz: 5, wave: "sine" }); // prettier-ignore
  assert.deepEqual(clockDef.normalizeParams({ hz: 5, wave: "wobble" }), { hz: 5 }); // prettier-ignore
  // A manual clock is a switch, and a switch is square.
  assert.equal(clockDef.waveOf({ hz: "manual", wave: "sine" }), "square");
  assert.equal(clockDef.waveOf({ hz: 2, wave: "triangle" }), "triangle");
  // The levels run in both engines; every other wave is Spice Lite's.
  assert.deepEqual(LEVEL_WAVES, ["square", "pwm"]);
  const field = clockDef.properties.find((f) => f.key === "wave");
  assert.ok(!field.spiceOnly, "the field itself is offered in both engines");
  assert.deepEqual(
    field.options.filter((o) => !o.spiceOnly).map((o) => o.value),
    LEVEL_WAVES,
  );
  assert.equal(field.default, "square");
});

test("a PWM's pulse width: whole percents 1–99, stored only off 50", () => {
  const norm = (raw) => clockDef.normalizeParams({ hz: 5, ...raw });
  assert.deepEqual(norm({ wave: "pwm" }), { hz: 5, wave: "pwm" });
  assert.deepEqual(norm({ wave: "pwm", duty: 50 }), { hz: 5, wave: "pwm" });
  assert.deepEqual(norm({ wave: "pwm", duty: 25 }), { hz: 5, wave: "pwm", duty: 25 }); // prettier-ignore
  assert.deepEqual(norm({ wave: "pwm", duty: 0 }), { hz: 5, wave: "pwm", duty: 1 }); // prettier-ignore
  assert.deepEqual(norm({ wave: "pwm", duty: 100 }), { hz: 5, wave: "pwm", duty: 99 }); // prettier-ignore
  assert.deepEqual(norm({ wave: "pwm", duty: 12.6 }), { hz: 5, wave: "pwm", duty: 13 }); // prettier-ignore
  assert.deepEqual(norm({ wave: "pwm", duty: "x" }), { hz: 5, wave: "pwm" });
  // Only a PWM has one.
  assert.deepEqual(norm({ wave: "square", duty: 25 }), { hz: 5 });
  assert.deepEqual(norm({ wave: "trapezoid", duty: 25 }), { hz: 5, wave: "trapezoid" }); // prettier-ignore
  assert.equal(clockDef.dutyOf({ hz: 5, wave: "pwm", duty: 25 }), 0.25);
  assert.equal(clockDef.dutyOf({ hz: 5, wave: "pwm" }), 0.5);
  assert.equal(clockDef.dutyOf({ hz: 5, wave: "square", duty: 25 }), 0.5);
  assert.equal(clockDef.dutyOf({ hz: "manual", wave: "pwm", duty: 25 }), 0.5);
});

test("each wave starts at its LOW point and runs 0 V to its supply", () => {
  for (const wave of ["triangle", "ramp-up", "sine"]) {
    assert.equal(waveVolts(wave, 0, 5), 0, wave);
  }
  assert.equal(waveVolts("ramp-down", 0, 5), 5);
  assert.equal(waveVolts("triangle", 0.5, 5), 5);
  near(waveVolts("sine", 0.5, 5), 5, 1e-12, "sine peak");
  near(waveVolts("sine", 0.25, 5), 2.5, 1e-12, "sine middle");
  assert.equal(waveVolts("ramp-up", 0.75, 4), 3);
  assert.equal(waveVolts("ramp-down", 0.75, 4), 1);
  // The phase: LOW half first, each as far in as the time since its edge.
  const timing = { half: 0.5, since: 1 };
  assert.equal(cyclePhase(L, timing, 1.25), 0.25);
  assert.equal(cyclePhase(H, timing, 1.25), 0.75);
  // Held by its own pause it stands still; an edge overdue, at its half's end.
  assert.equal(cyclePhase(L, { half: 0.5, frac: 0.4 }, 99), 0.2);
  assert.equal(cyclePhase(L, timing, 9), 0.5);
});

test("a generator's slope and edge are the wave's own", () => {
  const timing = { half: 0.05, since: 0 };
  const tri = waveGenerator("triangle", L, timing, 5, 0.01);
  assert.equal(tri.slope, 100); // 5 V up in one half of 50 ms
  assert.equal(tri.end, 0.05);
  assert.equal(waveGenerator("triangle", H, timing, 5, 0.01).slope, -100);
  assert.equal(waveGenerator("ramp-up", H, timing, 5, 0.01).slope, 50);
  assert.equal(waveGenerator("ramp-down", L, timing, 5, 0.01).slope, -50);
  const sine = waveGenerator("sine", L, timing, 5, 0.025);
  near(sine.omega, 2 * Math.PI * 10, 1e-9, "ω");
  near(sine.aux, 2.5, 1e-12, "quadrature at mid-rise");
  // Held, or past its edge: still.
  const held = waveGenerator("triangle", L, { half: 0.05, frac: 0.5 }, 5, 3);
  assert.equal(held.running, false);
  assert.equal(held.slope, 0);
  assert.equal(held.value, 2.5);
  assert.equal(waveGenerator("triangle", L, timing, 5, 0.06).running, false);
});

test("a trapezoid: flat 30 %, up 20 %, flat 30 %, down 20 %", () => {
  assert.equal(TRAPEZOID_RAMP, 0.2);
  assert.equal(waveVolts("trapezoid", 0, 5), 0);
  assert.equal(waveVolts("trapezoid", 0.29, 5), 0);
  near(waveVolts("trapezoid", 0.4, 5), 2.5, 1e-12, "half way up");
  assert.equal(waveVolts("trapezoid", 0.5, 5), 5, "at the top by the L→H edge");
  assert.equal(waveVolts("trapezoid", 0.79, 5), 5);
  near(waveVolts("trapezoid", 0.9, 5), 2.5, 1e-12, "half way down");
  near(waveVolts("trapezoid", 0.99999, 5), 0, 1e-3, "at 0 V by the H→L edge");
  // Its pieces: each half flat to the foot of its ramp (60 % in), then the
  // ramp to the edge — 5 V over 20 ms at 10 Hz.
  const timing = { half: 0.05, since: 0 };
  const flat = waveGenerator("trapezoid", L, timing, 5, 0.01);
  assert.equal(flat.slope, 0);
  assert.equal(flat.value, 0);
  near(flat.end, 0.03, 1e-15, "the flat ends at the ramp's foot");
  const up = waveGenerator("trapezoid", L, timing, 5, flat.end);
  near(up.slope, 250, 1e-9, "up 250 V/s");
  assert.equal(up.end, 0.05);
  const top = waveGenerator("trapezoid", H, timing, 5, 0.01);
  assert.equal(top.slope, 0);
  assert.equal(top.value, 5);
  near(waveGenerator("trapezoid", H, timing, 5, 0.04).slope, -250, 1e-9, "down"); // prettier-ignore
  // Held, it stands still.
  const held = waveGenerator("trapezoid", L, { half: 0.05, frac: 0.8 }, 5, 3);
  assert.equal(held.running, false);
  assert.equal(held.slope, 0);
  near(held.value, 2.5, 1e-12, "held half way up");
});

test("a Schmitt input on a trapezoid switches on its ramps, mid-half", () => {
  // A CD40106B on a 10 Hz trapezoid: it rises 250 V/s from 30 ms and falls
  // from 80 ms — corners that are not edges, each ending the wave's piece.
  const b = clockDesk({ wave: "trapezoid", hz: 10 });
  const u = b.seat("u1", "CD40106B", "e50");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.link(u.get(1), "d5");
  const { upV, downV } = partDef("CD40106B").schmitt;
  const flips = [];
  let was = null;
  run(b.doc, {
    hz: 10,
    until: 0.1,
    sample(now, r, nl) {
      const y = r.netLevels.get(nl.netOfPoint.get(b.at(u.get(2))));
      if (was != null && y !== was) flips.push([now, y]);
      was = y;
    },
  });
  assert.equal(flips.length, 2);
  assert.equal(flips[0][1], L);
  near(flips[0][0], 0.03 + upV / 250, 1e-9, "the rising crossing");
  assert.equal(flips[1][1], H);
  near(flips[1][0], 0.08 + (5 - downV) / 250, 1e-9, "the falling crossing");
});

test("a trapezoid through an RC, exactly, piece by piece", () => {
  // τ = 10 ms. Each piece of input a + s·t takes the capacitor from v0 to
  // a + s·(d − τ) + (v0 − a + s·τ)·e^(−d/τ) over its d.
  const b = clockDesk({ wave: "trapezoid", hz: 10 });
  lowPass(b);
  const at = new Map();
  run(b.doc, {
    hz: 10,
    until: 0.3,
    sample(now, r, nl) {
      at.set(Math.round(now * 1e4), r.nodeVolts.get(nl.netOfPoint.get(b.at("a20")))); // prettier-ignore
    },
  });
  const tau = 0.01;
  const pieces = [
    [0.03, 0, 0],
    [0.02, 0, 250],
    [0.03, 5, 0],
    [0.02, 5, -250],
  ];
  let v = 0;
  const want = new Map([[0, 0]]);
  let t = 0;
  for (let k = 0; k < 3; k++) {
    for (const [d, a, s] of pieces) {
      v = a + s * (d - tau) + (v - a + s * tau) * Math.exp(-d / tau);
      t += d;
      want.set(Math.round(t * 1e4), v);
    }
  }
  for (const ms of [500, 1000, 1500, 2000, 2500, 3000]) {
    near(at.get(ms), want.get(ms), 2e-4, `at ${ms / 10} ms`);
  }
});

test("under Spice Lite a PWM is a level, never a wave", () => {
  const b = clockDesk({ wave: "pwm", hz: 10 });
  const seen = [];
  run(b.doc, {
    hz: 10,
    until: 0.2,
    sample(now, r, nl) {
      const net = nl.netOfPoint.get("clk1.out");
      seen.push([r.netLevels.get(net), r.nodeVolts.get(net)]);
    },
  });
  assert.deepEqual(
    seen.map(([lv]) => lv),
    [L, H, L, H, L],
  );
  for (const [lv, v] of seen) {
    if (lv === H) assert.ok(v > 4.9, `HIGH at ${v} V`);
    else assert.ok(v < 0.1, `LOW at ${v} V`);
  }
});

test("a triangle through an RC lags it by slope·τ, exactly", () => {
  // 10 Hz, 0 → 5 V: 100 V/s each way through τ = 10 ms. Its steady state
  // swings between V0 = 2/(1 + e^−5) − 1 and 5 − V0, at the corners.
  const b = clockDesk({ wave: "triangle", hz: 10 });
  lowPass(b);
  const at = new Map();
  run(b.doc, {
    hz: 10,
    until: 0.3,
    sample(now, r, nl) {
      at.set(Math.round(now * 1e4), r.nodeVolts.get(nl.netOfPoint.get(b.at("a20")))); // prettier-ignore
    },
  });
  const v0 = 2 / (1 + Math.exp(-5)) - 1;
  near(at.get(2000), v0, 2e-4, "trough at 200 ms");
  near(at.get(2500), 5 - v0, 2e-4, "peak at 250 ms");
});

test("a sine through an RC: the low-pass's gain and phase", () => {
  // 10 Hz, ωτ = 0.2π: gain 1/√(1 + (ωτ)²), lag atan(ωτ). At a peak of the
  // input (ωt = 3π) the output stands at mid + A·gain·cos(lag).
  const b = clockDesk({ wave: "sine", hz: 10 });
  lowPass(b);
  const at = new Map();
  run(b.doc, {
    hz: 10,
    until: 0.35,
    sample(now, r, nl) {
      at.set(Math.round(now * 1e4), r.nodeVolts.get(nl.netOfPoint.get(b.at("a20")))); // prettier-ignore
    },
  });
  const wt = 2 * Math.PI * 10 * 0.01;
  const gain = 1 / Math.sqrt(1 + wt * wt);
  const want = (t) => 2.5 - 2.5 * gain * Math.cos(2 * Math.PI * 10 * t - Math.atan(wt)); // prettier-ignore
  near(at.get(2500), want(0.25), 2e-3, "at the 250 ms peak");
  near(at.get(3000), want(0.3), 2e-3, "at the 300 ms trough");
});

test("a sawtooth's drop steps a capacitor's far plate, its rise does not", () => {
  // A high-pass: clock — 1 µF — node — 10 kΩ — ground. The ramp-up climbs
  // 50 V/s, so the node settles towards slope·τ = 0.5 V; at the HIGH → LOW edge
  // the wave falls 5 V at once, and so does the node.
  const b = clockDesk({ wave: "ramp-up", hz: 10 });
  const c = b.seat("c2", "cap-ceramic", "b5", { farads: 1e-6 });
  const r = b.seat("r2", "resistor", "a40", { ohms: 10000 });
  b.link(c.get(2), r.get(1));
  b.gnd(r.get(2));
  const node = [];
  run(b.doc, {
    hz: 10,
    until: 0.11,
    sample(now, res, nl) {
      node.push([now, res.nodeVolts.get(nl.netOfPoint.get(b.at("a40")))]);
    },
  });
  const before = node.filter(([t]) => t < 0.1).at(-1)[1];
  const at = node.find(([t]) => t >= 0.1)[1];
  near(before, 0.5 * (1 - Math.exp(-10)), 1e-3, "risen towards slope·τ");
  near(at - before, -5, 1e-3, "the drop carried through");
});

test("a Schmitt input switches where the wave crosses its thresholds", () => {
  // A CD40106B on a 10 Hz triangle: up at VT+ while it rises (100 V/s from
  // 0), down at VT− while it falls from the 50 ms peak.
  const b = clockDesk({ wave: "triangle", hz: 10 });
  const u = b.seat("u1", "CD40106B", "e50");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.link(u.get(1), "d5");
  const { upV, downV } = partDef("CD40106B").schmitt;
  const flips = [];
  let was = null;
  run(b.doc, {
    hz: 10,
    until: 0.1,
    sample(now, r, nl) {
      const y = r.netLevels.get(nl.netOfPoint.get(b.at(u.get(2))));
      if (was != null && y !== was) flips.push([now, y]);
      was = y;
    },
  });
  assert.equal(flips.length, 2);
  assert.equal(flips[0][1], L);
  near(flips[0][0], upV / 100, 1e-9, "the rising crossing");
  assert.equal(flips[1][1], H);
  near(flips[1][0], 0.05 + (5 - downV) / 100, 1e-9, "the falling crossing");
});

test("a clock held by its own pause holds its wave, and its RC arrives", () => {
  const b = clockDesk({ wave: "triangle", hz: 10 });
  lowPass(b);
  const { results, netlist } = run(b.doc, { hz: 10, until: 0.2, held: 0.6 });
  const last = results.at(-1).r;
  near(last.nodeVolts.get(netlist.netOfPoint.get("clk1.out")), 3, 1e-12, "held at 60 % of the LOW half's rise"); // prettier-ignore
  near(last.nodeVolts.get(netlist.netOfPoint.get(b.at("a20"))), 3, 0.05, "the RC on its way"); // prettier-ignore
  // Nothing runs, so the desk stops asking to be redrawn once it has arrived.
  const done = run(b.doc, { hz: 10, until: 2, held: 0.6 }).results.at(-1).r;
  assert.equal(done.wakeAt, null);
  assert.equal(done.frameAt, null);
});

test("a running wave asks for frames enough to be drawn — frames, not wakes", () => {
  const b = clockDesk({ wave: "sine", hz: 2 });
  const { results } = run(b.doc, { hz: 2, until: 0.2 });
  const { now, r } = results[0];
  near(r.frameAt - now, 0.5 / 16, 1e-12, "a sixteenth of its period");
  assert.ok(r.wakeAt == null || r.wakeAt > r.frameAt, "a frame wakes nothing");
});

test("the incremental settle and the full one agree on every wave", () => {
  for (const wave of [
    "triangle",
    "trapezoid",
    "sine",
    "ramp-up",
    "ramp-down",
  ]) {
    const b = clockDesk({ wave, hz: 10 });
    lowPass(b);
    const u = b.seat("u1", "CD40106B", "e50");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    b.link(u.get(1), "d5");
    const a = run(b.doc, { hz: 10, until: 0.15 }).results;
    const f = run(b.doc, { hz: 10, until: 0.15, mode: "full" }).results;
    assert.equal(a.length, f.length, wave);
    for (let i = 0; i < a.length; i++) {
      assert.deepEqual(a[i].r.nodeVolts, f[i].r.nodeVolts, `${wave} @${a[i].now}`); // prettier-ignore
      assert.deepEqual(a[i].r.netLevels, f[i].r.netLevels, `${wave} @${a[i].now}`); // prettier-ignore
    }
  }
});

test("the digital engine runs every clock square, whatever its wave", () => {
  const b = clockDesk({ wave: "sine", hz: 10 });
  const levels = [];
  run(b.doc, {
    hz: 10,
    until: 0.2,
    engine: "digital",
    sample(now, r, nl) {
      levels.push(r.netLevels.get(nl.netOfPoint.get("clk1.out")));
    },
  });
  assert.deepEqual(levels, [L, H, L, H, L]);
});

test("a schedule resuming part-way through a half keeps its place", () => {
  const s = new EdgeSchedule();
  s.set("a", 0.5, 10, 0.2);
  assert.equal(s.next().at, 10.3);
  s.set("b", 0.5, 10);
  assert.equal(s.next(null).at, 10.3);
});

test("a wave's SHAPE changed mid-run steps the capacitor it feeds by the gap", () => {
  // A 10 Hz triangle into a 1 µF / 1 MΩ high-pass, switched to a falling
  // sawtooth at 26 ms: the source jumps 2.60 → 3.70 V, and the node after
  // the capacitor jumps with it (the jump used to be read with the NEW shape
  // on both sides — zero).
  const build = (wave) => {
    const b = bench();
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: { hz: 10, wave } }); // prettier-ignore
    b.doc.wires.push(
      { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
      { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
      { id: "wc3", from: "clk1.out", to: b.at("a5"), color: "blue" },
    );
    const c = b.seat("c1", "cap-ceramic", "a20", { farads: 1e-6 });
    b.link(c.get(1), "b5");
    const r = b.seat("r1", "resistor", "a40", { ohms: 1e6 });
    b.link(r.get(1), c.get(2));
    b.gnd(r.get(2));
    return { doc: b.doc, node: b.at(c.get(2)) };
  };
  const a = build("triangle");
  const z = build("ramp-down");
  const T = 0.026;
  const seen = new Map();
  driveSpice(a.doc, {
    seconds: 0.03,
    end: true,
    at: [T - 1e-7, T],
    edits: [{ at: T, doc: z.doc }],
    onTick(now, res, input) {
      const at = (p) => res.nodeVolts.get(input.netlist.netOfPoint.get(p));
      seen.set(now, { wave: at("clk1.out"), hp: at(a.node) });
    },
  });
  const pre = seen.get(T - 1e-7);
  const post = seen.get(T);
  const waveJump = post.wave - pre.wave;
  assert.ok(waveJump > 1, `the source jumped (${waveJump})`);
  assert.ok(Math.abs(post.hp - pre.hp - waveJump) < 0.05, `the node followed: ${pre.hp} → ${post.hp}`); // prettier-ignore
});

test("the Spice bench driver runs a PWM clock at its pulse width, as the app does", () => {
  const b = bench();
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: { hz: 100, wave: "pwm", duty: 25 } }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
  );
  const edges = [];
  driveSpice(b.doc, {
    seconds: 0.03,
    onTick(now, _res, input) {
      const level = input.clockPhase.get("clk1");
      if (edges.at(-1)?.level !== level) edges.push({ now, level });
    },
  });
  const highs = [];
  for (let i = 1; i < edges.length; i++) {
    if (edges[i - 1].level === H) highs.push(edges[i].now - edges[i - 1].now);
  }
  assert.ok(highs.length >= 2);
  for (const h of highs) assert.ok(Math.abs(h - 0.0025) < 1e-9, `HIGH for ${h} s`); // prettier-ignore
});
