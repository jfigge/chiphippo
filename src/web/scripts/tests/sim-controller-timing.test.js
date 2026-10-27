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

// SimController's simulated clock — the time a 555 or a CD4000 timer is told
// it is (sim/timing.js): it flows while running, stops while paused, is
// stepped by Step, and the controller ticks again exactly when the engine says
// a timed part next moves (`wakeAt`). Real timers, kept short.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { buildNetlist } from "../sim/netlist.js";
import { astable555, bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";

const { SimController, SETTLE_S, UNDER_HOLD_S } =
  await import("../components/sim-controller.js");

/** A DeskDoc stand-in over a plain document (SimController reads only these). */
function fakeDoc(raw) {
  const doc = JSON.parse(JSON.stringify(raw));
  return {
    toJSON: () => doc,
    // The analyzer's channels: frames are drawn only while it records.
    get scopeChannels() {
      return doc.scopeChannels ?? [];
    },
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      const c = doc.components.find((x) => x.id === id);
      c.params = { ...c.params, ...patch };
      return c;
    },
  };
}

function fakeNotifications() {
  const calls = [];
  return { calls, notify: (o) => calls.push(o), dismiss() {} };
}

/** Every sim-state published from here on. */
function capture() {
  const events = [];
  const ticks = []; // every TICK (sim-tick) — a batch publishes only its last
  const handler = (e) => events.push(e.detail);
  const onTick = (e) => ticks.push(...e.detail.ticks);
  window.addEventListener("chiphippo:sim-state", handler);
  window.addEventListener("chiphippo:sim-ticks", onTick);
  return {
    events,
    ticks,
    stop() {
      window.removeEventListener("chiphippo:sim-state", handler);
      window.removeEventListener("chiphippo:sim-ticks", onTick);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** OUT's level in each published state (or tick), for a 555 at e10 (OUT =
    e12). */
function outLevels(doc, events) {
  const netlist = buildNetlist(doc);
  const net = netlist.netOfPoint.get("bb1.e12");
  return events.filter((e) => e.running).map((e) => e.netLevels.get(net));
}

/** How many times a level sequence changes. */
const edges = (levels) =>
  levels.reduce((n, lv, i) => (i && lv !== levels[i - 1] ? n + 1 : n), 0);

test("Run's first tick is AT 0, whatever building it took", async () => {
  // Read off the wall clock it landed a few ms in, and an AC supply came on
  // part-way up its sine — a step that burnt a bridge charging its
  // reservoir capacitor (2026-10-21).
  resetDom();
  const { doc } = astable555({ ra: 1e3, rb: 1e3, c: 10e-6 });
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });
  sim.setSpiceLite({ enabled: true });
  const cap = capture();
  sim.start();
  await sleep(20);
  sim.stop();
  cap.stop();
  assert.ok(cap.ticks.length > 1);
  assert.equal(cap.ticks[0].at, 0);
  assert.ok(cap.ticks[1].at > 0, "and time runs on from there");
});

/** An LM7805 off a `volts` supply (its limit 5 A, past the regulator's
    own), 100 Ω on its OUT — and `farads` across it, when given. */
function regulatorDesk(volts, farads = 0) {
  const b = bench({ volts });
  b.doc.components[0].params.currentLimit = 5;
  const u = b.seat("u1", "LM7805", "a20");
  b.vcc(u.get(1));
  b.gnd(u.get(2));
  const r = b.seat("rl", "resistor", "a40", { ohms: 100 });
  b.link(r.get(1), u.get(3));
  b.gnd(r.get(2));
  if (farads) {
    const c = b.seat("c1", "cap-electrolytic", "a50", { farads });
    b.link(c.get(1), u.get(3));
    b.gnd(c.get(2));
  }
  return b.doc;
}

/** Run `doc` on Spice Lite at ×4 until the sim clock passes `until`; the
    toasts said, each with the sim time it was said at. */
async function runToasts(doc, until) {
  resetDom();
  const said = [];
  let at = 0;
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: { notify: (o) => said.push({ key: o.key, at }), dismiss() {} }, // prettier-ignore
  });
  sim.setSpiceLite({ enabled: true });
  sim.setSpeed(4);
  const onTick = (e) => (at = e.detail.ticks.at(-1)?.at ?? at);
  window.addEventListener("chiphippo:sim-ticks", onTick);
  sim.start();
  for (let k = 0; k < 200 && at < until; k++) await sleep(20);
  sim.stop();
  window.removeEventListener("chiphippo:sim-ticks", onTick);
  return said;
}

test("a regulator still charging its output after Run says nothing of it", async () => {
  // 10 mF on a 7805's OUT: charged at its 1.5 A limit — hot for the moment
  // — for some 35 ms, then holding 5 V.
  const said = await runToasts(regulatorDesk(9, 10e-3), SETTLE_S + 0.2);
  assert.deepEqual(
    said.filter((x) => x.key.startsWith("regulator-")),
    [],
  );
});

test("…but one that STAYS in dropout is said, once the circuit has had its time to rise", async () => {
  const said = await runToasts(regulatorDesk(6), SETTLE_S + 0.2);
  const dropout = said.find((x) => x.key === "regulator-dropout:u1");
  assert.ok(dropout, JSON.stringify(said));
  assert.ok(dropout.at >= SETTLE_S - 0.05, `said at ${dropout.at} s`);
});

