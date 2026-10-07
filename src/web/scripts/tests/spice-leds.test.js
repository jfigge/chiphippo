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

// spice-leds.test.js — Spice Lite's LEDs (features/spice-lite-leds.md):
// each colour's datasheet numbers and what follows from them (spice/leds.js),
// a chip output as the stage it is (spice/output-stage.js), and the network
// solve around every LED (spice/lamps.js) — lit, how bright, overdriven,
// reversed, and burnt for the rest of the run.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LED_SPECS,
  backlightSpec,
  burnCurrent,
  junctionTemp,
  ledCurrent,
  ledKnee,
  ledVerdict,
} from "../sim/spice/leds.js";
import {
  outputStage,
  stageCurrent,
  stageSlope,
} from "../sim/spice/output-stage.js";
import { gaussSolve } from "../sim/spice/lamps.js";
import { channelOhms } from "../sim/spice/output-stage.js";
import { partDef } from "../catalog/index.js";
import { LCD_BACKLIGHT } from "../catalog/parts.js";
import { astable555, bench, runner } from "./timing-fixtures.js";

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

const RED = LED_SPECS.red;
const spice = (doc) => runner(doc, { engine: "spice" });

// ── The datasheet numbers ───────────────────────────────────────────────────

test("each colour is fitted through its sheet's typical VF", () => {
  // Kingbright WP7113: VF at the test current, and the knee the slope puts
  // under it.
  const knees = Object.fromEntries(
    Object.entries(LED_SPECS).map(([c, s]) => [c, +ledKnee(s).toFixed(3)]),
  );
  assert.deepEqual(knees, {
    red: 1.8,
    yellow: 1.83,
    green: 1.86,
    blue: 2.8,
    white: 2.8,
  });
  for (const spec of Object.values(LED_SPECS)) {
    close(ledCurrent(spec, spec.vfV) * 1000, spec.atMa, 1e-9, spec.part);
  }
  assert.equal(ledCurrent(RED, 1.79), 0, "dark below the knee");
});

test("an LED burns where its junction reaches its maximum temperature", () => {
  // Ta + RthJA · VF · IF = Tj max, solved for IF.
  const burn = Object.fromEntries(
    Object.entries(LED_SPECS).map(([c, s]) => [
      c,
      +(burnCurrent(s) * 1000).toFixed(1),
    ]),
  );
  assert.deepEqual(burn, {
    red: 71.1,
    yellow: 59.6,
    green: 54.1,
    blue: 39.1,
    white: 41.2,
  });
  for (const spec of Object.values(LED_SPECS)) {
    close(junctionTemp(spec, burnCurrent(spec)), spec.tjMaxC, 1e-9, spec.part);
    // The DC rating is always short of it: overdriven comes first.
    assert.ok(spec.ifMaxMa / 1000 < burnCurrent(spec), spec.part);
  }
});

test("a verdict: lit, how bright, overdriven, burning, reversed", () => {
  const at = (ma) => ledVerdict(RED, ma / 1000, RED.vfV);
  assert.equal(at(0.01).lit, false, "10 µA is dark");
  assert.equal(at(0.1).lit, true);
  close(at(10).level, 1, 1e-9, "1 at the sheet's normalising current");
  close(at(1.25).level, 0.5, 1e-9, "the cube root: 1/8 the current, half");
  assert.equal(at(500).level, 1.4, "capped");
  assert.equal(at(30).overdriven, false, "AT the rating is fine");
  assert.equal(at(31).overdriven, true);
  assert.equal(at(70).burns, false);
  assert.equal(at(72).burns, true);
  assert.equal(ledVerdict(RED, 0, -5).reverse, false, "5 V reverse is rated");
  assert.equal(ledVerdict(RED, 0, -5.1).reverse, true);
});

// ── Output stages ───────────────────────────────────────────────────────────

