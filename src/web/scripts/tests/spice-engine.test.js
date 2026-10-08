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

// spice-engine.test.js — Spice Lite in circuit (sim/spice/engine.js,
// features/done/spice-lite.md §3–§4), on fixtures built in code like every engine
// suite: an RC node charging toward a gate's threshold, listeners with
// different thresholds, a node that never gets there, a ring oscillator, a
// Schmitt-trigger RC oscillator (and a late tick replaying it), a capacitor
// keeping its charge through a switch, a capacitor wired to nothing, and a
// mixed-family desk. The timing parts as their silicon are
// tests/spice-silicon.test.js's.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import {
  ANALOG_FRAME_S,
  CHATTER_MEMORY_S,
  MAX_ANALOG_EVENTS,
  MAX_CAPPED_BACKOFF_S,
  MAX_CATCHUP_EVENTS,
  MAX_HOLD,
  capacitorNets,
} from "../sim/spice/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { valueAt } from "../sim/spice/rc-curve.js";
import { MIN_SHOWN_S } from "../sim/timing.js";
import { ENGINES } from "../sim/engines.js";
import { inputStages, inputThresholds } from "../sim/spice/params.js";
import {
  outputStage,
  stageCurrent,
  stageKinks,
} from "../sim/spice/output-stage.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";
import { partDef } from "../catalog/index.js";
import { bench, runner } from "./timing-fixtures.js";

const spice = (doc, config) => runner(doc, { engine: "spice", spice: config });

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

/** A powered inverter package at `anchor`: pin → hole. */
function inverter(b, id, ref, anchor) {
  const u = b.seat(id, ref, anchor);
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  return u;
}

/** R from VCC (or GND) into a node, C from the node to GND, feeding
    inverter input 1A (pin 1). Returns the bench, the inverter and the
    node's hole. */
function rcInto(ref = "74LS04", { r = 10e3, c = 10e-6, pull = "vcc" } = {}) {
  const b = bench();
  const u = inverter(b, "u1", ref, "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(1));
  (pull === "vcc" ? b.vcc : b.gnd)(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  return { b, u, node: u.get(1) };
}

const TTL_TRIGGER = inputThresholds(normalizeSpiceConfig(null), partDef("74LS04"), 5).up; // prettier-ignore
// A CD4000 input draws nothing, so an RC into one charges at exactly R·C: the
// fixture the curve's own arithmetic is proved on.
const CMOS_TRIGGER = inputThresholds(normalizeSpiceConfig(null), partDef("CD4069UB"), 5).up; // prettier-ignore

/** Run a tick at each wake until the next one is at or past `until`;
    returns the last result. */
function runTo(sim, r, until) {
  for (
    let i = 0;
    i < 1000 && r.wakeAt != null && r.wakeAt < until * (1 - 1e-6);
    i++
  ) {
    r = sim.run(r.wakeAt).result;
  }
  return r;
}

/** A powered 74LS input's stage (spice/params.js TTL_INPUT): a constant
    current OUT of its pin below its 0.9 V knee, falling to none at 1.3 V. */
const [TTL_BIAS] = inputStages(partDef("74LS04"), 5);
const TTL_KNEE = TTL_BIAS.volts - TTL_BIAS.limit * TTL_BIAS.ohms;

/**
 * An RC node (conductance `g0` to a source pushing `i0` in, capacitance `c`)
 * charging from 0 V with a 74LS input on it: the time it reaches `v`, through
 * the input's knee and its 1.3 V — each segment a plain exponential.
 */
function ttlRc({ g0, i0, c }) {
  const segments = [
    { to: TTL_KNEE, g: g0, i: i0 + TTL_BIAS.limit },
    { to: TTL_BIAS.volts, g: g0 + 1 / TTL_BIAS.ohms, i: i0 + TTL_BIAS.volts / TTL_BIAS.ohms }, // prettier-ignore
    { to: Infinity, g: g0, i: i0 },
  ];
  return {
    at(v) {
      let t = 0;
      let from = 0;
      for (const seg of segments) {
        const vInf = seg.i / seg.g;
        const end = Math.min(v, seg.to);
        t += (c / seg.g) * Math.log((vInf - from) / (vInf - end));
        if (v <= seg.to) return t;
        from = seg.to;
      }
      return t;
    },
    /** Where it settles. */
    rest() {
      for (const seg of segments) {
        const v = seg.i / seg.g;
        if (v <= seg.to) return v;
      }
      return i0 / g0;
    },
  };
}

test("an RC node charges, and the gate flips when it crosses the threshold", () => {
  // 1 µF, so the crossing comes before the first display frame.
  const { b, u } = rcInto("CD4069UB", { c: 1e-6 });
  const tau = 10e3 * 1e-6;
  const crossing = tau * Math.log(5 / (5 - CMOS_TRIGGER));
  assert.equal(TTL_TRIGGER, 1.4, "74LS: halfway between VIL 0.8 and VIH 2");
  assert.equal(CMOS_TRIGGER, 2.5, "CD4000 at 5 V: between VIL 1.5 and VIH 3.5");

  // The digital engine has no time: the pull-up wins at once.
  assert.equal(runner(b.doc).run(0).level(u.get(2)), L);

  const sim = spice(b.doc);
  const first = sim.run(0);
  assert.equal(first.level(u.get(2)), H, "an empty capacitor reads LOW");
  const nodeNet = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  // The curve is anchored when the first settle ends — a few gate delays
  // after Run (125 ns each, here), so a fraction of a millivolt.
  assert.ok(first.result.nodeVolts.get(nodeNet) < 1e-3);
  close(
    first.result.wakeAt,
    crossing,
    1e-4,
    "it asks to be woken AT the crossing",
  );

  const flipped = sim.run(first.result.wakeAt);
  assert.equal(
    flipped.level(u.get(2)),
    L,
    "past the threshold, the input reads HIGH",
  );
  close(
    flipped.result.nodeVolts.get(nodeNet),
    CMOS_TRIGGER,
    1e-4,
    "the node is at the trigger point (a few gate delays on)",
  );
  assert.equal(flipped.result.netLevels.get(nodeNet), H);
});

test("a crossing fires once: a node still climbing past it makes no more events", () => {
  const { b, u } = rcInto("CD4069UB", { c: 1e-6 });
  const sim = spice(b.doc);
  let at = sim.run(0).result.wakeAt;
  sim.run(at);
  // The node keeps rising (never frozen), but nothing listens past 2.5 V, so
  // the only wakes left are display frames, until it is within 1 % of 5 V.
  const nodeNet = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  let last = 0;
  for (let i = 0; i < 400; i++) {
    const r = sim.run(at).result;
    assert.equal(sim.level(u.get(2)), L);
    assert.ok(!r.warnings.some((w) => w.type === "oscillation"));
    const v = r.nodeVolts.get(nodeNet);
    assert.ok(v >= last, "monotonic");
    last = v;
    if (r.wakeAt == null) break;
    close(r.wakeAt - at, ANALOG_FRAME_S, 1e-6, "a display frame");
    at = r.wakeAt;
  }
  assert.ok(sim.result.wakeAt == null, "it stops asking once it has arrived");
  assert.ok(Math.abs(5 - last) <= 0.05 + 1e-9, `within 1 % of 5 V: ${last}`);
});

test("listeners with different thresholds each switch at their own crossing", () => {
  const b = bench();
  const ls = inverter(b, "u1", "74LS04", "e10");
  const cmos = inverter(b, "u2", "CD4069UB", "e20");
  const res = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.link(res.get(1), ls.get(1));
  b.vcc(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: 10e-6 });
  b.link(cap.get(1), ls.get(1));
  b.gnd(cap.get(2));
  b.link(ls.get(1), cmos.get(1));

  // Below 1.3 V the 74LS input pushes its own current into the node too —
  // flat to its 0.9 V knee, then falling — so the first stretches run faster
  // than R·C, a corner at each, and from 1.3 V at R·C toward 5 V.
  const rc = ttlRc({ g0: 1 / 10e3, i0: 5 / 10e3, c: 10e-6 });
  const tLs = rc.at(1.4);
  const tCmos = rc.at(2.5); // VIL 1.5 / VIH 3.5 at 5 V
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  close(r.wakeAt, rc.at(TTL_KNEE), 1e-5, "woken at the knee, to run on from there"); // prettier-ignore
  r = sim.run(r.wakeAt).result;
  close(r.wakeAt, rc.at(TTL_BIAS.volts), 1e-5, "and at the input's 1.3 V");
  r = sim.run(r.wakeAt).result;
  close(r.wakeAt, tLs, 1e-5, "the 74LS crossing first");
  r = sim.run(r.wakeAt).result;
  assert.equal(sim.level(ls.get(2)), L);
  assert.equal(sim.level(cmos.get(2)), H, "the CMOS input has not crossed yet");
  const nodeNet = sim.netlist.netOfPoint.get(b.at(ls.get(1)));
  assert.equal(
    r.netLevels.get(nodeNet),
    "X",
    "they disagree, so the net says so",
  );
  // Frames until the CMOS crossing, which is woken for exactly.
  let at = r.wakeAt;
  while (at < tCmos * (1 - 1e-5)) at = sim.run(at).result.wakeAt;
  close(at, tCmos, 1e-5, "the CMOS crossing");
  sim.run(at);
  assert.equal(sim.level(cmos.get(2)), L);
  assert.equal(sim.result.netLevels.get(nodeNet), H);
});

test("a node whose asymptote is short of the threshold is released, never waited for", () => {
  // 10k to VCC, 2.2k to GND: it settles at 0.90 V, under the CD4069UB's 2.5 V.
  const { b, u } = rcInto("CD4069UB");
  const down = b.seat("r2", "resistor", "a50", { ohms: 2.2e3 });
  b.link(down.get(1), u.get(1));
  b.gnd(down.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  let at = 0;
  for (let i = 0; i < 100 && r.wakeAt != null; i++) {
    close(r.wakeAt - at, ANALOG_FRAME_S, 1e-6, "frames only — no crossing");
    at = r.wakeAt;
    r = sim.run(at).result;
  }
  assert.equal(r.wakeAt, null, "arrived, and nothing will ever cross");
  assert.equal(sim.level(u.get(2)), H);
  const v = r.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(1))));
  close(v, (5 * 2.2) / 12.2, 0.011, "the divider's voltage");
});