test("…and a run handed over before it was said still says it (exportRun / importRun)", async () => {
  // The Worker hands a run to the main thread when a custom chip is armed:
  // the held-back warning went with nothing to wake it at SETTLE_S, on a
  // desk nothing else ticks, so it was never said.
  resetDom();
  const doc = regulatorDesk(6);
  const first = fakeNotifications();
  const a = new SimController({ deskDoc: fakeDoc(doc), notifications: first });
  a.setSpiceLite({ enabled: true });
  a.start();
  await sleep(30);
  const run = a.exportRun();
  assert.ok(run.simNow < SETTLE_S, `handed over at ${run.simNow} s`);
  assert.equal(run.settleCheck, true, "a warning held back");
  a.stop();
  const said = fakeNotifications();
  const b = new SimController({ deskDoc: fakeDoc(doc), notifications: said });
  b.setSpiceLite({ enabled: true });
  b.importRun(run);
  for (let k = 0; k < 100 && !said.calls.some((c) => c.key === "regulator-dropout:u1"); k++) await sleep(20); // prettier-ignore
  b.stop();
  assert.ok(said.calls.some((c) => c.key === "regulator-dropout:u1"), JSON.stringify(said.calls.map((c) => c.key))); // prettier-ignore
});

test("…and said ONCE while it stands, however often the desk ticks", async () => {
  // A 100 Hz clock brick beside it ticks the desk 200 times a second: the
  // dropout toast was raised again at every one (205 in 1.5 s), so one
  // clicked away came straight back.
  const doc = regulatorDesk(6);
  doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 40, y: 30, params: { hz: 100 } }); // prettier-ignore
  doc.wires.push({ id: "wc2", from: "clk1.gnd", to: "psu1.-", color: "black" });
  const said = await runToasts(doc, SETTLE_S + 0.5);
  const dropouts = said.filter((x) => x.key === "regulator-dropout:u1");
  assert.equal(dropouts.length, 1, JSON.stringify(said.slice(0, 5)));
});

/** A 12 V~ adapter through a DB105 into 470 µF, a 7805 off that, and an
    LM358 on its OUT: the op-amp's rail passes 2.25 V on its way to 5 V,
    1.5 ms after Run. */
function rectifiedOpAmpDesk() {
  const b = bench();
  const br = b.seat("br1", "bridge-rectifier", "e5");
  const cr = b.seat("cr", "cap-electrolytic", "a12", { farads: 470e-6 });
  const u = b.seat("u1", "LM7805", "a20");
  const o = b.seat("o1", "LM358", "e30");
  b.link(br.get(1), cr.get(1));
  b.link(br.get(1), u.get(1));
  b.gnd(br.get(2));
  b.gnd(cr.get(2));
  b.gnd(u.get(2));
  b.link(o.get(8), u.get(3));
  b.gnd(o.get(4));
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: { hz: 60, rms: 12 } }); // prettier-ignore
  b.doc.wires.push(
    { id: "wa", from: "adp1.S1", to: b.at(br.get(4).replace(/^f/, "j")), color: "blue" }, // prettier-ignore
    { id: "wb", from: "adp1.S2", to: b.at(br.get(3).replace(/^f/, "j")), color: "blue" }, // prettier-ignore
  );
  return b.doc;
}

test("a chip whose rail is still rising after Run is not said underpowered (Spice Lite)", async () => {
  const said = await runToasts(rectifiedOpAmpDesk(), SETTLE_S + 0.2);
  assert.deepEqual(
    said.filter((x) => x.key === "under:o1"),
    [],
  );
});

/** A 74LS04 on a 3 V supply — under its 4.75 V for good. */
function lowRailDesk() {
  const b = bench({ volts: 3 });
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  return b.doc;
}

test("…but one that STAYS under is said, once the circuit has had its time to rise", async () => {
  const said = await runToasts(lowRailDesk(), SETTLE_S + 0.2);
  const under = said.filter((x) => x.key === "under:u1");
  assert.equal(under.length, 1, JSON.stringify(said));
  assert.ok(under[0].at >= SETTLE_S - 0.05, `said at ${under[0].at} s`);
});

test("…and the logic engine, whose rails do not rise, says it once it has stood UNDER_HOLD_S", () => {
  // Under from the first tick, on a desk nothing else ticks: woken at the
  // hold's end to say it (#nextEvent), not left silent for good.
  resetDom();
  const clock = steppedClock();
  const said = fakeNotifications();
  const sim = new SimController({ deskDoc: fakeDoc(lowRailDesk()), notifications: said, clock }); // prettier-ignore
  sim.start();
  clock.advance(UNDER_HOLD_S * 1000 - 100);
  assert.equal(
    said.calls.filter((c) => c.key === "under:u1").length,
    0,
    "held",
  );
  clock.advance(300);
  sim.stop();
  const under = said.calls.filter((c) => c.key === "under:u1");
  assert.equal(under.length, 1, JSON.stringify(said.calls.map((c) => c.key)));
  assert.match(under[0].message, /inert/);
});

/** A 74LS04 whose VCC a push button (s1) puts on a 3 V supply: under its
    range — and its floor — while pressed, unpowered (said nothing) while
    not. */
function pressedLowRailDesk() {
  const b = bench({ volts: 3 });
  const u = b.seat("u1", "74LS04", "e10");
  const s = b.seat("s1", "sw-push", "a40");
  b.vcc(s.get(1));
  b.link(s.get(2), u.get(14));
  b.gnd(u.get(7));
  return b.doc;
}

const press = (pressed) =>
  window.dispatchEvent(new window.CustomEvent("chiphippo:part-state", { detail: { id: "s1", ref: "sw-push", state: { pressed } } })); // prettier-ignore

for (const spice of [false, true]) {
  const engine = spice ? "Spice Lite" : "the logic engine";
  test(`an underpowered stretch shorter than UNDER_HOLD_S says nothing; a longer one is said once (${engine})`, () => {
    resetDom();
    const clock = steppedClock();
    const said = [];
    const sim = new SimController({ deskDoc: fakeDoc(pressedLowRailDesk()), notifications: { notify: (o) => said.push(o), dismiss() {} }, clock }); // prettier-ignore
    if (spice) sim.setSpiceLite({ enabled: true });
    sim.start();
    const under = () => said.filter((o) => o.key === "under:u1").length;
    clock.advance(1000); // past Run's settling window
    press(true);
    clock.advance(300); // a 0.3 s sag
    press(false);
    clock.advance(1000);
    assert.equal(under(), 0, "0.3 s: silent");
    press(true);
    clock.advance(600); // a 0.6 s one
    assert.equal(under(), 1, "0.6 s: said");
    clock.advance(2000); // standing on: said once
    assert.equal(under(), 1, "once");
    sim.stop();
  });
}