test("a 74LS output: VCC − 1.4 V behind 120 Ω HIGH, 0.15 V behind 25 Ω LOW", () => {
  const def = partDef("74LS04");
  const high = outputStage(def, 5, "H");
  close(high.volts, 3.6, 1e-12, "VOH open");
  // SDLS025D: VOH 3.4 V typ at VCC 4.75 V, IOH −0.4 mA.
  close(
    outputStage(def, 4.75, "H").volts - 0.0004 * high.ohms,
    3.302,
    1e-9,
    "VOH",
  );
  // IOS 20–100 mA at VCC 5.25 V, shorted.
  const ios = stageCurrent(outputStage(def, 5.25, "H"), 0);
  assert.ok(ios > 0.02 && ios < 0.1, `IOS ${ios}`);
  const low = outputStage(def, 5, "L");
  // §6.6: VOL 0.25 V typ at 4 mA, 0.35 V at 8 mA.
  close(-stageCurrent(low, 0.25), 0.004, 1e-9, "4 mA at 0.25 V");
  close(-stageCurrent(low, 0.35), 0.008, 1e-9, "8 mA at 0.35 V");
  assert.equal(stageCurrent(high, 4), 0, "a HIGH cannot sink");
  assert.equal(stageCurrent(low, 0.1), 0, "a LOW cannot source");
});

test("a CD4000 output saturates, by supply", () => {
  const def = partDef("CD4069UB");
  // Straight into a red LED: ~4 mA at 5 V (CD4029B Figs. 1 and 3).
  close(stageCurrent(outputStage(def, 5, "H"), 1.9), 0.0042, 1e-9, "5 V");
  close(stageCurrent(outputStage(def, 10, "H"), 1.9), 0.016, 1e-9, "10 V");
  close(stageCurrent(outputStage(def, 15, "H"), 1.9), 0.028, 1e-9, "15 V");
  // Linear near the rail: 1 mA at VO 0.4 V (5 V).
  close(-stageCurrent(outputStage(def, 5, "L"), 0.4), 0.001, 1e-9, "IOL");
  assert.equal(stageSlope(outputStage(def, 5, "L"), 4), 0, "saturated");
  close(stageSlope(outputStage(def, 5, "L"), 0.4), -1 / 400, 1e-9, "linear");
});

test("the parts whose stage is their own say so", () => {
  // NE555: 1.35 V behind 3.5 Ω — 1.7 V down at 100 mA (§5.5's 13.3 V at 15 V).
  close(outputStage(partDef("NE555"), 15, "H").volts - 0.1 * 3.5, 13.3, 1e-9, "555 VOH"); // prettier-ignore
  close(-stageCurrent(outputStage(partDef("NE555"), 5, "L"), 5), 0.055, 1e-9, "555 sink limit"); // prettier-ignore
  // CD4511B: VDD − 0.55 V behind 30 Ω (VOH 4.25 V typ at 5 mA, 3.55 at 25).
  const seg = outputStage(partDef("CD4511B"), 5, "H");
  close(seg.volts - 0.005 * seg.ohms, 4.3, 1e-9, "4511 at 5 mA");
  // An emitter follower: its resistance limits it, never the B-series
  // MOSFET's 4.2 mA at 5 V.
  assert.equal(seg.limit, Number.POSITIVE_INFINITY, "4511 HIGH unlimited");
  close(stageCurrent(seg, 4.45 - 0.025 * 30), 0.025, 1e-9, "25 mA at 3.7 V");
  // CD4049UB: a 19.5 mA sink, a 6.5 mA source.
  close(-stageCurrent(outputStage(partDef("CD4049UB"), 5, "L"), 5), 0.0195, 1e-9, "4049 sink"); // prettier-ignore
  close(stageCurrent(outputStage(partDef("CD4049UB"), 5, "H"), 0), 0.0065, 1e-9, "4049 source"); // prettier-ignore
  assert.deepEqual(partDef("CD4050B").outputStage, partDef("CD4049UB").outputStage); // prettier-ignore
});

test("an analog switch's channel is its on-resistance at its supply", () => {
  assert.equal(channelOhms(partDef("CD4066B"), 5), 470);
  assert.equal(channelOhms(partDef("CD4066B"), 10), 180);
});

