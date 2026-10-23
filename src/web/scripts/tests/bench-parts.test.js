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

// The bench parts (features/chiphippo-bench-parts-feature-request.md) in
// both engines: the optocouplers, the LM358, the LM339, the linear
// regulators, the relay and the electronic load. The ULN2003A has its own
// file.

import test from "node:test";
import assert from "node:assert/strict";
import { H, L, X } from "../sim/levels.js";
import { partDef } from "../catalog/index.js";
import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { regulatorFacts, regulatorVolts } from "../sim/regulators.js";
import { coilOf } from "../sim/spice/inductors.js";
import { buildNetlist } from "../sim/netlist.js";
import {
  LOAD_CV_OHMS,
  LOAD_MAX_A,
  LOAD_RON,
  OPTO_TRANSFER,
  QUIESCENT_HEAD_V,
  analogCurrents,
  analogHeldThrough,
  heldOutright,
  loadLaw,
  loadSlope,
  opAmpSlope,
  opAmpStepCut,
  optoTransfer,
  regulatorQuiescent,
} from "../sim/spice/analog-devices.js";
import {
  HEAT_STEP_S,
  HOT_RECHECK_S,
  SUSTAIN_S,
  HEAT_TAU_S,
  tripIn,
} from "../sim/spice/bench-warnings.js";
import { REGULATOR_HEAT, loadBadge } from "../catalog/bench-parts.js";
import { bench, runner } from "./timing-fixtures.js";
import { driveSpice } from "../bench/drive-spice.js";
import { readFileSync } from "node:fs";
import { exampleDesktops } from "../model/example-desktops.js";

/** A net's voltage on the last tick, by one of its holes. */
const voltsAt = (sim, b, hole) =>
  sim.result.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(hole)));

/** Run to `until`, ticking at every wake on the way. */
function runTo(sim, from, until, levels = new Map()) {
  let r = sim.run(from, levels).result;
  const seen = [r];
  for (let i = 0; i < 400 && r.wakeAt != null && r.wakeAt < until; i++) {
    r = sim.run(r.wakeAt, levels).result;
    seen.push(r);
  }
  return seen;
}

