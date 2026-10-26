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

// The multimeter in a RUN (components/sim-controller.js): its window of
// readings on sim-state — a PWM's mean, an AC adapter's RMS, a clock's and
// a 555's Hz (a fast one at its TRUE rate, drawn slowed) — and its fuse,
// blown by a supply it was put across and mended at Stop. Real timers, kept
// short.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { astable555, bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";

const { SimController } = await import("../components/sim-controller.js");

/** A DeskDoc stand-in over a plain document, normalizing a params write as
    the real one does. */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A meter brick on the bench. */
const meterOf = (params) => ({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 0, params: partDef("meter").normalizeParams(params) }); // prettier-ignore

/** Run `doc` for `ms` (Spice Lite unless `spice` is false): every meter
    window sim-state carried, the toasts, the last timed parts' readings and
    the document after Stop. */
async function runFor(raw, ms, { spice = true } = {}) {
  resetDom();
  const notes = [];
  const deskDoc = fakeDoc(raw);
  const sim = new SimController({
    deskDoc,
    notifications: { notify: (o) => notes.push(o), dismiss() {} },
  });
  sim.setSpiceLite({ enabled: spice });
  const windows = [];
  let latched = false;
  let timing = null;
  const onState = (e) => {
    const m = e.detail.meters?.get("dmm1");
    if (m) windows.push(m);
    if (e.detail.timing?.size) timing = e.detail.timing;
    if (deskDoc.getComponent("dmm1")?.params?.fuseF1) latched = true;
  };
  window.addEventListener("chiphippo:sim-state", onState);
  sim.start();
  await sleep(ms);
  sim.stop();
  window.removeEventListener("chiphippo:sim-state", onState);
  return { windows, notes, latched, timing, after: deskDoc.getComponent("dmm1") }; // prettier-ignore
}

test("a run's window: a 25 % PWM reads a quarter of its swing", async () => {
  const b = bench({ volts: 5 });
  const r = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  b.gnd(r.get(2));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 100, wave: "pwm", duty: 25 }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "clk1.out", to: b.at("c10"), color: "red" },
    { id: "wc2", from: "clk1.gnd", to: "psu1.-", color: "black" },
    { id: "wc3", from: "clk1.vcc", to: "psu1.+", color: "red" },
  );
  b.doc.components.push(meterOf({ dial: "v", red: { at: b.at("b10") }, black: { at: "psu1.-" } })); // prettier-ignore
  const { windows } = await runFor(b.doc, 1100);
  const settled = windows.filter((w) => w.span > 0.1);
  assert.ok(settled.length >= 2, `${settled.length} windows`);
  // A window is a whole number of periods give or take one HIGH: ±0.06 V.
  for (const w of settled) {
    assert.ok(Math.abs(w.mean - 1.25) < 0.08, `mean ${w.mean}`);
    assert.ok(Math.abs(w.rms - Math.sqrt(0.25 * 25 - 1.25 ** 2)) < 0.15, `rms ${w.rms}`); // prettier-ignore
  }
});

test("a run's window: Hz is a clock's rate, and a fast 555's TRUE rate where it is drawn slowed", async () => {
  const b = bench({ volts: 5 });
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 100 }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "clk1.out", to: b.at("c10"), color: "red" },
    { id: "wc2", from: "clk1.gnd", to: "psu1.-", color: "black" },
    { id: "wc3", from: "clk1.vcc", to: "psu1.+", color: "red" },
  );
  b.doc.components.push(meterOf({ dial: "v", red: { at: b.at("b10") }, black: { at: "psu1.-" } })); // prettier-ignore
  const clock = (await runFor(b.doc, 1600)).windows.at(-1);
  assert.ok(Math.abs(clock.hz[0] - 100) < 1e-6, `${clock.hz[0]} Hz`);
  // 1 kΩ, 10 kΩ, 10 nF: 6.7 kHz, drawn at the 1 kHz cap.
  const fast = astable555({ ra: 1000, rb: 10000, c: 10e-9, capRef: "cap-ceramic" }); // prettier-ignore
  const out = fast.b.at(fast.u.get(3).replace(/^e/, "a"));
  fast.doc.components.push(meterOf({ dial: "v", red: { at: out }, black: { at: "psu1.-" } })); // prettier-ignore
  const run = await runFor(fast.doc, 1200);
  const w = run.windows.at(-1);
  const truth = run.timing.get("u1").sections[0].frequency;
  assert.ok(truth > 6000, `${truth} Hz`);
  assert.ok(
    Math.abs(w.hz[0] / truth - 1) < 1e-6,
    `${w.hz[0]} Hz against ${truth}`,
  );
  // Its mean is the real wave's — about half the bipolar 555's HIGH.
  assert.ok(w.mean > 1.5 && w.mean < 2.2, `${w.mean} V`);
});