test("gaussSolve solves, and refuses a singular system", () => {
  const x = gaussSolve(
    [Float64Array.from([2, 1]), Float64Array.from([1, 3])],
    [3, 5],
  );
  close(x[0], 0.8, 1e-12, "x");
  close(x[1], 1.4, 1e-12, "y");
  assert.equal(
    gaussSolve([Float64Array.from([1, 2]), Float64Array.from([2, 4])], [1, 2]),
    null,
  );
});

// ── In circuit ──────────────────────────────────────────────────────────────

/** A `color` LED from + to − through `ohms` (none: straight across). */
function railLamp({
  volts = 5,
  ohms = 330,
  color = "red",
  reversed = false,
} = {}) {
  const b = bench({ volts });
  const d = b.seat("d1", "led", "a30", { color });
  const [anode, cathode] = reversed ? [d.get(2), d.get(1)] : [d.get(1), d.get(2)]; // prettier-ignore
  if (ohms) {
    const r = b.seat("r1", "resistor", "a20", { ohms });
    b.vcc(r.get(1));
    b.link(r.get(2), anode);
  } else {
    b.vcc(anode);
  }
  b.gnd(cathode);
  return b.doc;
}

/** A powered inverter package at `anchor`: pin → hole. */
function inverter(b, id, ref, anchor) {
  const u = b.seat(id, ref, anchor);
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  return u;
}

test("through a resistor: (V − knee) / (R + rd), lit, nothing to say", () => {
  const r = spice(railLamp()).run(0).result;
  const lamp = r.lamps.get("d1");
  close(lamp.amps, (5 - 1.8) / 340, 1e-6, "9.4 mA");
  assert.equal(lamp.lit, true);
  assert.equal(lamp.burnt, false);
  assert.ok(lamp.level > 0.95 && lamp.level < 1, `level ${lamp.level}`);
  assert.ok(!r.warnings.some((w) => w.type.startsWith("led-")));
});

test("straight across a supply it burns — once, and stays burnt", () => {
  const sim = spice(railLamp({ ohms: 0 }));
  let r = sim.run(0).result;
  const burnt = r.warnings.filter((w) => w.type === "led-burnt");
  assert.equal(burnt.length, 1);
  assert.equal(burnt[0].comp, "d1");
  // (5 − 1.8) / 10 Ω: 320 mA, its junction far past 125 °C.
  close(burnt[0].amps, 0.32, 1e-6, "the current that burnt it");
  assert.ok(burnt[0].tj > 125);
  assert.deepEqual(
    { lit: r.lamps.get("d1").lit, burnt: r.lamps.get("d1").burnt },
    { lit: false, burnt: true },
  );
  // Open from then on: the supply delivers nothing to it.
  assert.equal(r.supplies.get("psu1").amps, 0);
  r = sim.run(0.01).result;
  assert.equal(r.lamps.get("d1").burnt, true, "still burnt");
  assert.ok(!r.warnings.some((w) => w.type === "led-burnt"), "said once");
  // A new run is a new LED.
  assert.equal(spice(railLamp({ ohms: 330 })).run(0).result.lamps.get("d1").burnt, false); // prettier-ignore
});

test("past its DC rating it is overdriven — warned, not burnt", () => {
  // 9 V through 220 Ω: (9 − 1.8) / 230 Ω = 31.3 mA, past red's 30 mA.
  const r = spice(railLamp({ volts: 9, ohms: 220 })).run(0).result;
  const w = r.warnings.find((x) => x.type === "led-overdriven");
  assert.ok(w);
  assert.equal(w.comp, "d1");
  close(w.amps, 7.2 / 230, 1e-6, "31 mA");
  close(w.rating, 0.03, 1e-12, "red's 30 mA");
  assert.equal(r.lamps.get("d1").burnt, false);
  assert.ok(r.lamps.get("d1").level > 1, "brighter than at its rating");
});

test("a blue LED on 3 V barely lights; on 5 V it lights", () => {
  const dim = spice(railLamp({ volts: 3, ohms: 100, color: "blue" })).run(0).result; // prettier-ignore
  close(dim.lamps.get("d1").amps, 0.2 / 125, 1e-5, "1.6 mA past its 2.8 V knee"); // prettier-ignore
  const bright = spice(railLamp({ volts: 5, ohms: 100, color: "blue" })).run(0).result; // prettier-ignore
  assert.ok(dim.lamps.get("d1").level < bright.lamps.get("d1").level / 2);
});