/** A load brick across the bench's supply, or across `pos` and −. */
function addLoad(b, params, pos = null) {
  b.doc.components.push({ id: "load1", kind: "load", ref: "load", x: 20, y: 30, params: partDef("load").normalizeParams(params) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wl1", from: "load1.pos", to: pos ?? "psu1.+", color: "red" },
    { id: "wl2", from: "load1.neg", to: "psu1.-", color: "black" },
  );
}

// ── Optocouplers ──────────────────────────────────────────────────────────

/** An optocoupler's LED fed from signal "in" through 470 Ω, its
    phototransistor sinking 1 kΩ from + (12 V). */
function opto(ref, pins) {
  const b = bench({ volts: 12 });
  const u = b.seat("u1", ref, "e10");
  const rin = b.seat("r1", "resistor", "a30", { ohms: 470 });
  b.signal("in", rin.get(1), "low");
  b.link(rin.get(2), u.get(pins.a));
  b.gnd(u.get(pins.k));
  const rout = b.seat("r2", "resistor", "a40", { ohms: 1000 });
  b.vcc(rout.get(1));
  b.link(rout.get(2), u.get(pins.c));
  b.gnd(u.get(pins.e));
  return { b, u };
}

for (const [ref, pins] of [
  ["4N35", { a: 1, k: 2, c: 5, e: 4 }],
  ["PC817", { a: 1, k: 2, c: 4, e: 3 }],
]) {
  test(`${ref}: the logic engine closes C–E while its LED is lit`, () => {
    const { b, u } = opto(ref, pins);
    const sim = runner(b.doc);
    sim.run(0, new Map([["in", H]]));
    assert.equal(sim.level(u.get(pins.c)), L);
    sim.run(0.01, new Map([["in", L]]));
    assert.equal(sim.level(u.get(pins.c)), H);
  });

  test(`${ref}, Spice Lite: the output carries no more than CTR × IF`, () => {
    /** The collector's voltage with the LED fed through `rin`, at `ctr`. */
    const collector = (rin, ctr, level = H) => {
      const { b, u } = opto(ref, pins);
      b.doc.components.find((c) => c.id === "u1").params = partDef(ref).normalizeParams({ ctr }); // prettier-ignore
      b.doc.components.find((c) => c.id === "r1").params = { ohms: rin };
      const sim = runner(b.doc, { engine: "spice" });
      sim.run(0, new Map([["in", level]]));
      return voltsAt(sim, b, u.get(pins.c));
    };
    // 12 V through 470 Ω: IF ≈ 23 mA, past the 12 mA the 1 kΩ lets through
    // — saturated.
    assert.ok(collector(470, 100) < 0.5);
    // Through 4.7 kΩ, IF ≈ 2.3 mA, where the CTR has fallen to about 0.74 of
    // its setting (spice/analog-devices.js OPTO_TRANSFER): at 100 % the
    // transistor carries about 1.7 mA, and the collector sits near
    // 12 − 1.7 = 10.3 V; at 300 % three times as much; dark, nothing at all.
    const at100 = collector(4700, 100);
    assert.ok(at100 > 9 && at100 < 10.5, `CTR-limited: ${at100} V`);
    const at300 = collector(4700, 300);
    assert.ok(Math.abs(12 - at300 - 3 * (12 - at100)) < 0.3, `×3: ${at300} V`);
    assert.ok(collector(470, 100, L) > 11.9, "dark: open");
  });
}

test("an optocoupler's CTR falls below 5 mA of LED current, one curve for both", () => {
  // The two sheets' curves, each relative to its own 5 mA, meet in their
  // mean: 0.51 at 1 mA, 0.32 at 0.5 mA, 0.09 at 0.1 mA; the CTR set holds
  // from 5 mA up.
  const rel = (ma) => optoTransfer(ma / 1000) / (ma / 1000);
  for (const [ma, want] of [
    [0.1, 0.09],
    [0.5, 0.32],
    [1, 0.51],
    [2, 0.725],
    [5, 1],
    [10, 1],
    [40, 1],
  ]) {
    // prettier-ignore
    assert.ok(Math.abs(rel(ma) - want) < 1e-9, `${ma} mA: ${rel(ma)}`);
  }
  assert.equal(optoTransfer(0), 0, "dark");
  // What it carries only ever rises with the LED's current.
  for (let k = 1; k < OPTO_TRANSFER.length; k++) {
    assert.ok(OPTO_TRANSFER[k][1] > OPTO_TRANSFER[k - 1][1]);
  }
});

test("an optocoupler's CTR is stored only off its default", () => {
  const def = partDef("4N35");
  assert.deepEqual(def.normalizeParams({ ctr: 100 }), {});
  assert.deepEqual(def.normalizeParams({ ctr: 200 }), { ctr: 200 });
  assert.deepEqual(def.normalizeParams({ ctr: 7 }), {});
});

// ── LM358 ─────────────────────────────────────────────────────────────────

/** An LM358 on `volts`: unit 1's IN+ on signal "p" or a divider, IN− on a
    divider to half the supply or fed back. */
function opAmp({ volts = 9, gain = false } = {}) {
  const b = bench({ volts });
  const u = b.seat("u1", "LM358", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(4));
  // IN+ from a divider: 1k over 2k from + (a third of the supply, below).
  const ra = b.seat("ra", "resistor", "a30", { ohms: 2000 });
  const rb = b.seat("rb", "resistor", "a40", { ohms: 1000 });
  b.vcc(ra.get(1));
  b.link(ra.get(2), u.get(3));
  b.link(rb.get(1), u.get(3));
  b.gnd(rb.get(2));
  if (gain) {
    const rf = b.seat("rf", "resistor", "a50", { ohms: 10000 });
    const rg = b.seat("rg", "resistor", "f50", { ohms: 10000 });
    b.link(rf.get(1), u.get(1));
    b.link(rf.get(2), u.get(2));
    b.link(rg.get(1), u.get(2));
    b.gnd(rg.get(2));
  } else {
    b.signal("n", u.get(2), "low");
  }
  return { b, u };
}

test("LM358, logic engine: a comparator of its inputs' levels", () => {
  const b = bench({ volts: 9 });
  const u = b.seat("u1", "LM358", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(4));
  b.signal("p", u.get(3), "low");
  b.signal("n", u.get(2), "low");
  const sim = runner(b.doc);
  for (const [p, n, out] of [
    [H, L, H],
    [L, H, L],
    [H, H, X],
    [L, L, X],
  ]) {
    sim.run(
      0,
      new Map([
        ["p", p],
        ["n", n],
      ]),
    );
    assert.equal(sim.level(u.get(1)), out, `${p} ${n}`);
  }
});

test("LM358, Spice Lite: gain 2 from two 10k, and its output stops 1.5 V short of the supply", () => {
  const { b, u } = opAmp({ gain: true });
  const sim = runner(b.doc, { engine: "spice" });
  sim.run(0);
  const vin = voltsAt(sim, b, u.get(3));
  const vout = voltsAt(sim, b, u.get(1));
  assert.ok(Math.abs(vin - 3) < 0.01, `IN+ ${vin} V`);
  assert.ok(Math.abs(vout - 2 * vin) < 0.01, `OUT ${vout} V`);
  // As a comparator with IN− at 0 V the output swings to its top: the
  // supply less 1.5 V.
  const c = opAmp();
  const sim2 = runner(c.b.doc, { engine: "spice" });
  sim2.run(0, new Map([["n", L]]));
  const top = voltsAt(sim2, c.b, c.u.get(1));
  assert.ok(Math.abs(top - 7.5) < 0.05, `HIGH ${top} V`);
  sim2.run(0.01, new Map([["n", H]]));
  assert.ok(voltsAt(sim2, c.b, c.u.get(1)) < 0.05, "LOW near ground");
});

// The op-amp's law in the solve (spice/analog-devices.js): its slope read
// analytically, never a step apart, and a Newton step cut where it would
// carry the output across a corner of its swing — the band between its two
// saturations is tens of microvolts of input wide. A Schmitt trigger's fold
// (network.js `swingRetry`) is proved on the shipped AC examples
// (spice-ac-examples.test.js).

/** An LM358 unit as the solve's "a" branch, on nets named for its pins. */
const opAmpBranch = () => ({
  inp: "p",
  inn: "n",
  out: "o",
  vcc: "v",
  gnd: "g",
  amp: partDef("LM358").opAmps.model,
});

test("an op-amp's slope is its law's own, piece by piece", () => {
  const br = opAmpBranch();
  const { gain, rOut } = br.amp;
  const at = (volts) => (node) => volts[node];
  // In its band (5 µV in: the raw level 0.5 V above the swing's middle),
  // sourcing a few mA into its output.
  const band = at({ v: 5, g: 0, n: 1, p: 1 + 5e-6, o: 2 });
  assert.equal(opAmpSlope(br, "o", "p", band), gain / rOut);
  assert.equal(opAmpSlope(br, "o", "n", band), -gain / rOut);
  assert.equal(opAmpSlope(br, "o", "o", band), -1 / rOut);
  // The swing's middle follows its supply: half of it reaches the output.
  assert.equal(opAmpSlope(br, "o", "v", band), 0.5 / rOut);
  // What it sources comes out of VCC; GND carries none of it.
  assert.equal(opAmpSlope(br, "v", "p", band), -gain / rOut);
  assert.equal(opAmpSlope(br, "g", "p", band), 0);
  // Saturated HIGH (a millivolt in): its inputs move nothing, its top does.
  const high = at({ v: 5, g: 0, n: 1, p: 1.001, o: 3.4 });
  assert.equal(opAmpSlope(br, "o", "p", high), 0);
  assert.equal(opAmpSlope(br, "o", "v", high), 1 / rOut);
  assert.equal(opAmpSlope(br, "o", "o", high), -1 / rOut);
  // At its current limit nothing moves it at all.
  const limited = at({ v: 5, g: 0, n: 1, p: 1.001, o: 0 });
  assert.equal(opAmpSlope(br, "o", "o", limited), 0);
  assert.equal(opAmpSlope(br, "o", "p", limited), 0);
  // ON the top of the swing, the piece is the one the move enters.
  const mid = (br.amp.lowV + (5 - br.amp.headroomV)) / 2;
  const edge = at({ v: 5, g: 0, n: 0, p: (5 - br.amp.headroomV - mid) / gain, o: 3.4 }); // prettier-ignore
  assert.equal(opAmpSlope(br, "o", "p", edge, 1), 0, "moving up: saturated");
  assert.ok(Math.abs(opAmpSlope(br, "o", "p", edge, -1) - gain / rOut) < 1e-6, "moving down: in the band"); // prettier-ignore
});

test("a Newton step is cut where it carries an op-amp's output across a corner", () => {
  const br = opAmpBranch();
  const { gain, lowV, headroomV } = br.amp;
  const lo = lowV;
  const hi = 5 - headroomV;
  const mid = (lo + hi) / 2;
  const volts = { v: 5, g: 0, n: 1, p: 1, o: mid };
  const vAt = (node) => volts[node];
  const by = (moves) => (node) => moves[node] ?? 0;
  // A microvolt on IN+ moves the raw level a tenth of a volt: inside the
  // band, uncut.
  assert.equal(opAmpStepCut(br, vAt, by({ p: 1e-6 })), 1);
  // A tenth of a millivolt would carry it 10 V, through the top of the
  // swing (its output carried along, so no current limit comes first): cut
  // a hair past the corner — a microvolt of its raw level, a ten-millionth
  // of this step.
  const up = opAmpStepCut(br, vAt, by({ p: 1e-4, o: 10 }));
  const corner = (hi - mid) / (gain * 1e-4);
  assert.ok(up > corner && up - corner < 2e-7, `up: ${up}, corner ${corner}`);
  // And down through the bottom.
  const down = opAmpStepCut(br, vAt, by({ n: 1e-4, o: -10 }));
  const floor = (mid - lo) / (gain * 1e-4);
  assert.ok(down > floor && down - floor < 2e-7, `down: ${down}, floor ${floor}`); // prettier-ignore
  // Its output left where it stands, the same step reaches its source
  // limit first, along the linear piece it is on: sourceA·rOut of raw
  // level, long before the corner.
  const sourcing = opAmpStepCut(br, vAt, by({ p: 1e-4 }));
  const source = (br.amp.sourceA * br.amp.rOut) / (gain * 1e-4);
  assert.ok(sourcing > source && sourcing - source < 2e-7, `sourcing: ${sourcing}, limit ${source}`); // prettier-ignore
  // Saturated at the top, an input carried past its crossing is cut at
  // the corner it leaves by, not at a current the end of the step reads.
  volts.p = 1.001;
  const leaving = opAmpStepCut(br, vAt, by({ n: 2e-3 }));
  const out = (1e-3 - (hi - mid) / gain) / 2e-3;
  assert.ok(leaving > out && leaving - out < 1e-6, `leaving: ${leaving}, corner ${out}`); // prettier-ignore
  volts.p = 1;
  // In its band, its output dragged a volt down toward its source limit:
  // cut where it reaches it, sourceA·rOut along.
  const dragged = opAmpStepCut(br, vAt, by({ o: -1 }));
  const limit = br.amp.sourceA * br.amp.rOut;
  assert.ok(Math.abs(dragged - limit) < 1e-5, `at the limit: ${dragged}`);
});

// ── LM339 ─────────────────────────────────────────────────────────────────

/** An LM339 on `volts`, unit 1's IN+ on signal "p" (or a 1k/2k divider,
    a third of the supply), IN− on signal "n"; 1OUT pulled up through `pull`
    to the supply — or, given `pullTo`, to a second supply of that many
    volts — or not at all (`pull` null). */
function comparator({
  volts = 9,
  pull = 10000,
  pullTo = null,
  divider = false,
} = {}) {
  const b = bench({ volts });
  const u = b.seat("u1", "LM339", "e10");
  b.vcc(u.get(3));
  b.gnd(u.get(12));
  if (divider) {
    const ra = b.seat("ra", "resistor", "a30", { ohms: 2000 });
    const rb = b.seat("rb", "resistor", "a40", { ohms: 1000 });
    b.vcc(ra.get(1));
    b.link(ra.get(2), u.get(7));
    b.link(rb.get(1), u.get(7));
    b.gnd(rb.get(2));
  } else {
    b.signal("p", u.get(7), "low");
  }
  b.signal("n", u.get(6), "low");
  if (pull != null) {
    const rp = b.seat("rp", "resistor", "f40", { ohms: pull });
    b.link(rp.get(1), u.get(1));
    if (pullTo == null) b.vcc(rp.get(2));
    else {
      b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 20, y: 30, params: { volts: pullTo } }); // prettier-ignore
      b.doc.wires.push(
        { id: "wp1", from: "psu2.+", to: b.at(rp.get(2)), color: "red" },
        { id: "wp2", from: "psu2.-", to: "psu1.-", color: "black" },
      );
    }
  }
  return { b, u };
}

