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

// spice-engine.test.js — Spice Light in circuit (sim/spice/engine.js,
// features/spice-light.md §3–§4), on fixtures built in code like every engine
// suite: an RC node charging toward a gate's threshold, listeners with
// different thresholds, a node that never gets there, a ring oscillator, a
// Schmitt-trigger RC oscillator (and a late tick replaying it), a capacitor
// keeping its charge through a switch, a capacitor wired to nothing, a
// mixed-family desk, and the 555 timing by its capacitor's curve.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { CURVE_K } from "../sim/timer-555.js";
import {
  ANALOG_FRAME_S,
  MAX_ANALOG_EVENTS,
  MAX_CATCHUP_EVENTS,
  MAX_HOLD,
  capacitorNets,
} from "../sim/spice/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { ENGINES } from "../sim/engines.js";
import { inputThresholds } from "../sim/spice/params.js";
import { normalizeSpiceConfig } from "../sim/spice/config.js";
import { partDef } from "../catalog/index.js";
import { astable555, bench, runner } from "./timing-fixtures.js";

const spice = (doc, config) => runner(doc, { engine: "spice", spice: config });

const close = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * rel,
    `${what}: ${actual} vs ${expected}`,
  );

/** A powered inverter package at `anchor`: pin → hole. */
function inverter(b, id, ref, anchor) {
  const u = b.seat(id, ref, anchor);
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  return u;
}

/** R from VCC (or GND) into a node, C from the node to GND, feeding
    inverter input 1A (pin 1). Returns the bench, the inverter and the
    node's hole. */
