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
// both engines: the optocouplers, the LM358, the linear regulators, the
// relay and the electronic load. The ULN2003A has its own file.

import test from "node:test";
import assert from "node:assert/strict";
import { H, L, X } from "../sim/levels.js";
import { partDef } from "../catalog/index.js";
import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { regulatorFacts, regulatorVolts } from "../sim/regulators.js";
import { coilOf } from "../sim/spice/inductors.js";
import { buildNetlist } from "../sim/netlist.js";
import { bench, runner } from "./timing-fixtures.js";

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
    // Through 4.7 kΩ, IF ≈ 2.3 mA: at 100 % the transistor carries about
    // that, and the collector sits near 12 − 2.3 = 9.7 V; at 300 % three
    // times as much; dark, nothing at all.
    const at100 = collector(4700, 100);
    assert.ok(at100 > 9 && at100 < 10.5, `CTR-limited: ${at100} V`);
    const at300 = collector(4700, 300);
    assert.ok(Math.abs(12 - at300 - 3 * (12 - at100)) < 0.3, `×3: ${at300} V`);
    assert.ok(collector(470, 100, L) > 11.9, "dark: open");
  });
}

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
  assert.ok(r.warnings.some((w) => w.type === "regulator-dropout"));
  // 1.2 W (9 V in, 300 mA): hot.
  ({ b, g } = regulated("LM7805"));
  addLoad(b, { mode: "cc", amps: 0.3 }, b.at(g.get(3)));
  b.doc.wires.find((w) => w.to === b.at(g.get(3))).to = "bb1.e52"; // the OUT node's free hole
  sim = runner(b.doc, { engine: "spice" });
  r = sim.run(0).result;
  assert.ok(r.warnings.some((w) => w.type === "regulator-hot"), r.warnings.map((w) => w.type).join()); // prettier-ignore
  const reading = r.bench.get("g1");
  // 4 V across it at 300 mA, and the 74LS04's few mA beside.
  assert.ok(Math.abs(reading.watts - 4 * 0.3) < 0.1, `${reading.watts} W`);
});

test("a 7805 past 2 W shuts down hot, and comes back once it has cooled", () => {
  const { b } = regulated("LM7805", { volts: 15 });
  addLoad(b, { mode: "cc", amps: 0.5 }, "bb1.e52");
  const sim = runner(b.doc, { engine: "spice" });
  const seen = runTo(sim, 0, 0.5);
  assert.ok(seen.some((r) => r.warnings.some((w) => w.type === "regulator-shutdown"))); // prettier-ignore
  assert.equal(seen.at(-1).bench.get("g1").off, true, "off while it cools");
  // Cooled (a second on), it is on again — and over again, so it trips
  // again: cycling, as a real one does.
  const back = sim.run(1.2).result;
  assert.ok(back.bench.get("g1").watts > 2, "on again");
  assert.ok(back.warnings.some((w) => w.type === "regulator-shutdown"));
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
  assert.deepEqual(again.components.find((c) => c.id === "load1").params, { mode: "cr", amps: 0.1, ohms: 10 }); // prettier-ignore
  assert.equal(again.nextLoadId, 2);
});
