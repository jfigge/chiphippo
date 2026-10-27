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

// The 2026-10-26 review's Spice Lite findings, each held here: a transistor
// driven far past its knee (a coil forcing amps through a PNP's base) solved
// in milliseconds, not a minute a tick; a settle capped mid-tick said; a
// ringing coil's run-on searched only as far as it can cross zero; and two
// supplies stacked for a ± rail floating on each other, not shorted.

import test from "node:test";
import assert from "node:assert/strict";

import { partDef } from "../catalog/index.js";
import { bench, runner } from "./timing-fixtures.js";
import { buildNetlist } from "../sim/netlist.js";
import { stackedSupplies } from "../sim/floating-grounds.js";
import { rcTrace } from "../sim/rc-trace.js";
import { L } from "../sim/levels.js";
import { driveSpice } from "../bench/drive-spice.js";
import { coupledValue, signHeldAfter } from "../sim/spice/dynamics.js";
import { sampleTimes } from "../sim/spice/rc-curve.js";

const near = (got, want, tol, what) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} for ${want}`);

test("a coil forcing amps through a PNP's base is solved in milliseconds", () => {
  // 12 V bench, a 10 Hz clock into a 1N4148 into 100 µH to ground; a PNP's
  // base on the coil, its collector on the clock, its emitter 100 Ω to it.
  // At the first edge the coil draws ~15 A, the diode burns, and the coil's
  // current is left only the PNP's base — VBE tens of volts behind RB. The
  // drop solve inside the transistor went round a cycle of three for good
  // there, every read fell to its nested search, and the next two ticks
  // took 17 s and 72 s, the coil ending at −824 A. (That was an ideal
  // brick's edge; behind its 50 Ω the coil sees a quarter of an amp, and
  // the test holds the desk to its pace.)
  const b = bench({ volts: 12 });
  const d = b.seat("d1", "diode", "a10");
  const l = b.seat("l1", "inductor", "a20", { henries: 1e-4 });
  const q = b.seat("q1", "pnp", "a30");
  const r = b.seat("r1", "resistor", "a40", { ohms: 100 });
  b.link(d.get(2), l.get(1));
  b.gnd(l.get(2));
  b.link(q.get(2), l.get(1));
  b.link(q.get(1), r.get(1));
  b.link(r.get(2), d.get(1));
  b.link(q.get(3), d.get(1));
  b.doc.components.push({
    id: "clk1",
    kind: "clock",
    ref: "clock",
    x: 20,
    y: 40,
    params: partDef("clock").normalizeParams({ hz: 10 }),
  });
  b.doc.wires.push(
    { id: "wc1", from: "clk1.out", to: b.at(d.get(1).replace(/^a/, "e")), color: "red" }, // prettier-ignore
    { id: "wc2", from: "clk1.gnd", to: "psu1.-", color: "black" },
    { id: "wc3", from: "clk1.vcc", to: "psu1.+", color: "red" },
  );
  const t0 = performance.now();
  let burnt = false;
  const amps = [];
  driveSpice(b.doc, {
    seconds: 0.0512,
    onTick(now, res) {
      if ((res.warnings ?? []).some((w) => w.type === "diode-burnt")) burnt = true; // prettier-ignore
      amps.push(res.analog?.coilAmps?.get("l1") ?? 0);
    },
  });
  const ms = performance.now() - t0;
  // (The diode no longer burns at the edge: behind the brick's 50 Ω —
  // spice/output-stage.js `CLOCK_OHMS` — it carries a quarter of an amp.)
  void burnt;
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms for the edge and two ticks on`);
  for (const a of amps) assert.ok(Math.abs(a) < 20, `coil at ${a} A`);
});

