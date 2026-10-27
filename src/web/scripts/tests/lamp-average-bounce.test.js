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

// What a frame shows of a lamp — its brightness averaged over the time the
// frame covers (sim/lamp-average.js) — and a switch's contact bounce
// (sim/bounce.js), each on its own and as SimController runs them.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { buildNetlist } from "../sim/netlist.js";
import { LampAverage } from "../sim/lamp-average.js";
import {
  BOUNCE_MAX_S,
  ContactBounce,
  bounceIntervals,
  gapContacts,
} from "../sim/bounce.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";

const { SimController } = await import("../components/sim-controller.js");

// ── The pure halves ────────────────────────────────────────────────────────

test("a lamp's frame average: brightness × the time each tick held it", () => {
  const avg = new LampAverage();
  // A 20 % PWM at 250 Hz: on for 0.8 ms of every 4 ms, over 40 ms.
  for (let k = 0; k < 10; k++) {
    avg.record(k * 4e-3, new Map([["d1", 1]]));
    avg.record(k * 4e-3 + 0.8e-3, new Map([["d1", 0]]));
  }
  const mean = avg.take(40e-3).get("d1");
  assert.ok(Math.abs(mean - 0.2) < 1e-9, `a fifth: ${mean}`);
  // A lamp that did not change in a frame: nothing averaged.
  avg.record(50e-3, new Map([["d1", 0]]));
  assert.equal(avg.take(80e-3), null, "steady: the tick's own picture");
  // A frame covering no time: nothing either.
  assert.equal(avg.take(80e-3), null);
});

test("a bounce: a travel gap, then touches, all within its few milliseconds", () => {
  const gaps = bounceIntervals("s1#1");
  assert.equal(gaps[0][0], 0, "open from the moment the actuator moves");
  assert.ok(gaps.length >= 3, `${gaps.length} gaps`);
  for (let k = 1; k < gaps.length; k++) {
    assert.ok(gaps[k][0] > gaps[k - 1][1], "in order, with a touch between");
  }
  assert.ok(gaps.at(-1)[1] < BOUNCE_MAX_S);
  assert.deepEqual(bounceIntervals("s1#1"), gaps, "the same press, the same bounce"); // prettier-ignore
  assert.notDeepEqual(bounceIntervals("s1#2"), gaps, "the next one differs");
  // A slide switch's gaps keep no throw at all; a DIP bank keeps the
  // positions that did not move.
  assert.deepEqual(gapContacts([[2, 1]], [[2, 3]]), []);
  assert.deepEqual(
    gapContacts(
      [[1, 8]],
      [
        [1, 8],
        [2, 7],
      ],
    ),
    [[1, 8]],
  );
});

test("only a closing contact bounces, and only when asked to", () => {
  const b = bench();
  b.seat("s1", "sw-toggle", "a40");
  const doc = (on) => ({ ...b.doc, components: b.doc.components.map((c) => (c.id === "s1" ? { ...c, params: { on } } : c)) }); // prettier-ignore
  const bounce = new ContactBounce();
  bounce.watch(doc(false), new Map(), 0, true); // first seen: remembered
  assert.equal(bounce.active, false);
  bounce.watch(doc(true), new Map(), 1, true); // closes: bounces
  assert.equal(bounce.active, true);
  assert.equal(bounce.gapsAt(1).get("s1")?.length, 0, "open at the press");
  assert.equal(bounce.gapsAt(1.01).size, 0, "closed for good 10 ms on");
  bounce.watch(doc(false), new Map(), 2, true); // opens: clean
  assert.equal(bounce.gapsAt(2).size, 0);
  bounce.watch(doc(true), new Map(), 3, false); // closes, not asked: clean
  assert.equal(bounce.gapsAt(3).size, 0);
});

test("the setting: Switch bounce is off unless exactly true", () => {
  assert.equal(normalizeSpiceConfig(null).bounce, false);
  assert.equal(normalizeSpiceConfig({ bounce: "yes" }).bounce, false);
  assert.equal(normalizeSpiceConfig({ bounce: true }).bounce, true);
});

// ── As SimController runs them ─────────────────────────────────────────────

/** A DeskDoc stand-in over a plain document. */
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

