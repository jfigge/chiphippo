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

// The multimeter's fixes from the 2026-10-26 review (meter FINDINGS 1–12):
// a probe straight on an AC source's terminal, meters in series and on a
// supply on its limit, a probe drag cancelled, a beeper put away, an AC
// current through a fuse, DC of a periodic signal over whole periods, the
// blown-fuse mark, a stopped bench left alone by an edit it does not reach,
// "----", HOLD over InEr, REC per reading, and a run handed over.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { bench, runner } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { DeskDoc } from "../model/desk-doc.js";
import { worldOfAddress, partPinAddresses } from "../model/occupancy.js";
import { jackOf, jackWorld } from "../model/meter-probes.js";
import { MeterAverage } from "../sim/meter-average.js";
import {
  OffBench,
  capacitanceSteps,
  measureCapacitance,
} from "../sim/meter-offline.js";

const { DeskController } = await import("../components/desk-controller.js");
const { SimController } = await import("../components/sim-controller.js");
const { MeterView } = await import("../components/meter-view.js");
const { gripOf } = await import("../components/meter-probe-layer.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const meterOf = (id, params) => ({ id, kind: "meter", ref: "meter", x: 70, y: 0, params: partDef("meter").normalizeParams(params) }); // prettier-ignore

/** A DeskDoc stand-in over a plain document (meter-sim.test.js's). */
function fakeDoc(raw) {
  const doc = JSON.parse(JSON.stringify(raw));
  return {
    toJSON: () => doc,
    get scopeChannels() {
      return doc.scopeChannels ?? [];
    },
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      const c = doc.components.find((x) => x.id === id);
      c.params = partDef(c.ref).normalizeParams({ ...c.params, ...patch });
      return c;
    },
  };
}

/** The probes' reading of a meter at each of `ts` (Spice Lite, ticked). */
function readings(doc, ts, id = "dmm1") {
  const run = runner(doc, { engine: "spice" });
  return ts.map((t) => run.run(t).result.bench?.get(id));
}

/** An adapter's sine at `t`: 12 V RMS, 60 Hz. */
const sine12 = (t) => 12 * Math.SQRT2 * Math.sin(2 * Math.PI * 60 * t);

function adapterBench() {
  const b = bench({ volts: 5 });
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: 32, y: 30, params: partDef("adapter").normalizeParams({ rms: 12, hz: 60 }) }); // prettier-ignore
  return b;
}

test("a voltmeter straight on an adapter's S1/S2, nothing else wired, reads its sine", () => {
  const b = adapterBench();
  b.doc.components.push(meterOf("dmm1", { dial: "v", sel: { v: "ac" }, red: { at: "adp1.S1" }, black: { at: "adp1.S2" } })); // prettier-ignore
  for (const [t, r] of [0.002, 0.004].map((t, i, ts) => [
    t,
    readings(b.doc, ts)[i],
  ])) {
    // 10 MΩ behind the adapter's 1.2 Ω: the open-circuit sine to 1e-6.
    assert.ok(Math.abs(r.volts - sine12(t)) < 1e-3 * Math.abs(sine12(t)), `${r.volts} at ${t}`); // prettier-ignore
  }
});

