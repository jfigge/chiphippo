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

// spice-current.test.js — Spice Lite's current model (features/done/
// spice-lite.md §4.5–§4.6): fan-out as the voltage solve's own (a
// Brownout where an output's load holds its net where its inputs misread
// it — a warning, never smoke), a supply's demand and its droop past its
// current limit (which the engine's own power check turns into
// "underpowered"), a supply shorted + to −, and the PSU's param and readout.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { CHIP_STATUS } from "../sim/engine.js";
import {
  FAMILY_DEFAULTS,
  TTL_INPUT,
  inputStages,
  stageStrength,
} from "../sim/spice/params.js";
import { outputStage } from "../sim/spice/output-stage.js";
import { LED_SPECS, ledKnee } from "../sim/spice/leds.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";
import { SHORT_OHMS, supplyTopology } from "../sim/spice/supply.js";
import { buildNetlist } from "../sim/netlist.js";
import { CHIP_DEFS, partDef } from "../catalog/index.js";
import { familyOf } from "../catalog/families.js";
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
    `n` 74LS04 inputs — each pushing its bias current (1.3 V behind 4.5 kΩ,
    spice/params.js TTL_INPUT) into the CMOS output's 400 Ω LOW. */
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
  return { doc: b.doc, drv };
}

const signals = new Map([["in", H]]);
const spiceRun = (doc, spice = null) =>
  runner(doc, { engine: "spice", spice }).run(0, signals).result;

/** Where `n` 74LS inputs hold a CD4000 LOW at 5 V: their biases' Thévenin
    against the output's 400 Ω. */
const heldAt = (n) => {
  const g = 1 / 400 + n / TTL_INPUT.ohms;
  return (n * TTL_INPUT.volts) / TTL_INPUT.ohms / g;
};

test("fan-out is the solve's own: a CD4069UB holds six 74LS inputs LOW, unharmed", () => {
  for (const n of [2, 5, 6]) {
    const { doc, drv } = fanout(n);
    const sim = runner(doc, { engine: "spice" });
    const r = sim.run(0, signals).result;
    const net = sim.netlist.netOfPoint.get(`bb1.${drv.get(2)}`);
    close(r.nodeVolts.get(net), heldAt(n), 1e-6, `${n} inputs`);
    assert.ok(r.nodeVolts.get(net) < FAMILY_DEFAULTS["74LS"].vilV, "a LOW to them"); // prettier-ignore
    assert.equal(sim.level(drv.get(2)), L);
    assert.ok(!r.warnings.some((w) => w.type === "brownout"), `${n}: no brownout`); // prettier-ignore
    assert.ok(!r.warnings.some((w) => w.smoke), `${n}: no smoke`);
    assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OK);
  }
});

test("the solve replaces the standard engine's fan-out rule", () => {
  // Two 74LS inputs on a CD4069UB: past the sheet's guaranteed minimum (the
  // digital engine's `ls-fanout`); the solve holds them at 0.27 V.
  const { doc } = fanout(2);
  const digital = runner(doc).run(0, signals).result;
  assert.ok(digital.warnings.some((w) => w.type === "ls-fanout"));
  const r = spiceRun(doc);
  assert.ok(!r.warnings.some((w) => w.type === "ls-fanout"));
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
});

/** A 74LS04 whose 1Y is driven HIGH into `ohms` to GND, and read by 2A. */
function pulledDown(ohms) {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1)); // 1Y HIGH
  b.link(u.get(2), u.get(3)); // read by 2A
  const r = b.seat("r1", "resistor", "a30", { ohms });
  b.link(r.get(1), u.get(2));
  b.gnd(r.get(2));
  return { b, u };
}

test("a brownout: an output whose load holds its net where its inputs misread it", () => {
  // A 74LS HIGH (3.6 V behind 120 Ω) into 100 Ω to GND sits at about 1.6 V
  // — in the undefined band of the input reading it. A warning; the 16 mA
  // through the pin is within its 20 mA, so nothing smokes.
  const { b, u } = pulledDown(100);
  const sim = runner(b.doc, { engine: "spice" });
  const r = sim.run(0).result;
  const net = sim.netlist.netOfPoint.get(b.at(u.get(2)));
  const v = r.nodeVolts.get(net);
  close(v, (3.6 * 100) / 220, 1e-3, "the divider");
  const w = r.warnings.find((x) => x.type === "brownout");
  assert.ok(w, "brownout");
  assert.equal(w.chip, "u1");
  assert.equal(w.pin, 2);
  assert.equal(w.level, H);
  assert.equal(w.misread, 1);
  close(w.volts, v, 1e-9, "the net's own voltage");
  assert.equal(w.smoke, undefined, "never smoke");
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OK);
  assert.ok(!r.warnings.some((x) => x.type === "output-current"));
  assert.ok(r.loads.has("u1:2"));

  // A light load holds it: no warning.
  const light = pulledDown(1e3);
  assert.ok(!spiceRun(light.b.doc).warnings.some((x) => x.type === "brownout")); // prettier-ignore
});

