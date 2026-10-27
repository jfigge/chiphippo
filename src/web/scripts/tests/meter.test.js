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

// The multimeter (catalog/meter.js, features/chiphippo-multimeter-prompt.md):
// its settings, its display, its window of readings, its element in the
// Spice Lite solve, a stopped bench's ohms and diode test, its probes on the
// document, its shunt in the logic engine's netlist, and the exports.

import test from "node:test";
import assert from "node:assert/strict";
import { partDef } from "../catalog/index.js";
import {
  CAP_LOG,
  CONTINUITY_OHMS,
  METER_ELEMENTS,
  capOhms,
  hzBands,
  meterSetup,
} from "../catalog/meter.js";
import { DOWN_COUNTS, meterDisplay, pickRange, METER_RANGES } from "../model/meter-display.js"; // prettier-ignore
import { MeterAverage } from "../sim/meter-average.js";
import {
  BenchRun,
  measureCapacitance,
  offlineMeterReading,
} from "../sim/meter-offline.js";
import { junctionKey } from "../sim/spice/lamps.js";
import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";
import { buildOccupancy, worldOfAddress } from "../model/occupancy.js";
import { exportKicad } from "../model/export/kicad.js";
import { exportDigital } from "../model/export/digital.js";
import { buildPlan } from "../model/build-plan.js";
import { bench, runner } from "./timing-fixtures.js";

const METER = partDef("meter");

/** A meter brick (`dmm1`) with its params normalized. */
const meterOf = (params) => ({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 0, params: METER.normalizeParams(params) }); // prettier-ignore

/** A 5 V bench with a divider of `top` over `bottom` (a10–a13, a20–a23):
    its middle is the node of a13. */
function divider(top, bottom) {
  const b = bench({ volts: 5 });
  // (Ids a document keeps: `normalizeDocument` takes c<n> only.)
  const r1 = b.seat("c1", "resistor", "a10", { ohms: top });
  const r2 = b.seat("c2", "resistor", "a20", { ohms: bottom });
  b.vcc(r1.get(1));
  b.link(r1.get(2), r2.get(1));
  b.gnd(r2.get(2));
  return b;
}

/** The reading a meter's element gives on one Spice Lite tick. */
function spiceReading(doc, id = "dmm1") {
  return runner(doc, { engine: "spice" }).run(0).result.bench.get(id) ?? null;
}

/** What the display shows for one steady reading of `volts` across it. */
function shown(params, volts) {
  const setup = meterSetup(METER.normalizeParams(params));
  return meterDisplay({ ...setup, reading: { mean: volts, rms: 0, min: volts, max: volts } }); // prettier-ignore
}

// ── Settings ─────────────────────────────────────────────────────────────

test("a new meter stands on DC volts, its probes lying beside it", () => {
  const p = METER.normalizeParams({});
  assert.equal(p.dial, "v");
  assert.equal(p.sound, "off");
  assert.ok(Number.isFinite(p.red.dx) && Number.isFinite(p.black.dy));
  assert.equal(meterSetup(p).fn, "dcv");
  // SELECT's choice is kept off its first only; a bad one is dropped.
  assert.deepEqual(METER.normalizeParams({ sel: { v: "dc", ohm: "cont", mv: "x" } }).sel, { ohm: "cont" }); // prettier-ignore
  // A probe on a point keeps the point; junk lies down.
  assert.deepEqual(METER.normalizeParams({ red: { at: "bb1.c13" } }).red, { at: "bb1.c13" }); // prettier-ignore
  assert.ok("dx" in METER.normalizeParams({ red: { at: "not an address" } }).red); // prettier-ignore
});