test("…as on mains L/N, and on a transformer's secondary with only the probes on it", () => {
  const d = { version: 1, boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }], components: [], wires: [], signals: [] }; // prettier-ignore
  d.components.push({ id: "ac1", kind: "ac", ref: "ac", x: 0, y: 30, params: partDef("ac").normalizeParams({ rms: 120, hz: 60 }) }); // prettier-ignore
  d.components.push(meterOf("dmm1", { dial: "v", sel: { v: "ac" }, red: { at: "ac1.L" }, black: { at: "ac1.N" } })); // prettier-ignore
  const [r] = readings(d, [0.002]);
  const want = 120 * Math.SQRT2 * Math.sin(2 * Math.PI * 60 * 0.002);
  assert.ok(Math.abs(r.volts - want) < 1e-3 * want, `${r.volts} for ${want}`);
  // The secondary: probes alone against the same secondary wired to two
  // empty holes (which was always read).
  const xf = (wired) => {
    const x = structuredClone(d);
    x.components = x.components.filter((c) => c.kind !== "meter");
    x.components.push({ id: "xfmr1", kind: "transformer", ref: "transformer", x: 20, y: 30, params: partDef("transformer").normalizeParams({}) }); // prettier-ignore
    x.wires.push({ id: "w1", from: "ac1.L", to: "xfmr1.P1", color: "red" }, { id: "w2", from: "ac1.N", to: "xfmr1.P2", color: "black" }); // prettier-ignore
    if (wired) x.wires.push({ id: "w3", from: "xfmr1.S1", to: "bb1.a1", color: "y" }, { id: "w4", from: "xfmr1.S2", to: "bb1.a5", color: "k" }); // prettier-ignore
    x.components.push(meterOf("dmm1", { dial: "v", sel: { v: "ac" }, red: { at: wired ? "bb1.b1" : "xfmr1.S1" }, black: { at: wired ? "bb1.b5" : "xfmr1.S2" } })); // prettier-ignore
    return readings(x, [0.002, 0.004, 0.006]).map((m) => m.volts);
  };
  const [alone, holes] = [xf(false), xf(true)];
  assert.ok(Math.abs(holes[1]) > 10, `secondary ${holes}`);
  alone.forEach((v, i) => assert.ok(Math.abs(v - holes[i]) < 1e-6 * Math.abs(holes[i]) + 1e-9, `${alone} vs ${holes}`)); // prettier-ignore
});

test("an mA meter closing an adapter's loop at its terminal reads the loop's current", () => {
  const b = adapterBench();
  const r = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  b.doc.wires.push({ id: "wa1", from: "adp1.S1", to: b.at("c10"), color: "y" });
  b.doc.components.push(meterOf("dmm1", { dial: "ma", jack: "ma", red: { at: b.at(r.get(2).replace(/^a/, "c")) }, black: { at: "adp1.S2" } })); // prettier-ignore
  const [m] = readings(b.doc, [0.002]);
  // 1 kΩ, the mA shunt's 1.9 Ω and the adapter's 1.2 Ω.
  const want = sine12(0.002) / 1003.1;
  assert.ok(Math.abs(m.amps - want) < 1e-3 * want, `${m.amps} for ${want}`);
});

test("two ammeters in series in a supply's lead both read the current through them", () => {
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a20", { ohms: 330 });
  b.gnd(r.get(2));
  b.doc.components.push(meterOf("dmm1", { dial: "ma", jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("a10") } })); // prettier-ignore
  b.doc.components.push(meterOf("dmm2", { dial: "ma", jack: "ma", red: { at: b.at("b10") }, black: { at: b.at(r.get(1).replace(/^a/, "c")) } })); // prettier-ignore
  // (Feeding no chip, both shunts are in the solve: 330 Ω + 2 × 1.9 Ω.)
  const want = 5 / 333.8;
  for (const id of ["dmm1", "dmm2"]) {
    const [m] = readings(b.doc, [0.01], id);
    assert.ok(Math.abs(m.amps - want) < 1e-6, `${id} ${m.amps} for ${want}`);
  }
});