/** A wall clock the test drives: `advance(ms)` fires every timer due. */
function drivenClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, at: now + Math.max(0, ms) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        }
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        next[1].fn();
      }
      now = end;
    },
  };
}

/** Every sim-state and sim-tick from here on. */
function capture() {
  const states = [];
  const ticks = [];
  const onState = (e) => states.push(e.detail);
  const onTick = (e) => ticks.push(...e.detail.ticks);
  window.addEventListener("chiphippo:sim-state", onState);
  window.addEventListener("chiphippo:sim-ticks", onTick);
  return {
    states,
    ticks,
    stop() {
      window.removeEventListener("chiphippo:sim-state", onState);
      window.removeEventListener("chiphippo:sim-ticks", onTick);
    },
  };
}

/** A clock brick's PWM (`duty` %) into an LED and 330 Ω to ground. */
function pwmLed(hz, duty) {
  const b = bench();
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz, wave: "pwm", duty }) }); // prettier-ignore
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
  return b.doc;
}

for (const spice of [false, true]) {
  test(`${spice ? "Spice Lite" : "the logic engine"}: an LED on a 250 Hz PWM at 20 % shows a fifth as bright`, () => {
    resetDom();
    const clock = drivenClock();
    const sim = new SimController({
      deskDoc: fakeDoc(pwmLed(250, 20)),
      notifications: { notify() {}, dismiss() {} },
      clock,
    });
    sim.setSpiceLite({ enabled: spice });
    const cap = capture();
    sim.start();
    clock.advance(400);
    const glows = cap.states
      .filter((s) => s.running && s.lampGlow)
      .map((s) => s.lampGlow.get("d1"));
    assert.ok(glows.length >= 5, `averaged frames: ${glows.length}`);
    // Each LIT moment's own brightness: 1 on the logic engine, its level
    // (its current against its datasheet's) under Spice Lite.
    const lit = spice
      ? cap.ticks.map((t) => t.lamps?.get("d1")).find((v) => v?.lit)?.level
      : 1;
    for (const g of glows.slice(2)) {
      assert.ok(Math.abs(g - 0.2 * lit) < 0.05 * lit, `≈ ${0.2 * lit}: ${g}`);
    }
    sim.stop();
    assert.equal(cap.states.at(-1).lampGlow, null, "stopped: nothing");
    cap.stop();
  });
}

test("Spice Lite: a supply's current on a PWM load is shown as its mean over the frame", () => {
  // Read off the tick each frame happened to end on, a switching load's
  // supply read all or nothing by turns (the grade, 2026-10-23).
  resetDom();
  const clock = drivenClock();
  const sim = new SimController({
    deskDoc: fakeDoc(pwmLed(250, 20)),
    notifications: { notify() {}, dismiss() {} },
    clock,
  });
  sim.setSpiceLite({ enabled: true });
  const cap = capture();
  sim.start();
  clock.advance(400);
  const on = Math.max(...cap.ticks.map((t) => t.supplies?.get("psu1")?.amps ?? 0)); // prettier-ignore
  assert.ok(on > 1e-3, `lit: ${on} A`);
  const shown = cap.states
    .filter((s) => s.running && s.lampGlow)
    .map((s) => s.supplies.get("psu1").amps);
  assert.ok(shown.length >= 5, `frames: ${shown.length}`);
  for (const a of shown.slice(2)) {
    assert.ok(Math.abs(a - 0.2 * on) < 0.05 * on, `≈ ${0.2 * on} A: ${a}`);
  }
  sim.stop();
  cap.stop();
});