test("a late tick catches up on the crossing it missed", () => {
  const { b, u } = rcInto();
  const sim = spice(b.doc);
  sim.run(0);
  assert.equal(sim.run(0.5).level(u.get(2)), L);
});

test("a discharging node falls through the threshold the other way", () => {
  // The capacitor's far side on VCC: an empty capacitor starts the node AT
  // 5 V, and the resistor to GND drains it.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.link(res.get(1), u.get(1));
  b.gnd(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: 10e-6 });
  b.link(cap.get(1), u.get(1));
  b.vcc(cap.get(2));
  const sim = spice(b.doc);
  let at = sim.run(0).result.wakeAt;
  assert.equal(sim.level(u.get(2)), L, "power-on: the node starts HIGH");
  const falls = 0.1 * Math.log(5 / 1.4);
  // Display frames while it falls, then the crossing itself.
  while (at < falls * (1 - 1e-5)) {
    assert.equal(sim.level(u.get(2)), L);
    at = sim.run(at).result.wakeAt;
  }
  close(at, falls, 1e-5, "falls to 1.4 V");
  sim.run(at);
  assert.equal(sim.level(u.get(2)), H);
});

test("a ring oscillator is still reported as oscillating", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.link(u.get(2), u.get(3)); // 1Y → 2A
  b.link(u.get(4), u.get(5)); // 2Y → 3A
  b.link(u.get(6), u.get(1)); // 3Y → 1A
  for (const engine of ["digital", "spice"]) {
    const r = runner(b.doc, { engine }).run(0).result;
    assert.ok(
      r.warnings.some((w) => w.type === "oscillation"),
      `${engine}: oscillation`,
    );
  }
});

/** An RC relaxation oscillator round inverter 1: 1Y → R → 1A, and C from
    1A to GND. Oscillates at a period its thresholds set if the inverter is a
    Schmitt trigger; with one threshold it turns straight back. A CD40106B's
    by default: its input draws nothing, and its output is 5 V or 0 V behind
    its own 400 Ω, in series with R — `rc` counts it. Exactly 400 Ω: through
    100 kΩ it carries 50 µA at most, 20 mV of drive, on the first chord of
    its square law (spice/output-stage.js `CURVE_CORNERS`), the curve's own
    slope at the rail. */
