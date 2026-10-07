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

// spice-current.test.js — Spice Light's current model (features/
// spice-light.md §4.5–§4.6): an output's fan-out budget (Brownout, then brown
// smoke past twice it), a supply's demand and its droop past its current
// limit (which the engine's own power check turns into "underpowered"), and
// the PSU's new param and readout.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { CHIP_STATUS } from "../sim/engine.js";
import { OVERLOAD_RATIO } from "../sim/spice/loads.js";
import {
  FAMILY_DEFAULTS,
  FORWARD_VOLTS,
  outputDrive,
} from "../sim/spice/params.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";
import { measureSupplies, supplyTopology } from "../sim/spice/supply.js";
import { tick as digitalTick } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partDef } from "../catalog/index.js";
import { DEFAULT_CURRENT_LIMIT } from "../catalog/parts.js";
import { supplyReadout } from "../components/psu-view.js";
import { bench, runner } from "./timing-fixtures.js";

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

/** A CD4069UB output held LOW (its input on a flag resting HIGH), wired to
    `n` 74LS04 inputs: each sources its 0.4 mA I_IL into the CMOS output,
    whose sink budget is 1 mA at 5 V. */
function fanout(n) {
  const b = bench();
  const drv = inverter(b, "u1", "CD4069UB", "e10");
  b.signal("in", drv.get(1), "high");
  const ls = inverter(b, "u2", "74LS04", "e20");
  // Daisy-chained, input to input: one net, and no node runs out of holes.
  let from = drv.get(2);
  for (const pin of [1, 3, 5, 9, 11, 13].slice(0, n)) {
    b.link(from, ls.get(pin));
    from = ls.get(pin);
  }
  return b.doc;
}

const signals = new Map([["in", H]]);
const spiceRun = (doc) =>
  runner(doc, { engine: "spice" }).run(0, signals).result;

test("fan-out within budget: no brownout", () => {
  const r = spiceRun(fanout(2)); // 0.8 mA of 1 mA
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
  const load = r.loads.get("u1:2");
  assert.equal(load.level, L);
  assert.equal(load.inputs, 2);
  close(load.loadMa, 0.8, 1e-9, "two I_IL");
  close(
    load.budgetMa,
    FAMILY_DEFAULTS.CD4000.sinkMa,
    1e-9,
    "the CMOS sink budget",
  );
});

test("the budget replaces the standard engine's fan-out rule", () => {
  // Two 74LS inputs on a CD4069UB: past the sheet's guaranteed minimum (the
  // digital engine's `ls-fanout`), within Spice Light's typical 1 mA.
  const doc = fanout(2);
  const digital = runner(doc).run(0, signals).result;
  assert.ok(digital.warnings.some((w) => w.type === "ls-fanout"));
  const r = spiceRun(doc);
  assert.ok(!r.warnings.some((w) => w.type === "ls-fanout"));
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
});

test("past the budget: a brownout warning; past twice it: brown smoke", () => {
  let r = spiceRun(fanout(3)); // 1.2 mA of 1 mA
  let w = r.warnings.find((x) => x.type === "brownout");
  assert.ok(w, "brownout");
  assert.equal(w.chip, "u1");
  assert.equal(w.smoke, false);
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OK);

  r = spiceRun(fanout(5)); // 2.0 mA of 1 mA
  w = r.warnings.find((x) => x.type === "brownout");
  assert.equal(OVERLOAD_RATIO, 2);
  assert.equal(w.smoke, true);
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OVERLOADED);
});

test("a chip is warned about once, for its worst output", () => {
  // One CD4069UB: 1Y sinks three 74LS inputs (a brownout), 2Y five (smoke).
  const b = bench();
  const drv = inverter(b, "u1", "CD4069UB", "e10");
  b.signal("in", drv.get(1), "high");
  b.link(drv.get(1), drv.get(3)); // both inverters' inputs HIGH: both LOW
  const ls = inverter(b, "u2", "74LS04", "e20");
  const ls2 = inverter(b, "u3", "74LS04", "e30");
  let from = drv.get(2);
  for (const pin of [1, 3, 5]) {
    b.link(from, ls.get(pin));
    from = ls.get(pin);
  }
  from = drv.get(4);
  for (const pin of [9, 11, 13]) {
    b.link(from, ls.get(pin));
    from = ls.get(pin);
  }
  for (const pin of [1, 3]) {
    b.link(from, ls2.get(pin));
    from = ls2.get(pin);
  }
  const r = spiceRun(b.doc);
  const mine = r.warnings.filter((w) => w.type === "brownout" && w.chip === "u1"); // prettier-ignore
  assert.equal(mine.length, 1);
  assert.equal(mine[0].smoke, true, "the worst one");
  assert.equal(mine[0].inputs, 5);
});

