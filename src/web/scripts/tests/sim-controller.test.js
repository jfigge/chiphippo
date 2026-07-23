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

test("damage persists through Stop; Replace chip then resets it", () => {
  resetDom();
  const deskDoc = fakeDoc(poweredDoc(12));
  const sim = new SimController({
    deskDoc,
    notifications: fakeNotifications(),
  });

  sim.start();
  assert.equal(deskDoc.getComponent("c1").params.damaged, true);
  sim.stop(); // returning to editing keeps the damage
  assert.equal(deskDoc.getComponent("c1").params.damaged, true);
  sim.replaceChip("c1"); // the context-menu action clears it (not running)
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
