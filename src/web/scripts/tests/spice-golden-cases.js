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
// ngspice (features/spice-lite-3-plan.md, Phase 0), and the rubric that
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
  { id: "cmos-stage", title: "CMOS output stage dynamics", floor: "B", target: "B", phase: null }, // prettier-ignore
  { id: "bjt-switch", title: "BJT as a saturated switch", floor: "C", target: "B", phase: "4" }, // prettier-ignore
  { id: "bjt-active", title: "BJT in its active region", floor: "D", target: "B", phase: "4" }, // prettier-ignore
  { id: "mosfet-on", title: "MOSFET fully on", floor: "C", target: "B", phase: "4" }, // prettier-ignore
  { id: "mosfet-threshold", title: "MOSFET near threshold", floor: "D", target: "B", phase: "4" }, // prettier-ignore
  { id: "inductors", title: "Inductors", floor: "A", target: "B", phase: "3" }, // prettier-ignore
]);

/** The plan's phases that have landed: an area of one of these is held to
    its target. */
export const LANDED = Object.freeze(["0", "1a", "1b", "2", "3"]);

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

/** An NPN switch: base through `rb` from +5 V, collector 1 kΩ to +5 V. */
function npnSwitch(rb) {
  const b = bench();
  const q = b.seat("q1", "npn", "a30");
  b.gnd(q.get(1));
  const base = b.seat("rb", "resistor", "a40", { ohms: rb });
  b.vcc(base.get(1));
  b.link(base.get(2), q.get(2));
  const load = b.seat("rc", "resistor", "a50", { ohms: 1e3 });
  b.vcc(load.get(1));
  b.link(load.get(2), q.get(3));
  return { doc: b.doc, at: { collector: b.at(q.get(3)) } };
}

/** An N-MOSFET, its gate at `vg` from a stiff divider, drain 100 Ω to +5 V. */
function nmosLoad(vg) {
  const b = bench();
  const q = b.seat("q1", "nmos", "a10");
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
  {
    id: "cmos-high-into-1u",
    area: "cmos-stage",
    reference: "device",
    build() {
      const b = bench();
      const u = cmosHigh(b);
      const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
      b.link(c.get(1), u.get(2));
      b.gnd(c.get(2));
      return { doc: b.doc, at: { out: b.at(u.get(2)) } };
    },
    measure: { kind: "tran", stop: 0.003, step: 1e-6, at: [0.0002, 0.0005, 0.0008, 0.001, 0.0015, 0.002, 0.003], volts: ["out"], grids: [1e-4, 1e-5] }, // prettier-ignore
  },

  // ── Transistors ───────────────────────────────────────────────────────
  {
    id: "npn-switch-10k",
    area: "bjt-switch",
    reference: "device",
    build: () => npnSwitch(10e3),
    measure: { kind: "dc", volts: ["collector"] },
  },
  ...[1e6, 100e3].map((rb) => ({
    id: `npn-active-${si(rb)}`,
    area: "bjt-active",
    reference: "device",
    build: () => npnSwitch(rb),
    measure: { kind: "dc", volts: ["collector"] },
  })),
  ...[4, 5].map((vg) => ({
    id: `nmos-on-${vg}v`,
    area: "mosfet-on",
    reference: "device",
    build: () => nmosLoad(vg),
    measure: { kind: "dc", volts: ["drain"] },
  })),
  ...[2.5, 3, 3.5].map((vg) => ({
    id: `nmos-threshold-${vg}v`,
    area: "mosfet-threshold",
    reference: "device",
    build: () => nmosLoad(vg),
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
]);

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