test("an output that never reaches an input's threshold is no brownout", () => {
  // A 74LS HIGH's 3.6 V into a CMOS input whose VIH is set to 4 V: it is
  // short of it unloaded too, so no load is to blame (it reads unknown all
  // the same).
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1));
  const c = inverter(b, "u2", "CD4069UB", "e20");
  b.link(u.get(2), c.get(1));
  const spice = { families: { CD4000: { vihV: 4 } } };
  const sim = runner(b.doc, { engine: "spice", spice });
  const r = sim.run(0).result;
  assert.equal(sim.level(u.get(2)), "X", "the CMOS input reads it unknown");
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
});

test("an overloaded chip is dead for the run", () => {
  const { doc } = fanout(5);
  doc.components.find((c) => c.id === "u1").params.overloaded = true;
  const r = runner(doc).run(0, signals).result; // even on the digital engine
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OVERLOADED);
  assert.ok(r.warnings.some((w) => w.type === "overloaded" && w.chip === "u1"));
});

test("no 74LS part carries an electrical figure of its own", () => {
  for (const def of CHIP_DEFS) {
    if (familyOf(def) !== "74LS") continue;
    for (const key of ["drive", "outputStage", "highCurrent", "ledLimit"]) {
      assert.equal(def[key], undefined, `${def.id} states its own ${key}`);
    }
  }
});

test("the family's source and sink currents are its output stage's strength", () => {
  // Settings ▸ Spice Lite's figures are what the stage is built round: the
  // defaults leave it as it is, and twice the sink current is a LOW twice
  // as strong — half the resistance, twice the saturation current.
  const ls = partDef("74LS04");
  const cmos = partDef("CD4069UB");
  const plain = normalizeSpiceConfig(null);
  assert.equal(stageStrength(plain, ls, H), 1);
  assert.equal(stageStrength(plain, cmos, L), 1);
  assert.equal(stageStrength(plain, partDef("ram-8k"), L), 1, "no family");
  const own = normalizeSpiceConfig({
    families: { "74LS": { sinkMa: 16 }, CD4000: { sourceMa: 2 } },
  });
  assert.equal(stageStrength(own, ls, L), 2);
  assert.equal(stageStrength(own, ls, H), 1);
  const lo = outputStage(ls, 5, L, stageStrength(own, ls, L));
  close(lo.ohms, outputStage(ls, 5, L).ohms / 2, 1e-12, "a 74LS LOW at 16 mA");
  const hi = outputStage(cmos, 5, H, stageStrength(own, cmos, H));
  close(hi.ohms, 200, 1e-12, "a CMOS HIGH at 2 mA");
  close(hi.limit, 0.0084, 1e-12, "and twice the saturation current");

  // …and it reaches the solve: a stronger CMOS LOW holds five 74LS inputs
  // nearer ground.
  const { doc, drv } = fanout(5);
  const sim = runner(doc, {
    engine: "spice",
    spice: { families: { CD4000: { sinkMa: 2 } } },
  });
  const r = sim.run(0, signals).result;
  const net = sim.netlist.netOfPoint.get(`bb1.${drv.get(2)}`);
  const g = 1 / 200 + 5 / TTL_INPUT.ohms;
  close(r.nodeVolts.get(net), ((5 * TTL_INPUT.volts) / TTL_INPUT.ohms) / g, 1e-6, "at 200 Ω"); // prettier-ignore
});

