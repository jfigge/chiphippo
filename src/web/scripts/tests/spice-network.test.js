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

// spice-network.test.js — every net a voltage (sim/spice/voltages.js,
// features/spice-lite-audit.md phase B). Each circuit the audit found the
// digital engine's strength rules getting wrong is built here and held to
// what a bench would show — the inputs reading their own net's VOLTAGE —
// beside the digital engine, which is left exactly as it was.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, X } from "../sim/levels.js";
import { CHIP_STATUS } from "../sim/engine.js";
import { solveDrivers } from "../sim/spice/voltages.js";
import { outputStage } from "../sim/spice/output-stage.js";
import {
  CMOS_BAND_MA,
  CMOS_CLAMP,
  OUTPUT_LIMITS,
  TTL_INPUT,
  inputStages,
} from "../sim/spice/params.js";
import { partDef } from "../catalog/index.js";
import { bench, runner } from "./timing-fixtures.js";

const close = (actual, expected, tol, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: ${actual} vs ${expected}`,
  );

/** A powered inverter package at `anchor`: pin → hole. */
function inverter(b, id, ref, anchor) {
  const u = b.seat(id, ref, anchor);
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  return u;
}

/** Run a desk once on both engines: each runner, and its first result. */
function both(doc) {
  const digital = runner(doc);
  const spice = runner(doc, { engine: "spice" });
  return {
    digital,
    spice,
    d: digital.run(0).result,
    s: spice.run(0).result,
  };
}

/** A hole's net's voltage under Spice Lite. */
const voltsAt = (sim, result, hole) =>
  result.nodeVolts.get(sim.netlist.netOfPoint.get(`bb1.${hole}`));

/** A second supply, at `volts`, sharing the first's ground: the wire that
    is laid next lands on its + (or −) instead. */
function secondSupply(b, volts) {
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 20, y: 30, params: { volts } }); // prettier-ignore
  const last = () => b.doc.wires[b.doc.wires.length - 1];
  return {
    vcc(hole) {
      b.vcc(hole);
      last().from = "psu2.+";
    },
  };
}

/** The Thévenin a 74LS input sees at its own pin below 1.3 V. */
const ttlBias = (g, i) => {
  const gTotal = g + 1 / TTL_INPUT.ohms;
  return (i + TTL_INPUT.volts / TTL_INPUT.ohms) / gTotal;
};

test("a diode-AND: the diode carries the LOW through to the input (B)", () => {
  // 10 k from + to N; a diode, anode N, to 1Y driven LOW; N into 2A. The
  // digital engine has no forward drop — a pulled-up anode reads HIGH; on a
  // bench N sits a diode above the LOW, which 2A reads LOW.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.vcc(u.get(1)); // 1Y LOW
  const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.vcc(r.get(1));
  const d = b.seat("d1", "diode", "a40");
  b.link(r.get(2), d.get(1));
  b.link(d.get(2), u.get(2));
  b.link(r.get(2), u.get(3));
  const { digital, spice, s } = both(b.doc);
  assert.equal(digital.level(u.get(3)), H, "digital: the pull-up wins");
  assert.equal(spice.level(u.get(3)), L, "a diode above the LOW reads LOW");
  assert.equal(spice.level(u.get(4)), H);
  const v = voltsAt(spice, s, u.get(3));
  assert.ok(v > 0.6 && v < 0.8, `a diode drop above 1Y: ${v}`);
});

test("a divider reads its voltage, not X (C)", () => {
  // 10 k from +, 1 k to GND, into a 74LS input: two pulls the digital engine
  // cannot weigh (X). The input's own current adds to the 1 k's share.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.vcc(r1.get(1));
  b.link(r1.get(2), u.get(1));
  const r2 = b.seat("r2", "resistor", "a40", { ohms: 1e3 });
  b.link(r2.get(1), u.get(1));
  b.gnd(r2.get(2));
  const { digital, spice, s } = both(b.doc);
  assert.equal(digital.level(u.get(1)), X);
  const v = ttlBias(1 / 10e3 + 1 / 1e3, 5 / 10e3);
  close(voltsAt(spice, s, u.get(1)), v, 1e-6, "the divider, the input on it");
  assert.equal(spice.level(u.get(1)), L);
  assert.equal(spice.level(u.get(2)), H, "and the gate acts on it");
});

test("a potentiometer's wiper reads where it is (K)", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  const p = b.seat("p1", "pot", "a30", { ohms: 10e3, position: 90 });
  b.vcc(p.get(1));
  b.gnd(p.get(3));
  b.link(p.get(2), u.get(1));
  const { digital, spice, s } = both(b.doc);
  assert.equal(digital.level(u.get(1)), X);
  close(voltsAt(spice, s, u.get(1)), ttlBias(1 / 9e3 + 1 / 1e3, 5 / 9e3), 1e-6, "9 k up, 1 k down"); // prettier-ignore
  assert.equal(spice.level(u.get(2)), H);
});

test("a 74LS input pulled down through 10 kΩ sits in its undefined band (J)", () => {
  // Its own current out of the pin holds it at 0.9 V — the digital engine's
  // pull says LOW; a bench meter says it is not a valid LOW. Through 1 kΩ
  // (catalog/families.js pullDownOhms) it is.
  for (const [ohms, level] of [
    [10e3, X],
    [1e3, L],
  ]) {
    const b = bench();
    const u = inverter(b, "u1", "74LS04", "e10");
    const r = b.seat("r1", "resistor", "a30", { ohms });
    b.link(r.get(1), u.get(1));
    b.gnd(r.get(2));
    const { digital, spice, s } = both(b.doc);
    assert.equal(digital.level(u.get(1)), L);
    close(voltsAt(spice, s, u.get(1)), ttlBias(1 / ohms, 0), 1e-6, `${ohms} Ω`); // prettier-ignore
    assert.equal(spice.level(u.get(1)), level, `${ohms} Ω reads ${level}`);
  }
});

test("a 74LS HIGH into a 12 V CMOS input is no HIGH to it (D)", () => {
  const b = bench();
  const ls = inverter(b, "u1", "74LS04", "e10");
  b.gnd(ls.get(1)); // 1Y HIGH
  const cmos = b.seat("u2", "CD4069UB", "e30");
  secondSupply(b, 12).vcc(cmos.get(14));
  b.gnd(cmos.get(7));
  b.link(ls.get(2), cmos.get(1));
  const { digital, spice, d, s } = both(b.doc);
  assert.equal(digital.level(cmos.get(1)), H, "digital: a HIGH is a HIGH");
  close(voltsAt(spice, s, cmos.get(1)), 3.6, 1e-9, "VCC less two VBE");
  assert.notEqual(spice.level(cmos.get(2)), L, "the 12 V gate does not see a HIGH"); // prettier-ignore
  // The digital engine can only warn about it; Spice Lite shows it, and
  // retires the guesses.
  const types = (r) => new Set(r.warnings.map((w) => w.type));
  assert.ok(types(d).has("marginal-high") && types(d).has("mixed-supply"));
  assert.ok(!types(s).has("marginal-high") && !types(s).has("mixed-supply"));
});

test("a 12 V CMOS output into a 74LS input lets out the smoke", () => {
  const b = bench();
  const cmos = b.seat("u1", "CD4069UB", "e10");
  secondSupply(b, 12).vcc(cmos.get(14));
  b.gnd(cmos.get(7));
  b.gnd(cmos.get(1)); // 1Y HIGH, at 12 V
  const ls = inverter(b, "u2", "74LS04", "e30");
  b.link(cmos.get(2), ls.get(1));
  const { s } = both(b.doc);
  const w = s.warnings.find((x) => x.type === "input-overvoltage");
  assert.ok(w, "said");
  assert.equal(w.chip, "u2");
  assert.equal(w.smoke, true);
  assert.equal(s.chipStatus.get("u2").status, CHIP_STATUS.OVERLOADED);
});

test("a 12 V CMOS output into a 5 V CMOS input drives its protection diode", () => {
  const b = bench();
  const hi = b.seat("u1", "CD4069UB", "e10");
  secondSupply(b, 12).vcc(hi.get(14));
  b.gnd(hi.get(7));
  b.gnd(hi.get(1)); // 1Y HIGH, at 12 V
  const lo = inverter(b, "u2", "CD4069UB", "e30");
  b.link(hi.get(2), lo.get(1));
  const { spice, s } = both(b.doc);
  // The 12 V stage into the clamp at 5.5 V behind 200 Ω.
  const stage = outputStage(partDef("CD4069UB"), 12, H);
  const amps = (12 - 5 - CMOS_CLAMP.overV) / (stage.ohms + CMOS_CLAMP.ohms);
  close(voltsAt(spice, s, lo.get(1)), 5 + CMOS_CLAMP.overV + amps * CMOS_CLAMP.ohms, 1e-6, "clamped above its supply"); // prettier-ignore
  const w = s.warnings.find((x) => x.type === "input-clamp");
  close(w.amps, amps, 1e-9, "the diode's current");
  assert.equal(w.smoke, amps * 1000 > CMOS_CLAMP.smokeMa);
  assert.equal(s.chipStatus.get("u2").status, CHIP_STATUS.OVERLOADED);
});

test("a level shifter's input takes a voltage above its own supply", () => {
  // The CD4049UB has no diode to VDD: 12 V into it at 5 V is what it is for.
  const b = bench();
  const hi = b.seat("u1", "CD4069UB", "e10");
  secondSupply(b, 12).vcc(hi.get(14));
  b.gnd(hi.get(7));
  b.gnd(hi.get(1));
  const shifter = b.seat("u2", "CD4049UB", "e30");
  b.vcc(shifter.get(1)); // its VCC
  b.gnd(shifter.get(8));
  b.link(hi.get(2), shifter.get(3)); // input A
  const { spice, s } = both(b.doc);
  assert.equal(inputStages(partDef("CD4049UB"), 5).length, 1, "only the diode to VSS"); // prettier-ignore
  close(voltsAt(spice, s, shifter.get(3)), 12, 1e-6, "at the 12 V output");
  assert.equal(spice.level(shifter.get(2)), L, "it reads HIGH, inverts it");
  assert.ok(!s.warnings.some((w) => w.type.startsWith("input-")));
});

test("an output shorted to ground carries its short-circuit current (H)", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1)); // 1Y HIGH…
  b.gnd(u.get(2)); // …into ground
  const { s } = both(b.doc);
  const amps = 3.6 / 120;
  close(s.currents.get(`bb1.${u.get(2)}`) ?? 0, amps, 1e-9, "the stage into 0 V"); // prettier-ignore
  const w = s.warnings.find((x) => x.type === "output-current");
  assert.ok(w && !w.smoke, "past 20 mA: a warning, not smoke");
  assert.equal(w.limit, OUTPUT_LIMITS["74LS"].warnMa);
  close(s.supplies.get("psu1").amps, amps + 1.6e-3, 1e-9, "and the supply delivers it"); // prettier-ignore
});

test("a LOW shorted to + lets out the smoke", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.vcc(u.get(1)); // 1Y LOW…
  b.vcc(u.get(2)); // …into +5 V
  const { s } = both(b.doc);
  const w = s.warnings.find((x) => x.type === "output-current");
  close(w.amps, (5 - 0.15) / 25, 1e-9, "the LOW stage from 5 V");
  assert.equal(w.smoke, true);
  assert.equal(s.chipStatus.get("u1").status, CHIP_STATUS.OVERLOADED);
});

test("two outputs fighting: the LOW wins at its voltage, and both carry it (I)", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1)); // 1Y HIGH
  b.vcc(u.get(3)); // 2Y LOW
  b.link(u.get(2), u.get(4));
  b.link(u.get(2), u.get(5)); // 3A reads the fight
  const { digital, spice, s } = both(b.doc);
  assert.equal(digital.level(u.get(2)), X, "digital: a conflict");
  // …with 3A's own current out of its pin pushing the net up a little.
  const v = (3.6 / 120 + 0.15 / 25 + 1.3 / 4500) / (1 / 120 + 1 / 25 + 1 / 4500); // prettier-ignore
  close(voltsAt(spice, s, u.get(2)), v, 1e-6, "0.75 V");
  assert.equal(spice.level(u.get(2)), L, "shown as what its reader sees");
  assert.equal(spice.level(u.get(6)), H, "3A reads LOW");
  assert.ok(
    s.warnings.some((w) => w.type === "conflict"),
    "still said",
  );
  // The chip's worst output is said: the LOW, sinking the HIGH's current
  // and 3A's own.
  const out = s.warnings.find((w) => w.type === "output-current");
  close(out.amps, (v - 0.15) / 25, 1e-9, "24 mA into the LOW");
  assert.ok((3.6 - v) / 120 > OUTPUT_LIMITS["74LS"].warnMa / 1000, "both past 20 mA"); // prettier-ignore
});

test("open-collector outputs wired together: a wired-AND (O)", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS05", "e10");
  b.gnd(u.get(1)); // 1Y off (floats)
  b.vcc(u.get(3)); // 2Y LOW
  b.link(u.get(2), u.get(4));
  const r = b.seat("r1", "resistor", "a30", { ohms: 4.7e3 });
  b.vcc(r.get(1));
  b.link(r.get(2), u.get(2));
  const v = inverter(b, "u2", "74LS04", "e40");
  b.link(u.get(2), v.get(1));
  const { digital, spice } = both(b.doc);
  assert.equal(digital.level(u.get(2)), L);
  assert.equal(spice.level(u.get(2)), L);
  assert.equal(spice.level(v.get(2)), H);
});

test("a CMOS input left between its thresholds draws from its supply", () => {
  // 100 k each way into a CD4069UB input: 2.5 V, in its undefined band.
  const b = bench();
  const u = inverter(b, "u1", "CD4069UB", "e10");
  for (const p of [3, 5, 9, 11, 13]) b.gnd(u.get(p));
  const up = b.seat("r1", "resistor", "a30", { ohms: 100e3 });
  b.vcc(up.get(1));
  b.link(up.get(2), u.get(1));
  const down = b.seat("r2", "resistor", "a40", { ohms: 100e3 });
  b.link(down.get(1), u.get(1));
  b.gnd(down.get(2));
  const { spice, s } = both(b.doc);
  close(voltsAt(spice, s, u.get(1)), 2.5, 1e-6, "halfway");
  assert.equal(spice.level(u.get(2)), X, "undefined in, undefined out");
  const divider = 5 / 200e3;
  close(s.supplies.get("psu1").amps, divider + CMOS_BAND_MA / 1000 + 1e-8, 1e-9, "the divider, and the input's own"); // prettier-ignore
});

test("every net the solve holds has a voltage", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1));
  b.link(u.get(2), u.get(3));
  b.link(u.get(4), u.get(5));
  const { spice, s } = both(b.doc);
  close(voltsAt(spice, s, u.get(2)), 3.6, 1e-9, "a 74LS HIGH, unloaded");
  const low = voltsAt(spice, s, u.get(4));
  assert.ok(low > 0.15 && low < 0.2, `a LOW, under its own input's current: ${low}`); // prettier-ignore
  close(voltsAt(spice, s, u.get(14)), 5, 1e-9, "the rail");
  assert.equal(
    voltsAt(spice, s, u.get(9)),
    undefined,
    "a floating input: none",
  );
});

