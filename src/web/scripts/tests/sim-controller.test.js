/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Tests for SimController — the renderer's run-state owner. It bridges the
// pure engine to the UI: Run/Stop toggling, the chiphippo:sim-state broadcast,
// 12 V damage persistence into params.damaged (an acceptance criterion), the
// magic-smoke notification, and "Replace chip" reset. The engine itself is
// proven in engine.test.js; here we cover the plumbing around it.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { partPinAddresses, partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";
import { CLOCK_HZ } from "../catalog/parts.js";

const { SimController } = await import("../components/sim-controller.js");

// ── Circuit builders (raw docs — SimController only needs toJSON) ────────────

let wireSeq = 0;
const wire = (from, to) => ({ id: `w${++wireSeq}`, from, to, color: "black" });

function chipHoles(ref, anchor) {
  const map = new Map();
  for (const { pin, hole } of partPinHoles(ref, anchor)) map.set(pin, hole);
  return map;
}
const mates = (hole) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole);

/**
 * Pin number → its seated BARE hole for a `def.can` part at `anchor` on
 * "bb1", rot 0. Unlike chipHoles, this resolves against a full document —
 * 3 of a can's 4 pins are {dx, dy} offsets from the anchor (see
 * model/occupancy.js's `def.can` branch), not footprint-derived like a
 * chip's.
 */
function canHoles(anchor, ref = "osc-full") {
  const doc = { boards: [board], components: [], wires: [] };
  const comp = { ref, board: "bb1", anchor, params: {} };
  const map = new Map();
  for (const { pin, address } of partPinAddresses(doc, comp)) {
    map.set(pin, address ? address.split(".")[1] : null);
  }
  return map;
}

const board = { id: "bb1", type: "pins-full", x: 0, y: 0 };
const psu = (id, x, volts) => ({
  id,
  kind: "psu",
  ref: "psu",
  x,
  y: 0,
  params: { volts },
});
const chip = (id, ref, anchor, params = {}) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params,
});
const part = (id, ref, anchor, params = {}) => ({
  id,
  kind: "discrete",
  ref,
  board: "bb1",
  anchor,
  params,
});
function powerWires(psuId, holes) {
  return [
    wire(`${psuId}.+`, `bb1.${mates(holes.get(14))[0]}`),
    wire(`${psuId}.-`, `bb1.${mates(holes.get(7))[0]}`),
  ];
}

/** A 74LS00 whose VCC sits on a `volts` PSU rail. */
function poweredDoc(volts) {
  const holes = chipHoles("74LS00", "e10");
  return {
    boards: [board],
    components: [psu("psu1", 80, volts), chip("c1", "74LS00", "e10")],
    wires: powerWires("psu1", holes),
  };
}

/** A minimal DeskDoc stand-in: SimController uses only these three. */
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

/** A notification-stack stub that records every call. */
function fakeNotifications() {
  const calls = [];
  return {
    calls,
    notify: (o) => calls.push(o),
    clear: () => calls.push({ cleared: true }),
  };
}

function capture() {
  const events = [];
  const handler = (e) => events.push(e.detail);
  window.addEventListener("chiphippo:sim-state", handler);
  return events;
}

test("start publishes a running sim-state and flips run state", () => {
  resetDom();
  const modes = [];
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
    onTransportChange: (m) => modes.push(m),
  });
  const events = capture();

  assert.equal(sim.running, false);
  sim.start();
  assert.equal(sim.running, true);
  assert.deepEqual(modes, ["running"]);
  assert.equal(events.at(-1).running, true);
  assert.equal(events.at(-1).chipStatus.get("c1").status, "ok");
});

test("stop clears notifications, publishes not-running, keeps run state off", () => {
  resetDom();
  const modes = [];
  const notifications = fakeNotifications();
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications,
    onTransportChange: (m) => modes.push(m),
  });
  const events = capture();

  sim.start();
  sim.stop();
  assert.equal(sim.running, false);
  assert.deepEqual(modes, ["running", "stopped"]);
  assert.equal(events.at(-1).running, false);
  assert.deepEqual(events.at(-1).netLevels, new Map()); // views clear
  assert.ok(notifications.calls.some((c) => c.cleared)); // clear() ran
});

