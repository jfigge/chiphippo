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

// spice-engine.test.js — Spice Lite in circuit (sim/spice/engine.js,
// features/spice-lite.md §3–§4), on fixtures built in code like every engine
// suite: an RC node charging toward a gate's threshold, listeners with
// different thresholds, a node that never gets there, a ring oscillator, a
// Schmitt-trigger RC oscillator (and a late tick replaying it), a capacitor
// keeping its charge through a switch, a capacitor wired to nothing, and a
// mixed-family desk. The timing parts as their silicon are
// tests/spice-silicon.test.js's.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import {
  ANALOG_FRAME_S,
  FAST_WINDOW_S,
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
import { bench, runner } from "./timing-fixtures.js";

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
// A CD4000 input draws nothing, so an RC into one charges at exactly R·C: the
// fixture the curve's own arithmetic is proved on.
const CMOS_TRIGGER = inputThresholds(normalizeSpiceConfig(null), partDef("CD4069UB"), 5).up; // prettier-ignore

/** Run a tick at each wake until the next one is at or past `until`;
    returns the last result. */
function runTo(sim, r, until) {
  for (
    let i = 0;
    i < 1000 && r.wakeAt != null && r.wakeAt < until * (1 - 1e-6);
    i++
  ) {
    r = sim.run(r.wakeAt).result;
  }
  return r;
}

/** The current a powered 74LS input pushes OUT of its pin below 1.3 V
    (spice/params.js TTL_INPUT) — what an RC into one adds below there. */
const TTL_BIAS = { volts: 1.3, ohms: 4500 };

test("an RC node charges, and the gate flips when it crosses the threshold", () => {
  // 1 µF, so the crossing comes before the first display frame.
  const { b, u } = rcInto("CD4069UB", { c: 1e-6 });
  const tau = 10e3 * 1e-6;
  const crossing = tau * Math.log(5 / (5 - CMOS_TRIGGER));
  assert.equal(TTL_TRIGGER, 1.4, "74LS: halfway between VIL 0.8 and VIH 2");
  assert.equal(CMOS_TRIGGER, 2.5, "CD4000 at 5 V: between VIL 1.5 and VIH 3.5");

  // The digital engine has no time: the pull-up wins at once.
  assert.equal(runner(b.doc).run(0).level(u.get(2)), L);

  const sim = spice(b.doc);
  const first = sim.run(0);
  assert.equal(first.level(u.get(2)), H, "an empty capacitor reads LOW");
  const nodeNet = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  // The curve is anchored when the first settle ends — a few gate delays
  // after Run (125 ns each, here), so a fraction of a millivolt.
  assert.ok(first.result.nodeVolts.get(nodeNet) < 1e-3);
  close(
    first.result.wakeAt,
    crossing,
    1e-4,
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
    CMOS_TRIGGER,
    1e-4,
    "the node is at the trigger point (a few gate delays on)",
  );
  assert.equal(flipped.result.netLevels.get(nodeNet), H);
});