test("an underpowered chip that recovers is said again only once it has been gone REARM_S", () => {
  resetDom();
  const clock = steppedClock();
  const said = [];
  const sim = new SimController({ deskDoc: fakeDoc(pressedLowRailDesk()), notifications: { notify: (o) => said.push(o), dismiss() {} }, clock }); // prettier-ignore
  sim.start();
  const under = () => said.filter((o) => o.key === "under:u1").length;
  press(true);
  clock.advance(700);
  assert.equal(under(), 1, "said once it stood the hold");
  press(false);
  clock.advance(500);
  press(true); // back 0.5 s after it recovered: the same fault
  clock.advance(700);
  assert.equal(under(), 1, "back within REARM_S: not said again");
  press(false);
  clock.advance(1500);
  press(true); // back 1.5 s after: news — said again, after its own hold
  clock.advance(400);
  assert.equal(under(), 1, "and held for its hold again");
  clock.advance(300);
  assert.equal(under(), 2, "said again");
  sim.stop();
});

test("a chip in its margin is said underpowered — and that it works", () => {
  // A 74LS04 fed through 47 Ω, 1Y HIGH into an LED: 4.57 V on its pins,
  // under its 4.75 V but over its 4.5 V floor (families.js `supplyFloor`).
  resetDom();
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
  const clock = steppedClock();
  const said = [];
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: { notify: (o) => said.push(o), dismiss() {} }, clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  sim.start();
  clock.advance(1000);
  sim.stop();
  const under = said.filter((o) => o.key === "under:u1");
  assert.equal(under.length, 1, JSON.stringify(said.map((o) => o.key)));
  assert.match(under[0].message, /still working/);
});

test("a running 555 ticks itself at its own edges — no clock brick needed", async () => {
  resetDom();
  // 48 kHz, shown at the cap (1 kHz): an edge every 0.3–0.7 ms of wall time.
  const { doc } = astable555({ ra: 1e3, rb: 1e3, c: 10e-9, capRef: "cap-ceramic" }); // prettier-ignore
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });
  const cap = capture();
  sim.start();
  await sleep(80);
  const levels = outLevels(doc, cap.ticks);
  assert.ok(edges(levels) >= 4, `it oscillated: ${levels.join("")}`);
  const timing = cap.events.at(-1).timing.get("u1");
  assert.equal(timing.sections[0].mode, "astable", "the analysis is published");
  sim.stop();
  const after = cap.events.length;
  await sleep(30);
  assert.equal(cap.events.length, after, "Stop leaves no wake timer behind");
  assert.equal(cap.events.at(-1).timing.size, 0, "and clears the readout");
  cap.stop();
});

/** A 3 V~ 60 Hz adapter (S2 on the supply's −) through 1 kΩ into `hole`:
    ±4.2 V, its trough held a diode below ground by the input's clamp. */
function sineInto(b, hole) {
  const r = b.seat("rs", "resistor", "a40", { ohms: 1000 });
  b.link(r.get(2), hole);
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: { hz: 60, rms: 3 } }); // prettier-ignore
  b.doc.wires.push(
    { id: "wl", from: "adp1.S1", to: b.at(r.get(1).replace(/^a/, "c")), color: "red" }, // prettier-ignore
    { id: "wn", from: "adp1.S2", to: "psu1.-", color: "black" },
  );
}

test("a running AC wave's crossings are ticked at their own moments, as a clock's edges are", async () => {
  // A 60 Hz sine into a 74LS14: each crossing of the input's threshold is a
  // tick of its own (`edgeAt`), never held back to MIN_SHOWN_S — held, a
  // fast wave's every tick landed on one phase and the output read steady
  // (2026-10-22).
  resetDom();
  const b = bench();
  const u = b.seat("u1", "74LS14", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  sineInto(b, u.get(1));
  const sim = new SimController({
    deskDoc: fakeDoc(b.doc),
    notifications: fakeNotifications(),
  });
  sim.setSpiceLite({ enabled: true });
  sim.setSpeed(4);
  const cap = capture();
  sim.start();
  // Until five cycles have run (a busy machine runs fewer a wall second).
  for (let k = 0; k < 200 && !(cap.ticks.at(-1)?.at > 5 / 60); k++) await sleep(10); // prettier-ignore
  sim.stop();
  cap.stop();
  const net = buildNetlist(b.doc).netOfPoint.get(b.at(u.get(2)));
  const ticks = cap.ticks.filter((t) => t.at > 0);
  const levels = ticks.map((t) => t.netLevels.get(net));
  // Two crossings a cycle, every one shown: the output flips at each.
  const cycles = 60 * ticks.at(-1).at;
  assert.ok(cycles > 4, `${cycles} cycles`);
  assert.ok(Math.abs(edges(levels) - 2 * cycles) <= 2, `${edges(levels)} flips in ${cycles} cycles`); // prettier-ignore
});

test("a batch out of budget draws the analyzer's frames only up to its last tick — time never runs back", () => {
  // The budget spent, the sim clock goes back to the last tick run — but the
  // frames went on to the moment the batch had set out for, holding every
  // net no node makes (an adapter's S1, an op-amp's output) at the last
  // tick's value over events still unrun; the next batch's ticks then went
  // BACK under them, and the analyzer's voltage lanes drew flat stretches
  // (2026-10-22).
  resetDom();
  const b = bench();
  const u = b.seat("u1", "74LS14", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  sineInto(b, u.get(1));
  b.doc.scopeChannels = [{ id: "sc1", kind: "net", ref: b.at(u.get(1)) }];
  // A wall clock every read of which costs a millisecond: a batch spends
  // its budget in a few ticks, always behind.
  let wall = 0;
  let pending = null;
  const clock = {
    now: () => (wall += 1),
    setTimeout: (fn) => (pending = fn),
    clearTimeout: () => (pending = null),
  };
  const sim = new SimController({
    deskDoc: fakeDoc(b.doc),
    notifications: fakeNotifications(),
    clock,
  });
  sim.setSpiceLite({ enabled: true });
  const cap = capture();
  sim.start();
  for (let k = 0; k < 40 && pending; k++) {
    wall += 50;
    const fn = pending;
    pending = null;
    fn();
  }
  sim.stop();
  cap.stop();
  const ats = cap.ticks.map((t) => t.at);
  assert.ok(ats.length > 40, `${ats.length} ticks and frames`);
  const back = ats.findIndex((at, i) => i && at < ats[i - 1]);
  assert.equal(back, -1, `time ran back at ${back}: ${ats[back - 1]} → ${ats[back]}`); // prettier-ignore
});

test("Pause freezes simulated time; Step moves it to the next timed edge", async () => {
  resetDom();
  const { doc } = astable555({ ra: 1e3, rb: 1e3, c: 10e-9, capRef: "cap-ceramic" }); // prettier-ignore
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
  });
  const cap = capture();
  sim.start();
  sim.pause();
  const paused = cap.events.length;
  await sleep(40);
  assert.equal(cap.events.length, paused, "nothing ticks while paused");
  const before = outLevels(doc, cap.events).at(-1);
  sim.step();
  const once = outLevels(doc, cap.events).at(-1);
  assert.notEqual(once, before, "one Step: one edge");
  sim.step();
  assert.equal(outLevels(doc, cap.events).at(-1), before, "and back");
  sim.stop();
  cap.stop();
});