test("solveDrivers balances stages between their open-circuit levels", () => {
  const hi = outputStage(partDef("74LS04"), 5, H);
  const lo = outputStage(partDef("74LS04"), 5, L);
  close(solveDrivers([hi, lo], 2), (3.6 / 120 + 0.15 / 25) / (1 / 120 + 1 / 25), 1e-9, "a fight"); // prettier-ignore
  const cmos = outputStage(partDef("CD4069UB"), 5, L);
  const ttl = inputStages(partDef("74LS04"), 5)[0];
  // A saturating stage and a TTL input: still found, from anywhere.
  for (const guess of [0, 2.5, 5, Number.NaN]) {
    const v = solveDrivers([cmos, ttl, ttl], guess);
    close((2 * (1.3 - v)) / 4500, v / 400, 1e-12, `balanced from ${guess}`);
  }
});

test("the digital engine is untouched by any of it", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1));
  b.gnd(u.get(2));
  const { d } = both(b.doc);
  assert.equal(d.nodeVolts, undefined);
  assert.ok(!d.warnings.some((w) => w.type === "output-current"));
});

// ── Transistors as devices (phase C) ─────────────────────────────────────

/** An NPN's collector pulled up through 1 kΩ, its emitter on GND, its base
    fed through `rb` from a 74LS HIGH, the collector read by a 74LS input. */