function relaxation(ref = "CD40106B", { r = 100e3, c = 1e-6 } = {}) {
  const b = bench();
  const u = inverter(b, "u1", ref, "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  const own = ref.startsWith("CD") ? 400 : 0;
  return { b, u, rc: (r + own) * c };
}

const noOscillation = (r) =>
  assert.ok(
    !r.warnings.some((w) => w.type === "oscillation"),
    "no oscillation fault",
  );

test("a Schmitt input swings an RC between its two thresholds: a relaxation oscillator", () => {
  const config = normalizeSpiceConfig(null);
  let { up, down } = inputThresholds(config, partDef("74LS14"), 5);
  assert.deepEqual([up, down], [1.6, 0.8], "the '14's VT+ and VT−");
  const cmos = inputThresholds(config, partDef("CD40106B"), 10);
  close(cmos.up, 5.8, 1e-12, "a CMOS Schmitt's points scale with its supply");
  close(cmos.down, 3.8, 1e-12, "both of them");

  const { b, u, rc } = relaxation();
  ({ up, down } = inputThresholds(config, partDef("CD40106B"), 5));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  let level = sim.level(u.get(2));
  assert.equal(level, H, "an empty capacitor reads LOW, so 1Y is HIGH");
  const edges = [];
  for (let i = 0; i < 400 && edges.length < 7; i++) {
    const at = r.wakeAt;
    r = sim.run(at).result;
    noOscillation(r);
    const now = sim.level(u.get(2));
    if (now !== level) {
      edges.push(at);
      level = now;
    }
  }
  assert.equal(edges.length, 7);
  // The first HIGH charges an EMPTY capacitor all the way up from 0 V.
  close(edges[0], rc * Math.log(5 / (5 - up)), 1e-4, "the first, long HIGH");
  for (let i = 1; i + 1 < edges.length; i += 2) {
    close(edges[i] - edges[i - 1], rc * Math.log(up / down), 1e-4, "LOW: VT+ down to VT−"); // prettier-ignore
    close(edges[i + 1] - edges[i], rc * Math.log((5 - down) / (5 - up)), 1e-4, "HIGH: VT− up to VT+"); // prettier-ignore
  }
});

test("the same RC round an ordinary inverter turns straight back: an oscillation", () => {
  const { b } = relaxation("CD4069UB");
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  for (let i = 0; i < 20 && !r.analog.oscillating; i++) r = sim.run(r.wakeAt).result; // prettier-ignore
  assert.ok(r.warnings.some((w) => w.type === "oscillation"));
  assert.equal(r.analog.oscillating, true);
  // The next tick does not replay a history nobody can see: it starts at
  // its own moment.
  const next = sim.run(r.wakeAt).result;
  assert.ok(next.analog.time >= r.wakeAt);
});

test("a circuit stuck chattering backs off rather than replaying its budget every half millisecond", () => {
  const { b } = relaxation("CD4069UB");
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  for (let i = 0; i < 20 && !r.analog.oscillating; i++) r = sim.run(r.wakeAt).result; // prettier-ignore
  assert.equal(r.analog.oscillating, true);
  const { at, backoff } = r.analog.chatter;
  assert.equal(
    backoff,
    MIN_SHOWN_S,
    "a first capped tick waits the shortest shown time",
  );
  assert.ok(r.wakeAt >= at + backoff - 1e-12, "and asks for nothing sooner");
  // The quiet ticks after it remember it: each waits as long, and none
  // replays the chatter it skipped.
  for (let i = 0; i < 5; i++) {
    const target = r.wakeAt;
    r = sim.run(target).result;
    assert.ok(r.analog.chatter, "still remembered");
    assert.ok(
      r.wakeAt >= target + r.analog.chatter.backoff - 1e-12,
      "it waits",
    );
    assert.ok(r.analog.time >= target, "no history replayed");
  }
  assert.ok(MAX_CAPPED_BACKOFF_S >= MIN_SHOWN_S && CHATTER_MEMORY_S > 0);
});

/** The classic two-gate RC oscillator: 1Y → 2A, R from 1Y to the junction
    X, C from 2Y to X, and X into 1A — through `rs` when one is given (the
    CMOS sheets' 2.2·RC form; without it the input diodes clamp X). */
function twoGate(ref, { r, c, rs = 0 }) {
  const b = bench();
  const u = inverter(b, "u1", ref, "e10");
  b.link(u.get(2), u.get(3));
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(2));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: c });
  b.link(cap.get(1), u.get(4));
  b.link(res.get(2), cap.get(2));
  if (rs) {
    const series = b.seat("rs", "resistor", "a50", { ohms: rs });
    b.link(series.get(1), cap.get(2));
    b.link(series.get(2), u.get(1));
  } else {
    b.link(cap.get(2), u.get(1));
  }
  return { b, u };
}

/** The periods, rising edge to rising edge, of `out` over `until` seconds
    — and how many ticks reported an oscillation on the way. */
function periodsOf(sim, out, until) {
  let r = sim.run(0).result;
  let level = sim.level(out);
  const rises = [];
  let faults = 0; // ticks that reported an oscillation on the way
  for (let i = 0; i < 2000 && r.wakeAt != null && r.wakeAt <= until; i++) {
    const at = r.wakeAt;
    r = sim.run(at).result;
    if (r.warnings.some((w) => w.type === "oscillation")) faults++;
    const now = sim.level(out);
    if (now === H && level === L) rises.push(at);
    level = now;
  }
  return { periods: rises.slice(1).map((t, i) => t - rises[i]), faults };
}