test("a series meter on a supply on its limit reads its own branch, never the supply's total", () => {
  // The Spice reviewer's B: 5 V / 1 A, two 4.7 Ω loads, the meter in series
  // with one — each carries half the limit.
  const b = bench({ volts: 5 });
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 4.7 });
  b.vcc(r1.get(1));
  b.gnd(r1.get(2));
  const r2 = b.seat("r2", "resistor", "a20", { ohms: 4.7 });
  b.gnd(r2.get(2));
  b.doc.components.push(meterOf("dmm1", { dial: "a", jack: "a", red: { at: "psu1.+" }, black: { at: b.at(r2.get(1).replace(/^a/, "c")) } })); // prettier-ignore
  const [m] = readings(b.doc, [0, 0.001, 0.01, 0.05, 0.2]).slice(-1);
  assert.ok(Math.abs(m.amps - 0.5) < 0.005, `${m.amps} A`);
  // A 100 mA supply held by 10 Ω, 1 kΩ through the meter: ~1 mA (V/1 kΩ).
  const c = bench({ volts: 5 });
  c.doc.components[0].params = partDef("psu").normalizeParams({ volts: 5, currentLimit: 0.1 }); // prettier-ignore
  const ra = c.seat("ra", "resistor", "a20", { ohms: 10 });
  c.vcc(ra.get(1));
  c.gnd(ra.get(2));
  const rb = c.seat("rb", "resistor", "a30", { ohms: 1000 });
  c.gnd(rb.get(2));
  c.doc.components.push(meterOf("dmm1", { dial: "ma", jack: "ma", red: { at: "psu1.+" }, black: { at: c.at(rb.get(1).replace(/^a/, "c")) } })); // prettier-ignore
  const run = runner(c.doc, { engine: "spice" });
  for (const t of [0, 0.01, 0.05]) run.run(t);
  const read = run.result.bench.get("dmm1");
  const volts = run.result.supplies.get("psu1").volts;
  const want = volts / 1001.9; // 1 kΩ and the mA shunt
  assert.ok(Math.abs(read.amps - want) < 1e-3 * want, `${read.amps} A at ${volts} V`); // prettier-ignore
});

/** A desk with a full kit and a meter, the pointer's world point live. */
function desk() {
  resetDom();
  const doc = new DeskDoc(null);
  const world = { x: 0, y: 0 };
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = { surface, camera: { cx: 0, cy: 0, zoom: 1 }, worldFromEvent: () => ({ x: world.x, y: world.y }) }; // prettier-ignore
  const controller = new DeskController({ viewport, deskView, deskDoc: doc });
  controller.addKitAt("full", 0, 0);
  return { doc, surface, controller, world };
}
const fire = (el, type, client = [0, 0]) => el.dispatchEvent(new window.PointerEvent(type, { bubbles: true, button: 0, pointerId: 3, clientX: client[0], clientY: client[1] })); // prettier-ignore

/** A probe pressed and carried over bb2.a20, not yet let go. */
function dragProbe({ doc, surface, world }, meterId) {
  const probe = surface.querySelector(".meter-probe--red .meter-probe-body");
  fire(probe, "pointerdown");
  const meter = doc.getComponent(meterId);
  const at = gripOf(worldOfAddress(doc.boards, "bb2.a20"), jackWorld(meter, jackOf(meter.params, "red"))); // prettier-ignore
  world.x = at.x;
  world.y = at.y;
  fire(probe, "pointermove", [40, 40]);
  return probe;
}

test("Escape mid probe-drag reverts it; a desktop swapped in mid-drag takes no probe", () => {
  const d = desk();
  const { id } = d.controller.addBrickAt("meter", 80, 0, {});
  const before = JSON.stringify(d.doc.getComponent(id).params.red);
  const probe = dragProbe(d, id);
  assert.equal(d.controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "Escape" })), true); // prettier-ignore
  fire(probe, "pointerup", [40, 40]);
  assert.equal(JSON.stringify(d.doc.getComponent(id).params.red), before);
  const e = desk();
  const meter = e.controller.addBrickAt("meter", 80, 0, {});
  const other = JSON.parse(JSON.stringify(e.doc.toJSON()));
  dragProbe(e, meter.id);
  e.controller.loadDocument(other);
  window.dispatchEvent(new window.PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 3, clientX: 40, clientY: 40 })); // prettier-ignore
  assert.notEqual(e.doc.getComponent(meter.id).params.red.at, "bb2.a20");
});