test("reversed across 9 V: past its 5 V rating, warned", () => {
  const r = spice(railLamp({ volts: 9, ohms: 0, reversed: true })).run(0).result; // prettier-ignore
  const w = r.warnings.find((x) => x.type === "led-reverse");
  assert.ok(w);
  close(w.volts, 9, 1e-6, "9 V reverse");
  assert.equal(w.rating, 5);
  assert.equal(r.lamps.get("d1").lit, false);
  assert.equal(r.lamps.get("d1").burnt, false);
  // On 5 V it is within its rating.
  const ok = spice(railLamp({ volts: 5, ohms: 0, reversed: true })).run(0).result; // prettier-ignore
  assert.ok(!ok.warnings.some((x) => x.type === "led-reverse"));
});

test("an output as the stage it is: a 74LS HIGH lights an LED, its LOW burns one", () => {
  // Sourcing straight into a red LED: 120 Ω is a resistor in all but name —
  // (3.6 − 1.8) / 130 Ω = 13.8 mA. The digital engine burns it.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1)); // 1Y HIGH
  const d = b.seat("d1", "led", "a30", { color: "red" });
  b.link(u.get(2), d.get(1));
  b.gnd(d.get(2));
  const r = spice(b.doc).run(0).result;
  close(r.lamps.get("d1").amps, 1.8 / 130, 1e-6, "13.8 mA");
  assert.equal(r.lamps.get("d1").burnt, false);

  // Sinking from VCC: 25 Ω and 10 Ω take (5 − 1.8 − 0.15) V — 87 mA.
  const s = bench();
  const v = inverter(s, "u1", "74LS04", "e10");
  s.vcc(v.get(1)); // 1Y LOW
  const e = s.seat("d1", "led", "a30", { color: "red" });
  s.vcc(e.get(1));
  s.link(e.get(2), v.get(2));
  const burnt = spice(s.doc).run(0).result;
  const w = burnt.warnings.find((x) => x.type === "led-burnt");
  close(w.amps, 3.05 / 35, 1e-6, "87 mA");
});

test("a CD4000 output at 5 V limits an LED itself; a 555 does not", () => {
  const b = bench();
  const u = inverter(b, "u1", "CD4069UB", "e10");
  b.gnd(u.get(1));
  const d = b.seat("d1", "led", "a30", { color: "red" });
  b.link(u.get(2), d.get(1));
  b.gnd(d.get(2));
  const r = spice(b.doc).run(0).result;
  close(r.lamps.get("d1").amps, 0.0042, 1e-6, "saturated at 4.2 mA");
  assert.equal(r.lamps.get("d1").lit, true);
  assert.ok(!r.warnings.some((w) => w.type.startsWith("led-")));

  // A 555 starts its astable HIGH: 1.35 V behind 3.5 Ω — (5 − 1.35 − 1.8)
  // over 13.5 Ω is 137 mA, and the LED is gone.
  const { b: t, u: timer } = astable555({ ra: 1e3, rb: 10e3, c: 10e-6 });
  const e = t.seat("d1", "led", "a58", { color: "red" });
  t.link(timer.get(3), e.get(1));
  t.gnd(e.get(2));
  const w = spice(t.doc).run(0).result.warnings.find((x) => x.type === "led-burnt"); // prettier-ignore
  close(w.amps, 1.85 / 13.5, 1e-6, "137 mA");
});