function npnStage(rb) {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1)); // 1Y HIGH
  const q = b.seat("q1", "npn", "a30"); // E · B · C
  b.gnd(q.get(1));
  const base = b.seat("rb", "resistor", "a40", { ohms: rb });
  b.link(u.get(2), base.get(1));
  b.link(base.get(2), q.get(2));
  const load = b.seat("rc", "resistor", "a50", { ohms: 1e3 });
  b.vcc(load.get(1));
  b.link(load.get(2), q.get(3));
  b.link(q.get(3), u.get(3)); // 2A reads the collector
  return { b, u, q };
}

test("a BJT has gain, not a switch's yes or no (M)", () => {
  // Through 10 MΩ the base takes 0.3 µA: β × that is 30 µA, which pulls the
  // collector down 30 mV — still HIGH. The digital engine's switch, seeing a
  // HIGH base, closes outright.
  const weak = npnStage(10e6);
  const { digital, spice, s } = both(weak.b.doc);
  assert.equal(digital.level(weak.q.get(3)), L, "digital: a closed switch");
  const ib = (3.6 - 0.65) / (10e6 + 2);
  close(voltsAt(spice, s, weak.q.get(3)), 5 - 100 * ib * 1e3, 1e-4, "5 V less β·Ib × 1 kΩ"); // prettier-ignore
  assert.equal(spice.level(weak.q.get(3)), H);
  assert.equal(s.transistors.get("q1").on, true, "it does conduct, a little");
  // Through 10 kΩ, β × 0.3 mA is far past what 1 kΩ lets through: saturated.
  const hard = npnStage(10e3);
  const r = both(hard.b.doc);
  const vc = voltsAt(r.spice, r.s, hard.q.get(3));
  assert.ok(vc > 0.2 && vc < 0.21, `VCE(sat): ${vc}`);
  assert.equal(r.spice.level(hard.u.get(4)), H, "2A reads it LOW");
});