const levels = (p, n) =>
  new Map([
    ["p", p],
    ["n", n],
  ]);

test("LM339, logic engine: an open-collector comparator of its inputs' levels", () => {
  const { b, u } = comparator();
  const sim = runner(b.doc);
  for (const [p, n, out] of [
    [H, L, H], // let go: the pull-up's
    [L, H, L],
    [H, H, X],
    [L, L, X],
  ]) {
    sim.run(0, levels(p, n));
    assert.equal(sim.level(u.get(1)), out, `${p} ${n}`);
  }
  // With no pull-up, let go is no drive at all.
  const bare = comparator({ pull: null });
  const sim2 = runner(bare.b.doc);
  sim2.run(0, levels(H, L));
  assert.equal(sim2.level(bare.u.get(1)), "Z");
});

test("LM339, Spice Lite: it sinks on its saturation line to its limit, and sources nothing", () => {
  const { lowV, rOut, sinkA } = partDef("LM339").opAmps.model;
  for (const [pull, want] of [
    [10000, null], // on its line: lowV + I·rOut
    [100, 9 - sinkA * 100], // against its 16 mA
  ]) {
    const { b, u } = comparator({ pull, divider: true });
    const sim = runner(b.doc, { engine: "spice" });
    sim.run(0, new Map([["n", L]]));
    // IN+ (3 V) over IN− (0 V): let go, at the pull-up's 9 V.
    assert.ok(Math.abs(voltsAt(sim, b, u.get(1)) - 9) < 1e-3, `${pull}: released`); // prettier-ignore
    sim.run(0.01, new Map([["n", H]]));
    const v = voltsAt(sim, b, u.get(1));
    const line = (9 - lowV) / (pull + rOut);
    const expect = want ?? lowV + line * rOut;
    assert.ok(Math.abs(v - expect) < 1e-3, `${pull}: ${v} V, not ${expect}`);
  }
});

test("LM339, Spice Lite: let go, its pin is its pull-up's — above its own supply too", () => {
  const { b, u } = comparator({ volts: 5, pullTo: 12, divider: true });
  const sim = runner(b.doc, { engine: "spice" });
  sim.run(0, new Map([["n", L]]));
  assert.ok(Math.abs(voltsAt(sim, b, u.get(1)) - 12) < 1e-3, "at 12 V");
  sim.run(0.01, new Map([["n", H]]));
  assert.ok(voltsAt(sim, b, u.get(1)) < 0.1, "sinking");
  // No pull-up: nothing holds the pin while it is let go, so it has no
  // voltage — it floats, and a 74LS input on it reads HIGH, as the logic
  // engine says.
  const bare = comparator({ volts: 5, pull: null });
  const t = bare.b.seat("t1", "74LS04", "e40");
  bare.b.vcc(t.get(14));
  bare.b.gnd(t.get(7));
  bare.b.link(t.get(1), bare.u.get(1));
  const sim2 = runner(bare.b.doc, { engine: "spice" });
  sim2.run(0, levels(H, L));
  assert.equal(voltsAt(sim2, bare.b, bare.u.get(1)), undefined);
  assert.equal(sim2.level(t.get(2)), L);
  sim2.run(0.01, levels(L, H));
  assert.ok(voltsAt(sim2, bare.b, bare.u.get(1)) < 0.1, "sinking a 74LS input");
  assert.equal(sim2.level(t.get(2)), H);
});

test("LM339: two outputs tied are a wired-AND in both engines", () => {
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "LM339", "e10");
  b.vcc(u.get(3));
  b.gnd(u.get(12));
  b.signal("p1", u.get(7), "low");
  b.signal("n1", u.get(6), "low");
  b.signal("p2", u.get(5), "low");
  b.signal("n2", u.get(4), "low");
  const rp = b.seat("rp", "resistor", "f40", { ohms: 10000 });
  b.vcc(rp.get(2));
  b.link(rp.get(1), u.get(1));
  b.link(u.get(1), u.get(2));
  for (const engine of ["digital", "spice"]) {
    const sim = runner(b.doc, { engine });
    let t = 0;
    for (const [one, two, out] of [
      [true, true, H],
      [true, false, L],
      [false, true, L],
      [false, false, L],
    ]) {
      const r = sim.run((t += 0.01), new Map([["p1", one ? H : L], ["n1", one ? L : H], ["p2", two ? H : L], ["n2", two ? L : H]])).result; // prettier-ignore
      assert.equal(sim.level(u.get(1)), out, `${engine} ${one} ${two}`);
      assert.ok(!r.warnings.some((w) => w.type === "conflict"), `${engine}: no fight`); // prettier-ignore
    }
  }
});

test("LM339, Spice Lite: a Schmitt trigger switches at its two thresholds on a triangle", () => {
  // IN− on a 10 Hz triangle (0–5 V); IN+ at 2.5 V through 10k ‖ 10k, 100k
  // from 1OUT, 1OUT pulled up through 10k. Let go, 1OUT stands at 4.78 V
  // (21.7 µA through 115k) and IN+ at 2.609 V; sinking (63 mV), IN+ is 2.384.
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "LM339", "e10");
  b.vcc(u.get(3));
  b.gnd(u.get(12));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 10, wave: "triangle" }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at("a6"), color: "blue" },
  );
  b.link("a6", u.get(6));
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 10000 });
  const r2 = b.seat("r2", "resistor", "a40", { ohms: 10000 });
  const rf = b.seat("rf", "resistor", "a50", { ohms: 100000 });
  const rp = b.seat("rp", "resistor", "f50", { ohms: 10000 });
  b.vcc(r1.get(1));
  b.link(r1.get(2), u.get(7));
  b.link(r2.get(1), u.get(7));
  b.gnd(r2.get(2));
  b.link(rf.get(1), u.get(7));
  b.link(rf.get(2), u.get(1));
  b.link(rp.get(1), u.get(1));
  b.vcc(rp.get(2));
  const { lowV, rOut } = partDef("LM339").opAmps.model;
  // Let go: 5 V through 10k + 100k + 5k to 2.5 V; sinking: from lowV (plus
  // what the 10k pull-up puts through rOut) through 100k + 5k.
  const up = 2.5 + (2.5 / 115e3) * 5e3;
  const low = lowV + (5 / 10e3) * rOut;
  const down = 2.5 - ((2.5 - low) / 105e3) * 5e3;
  let last = null;
  const flips = [];
  driveSpice(b.doc, {
    seconds: 0.5,
    onTick(now, result, input) {
      const net = (h) => input.netlist.netOfPoint.get(b.at(h));
      const high = result.nodeVolts.get(net(u.get(1))) > 2.5;
      if (last !== null && high !== last) flips.push({ high, inn: result.nodeVolts.get(net(u.get(6))) }); // prettier-ignore
      last = high;
    },
  });
  assert.ok(flips.length >= 8, `${flips.length} flips`);
  for (const f of flips) {
    const want = f.high ? down : up;
    assert.ok(Math.abs(f.inn - want) < 2e-3, `${f.high ? "up" : "down"} at ${f.inn} V, not ${want}`); // prettier-ignore
  }
});