test("segments sharing one resistor share its current", () => {
  // A common-cathode digit: segments a and b on +, K through 330 Ω to −.
  const b = bench();
  const g = b.seat("g1", "seg8cc", "a20", { color: "red" });
  b.vcc(g.get(1));
  b.vcc(g.get(2));
  const r = b.seat("r1", "resistor", "a40", { ohms: 330 });
  b.link(g.get(9), r.get(1));
  b.gnd(r.get(2));
  const res = spice(b.doc).run(0).result;
  const a = res.lamps.get("g1#a");
  const bSeg = res.lamps.get("g1#b");
  close(a.amps, bSeg.amps, 1e-6, "alike");
  // Two in parallel: 2 · (3.2 − Vk) / 10 = Vk / 330.
  const vk = 0.64 / (0.2 + 1 / 330);
  close(a.amps + bSeg.amps, vk / 330, 1e-6, "the resistor's current");
  assert.equal(res.lamps.get("g1#c").lit, false, "an undriven segment is dark");
  close(res.supplies.get("psu1").amps, vk / 330, 1e-6, "booked to the supply");
});

test("the digital engine keeps its rule and draws no lamps", () => {
  const r = runner(railLamp({ ohms: 0 })).run(0).result;
  assert.equal(r.lamps, undefined);
  assert.ok(!r.warnings.some((w) => w.type.startsWith("led-")));
});

// ── The current through each lead (what the probe reads) ───────────────────

test("every lead the solve knows carries its current, by the hole it is in", () => {
  const b = bench();
  const d = b.seat("d1", "led", "a30", { color: "red" });
  const r = b.seat("r1", "resistor", "a20", { ohms: 330 });
  b.vcc(r.get(1));
  b.link(r.get(2), d.get(1));
  b.gnd(d.get(2));
  const res = spice(b.doc).run(0).result;
  const amps = res.lamps.get("d1").amps;
  for (const hole of [d.get(1), d.get(2), r.get(1), r.get(2)]) {
    close(res.currents.get(b.at(hole)), amps, 1e-5, hole);
  }
  assert.equal(res.currents.get(b.at("j60")), undefined, "an empty hole: none");
  assert.equal(
    runner(b.doc).run(0).result.currents,
    undefined,
    "digital: none",
  );
});

test("a shared lead carries the sum; an output pin what it drives", () => {
  // A common-cathode digit with two segments lit: K carries both.
  const b = bench();
  const g = b.seat("g1", "seg8cc", "a20", { color: "red" });
  b.vcc(g.get(1));
  b.vcc(g.get(2));
  const r = b.seat("r1", "resistor", "a40", { ohms: 330 });
  b.link(g.get(9), r.get(1));
  b.gnd(r.get(2));
  let res = spice(b.doc).run(0).result;
  const a = res.lamps.get("g1#a").amps;
  close(res.currents.get(b.at(g.get(9))), 2 * a, 1e-5, "K");
  close(res.currents.get(b.at(g.get(1))), a, 1e-5, "a");
  assert.equal(res.currents.get(b.at(g.get(3))), 0, "an unlit segment's pin");

  // A 74LS04's 1Y sourcing a red LED through 1 kΩ: its pin, the LED's.
  const s = bench();
  const u = inverter(s, "u1", "74LS04", "e10");
  s.gnd(u.get(1));
  const rr = s.seat("r1", "resistor", "a20", { ohms: 1e3 });
  const e = s.seat("d1", "led", "a30", { color: "red" });
  s.link(u.get(2), rr.get(1));
  s.link(rr.get(2), e.get(1));
  s.gnd(e.get(2));
  res = spice(s.doc).run(0).result;
  close(res.currents.get(s.at(u.get(2))), res.lamps.get("d1").amps, 1e-5, "1Y");
});

// ── Diodes and Zeners in the same solve (spice/diodes.js) ───────────────────

test("an LED fed through a diode lights, a diode's drop below the supply", () => {
  // + → diode → red LED → 330 Ω → GND: once a network with no source of its
  // own, so the LED read dark while the digital engine lit it.
  const b = bench();
  const d = b.seat("d1", "diode", "a10");
  const led = b.seat("l1", "led", "a20", { color: "red" });
  const r = b.seat("r1", "resistor", "a30", { ohms: 330 });
  b.vcc(d.get(1));
  b.link(d.get(2), led.get(1));
  b.link(led.get(2), r.get(1));
  b.gnd(r.get(2));
  const res = spice(b.doc).run(0).result;
  const v = res.lamps.get("l1");
  assert.equal(v.lit, true);
  // (5 − 0.6 − 1.8) / (2 + 10 + 330)
  close(v.amps, 2.6 / 342, 1e-3, "the LED's current");
  close(res.lamps.get("d1").amps, v.amps, 1e-6, "the diode carries it too");
  assert.equal(res.lamps.get("d1").lit, false, "a diode never glows");
  close(
    res.supplies.get("psu1").amps,
    v.amps + 1e-12,
    1e-3,
    "the supply books it",
  );
});

