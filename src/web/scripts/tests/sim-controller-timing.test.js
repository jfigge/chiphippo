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
import { astable555 } from "./timing-fixtures.js";

const { SimController } = await import("../components/sim-controller.js");

/** A DeskDoc stand-in over a plain document (SimController reads only these). */
function fakeDoc(raw) {
  const doc = JSON.parse(JSON.stringify(raw));
  return {
    toJSON: () => doc,
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
  const onTick = (e) => ticks.push(e.detail);
  window.addEventListener("chiphippo:sim-state", handler);
  window.addEventListener("chiphippo:sim-tick", onTick);
  return {
    events,
    ticks,
    stop() {
      window.removeEventListener("chiphippo:sim-state", handler);
      window.removeEventListener("chiphippo:sim-tick", onTick);
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
