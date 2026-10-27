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
import {
  createWorkerHost,
  urgentTimer,
} from "../components/sim-worker-host.js";
import { SimHost } from "../components/sim-host.js";
import { SimController } from "../components/sim-controller.js";
import { NetlistCache } from "../components/netlist-cache.js";
import { astable555, bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { readVolts, readVoltsAgainst } from "../model/scope-recorder.js";

/** A wall clock and timers the test drives (as sim-controller.test.js's);
    every reading costs `cost` ms, as if the work timed took that long. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    cost: 0,
    now() {
      const t = now;
      now += this.cost;
      return t;
    },
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
    get scopeGround() {
      return doc.scopeGround ?? null;
    },
  };
}

/** A "Worker" on this thread: its own scope, every message cloned, each
    delivered in a task of its own as a real Worker's is. */
function fakeWorker(clock, sent = null) {
  const scope = new window.EventTarget();
  const listeners = [];
  const host = createWorkerHost({
    scope,
    clock,
    post: (m) => {
      const copy = structuredClone(m);
      sent?.push(copy);
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
function desk({ channels = true } = {}) {
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
  doc.scopeChannels = channels ? [{ id: "sc1", kind: "net", ref: b.at(c.get(1)) }] : []; // prettier-ignore
  return doc;
}

/** Run the script on `make(deskDoc, clock)`; what the views were told. */
async function script(make, opts = {}) {
  resetDom();
  const clock = fakeClock();
  const deskDoc = fakeDeskDoc(desk(opts));
  const toasts = [];
  const states = [];
  const ticks = [];
  const batches = []; // how many ticks each sim-ticks event carried
  window.addEventListener("chiphippo:sim-state", (e) => states.push(board(e.detail))); // prettier-ignore
  window.addEventListener("chiphippo:sim-ticks", (e) => {
    batches.push(e.detail.ticks.length);
    ticks.push(...e.detail.ticks.map(board));
  });
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
  return { states, ticks, batches, toasts, onWorker };
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

test("each board from the Worker reads on its OWN netlist, across an edit that renames a net", async () => {
  // A pot between two 10 k resistors, its wiper free, the analyzer on both
  // track ends: 3.33 V and 1.67 V wherever the wiper is. At 100 % the
  // wiper joins pin 3's net, which takes the wiper column's (smaller)
  // address as its id. An edit's catch-up ticks run on the board as it
  // stood and went out in one message with the edited board's, all paired
  // with the NEWEST netlist — so pin 3 read no voltage on each, a glitch in
  // the analyzer at every step of the slider across 100 (2026-10-21). Two
  // edits back to back put the Worker a version behind this thread, too.
  const pot = () => {
    const b = bench();
    const p = b.seat("p1", "pot", "a30", { ohms: 10e3, position: 90 });
    const r1 = b.seat("r1", "resistor", "a10", { ohms: 10e3 });
    const r2 = b.seat("r2", "resistor", "a45", { ohms: 10e3 });
    b.vcc(r1.get(1));
    b.link(r1.get(2), p.get(1));
    b.link(p.get(3), r2.get(1));
    b.gnd(r2.get(2));
    b.doc.scopeChannels = [
      { id: "sc1", kind: "net", ref: b.at(p.get(1)) },
      { id: "sc2", kind: "net", ref: b.at(p.get(3)) },
    ];
    return b.doc;
  };
  const run = async (make) => {
    resetDom();
    const clock = fakeClock();
    const deskDoc = fakeDeskDoc(pot());
    const read = [];
    window.addEventListener("chiphippo:sim-ticks", (e) => {
      for (const detail of e.detail.ticks) {
        const [a, b] = deskDoc.scopeChannels.map((ch) => readVolts(ch.ref, detail)); // prettier-ignore
        read.push(`${a?.toFixed(3)} / ${b?.toFixed(3)}`);
      }
    });
    const sim = make({ deskDoc, netlist: new NetlistCache(deskDoc), notifications: null, clock }); // prettier-ignore
    sim.setSpiceLite({ enabled: true });
    sim.start();
    await settle();
    await settle();
    const slide = (position) => {
      clock.advance(20);
      deskDoc.edit((d) => (d.components.find((c) => c.id === "p1").params.position = position)); // prettier-ignore
    };
    for (const position of [99, 100, 99, 100]) {
      slide(position);
      await settle();
      await settle();
    }
    slide(98);
    slide(100);
    await settle();
    await settle();
    const onWorker = sim.inWorker === true;
    sim.stop();
    return { read, onWorker };
  };
  const main = await run((opts) => new SimController(opts));
  const worker = await run((opts) => new SimHost({ ...opts, worker: () => fakeWorker(opts.clock) })); // prettier-ignore
  assert.ok(main.read.length > 6, `${main.read.length} columns`);
  assert.ok(
    main.read.every((r) => r === "3.333 / 1.667"),
    main.read.join(", "),
  );
  assert.equal(worker.onWorker, true, "the run went to the Worker");
  assert.ok(worker.read.length > 6, `${worker.read.length} columns`);
  assert.ok(worker.read.every((r) => r === "3.333 / 1.667"), worker.read.join(", ")); // prettier-ignore
});

test("the analyzer's ground lead is read on the Worker as on this thread", async () => {
  // The Worker cut each sim-tick to the CHANNELS' nets and left the lead's
  // out, so every voltage lane read against 0 V there (the regrade,
  // 2026-10-22): VCC – 10k – A – 10k – GND, a channel on VCC, the lead on A.
  const b = bench();
  const r1 = b.seat("c1", "resistor", "a10", { ohms: 10e3 });
  const r2 = b.seat("c2", "resistor", "a20", { ohms: 10e3 });
  b.vcc(r1.get(1));
  b.link(r1.get(2), r2.get(1));
  b.gnd(r2.get(2));
  b.doc.scopeChannels = [{ id: "sc1", kind: "net", ref: b.at(r1.get(1)) }];
  b.doc.scopeGround = b.at(r2.get(1));
  const run = async (make) => {
    resetDom();
    const clock = fakeClock();
    const deskDoc = fakeDeskDoc(b.doc);
    const read = [];
    window.addEventListener("chiphippo:sim-ticks", (e) => {
      for (const detail of e.detail.ticks) read.push(readVoltsAgainst(b.doc.scopeChannels[0].ref, b.doc.scopeGround, detail)?.toFixed(3)); // prettier-ignore
    });
    const sim = make({ deskDoc, netlist: new NetlistCache(deskDoc), notifications: null, clock }); // prettier-ignore
    sim.setSpiceLite({ enabled: true });
    sim.start();
    await settle();
    await settle();
    for (let i = 0; i < 3; i++) {
      clock.advance(40);
      await settle();
      await settle();
    }
    const onWorker = sim.inWorker === true;
    sim.stop();
    return { read, onWorker };
  };
  const main = await run((opts) => new SimController(opts));
  const worker = await run((opts) => new SimHost({ ...opts, worker: () => fakeWorker(opts.clock) })); // prettier-ignore
  assert.equal(worker.onWorker, true);
  assert.ok(main.read.length > 0 && main.read.every((v) => v === "2.500"), main.read.join(", ")); // prettier-ignore
  assert.ok(worker.read.length > 0 && worker.read.every((v) => v === "2.500"), worker.read.join(", ")); // prettier-ignore
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

test("a toast the Worker raised is taken down at Stop after the run was handed over", async () => {
  // The hand-over carries what was already said, so this thread never raises
  // the toast again — and never owned it to take down (the regrade).
  resetDom();
  const clock = fakeClock();
  const b = bench({ volts: 12 });
  const u = b.seat("u1", "74LS00", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const d = fakeDeskDoc(b.doc);
  const open = new Set();
  const notifications = { notify: (o) => open.add(o.key), dismiss: (k) => open.delete(k) }; // prettier-ignore
  let armed = false;
  const debug = { begin() {}, end() {}, observer: () => (armed ? { watch: new Set(), round() {}, chip() {} } : null) }; // prettier-ignore
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications, clock, debug, worker: () => fakeWorker(clock) }); // prettier-ignore
  host.start();
  for (let i = 0; i < 4; i++) {
    clock.advance(40);
    await settle();
    await settle();
  }
  assert.ok(open.has("smoke:u1"), [...open].join(", "));
  armed = true;
  host.wake();
  await settle();
  await settle();
  clock.advance(40);
  await settle();
  await settle();
  await settle();
  assert.equal(host.inWorker, false, "handed over");
  host.stop();
  assert.deepEqual([...open], []);
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
  let receive = null;
  let run = null;
  const broken = () => {
    made += 1;
    return {
      addEventListener(type, fn) {
        if (type === "error") fail = fn;
        if (type === "message") receive = fn;
      },
      postMessage(m) {
        run = m.run ?? run; // a module that never loaded answers nothing
      },
      terminate() {},
    };
  };
  const toasts = [];
  const dismissed = [];
  const notifications = { notify: (o) => toasts.push(o.key), dismiss: (k) => dismissed.push(k) }; // prettier-ignore
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications, clock, worker: broken }); // prettier-ignore
  host.start();
  assert.equal(host.inWorker, true);
  host.pause();
  // A toast the Worker's run raised before it broke…
  receive?.({ data: { type: "notify", run, opts: { key: "led:c4", title: "x" } } }); // prettier-ignore
  fail({ message: "module script failed" });
  assert.equal(host.inWorker, false, "the run moved to this thread");
  assert.equal(host.running, true, "and is still running…");
  assert.equal(host.mode, "paused", "…paused, as the user left it");
  assert.deepEqual(toasts, ["led:c4", "sim-worker-failed"], "and says so");
  assert.deepEqual(
    dismissed,
    ["led:c4"],
    "…withdrawing what the lost run said",
  );
  host.stop();
  host.start();
  assert.equal(host.inWorker, false, "no second try at a broken Worker");
  assert.equal(made, 1);
  host.stop();
});

test("a CPU breakpoint on the Worker pauses the transport here too", async () => {
  const { z80Doc } = await import("./cpu-fixtures.js");
  resetDom();
  const clock = fakeClock();
  const d = fakeDeskDoc(z80Doc()); // its RAM reads 0: NOPs
  const modes = [];
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications: null, clock, onTransportChange: (m) => modes.push(m), worker: () => fakeWorker(clock) }); // prettier-ignore
  const breaks = [];
  window.addEventListener("chiphippo:cpu-break", (e) => breaks.push(e.detail));
  host.setCpuBreakpoints("c1", [0x0002]); // set while stopped: the run takes it
  host.start();
  await settle();
  assert.equal(host.inWorker, true, "the run went to the Worker");
  for (let i = 0; i < 60 && !breaks.length; i++) {
    host.manualToggle("clk1");
    await settle();
    await settle();
  }
  assert.deepEqual(breaks, [{ compId: "c1", addr: 0x0002, paused: true }]);
  assert.equal(host.mode, "paused");
  assert.equal(modes.at(-1), "paused");
  host.stop();
});

test("the CPU monitor's Step runs on the Worker", async () => {
  const { z80Doc } = await import("./cpu-fixtures.js");
  resetDom();
  const clock = fakeClock();
  const doc = z80Doc(); // its RAM reads 0: NOPs
  doc.components = doc.components.map((c) => (c.id === "clk1" ? { ...c, params: { ...c.params, hz: 1 } } : c)); // prettier-ignore
  const d = fakeDeskDoc(doc);
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications: null, clock, worker: () => fakeWorker(clock) }); // prettier-ignore
  const states = [];
  window.addEventListener("chiphippo:sim-state", (e) => states.push(e.detail));
  host.monitorCpu("c1");
  host.start();
  await settle();
  assert.equal(host.inWorker, true, "the run went to the Worker");
  assert.equal(host.stepCpu("c1"), false, "running: nothing to step from");
  host.pause();
  await settle();
  const pc = () => states.at(-1)?.cpuMonitor?.pc;
  assert.equal(host.stepCpu("c1"), true);
  await settle();
  await settle();
  const first = pc();
  assert.equal(states.at(-1).cpuMonitor.view.step.index, 1, "at an operation's start"); // prettier-ignore
  host.stepCpu("c1");
  await settle();
  await settle();
  assert.equal(pc(), first + 1, "the next NOP");
  assert.equal(host.mode, "paused");
  host.stop();
});

test("a Step Over the Worker hands to its run moves the transport here, and its return pauses it", async () => {
  const { z80Doc } = await import("./cpu-fixtures.js");
  resetDom();
  const clock = fakeClock();
  const doc = z80Doc(); // its RAM reads 0: NOPs
  doc.components = doc.components.map((c) => (c.id === "clk1" ? { ...c, params: { ...c.params, hz: 1000 } } : c)); // prettier-ignore
  const d = fakeDeskDoc(doc);
  const modes = [];
  const host = new SimHost({ deskDoc: d, netlist: new NetlistCache(d), notifications: null, clock, onTransportChange: (m) => modes.push(m), worker: () => fakeWorker(clock) }); // prettier-ignore
  const states = [];
  const breaks = [];
  window.addEventListener("chiphippo:sim-state", (e) => states.push(e.detail));
  window.addEventListener("chiphippo:cpu-break", (e) => breaks.push(e.detail));
  host.monitorCpu("c1");
  host.start();
  await settle();
  host.pause();
  await settle();
  // $0004 CALL $0020 · $0007 NOP · $0020 LD B,3 · DJNZ $0022 · RET
  const program = [[0x0004, [0xcd, 0x20, 0x00]], [0x0020, [0x06, 0x03, 0x10, 0xfe, 0xc9]]]; // prettier-ignore
  for (const [at, bytes] of program) bytes.forEach((b, i) => host.pokeCpuMemory("c1", at + i, b)); // prettier-ignore
  await settle();
  const pc = () => states.at(-1)?.cpuMonitor?.pc;
  for (let i = 0; i < 8 && pc() !== 0x0004; i++) {
    host.stepCpu("c1");
    await settle();
    await settle();
  }
  assert.equal(pc(), 0x0004);
  assert.equal(states.at(-1).cpuMonitor.pipeline.current.call, true);
  clock.cost = 300; // the budget runs out at once
  assert.equal(host.stepOverCpu("c1"), true);
  await settle();
  clock.cost = 0;
  await settle();
  assert.equal(host.mode, "running", "the Worker resumed, and said so");
  assert.equal(modes.at(-1), "running");
  clock.advance(2000);
  await settle();
  await settle();
  assert.deepEqual(breaks, [{ compId: "c1", addr: 0x0007, over: true, paused: true }]); // prettier-ignore
  assert.equal(host.mode, "paused");
  assert.equal(pc(), 0x0007);
  host.stop();
});

test("the Worker's continuation runs a due batch at once, waits out the rest, and can be cleared (R2)", async () => {
  // A timer set from a timer is held to 4 ms once nested; the continuation
  // hops through a MessageChannel so a behind run's next batch is not.
  const timer = urgentTimer();
  assert.ok(timer, "Node has a MessageChannel");
  const ran = [];
  const t0 = performance.now();
  timer.set(() => ran.push(["now", performance.now() - t0]), 0);
  timer.set(() => ran.push(["later", performance.now() - t0]), 6);
  const gone = timer.set(() => ran.push(["cleared"]), 0);
  timer.clear(gone);
  const slow = timer.set(() => ran.push(["cleared late"]), 60);
  await new Promise((r) => setTimeout(r, 5));
  timer.clear(slow); // after its hop: its wait's timer is cleared too
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(
    ran.map(([what]) => what),
    ["now", "later"],
  );
  assert.ok(ran[1][1] >= 5.5, `waited ${ran[1][1]} ms`);
});

test("the continuation never runs a batch before its moment: whole ms on a timer, the fraction left hopped (NEW-1)", async () => {
  // A browser's timer cuts a fractional wait DOWN: 1.6 ms fired at 1, and
  // the batch found nothing due (35–70k such batches a second).
  let wall = 0;
  const waits = [];
  const timers = {
    setTimeout: (fn, ms) => (waits.push({ fn, ms }), waits.length),
    clearTimeout: () => {},
  };
  const timer = urgentTimer({ now: () => wall, timers });
  let ran = 0;
  timer.set(() => (ran += 1), 1.6);
  const hops = () => new Promise((r) => setTimeout(r, 5));
  await hops();
  assert.deepEqual(waits.map((w) => w.ms), [1], "the whole ms on a timer"); // prettier-ignore
  wall = 1; // the timer fires, 0.6 ms short
  waits[0].fn();
  await hops();
  assert.equal(ran, 0, "not yet: the rest is hopped, not run");
  assert.equal(waits.length, 1, "and set on no timer");
  wall = 1.6;
  await hops();
  assert.equal(ran, 1, "run once, at its moment");
});

test("the Worker sends what the analyzer reads, and no more: one sim-tick a message with no channel, a tick's levels once for its curve samples (R9)", async () => {
  // No channel: the analyzer hears only that a run is under way.
  const bare = await script((opts) => new SimController(opts), { channels: false }); // prettier-ignore
  const sent = [];
  const thin = await script((opts) => new SimHost({ ...opts, worker: () => fakeWorker(opts.clock, sent) }), { channels: false }); // prettier-ignore
  assert.equal(thin.onWorker, true);
  const perMessage = sent.filter((m) => m.type === "events").map((m) => m.events.filter((e) => e.type === "chiphippo:sim-tick").length); // prettier-ignore
  assert.ok(perMessage.length > 10, `${perMessage.length} messages`);
  assert.ok(Math.max(...perMessage) <= 1, `at most one sim-tick a message: ${Math.max(...perMessage)}`); // prettier-ignore
  assert.ok(bare.ticks.length > 2 * thin.ticks.length, `${bare.ticks.length} ticks on the main thread, ${thin.ticks.length} sent`); // prettier-ignore
  // …and every board the views are told is the same.
  assert.deepEqual(thin.states, bare.states);
  // With a channel, every tick goes, and the curve samples after a tick
  // carry ITS levels as one Map in the message, not a copy each.
  const full = [];
  const run = await script((opts) => new SimHost({ ...opts, worker: () => fakeWorker(opts.clock, full) })); // prettier-ignore
  let samples = 0;
  let shared = 0;
  for (const m of full.filter((x) => x.type === "events")) {
    let last = null;
    for (const e of m.events) {
      if (e.type !== "chiphippo:sim-tick") continue;
      if (e.detail.sample) {
        samples += 1;
        if (last && e.detail.netLevels === last) shared += 1;
      }
      last = e.detail.netLevels;
    }
  }
  assert.ok(run.ticks.length > 50);
  assert.ok(samples > 20, `${samples} curve samples`);
  assert.ok(shared > samples / 2, `${shared} of ${samples} samples share their tick's levels`); // prettier-ignore
});

test("a Worker message's sim-ticks reach the window as ONE sim-ticks event, in order (scope batch)", async () => {
  // An event a column was the main thread's whole cost of a recording.
  const sent = [];
  const run = await script((opts) => new SimHost({ ...opts, worker: () => fakeWorker(opts.clock, sent) })); // prettier-ignore
  assert.equal(run.onWorker, true);
  const perMessage = sent.filter((m) => m.type === "events").map((m) => m.events.filter((e) => e.type === "chiphippo:sim-tick").length).filter((n) => n > 0); // prettier-ignore
  const total = perMessage.reduce((a, n) => a + n, 0);
  assert.ok(total > 50, `${total} sim-ticks sent`);
  assert.equal(run.ticks.length, total, "every tick told");
  assert.ok(run.batches.length < total / 2, `${run.batches.length} events for ${total} ticks`); // prettier-ignore
  assert.ok(run.batches.length <= perMessage.length + run.states.length, "one a run of ticks in a message"); // prettier-ignore
  // …and still in time order, each with this thread's netlist.
  for (let i = 1; i < run.ticks.length; i++) assert.ok(run.ticks[i].at >= run.ticks[i - 1].at, `column ${i}`); // prettier-ignore
  const main = await script((opts) => new SimController(opts));
  assert.deepStrictEqual(
    run.ticks,
    main.ticks,
    "the columns the main thread tells",
  );
});