test("pause freezes the transport; resume returns to running", () => {
  resetDom();
  const modes = [];
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
    onTransportChange: (m) => modes.push(m),
  });
  sim.start();
  sim.togglePause();
  assert.equal(sim.mode, "paused");
  sim.togglePause();
  assert.equal(sim.mode, "running");
  assert.deepEqual(modes, ["running", "paused", "running"]);
});

test("12 V damage persists into params.damaged and warns once", () => {
  resetDom();
  const notifications = fakeNotifications();
  const deskDoc = fakeDoc(poweredDoc(12));
  const sim = new SimController({ deskDoc, notifications });

  sim.start();
  // Engine reports damaged → SimController writes it through desk-doc.
  assert.equal(deskDoc.getComponent("c1").params.damaged, true);
  assert.ok(
    notifications.calls.some(
      (c) => c.variant === "danger" && /smoke/i.test(c.title),
    ),
  );
});

test("reversed power warns but is NEVER persisted as damage", () => {
  resetDom();
  const notifications = fakeNotifications();
  const holes = chipHoles("74LS00", "e10");
  const deskDoc = fakeDoc({
    boards: [board],
    components: [psu("psu1", 80, 5), chip("c1", "74LS00", "e10")],
    wires: [
      wire("psu1.+", `bb1.${mates(holes.get(7))[0]}`),
      wire("psu1.-", `bb1.${mates(holes.get(14))[0]}`),
    ],
  });
  const sim = new SimController({ deskDoc, notifications });

  sim.start();
  assert.ok(
    notifications.calls.some(
      (c) => c.variant === "danger" && /reversed/i.test(c.title),
    ),
  );
  // Swapped wires are an editing mistake, not a dead chip: rewiring must fix
  // it without a trip through "Replace chip".
  assert.notEqual(deskDoc.getComponent("c1").params.damaged, true);
});

test("damage lasts the RUN and no longer: Stop makes every chip whole", () => {
  resetDom();
  const deskDoc = fakeDoc(poweredDoc(12));
  const sim = new SimController({
    deskDoc,
    notifications: fakeNotifications(),
  });

  sim.start();
  assert.equal(
    deskDoc.getComponent("c1").params.damaged,
    true,
    "latched for the run — the engine reads the document to stay dead",
  );
  sim.stop();
  assert.equal(
    deskDoc.getComponent("c1").params.damaged,
    false,
    "a 12 V mistake must not permanently spoil the circuit it was run on",
  );
});

test("the damage clear lands BEFORE the transport change", () => {
  resetDom();
  const deskDoc = fakeDoc(poweredDoc(12));
  // Stopping re-baselines undo/redo against the live document, and app.js
  // drives that from onTransportChange — so the chips have to be whole by then
  // or the baseline keeps the damage and a ⌘Z brings the smoke back.
  const seen = [];
  const sim = new SimController({
    deskDoc,
    notifications: fakeNotifications(),
    onTransportChange: (mode) =>
      seen.push([mode, deskDoc.getComponent("c1").params.damaged]),
  });

  sim.start();
  sim.stop();
  assert.deepEqual(seen.at(-1), ["stopped", false]);
});

test("a chip burnt mid-run stays dead until the run ends", () => {
  resetDom();
  const deskDoc = fakeDoc(poweredDoc(12));
  const sim = new SimController({
    deskDoc,
    notifications: fakeNotifications(),
  });

  sim.start();
  // Clearing the flag under a live 12 V rail cannot revive anything: the doc
  // change re-ticks, the engine sees the same rail, and the latch goes back on.
  // That is the point of the latch, and it is why the clear belongs to `stop`.
  deskDoc.setComponentParams("c1", { damaged: false });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  assert.equal(deskDoc.getComponent("c1").params.damaged, true);

  sim.stop();
  assert.equal(deskDoc.getComponent("c1").params.damaged, false);
});

test("toggle alternates run state", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
  });
  sim.toggle();
  assert.equal(sim.running, true);
  sim.toggle();
  assert.equal(sim.running, false);
});

// ── Transport: clock stepping ─────────────────────────────────────────────

/** A bare doc with one free-running clock (no chips). */
const clockDoc = (hz) => ({
  boards: [],
  components: [
    { id: "clk1", kind: "clock", ref: "clock", x: 0, y: 0, params: { hz } },
  ],
  wires: [],
});