function rcInto(ref = "74LS04", { r = 10e3, c = 10e-6, pull = "vcc" } = {}) {
  const b = bench();
  const u = inverter(b, "u1", ref, "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(1));
  (pull === "vcc" ? b.vcc : b.gnd)(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  return { b, u, node: u.get(1) };
}

const TTL_TRIGGER = inputThresholds(normalizeSpiceConfig(null), partDef("74LS04"), 5).up; // prettier-ignore

test("an RC node charges, and the gate flips when it crosses the threshold", () => {
  const { b, u } = rcInto();
  const tau = 10e3 * 10e-6;
  const crossing = tau * Math.log(5 / (5 - TTL_TRIGGER));
  assert.equal(TTL_TRIGGER, 1.4, "74LS: halfway between VIL 0.8 and VIH 2");

  // The digital engine has no time: the pull-up wins at once.
  assert.equal(runner(b.doc).run(0).level(u.get(2)), L);

  const sim = spice(b.doc);
  const first = sim.run(0);
  assert.equal(first.level(u.get(2)), H, "an empty capacitor reads LOW");
  const nodeNet = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  // The curve is anchored when the first settle ends — a few gate delays
  // after Run, so a few µV and a fraction of a µs.
  assert.ok(first.result.nodeVolts.get(nodeNet) < 1e-4);
  close(
    first.result.wakeAt,
    crossing,
    1e-5,
    "it asks to be woken AT the crossing",
  );

  const flipped = sim.run(first.result.wakeAt);
  assert.equal(
    flipped.level(u.get(2)),
    L,
    "past the threshold, the input reads HIGH",
  );
  close(
    flipped.result.nodeVolts.get(nodeNet),
    TTL_TRIGGER,
    1e-6,
    "the node is at the trigger point",
  );
  assert.equal(flipped.result.netLevels.get(nodeNet), H);
});

test("a crossing fires once: a node still climbing past it makes no more events", () => {
  const { b, u } = rcInto();
  const sim = spice(b.doc);
  let at = sim.run(0).result.wakeAt;
  sim.run(at);
  // The node keeps rising (never frozen), but nothing listens past 1.4 V, so
  // the only wakes left are display frames, until it is within 1 % of 5 V.
  const nodeNet = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  let last = 0;
  for (let i = 0; i < 400; i++) {
    const r = sim.run(at).result;
    assert.equal(sim.level(u.get(2)), L);
    assert.ok(!r.warnings.some((w) => w.type === "oscillation"));
    const v = r.nodeVolts.get(nodeNet);
    assert.ok(v >= last, "monotonic");
    last = v;
    if (r.wakeAt == null) break;
    close(r.wakeAt - at, ANALOG_FRAME_S, 1e-6, "a display frame");
    at = r.wakeAt;
  }
  assert.ok(sim.result.wakeAt == null, "it stops asking once it has arrived");
  assert.ok(Math.abs(5 - last) <= 0.05 + 1e-9, `within 1 % of 5 V: ${last}`);
});

test("listeners with different thresholds each switch at their own crossing", () => {
  const b = bench();
  const ls = inverter(b, "u1", "74LS04", "e10");
  const cmos = inverter(b, "u2", "CD4069UB", "e20");
  const res = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.link(res.get(1), ls.get(1));
  b.vcc(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: 10e-6 });
  b.link(cap.get(1), ls.get(1));
  b.gnd(cap.get(2));
  b.link(ls.get(1), cmos.get(1));

  const tau = 0.1;
  const tLs = tau * Math.log(5 / (5 - 1.4));
  const tCmos = tau * Math.log(5 / (5 - 2.5)); // VIL 1.5 / VIH 3.5 at 5 V
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  close(r.wakeAt, tLs, 1e-5, "the 74LS crossing first");
  r = sim.run(r.wakeAt).result;
  assert.equal(sim.level(ls.get(2)), L);
  assert.equal(sim.level(cmos.get(2)), H, "the CMOS input has not crossed yet");
  const nodeNet = sim.netlist.netOfPoint.get(b.at(ls.get(1)));
  assert.equal(
    r.netLevels.get(nodeNet),
    "X",
    "they disagree, so the net says so",
  );
  // Frames until the CMOS crossing, which is woken for exactly.
  let at = r.wakeAt;
  while (at < tCmos * (1 - 1e-5)) at = sim.run(at).result.wakeAt;
  close(at, tCmos, 1e-5, "the CMOS crossing");
  sim.run(at);
  assert.equal(sim.level(cmos.get(2)), L);
  assert.equal(sim.result.netLevels.get(nodeNet), H);
});

test("a node whose asymptote is short of the threshold is released, never waited for", () => {
  // 10k to VCC, 2.2k to GND: it settles at 0.90 V, under the 74LS's 1.4 V.
  const { b, u } = rcInto();
  const down = b.seat("r2", "resistor", "a50", { ohms: 2.2e3 });
  b.link(down.get(1), u.get(1));
  b.gnd(down.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  let at = 0;
  for (let i = 0; i < 100 && r.wakeAt != null; i++) {
    close(r.wakeAt - at, ANALOG_FRAME_S, 1e-6, "frames only — no crossing");
    at = r.wakeAt;
    r = sim.run(at).result;
  }
  assert.equal(r.wakeAt, null, "arrived, and nothing will ever cross");
  assert.equal(sim.level(u.get(2)), H);
  const v = r.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(1))));
  close(v, (5 * 2.2) / 12.2, 0.011, "the divider's voltage");
});

test("a late tick catches up on the crossing it missed", () => {
  const { b, u } = rcInto();
  const sim = spice(b.doc);
  sim.run(0);
  assert.equal(sim.run(0.5).level(u.get(2)), L);
});

test("a discharging node falls through the threshold the other way", () => {
  // The capacitor's far side on VCC: an empty capacitor starts the node AT
  // 5 V, and the resistor to GND drains it.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
  b.link(res.get(1), u.get(1));
  b.gnd(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: 10e-6 });
  b.link(cap.get(1), u.get(1));
  b.vcc(cap.get(2));
  const sim = spice(b.doc);
  let at = sim.run(0).result.wakeAt;
  assert.equal(sim.level(u.get(2)), L, "power-on: the node starts HIGH");
  const falls = 0.1 * Math.log(5 / 1.4);
  // Display frames while it falls, then the crossing itself.
  while (at < falls * (1 - 1e-5)) {
    assert.equal(sim.level(u.get(2)), L);
    at = sim.run(at).result.wakeAt;
  }
  close(at, falls, 1e-5, "falls to 1.4 V");
  sim.run(at);
  assert.equal(sim.level(u.get(2)), H);
});