test("a latch of an NPN and a PNP on a triangle settles: no capped settle, nothing to say", () => {
  // 12 V, a 5 kHz triangle on CLK; an NPN (E N5, B N4, C ground) with a
  // 6.2 V Zener N5 → N4, a PNP (E CLK, B N5, C N3) with one N3 → N5, and
  // 1 kΩ from N3 to ground. Its settles capped at a crossing mid-tick, and
  // only a tick's LAST settle's warnings reached its result: twenty capped
  // settles in twenty-one ticks, and not one `oscillation` (the 2026-10-26
  // review: each now said). The cap itself was the transistors' readings
  // turning with their nets held and unheld — off the solve where it held
  // them, their nets' digital level where it held nothing, every pass; the
  // regrade's phase 7 (2026-10-27) reads a transistor the solve left
  // holding nothing as off (spice/voltages.js `selfLevel`), and it settles.
  const b = bench({ volts: 12 });
  const slots = ["a1", "a6", "a11", "a16", "a21"];
  const spec = [
    ["npn", {}, [5, 4, 0]],
    ["zener", { zenerVolts: 6.2 }, [5, 4]],
    ["pnp", {}, [2, 5, 3]],
    ["zener", { zenerVolts: 6.2 }, [3, 5]],
    ["resistor", { ohms: 1000 }, [0, 3]],
  ];
  const pinsOf = new Map();
  spec.forEach(([ref, params, nets], i) => {
    const h = b.seat(`p${i}`, ref, slots[i], params);
    nets.forEach((n, k) => {
      if (!pinsOf.has(n)) pinsOf.set(n, []);
      pinsOf.get(n).push(h.get(k + 1));
    });
  });
  for (const [n, holes] of pinsOf) {
    if (n === 0) holes.forEach((h) => b.gnd(h));
    for (let k = 1; k < holes.length; k++) b.link(holes[k - 1], holes[k]);
  }
  b.doc.components.push({
    id: "clk1",
    kind: "clock",
    ref: "clock",
    x: 20,
    y: 40,
    params: partDef("clock").normalizeParams({ hz: 5000, wave: "triangle" }),
  });
  b.doc.wires.push(
    { id: "wc1", from: "clk1.out", to: b.at(`e${pinsOf.get(2)[0].slice(1)}`), color: "red" }, // prettier-ignore
    { id: "wc2", from: "clk1.gnd", to: "psu1.-", color: "black" },
    { id: "wc3", from: "clk1.vcc", to: "psu1.+", color: "red" },
  );
  const stats = {};
  let said = 0;
  driveSpice(b.doc, {
    seconds: 0.002,
    stats,
    onTick(now, res) {
      const osc = (res.warnings ?? []).find((w) => w.type === "oscillation");
      if (osc) {
        said++;
        assert.ok(osc.nets.length > 0, "names the nets");
      }
    },
  });
  assert.equal(stats.cappedSolves ?? 0, 0, "no settle capped");
  assert.equal(said, 0, "no oscillation said");
});

test("a settle capped at a crossing mid-tick is said, though the tick's last settles", () => {
  // A ring of three 74LS00 gates (gate 1 a NAND, its other input EN; gates 2
  // and 3 as inverters) enabled through an RC from a 100 Hz clock: 1 kΩ into
  // 100 nF on EN, so EN crosses the gate's threshold 70 µs after each edge
  // and the ring runs — a settle capped at that crossing — and the tick that
  // holds it may end with the ring stopped. Only a tick's last settle's
  // warnings reach its result, so such a capped settle went unsaid
  // (`cappedNets`, spice/engine.js); four of this desk's ticks are such
  // (the regrade's phase 7, 2026-10-27, when the latch above stopped
  // capping: the path had no test of its own).
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "74LS00", "e10");
  const row = (n, r) => u.get(n).replace(/^[a-j]/, r);
  b.vcc(row(14, "j"));
  b.gnd(row(7, "a"));
  b.link(row(3, "b"), row(4, "b"));
  b.link(row(4, "c"), row(5, "c"));
  b.link(row(6, "b"), row(9, "j"));
  b.link(row(9, "i"), row(10, "i"));
  b.link(row(8, "h"), row(2, "b"));
  const r = b.seat("r1", "resistor", "a40", { ohms: 1000 });
  const c = b.seat("c1", "cap-ceramic", "a50", { farads: 1e-7 });
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  b.link(c.get(1).replace(/^a/, "c"), row(1, "c"));
  b.doc.components.push({
    id: "clk1",
    kind: "clock",
    ref: "clock",
    x: 20,
    y: 40,
    params: partDef("clock").normalizeParams({ hz: 100 }),
  });
  b.doc.wires.push(
    { id: "wc1", from: "clk1.out", to: b.at(r.get(1).replace(/^a/, "e")), color: "red" }, // prettier-ignore
    { id: "wc2", from: "clk1.gnd", to: "psu1.-", color: "black" },
    { id: "wc3", from: "clk1.vcc", to: "psu1.+", color: "red" },
  );
  const stats = {};
  let seen = 0;
  let cappedTicks = 0;
  driveSpice(b.doc, {
    seconds: 0.05,
    stats,
    onTick(now, res) {
      const capped = stats.cappedSolves ?? 0;
      if (capped > seen) {
        cappedTicks++;
        const osc = (res.warnings ?? []).find((w) => w.type === "oscillation");
        assert.ok(osc, `a settle capped in the tick at ${now} s, and not said`);
        assert.ok(osc.nets.length > 0, "names the nets");
      }
      seen = capped;
    },
  });
  assert.ok(cappedTicks > 0, "the ring capped settles");
  assert.ok(stats.settles > cappedTicks, "ticks of several settles");
});