test("step advances exactly one clock half-period (L→H→L) and pauses", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc(1)),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  assert.equal(events.at(-1).clockLevels.get("clk1"), "L", "idles low");

  sim.step();
  assert.equal(sim.mode, "paused", "stepping implies paused (clocks frozen)");
  assert.equal(events.at(-1).clockLevels.get("clk1"), "H", "one half-period");

  sim.step();
  assert.equal(events.at(-1).clockLevels.get("clk1"), "L", "two → full cycle");
  sim.stop(); // clear timers
});

test("a manual clock toggles on manualToggle", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc("manual")),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  assert.equal(events.at(-1).clockLevels.get("clk1"), "L");
  sim.manualToggle("clk1");
  assert.equal(events.at(-1).clockLevels.get("clk1"), "H");
  sim.stop();
});

/** Every half-period `setInterval` is asked for while `fn()` runs. */
function captureIntervals(fn) {
  const real = globalThis.setInterval;
  const periods = [];
  globalThis.setInterval = (_cb, ms) => {
    periods.push(ms);
    // A handle stop()'s clearInterval can take, that never fires and never
    // holds the test runner open.
    const h = real(() => {}, 1e9);
    h?.unref?.();
    return h;
  };
  try {
    fn();
  } finally {
    globalThis.setInterval = real;
  }
  return periods;
}

test("every rate the picker offers is a rate the timer really runs", () => {
  // The floor on a timer's half-period is DERIVED from the top of CLOCK_HZ, so
  // a rate can never be offered that the transport quietly runs slower than —
  // which is exactly what a hand-picked floor let happen (at a flat 20 ms,
  // "50 Hz" and "100 Hz" would both have ticked at 25 and said nothing).
  for (const hz of CLOCK_HZ.filter((v) => typeof v === "number")) {
    resetDom();
    const sim = new SimController({
      deskDoc: fakeDoc(clockDoc(hz)),
      notifications: fakeNotifications(),
    });
    const periods = captureIntervals(() => sim.start());
    assert.deepEqual(periods, [1000 / (2 * hz)], `${hz} Hz at ×1`);
    sim.stop();
  }
});

test("the SPEED multiplier saturates at the fastest offered rate, both ways", () => {
  resetDom();
  const fastest = Math.max(...CLOCK_HZ.filter((v) => typeof v === "number"));
  const floor = 1000 / (2 * fastest);
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc(fastest)),
    notifications: fakeNotifications(),
  });

  sim.setSpeed(4);
  assert.deepEqual(
    captureIntervals(() => sim.start()),
    [floor],
    "×4 on the top rate asks for more edges than the app runs — it clamps",
  );
  sim.stop();

  // ×¼ is below the floor and so is honoured exactly: the clamp is a ceiling
  // on edge RATE, never a floor on the period the user asked for.
  sim.setSpeed(0.25);
  assert.deepEqual(
    captureIntervals(() => sim.start()),
    [floor * 4],
  );
  sim.stop();
});

// ── Transport: one clock's own pause ──────────────────────────────────────

/** Two free-running clocks, so one can be paused while the other runs on. */
const twoClockDoc = () => ({
  boards: [],
  components: [
    { id: "clk1", kind: "clock", ref: "clock", x: 0, y: 0, params: { hz: 1 } },
    { id: "clk2", kind: "clock", ref: "clock", x: 10, y: 0, params: { hz: 2 } },
  ],
  wires: [],
});

/** Every handle `captureTimers` has minted → its half-period, kept across
    calls so a timer started under one capture is recognised when another
    clears it. */
const periodOf = new Map();

/**
 * Run `fn` with setInterval/clearInterval recording WHICH clock's timer each
 * call touched (a timer is told apart by its half-period). No timer ever
 * fires, and none holds the runner open.
 */
function captureTimers(fn) {
  const real = { set: globalThis.setInterval, clear: globalThis.clearInterval };
  const log = { started: [], cleared: [] };
  globalThis.setInterval = (_cb, ms) => {
    const h = real.set(() => {}, 1e9);
    h?.unref?.();
    periodOf.set(h, ms);
    log.started.push(ms);
    return h;
  };
  globalThis.clearInterval = (h) => {
    if (periodOf.has(h)) log.cleared.push(periodOf.get(h));
    real.clear(h);
  };
  try {
    fn();
  } finally {
    globalThis.setInterval = real.set;
    globalThis.clearInterval = real.clear;
  }
  return log;
}