test("the logic engine: a timed part's wake is its own moment, not held MIN_SHOWN_S past a clock edge", () => {
  // A 0.7 ms 555 one-shot fired by a 1 kHz clock's falling edges: held off
  // to half a millisecond after the edge before it, each pulse's end merged
  // into the next trigger and OUT never went LOW (the grade, 2026-10-23).
  resetDom();
  const clock = drivenClock();
  const b = bench();
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: partDef("clock").normalizeParams({ hz: 1000 }) }); // prettier-ignore
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.link(u.get(6), u.get(7));
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 0.1e-6 });
  b.link(c.get(1), u.get(6));
  b.gnd(c.get(2));
  const ra = b.seat("r1", "resistor", "a40", { ohms: 6360 });
  b.link(ra.get(1), u.get(6));
  b.vcc(ra.get(2));
  b.doc.wires.push(
    { id: "wc1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wc2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wc3", from: "clk1.out", to: b.at(u.get(2).replace(/^e/, "a")), color: "blue" }, // prettier-ignore
  );
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: { notify() {}, dismiss() {} }, clock }); // prettier-ignore
  const cap = capture();
  sim.start();
  clock.advance(20);
  const out = buildNetlist(b.doc).netOfPoint.get(b.at(u.get(3)));
  let rises = 0;
  let was = null;
  for (const t of cap.ticks) {
    const v = t.netLevels.get(out);
    if (v === "H" && was !== "H") rises++;
    was = v;
  }
  assert.ok(rises >= 18, `${rises} pulses in 20 ms`);
  sim.stop();
  cap.stop();
});

test("a steady LED is drawn as the tick left it — nothing averaged", () => {
  resetDom();
  const clock = drivenClock();
  const b = bench();
  const d = b.seat("d1", "led", "a20", { color: "red" });
  b.vcc(d.get(1));
  const r = b.seat("r1", "resistor", "a30", { ohms: 330 });
  b.link(d.get(2), r.get(1));
  b.gnd(r.get(2));
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: { notify() {}, dismiss() {} }, clock }); // prettier-ignore
  const cap = capture();
  sim.start();
  clock.advance(200);
  assert.ok(cap.states.filter((s) => s.running).every((s) => s.lampGlow == null)); // prettier-ignore
  sim.stop();
  cap.stop();
});

/** The ticks from an edit about to be made on: a reader called after it.
    Under Spice Lite the board as it stood runs on to the edit's moment first
    (SimController's #runOnTo) — that tick, on the old netlist, is the board
    BEFORE the edit, and left out. */
function afterEdit(ticks) {
  const from = ticks.length;
  const was = ticks.at(-1)?.netlist;
  return () => {
    const after = ticks.slice(from);
    return after[0]?.netlist === was ? after.slice(1) : after;
  };
}

/** A push button from node N (a 10 kΩ pull-up) to ground, N into a 74LS04
    input: N's level in every tick after the press. */
function pressButton({ bounce }) {
  resetDom();
  const clock = drivenClock();
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
  const sim = new SimController({ deskDoc: fakeDoc(b.doc), notifications: { notify() {}, dismiss() {} }, clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true, bounce });
  const cap = capture();
  sim.start();
  clock.advance(20);
  const from = afterEdit(cap.ticks);
  window.dispatchEvent(new CustomEvent("chiphippo:part-state", { detail: { id: "s1", ref: "sw-push", state: { pressed: true } } })); // prettier-ignore
  // Past the bounce, and past the next frame's publish.
  clock.advance(100);
  const levels = from().map((t) => t.netLevels.get(t.netlist.netOfPoint.get(b.at(u.get(1))))); // prettier-ignore
  const own = from().filter((t) => t.ownNetlist).length;
  const end = cap.states.at(-1);
  sim.stop();
  cap.stop();
  return { levels, own, end, at: b.at(u.get(1)) };
}

const changes = (levels) =>
  levels.reduce((n, lv, i) => (i && lv !== levels[i - 1] ? n + 1 : n), 0);

test("Switch bounce: a pressed button chatters, then rests closed", () => {
  const { levels, own, end, at } = pressButton({ bounce: true });
  assert.ok(own >= 3, `ticks on a bounce's netlist: ${own}`);
  assert.ok(changes(levels) >= 4, `it chattered: ${levels.join("")}`);
  assert.equal(levels.at(-1), "L", "and rests LOW");
  assert.equal(end.netLevels.get(end.netlist.netOfPoint.get(at)), "L");
  assert.equal(end.ownNetlist, false, "settled: the desk's own netlist");
});

test("Switch bounce off: the button closes once", () => {
  const { levels, own } = pressButton({ bounce: false });
  assert.equal(own, 0);
  assert.equal(changes(levels.filter((lv) => lv === "H" || lv === "L")), 0);
  assert.equal(levels.at(-1), "L");
});