test("a two-gate RC oscillator runs: the second gate sees the first switch in the same settle", () => {
  // Its second gate's input is a pin on the FIRST gate's output, in the
  // capacitor's network — read by its crossings, it saw that output switch
  // only at the next event, and the oscillator flipped every two quanta and
  // never ran (features/done/spice-lite-3-plan.md, D1). The CD4069UB's periods
  // are ngspice's on the same stage, clamp and threshold models (1.64·RC,
  // and 2.17·RC behind Rs = 2.2 R — spice-golden/coupled-osc.json): within
  // 1 %, the capacitor's two plates solved as the one charge they hold
  // (spice/dynamics.js).
  const cases = [
    ["CD4069UB", { r: 100e3, c: 1e-6 }, 0.1645],
    ["CD4069UB", { r: 100e3, c: 1e-6, rs: 220e3 }, 0.2171],
    ["CD40106B", { r: 100e3, c: 1e-6 }, null],
    ["CD40106B", { r: 100e3, c: 1e-6, rs: 220e3 }, null],
    ["74LS04", { r: 1e3, c: 100e-6 }, null],
    // Behind 1 kΩ: the LS input pushes its 0.2 mA out through Rs, so its pin
    // sits Rs × 0.2 mA above the junction — behind 2.2 kΩ, at its own 0.8 V
    // lower threshold, and it never reads LOW (as on a bench).
    ["74LS14", { r: 1e3, c: 100e-6, rs: 1e3 }, null],
  ];
  for (const [ref, rc, reference] of cases) {
    const { b, u } = twoGate(ref, rc);
    const { periods, faults } = periodsOf(spice(b.doc), u.get(4), 1.6);
    const what = `${ref}${rc.rs ? " behind Rs" : ""}`;
    assert.ok(
      periods.length >= 3,
      `${what}: it runs (${periods.length} periods)`,
    );
    assert.equal(faults, 0, `${what}: no oscillation fault`);
    const last = periods.at(-1);
    close(periods.at(-2), last, 1e-6, `${what}: steadily`);
    if (reference != null)
      close(last, reference, 0.01, `${what}: ngspice's period`);
  }
});

test("a two-gate oscillator behind Rs crosses its first threshold cleanly", () => {
  // At the crossing, an input a resistor away from the node was read again
  // from the voltage solve BEFORE the settle had solved anything: its
  // voltage was the last settle's, the node where it stood then, and the
  // crossing it was called for was undone — capped once, at Run.
  const { b, u } = twoGate("CD4069UB", { r: 100e3, c: 1e-6, rs: 220e3 });
  assert.equal(periodsOf(spice(b.doc), u.get(4), 1.6).faults, 0);
});

test("a late tick replays a slow oscillator's crossings without calling it an oscillation", () => {
  const { b, u, rc } = relaxation();
  const { up, down } = inputThresholds(normalizeSpiceConfig(null), partDef("CD40106B"), 5); // prettier-ignore
  const period = rc * (Math.log(up / down) + Math.log((5 - down) / (5 - up)));
  const sim = spice(b.doc);
  sim.run(0);
  // Two seconds late — a throttled timer: twenty-odd periods, more crossings
  // than one tick's own budget.
  assert.ok((2 * 2) / period > MAX_ANALOG_EVENTS);
  let r = sim.run(2).result;
  noOscillation(r);
  assert.equal(r.analog.oscillating, false);
  assert.ok(r.analog.time >= 2, "caught up to now");
  assert.ok(r.wakeAt > 2 && r.wakeAt - 2 <= period, "and runs on from there");
  // Hopelessly late, past even the catch-up budget: the history is skipped.
  assert.ok((2 * 200) / period > MAX_CATCHUP_EVENTS);
  r = sim.run(200).result;
  noOscillation(r);
  assert.ok(r.analog.time >= 200);
  // ... and it still oscillates afterwards, at its own pace.
  let level = sim.level(u.get(2));
  let edges = 0;
  for (let i = 0; i < 50 && edges < 3; i++) {
    r = sim.run(r.wakeAt).result;
    noOscillation(r);
    if (sim.level(u.get(2)) !== level) {
      level = sim.level(u.get(2));
      edges++;
    }
  }
  assert.equal(edges, 3);
});

test("a 74LS14 cannot run an RC oscillator through 10 kΩ: its input holds the capacitor up", () => {
  // Output LOW is 0.15 V behind 25 Ω, but below 1.3 V the input pushes its
  // own current back into the capacitor: through 10 kΩ the node comes to
  // rest near 0.94 V — above VT− 0.8 V — so the '14 never turns back. A
  // real '14 oscillator wants R of a kilohm or so, for this very reason.
  const { b, u } = relaxation("74LS14", { r: 10e3, c: 10e-6 });
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  let edges = 0;
  let level = sim.level(u.get(2));
  for (let i = 0; i < 200 && r.wakeAt != null; i++) {
    r = sim.run(r.wakeAt).result;
    if (sim.level(u.get(2)) !== level) {
      level = sim.level(u.get(2));
      edges++;
    }
  }
  assert.equal(edges, 1, "it turns LOW once, and stays there");
  assert.equal(level, L);
  const node = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  const rest = ttlRc({ g0: 1 / (10e3 + 25), i0: 0.15 / (10e3 + 25), c: 1 }).rest(); // prettier-ignore
  close(r.nodeVolts.get(node), rest, 0.011, "at rest above VT−");
  assert.ok(rest > 0.8);
});