test("an overloaded chip is dead for the run", () => {
  const doc = fanout(5);
  doc.components.find((c) => c.id === "u1").params.overloaded = true;
  const r = runner(doc).run(0, signals).result; // even on the digital engine
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OVERLOADED);
  assert.ok(r.warnings.some((w) => w.type === "overloaded" && w.chip === "u1"));
});

test("a buffer carries its own budget: a CD4050B holds five 74LS inputs LOW", () => {
  // What a CD4069UB cannot (brown smoke at five), the buffer the guide says
  // to put between the families does: SCHS046L's 3.3 mA sink.
  const b = bench();
  const buf = b.seat("u1", "CD4050B", "e10");
  b.vcc(buf.get(1));
  b.gnd(buf.get(8));
  b.signal("in", buf.get(3), "low"); // A → G (pin 2)
  const ls = inverter(b, "u2", "74LS04", "e30");
  let from = buf.get(2);
  for (const pin of [1, 3, 5, 9, 11]) {
    b.link(from, ls.get(pin));
    from = ls.get(pin);
  }
  const r = runner(b.doc, { engine: "spice" }).run(
    0,
    new Map([["in", L]]),
  ).result;
  const load = r.loads.get("u1:2");
  assert.equal(load.level, L);
  close(load.loadMa, 2, 1e-9, "five I_IL");
  close(load.budgetMa, 3.3, 1e-9, "the buffer's own sink");
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OK);
});

test("bus drivers state their own budgets, and a pin may state its own", () => {
  const config = normalizeSpiceConfig(null);
  assert.deepEqual(outputDrive(config, partDef("74LS04"), 2), {
    sinkMa: FAMILY_DEFAULTS["74LS"].sinkMa,
    sourceMa: FAMILY_DEFAULTS["74LS"].sourceMa,
  });
  assert.deepEqual(outputDrive(config, partDef("74LS244"), 18), {
    sinkMa: 24,
    sourceMa: 15,
  });
  // The '595's eight outputs are 24 mA; QH′, the serial hand-off, is not.
  assert.deepEqual(outputDrive(config, partDef("74LS595"), 15), {
    sinkMa: 24,
    sourceMa: 2.6,
  });
  assert.deepEqual(outputDrive(config, partDef("74LS595"), 9), {
    sinkMa: 16,
    sourceMa: 1,
  });
  // A CMOS buffer states its sink only; its source is the family's.
  assert.deepEqual(outputDrive(config, partDef("CD4049UB"), 2), {
    sinkMa: 3.3,
    sourceMa: FAMILY_DEFAULTS.CD4000.sourceMa,
  });
  // A family override reaches every part that does not state its own.
  const own = normalizeSpiceConfig({ families: { "74LS": { sinkMa: 4 } } });
  assert.equal(outputDrive(own, partDef("74LS04"), 2).sinkMa, 4);
  assert.equal(outputDrive(own, partDef("74LS244"), 18).sinkMa, 24);
});

test("the digital engine knows nothing of budgets", () => {
  const r = runner(fanout(5)).run(0, signals).result;
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OK);
});

/** A 74LS04 on a supply loaded with `n` 100 Ω resistors across the rails. */
function loadedSupply(n, limit) {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  for (let i = 0; i < n; i++) {
    const r = b.seat(`r${i}`, "resistor", `a${30 + i * 5}`, { ohms: 100 });
    b.vcc(r.get(1));
    b.gnd(r.get(2));
  }
  if (limit != null) b.doc.components[0].params.currentLimit = limit;
  return { doc: b.doc, u };
}

/** A powered `ref` inverter whose 1Y (pin 2) lights a red LED through
    `ohms` — sourcing it (LED to GND) or sinking it (LED from VCC). */
