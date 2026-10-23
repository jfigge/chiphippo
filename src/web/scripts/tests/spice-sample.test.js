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

// The analog side between ticks (spice/sample.js, features/01-display-wakes.md):
// what `sampleAnalog` reads off a tick's carried state at a moment before the
// next tick is what the engine itself says when it IS ticked there. Each
// fixture is run as SimController runs it; at 200 random moments between two
// of its ticks the engine is made to tick there too (from the earlier tick's
// state — a replay, nothing carried on), and every node it reports is held to
// the sample at the moment that tick left them at, to a nanovolt.

import test from "node:test";
import assert from "node:assert/strict";
import { ENGINES } from "../sim/engines.js";
import { FAST_WINDOW_S } from "../sim/spice/engine.js";
import {
  cycleTemplates,
  sampleAnalog,
  nextDisplayFrame,
  scopeSamples,
  walkingFrame,
} from "../sim/spice/sample.js";
import { valueAt } from "../sim/spice/rc-curve.js";
import { driveSpice } from "../bench/drive-spice.js";
import { astable555, bench } from "./timing-fixtures.js";
import { GOLDEN_CASES } from "./spice-golden-cases.js";
import { partDef } from "../catalog/index.js";

/** A small deterministic generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A clock putting out `wave` at `hz` into an RC low-pass — or, with
    `coil`, into a series R–L to ground. */
function waveRc(wave, hz, { coil = false } = {}) {
  const b = bench();
  const r = b.seat("r1", "resistor", "a10", { ohms: coil ? 100 : 1e3 });
  const c = coil
    ? b.seat("l1", "inductor", "a20", { henries: 0.1 })
    : b.seat("c1", "cap-ceramic", "a20", { farads: 1e-6 });
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz, wave }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at(r.get(1).replace(/^a/, "c")), color: "blue" }, // prettier-ignore
  );
  return b.doc;
}

const golden = (id) => GOLDEN_CASES.find((c) => c.id === id).build().doc;

const FIXTURES = [
  { name: "a 555 astable (single curves)", doc: astable555({ ra: 1e3, rb: 10e3, c: 1e-6 }).doc, seconds: 0.1 }, // prettier-ignore
  { name: "a two-gate CD4069UB oscillator (a coupled group)", doc: golden("two-gate-cd4069ub"), seconds: 0.5 }, // prettier-ignore
  { name: "a square into a series RL (a coil's current)", doc: waveRc("square", 100, { coil: true }), seconds: 0.05 }, // prettier-ignore
  { name: "a sine into an RC (a running wave)", doc: waveRc("sine", 50), seconds: 0.1 }, // prettier-ignore
  { name: "a triangle into an RC (a running wave)", doc: waveRc("triangle", 20), seconds: 0.2 }, // prettier-ignore
  { name: "a fast 555 (a drawn cycle)", doc: astable555({ ra: 1e3, rb: 10e3, c: 10e-9 }).doc, seconds: 0.02 }, // prettier-ignore
];

const SAMPLES = 200;