test("Switch bounce: a slide switch's old throw never re-makes as its new one bounces", () => {
  resetDom();
  const clock = drivenClock();
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  // Common into the input, pulled up through 10 kΩ; throw 1 to ground,
  // throw 2 to +5 V. Thrown 1 → 2, the input goes LOW → HIGH once: in every
  // gap the common floats up through its pull-up, never back to ground.
  const s = b.seat("s1", "sw-slide", "a40", { pos: "1" });
  b.gnd(s.get(1));
  b.vcc(s.get(3));
  const up = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.vcc(up.get(1));
  b.link(up.get(2), s.get(2));
  b.link(s.get(2), u.get(1));
  const desk = fakeDoc(b.doc);
  const sim = new SimController({ deskDoc: desk, notifications: { notify() {}, dismiss() {} }, clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: true, bounce: true });
  const cap = capture();
  sim.start();
  clock.advance(20);
  const from = afterEdit(cap.ticks);
  desk.setComponentParams("s1", { pos: "2" });
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  clock.advance(20);
  const after = from();
  const level = (t) =>
    t.netLevels.get(t.netlist.netOfPoint.get(b.at(u.get(1))));
  assert.ok(after.filter((t) => t.ownNetlist).length >= 3, "it bounced");
  assert.ok(
    after.every((t) => level(t) === "H"),
    after.map(level).join(""),
  );
  // A bounce's netlist names its own nets: the common is cut off both throws.
  const gap = after.find((t) => t.ownNetlist);
  const base = buildNetlist(desk.toJSON());
  assert.notEqual(gap.netlist, base);
  sim.stop();
  cap.stop();
});

/** +5 V through a latching switch, an LED and 330 Ω to ground: what the desk
    draws of the LED in the LAST frame after each throw (sim-overlay.js's
    #verdict: the frame's average when it has one, else the tick's lamp). */
function switchedLed({ spice, bounce = false }) {
  resetDom();
  const clock = drivenClock();
  const b = bench();
  const s = b.seat("s1", "sw-toggle", "a40");
  b.vcc(s.get(1));
  const d = b.seat("d1", "led", "a20", { color: "red" });
  b.link(s.get(2), d.get(1));
  const r = b.seat("r1", "resistor", "a30", { ohms: 330 });
  b.link(d.get(2), r.get(1));
  b.gnd(r.get(2));
  const desk = fakeDoc(b.doc);
  const sim = new SimController({ deskDoc: desk, notifications: { notify() {}, dismiss() {} }, clock }); // prettier-ignore
  sim.setSpiceLite({ enabled: spice, bounce });
  const cap = capture();
  const shown = () => {
    const state = cap.states.filter((x) => x.running).at(-1);
    const glow = state.lampGlow?.get("d1");
    if (glow != null) return glow;
    if (state.lamps) {
      const lamp = state.lamps.get("d1");
      return lamp?.lit ? lamp.level : 0;
    }
    const net = (at) => state.netlist.netOfPoint.get(at);
    const pins = [d.get(1), d.get(2)].map((p) => state.netLevels.get(net(b.at(p)))); // prettier-ignore
    return pins[0] === "H" && pins[1] === "L" ? 1 : 0;
  };
  sim.start();
  clock.advance(200);
  const seen = [shown()];
  for (const on of [true, false, true, false]) {
    desk.setComponentParams("s1", { on });
    window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
    // An idle desk: nothing ticks again until the next throw.
    clock.advance(500);
    seen.push(shown());
  }
  const lit = cap.ticks.map((t) => t.lamps?.get("d1")).find((v) => v?.lit)?.level ?? 1; // prettier-ignore
  sim.stop();
  cap.stop();
  return { seen, lit };
}

for (const [spice, bounce] of [
  [false, false],
  [true, false],
  [true, true],
]) {
  test(`${spice ? "Spice Lite" : "the logic engine"}${bounce ? " with bounce" : ""}: an idle desk's last frame shows each throw of a switch, not the average before it`, () => {
    const { seen, lit } = switchedLed({ spice, bounce });
    const want = [0, lit, 0, lit, 0];
    for (let k = 0; k < want.length; k++) {
      assert.ok(Math.abs(seen[k] - want[k]) < 1e-6, `${seen.join(", ")} ≠ ${want.join(", ")}`); // prettier-ignore
    }
  });
}