test("a capacitor keeps its charge while its node is merged into a rail", () => {
  // A slide switch ties the node to + (pin 1) or to its unwired pin 3. Held
  // at +, the node IS the rail; switched away, it comes back as a node — at
  // the 5 V its capacitor was left holding, draining through 10k.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  const sw = b.seat("s1", "sw-slide", "a30", { pos: "1" });
  b.vcc(sw.get(1));
  b.link(sw.get(2), u.get(1));
  const res = b.seat("r1", "resistor", "a40", { ohms: 10e3 });
  b.link(res.get(1), u.get(1));
  b.gnd(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a50", { farads: 10e-6 });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  assert.equal(sim.level(u.get(2)), L, "on the rail: the input reads HIGH");
  close(r.analog.caps.get("c1"), 5, 1e-9, "charged to the rail");

  b.doc.components.find((c) => c.id === "s1").params.pos = "2";
  sim.rebuild();
  r = sim.run(1).result;
  assert.equal(sim.level(u.get(2)), L, "released: the capacitor holds it up");
  const node = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  close(r.nodeVolts.get(node), 5, 1e-3, "at the charge it was left with");
  // Display frames while it drains, then the crossing itself.
  const falls = 1 + 0.1 * Math.log(5 / TTL_TRIGGER);
  let at = r.wakeAt;
  while (at < falls * (1 - 1e-6)) {
    assert.equal(sim.level(u.get(2)), L);
    at = sim.run(at).result.wakeAt;
  }
  close(at, falls, 1e-6, "then drains to 1.4 V");
  sim.run(at);
  assert.equal(sim.level(u.get(2)), H);
});

test("a capacitor whose other lead goes nowhere is no part of the node", () => {
  const { b, u } = rcInto("CD4069UB", { c: 1e-6 });
  // 100 µF more on the node, its other lead alone in a column of its own.
  const stray = b.seat("c2", "cap-electrolytic", "a50", { farads: 100e-6 });
  b.link(stray.get(1), u.get(1));
  const r = spice(b.doc).run(0).result;
  close(
    r.wakeAt,
    0.01 * Math.log(5 / (5 - CMOS_TRIGGER)),
    1e-4,
    "τ is the wired capacitor's alone",
  );
});

test("a 74LS input on an RC pushes its own current into it below 1.3 V", () => {
  // The same 10 kΩ / 10 µF into a 74LS04: from 0 V to the input's 0.9 V knee
  // the input sources its 0.2 mA into the capacitor alongside the resistor,
  // then less and less to its 1.3 V, and from there the resistor charges it
  // alone — a corner at each, where the curve is linearized again.
  const { b, u } = rcInto();
  const rc = ttlRc({ g0: 1 / 10e3, i0: 5 / 10e3, c: 10e-6 });
  const crossing = rc.at(TTL_TRIGGER);
  assert.ok(crossing < 0.1 * Math.log(5 / (5 - TTL_TRIGGER)), "sooner than R·C alone"); // prettier-ignore
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  close(r.wakeAt, rc.at(TTL_KNEE), 1e-5, "the knee");
  const node = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  r = sim.run(r.wakeAt).result;
  close(r.nodeVolts.get(node), TTL_KNEE, 1e-6, "at the input's knee");
  close(r.wakeAt, rc.at(TTL_BIAS.volts), 1e-5, "the input's own 1.3 V");
  r = sim.run(r.wakeAt).result;
  close(r.nodeVolts.get(node), 1.3, 1e-6, "at the input's own 1.3 V");
  close(r.wakeAt, crossing, 1e-5, "the crossing, on the resistor alone");
  sim.run(r.wakeAt);
  assert.equal(sim.level(u.get(2)), L);
});

test("a 74LS input under a stiff divider: its own current lifts the node", () => {
  // 10k to VCC and 2.2k to GND would hold an open node at 0.90 V; the 74LS
  // input's current out of the pin lifts it to ~1.09 V — still LOW to the
  // gate, and short of its 1.4 V trigger, so it is released.
  const { b, u } = rcInto();
  const down = b.seat("r2", "resistor", "a50", { ohms: 2.2e3 });
  b.link(down.get(1), u.get(1));
  b.gnd(down.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  r = runTo(sim, r, 10);
  const v = ttlRc({ g0: 1 / 10e3 + 1 / 2.2e3, i0: 5 / 10e3, c: 1 }).rest();
  close(r.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(1)))), v, 0.011, "the divider with the input on it"); // prettier-ignore
  assert.equal(sim.level(u.get(2)), H);
});

test("a node reads a HIGH as its driver's supply, not the desk's highest", () => {
  // A 74LS04 on 5 V charges an RC that a CD4069UB on 12 V reads: the node
  // can climb only to the 3.6 V its driver's HIGH stage reaches (VCC less
  // two VBE), short of the CMOS gate's 6 V — the reason a 5 V part cannot
  // drive 12 V CMOS.
  const b = bench();
  const last = () => b.doc.wires[b.doc.wires.length - 1];
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 20, y: 30, params: { volts: 12 } }); // prettier-ignore
  const ls = inverter(b, "u1", "74LS04", "e10");
  b.gnd(ls.get(1)); // 1Y HIGH
  const cmos = b.seat("u2", "CD4069UB", "e30");
  b.vcc(cmos.get(14));
  last().from = "psu2.+";
  b.gnd(cmos.get(7));
  b.gnd(cmos.get(7));
  last().from = "psu2.-"; // one ground for both supplies
  const res = b.seat("r1", "resistor", "a50", { ohms: 10e3 });
  b.link(ls.get(2), res.get(1));
  b.link(res.get(2), cmos.get(1));
  const cap = b.seat("c1", "cap-electrolytic", "a58", { farads: 10e-6 });
  b.link(cap.get(1), cmos.get(1));
  b.gnd(cap.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  for (let i = 0; i < 100 && r.wakeAt != null; i++)
    r = sim.run(r.wakeAt).result;
  assert.equal(r.wakeAt, null, "it arrives, and nothing crosses");
  const node = sim.netlist.netOfPoint.get(b.at(cmos.get(1)));
  close(r.nodeVolts.get(node), 3.6, 0.011, "at its driver's 3.6 V HIGH");
  assert.equal(sim.level(cmos.get(2)), H, "the 12 V gate never switches");
});

test("a RAM write made in one settle is read by the next, inside one tick", () => {
  // An SRAM with WE on a fast RC (τ = 1 µs, crossing well inside the fast
  // window): the first settle writes (WE LOW, the data pins floating HIGH),
  // the crossing's settle reads it back (WE HIGH, OE LOW). The image the
  // second settle reads has the first's write in it; the caller's does not.
  const b = bench();
  const ram = b.seat("u1", "ram-8k", "e10");
  b.vcc(ram.get(28));
  b.gnd(ram.get(14));
  b.gnd(ram.get(26)); // CE
  b.gnd(ram.get(27)); // OE
  const res = b.seat("r1", "resistor", "a50", { ohms: 1e3 });
  b.link(res.get(1), ram.get(20)); // WE
  b.vcc(res.get(2));
  const cap = b.seat("c1", "cap-ceramic", "a56", { farads: 1e-9 });
  b.link(cap.get(1), ram.get(20));
  b.gnd(cap.get(2));
  const netlist = buildNetlist(b.doc);
  const images = new Map([["u1", new Uint8Array(8192)]]);
  const r = ENGINES.spice.tick({
    document: b.doc,
    netlist,
    warmStart: new Map(),
    state: new Map(),
    prevPinLevels: new Map(),
    signalLevels: new Map(),
    images,
    now: 0,
    spice: { config: { enabled: true }, analog: null },
  });
  const dq0 = netlist.netOfPoint.get(b.at(ram.get(9)));
  assert.ok(r.memWrites.some((w) => w.compId === "u1" && w.value === 0xff));
  assert.equal(r.netLevels.get(dq0), H, "the written byte read back");
  assert.ok(images.get("u1").every((v) => v === 0), "the caller's image untouched"); // prettier-ignore
});