test("the dial and the red lead's jack make the element between the probes", () => {
  const setup = (p) => meterSetup(METER.normalizeParams(p));
  assert.deepEqual(setup({ dial: "v" }).element, METER_ELEMENTS.volts);
  assert.deepEqual(setup({ dial: "autov" }).element, METER_ELEMENTS.autov);
  assert.deepEqual(setup({ dial: "ohm" }).element, METER_ELEMENTS.ohms);
  assert.deepEqual(setup({ dial: "diode" }).element, METER_ELEMENTS.diode);
  assert.deepEqual(
    setup({ dial: "ua", jack: "ma" }).element,
    METER_ELEMENTS.ua,
  );
  assert.deepEqual(
    setup({ dial: "ma", jack: "ma" }).element,
    METER_ELEMENTS.ma,
  );
  assert.deepEqual(setup({ dial: "ma", jack: "a" }).element, METER_ELEMENTS.a);
  assert.equal(setup({ dial: "ma", jack: "a" }).scale, "a");
  // A current position with the lead in VΩ: open, reading 0.
  assert.equal(setup({ dial: "ma" }).element, null);
  // Beep-Jack: a lead in a current jack with the dial on volts — and the
  // 10A shunt still hard-wired across the probes.
  const trap = setup({ dial: "v", jack: "a" });
  assert.equal(trap.inErr, true);
  assert.deepEqual(trap.element, METER_ELEMENTS.a);
  assert.equal(setup({ dial: "v", jack: "ma" }).element, null);
  assert.equal(setup({ dial: "off", jack: "a" }).element, METER_ELEMENTS.a);
  assert.equal(setup({ dial: "off" }).element, null);
  // A blown fuse opens its input.
  assert.equal(setup({ dial: "ma", jack: "ma", fuseF1: true }).element, null);
  assert.equal(setup({ dial: "ma", jack: "a", fuseF2: true }).element, null);
});

// ── Display ──────────────────────────────────────────────────────────────

test("the display ranges itself on 6000 counts, as the BM235's", () => {
  assert.equal(shown({ dial: "v" }, 2.49875).text, "2.499");
  assert.equal(shown({ dial: "v" }, 5).text, "5.000");
  assert.equal(shown({ dial: "v" }, 12).text, "12.00");
  assert.equal(shown({ dial: "v" }, -3.3).text, "-3.300");
  assert.equal(shown({ dial: "v" }, 0).text, "0.000");
  assert.equal(shown({ dial: "v" }, 1200).text, "OL");
  assert.equal(shown({ dial: "mv" }, 0.0185).text, "18.50");
  assert.equal(shown({ dial: "mv" }, 0.0185).unit, "mV");
  // Down again only well inside the next range: 5.5 V on the 60 V range
  // stays there; 0.4 V goes down.
  const r = METER_RANGES.dcv;
  assert.equal(pickRange(r, 5.5, 1), 1);
  assert.ok(DOWN_COUNTS > 0);
  assert.equal(pickRange(r, 0.4, 1), 0);
  // RANGE holds it.
  assert.equal(pickRange(r, 12, 0, true), 0);
  const held = meterDisplay({ ...meterSetup(METER.normalizeParams({})), reading: { mean: 12 }, range: 0, manual: true }); // prettier-ignore
  assert.equal(held.text, "OL");
});

test("ohms, continuity, diode, AutoV, the current ranges and InEr read as the meter does", () => {
  // 1 kΩ through the 8 kΩ reference: 0.1778 V across it.
  const across = (ohms) => (1.6 * ohms) / (8000 + ohms);
  const ohm = shown({ dial: "ohm" }, across(1000));
  assert.equal(`${ohm.text} ${ohm.unit}`, "1.000 kΩ");
  assert.equal(shown({ dial: "ohm" }, 1.6).text, "OL");
  assert.equal(shown({ dial: "ohm", sel: { ohm: "cont" } }, across(100)).beep, true); // prettier-ignore
  assert.equal(shown({ dial: "ohm", sel: { ohm: "cont" } }, across(220)).beep, false); // prettier-ignore
  assert.ok(CONTINUITY_OHMS > 100 && CONTINUITY_OHMS < 220);
  assert.equal(shown({ dial: "diode" }, 0.5506).text, "0.551");
  assert.equal(shown({ dial: "diode" }, 3.2).text, "OL");
  // AutoV: nothing under a volt.
  assert.equal(shown({ dial: "autov" }, 0.739).text, "----");
  assert.equal(shown({ dial: "autov" }, 5).text, "5.0");
  // A current: the voltage across the shunt over its ohms.
  const ma = shown({ dial: "ma", jack: "ma" }, 0.0177);
  assert.equal(`${ma.text} ${ma.unit}`, "9.32 mA");
  assert.equal(shown({ dial: "ua", jack: "ma" }, 5).text, "OL");
  assert.equal(shown({ dial: "v", jack: "a" }, 0).text, "InEr");
  assert.equal(shown({ dial: "off" }, 3).blank, true);
});