test("an open collector's law: it never sources, and holds its pin only while it sinks", () => {
  const br = {
    kind: "a",
    inp: "p",
    inn: "n",
    out: "o",
    vcc: "v",
    gnd: "g",
    amp: partDef("LM339").opAmps.model,
  };
  const at = (volts) => (node) => volts[node];
  // Let go (IN+ above IN−), its pin pulled to 12 V on a 5 V supply: no
  // current either way, no slope, nothing held.
  const off = at({ v: 5, g: 0, p: 2, n: 1, o: 12 });
  assert.deepEqual(
    analogCurrents(br, off).map(([, i]) => i),
    [0, -0, 0],
  );
  for (const t of ["o", "p", "n", "v"]) assert.equal(opAmpSlope(br, "o", t, off), 0, t); // prettier-ignore
  assert.deepEqual(heldOutright(br), []);
  assert.deepEqual(analogHeldThrough(br, "g", off), []);
  // Sinking (IN− above IN+): from its pin into its ground, and its ground
  // holds its pin.
  const on = at({ v: 5, g: 0, p: 1, n: 2, o: 1 });
  const [[, out], [, vcc], [, gnd]] = analogCurrents(br, on);
  assert.ok(Math.abs(out + br.amp.sinkA) < 1e-12, `sinks ${out}`);
  assert.equal(vcc, -0);
  assert.ok(Math.abs(gnd - br.amp.sinkA) < 1e-12);
  assert.deepEqual(analogHeldThrough(br, "g", on), ["o", "g"]);
  // An LM358 unit still holds its output outright.
  assert.deepEqual(heldOutright({ ...br, amp: partDef("LM358").opAmps.model }), ["o"]); // prettier-ignore
});

test("the LM339 examples do what their captions say under Spice Lite", () => {
  const payload = JSON.parse(readFileSync(new URL("../../demos/LM339.json", import.meta.url), "utf8")); // prettier-ignore
  const desk = (name) => structuredClone(exampleDesktops("LM339", payload).find((d) => d.name === `LM339 ${name} example`).doc); // prettier-ignore
  const led = (doc) => doc.components.find((c) => c.ref === "led").id;
  // The window: lit only while the wiper is between a third and two thirds
  // of the supply.
  for (const [position, lit] of [
    [10, false],
    [30, false],
    [40, true],
    [50, true],
    [60, true],
    [70, false],
    [90, false],
  ]) {
    const doc = desk("Window comparator");
    doc.components.find((c) => c.ref === "pot").params.position = position;
    const { result } = driveSpice(doc, { seconds: 0.01 });
    assert.equal(result.lamps.get(led(doc)).lit, lit, `at ${position} %`);
  }
  // The oscillator: blinking, every 1.4 s or so.
  const doc = desk("Oscillator");
  const id = led(doc);
  let was = null;
  const flips = [];
  driveSpice(doc, {
    seconds: 6,
    onTick(now, r) {
      const on = r.lamps.get(id).lit;
      if (was !== null && on !== was) flips.push(now);
      was = on;
    },
  });
  assert.ok(flips.length >= 6, `${flips.length} flips`);
  const period = flips.at(-1) - flips.at(-3);
  assert.ok(period > 1.3 && period < 1.6, `period ${period} s`);
});

// ── Regulators ────────────────────────────────────────────────────────────

/** A regulator `ref` fed from the bench's supply (`volts`), a 74LS04 on its
    output with its input tied low, and `ohms` (if any) from OUT to −. */
function regulated(ref, { volts = 9, ohms = null } = {}) {
  const b = bench({ volts });
  const g = b.seat("g1", ref, "a50");
  const r = partDef(ref).regulator.pins;
  b.vcc(g.get(r.inp));
  const u = b.seat("u1", "74LS04", "e10");
  b.link(g.get(r.out), u.get(14));
  b.gnd(u.get(7));
  b.gnd(u.get(1));
  if (!partDef(ref).regulator.adjustable) b.gnd(g.get(r.ref));
  if (ohms) {
    const rl = b.seat("rl", "resistor", "a30", { ohms });
    b.link(rl.get(1), g.get(r.out));
    b.gnd(rl.get(2));
  }
  return { b, g, u };
}

test("a 78xx, logic engine: its output is a supply while its input is 2 V above it", () => {
  for (const [volts, powered] of [
    [9, true],
    [12, true],
    [5, false],
  ]) {
    const { b, u } = regulated("LM7805", { volts });
    const sim = runner(b.doc);
    const r = sim.run(0).result;
    assert.equal(r.chipStatus.get("u1").status, powered ? "ok" : "unpowered", `${volts} V`); // prettier-ignore
    if (powered) assert.equal(sim.level(u.get(2)), H);
  }
});

test("regulators chain: a 7805 fed by a 7812's output", () => {
  const b = bench({ volts: 15 });
  const g12 = b.seat("g1", "LM7812", "a50");
  const g5 = b.seat("g2", "LM7805", "a40");
  b.vcc(g12.get(1));
  b.gnd(g12.get(2));
  b.link(g12.get(3), g5.get(1));
  b.gnd(g5.get(2));
  const u = b.seat("u1", "74LS04", "e10");
  b.link(g5.get(3), u.get(14));
  b.gnd(u.get(7));
  const r = runner(b.doc).run(0).result;
  assert.equal(r.chipStatus.get("u1").status, "ok");
});

test("an LM317's output is what its two resistors set", () => {
  const b = bench({ volts: 9 });
  const g = b.seat("g1", "LM317", "a50"); // ADJ · OUT · IN
  b.vcc(g.get(3));
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 240 });
  const r2 = b.seat("r2", "resistor", "a40", { ohms: 390 });
  b.link(r1.get(1), g.get(2));
  b.link(r1.get(2), g.get(1));
  b.link(r2.get(1), g.get(1));
  b.gnd(r2.get(2));
  const netlist = buildNetlist(b.doc);
  const [reg] = regulatorFacts(b.doc, netlist);
  const minus = new Set([netlist.netOfPoint.get("psu1.-")]);
  const want = 1.25 * (1 + 390 / 240) + 50e-6 * 390;
  assert.ok(Math.abs(regulatorVolts(reg, minus) - want) < 1e-9);
  const sim = runner(b.doc, { engine: "spice" });
  sim.run(0);
  const out = voltsAt(sim, b, g.get(2));
  assert.ok(Math.abs(out - want) < 0.01, `${out} V vs ${want}`);
});

test("a 7805, Spice Lite: 5 V out, dropout, its current limit and its heat", () => {
  // Light load: 5 V.
  let { b, g } = regulated("LM7805", { ohms: 1000 });
  let sim = runner(b.doc, { engine: "spice" });
  let r = sim.run(0).result;
  assert.ok(Math.abs(voltsAt(sim, b, g.get(3)) - 5) < 0.01);
  assert.ok(!r.warnings.some((w) => w.type.startsWith("regulator-")), r.warnings.map((w) => w.type).join()); // prettier-ignore
  // 6 V in: dropout, 4 V out.
  ({ b, g } = regulated("LM7805", { volts: 5, ohms: 1000 }));
  b.doc.components[0].params.volts = 6;
  sim = runner(b.doc, { engine: "spice" });
  r = sim.run(0).result;
  // Said once it has stood SUSTAIN_S (an inrush is milliseconds of it).
  assert.ok(!r.warnings.some((w) => w.type === "regulator-dropout"));
  assert.ok(Math.abs(r.wakeAt - SUSTAIN_S) < 1e-9, `woken at ${r.wakeAt}`);
  r = sim.run(SUSTAIN_S).result;
  assert.ok(r.warnings.some((w) => w.type === "regulator-dropout"));
  // 1.2 W (9 V in, 300 mA): hot.
  ({ b, g } = regulated("LM7805"));
  addLoad(b, { mode: "cc", amps: 0.3 }, b.at(g.get(3)));
  b.doc.wires.find((w) => w.to === b.at(g.get(3))).to = "bb1.e52"; // the OUT node's free hole
  sim = runner(b.doc, { engine: "spice" });
  r = sim.run(0).result;
  // Said at the second tick running past the figure, never off one instant,
  // and once it has stood SUSTAIN_S.
  assert.ok(!r.warnings.some((w) => w.type === "regulator-hot"), r.warnings.map((w) => w.type).join()); // prettier-ignore
  r = sim.run(SUSTAIN_S / 2).result;
  assert.ok(!r.warnings.some((w) => w.type === "regulator-hot"), r.warnings.map((w) => w.type).join()); // prettier-ignore
  r = sim.run(SUSTAIN_S).result;
  assert.ok(r.warnings.some((w) => w.type === "regulator-hot"), r.warnings.map((w) => w.type).join()); // prettier-ignore
  const reading = r.bench.get("g1");
  // 4 V across it at 300 mA, and the 74LS04's few mA beside.
  assert.ok(Math.abs(reading.watts - 4 * 0.3) < 0.1, `${reading.watts} W`);
});