test("each capacitor's nets are read once per netlist", () => {
  const { b } = rcInto();
  const netlist = buildNetlist(b.doc);
  const nets = capacitorNets(b.doc, netlist);
  assert.equal(capacitorNets(b.doc, netlist), nets, "cached");
  assert.notEqual(capacitorNets(b.doc, buildNetlist(b.doc)), nets);
  const c1 = nets.get("c1");
  assert.ok(c1.a && c1.b && c1.a !== c1.b, "pin 1's net and pin 2's");
});

test("mixed families: the slower CD4000 gate holds its output for its delay", () => {
  // A signal into a CD4069UB, its output into a 74LS04: the same settled
  // levels as the digital engine, reached in more passes — the CMOS gate is
  // ~12 quanta of 10 ns at 5 V (125 ns).
  const b = bench();
  const cmos = inverter(b, "u1", "CD4069UB", "e10");
  const ls = inverter(b, "u2", "74LS04", "e20");
  b.link(cmos.get(2), ls.get(1));
  b.signal("in", cmos.get(1), "low");
  const levels = new Map([["in", H]]);
  const digital = runner(b.doc);
  const sl = spice(b.doc);
  digital.run(0, new Map([["in", L]]));
  sl.run(0, new Map([["in", L]]));
  const d = digital.run(0.01, levels).result;
  const s = sl.run(0.01, levels).result;
  assert.deepEqual(s.netLevels, d.netLevels);
  assert.equal(sl.level(ls.get(2)), H);
  assert.ok(
    s.iterations >= d.iterations + 11,
    `held for its delay: ${s.iterations} vs ${d.iterations}`,
  );
  assert.ok(s.analog.outputs.has("u1"), "the CMOS gate's outputs are carried");
});

test("an edited delay far shorter than the rest cannot make a tick crawl", () => {
  // The 74LS delay set to a picosecond against the CMOS gate's 125 ns: held
  // to MAX_HOLD quanta, a settle stays a handful of passes.
  const b = bench();
  const cmos = inverter(b, "u1", "CD4069UB", "e10");
  const ls = inverter(b, "u2", "74LS04", "e20");
  b.link(cmos.get(2), ls.get(1));
  b.signal("in", cmos.get(1), "low");
  const sim = spice(b.doc, { families: { "74LS": { delayNs: 0.001 } } });
  sim.run(0, new Map([["in", L]]));
  const r = sim.run(0.01, new Map([["in", H]])).result;
  assert.equal(sim.level(ls.get(2)), H, "it still settles right");
  assert.ok(r.iterations <= 4 * MAX_HOLD, `${r.iterations} passes`);
});

/** How long, seconds, a stage takes to charge `farads` straight from `from`
    to `to` volts: piece by piece between its kinks, where its current is a
    straight line in the voltage — C/g · ln(I_b/I_a) along a slope g, a
    ramp where it is flat. */
function chargeTime(stage, farads, from, to) {
  const ends = [from, ...stageKinks(stage).filter((k) => k > from && k < to).sort((a, b) => a - b), to]; // prettier-ignore
  let t = 0;
  for (let k = 0; k + 1 < ends.length; k++) {
    const [va, vb] = [ends[k], ends[k + 1]];
    const [ia, ib] = [stageCurrent(stage, va), stageCurrent(stage, vb)];
    const g = (ib - ia) / (vb - va);
    t += Math.abs(g) < 1e-15 ? (farads * (vb - va)) / ia : (farads / g) * Math.log(ib / ia); // prettier-ignore
  }
  return t;
}

test("a CD4000 output at 5 V charges a capacitor it drives straight — at its limit, then along its curve", () => {
  // At 5 V a CD4000 output limits an LED's current, so the LED rule's strong
  // map leaves it out — which once made its capacitor an undriven node,
  // frozen at 0 V while the gate drove it HIGH. It is a stage: 5 V behind
  // 400 Ω at the rail, saturating at 4.2 mA (spice/output-stage.js) — so an
  // empty 100 nF rises in a straight line at 4.2 mA until the output comes
  // out of saturation at 5 − 3.36 V (its overdrive), and from there along
  // its square law's chords, each one an RC of its own.
  const b = bench();
  const u = inverter(b, "u1", "CD4069UB", "e10");
  b.gnd(u.get(1)); // 1Y HIGH
  for (const p of [5, 9, 11, 13]) b.gnd(u.get(p));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: 100e-9 });
  b.link(cap.get(1), u.get(2));
  b.gnd(cap.get(2));
  b.link(u.get(2), u.get(3)); // 2A reads 1Y
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  const net = sim.netlist.netOfPoint.get(b.at(u.get(2)));
  // Anchored where the first settle ends, a few gate delays after Run.
  const { t0, v0 } = r.analog.nodes.get(net).curve;
  const stage = outputStage(partDef("CD4069UB"), 5, H);
  const ramp = 4.2e-3 / 100e-9; // volts per second, saturated
  const corner = t0 + (5 - stage.vov - v0) / ramp;
  close(r.wakeAt, corner, 1e-9, "a straight ramp out of saturation at 1.64 V");
  // From there corner by corner along the curve — every curve the node runs
  // starts exactly where the square law's chords put it, at the moment they
  // say, through 2A reading it HIGH at 2.5 V on the way.
  const starts = [];
  for (let i = 0; i < 40 && r.wakeAt != null && r.wakeAt < 1e-3; i++) {
    r = sim.run(r.wakeAt).result;
    const c = r.analog.nodes.get(net).curve;
    starts.push(c.v0);
    close(c.t0, corner + chargeTime(stage, 100e-9, 5 - stage.vov, c.v0), 1e-9, `at ${c.v0.toFixed(3)} V`); // prettier-ignore
  }
  assert.ok(starts.length >= 5, "several chords");
  assert.ok(
    starts.some((v) => v > CMOS_TRIGGER),
    "past 2A's 2.5 V",
  );
  assert.equal(sim.level(u.get(4)), L, "2A reads it HIGH");
  r = runTo(sim, r, 1);
  assert.equal(r.wakeAt, null, "arrived");
  close(r.nodeVolts.get(net), 5, 0.011, "at its driver's supply");
  assert.equal(sim.level(u.get(2)), H, "1Y is HIGH");
});

