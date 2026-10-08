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
// features/done/spice-lite-audit.md phase B). Each circuit the audit found the
// digital engine's strength rules getting wrong is built here and held to
// what a bench would show — the inputs reading their own net's VOLTAGE —
// beside the digital engine, which is left exactly as it was.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, X, Z } from "../sim/levels.js";
import { CHIP_STATUS } from "../sim/engine.js";
import { solveDrivers } from "../sim/spice/voltages.js";
import { outputStage, stageCurrent } from "../sim/spice/output-stage.js";
import {
  CMOS_BAND_MA,
  CMOS_CLAMP,
  OUTPUT_LIMITS,
  inputStages,
} from "../sim/spice/params.js";
import { partDef } from "../catalog/index.js";
import {
  BJT_GRADES,
  MOSFET_GRADES,
  bjtCurrents,
  mosfetCurrent,
} from "../sim/spice/transistors.js";
import { bench, runner } from "./timing-fixtures.js";
import { gradeFigures } from "../sim/spice/transistor-figures.js";
import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";

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

/** Where a node settles that a conductance `g` to ground and a current `i`
    pushed in hold, with `n` powered 74LS inputs on it — each its stage
    (spice/params.js TTL_INPUT: a constant current out of the pin to its
    0.9 V knee, falling to none at 1.3 V). Bisected: the stage only falls. */
function ttlHeld(g, i, n = 1) {
  const [bias] = inputStages(partDef("74LS04"), 5);
  let lo = 0;
  let hi = 5;
  for (let k = 0; k < 200; k++) {
    const v = (lo + hi) / 2;
    if (i + n * stageCurrent(bias, v) - g * v > 0) lo = v;
    else hi = v;
  }
  return (lo + hi) / 2;
}

/** Where a 74LS input sits that a conductance `g` to ground and a current
    `i` in hold. */
const ttlBias = (g, i) => ttlHeld(g, i);

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
  // The 12 V stage (its square law, spice/output-stage.js) into the clamp
  // at 5.5 V behind its resistance: where the two carry the same current.
  const stage = outputStage(partDef("CD4069UB"), 12, H);
  const knee = 5 + CMOS_CLAMP.overV;
  let [below, above] = [knee, 12];
  for (let k = 0; k < 100; k++) {
    const v = (below + above) / 2;
    if (stageCurrent(stage, v) > (v - knee) / CMOS_CLAMP.ohms) below = v;
    else above = v;
  }
  const amps = (below - knee) / CMOS_CLAMP.ohms;
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
  // …with 3A's own 0.2 mA out of its pin pushing the net up a little.
  const v = (3.6 / 120 + 0.15 / 25 + 0.2e-3) / (1 / 120 + 1 / 25);
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
    close(2 * stageCurrent(ttl, v), -stageCurrent(cmos, v), 1e-12, `balanced from ${guess}`); // prettier-ignore
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
function npnStage(rb, params = undefined) {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1)); // 1Y HIGH
  const q = b.seat("q1", "npn", "a30", params); // E · B · C
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
  // Through 10 MΩ the base takes 0.3 µA: β (its grade's, the 2N3904's) times
  // that pulls the collector down a few tens of millivolts — still HIGH. The
  // digital engine's switch, seeing a HIGH base, closes outright.
  const weak = npnStage(10e6);
  const { digital, spice, s } = both(weak.b.doc);
  assert.equal(digital.level(weak.q.get(3)), L, "digital: a closed switch");
  const vb = voltsAt(spice, s, weak.q.get(2));
  const vc = voltsAt(spice, s, weak.q.get(3));
  const model = BJT_GRADES.npn["small-signal"];
  const { ib, ic } = bjtCurrents(model, vb, vc);
  close(ic, (5 - vc) / 1e3, 1e-6, "the collector carries what 1 kΩ drops");
  close(ib, (3.6 - vb) / (10e6 + 120), 1e-3, "the base what 10 MΩ lets in");
  assert.ok(ic / ib > 50 && ic / ib < 200, `β ${ic / ib}`);
  assert.ok(vc > 4.95 && vc < 4.995, `a little below 5 V: ${vc}`);
  assert.equal(spice.level(weak.q.get(3)), H);
  assert.equal(s.transistors.get("q1").on, true, "it does conduct, a little");
  // Through 10 kΩ, β × 0.3 mA is far past what 1 kΩ lets through: saturated.
  const hard = npnStage(10e3);
  const r = both(hard.b.doc);
  const sat = voltsAt(r.spice, r.s, hard.q.get(3));
  assert.ok(sat > 0.03 && sat < 0.15, `VCE(sat): ${sat}`);
  assert.equal(r.spice.level(hard.u.get(4)), H, "2A reads it LOW");
});