test("a paused clock HOLDS its level while the rest of the circuit runs on", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(twoClockDoc()),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  sim.step(); // both H
  sim.togglePause(); // the transport runs again; clk1 is paused on its own
  sim.toggleClockPause("clk1");
  assert.equal(sim.mode, "running", "the circuit is still running");
  assert.equal(sim.isClockPaused("clk1"), true);
  assert.deepEqual([...events.at(-1).pausedClocks], ["clk1"], "published");
  assert.equal(
    events.at(-1).clockLevels.get("clk1"),
    "H",
    "pausing makes no edge: the clock holds where it was",
  );

  // Step is the transport's edge, not a way round one clock's own pause.
  sim.step();
  assert.equal(events.at(-1).clockLevels.get("clk1"), "H", "held");
  assert.equal(events.at(-1).clockLevels.get("clk2"), "L", "the other moves");

  sim.toggleClockPause("clk1");
  assert.equal(sim.isClockPaused("clk1"), false);
  assert.deepEqual([...events.at(-1).pausedClocks], []);
  assert.equal(
    events.at(-1).clockLevels.get("clk1"),
    "H",
    "no edge out either",
  );
  sim.step();
  assert.equal(events.at(-1).clockLevels.get("clk1"), "L", "moving again");
  sim.stop();
});

test("pausing one clock touches ONLY its own timer", () => {
  // Re-scheduling the lot would restart every other clock's half-period and
  // push its next edge back — a clock nobody touched would stutter.
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(twoClockDoc()),
    notifications: fakeNotifications(),
  });
  captureTimers(() => sim.start());

  const paused = captureTimers(() => sim.toggleClockPause("clk1"));
  assert.deepEqual(paused, { started: [], cleared: [500] }, "clk1's alone");

  const resumed = captureTimers(() => sim.toggleClockPause("clk1"));
  assert.deepEqual(resumed, { started: [500], cleared: [] }, "clk1's alone");
  sim.stop();
});

test("a clock paused on its own stays held when the TRANSPORT resumes", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(twoClockDoc()),
    notifications: fakeNotifications(),
  });
  captureTimers(() => sim.start());
  sim.pause();
  // Under the transport's pause no timer runs, so there is none to stop or
  // start — but the clock's own pause is still recorded.
  const whilePaused = captureTimers(() => sim.toggleClockPause("clk1"));
  assert.deepEqual(whilePaused.started, []);
  assert.equal(sim.isClockPaused("clk1"), true);

  const resumed = captureTimers(() => sim.resume());
  assert.deepEqual(resumed.started, [250], "only clk2 starts again");
  sim.stop();
});

test("a clock's own pause is run-volatile, and refused where it means nothing", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc({
      boards: [],
      components: [
        { id: "clk1", kind: "clock", ref: "clock", x: 0, y: 0, params: { hz: 1 } }, // prettier-ignore
        { id: "clk2", kind: "clock", ref: "clock", x: 10, y: 0, params: { hz: "manual" } }, // prettier-ignore
      ],
      wires: [],
    }),
    notifications: fakeNotifications(),
  });
  const events = capture();

  sim.toggleClockPause("clk1");
  assert.equal(sim.isClockPaused("clk1"), false, "stopped: nothing to pause");

  captureTimers(() => sim.start());
  sim.toggleClockPause("clk2");
  assert.equal(sim.isClockPaused("clk2"), false, "a manual clock has no timer");

  sim.toggleClockPause("clk1");
  sim.stop();
  assert.equal(sim.isClockPaused("clk1"), false, "Stop forgets");
  assert.deepEqual([...events.at(-1).pausedClocks], [], "and says so");

  captureTimers(() => sim.start());
  assert.equal(
    sim.isClockPaused("clk1"),
    false,
    "Run starts every clock going",
  );
  sim.stop();
});

// ── Transport: board-seated oscillator can ─────────────────────

// Canonical can pin numbers (see catalog/parts.js's `def.can` defs):
// 1 NC, 2 GND, 3 OUT, 4 VCC.

/** An osc-full can, VCC/GND wired to a 5 V PSU. */
function oscDoc(hz) {
  const holes = canHoles("e10", "osc-full");
  return {
    boards: [board],
    components: [psu("psu1", 80, 5), part("c1", "osc-full", "e10", { hz })],
    wires: [
      wire("psu1.+", `bb1.${mates(holes.get(4))[0]}`), // VCC
      wire("psu1.-", `bb1.${mates(holes.get(2))[0]}`), // GND
    ],
  };
}

