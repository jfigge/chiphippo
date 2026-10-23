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

// spice-leds.test.js — Spice Lite's LEDs (features/done/spice-lite-leds.md):
// each colour's datasheet numbers and what follows from them (spice/leds.js),
// a chip output as the stage it is (spice/output-stage.js), and the network
// solve around every LED (spice/lamps.js) — lit, how bright, overdriven,
// reversed, heated through its lag, and burnt for the rest of the run.

import test from "node:test";
import assert from "node:assert/strict";

import {
  LED_SPECS,
  backlightSpec,
  burnCurrent,
  junctionTemp,
  LED_HEAT_TAU_S,
  ledBurnIn,
  ledCurrent,
  ledVoltage,
  ledVerdict,
} from "../sim/spice/leds.js";
import {
  outputStage,
  splitterAmps,
  splitterUnits,
  stageCurrent,
  stageKinks,
  stagePiece,
  stageSlope,
} from "../sim/spice/output-stage.js";
import { gaussSolve } from "../sim/spice/lamps.js";
import { channelOhms } from "../sim/spice/output-stage.js";
import { partDef } from "../catalog/index.js";
import { LCD_BACKLIGHT } from "../catalog/parts.js";
import {
  VT_V,
  shockleyVolts,
  tableVolts,
} from "../sim/spice/junction-table.js";
import { DIODE_SPEC } from "../sim/spice/diodes.js";
import { astable555, bench, runner } from "./timing-fixtures.js";

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

const RED = LED_SPECS.red;
const spice = (doc) => runner(doc, { engine: "spice" });

/** Tick `sim` at its own wakes from 0 until an LED burns (or `stop`
    seconds): that tick's result, when, and its `led-burnt` warning. */
function untilBurnt(sim, stop = 10) {
  let now = 0;
  for (let k = 0; k < 500; k++) {
    const result = sim.run(now).result;
    const burnt = result.warnings.find((w) => w.type === "led-burnt");
    if (burnt || result.wakeAt == null || result.wakeAt > stop) {
      return { result, at: now, burnt };
    }
    now = result.wakeAt;
  }
  throw new Error("no burn in 500 ticks");
}

/** The current, amps, an LED of `spec` carries from `volts` behind `ohms`:
    volts = V(I) + I·ohms, its curve's own V (bisected — V only rises). */