test("Pause between two batches still stops on the press: the first Step is one edge", () => {
  // The test above with real timers passed only while Pause came within one
  // shown edge of Run: past that, the edges owed since the last batch were
  // frozen unrun, and the first Step merely caught up to the press — no edge,
  // or several. A clock the test drives puts a gap of several edges (at the
  // 1 kHz cap, an edge every 0.3–0.7 ms) between Run and Pause, with no batch
  // in it — a Pause landing between two frames.
  for (const gap of [0, 0.4, 1, 2.5, 7]) {
    resetDom();
    let now = 0;
    const clock = { now: () => now, setTimeout: () => 0, clearTimeout() {} };
    const { doc } = astable555({ ra: 1e3, rb: 1e3, c: 10e-9, capRef: "cap-ceramic" }); // prettier-ignore
    const sim = new SimController({
      deskDoc: fakeDoc(doc),
      notifications: fakeNotifications(),
      clock,
    });
    const cap = capture();
    sim.start();
    now += gap;
    sim.pause();
    const levels = () => outLevels(doc, cap.events);
    const before = levels().at(-1);
    sim.step();
    assert.notEqual(levels().at(-1), before, `${gap} ms: one Step, one edge`);
    sim.step();
    assert.equal(levels().at(-1), before, `${gap} ms: and back`);
    sim.stop();
    cap.stop();
  }
});

test("a timer that cannot read its wiring raises a toast naming what is missing", () => {
  resetDom();
  const { doc } = astable555({ ra: 1e3, rb: 1e3, c: 1e-6 });
  // Take the timing capacitor away.
  doc.components = doc.components.filter((c) => c.id !== "c1");
  const notifications = fakeNotifications();
  const sim = new SimController({ deskDoc: fakeDoc(doc), notifications });
  sim.start();
  const toast = notifications.calls.find((c) => c.key === "timing:u1");
  assert.ok(toast, "a timing toast");
  assert.match(toast.message, /no timing capacitor from TRIG\/THRES \(2, 6\) to GND/); // prettier-ignore
  sim.stop();
});

test("a Spice Lite wave is where its clock is between edges: Step, own pause", async () => {
  resetDom();
  // A 1 Hz triangle (sim/spice/waves.js): 0 V at Run, 5 V at its first edge.
  const { bench } = await import("./timing-fixtures.js");
  const { partDef } = await import("../catalog/index.js");
  const b = bench();
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 1, wave: "triangle" }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at("a5"), color: "blue" },
  );
  const sim = new SimController({
    deskDoc: fakeDoc(b.doc),
    notifications: fakeNotifications(),
  });
  sim.setSpiceLite({ enabled: true });
  const cap = capture();
  sim.start();
  sim.pause();
  const out = (e = cap.events.at(-1)) =>
    e.nodeVolts.get(e.netlist.netOfPoint.get("clk1.out"));
  const lamp = () => cap.events.at(-1).clockLevels.get("clk1");
  // Read off the state Run published: a loaded machine can let a batch run
  // a frame or more of wall time before the pause lands.
  assert.ok(out(cap.events[0]) < 0.5, `near 0 V at Run: ${out(cap.events[0])}`);
  // (Read a few gate delays on: the tick's settle runs on past its moment.)
  sim.step(); // one half: the triangle's peak
  assert.ok(Math.abs(out() - 5) < 1e-5, `at its peak: ${out()}`);
  assert.equal(lamp(), "H");
  sim.step();
  assert.ok(Math.abs(out()) < 1e-5, `back at 0 V: ${out()}`);
  assert.equal(lamp(), "L");
  // Held on its own part-way up, it stays there while time runs on.
  sim.resume();
  await sleep(120);
  sim.toggleClockPause("clk1");
  // Read once the pause has published: under load the last state out can
  // still be a batch from a few milliseconds before it.
  await sleep(30);
  const held = out();
  assert.ok(held > 0 && held < 5, `part-way: ${held}`);
  await sleep(60);
  assert.ok(Math.abs(out() - held) < 1e-6, `held at ${out()} from ${held}`);
  sim.toggleClockPause("clk1"); // …and picks up where it was
  assert.ok(Math.abs(out() - held) < 0.05, `resumed at ${out()} from ${held}`);
  sim.stop();
  cap.stop();
});

