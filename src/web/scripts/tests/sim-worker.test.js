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

// The simulation Worker (features/03-sim-worker.md): one scripted run —
// Run, time, a signal pressed and released, a clock paused on its own, Pause,
// Step, Resume, an edit, Stop — through SimController on this thread and
// through SimHost with its run on a "Worker" (components/sim-worker-host.js
// over a message channel that structured-clones every message, as a real one
// does, on a scope of its own), each on its own fake clock. Every board the
// views are told of (`sim-state`), every analyzer column (`sim-tick`) and
// every toast must be the same.

import test from "node:test";
import assert from "node:assert/strict";
import { resetDom } from "./jsdom-setup.js";
import { createWorkerHost } from "../components/sim-worker-host.js";
import { SimHost } from "../components/sim-host.js";
import { SimController } from "../components/sim-controller.js";
import { NetlistCache } from "../components/netlist-cache.js";
import { astable555, bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";

/** A wall clock and timers the test drives (as sim-controller.test.js's). */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      pending.set(++seq, { at: now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
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
}

/** A DeskDoc stand-in that tells the window of every change, as DeskDoc
    does through its controller. */
function fakeDeskDoc(raw) {
  let doc = structuredClone(raw);
  return {
    toJSON: () => structuredClone(doc),
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      doc = { ...doc, components: doc.components.map((c) => (c.id === id ? { ...c, params: { ...c.params, ...patch } } : c)) }; // prettier-ignore
      return this.getComponent(id);
    },
    edit(fn) {
      doc = structuredClone(doc);
      fn(doc);
      window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    },
    get scopeChannels() {
      return doc.scopeChannels ?? [];
    },
  };
}

/** A "Worker" on this thread: its own scope, every message cloned, each
    delivered in a task of its own as a real Worker's is. */
function fakeWorker(clock) {
  const scope = new window.EventTarget();
  const listeners = [];
  const host = createWorkerHost({
    scope,
    clock,
    post: (m) => {
      const copy = structuredClone(m);
      setImmediate(() => listeners.forEach((fn) => fn({ data: copy })));
    },
  });
  return {
    addEventListener(type, fn) {
      if (type === "message") listeners.push(fn);
    },
    postMessage(m) {
      const copy = structuredClone(m);
      setImmediate(() => host.receive(copy));
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** What a view reads off a board: everything but the netlist object. */
const board = ({ netlist: _n, ...rest }) => rest;

/** The 555 astable with a clock-driven RC beside it and a signal flag. */
function desk() {
  const { doc, b } = astable555({ ra: 1e3, rb: 10e3, c: 1e-6 });
  const r = b.seat("r9", "resistor", "a56", { ohms: 10e3 });
  const c = b.seat("c9", "cap-ceramic", "b60", { farads: 1e-6 });
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  b.signal("sig1", r.get(1).replace(/^a/, "c"), "low");
  doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 40, params: partDef("clock").normalizeParams({ hz: 50 }) }); // prettier-ignore
  doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
  );
  doc.scopeChannels = [{ id: "sc1", kind: "net", ref: b.at(c.get(1)) }];
  return doc;
}

/** Run the script on `make(deskDoc, clock)`; what the views were told. */
async function script(make) {
  resetDom();
  const clock = fakeClock();
  const deskDoc = fakeDeskDoc(desk());
  const toasts = [];
  const states = [];
  const ticks = [];
  window.addEventListener("chiphippo:sim-state", (e) => states.push(board(e.detail))); // prettier-ignore
  window.addEventListener("chiphippo:sim-tick", (e) => ticks.push(board(e.detail))); // prettier-ignore
  const sim = make({
    deskDoc,
    netlist: new NetlistCache(deskDoc),
    notifications: { notify: (o) => toasts.push(o), dismiss: () => {} },
    clock,
  });
  sim.setSpiceLite({ enabled: true });
  const step = async (fn) => {
    fn();
    await settle();
    await settle();
  };
  await step(() => sim.start());
  const onWorker = sim.inWorker === true;
  for (let i = 0; i < 10; i++) await step(() => clock.advance(20));
  await step(() => sim.pressSignal("sig1", true));
  for (let i = 0; i < 5; i++) await step(() => clock.advance(20));
  await step(() => sim.pressSignal("sig1", false));
  await step(() => sim.toggleClockPause("clk1"));
  for (let i = 0; i < 5; i++) await step(() => clock.advance(20));
  await step(() => sim.pause());
  await step(() => sim.step());
  await step(() => sim.step());
  await step(() => sim.resume());
  for (let i = 0; i < 5; i++) await step(() => clock.advance(20));
  await step(() => deskDoc.edit((d) => (d.components.find((c) => c.id === "r9").params.ohms = 4.7e3))); // prettier-ignore
  for (let i = 0; i < 5; i++) await step(() => clock.advance(20));
  await step(() => sim.stop());
  return { states, ticks, toasts, onWorker };
}

test("a run on the simulation Worker tells the views exactly what one on the main thread does", async () => {
  const main = await script((opts) => new SimController(opts));
  let host = null;
  const worker = await script((opts) => {
    host = new SimHost({ ...opts, worker: () => fakeWorker(opts.clock) });
    return host;
  });
  assert.equal(worker.onWorker, true, "the run went to the Worker");
  assert.ok(main.states.length > 20, `${main.states.length} boards`);
  assert.ok(main.ticks.length > 50, `${main.ticks.length} sim-ticks`);
  assert.equal(worker.states.length, main.states.length, "as many boards");
  for (let i = 0; i < main.states.length; i++) {
    assert.deepStrictEqual(worker.states[i], main.states[i], `board ${i}`);
  }
  // The analyzer's columns: the nets it reads, the same at every tick.
  assert.equal(worker.ticks.length, main.ticks.length, "as many columns");
  const net = [...worker.ticks[0].netLevels.keys()];
  assert.ok(net.length >= 1, "the analyzer's net is sent");
  for (let i = 0; i < main.ticks.length; i++) {
    const w = worker.ticks[i];
    const m = main.ticks[i];
    assert.equal(w.at, m.at, `column ${i}: time`);
    for (const id of net) {
      assert.equal(w.netLevels.get(id), m.netLevels.get(id), `column ${i}: level`); // prettier-ignore
      assert.equal(w.nodeVolts.get(id), m.nodeVolts.get(id), `column ${i}: volts`); // prettier-ignore
    }
  }
  assert.deepStrictEqual(worker.toasts, main.toasts, "the same toasts");
  assert.ok(main.states.some((s) => s.nodeVolts.size > 0), "Spice Lite's voltages among them"); // prettier-ignore
  assert.equal(host.running, false);
});

test("an Arduino on the desk runs on the main thread; a chip armed for debugging mid-run is handed over", async () => {
  resetDom();
  const clock = fakeClock();
  // An integration element on the desk: the main thread from the start.
  const withArduino = { ...desk(), integrations: [{ id: "out1", kind: "output", tags: {} }] }; // prettier-ignore
  const a = fakeDeskDoc(withArduino);
  const onMain = new SimHost({ deskDoc: a, netlist: new NetlistCache(a), notifications: null, clock, worker: () => fakeWorker(clock) }); // prettier-ignore
  onMain.start();
  assert.equal(onMain.inWorker, false);
  assert.equal(onMain.running, true);
  onMain.stop();

  // A debugger that arms a chip after the run has begun.
  resetDom();
  const clock2 = fakeClock();
  let armed = false;
  const debug = { begin() {}, end() {}, observer: () => (armed ? { watch: new Set(), round() {}, chip() {} } : null) }; // prettier-ignore
  const d = fakeDeskDoc(desk());
  const states = [];
  window.addEventListener("chiphippo:sim-state", (e) => states.push(e.detail));
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications: null, clock: clock2, debug, worker: () => fakeWorker(clock2) }); // prettier-ignore
  host.setSpiceLite({ enabled: true });
  host.start();
  await settle();
  for (let i = 0; i < 5; i++) {
    clock2.advance(40);
    await settle();
    await settle();
  }
  assert.equal(host.inWorker, true);
  const before = states.at(-1);
  armed = true;
  clock2.advance(40);
  await settle();
  await settle();
  await settle();
  assert.equal(host.inWorker, false, "handed over to the main thread");
  assert.equal(host.running, true, "still running");
  const n = states.length;
  clock2.advance(200);
  assert.ok(states.length > n, "the main thread carries on publishing");
  // The run carried on, not restarted: the 555 kept its count of the time.
  assert.deepStrictEqual([...states.at(-1).chipStatus.keys()], [...before.chipStatus.keys()]); // prettier-ignore
  host.stop();
  assert.equal(host.running, false);
});