test("a Custom grade is the transistor the solve runs", () => {
  // The same weak drive (10 MΩ from a HIGH) into the 2N3904 grade and into a
  // Custom one started from it with three times its gain: about three times
  // the collector current — "about", since hFE is stated at the grade's test
  // point (20 mA) and at a third of a microamp of base current the gain is
  // the model's own curve, its recombination term bigger.
  const own = gradeFigures("npn", "small-signal");
  const custom = { from: "small-signal", ...own, hfe: own.hfe * 3 };
  const drawn = (params) => {
    const stage = npnStage(10e6, params);
    const { spice, s } = both(stage.b.doc);
    return (5 - voltsAt(spice, s, stage.q.get(3))) / 1e3;
  };
  const ratio = drawn({ grade: "custom", custom }) / drawn();
  assert.ok(ratio > 2.5 && ratio < 4, `IC ratio ${ratio}`);
});

test("a MOSFET opens from its threshold, against its source", () => {
  // A divider sets the gate; the drain is pulled up through 1 kΩ. A TO-92 is
  // a logic-level part (the 2N7000, 2.1 V); a TO-220 a power one (the
  // IRF540N, 3.6 V), off at 3 V and on at 5.
  for (const [vg, pkg, open] of [
    [1.5, "TO-92", false],
    [3, "TO-92", true],
    [3, "TO-220", false],
    [4.5, "TO-220", true],
  ]) {
    const b = bench();
    const q = b.seat("q1", "nmos", "a10", { case: pkg }); // S · G · D
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
    const model = MOSFET_GRADES.nmos[pkg === "TO-92" ? "logic" : "power"];
    if (open) {
      // Its channel carries what 1 kΩ drops, the drain well down.
      close(mosfetCurrent(model, vg, vd), (5 - vd) / 1e3, 1e-6, `${vg} V on the gate`); // prettier-ignore
      assert.ok(vd < 0.1, `${pkg} at ${vg} V: ${vd}`);
    } else {
      close(vd, 5, 1e-6, `${vg} V on the gate: off`);
    }
    assert.equal(s.transistors.get("q1").on, open, `${pkg} at ${vg} V`);
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

// ── Review fixes, 2026-10-07 ──────────────────────────────────────────────

test("a BJT whose base is on a rail is still one network (an emitter follower)", () => {
  // Base straight on +5 V, collector 100 Ω to +, emitter 1 kΩ to ground. The
  // collector and emitter meet only through the transistor: with the base
  // on a rail they were two networks, the emitter read as 0 V and the base
  // took amps from the supply.
  const b = bench();
  const q = b.seat("q1", "npn", "a30"); // E · B · C
  b.vcc(q.get(2));
  const rc = b.seat("rc", "resistor", "a40", { ohms: 100 });
  b.vcc(rc.get(1));
  b.link(rc.get(2), q.get(3));
  const re = b.seat("re", "resistor", "a50", { ohms: 1e3 });
  b.link(q.get(1), re.get(1));
  b.gnd(re.get(2));
  const { spice, s } = both(b.doc);
  // The emitter a VBE under the base, carrying base and collector current
  // into 1 kΩ; the collector 100 Ω's drop under the rail.
  const ve = voltsAt(spice, s, q.get(1));
  const vc = voltsAt(spice, s, q.get(3));
  assert.ok(ve > 4.2 && ve < 4.45, `VE a VBE under the base: ${ve}`);
  const { ib, ic } = bjtCurrents(BJT_GRADES.npn["small-signal"], 5 - ve, vc - ve); // prettier-ignore
  close(ib + ic, ve / 1e3, 1e-6, "the emitter's current");
  close(vc, 5 - 100 * ic, 1e-6, "VC");
  const psu = s.supplies.get("psu1");
  assert.equal(psu.limited, false);
  close(psu.volts, 5, 0, "the supply holds");
  // …and a PNP with its base on ground, its emitter 1 kΩ from +: on.
  const p = bench();
  const t = p.seat("q2", "pnp", "a30");
  p.gnd(t.get(2));
  const pe = p.seat("re", "resistor", "a40", { ohms: 1e3 });
  p.vcc(pe.get(1));
  p.link(pe.get(2), t.get(1));
  const pc = p.seat("rc", "resistor", "a50", { ohms: 1e3 });
  p.link(t.get(3), pc.get(1));
  p.gnd(pc.get(2));
  const r = both(p.doc);
  assert.equal(r.s.transistors.get("q2").on, true);
  const vpe = voltsAt(r.spice, r.s, t.get(1));
  assert.ok(vpe > 0.65 && vpe < 0.85, `VE a VBE above the base: ${vpe}`);
  // Its base takes far more than its collector can pass: deep in
  // saturation, a few millivolts across it.
  const vce = vpe - voltsAt(r.spice, r.s, t.get(3));
  assert.ok(vce > 0 && vce < 0.05, `saturated: ${vce}`);
});

test("a transistor straight across the rails is a short the supply delivers", () => {
  // An N-channel MOSFET from + to ground, its gate driven HIGH: a TO-220
  // power part (the IRF540N) saturated at 5 V on its gate — ~29 A asked of a
  // 1 A supply. Every end of it on a rail, it was in no network and drew
  // nothing.
  const b = bench();
  const q = b.seat("q1", "nmos", "a10"); // S · G · D
  b.gnd(q.get(1));
  b.vcc(q.get(3));
  b.signal("g", q.get(2), "low");
  const sim = runner(b.doc, { engine: "spice" });
  let r = sim.run(0, new Map([["g", H]])).result;
  const psu = r.supplies.get("psu1");
  assert.equal(psu.limited, true);
  const demand = mosfetCurrent(MOSFET_GRADES.nmos.power, 5, 5);
  close(psu.demand, demand, 1e-6, "its saturation current at 5 V");
  close(psu.volts, 5 / demand, 1e-6, "drooped to its limit");
  assert.equal(r.transistors.get("q1").on, true);
  r = sim.run(0.01, new Map([["g", L]])).result;
  assert.equal(r.supplies.get("psu1").limited, false, "off: nothing drawn");
  assert.equal(r.transistors.get("q1").on, false);
});

test("an analog switch channel straight across the rails draws through its rON", () => {
  const b = bench();
  const u = b.seat("u1", "CD4066B", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.vcc(u.get(1)); // channel 1: + …
  b.gnd(u.get(2)); // … to ground
  b.signal("on", u.get(13), "low");
  for (const p of [5, 6, 12]) b.gnd(u.get(p));
  const sim = runner(b.doc, { engine: "spice" });
  const amps = (level, t) =>
    sim.run(t, new Map([["on", level]])).result.supplies.get("psu1").amps;
  close(amps(H, 0), 5 / 470, 1e-7, "on: 5 V over 470 Ω");
  assert.ok(amps(L, 0.01) < 1e-6, "off: nothing");
  close(amps(H, 0.02), 5 / 470, 1e-7, "on again");
});

test("a CD4007UB's MOSFETs are its family's, not a power part's", () => {
  // Pair 1 as an inverter, its gates held at mid-supply by a divider: both
  // part-way on, the N and P channel each a quarter on at 400 Ω — about
  // 1.6 mA through the pair, not the 600 mA a 1 Ω power MOSFET would let by.
  const b = bench();
  const u = b.seat("u1", "CD4007UB", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.link(u.get(13), u.get(8));
  const up = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  const down = b.seat("r2", "resistor", "a40", { ohms: 10e3 });
  b.vcc(up.get(1));
  b.link(up.get(2), u.get(6));
  b.gnd(down.get(1));
  b.link(down.get(2), u.get(6));
  const { spice, s } = both(b.doc);
  close(voltsAt(spice, s, u.get(13)), 2.5, 1e-6, "the output sits mid-way");
  // The pair and the divider — and nothing more: a CD4007UB's gate is a bare
  // MOSFET's, whose current IS the pair's (the band current a CMOS GATE's
  // input stage draws is not booked on top of it).
  const pair = 5 / (2 * 1600);
  close(s.supplies.get("psu1").amps, pair + 5 / 20e3, 1e-6, "the supply's draw"); // prettier-ignore
});

test("a CD4007UB channel shorted saturates — and past 100 mW smokes", () => {
  // P-channel on (gate LOW), its drain shorted to ground: it saturates at
  // the B-series output's 4.2 mA at 5 V (21 mW, fine) and 28 mA at 15 V
  // (420 mW, past the 100 mW absolute maximum).
  for (const [volts, ma, smoke] of [
    [5, 4.2, false],
    [15, 28, true],
  ]) {
    const b = bench({ volts });
    const u = b.seat("u1", "CD4007UB", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    b.gnd(u.get(6)); // gates LOW: P on, N off
    b.gnd(u.get(13)); // the P's drain on ground
    const { s } = both(b.doc);
    close(s.supplies.get("psu1").amps, ma / 1000, 1e-6, `${volts} V`);
    const w = s.warnings.find((x) => x.type === "output-current");
    assert.equal(Boolean(w?.smoke), smoke, `${volts} V smoke`);
  }
});

test("a chip fed through a resistor draws what its outputs source through its VCC", () => {
  // A 74LS04 fed through 47 Ω, 1Y HIGH lighting an LED through 100 Ω: the
  // LED's current comes in through the feed, so VCC sags below 4.75 V —
  // underpowered, and lighting the LED all the same.
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
  const sim = runner(b.doc, { engine: "spice" });
  sim.run(0);
  const r = sim.run(0.01).result;
  const vcc = voltsAt(sim, r, u.get(14));
  assert.equal(r.chipStatus.get("u1").status, CHIP_STATUS.UNDERPOWERED);
  assert.ok(vcc > 4.5 && vcc < 4.75, `VCC sags: ${vcc}`);
  const lit = r.lamps.get("d1").amps;
  assert.ok(lit > 5e-3, `the LED still lit: ${lit}`);
  // Kirchhoff at the chip: the feed carries the LED and the chip's ICC
  // (1.6 mA at 5 V, as the load it is).
  close((5 - vcc) / 47, lit + vcc / (5 / 1.6e-3), 1e-8, "in through VCC = out");
  close(r.currents.get(`bb1.${u.get(14)}`), (5 - vcc) / 47, 1e-8, "the VCC lead"); // prettier-ignore
  close(r.supplies.get("psu1").amps, (5 - vcc) / 47, 1e-8, "the supply");
});

test("a chip with its ground lifted drives and reads from its own ground", () => {
  // A CD4069UB whose VSS is a diode above ground: its LOW is that ground, not
  // 0 V, and the next gate reads it LOW against it.
  const b = bench();
  const u = b.seat("u1", "CD4069UB", "e10");
  b.vcc(u.get(14));
  const d = b.seat("d1", "diode", "a30");
  b.link(d.get(1), u.get(7));
  b.gnd(d.get(2));
  b.vcc(u.get(1)); // 1Y LOW
  b.link(u.get(2), u.get(3)); // 2Y = NOT 1Y
  const sim = runner(b.doc, { engine: "spice" });
  const r = sim.run(0).result;
  const vss = voltsAt(sim, r, u.get(7));
  // A diode's drop at the chip's own quiescent current — a fraction of a
  // microamp, so well under the 0.6 V it drops at a milliamp.
  assert.ok(vss > 0.1 && vss < 0.65, `VSS a diode up: ${vss}`);
  close(voltsAt(sim, r, u.get(2)), vss, 1e-6, "1Y LOW at its own ground");
  close(voltsAt(sim, r, u.get(4)), 5, 1e-6, "2Y HIGH at VDD");
  assert.equal(sim.level(u.get(2)), L);
  assert.equal(sim.level(u.get(4)), H);
});

test("two bench sources on one net: held while they agree, a conflict when not", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.signal("s0", u.get(1), "low");
  b.signal("s1", u.get(1), "low");
  const sim = runner(b.doc, { engine: "spice" });
  const at = (s0, s1, t) => {
    const r = sim.run(
      t,
      new Map([
        ["s0", s0],
        ["s1", s1],
      ]),
    ).result;
    return { r, v: voltsAt(sim, r, u.get(1)) };
  };
  close(at(H, H, 0).v, 5, 1e-9, "both HIGH");
  close(at(L, L, 0.01).v, 0, 1e-9, "both LOW");
  // Either one changing is seen — not only the first listed: two ideal
  // sources fighting have no voltage, and the digital engine's X stands.
  const fight = at(L, H, 0.02).r;
  assert.equal(sim.level(u.get(1)), X, "a fight: X");
  assert.ok(fight.warnings.some((w) => w.type === "conflict"));
  close(at(H, H, 0.03).v, 5, 1e-9, "agreed again");
});

test("a flag no chip reads drives the lowest supply set, not the highest", () => {
  // A flag into an LED through 330 Ω on a 5 V desk that also holds an idle
  // 12 V supply: a 5 V source.
  const b = bench();
  secondSupply(b, 12);
  inverter(b, "u1", "74LS04", "e10");
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 330 });
  const led = b.seat("l1", "led", "a40", { color: "red" });
  b.signal("s", r1.get(1));
  b.link(r1.get(2), led.get(1));
  b.gnd(led.get(2));
  const sim = runner(b.doc, { engine: "spice" });
  const r = sim.run(0, new Map([["s", H]])).result;
  close(voltsAt(sim, r, r1.get(1)), 5, 0, "5 V");
});

test("a clock brick's current comes out of the supply that powers it", () => {
  const b = bench();
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 10, y: 30, params: { hz: 1 } }); // prettier-ignore
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 100 });
  b.gnd(r1.get(2));
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: `bb1.${r1.get(1).replace(/^a/, "c")}`, color: "blue" }, // prettier-ignore
  );
  const netlist = buildNetlist(b.doc);
  const tick = (level) =>
    ENGINES.spice.tick({
      document: b.doc,
      netlist,
      warmStart: new Map(),
      state: new Map(),
      prevPinLevels: new Map(),
      clockPhase: new Map([["clk1", level]]),
      now: 0,
      spice: { config: { enabled: true }, analog: null },
    });
  close(
    tick(H).supplies.get("psu1").amps,
    5 / 100,
    1e-9,
    "HIGH: 5 V over 100 Ω",
  );
  close(tick(L).supplies.get("psu1").amps, 0, 1e-9, "LOW: nothing");
});