test("Spice Lite: a switch thrown after a quiet stretch charges from the throw, not from the last tick", async () => {
  // The cap-electrolytic Timer: a slide switch takes 10 kΩ into 1000 µF to
  // +5 V (τ = 1 s), and a CD40106B reads the capacitor. Nothing ticks after
  // Run — no clock, the capacitor flat at 0 V — so when the switch is
  // thrown 3 s in, the last tick is Run's. The engine catches a late tick up
  // from the last on the board it is HANDED; given the thrown board, it
  // charged the capacitor across those 3 s (5(1 − e^−3) = 4.75 V at once,
  // the Schmitt tripped on the spot). The board as it stood must run on to
  // the throw first.
  resetDom();
  const { readFileSync } = await import("node:fs");
  const { exampleDesktops } = await import("../model/example-desktops.js");
  const ref = "cap-electrolytic";
  const payload = JSON.parse(readFileSync(new URL(`../../demos/${ref}.json`, import.meta.url), "utf8")); // prettier-ignore
  const { doc } = exampleDesktops(ref, payload).find((d) => d.name === `${ref} Timer example`); // prettier-ignore
  const sw = doc.components.find((c) => c.ref === "sw-slide");
  const capC = doc.components.find((c) => c.ref === "cap-electrolytic");
  const r = doc.components.find((c) => c.ref === "resistor" && c.params.ohms === 10e3); // prettier-ignore
  const tau = r.params.ohms * capC.params.farads;
  let now = 0;
  const clock = { now: () => now, setTimeout: () => 0, clearTimeout() {} };
  const desk = fakeDoc(doc);
  const sim = new SimController({ deskDoc: desk, notifications: fakeNotifications(), clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  const cap = capture();
  sim.start();
  const volts = () => {
    const e = cap.events.at(-1);
    return e.nodeVolts.get(e.netlist.netOfPoint.get(`${capC.board}.${capC.anchor}`)); // prettier-ignore
  };
  assert.ok(volts() < 0.01, `discharged at Run: ${volts()}`);
  now += 3000; // a quiet three seconds
  desk.setComponentParams(sw.id, { pos: sw.params.pos === "2" ? "1" : "2" });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  assert.ok(volts() < 0.01, `still discharged at the throw: ${volts()}`);
  // …and one τ after it, 1 − 1/e of the supply.
  now += tau * 1000;
  sim.wake();
  const want = 5 * (1 - Math.exp(-1));
  assert.ok(Math.abs(volts() - want) < 0.02, `one τ on: ${volts()}, want ${want}`); // prettier-ignore
  sim.stop();
  cap.stop();
});

/** A wall clock whose timers run as it is advanced (`advance(ms)`). */
function steppedClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      pending.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout: (id) => pending.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of pending) {
          if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
    },
  };
}

test("Spice Lite: a desk come to rest shows its nodes where they rest, not 1 % short", () => {
  // Redrawn until the gap setting says each node has arrived (1 % of its
  // step), then no more: the last frame stood for good — 1 kΩ charging
  // 100 µF from 5 V read 4.95 V, and a supply on its limit read the
  // rail its own last tick left, short of the rail it held.
  for (const limited of [false, true]) {
    resetDom();
    const b = bench();
    let probe;
    if (limited) {
      // 10 Ω ‖ 1000 µF on 0.1 A: the rail charges to 1 V, τ 10 ms.
      b.doc.components[0].params.currentLimit = 0.1;
      const rl = b.seat("rl", "resistor", "a20", { ohms: 10 });
      b.vcc(rl.get(1));
      b.gnd(rl.get(2));
      const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 1000e-6 });
      b.vcc(c.get(1));
      b.gnd(c.get(2));
      probe = b.at(rl.get(1));
    } else {
      const rl = b.seat("rl", "resistor", "a20", { ohms: 1000 });
      b.vcc(rl.get(1));
      const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 100e-6 });
      b.link(rl.get(2), c.get(1));
      b.gnd(c.get(2));
      probe = b.at(c.get(1));
    }
    const clock = steppedClock();
    const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: fakeNotifications(), clock }); // prettier-ignore
    sim.setSpiceLite({ enabled: true });
    const cap = capture();
    sim.start();
    for (let ms = 0; ms < 2000; ms += 20) clock.advance(20);
    const last = cap.events.at(-1);
    sim.stop();
    cap.stop();
    const want = limited ? 1 : 5;
    const v = last.nodeVolts.get(last.netlist.netOfPoint.get(probe));
    assert.ok(Math.abs(v - want) < 1e-3, `${limited ? "limited" : "RC"}: shows ${v} V`); // prettier-ignore
    if (limited) {
      const psu = last.supplies.get("psu1").volts;
      assert.ok(Math.abs(psu - want) < 1e-3, `the supply reads ${psu} V`);
    }
  }
});

