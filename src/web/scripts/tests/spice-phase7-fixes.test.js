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

// The 2026-10-26 regrade's Spice Lite findings, fixed in the review's phase
// 7 (2026-10-27): a small-signal diode's die judged where its voltage
// reaches its burn, at that moment, whatever the ticks; a tick that reads
// its own moment on an island nothing listens to (an edge into a clamp
// diode, a coupled trigger into a transistor's base), not one run on along
// its curve's corners; and a MOSFET wired as a diode with nothing to feed
// it left floating, not held at its threshold.

import test from "node:test";
import assert from "node:assert/strict";

import { partDef } from "../catalog/index.js";
import { bench, runner } from "./timing-fixtures.js";
import { H, L } from "../sim/levels.js";
import { DIODE_SPEC, burnVolts, diodeCurrent, diodeVerdict } from "../sim/spice/diodes.js"; // prettier-ignore

const near = (got, want, tol, what) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} for ${want}`);

/** A 12 V~ adapter through a diode of `grade` into `farads` ∥ 1 kΩ. */
function halfWave(farads, grade) {
  const b = bench({ volts: 5 });
  const d = b.seat("d1", "diode", "a10", grade ? { grade } : {});
  const c = b.seat("c1", "cap-electrolytic", "a20", { farads });
  const r = b.seat("r1", "resistor", "a30", { ohms: 1000 });
  b.link(d.get(2), c.get(1));
  b.link(c.get(1), r.get(1));
  b.link(c.get(2), r.get(2));
  b.gnd(c.get(2));
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -40, y: 40, params: partDef("adapter").normalizeParams({ hz: 60, rms: 12 }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wl", from: "adp1.S1", to: b.at(d.get(1)), color: "red" },
    { id: "wn", from: "adp1.S2", to: b.at(c.get(2)), color: "black" },
  );
  return { doc: b.doc, out: b.at(c.get(1)) };
}

/** Run a half-wave for `seconds` on its own wakes, and on `grid` too: the
    moment the diode burnt (null if it did not) and the output then. */
function burnOf(farads, grid, grade, seconds = 0.03) {
  const { doc, out } = halfWave(farads, grade);
  const sim = runner(doc, { engine: "spice" });
  const net = sim.netlist.netOfPoint.get(out);
  let r = sim.run(0, new Map(), {}).result;
  let t = 0;
  while (t < seconds) {
    const onGrid = grid ? (Math.floor(t / grid + 1e-9) + 1) * grid : Infinity;
    t = Math.min(r.wakeAt ?? Infinity, onGrid);
    if (!Number.isFinite(t)) break;
    r = sim.run(t, new Map(), {}).result;
    const burnt = r.warnings.find((w) => w.type === "diode-burnt");
    if (burnt) return { t, out: r.nodeVolts.get(net), amps: burnt.amps };
  }
  return null;
}

test("a small-signal diode's die burns where its voltage reaches its burn, at any tick spacing", () => {
  // Into 470 µF a 1N4148 off a 12 V~ adapter carries 2.27 A at its crest,
  // 1.9 ms in (ngspice) — past the 2 A its die takes for a microsecond. It
  // burnt on a 0.2–2.5 ms grid of ticks, read at whatever instant a tick
  // landed on, and at the adapter's own wakes never (the regrade,
  // 2026-10-26). Now it burns where it reaches 2 A, 1.2 ms in (ngspice
  // 1.200 ms), its reservoir at 2.70 V, whatever the ticks.
  const runs = [null, 2e-4, 5e-4, 2.5e-3].map((grid) => burnOf(470e-6, grid));
  for (const run of runs) {
    assert.ok(run, "it burns");
    near(run.amps, 2, 0.01, "at its die's 2 A");
  }
  // The capacitor stops charging at the burn, wherever the tick that says
  // so falls.
  for (const run of runs) near(run.out, runs[1].out, 0.01, "its reservoir");
  near(runs[1].out, 2.7, 0.02, "charged to the burn's moment");
});

test("a rectifier diode charging the same reservoir does not burn", () => {
  // The 1N4007 grade is surge-rated (30 A): the half-wave is exact against
  // its card at every tick spacing (golden `halfwave4007`'s kind).
  for (const grid of [null, 5e-4]) assert.equal(burnOf(470e-6, grid, "rectifier"), null); // prettier-ignore
});

test("burnVolts is where diodeVerdict says the die burns", () => {
  const at = burnVolts(DIODE_SPEC, 25);
  const amps = diodeCurrent(DIODE_SPEC, at.up);
  near(amps, 2, 1e-6, "its die's surge current, from ambient");
  assert.equal(diodeVerdict(DIODE_SPEC, amps, at.up, 25).burns, true);
  const under = at.up - 1e-6;
  assert.equal(diodeVerdict(DIODE_SPEC, diodeCurrent(DIODE_SPEC, under), under, 25).burns, false); // prettier-ignore
  // A package already hot leaves its die less room.
  assert.ok(burnVolts(DIODE_SPEC, 100).up < at.up);
  assert.equal(burnVolts(DIODE_SPEC, 150), null);
  // A Zener burns backwards too, past its breakdown.
  const zener = { ...DIODE_SPEC, zenerV: 5.1 };
  const z = burnVolts(zener, 25);
  assert.ok(z.down < -5.1);
  assert.equal(diodeVerdict(zener, diodeCurrent(zener, z.down), z.down, 25).burns, true); // prettier-ignore
});

/** A 1 kHz square clock through 10 µF into a junction (`part`: a red LED
    or a small-signal diode) to ground. */
function edgeClamp(part = "led") {
  const b = bench({ volts: 5 });
  const c = b.seat("c1", "cap-electrolytic", "a10", { farads: 10e-6 });
  const d = b.seat("d1", part, "a20", part === "led" ? { color: "red" } : {});
  b.link(c.get(2), d.get(1));
  b.gnd(d.get(2));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 1000 }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wk1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wk2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wk3", from: "clk1.out", to: b.at(c.get(1)), color: "blue" },
  );
  return { doc: b.doc, x: b.at(c.get(2)) };
}

for (const [part, refs] of [
  // ngspice's device deck, the brick's 50 Ω in it (golden coupled-edge-*-clamp).
  ["led", [2.3285, 2.3278, 2.3209]],
  ["diode", [0.92471, 0.92449, 0.9224]],
]) {
  test(`an edge into a ${part} clamp is read at its own moment, behind the brick's 50 Ω, and burns nothing`, () => {
    // Nothing listens to the plate: run on corner to corner past the tick
    // (FAST_WINDOW_S, chained) a 1N4148's plate was read 50 µs on — 0.90 V
    // a tenth of a microsecond after the edge, for ngspice's 4.93 V. And
    // the ideal brick drove 6 A into it at the edge and burnt it; behind
    // its 50 Ω (spice/output-stage.js `CLOCK_OHMS`, wave 2b, 2026-10-27)
    // the edge is 0.1 A at most.
    const { doc, x } = edgeClamp(part);
    const sim = runner(doc, { engine: "spice" });
    const net = sim.netlist.netOfPoint.get(x);
    const half = 5e-4;
    const clocks = (t) => {
      const n = Math.floor(t / half + 1e-9);
      return { clockPhase: new Map([["clk1", n % 2 ? H : L]]), clockTimes: new Map([["clk1", { half, since: n * half }]]) }; // prettier-ignore
    };
    let burnt = 0;
    const run = (t) => {
      const r = sim.run(t, new Map(), clocks(t)).result;
      burnt += r.warnings.filter((w) => w.type === "diode-burnt" || w.type === "led-burnt").length; // prettier-ignore
      return r.nodeVolts.get(net);
    };
    run(0);
    run(5e-4);
    near(run(5.001e-4), refs[0], 0.01 * refs[0], "0.1 µs on");
    near(run(5.01e-4), refs[1], 0.01 * refs[1], "1 µs on");
    near(run(5.1e-4), refs[2], 0.01 * refs[2], "10 µs on");
    for (let t = 1e-3; t <= 0.02 + 1e-9; t += 2.5e-4) run(t);
    assert.equal(burnt, 0, "nothing burns");
  });
}

test("a MOSFET wired as a diode with nothing to feed it holds no net", () => {
  // Gate to drain through 10 kΩ, its source on ground and nothing else on
  // its drain: solved where its square law comes within the solve's
  // tolerance of nothing, VTO + 40 µV, and held there it read 2.1 V
  // (ngspice: its leak to ground, 0 — fuzz fz771800064-108).
  const b = bench({ volts: 9 });
  const q = b.seat("q1", "nmos", "a10", { case: "TO-92" });
  const r = b.seat("r1", "resistor", "a20", { ohms: 10e3 });
  b.gnd(q.get(1));
  b.link(r.get(1), q.get(2));
  b.link(r.get(2), q.get(3));
  const sim = runner(b.doc, { engine: "spice" });
  const res = sim.run(0, new Map(), {}).result;
  const drain = sim.netlist.netOfPoint.get(b.at(q.get(3)));
  const v = res.nodeVolts.get(drain);
  assert.ok(v == null || Math.abs(v) < 0.02, `${v} V`);
});