test("a run's window: an AC adapter's RMS across a load", async () => {
  const b = bench({ volts: 5 });
  b.seat("r1", "resistor", "a10", { ohms: 1000 });
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: 32, y: 30, params: partDef("adapter").normalizeParams({ rms: 12, hz: 60 }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wa1", from: "adp1.S1", to: b.at("c10"), color: "yellow" },
    { id: "wa2", from: "adp1.S2", to: b.at("c13"), color: "black" },
  );
  b.doc.components.push(meterOf({ dial: "v", sel: { v: "ac" }, red: { at: b.at("b10") }, black: { at: b.at("b13") } })); // prettier-ignore
  const { windows } = await runFor(b.doc, 1100);
  const settled = windows.filter((w) => w.span > 0.1);
  assert.ok(settled.length >= 2);
  // 12 V behind its 1.2 Ω into 1 kΩ.
  for (const w of settled) assert.ok(Math.abs(w.rms - 11.986) < 0.15, `rms ${w.rms}`); // prettier-ignore
});

test("on mA straight across a supply, the 0.4 A fuse blows — and is whole again at Stop", async () => {
  // A 1 A supply: limited, it still puts 1 A through the meter.
  const b = bench({ volts: 5 });
  b.doc.components.push(meterOf({ dial: "ma", jack: "ma", red: { at: "psu1.+" }, black: { at: "psu1.-" } })); // prettier-ignore
  const { notes, latched, after } = await runFor(b.doc, 500);
  assert.ok(latched, "F1 latched while running");
  assert.ok(
    notes.some((n) => /F1/.test(n.message ?? "")),
    "and said so",
  );
  assert.equal(after.params.fuseF1, undefined, "mended at Stop");
  // On the 10A jack the supply's limit saves F2.
  const a = bench({ volts: 5 });
  a.doc.components.push(meterOf({ dial: "ma", jack: "a", red: { at: "psu1.+" }, black: { at: "psu1.-" } })); // prettier-ignore
  const ten = await runFor(a.doc, 400);
  assert.equal(ten.latched, false);
  const amps = ten.windows.at(-1).mean / 0.04;
  assert.ok(Math.abs(amps - 1) < 0.05, `${amps} A, the supply's limit`);
});

test("running, probes on one net read 0 V — not the open input's nothing", async () => {
  const b = bench({ volts: 5 });
  b.vcc("a10");
  b.doc.components.push(meterOf({ dial: "v", red: { at: b.at("c10") }, black: { at: b.at("d10") } })); // prettier-ignore
  const { windows } = await runFor(b.doc, 500);
  assert.ok(windows.length >= 1, `${windows.length} windows`);
  for (const w of windows) assert.equal(w.mean, 0);
});

test("the logic engine reads no meter", async () => {
  const b = bench({ volts: 5 });
  b.doc.components.push(meterOf({ dial: "v", red: { at: "psu1.+" }, black: { at: "psu1.-" } })); // prettier-ignore
  const { windows } = await runFor(b.doc, 250, { spice: false });
  assert.equal(windows.length, 0);
});

test("in series with a supply's lead it reads what the supply delivers beyond it", async () => {
  // 5 V → meter (mA) → a rail feeding a 74LS04 and a 330 Ω + LED.
  const b = bench({ volts: 5 });
  const u = b.seat("u1", "74LS04", "e10");
  const r = b.seat("r1", "resistor", "a20", { ohms: 330 });
  const led = b.seat("l1", "led", "a30", { color: "red" });
  const vcc = b.at(u.get(14).replace(/^f/, "j"));
  b.gnd(u.get(7));
  b.gnd(u.get(1));
  b.link(u.get(2), r.get(1));
  b.link(r.get(2), led.get(1));
  b.gnd(led.get(2));
  const direct = structuredClone(b.doc);
  direct.wires.push({ id: "wv", from: "psu1.+", to: vcc, color: "red" });
  b.doc.components.push(meterOf({ dial: "ma", jack: "ma", red: { at: "psu1.+" }, black: { at: vcc } })); // prettier-ignore
  const { windows } = await runFor(b.doc, 300);
  const amps = windows.at(-1).mean / 1.9;
  // What the supply delivers with the meter out of the circuit.
  resetDom();
  const sim = new SimController({ deskDoc: fakeDoc(direct), notifications: { notify() {}, dismiss() {} } }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  let supply = null;
  const onState = (e) => (supply = e.detail.supplies?.get("psu1") ?? supply);
  window.addEventListener("chiphippo:sim-state", onState);
  sim.start();
  await sleep(200);
  sim.stop();
  window.removeEventListener("chiphippo:sim-state", onState);
  assert.ok(amps > 0.004, `${amps} A`);
  assert.ok(Math.abs(amps - supply.amps) < 1e-4, `${amps} A against the supply's ${supply.amps} A`); // prettier-ignore
});