test("a run handed over mid-bounce bounces on as it would have (exportRun / importRun)", async () => {
  // The switches' bounces and the moves their seeds count were not carried:
  // a press just before the hand-over closed solid at once, and the next
  // press bounced as the run's first ever did.
  const { NetlistCache } = await import("../components/netlist-cache.js");
  const press = (pressed) =>
    window.dispatchEvent(new window.CustomEvent("chiphippo:part-state", { detail: { id: "s1", ref: "sw-push", state: { pressed } } })); // prettier-ignore
  const run = (handOver) => {
    resetDom();
    const b = bench();
    const u = b.seat("u1", "74LS04", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    const s = b.seat("s1", "sw-push", "a40");
    b.gnd(s.get(1));
    const up = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
    b.vcc(up.get(1));
    b.link(up.get(2), s.get(2));
    b.link(s.get(2), u.get(1));
    const clock = steppedClock();
    const desk = fakeDoc(b.doc);
    const netlist = new NetlistCache(desk);
    const make = () => {
      const sim = new SimController({ deskDoc: desk, netlist, notifications: fakeNotifications(), clock }); // prettier-ignore
      sim.setSpiceLite({ enabled: true, bounce: true });
      return sim;
    };
    let sim = make();
    const cap = capture();
    sim.start();
    clock.advance(20);
    const swap = () => {
      const state = sim.exportRun();
      sim.stop();
      sim = make();
      sim.importRun(state);
    };
    const level = (t) =>
      t.netLevels.get(t.netlist.netOfPoint.get(b.at(u.get(1))));
    const seen = [];
    for (const k of [0, 1]) {
      const from = cap.ticks.length;
      press(true);
      if (handOver === k) swap();
      clock.advance(100);
      seen.push(cap.ticks.slice(from).map((t) => `${(t.at * 1e3).toFixed(3)}${level(t)}`)); // prettier-ignore
      press(false);
      clock.advance(100);
    }
    sim.stop();
    cap.stop();
    // Only the moments it changed (a hand-over adds a tick of its own).
    return seen.map((ts) => ts.filter((x, i) => i === 0 || x.slice(-1) !== ts[i - 1].slice(-1))); // prettier-ignore
  };
  const straight = run(null);
  assert.ok(straight[0].length > 4, `it bounces: ${straight[0]}`);
  assert.deepEqual(run(0), straight, "handed over in the first bounce");
  assert.deepEqual(
    run(1),
    straight,
    "handed over in the second, its seed the run's third move",
  );
});

test("a run handed over keeps its lamps' averages: no frame of a PWM LED's bare tick", async () => {
  // Begun empty, the importing side's averaging window covered none of the
  // time before the hand-over, and its first frame showed the LED as the
  // tick left it — dark, or full on — where every other showed 20 %.
  const { NetlistCache } = await import("../components/netlist-cache.js");
  const { partDef } = await import("../catalog/index.js");
  for (const after of [0, 1, 2]) {
    resetDom();
    const b = bench();
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 250, wave: "pwm", duty: 20 }) }); // prettier-ignore
    b.doc.wires.push(
      { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
      { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
      { id: "wc3", from: "clk1.out", to: b.at("e5"), color: "blue" },
    );
    const d = b.seat("d1", "led", "a20", { color: "red" });
    b.link("a5", d.get(1));
    const r = b.seat("r1", "resistor", "a30", { ohms: 330 });
    b.link(d.get(2), r.get(1));
    b.gnd(r.get(2));
    const clock = steppedClock();
    const desk = fakeDoc(b.doc);
    const netlist = new NetlistCache(desk);
    const make = () => new SimController({ deskDoc: desk, netlist, notifications: fakeNotifications(), clock }); // prettier-ignore
    let sim = make();
    const cap = capture();
    sim.start();
    for (let ms = 0; ms < 400; ms += 10) {
      if (ms === 200) {
        clock.advance(after);
        const state = sim.exportRun();
        sim.stop();
        sim = make();
        sim.importRun(state);
      }
      clock.advance(10);
    }
    sim.stop();
    cap.stop();
    const glows = cap.events.filter((e) => e.running).slice(5).map((e) => e.lampGlow?.get("d1")); // prettier-ignore
    for (const g of glows) assert.ok(g != null && Math.abs(g - 0.2) < 0.02, `${after} ms on: ${glows.map((x) => x?.toFixed(3))}`); // prettier-ignore
  }
});

test("an underpowered chip is said once while its droop settles, not at every tenth", () => {
  // Its toast carries the volts, and a 555 off a 7805 in dropout — fed from
  // a 9 V supply limited to 100 mA, its output into 22 Ω — was said at 3.82,
  // 3.69 and 3.70 V: three toasts in its first ticks.
  resetDom();
  const b = bench({ volts: 9 });
  b.doc.components[0].params.currentLimit = 0.1;
  const reg = b.seat("g1", "LM7805", "a55");
  b.vcc(reg.get(1));
  b.gnd(reg.get(2));
  const u = b.seat("u1", "NE555", "e10");
  b.link(reg.get(3), u.get(8));
  b.link(u.get(8), u.get(4));
  b.gnd(u.get(1));
  b.link(u.get(2), u.get(6));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: 1e-6 });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const rB = b.seat("r2", "resistor", "a40", { ohms: 10e3 });
  b.link(rB.get(1), u.get(7));
  b.link(rB.get(2), u.get(6));
  const rA = b.seat("r1", "resistor", "a50", { ohms: 1e3 });
  b.link(rA.get(1), u.get(7));
  b.link(rA.get(2), u.get(8));
  const load = b.seat("rl", "resistor", "f30", { ohms: 22 });
  b.link(load.get(1), u.get(3));
  b.gnd(load.get(2));
  const clock = steppedClock();
  const said = [];
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: { notify: (o) => said.push(o), dismiss() {} }, clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  sim.start();
  for (let ms = 0; ms < 1000; ms += 20) clock.advance(20);
  sim.stop();
  const under = said.filter((o) => o.key === "under:u1");
  // (At most once: since the 2026-10-26 review the supply starts at its set
  // volts and sags as its own 470 µF drains, so the Run tick's instant
  // droop — the one moment it read underpowered here — is gone.)
  assert.ok(under.length <= 1, under.map((o) => o.message).join(" | "));
});