test("a 7805 past 2 W heats up, shuts down hot, and comes back once it has cooled", () => {
  const { b } = regulated("LM7805", { volts: 15 });
  addLoad(b, { mode: "cc", amps: 0.5 }, "bb1.e52");
  const sim = runner(b.doc, { engine: "spice" });
  // Not at once: its heat lags what it dissipates by HEAT_TAU_S, and it is
  // woken where the heat will reach its shutdown.
  let r = sim.run(0).result;
  assert.ok(!r.warnings.some((w) => w.type === "regulator-shutdown"));
  const watts = r.bench.get("g1").watts;
  assert.ok(watts > 4.9, `${watts} W`);
  const due = tripIn(0, watts);
  // Woken to read its watts again every HEAT_STEP_S, the last wake on the
  // trip — and first, past 1 W, HOT_RECHECK_S on, to say it is hot.
  assert.ok(Math.abs(r.wakeAt - Math.min(due, HEAT_STEP_S, HOT_RECHECK_S, SUSTAIN_S)) < 1e-9, `woken at ${r.wakeAt}, due ${due}`); // prettier-ignore
  assert.ok(Math.abs(due - HEAT_TAU_S * Math.log(watts / (watts - REGULATOR_HEAT.shutdownW))) < 1e-9); // prettier-ignore
  r = sim.run(due - 0.01).result;
  assert.ok(
    !r.warnings.some((w) => w.type === "regulator-shutdown"),
    "not yet",
  );
  r = sim.run(due).result;
  assert.ok(
    r.warnings.some((w) => w.type === "regulator-shutdown"),
    "tripped",
  );
  const off = sim.run(due + 0.5).result;
  assert.equal(off.bench.get("g1").off, true, "off while it cools");
  // Cooled (a second on), it is on again — still hot, and still over, so it
  // trips again well inside its first heating: cycling, as a real one does.
  const back = sim.run(due + 1.2).result;
  assert.ok(back.bench.get("g1").watts > 2, "on again");
  assert.ok(!back.warnings.some((w) => w.type === "regulator-shutdown"));
  // Following its wakes, it trips again well inside its first heating.
  let at = due + 1.2;
  let next = back;
  for (
    let k = 0;
    k < 20 && !next.warnings.some((w) => w.type === "regulator-shutdown");
    k++
  ) {
    // prettier-ignore
    at = next.wakeAt;
    next = sim.run(at).result;
  }
  assert.ok(next.warnings.some((w) => w.type === "regulator-shutdown"), "trips again"); // prettier-ignore
  assert.ok(at - (due + 1.2) < due / 2, `trips again at ${at}`);
});

test("a 7805 charging 10 mF at its current limit does not shut down", () => {
  // 1.5 A at 7 V across it is 10 W, but only for the ~35 ms the capacitor
  // takes: a junction heats over seconds. (An instant trip past 2 W shut it
  // down the moment it was switched on.)
  const { b, g } = regulated("LM7805", { volts: 12, ohms: 100 });
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 0.01 });
  b.link(c.get(1), g.get(3));
  b.gnd(c.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  let limited = false;
  for (let k = 0; k <= 40; k++) {
    const r = sim.run(k * 0.005).result;
    limited ||= r.bench.get("g1").limited;
    assert.ok(!r.warnings.some((w) => w.type === "regulator-shutdown"), `at ${k * 5} ms`); // prettier-ignore
  }
  assert.ok(limited, "it charged at its limit");
  assert.ok(Math.abs(voltsAt(sim, b, g.get(3)) - 5) < 0.01, "and regulates");
});

test("…nor when nothing else wakes the board after it has charged", () => {
  // Ticked only at its own wakes: the last tick of the charge read 6 W, and
  // the next was the trip that power predicted, four seconds on — booked at
  // 6 W all the way, it shut down hot with 0.25 W in it.
  const { b, g } = regulated("LM7805", { volts: 9, ohms: 100 });
  b.doc.components[0].params.currentLimit = 5;
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 0.01 });
  b.link(c.get(1), g.get(3));
  b.gnd(c.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  let t = 0;
  for (let k = 0; k < 400 && t < 10; k++) {
    const r = sim.run(t).result;
    assert.ok(!r.warnings.some((w) => w.type === "regulator-shutdown"), `shut down at ${t} s`); // prettier-ignore
    if (r.wakeAt == null) break;
    assert.ok(r.wakeAt - t <= HEAT_STEP_S + 1e-9 || r.bench.get("g1").watts < 2, `a ${r.wakeAt - t} s stretch at ${r.bench.get("g1").watts} W`); // prettier-ignore
    t = r.wakeAt;
  }
  assert.ok(Math.abs(voltsAt(sim, b, g.get(3)) - 5) < 0.01);
});

test("a 7805 at its 1.5 A limit droops", () => {
  const { b, g } = regulated("LM7805", { volts: 9 });
  addLoad(b, { mode: "cr", ohms: 2 }, "bb1.e52");
  b.doc.components[0].params.currentLimit = 5;
  const sim = runner(b.doc, { engine: "spice" });
  const r = sim.run(0).result;
  const out = voltsAt(sim, b, g.get(3));
  assert.ok(Math.abs(out - 3) < 0.05, `1.5 A × 2 Ω: ${out} V`);
  assert.ok(r.bench.get("g1").limited);
});

test("a regulator's quiescent current: all of it from QUIESCENT_HEAD_V up, a line through zero below", () => {
  const reg = partDef("LM7805").regulator.model({});
  const br = { kind: "g", inp: "in", ref: "gnd", out: "out", reg };
  const at = (vin, vref) => (n) => ({ in: vin, gnd: vref, out: vref })[n];
  const iq = (vin, vref) => regulatorQuiescent(br, at(vin, vref));
  const head = QUIESCENT_HEAD_V;
  assert.ok(head !== reg.dropoutV, "off the corner where it starts to source");
  assert.equal(iq(0, 0), 0);
  assert.equal(iq(head / 2, 0), reg.quiescentA / 2);
  assert.equal(iq(head, 0), reg.quiescentA);
  assert.equal(iq(12, 3), reg.quiescentA);
  // REF above IN: back the other way, as through a resistance.
  assert.equal(iq(0, head / 2), -reg.quiescentA / 2);
  assert.equal(regulatorQuiescent({ ...br, off: true }, at(12, 0)), 0, "shut down"); // prettier-ignore
  // And it is the current the device puts on IN and REF.
  const flows = new Map(analogCurrents(br, at(head / 2, 0)));
  assert.equal(flows.get("gnd"), reg.quiescentA / 2);
});

test("a 7805 whose GND returns nowhere floats — it does not run away", () => {
  // IN on +, OUT into 10 kΩ and 1 mF, both back to GND — and GND to
  // nothing else (a bridge's − left off the regulator's ground rail). Its
  // quiescent current used to flow regardless, and with no return the solve
  // left GND at Iq / GMIN, 5 GV more every tick. Now it floats somewhere
  // around IN (no current, so the solve cannot say exactly where) and stays.
  const b = bench({ volts: 9 });
  const g = b.seat("g1", "LM7805", "a50");
  b.vcc(g.get(1));
  const rl = b.seat("rl", "resistor", "a30", { ohms: 10000 });
  b.link(rl.get(1), g.get(3));
  b.link(rl.get(2), g.get(2));
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 1e-3 });
  b.link(c.get(1), g.get(3));
  b.link(c.get(2), g.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  const first = new Map();
  for (const t of [0, 0.001, 0.01, 0.1, 1]) {
    sim.run(t);
    for (const pin of [2, 3]) {
      const v = voltsAt(sim, b, g.get(pin));
      assert.ok(Number.isFinite(v) && Math.abs(v) < 18, `pin ${pin} at ${t} s: ${v} V`); // prettier-ignore
      if (!first.has(pin)) first.set(pin, v);
      assert.ok(Math.abs(v - first.get(pin)) < 1e-3, `pin ${pin} moved by ${t} s: ${v} V`); // prettier-ignore
    }
  }
});