test("a crossing fires once: a node still climbing past it makes no more events", () => {
  const { b, u } = rcInto("CD4069UB", { c: 1e-6 });
  const sim = spice(b.doc);
  let at = sim.run(0).result.wakeAt;
  sim.run(at);
  // The node keeps rising (never frozen), but nothing listens past 2.5 V, so
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

  // Below 1.3 V the 74LS input pushes its own current into the node too, so
  // the first stretch runs toward the Thévenin of 10 kΩ to 5 V and 4.5 kΩ to
  // 1.3 V — a corner there — and from it at R·C toward 5 V.
  const tau = 0.1;
  const g = 1 / 10e3 + 1 / TTL_BIAS.ohms;
  const vInf = (5 / 10e3 + TTL_BIAS.volts / TTL_BIAS.ohms) / g;
  const corner = (10e-6 / g) * Math.log(vInf / (vInf - TTL_BIAS.volts));
  const tLs = corner + tau * Math.log((5 - 1.3) / (5 - 1.4));
  const tCmos = corner + tau * Math.log((5 - 1.3) / (5 - 2.5)); // VIL 1.5 / VIH 3.5 at 5 V
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  close(r.wakeAt, corner, 1e-5, "woken at the corner, to run on from there");
  r = sim.run(r.wakeAt).result;
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
  // 10k to VCC, 2.2k to GND: it settles at 0.90 V, under the CD4069UB's 2.5 V.
  const { b, u } = rcInto("CD4069UB");
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
    Schmitt trigger; with one threshold it turns straight back. A CD40106B's
    by default: its input draws nothing, and its output is 5 V or 0 V behind
    its own 400 Ω (spice/output-stage.js), in series with R — `rc` counts it. */
function relaxation(ref = "CD40106B", { r = 10e3, c = 10e-6 } = {}) {
  const b = bench();
  const u = inverter(b, "u1", ref, "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  const own = ref.startsWith("CD") ? 400 : 0;
  return { b, u, rc: (r + own) * c };
}

const noOscillation = (r) =>
  assert.ok(
    !r.warnings.some((w) => w.type === "oscillation"),
    "no oscillation fault",
  );

test("a Schmitt input swings an RC between its two thresholds: a relaxation oscillator", () => {
  const config = normalizeSpiceConfig(null);
  let { up, down } = inputThresholds(config, partDef("74LS14"), 5);
  assert.deepEqual([up, down], [1.6, 0.8], "the '14's VT+ and VT−");
  const cmos = inputThresholds(config, partDef("CD40106B"), 10);
  close(cmos.up, 5.8, 1e-12, "a CMOS Schmitt's points scale with its supply");
  close(cmos.down, 3.8, 1e-12, "both of them");

  const { b, u, rc } = relaxation();
  ({ up, down } = inputThresholds(config, partDef("CD40106B"), 5));
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
  const { b } = relaxation("CD4069UB");
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  for (let i = 0; i < 20 && !r.analog.oscillating; i++) r = sim.run(r.wakeAt).result; // prettier-ignore
  assert.ok(r.warnings.some((w) => w.type === "oscillation"));
  assert.equal(r.analog.oscillating, true);
  // The next tick does not replay a history nobody can see: it starts at
  // its own moment.
  const next = sim.run(r.wakeAt).result;
  assert.ok(next.analog.time >= r.wakeAt);
});

test("a late tick replays a slow oscillator's crossings without calling it an oscillation", () => {
  const { b, u, rc } = relaxation();
  const { up, down } = inputThresholds(normalizeSpiceConfig(null), partDef("CD40106B"), 5); // prettier-ignore
  const period = rc * (Math.log(up / down) + Math.log((5 - down) / (5 - up)));
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

test("a 74LS14 cannot run an RC oscillator through 10 kΩ: its input holds the capacitor up", () => {
  // Output LOW is 0.15 V behind 25 Ω, but below 1.3 V the input pushes its
  // own current back into the capacitor: through 10 kΩ the node comes to
  // rest near 0.94 V — above VT− 0.8 V — so the '14 never turns back. A
  // real '14 oscillator wants R of a kilohm or so, for this very reason.
  const { b, u } = relaxation("74LS14");
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  let edges = 0;
  let level = sim.level(u.get(2));
  for (let i = 0; i < 200 && r.wakeAt != null; i++) {
    r = sim.run(r.wakeAt).result;
    if (sim.level(u.get(2)) !== level) {
      level = sim.level(u.get(2));
      edges++;
    }
  }
  assert.equal(edges, 1, "it turns LOW once, and stays there");
  assert.equal(level, L);
  const node = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  const g = 1 / (10e3 + 25) + 1 / TTL_BIAS.ohms;
  const rest = (0.15 / (10e3 + 25) + TTL_BIAS.volts / TTL_BIAS.ohms) / g;
  close(r.nodeVolts.get(node), rest, 0.011, "at rest above VT−");
  assert.ok(rest > 0.8);
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
  const { b, u } = rcInto("CD4069UB", { c: 1e-6 });
  // 100 µF more on the node, its other lead alone in a column of its own.
  const stray = b.seat("c2", "cap-electrolytic", "a50", { farads: 100e-6 });
  b.link(stray.get(1), u.get(1));
  const r = spice(b.doc).run(0).result;
  close(
    r.wakeAt,
    0.01 * Math.log(5 / (5 - CMOS_TRIGGER)),
    1e-4,
    "τ is the wired capacitor's alone",
  );
});

test("a 74LS input on an RC pushes its own current into it below 1.3 V", () => {
  // The same 10 kΩ / 10 µF into a 74LS04: from 0 V to the input's 1.3 V the
  // input sources current into the capacitor alongside the resistor (its
  // Thévenin is 2.45 V behind 3.1 kΩ), and from there the resistor charges
  // it alone — a corner where the curve is linearized again, then R·C.
  const { b, u } = rcInto();
  const g = 1 / 10e3 + 1 / TTL_BIAS.ohms;
  const vInf = (5 / 10e3 + TTL_BIAS.volts / TTL_BIAS.ohms) / g;
  const corner = (10e-6 / g) * Math.log(vInf / (vInf - TTL_BIAS.volts));
  const crossing = corner + 0.1 * Math.log((5 - 1.3) / (5 - TTL_TRIGGER));
  assert.ok(crossing < 0.1 * Math.log(5 / (5 - TTL_TRIGGER)), "sooner than R·C alone"); // prettier-ignore
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  close(r.wakeAt, corner, 1e-5, "the corner");
  const node = sim.netlist.netOfPoint.get(b.at(u.get(1)));
  r = sim.run(r.wakeAt).result;
  close(r.nodeVolts.get(node), 1.3, 1e-6, "at the input's own 1.3 V");
  close(r.wakeAt, crossing, 1e-5, "the crossing, on the resistor alone");
  sim.run(r.wakeAt);
  assert.equal(sim.level(u.get(2)), L);
});

test("a 74LS input under a stiff divider: its own current lifts the node", () => {
  // 10k to VCC and 2.2k to GND would hold an open node at 0.90 V; the 74LS
  // input's current out of the pin lifts it to ~1.01 V — still LOW to the
  // gate, and short of its 1.4 V trigger, so it is released.
  const { b, u } = rcInto();
  const down = b.seat("r2", "resistor", "a50", { ohms: 2.2e3 });
  b.link(down.get(1), u.get(1));
  b.gnd(down.get(2));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  r = runTo(sim, r, 10);
  const g = 1 / 10e3 + 1 / 2.2e3 + 1 / TTL_BIAS.ohms;
  const v = (5 / 10e3 + TTL_BIAS.volts / TTL_BIAS.ohms) / g;
  close(r.nodeVolts.get(sim.netlist.netOfPoint.get(b.at(u.get(1)))), v, 0.011, "the divider with the input on it"); // prettier-ignore
  assert.equal(sim.level(u.get(2)), H);
});

test("a node reads a HIGH as its driver's supply, not the desk's highest", () => {
  // A 74LS04 on 5 V charges an RC that a CD4069UB on 12 V reads: the node
  // can climb only to the 3.6 V its driver's HIGH stage reaches (VCC less
  // two VBE), short of the CMOS gate's 6 V — the reason a 5 V part cannot
  // drive 12 V CMOS.
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
  close(r.nodeVolts.get(node), 3.6, 0.011, "at its driver's 3.6 V HIGH");
  assert.equal(sim.level(cmos.get(2)), H, "the 12 V gate never switches");
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

test("a CD4000 output at 5 V charges a capacitor it drives straight — at its limit, then through its resistance", () => {
  // At 5 V a CD4000 output limits an LED's current, so the LED rule's strong
  // map leaves it out — which once made its capacitor an undriven node,
  // frozen at 0 V while the gate drove it HIGH. It is a stage: 5 V behind
  // 400 Ω, saturating at 4.2 mA (spice/output-stage.js) — so an empty
  // 100 nF rises in a straight line at 4.2 mA until the output comes out of
  // saturation at 5 − 4.2 mA × 400 Ω, and from there along 400 Ω × C.
  const b = bench();
  const u = inverter(b, "u1", "CD4069UB", "e10");
  b.gnd(u.get(1)); // 1Y HIGH
  for (const p of [5, 9, 11, 13]) b.gnd(u.get(p));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: 100e-9 });
  b.link(cap.get(1), u.get(2));
  b.gnd(cap.get(2));
  b.link(u.get(2), u.get(3)); // 2A reads 1Y
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  const net = sim.netlist.netOfPoint.get(b.at(u.get(2)));
  // Anchored where the first settle ends, a few gate delays after Run.
  const { t0, v0 } = r.analog.nodes.get(net).curve;
  const ramp = 4.2e-3 / 100e-9; // volts per second, saturated
  close(r.wakeAt, t0 + (CMOS_TRIGGER - v0) / ramp, 1e-9, "a straight ramp to 2A's 2.5 V"); // prettier-ignore
  assert.equal(sim.level(u.get(4)), H, "2A still reads the empty capacitor");
  r = sim.run(r.wakeAt).result;
  assert.equal(sim.level(u.get(4)), L, "and now reads it HIGH");
  const corner = t0 + (5 - 4.2e-3 * 400 - v0) / ramp;
  close(r.wakeAt, corner, 1e-9, "out of saturation at 3.32 V");
  r = sim.run(r.wakeAt).result;
  close(r.nodeVolts.get(net), 5 - 4.2e-3 * 400, 0.01, "the corner (a few gate delays on)"); // prettier-ignore
  r = runTo(sim, r, 1);
  assert.equal(r.wakeAt, null, "arrived");
  close(r.nodeVolts.get(net), 5, 0.011, "at its driver's supply");
  assert.equal(sim.level(u.get(2)), H, "1Y is HIGH");
});

test("a CD4066 channel at 5 V carries a rail onto a capacitor, through its on-resistance", () => {
  const b = bench();
  const s = b.seat("u1", "CD4066B", "e10");
  b.vcc(s.get(14));
  b.gnd(s.get(7));
  b.vcc(s.get(13)); // switch 1 on
  b.vcc(s.get(1));
  for (const p of [5, 6, 12]) b.gnd(s.get(p));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: 100e-9 });
  b.link(cap.get(1), s.get(2));
  b.gnd(cap.get(2));
  const u = inverter(b, "u2", "74LS04", "e30");
  b.link(s.get(2), u.get(1));
  const sim = spice(b.doc);
  let r = sim.run(0).result;
  assert.equal(sim.level(u.get(2)), H, "the empty capacitor reads LOW");
  const net = sim.netlist.netOfPoint.get(b.at(s.get(2)));
  const t0 = r.analog.nodes.get(net).curve.t0;
  // Below 1.3 V the 74LS input's own current joins the switch's (470 Ω).
  const g = 1 / 470 + 1 / TTL_BIAS.ohms;
  const vInf = (5 / 470 + TTL_BIAS.volts / TTL_BIAS.ohms) / g;
  const corner = t0 + (100e-9 / g) * Math.log(vInf / (vInf - TTL_BIAS.volts));
  close(r.wakeAt, corner, 1e-9, "the input's corner");
  // From there 470 Ω × C to the gate's 1.4 V — 1.3 µs on, inside the fast
  // window, so settled in the corner's own tick.
  r = sim.run(r.wakeAt).result;
  assert.ok(470 * 100e-9 * Math.log((5 - 1.3) / (5 - 1.4)) < FAST_WINDOW_S);
  assert.equal(sim.level(u.get(2)), L, "crossed");
  r = runTo(sim, r, 1);
  assert.equal(
    sim.level(u.get(2)),
    L,
    "the gate reads the rail through the switch",
  );
  close(r.nodeVolts.get(net), 5, 0.011, "at the rail");
});