test("an LED overdriven by an AC adapter is said once while it stands, not at every phase", () => {
  // Read at a new phase every frame, its toast's milliamps changed every
  // tick and it was said again each time: 360 times in 2 s, straight back
  // when clicked away (the regrade, 2026-10-23). Said again only when a
  // number in it grows past the most said by a quarter.
  resetDom();
  const b = bench();
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: { hz: 60, rms: 12 } }); // prettier-ignore
  const r = b.seat("r1", "resistor", "a30", { ohms: 100 });
  const d = b.seat("d1", "led", "a40", {});
  b.doc.wires.push({ id: "x1", from: "adp1.S1", to: b.at(r.get(1)), color: "orange" }); // prettier-ignore
  b.link(r.get(2), d.get(1));
  b.doc.wires.push({ id: "x2", from: "adp1.S2", to: b.at(d.get(2)), color: "blue" }); // prettier-ignore
  const clock = steppedClock();
  const said = [];
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: { notify: (o) => said.push(o), dismiss() {} }, clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  sim.start();
  for (let ms = 0; ms < 2000; ms += 20) clock.advance(20);
  sim.stop();
  const over = said.filter((o) => o.key === "led:d1");
  assert.ok(over.length >= 1 && over.length <= 3, over.map((o) => o.message).join(" | ")); // prettier-ignore
  const reverse = said.filter((o) => o.key === "led-reverse:d1");
  assert.ok(reverse.length >= 1 && reverse.length <= 3, reverse.map((o) => o.message).join(" | ")); // prettier-ignore
});

test("a fault that clears and comes back is said again — once it has been gone a second", () => {
  // Said once a run and never again: a short a push button made, released
  // and pressed again stayed silent, its toast long clicked away (the
  // release review, 2026-10-23). Back within REARM_S it is the same fault
  // still standing; after, it is news.
  resetDom();
  const press = (pressed) =>
    window.dispatchEvent(new window.CustomEvent("chiphippo:part-state", { detail: { id: "s1", ref: "sw-push", state: { pressed } } })); // prettier-ignore
  const b = bench();
  const s = b.seat("s1", "sw-push", "a40");
  b.vcc(s.get(1));
  b.gnd(s.get(2));
  const clock = steppedClock();
  const said = [];
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: { notify: (o) => said.push(o), dismiss() {} }, clock }); // prettier-ignore
  sim.start();
  const shorts = () => said.filter((o) => o.key?.startsWith("short:")).length;
  clock.advance(100);
  press(true);
  clock.advance(200);
  assert.equal(shorts(), 1, "said when the button first shorts the rails");
  press(false);
  clock.advance(200);
  press(true); // back 0.2 s after it cleared
  clock.advance(200);
  assert.equal(shorts(), 1, "back at once: the same short");
  press(false);
  clock.advance(1500);
  press(true); // back 1.5 s after it cleared
  clock.advance(200);
  assert.equal(shorts(), 2, "back after a second and more: said again");
  sim.stop();
});

test("the speed button's behind readout clears once the desk goes quiet", () => {
  // A desk that fell behind and then stopped ticking published nothing more,
  // so its last frame's amber "×1 · ×0.13" stood over a board doing nothing
  // (the release review, 2026-10-23). The meter's window closing is owed a
  // frame of its own.
  resetDom();
  let now = 0;
  let seq = 0;
  const pending = new Map();
  const clock = {
    now: () => (now += 0.5), // every read costs half a wall ms: a slow board
    setTimeout(fn, ms) {
      pending.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout: (id) => pending.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of pending) {
          if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        }
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = Math.max(now, end);
    },
  };
  const b = bench();
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: { hz: 1000 } }); // prettier-ignore
  b.doc.wires.push({ id: "cv", from: "psu1.+", to: "clk1.vcc", color: "red" }, { id: "cg", from: "psu1.-", to: "clk1.gnd", color: "black" }); // prettier-ignore
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: fakeNotifications(), clock }); // prettier-ignore
  sim.setSpeed(4);
  const cap = capture();
  sim.start();
  clock.advance(1500);
  assert.ok(cap.events.at(-1).behind != null, "behind while the clock runs");
  sim.toggleClockPause("clk1"); // nothing left to tick
  clock.advance(2500);
  const last = cap.events.at(-1);
  sim.stop();
  cap.stop();
  assert.equal(last.mode, "running");
  assert.equal(last.behind, null, "the quiet desk keeps up");
});

/** Every sim-tick of a Spice Lite run recorded on the analyzer's channel at
    `ref`, run `seconds` on a stepped wall clock: `{at, v, sample}`. */
function recordScope(doc, ref, seconds) {
  resetDom();
  doc.scopeChannels = [{ id: "sc1", kind: "net", ref }];
  const clock = steppedClock();
  const sim = new SimController({ deskDoc: fakeDoc(doc), notifications: fakeNotifications(), clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  const cap = capture();
  sim.start();
  for (let ms = 0; ms < seconds * 1000; ms += 20) clock.advance(20);
  sim.stop();
  cap.stop();
  const net = buildNetlist(doc).netOfPoint.get(ref);
  return cap.ticks.map((t) => ({ at: t.at, v: t.nodeVolts.get(net), sample: t.sample === true })); // prettier-ignore
}

/** A clock brick putting out `wave` at `hz` on `hole`. */
function clockInto(b, hz, wave, hole) {
  const params = partDef("clock").normalizeParams({ hz, wave });
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params }); // prettier-ignore
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at(hole), color: "blue" },
  );
}