test("a 7805 with its GND wired to nothing rises to its input less its dropout, and says why", () => {
  // IN on 9 V, OUT into 100 Ω to the supply's −, GND in a hole of its own.
  // On the bench its output climbs towards its input; read against that
  // GND (which the solve leaves up at IN) it read −2 V, "in dropout".
  const b = bench({ volts: 9 });
  const g = b.seat("g1", "LM7805", "a50");
  b.vcc(g.get(1));
  const rl = b.seat("rl", "resistor", "a30", { ohms: 100 });
  b.link(rl.get(1), g.get(3));
  b.gnd(rl.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  const r = sim.run(0).result;
  const reg = partDef("LM7805").regulator.model({});
  const out = voltsAt(sim, b, g.get(3));
  assert.ok(Math.abs(out - (9 - reg.dropoutV)) < 0.01, `${out} V`);
  const reading = r.bench.get("g1");
  assert.equal(reading.open, true);
  assert.equal(reading.dropout, false);
  assert.ok(Math.abs(reading.volts - out) < 1e-9, "against the desk's ground");
  const w = r.warnings.find((x) => x.type === "regulator-open");
  assert.ok(w && Math.abs(w.volts - out) < 1e-9);
  assert.ok(!r.warnings.some((x) => x.type === "regulator-dropout"));
  // GND to nothing a DC current can take — a dangling 1 kΩ, a 10 µF to
  // ground once charged — is as open.
  for (const [what, hang] of [
    ["dangling 1 kΩ", (h, gnd) => { const r = h.seat("rg", "resistor", "a10", { ohms: 1000 }); h.link(r.get(1), gnd); }], // prettier-ignore
    ["10 µF to ground", (h, gnd) => { const c = h.seat("cg", "cap-electrolytic", "a10", { farads: 10e-6 }); h.link(c.get(1), gnd); h.gnd(c.get(2)); }], // prettier-ignore
  ]) {
    const h = bench({ volts: 9 });
    const hg = h.seat("g1", "LM7805", "a50");
    h.vcc(hg.get(1));
    const hl = h.seat("rl", "resistor", "a30", { ohms: 100 });
    h.link(hl.get(1), hg.get(3));
    h.gnd(hl.get(2));
    hang(h, hg.get(2));
    const hs = runner(h.doc, { engine: "spice" });
    let res = hs.run(0).result;
    for (let k = 0; k < 20 && res.wakeAt != null && res.wakeAt < 1; k++) res = hs.run(res.wakeAt).result; // prettier-ignore
    res = hs.run(1).result;
    assert.equal(res.bench.get("g1").open, true, what);
    assert.ok(Math.abs(res.bench.get("g1").volts - (9 - reg.dropoutV)) < 0.01, `${what}: ${res.bench.get("g1").volts} V`); // prettier-ignore
    assert.ok(!res.warnings.some((x) => x.type === "regulator-dropout"), what);
  }
  // Grounded, it is a 7805 again.
  const { b: ok } = regulated("LM7805", { ohms: 100 });
  const fine = runner(ok.doc, { engine: "spice" }).run(0).result;
  assert.equal(fine.bench.get("g1").open, false);
  assert.ok(!fine.warnings.some((x) => x.type === "regulator-open"));
});

test("a 7805 off a 1 A supply charges 1 mF and comes up to 5 V", () => {
  // At its set 9 V the regulator draws its 1.5 A, past the supply's 1 A;
  // pulled down in proportion, to 5.98 V, its input left it nothing to give
  // its output past 3.98 V — so it drew nothing there, and the supply was
  // put back at 5.98 V for good. Now the supply sits where the draw meets
  // its limit (spice/supply.js `droopVolts`), and lets go once it is charged.
  const b = bench({ volts: 9 });
  const g = b.seat("g1", "LM7805", "a50");
  b.vcc(g.get(1));
  b.gnd(g.get(2));
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 1e-3 });
  b.link(c.get(1), g.get(3));
  b.gnd(c.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  runTo(sim, 0, 0.02);
  sim.run(0.02);
  assert.ok(Math.abs(voltsAt(sim, b, g.get(3)) - 5) < 0.01, `${voltsAt(sim, b, g.get(3))} V`); // prettier-ignore
  assert.equal([...sim.result.supplies.values()][0].limited, false);
});

test("a 7805 charging 1 mF with a load off a 1 A supply: constant current, then constant voltage", () => {
  // The supply's limit is the solve's (spice/analog-devices.js "p"): its +
  // sits where the regulator's input draws exactly 1 A, the output climbing
  // at (1 A − its own load) / 1 mF, until it is up. Booked as a droop at the
  // set voltage it locked at 3.98 V (with a load nothing ever leaves dropout).
  const b = bench({ volts: 9 });
  const g = b.seat("g1", "LM7805", "a50");
  b.vcc(g.get(1));
  b.gnd(g.get(2));
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 1e-3 });
  b.link(c.get(1), g.get(3));
  b.gnd(c.get(2));
  const rl = b.seat("rl", "resistor", "a30", { ohms: 100 });
  b.link(rl.get(1), g.get(3));
  b.gnd(rl.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  const seen = runTo(sim, 0, 0.003);
  sim.run(0.003);
  const psu = sim.result.supplies.get("psu1");
  assert.equal(psu.limited, true, "on its limit");
  assert.ok(Math.abs(psu.amps - 1) < 1e-6, `delivering ${psu.amps} A`);
  // Its + is the output plus the regulator's dropout, not the set 9 V.
  assert.ok(psu.volts < 7 && psu.volts > voltsAt(sim, b, g.get(3)) + 1.5, `${psu.volts} V`); // prettier-ignore
  assert.ok(seen.length < 10, `${seen.length} ticks`);
  // Up by about 1 mF · 5 V / 0.97 A ≈ 5.2 ms, and the supply a rail again.
  runTo(sim, 0.003, 0.02);
  sim.run(0.02);
  assert.ok(Math.abs(voltsAt(sim, b, g.get(3)) - 5) < 5e-3, `OUT ${voltsAt(sim, b, g.get(3))} V`); // prettier-ignore
  assert.equal(sim.result.supplies.get("psu1").limited, false);
  assert.equal(sim.result.analog.free.size, 0, "a rail again");
});

test("a 7805 coming up from a charging input never lets its unloaded output past 5 V", () => {
  // IN charged through 10 Ω into 1 mF, OUT on nothing but 100 nF. As IN
  // crossed its dropout the linear model read the regulator ON from IN's
  // side and OFF from OUT's (each nudged alone the way it heads) — OUT
  // driven by IN with nothing to stop it — and OUT ran to 13.8 kV.
  const b = bench({ volts: 9 });
  b.doc.components[0].params.currentLimit = 5;
  const g = b.seat("g1", "LM7805", "a50");
  const r1 = b.seat("r1", "resistor", "a20", { ohms: 10 });
  b.vcc(r1.get(1));
  b.link(r1.get(2), g.get(1));
  const cin = b.seat("cin", "cap-electrolytic", "a30", { farads: 1e-3 });
  b.link(cin.get(1), g.get(1));
  b.gnd(cin.get(2));
  b.gnd(g.get(2));
  const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-7 });
  b.link(c.get(1), g.get(3));
  b.gnd(c.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  let worst = 0;
  for (const r of runTo(sim, 0, 0.05)) worst = Math.max(worst, voltsAt({ result: r, netlist: sim.netlist }, b, g.get(3))); // prettier-ignore
  sim.run(0.05);
  assert.ok(worst < 5.01, `OUT reached ${worst} V`);
  assert.ok(Math.abs(voltsAt(sim, b, g.get(3)) - 5) < 0.01);
});

// ── The relay ─────────────────────────────────────────────────────────────

/** A 5 V relay: COIL+ on +, COIL− on signal "drv", COM on +, NO (4) and
    NC (5) each 1k to −. */
function relay(coilVolts = 5) {
  const b = bench({ volts: 5 });
  const k = b.seat("k1", "relay", "a10", { coilVolts });
  b.vcc(k.get(1));
  b.signal("drv", k.get(2), "high");
  b.vcc(k.get(3));
  for (const [pin, at] of [
    [4, "a30"],
    [5, "a40"],
  ]) {
    const r = b.seat(`r${pin}`, "resistor", at, { ohms: 1000 });
    b.link(r.get(1), k.get(pin));
    b.gnd(r.get(2));
  }
  return { b, k };
}

test("relay, logic engine: COM to NO while one coil leg is HIGH and the other LOW", () => {
  const { b, k } = relay();
  const sim = runner(b.doc);
  sim.run(0, new Map([["drv", L]]));
  assert.equal(sim.level(k.get(4)), H, "NO");
  assert.equal(sim.level(k.get(5)), L, "NC");
  sim.run(0.01, new Map([["drv", H]]));
  assert.equal(sim.level(k.get(4)), L);
  assert.equal(sim.level(k.get(5)), H);
});