function lamp(ref, { volts = 5, ohms = 1e3, sink = false } = {}) {
  const b = bench({ volts });
  const u = inverter(b, "u1", ref, "e10");
  (sink ? b.vcc : b.gnd)(u.get(1)); // 1Y LOW to sink, HIGH to source
  const r = b.seat("r1", "resistor", "a20", { ohms });
  const d = b.seat("d1", "led", "a30", { color: "red" });
  if (sink) {
    b.vcc(r.get(1));
    b.link(r.get(2), d.get(1));
    b.link(d.get(2), u.get(2));
  } else {
    b.link(u.get(2), r.get(1));
    b.link(r.get(2), d.get(1));
    b.gnd(d.get(2));
  }
  return { b, u };
}

test("a chip output's lamp is booked to the supply, CMOS at 5 V included", () => {
  // The LED rule drops a ≤ 5 V CD4000 output from the HARD levels; the
  // supply reading takes what the chip DRIVES.
  for (const [ref, volts] of [
    ["74LS04", 5],
    ["CD4069UB", 5],
    ["CD4069UB", 9],
  ]) {
    for (const sink of [false, true]) {
      const { b } = lamp(ref, { volts, sink });
      const r = runner(b.doc, { engine: "spice" }).run(0).result;
      const icc = partDef(ref) && FAMILY_DEFAULTS[ref === "74LS04" ? "74LS" : "CD4000"].supplyMa / 1000; // prettier-ignore
      const led = (volts - FORWARD_VOLTS.red) / 1e3;
      close(r.supplies.get("psu1").amps, icc + led, 1e-9, `${ref} ${volts} V ${sink ? "sinking" : "sourcing"}`); // prettier-ignore
    }
  }
});

test("sunk current returns through the sinking chip's GND pin", () => {
  const { b, u } = lamp("74LS04", { sink: true });
  const netlist = buildNetlist(b.doc);
  let ctx = null;
  const driven = new Map();
  const result = digitalTick({
    document: b.doc,
    netlist,
    hooks: {
      context: (c) => (ctx = c),
      outputs: (c, outs) => (driven.set(c.comp.id, outs), outs),
    },
  });
  const { draws } = measureSupplies({
    doc: b.doc,
    netlist,
    ctx,
    netLevels: result.netLevels,
    strongLevels: result.strongLevels,
    nodeVolts: new Map(),
    config: normalizeSpiceConfig(null),
    driven,
  });
  const led = draws.find((d) => d.chip == null);
  const gnd = supplyTopology(b.doc, netlist).feeds.get("u1").gndAt;
  assert.equal(led.minusAt, gnd, "out through the chip's own ground");
  assert.equal(gnd, b.at(u.get(7)));
});

test("a switch channel to + feeds its load from the supply (a PNP high side)", () => {
  const b = bench();
  const q = b.seat("q1", "pnp", "a10"); // E · B · C
  b.vcc(q.get(1));
  b.gnd(q.get(2)); // base LOW: on
  const r = b.seat("r1", "resistor", "a20", { ohms: 100 });
  const d = b.seat("d1", "led", "a30", { color: "red" });
  b.link(q.get(3), r.get(1));
  b.link(r.get(2), d.get(1));
  b.gnd(d.get(2));
  const res = runner(b.doc, { engine: "spice" }).run(0).result;
  close(res.supplies.get("psu1").amps, (5 - FORWARD_VOLTS.red) / 100, 1e-9, "the LED's current"); // prettier-ignore
});

test("a supply its own chip's load pulls down stays down: no flicker", () => {
  // A 74LS04 lighting six 100 Ω LEDs (193 mA) from a 100 mA supply: the
  // droop leaves it underpowered, and its load is still booked (as it last
  // drove it), so every tick reads the same.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1));
  let from = u.get(2);
  for (let i = 0; i < 6; i++) {
    const r = b.seat(`r${i}`, "resistor", `a${20 + i * 7}`, { ohms: 100 });
    const d = b.seat(`d${i}`, "led", `a${24 + i * 7}`, { color: "red" });
    b.link(from, r.get(1)); // daisy-chained: one net
    from = r.get(1);
    b.link(r.get(2), d.get(1));
    b.gnd(d.get(2));
  }
  b.doc.components[0].params.currentLimit = 0.1;
  const sim = runner(b.doc, { engine: "spice" });
  const seen = [];
  for (let i = 0; i < 6; i++) {
    const r = sim.run(i * 0.01).result;
    seen.push([r.chipStatus.get("u1").status, r.supplies.get("psu1").limited]);
  }
  for (const s of seen) {
    assert.deepEqual(s, [CHIP_STATUS.UNDERPOWERED, true], JSON.stringify(seen));
  }
});