// ── The window ───────────────────────────────────────────────────────────

test("a window is the mean of what was held, and the RMS of what moved", () => {
  const avg = new MeterAverage();
  // A 25 % PWM, 0/5 V, 10 ms: HIGH 2.5 ms, LOW 7.5 ms, held between edges.
  for (let k = 0; k < 10; k++) {
    const t = k * 0.01;
    avg.record("m", t, 5);
    avg.hold("m", t + 0.0025);
    avg.record("m", t + 0.0025, 0);
    avg.hold("m", t + 0.01);
  }
  const w = avg.take(0.1).get("m");
  assert.ok(Math.abs(w.mean - 1.25) < 1e-9, `${w.mean}`);
  assert.ok(Math.abs(w.rms - Math.sqrt(0.25 * 25 - 1.25 ** 2)) < 1e-9, `${w.rms}`); // prettier-ignore
  // A window covering no time is the last value, steady.
  const still = avg.take(0.1).get("m");
  assert.equal(still.mean, 0);
  assert.equal(still.span, 0);
});

// ── Spice Lite: the meter in the solve ──────────────────────────────────

test("on volts the meter loads what it measures with its 10 MΩ", () => {
  const b = divider(10e3, 10e3);
  b.doc.components.push(meterOf({ dial: "v", red: { at: b.at("c13") }, black: { at: "psu1.-" } })); // prettier-ignore
  assert.ok(Math.abs(spiceReading(b.doc).volts - 2.49875) < 1e-4);
  const hi = divider(1e6, 1e6);
  hi.doc.components.push(meterOf({ dial: "v", red: { at: hi.at("c13") }, black: { at: "psu1.-" } })); // prettier-ignore
  assert.ok(Math.abs(spiceReading(hi.doc).volts - 2.38095) < 1e-4, "a 1 M/1 M divider reads 2.381 V"); // prettier-ignore
  // The rail itself: 5 V.
  const rail = divider(10e3, 10e3);
  rail.doc.components.push(meterOf({ dial: "v", red: { at: "psu1.+" }, black: { at: "psu1.-" } })); // prettier-ignore
  assert.ok(Math.abs(spiceReading(rail.doc).volts - 5) < 1e-6);
});

test("AutoV's LoZ drags a divider down; a floating net reads 0", () => {
  const b = divider(10e3, 10e3);
  b.doc.components.push(meterOf({ dial: "autov", red: { at: b.at("c13") }, black: { at: "psu1.-" } })); // prettier-ignore
  assert.ok(Math.abs(spiceReading(b.doc).volts - 0.73944) < 1e-4);
  // A hole nothing is wired to: the 10 MΩ ties it to the black probe.
  const f = divider(10e3, 10e3);
  f.doc.components.push(meterOf({ dial: "v", red: { at: f.at("c60") }, black: { at: "psu1.-" } })); // prettier-ignore
  assert.ok(Math.abs(spiceReading(f.doc)?.volts ?? 0) < 1e-6);
});

test("on mA in series it reads the current, its burden left across it", () => {
  // 5 V → 330 Ω → (meter) → red LED → −: the meter closes the gap.
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 330 });
  const led = b.seat("l1", "led", "a30", { color: "red" });
  b.vcc(r.get(1));
  b.gnd(led.get(2));
  b.doc.components.push(meterOf({ dial: "ma", jack: "ma", red: { at: b.at("c13") }, black: { at: b.at("c30") } })); // prettier-ignore
  const reading = spiceReading(b.doc);
  assert.ok(reading.amps > 0.008 && reading.amps < 0.011, `${reading.amps} A`);
  assert.ok(
    Math.abs(reading.volts - reading.amps * 1.9) < 1e-9,
    "1.9 Ω of burden",
  );
  // Probes on one unbroken net read nothing.
  const same = bench({ volts: 5 });
  same.doc.components.push(meterOf({ dial: "ma", jack: "ma", red: { at: same.at("c13") }, black: { at: same.at("d13") } })); // prettier-ignore
  assert.equal(spiceReading(same.doc), null);
});