test("a meter put away while its continuity beep sounds takes the beep with it", async () => {
  const log = [];
  globalThis.AudioContext = class {
    currentTime = 0;
    destination = {};
    createOscillator = () => ({ type: "", frequency: { value: 0 }, connect: (g) => g, start() {} }); // prettier-ignore
    createGain = () => ({ gain: { value: 0, setTargetAtTime: (v) => log.push(v) }, connect: (x) => x }); // prettier-ignore
    resume() {}
    suspend() {
      log.push("suspend");
    }
  };
  try {
    const { doc, controller } = desk();
    controller.setSpiceLite({ enabled: true });
    const meter = controller.addBrickAt("meter", 80, 0, { sound: "on", dial: "ohm", sel: { ohm: "cont" } }); // prettier-ignore
    doc.setMeterProbe(meter.id, "red", { at: "bb2.a20" });
    doc.setMeterProbe(meter.id, "black", { at: "bb2.b20" });
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    await sleep(400);
    assert.ok(log.includes(0.05), "the short beeps");
    controller.putMeterAway(meter.id);
    await sleep(100);
    assert.ok(
      log.at(-1) === 0 || log.at(-1) === "suspend",
      JSON.stringify(log),
    );
  } finally {
    delete globalThis.AudioContext;
  }
});