test("the family's IIL is its 74LS input's bias; a CMOS input's leaks only when set", () => {
  const ls = partDef("74LS04");
  const [bias] = inputStages(ls, 5);
  close(bias.ohms, TTL_INPUT.ohms, 1e-12, "the default");
  const own = normalizeSpiceConfig({ families: { "74LS": { inputLowUa: 800 } } }); // prettier-ignore
  close(inputStages(ls, 5, own)[0].ohms, TTL_INPUT.ohms / 2, 1e-12, "twice the IIL"); // prettier-ignore
  const cmos = partDef("CD4069UB");
  assert.equal(inputStages(cmos, 5).length, 2, "its two diodes, no leak");
  const leaky = normalizeSpiceConfig({ families: { CD4000: { inputLowUa: 1 } } }); // prettier-ignore
  const stages = inputStages(cmos, 5, leaky);
  assert.equal(stages.length, 3);
  close(stages[2].limit, 1e-6, 1e-12, "1 µA out of the pin");
});

test("the digital engine knows nothing of fan-out currents", () => {
  const r = runner(pulledDown(100).b.doc).run(0).result;
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.OK);
});

test("a supply shorted + to − sits on its limit, drooped to nothing", () => {
  const b = bench();
  inverter(b, "u1", "74LS04", "e10");
  b.doc.wires.push({ id: "ws", from: "psu1.+", to: "psu1.-", color: "red" });
  const r = spiceRun(b.doc);
  const s = r.supplies.get("psu1");
  assert.equal(s.limited, true);
  assert.equal(s.amps, DEFAULT_CURRENT_LIMIT);
  assert.ok(s.demand >= 5 / SHORT_OHMS, `asked ${s.demand} A`);
  assert.ok(s.volts < 0.2, `drooped to ${s.volts} V`);
  assert.ok(
    r.warnings.some((w) => w.type === "short"),
    "and said",
  );
  // The digital engine has no current to limit: the short alone.
  assert.ok(runner(b.doc).run(0).result.warnings.some((w) => w.type === "short")); // prettier-ignore
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

/** A red LED's knee and dynamic resistance (spice/leds.js). */
const RED_KNEE = ledKnee(LED_SPECS.red);
const RED_RD = LED_SPECS.red.rdOhm;

test("a chip output's lamp is booked to the supply, as the stage it is", () => {
  // The supply reading takes the LED's network as spice/lamps.js solves it:
  // the output as its family's stage (spice/output-stage.js — a 74LS HIGH
  // is VCC − 1.4 V behind 120 Ω, its LOW 0.15 V behind 25 Ω; a CD4000
  // output 400 Ω at 5 V and 232 Ω at 9 V, under its saturation current),
  // the LED at its knee behind its dynamic resistance.
  for (const [ref, volts, sink, led] of [
    ["74LS04", 5, false, (5 - 1.4 - RED_KNEE) / (120 + 1e3 + RED_RD)],
    ["74LS04", 5, true, (5 - RED_KNEE - 0.15) / (1e3 + RED_RD + 25)],
    ["CD4069UB", 5, false, (5 - RED_KNEE) / (400 + 1e3 + RED_RD)],
    ["CD4069UB", 5, true, (5 - RED_KNEE) / (400 + 1e3 + RED_RD)],
    ["CD4069UB", 9, false, (9 - RED_KNEE) / (232 + 1e3 + RED_RD)],
    ["CD4069UB", 9, true, (9 - RED_KNEE) / (232 + 1e3 + RED_RD)],
  ]) {
    const { b } = lamp(ref, { volts, sink });
    const r = runner(b.doc, { engine: "spice" }).run(0).result;
    const icc = partDef(ref) && FAMILY_DEFAULTS[ref === "74LS04" ? "74LS" : "CD4000"].supplyMa / 1000; // prettier-ignore
    close(r.supplies.get("psu1").amps, icc + led, 1e-5, `${ref} ${volts} V ${sink ? "sinking" : "sourcing"}`); // prettier-ignore
    close(r.lamps.get("d1").amps, led, 1e-5, "the LED's own current");
  }
});

test("sunk current returns through the sinking chip's GND pin", () => {
  const { b, u } = lamp("74LS04", { sink: true });
  const sim = runner(b.doc, { engine: "spice" });
  const { draws } = sim.run(0).result;
  const led = draws.find((d) => d.chip == null);
  const gnd = supplyTopology(b.doc, sim.netlist).feeds.get("u1").gndAt;
  assert.equal(led.minusAt, gnd, "out through the chip's own ground");
  assert.equal(gnd, b.at(u.get(7)));
});

test("a PNP high side feeds its load from the supply, and its base draws too", () => {
  const b = bench();
  const q = b.seat("q1", "pnp", "a10"); // E · B · C
  b.vcc(q.get(1));
  const rb = b.seat("rb", "resistor", "a40", { ohms: 1e3 });
  b.link(rb.get(1), q.get(2));
  b.gnd(rb.get(2)); // base pulled LOW through 1 kΩ: on
  const r = b.seat("r1", "resistor", "a20", { ohms: 100 });
  const d = b.seat("d1", "led", "a30", { color: "red" });
  b.link(q.get(3), r.get(1));
  b.link(r.get(2), d.get(1));
  b.gnd(d.get(2));
  // Saturated (β × 4.3 mA is far more than the LED can take): the collector
  // sits VCE(sat) 0.2 V (behind 1 Ω) under the emitter.
  const led = (5 - 0.2 - RED_KNEE) / (100 + RED_RD + 1);
  const base = (5 - 0.65) / (1e3 + 2);
  const res = runner(b.doc, { engine: "spice" }).run(0).result;
  close(res.lamps.get("d1").amps, led, 1e-6, "the LED's current");
  close(res.supplies.get("psu1").amps, led + base, 1e-6, "and the base's");
});

test("a supply its own chip's load pulls down stays down: no flicker", () => {
  // A 74LS04 SINKING six red LEDs, each through 100 Ω from VCC (~70 mA into
  // its LOW, 25 Ω to 0.15 V) from a 50 mA supply: the droop leaves it
  // underpowered, and its load is still booked (as it last drove it), so
  // every tick reads the same.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.vcc(u.get(1));
  let from = u.get(2);
  for (let i = 0; i < 6; i++) {
    const r = b.seat(`r${i}`, "resistor", `a${20 + i * 7}`, { ohms: 100 });
    const d = b.seat(`d${i}`, "led", `a${24 + i * 7}`, { color: "red" });
    b.vcc(r.get(1));
    b.link(r.get(2), d.get(1));
    b.link(d.get(2), from); // daisy-chained: one net, the output's
    from = d.get(2);
  }
  b.doc.components[0].params.currentLimit = 0.05;
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

test("a tri-state output switched off is no driver", () => {
  // A 74LS125 with 1G HIGH (1Y off) on the same net as a 74LS04's 1Y, which
  // is driven HIGH into 100 Ω to GND and read by 2A: the brownout is the
  // '04's alone.
  const b = bench();
  const t = inverter(b, "u1", "74LS125", "e10");
  b.vcc(t.get(1));
  const n = inverter(b, "u2", "74LS04", "e30");
  b.gnd(n.get(1));
  b.link(t.get(3), n.get(2));
  b.link(n.get(2), n.get(3)); // read by 2A
  const r1 = b.seat("r1", "resistor", "a50", { ohms: 100 });
  b.link(r1.get(1), n.get(2));
  b.gnd(r1.get(2));
  const r = spiceRun(b.doc);
  assert.ok(!r.loads.has("u1:3"), "off: no driver");
  assert.ok(r.loads.has("u2:2"));
  const mine = r.warnings.filter((w) => w.type === "brownout");
  assert.deepEqual(
    mine.map((w) => w.chip),
    ["u2"],
  );
});

test("a family-less part's inputs barely load a net: MOS inputs", () => {
  // Five RAM address inputs on one CD4069UB output held LOW: they draw
  // nothing, so it sits at 0 V.
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
  const sim = runner(b.doc, { engine: "spice" });
  const r = sim.run(0, signals).result;
  const net = sim.netlist.netOfPoint.get(`bb1.${drv.get(2)}`);
  assert.ok(Math.abs(r.nodeVolts.get(net)) < 1e-6, `${r.nodeVolts.get(net)} V`);
  assert.ok(!r.warnings.some((w) => w.type === "brownout"));
});

test("the supply topology is read once per netlist", () => {
  const { doc } = loadedSupply(2);
  const netlist = buildNetlist(doc);
  const topo = supplyTopology(doc, netlist);
  assert.equal(supplyTopology(doc, netlist), topo, "cached");
  assert.notEqual(supplyTopology(doc, buildNetlist(doc)), topo);
  assert.equal(topo.psus.length, 1);
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
  close(s.amps, (5 - RED_KNEE) / (330 + RED_RD), 1e-5, "the LED's current");

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