// ── A stopped bench ──────────────────────────────────────────────────────

test("stopped, ohms reads a resistor, an open gap OL, and a charged capacitor open", () => {
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 100e-6 });
  const read = (red, black, params = { dial: "ohm" }) => {
    const doc = structuredClone(b.doc);
    doc.components.push(meterOf({ ...params, red: { at: red }, black: { at: black } })); // prettier-ignore
    return offlineMeterReading(doc, "dmm1");
  };
  const at = (h) => b.at(h.replace(/^a/, "c"));
  const v = read(at(r.get(1)), at(r.get(2))).volts;
  assert.ok(Math.abs((v * 8000) / (1.6 - v) - 1000) < 1e-3);
  assert.ok(read(at(r.get(1)), b.at("c60")).volts > 1.5999);
  assert.ok(read(at(c.get(1)), at(c.get(2))).volts > 1.5999);
  // On volts a stopped bench reads nothing to ask for.
  assert.equal(read(at(r.get(1)), at(r.get(2)), { dial: "v" }), null);
});

test("stopped, probes on ONE net are a dead short: 0 Ω and the continuity beep — a wire across a resistor, two holes of a strip", () => {
  const b = bench({ volts: 5 });
  const r = b.seat("c1", "resistor", "a10", { ohms: 1000 });
  // A jumper across the resistor's two columns (the user's 2026-10-26 desk).
  b.link(r.get(1).replace(/^a/, "b"), r.get(2).replace(/^a/, "b"));
  const read = (red, black, params) => {
    const doc = structuredClone(b.doc);
    doc.components.push(meterOf({ ...params, red: { at: red }, black: { at: black } })); // prettier-ignore
    return offlineMeterReading(doc, "dmm1");
  };
  const at = (h) => b.at(h.replace(/^a/, "d"));
  for (const params of [
    { dial: "ohm" },
    { dial: "ohm", sel: { ohm: "cont" } },
  ]) {
    assert.deepEqual(read(at(r.get(1)), at(r.get(2)), params), { volts: 0 });
    // Two holes of one strip are one net too.
    assert.deepEqual(read(b.at("c40"), b.at("d40"), params), { volts: 0 });
  }
  assert.equal(shown({ dial: "ohm", sel: { ohm: "cont" } }, 0).beep, true);
  assert.equal(shown({ dial: "ohm" }, 0).ol, false);
  // Nothing to charge across a short: no capacitance reading.
  const doc = structuredClone(b.doc);
  doc.components.push(meterOf({ dial: "diode", sel: { diode: "cap" }, red: { at: b.at("c40") }, black: { at: b.at("d40") } })); // prettier-ignore
  assert.equal(measureCapacitance(doc, "dmm1"), null);
});

test("stopped, the diode test reads a junction's drop forward and OL backward", () => {
  const b = bench({ volts: 5 });
  const d = b.seat("d1", "diode", "a30", {});
  const led = b.seat("l1", "led", "a50", { color: "red" });
  const at = (h) => b.at(h.replace(/^a/, "c"));
  const read = (red, black) => {
    const doc = structuredClone(b.doc);
    doc.components.push(meterOf({ dial: "diode", red: { at: red }, black: { at: black } })); // prettier-ignore
    return offlineMeterReading(doc, "dmm1").volts;
  };
  const fwd = read(at(d.get(1)), at(d.get(2)));
  assert.ok(fwd > 0.45 && fwd < 0.75, `${fwd} V`);
  assert.ok(read(at(d.get(2)), at(d.get(1))) > 3);
  const ledFwd = read(at(led.get(1)), at(led.get(2)));
  assert.ok(ledFwd > 1.3 && ledFwd < 2.2, `${ledFwd} V`);
});