/** A run of `raw` for `ms`: whether F1 blew, and the toasts. */
async function runFuse(raw, ms) {
  resetDom();
  const notes = [];
  const deskDoc = fakeDoc(raw);
  const sim = new SimController({ deskDoc, notifications: { notify: (o) => notes.push(o), dismiss() {} } }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  let blown = false;
  const onState = () => {
    blown ||= deskDoc.getComponent("dmm1")?.params?.fuseF1 === true;
  };
  window.addEventListener("chiphippo:sim-state", onState);
  sim.start();
  await sleep(ms);
  sim.stop();
  window.removeEventListener("chiphippo:sim-state", onState);
  return { blown, notes };
}

/** 12 V~ through `ohms` and an mA meter (F1, 0.4 A) on its AC range. */
function acThroughF1(ohms) {
  const b = adapterBench();
  const r = b.seat("r1", "resistor", "a10", { ohms });
  b.doc.wires.push({ id: "wa1", from: "adp1.S1", to: b.at("c10"), color: "y" }, { id: "wa2", from: "adp1.S2", to: b.at("c40"), color: "k" }); // prettier-ignore
  b.doc.components.push(meterOf("dmm1", { dial: "ma", jack: "ma", sel: { ma: "ac" }, red: { at: b.at(r.get(2).replace(/^a/, "c")) }, black: { at: b.at("d40") } })); // prettier-ignore
  return b.doc;
}

test("an AC current past F1's rating blows it by its heat; one under it never does", async () => {
  // 0.92 A RMS (its zero crossings reset the old timer every half cycle).
  const hot = await runFuse(acThroughF1(10), 700);
  assert.ok(hot.blown, "0.92 A RMS through a 0.4 A fuse");
  assert.ok(
    hot.notes.some((n) => /F1/.test(n.message ?? "")),
    "the toast",
  );
  // 0.399 A RMS: its peaks pass 0.4 A, its heat never does.
  const cool = await runFuse(acThroughF1(27), 700);
  assert.equal(cool.blown, false, "0.399 A RMS");
});

test("DC of a periodic signal is the mean over whole periods", () => {
  // A 60 Hz sine over a window that is not a whole number of its periods.
  const m = new MeterAverage();
  m.bands("dmm1", [0.1]);
  const dt = 1e-4;
  let t = 0;
  const takes = [];
  for (const until of [0.2083, 0.4171, 0.6249, 0.8337]) {
    for (; t <= until; t += dt) m.record("dmm1", t, sine12(t));
    takes.push(m.take(until).get("dmm1"));
  }
  for (const w of takes.slice(1)) assert.ok(Math.abs(w.mean) < 1e-3, `mean ${w.mean}`); // prettier-ignore
  // A 100 Hz 25 % PWM, 0/5 V, its edges stepped.
  const p = new MeterAverage();
  p.bands("dmm1", [0.1]);
  let level = 0;
  const pwm = [];
  for (let k = 0; k < 120; k++) {
    const rise = k * 0.01;
    p.record("dmm1", rise, level);
    p.record("dmm1", rise, (level = 5));
    p.record("dmm1", rise + 0.0025, level);
    p.record("dmm1", rise + 0.0025, (level = 0));
    if (k % 21 === 20) pwm.push(p.take(rise + 0.0071).get("dmm1"));
  }
  for (const w of pwm.slice(1)) assert.ok(Math.abs(w.mean - 1.25) < 5e-4, `mean ${w.mean}`); // prettier-ignore
});

test("the run's blown fuse shows its red (i) on the meter", async () => {
  const { doc, surface, controller } = desk();
  controller.setSpiceLite({ enabled: true });
  const psu = controller.addBrickAt("psu", -20, 30, { volts: 5 });
  const meter = controller.addBrickAt("meter", 80, 0, { dial: "ma", jack: "ma" }); // prettier-ignore
  doc.setMeterProbe(meter.id, "red", { at: `${psu.id}.+` });
  doc.setMeterProbe(meter.id, "black", { at: `${psu.id}.-` });
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  const sim = new SimController({ deskDoc: doc, notifications: { notify() {}, dismiss() {} } }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  sim.start();
  await sleep(500);
  const el = surface.querySelector(`[data-component-id="${meter.id}"]`);
  assert.equal(doc.getComponent(meter.id).params.fuseF1, true);
  assert.ok(el.classList.contains("part-meter--marked"), "the red (i)");
  sim.stop();
  assert.equal(el.classList.contains("part-meter--marked"), false, "mended at Stop"); // prettier-ignore
});

test("a stopped bench's key: unmoved by a supply, a meter or a part it does not reach", () => {
  const b = bench({ volts: 5 });
  const c = b.seat("c1", "cap-ceramic", "a20", { farads: 100e-9 });
  b.doc.components.push(meterOf("dmm1", { dial: "diode", sel: { diode: "cap" }, red: { at: b.at(c.get(1).replace(/^a/, "c")) }, black: { at: b.at(c.get(2).replace(/^a/, "c")) } })); // prettier-ignore
  const key = (doc) => new OffBench(doc).benchKey(doc.components.find((x) => x.id === "dmm1")); // prettier-ignore
  const base = key(b.doc);
  const more = structuredClone(b.doc);
  more.components.push({ id: "psu9", kind: "psu", ref: "psu", x: -90, y: 90, params: { volts: 12 } }); // prettier-ignore
  more.components.push(meterOf("dmm2", { dial: "v" }));
  assert.equal(new OffBench(more).key, new OffBench(b.doc).key, "a supply and a meter are no part of the bench"); // prettier-ignore
  const far = bench({ volts: 5 });
  far.doc = more;
  far.seat("r9", "resistor", "a50", { ohms: 1000 });
  assert.equal(key(more), base, "a resistor it does not reach");
  const near = structuredClone(b.doc);
  near.components.find((x) => x.id === "c1").params.farads = 220e-9;
  assert.notEqual(key(near), base, "its own capacitor's value");
});

test("the capacitance test runs in steps, to the same measurement", () => {
  const b = bench({ volts: 5 });
  const c = b.seat("c1", "cap-ceramic", "a20", { farads: 100e-9 });
  const at = (p) => b.at(c.get(p).replace(/^a/, "c"));
  b.doc.components.push(meterOf("dmm1", { dial: "diode", sel: { diode: "cap" }, red: { at: at(1) }, black: { at: at(2) } })); // prettier-ignore
  const whole = measureCapacitance(b.doc, "dmm1");
  const steps = capacitanceSteps(b.doc, "dmm1", { enabled: true }, { bench: new OffBench(b.doc) }); // prettier-ignore
  let n = 0;
  let r = steps.next();
  for (; !r.done; r = steps.next()) n++;
  assert.ok(n >= 2, `${n} steps`);
  assert.deepEqual(r.value, whole);
  assert.ok(Math.abs(whole.farads - 100e-9) < 2e-12, `${whole.farads}`);
});

test("a finished capacitance stands when an unrelated supply is put down", async () => {
  const { doc, surface, controller } = desk();
  controller.setSpiceLite({ enabled: true });
  const cap = controller.addComponentAt("cap-ceramic", "bb2", "a20", { farads: 100e-9 }); // prettier-ignore
  const pins = partPinAddresses(doc, doc.getComponent(cap.id));
  const meter = controller.addBrickAt("meter", 80, 0, { dial: "diode", sel: { diode: "cap" } }); // prettier-ignore
  doc.setMeterProbe(meter.id, "red", { at: pins[0].address });
  doc.setMeterProbe(meter.id, "black", { at: pins[1].address });
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  const digits = () => surface.querySelector(`[data-component-id="${meter.id}"] .part-meter-digits`).textContent; // prettier-ignore
  await sleep(900);
  const done = digits();
  assert.notEqual(done, "----");
  controller.addBrickAt("psu", -60, 60, {});
  await sleep(200);
  assert.equal(digits(), done);
});

/** A meter's view alone, under Spice Lite. */
function viewOf(params, callbacks = {}) {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const meter = meterOf("dmm1", { red: { at: "bb1.a1" }, black: { at: "bb1.a2" }, ...params }); // prettier-ignore
  const view = new MeterView(layer, meter, callbacks, { spiceLite: true });
  return { view, layer, meter };
}

test("'----' is dashes, not a negative reading", () => {
  const { view, layer } = viewOf({ dial: "autov" });
  view.setLive("running", { mean: 0.5, rms: 0, min: 0.5, max: 0.5, hz: [] });
  assert.equal(layer.querySelector(".part-meter-digits").textContent, "----");
  assert.equal(view.element.classList.contains("part-meter--negative"), false);
});

test("HOLD never hides InEr; REC books each reading once, however often drawn", () => {
  const beeps = [];
  const { view, layer, meter } = viewOf({ dial: "v" }, { onBeep: (id, on) => beeps.push(on) }); // prettier-ignore
  view.setLive("running", { mean: 5, rms: 0, min: 5, max: 5, hz: [] });
  view.pressHold(false);
  view.updateParams(partDef("meter").normalizeParams({ ...meter.params, jack: "a" })); // prettier-ignore
  assert.equal(layer.querySelector(".part-meter-digits").textContent, "InEr");
  assert.equal(beeps.at(-1), true);
  const rec = viewOf({ dial: "ohm" }).view;
  rec.setOffline({ volts: (1.6 * 1000) / 9000 }); // 1 kΩ
  rec.pressRec(false);
  for (let k = 0; k < 4; k++) rec.pressRec(false);
  rec.setOffline({ volts: (1.6 * 2000) / 10000 }); // 2 kΩ
  for (let k = 0; k < 3; k++) rec.pressRec(false);
  assert.equal(rec.element.querySelector(".part-meter-digits").textContent, "1.500"); // prettier-ignore
});

test("a run handed over keeps each meter's window (exportRun / importRun)", async () => {
  resetDom();
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  b.vcc(r.get(1));
  b.gnd(r.get(2));
  b.doc.components.push(meterOf("dmm1", { dial: "v", red: { at: b.at(r.get(1).replace(/^a/, "c")) }, black: { at: "psu1.-" } })); // prettier-ignore
  const quiet = { notify() {}, dismiss() {} };
  const a = new SimController({
    deskDoc: fakeDoc(b.doc),
    notifications: quiet,
  });
  a.setSpiceLite({ enabled: true });
  a.start();
  await sleep(60);
  const run = a.exportRun();
  a.stop();
  const from = new Map(run.meters.windows.windows).get("dmm1")?.from;
  assert.ok(from != null, "a window open at the hand-over");
  const c = new SimController({
    deskDoc: fakeDoc(b.doc),
    notifications: quiet,
  });
  c.setSpiceLite({ enabled: true });
  const shown = [];
  const onState = (e) => {
    const w = e.detail.meters?.get("dmm1");
    if (w) shown.push(w);
  };
  window.addEventListener("chiphippo:sim-state", onState);
  c.importRun(run);
  window.removeEventListener("chiphippo:sim-state", onState);
  c.stop();
  // Its first window here covers the stretch booked before the hand-over:
  // forgotten, it was a window of no time at all.
  assert.ok(shown[0]?.span >= run.meters.at - from - 1e-9, `span ${shown[0]?.span} of ${run.meters.at - from}`); // prettier-ignore
  assert.ok(shown[0].span > 0);
});