test("a tri-state output switched off is no driver; a bus pin driving is one", () => {
  // A 74LS125 with 1G HIGH (1Y off) on the same net as a 74LS04's 1Y.
  const b = bench();
  const t = inverter(b, "u1", "74LS125", "e10");
  b.vcc(t.get(1));
  const n = inverter(b, "u2", "74LS04", "e30");
  b.link(t.get(3), n.get(2));
  b.link(n.get(2), n.get(3)); // a load on the net: 2A
  let r = runner(b.doc, { engine: "spice" }).run(0).result;
  assert.ok(!r.loads.has("u1:3"), "off: no budget, no load");
  assert.ok(r.loads.has("u2:2"));
  // A '245 B port driving (DIR HIGH: A → B, OE LOW) carries its own 24 mA.
  const b2 = bench();
  const x = b2.seat("u1", "74LS245", "e10");
  b2.vcc(x.get(20));
  b2.gnd(x.get(10));
  b2.vcc(x.get(1)); // DIR
  b2.gnd(x.get(19)); // OE
  b2.gnd(x.get(2)); // A1 LOW
  const ls = inverter(b2, "u2", "74LS04", "e40");
  b2.link(x.get(18), ls.get(1)); // B1 → 1A
  r = runner(b2.doc, { engine: "spice" }).run(0).result;
  const load = r.loads.get("u1:18");
  assert.ok(load, "the io pin is a driver while it drives");
  assert.equal(load.budgetMa, 24);
});

test("a family-less part's inputs load a net as MOS inputs, not TTL ones", () => {
  // Five RAM address inputs on one CD4069UB output held LOW: 50 µA of its
  // 1 mA, where five 74LS inputs would let out the smoke.
  const b = bench();
  const drv = inverter(b, "u1", "CD4069UB", "e10");
  b.signal("in", drv.get(1), "high");
  const ram = b.seat("u2", "ram-8k", "e30");
  b.vcc(ram.get(28));
  b.gnd(ram.get(14));
  let from = drv.get(2);
  for (const pin of [1, 2, 3, 4, 5]) {
    b.link(from, ram.get(pin));
    from = ram.get(pin);
  }
  const r = spiceRun(b.doc);
  close(r.loads.get("u1:2").loadMa, 0.05, 1e-9, "five MOS inputs");
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
});

test("the supply topology is read once per netlist", () => {
  const { doc } = loadedSupply(2);
  const netlist = buildNetlist(doc);
  const topo = supplyTopology(doc, netlist);
  assert.equal(supplyTopology(doc, netlist), topo, "cached");
  assert.notEqual(supplyTopology(doc, buildNetlist(doc)), topo);
  assert.equal(topo.psus.length, 1);
  assert.equal(topo.resistors.length, 2);
  assert.ok(topo.feeds.has("u1"));
});

test("a supply within its limit holds its voltage and reports its current", () => {
  const { doc } = loadedSupply(4); // 4 × 50 mA + one 74LS04
  const r = spiceRun(doc);
  const s = r.supplies.get("psu1");
  const icc = FAMILY_DEFAULTS["74LS"].supplyMa / 1000;
  close(s.amps, 0.2 + icc, 1e-9, "200 mA of resistors + ICC");
  assert.equal(s.volts, 5);
  assert.equal(s.limited, false);
  assert.equal(s.limit, DEFAULT_CURRENT_LIMIT);
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OK);
});

test("past its limit a supply droops in proportion, and its chips go underpowered", () => {
  const { doc } = loadedSupply(4, 0.1); // 201.6 mA asked of a 100 mA supply
  const r = spiceRun(doc);
  const s = r.supplies.get("psu1");
  const demand = 0.2 + FAMILY_DEFAULTS["74LS"].supplyMa / 1000;
  assert.equal(s.limited, true);
  close(s.demand, demand, 1e-9, "demand");
  close(s.volts, (5 * 0.1) / demand, 1e-9, "V = Vset · Ilimit / Idemand");
  assert.equal(s.amps, 0.1);
  // The engine's own check: 2.5 V is under the 74LS's 4.75 V minimum.
  const status = r.chipStatus.get("u1");
  assert.equal(status.status, CHIP_STATUS.UNDERPOWERED);
  close(status.volts, s.volts, 1e-9, "the chip saw the drooped supply");
  assert.ok(r.warnings.some((w) => w.type === "underpowered"));
});