test("relay, Spice Lite: it pulls in once its coil's current builds, and lets go", () => {
  const { b, k } = relay();
  const sim = runner(b.doc, { engine: "spice" });
  const on = new Map([["drv", L]]);
  let r = sim.run(0, on).result;
  assert.ok(voltsAt(sim, b, k.get(4)) < 0.1, "not yet: the coil's current takes time"); // prettier-ignore
  // τ = L/R = 0.14 H / 70 Ω = 2 ms: 75 % of its rating at 2.8 ms.
  assert.ok(r.wakeAt > 0.002 && r.wakeAt < 0.0035, `pull-in wake ${r.wakeAt}`);
  runTo(sim, r.wakeAt, 0.01, on);
  sim.run(0.01, on);
  assert.ok(voltsAt(sim, b, k.get(4)) > 4.9, "pulled in");
  // Both coil legs at +5 V: its current dies round its own winding (2 ms),
  // and it lets go once that is under a tenth of its rating.
  const off = new Map([["drv", H]]);
  sim.run(0.02, off);
  assert.ok(voltsAt(sim, b, k.get(4)) > 4.9, "still in: the current is still there"); // prettier-ignore
  runTo(sim, 0.02, 0.04, off);
  sim.run(0.04, off);
  assert.ok(voltsAt(sim, b, k.get(5)) > 4.9, "let go");
});

test("a relay whose coil is shorted out asks to be ticked when it lets go", () => {
  // Both coil legs on +: no branch any more, its current dying round its own
  // winding with no curve for a crossing to be timed on — so it held its
  // contacts until something else ticked the desk.
  const { b, k } = relay();
  const sim = runner(b.doc, { engine: "spice" });
  const on = new Map([["drv", L]]);
  runTo(sim, sim.run(0, on).result.wakeAt, 0.01, on);
  sim.run(0.01, on);
  assert.ok(voltsAt(sim, b, k.get(4)) > 4.9, "pulled in");
  const off = new Map([["drv", H]]);
  const r = sim.run(0.02, off).result;
  assert.ok(voltsAt(sim, b, k.get(4)) > 4.9, "still in");
  // L/R = 2 ms, from about its rating down to its drop-out current.
  assert.ok(r.wakeAt > 0.022 && r.wakeAt < 0.03, `drop-out wake ${r.wakeAt}`);
  sim.run(r.wakeAt, off);
  assert.ok(voltsAt(sim, b, k.get(5)) > 4.9, "let go, then");
});

test("a relay's coil is an inductor of its rating", () => {
  const def = partDef("relay");
  assert.deepEqual(coilOf(def, {}), { a: 1, b: 2, henries: 0.14, ohms: 70 });
  assert.deepEqual(coilOf(def, { coilVolts: 12 }), { a: 1, b: 2, henries: 0.8, ohms: 400 }); // prettier-ignore
  assert.deepEqual(def.normalizeParams({ coilVolts: 5 }), {});
  assert.deepEqual(def.normalizeParams({ coilVolts: 12 }), { coilVolts: 12 });
});

// ── The electronic load ───────────────────────────────────────────────────

test("load, Spice Lite: constant current, constant resistance, and UNREG", () => {
  for (const [params, amps, unreg] of [
    [{ mode: "cc", amps: 0.2 }, 0.2, false],
    [{ mode: "cr", ohms: 50 }, 0.1, false],
  ]) {
    const b = bench({ volts: 5 });
    addLoad(b, params);
    const r = runner(b.doc, { engine: "spice" }).run(0).result;
    const reading = r.bench.get("load1");
    assert.ok(Math.abs(reading.amps - amps) < 1e-3, `${reading.amps} A`);
    assert.equal(reading.unreg, unreg);
    assert.ok(Math.abs(reading.watts - 5 * amps) < 0.01);
  }
  // Past the supply's limit the supply droops and the load cannot hold.
  const b = bench({ volts: 5 });
  b.doc.components[0].params.currentLimit = 0.5;
  addLoad(b, { mode: "cc", amps: 1 });
  const r = runner(b.doc, { engine: "spice" }).run(0).result;
  assert.ok(r.supplies.get("psu1").limited, "the supply at its limit");
});

test("load, Spice Lite: constant voltage pulls a supply down to its setting, and nothing below it", () => {
  // A 5 V supply limited to 1 A under CV 4 V: the supply on its limit, the
  // load holding 4 V (and its 10 mV an amp).
  const b = bench({ volts: 5 });
  b.doc.components[0].params.currentLimit = 1;
  addLoad(b, { mode: "cv", volts: 4 });
  // (Its first tick frees the supply; the next has it held at its limit.)
  const r = runTo(runner(b.doc, { engine: "spice" }), 0, 1).at(-1);
  const reading = r.bench.get("load1");
  assert.ok(r.supplies.get("psu1").limited, "the supply at its limit");
  assert.ok(Math.abs(reading.volts - (4 + 1 * LOAD_CV_OHMS)) < 2e-3, `${reading.volts} V`); // prettier-ignore
  assert.ok(Math.abs(reading.amps - 1) < 2e-3, `${reading.amps} A`);
  assert.equal(reading.unreg, false);
  // Set above the supply: it draws nothing and cannot hold (UNREG).
  const above = bench({ volts: 5 });
  addLoad(above, { mode: "cv", volts: 6 });
  const r2 = runner(above.doc, { engine: "spice" }).run(0).result;
  assert.ok(Math.abs(r2.bench.get("load1").amps) < 1e-9);
  assert.equal(r2.bench.get("load1").unreg, true);
});

test("load, Spice Lite: constant power — P / V, through a resistance too, and its 5 A ceiling", () => {
  // Straight across 5 V: 2 W is 0.4 A.
  const b = bench({ volts: 5 });
  addLoad(b, { mode: "cp", watts: 2 });
  const reading = runner(b.doc, { engine: "spice" }).run(0).result.bench.get("load1"); // prettier-ignore
  assert.ok(Math.abs(reading.watts - 2) < 2 * 0.002, `${reading.watts} W`);
  assert.equal(reading.unreg, false);
  // Behind 1 Ω: V·(5 − V) = 2, the upper root 4.56 V.
  const r1 = bench({ volts: 5 });
  const r = r1.seat("r1", "resistor", "a40", { ohms: 1 });
  r1.vcc(r.get(1));
  addLoad(r1, { mode: "cp", watts: 2 }, r1.at(r.get(2).replace(/^[a-e]/, "c")));
  const behind = runner(r1.doc, { engine: "spice" }).run(0).result.bench.get("load1"); // prettier-ignore
  const upper = (5 + Math.sqrt(25 - 8)) / 2;
  assert.ok(Math.abs(behind.volts - upper) < 0.01, `${behind.volts} V`);
  assert.ok(Math.abs(behind.watts - 2) < 2 * 0.002, `${behind.watts} W`);
  // 30 W from 5 V would be 6 A: it stops at its ceiling, UNREG.
  const big = bench({ volts: 5 });
  big.doc.components[0].params.currentLimit = 10;
  addLoad(big, { mode: "cp", watts: 30 });
  const capped = runner(big.doc, { engine: "spice" }).run(0).result.bench.get("load1"); // prettier-ignore
  assert.ok(Math.abs(capped.amps - LOAD_MAX_A) < 1e-3, `${capped.amps} A`);
  assert.equal(capped.unreg, true);
});