test("stopped, the bench runs in time: ohms climbs across a capacitor as the test charges it", () => {
  const b = bench({ volts: 5 });
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 100e-6 });
  const at = (h) => b.at(h.replace(/^a/, "c"));
  b.doc.components.push(meterOf({ dial: "ohm", red: { at: at(c.get(1)) }, black: { at: at(c.get(2)) } })); // prettier-ignore
  const run = new BenchRun(b.doc, "dmm1");
  // 1.6 V behind 8 kΩ into 100 µF: τ = 0.8 s.
  const { volts, ohms } = METER_ELEMENTS.ohms;
  assert.ok(Math.abs(run.voltsAt(0)) < 1e-6);
  const v = run.voltsAt(0.8);
  assert.ok(Math.abs(v - volts * (1 - Math.exp(-0.8 / (ohms * 100e-6)))) < 1e-4, `${v} V`); // prettier-ignore
  assert.equal(run.settled, false, "still charging");
  // Charged, it reads the source's whole voltage: open.
  assert.ok(run.voltsAt(20, { arrived: 1 }) > volts - 1e-6);
});

test("stopped, the diode test lights an LED faintly", () => {
  const b = bench({ volts: 5 });
  const led = b.seat("l1", "led", "a50", { color: "red" });
  const at = (h) => b.at(h.replace(/^a/, "c"));
  b.doc.components.push(meterOf({ dial: "diode", red: { at: at(led.get(1)) }, black: { at: at(led.get(2)) } })); // prettier-ignore
  const run = new BenchRun(b.doc, "dmm1");
  run.voltsAt(0.1);
  const lamp = run.lamps.get(junctionKey("l1"));
  assert.ok(lamp?.lit, "lit");
  // 3.2 V behind 9.7 kΩ through a red LED: ~0.14 mA, a dim glow.
  assert.ok(lamp.level < 0.5, `level ${lamp.level}`);
});

test("capacitance is timed: exact on a capacitor alone, thrown off by a resistor across it, OL past 10 mF", () => {
  const measure = (farads, across = null) => {
    const b = bench({ volts: 5 });
    const c = b.seat("c1", farads >= 1e-6 ? "cap-electrolytic" : "cap-ceramic", "a40", { farads }); // prettier-ignore
    if (across) {
      const r = b.seat("r1", "resistor", "a10", { ohms: across });
      b.link(r.get(1), c.get(1));
      b.link(r.get(2), c.get(2));
    }
    const at = (h) => b.at(h.replace(/^a/, "c"));
    b.doc.components.push(meterOf({ dial: "diode", sel: { diode: "cap" }, red: { at: at(c.get(1)) }, black: { at: at(c.get(2)) } })); // prettier-ignore
    return measureCapacitance(b.doc, "dmm1");
  };
  for (const farads of [10e-9, 100e-9, 4.7e-6, 1000e-6]) {
    const m = measure(farads);
    // (A floating pair carries the solve's picofarad of stray to earth.)
    assert.ok(Math.abs(m.farads / farads - 1) < 2e-4, `${farads} F read ${m.farads}`); // prettier-ignore
  }
  // The bigger the capacitor, the longer the meter takes: 1000 µF, seconds.
  assert.ok(measure(100e-9).seconds < 0.5);
  assert.ok(measure(1000e-6).seconds > 2);
  // 1 MΩ across 100 nF: the swing on its 773 kΩ range is cut short — high.
  const r = capOhms(1);
  const asym = (1.6 * 1e6) / (r + 1e6);
  const swing = ((r * 1e6) / (r + 1e6)) * 100e-9 * Math.log((asym + 0.5) / (asym - 0.5)); // prettier-ignore
  const read = measure(100e-9, 1e6).farads;
  assert.ok(Math.abs(read - swing / (r * CAP_LOG)) < 1e-11, `${read}`);
  assert.equal(measure(47e-3).farads, Infinity);
  // On the display.
  const cap = { ...meterSetup(METER.normalizeParams({ dial: "diode", sel: { diode: "cap" } })) }; // prettier-ignore
  const lcd = (farads) => meterDisplay({ ...cap, reading: { farads } });
  assert.deepEqual([lcd(100e-9).text, lcd(100e-9).unit], ["100.0", "nF"]);
  assert.deepEqual([lcd(4.7e-6).text, lcd(4.7e-6).unit], ["4.70", "µF"]);
  assert.deepEqual([lcd(4.7e-3).text, lcd(4.7e-3).unit], ["4.70", "mF"]);
  assert.equal(lcd(Infinity).text, "OL");
  assert.equal(lcd(null).text, "----", "still measuring");
});