test("a ringing curve keeps its final sign past where its modes have died below it", () => {
  // A coil's run-on looked for its zero crossing every sixteenth of a period
  // for 256 periods of a high-Q ring that never reached zero (150 s a
  // simulated second). Past `signHeldAfter` the curve cannot cross; before,
  // it may — the search keeps every sample up to there.
  const curve = {
    kind: "modal",
    base: 1,
    terms: [{ k: -1e3, ki: 3e6, a: 2, ai: 0.5, r: 0, ri: 0 }],
  };
  const held = signHeldAfter(curve);
  assert.equal(held.sign, 1);
  assert.ok(held.after > 0);
  let crossed = false;
  for (let i = 1; i <= 4000; i++) {
    const dt = (held.after * i) / 1000; // up to four times past it
    const v = coupledValue(curve, dt);
    if (dt >= held.after) assert.ok(v > 0, `${v} at ${dt}`);
    else if (v < 0) crossed = true;
  }
  assert.ok(crossed, "it crosses before");
  // The cut list is the whole one up to its first time past the cut.
  const whole = sampleTimes(0, 1e-2, 1e-7, 3e6);
  const cut = sampleTimes(0, 1e-2, 1e-7, 3e6, held.after);
  assert.ok(cut.length < whole.length);
  assert.deepEqual(cut, whole.slice(0, cut.length));
  assert.ok(cut.at(-1) > held.after && cut.at(-2) <= held.after);
});

/** Two 5 V supplies: psu1 the bench's, psu2 wired by `wires`, beside a
    resistor whose first lead is on psu1's −. */
function twoSupplies(wires) {
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 1e3 });
  b.gnd(r.get(1));
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 0, y: 50, params: { volts: 5 } }); // prettier-ignore
  b.doc.wires.push(...wires(b, r));
  return b.doc;
}

test("a supply stacked on another floats on it; one wired across it does not", () => {
  const free = (b, r) => b.at(r.get(2).replace(/^a/, "d"));
  const cases = [
    // psu2's + on psu1's −: a −5 V rail.
    ["below", (b, r) => [{ id: "w1", from: "psu2.+", to: "psu1.-", color: "red" }, { id: "w2", from: "psu2.-", to: free(b, r), color: "black" }], -5], // prettier-ignore
    // psu2's − on psu1's +: a +10 V rail.
    ["above", (b, r) => [{ id: "w1", from: "psu2.-", to: "psu1.+", color: "red" }, { id: "w2", from: "psu2.+", to: free(b, r), color: "black" }], 10], // prettier-ignore
    // Backwards across psu1, and + straight to ground: shorts, no stack.
    ["across", () => [{ id: "w1", from: "psu2.+", to: "psu1.-", color: "red" }, { id: "w2", from: "psu2.-", to: "psu1.+", color: "black" }], null], // prettier-ignore
    ["shorted", () => [{ id: "w1", from: "psu2.+", to: "psu1.-", color: "red" }, { id: "w2", from: "psu2.-", to: "psu1.-", color: "black" }], null], // prettier-ignore
  ];
  for (const [name, wires, volts] of cases) {
    const doc = twoSupplies(wires);
    const st = stackedSupplies(doc, buildNetlist(doc));
    if (volts == null) assert.equal(st.size, 0, name);
    else assert.equal(st.get("psu2")?.volts, volts, name);
  }
});

