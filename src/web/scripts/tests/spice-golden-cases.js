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

// spice-golden-cases.js — the circuits Spice Lite is graded on against
// ngspice (features/done/spice-lite-3-plan.md, Phase 0), and the rubric that
// grades them. Read by `spice-golden.test.js` (which runs Spice Lite on each)
// and by `scripts/spice-golden.mjs` (which runs ngspice on each, through
// `scripts/spice-deck.mjs`, and writes `spice-golden/<area>.json`).
//
// Every circuit is built ONCE, here, with the timing fixtures' bench — the
// deck is generated from the same document Spice Lite runs.
//
// A case:
//   id, area    its name and its scorecard row (`AREAS`)
//   reference   which deck its numbers come from: "same" (Spice Lite's own
//               models — grades the engine), "device" (the parts' real
//               models — grades the models) or "ideal" (the same models less
//               the comparators' input bias currents: what a 555's datasheet
//               formula assumes)
//   models      component id → a device model other than the default
//   build()     → {doc, at: {name: address}, signals?: {id: [[t, level]]}}
//               (a signal flag's levels, "high"/"low", from each time on)
//   measure     what is read, one of:
//     {kind: "dc", volts: [name], amps: [junction key]}
//       the operating point: node volts, junction currents
//     {kind: "tran", stop, step, at: [t], volts: [name], coils: [id],
//      grids: [s]}
//       node volts and inductor currents at times; `step` is ngspice's
//     {kind: "period", stop, step, out: name, threshold, grids: [s]}
//       the last full cycle of `out` (rise to rise): period, high, low
//   `grids` are the extra tick spacings the tick-spacing check runs (beside
//   the circuit's own wake times).

import { bench } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { TRANSFORMER_DEF, acPeakOf } from "../catalog/ac-parts.js";

/** The grades, best first. */
export const GRADES = Object.freeze(["A", "B", "C", "D", "F"]);

/** Each grade's tolerance: relative, and absolute for a voltage under 1 V
    (the rubric's "2 % (or 20 mV for a voltage under 1 V)"). */
export const TOLERANCE = Object.freeze({
  A: Object.freeze({ rel: 0.02, volts: 0.02 }),
  B: Object.freeze({ rel: 0.1, volts: 0.05 }),
  C: Object.freeze({ rel: 0.5, volts: 0.25 }),
});

/** Two runs of one circuit at different tick spacings agree to this,
    relative: the rubric's "independent of tick spacing". Not tighter: the
    network solve stops within a nanoamp (spice/network.js TOLERANCE_A),
    which through 10 kΩ is 1e-5 V, and where its Newton steps start from
    moves with the spacing. */
export const INVARIANCE = 1e-4;

/**
 * The scorecard's rows. `floor` is the grade the area has reached — the test
 * fails below it (a ratchet: raise it when the test says the area beat it);
 * `target` the grade its phase brings it to — below it the area is a `todo`
 * until that phase is in `LANDED`, and a failure after.
 */
export const AREAS = Object.freeze([
  { id: "resistive", title: "Resistive DC", floor: "A", target: "A", phase: null }, // prettier-ignore
  { id: "single-rc", title: "Single-capacitor RC, Schmitt relaxation", floor: "A", target: "A", phase: null }, // prettier-ignore
  { id: "multi-rc", title: "Multi-capacitor RC networks", floor: "A", target: "A", phase: "2" }, // prettier-ignore
  { id: "coupled-osc", title: "Capacitor-coupled gate oscillators", floor: "A", target: "A", phase: "2" }, // prettier-ignore
  { id: "ne555", title: "NE555 timing", floor: "A", target: "A", phase: "1b" }, // prettier-ignore
  { id: "led", title: "LEDs", floor: "A", target: "A", phase: "4" },
  { id: "diode", title: "Silicon diodes", floor: "A", target: "A", phase: "4" }, // prettier-ignore
  { id: "cmos-stage", title: "CMOS output stage dynamics", floor: "A", target: "A", phase: null }, // prettier-ignore
  { id: "bjt-switch", title: "BJT as a saturated switch", floor: "A", target: "B", phase: "4" }, // prettier-ignore
  { id: "bjt-active", title: "BJT in its active region", floor: "A", target: "B", phase: "4" }, // prettier-ignore
  { id: "mosfet-on", title: "MOSFET fully on", floor: "A", target: "B", phase: "4" }, // prettier-ignore
  { id: "mosfet-threshold", title: "MOSFET near threshold", floor: "A", target: "B", phase: "4" }, // prettier-ignore
  { id: "inductors", title: "Inductors", floor: "A", target: "B", phase: "3" }, // prettier-ignore
  // Graded against the 74LS04's own schematic (2026-10-13): C at first,
  // from a stage drawn as a line — 3.6 V behind 120 Ω, where the Darlington
  // climbs toward 4.5 V under a light load, and a LOW 50 mV under its own —
  // and A once it was redrawn as the swept gate's corners, with the phase
  // splitter's current an input held LOW lifts (spice/output-stage.js).
  { id: "ls-stage", title: "74LS input and output stages", floor: "A", target: "A", phase: null }, // prettier-ignore
  { id: "mixed", title: "Mixed circuits", floor: "A", target: "A", phase: null }, // prettier-ignore
  // A clock brick's waves (spice/waves.js) into RCs and a Schmitt input, and
  // the bench parts — a ULN2003A's Darlingtons against their cards, the
  // optocoupler, op-amp, regulators and electronic load against their own
  // laws (no maker publishes a model to grade the law by: these grade the
  // solve on them). Compared by hand in features/done/
  // spice-lite-accuracy-review.md §5, all A; graded on every build since
  // 2026-10-13.
  { id: "waves", title: "Clock waves", floor: "A", target: "A", phase: null }, // prettier-ignore
  // The CD4000 timers as their silicon (spice/silicon.js): comparators,
  // discharge and flip-flops as the deck's behavioural blocks, the outputs
  // the family's MOSFET pairs — so the RC networks' swing past the rails
  // and back, and every crossing, are graded against SPICE rather than only
  // against each sheet's formula (2026-10-13).
  { id: "cd4000-timers", title: "CD4000 timers", floor: "A", target: "A", phase: null }, // prettier-ignore
  { id: "bench-parts", title: "Bench parts", floor: "A", target: "A", phase: null }, // prettier-ignore
  // A bridge rectifier off a transformer into its reservoir capacitor
  // (2026-10-20): its four diodes on the bridge's SIMPLER curve
  // (spice/diodes.js BRIDGE_FIT), graded against the 1N4007's own card —
  // the charge from Run and the ripple after, light to heavy.
  { id: "rectifier", title: "Bridge rectifier", floor: "A", target: "A", phase: null }, // prettier-ignore
]);

/** The plan's phases that have landed: an area of one of these is held to
    its target. */
export const LANDED = Object.freeze(["0", "1a", "1b", "2", "3", "4"]);

/** A value as a case id spells it: 10k, 1M, 10u, 330. */
function si(x) {
  for (const [scale, suffix] of [
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "u"],
    [1e-9, "n"],
  ]) {
    // prettier-ignore
    if (Math.abs(x) >= scale) return `${Number((x / scale).toPrecision(3))}${suffix}`; // prettier-ignore
  }
  return String(x);
}

/** A 14-pin logic chip on the rails. */
function chip(b, id, ref, anchor) {
  const u = b.seat(id, ref, anchor);
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  return u;
}

/** A CMOS output (a CD4069UB, input grounded: HIGH from t = 0) and the
    chip, for an RC to hang off. */
function cmosHigh(b) {
  const u = chip(b, "u1", "CD4069UB", "e10");
  b.gnd(u.get(1));
  return u;
}

/** The classic two-gate RC oscillator (spice-engine.test.js `twoGate`). */
function twoGate(ref, { r, c, rs = 0 }) {
  const b = bench();
  const u = chip(b, "u1", ref, "e10");
  b.link(u.get(2), u.get(3));
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(2));
  const cap = b.seat("c1", "cap-ceramic", "a40", { farads: c });
  b.link(cap.get(1), u.get(4));
  b.link(res.get(2), cap.get(2));
  if (rs) {
    const series = b.seat("rs", "resistor", "a50", { ohms: rs });
    b.link(series.get(1), cap.get(2));
    b.link(series.get(2), u.get(1));
  } else {
    b.link(cap.get(2), u.get(1));
  }
  return { doc: b.doc, at: { out: b.at(u.get(4)) } };
}

/** A Schmitt inverter's RC relaxation oscillator: R from output to input,
    C from input to GND. */