test("Hz counts a window's rising crossings on each trigger band, AC-coupled", () => {
  const avg = new MeterAverage();
  avg.bands("m", hzBands(meterSetup(METER.normalizeParams({ dial: "v" }))));
  // A 0/5 V square at 100 Hz for a second, sampled at its edges.
  const square = (from, to, hz, lo = 0, hi = 5) => {
    for (let k = Math.round(from * 2 * hz); k / (2 * hz) <= to; k++) {
      const t = k / (2 * hz);
      avg.hold("m", t);
      avg.record("m", t, k % 2 ? lo : hi);
    }
  };
  avg.record("m", 0, 0);
  square(0, 0.2, 100);
  avg.take(0.2);
  square(0.2, 1.2, 100);
  const w = avg.take(1.2).get("m");
  assert.equal(w.hz.length, 4, "one per V trigger range");
  assert.ok(Math.abs(w.hz[0] - 100) < 1e-6, `${w.hz[0]} Hz`);
  // A 1 V swing is past the 6 V range's trigger and short of the 600 V's.
  square(1.2, 2.4, 50, 2, 3);
  const small = avg.take(2.4).get("m");
  assert.ok(Math.abs(small.hz[0] - 50) < 1e-6 && small.hz[2] === 0, `${small.hz}`); // prettier-ignore
  // Under 2 Hz reads 0.
  square(2.4, 4.4, 1);
  assert.equal(avg.take(4.4).get("m").hz[0], 0);
  // On the display.
  const v = meterSetup(METER.normalizeParams({ dial: "v" }));
  const hz = (f) =>
    meterDisplay({ ...v, hz: true, reading: { mean: 0, hz: f } });
  assert.deepEqual([hz(1000).text, hz(1000).unit, hz(1000).mode], ["1.000", "kHz", null]); // prettier-ignore
  assert.deepEqual([hz(50).text, hz(50).unit], ["50.00", "Hz"]);
  assert.deepEqual([hz(60).text, hz(60).unit], ["60.0", "Hz"], "6000 counts: up a range"); // prettier-ignore
  assert.equal(hzBands(meterSetup(METER.normalizeParams({ dial: "ohm" }))).length, 0); // prettier-ignore
});

test("Relative Zero shows a reading less its reference; REC's value shows in place of the reading", () => {
  const v = meterSetup(METER.normalizeParams({ dial: "v" }));
  const reading = { mean: 5, rms: 0, min: 5, max: 5 };
  const rel = meterDisplay({ ...v, reading, relative: 2 });
  assert.equal(rel.text, "3.000");
  assert.equal(rel.value, 5, "what it read, before the reference");
  assert.equal(meterDisplay({ ...v, reading, value: 1.25 }).text, "1.250");
});

// ── The document ─────────────────────────────────────────────────────────

test("a probe rests on a taken hole and claims nothing", () => {
  const b = divider(10e3, 10e3);
  b.doc.components.push(meterOf({ dial: "v", red: { at: b.at("a13") }, black: { at: "psu1.-" } })); // prettier-ignore
  const doc = normalizeDocument(b.doc);
  const meter = doc.components.find((c) => c.id === "dmm1");
  assert.equal(
    meter.params.red.at,
    "bb1.a13",
    "kept on the resistor's own hole",
  );
  assert.equal(buildOccupancy(doc).get("bb1.a13")?.componentId, "c1");
  // A dangling point loads lying loose.
  const gone = divider(10e3, 10e3).doc;
  gone.components.push(meterOf({ red: { at: "bb9.a1" } }));
  const loaded = normalizeDocument(gone).components.find((c) => c.id === "dmm1"); // prettier-ignore
  assert.ok("dx" in loaded.params.red);
});