function ledThrough(spec, volts, ohms) {
  let lo = 0;
  let hi = ohms > 0 ? volts / ohms : 10;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (ledVoltage(spec, mid) + mid * ohms < volts) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ── The datasheet numbers ───────────────────────────────────────────────────

test("each colour is fitted to its sheet's curve, through its typical VF", () => {
  // Kingbright WP7113: within 0.4 % of VF at the test current (the fit's
  // own error and the table's together), and the toe the knee left out.
  for (const spec of Object.values(LED_SPECS)) {
    // Green's own figure puts 10 mA at 2.03 V, 30 mV over its table's typ.
    const off = spec.part === "WP7113GD" ? 0.015 : 0.004;
    close(ledVoltage(spec, spec.atMa / 1000), spec.vfV, off, spec.part);
  }
  // The red figure: 0.3 mA at 1.60 V, 2 mA at 1.70, 20 mA at 2.00.
  close(ledCurrent(RED, 1.6) * 1000, 0.43, 0.05, "the toe");
  close(ledCurrent(RED, 1.7) * 1000, 1.54, 0.05);
  close(ledVoltage(RED, 0.02), 2.02, 0.01);
  assert.equal(ledCurrent(RED, 1), 0, "dark well below its toe");
  // The table strays from the exponential by a few millivolts at most.
  for (const spec of Object.values(LED_SPECS)) {
    for (const amps of [1e-4, 1e-3, 1e-2, 3e-2]) {
      const err = Math.abs(ledVoltage(spec, amps) - shockleyVolts(spec, amps));
      assert.ok(
        err < 0.07 * spec.n * VT_V,
        `${spec.part} at ${amps} A: ${err}`,
      );
    }
  }
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
    red: 72,
    yellow: 62.1,
    green: 54.4,
    blue: 39.2,
    white: 41.4,
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
  assert.equal(at(71).burns, false);
  assert.equal(at(73).burns, true);
  assert.equal(ledVerdict(RED, 0, -5).reverse, false, "5 V reverse is rated");
  assert.equal(ledVerdict(RED, 0, -5.1).reverse, true);
});

// ── Output stages ───────────────────────────────────────────────────────────

test("a 74LS output: its swept gate's corners, HIGH and LOW", () => {
  const def = partDef("74LS04");
  const high = outputStage(def, 5, "H");
  close(high.volts, 4.51, 1e-12, "VOH open: VCC less 0.49 V");
  close(outputStage(def, 4.75, "H").volts, 4.26, 1e-12, "…at every VCC");
  // SDLS029C: VOH 3.4 V typ at VCC 4.75 V, IOH −0.4 mA — the fit's 3.37 V.
  close(stageCurrent(outputStage(def, 4.75, "H"), 4.26 - 0.8862), 0.0004, 1e-9, "VOH"); // prettier-ignore
  // A light load sits high on the Darlington's knee: 100 kΩ holds it at
  // 4.18 V (the transistor-level gate's 4.177).
  close(stageCurrent(high, 4.1789), 4.1789 / 100e3, 1e-4, "100 kΩ");
  // IOS 20–100 mA at VCC 5.25 V, shorted; 31.8 mA at 5 V.
  close(stageCurrent(high, 0), 0.0318, 2e-4, "IOS at 5 V");
  const ios = stageCurrent(outputStage(def, 5.25, "H"), 0);
  assert.ok(ios > 0.02 && ios < 0.1, `IOS ${ios}`);
  close(ios, 0.0338, 2e-4, "IOS at 5.25 V");
  assert.equal(stageSlope(high, -1), 0, "saturated past its short");
  const low = outputStage(def, 5, "L");
  close(low.volts, 0.2044, 1e-12, "VOL open");
  // §6.6: VOL 0.25 V typ at 4 mA, 0.35 V at 8 mA — the gate's 0.29 and 0.34.
  close(-stageCurrent(low, 0.2925), 0.004, 1e-2, "4 mA");
  close(-stageCurrent(low, 0.3439), 0.008, 1e-2, "8 mA");
  // All the base drive its pull-down has, from 0.6 V to 1.4 V; and pushed
  // past the Darlington's emitter, 152 mA — a LOW shorted to VCC smokes.
  close(-stageCurrent(low, 1), 0.01849, 1e-3, "18.5 mA at 1 V");
  close(-stageCurrent(low, 5), 0.152, 1e-3, "152 mA shorted to VCC");
  // Its currents follow VCC (its open level does not): the plateau 16.8 and
  // 20.2 mA at the sheet's 4.75 and 5.25 V, held outside them.
  close(-stageCurrent(outputStage(def, 4.75, "L"), 1), 0.01678, 1e-3, "4.75 V");
  close(-stageCurrent(outputStage(def, 5.25, "L"), 1), 0.02021, 1e-3, "5.25 V");
  close(-stageCurrent(outputStage(def, 5.5, "L"), 1), 0.02021, 1e-3, "held past 5.25 V"); // prettier-ignore
  assert.equal(outputStage(def, 5.25, "L").volts, low.volts);
  assert.equal(stageCurrent(high, 4.6), 0, "a HIGH cannot sink");
  assert.equal(stageCurrent(low, 0.1), 0, "a LOW cannot source");
  // Monotone: every chord's slope is a conductance, every kink a corner.
  for (const st of [high, low]) {
    let was = 0;
    for (const [d, amps] of st.corners) {
      assert.ok(amps >= was, `${st.sources ? "HIGH" : "LOW"} at ${d} V`);
      was = amps;
    }
    assert.equal(stageKinks(st).length, st.corners.length);
  }
  // A strength moves its currents, never its volts.
  const twice = outputStage(def, 5, "L", 2);
  close(-stageCurrent(twice, 0.3439), -2 * stageCurrent(low, 0.3439), 1e-9, "twice the sink"); // prettier-ignore
  assert.equal(twice.volts, low.volts);
});

test("a 74LS splitter: the current an input held LOW lets the pull-down take", () => {
  // Nothing at a grounded input; 15 µA at an LS LOW's 0.2 V, 54 µA at
  // 0.4 V, whatever the output (1–4 V); falling to nothing as the output
  // nears its GND.
  close(splitterAmps(0, 3), 0, 0, "grounded");
  close(splitterAmps(0.2, 3), 15e-6, 1e-12, "0.2 V");
  close(splitterAmps(0.4, 1), 53.7e-6, 1e-12, "0.4 V");
  assert.equal(splitterAmps(0.4, 4), splitterAmps(0.4, 1), "the output's own volts move nothing"); // prettier-ignore
  close(splitterAmps(0.4, 0.1), 53.7e-6 / 2, 1e-12, "saturating");
  assert.equal(splitterAmps(0.4, 0), 0);
  assert.equal(splitterAmps(2, 3), splitterAmps(0.8, 3), "held past VIL");
  // Only an LS INV or NAND with its family's totem pole carries one.
  assert.equal(splitterUnits(partDef("74LS04")).length, 6);
  assert.equal(splitterUnits(partDef("74LS00")).length, 4);
  assert.equal(splitterUnits(partDef("74LS14")).length, 0, "a Schmitt trigger");
  assert.equal(splitterUnits(partDef("74LS05")).length, 0, "an open collector");
  assert.equal(splitterUnits(partDef("74LS08")).length, 0, "an AND");
  assert.equal(splitterUnits(partDef("CD4069UB")).length, 0, "CMOS");
});

test("a CD4000 output saturates, by supply", () => {
  const def = partDef("CD4069UB");
  // Saturated past its overdrive (2 × R × limit): 4.2 / 16 / 28 mA at
  // 5 / 10 / 15 V (CD4029B Figs. 1 and 3).
  for (const [vdd, ma, ohms] of [
    [5, 4.2, 400],
    [10, 16, 190],
    [15, 28, 200],
  ]) {
    // prettier-ignore
    const st = outputStage(def, vdd, "H");
    close(st.vov, (2 * ohms * ma) / 1000, 1e-12, `${vdd} V: its overdrive`);
    close(stageCurrent(st, vdd - st.vov), ma / 1000, 1e-12, `${vdd} V: saturated`); // prettier-ignore
    close(stageCurrent(st, 0), ma / 1000, 1e-12, `${vdd} V: shorted`);
    assert.equal(stageSlope(st, 0), 0, `${vdd} V: flat`);
  }
  // Between, the square law: a red LED's 1.9 V is 3.1 V from a 5 V HIGH,
  // short of its 3.36 V overdrive — 99 % of the limit, not all of it.
  const hi = outputStage(def, 5, "H");
  const x = 3.1 / hi.vov;
  close(
    stageCurrent(hi, 1.9),
    0.0042 * x * (2 - x),
    3e-3,
    "5 V into a red LED",
  );
  // Near the rail its slope is R's: what draws little sees 400 Ω exactly…
  const lo = outputStage(def, 5, "L");
  close(stageSlope(lo, 0.01), -1 / 400, 1e-12, "400 Ω at the rail");
  close(-stageCurrent(lo, 0.02), 0.02 / 400, 1e-15, "a light load");
  // …and the curve bends from it: at the sheet's IOL test point (VO 0.4 V)
  // 0.93 mA, within 7 % of its 1 mA typical.
  close(-stageCurrent(lo, 0.4), 0.000934, 1e-3, "IOL");
  // The chords stay within a fraction of a percent of the limit of the
  // square law they are drawn from.
  for (let d = 0; d <= hi.vov; d += hi.vov / 97) {
    const t = d / hi.vov;
    const off = Math.abs(stageCurrent(hi, 5 - d) - 0.0042 * t * (2 - t));
    assert.ok(off <= 0.0042 * 0.003, `at ${d.toFixed(2)} V: ${off} A off the curve`); // prettier-ignore
  }
});

test("a CD4000 output's curve: its corners, its pieces, and who has one", () => {
  const def = partDef("CD4069UB");
  const hi = outputStage(def, 5, "H");
  // Every chord's end is a kink, both ways round a channel, and each chord a
  // piece of its own — the one through zero the same piece either way.
  const kinks = stageKinks(hi);
  assert.equal(kinks[0], 5, "its open-circuit level");
  for (const d of [0.0125, 0.5, 1].map((x) => x * hi.vov)) {
    assert.ok(kinks.some((k) => Math.abs(k - (5 - d)) < 1e-12), `5 − ${d.toFixed(3)} V`); // prettier-ignore
    assert.ok(kinks.some((k) => Math.abs(k - (5 + d)) < 1e-12), `5 + ${d.toFixed(3)} V`); // prettier-ignore
  }
  const pieces = [4.99, 5.01, 4.9, 4, 2, 0].map((v) => stagePiece(hi, v));
  assert.equal(pieces[0], pieces[1], "the chord through zero, both ways");
  assert.equal(new Set(pieces.slice(1)).size, 5, "a piece per chord");
  assert.equal(pieces[5], "2", "saturated");
  // A stronger family figure is a bigger transistor: the same overdrive,
  // the current scaled.
  const twice = outputStage(def, 5, "H", 2);
  close(twice.vov, hi.vov, 1e-12, "the same overdrive");
  close(stageCurrent(twice, 3), 2 * stageCurrent(hi, 3), 1e-12, "twice the current"); // prettier-ignore
  // So is a part's own `scale` (the CD4049UB's sink)…
  const buffer = outputStage(partDef("CD4049UB"), 5, "L");
  close(buffer.vov, hi.vov, 1e-12, "a 4049's sink: the family's curve");
  // …but a stage stated outright is some other transistor, and stays two
  // straight lines.
  assert.equal(outputStage(partDef("CD4511B"), 5, "H").vov, undefined, "4511 HIGH"); // prettier-ignore
  assert.ok(outputStage(partDef("CD4511B"), 5, "L").vov > 0, "its LOW is the family's"); // prettier-ignore
  assert.equal(outputStage(partDef("NE555"), 5, "H").vov, undefined, "555");
  assert.equal(outputStage(partDef("74LS04"), 5, "L").vov, undefined, "74LS");
  // Below 2 V the family saturates at nothing: no curve to draw.
  assert.equal(outputStage(def, 2, "H").vov, undefined, "2 V");
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

test("through a resistor: V = VF(I) + I·R, lit, nothing to say", () => {
  const r = spice(railLamp()).run(0).result;
  const lamp = r.lamps.get("d1");
  close(lamp.amps, ledThrough(RED, 5, 330), 1e-6, "9.4 mA");
  assert.equal(lamp.lit, true);
  assert.equal(lamp.burnt, false);
  assert.ok(lamp.level > 0.95 && lamp.level < 1, `level ${lamp.level}`);
  assert.ok(!r.warnings.some((w) => w.type.startsWith("led-")));
});

test("straight across a supply it burns — in time, once, and stays burnt", () => {
  const sim = spice(railLamp({ ohms: 0 }));
  // Not at once: lit and heating, woken where its junction reaches 125 °C.
  let r = sim.run(0).result;
  assert.equal(r.lamps.get("d1").burnt, false);
  assert.equal(r.lamps.get("d1").lit, true);
  const amps = ledThrough(RED, 5, 0);
  const due = ledBurnIn(25, junctionTemp(RED, amps), RED.tjMaxC);
  close(r.wakeAt, due, 1e-9, "woken on the burn");
  assert.ok(due > 0.05 && due < 0.15, `${due} s`);
  r = sim.run(due).result;
  const burnt = r.warnings.filter((w) => w.type === "led-burnt");
  assert.equal(burnt.length, 1);
  assert.equal(burnt[0].comp, "d1");
  // Its curve at 5 V: ~410 mA, which would heat its junction far past
  // 125 °C.
  close(burnt[0].amps, amps, 1e-6, "the current that burnt it");
  close(burnt[0].tj, junctionTemp(RED, amps), 1e-9, "where it was heading");
  assert.ok(burnt[0].tj > 1000);
  assert.deepEqual(
    { lit: r.lamps.get("d1").lit, burnt: r.lamps.get("d1").burnt },
    { lit: false, burnt: true },
  );
  // Open from then on: the supply delivers nothing to it.
  assert.equal(r.supplies.get("psu1").amps, 0);
  r = sim.run(due + 0.01).result;
  assert.equal(r.lamps.get("d1").burnt, true, "still burnt");
  assert.ok(!r.warnings.some((w) => w.type === "led-burnt"), "said once");
  // A new run is a new LED.
  assert.equal(spice(railLamp({ ohms: 330 })).run(0).result.lamps.get("d1").burnt, false); // prettier-ignore
});

test("a little over current it survives; past its burn figure, in time, it burns", () => {
  // 5 V through 47 Ω: 56 mA — under red's 72 mA burn figure, never burnt.
  const warm = spice(railLamp({ ohms: 47 }));
  const r = warm.run(0).result;
  assert.ok(r.lamps.get("d1").overdriven);
  assert.equal(r.wakeAt, null, "nothing to wake for");
  assert.equal(warm.run(60).result.lamps.get("d1").burnt, false);
  // 5 V through 33 Ω: 75 mA — just past it: seconds, not a moment.
  const hot = untilBurnt(spice(railLamp({ ohms: 33 })));
  assert.ok(hot.burnt);
  assert.ok(hot.at > 2 * LED_HEAT_TAU_S && hot.at < 4 * LED_HEAT_TAU_S, `${hot.at} s`); // prettier-ignore
});

test("a pulse past its burn figure heats it only while it lasts", () => {
  // 5 V straight across, for 50 ms of the ~91 ms it would take, then off:
  // it cools, and the next 50 ms do not burn it either.
  const doc = railLamp({ ohms: 0 });
  const sim = spice(doc);
  assert.equal(sim.run(0).result.lamps.get("d1").burnt, false);
  const feed = doc.wires.findIndex((w) => w.from === "psu1.+");
  const [wire] = doc.wires.splice(feed, 1);
  sim.rebuild();
  assert.equal(sim.run(0.05).result.lamps.get("d1").burnt, false);
  doc.wires.push(wire);
  sim.rebuild();
  assert.equal(sim.run(2).result.lamps.get("d1").burnt, false, "cooled");
  assert.equal(sim.run(2.05).result.lamps.get("d1").burnt, false, "a fresh 50 ms"); // prettier-ignore
});

test("past its DC rating it is overdriven — warned, not burnt", () => {
  // 9 V through 220 Ω: 31.2 mA, past red's 30 mA.
  const r = spice(railLamp({ volts: 9, ohms: 220 })).run(0).result;
  const w = r.warnings.find((x) => x.type === "led-overdriven");
  assert.ok(w);
  assert.equal(w.comp, "d1");
  close(w.amps, ledThrough(RED, 9, 220), 1e-6, "31 mA");
  close(w.rating, 0.03, 1e-12, "red's 30 mA");
  assert.equal(r.lamps.get("d1").burnt, false);
  assert.ok(r.lamps.get("d1").level > 1, "brighter than at its rating");
});

test("a blue LED on 3 V barely lights; on 5 V it lights", () => {
  const dim = spice(railLamp({ volts: 3, ohms: 100, color: "blue" })).run(0).result; // prettier-ignore
  close(dim.lamps.get("d1").amps, ledThrough(LED_SPECS.blue, 3, 100), 1e-5, "2.7 mA"); // prettier-ignore
  const bright = spice(railLamp({ volts: 5, ohms: 100, color: "blue" })).run(0).result; // prettier-ignore
  close(bright.lamps.get("d1").amps, ledThrough(LED_SPECS.blue, 5, 100), 1e-5, "17.7 mA"); // prettier-ignore
  assert.ok(dim.lamps.get("d1").level < bright.lamps.get("d1").level * 0.6);
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

/** The current, amps, an LED of `spec` carries straight on a chip output's
    `stage` — to ground from a HIGH, or from a `volts` supply into a LOW:
    what the stage delivers at the pin the LED holds (bisected). */
function ledOnStage(spec, stage, volts = 5) {
  const pin = (i) => (stage.sources ? ledVoltage(spec, i) : volts - ledVoltage(spec, i)); // prettier-ignore
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (Math.abs(stageCurrent(stage, pin(mid))) > mid) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

test("an output as the stage it is: a 74LS HIGH lights an LED, its LOW burns one", () => {
  // Sourcing straight into a red LED: the HIGH's own ~120 Ω past its knee
  // is a resistor in all but name — 16 mA. The digital engine burns it.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.gnd(u.get(1)); // 1Y HIGH
  const d = b.seat("d1", "led", "a30", { color: "red" });
  b.link(u.get(2), d.get(1));
  b.gnd(d.get(2));
  const r = spice(b.doc).run(0).result;
  const ls = partDef("74LS04");
  const lit = ledOnStage(RED, outputStage(ls, 5, "H"));
  close(r.lamps.get("d1").amps, lit, 1e-6, "16 mA");
  assert.ok(lit > 0.015 && lit < 0.017, `${lit}`);
  assert.equal(r.lamps.get("d1").burnt, false);

  // Sinking from VCC: pushed past the Darlington's emitter, the LOW takes
  // all the LED will — and burns it.
  const s = bench();
  const v = inverter(s, "u1", "74LS04", "e10");
  s.vcc(v.get(1)); // 1Y LOW
  const e = s.seat("d1", "led", "a30", { color: "red" });
  s.vcc(e.get(1));
  s.link(e.get(2), v.get(2));
  const { burnt: w } = untilBurnt(spice(s.doc));
  close(w.amps, ledOnStage(RED, outputStage(ls, 5, "L")), 1e-6, "sunk");
});

test("a CD4000 output at 5 V limits an LED itself; a 555 does not", () => {
  const b = bench();
  const u = inverter(b, "u1", "CD4069UB", "e10");
  b.gnd(u.get(1));
  const d = b.seat("d1", "led", "a30", { color: "red" });
  b.link(u.get(2), d.get(1));
  b.gnd(d.get(2));
  const r = spice(b.doc).run(0).result;
  // Just short of its 4.2 mA limit: the LED's ~1.9 V leaves the output
  // 3.1 V of its 3.36 V overdrive (spice/output-stage.js's square law).
  close(r.lamps.get("d1").amps, 0.00418, 1e-3, "nearly saturated at 4.2 mA");
  assert.equal(r.lamps.get("d1").lit, true);
  assert.ok(!r.warnings.some((w) => w.type.startsWith("led-")));

  // A 555 starts its astable HIGH: 1.35 V behind 3.5 Ω — 154 mA (less the
  // millivolt the wiring takes), past red's 72 mA burn figure. Its first
  // 0.12 s HIGH does not burn it — each LOW cools it a little — but about
  // half the time at 154 mA heats it past 125 °C within a few cycles.
  const { b: t, u: timer } = astable555({ ra: 1e3, rb: 10e3, c: 10e-6 });
  const e = t.seat("d1", "led", "a58", { color: "red" });
  t.link(timer.get(3), e.get(1));
  t.gnd(e.get(2));
  const { burnt: w, at } = untilBurnt(spice(t.doc), 10);
  close(w.amps, ledThrough(RED, 5 - 1.35, 3.5), 1e-3, "154 mA");
  assert.ok(at > 0.5 && at < 3, `burnt at ${at} s`);
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
  // Two in parallel: 2 · I(5 − Vk) = Vk / 330, bisected.
  let lo = 0;
  let hi = 5;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (2 * ledCurrent(RED, 5 - mid) > mid / 330) lo = mid;
    else hi = mid;
  }
  const vk = (lo + hi) / 2;
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

test("every LED of a series string lights, and so does what lies between two of them", () => {
  // 12 V → 330 Ω → three red LEDs → GND: the nets between them are reached
  // through junctions alone, so nothing HOLDS them — the middle LED, both
  // its ends such a net, was dropped from the report and read dark.
  const b = bench({ volts: 12 });
  const r = b.seat("r1", "resistor", "a5", { ohms: 330 });
  const leds = ["d1", "d2", "d3"].map((id, i) => b.seat(id, "led", `a${20 + 10 * i}`, { color: "red" })); // prettier-ignore
  b.vcc(r.get(1));
  b.link(r.get(2), leds[0].get(1));
  b.link(leds[0].get(2), leds[1].get(1));
  b.link(leds[1].get(2), leds[2].get(1));
  b.gnd(leds[2].get(2));
  const res = spice(b.doc).run(0).result;
  const amps = res.lamps.get("d1").amps;
  assert.ok(amps > 0.015, `${amps} A`);
  for (const id of ["d2", "d3"]) {
    assert.equal(res.lamps.get(id).lit, true, id);
    close(res.lamps.get(id).amps, amps, 1e-6, id);
  }
  close(res.currents.get(b.at(leds[1].get(1))), amps, 1e-5, "d2's anode lead");

  // + → LED → 330 Ω → LED → GND: the resistor between the two.
  const c = bench();
  const e1 = c.seat("d1", "led", "a20", { color: "red" });
  const rr = c.seat("r1", "resistor", "a30", { ohms: 330 });
  const e2 = c.seat("d2", "led", "a40", { color: "red" });
  c.vcc(e1.get(1));
  c.link(e1.get(2), rr.get(1));
  c.link(rr.get(2), e2.get(1));
  c.gnd(e2.get(2));
  const out = spice(c.doc).run(0).result;
  const through = out.lamps.get("d1").amps;
  assert.ok(through > 1e-4, `${through} A`);
  close(
    out.currents.get(c.at(rr.get(1))),
    through,
    1e-5,
    "the resistor's lead",
  );
});

test("a 7-segment digit's current leaves by the common that is wired, pin 3 or pin 8", () => {
  // Its two commons are one strip inside it; the segments name pin 3. Wired
  // through pin 8 alone, every segment's milliamps were booked on pin 3's
  // hole, with nothing plugged into it.
  for (const com of [3, 8]) {
    const b = bench();
    const d = b.seat("d1", "seg7cc", "e20", { color: "red" });
    b.gnd(d.get(com));
    const r = b.seat("r1", "resistor", "a40", { ohms: 330 });
    b.link(r.get(1), d.get(7)); // segment a
    b.vcc(r.get(2));
    const res = spice(b.doc).run(0).result;
    const amps = res.lamps.get("d1#a").amps;
    assert.ok(amps > 5e-3, `lit: ${amps} A`);
    const other = com === 3 ? 8 : 3;
    close(res.currents.get(b.at(d.get(com))), amps, 1e-5, `pin ${com}, wired`);
    assert.ok(!res.currents.get(b.at(d.get(other))), `pin ${other}, empty`);
    close(res.currents.get(b.at(d.get(7))), amps, 1e-5, "segment a's pin");
  }
});

test("an input pin carries what its own stage does: a 74LS input's bias out of it", () => {
  // A 74LS04's 1A pulled down through 1 kΩ: the resistor carries the
  // input's bias, and so does the pin it comes out of.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  const r = b.seat("r1", "resistor", "a30", { ohms: 1e3 });
  b.link(u.get(1), r.get(1));
  b.gnd(r.get(2));
  let res = spice(b.doc).run(0).result;
  const bias = res.currents.get(b.at(r.get(1)));
  assert.ok(bias > 1e-4, `${bias} A`);
  close(res.currents.get(b.at(u.get(1))), bias, 1e-6, "1A");

  // Fed through 10 Ω, off the rails: its VCC pin carries what the feed
  // does — its ICC and the bias that leaves by 1A, tied to GND.
  const c = bench();
  const v = c.seat("u1", "74LS04", "e10");
  const feed = c.seat("rf", "resistor", "a30", { ohms: 10 });
  c.vcc(feed.get(1));
  c.link(feed.get(2), v.get(14));
  c.gnd(v.get(7));
  c.gnd(v.get(1));
  res = spice(c.doc).run(0).result;
  const fed = res.currents.get(c.at(feed.get(1)));
  close(res.currents.get(c.at(v.get(14))), fed, 1e-6, "VCC");
  const out = res.currents.get(c.at(v.get(1)));
  assert.ok(out > 1e-4, `1A: ${out} A`);
  close(
    res.currents.get(c.at(v.get(7))) + out,
    fed,
    1e-6,
    "GND and 1A, what VCC took",
  );
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
  // 5 V = the diode's drop + the LED's + 330 Ω's, at one current.
  let lo = 0;
  let hi = 0.1;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (
      tableVolts(DIODE_SPEC.table, mid) + ledVoltage(RED, mid) + 330 * mid <
      5
    )
      lo = mid; // prettier-ignore
    else hi = mid;
  }
  close(v.amps, (lo + hi) / 2, 1e-3, "the LED's current");
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
  // The supply goes past its limit at its set voltage: the solve holds it
  // on the limit from the next tick, soon, and the diode is judged there —
  // not at the 6 A the set voltage drove. There the supply's own 470 µF
  // (`PSU_OUTPUT_F`), at 5 V, empties through it first — far past a
  // 1N4148's 4 A for 1 µs (its sheet) — and it burns as the supply comes
  // on its limit.
  const run = sim.run(0).result;
  assert.equal(run.lamps.get("d1").burnt, false);
  assert.ok(run.wakeAt > 0 && run.wakeAt < 1e-3, `wakes at ${run.wakeAt}`);
  let first = sim.run(run.wakeAt).result;
  let at = run.wakeAt;
  for (let k = 0; k < 200 && !first.lamps.get("d1").burnt; k++) {
    at = Math.max(first.wakeAt ?? at + 0.1, at + 5e-4);
    first = sim.run(at).result;
  }
  assert.equal(first.lamps.get("d1").burnt, true);
  assert.ok(at < 0.01, `burnt at ${at} s`);
  const burnt = first.warnings.filter((w) => w.type === "diode-burnt");
  assert.equal(burnt.length, 1);
  assert.equal(burnt[0].comp, "d1");
  assert.equal(
    first.warnings.some((w) => w.type === "led-burnt"),
    false,
  );
  const again = sim.run(at + 0.01).result;
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
    const amps = ledThrough(led, 5, LCD_BACKLIGHT.ohms);
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