function relaxation(ref, r, c) {
  const b = bench();
  const u = chip(b, "u1", ref, "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  return { doc: b.doc, at: { out: b.at(u.get(2)) } };
}

/** The 555 astable (SLFS022K Figure 6-5), as timing-fixtures.js builds it. */
function astable(ra, rb, c) {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.link(u.get(2), u.get(6));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: c });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const rB = b.seat("r2", "resistor", "a40", { ohms: rb });
  b.link(rB.get(1), u.get(7));
  b.link(rB.get(2), u.get(6));
  const rA = b.seat("r1", "resistor", "a50", { ohms: ra });
  b.link(rA.get(1), u.get(7));
  b.vcc(rA.get(2));
  return { doc: b.doc, at: { out: b.at(u.get(3)) } };
}

/** An NPN switch: base through `rb` from +5 V, collector `load` to +5 V;
    `params` its grade and package. */
function npnSwitch(rb, { load = 1e3, params = {} } = {}) {
  const b = bench();
  const q = b.seat("q1", "npn", "a30", params);
  b.gnd(q.get(1));
  const base = b.seat("rb", "resistor", "a40", { ohms: rb });
  b.vcc(base.get(1));
  b.link(base.get(2), q.get(2));
  const rc = b.seat("rc", "resistor", "a50", { ohms: load });
  b.vcc(rc.get(1));
  b.link(rc.get(2), q.get(3));
  return { doc: b.doc, at: { collector: b.at(q.get(3)) } };
}

/** A PNP switch: emitter on +5 V, base through `rb` to ground, collector
    `load` to ground. */
function pnpSwitch(rb, { load = 1e3, params = {} } = {}) {
  const b = bench();
  const q = b.seat("q1", "pnp", "a30", params);
  b.vcc(q.get(1));
  const base = b.seat("rb", "resistor", "a40", { ohms: rb });
  b.gnd(base.get(1));
  b.link(base.get(2), q.get(2));
  const rc = b.seat("rc", "resistor", "a50", { ohms: load });
  b.gnd(rc.get(1));
  b.link(rc.get(2), q.get(3));
  return { doc: b.doc, at: { collector: b.at(q.get(3)) } };
}

/** A P-MOSFET, its source on +5 V and its gate `vg` under it from a stiff
    divider, drain 100 Ω to ground. */
function pmosLoad(vg, params = {}) {
  const b = bench();
  const q = b.seat("q1", "pmos", "a10", params);
  b.vcc(q.get(1));
  if (vg >= 5) b.gnd(q.get(2));
  else {
    const up = b.seat("r1", "resistor", "a20", { ohms: vg * 200 });
    b.vcc(up.get(1));
    b.link(up.get(2), q.get(2));
    const down = b.seat("r2", "resistor", "a30", { ohms: (5 - vg) * 200 });
    b.link(down.get(1), q.get(2));
    b.gnd(down.get(2));
  }
  const load = b.seat("rd", "resistor", "a40", { ohms: 100 });
  b.gnd(load.get(1));
  b.link(load.get(2), q.get(3));
  return { doc: b.doc, at: { drain: b.at(q.get(3)) } };
}

/** An N-MOSFET, its gate at `vg` from a stiff divider, drain 100 Ω to +5 V
    — a TO-92 (the 2N7000's logic-level grade) unless `params` say. */
function nmosLoad(vg, params = { case: "TO-92" }) {
  const b = bench();
  const q = b.seat("q1", "nmos", "a10", params);
  b.gnd(q.get(1));
  if (vg >= 5) b.vcc(q.get(2));
  else {
    const up = b.seat("r1", "resistor", "a20", { ohms: (5 - vg) * 200 });
    b.vcc(up.get(1));
    b.link(up.get(2), q.get(2));
    const down = b.seat("r2", "resistor", "a30", { ohms: vg * 200 });
    b.link(down.get(1), q.get(2));
    b.gnd(down.get(2));
  }
  const load = b.seat("rd", "resistor", "a40", { ohms: 100 });
  b.vcc(load.get(1));
  b.link(load.get(2), q.get(3));
  return { doc: b.doc, at: { drain: b.at(q.get(3)) } };
}

/** +5 V through `ohms` into an LED of `color`. */
function ledLoad(ohms, color = "red") {
  const b = bench();
  const r = b.seat("r1", "resistor", "a20", { ohms });
  const d = b.seat("d1", "led", "a30", { color });
  b.vcc(r.get(1));
  b.link(r.get(2), d.get(1));
  b.gnd(d.get(2));
  return { doc: b.doc, at: {} };
}

/** A 74LS04 whose first inverter's input is tied `input` ("gnd", "vcc", or
    through `ohms` to ground) and whose output carries `load`: "gnd" or "vcc"
    (a resistor of `ohms` to that rail), "led-gnd" (a red LED through `ohms`
    to ground: the output sources it) or "led-vcc" (from +5 V through `ohms`
    and a red LED: the output sinks it). Measured at the output, the input
    and the LED. */
function lsStage({ input = "gnd", inputOhms = 0, load, ohms, volts = 5 }) {
  const b = bench({ volts });
  const u = chip(b, "u1", "74LS04", "e10");
  if (inputOhms) {
    const ri = b.seat("ri", "resistor", "a5", { ohms: inputOhms });
    b.link(ri.get(1), u.get(1));
    b.gnd(ri.get(2));
  } else if (input === "gnd") b.gnd(u.get(1));
  else b.vcc(u.get(1));
  const r = b.seat("r1", "resistor", "a30", { ohms });
  if (load === "led-vcc") {
    // +5 V → R → LED → the output, which sinks it.
    const d = b.seat("d1", "led", "a40", { color: "red" });
    b.vcc(r.get(1));
    b.link(r.get(2), d.get(1));
    b.link(d.get(2), u.get(2));
  } else {
    b.link(r.get(1), u.get(2));
    if (load === "gnd") b.gnd(r.get(2));
    else if (load === "vcc") b.vcc(r.get(2));
    else {
      // The output → R → LED → ground: it sources it.
      const d = b.seat("d1", "led", "a40", { color: "red" });
      b.link(r.get(2), d.get(1));
      b.gnd(d.get(2));
    }
  }
  return { doc: b.doc, at: { out: b.at(u.get(2)), in: b.at(u.get(1)) } };
}

/** A period measurement over `cycles` of a period near `t`. */
const period = (t, { cycles = 6, out = "out", threshold = 2.5 } = {}) => ({
  kind: "period",
  stop: cycles * t,
  step: t / 4000,
  out,
  threshold,
  grids: [t / 10, t / 40],
});