test("probes move, fall loose with their board, and a pasted meter's lie beside it", () => {
  const b = divider(10e3, 10e3);
  const desk = new DeskDoc(normalizeDocument(b.doc));
  const meter = desk.addBrick("meter", 80, 0, { red: { at: "bb1.a13" } });
  assert.ok("dx" in desk.getComponent(meter.id).params.red, "a new meter's probes lie loose"); // prettier-ignore
  desk.setMeterProbe(meter.id, "red", { at: "bb1.a13" });
  desk.setMeterProbe(meter.id, "black", { at: "psu1.-" });
  assert.equal(desk.getComponent(meter.id).params.red.at, "bb1.a13");
  assert.throws(() => desk.setMeterProbe(meter.id, "red", { at: "bb9.a1" }));
  desk.setMeterProbe(meter.id, "red", { x: 100, y: 10 });
  assert.deepEqual(desk.getComponent(meter.id).params.red, { dx: 20, dy: 10 });
  desk.setMeterProbe(meter.id, "red", { at: "bb1.a13" });
  desk.removeBoard("bb1");
  const red = desk.getComponent(meter.id).params.red;
  assert.ok(
    !("at" in red) && Number.isFinite(red.dx),
    "loose where its hole was",
  );
  desk.removeComponent("psu1");
  assert.ok(!("at" in desk.getComponent(meter.id).params.black));
});

test("seatKey says what one part puts into holes: equal across an edit that moves no pin, not across one that does", () => {
  const desk = new DeskDoc(null);
  desk.addKit("full", 0, 0);
  const l = desk.addComponent({ kind: "discrete", ref: "inductor", board: "bb2", anchor: "a10" }); // prettier-ignore
  const chip = desk.addComponent({ kind: "chip", ref: "AT28C256", board: "bb2", anchor: "d30" }); // prettier-ignore
  const meter = desk.addBrick("meter", 80, 0, {});
  const before = desk.seatKey(l.id);
  desk.setComponentParams(l.id, { style: "can" });
  desk.setComponentMeta(l.id, { name: "L1" });
  assert.equal(desk.seatKey(l.id), before, "a look and a name move no pin");
  desk.setComponentParams(l.id, { bodyHoles: 3 });
  assert.notEqual(desk.seatKey(l.id), before, "a longer body moves pin 2");
  // A 600-mil chip's key carries the holes its body covers.
  assert.match(desk.seatKey(chip.id), /bb2\.f31/);
  // A meter's is where its probes rest; a brick's is nothing.
  const probes = desk.seatKey(meter.id);
  desk.setMeterProbe(meter.id, "red", { at: "bb2.a50" });
  assert.notEqual(desk.seatKey(meter.id), probes);
  assert.equal(desk.seatKey(desk.addBrick("psu", 200, 0, {}).id), "");
  assert.equal(desk.seatKey("nope"), "");
});

test("a probe in a hole is pushed off by a body or a lead pressed into it, and lies where its tip was", () => {
  const desk = new DeskDoc(null);
  desk.addKit("full", 0, 0);
  const meter = desk.addBrick("meter", 80, 0, {});
  const red = () => desk.getComponent(meter.id).params.red;
  const black = () => desk.getComponent(meter.id).params.black;
  // A 600-mil chip seated in d/h: its body stands over rows e–g.
  desk.setMeterProbe(meter.id, "red", { at: "bb2.f33" });
  desk.setMeterProbe(meter.id, "black", { at: "bb2.a50" });
  desk.addComponent({ kind: "chip", ref: "AT28C256", board: "bb2", anchor: "d30" }); // prettier-ignore
  assert.equal(desk.canProbeAt("bb2.f33"), false, "under the body");
  assert.equal(desk.pressProbesOff(), 1);
  const tip = worldOfAddress(desk.boards, "bb2.f33");
  assert.deepEqual(red(), { dx: tip.x - 80, dy: Math.round((tip.y - 0) * 100) / 100 }); // prettier-ignore
  assert.equal(
    black().at,
    "bb2.a50",
    "a hole nothing went into keeps its probe",
  );
  // A lead pressed into a hole that held none pushes it out too.
  desk.addComponent({ kind: "discrete", ref: "resistor", board: "bb2", anchor: "a50" }); // prettier-ignore
  assert.equal(desk.pressProbesOff(), 1);
  assert.ok(!("at" in black()) && Number.isFinite(black().dx));
  // A probe put on a hole a lead is ALREADY in touches it, edit after edit.
  desk.setMeterProbe(meter.id, "black", { at: "bb2.a50" });
  assert.equal(desk.pressProbesOff(), 0);
  desk.addComponent({ kind: "discrete", ref: "resistor", board: "bb2", anchor: "a55" }); // prettier-ignore
  assert.equal(desk.pressProbesOff(), 0);
  assert.equal(black().at, "bb2.a50");
  // Lead out, lead in again: pressed in, it pushes the probe off.
  desk.removeComponent(desk.componentsOnBoard("bb2").find((c) => c.anchor === "a50").id); // prettier-ignore
  assert.equal(desk.pressProbesOff(), 0, "a lead pulled out leaves it");
  desk.addComponent({ kind: "discrete", ref: "resistor", board: "bb2", anchor: "a50" }); // prettier-ignore
  assert.equal(desk.pressProbesOff(), 1);
  // A file with a probe under a body loads it lying there.
  const raw = desk.toJSON();
  raw.components.find((c) => c.id === meter.id).params.red = { at: "bb2.f33" };
  const loaded = normalizeDocument(raw).components.find((c) => c.id === meter.id); // prettier-ignore
  assert.ok(!("at" in loaded.params.red) && Number.isFinite(loaded.params.red.dx)); // prettier-ignore
});