test("a CD4066 channel at 5 V carries a rail onto a capacitor, through its on-resistance", () => {
  const b = bench();
  const s = b.seat("u1", "CD4066B", "e10");
  b.vcc(s.get(14));
  b.gnd(s.get(7));
  b.vcc(s.get(13)); // switch 1 on
  b.vcc(s.get(1));
  for (const p of [5, 6, 12]) b.gnd(s.get(p));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
  b.link(cap.get(1), s.get(2));
  b.gnd(cap.get(2));
  const u = inverter(b, "u2", "74LS04", "e30");
  b.link(s.get(2), u.get(1));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  assert.equal(sim.level(u.get(2)), H, "the empty capacitor reads LOW");
  const net = sim.netlist.netOfPoint.get(b.at(s.get(2)));
  const t0 = r.analog.nodes.get(net).curve.t0;
  // Below 1.3 V the 74LS input's own current joins the switch's (470 Ω):
  // a corner at its knee and at its 1.3 V, then the gate's 1.4 V.
  const rc = ttlRc({ g0: 1 / 470, i0: 5 / 470, c: 1e-6 });
  close(r.wakeAt, t0 + rc.at(TTL_KNEE), 1e-9, "the input's knee");
  r = sim.run(r.wakeAt).result;
  close(r.wakeAt, t0 + rc.at(TTL_BIAS.volts), 1e-9, "the input's 1.3 V");
  r = sim.run(r.wakeAt).result;
  close(r.wakeAt, t0 + rc.at(1.4), 1e-9, "the gate's crossing");
  r = sim.run(r.wakeAt).result;
  assert.equal(sim.level(u.get(2)), L, "crossed");
  r = runTo(sim, r, 1);
  assert.equal(
    sim.level(u.get(2)),
    L,
    "the gate reads the rail through the switch",
  );
  close(r.nodeVolts.get(net), 5, 0.011, "at the rail");
});

test("a curve is never read past its corner", () => {
  // Past `until` the network it was linearized from is another one: it stands
  // at its corner until it is linearized again there.
  const ramp = { t0: 0, v0: 0, vInf: 0, tau: Number.POSITIVE_INFINITY, rate: 1e3, until: 2 }; // prettier-ignore
  assert.equal(valueAt(ramp, 1e-3), 1, "on its way");
  assert.equal(valueAt(ramp, 1), 2, "a second on: at its corner, not 1000 V");
  const down = { ...ramp, rate: -1e3, v0: 3, until: 0.5 };
  assert.equal(valueAt(down, 1), 0.5, "a falling ramp too");
  const curve = { t0: 0, v0: 5, vInf: -1, tau: 1e-3, until: 0 };
  assert.equal(valueAt(curve, 1), 0, "an exponential stops at its corner");
  close(
    valueAt(curve, 1e-4),
    -1 + 6 * Math.exp(-0.1),
    1e-12,
    "before it, the curve",
  );
  const plain = { t0: 0, v0: 5, vInf: -1, tau: 1e-3 };
  close(valueAt(plain, 1), -1, 1e-9, "no corner, its asymptote");
});

test("a tick that skips history never runs a node past its corner — nor smokes a chip for it", () => {
  // 100 Ω round a CD4069UB onto 100 nF: the output saturates (a ramp at
  // 4.2 mA / 100 nF = 42 kV/s) and the loop chatters about its trip point.
  // Ticked as SimController paces a desk (each wake, never sooner than
  // MIN_SHOWN_S on), every tick skips history — and read straight on, the
  // ramp put the input at −10 V, its clamp diode and the output smoking.
  const b = bench();
  const u = inverter(b, "u1", "CD4069UB", "e10");
  for (const p of [3, 5, 9, 11, 13]) b.gnd(u.get(p));
  const res = b.seat("r1", "resistor", "a30", { ohms: 100 });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(2));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: 100e-9 });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  const sim = spice(b.doc);
  const net = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  let r = sim.run(0).result;
  let t = 0;
  for (let i = 0; i < 40; i++) {
    t = Math.max(r.wakeAt ?? Number.POSITIVE_INFINITY, t + MIN_SHOWN_S);
    r = sim.run(t).result;
    const v = r.nodeVolts.get(net);
    assert.ok(v >= -0.5 && v <= 5.5, `tick ${i}: ${v} V, inside the rails' clamps`); // prettier-ignore
    assert.ok(!r.warnings.some((w) => w.smoke), `tick ${i}: nothing smokes`);
    assert.equal(r.chipStatus.get("u1").status, "ok");
  }
});

test("a gate delay longer than the ticks' spacing never runs analog time backwards", () => {
  // Each settle runs on past its moment by its passes × the delay; with a
  // 10 µs gate (the most the setting takes) that is past the next tick's
  // `now`. Started back at `now`, every curve was read before its anchor —
  // where it stands still — and the RC never charged.
  const { b, u } = rcInto("74LS04", { r: 1e3, c: 1e-6 });
  const sim = spice(b.doc, { families: { "74LS": { delayNs: 10_000 } } });
  const net = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  let time = -1;
  let volts = -1;
  for (const at of [0, 5e-6, 1e-5, 1.5e-5, 2e-5, 1e-4]) {
    const r = sim.run(at).result;
    assert.ok(r.analog.time >= time, `${at}: ${r.analog.time} after ${time}`);
    if (at > 0) assert.ok(r.nodeVolts.get(net) > volts, `${at}: charging`);
    time = r.analog.time;
    volts = r.nodeVolts.get(net);
  }
});