test("a diode straight across the rails burns, and says so", () => {
  const b = bench();
  const d = b.seat("d1", "diode", "a10");
  b.vcc(d.get(1));
  b.gnd(d.get(2));
  const sim = spice(b.doc);
  const first = sim.run(0).result;
  assert.equal(first.lamps.get("d1").burnt, true);
  const burnt = first.warnings.filter((w) => w.type === "diode-burnt");
  assert.equal(burnt.length, 1);
  assert.equal(burnt[0].comp, "d1");
  assert.equal(
    first.warnings.some((w) => w.type === "led-burnt"),
    false,
  );
  const again = sim.run(0.01).result;
  assert.equal(
    again.lamps.get("d1").burnt,
    true,
    "open for the rest of the run",
  );
  assert.equal(
    again.warnings.some((w) => w.type === "diode-burnt"),
    false,
    "said once",
  );
});

test("a Zener clamps backwards at its voltage; one with none set is a diode", () => {
  const build = (params) => {
    const b = bench();
    const r = b.seat("r1", "resistor", "a10", { ohms: 1000 });
    const z = b.seat("z1", "zener", "a20", params);
    b.vcc(r.get(1));
    b.link(r.get(2), z.get(2)); // cathode up
    b.gnd(z.get(1));
    const sim = spice(b.doc);
    const res = sim.run(0).result;
    const net = sim.netlist.netOfPoint.get(b.at(z.get(2)));
    return { res, volts: res.nodeVolts.get(net) };
  };
  const { res, volts } = build({ zenerVolts: 3.3 });
  // (5 − 3.3) / (1000 + 5) through it, backwards.
  close(-res.lamps.get("z1").amps, 1.7 / 1005, 1e-3, "the breakdown current");
  close(volts, 3.3 + (1.7 / 1005) * 5, 1e-3, "clamped at its voltage");
  const plain = build({});
  close(plain.volts, 5, 1e-3, "no breakdown set: nothing flows, the net rises");
});

test("a character LCD's backlight is its colour's LED behind the board's resistor", () => {
  // A to VDD, K to GND — the usual hookup: lit, by (V − knee) / (rd + 100 Ω),
  // booked to the supply, and no rating said (the module maker's).
  for (const color of ["green", "blue"]) {
    const b = bench();
    const u = b.seat("u1", "lcd16x2", "a10", { color });
    b.vcc(u.get(2));
    b.gnd(u.get(1));
    b.gnd(u.get(3));
    b.vcc(u.get(15));
    b.gnd(u.get(16));
    const r = spice(b.doc).run(0).result;
    const led = LED_SPECS[color];
    const amps = (5 - ledKnee(led)) / (led.rdOhm + LCD_BACKLIGHT.ohms);
    const lamp = r.lamps.get("u1#backlight");
    close(lamp.amps, amps, 1e-6, `${color} backlight`);
    assert.equal(lamp.lit, true);
    assert.deepEqual(r.warnings, []);
    close(r.currents.get(b.at(u.get(15))), amps, 1e-6, "through A");
  }
  // Even at 12 V it neither warns nor burns.
  const at12 = ledVerdict(backlightSpec("red", LCD_BACKLIGHT.ohms), 0.1, 12);
  assert.equal(at12.overdriven || at12.burns || at12.reverse, false);
  // Unwired, it is dark.
  const b = bench();
  const u = b.seat("u1", "lcd16x2", "a10");
  b.vcc(u.get(2));
  b.gnd(u.get(1));
  const dark = spice(b.doc).run(0).result.lamps.get("u1#backlight");
  assert.equal(dark?.lit ?? false, false);
});