test("a MOSFET opens from its threshold, against its source", () => {
  // A divider sets the gate; the drain is pulled up through 1 kΩ.
  for (const [vg, open] of [
    [1.5, false],
    [3, true],
  ]) {
    const b = bench();
    const q = b.seat("q1", "nmos", "a10"); // S · G · D
    b.gnd(q.get(1));
    const up = b.seat("r1", "resistor", "a20", { ohms: (5 - vg) * 1e3 });
    b.vcc(up.get(1));
    b.link(up.get(2), q.get(2));
    const down = b.seat("r2", "resistor", "a30", { ohms: vg * 1e3 });
    b.link(down.get(1), q.get(2));
    b.gnd(down.get(2));
    const load = b.seat("rd", "resistor", "a40", { ohms: 1e3 });
    b.vcc(load.get(1));
    b.link(load.get(2), q.get(3));
    const { spice, s } = both(b.doc);
    const vd = voltsAt(spice, s, q.get(3));
    if (open) {
      // Half way from VTH to fully on: 2 Ω.
      close(vd, (5 * 2) / (1e3 + 2), 1e-6, `${vg} V on the gate`);
    } else {
      close(vd, 5, 1e-6, `${vg} V on the gate: off`);
    }
    assert.equal(s.transistors.get("q1").on, open);
  }
});