test("a board-seated oscillator can free-runs like a clock brick — but only while powered", () => {
  resetDom();
  const holes = canHoles("e10", "osc-full");
  const outAddr = `bb1.${holes.get(3)}`;
  const sim = new SimController({
    deskDoc: fakeDoc(oscDoc(1)),
    notifications: fakeNotifications(),
  });
  const events = capture();
  const outLevel = () => {
    const e = events.at(-1);
    return e.netLevels.get(e.netlist.netOfPoint.get(outAddr));
  };

  sim.start();
  assert.equal(events.at(-1).chipStatus.get("c1").status, "ok");
  assert.equal(events.at(-1).clockLevels.get("c1"), "L", "idles low");
  assert.equal(outLevel(), "L");

  sim.step();
  assert.equal(events.at(-1).clockLevels.get("c1"), "H", "one half-period");
  assert.equal(outLevel(), "H", "the output net follows, power-gated by VCC");
  sim.stop();
});

test("an unpowered oscillator can is scheduled but the engine gates its output", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc({
      boards: [board],
      components: [part("c1", "osc-full", "e10", { hz: 1 })], // no PSU wired
      wires: [],
    }),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  // The transport still schedules it (clockLevels carries an entry) — power
  // gating is the ENGINE's concern (chipStatus), not the transport's.
  assert.ok(events.at(-1).clockLevels.has("c1"));
  assert.equal(events.at(-1).chipStatus.get("c1").status, "unpowered");
  sim.stop();
});

// ── External signals (Feature 370) ──────────────────────────────────────────
// The transport owns the LEVEL a signal holds — run-volatile, exactly like a
// clock phase — and `pressSignal` is the one place momentary/toggle is decided,
// so the rail's pointer and the digit keys can never come to disagree.

const signalDoc = (signals) => ({
  boards: [board],
  components: [],
  wires: [],
  signals,
});
const sig = (id, extra = {}) => ({
  id,
  color: "red",
  type: "momentary",
  rest: "low",
  flag: { anchor: "bb1.a12", rot: 0 },
  ...extra,
});

test("signals seed from `rest` on start and clear on stop (run-volatile)", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(
      signalDoc([sig("sig1"), sig("sig2", { rest: "high", color: "blue" })]),
    ),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  assert.deepEqual(
    [...events.at(-1).signalLevels],
    [
      ["sig1", "L"],
      ["sig2", "H"],
    ],
  );
  sim.stop();
  assert.equal(events.at(-1).signalLevels.size, 0, "cleared on stop");
});

test("a MOMENTARY signal asserts the opposite of rest, and returns", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1", { rest: "high" })])),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  const level = () => events.at(-1).signalLevels.get("sig1");
  assert.equal(level(), "H", "rest high");
  sim.pressSignal("sig1", true);
  assert.equal(level(), "L", "held → the other one");
  sim.pressSignal("sig1", false);
  assert.equal(level(), "H", "released → back to rest");
});

test("a TOGGLE latches on the press and ignores the release", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1", { type: "toggle" })])),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  const level = () => events.at(-1).signalLevels.get("sig1");
  assert.equal(level(), "L");
  sim.pressSignal("sig1", true);
  assert.equal(level(), "H");
  sim.pressSignal("sig1", false);
  assert.equal(level(), "H", "the release does nothing");
  sim.pressSignal("sig1", true);
  assert.equal(level(), "L", "the next press flips it back");
});

test("a toggle does NOT survive a Run — `rest` is the one durable answer", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1", { type: "toggle" })])),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  sim.pressSignal("sig1", true);
  assert.equal(events.at(-1).signalLevels.get("sig1"), "H");
  sim.stop();
  sim.start();
  assert.equal(events.at(-1).signalLevels.get("sig1"), "L", "back to rest");
});

test("pressSignal is inert while stopped, and ignores an unknown id", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1")])),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.pressSignal("sig1", true); // stopped
  assert.equal(events.length, 0, "nothing published");
  sim.start();
  const before = events.length;
  sim.pressSignal("nope", true);
  assert.equal(events.length, before, "an unknown signal ticks nothing");
});

test("an UNPLACED signal still holds a level — it simply drives no net", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([{ ...sig("sig1"), flag: undefined }])),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  sim.pressSignal("sig1", true);
  assert.equal(events.at(-1).signalLevels.get("sig1"), "H");
});