test("a current range is a wire to the logic engine, a branch to Spice Lite, nothing to the build", () => {
  const b = bench({ volts: 5 });
  b.doc.components.push(meterOf({ dial: "ma", jack: "ma", red: { at: b.at("c13") }, black: { at: b.at("c30") } })); // prettier-ignore
  const logic = buildNetlist(b.doc);
  assert.equal(logic.netOfPoint.get(b.at("c13")), logic.netOfPoint.get(b.at("c30"))); // prettier-ignore
  const spice = buildNetlist(b.doc, new Map(), { inductors: "branch" });
  assert.notEqual(spice.netOfPoint.get(b.at("c13")), spice.netOfPoint.get(b.at("c30"))); // prettier-ignore
  const wiring = buildNetlist(b.doc, new Map(), { bridges: false });
  assert.notEqual(wiring.netOfPoint.get(b.at("c13")), wiring.netOfPoint.get(b.at("c30"))); // prettier-ignore
  // On volts it joins nothing anywhere.
  const v = bench({ volts: 5 });
  v.doc.components.push(meterOf({ dial: "v", red: { at: v.at("c13") }, black: { at: v.at("c30") } })); // prettier-ignore
  const n = buildNetlist(v.doc);
  assert.notEqual(n.netOfPoint.get(v.at("c13")), n.netOfPoint.get(v.at("c30")));
});

test("the exports and the build plan leave the meter out, and say a series gap is left open", () => {
  const b = divider(10e3, 10e3);
  b.doc.components.push(meterOf({ dial: "ma", jack: "ma", red: { at: b.at("c13") }, black: { at: b.at("c30") } })); // prettier-ignore
  const doc = normalizeDocument(b.doc);
  const kicad = exportKicad(doc, { tabId: "t1", name: "m" });
  assert.ok(kicad.report.some((e) => e.code === "meterInSeries" && e.ref === "meter")); // prettier-ignore
  assert.ok(!kicad.files.some((f) => f.text.includes("dmm1")));
  const digital = exportDigital(doc, { tabId: "t1", name: "m" });
  assert.ok(digital.report.some((e) => e.code === "meterInSeries"));
  // The line names the gap it leaves open — the two nets the probes were on.
  for (const report of [kicad.report, digital.report]) {
    const gap = report.find((e) => e.code === "meterInSeries").gap;
    assert.match(gap, /^\S.* – \S/, gap);
  }
  const onVolts = structuredClone(doc);
  onVolts.components.find((c) => c.id === "dmm1").params.dial = "v";
  assert.ok(exportKicad(onVolts, { tabId: "t1", name: "m" }).report.some((e) => e.code === "benchInstrument")); // prettier-ignore
  const plan = buildPlan(doc, buildNetlist(doc));
  assert.ok(!JSON.stringify(plan).includes("dmm1"));
});