export const GOLDEN_CASES = Object.freeze([
  // ── Resistive DC ──────────────────────────────────────────────────────
  {
    id: "divider-chain",
    area: "resistive",
    reference: "same",
    build() {
      const b = bench();
      const r1 = b.seat("r1", "resistor", "a20", { ohms: 10e3 });
      const r2 = b.seat("r2", "resistor", "a30", { ohms: 4.7e3 });
      const r3 = b.seat("r3", "resistor", "a40", { ohms: 2.2e3 });
      b.vcc(r1.get(1));
      b.link(r1.get(2), r2.get(1));
      b.link(r2.get(2), r3.get(1));
      b.gnd(r3.get(2));
      return { doc: b.doc, at: { a: b.at(r1.get(2)), b: b.at(r2.get(2)) } };
    },
    measure: { kind: "dc", volts: ["a", "b"] },
  },

  // ── Single-capacitor RC ───────────────────────────────────────────────
  {
    id: "cmos-rc-ramp",
    area: "single-rc",
    reference: "same",
    build() {
      const b = bench();
      const u = cmosHigh(b);
      const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
      b.link(r.get(1), u.get(2));
      const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
      b.link(c.get(1), r.get(2));
      b.gnd(c.get(2));
      return { doc: b.doc, at: { cap: b.at(r.get(2)) } };
    },
    measure: { kind: "tran", stop: 0.05, step: 1e-5, at: [0.002, 0.005, 0.01, 0.02, 0.05], volts: ["cap"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    id: "schmitt-cd40106b-100k-1u",
    area: "single-rc",
    reference: "same",
    build: () => relaxation("CD40106B", 100e3, 1e-6),
    measure: period(0.0816),
  },
  {
    id: "schmitt-cd40106b-10k-10u",
    area: "single-rc",
    reference: "same",
    build: () => relaxation("CD40106B", 10e3, 10e-6),
    measure: period(0.0845),
  },

  // ── Multi-capacitor RC (D3) ───────────────────────────────────────────
  {
    id: "rc-ladder",
    area: "multi-rc",
    reference: "same",
    build() {
      const b = bench();
      const u = cmosHigh(b);
      const r1 = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
      b.link(r1.get(1), u.get(2));
      const c1 = b.seat("c1", "cap-ceramic", "a35", { farads: 1e-6 });
      b.link(c1.get(1), r1.get(2));
      b.gnd(c1.get(2));
      const r2 = b.seat("r2", "resistor", "a40", { ohms: 10e3 });
      b.link(r2.get(1), r1.get(2));
      const c2 = b.seat("c2", "cap-ceramic", "a45", { farads: 1e-6 });
      b.link(c2.get(1), r2.get(2));
      b.gnd(c2.get(2));
      return { doc: b.doc, at: { out: b.at(r2.get(2)) } };
    },
    measure: { kind: "tran", stop: 0.08, step: 1e-5, at: [0.01, 0.02, 0.05, 0.08], volts: ["out"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    id: "high-pass",
    area: "multi-rc",
    reference: "same",
    build() {
      const b = bench();
      const u = cmosHigh(b);
      const r1 = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
      b.link(r1.get(1), u.get(2));
      const c1 = b.seat("c1", "cap-ceramic", "a35", { farads: 1e-6 });
      b.link(c1.get(1), r1.get(2));
      b.gnd(c1.get(2));
      const c2 = b.seat("c2", "cap-ceramic", "a40", { farads: 1e-6 });
      b.link(c2.get(1), r1.get(2));
      const r2 = b.seat("r2", "resistor", "a45", { ohms: 10e3 });
      b.link(r2.get(1), c2.get(2));
      b.gnd(r2.get(2));
      return { doc: b.doc, at: { out: b.at(r2.get(1)) } };
    },
    measure: { kind: "tran", stop: 0.04, step: 1e-5, at: [0.002, 0.005, 0.01, 0.02, 0.04], volts: ["out"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },

  // ── Capacitor-coupled gate oscillators (D1) ───────────────────────────
  // CMOS only. A 74LS pair (1 kΩ, 100 µF) has no same-model reference:
  // ngspice's step control collapses on its one-way stages switching into a
  // 1 kΩ / 100 µF loop, hard comparator or smooth (spice-engine.test.js
  // still holds the 74LS04 and 74LS14 to running).
  ...[
    ["CD4069UB", { r: 100e3, c: 1e-6 }, 0.167],
    ["CD4069UB", { r: 100e3, c: 1e-6, rs: 220e3 }, 0.22],
    ["CD40106B", { r: 100e3, c: 1e-6 }, 0.11],
    ["CD40106B", { r: 100e3, c: 1e-6, rs: 220e3 }, 0.11],
  ].map(([ref, rc, t]) => ({
    id: `two-gate-${ref.toLowerCase()}${rc.rs ? "-rs" : ""}`,
    area: "coupled-osc",
    reference: "same",
    build: () => twoGate(ref, rc),
    measure: period(t),
  })),

  // ── NE555 (D2) ────────────────────────────────────────────────────────
  ...[
    [10e3, 10e3, 10e-6],
    [10e3, 1e3, 10e-6],
    [1e3, 100e3, 1e-6],
    [1e6, 1e6, 1e-6],
  ].map(([ra, rb, c]) => ({
    id: `ne555-${si(ra)}-${si(rb)}-${si(c)}`,
    area: "ne555",
    // The datasheet's formula: ideal comparators, no input bias current.
    reference: "ideal",
    build: () => astable(ra, rb, c),
    measure: period(Math.LN2 * (ra + 2 * rb) * c, { threshold: 1.5 }),
  })),

  // ── LEDs, diodes ──────────────────────────────────────────────────────
  ...[10e3, 1e3, 330, 100].map((ohms) => ({
    id: `led-red-${si(ohms)}`,
    area: "led",
    reference: "device",
    build: () => ledLoad(ohms),
    measure: { kind: "dc", amps: ["d1"] },
  })),
  // Every other colour, at a common current and a faint one.
  ...["yellow", "green", "blue", "white"].flatMap((color) =>
    [330, 10e3].map((ohms) => ({
      id: `led-${color}-${si(ohms)}`,
      area: "led",
      reference: "device",
      build: () => ledLoad(ohms, color),
      measure: { kind: "dc", amps: ["d1"] },
    })),
  ),
  {
    id: "diode-led-330",
    area: "diode",
    reference: "device",
    build() {
      const b = bench();
      const dd = b.seat("d0", "diode", "a10");
      const d = b.seat("d1", "led", "a20", { color: "red" });
      const r = b.seat("r1", "resistor", "a30", { ohms: 330 });
      b.vcc(dd.get(1));
      b.link(dd.get(2), d.get(1));
      b.link(d.get(2), r.get(1));
      b.gnd(r.get(2));
      return { doc: b.doc, at: {} };
    },
    measure: { kind: "dc", amps: ["d1"] },
  },

  // ── CMOS output stage ─────────────────────────────────────────────────
  // A CMOS HIGH straight into 1 µF: saturated, then along its square law —
  // at 5 V and at 10 V, where its figures (and so its device card) differ.
  ...[
    [5, 0.003, [0.0002, 0.0005, 0.0008, 0.001, 0.0015, 0.002, 0.003]],
    [10, 0.0015, [0.0001, 0.0003, 0.0004, 0.0005, 0.0007, 0.001, 0.0015]],
  ].map(([volts, stop, at]) => ({
    id: volts === 5 ? "cmos-high-into-1u" : `cmos-high-into-1u-${volts}v`,
    area: "cmos-stage",
    reference: "device",
    build() {
      const b = bench({ volts });
      const u = cmosHigh(b);
      const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
      b.link(c.get(1), u.get(2));
      b.gnd(c.get(2));
      return { doc: b.doc, at: { out: b.at(u.get(2)) } };
    },
    measure: { kind: "tran", stop, step: 1e-6, at, volts: ["out"], grids: [1e-4, 1e-5] }, // prettier-ignore
  })),

  // ── Transistors ───────────────────────────────────────────────────────
  // Every grade against its vendor card or its own fit (spice/transistors.js;
  // the deck's `gradeCard`), switched hard and run in its active region.
  ...[
    ["npn-switch-10k", npnSwitch, 10e3, {}],
    ["npn-general-switch-10k", npnSwitch, 10e3, { params: { grade: "general" } }], // prettier-ignore
    ["npn-power-switch", npnSwitch, 100, { load: 10, params: { case: "TO-220" } }], // prettier-ignore
    ["npn-darlington-switch", npnSwitch, 1e3, { load: 10, params: { case: "TO-220", grade: "darlington" } }], // prettier-ignore
    ["pnp-switch-10k", pnpSwitch, 10e3, {}],
    ["pnp-general-switch-10k", pnpSwitch, 10e3, { params: { grade: "general" } }], // prettier-ignore
    ["pnp-power-switch", pnpSwitch, 100, { load: 10, params: { case: "TO-220" } }], // prettier-ignore
  ].map(([id, build, rb, opts]) => ({
    id,
    area: "bjt-switch",
    reference: "device",
    build: () => build(rb, opts),
    measure: { kind: "dc", volts: ["collector"] },
  })),
  ...[
    ["npn-active-1M", npnSwitch, 1e6, {}],
    ["npn-active-100k", npnSwitch, 100e3, {}],
    ["npn-general-active-1M", npnSwitch, 1e6, { params: { grade: "general" } }], // prettier-ignore
    ["npn-power-active", npnSwitch, 47e3, { load: 10, params: { case: "TO-220" } }], // prettier-ignore
    ["npn-darlington-active", npnSwitch, 10e3, { load: 100, params: { case: "TO-220", grade: "darlington" } }], // prettier-ignore
    ["pnp-active-1M", pnpSwitch, 1e6, {}],
    ["pnp-general-active-1M", pnpSwitch, 1e6, { params: { grade: "general" } }], // prettier-ignore
  ].map(([id, build, rb, opts]) => ({
    id,
    area: "bjt-active",
    reference: "device",
    build: () => build(rb, opts),
    measure: { kind: "dc", volts: ["collector"] },
  })),
  ...[
    ["nmos-on-4v", nmosLoad, 4, undefined],
    ["nmos-on-5v", nmosLoad, 5, undefined],
    ["nmos-logic-power-on-3v", nmosLoad, 3, { grade: "logic-power" }],
    ["nmos-logic-power-on-5v", nmosLoad, 5, { grade: "logic-power" }],
    ["nmos-power-on-4.5v", nmosLoad, 4.5, {}],
    ["nmos-power-on-5v", nmosLoad, 5, {}],
    ["pmos-on-5v", pmosLoad, 5, { case: "TO-92" }],
    ["pmos-power-on-4v", pmosLoad, 4, {}],
    ["pmos-power-on-5v", pmosLoad, 5, {}],
  ].map(([id, build, vg, params]) => ({
    id,
    area: "mosfet-on",
    reference: "device",
    build: () => build(vg, params),
    measure: { kind: "dc", volts: ["drain"] },
  })),
  ...[
    ["nmos-threshold-2.5v", nmosLoad, 2.5, undefined],
    ["nmos-threshold-3v", nmosLoad, 3, undefined],
    ["nmos-threshold-3.5v", nmosLoad, 3.5, undefined],
    ["nmos-power-threshold-3.65v", nmosLoad, 3.65, {}],
    ["pmos-threshold-3v", pmosLoad, 3, { case: "TO-92" }],
    ["pmos-power-threshold-3v", pmosLoad, 3, {}],
  ].map(([id, build, vg, params]) => ({
    id,
    area: "mosfet-threshold",
    reference: "device",
    build: () => build(vg, params),
    measure: { kind: "dc", volts: ["drain"] },
  })),

  // ── Inductors (Phase 3) ───────────────────────────────────────────────
  {
    // +5 V through 100 Ω into a 100 mH coil (2 holes: its winding ~49 Ω).
    id: "rl-step",
    area: "inductors",
    reference: "same",
    build() {
      const b = bench();
      const r = b.seat("r1", "resistor", "a20", { ohms: 100 });
      const l = b.seat("l1", "inductor", "a30", { henries: 0.1 });
      b.vcc(r.get(1));
      b.link(r.get(2), l.get(1));
      b.gnd(l.get(2));
      return { doc: b.doc, at: { mid: b.at(r.get(2)) } };
    },
    measure: { kind: "tran", stop: 0.004, step: 2e-7, at: [0.0003, 0.0007, 0.0014, 0.0035], volts: ["mid"], coils: ["l1"], grids: [1e-4, 1e-5] }, // prettier-ignore
  },
  {
    // The coil's current decays through the flyback diode once the switch
    // lets go.
    id: "relay-flyback",
    area: "inductors",
    reference: "same",
    build: () => relayDriver(true),
    measure: { kind: "tran", stop: 0.023, step: 1e-6, at: [0.0195, 0.0203, 0.0206, 0.021, 0.0215], volts: ["collector"], coils: ["l1"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    // …and with no diode, the transistor's breakdown carries it.
    id: "relay-kick",
    area: "inductors",
    reference: "same",
    build: () => relayDriver(false),
    measure: { kind: "tran", stop: 0.0202, step: 1e-7, at: [0.02002, 0.02005, 0.0201], volts: ["collector"], coils: ["l1"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    // +5 V through 50 Ω and a 100 mH coil onto 1 µF: it rings at ~500 Hz.
    id: "rlc-series",
    area: "inductors",
    reference: "same",
    build() {
      const b = bench();
      const r = b.seat("r1", "resistor", "a20", { ohms: 50 });
      const l = b.seat("l1", "inductor", "a30", { henries: 0.1 });
      const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
      b.vcc(r.get(1));
      b.link(r.get(2), l.get(1));
      b.link(l.get(2), c.get(1));
      b.gnd(c.get(2));
      return { doc: b.doc, at: { cap: b.at(c.get(1)) } };
    },
    measure: { kind: "tran", stop: 0.008, step: 2e-7, at: [0.0005, 0.001, 0.0015, 0.002, 0.003, 0.005, 0.008], volts: ["cap"], grids: [1e-4, 1e-5] }, // prettier-ignore
  },

  // ── 74LS stages ───────────────────────────────────────────────────────
  // A 74LS04 against its own datasheet schematic, transistor by transistor
  // (scripts/spice-deck.mjs `lsGate`): the output HIGH and LOW into the
  // loads a bench gives one, the LED it is most often asked to light, and
  // its input pulled down through a resistor.
  ...[
    ["ls-high-100k", { load: "gnd", ohms: 100e3 }],
    ["ls-high-10k", { load: "gnd", ohms: 10e3 }],
    ["ls-high-2k2", { load: "gnd", ohms: 2.2e3 }],
    ["ls-low-10k", { input: "vcc", load: "vcc", ohms: 10e3 }],
    ["ls-low-1k", { input: "vcc", load: "vcc", ohms: 1e3 }],
    ["ls-low-470", { input: "vcc", load: "vcc", ohms: 470 }],
  ].map(([id, opts]) => ({
    id,
    area: "ls-stage",
    reference: "device",
    build: () => lsStage(opts),
    measure: { kind: "dc", volts: ["out"] },
  })),
  ...[
    ["ls-source-led-330", { load: "led-gnd", ohms: 330 }],
    ["ls-source-led-1k", { load: "led-gnd", ohms: 1e3 }],
    ["ls-sink-led-330", { input: "vcc", load: "led-vcc", ohms: 330 }],
    ["ls-sink-led-1k", { input: "vcc", load: "led-vcc", ohms: 1e3 }],
  ].map(([id, opts]) => ({
    id,
    area: "ls-stage",
    reference: "device",
    build: () => lsStage(opts),
    measure: { kind: "dc", volts: ["out"], amps: ["d1"] },
  })),
  // Its LOW on the plateau (220 Ω from VCC: all the pull-down's base drive)
  // and its HIGH under a load, across the sheet's supply range: the stage's
  // currents follow VCC.
  ...[4.75, 5, 5.25].flatMap((volts) => [
    {
      id: `ls-low-220-${volts}v`,
      area: "ls-stage",
      reference: "device",
      build: () => lsStage({ input: "vcc", load: "vcc", ohms: 220, volts }),
      measure: { kind: "dc", volts: ["out"] },
    },
    {
      id: `ls-high-2k2-${volts}v`,
      area: "ls-stage",
      reference: "device",
      build: () => lsStage({ load: "gnd", ohms: 2.2e3, volts }),
      measure: { kind: "dc", volts: ["out"] },
    },
  ]),
  ...[1e3, 470].map((ohms) => ({
    id: `ls-input-pulldown-${si(ohms)}`,
    area: "ls-stage",
    reference: "device",
    build: () => lsStage({ inputOhms: ohms, load: "gnd", ohms: 10e3 }),
    measure: { kind: "dc", volts: ["in"] },
  })),
  {
    // Its HIGH through 10 kΩ into 1 µF: the curve every LS-timed RC follows.
    id: "ls-rc-10k-1u",
    area: "ls-stage",
    reference: "device",
    build() {
      const b = bench();
      const u = chip(b, "u1", "74LS04", "e10");
      b.gnd(u.get(1));
      const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
      b.link(r.get(1), u.get(2));
      const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
      b.link(c.get(1), r.get(2));
      b.gnd(c.get(2));
      return { doc: b.doc, at: { cap: b.at(r.get(2)) } };
    },
    measure: { kind: "tran", stop: 0.05, step: 1e-5, at: [0.002, 0.005, 0.01, 0.02, 0.05], volts: ["cap"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    // Three inverters in a row, the last into 100 kΩ: its input held at the
    // LOW before it, not at ground, leaves its pull-down a little on (the
    // phase splitter) — a light load's HIGH 0.2 V lower than the first's.
    id: "ls-chain",
    area: "ls-stage",
    reference: "device",
    build() {
      const b = bench();
      const u = chip(b, "u1", "74LS04", "e10");
      b.gnd(u.get(1));
      b.link(u.get(2), u.get(3));
      b.link(u.get(4), u.get(5));
      const r = b.seat("r1", "resistor", "a30", { ohms: 100e3 });
      b.link(r.get(1), u.get(6));
      b.gnd(r.get(2));
      return { doc: b.doc, at: { y1: b.at(u.get(2)), y2: b.at(u.get(4)), y3: b.at(u.get(6)) } }; // prettier-ignore
    },
    measure: { kind: "dc", volts: ["y1", "y2", "y3"] },
  },
  {
    // A 74LS00: a NAND's LOW into one input of the next, its other input
    // HIGH, into 100 kΩ — the splitter lifted by the one input that is LOW.
    id: "ls-nand-chain",
    area: "ls-stage",
    reference: "device",
    build() {
      const b = bench();
      const u = chip(b, "u1", "74LS00", "e10");
      b.vcc(u.get(1));
      b.vcc(u.get(2));
      b.link(u.get(3), u.get(4));
      b.vcc(u.get(5));
      const r = b.seat("r1", "resistor", "a30", { ohms: 100e3 });
      b.link(r.get(1), u.get(6));
      b.gnd(r.get(2));
      return { doc: b.doc, at: { y1: b.at(u.get(3)), y2: b.at(u.get(6)) } }; // prettier-ignore
    },
    measure: { kind: "dc", volts: ["y1", "y2"] },
  },

  // ── Mixed circuits ────────────────────────────────────────────────────
  // Families and devices in one circuit, where each one's error lands on the
  // next: the place compounding would show.
  {
    // A CD40106B relaxation oscillator whose output also drives a 74LS04
    // input — the TTL input's current pulls on the CMOS output the RC hangs
    // from, so the period moves with both stages.
    id: "mixed-cmos-osc-ls-load",
    area: "mixed",
    reference: "device",
    build() {
      const { doc, at } = mixedOscillator();
      return { doc, at };
    },
    measure: period(0.0816),
  },
  {
    // A 74LS04 HIGH through 10 kΩ into 1 µF, read by a CD40106B, whose
    // output drives an NPN through 1 kΩ, switching a 100 mH coil with a
    // flyback diode: the coil runs while the capacitor charges, and lets
    // go once it crosses the Schmitt's upper threshold.
    id: "mixed-ls-rc-schmitt-coil",
    area: "mixed",
    reference: "device",
    build: () => mixedChain(),
    // Read clear of the moment it lets go (≈15 ms): a reading taken AT an
    // edge grades which side of it each tool lands, not the circuit.
    measure: { kind: "tran", stop: 0.03, step: 1e-6, at: [0.002, 0.005, 0.01, 0.013, 0.022, 0.03], volts: ["cap", "collector"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    // …and the coil's current while it runs (once it has let go there is
    // only a picoamp of leakage left to compare, which no rubric reads).
    id: "mixed-ls-rc-schmitt-coil-current",
    area: "mixed",
    reference: "device",
    build: () => mixedChain(),
    measure: { kind: "tran", stop: 0.014, step: 1e-6, at: [0.001, 0.002, 0.005, 0.01, 0.013], coils: ["l1"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    // A ring of three inversions — a CD40106B and two 74LS04 inverters — timed
    // by 10 kΩ and 1 µF hung from the last LS output: each half charges the
    // capacitor from that output's HIGH or LOW to the Schmitt's other
    // threshold, so the period is the LS output levels, under a load that
    // falls as the capacitor fills.
    id: "mixed-ls-rc-ring",
    area: "mixed",
    reference: "device",
    build: () => mixedRing(),
    measure: period(0.011),
  },

  // ── Clock waves ───────────────────────────────────────────────────────
  // Each the ideal source Spice Lite makes it, into an RC: the reference is
  // the same source in ngspice (`waveSource`), so these grade the curve
  // through a moving source. A sawtooth's drop is read 0.1 ms after it,
  // where both sides of the step agree.
  ...[
    [
      "triangle",
      10,
      {},
      [0.05, 0.1, 0.125, 0.15, 0.175, 0.2, 0.25, 0.275, 0.3],
    ],
    [
      "sine",
      50,
      {},
      [0.005, 0.01, 0.015, 0.02, 0.03, 0.045, 0.05, 0.055, 0.06],
    ],
    ["ramp-up", 20, { high: true }, [0.0251, 0.04, 0.0501, 0.075, 0.1001, 0.12, 0.1501, 0.17]], // prettier-ignore
    ["ramp-down", 20, {}, [0.02, 0.0501, 0.07, 0.1001, 0.12, 0.1501, 0.17]],
    ["trapezoid", 20, {}, [0.01, 0.02, 0.025, 0.04, 0.05, 0.075, 0.09, 0.1, 0.125, 0.15]], // prettier-ignore
    ["triangle", 250, { ohms: 1e3 }, [0.002, 0.004, 0.005, 0.006, 0.008, 0.01, 0.011]], // prettier-ignore
    // Set an Amplitude about an Offset — and past the supply's rails,
    // clipped flat on them.
    ["sine", 50, { swing: { amplitude: 1, offset: 2.5 } }, [0.005, 0.01, 0.015, 0.02, 0.03, 0.045, 0.06]], // prettier-ignore
    ["ramp-up", 20, { high: true, swing: { amplitude: 2, offset: 3 } }, [0.0251, 0.04, 0.0501, 0.075, 0.1001, 0.12]], // prettier-ignore
    ["triangle", 10, { swing: { amplitude: 8, offset: 2.5 } }, [0.02, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3]], // prettier-ignore
    ["sine", 20, { swing: { amplitude: 9, offset: 3 } }, [0.005, 0.01, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1]], // prettier-ignore
  ].map(([wave, hz, rc, at]) => ({
    id: `wave-${wave}-${hz}hz-${rc.high ? "high" : "low"}-pass${rc.ohms ? `-${si(rc.ohms)}` : ""}${rc.swing ? `-${si(rc.swing.amplitude)}vpp-at-${si(rc.swing.offset)}v` : ""}`, // prettier-ignore
    area: "waves",
    reference: "same",
    build: () => waveRc(wave, hz, rc),
    measure: { kind: "tran", stop: Math.max(...at), step: Math.max(...at) / 20000, at, volts: ["out"], grids: [1 / hz / 20, 1 / hz / 80] }, // prettier-ignore
  })),
  {
    // A 10 Hz sine into a CD40106B (its output into 100 kΩ): it switches
    // where the wave crosses its VT+ and VT−, so its output's HIGH and LOW
    // are the wave's own times between them.
    id: "wave-sine-10hz-schmitt",
    area: "waves",
    reference: "same",
    build() {
      const b = bench();
      const u = chip(b, "u1", "CD40106B", "e10");
      waveClock(b, "sine", 10, "e5");
      b.link("a5", u.get(1));
      const r = b.seat("r1", "resistor", "a30", { ohms: 100e3 });
      b.link(r.get(1), u.get(2));
      b.gnd(r.get(2));
      return { doc: b.doc, at: { out: b.at(u.get(2)) } };
    },
    measure: period(0.1, { cycles: 4 }),
  },

  // ── CD4000 timers ─────────────────────────────────────────────────────
  // The 4060's and 4541's two-inverter oscillator, its junction swinging
  // past both rails into the input's protection diodes behind Rs: about
  // 2.2·Rx·Cx (the 4060's sheet; the 4541's says 2.3).
  ...[
    ["CD4060B", 100e3, 1e-6, 220e3],
    ["CD4060B", 10e3, 10e-6, 22e3],
    ["CD4060B", 100e3, 1e-6, 1e6],
    ["CD4541B", 100e3, 1e-6, 220e3],
  ].map(([ref, rx, cx, rs]) => ({
    id: `${ref.toLowerCase()}-osc-${si(rx)}-${si(cx)}-rs-${si(rs)}`,
    area: "cd4000-timers",
    reference: "device",
    build: () => rcOscillator(ref, { rx, cx, rs }),
    measure: period(2.2 * rx * cx),
  })),
  // The 4047 astable: OSC OUT at 2.2·RC, Q at 4.4·RC.
  ...[
    [13, 2.2],
    [10, 4.4],
  ].map(([out, k]) => ({
    id: `cd4047b-astable-${out === 13 ? "osc" : "q"}-100k-1u`,
    area: "cd4000-timers",
    reference: "device",
    build: () => astable4047(100e3, 1e-6, out),
    measure: period(k * 0.1),
  })),
  // The monostables, retriggered every 0.25 s: Q's HIGH is the pulse —
  // 0.5, 0.2·ln VDD and 1 times Rx·Cx, and the discharge before it.
  ...["CD4098B", "CD4528B", "CD4538B"].map((ref) => ({
    id: `${ref.toLowerCase()}-pulse-100k-1u`,
    area: "cd4000-timers",
    reference: "device",
    build: () => monostable(ref, { rx: 100e3, cx: 1e-6, every: 0.25, pulses: 4 }), // prettier-ignore
    // ngspice stepped finely enough for the discharge (≈83 Ω into 1 µF): at
    // the period's own step it overshot the lower comparator by 30 mV.
    measure: { ...period(0.25, { cycles: 4 }), step: 2e-6 },
  })),

  // ── Bench parts ───────────────────────────────────────────────────────
  // A ULN2003A channel against its Darlington's own cards (§5.2), on and
  // through an input resistor.
  ...[
    [5, 1000, 0],
    [5, 100, 0],
    [12, 100, 0],
    [12, 24, 0],
    [5, 100, 10e3],
    [5, 100, 100e3],
    [12, 100, 47e3],
  ].map(([volts, ohms, rin]) => ({
    id: `uln2003a-${volts}v-${si(ohms)}${rin ? `-in-${si(rin)}` : ""}`,
    area: "bench-parts",
    reference: "device",
    build: () => ulnChannel(volts, ohms, rin),
    measure: { kind: "dc", volts: rin ? ["out", "in"] : ["out"] },
  })),
  // The optocoupler saturated, in its linear region and off.
  ...[
    [470, 1000],
    [4700, 1000],
    [47e3, 1000],
    [4700, 10e3],
    [2200, 4700],
  ].map(([rin, rc]) => ({
    id: `opto-4n35-${si(rin)}-${si(rc)}`,
    area: "bench-parts",
    reference: "same",
    build: () => optoSwitch(rin, rc),
    measure: { kind: "dc", volts: ["collector"] },
  })),
  // An LM358 amplifier, in its range and against its clamp.
  ...[
    [8000, 1000],
    [2000, 1000],
    [1000, 1000],
  ].map(([top, bottom]) => ({
    id: `lm358-x2-${si(top)}-${si(bottom)}`,
    area: "bench-parts",
    reference: "same",
    build: () => opAmpGain(top, bottom),
    measure: { kind: "dc", volts: ["out"] },
  })),
  // An LM339's open collector sinking into its pull-up — on its saturation
  // line, and against its sink limit — and a relaxation oscillator round one
  // (its hysteresis through the pull-up it lets go to).
  ...[
    [5, 10e3],
    [5, 100],
    [12, 330],
  ].map(([volts, pull]) => ({
    id: `lm339-sink-${volts}v-${si(pull)}`,
    area: "bench-parts",
    reference: "same",
    build: () => comparatorSink(volts, pull),
    measure: { kind: "dc", volts: ["out"] },
  })),
  {
    id: "lm339-relaxation-100k-1u",
    area: "bench-parts",
    reference: "same",
    build: () => comparatorRelaxation(100e3, 1e-6),
    measure: period(0.14),
  },
  // An LM7805 holding, loaded and in dropout; into an electronic load —
  // CP at 1 W, under what the regulator gives where RON's line meets P / V
  // (√(P / RON), 1.41 A): past it a CP load has a second balance down on
  // that line, and a solve from 0 V finds that one.
  ...[
    [9, 1000, null],
    [9, 100, null],
    [9, 22, null],
    [6, 100, null],
    [9, 0, { mode: "cc", amps: 0.25 }],
    [9, 0, { mode: "cr", ohms: 47 }],
    [9, 0, { mode: "cp", watts: 1 }],
  ].map(([volts, ohms, load]) => ({
    id: `lm7805-${volts}v-${load ? `load-${load.mode}` : si(ohms)}`,
    area: "bench-parts",
    reference: "same",
    build: () => regulator7805(volts, ohms, load),
    measure: { kind: "dc", volts: ["out"] },
  })),
  // A CV load behind a resistance from 9 V: it holds its setting (and its
  // 10 mV an amp), or draws nothing set past what reaches it.
  ...[
    [10, 5],
    [4.7, 5],
    [10, 9.5],
  ].map(([ohms, set]) => ({
    id: `load-cv-${set}v-behind-${si(ohms)}`,
    area: "bench-parts",
    reference: "same",
    build: () => loadBehind(9, ohms, { mode: "cv", volts: set }),
    measure: { kind: "dc", volts: ["out"] },
  })),
  // An LM7805 charging 1 mF (and 100 Ω) off a 9 V supply limited to
  // 0.25 A: the supply in constant current, its + where the regulator's
  // input meets the limit, until the output is up — then constant voltage.
  {
    id: "lm7805-9v-limited-0.25a-1m",
    area: "bench-parts",
    reference: "same",
    build: () => regulator7805(9, 100, null, { limit: 0.25, farads: 1e-3 }),
    measure: { kind: "tran", stop: 0.04, step: 4e-6, at: [0.002, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04], volts: ["out"], grids: [0.001, 0.0037] }, // prettier-ignore
  },
  // An LM317 set by its two resistors.
  ...[240, 390, 1000, 2000].map((r2) => ({
    id: `lm317-240-${si(r2)}`,
    area: "bench-parts",
    reference: "same",
    build: () => regulator317(r2),
    measure: { kind: "dc", volts: ["out"] },
  })),

  // ── Bridge rectifier ──────────────────────────────────────────────────
  // 120 V~ 60 Hz through the 120 → 12 V transformer into a DB105, its +
  // across a reservoir capacitor and a load: the charge over the first
  // cycles, then the ripple's top and bottom — a light load, a common one,
  // and amps through a big capacitor. And the common one on Spice Lite's own
  // models, grading the solve.
  ...[
    [10e3, 47e-6, "device"],
    [100, 470e-6, "device"],
    [22, 2200e-6, "device"],
    [100, 470e-6, "same"],
  ].map(([ohms, farads, reference]) => ({
    id: `bridge-${si(ohms)}-${si(farads)}F${reference === "same" ? "-same" : ""}`,
    area: "rectifier",
    reference,
    build: () => bridgeSupply(ohms, farads),
    measure: { kind: "tran", stop: 0.1, step: 1e-5, at: [0.002, 0.004, 0.006, 0.01, 0.02, 0.05, 0.0917, 0.0958, 0.1], volts: ["out"], grids: [1 / 60 / 20] }, // prettier-ignore
  })),
  // A 12 V~ 60 Hz AC adapter — an isolated output, behind its own 1.2 Ω —
  // straight into the bridge, its − on the ground rail (which mains on its
  // own shorts through a diode every other half-cycle).
  ...[
    [100, 470e-6, "device"],
    [100, 470e-6, "same"],
  ].map(([ohms, farads, reference]) => ({
    id: `bridge-adapter-${si(ohms)}-${si(farads)}F${reference === "same" ? "-same" : ""}`, // prettier-ignore
    area: "rectifier",
    reference,
    build: () => bridgeSupply(ohms, farads, { adapter: true }),
    measure: { kind: "tran", stop: 0.1, step: 1e-5, at: [0.002, 0.004, 0.006, 0.01, 0.02, 0.05, 0.0917, 0.0958, 0.1], volts: ["out"], grids: [1 / 60 / 20] }, // prettier-ignore
  })),
]);

/** 120 V~ 60 Hz → the 120 → 12 V transformer → a DB105 at e10, its −
    grounded, its + across `farads` and `ohms` — or, `adapter`, fed by a
    12 V~ AC adapter instead of mains and the transformer. */
function bridgeSupply(ohms, farads, { adapter = false } = {}) {
  const b = bench();
  b.seat("br1", "bridge-rectifier", "e10");
  const r = b.seat("r1", "resistor", "a30", { ohms });
  b.link("e10", r.get(1));
  b.gnd(r.get(2));
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads });
  b.link("e10", c.get(1));
  b.gnd(c.get(2));
  b.gnd("e12");
  if (adapter) {
    b.doc.components.push(
      { id: "adp1", kind: "adapter", ref: "adapter", x: -40, y: 40, params: partDef("adapter").normalizeParams({ hz: 60, rms: 12 }) }, // prettier-ignore
    );
    b.doc.wires.push(
      { id: "wl", from: "adp1.S1", to: b.at("g10"), color: "red" },
      { id: "wn", from: "adp1.S2", to: b.at("g12"), color: "black" },
    );
    return { doc: b.doc, at: { out: b.at("e10") } };
  }
  b.doc.components.push(
    { id: "ac1", kind: "ac", ref: "ac", x: -40, y: 30, params: partDef("ac").normalizeParams({ peak: acPeakOf(120), trough: -acPeakOf(120), hz: 60 }) }, // prettier-ignore
    { id: "xfmr1", kind: "transformer", ref: "transformer", x: -20, y: 30, params: TRANSFORMER_DEF.normalizeParams({}) }, // prettier-ignore
  );
  b.doc.wires.push(
    { id: "wp1", from: "ac1.L", to: "xfmr1.P1", color: "red" },
    { id: "wp2", from: "ac1.N", to: "xfmr1.P2", color: "black" },
    { id: "wn", from: "ac1.N", to: "psu1.-", color: "black" },
    { id: "ws1", from: "xfmr1.S1", to: b.at("g10"), color: "blue" },
    { id: "ws2", from: "xfmr1.S2", to: b.at("g12"), color: "blue" },
  );
  return { doc: b.doc, at: { out: b.at("e10") } };
}

/** CD40106B → 74LS04 → 74LS04 → 10 kΩ → 1 µF, read by the CD40106B. */
function mixedRing() {
  const b = bench();
  const cm = chip(b, "u1", "CD40106B", "e10");
  const ls = chip(b, "u2", "74LS04", "e30");
  b.link(cm.get(2), ls.get(1));
  b.link(ls.get(2), ls.get(3));
  const r = b.seat("r1", "resistor", "a45", { ohms: 10e3 });
  b.link(r.get(1), ls.get(4));
  const c = b.seat("c1", "cap-ceramic", "a52", { farads: 1e-6 });
  b.link(c.get(1), r.get(2));
  b.gnd(c.get(2));
  b.link(cm.get(1), r.get(2));
  return { doc: b.doc, at: { out: b.at(cm.get(2)) } };
}

/** A CD40106B's RC relaxation oscillator (100 kΩ, 1 µF) driving a 74LS04
    input, the LS output into 2.2 kΩ to ground. */
function mixedOscillator() {
  const b = bench();
  const u = chip(b, "u1", "CD40106B", "e10");
  const res = b.seat("r1", "resistor", "a30", { ohms: 100e3 });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(2));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: 1e-6 });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  const ls = chip(b, "u2", "74LS04", "e44");
  b.link(ls.get(1), u.get(2));
  const load = b.seat("r2", "resistor", "a55", { ohms: 2.2e3 });
  b.link(load.get(1), ls.get(2));
  b.gnd(load.get(2));
  return { doc: b.doc, at: { out: b.at(u.get(2)) } };
}

/** 74LS04 (input grounded) → 10 kΩ → 1 µF → CD40106B → 1 kΩ → NPN →
    100 mH coil to +5 V, a 1N4148 across it. */
function mixedChain() {
  const b = bench();
  const ls = chip(b, "u1", "74LS04", "e10");
  b.gnd(ls.get(1));
  const r = b.seat("r1", "resistor", "a25", { ohms: 10e3 });
  b.link(r.get(1), ls.get(2));
  const c = b.seat("c1", "cap-ceramic", "a30", { farads: 1e-6 });
  b.link(c.get(1), r.get(2));
  b.gnd(c.get(2));
  const cm = chip(b, "u2", "CD40106B", "e35");
  b.link(cm.get(1), r.get(2));
  const q = b.seat("q1", "npn", "a50");
  b.gnd(q.get(1));
  const rb = b.seat("rb", "resistor", "a55", { ohms: 1e3 });
  b.link(rb.get(1), cm.get(2));
  b.link(rb.get(2), q.get(2));
  const coil = b.seat("l1", "inductor", "a60", { henries: 0.1, style: "can" });
  b.vcc(coil.get(1));
  b.link(coil.get(2), q.get(3));
  const d = b.seat("d1", "diode", "a5");
  b.link(d.get(1), q.get(3));
  b.vcc(d.get(2));
  return { doc: b.doc, at: { cap: b.at(r.get(2)), collector: b.at(q.get(3)) } };
}

/** A coil and its NPN switch: +5 V through a 100 mH can (2 holes between
    its leads: its winding ~96 Ω) into the collector, the base through
    1 kΩ from a flag held HIGH for 20 ms — and, with `flyback`, a diode from
    the collector back to +5 V. */
function relayDriver(flyback) {
  const b = bench();
  const q = b.seat("q1", "npn", "a30");
  b.gnd(q.get(1));
  const rb = b.seat("rb", "resistor", "a40", { ohms: 1e3 });
  b.link(rb.get(2), q.get(2));
  b.signal("s1", rb.get(1), "low");
  const coil = b.seat("l1", "inductor", "a50", { henries: 0.1, style: "can" });
  b.vcc(coil.get(1));
  b.link(coil.get(2), q.get(3));
  if (flyback) {
    const d = b.seat("d1", "diode", "a10");
    b.link(d.get(1), q.get(3));
    b.vcc(d.get(2));
  }
  return {
    doc: b.doc,
    at: { collector: b.at(q.get(3)) },
    signals: { s1: [[0, "high"], [0.02, "low"]] }, // prettier-ignore
  };
}

/** A clock brick putting out `wave` at `hz`, on the bench's supply, its
    `out` wired into `hole`'s node. */
function waveClock(b, wave, hz, hole, swing = {}) {
  const def = partDef("clock");
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 20, y: 30, params: def.normalizeParams({ hz, wave, ...swing }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wk1", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wk2", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wk3", from: "clk1.out", to: b.at(hole), color: "blue" },
  );
}

/** A wave through `ohms` into `farads` to ground (a low-pass), or — `high`
    — through `farads` into `ohms` to ground (a high-pass): read across the
    part to ground. */
function waveRc(
  wave,
  hz,
  { ohms = 10e3, farads = 1e-6, high = false, swing } = {},
) {
  // prettier-ignore
  const b = bench();
  waveClock(b, wave, hz, "e5", swing);
  const [first, second] = high
    ? [b.seat("c1", "cap-ceramic", "c5", { farads }), b.seat("r1", "resistor", "a20", { ohms })] // prettier-ignore
    : [b.seat("r1", "resistor", "c5", { ohms }), b.seat("c1", "cap-ceramic", "a20", { farads })]; // prettier-ignore
  b.link(first.get(2), second.get(1));
  b.gnd(second.get(2));
  return { doc: b.doc, at: { out: b.at(second.get(1)) } };
}

/** A CD4060B or CD4541B running its own RC oscillator (SCHS049C Fig. 12,
    SCHS085E Fig. 2): Cx from the in-phase output and Rx from its complement
    meeting at a junction, Rs from there to the input. Read at the in-phase
    output. */
function rcOscillator(ref, { rx, cx, rs }) {
  const b = bench();
  const u = b.seat("u1", ref, "e10");
  // A 4060 is a DIP-16, a 4541 a DIP-14.
  b.vcc(u.get(ref === "CD4060B" ? 16 : 14));
  b.gnd(u.get(ref === "CD4060B" ? 8 : 7));
  const [input, same, opp] = ref === "CD4060B" ? [11, 9, 10] : [3, 2, 1];
  if (ref === "CD4060B") b.gnd(u.get(12));
  else for (const n of [5, 6, 9, 10, 12, 13]) b.gnd(u.get(n));
  const c = b.seat("cx", "cap-electrolytic", "a30", { farads: cx });
  b.link(c.get(1), u.get(same));
  const r = b.seat("rx", "resistor", "a40", { ohms: rx });
  b.link(r.get(1), u.get(opp));
  b.link(r.get(2), c.get(2));
  const series = b.seat("rs", "resistor", "a50", { ohms: rs });
  b.link(series.get(1), c.get(2));
  b.link(series.get(2), u.get(input));
  return { doc: b.doc, at: { out: b.at(u.get(same)) } };
}

/** A CD4047B astable (SCHS044C Fig. 32): R from R (2) and C from C (1) to
    RC COMMON (3); ASTABLE and ASTABLĒ HIGH, RESET and the triggers LOW.
    Read at `out` (OSC OUT 13, or Q 10), across 100 kΩ. */
function astable4047(r, c, out) {
  const b = bench();
  const u = b.seat("u1", "CD4047B", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  for (const n of [4, 5, 6]) b.vcc(u.get(n));
  for (const n of [8, 9, 12]) b.gnd(u.get(n));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.link(cap.get(2), u.get(3));
  const res = b.seat("r1", "resistor", "a40", { ohms: r });
  b.link(res.get(1), u.get(2));
  b.link(res.get(2), u.get(3));
  const load = b.seat("rl", "resistor", "a50", { ohms: 100e3 });
  b.link(load.get(1), u.get(out));
  b.gnd(load.get(2));
  return { doc: b.doc, at: { out: b.at(u.get(out)) } };
}

/** A dual monostable's first section, Rx from RX CX to VDD and Cx across
    RX CX and CX (a 4528's T1 wired to GND, as its sheet asks), RESET HIGH,
    triggered by +TR (A) pulses every `every` seconds — the first at
    `every`/5 — with −TR (B) HIGH; Q read across 100 kΩ. */
function monostable(ref, { rx, cx, every, pulses }) {
  const b = bench();
  const u = b.seat("u1", ref, "e10");
  b.vcc(u.get(16));
  b.gnd(u.get(8));
  if (ref === "CD4528B") b.gnd(u.get(1));
  const c = b.seat("cx", "cap-electrolytic", "a30", { farads: cx });
  b.link(c.get(1), u.get(2));
  b.link(c.get(2), u.get(1));
  const r = b.seat("rx", "resistor", "a40", { ohms: rx });
  b.vcc(r.get(1));
  b.link(r.get(2), u.get(2));
  b.vcc(u.get(3));
  b.vcc(u.get(5));
  b.signal("s1", u.get(4), "low");
  // The unused section: held off, its inputs on the rails.
  for (const n of [11, 13]) b.vcc(u.get(n));
  b.gnd(u.get(12));
  const load = b.seat("rl", "resistor", "a50", { ohms: 100e3 });
  b.link(load.get(1), u.get(6));
  b.gnd(load.get(2));
  const steps = [[0, "low"]];
  for (let k = 0; k < pulses; k++) {
    const t = every / 5 + k * every;
    steps.push([t, "high"], [t + 1e-3, "low"]);
  }
  return { doc: b.doc, at: { out: b.at(u.get(6)) }, signals: { s1: steps } };
}

/** A ULN2003A's first channel on a `volts` bench: the load `ohms` from +
    to 1C, E to ground, 1B tied to + (`rin` 0) or through `rin`. */
function ulnChannel(volts, ohms, rin) {
  const b = bench({ volts });
  const u = b.seat("u1", "ULN2003A", "e10");
  b.gnd(u.get(8));
  const load = b.seat("rl", "resistor", "a30", { ohms });
  b.vcc(load.get(1));
  b.link(load.get(2), u.get(16));
  const at = { out: b.at(u.get(16)) };
  if (rin) {
    const r = b.seat("rb", "resistor", "a40", { ohms: rin });
    b.vcc(r.get(1));
    b.link(r.get(2), u.get(1));
    at.in = b.at(u.get(1));
  } else b.vcc(u.get(1));
  return { doc: b.doc, at };
}

/** A 4N35 on 12 V: its LED from + through `rin`, its collector from +
    through `rc`, the cathode and emitter grounded. */
function optoSwitch(rin, rc) {
  const b = bench({ volts: 12 });
  const u = b.seat("u1", "4N35", "e10");
  const ri = b.seat("ri", "resistor", "a30", { ohms: rin });
  b.vcc(ri.get(1));
  b.link(ri.get(2), u.get(1));
  b.gnd(u.get(2));
  b.gnd(u.get(4));
  const rl = b.seat("rc", "resistor", "a40", { ohms: rc });
  b.vcc(rl.get(1));
  b.link(rl.get(2), u.get(5));
  return { doc: b.doc, at: { collector: b.at(u.get(5)) } };
}

/** An LM358 on 9 V as a ×2 non-inverting amplifier (10 kΩ / 10 kΩ), IN+
    from a divider of `top` over `bottom`; its second unit a follower of
    ground. */
function opAmpGain(top, bottom) {
  const b = bench({ volts: 9 });
  const u = b.seat("u1", "LM358", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(4));
  const rf = b.seat("rf", "resistor", "a30", { ohms: 10e3 });
  b.link(rf.get(1), u.get(1));
  b.link(rf.get(2), u.get(2));
  const rg = b.seat("rg", "resistor", "a40", { ohms: 10e3 });
  b.link(rg.get(1), u.get(2));
  b.gnd(rg.get(2));
  const up = b.seat("r1", "resistor", "a50", { ohms: top });
  b.vcc(up.get(1));
  b.link(up.get(2), u.get(3));
  const down = b.seat("r2", "resistor", "a55", { ohms: bottom });
  b.link(down.get(1), u.get(3));
  b.gnd(down.get(2));
  b.gnd(u.get(5));
  b.link(u.get(6), u.get(7));
  return { doc: b.doc, at: { out: b.at(u.get(1)) } };
}

/** An LM339 on `volts`, unit 1 sinking (IN+ on −, IN− on +) into `pull`
    from +. */
function comparatorSink(volts, pull) {
  const b = bench({ volts });
  const u = b.seat("u1", "LM339", "e10");
  b.vcc(u.get(3));
  b.gnd(u.get(12));
  b.gnd(u.get(7));
  b.vcc(u.get(6));
  const rp = b.seat("rp", "resistor", "a30", { ohms: pull });
  b.vcc(rp.get(1));
  b.link(rp.get(2), u.get(1));
  return { doc: b.doc, at: { out: b.at(u.get(1)) } };
}

/** An LM339 relaxation oscillator on 5 V: 1OUT pulled up through 1 kΩ, 1IN+
    at a third or two thirds of the supply (10 kΩ to each rail and from
    1OUT), `r` from 1OUT charging `c` on 1IN−. A CD4069UB input reads 1OUT
    (drawing nothing), so its level is shown and its edges timed. */
function comparatorRelaxation(r, c) {
  const b = bench();
  const u = b.seat("u1", "LM339", "e10");
  b.vcc(u.get(3));
  b.gnd(u.get(12));
  const rp = b.seat("rp", "resistor", "a30", { ohms: 1000 });
  b.vcc(rp.get(1));
  b.link(rp.get(2), u.get(1));
  const ra = b.seat("ra", "resistor", "a35", { ohms: 10e3 });
  const rb = b.seat("rb", "resistor", "a40", { ohms: 10e3 });
  const rf = b.seat("rf", "resistor", "a45", { ohms: 10e3 });
  b.vcc(ra.get(1));
  b.link(ra.get(2), u.get(7));
  b.link(rb.get(1), u.get(7));
  b.gnd(rb.get(2));
  b.link(rf.get(1), u.get(1));
  b.link(rf.get(2), u.get(7));
  const rt = b.seat("rt", "resistor", "a50", { ohms: r });
  b.link(rt.get(1), u.get(1));
  b.link(rt.get(2), u.get(6));
  const cap = b.seat("c1", "cap-electrolytic", "a55", { farads: c });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const inv = b.seat("u2", "CD4069UB", "e2");
  b.vcc(inv.get(14));
  b.gnd(inv.get(7));
  b.link(inv.get(1), u.get(1));
  return { doc: b.doc, at: { out: b.at(u.get(1)) } };
}

/** An LM7805 on a `volts` bench (IN on +, GND on −), its OUT into `ohms`
    to ground — or, with `load`, into an electronic load of those params. */
/** An electronic load set to `load`, fed from a `volts` supply through
    `ohms`. */
function loadBehind(volts, ohms, load) {
  const b = bench({ volts });
  const r = b.seat("r1", "resistor", "a20", { ohms });
  b.vcc(r.get(1));
  const out = r.get(2).replace(/^[a-e]/, "c");
  b.doc.components.push({ id: "ld1", kind: "load", ref: "load", x: 40, y: 30, params: partDef("load").normalizeParams(load) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wl1", from: "ld1.pos", to: b.at(out), color: "red" },
    { id: "wl2", from: "ld1.neg", to: "psu1.-", color: "black" },
  );
  return { doc: b.doc, at: { out: b.at(out) } };
}

function regulator7805(
  volts,
  ohms,
  load = null,
  { limit = null, farads = null } = {},
) {
  // prettier-ignore
  const b = bench({ volts });
  if (limit) b.doc.components[0].params.currentLimit = limit;
  const u = b.seat("u1", "LM7805", "a20");
  b.vcc(u.get(1));
  b.gnd(u.get(2));
  if (farads) {
    const c = b.seat("c1", "cap-electrolytic", "a50", { farads });
    b.link(c.get(1), u.get(3));
    b.gnd(c.get(2));
  }
  if (load) {
    b.doc.components.push({ id: "ld1", kind: "load", ref: "load", x: 40, y: 30, params: partDef("load").normalizeParams(load) }); // prettier-ignore
    b.doc.wires.push(
      { id: "wl1", from: "ld1.pos", to: b.at("e22"), color: "red" },
      { id: "wl2", from: "ld1.neg", to: "psu1.-", color: "black" },
    );
  } else {
    const r = b.seat("rl", "resistor", "a40", { ohms });
    b.link(r.get(1), u.get(3));
    b.gnd(r.get(2));
  }
  return { doc: b.doc, at: { out: b.at(u.get(3)) } };
}

/** An LM317 on 15 V: R1 240 Ω from OUT to ADJ, `r2` from ADJ to ground. */
function regulator317(r2) {
  const b = bench({ volts: 15 });
  const u = b.seat("u1", "LM317", "a20");
  b.vcc(u.get(3));
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 240 });
  b.link(r1.get(1), u.get(2));
  b.link(r1.get(2), u.get(1));
  const r = b.seat("r2", "resistor", "a40", { ohms: r2 });
  b.link(r.get(1), u.get(1));
  b.gnd(r.get(2));
  return { doc: b.doc, at: { out: b.at(u.get(2)) } };
}

/**
 * The last full cycle of a run of edges `[[t, rising]]`, rise to rise:
 * `{period, high, low}`, or nulls when it never completed one.
 */
export function lastCycle(edges) {
  const rises = edges.filter(([, up]) => up).map(([t]) => t);
  if (rises.length < 2) return { period: null, high: null, low: null };
  const [r1, r2] = rises.slice(-2);
  const fall = edges.find(([t, up]) => !up && t > r1 && t < r2)?.[0];
  if (fall == null) return { period: r2 - r1, high: null, low: null };
  return { period: r2 - r1, high: fall - r1, low: r2 - fall };
}

/** The keys a case's measurement yields, in order. */
export function keysOf(measure) {
  if (measure.kind === "dc") {
    return [
      ...(measure.volts ?? []).map((n) => `${n}/V`),
      ...(measure.amps ?? []).map((k) => `${k}/A`),
    ];
  }
  if (measure.kind === "tran") {
    return [
      ...(measure.volts ?? []).flatMap((n) => measure.at.map((t) => `${n}@${t}/V`)), // prettier-ignore
      ...(measure.coils ?? []).flatMap((id) => measure.at.map((t) => `${id}@${t}/A`)), // prettier-ignore
    ];
  }
  return ["period/s", "high/s", "low/s"];
}

/** Whether a key is a voltage (graded with the rubric's absolute volts
    under 1 V). */
const isVolts = (key) => key.endsWith("/V");

/**
 * The grade one value earns against its reference: the best whose tolerance
 * it is inside, D past them all, F where one has a value and the other none
 * (an oscillator that never starts).
 */
export function gradeOf(key, value, ref) {
  if (ref == null && value == null) return "A";
  if (ref == null || value == null || !Number.isFinite(value)) return "F";
  const err = Math.abs(value - ref);
  for (const g of ["A", "B", "C"]) {
    const tol = TOLERANCE[g];
    if (err <= tol.rel * Math.abs(ref)) return g;
    if (isVolts(key) && Math.abs(ref) < 1 && err <= tol.volts) return g;
  }
  return "D";
}

/** The worse of two grades. */
export const worse = (a, b) =>
  GRADES[Math.max(GRADES.indexOf(a), GRADES.indexOf(b))];

/** Whether grade `a` is at least `b`. */
export const atLeast = (a, b) => GRADES.indexOf(a) <= GRADES.indexOf(b);