test("two supplies stacked for a ± rail run an LM358 below ground, and a short stays one", () => {
  // The finding's desk: an LM358 follower on +5 / −5 from two stacked 5 V
  // supplies. Every − was ground, so psu2's + on psu1's − read as a short,
  // psu2 held at its limit (0.1 V, 1 A, 50 A asked).
  for (const [foot, want] of [
    ["ground", 2],
    ["minus", -1],
  ]) {
    const b = bench({ volts: 5 });
    const u = b.seat("u1", "LM358", "e10");
    b.vcc(u.get(8));
    b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 0, y: 50, params: { volts: 5 } }); // prettier-ignore
    b.doc.wires.push(
      { id: "wp2a", from: "psu2.+", to: "psu1.-", color: "red" },
      { id: "wp2b", from: "psu2.-", to: b.at(u.get(4).replace(/^[a-e]/, "d")), color: "black" }, // prettier-ignore
    );
    const s1 = b.seat("s1", "resistor", "a30", { ohms: 3e3 });
    const s2 = b.seat("s2", "resistor", "a35", { ohms: 2e3 });
    b.vcc(s1.get(1));
    b.link(s1.get(2), s2.get(1));
    if (foot === "ground") b.gnd(s2.get(2));
    else b.doc.wires.push({ id: "wn", from: "psu2.-", to: b.at(s2.get(2).replace(/^a/, "d")), color: "black" }); // prettier-ignore
    b.link(s1.get(2), u.get(3));
    b.link(u.get(1), u.get(2));
    const rl = b.seat("rl", "resistor", "a45", { ohms: 1e3 });
    b.link(rl.get(1), u.get(1));
    b.gnd(rl.get(2));
    b.gnd(u.get(5));
    b.link(u.get(6), u.get(7));
    const sim = runner(b.doc, { engine: "spice" });
    const r = sim.run(0).result;
    const v = (pin) => r.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(pin)))); // prettier-ignore
    assert.deepEqual(
      r.warnings.filter((w) => w.type === "short"),
      [],
      foot,
    );
    near(v(4), -5, 1e-9, `${foot}: the − rail`);
    near(v(1), want, 1e-3, `${foot}: the follower`);
    for (const [id, sup] of r.supplies) assert.equal(sup.limited, false, `${foot}: ${id} limited`); // prettier-ignore
  }
  // + straight to ground is still a short.
  const doc = twoSupplies(() => [
    { id: "w1", from: "psu2.+", to: "psu1.-", color: "red" },
    { id: "w2", from: "psu2.-", to: "psu1.-", color: "black" },
  ]);
  const r = runner(doc, { engine: "spice" }).run(0).result;
  assert.ok(
    r.warnings.some((w) => w.type === "short"),
    "the short",
  );
  assert.equal(r.supplies.get("psu2").limited, true);
});

test("the logic engine reads a stacked supply as the stack, and a short as a short", () => {
  // psu2's + on psu1's −, its − a −5 V rail an LM358's V− is on: no short,
  // ground LOW, the LM358 across its whole 10 V; the RC trace calls the
  // shared net a − and the −5 V rail one too.
  const doc = twoSupplies((b, r) => [
    { id: "w1", from: "psu2.+", to: "psu1.-", color: "red" },
    { id: "w2", from: "psu2.-", to: b.at(r.get(2).replace(/^a/, "d")), color: "black" }, // prettier-ignore
  ]);
  const sim = runner(doc, { engine: "digital" });
  const res = sim.run(0).result;
  const ground = sim.netlist.netOfPoint.get("psu1.-");
  const rail = sim.netlist.netOfPoint.get("psu2.-");
  assert.deepEqual(res.warnings, []);
  assert.equal(res.netLevels.get(ground), L);
  const trace = rcTrace(doc, sim.netlist);
  assert.equal(trace.rail(ground), "-");
  assert.equal(trace.rail(rail), "-");
  // …and on top of it: a +10 V rail.
  const top = twoSupplies((b, r) => [
    { id: "w1", from: "psu2.-", to: "psu1.+", color: "red" },
    { id: "w2", from: "psu2.+", to: b.at(r.get(2).replace(/^a/, "d")), color: "black" }, // prettier-ignore
  ]);
  const topNet = buildNetlist(top);
  assert.equal(rcTrace(top, topNet).supplyVolts(topNet.netOfPoint.get("psu2.+")), 10); // prettier-ignore
  assert.deepEqual(runner(top, { engine: "digital" }).run(0).result.warnings, []); // prettier-ignore
  // + straight to ground is a short in both engines.
  const shorted = twoSupplies(() => [
    { id: "w1", from: "psu2.+", to: "psu1.-", color: "red" },
    { id: "w2", from: "psu2.-", to: "psu1.-", color: "black" },
  ]);
  for (const engine of ["digital", "spice"]) {
    const w = runner(shorted, { engine }).run(0).result.warnings;
    assert.ok(
      w.some((x) => x.type === "short"),
      engine,
    );
  }
});