test("a chip its supply's droop turns off stops driving its RC at once", () => {
  // A 74LS04's 1Y charges an RC — but a 25 Ω load asks 200 mA of a 100 mA
  // supply, which droops to 2.5 V and leaves the inverter underpowered. Its
  // output stops driving in the settle that sees the droop, so the node holds
  // its empty capacitor's 0 V rather than charging on toward 5 V.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1)); // 1Y HIGH while powered
  const load = b.seat("rl", "resistor", "a30", { ohms: 25 });
  b.vcc(load.get(1));
  b.gnd(load.get(2));
  const res = b.seat("r1", "resistor", "a40", { ohms: 10e3 });
  b.link(u.get(2), res.get(1));
  const cap = b.seat("c1", "cap-electrolytic", "a50", { farads: 10e-6 });
  b.link(res.get(2), cap.get(1));
  b.gnd(cap.get(2));
  b.doc.components[0].params.currentLimit = 0.1;
  const sim = runner(b.doc, { engine: "spice" });
  let r = sim.run(0).result;
  close(r.supplies.get("psu1").volts, 2.5, 0.02, "drooped");
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.UNDERPOWERED);
  // The same tick knows the node has nothing driving it: no curve to show,
  // nothing to wake for.
  assert.equal(r.wakeAt, null, "a node with no drive asks for no frames");
  const node = sim.netlist.netOfPoint.get(b.at(cap.get(1)));
  r = sim.run(0.5).result;
  assert.ok(r.nodeVolts.get(node) < 0.01, `it holds: ${r.nodeVolts.get(node)}`); // prettier-ignore
});

test("a slight overload droops a little — no cliff", () => {
  const { doc } = loadedSupply(2, 0.1); // 101.6 mA of 100 mA
  const s = spiceRun(doc).supplies.get("psu1");
  close(s.volts, (5 * 0.1) / 0.1016, 1e-9, "a 1.6 % droop");
  assert.ok(s.volts > 4.9);
});

test("an LED through a resistor draws (V − VF) / R", () => {
  const b = bench();
  const r = b.seat("r1", "resistor", "a30", { ohms: 330 });
  const led = b.seat("d1", "led", "a40", { color: "red" });
  b.vcc(r.get(1));
  b.link(r.get(2), led.get(1)); // anode
  b.gnd(led.get(2)); // cathode
  const s = spiceRun(b.doc).supplies.get("psu1");
  close(s.amps, (5 - FORWARD_VOLTS.red) / 330, 1e-9, "the LED's current");

  // Turned round, it blocks: no current at all.
  const back = bench();
  const r2 = back.seat("r1", "resistor", "a30", { ohms: 330 });
  const led2 = back.seat("d1", "led", "a40", { color: "red" });
  back.vcc(r2.get(1));
  back.link(r2.get(2), led2.get(2)); // cathode toward the supply
  back.gnd(led2.get(1));
  assert.equal(spiceRun(back.doc).supplies.get("psu1").amps, 0);
});

test("the PSU's current limit is stored only when it is not the default", () => {
  const def = partDef("psu");
  assert.deepEqual(def.normalizeParams({ volts: 5 }), { volts: 5 });
  assert.deepEqual(def.normalizeParams({ volts: 5, currentLimit: 1 }), { volts: 5 }); // prettier-ignore
  assert.deepEqual(def.normalizeParams({ volts: 9, currentLimit: 0.5 }), { volts: 9, currentLimit: 0.5 }); // prettier-ignore
  assert.deepEqual(def.normalizeParams({ volts: 5, currentLimit: 7 }), { volts: 5 }); // prettier-ignore
  const field = def.properties.find((f) => f.key === "currentLimit");
  assert.equal(field.default, DEFAULT_CURRENT_LIMIT);
  assert.deepEqual(
    field.options.map((o) => o.label),
    ["100 mA", "250 mA", "500 mA", "1 A", "2 A", "3 A", "5 A"],
  );
});

test("the PSU readout: the current, and the drooped voltage at the limit", () => {
  assert.equal(
    supplyReadout({ volts: 5, amps: 0.035, limited: false }),
    "35 mA",
  );
  assert.equal(
    supplyReadout({ volts: 5, amps: 1.2, limited: false }),
    "1.20 A",
  );
  assert.equal(
    supplyReadout({ volts: 2.48, amps: 0.1, limited: true }),
    "2.48 V · 100 mA",
  );
});