test("a load's law: every mode continuous across its pieces, CP within 0.19 % of P / V, its slopes by hand", () => {
  const loads = [
    { mode: "cc", amps: 0.25 },
    { mode: "cc", amps: 5 },
    { mode: "cr", ohms: 47 },
    { mode: "cv", volts: 4 },
    { mode: "cv", volts: 0.5 },
    { mode: "cv", volts: 2.45 },
    { mode: "cp", watts: 2 },
    { mode: "cp", watts: 0.01 },
    { mode: "cp", watts: 30 },
  ];
  for (const load of loads) {
    const br = { pos: "p", neg: "n", amps: 0, ohms: 0, volts: 0, watts: 0, ...load }; // prettier-ignore
    const pieces = new Set();
    for (let v = -1; v <= 40; v += 0.0007) {
      const law = loadLaw(br, v);
      pieces.add(law.piece);
      assert.ok(v >= law.lo && (v < law.hi || law.hi === 0), `${JSON.stringify(load)} ${v} V in [${law.lo}, ${law.hi})`); // prettier-ignore
      assert.ok(law.amps >= 0 && law.amps <= Math.max(LOAD_MAX_A, br.amps) + 1e-12); // prettier-ignore
      assert.ok(law.amps <= Math.max(0, v) / LOAD_RON + 1e-12, "never past RON's line"); // prettier-ignore
      // Continuous at its piece's ends.
      for (const edge of [law.lo, law.hi]) {
        if (!Number.isFinite(edge) || edge <= 0) continue;
        const below = loadLaw(br, edge * (1 - 1e-12)).amps;
        const above = loadLaw(br, edge).amps;
        assert.ok(Math.abs(below - above) < 1e-9 * Math.max(1, above), `${JSON.stringify(load)} at ${edge} V: ${below} | ${above}`); // prettier-ignore
      }
      // Its slope, by hand, against a read inside the piece.
      const vAt = (n) => (n === "p" ? v : 0);
      const dv = Math.min(1e-7, (law.hi - v) / 4);
      if (v > 0 && dv > 1e-12) {
        const read = (loadLaw(br, v + dv).amps - law.amps) / dv;
        assert.ok(Math.abs(-loadSlope(br, "p", "p", vAt) - read) < 1e-5 * Math.max(1, Math.abs(read)), `${JSON.stringify(load)} slope at ${v} V`); // prettier-ignore
      }
      if (load.mode === "cp" && law.piece[0] === "p") {
        const exact = load.watts / v;
        assert.ok(law.amps >= exact * (1 - 1e-12) && law.amps <= exact * 1.0019, `${law.amps} for ${exact}`); // prettier-ignore
      }
      if (load.mode === "cv" && law.piece === "v") {
        assert.ok(Math.abs(law.amps - (v - load.volts) / LOAD_CV_OHMS) < 1e-9);
      }
    }
    assert.ok(pieces.size >= 2, `${JSON.stringify(load)}: ${[...pieces]}`);
  }
  // A CV load's slope on its setting, each way.
  const cv = { pos: "p", neg: "n", mode: "cv", volts: 4 };
  const at = (n) => (n === "p" ? 4 : 0);
  assert.equal(-loadSlope(cv, "p", "p", at, 1), 1 / LOAD_CV_OHMS);
  assert.equal(-loadSlope(cv, "p", "p", at, -1), 0);
  assert.equal(loadSlope(cv, "n", "p", at, 1), 1 / LOAD_CV_OHMS);
});

test("a load's badge names its mode and setting", () => {
  assert.equal(loadBadge({}), "CC 100mA");
  assert.equal(loadBadge({ mode: "cr", ohms: 47 }), "CR 47Ω");
  assert.equal(loadBadge({ mode: "cv", volts: 3.3 }), "CV 3.3V");
  assert.equal(loadBadge({ mode: "cp", watts: 2.5 }), "CP 2.5W");
  assert.equal(loadBadge({ mode: "cp", watts: 0.25 }), "CP 250mW");
  assert.equal(loadBadge({ mode: "zz" }), "CC 100mA");
});

test("load: past 25 W it warns", () => {
  const b = bench({ volts: 15 });
  b.doc.components[0].params.currentLimit = 5;
  addLoad(b, { mode: "cc", amps: 2 });
  const r = runner(b.doc, { engine: "spice" }).run(0).result;
  assert.ok(r.warnings.some((w) => w.type === "load-power"));
});

test("load, logic engine: nothing — a logic simulator draws no current", () => {
  const b = bench({ volts: 5 });
  addLoad(b, { mode: "cc", amps: 1 });
  const r = runner(b.doc).run(0).result;
  assert.deepEqual(r.warnings, []);
});

test("a load brick on a desk: minted, kept, and its counter stored once used", () => {
  const d = new DeskDoc();
  assert.equal(d.toJSON().nextLoadId, undefined, "a desk without one keeps its bytes"); // prettier-ignore
  const l = d.addBrick("load", 0, 0, { mode: "cr", ohms: 10 });
  assert.equal(l.id, "load1");
  assert.equal(d.toJSON().nextLoadId, 2);
  const again = normalizeDocument(d.toJSON());
  assert.deepEqual(again.components.find((c) => c.id === "load1").params, { mode: "cr", amps: 0.1, ohms: 10, volts: 3.3, watts: 1 }); // prettier-ignore
  assert.equal(again.nextLoadId, 2);
});

test("a regulator's lead currents are each on its own lead", () => {
  const b = bench({ volts: 9 });
  const g = b.seat("g1", "LM7805", "a50");
  b.vcc(g.get(1));
  b.gnd(g.get(2));
  const rl = b.seat("rl", "resistor", "a30", { ohms: 100 });
  b.link(rl.get(1), g.get(3));
  b.gnd(rl.get(2));
  const r = runner(b.doc, { engine: "spice" });
  r.run(0);
  const amps = (pin) => r.result.currents.get(b.at(g.get(pin)));
  // 50 mA out of OUT into 100 Ω; IN carries that and the quiescent 5 mA,
  // which GND returns.
  assert.ok(Math.abs(amps(3) - 0.05) < 1e-3, `OUT ${amps(3)} A`);
  assert.ok(Math.abs(amps(1) - 0.055) < 1e-3, `IN ${amps(1)} A`);
  assert.ok(Math.abs(amps(2) - 0.005) < 1e-4, `GND ${amps(2)} A`);
});

test("a 7805 in its datasheet circuit comes up at 5 V from Run, its supply undrooped", () => {
  // 9 V → 0.33 µF on IN, 0.1 µF on OUT, 1 kΩ: the output capacitor's inrush
  // at Run was booked as a steady demand, the supply drooped to 5.98 V and
  // held there half a millisecond, the regulator in dropout (the regrade,
  // 2026-10-22). A 1 mF one's inrush said nothing either.
  for (const out of [0.1e-6, 1e-3]) {
    const b = bench({ volts: 9 });
    const g = b.seat("g1", "LM7805", "a10");
    b.vcc(g.get(1));
    b.gnd(g.get(2));
    const ci = b.seat("ci", "cap-ceramic", "f10", { farads: 0.33e-6 });
    b.link(ci.get(1), g.get(1));
    b.gnd(ci.get(2));
    const co = b.seat("co", out < 1e-5 ? "cap-ceramic" : "cap-electrolytic", "f20", { farads: out }); // prettier-ignore
    b.link(co.get(1), g.get(3));
    b.gnd(co.get(2));
    const rl = b.seat("rl", "resistor", "a30", { ohms: 1000 });
    b.link(g.get(3), rl.get(1));
    b.gnd(rl.get(2));
    const said = new Set();
    const lows = [];
    driveSpice(b.doc, {
      seconds: 0.1,
      onTick(now, res, inp) {
        for (const w of res.warnings) said.add(w.type);
        const v = res.nodeVolts.get(inp.netlist.netOfPoint.get(b.at(g.get(3))));
        if (out < 1e-5 && now > 5e-6 && v < 4.95) lows.push(`${now}: ${v}`);
      },
    });
    assert.deepEqual([...said].filter((t) => t.startsWith("regulator-")), [], `${out} F`); // prettier-ignore
    assert.deepEqual(lows, [], `${out} F`);
  }
});

test("an optocoupler's LED driven past its rating is said as its LED's, not a transistor's", () => {
  const b = bench({ volts: 9 });
  const o = b.seat("o1", "4N35", "e20");
  const r = b.seat("r1", "resistor", "a10", { ohms: 47 });
  b.vcc(r.get(1));
  b.link(r.get(2), o.get(1));
  b.gnd(o.get(2));
  const rl = b.seat("rl", "resistor", "a40", { ohms: 1000 });
  b.vcc(rl.get(1));
  b.link(rl.get(2), o.get(5));
  b.gnd(o.get(4));
  const res = runner(b.doc, { engine: "spice" }).run(0).result;
  const w = res.warnings.find((x) => x.comp === "o1");
  assert.equal(w?.type, "opto-led", JSON.stringify(res.warnings));
  assert.ok(w.amps > 0.15 && w.limit === 60 && !w.smoke);
});