test("an LM358 across two stacked supplies sees both", () => {
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "LM358", "e10");
  b.vcc(u.get(8));
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 0, y: 50, params: { volts: 5 } }); // prettier-ignore
  b.doc.wires.push(
    { id: "wp2a", from: "psu2.+", to: "psu1.-", color: "red" },
    { id: "wp2b", from: "psu2.-", to: b.at(u.get(4).replace(/^[a-e]/, "d")), color: "black" }, // prettier-ignore
  );
  for (const engine of ["digital", "spice"]) {
    const res = runner(b.doc, { engine }).run(0).result;
    assert.equal(res.chipStatus.get("u1").volts, 10, engine);
  }
});

test("the ngspice deck writes a stacked supply across its own nets", async () => {
  // Every − was named ground, so a ± desk's lower supply was a shorted
  // source and ngspice refused it ("vpsu2 is a shorted VSRC").
  const { spiceDeck } = await import("../../../../scripts/spice-deck.mjs");
  const doc = twoSupplies((b, r) => [
    { id: "w1", from: "psu2.+", to: "psu1.-", color: "red" },
    { id: "w2", from: "psu2.-", to: b.at(r.get(2).replace(/^a/, "d")), color: "black" }, // prettier-ignore
  ]);
  const { text } = spiceDeck(doc, { flavour: "same", probes: [], analysis: { op: true } }); // prettier-ignore
  const line = text.split("\n").find((l) => l.startsWith("Vpsu2 "));
  const [, plus, minus, volts] = line.split(/\s+/);
  assert.equal(plus, "0");
  assert.notEqual(minus, "0");
  assert.equal(Number(volts), 5);
});

test("an overloaded supply starts at its set volts and sags as its capacitor drains", () => {
  // 1.9 Ω straight across 5 V / 1 A, nothing logic-powered on it. Jason:
  // "match ngspice" — its 470 µF starts charged (the deck's IC=set) and the
  // rail falls from 5 V to the limit's 1.9 V with τ = 1.9 Ω × 470 µF. It
  // read 1.9 V at Run, 4.99 V a microsecond on, then fell back over 5 ms.
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 1.9 });
  b.vcc(r.get(1));
  b.gnd(r.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  const read = [];
  for (const t of [0, 1e-6, 1e-4, 1e-3, 1e-2]) read.push(sim.run(t).result.supplies.get("psu1").volts); // prettier-ignore
  near(read[0], 5, 1e-9, "at Run");
  for (let i = 1; i < read.length; i++) assert.ok(read[i] <= read[i - 1] + 1e-9, `rises: ${read}`); // prettier-ignore
  const tau = 1.9 * 470e-6;
  near(read[2], 1.9 + 3.1 * Math.exp(-1e-4 / tau), 0.02, "at 0.1 ms");
  near(read[4], 1.9, 0.01, "at its limit");
});