test("a chip's damage latch reaches the real document, and Stop takes it off again", async () => {
  resetDom();
  const clock = fakeClock();
  // A 74LS00 on 12 V: magic smoke at the first tick.
  const b = bench({ volts: 12 });
  const u = b.seat("u1", "74LS00", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const d = fakeDeskDoc(b.doc);
  const changes = [];
  window.addEventListener("chiphippo:doc-changed", () => changes.push(d.getComponent("u1").params.damaged)); // prettier-ignore
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications: null, clock, worker: () => fakeWorker(clock) }); // prettier-ignore
  host.start();
  await settle();
  await settle();
  assert.equal(host.inWorker, true);
  assert.equal(d.getComponent("u1").params.damaged, true, "latched in the real document"); // prettier-ignore
  host.stop();
  assert.equal(d.getComponent("u1").params.damaged, false, "and cleared at Stop"); // prettier-ignore
  assert.deepStrictEqual(changes, [true, false]);
});

test("a memory chip's bytes are on hand on the main thread while the Worker runs it", async () => {
  resetDom();
  const clock = fakeClock();
  const b = bench();
  const ram = b.seat("u3", "HM62256", "e20");
  b.vcc(ram.get(28));
  b.gnd(ram.get(14));
  const d = fakeDeskDoc(b.doc);
  const direct = new SimController({ deskDoc: fakeDeskDoc(b.doc), netlist: new NetlistCache(d), notifications: null, clock: fakeClock() }); // prettier-ignore
  direct.start();
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications: null, clock, worker: () => fakeWorker(clock) }); // prettier-ignore
  host.start();
  await settle();
  await settle();
  assert.equal(host.inWorker, true);
  assert.deepStrictEqual(host.imageBytesOf("u3"), direct.imageBytesOf("u3"));
  host.stop();
  direct.stop();
});

test("a Worker that fails is dropped, and the run carries on on this thread", async () => {
  resetDom();
  const clock = fakeClock();
  const b = bench();
  const u = b.seat("u1", "74LS00", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const d = fakeDeskDoc(b.doc);
  let made = 0;
  let fail = null;
  const broken = () => {
    made += 1;
    return {
      addEventListener(type, fn) {
        if (type === "error") fail = fn;
      },
      postMessage() {}, // a module that never loaded answers nothing
      terminate() {},
    };
  };
  const toasts = [];
  const notifications = { notify: (o) => toasts.push(o.key), dismiss() {} };
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications, clock, worker: broken }); // prettier-ignore
  host.start();
  assert.equal(host.inWorker, true);
  host.pause();
  fail({ message: "module script failed" });
  assert.equal(host.inWorker, false, "the run moved to this thread");
  assert.equal(host.running, true, "and is still running…");
  assert.equal(host.mode, "paused", "…paused, as the user left it");
  assert.deepEqual(toasts, ["sim-worker-failed"], "and says so");
  host.stop();
  host.start();
  assert.equal(host.inWorker, false, "no second try at a broken Worker");
  assert.equal(made, 1);
  host.stop();
});