test("a resistance that will not read is no resistor in either engine", () => {
  // An older document's value kept as its text: the digital engine pulled
  // with it while Spice Lite had no ohms to solve it with. Neither does now.
  const b = bench();
  const u = b.seat("u1", "CD4069UB", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const r1 = b.seat("r1", "resistor", "a30");
  b.doc.components.find((c) => c.id === "r1").params.ohms = "ten k";
  b.vcc(r1.get(1));
  b.link(r1.get(2), u.get(1));
  const { digital, spice } = both(b.doc);
  assert.equal(digital.level(u.get(1)), Z, "digital: 1A floats");
  assert.equal(spice.level(u.get(1)), Z, "Spice Lite: 1A floats");
});

test("an analog switch channel is held to its rating: past 10 mA a warning, past 25 mA smoke", () => {
  // A CD4066B channel switched on straight across the rails: 5 V over its
  // 470 Ω is 10.6 mA — past the sheet's ±10 mA — and 15 V over 125 Ω
  // 120 mA, which lets out the smoke.
  for (const [volts, smoke] of [
    [5, false],
    [15, true],
  ]) {
    const b = bench({ volts });
    const u = b.seat("u1", "CD4066B", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    b.vcc(u.get(13)); // A's control
    b.vcc(u.get(1));
    b.gnd(u.get(2));
    const { s } = both(b.doc);
    const w = s.warnings.find((x) => x.type === "switch-current");
    assert.ok(w, `${volts} V`);
    assert.equal(w.chip, "u1");
    assert.equal(w.smoke, smoke, `${volts} V smoke`);
    assert.equal(
      s.chipStatus.get("u1").status,
      smoke ? CHIP_STATUS.OVERLOADED : CHIP_STATUS.OK,
    );
  }
});

test("a CMOS buffer's own stage is still held to its family's 100 mW", () => {
  // A CD4050B's strong LOW wired to a 15 V supply: ~130 mA, ~2 W.
  const b = bench({ volts: 15 });
  const u = b.seat("u1", "CD4050B", "e10");
  b.vcc(u.get(1));
  b.gnd(u.get(8));
  b.gnd(u.get(3)); // A LOW → G (pin 2) LOW
  b.vcc(u.get(2));
  const { s } = both(b.doc);
  const w = s.warnings.find((x) => x.type === "output-current");
  assert.ok(w, "said");
  assert.equal(w.unit, "mW");
  assert.equal(w.smoke, true);
  assert.equal(s.chipStatus.get("u1").status, CHIP_STATUS.OVERLOADED);
});

test("a MOS part's inputs, and an analog switch's control, are clamped like a CMOS input's", () => {
  // A CD4069UB on 12 V drives an input of a 5 V part: its protection diode
  // to VCC carries what the CMOS output can push — past 10 mA, smoke.
  for (const [ref, pin] of [
    ["HM62256", 10], // A0
    ["W65C02", 2], // RDY
    ["CD4066B", 13], // A's control
  ]) {
    const b = bench();
    const two = secondSupply(b, 12);
    const c = b.seat("u1", "CD4069UB", "e10");
    two.vcc(c.get(14));
    b.gnd(c.get(7));
    b.gnd(c.get(1)); // 1Y HIGH, at 12 V
    const def = partDef(ref);
    const t = b.seat("u2", ref, "e30");
    b.vcc(t.get(def.pins.find((p) => p.role === "vcc").n));
    b.gnd(t.get(def.pins.find((p) => p.role === "gnd").n));
    b.link(c.get(2), t.get(pin));
    const { s } = both(b.doc);
    const w = s.warnings.find((x) => x.type === "input-clamp" && x.chip === "u2"); // prettier-ignore
    assert.ok(w, `${ref}: ${s.warnings.map((x) => x.type)}`);
    assert.ok(w.amps * 1000 > CMOS_CLAMP.smokeMa, `${ref}: ${w.amps} A`);
    assert.equal(w.smoke, true);
  }
});

test("an analog switch off the rails: its control is clamped against its own supply", () => {
  // A CD4066B fed off the rails — its VDD through 100 Ω, or its ground a
  // diode up — has its control driven from a 12 V CMOS output: the diode to
  // its OWN VDD carries the current (back-feeding that VDD up past 5 V when
  // it hangs off a resistor), past 10 mA the smoke, and the voltage stress
  // is said against its own ground.
  for (const lift of ["vdd", "vss"]) {
    const b = bench();
    const two = secondSupply(b, 12);
    const c = b.seat("u1", "CD4069UB", "e10");
    two.vcc(c.get(14));
    b.gnd(c.get(7));
    b.gnd(c.get(1)); // 1Y HIGH, at 12 V
    const t = b.seat("u2", "CD4066B", "e30");
    if (lift === "vdd") {
      const r = b.seat("r1", "resistor", "j45", { ohms: 100 });
      b.vcc(r.get(1));
      b.link(r.get(2), t.get(14));
      b.gnd(t.get(7));
    } else {
      const d = b.seat("d1", "diode", "j45");
      b.link(d.get(1), t.get(7));
      b.gnd(d.get(2));
      b.vcc(t.get(14));
    }
    b.link(c.get(2), t.get(13)); // A's control
    // A few ticks: a VDD the clamp itself back-feeds is where the next
    // settle's stages are built from.
    const { spice } = both(b.doc);
    spice.run(0.001);
    const s = spice.run(0.002).result;
    const w = s.warnings.find((x) => x.type === "input-clamp" && x.chip === "u2"); // prettier-ignore
    assert.ok(w, `${lift}: ${s.warnings.map((x) => x.type)}`);
    assert.equal(w.pin, 13);
    assert.ok(w.amps * 1000 > CMOS_CLAMP.smokeMa, `${lift}: ${w.amps} A`);
    assert.equal(w.smoke, true);
    assert.equal(s.chipStatus.get("u2").status, CHIP_STATUS.OVERLOADED);
    // Clamped a diode above its own VDD, wherever that VDD has gone.
    const vdd = voltsAt(spice, s, t.get(14));
    const ground = voltsAt(spice, s, t.get(7));
    close(voltsAt(spice, s, t.get(13)), vdd + CMOS_CLAMP.overV + w.amps * CMOS_CLAMP.ohms, 1e-3, `${lift}: clamped`); // prettier-ignore
    close(w.volts, voltsAt(spice, s, t.get(13)) - ground, 1e-6, `${lift}: against its own ground`); // prettier-ignore
    if (lift === "vdd") assert.ok(vdd > 5.5, `back-fed: ${vdd}`);
  }
});

test("a discrete transistor is held to its part's ratings — and carries on", () => {
  // An N-channel TO-92 (a 2N7000) fully on, 10 Ω from 5 V: 0.43 A through
  // its 1.6 Ω — past the 200 mA it is rated for (and the 200 mW its package
  // is). The same in a TO-220 (an IRF540N, rated 33 A): fine.
  for (const [pkg, warned] of [
    ["TO-92", true],
    ["TO-220", false],
  ]) {
    const b = bench();
    const q = b.seat("q1", "nmos", "a10", { case: pkg }); // S · G · D
    b.gnd(q.get(1));
    b.vcc(q.get(2));
    const r = b.seat("r1", "resistor", "a30", { ohms: 10 });
    b.link(r.get(1), q.get(3));
    b.vcc(r.get(2));
    const { s } = both(b.doc);
    const w = s.warnings.find((x) => x.type === "transistor-overload");
    assert.equal(Boolean(w), warned, pkg);
    if (w) {
      assert.equal(w.unit, "mA");
      assert.equal(w.limit, 200);
      assert.equal(w.smoke, false);
    }
    assert.equal(s.transistors.get("q1").on, true);
  }
  // An NPN (a 2N3904) driven hard into 4 Ω: ~0.85 A, past the 600 mA no
  // TO-92 survives — and 1.4 W in it, past its package's 625 mW: the worse.
  const b = bench();
  const q = b.seat("q1", "npn", "a10"); // E · B · C
  b.gnd(q.get(1));
  const rb = b.seat("rb", "resistor", "a30", { ohms: 100 });
  b.link(rb.get(1), q.get(2));
  b.vcc(rb.get(2));
  const rc = b.seat("rc", "resistor", "a40", { ohms: 4 });
  b.link(rc.get(1), q.get(3));
  b.vcc(rc.get(2));
  const { s } = both(b.doc);
  const w = s.warnings.find((x) => x.type === "transistor-overload");
  assert.ok(w);
  assert.equal(w.unit, "mW");
  assert.equal(w.smoke, true);
  assert.ok(w.amps > 0.6, `past 600 mA too: ${w.amps}`);
  assert.equal(s.transistors.get("q1").on, true, "it carries on");
  assert.ok(!s.chipStatus.has("q1"), "nothing latches a part with no supply");
});

test("a chip across two rails drives from its own pins' rails", () => {
  // A CD4069UB with VDD on a 12 V supply and VSS on the 5 V rail runs on
  // 7 V — its LOW is 5 V, its HIGH 12 V (each into 10 kΩ to ground).
  for (const [inHigh, near] of [
    [true, 5],
    [false, 12],
  ]) {
    const b = bench();
    const two = secondSupply(b, 12);
    const c = b.seat("u1", "CD4069UB", "e10");
    two.vcc(c.get(14));
    b.vcc(c.get(7)); // VSS on the 5 V rail
    if (inHigh) two.vcc(c.get(1));
    else b.vcc(c.get(1));
    const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
    b.link(r.get(1), c.get(2));
    b.gnd(r.get(2));
    const { spice, s } = both(b.doc);
    assert.equal(s.chipStatus.get("u1").status, CHIP_STATUS.OK);
    close(s.chipStatus.get("u1").volts, 7, 1e-9, "its supply");
    const v = voltsAt(spice, s, c.get(2));
    // Within its 400 Ω (at 7 V, ~330 Ω) of the rail it switches to.
    close(v, near, 0.6, inHigh ? "LOW at its own ground" : "HIGH at its own VDD"); // prettier-ignore
  }
});

test("a part in no family drives the common MOS stage: rail to rail", () => {
  for (const ref of ["HM62256", "W65C02", "osc-full", "lcd16x2"]) {
    const def = partDef(ref);
    const hi = outputStage(def, 5, H);
    const lo = outputStage(def, 5, L);
    assert.equal(hi.volts, 5, `${ref} HIGH`);
    assert.equal(lo.volts, 0, `${ref} LOW`);
    assert.equal(hi.ohms, 100);
    assert.equal(lo.ohms, 100);
  }
  // …and a part of a family keeps its own; the NE555 its sheet's.
  assert.equal(outputStage(partDef("74LS04"), 5, H).volts, 3.6);
  close(outputStage(partDef("NE555"), 5, H).volts, 3.65, 1e-9, "the 555");
});

// ── A gate's linear region (features/done/spice-lite-3-plan.md, Phase 5) ─────────

test("a gate biased by its own feedback resistor is said to be in its linear region", () => {
  // An inverter with 1 MΩ from its output back to its input is an amplifier
  // on a bench, its input and output half way up. Spice Lite has no answer
  // there, so it says that, in place of the chatter (a 74LS04) or the
  // floating input (a CD4069UB, its output driving X) its loop raises.
  for (const ref of ["CD4069UB", "74LS04"]) {
    const b = bench();
    const u = b.seat("u1", ref, "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    const r = b.seat("r1", "resistor", "a30", { ohms: 1e6 });
    b.link(r.get(1), u.get(1));
    b.link(r.get(2), u.get(2));
    for (const p of [3, 5, 9, 11, 13]) b.gnd(u.get(p));
    const { s } = both(b.doc);
    const bias = s.warnings.filter((w) => w.type === "linear-bias");
    assert.deepEqual(bias, [{ type: "linear-bias", chip: "u1", pin: 2 }], ref);
    assert.ok(!s.warnings.some((w) => w.type === "oscillation"), `${ref}: no chatter`); // prettier-ignore
    assert.ok(!s.warnings.some((w) => w.type === "floating-input"), `${ref}: no floating input`); // prettier-ignore
  }
  // A Schmitt input has no linear region (its loop is an oscillator), and a
  // gate whose input something else holds is not left there.
  const b = bench();
  const u = b.seat("u1", "CD4069UB", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const r = b.seat("r1", "resistor", "a30", { ohms: 1e6 });
  b.link(r.get(1), u.get(1));
  b.link(r.get(2), u.get(2));
  b.gnd(u.get(1));
  for (const p of [3, 5, 9, 11, 13]) b.gnd(u.get(p));
  assert.ok(!both(b.doc).s.warnings.some((w) => w.type === "linear-bias"));
  const t = bench();
  const v = t.seat("u1", "CD40106B", "e10");
  t.vcc(v.get(14));
  t.gnd(v.get(7));
  const rt = t.seat("r1", "resistor", "a30", { ohms: 1e6 });
  t.link(rt.get(1), v.get(1));
  t.link(rt.get(2), v.get(2));
  for (const p of [3, 5, 9, 11, 13]) t.gnd(v.get(p));
  assert.ok(!both(t.doc).s.warnings.some((w) => w.type === "linear-bias"));
});