test("a chip its supply sags under is said underpowered once, after the sag", async () => {
  // Since the supply starts at its set volts and sags (above), a 74LS04
  // beside 200 mA of load on a 100 mA supply is OK at Run and underpowered
  // once its 470 µF has drained to the limit's 2.5 V: said once, past the
  // settling window, and not again while it stays there.
  const { resetDom } = await import("./jsdom-setup.js");
  const { SimController } = await import("../components/sim-controller.js");
  resetDom();
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  for (let i = 0; i < 4; i++) {
    const r = b.seat(`r${i}`, "resistor", `a${30 + i * 5}`, { ohms: 100 });
    b.vcc(r.get(1));
    b.gnd(r.get(2));
  }
  b.doc.components[0].params.currentLimit = 0.1;
  const doc = JSON.parse(JSON.stringify(b.doc));
  const deskDoc = { toJSON: () => doc, get scopeChannels() { return []; }, getComponent: (id) => doc.components.find((c) => c.id === id) ?? null, setComponentParams() {} }; // prettier-ignore
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, ms) {
      pending.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout: (id) => pending.delete(id),
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      let due = null;
      for (const [id, t] of pending) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t]; // prettier-ignore
      if (!due) break;
      pending.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = end;
  };
  const said = [];
  const sim = new SimController({ deskDoc, notifications: { notify: (o) => said.push(o), dismiss() {} }, clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  sim.start();
  for (let ms = 0; ms < 1500; ms += 20) advance(20);
  sim.stop();
  const under = said.filter((o) => o.key === "under:u1");
  assert.equal(under.length, 1, under.map((o) => o.message).join(" | "));
});

/** Run `raw` under Spice Lite in a SimController on a fake wall clock for
    `ms`, gathering every sim-state's detail. */
async function controllerRun(raw, ms) {
  const { resetDom } = await import("./jsdom-setup.js");
  const { SimController } = await import("../components/sim-controller.js");
  const { partDef } = await import("../catalog/index.js");
  resetDom();
  const doc = JSON.parse(JSON.stringify(raw));
  const deskDoc = {
    toJSON: () => doc,
    get scopeChannels() {
      return [];
    },
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      const c = doc.components.find((x) => x.id === id);
      c.params = partDef(c.ref).normalizeParams({ ...c.params, ...patch });
      return c;
    },
  };
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const clock = {
    now: () => now,
    setTimeout(fn, wait) {
      pending.set(++seq, { at: now + Math.max(0, wait), fn });
      return seq;
    },
    clearTimeout: (id) => pending.delete(id),
  };
  const states = [];
  const listen = (e) => states.push(e.detail);
  window.addEventListener("chiphippo:sim-state", listen);
  const sim = new SimController({ deskDoc, notifications: { notify() {}, dismiss() {} }, clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  sim.start();
  for (const end = now + ms; ;) {
    let due = null;
    for (const [id, t] of pending) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t]; // prettier-ignore
    if (!due) {
      now = end;
      break;
    }
    pending.delete(due[0]);
    now = Math.max(now, due[1].at);
    due[1].fn();
  }
  sim.stop();
  window.removeEventListener("chiphippo:sim-state", listen);
  return states;
}

test("a supply with only a resistor across it sags to its limit in a run with nothing else to wake it", async () => {
  // No clock, no chip: only the freeing tick and the sag's own frames move
  // the run. It used to show 5 V for good once the freeing tick had run.
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 1.9 });
  b.vcc(r.get(1));
  b.gnd(r.get(2));
  const states = await controllerRun(b.doc, 400);
  const volts = states.map((s) => s.supplies?.get("psu1")?.volts).filter((v) => v != null); // prettier-ignore
  near(volts[0], 5, 1e-6, "at Run");
  near(volts.at(-1), 1.9, 0.01, `shown last: ${volts}`);
});

test("a meter on its 10 A jack straight across a 1 A supply reads the limit, its fuse whole", async () => {
  // The 470 µF empties through the 0.04 Ω shunt at Run — 125 A for some
  // tens of microseconds, far under the fuse's I²t — and the display's
  // next window, though nothing else ticks, reads the supply's 1 A.
  const { partDef } = await import("../catalog/index.js");
  const b = bench({ volts: 5 });
  b.doc.components.push({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 0, params: partDef("meter").normalizeParams({ dial: "ma", jack: "a", red: { at: "psu1.+" }, black: { at: "psu1.-" } }) }); // prettier-ignore
  const states = await controllerRun(b.doc, 500);
  const windows = states.map((s) => s.meters?.get("dmm1")).filter(Boolean);
  const last = windows.at(-1);
  assert.ok(last.span > 0.1, `window span ${last.span}`);
  near(last.mean / 0.04, 1, 0.03, "amps");
  const doc = states.at(-1);
  assert.ok(doc, "published");
});