for (const f of FIXTURES) {
  test(`sampleAnalog reads what a tick there reports — ${f.name}`, () => {
    const ticks = [];
    driveSpice(f.doc, {
      seconds: f.seconds,
      onTick: (now, result, input) => {
        ticks.push({ now, result, input: { ...input, clockPhase: new Map(input.clockPhase) } }); // prettier-ignore
      },
    });
    assert.ok(ticks.length > 2, "the fixture ticks");
    const random = rng(0x5eed);
    let compared = 0;
    let worst = 0;
    let worstAmps = 0;
    for (let n = 0; n < SAMPLES; n++) {
      // A moment strictly between two ticks, before the earlier one's wake
      // (the transport may tick later than that: MIN_SHOWN_S) by more than
      // the fast window (a tick there runs on into a crossing that close).
      const k = Math.floor(random() * (ticks.length - 1));
      const { result: prev, input } = ticks[k];
      const after = Math.min(ticks[k + 1].now, (prev.wakeAt ?? Infinity) - 2 * FAST_WINDOW_S); // prettier-ignore
      const from = prev.analog.time;
      if (!(after > from)) continue;
      const at = from + random() * (after - from);
      const forced = ENGINES.spice.tick({ ...input, warmStart: prev.netLevels, state: prev.state, prevPinLevels: prev.pinLevels, now: at, spice: { ...input.spice, analog: prev.analog } }); // prettier-ignore
      // A drawn cycle stands where its schedule has it at the tick's own
      // moment; a curve where the tick's settles left it.
      const when = prev.analog.cycle ? at : forced.analog.time;
      const { volts, coils } = sampleAnalog(prev.analog, when);
      // A node on its own curve agrees to a nanovolt. A tick re-anchors a
      // coupled group where it stands (its common mode balanced to
      // BALANCE_V, its slopes read numerically), so beside it a group's
      // node is allowed two nanovolts and one more per volt it stands at, and a coil's
      // current a millionth of itself: the tick's own re-linearizing, not the
      // sample's (which reads one curve exactly).
      for (const [net, v] of volts) {
        const engine = forced.nodeVolts.get(net);
        if (engine == null) continue;
        const coupled = prev.analog.nodes.get(net)?.curve?.kind != null;
        const bar = coupled ? 1e-9 * (2 + Math.abs(v)) : 1e-9;
        worst = Math.max(worst, Math.abs(engine - v) / bar);
        compared++;
      }
      for (const [id, amps] of coils) {
        const engine = forced.analog.coilAmps.get(id);
        if (engine == null) continue;
        worstAmps = Math.max(worstAmps, Math.abs(engine - amps) / Math.max(1e-6 * Math.abs(amps), 1e-15)); // prettier-ignore
        compared++;
      }
    }
    assert.ok(compared >= SAMPLES / 2, `compared ${compared} node readings`);
    assert.ok(worst <= 1, `worst node disagreement ${worst}× its bar`);
    assert.ok(worstAmps <= 1, `worst coil disagreement ${worstAmps}× its bar`);
  });
}

test("nextDisplayFrame: a node on its way, until it arrives; a wave by its period", () => {
  const moving = { t0: 0, v0: 0, vInf: 5, tau: 1e-3 };
  const nodes = new Map([["n1", { driven: null, curve: moving }]]);
  const at = nextDisplayFrame({ nodes }, 1, 0.001, { gapPercent: 1 });
  assert.equal(at, 1 + 1 / 30);
  assert.equal(nextDisplayFrame({ nodes }, 1, 0.1, { gapPercent: 1 }), null, "arrived"); // prettier-ignore
  assert.equal(nextDisplayFrame({ nodes, chatter: { at: 0, backoff: 1 } }, 1, 0.001, { gapPercent: 1 }), null, "never while chattering"); // prettier-ignore
  const wave = {
    nodes: new Map([["w", { driven: null, curve: { t0: 0, v0: 0, vInf: 0, tau: Infinity, rate: 10 } }]]), // prettier-ignore
    waves: new Map([["w", "clk1"]]),
    inputs: { clockTimes: new Map([["clk1", { half: 0.25, since: 0 }]]) },
  };
  assert.equal(nextDisplayFrame(wave, 0, 0, { gapPercent: 1 }), 0.5 / 16);
  // Unrecorded, an odd number of sixteenths of its period (here one), on a
  // lattice from the run's start (`walkingFrame`).
  assert.equal(nextDisplayFrame(wave, 0, 0, { gapPercent: 1, waveFrames: false }), 0.5 / 16); // prettier-ignore
});