test("a MOSFET's floating gate keeps its charge", () => {
  const b = bench();
  const q = b.seat("q1", "nmos", "a10");
  b.gnd(q.get(1));
  b.signal("g", q.get(2), "low");
  const load = b.seat("rd", "resistor", "a40", { ohms: 1e3 });
  b.vcc(load.get(1));
  b.link(load.get(2), q.get(3));
  const sim = runner(b.doc, { engine: "spice" });
  let r = sim.run(0, new Map([["g", H]])).result;
  assert.equal(r.transistors.get("q1").on, true, "driven HIGH: on");
  assert.equal(r.transistors.get("q1").held, false);
  r = sim.run(0.01, new Map()).result; // the flag lets go: the gate floats
  assert.equal(r.transistors.get("q1").on, true, "still on");
  assert.equal(r.transistors.get("q1").held, true, "on the charge it keeps");
  r = sim.run(0.02, new Map([["g", L]])).result;
  assert.equal(r.transistors.get("q1").on, false, "driven LOW: off");
});

test("a CD4007UB pair is a CMOS inverter, rail to rail", () => {
  const b = bench();
  const u = b.seat("u1", "CD4007UB", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.link(u.get(13), u.get(8)); // pair 1's drains: the output
  b.signal("in", u.get(6), "low");
  const sim = runner(b.doc, { engine: "spice" });
  for (const [level, out] of [
    [L, 5],
    [H, 0],
  ]) {
    const r = sim.run(level === L ? 0 : 0.01, new Map([["in", level]])).result;
    close(voltsAt(sim, r, u.get(13)), out, 1e-6, `in ${level}`);
  }
});

// ── Chip power from the voltage at its pins (phase D) ────────────────────

/** A `ref` inverter whose VCC is fed from + through a series diode. */
function diodeFed(ref) {
  const b = bench();
  const u = b.seat("u1", ref, "e10");
  b.gnd(u.get(7));
  const d = b.seat("d1", "diode", "a30");
  b.vcc(d.get(1));
  b.link(d.get(2), u.get(14));
  b.gnd(u.get(1)); // 1Y HIGH, if it runs
  return { b, u };
}

test("a chip fed through a diode runs at what reaches its pins (F)", () => {
  // A 74LS04 needs 4.75 V: a diode below 5 V it is underpowered. The
  // digital engine sees a VCC pin on no supply at all.
  const ls = diodeFed("74LS04");
  const { d, s } = both(ls.b.doc);
  assert.equal(d.chipStatus.get("u1").status, CHIP_STATUS.UNPOWERED);
  const st = s.chipStatus.get("u1");
  assert.equal(st.status, CHIP_STATUS.UNDERPOWERED);
  assert.ok(st.volts > 4.3 && st.volts < 4.45, `a diode drop under 5 V: ${st.volts}`); // prettier-ignore
  // A CD4069UB runs from 3 V up: the same feed powers it, and its HIGH is
  // what it runs at.
  const cmos = diodeFed("CD4069UB");
  for (const p of [3, 5, 9, 11, 13]) cmos.b.gnd(cmos.u.get(p));
  const r = both(cmos.b.doc);
  const on = r.s.chipStatus.get("u1");
  assert.equal(on.status, CHIP_STATUS.OK);
  close(voltsAt(r.spice, r.s, cmos.u.get(2)), on.volts, 1e-6, "1Y at its own supply"); // prettier-ignore
  assert.equal(r.spice.level(cmos.u.get(2)), H);
});

test("a chip powered from another chip's output", () => {
  // A 74LS HIGH (3.6 V behind 120 Ω) feeding a CD4069UB's VDD: it runs at
  // what is left after its own supply current.
  const b = bench();
  const ls = inverter(b, "u1", "74LS04", "e10");
  b.gnd(ls.get(1)); // 1Y HIGH: the CMOS part's supply
  const cmos = b.seat("u2", "CD4069UB", "e30");
  b.link(ls.get(2), cmos.get(14));
  b.gnd(cmos.get(7));
  for (const p of [1, 3, 5, 9, 11, 13]) b.gnd(cmos.get(p));
  const { s } = both(b.doc);
  const st = s.chipStatus.get("u2");
  assert.equal(st.status, CHIP_STATUS.OK);
  close(st.volts, 3.6, 1e-3, "3.6 V, less a CMOS part's microamps × 120 Ω");
});

test("a chip on the rails is untouched: its supply is its rail's", () => {
  const b = bench();
  inverter(b, "u1", "74LS04", "e10");
  const { d, s } = both(b.doc);
  assert.deepEqual(s.chipStatus.get("u1"), d.chipStatus.get("u1"));
});
