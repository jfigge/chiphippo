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
import { FRAME_MS } from "../components/sim-pacer.js";

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
    dismiss: (key) => calls.push({ dismissed: key }),
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
  // Stop takes down its OWN toasts, never the whole stack.
  assert.ok(!notifications.calls.some((c) => c.cleared));
});

test("Stop dismisses the run's toasts and leaves everyone else's", () => {
  resetDom();
  const notifications = fakeNotifications();
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(12)), // 12 V: the chip lets its smoke out
    notifications,
  });
  sim.start();
  const raised = notifications.calls.filter((c) => c.key).map((c) => c.key);
  assert.ok(raised.length > 0, "the run raised something");
  sim.stop();
  const dismissed = notifications.calls
    .filter((c) => c.dismissed)
    .map((c) => c.dismissed);
  assert.deepEqual(dismissed.sort(), [...new Set(raised)].sort());
  // The updater's sticky Restart offer, the auto-route Cancel: not the sim's
  // to take down, and a whole-stack clear used to.
  assert.ok(!notifications.calls.some((c) => c.cleared));
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

test("the engine reads one document snapshot per change, never one per tick", () => {
  resetDom();
  // A DeskDoc's toJSON hands out a COPY, as the real one does.
  const doc = JSON.parse(JSON.stringify(poweredDoc(5)));
  let reads = 0;
  const deskDoc = {
    toJSON: () => (reads++, structuredClone(doc)),
    getComponent: (id) => doc.components.find((c) => c.id === id) ?? null,
    setComponentParams(id, patch) {
      const c = doc.components.find((x) => x.id === id);
      c.params = { ...c.params, ...patch };
      return c;
    },
  };
  const sim = new SimController({ deskDoc, notifications: fakeNotifications() }); // prettier-ignore
  const events = capture();
  sim.start();
  sim.step();
  const settled = reads;
  sim.step();
  sim.step();
  sim.step();
  assert.equal(reads, settled, "ticks with nothing changed re-read nothing");
  assert.equal(events.at(-1).chipStatus.get("c1").status, "ok");

  // A change is read at once: 12 V on the rail smokes the chip…
  deskDoc.setComponentParams("psu1", { volts: 12 });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  assert.ok(reads > settled);
  assert.equal(events.at(-1).chipStatus.get("c1").status, "damaged");
  // …and the damage the controller wrote is in the next tick's snapshot:
  // back at 5 V the chip stays dead for the rest of the run.
  deskDoc.setComponentParams("psu1", { volts: 5 });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  sim.step();
  assert.equal(doc.components.find((c) => c.id === "c1").params.damaged, true);
  assert.equal(events.at(-1).chipStatus.get("c1").status, "damaged");
  sim.stop();
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

/** Clock bricks, each with a bench supply wired straight to its `vcc` and
    `gnd` — a clock with no power stops, and its lamp stays dark. */
const poweredClocks = (clocks) => ({
  components: [
    ...clocks,
    ...clocks.map((c, i) => ({ id: `psu${i + 1}`, kind: "psu", ref: "psu", x: c.x, y: 20, params: { volts: 5 } })), // prettier-ignore
  ],
  wires: clocks.flatMap((c, i) => [
    { id: `wv${i}`, from: `psu${i + 1}.+`, to: `${c.id}.vcc`, color: "red" },
    { id: `wg${i}`, from: `psu${i + 1}.-`, to: `${c.id}.gnd`, color: "black" },
  ]),
});

/** A bare doc with one free-running clock (no chips). */
const clockDoc = (hz) => ({
  boards: [],
  ...poweredClocks([
    { id: "clk1", kind: "clock", ref: "clock", x: 0, y: 0, params: { hz } },
  ]),
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

test("an unpowered clock is shown stopped, whatever its timer does", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc({
      boards: [],
      components: [
        { id: "clk1", kind: "clock", ref: "clock", x: 0, y: 0, params: { hz: 1 } }, // prettier-ignore
      ],
      wires: [],
    }),
    notifications: fakeNotifications(),
  });
  const events = capture();
  sim.start();
  sim.step();
  assert.equal(
    events.at(-1).clockLevels.get("clk1"),
    "L",
    "its lamp stays dark",
  );
  sim.stop();
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

/**
 * A wall clock and a timer the test drives. `advance(ms)` fires every timer
 * due on the way, in order, the clock standing at each one's moment; `cost`
 * ms pass on every reading, as if the work being timed took that long.
 */
function fakeClock({ cost = 0 } = {}) {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    now() {
      const t = now;
      now += cost;
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

/** Every tick's simulated moment, from `chiphippo:sim-tick`. */
function captureTicks() {
  const at = [];
  window.addEventListener("chiphippo:sim-tick", (e) => at.push(e.detail.at));
  return at;
}

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`); // prettier-ignore

test("every rate the picker offers runs at its TRUE rate — no timer floor", () => {
  // Edges come in batches between frames (features/done/batched-ticks.md), so
  // nothing caps the rate but what a batch can do: 1 kHz is 2000 edges a
  // second, each at its own exact moment.
  for (const hz of CLOCK_HZ.filter((v) => typeof v === "number")) {
    resetDom();
    const clock = fakeClock();
    const sim = new SimController({
      deskDoc: fakeDoc(clockDoc(hz)),
      notifications: fakeNotifications(),
      clock,
    });
    const ticks = captureTicks();
    sim.start();
    clock.advance(1100);
    const edges = ticks.slice(1).filter((t) => t <= 1 + 1e-9);
    assert.equal(edges.length, 2 * hz, `${hz} Hz at ×1`);
    edges.forEach((t, i) => close(t, (i + 1) / (2 * hz), `${hz} Hz edge ${i + 1}`)); // prettier-ignore
    sim.stop();
  }
});

test("the SPEED multiplier scales simulated time — 1 kHz at ×4 is 8000 edges a second", () => {
  for (const [speed, edges] of [
    [4, 8000],
    [0.25, 500],
  ]) {
    resetDom();
    const clock = fakeClock();
    const sim = new SimController({
      deskDoc: fakeDoc(clockDoc(1000)),
      notifications: fakeNotifications(),
      clock,
    });
    sim.setSpeed(speed);
    const ticks = captureTicks();
    sim.start();
    clock.advance(1000);
    assert.equal(
      ticks.slice(1).filter((t) => t <= speed + 1e-9).length,
      edges,
      `×${speed}`,
    );
    sim.stop();
  }
});

test("a batch runs every edge due but tells the views ONCE", () => {
  resetDom();
  const clock = fakeClock();
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc(1000)),
    notifications: fakeNotifications(),
    clock,
  });
  const ticks = captureTicks();
  const states = capture();
  sim.start();
  clock.advance(1000);
  assert.ok(ticks.length >= 2000, `${ticks.length} ticks`);
  assert.ok(
    states.length <= 1000 / FRAME_MS + 2,
    `${states.length} sim-states for ${ticks.length} ticks`,
  );
  // The views see the LAST tick of each batch: the lamp is where the clock is
  // — once what is owed has gone out (a batch's board waits for the next
  // PUBLISH_MS frame; a pause sends it at once).
  sim.pause();
  const flips = ticks.length - 1;
  assert.equal(states.at(-1).clockLevels.get("clk1"), flips % 2 ? "H" : "L");
  sim.stop();
});

test("sim-state says how fast the desk toggles — the fastest clock, times the speed", () => {
  resetDom();
  const clock = fakeClock();
  const sim = new SimController({
    deskDoc: fakeDoc(twoClockDoc()),
    notifications: fakeNotifications(),
    clock,
  });
  const states = capture();
  sim.start();
  assert.equal(states.at(-1).fastestHz, 2, "clk2's 2 Hz");
  sim.setSpeed(4);
  clock.advance(500);
  assert.equal(states.at(-1).fastestHz, 8, "×4");
  sim.toggleClockPause("clk2");
  assert.equal(states.at(-1).fastestHz, 4, "a paused clock toggles nothing");
  sim.stop();
  assert.equal(states.at(-1).fastestHz, 0, "stopped");
});

test("a desk too busy to keep up runs slower — and says by how much", () => {
  resetDom();
  // Every reading of the wall clock costs half a millisecond: a batch's
  // budget runs out long before 8000 edges a second are done.
  const clock = fakeClock({ cost: 0.5 });
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc(1000)),
    notifications: fakeNotifications(),
    clock,
  });
  sim.setSpeed(4);
  const ticks = captureTicks();
  const states = capture();
  sim.start();
  clock.advance(1500);
  const behind = states.at(-1).behind;
  assert.ok(behind != null && behind < 4 * 0.95, `achieved ×${behind}`);
  assert.ok(ticks.at(-1) < 4, "simulated time fell behind the wall clock's");
  // Edges are dropped, never bunched: each still lands half a period on
  // from the last.
  for (let i = 2; i < ticks.length; i++) {
    close(ticks[i] - ticks[i - 1], 1 / 2000, `edge ${i}`);
  }
  sim.stop();
});

// ── Transport: one clock's own pause ──────────────────────────────────────

/** Two free-running clocks, so one can be paused while the other runs on. */
const twoClockDoc = () => ({
  boards: [],
  ...poweredClocks([
    { id: "clk1", kind: "clock", ref: "clock", x: 0, y: 0, params: { hz: 1 } },
    { id: "clk2", kind: "clock", ref: "clock", x: 10, y: 0, params: { hz: 2 } },
  ]),
});

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

test("pausing one clock leaves every other clock's edges where they were", () => {
  // Re-scheduling the lot would restart every other clock's half-period and
  // push its next edge back — a clock nobody touched would stutter.
  resetDom();
  const clock = fakeClock();
  const sim = new SimController({
    deskDoc: fakeDoc(twoClockDoc()),
    notifications: fakeNotifications(),
    clock,
  });
  const ticks = captureTicks();
  sim.start();
  clock.advance(300);
  sim.toggleClockPause("clk1"); // an input tick at 0.3 s
  const from = ticks.length;
  clock.advance(1000); // to 1.3 s
  [0.5, 0.75, 1, 1.25].forEach((t, i) => close(ticks[from + i], t, "clk2 on its grid")); // prettier-ignore
  assert.equal(ticks.length, from + 4);

  sim.toggleClockPause("clk1"); // clk1 again, from 1.3 s
  clock.advance(600); // to 1.9 s
  const after = ticks.slice(from + 5);
  [1.5, 1.75, 1.8].forEach((t, i) => close(after[i], t, "clk2's grid kept, clk1 from its resume")); // prettier-ignore
  sim.stop();
});

test("an edit while running retimes only the clock it changed", () => {
  // Every switch flip is a doc change. Restarting every clock on each one put
  // every clock's next edge back by a whole half-period — flip a switch faster
  // than a slow clock's half-period and that clock never ticked at all.
  resetDom();
  const raw = twoClockDoc();
  const deskDoc = fakeDoc(raw);
  const clock = fakeClock();
  const sim = new SimController({
    deskDoc,
    notifications: fakeNotifications(),
    clock,
  });
  const ticks = captureTicks();
  sim.start();
  const flip = () =>
    window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));

  // Nothing about a clock changed: both keep their grids.
  clock.advance(200);
  flip(); // ticks at 0.2
  let from = ticks.length;
  clock.advance(100); // to 0.3: clk2 at 0.25
  close(ticks[from], 0.25, "clk2 untouched");

  // clk2 re-rated at 0.35 s: its edges run from there; clk1 keeps 0.5, 1.0.
  clock.advance(50);
  deskDoc.setComponentParams("clk2", { hz: 5 });
  flip();
  from = ticks.length;
  clock.advance(400); // to 0.75
  [0.45, 0.5, 0.55, 0.65, 0.75].forEach((t, i) => close(ticks[from + i], t, "clk2 at 5 Hz from 0.35; clk1 at 0.5")); // prettier-ignore

  // clk1 deleted: its edge at 1.0 never comes.
  deskDoc.toJSON().components.splice(0, 1);
  flip();
  from = ticks.length;
  clock.advance(300); // to 1.05
  assert.deepEqual(
    ticks.slice(from).map((t) => Math.round(t * 100) / 100),
    [0.85, 0.95, 1.05],
  );
  sim.stop();
});

test("a clock paused on its own stays held when the TRANSPORT resumes", () => {
  resetDom();
  const clock = fakeClock();
  const sim = new SimController({
    deskDoc: fakeDoc(twoClockDoc()),
    notifications: fakeNotifications(),
    clock,
  });
  const states = capture();
  sim.start();
  sim.pause();
  // Under the transport's pause nothing runs — but the clock's own pause is
  // still recorded.
  sim.toggleClockPause("clk1");
  assert.equal(sim.isClockPaused("clk1"), true);
  const from = states.length;
  sim.resume();
  clock.advance(2000);
  const seen = states.slice(from);
  assert.ok(
    seen.every((s) => s.clockLevels.get("clk1") === "L"),
    "clk1 held",
  );
  assert.ok(
    seen.some((s) => s.clockLevels.get("clk2") === "H"),
    "clk2 runs",
  );
  sim.stop();
});

test("a clock's own pause is run-volatile, and refused where it means nothing", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc({
      boards: [],
      ...poweredClocks([
        { id: "clk1", kind: "clock", ref: "clock", x: 0, y: 0, params: { hz: 1 } }, // prettier-ignore
        { id: "clk2", kind: "clock", ref: "clock", x: 10, y: 0, params: { hz: "manual" } }, // prettier-ignore
      ]),
    }),
    notifications: fakeNotifications(),
    clock: fakeClock(),
  });
  const events = capture();

  sim.toggleClockPause("clk1");
  assert.equal(sim.isClockPaused("clk1"), false, "stopped: nothing to pause");

  sim.start();
  sim.toggleClockPause("clk2");
  assert.equal(sim.isClockPaused("clk2"), false, "a manual clock has no timer");

  sim.toggleClockPause("clk1");
  sim.stop();
  assert.equal(sim.isClockPaused("clk1"), false, "Stop forgets");
  assert.deepEqual([...events.at(-1).pausedClocks], [], "and says so");

  sim.start();
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

// ── The settle boundary (the Arduino serial integration) ────────────────────
// The one moment an outside party may look at the board or change it. A
// collaborator hears every boundary, may put levels on the board (`again`),
// may STALL it on a promise, may refuse a Run, gate the first tick, and hears
// Stop — and the engine knows none of it.

/** A scriptable integration collaborator that records what it was told. */
function fakeIntegration(overrides = {}) {
  const log = { settled: [], ended: 0, begun: 0, preflights: 0 };
  return {
    log,
    preflight: (doc) => {
      log.preflights++;
      return overrides.preflight ? overrides.preflight(doc) : true;
    },
    begin: (doc) => {
      log.begun++;
      return overrides.begin ? overrides.begin(doc) : null;
    },
    settled: (ctx) => {
      log.settled.push(ctx);
      return overrides.settled ? overrides.settled(ctx, log) : null;
    },
    levels: () => overrides.levels?.() ?? new Map(),
    end: () => {
      log.ended++;
    },
  };
}

/** Resolve after the microtask queue drains (promise `.then` chains). */
const flush = () => new Promise((r) => setTimeout(r, 0));

test("every settle is reported at the boundary, with the settled board", () => {
  resetDom();
  const integration = fakeIntegration();
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1")])),
    notifications: fakeNotifications(),
    integration,
  });
  const events = capture();
  sim.start();
  sim.pressSignal("sig1", true);
  assert.equal(integration.log.settled.length, 2, "one per tick");
  const last = integration.log.settled.at(-1);
  assert.ok(last.document.signals, "the document it settled");
  assert.ok(last.netlist.netOfPoint instanceof Map, "the netlist");
  assert.equal(
    last.netLevels,
    events.at(-1).netLevels,
    "the SAME levels published",
  );
  const net = last.netlist.netOfPoint.get("bb1.a12");
  assert.equal(
    last.netLevels.get(net),
    "H",
    "the signal's press is on the board",
  );
});

test("`again` runs one more settle straight away — once", () => {
  resetDom();
  let asked = 0;
  const integration = fakeIntegration({
    settled: () => (++asked === 1 ? { again: true } : null),
  });
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1")])),
    notifications: fakeNotifications(),
    integration,
  });
  sim.start();
  assert.equal(integration.log.settled.length, 2);
});

test("a collaborator that always says `again` cannot spin the renderer", () => {
  resetDom();
  const integration = fakeIntegration({ settled: () => ({ again: true }) });
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1")])),
    notifications: fakeNotifications(),
    integration,
  });
  sim.start();
  assert.ok(integration.log.settled.length <= 32);
});

test("levels() drive the board alongside the signals' own", () => {
  resetDom();
  const doc = {
    boards: [board],
    components: [],
    wires: [],
    signals: [],
    integrations: [
      {
        id: "in1",
        kind: "input",
        fields: [{ type: "bit", name: "a" }],
        tags: { 1: { anchor: "bb1.a20", rot: 0 } },
      },
    ],
  };
  let level = "L";
  const integration = fakeIntegration({
    levels: () => new Map([["in1:1", level]]),
  });
  const sim = new SimController({
    deskDoc: fakeDoc(doc),
    notifications: fakeNotifications(),
    integration,
  });
  const events = capture();
  sim.start();
  const at = () => {
    const d = events.at(-1);
    return d.netLevels.get(d.netlist.netOfPoint.get("bb1.a20"));
  };
  assert.equal(at(), "L");
  level = "H";
  sim.wake();
  assert.equal(at(), "H", "wake() settles whatever the integration now holds");
});

test("a STALL holds every tick until it resolves, then settles once", async () => {
  resetDom();
  let release = null;
  let stallNext = true;
  const integration = fakeIntegration({
    settled: () => {
      if (!stallNext) return null;
      stallNext = false;
      return new Promise((r) => (release = r));
    },
  });
  const sim = new SimController({
    deskDoc: fakeDoc(
      signalDoc([sig("sig1"), sig("sig2", { flag: undefined })]),
    ),
    notifications: fakeNotifications(),
    integration,
  });
  const events = capture();
  sim.start();
  assert.equal(sim.stalled, true);
  const published = events.length;
  sim.pressSignal("sig1", true);
  sim.pressSignal("sig2", true);
  sim.wake();
  assert.equal(events.length, published, "nothing settles while stalled");
  release({ again: false });
  await flush();
  assert.equal(sim.stalled, false);
  assert.equal(events.length, published + 1, "the held input settles ONCE");
  assert.equal(events.at(-1).signalLevels.get("sig1"), "H");
});

test("a stall resolving `again` settles again even with nothing held", async () => {
  resetDom();
  let n = 0;
  const integration = fakeIntegration({
    settled: () => (++n === 1 ? Promise.resolve({ again: true }) : null),
  });
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1")])),
    notifications: fakeNotifications(),
    integration,
  });
  sim.start();
  await flush();
  assert.equal(integration.log.settled.length, 2);
});

test("clock edges due during a stall are SKIPPED, not queued", async () => {
  resetDom();
  let release = null;
  const integration = fakeIntegration({
    settled: (_ctx, log) =>
      log.settled.length === 1 ? new Promise((r) => (release = r)) : null,
  });
  const clockDoc = {
    boards: [board],
    ...poweredClocks([
      {
        id: "clk1",
        kind: "clock",
        ref: "clock",
        x: 40,
        y: 0,
        params: { hz: 100 },
      },
    ]),
  };
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc),
    notifications: fakeNotifications(),
    integration,
  });
  const events = capture();
  sim.start();
  const published = events.length;
  await new Promise((r) => setTimeout(r, 60)); // several half-periods at 100 Hz
  assert.equal(events.length, published, "no edge ticked while stalled");
  release(null);
  await flush();
  const after = events.length;
  assert.ok(
    after - published <= 1,
    "and none were saved up to burst out after",
  );
  sim.stop();
});

test("preflight can refuse a Run — nothing starts, nothing locks", async () => {
  resetDom();
  const modes = [];
  const integration = fakeIntegration({ preflight: () => false });
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
    onTransportChange: (m) => modes.push(m),
    integration,
  });
  sim.start();
  assert.equal(sim.running, false);
  assert.deepEqual(modes, []);

  const later = fakeIntegration({ preflight: () => Promise.resolve(false) });
  const sim2 = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
    onTransportChange: (m) => modes.push(m),
    integration: later,
  });
  await sim2.start();
  assert.equal(sim2.running, false);
  assert.deepEqual(modes, []);
});

test("an async preflight that passes starts the run", async () => {
  resetDom();
  const integration = fakeIntegration({
    preflight: () => Promise.resolve(true),
  });
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
    integration,
  });
  await sim.start();
  assert.equal(sim.running, true);
  assert.equal(integration.log.begun, 1);
});

test("a Stop while an async preflight is still checking cancels the Run", async () => {
  // A tab switch or a New/Open stops the sim while the port scan is out; the
  // transport still reads stopped then, but the Run must not start after it.
  resetDom();
  let answer = null;
  const integration = fakeIntegration({
    preflight: () => new Promise((r) => (answer = r)),
  });
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
    integration,
  });
  const pending = sim.start();
  sim.stop();
  answer(true);
  await pending;
  assert.equal(sim.running, false);
  assert.equal(integration.log.begun, 0);
});

test("a desk edited while its preflight checks is checked again before it runs", async () => {
  resetDom();
  const seen = [];
  let answer = null;
  const integration = fakeIntegration({
    preflight: (doc) => {
      seen.push(doc.wires.length);
      return seen.length === 1
        ? new Promise((r) => (answer = r))
        : Promise.resolve(true);
    },
  });
  const deskDoc = fakeDoc(poweredDoc(5));
  const sim = new SimController({
    deskDoc,
    notifications: fakeNotifications(),
    integration,
  });
  const pending = sim.start();
  const before = seen[0];
  deskDoc.toJSON().wires.pop(); // an edit while the ports are scanned
  answer(true);
  await pending;
  assert.deepEqual(seen, [before, before - 1], "the edited desk was checked");
  assert.equal(sim.running, true);
  assert.equal(integration.log.begun, 1);
  sim.stop();
});

test("begin gates the first tick, and a `false` answer stops the run", async () => {
  resetDom();
  let open = null;
  const integration = fakeIntegration({
    begin: () => new Promise((r) => (open = r)),
  });
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
    integration,
  });
  const events = capture();
  const started = sim.start();
  assert.equal(sim.running, true, "the desk locks while ports open");
  assert.equal(integration.log.settled.length, 0, "no tick before the gate");
  open(true);
  await started;
  assert.equal(integration.log.settled.length, 1);
  assert.equal(events.at(-1).running, true);

  const refusing = fakeIntegration({ begin: () => Promise.resolve(false) });
  const sim2 = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
    integration: refusing,
  });
  await sim2.start();
  assert.equal(sim2.running, false);
  assert.equal(refusing.log.settled.length, 0);
  assert.equal(refusing.log.ended, 1, "Stop is heard, so ports close");
});

test("Stop is heard, and a stall that resolves after it changes nothing", async () => {
  resetDom();
  let release = null;
  const integration = fakeIntegration({
    settled: (_c, log) =>
      log.settled.length === 1 ? new Promise((r) => (release = r)) : null,
  });
  const sim = new SimController({
    deskDoc: fakeDoc(signalDoc([sig("sig1")])),
    notifications: fakeNotifications(),
    integration,
  });
  const events = capture();
  sim.start();
  sim.stop();
  assert.equal(integration.log.ended, 1);
  assert.equal(sim.stalled, false);
  const published = events.length;
  release({ again: true });
  await flush();
  assert.equal(events.length, published, "a stale stall does not tick");
  assert.equal(sim.running, false);
});

test("Spice Lite: the setting picks the engine at Run, never mid-run", () => {
  resetDom();
  const sim = new SimController({
    deskDoc: fakeDoc(poweredDoc(5)),
    notifications: fakeNotifications(),
  });
  const events = capture();
  assert.equal(sim.engineId, "digital", "the digital engine before any Run");

  sim.setSpiceLite({ enabled: true });
  assert.equal(sim.engineId, "digital", "the setting alone switches nothing");
  sim.start();
  assert.equal(sim.engineId, "spice", "Run reads the setting");
  // The views are none the wiser: the same sim-state, the same verdicts.
  assert.equal(events.at(-1).chipStatus.get("c1").status, "ok");

  sim.setSpiceLite({ enabled: false });
  assert.equal(
    sim.engineId,
    "spice",
    "a toggle mid-run waits for the next Run",
  );
  sim.stop();
  sim.start();
  assert.equal(sim.engineId, "digital");
  sim.stop();
});

test("Spice Lite: the numbers are the Run's too — an edit mid-run waits", async () => {
  resetDom();
  const { bench } = await import("./timing-fixtures.js");
  // A CD4069UB output held LOW and wired straight to VCC: it saturates at
  // 4.2 mA, 21 mW in its output transistor — within the 50 mW it is made for.
  const b = bench();
  const drv = b.seat("u1", "CD4069UB", "e10");
  b.vcc(drv.get(14));
  b.gnd(drv.get(7));
  b.signal("in", drv.get(1), "high");
  b.vcc(drv.get(2));
  const deskDoc = fakeDoc(b.doc);
  const sim = new SimController({
    deskDoc,
    notifications: fakeNotifications(),
  });
  sim.setSpiceLite({ enabled: true });
  sim.start();
  // A sink current five times the family's makes that a 105 mW short: brown
  // smoke — but not for a circuit the user did nothing to, mid-run.
  sim.setSpiceLite({ enabled: true, families: { CD4000: { sinkMa: 5 } } });
  sim.step();
  assert.notEqual(deskDoc.getComponent("u1").params.overloaded, true);
  sim.stop();
  sim.start(); // the next Run takes it
  assert.equal(deskDoc.getComponent("u1").params.overloaded, true);
  sim.stop();
});

test("Spice Lite: a supply spike names the supply as a supply, not its ref", async () => {
  resetDom();
  const { bench } = await import("./timing-fixtures.js");
  // Six inverters switching together on a 100 mA supply already held near
  // its limit by a 51 Ω load (spice-decoupling.test.js's desk).
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.signal("in", u.get(1), "low");
  for (const [from, to] of [
    [1, 3],
    [3, 5],
    [5, 9],
    [9, 11],
    [11, 13],
  ]) {
    b.link(u.get(from), u.get(to));
  }
  const load = b.seat("r1", "resistor", "a40", { ohms: 51 });
  b.vcc(load.get(1));
  b.gnd(load.get(2));
  b.doc.components[0].params.currentLimit = 0.1;
  const notifications = fakeNotifications();
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications });
  sim.setSpiceLite({ enabled: true });
  sim.start();
  sim.step();
  sim.pressSignal("in", true);
  const spike = notifications.calls.find((c) => c.key === "spike:psu1");
  assert.ok(spike, "the spike is said");
  assert.match(spike.message, /^Power supply \(psu1\)/);
  sim.stop();
});

test("Spice Lite: brown smoke latches for the run, says so, and Stop clears it", async () => {
  resetDom();
  const { bench } = await import("./timing-fixtures.js");
  // A 74LS04 output held LOW and wired straight to VCC: about 190 mA through
  // the pin, past the 100 mA it survives.
  const b = bench();
  const drv = b.seat("u1", "74LS04", "e10");
  b.vcc(drv.get(14));
  b.gnd(drv.get(7));
  b.vcc(drv.get(1));
  b.vcc(drv.get(2));
  const notifications = fakeNotifications();
  const deskDoc = fakeDoc(b.doc);
  const sim = new SimController({ deskDoc, notifications });
  sim.setSpiceLite({ enabled: true });
  const events = capture();
  sim.start();
  assert.equal(deskDoc.getComponent("u1").params.overloaded, true);
  assert.ok(
    notifications.calls.some(
      (c) => c.variant === "danger" && c.key === "output:u1",
    ),
  );
  assert.ok(events.at(-1).supplies.has("psu1"), "the PSU's readout data");
  sim.stop();
  assert.notEqual(deskDoc.getComponent("u1").params.overloaded, true);
});

test("Spice Lite: a brownout, a switch and a transistor are said", async () => {
  resetDom();
  const { bench } = await import("./timing-fixtures.js");
  const b = bench();
  // A 74LS HIGH into 100 Ω, read by 2A: a brownout.
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.gnd(u.get(1));
  b.link(u.get(2), u.get(3));
  const r = b.seat("r1", "resistor", "a30", { ohms: 100 });
  b.link(r.get(1), u.get(2));
  b.gnd(r.get(2));
  // A CD4066B channel switched on straight across the rails: 10.6 mA.
  const sw = b.seat("u2", "CD4066B", "e40");
  b.vcc(sw.get(14));
  b.gnd(sw.get(7));
  b.vcc(sw.get(13));
  b.vcc(sw.get(1));
  b.gnd(sw.get(2));
  // An N-channel TO-92 on, 10 Ω from VCC: about 200 mW.
  const q = b.seat("q1", "nmos", "a50", { case: "TO-92" });
  b.gnd(q.get(1));
  b.vcc(q.get(2));
  const rq = b.seat("r2", "resistor", "a55", { ohms: 10 });
  b.link(rq.get(1), q.get(3));
  b.vcc(rq.get(2));
  const notifications = fakeNotifications();
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications });
  sim.setSpiceLite({ enabled: true });
  sim.start();
  const keys = notifications.calls.map((c) => c.key);
  for (const key of ["brownout:u1", "switch:u2", "transistor:q1"]) {
    assert.ok(keys.includes(key), `${key} in ${keys}`);
  }
  for (const c of notifications.calls) {
    assert.ok(!/\{\w+\}/.test(c.message), `filled: ${c.message}`);
  }
  sim.stop();
});

// ── Batches against a device, a pause, re-entry, an edit's catch-up ─────────

/** Let promise chains run (a stall's `.then` → #endStall) without moving any
    clock — real or fake. */
const settleMicrotasks = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

test("an Arduino answering every edge keeps the run at its rate, frames still capped", async () => {
  // Every edge stalls on the device and is acknowledged at once. A stall's
  // end used to wait out a whole frame since the board it stalled on was
  // shown — one edge per FRAME_MS, 125 a second whatever the clock asked.
  resetDom();
  const clock = fakeClock();
  const integration = fakeIntegration({ settled: () => Promise.resolve(null) });
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc(1000)),
    notifications: fakeNotifications(),
    integration,
    clock,
  });
  const ticks = captureTicks();
  const states = capture();
  sim.start();
  await settleMicrotasks();
  for (let i = 0; i < 400; i++) {
    clock.advance(0.25); // 100 ms of wall in all: 200 edges at 1 kHz
    await settleMicrotasks();
  }
  assert.ok(ticks.length >= 190, `${ticks.length} ticks in 100 ms`);
  assert.ok(
    states.length <= 100 / FRAME_MS + 3,
    `${states.length} sim-states — still no oftener than a frame`,
  );
  sim.stop();
});

test("a run held back by its device says it is behind", async () => {
  // The device takes 2 ms to acknowledge each edge of a 1 kHz clock: half a
  // millisecond of simulated time per 2.5 of wall. A stall's frozen stretch
  // used to reset the meter, so the speed button never said.
  resetDom();
  const clock = fakeClock();
  const integration = fakeIntegration({
    settled: () => new Promise((r) => clock.setTimeout(r, 2)),
  });
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc(1000)),
    notifications: fakeNotifications(),
    integration,
    clock,
  });
  const states = capture();
  sim.start();
  await settleMicrotasks();
  for (let i = 0; i < 1500; i++) {
    clock.advance(1);
    await settleMicrotasks();
  }
  const behind = states.at(-1).behind;
  assert.ok(behind != null && behind < 0.5, `achieved ×${behind}`);
  sim.stop();
});

test("Pause drops the behind readout and the flat lamps at once; a Step glows", () => {
  resetDom();
  const clock = fakeClock({ cost: 0.5 });
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc(1000)),
    notifications: fakeNotifications(),
    clock,
  });
  sim.setSpeed(4);
  const states = capture();
  sim.start();
  clock.advance(1500);
  assert.ok(states.at(-1).behind != null, "behind while running");
  assert.ok(states.at(-1).fastestHz > 25, "flat while running");
  const from = states.length;
  sim.pause();
  assert.ok(states.length > from, "the pause itself is published");
  assert.equal(states.at(-1).mode, "paused");
  assert.equal(states.at(-1).behind, null, "nothing is behind while paused");
  assert.equal(states.at(-1).fastestHz, 0, "nothing toggles while paused");
  sim.step();
  assert.equal(states.at(-1).fastestHz, 0, "a hand-made step glows");
  sim.stop();
});

test("an input re-entering a batch is folded into it, not published on its own", () => {
  // A device (or a sim-tick listener) waking the board from INSIDE a batch.
  // The batch is already catching up, so the wake's catch-up does nothing,
  // and its tick is the batch's to publish at its end — a nested batch used
  // to clear the one batch flag on its way out, and the wake's tick (and any
  // after it) went out on its own.
  resetDom();
  const clock = fakeClock();
  let sim = null;
  let batching = false; // set once Run's own tick is done: ticks are a batch's
  let inWake = false;
  const midBatch = []; // sim-states published by each mid-batch wake
  let states = [];
  const integration = fakeIntegration({
    settled: () => {
      if (batching && !inWake) {
        inWake = true;
        const before = states.length;
        sim.wake();
        midBatch.push(states.length - before);
        inWake = false;
      }
      return null;
    },
  });
  sim = new SimController({
    deskDoc: fakeDoc(clockDoc(1000)),
    notifications: fakeNotifications(),
    integration,
    clock,
  });
  const ticks = captureTicks();
  states = capture();
  sim.start();
  batching = true;
  clock.advance(1000);
  assert.ok(ticks.length >= 2000, `${ticks.length} ticks`);
  assert.ok(midBatch.length > 100, `${midBatch.length} wakes mid-batch`);
  assert.ok(
    midBatch.every((n) => n === 0),
    "a wake inside a batch publishes nothing of its own",
  );
  assert.ok(
    states.length <= 1000 / FRAME_MS + 3,
    `${states.length} sim-states for ${ticks.length} ticks`,
  );
  sim.stop();
});

test("an edit's catch-up runs the edges due before it against the board before it", () => {
  // The edges that fell due before an edit are the board's past: they must
  // see the document as it was, and only the edit's own tick the new one.
  resetDom();
  const clock = fakeClock();
  const plain = fakeDoc(clockDoc(1000));
  // A real DeskDoc hands out a fresh snapshot on every toJSON.
  const deskDoc = { ...plain, toJSON: () => structuredClone(plain.toJSON()) };
  const seen = [];
  const integration = fakeIntegration({
    settled: (ctx) => {
      seen.push(
        ctx.document.components.find((c) => c.id === "psu1").params.mark ??
          null,
      );
      return null;
    },
  });
  const sim = new SimController({
    deskDoc,
    notifications: fakeNotifications(),
    integration,
    clock,
  });
  sim.start(); // published at wall 0: the next batch waits for the frame
  clock.advance(4); // eight 1 kHz edges fall due, none run yet
  assert.equal(seen.length, 1, "only Run's own tick so far");
  plain.setComponentParams("psu1", { volts: 5, mark: 1 });
  window.dispatchEvent(new window.CustomEvent("chiphippo:doc-changed"));
  assert.ok(seen.length >= 9, `${seen.length} settles`);
  assert.deepEqual(
    seen.slice(0, -1),
    seen.slice(0, -1).map(() => null),
    "every caught-up edge saw the board before the edit",
  );
  assert.equal(seen.at(-1), 1, "the edit's own tick sees it");
  sim.stop();
});

test("a debugger replay pass is published as one, and the settled board is not", async () => {
  // The desk lights LEDs by a pass's levels only when it is told the levels
  // are a pass's (Spice Lite's lamps are the settled tick's).
  resetDom();
  let release = null;
  let stallOnce = true;
  const { recorder } = await import("../model/chip-debug.js");
  const debug = {
    observer: () => recorder(new Set()),
    afterTick: ({ show, showFinal }) => {
      if (!stallOnce) return null;
      stallOnce = false;
      show(new Map());
      showFinal();
      return new Promise((r) => (release = r));
    },
  };
  const sim = new SimController({
    deskDoc: fakeDoc(clockDoc(1)),
    notifications: fakeNotifications(),
    debug,
  });
  const states = capture();
  sim.start();
  assert.equal(sim.stalled, true);
  const [pass, final] = states.slice(-2);
  assert.equal(pass.replay, true, "the pass");
  assert.equal(final.replay, false, "the settled point");
  assert.equal(pass.fastestHz, 0, "held by the debugger: nothing toggles");
  release();
  await settleMicrotasks();
  assert.equal(states.at(-1).replay, false);
  sim.stop();
});

test("Spice Lite: a moving node is redrawn at 25 fps off its curve — no tick", async () => {
  // features/01-display-wakes.md: an RC charging toward 5 V, nothing reading
  // it, wakes the engine for nothing — the views read its curve where the sim
  // clock has got to, every PUBLISH_MS, until it arrives.
  resetDom();
  const { bench } = await import("./timing-fixtures.js");
  const { PUBLISH_MS } = await import("../components/sim-pacer.js");
  const b = bench();
  const r = b.seat("r1", "resistor", "a10", { ohms: 10e3 });
  const c = b.seat("c1", "cap-ceramic", "a20", { farads: 10e-6 });
  b.vcc(r.get(1));
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  const clock = fakeClock();
  const sim = new SimController({
    deskDoc: fakeDoc(b.doc),
    notifications: fakeNotifications(),
    clock,
  });
  sim.setSpiceLite({ enabled: true });
  const ticks = captureTicks();
  const states = capture();
  sim.start();
  const net = states.at(-1).netlist.netOfPoint.get(b.at(c.get(1)));
  const volts = () => states.at(-1).nodeVolts.get(net);
  assert.ok(volts() < 1e-3, `empty at Run: ${volts()}`);
  clock.advance(200);
  assert.equal(ticks.length, 1, "the Run tick, and no other");
  const shown = states.length;
  assert.ok(shown >= 200 / PUBLISH_MS - 1 && shown <= 200 / PUBLISH_MS + 2, `${shown} redraws in 200 ms`); // prettier-ignore
  // τ = 0.1 s: the last redraw read the curve where the clock stood then.
  const expect = (t) => 5 * (1 - Math.exp(-t / 0.1));
  const at = Math.floor(200 / PUBLISH_MS) * PUBLISH_MS / 1000; // prettier-ignore
  assert.ok(Math.abs(volts() - expect(at)) < 0.05, `${volts()} at ${at} s vs ${expect(at)}`); // prettier-ignore
  // Paused, it shows the paused moment's voltage.
  clock.advance(15);
  sim.pause();
  assert.ok(Math.abs(volts() - expect(0.215)) < 1e-6, `paused: ${volts()} vs ${expect(0.215)}`); // prettier-ignore
  // Arrived (within the gap setting), it is no longer redrawn.
  sim.resume();
  clock.advance(2000);
  const done = states.length;
  clock.advance(500);
  assert.equal(states.length, done, "arrived: no more redraws");
  assert.equal(ticks.length, 1, "and still no tick");
  sim.stop();
});

test("Spice Lite: while the analyzer records, a moving node gets its frames as sim-ticks", async () => {
  // The columns the engine's display frames used to make (spice/sample.js
  // ANALOG_FRAME_S apart), read off the curve instead of ticked.
  resetDom();
  const { bench } = await import("./timing-fixtures.js");
  const { ANALOG_FRAME_S } = await import("../sim/spice/sample.js");
  const b = bench();
  const r = b.seat("r1", "resistor", "a10", { ohms: 10e3 });
  const c = b.seat("c1", "cap-ceramic", "a20", { farads: 10e-6 });
  b.vcc(r.get(1));
  b.link(r.get(2), c.get(1));
  b.gnd(c.get(2));
  const clock = fakeClock();
  const deskDoc = fakeDoc(b.doc);
  deskDoc.scopeChannels = [{ id: "s1", kind: "net", ref: b.at(c.get(1)) }];
  const sim = new SimController({ deskDoc, notifications: fakeNotifications(), clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true });
  const ticks = [];
  window.addEventListener("chiphippo:sim-tick", (e) => ticks.push(e.detail));
  sim.start();
  clock.advance(200);
  sim.stop();
  const net = ticks[0].netlist.netOfPoint.get(b.at(c.get(1)));
  assert.ok(ticks.length >= 6, `${ticks.length} columns`);
  for (let i = 1; i < ticks.length; i++) {
    const gap = ticks[i].at - ticks[i - 1].at;
    assert.ok(Math.abs(gap - ANALOG_FRAME_S) < 1e-6, `a frame apart: ${gap}`);
    const v = ticks[i].nodeVolts.get(net);
    const expect = 5 * (1 - Math.exp(-ticks[i].at / 0.1));
    assert.ok(Math.abs(v - expect) < 1e-3, `${v} at ${ticks[i].at} vs ${expect}`); // prettier-ignore
  }
});