test("an unrecorded wave's frames walk its phases — a 60 Hz one is never read at one moment of it", () => {
  // Redrawn every 1/30 s — two periods of 60 Hz — an LED on a 60 Hz adapter
  // was read at the zero crossing every frame: dark, cool, unwarned (the
  // regrade, 2026-10-23). Five sixteenths apart, on a lattice from the
  // run's start, so a wake between two leaves them walking.
  const ac = {
    nodes: new Map([["w", { driven: null, curve: { t0: 0, v0: 0, vInf: 0, tau: Infinity, rate: 10 } }]]), // prettier-ignore
    waves: new Map([["w", "ac1"]]),
    waveKinds: new Map([["w", { ac: true, hz: 60 }]]),
  };
  const frame = 5 / 16 / 60;
  assert.ok(Math.abs(walkingFrame(1 / 60) - frame) < 1e-15);
  const phases = new Set();
  let t = 0;
  for (let k = 0; k < 16; k++) {
    t = nextDisplayFrame(ac, t, t, { gapPercent: 1, waveFrames: false });
    phases.add(Math.round(((t * 60) % 1) * 16) % 16);
  }
  assert.equal(phases.size, 16, "every sixteenth of the period");
  // A wake between two frames (at 0.011 s) leaves the next on the lattice.
  const next = nextDisplayFrame(ac, 0.011, 0.011, { gapPercent: 1, waveFrames: false }); // prettier-ignore
  assert.ok(Math.abs(next - 3 * frame) < 1e-12, `${next}`);
  // 50 Hz, 5 sixteenths too (6.25 ms); a 1 kHz wave 65 (4.06 ms); a slow
  // one a sixteenth, no further apart than ANALOG_FRAME_S.
  assert.ok(Math.abs(walkingFrame(1 / 50) - 5 / 16 / 50) < 1e-15);
  assert.ok(Math.abs(walkingFrame(1e-3) - 65 / 16e3) < 1e-15);
  assert.equal(walkingFrame(0.5), 0.5 / 16);
  assert.equal(walkingFrame(10), 1 / 30);
});

test("scopeSamples: the analyzer's chords between two ticks lie on the curve", () => {
  // 1 ms RC charging to 5 V after a clock edge, the next tick 50 ms on: read
  // at the display frames it was a 33 ms ramp, off by up to 4.3 V.
  const curve = { t0: 0, v0: 0, vInf: 5, tau: 1e-3 };
  const analog = { nodes: new Map([["n1", { driven: null, curve }]]) };
  const tolerance = 0.01;
  const samples = scopeSamples(analog, ["n1"], 0, 0.05, { tolerance });
  assert.equal(samples.at(-1).at, 0.05, "the stretch's end is a sample");
  assert.ok(samples.length > 10 && samples.length < 200, `${samples.length} samples`); // prettier-ignore
  const pts = [{ at: 0, v: 0 }, ...samples.map((x) => ({ at: x.at, v: x.volts.get("n1") }))]; // prettier-ignore
  let worst = 0;
  for (let i = 1; i < pts.length; i++) {
    for (let k = 1; k < 16; k++) {
      const t = pts[i - 1].at + ((pts[i].at - pts[i - 1].at) * k) / 16;
      const drawn = pts[i - 1].v + ((pts[i].v - pts[i - 1].v) * k) / 16;
      worst = Math.max(worst, Math.abs(drawn - valueAt(curve, t)));
    }
  }
  assert.ok(worst <= 2 * tolerance, `worst ${worst} V off the curve`);
  for (const x of samples) assert.equal(x.volts.get("n1"), valueAt(curve, x.at)); // prettier-ignore
});