test("a ring oscillator is still reported as oscillating", () => {
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  b.link(u.get(2), u.get(3)); // 1Y → 2A
  b.link(u.get(4), u.get(5)); // 2Y → 3A
  b.link(u.get(6), u.get(1)); // 3Y → 1A
  for (const engine of ["digital", "spice"]) {
    const r = runner(b.doc, { engine }).run(0).result;
    assert.ok(
      r.warnings.some((w) => w.type === "oscillation"),
      `${engine}: oscillation`,
    );
  }
});

/** An RC relaxation oscillator round inverter 1: 1Y → R → 1A, and C from
    1A to GND. Oscillates at a period its thresholds set if the inverter is a
    Schmitt trigger; with one threshold it turns straight back. */
function relaxation(ref = "74LS14", { r = 10e3, c = 10e-6 } = {}) {
  const b = bench();
  const u = inverter(b, "u1", ref, "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  return { b, u, rc: r * c };
}

const noOscillation = (r) =>
  assert.ok(
    !r.warnings.some((w) => w.type === "oscillation"),
    "no oscillation fault",
  );

test("a Schmitt input swings an RC between its two thresholds: a relaxation oscillator", () => {
  const config = normalizeSpiceConfig(null);
  const { up, down } = inputThresholds(config, partDef("74LS14"), 5);
  assert.deepEqual([up, down], [1.6, 0.8], "the '14's VT+ and VT−");
  const cmos = inputThresholds(config, partDef("CD40106B"), 10);
  close(cmos.up, 5.8, 1e-12, "a CMOS Schmitt's points scale with its supply");
  close(cmos.down, 3.8, 1e-12, "both of them");

  const { b, u, rc } = relaxation();
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  let level = sim.level(u.get(2));
  assert.equal(level, H, "an empty capacitor reads LOW, so 1Y is HIGH");
  const edges = [];
  for (let i = 0; i < 400 && edges.length < 7; i++) {
    const at = r.wakeAt;
    r = sim.run(at).result;
    noOscillation(r);
    const now = sim.level(u.get(2));
    if (now !== level) {
      edges.push(at);
      level = now;
    }
  }
  assert.equal(edges.length, 7);
  // The first HIGH charges an EMPTY capacitor all the way up from 0 V.
  close(edges[0], rc * Math.log(5 / (5 - up)), 1e-4, "the first, long HIGH");
  for (let i = 1; i + 1 < edges.length; i += 2) {
    close(edges[i] - edges[i - 1], rc * Math.log(up / down), 1e-4, "LOW: VT+ down to VT−"); // prettier-ignore
    close(edges[i + 1] - edges[i], rc * Math.log((5 - down) / (5 - up)), 1e-4, "HIGH: VT− up to VT+"); // prettier-ignore
  }
});

test("the same RC round an ordinary inverter turns straight back: an oscillation", () => {
  const { b } = relaxation("74LS04");
  const sim = spice(b.doc);
  const r = sim.run(sim.run(0).result.wakeAt).result;
  assert.ok(r.warnings.some((w) => w.type === "oscillation"));
  assert.equal(r.analog.oscillating, true);
  // The next tick does not replay a history nobody can see: it starts at
  // its own moment.
  const next = sim.run(r.wakeAt).result;
  assert.ok(next.analog.time >= r.wakeAt);
});

test("a late tick replays a slow oscillator's crossings without calling it an oscillation", () => {
  const { b, u, rc } = relaxation();
  const period = rc * (Math.log(1.6 / 0.8) + Math.log(4.2 / 3.4));
  const sim = spice(b.doc);
  sim.run(0);
  // Two seconds late — a throttled timer: twenty-odd periods, more crossings
  // than one tick's own budget.
  assert.ok((2 * 2) / period > MAX_ANALOG_EVENTS);
  let r = sim.run(2).result;
  noOscillation(r);
  assert.equal(r.analog.oscillating, false);
  assert.ok(r.analog.time >= 2, "caught up to now");
  assert.ok(r.wakeAt > 2 && r.wakeAt - 2 <= period, "and runs on from there");
  // Hopelessly late, past even the catch-up budget: the history is skipped.
  assert.ok((2 * 200) / period > MAX_CATCHUP_EVENTS);
  r = sim.run(200).result;
  noOscillation(r);
  assert.ok(r.analog.time >= 200);
  // ... and it still oscillates afterwards, at its own pace.
  let level = sim.level(u.get(2));
  let edges = 0;
  for (let i = 0; i < 50 && edges < 3; i++) {
    r = sim.run(r.wakeAt).result;
    noOscillation(r);
    if (sim.level(u.get(2)) !== level) {
      level = sim.level(u.get(2));
      edges++;
    }
  }
  assert.equal(edges, 3);
});

test("a capacitor keeps its charge while its node is merged into a rail", () => {
  // A slide switch ties the node to + (pin 1) or to its unwired pin 3. Held
  // at +, the node IS the rail; switched away, it comes back as a node — at
  // the 5 V its capacitor was left holding, draining through 10k.
  const b = bench();
  const u = inverter(b, "u1", "74LS04", "e10");
  const sw = b.seat("s1", "sw-slide", "a30", { pos: "1" });
  b.vcc(sw.get(1));
  b.link(sw.get(2), u.get(1));
  const res = b.seat("r1", "resistor", "a40", { ohms: 10e3 });
  b.link(res.get(1), u.get(1));
  b.gnd(res.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a50", { farads: 10e-6 });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  assert.equal(sim.level(u.get(2)), L, "on the rail: the input reads HIGH");
  close(r.analog.caps.get("c1"), 5, 1e-9, "charged to the rail");

  b.doc.components.find((c) => c.id === "s1").params.pos = "2";
  sim.rebuild();
  r = sim.run(1).result;
  assert.equal(sim.level(u.get(2)), L, "released: the capacitor holds it up");
  const node = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  close(r.nodeVolts.get(node), 5, 1e-3, "at the charge it was left with");
  // Display frames while it drains, then the crossing itself.
  const falls = 1 + 0.1 * Math.log(5 / TTL_TRIGGER);
  let at = r.wakeAt;
  while (at < falls * (1 - 1e-6)) {
    assert.equal(sim.level(u.get(2)), L);
    at = sim.run(at).result.wakeAt;
  }
  close(at, falls, 1e-6, "then drains to 1.4 V");
  sim.run(at);
  assert.equal(sim.level(u.get(2)), H);
});

test("a capacitor whose other lead goes nowhere is no part of the node", () => {
  const { b, u } = rcInto();
  // 100 µF more on the node, its other lead alone in a column of its own.
  const stray = b.seat("c2", "cap-electrolytic", "a50", { farads: 100e-6 });
  b.link(stray.get(1), u.get(1));
  const r = spice(b.doc).run(0).result;
  close(
    r.wakeAt,
    0.1 * Math.log(5 / (5 - TTL_TRIGGER)),
    1e-5,
    "τ is the wired capacitor's alone",
  );
});

test("a node reads a HIGH as its driver's supply, not the desk's highest", () => {
  // A 74LS04 on 5 V charges an RC that a CD4069UB on 12 V reads: the node
  // can climb only to the 5 V its driver has, short of the CMOS gate's 6 V —
  // the reason a 5 V part cannot drive 12 V CMOS.
  const b = bench();
  const last = () => b.doc.wires[b.doc.wires.length - 1];
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 20, y: 30, params: { volts: 12 } }); // prettier-ignore
  const ls = inverter(b, "u1", "74LS04", "e10");
  b.gnd(ls.get(1)); // 1Y HIGH
  const cmos = b.seat("u2", "CD4069UB", "e30");
  b.vcc(cmos.get(14));
  last().from = "psu2.+";
  b.gnd(cmos.get(7));
  b.gnd(cmos.get(7));
  last().from = "psu2.-"; // one ground for both supplies
  const res = b.seat("r1", "resistor", "a50", { ohms: 10e3 });
  b.link(ls.get(2), res.get(1));
  b.link(res.get(2), cmos.get(1));
  const cap = b.seat("c1", "cap-electrolytic", "a58", { farads: 10e-6 });
  b.link(cap.get(1), cmos.get(1));
  b.gnd(cap.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  for (let i = 0; i < 100 && r.wakeAt != null; i++)
    r = sim.run(r.wakeAt).result;
  assert.equal(r.wakeAt, null, "it arrives, and nothing crosses");
  const node = sim.netlist.netOfPoint.get(b.at(cmos.get(1)));
  close(r.nodeVolts.get(node), 5, 0.011, "at its driver's 5 V");
  assert.equal(sim.level(cmos.get(2)), H, "the 12 V gate never switches");
});

test("a power-on RC on a 555's RESET holds it until the capacitor charges", () => {
  // A timed part owns only its TIMING pins' capacitors; RESET is an
  // ordinary input, so an RC on it is a node like any other.
  const { b, u } = astable555({ ra: 10e3, rb: 10e3, c: 10e-6, reset: false });
  const res = b.seat("r9", "resistor", "a20", { ohms: 100e3 });
  b.link(res.get(1), u.get(4));
  b.vcc(res.get(2));
  const cap = b.seat("c9", "cap-electrolytic", "a25", { farads: 1e-6 });
  b.link(cap.get(1), u.get(4));
  b.gnd(cap.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  assert.equal(sim.level(u.get(3)), L, "held in reset at power-on");
  const release = 0.1 * Math.log(5 / (5 - TTL_TRIGGER));
  let at = r.wakeAt;
  while (at < release * (1 - 1e-6)) {
    assert.equal(sim.level(u.get(3)), L);
    at = sim.run(at).result.wakeAt;
  }
  close(at, release, 1e-5, "RESET crosses its threshold");
  sim.run(at);
  assert.equal(sim.level(u.get(3)), H, "and the astable starts");
});

test("a RAM write made in one settle is read by the next, inside one tick", () => {
  // An SRAM with WE on a fast RC (τ = 1 µs, crossing well inside the fast
  // window): the first settle writes (WE LOW, the data pins floating HIGH),
  // the crossing's settle reads it back (WE HIGH, OE LOW). The image the
  // second settle reads has the first's write in it; the caller's does not.
  const b = bench();
  const ram = b.seat("u1", "ram-8k", "e10");
  b.vcc(ram.get(28));
  b.gnd(ram.get(14));
  b.gnd(ram.get(26)); // CE
  b.gnd(ram.get(27)); // OE
  const res = b.seat("r1", "resistor", "a50", { ohms: 1e3 });
  b.link(res.get(1), ram.get(20)); // WE
  b.vcc(res.get(2));
  const cap = b.seat("c1", "cap-ceramic", "a56", { farads: 1e-9 });
  b.link(cap.get(1), ram.get(20));
  b.gnd(cap.get(2));
  const netlist = buildNetlist(b.doc);
  const images = new Map([["u1", new Uint8Array(8192)]]);
  const r = ENGINES.spice.tick({
    document: b.doc,
    netlist,
    warmStart: new Map(),
    state: new Map(),
    prevPinLevels: new Map(),
    signalLevels: new Map(),
    images,
    now: 0,
    spice: { config: { enabled: true }, analog: null },
  });
  const dq0 = netlist.netOfPoint.get(b.at(ram.get(9)));
  assert.ok(r.memWrites.some((w) => w.compId === "u1" && w.value === 0xff));
  assert.equal(r.netLevels.get(dq0), H, "the written byte read back");
  assert.ok(images.get("u1").every((v) => v === 0), "the caller's image untouched"); // prettier-ignore
});

test("each capacitor's nets are read once per netlist", () => {
  const { b } = rcInto();
  const netlist = buildNetlist(b.doc);
  const nets = capacitorNets(b.doc, netlist);
  assert.equal(capacitorNets(b.doc, netlist), nets, "cached");
  assert.notEqual(capacitorNets(b.doc, buildNetlist(b.doc)), nets);
  const c1 = nets.get("c1");
  assert.ok(c1.a && c1.b && c1.a !== c1.b, "pin 1's net and pin 2's");
});

test("mixed families: the slower CD4000 gate holds its output for its delay", () => {
  // A signal into a CD4069UB, its output into a 74LS04: the same settled
  // levels as the digital engine, reached in more passes — the CMOS gate is
  // ~12 quanta of 10 ns at 5 V (125 ns).
  const b = bench();
  const cmos = inverter(b, "u1", "CD4069UB", "e10");
  const ls = inverter(b, "u2", "74LS04", "e20");
  b.link(cmos.get(2), ls.get(1));
  b.signal("in", cmos.get(1), "low");
  const levels = new Map([["in", H]]);
  const digital = runner(b.doc);
  const sl = spice(b.doc);
  digital.run(0, new Map([["in", L]]));
  sl.run(0, new Map([["in", L]]));
  const d = digital.run(0.01, levels).result;
  const s = sl.run(0.01, levels).result;
  assert.deepEqual(s.netLevels, d.netLevels);
  assert.equal(sl.level(ls.get(2)), H);
  assert.ok(
    s.iterations >= d.iterations + 11,
    `held for its delay: ${s.iterations} vs ${d.iterations}`,
  );
  assert.ok(s.analog.outputs.has("u1"), "the CMOS gate's outputs are carried");
});

test("an edited delay far shorter than the rest cannot make a tick crawl", () => {
  // The 74LS delay set to a picosecond against the CMOS gate's 125 ns: held
  // to MAX_HOLD quanta, a settle stays a handful of passes.
  const b = bench();
  const cmos = inverter(b, "u1", "CD4069UB", "e10");
  const ls = inverter(b, "u2", "74LS04", "e20");
  b.link(cmos.get(2), ls.get(1));
  b.signal("in", cmos.get(1), "low");
  const sim = spice(b.doc, { families: { "74LS": { delayNs: 0.001 } } });
  sim.run(0, new Map([["in", L]]));
  const r = sim.run(0.01, new Map([["in", H]])).result;
  assert.equal(sim.level(ls.get(2)), H, "it still settles right");
  assert.ok(r.iterations <= 4 * MAX_HOLD, `${r.iterations} passes`);
});

test("the 555 astable times by its capacitor's curve, from an EMPTY capacitor", () => {
  const ra = 1e3;
  const rb = 10e3;
  const c = 10e-6;
  const { doc } = astable555({ ra, rb, c });
  const sim = spice(doc);
  const r = sim.run(0).result;
  const s = r.timing.get("u1").sections[0];
  close(s.high, Math.LN2 * (ra + rb) * c, 1e-12, "tH = ln 2 · (RA+RB)·C");
  close(s.low, Math.LN2 * rb * c, 1e-12, "tL = ln 2 · RB·C");
  close(
    s.first,
    Math.log(3) * (ra + rb) * c,
    1e-12,
    "first HIGH = ln 3 · (RA+RB)·C",
  );
  close(CURVE_K.charge, 0.693, 1e-3, "the sheet's 0.693 is ln 2");
  close(CURVE_K.first, 1.1, 1e-2, "the sheet's 1.1 is ln 3");

  const OUT = "e12";
  const at = (t) => sim.run(t).level(OUT);
  assert.equal(at(0), H);
  assert.equal(at(s.first - 1e-4), H, "the first HIGH is the long one");
  assert.equal(at(s.first + 1e-4), L);
  assert.equal(at(s.first + s.low + 1e-4), H);
  assert.equal(at(s.first + s.low + s.high + 1e-4), L);

  // The capacitor's voltage is probed between ⅓ and ⅔ VCC once cycling.
  const thres = sim.netlist.netOfPoint.get("bb1.f12");
  const mid = sim.run(s.first + s.low / 2).result.nodeVolts.get(thres);
  close(
    mid,
    (10 / 3) * Math.exp(-(s.low / 2) / (rb * c)),
    1e-6,
    "discharging from ⅔ VCC",
  );
  assert.ok(mid > 5 / 3 && mid < 10 / 3);
});

test("the digital 555 is untouched by any of it", () => {
  const { doc } = astable555({ ra: 1e3, rb: 10e3, c: 10e-6 });
  const s = runner(doc).run(0).result.timing.get("u1").sections[0];
  close(s.high, 0.693 * 11e3 * 10e-6, 1e-12, "the datasheet's constant");
  assert.equal(s.first, undefined);
});