test("Spice Lite: the analyzer reads an RC's curve between two ticks, not at the display frames", () => {
  // 1 kΩ / 1 µF (τ 1 ms) on a 10 Hz square. Read at the 30 Hz display
  // frames each 5 ms charge was a 33 ms straight ramp — 4.3 V off at worst.
  // Now each sample is joined to the one before, each tick held to and
  // stepped at, and the trace is the curve.
  const b = bench();
  const r = b.seat("r1", "resistor", "a20", { ohms: 1e3 });
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 1e-6 });
  clockInto(b, 10, "square", "a10");
  b.link("a10", r.get(1));
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  const cols = recordScope(b.doc, b.at(c.get(1)), 0.45);
  const hi = Math.max(...cols.map((x) => x.v));
  assert.ok(hi > 4.9, `charges to the supply: ${hi}`);
  // The truth: LOW from Run, a half every 50 ms — τ the 1 kΩ and the
  // brick's own 50 Ω (spice/output-stage.js `CLOCK_OHMS`) into 1 µF.
  const truth = (t) => {
    let v = 0;
    for (let k = 0; k * 0.05 <= t; k++) {
      const target = k % 2 ? hi : 0;
      v = target + (v - target) * Math.exp(-(Math.min(0.05, t - k * 0.05)) / 1.05e-3); // prettier-ignore
    }
    return v;
  };
  let worst = 0;
  for (let i = 1; i < cols.length; i++) {
    const [a, z] = [cols[i - 1], cols[i]];
    if (a.at < 0.1) continue;
    for (let k = 1; k < 10; k++) {
      const t = a.at + ((z.at - a.at) * k) / 10;
      const drawn = z.sample ? a.v + ((z.v - a.v) * k) / 10 : a.v;
      worst = Math.max(worst, Math.abs(drawn - truth(t)));
    }
  }
  assert.ok(worst < 0.05, `the drawn trace strays ${worst} V from the curve`);
});

test("Spice Lite: the analyzer's buffer holds at least five whole waves however finely a wave is read", async () => {
  const { SCOPE_CAPACITY } = await import("../model/scope-recorder.js");
  const perPeriod = (cols, period, from) => {
    const kept = cols.filter((x) => x.at >= from);
    return kept.length / ((kept.at(-1).at - kept[0].at) / period);
  };
  // A 60 Hz 12 V~ adapter, its S1 on the board, and a 500 Hz sine clock.
  const a = bench();
  a.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -40, y: 40, params: { hz: 60, rms: 12 } }); // prettier-ignore
  const load = a.seat("r1", "resistor", "a20", { ohms: 10e3 });
  a.doc.wires.push(
    { id: "wa1", from: "adp1.S1", to: a.at("c20"), color: "red" },
    { id: "wa2", from: "adp1.S2", to: a.at("c24"), color: "black" },
  );
  a.link(load.get(2), "a24");
  const mains = recordScope(a.doc, a.at("a20"), 0.2);
  const s = bench();
  clockInto(s, 500, "sine", "a10");
  const r = s.seat("r1", "resistor", "a20", { ohms: 10e3 });
  s.link("a10", r.get(1));
  s.gnd(r.get(2));
  const sine = recordScope(s.doc, s.at("a10"), 0.1);
  for (const [name, cols, period] of [
    ["60 Hz", mains, 1 / 60],
    ["500 Hz", sine, 1 / 500],
  ]) {
    // prettier-ignore
    const n = perPeriod(cols, period, 0.05);
    assert.ok(n >= 16, `${name}: ${n} samples a period — its shape`);
    assert.ok(5 * n <= SCOPE_CAPACITY, `${name}: ${n} samples a period — five waves fit`); // prettier-ignore
    const crest = Math.max(...cols.map((x) => x.v));
    const trough = Math.min(...cols.map((x) => x.v));
    // Crest to trough the whole swing (the adapter's 1.2 Ω behind 10 kΩ):
    // read at the frames, 2 ms apart, a 500 Hz sine's was luck.
    const swing = name === "60 Hz" ? 2 * 12 * Math.SQRT2 : 5;
    assert.ok(crest - trough > 0.99 * swing, `${name}: swing ${trough}…${crest}`); // prettier-ignore
  }
});

test("Spice Lite: a cycle drawn slowed reaches the analyzer with its TRUE cycle, one template a net", () => {
  // A 555 at ~4.7 kHz is shown on the desk at the 1 kHz cap; recorded as
  // shown, the analyzer's cursors read a 1 ms period and its capacitor
  // swung 1.72–3.23 V. Each sim-tick now names the drawn cycle its nets are
  // on, with each net's one true cycle (spice/sample.js `cycleTemplates`).
  resetDom();
  const { doc, b, u } = astable555({ ra: 1e3, rb: 1e3, c: 100e-9 });
  const capRef = b.at(u.get(6));
  const outRef = b.at(u.get(3));
  doc.scopeChannels = [
    { id: "cap", kind: "net", ref: capRef },
    { id: "out", kind: "net", ref: outRef },
  ];
  const clock = steppedClock();
  const sim = new SimController({ deskDoc: fakeDoc(doc), notifications: fakeNotifications(), clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  const cap = capture();
  sim.start();
  for (let ms = 0; ms < 100; ms += 20) clock.advance(20);
  sim.stop();
  cap.stop();
  const tick = cap.ticks.findLast((t) => t.cycles);
  assert.ok(tick, "the drawn cycle is named");
  const [cycle] = tick.cycles;
  const measured = cap.events.findLast((e) => e.timing?.size)?.timing.get("u1").sections[0].period; // prettier-ignore
  assert.ok(Math.abs(cycle.period - measured) / measured < 1e-6, `true period ${cycle.period} vs the readout's ${measured}`); // prettier-ignore
  assert.ok(cycle.shown > 4 * cycle.period, "shown slowed on the desk");
  const nl = buildNetlist(doc);
  const capT = cycle.templates.get(nl.netOfPoint.get(capRef));
  const outT = cycle.templates.get(nl.netOfPoint.get(outRef));
  const volts = capT.map((p) => p.volts);
  assert.ok(Math.abs(Math.min(...volts) - 5 / 3) < 0.01 && Math.abs(Math.max(...volts) - 10 / 3) < 0.01, `the capacitor ⅓–⅔ of 5 V: ${Math.min(...volts)}…${Math.max(...volts)}`); // prettier-ignore
  // OUT HIGH while it charges through RA + RB, LOW while it discharges
  // through RB: two thirds of the period and one.
  const fall = outT.find((p) => p.cell === "L").u;
  assert.ok(Math.abs(fall / cycle.period - 2 / 3) < 0.03, `HIGH for ${fall / cycle.period} of it`); // prettier-ignore
});