test("scopeSamples: a node at rest, or a desk chattering, adds nothing", () => {
  const rest = { nodes: new Map([["n1", { driven: null, curve: { t0: 0, v0: 5, vInf: 5, tau: 1e-3 } }]]) }; // prettier-ignore
  assert.deepEqual(scopeSamples(rest, ["n1"], 0, 1, { tolerance: 0.01 }), []);
  const moving = { nodes: new Map([["n1", { driven: null, curve: { t0: 0, v0: 0, vInf: 5, tau: 1e-3 } }]]) }; // prettier-ignore
  assert.deepEqual(scopeSamples({ ...moving, chatter: { at: 0, backoff: 1 } }, ["n1"], 0, 1, { tolerance: 0.01 }), []); // prettier-ignore
  assert.deepEqual(scopeSamples(moving, ["other"], 0, 1, { tolerance: 0.01 }), [], "not one of its nets"); // prettier-ignore
  assert.deepEqual(scopeSamples(moving, ["n1"], 1, 1, { tolerance: 0.01 }), [], "no stretch"); // prettier-ignore
});

test("scopeSamples: a wave is looked at an eighth of its period at a time, so a whole period is no flat chord", () => {
  // A triangle clock 0 → 5 V over a 10 ms half: two stretches of exactly a
  // period each would read as one flat line at its ends.
  const rising = { t0: 0, v0: 0, vInf: 0, tau: Infinity, rate: 500 };
  const analog = {
    nodes: new Map([["w", { driven: null, curve: rising }]]),
    waves: new Map([["w", "clk1"]]),
    inputs: { clockTimes: new Map([["clk1", { half: 0.01, since: 0 }]]) },
  };
  const samples = scopeSamples(analog, ["w"], 0, 0.01, { tolerance: 0.01 });
  // A straight ramp needs no bisection: the eighths of its 20 ms period.
  assert.deepEqual(samples.map((x) => Math.round(x.at * 1e4)), [25, 50, 75, 100]); // prettier-ignore
});

test("cycleTemplates: one TRUE cycle of a drawn cycle, its nodes on their curves, every other net stepping at its segments", () => {
  // Two segments of 100 µs: a node charging (τ 50 µs), then discharging;
  // an output HIGH, then LOW. Each segment's curves on its own clock (`t`).
  const up = { t0: 1, v0: 1, vInf: 5, tau: 50e-6 };
  const down = { t0: 2, v0: 3, vInf: 0, tau: 50e-6 };
  const cycle = {
    period: 200e-6,
    segs: [
      { at: 0, t: 1, nodes: new Map([["n", { driven: null, curve: up }]]), probe: new Map([["n", { level: "X" }], ["out", { level: "H", volts: 3.6 }]]) }, // prettier-ignore
      { at: 100e-6, t: 2, nodes: new Map([["n", { driven: null, curve: down }]]), probe: new Map([["n", { level: "X" }], ["out", { level: "L", volts: 0.2 }]]) }, // prettier-ignore
    ],
  };
  const tolerance = 0.01;
  const t = cycleTemplates(cycle, ["n", "out", "missing"], { tolerance });
  assert.equal(t.has("missing"), false, "a net no moment recorded has none");
  assert.deepEqual(
    t.get("out").map((p) => [p.u, p.cell, p.volts, p.curve]),
    [
      [0, "H", 3.6, false],
      [100e-6, "L", 0.2, false],
    ],
  );
  const n = t.get("n");
  assert.equal(n[0].curve, false, "a segment begins with a step");
  assert.equal(n.at(-1).u, 200e-6, "and the cycle ends at its period");
  for (const p of n) {
    const want = p.u < 100e-6 || (p.u === 100e-6 && p.curve) ? valueAt(up, 1 + p.u) : valueAt(down, 2 + p.u - 100e-6); // prettier-ignore
    assert.ok(Math.abs(p.volts - want) < 1e-9, `on the curve at ${p.u}`);
  }
  for (let i = 1; i < n.length; i++) {
    if (!n[i].curve) continue;
    const mid = (n[i - 1].u + n[i].u) / 2;
    const seg = mid < 100e-6 ? [up, 1] : [down, 2 - 100e-6];
    const chord = (n[i - 1].volts + n[i].volts) / 2;
    assert.ok(Math.abs(chord - valueAt(seg[0], seg[1] + mid)) <= tolerance, `the chord at ${mid}`); // prettier-ignore
  }
});