test("a node nobody reads is shown against its own supply, not the desk's highest", () => {
  // A 5 V RC on a desk that also holds an idle 12 V supply: half the desk's
  // highest (6 V) is a level a 5 V node never reaches, so it read LOW for
  // ever. Its own supply is the 5 V rail its resistor reaches.
  const b = bench();
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 20, y: 30, params: { volts: 12 } }); // prettier-ignore
  const res = b.seat("r1", "resistor", "a10", { ohms: 1e3 });
  b.vcc(res.get(1));
  const cap = b.seat("c1", "cap-electrolytic", "a20", { farads: 1e-6 });
  b.link(res.get(2), cap.get(1));
  b.gnd(cap.get(2));
  const sim = spice(b.doc);
  const net = sim.netlist.netOfPoint.get(b.at(cap.get(1)));
  assert.equal(sim.run(0).result.netLevels.get(net), L, "empty: LOW");
  const r = sim.run(5e-3).result;
  assert.ok(r.nodeVolts.get(net) > 4.9, "charged to the 5 V rail");
  assert.equal(r.netLevels.get(net), H, "past half its own 5 V: HIGH");
});

test("a short through a transistor stands only as a short's current", () => {
  // NPN, collector on +, emitter on −, base fed from + through `ohms`: the
  // digital joins say + meets − either way; the solve says 43 µA through
  // 10 MΩ (a load, not a short) and 0.43 A through 1 kΩ (a short).
  const npn = (ohms) => {
    const b = bench();
    const q = b.seat("q1", "npn", "a30");
    b.vcc(q.get(3));
    b.gnd(q.get(1));
    const r = b.seat("r1", "resistor", "a40", { ohms });
    b.vcc(r.get(1));
    b.link(r.get(2), q.get(2));
    return b.doc;
  };
  const shorts = (doc, engine) =>
    runner(doc, { engine })
      .run(0)
      .result.warnings.filter((w) => w.type === "short");
  assert.equal(shorts(npn(10e6), "digital").length, 1, "the digital joins");
  assert.deepEqual(shorts(npn(10e6), "spice"), [], "43 µA is no short");
  assert.equal(shorts(npn(1e3), "spice").length, 1, "0.43 A is");
  assert.equal(shorts(npn(1e3), "spice")[0].via, "transistor");
});

test("a short through a switch stands while its supply is limited, not at a channel's milliamps", () => {
  // A MOSFET straight across the rails, gate HIGH: the supply limits.
  const fet = bench();
  const q = fet.seat("q1", "nmos", "a30");
  fet.gnd(q.get(1));
  fet.vcc(q.get(3));
  fet.signal("sig1", q.get(2), "high");
  const r = spice(fet.doc).run(0, new Map([["sig1", H]])).result;
  assert.equal(r.supplies.get("psu1").limited, true);
  assert.equal(r.warnings.filter((w) => w.type === "short").length, 1);
  // A CD4066B channel across the rails at 5 V: 470 Ω, 10.6 mA — no short.
  const sw = bench();
  const u = sw.seat("u1", "CD4066B", "e10");
  sw.vcc(u.get(14));
  sw.gnd(u.get(7));
  sw.vcc(u.get(1));
  sw.gnd(u.get(2));
  sw.vcc(u.get(13));
  const s = spice(sw.doc).run(0).result;
  assert.deepEqual(
    s.warnings.filter((w) => w.type === "short"),
    [],
  );
});

test("an RC node into a chip off the rails is read against that chip's own ground", () => {
  // A CD4069UB whose VSS sits a diode above GND (its drop at the chip's own
  // quiescent current, a few tenths of a volt): its 1A trips at its
  // threshold ABOVE VSS, so a 10 kΩ / 10 µF node from + gets there later
  // than one into a chip on the rails.
  const b = bench();
  const u = b.seat("u1", "CD4069UB", "e10");
  b.vcc(u.get(14));
  const d = b.seat("d1", "diode", "a50");
  b.link(d.get(1), u.get(7));
  b.gnd(d.get(2));
  const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.link(r.get(1), u.get(1));
  b.vcc(r.get(2));
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 10e-6 });
  b.link(c.get(1), u.get(1));
  b.gnd(c.get(2));
  const run = spice(b.doc);
  let t = 0;
  let flip = null;
  let result = null;
  for (let i = 0; i < 400 && flip == null; i++) {
    result = run.run(t).result;
    if (run.level(u.get(2)) === L) flip = t;
    t = result.wakeAt ?? t + 1e-3;
  }
  const vss = result.nodeVolts.get(run.netlist.netOfPoint.get(b.at(u.get(7))));
  const span = result.chipStatus.get("u1").volts;
  const { up } = inputThresholds(
    normalizeSpiceConfig({ enabled: true }),
    partDef("CD4069UB"),
    span,
  );
  assert.ok(vss > 0.1, `VSS lifted: ${vss}`);
  const expected = -10e3 * 10e-6 * Math.log(1 - (vss + up) / 5);
  assert.ok(flip != null, "1Y switched");
  close(flip, expected, 0.01, "the crossing, against VSS");
});

test("a chip fed through a resistor is said at the voltage on its pins from the first tick", () => {
  // A 74LS04 fed through 47 Ω, 1Y HIGH lighting an LED through 100 Ω: at
  // Run its outputs come on and draw through the feed, so the tick that
  // brought them on settles again on what that leaves its VCC — underpowered
  // on tick 0, not one tick later.
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  const feed = b.seat("r1", "resistor", "a30", { ohms: 47 });
  b.vcc(feed.get(1));
  b.link(feed.get(2), u.get(14));
  b.gnd(u.get(7));
  b.gnd(u.get(1));
  const rl = b.seat("rl", "resistor", "a40", { ohms: 100 });
  b.link(u.get(2), rl.get(1));
  const led = b.seat("d1", "led", "a50", { color: "red" });
  b.link(rl.get(2), led.get(1));
  b.gnd(led.get(2));
  const run = spice(b.doc);
  const r = run.run(0).result;
  const vcc = r.nodeVolts.get(run.netlist.netOfPoint.get(b.at(u.get(14))));
  const st = r.chipStatus.get("u1");
  assert.equal(st.status, "underpowered");
  close(st.volts, vcc, 1e-6, "said at what its pins carry");
  assert.ok(r.warnings.some((w) => w.type === "underpowered"));
});
