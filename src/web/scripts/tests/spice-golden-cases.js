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
//   known       (rare) why Spice Lite is known to miss this case's A: the
//               test reports it as a todo rather than a failure, and FAILS
//               once it passes (drop the field then). Each one is a finding
//               waiting on a decision; SPICE_GOLDEN_STRICT=1 makes them fail.
//   accept      (rarer) an ACCEPTED exception, decided by Jason: `{grade,
//               why}` — the worst grade the case may take — and/or
//               `{invariance, why}` — how far its answer may move with the
//               tick spacing, in place of INVARIANCE. Still a ratchet: past
//               it the case fails, and it fails too once it no longer needs
//               the allowance (tighten or drop it then). Listed among the
//               test's diagnostics; SPICE_GOLDEN_STRICT=1 holds them to the
//               rule as well.

import { bench, transistorFlasher } from "./timing-fixtures.js";
import { partDef } from "../catalog/index.js";
import { partPinHoles } from "../model/occupancy.js";
import { TRANSFORMER_DEF, acPeakOf } from "../catalog/ac-parts.js";

/** The ngspice the committed references come from (each JSON records its
    own): the test reports a file from another, and `make spice-golden`
    warns when the installed one differs. */
export const NGSPICE_VERSION = "ngspice-44.2";

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
 * The scorecard's rows. Every one is held to A — the golden rule, Spice Lite
 * within 2 % (or 20 mV under 1 V) of ngspice — case by case: one value past
 * it fails `make test` (spice-golden.test.js). The floors and phase targets
 * the areas once had (B for the transistors and inductors until their phase
 * landed) were all A by 2026-10-26, and went.
 */
export const AREAS = Object.freeze([
  { id: "resistive", title: "Resistive DC" }, // prettier-ignore
  { id: "single-rc", title: "Single-capacitor RC, Schmitt relaxation" }, // prettier-ignore
  { id: "multi-rc", title: "Multi-capacitor RC networks" }, // prettier-ignore
  { id: "coupled-osc", title: "Capacitor-coupled gate oscillators" }, // prettier-ignore
  { id: "ne555", title: "NE555 timing" }, // prettier-ignore
  { id: "led", title: "LEDs" },
  { id: "diode", title: "Silicon diodes" }, // prettier-ignore
  { id: "cmos-stage", title: "CMOS output stage dynamics" }, // prettier-ignore
  { id: "bjt-switch", title: "BJT as a saturated switch" }, // prettier-ignore
  { id: "bjt-active", title: "BJT in its active region" }, // prettier-ignore
  { id: "mosfet-on", title: "MOSFET fully on" }, // prettier-ignore
  { id: "mosfet-threshold", title: "MOSFET near threshold" }, // prettier-ignore
  { id: "inductors", title: "Inductors" }, // prettier-ignore
  // Graded against the 74LS04's own schematic (2026-10-13): C at first,
  // from a stage drawn as a line — 3.6 V behind 120 Ω, where the Darlington
  // climbs toward 4.5 V under a light load, and a LOW 50 mV under its own —
  // and A once it was redrawn as the swept gate's corners, with the phase
  // splitter's current an input held LOW lifts (spice/output-stage.js).
  { id: "ls-stage", title: "74LS input and output stages" }, // prettier-ignore
  { id: "mixed", title: "Mixed circuits" }, // prettier-ignore
  // A clock brick's waves (spice/waves.js) into RCs and a Schmitt input, and
  // the bench parts — a ULN2003A's Darlingtons against their cards, the
  // optocoupler, op-amp, regulators and electronic load against their own
  // laws (no maker publishes a model to grade the law by: these grade the
  // solve on them). Compared by hand in features/done/
  // spice-lite-accuracy-review.md §5, all A; graded on every build since
  // 2026-10-13.
  { id: "waves", title: "Clock waves" }, // prettier-ignore
  // The CD4000 timers as their silicon (spice/silicon.js): comparators,
  // discharge and flip-flops as the deck's behavioural blocks, the outputs
  // the family's MOSFET pairs — so the RC networks' swing past the rails
  // and back, and every crossing, are graded against SPICE rather than only
  // against each sheet's formula (2026-10-13).
  { id: "cd4000-timers", title: "CD4000 timers" }, // prettier-ignore
  { id: "bench-parts", title: "Bench parts" }, // prettier-ignore
  // A bridge rectifier off a transformer into its reservoir capacitor
  // (2026-10-20): its four diodes on the bridge's SIMPLER curve
  // (spice/diodes.js BRIDGE_FIT), graded against the 1N4007's own card —
  // the charge from Run and the ripple after, light to heavy.
  { id: "rectifier", title: "Bridge rectifier" }, // prettier-ignore
  // Added 2026-10-26 (the fix round's phase 5): the ± rails and the
  // current limit's sag, transistors switching and oscillating in time,
  // capacitor-coupled stages and the multimeter's burden.
  { id: "supplies", title: "Supplies: ± rails and current limits" },
  { id: "transistor-circuits", title: "Transistor circuits in time" },
  { id: "coupled-stages", title: "Capacitor-coupled stages" },
  { id: "meter", title: "Multimeter loading" },
]);

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
function lsStage({
  input = "gnd",
  inputOhms = 0,
  load,
  ohms,
  volts = 5,
  ref = "74LS04",
}) {
  // prettier-ignore
  const b = bench({ volts });
  const u = chip(b, "u1", ref, "e10");
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
  // Each MOSFET grade's body diode carrying `ohms`' current from the rail
  // (phase 7, 2026-10-27): the gate on the source, the channel off — each
  // N grade's its part's card's diode (spice/diodes.js MOSFET_BODIES), each
  // P grade's the fit to its sheet's curve (wave 2b) — graded at two
  // currents. One for every grade read 60–120 mV off.
  ...[
    ["nmos", { case: "TO-92" }, 22],
    ["nmos", { case: "TO-92" }, 10e3],
    ["nmos", { case: "TO-220", grade: "logic-power" }, 22],
    ["nmos", { case: "TO-220" }, 22],
    ["pmos", { case: "TO-92" }, 100],
    ["pmos", { case: "TO-92" }, 10e3],
    ["pmos", { case: "TO-220" }, 22],
    ["pmos", { case: "TO-220" }, 1e3],
  ].map(([type, params, ohms]) => ({
    id: `${type}-body-${params.grade ?? params.case}-${si(ohms)}`,
    area: "mosfet-on",
    reference: "device",
    build: () => bodyDiode(type, params, ohms),
    measure: { kind: "dc", volts: ["source"] },
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
  // 1 Ω and a 1 mH coil straight across a 5 V supply limited to 1 A: the
  // supply on its limit as the coil's current passes it, its own output
  // capacitor (470 µF) carrying it on — to 2.1 A — and + falling to 1.43 V
  // before the coil settles at the limit, + at 1 A × 1.74 Ω.
  {
    id: "psu-limited-coil-1r-1mh",
    area: "bench-parts",
    reference: "same",
    build: () => limitedCoil(),
    measure: { kind: "tran", stop: 0.01, step: 1e-6, at: [0.0002, 0.0005, 0.001, 0.0015, 0.002, 0.003, 0.005, 0.01], volts: ["plus"], grids: [0.0001, 0.00037] }, // prettier-ignore
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
  // ── Phase 5 (2026-10-26): what the suite did not yet grade ────────────
  // Jason: "add more tests to the golden rule of being within 2% of ngspice
  // … so we don't drift again". Every part Spice Lite models is in a case
  // (spice-golden-coverage.test.js), and every behaviour the fix round
  // changed: the ± rails, an overloaded supply's sag, the meter's elements.

  // ── Supplies ──────────────────────────────────────────────────────────
  // Two 5 V supplies stacked, psu2's + on psu1's −: a ±5 V rail (sim/
  // floating-grounds.js `stackedSupplies`), an LM358 across it on its own
  // law — a follower of −2 V and an inverting ×−2 of +1 V.
  {
    id: "pm5-lm358-follower",
    area: "supplies",
    reference: "same",
    build: () => splitRailOpAmp("follower"),
    measure: { kind: "dc", volts: ["out", "in", "minus"] },
  },
  {
    id: "pm5-lm358-inverting",
    area: "supplies",
    reference: "same",
    build: () => splitRailOpAmp("inverting"),
    measure: { kind: "dc", volts: ["out", "in"] },
  },
  // A 5 V supply limited to 0.1 A into 22 Ω (0.23 A): it starts at its set
  // volts and sags as its own 470 µF drains into the load, to 0.1 A × 22 Ω
  // with τ = 22 Ω × 470 µF (Jason's decision D, "match ngspice") — held by
  // the solve, nothing logic-powered on it; and the same with a CD4069UB on
  // the rail, whose droop is PACED (bench-parts.md, "A supply ON ITS LIMIT").
  ...[false, true].map((chipOn) => ({
    id: `psu-sag-22r-0.1a${chipOn ? "-chip" : ""}`,
    area: "supplies",
    reference: "same",
    // Found 2026-10-26 (phase 5): every reading is A (worst −0.42 %), but a
    // chip-powered supply's PACED droop (spice/engine.js `capDroop`) steps
    // with the ticks — on a 0.37 ms grid it reads up to 0.066 % higher
    // (−0.36 %), past the rubric's tick-spacing bar (INVARIANCE, 0.01 %).
    // The solve-held supply beside it is exact. Accepted by Jason,
    // 2026-10-26: held to 0.1 % instead, and to A against ngspice.
    ...(chipOn ? { accept: { invariance: 1e-3, why: "a chip-powered supply's paced droop moves with the tick spacing (0.066 %; accepted by Jason, 2026-10-26)" } } : {}), // prettier-ignore
    build: () => saggingSupply(chipOn),
    measure: { kind: "tran", stop: 0.04, step: 4e-6, at: [0.0005, 0.002, 0.005, 0.01, 0.02, 0.04], volts: ["plus"], grids: [0.001, 0.00037] }, // prettier-ignore
  })),

  // ── Transistor circuits in time ───────────────────────────────────────
  // Each transistor its grade's card (the 2N3904's vendor card, the
  // 2N7000's own fit), switching through a capacitor: the period of the
  // collector (or drain) a CD4069UB reads, timed at its 2.5 V trip in both.
  {
    id: "bjt-flasher-47k-1u",
    area: "transistor-circuits",
    reference: "device",
    build: () => withReader(transistorFlasher({ farads: 1e-6 }), "q1"),
    measure: period(2 * Math.LN2 * 47e3 * 1e-6, { cycles: 5 }),
  },
  {
    id: "mosfet-ring-10k-100n",
    area: "transistor-circuits",
    reference: "device",
    // Read once the ring has come to its own rhythm: from `uic`'s even
    // start it breaks its symmetry wherever the ticks tip it, and its period
    // creeps up over the first few cycles (3.05 → 3.06 ms in both engines),
    // so a cycle read 12 ms in measured how far it had crept.
    build: () => mosfetRing(10e3, 100e-9),
    measure: period(0.003, { cycles: 9 }),
  },
  {
    // A flag switching a 2N3904 through 10 kΩ, its collector's 1 kΩ
    // charging 100 nF once it lets go.
    id: "npn-switch-step-100n",
    area: "transistor-circuits",
    reference: "device",
    build: () => npnStep(),
    measure: { kind: "tran", stop: 0.006, step: 2e-7, at: [0.0005, 0.002, 0.00502, 0.00505, 0.0051, 0.0052, 0.0055, 0.006], volts: ["collector"], grids: [1e-4, 1e-5] }, // prettier-ignore
  },
  {
    // A 2N7000's gate charged through 10 kΩ into 1 µF: its drain (100 Ω
    // from +5 V) falls as the gate passes threshold, then back once the
    // flag lets go.
    id: "nmos-gate-rc-10k-1u",
    area: "transistor-circuits",
    reference: "device",
    build: () => nmosGateRc(),
    measure: { kind: "tran", stop: 0.06, step: 4e-6, at: [0.003, 0.005, 0.006, 0.008, 0.012, 0.02, 0.033, 0.036, 0.04, 0.06], volts: ["gate", "drain"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    // A 50 Hz sine (0–5 V) through 47 kΩ into a 2N3904's base: off, active
    // and saturated in turn, its collector 1 kΩ from +5 V.
    id: "npn-sine-50hz-47k",
    area: "transistor-circuits",
    reference: "device",
    build: () => npnOnSine(),
    measure: { kind: "tran", stop: 0.04, step: 2e-6, at: [0.004, 0.006, 0.007, 0.008, 0.01, 0.012, 0.013, 0.015, 0.025, 0.027, 0.03], volts: ["collector"], grids: [0.001, 0.00025] }, // prettier-ignore
  },
  {
    // A Darlington PNP (TIP125, its own fit) switching 10 Ω — the last
    // transistor grade the suite had not run.
    id: "pnp-darlington-switch",
    area: "bjt-switch",
    reference: "device",
    build: () => pnpSwitch(1e3, { load: 10, params: { case: "TO-220", grade: "darlington" } }), // prettier-ignore
    measure: { kind: "dc", volts: ["collector"] },
  },

  // ── Capacitor-coupled stages ──────────────────────────────────────────
  {
    // A common-emitter amplifier (2N3904, 47k/10k bias, 2.2 kΩ / 470 Ω), a
    // 1 kHz sine of 0.2 V about 2.5 V coupled in through 1 µF and out
    // through 1 µF into 10 kΩ — from Run, both capacitors empty.
    id: "ce-amp-1khz",
    area: "coupled-stages",
    reference: "device",
    build: () => commonEmitter(),
    measure: { kind: "tran", stop: 0.02, step: 1e-6, at: [0.00125, 0.00175, 0.005, 0.01025, 0.01075, 0.01525, 0.01575, 0.02], volts: ["base", "out"], grids: [1e-4, 2.5e-5] }, // prettier-ignore
  },
  {
    // A 500 Hz square clock through 100 µF into an 8 Ω speaker's coil.
    id: "coupled-speaker-500hz",
    area: "coupled-stages",
    reference: "same",
    build: () => coupledSpeaker(),
    measure: { kind: "tran", stop: 0.01, step: 1e-6, at: [0.0011, 0.0015, 0.0019, 0.0021, 0.0025, 0.0051, 0.0071, 0.0095], volts: ["coil"], grids: [1e-4, 2.5e-5] }, // prettier-ignore
  },
  // A 1 kHz edge through 10 µF straight into a junction (phase 7,
  // 2026-10-27): a red LED clamping the far plate to ground, and a
  // negative charge pump of two — each edge carried through the junction
  // as its curve, read within the microseconds after (a tick once ran
  // tens of microseconds past its moment along such a curve's corners, and
  // read a 1N4148 clamp at 0.90 V a tenth of a microsecond after the edge,
  // for ngspice's 4.93). The brick drives it behind its 50 Ω (`CLOCK_OHMS`,
  // wave 2b): ideal, its edge drove 6 A into a 1N4148 and burnt it — now
  // 0.1 A at most, and the 1N4148 pair below is graded too.
  {
    id: "coupled-edge-led-clamp",
    area: "coupled-stages",
    reference: "device",
    build: () => coupledEdge("clamp"),
    measure: { kind: "tran", stop: 0.002, step: 1e-7, at: [0.0005001, 0.000501, 0.00051, 0.0006, 0.00099, 0.0010001, 0.0011, 0.0015001, 0.0019], volts: ["x"], grids: [1e-4, 2.5e-5] }, // prettier-ignore
  },
  {
    id: "coupled-edge-led-pump",
    area: "coupled-stages",
    reference: "device",
    build: () => coupledEdge("pump"),
    measure: { kind: "tran", stop: 0.02, step: 1e-7, at: [0.0005001, 0.000501, 0.0006, 0.0010001, 0.0011, 0.0015001, 0.0105, 0.0195], volts: ["x", "out"], grids: [5e-4, 1e-4] }, // prettier-ignore
  },
  {
    id: "coupled-edge-diode-clamp",
    area: "coupled-stages",
    reference: "device",
    build: () => coupledEdge("clamp", "diode"),
    measure: { kind: "tran", stop: 0.002, step: 1e-7, at: [0.0005001, 0.000501, 0.00051, 0.0006, 0.00099, 0.0010001, 0.0011, 0.0015001, 0.0019], volts: ["x"], grids: [1e-4, 2.5e-5] }, // prettier-ignore
  },
  {
    id: "coupled-edge-diode-pump",
    area: "coupled-stages",
    reference: "device",
    build: () => coupledEdge("pump", "diode"),
    // (Read just before the falling edge, not just after: there its output
    // is microvolts to a few millivolts, just turning on, and moves with
    // the tick spacing by 3 µV — past the rubric's 0.01 %.)
    measure: { kind: "tran", stop: 0.02, step: 1e-7, at: [0.0005001, 0.000501, 0.0006, 0.00099, 0.0011, 0.0015001, 0.0105, 0.0195], volts: ["x", "out"], grids: [5e-4, 1e-4] }, // prettier-ignore
  },
  {
    // The same edge through 100 nF into a 2N3904's base (10 kΩ down), its
    // collector 1 kΩ from +5 V: saturated hard at the edge, let go as the
    // capacitor charges — read within the corners of the base's curve.
    id: "coupled-edge-npn-base",
    area: "coupled-stages",
    reference: "same",
    // (Phase 7, shipped in wave 2b, 2026-10-27, Jason: the tick ran its
    // corners on past its moment on a transistor's island and read its
    // collector up to 16 µs late, in steps — 1.03 V for ngspice's 0.04 V
    // 4 µs after the edge. Held to its moment, spice/engine.js
    // `settlingWaits`.)
    build: () => coupledBase(),
    measure: { kind: "tran", stop: 0.002, step: 1e-8, at: [0.000504, 0.000508, 0.000512, 0.00052, 0.00054, 0.00056, 0.0006, 0.0011, 0.0019], volts: ["b", "c"], grids: [1e-4, 1e-5] }, // prettier-ignore
  },

  // ── The multimeter ────────────────────────────────────────────────────
  // Its element between the probes (catalog/meter.js METER_ELEMENTS) on its
  // own figures: the burden it puts on what it measures.
  ...[
    // The 10 MΩ of V on a 1 MΩ divider, LoZ's 2.1 kΩ on a 10 kΩ one.
    ["meter-v-on-1m-1m", { dial: "v" }, 1e6, 1e6],
    ["meter-loz-on-10k-10k", { dial: "autov" }, 10e3, 10e3],
    // The current shunts in series between two resistors: µA 100 Ω, mA
    // 1.9 Ω, 10A 0.04 Ω.
    ["meter-ua-in-10k-1k", { dial: "ua", jack: "ma" }, 10e3, 1e3, true],
    ["meter-ma-in-100-100", { dial: "ma", jack: "ma" }, 100, 100, true],
    ["meter-a-in-4.7-4.7", { dial: "ma", jack: "a" }, 4.7, 4.7, true],
  ].map(([id, setting, top, bottom, series]) => ({
    id,
    area: "meter",
    reference: "same",
    build: () => meterOnDivider(setting, top, bottom, series),
    measure: { kind: "dc", volts: series ? ["a", "b"] : ["a"] },
  })),
  // …and in a supply's lead, its shunt the resistor it is there too, a
  // 74LS00 past it fed through it (the deck states a chip off the rails at
  // the volts that reach it): the supply's own net is not lowered with the
  // rail past the shunt — a 330/330 divider on it stays 2.500 V.
  ...[
    ["meter-ua-lead-supply-side", { dial: "ua", jack: "ma" }, 4700],
    ["meter-ma-lead-supply-side", { dial: "ma", jack: "ma" }, 100],
  ].map(([id, setting, load]) => ({
    id,
    area: "meter",
    reference: "same",
    build: () => meterInLead(setting, load, false),
    measure: { kind: "dc", volts: ["far", "near", "mid"] },
  })),
  {
    // In the − lead: the ground past it stands above the supply's by the
    // drop, and VCC stays 5 V (lowered with the supply, it read 4.739).
    id: "meter-ua-lead-minus",
    area: "meter",
    reference: "same",
    build: () => meterInLead({ dial: "ua", jack: "ma" }, 4700, true),
    measure: { kind: "dc", volts: ["far", "near", "vcc"] },
  },
  {
    // A meter in EACH lead of one supply, a 74LS00 and 1 kΩ between the two
    // rails past them: each shunt carries the one current (the + one read
    // nothing, the regrade, 2026-10-27).
    id: "meter-both-leads-ua-ma-1k",
    area: "meter",
    reference: "same",
    build: () => meterBothLeads({ dial: "ua", jack: "ma" }, { dial: "ma", jack: "ma" }, 1000), // prettier-ignore
    measure: { kind: "dc", volts: ["plus", "minus"] },
  },
  ...[
    // A 74LS04 past a meter driving a red LED through 330 Ω: HIGH into it
    // from the + lead (its VCC the rail past the shunt) and from the − lead
    // (its stage measured from its own lifted ground — measured from 0 V it
    // read −16 %), and LOW sinking one from +5 V behind the − lead (its LOW
    // its ground plus its own, +28 % read from 0 V).
    ["meter-ua-lead-ls04-led", false, false],
    ["meter-ua-minus-ls04-led", true, false],
    ["meter-ua-minus-ls04-sink", true, true],
  ].map(([id, minus, sink]) => ({
    id,
    area: "meter",
    reference: "same",
    build: () => meterChipLed({ dial: "ua", jack: "ma" }, minus, sink),
    measure: { kind: "dc", volts: ["out", "far"], amps: ["d1"] },
  })),
  {
    // Two meters in series in the + lead, µA then mA, 4.7 kΩ and a 74LS00
    // past both: each drops its own.
    id: "meter-chained-ua-ma",
    area: "meter",
    reference: "same",
    build: () => meterChained(),
    measure: { kind: "dc", volts: ["first", "second"] },
  },
  ...[
    // A supply limited to 0.1 A behind µA into 10 Ω and a 74LS04: 45.6 mA,
    // on no limit (the shunt counted before the limit is judged — it was
    // put on its limit at 100 mA, 0.997 V) — and behind mA into 47 Ω, past
    // its limit: its terminal held a shunt's drop above the rail past it.
    ["meter-ua-limited-0.1a-10", { dial: "ua", jack: "ma" }, 10],
    ["meter-ma-limited-0.1a-47", { dial: "ma", jack: "ma" }, 47],
  ].map(([id, setting, load]) => ({
    id,
    area: "meter",
    reference: "same",
    build: () => meterLimited(setting, load),
    // (In time: a supply goes on its limit at the tick after the one that
    // finds it past it.)
    measure: { kind: "tran", stop: 0.02, step: 1e-5, at: [0.01, 0.02], volts: ["near", "far"] }, // prettier-ignore
  })),
  {
    // 100 µF on the rail past a µA meter, a 74LS00 on it: its inrush through
    // the shunt, τ = 100 Ω · 100 µF (the rail past a joined meter never
    // charged at all).
    id: "meter-ua-lead-100u-inrush",
    area: "meter",
    reference: "same",
    build: () => meterFarCap(),
    measure: { kind: "tran", stop: 0.06, step: 1e-5, at: [0.001, 0.005, 0.01, 0.02, 0.05], volts: ["far"] }, // prettier-ignore
  },
  {
    // Ω's 1.6 V behind 8 kΩ across 10 kΩ to ground.
    id: "meter-ohm-on-10k",
    area: "meter",
    reference: "same",
    build: () => meterAcross("resistor", { dial: "ohm" }),
    measure: { kind: "dc", volts: ["a"] },
  },
  {
    // The diode test's 3.2 V behind 9.7 kΩ across a 1N4148 (its card).
    id: "meter-diode-on-1n4148",
    area: "meter",
    reference: "device",
    build: () => meterAcross("diode", { dial: "diode" }),
    measure: { kind: "dc", volts: ["a"] },
  },

  // ── Bench parts ───────────────────────────────────────────────────────
  {
    // An LM358 Schmitt trigger on 5 V: a 10 Hz sine into IN− through
    // 10 kΩ, IN+ at the midpoint of two 10 kΩ with 47 kΩ from OUT.
    id: "lm358-schmitt-sine-10hz",
    area: "bench-parts",
    reference: "same",
    build: () => opAmpSchmitt(),
    measure: period(0.1, { cycles: 4 }),
  },
  // The PC817 (its own CTR), as the 4N35 is graded.
  ...[
    [2200, 1000],
    [10e3, 4700],
  ].map(([rin, rc]) => ({
    id: `opto-pc817-${si(rin)}-${si(rc)}`,
    area: "bench-parts",
    reference: "same",
    build: () => optoSwitch(rin, rc, "PC817"),
    measure: { kind: "dc", volts: ["collector"] },
  })),
  // The other fixed regulators under 100 Ω — the 7815 on 15 V in dropout
  // — and an LM317 set to 5 V under 47 Ω.
  ...[
    ["LM7809", 12],
    ["LM7812", 15],
    ["LM7815", 15],
  ].map(([ref, volts]) => ({
    id: `${ref.toLowerCase()}-${volts}v-100`,
    area: "bench-parts",
    reference: "same",
    build: () => regulator7805(volts, 100, null, { ref }),
    measure: { kind: "dc", volts: ["out"] },
  })),
  {
    id: "lm317-240-720-load-47",
    area: "bench-parts",
    reference: "same",
    build: () => regulator317(720, 47),
    measure: { kind: "dc", volts: ["out"] },
  },
  {
    // A constant-current load behind 10 Ω from 9 V.
    id: "load-cc-0.25a-behind-10",
    area: "bench-parts",
    reference: "same",
    build: () => loadBehind(9, 10, { mode: "cc", amps: 0.25 }),
    measure: { kind: "dc", volts: ["out"] },
  },
  {
    // A 5 V relay's coil switched by a 2N3904 from a flag, a 1N4148 across
    // it: its contacts pull in at 75 % of its rated current and let go
    // below 10 % as the diode carries the coil's current down — COM on
    // +5 V, NO into 1 kΩ.
    id: "relay-npn-flyback",
    area: "bench-parts",
    reference: "device",
    build: () => relaySwitch(),
    measure: { kind: "tran", stop: 0.03, step: 1e-6, at: [0.001, 0.002, 0.004, 0.006, 0.0202, 0.021, 0.022, 0.024, 0.03], volts: ["collector", "no"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    // The coil's last 0.3 mA at 24 ms, 1.6 ms after it let go: +6.7 % —
    // the end of the decay some 6 µs late in its 4 ms (0.15 %), read as a
    // current. Accepted by Jason, 2026-10-26: held to B (the case below,
    // which stops at 23 ms, its last reading +0.29 %, is held to A).
    id: "relay-npn-flyback-coil-tail",
    area: "bench-parts",
    reference: "device",
    accept: { grade: "B", why: "the coil's last 0.3 mA reads +6.7 % (its decay ending ~6 µs late in 4 ms; accepted by Jason, 2026-10-26)" }, // prettier-ignore
    build: () => relaySwitch(),
    measure: { kind: "tran", stop: 0.025, step: 1e-6, at: [0.0235, 0.024], coils: ["k1"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },
  {
    // …and its coil's current, up to where the diode has nearly carried it
    // to nothing (past it the last tenth of a milliamp is the moment the
    // current ends, read as a current: well under 0.1 % of the decay's
    // time, and a picoamp of leakage after).
    id: "relay-npn-flyback-coil",
    area: "bench-parts",
    reference: "device",
    build: () => relaySwitch(),
    measure: { kind: "tran", stop: 0.023, step: 1e-6, at: [0.001, 0.002, 0.004, 0.006, 0.0202, 0.021, 0.022, 0.0225, 0.023], coils: ["k1"], grids: [1e-3, 1e-4] }, // prettier-ignore
  },

  // A 2N3904 / 2N3906 in deep saturation (phase 7, 2026-10-27): its base
  // driven through 100 Ω, its collector's load 10 kΩ / 100 kΩ — a forced
  // β of a few hundredths, the base current through the COLLECTOR
  // junction as much as the emitter's, against the vendor card.
  ...[
    ["npn", 100, 10e3],
    ["pnp", 100, 100e3],
  ].map(([type, rb, rc]) => ({
    id: `${type}-deep-saturation-${si(rb)}-${si(rc)}`,
    area: "bjt-switch",
    reference: "device",
    build: () => deepSaturation(type, rb, rc),
    measure: { kind: "dc", volts: ["b", "c"] },
  })),

  // ── Diodes ────────────────────────────────────────────────────────────
  // Each diode grade against its card (1N4007) or its sheet's fit
  // (1N5408, 1N5819), forward from 5 V.
  ...[
    ["rectifier", 100],
    ["power", 10],
    ["schottky", 100],
  ].map(([grade, ohms]) => ({
    id: `diode-${grade}-${si(ohms)}`,
    area: "diode",
    reference: "device",
    build: () => diodeLoad(ohms, grade),
    measure: { kind: "dc", amps: ["d1"] },
  })),
  // A 1N4148 half-wave off a 12 V~ adapter into 100 µF ∥ 1 kΩ (phase 7,
  // 2026-10-27), ticked on grids across a cycle's corners to a quarter of
  // one: its crest current (0.6 A) is a third of what its die burns at, as
  // the instant the tick reads it or not. (Into 470 µF it peaks at 2.27 A,
  // 1.9 ms in, and burns at 1.2 ms whatever the ticks —
  // spice-phase7-fixes.test.js.)
  {
    id: "halfwave-1n4148-100u",
    area: "diode",
    reference: "device",
    build: () => halfWave(100e-6),
    measure: { kind: "tran", stop: 0.1, step: 1e-5, at: [0.002, 0.005, 0.02, 0.05, 0.0917, 0.1], volts: ["out"], grids: [1 / 60 / 20, 2e-4, 2.5e-3] }, // prettier-ignore
  },
  // A 5.1 V Zener shunt from 12 V through 470 Ω, loaded and not: its
  // datasheet law (its VZ, then its dynamic resistance — spice/diodes.js),
  // the same in both: no one card is every Zener.
  ...[1e3, 0].map((load) => ({
    id: `zener-5.1v-12v-470${load ? `-load-${si(load)}` : ""}`,
    area: "diode",
    reference: "same",
    build: () => zenerShunt(load),
    measure: { kind: "dc", volts: ["out"] },
  })),

  // ── LEDs ──────────────────────────────────────────────────────────────
  // Strings of LEDs off 9 V, and a segment of every display.
  ...[
    ["red", 3, 330],
    ["white", 2, 220],
  ].map(([color, n, ohms]) => ({
    id: `led-string-${n}-${color}-9v-${si(ohms)}`,
    area: "led",
    reference: "device",
    build: () => ledString(color, n, ohms),
    measure: { kind: "dc", amps: ["d1", `d${n}`] },
  })),
  ...[
    ["seg7cc", "a"],
    ["seg7ca", "a"],
    ["seg8cc", "a"],
    ["seg8ca", "a"],
    ["bar8", "s1"],
    ["bar8iso", "s1"],
  ].map(([ref, seg]) => ({
    id: `${ref}-${seg}-330`,
    area: "led",
    reference: "device",
    build: () => segmentLit(ref, seg),
    measure: { kind: "dc", amps: [`x1#${seg}`] },
  })),
  // A character LCD's backlight: its colour's LED behind the module's
  // resistor, A on +5 V and K on ground.
  ...["lcd16x2", "lcd20x4"].map((ref) => ({
    id: `${ref}-backlight`,
    area: "led",
    reference: "same",
    build: () => lcdBacklight(ref),
    measure: { kind: "dc", amps: ["x1#backlight"] },
  })),

  // ── Logic parts with figures of their own ─────────────────────────────
  // The CD4049UB/CD4050B's stronger stage (its sheet's 19.5 / 6.5 mA), as
  // the family's MOSFET pair: HIGH into 470 Ω, LOW from +5 V through 220 Ω.
  ...[
    ["CD4049UB", "high", 470],
    ["CD4049UB", "low", 220],
    ["CD4050B", "high", 470],
  ].map(([ref, side, ohms]) => ({
    id: `${ref.toLowerCase()}-${side}-${si(ohms)}`,
    area: "cmos-stage",
    reference: "device",
    build: () => bufferStage(ref, side, ohms),
    measure: { kind: "dc", volts: ["out"] },
  })),
  {
    // A CD4511B showing 0: segment a's NPN-follower HIGH (its own stage)
    // into 330 Ω and a red LED.
    id: "cd4511b-seg-a-led-330",
    area: "cmos-stage",
    reference: "same",
    build: () => decoderSegment(),
    measure: { kind: "dc", volts: ["out"], amps: ["d1"] },
  },
  // A CD4007UB's MOSFETs as the family's output transistors: pair 3 an
  // inverter HIGH into 1 kΩ, Q1's N-channel on, 1 kΩ from +5 V — and the
  // same transistors at 10 V.
  ...[
    ["inverter", 5],
    ["n-on", 5],
    ["inverter", 10],
  ].map(([use, volts]) => ({
    id: `cd4007ub-${use}-1k${volts === 5 ? "" : `-${volts}v`}`,
    area: "cmos-stage",
    reference: "device",
    // The CD4007UB's channels are the CD4000 stage's square law, the level-1
    // card the deck's `cmosChannel` writes (2026-10-26, phase 5b — they were
    // the old straight line, +10 % / −19 % at 5 V). Jason accepted the cost:
    // a CD4007UB in TIME runs 4–5× slower (a 590 Hz astable 2.2 → 11.4 s a
    // simulated second), for every static reading exact.
    build: () => mosfetArray(use, volts),
    measure: { kind: "dc", volts: ["out"] },
  })),
  // The analog switches: one channel on (its sheet's RON at 5 V) between
  // 1 kΩ from +5 V and 1 kΩ to ground.
  ...["CD4066B", "CD4051B", "CD4052B", "CD4053B"].map((ref) => ({
    id: `${ref.toLowerCase()}-on-1k-1k`,
    area: "cmos-stage",
    reference: "same",
    build: () => switchChannel(ref),
    measure: { kind: "dc", volts: ["a", "b"] },
  })),
  {
    // A ROM's data outputs (family-less: the common MOS stage) LOW under
    // 1 kΩ and 330 Ω pull-ups: the logic engine's byte at address 1.
    id: "rom-8k-outputs-1k",
    area: "resistive",
    reference: "same",
    build: () => romOutputs(),
    measure: { kind: "dc", volts: ["q0", "q1"] },
  },
  // A 74LS05's open collector LOW under a pull-up and sinking an LED.
  ...[
    ["vcc", 1e3],
    ["led-vcc", 330],
  ].map(([load, ohms]) => ({
    id: `ls05-low-${load === "vcc" ? "pullup" : "led"}-${si(ohms)}`,
    area: "ls-stage",
    reference: "same",
    build: () => lsStage({ input: "vcc", load, ohms, ref: "74LS05" }),
    measure: { kind: "dc", volts: ["out"] },
  })),
  // Schmitt parts' own thresholds in a relaxation oscillator: a 74LS14
  // (its input current, through 680 Ω) and a CD4093B NAND, one input HIGH.
  {
    id: "schmitt-74ls14-680-10u",
    area: "single-rc",
    reference: "same",
    build: () => relaxation("74LS14", 680, 10e-6),
    measure: period(0.008, { threshold: 1.5 }),
  },
  {
    id: "schmitt-cd4093b-100k-1u",
    area: "single-rc",
    reference: "same",
    build: () => nandRelaxation(100e3, 1e-6),
    measure: period(0.08),
  },
  {
    // The 555 as a monostable: TRIG pulsed LOW for 1 ms every 0.25 s, its
    // pulse 1.1 · 100 kΩ · 1 µF (the datasheet's ideal comparators).
    id: "ne555-mono-100k-1u",
    area: "ne555",
    reference: "ideal",
    build: () => monostable555(100e3, 1e-6, { every: 0.25, pulses: 4 }),
    measure: { ...period(0.25, { cycles: 4, threshold: 1.5 }), step: 2e-6 },
  },
  // A square clock and a 25 % PWM, ideal sources as a flag is, into an RC.
  ...[
    ["square", {}],
    ["pwm", { duty: 25 }],
  ].map(([wave, extra]) => ({
    id: `wave-${wave}-500hz-low-pass-1k`,
    area: "waves",
    reference: "same",
    build: () => waveRc(wave, 500, { ohms: 1e3, swing: extra }),
    measure: { kind: "tran", stop: 0.006, step: 3e-7, at: [0.0009, 0.0012, 0.0015, 0.0019, 0.0025, 0.0041, 0.0049, 0.006], volts: ["out"], grids: [1e-4, 2.5e-5] }, // prettier-ignore
  })),
  {
    // An LC ring: +5 V through 1 Ω and a 1 mH coil (its own 0.74 Ω) onto
    // 10 µF, at ~1.6 kHz.
    id: "lc-ring-1mh-10u",
    area: "inductors",
    reference: "same",
    build: () => lcRing(),
    measure: { kind: "tran", stop: 0.005, step: 1e-7, at: [0.0001, 0.0003, 0.0005, 0.0008, 0.0012, 0.002, 0.003, 0.005], volts: ["cap"], coils: ["l1"], grids: [1e-4, 1e-5] }, // prettier-ignore
  },
  {
    // A resistor network's elements (10 kΩ, COM on +5 V) into 4.7 kΩ and
    // 1 kΩ, and a 10 kΩ pot at 30 % into 10 kΩ.
    id: "rnet9-pot-dividers",
    area: "resistive",
    reference: "same",
    build: () => networkAndPot(),
    measure: { kind: "dc", volts: ["n2", "n3", "wiper"] },
  },
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
function optoSwitch(rin, rc, ref = "4N35") {
  const b = bench({ volts: 12 });
  const u = b.seat("u1", ref, "e10");
  const ri = b.seat("ri", "resistor", "a30", { ohms: rin });
  b.vcc(ri.get(1));
  b.link(ri.get(2), u.get(1));
  b.gnd(u.get(2));
  // The 4N35's E and C are 4 and 5, the PC817's 3 and 4.
  const { e, c } = partDef(ref).optocoupler;
  b.gnd(u.get(e));
  const rl = b.seat("rc", "resistor", "a40", { ohms: rc });
  b.vcc(rl.get(1));
  b.link(rl.get(2), u.get(c));
  return { doc: b.doc, at: { collector: b.at(u.get(c)) } };
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
  { limit = null, farads = null, ref = "LM7805" } = {},
) {
  // prettier-ignore
  const b = bench({ volts });
  if (limit) b.doc.components[0].params.currentLimit = limit;
  const u = b.seat("u1", ref, "a20");
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

/** 1 Ω and a 1 mH coil (its own 0.74 Ω) from + to − of a 5 V supply
    limited to 1 A. */
function limitedCoil() {
  const b = bench({ volts: 5 });
  b.doc.components[0].params.currentLimit = 1;
  const r = b.seat("r1", "resistor", "a20", { ohms: 1 });
  const l = b.seat("l1", "inductor", "a10", { henries: 1e-3, style: "coil" });
  b.vcc(r.get(1));
  b.link(r.get(2), l.get(1));
  b.gnd(l.get(2));
  return { doc: b.doc, at: { plus: b.at(r.get(1)) } };
}

/** An LM317 on 15 V: R1 240 Ω from OUT to ADJ, `r2` from ADJ to ground —
    and, with `load`, that from OUT to ground. */
function regulator317(r2, load = 0) {
  const b = bench({ volts: 15 });
  const u = b.seat("u1", "LM317", "a20");
  b.vcc(u.get(3));
  const r1 = b.seat("r1", "resistor", "a30", { ohms: 240 });
  b.link(r1.get(1), u.get(2));
  b.link(r1.get(2), u.get(1));
  const r = b.seat("r2", "resistor", "a40", { ohms: r2 });
  b.link(r.get(1), u.get(1));
  b.gnd(r.get(2));
  if (load) {
    const rl = b.seat("rl", "resistor", "a50", { ohms: load });
    b.link(rl.get(1), u.get(2));
    b.gnd(rl.get(2));
  }
  return { doc: b.doc, at: { out: b.at(u.get(2)) } };
}

/** A second 5 V supply stacked under the bench's (its + on psu1's −): its −
    the bench's −5 V rail. Returns a function wiring a hole to that rail. */
function minusRail(b, volts = 5) {
  b.doc.components.push({ id: "psu2", kind: "psu", ref: "psu", x: 20, y: 30, params: { volts } }); // prettier-ignore
  b.doc.wires.push({ id: "wstack", from: "psu2.+", to: "psu1.-", color: "black" }); // prettier-ignore
  return (hole) => b.tie("psu2.-", hole);
}

/** An LM358 on ±5 V (V+ on psu1's +, V− on psu2's −): unit 1 a follower
    of −2 V (7 kΩ from +5 V over 3 kΩ to −5 V), or an inverting amplifier
    of ×−2 (10 kΩ in from +1 V — 4 kΩ over 1 kΩ — 20 kΩ back, IN+ on
    ground); unit 2 a follower of ground. */
function splitRailOpAmp(kind) {
  const b = bench();
  const minus = minusRail(b);
  const u = b.seat("u1", "LM358", "e10");
  b.vcc(u.get(8));
  minus(u.get(4));
  b.gnd(u.get(5));
  b.link(u.get(6), u.get(7));
  const at = { out: b.at(u.get(1)), minus: b.at(u.get(4)) };
  if (kind === "follower") {
    const up = b.seat("r1", "resistor", "a30", { ohms: 7e3 });
    b.vcc(up.get(1));
    b.link(up.get(2), u.get(3));
    const down = b.seat("r2", "resistor", "a35", { ohms: 3e3 });
    b.link(down.get(1), u.get(3));
    minus(down.get(2));
    b.link(u.get(1), u.get(2));
    at.in = b.at(u.get(3));
  } else {
    b.gnd(u.get(3));
    const up = b.seat("r1", "resistor", "a30", { ohms: 4e3 });
    b.vcc(up.get(1));
    const down = b.seat("r2", "resistor", "a35", { ohms: 1e3 });
    b.link(down.get(1), up.get(2));
    b.gnd(down.get(2));
    const rin = b.seat("ri", "resistor", "a40", { ohms: 10e3 });
    b.link(rin.get(1), up.get(2));
    b.link(rin.get(2), u.get(2));
    const rf = b.seat("rf", "resistor", "a45", { ohms: 20e3 });
    b.link(rf.get(1), u.get(2));
    b.link(rf.get(2), u.get(1));
    at.in = b.at(up.get(2));
  }
  return { doc: b.doc, at };
}

/** A 5 V supply limited to 0.1 A, 22 Ω across it — and, `chipOn`, a
    CD4069UB on its rails. */
function saggingSupply(chipOn) {
  const b = bench();
  b.doc.components[0].params.currentLimit = 0.1;
  const r = b.seat("r1", "resistor", "a30", { ohms: 22 });
  b.vcc(r.get(1));
  b.gnd(r.get(2));
  const at = { plus: b.at(r.get(1)) };
  // (Its output reaches nothing: a stage read at the set volts while its
  // rail sags is no reference — spice-deck.mjs refuses one.)
  if (chipOn) cmosHigh(b);
  return { doc: b.doc, at };
}

/** Transistor `q`'s collector (or drain) as the `out` a period case
    times, a CD4069UB input reading it — so its level is SHOWN (a net no
    pin reads shows the logic engine's X) at the CMOS trip, 2.5 V, the
    threshold ngspice's crossings are timed at. The input draws nothing. */
function withReader({ doc, b }, q) {
  const inv = b.seat("u9", "CD4069UB", "e55");
  b.vcc(inv.get(14));
  b.gnd(inv.get(7));
  const qc = doc.components.find((c) => c.id === q);
  const collector = partPinHoles(qc.ref, qc.anchor, qc.params).find((p) => p.pin === 3).hole; // prettier-ignore
  b.link(collector, inv.get(1));
  return { doc, at: { out: b.at(collector) } };
}

/** Three 2N7000 inverters in a ring (each drain 1 kΩ from +5 V, then
    `r` into the next gate, `c` from that gate to ground): a MOSFET
    astable. (The two-transistor multivibrator has a stable state with both
    on — its gates have no junction to kick them under threshold — and from
    `uic`'s empty start both engines lock into it; an odd ring has no
    stable state.) A CD4069UB reads q1's drain. */
function mosfetRing(r, c) {
  const b = bench();
  const qs = [1, 2, 3].map((k) => b.seat(`q${k}`, "nmos", `a${2 + 15 * (k - 1)}`, { case: "TO-92" })); // prettier-ignore
  qs.forEach((q, i) => {
    const k = i + 1;
    b.gnd(q.get(1));
    const rd = b.seat(`rd${k}`, "resistor", `f${2 + 15 * i}`, { ohms: 1e3 });
    b.vcc(rd.get(1));
    b.link(rd.get(2), q.get(3));
    const next = qs[(i + 1) % 3];
    const rt = b.seat(`rt${k}`, "resistor", `f${8 + 15 * i}`, { ohms: r });
    b.link(rt.get(1), q.get(3));
    b.link(rt.get(2), next.get(2));
    const ct = b.seat(`ct${k}`, "cap-ceramic", `a${8 + 15 * i}`, { farads: c }); // prettier-ignore
    b.link(ct.get(1), next.get(2));
    b.gnd(ct.get(2));
  });
  return withReader({ doc: b.doc, b }, "q1");
}

/** A flag HIGH for 5 ms into a 2N3904's base through 10 kΩ, its collector
    1 kΩ from +5 V with 100 nF to ground. */
function npnStep() {
  const b = bench();
  const q = b.seat("q1", "npn", "a30");
  b.gnd(q.get(1));
  const rb = b.seat("rb", "resistor", "a40", { ohms: 10e3 });
  b.link(rb.get(2), q.get(2));
  b.signal("s1", rb.get(1), "low");
  const rc = b.seat("rc", "resistor", "a50", { ohms: 1e3 });
  b.vcc(rc.get(1));
  b.link(rc.get(2), q.get(3));
  const c = b.seat("c1", "cap-ceramic", "a20", { farads: 100e-9 });
  b.link(c.get(1), q.get(3));
  b.gnd(c.get(2));
  return { doc: b.doc, at: { collector: b.at(q.get(3)) }, signals: { s1: [[0, "high"], [0.005, "low"]] } }; // prettier-ignore
}

/** A flag HIGH for 30 ms through 10 kΩ into a 2N7000's gate, 1 µF from the
    gate to ground, its drain 100 Ω from +5 V. */
function nmosGateRc() {
  const b = bench();
  const q = b.seat("q1", "nmos", "a10", { case: "TO-92" });
  b.gnd(q.get(1));
  const rg = b.seat("rg", "resistor", "a20", { ohms: 10e3 });
  b.signal("s1", rg.get(1), "low");
  b.link(rg.get(2), q.get(2));
  const c = b.seat("c1", "cap-electrolytic", "a30", { farads: 1e-6 });
  b.link(c.get(1), q.get(2));
  b.gnd(c.get(2));
  const rd = b.seat("rd", "resistor", "a40", { ohms: 100 });
  b.vcc(rd.get(1));
  b.link(rd.get(2), q.get(3));
  return { doc: b.doc, at: { gate: b.at(q.get(2)), drain: b.at(q.get(3)) }, signals: { s1: [[0, "high"], [0.03, "low"]] } }; // prettier-ignore
}

/** A 50 Hz sine clock through 47 kΩ into a 2N3904's base, its collector
    1 kΩ from +5 V. */
function npnOnSine() {
  const b = bench();
  waveClock(b, "sine", 50, "e5");
  const rb = b.seat("rb", "resistor", "a5", { ohms: 47e3 });
  const q = b.seat("q1", "npn", "a30");
  b.gnd(q.get(1));
  b.link(rb.get(2), q.get(2));
  const rc = b.seat("rc", "resistor", "a40", { ohms: 1e3 });
  b.vcc(rc.get(1));
  b.link(rc.get(2), q.get(3));
  return { doc: b.doc, at: { collector: b.at(q.get(3)) } };
}

/** A 2N3904 common-emitter stage: a 1 kHz sine of 0.2 V about 2.5 V
    through 1 µF into its base (47 kΩ up, 10 kΩ down), 2.2 kΩ collector,
    470 Ω emitter, its collector through 1 µF into 10 kΩ. */
function commonEmitter() {
  const b = bench();
  waveClock(b, "sine", 1000, "e5", { amplitude: 0.2, offset: 2.5 });
  const cin = b.seat("c1", "cap-ceramic", "a5", { farads: 1e-6 });
  const q = b.seat("q1", "npn", "a30");
  b.link(cin.get(2), q.get(2));
  const up = b.seat("r1", "resistor", "a10", { ohms: 47e3 });
  b.vcc(up.get(1));
  b.link(up.get(2), q.get(2));
  const down = b.seat("r2", "resistor", "a15", { ohms: 10e3 });
  b.link(down.get(1), q.get(2));
  b.gnd(down.get(2));
  const re = b.seat("re", "resistor", "a35", { ohms: 470 });
  b.link(re.get(1), q.get(1));
  b.gnd(re.get(2));
  const rc = b.seat("rc", "resistor", "a40", { ohms: 2.2e3 });
  b.vcc(rc.get(1));
  b.link(rc.get(2), q.get(3));
  const cout = b.seat("c2", "cap-ceramic", "a45", { farads: 1e-6 });
  b.link(cout.get(1), q.get(3));
  const rl = b.seat("rl", "resistor", "a50", { ohms: 10e3 });
  b.link(rl.get(1), cout.get(2));
  b.gnd(rl.get(2));
  return { doc: b.doc, at: { base: b.at(q.get(2)), out: b.at(rl.get(1)) } };
}

/** A 500 Hz square clock through 100 µF into an 8 Ω speaker. */
function coupledSpeaker() {
  const b = bench();
  waveClock(b, "square", 500, "e5");
  const c = b.seat("c1", "cap-electrolytic", "a5", { farads: 100e-6 });
  const sp = b.seat("sp1", "speaker", "a20");
  b.link(c.get(2), sp.get(1));
  b.gnd(sp.get(2));
  return { doc: b.doc, at: { coil: b.at(sp.get(1)) } };
}

/** A meter brick at `setting`, its red probe on `red` and its black on
    `black` (holes). */
function meterBrick(b, setting, red, black) {
  const def = partDef("meter");
  b.doc.components.push({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 40, params: def.normalizeParams({ ...setting, red: { at: b.at(red) }, black: { at: b.at(black) } }) }); // prettier-ignore
}

/** +5 V through `top` and `bottom` to ground: the meter across `bottom`
    (`a` the tap) — or, `series`, IN the gap between them (`a` its red
    side, `b` its black). */
function meterOnDivider(setting, top, bottom, series) {
  const b = bench();
  const r1 = b.seat("r1", "resistor", "a20", { ohms: top });
  const r2 = b.seat("r2", "resistor", "a30", { ohms: bottom });
  b.vcc(r1.get(1));
  b.gnd(r2.get(2));
  if (series) {
    meterBrick(b, setting, r1.get(2), r2.get(1));
    return { doc: b.doc, at: { a: b.at(r1.get(2)), b: b.at(r2.get(1)) } };
  }
  b.link(r1.get(2), r2.get(1));
  meterBrick(b, setting, r2.get(1), r2.get(2));
  return { doc: b.doc, at: { a: b.at(r1.get(2)) } };
}

/** A meter at `setting` joined in the supply's + lead (or, `minus`, its −):
    a 74LS00 past it (its signal pins open, so it is its supply current
    alone), `load` from the far rail to the other one, and a 330/330
    divider across the supply itself. `far` the rail past the meter, `near`
    the supply's own side of it, `mid` the divider's tap, `vcc` the chip's
    VCC. */
function meterInLead(setting, load, minus) {
  const b = bench();
  const u = b.seat("u1", "74LS00", "e40");
  const rl = b.seat("rl", "resistor", "a20", { ohms: load });
  const vcc = u.get(14).replace(/^f/, "j");
  const gnd = u.get(7).replace(/^e/, "a");
  if (minus) {
    b.vcc(vcc);
    b.link(gnd, "c5");
    b.vcc(rl.get(1));
    b.link(rl.get(2), "b5");
  } else {
    b.link(vcc, "c5");
    b.gnd(gnd);
    b.link(rl.get(1), "b5");
    b.gnd(rl.get(2));
  }
  const s1 = b.seat("s1", "resistor", "f20", { ohms: 330 });
  const s2 = b.seat("s2", "resistor", "f30", { ohms: 330 });
  b.vcc(s1.get(1));
  b.link(s1.get(2), s2.get(1));
  b.gnd(s2.get(2));
  const [red, black] = minus ? [b.at("d5"), "psu1.-"] : ["psu1.+", b.at("d5")]; // prettier-ignore
  const def = partDef("meter");
  b.doc.components.push({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 40, params: def.normalizeParams({ ...setting, red: { at: red }, black: { at: black } }) }); // prettier-ignore
  return { doc: b.doc, at: { far: b.at("a5"), near: minus ? "psu1.-" : "psu1.+", mid: b.at(s1.get(2)), vcc: b.at(u.get(14)) } }; // prettier-ignore
}

/** A meter at each of `plus` (in the supply's + lead) and `minus` (its −),
    a 74LS00 (its signal pins open) and `load` across the two rails past
    them: `plus` the rail past the + meter, `minus` past the − one. */
function meterBothLeads(plus, minus, load) {
  const b = bench();
  const u = b.seat("u1", "74LS00", "e40");
  const rl = b.seat("rl", "resistor", "a20", { ohms: load });
  b.link(u.get(14).replace(/^f/, "j"), "c5");
  b.link(rl.get(1), "b5");
  b.link(u.get(7).replace(/^e/, "a"), "c8");
  b.link(rl.get(2), "b8");
  const def = partDef("meter");
  const meter = (id, setting, red, black) => b.doc.components.push({ id, kind: "meter", ref: "meter", x: 70, y: 40, params: def.normalizeParams({ ...setting, red: { at: red }, black: { at: black } }) }); // prettier-ignore
  meter("dmm1", plus, "psu1.+", b.at("d5"));
  meter("dmm2", minus, b.at("d8"), "psu1.-");
  return { doc: b.doc, at: { plus: b.at("a5"), minus: b.at("a8") } };
}

/** A 74LS04 past a meter at `setting` in the supply's + lead (or, `minus`,
    its −), its input tied LOW and its output HIGH into 330 Ω and a red LED
    `d1` to its own ground — or (`sink`) its input HIGH and its output LOW
    sinking that LED from +5 V. `out` its output, `far` the rail past the
    meter. */
function meterChipLed(setting, minus, sink) {
  const b = bench();
  const u = b.seat("u1", "74LS04", "e40");
  const vcc = u.get(14).replace(/^f/, "j");
  const gnd = u.get(7).replace(/^e/, "a");
  const far = minus ? "c8" : "c5";
  b.link(minus ? gnd : vcc, far);
  if (minus) b.vcc(vcc);
  else b.gnd(gnd);
  // The input to the chip's own rail.
  b.link(u.get(1).replace(/^e/, "a"), sink ? (minus ? "j55" : far) : minus ? far : "j55"); // prettier-ignore
  if (sink ? minus : !minus) b[sink ? "vcc" : "gnd"]("j55");
  const r = b.seat("r1", "resistor", "a20", { ohms: 330 });
  const d = b.seat("d1", "led", "f20", { color: "red" });
  b.link(u.get(2).replace(/^e/, "b"), r.get(sink ? 2 : 1));
  if (sink) {
    b.link(d.get(2).replace(/^f/, "g"), r.get(1));
    b.vcc(d.get(1));
  } else {
    b.link(r.get(2), d.get(1).replace(/^f/, "g"));
    b.link(d.get(2), minus ? far.replace(/^c/, "e") : "j56");
    if (!minus) b.gnd("j56");
  }
  const def = partDef("meter");
  const [red, black] = minus ? [b.at(far.replace(/^c/, "d")), "psu1.-"] : ["psu1.+", b.at(far.replace(/^c/, "d"))]; // prettier-ignore
  b.doc.components.push({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 40, params: def.normalizeParams({ ...setting, red: { at: red }, black: { at: black } }) }); // prettier-ignore
  return { doc: b.doc, at: { out: b.at(u.get(2)), far: b.at(far.replace(/^c/, "a")) } }; // prettier-ignore
}

/** µA then mA in series in the supply's + lead, 4.7 kΩ and a 74LS00 past
    both: `first` the net between them, `second` the rail past both. */
function meterChained() {
  const b = bench();
  const u = b.seat("u1", "74LS00", "e40");
  const rl = b.seat("rl", "resistor", "a20", { ohms: 4700 });
  b.link(u.get(14).replace(/^f/, "j"), "c5");
  b.gnd(u.get(7).replace(/^e/, "a"));
  b.link(rl.get(1), "b5");
  b.gnd(rl.get(2));
  const def = partDef("meter");
  const meter = (id, setting, red, black) => b.doc.components.push({ id, kind: "meter", ref: "meter", x: 70, y: 40, params: def.normalizeParams({ ...setting, red: { at: red }, black: { at: black } }) }); // prettier-ignore
  meter("dmm1", { dial: "ua", jack: "ma" }, "psu1.+", b.at("a10"));
  meter("dmm2", { dial: "ma", jack: "ma" }, b.at("b10"), b.at("d5"));
  return { doc: b.doc, at: { first: b.at("c10"), second: b.at("a5") } };
}

/** A supply limited to 0.1 A, a meter at `setting` in its + lead and `load`
    and a 74LS04 (its signal pins open) past it: `near` its terminal, `far`
    the rail past the meter. */
function meterLimited(setting, load) {
  const b = bench();
  b.doc.components[0].params.currentLimit = 0.1;
  const u = b.seat("u1", "74LS04", "e40");
  const rl = b.seat("rl", "resistor", "a20", { ohms: load });
  b.link(u.get(14).replace(/^f/, "j"), "c5");
  b.gnd(u.get(7).replace(/^e/, "a"));
  b.link(rl.get(1), "b5");
  b.gnd(rl.get(2));
  const def = partDef("meter");
  b.doc.components.push({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 40, params: def.normalizeParams({ ...setting, red: { at: "psu1.+" }, black: { at: b.at("d5") } }) }); // prettier-ignore
  return { doc: b.doc, at: { near: "psu1.+", far: b.at("a5") } };
}

/** µA in the supply's + lead, 100 µF and a 74LS00 (its signal pins open) on
    the rail past it: `far` that rail. */
function meterFarCap() {
  const b = bench();
  const u = b.seat("u1", "74LS00", "e40");
  b.link(u.get(14).replace(/^f/, "j"), "c5");
  b.gnd(u.get(7).replace(/^e/, "a"));
  const c = b.seat("c1", "cap-electrolytic", "a10", { farads: 100e-6 });
  b.link("b5", c.get(1).replace(/^a/, "d"));
  b.gnd(c.get(2));
  const def = partDef("meter");
  b.doc.components.push({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 40, params: def.normalizeParams({ dial: "ua", jack: "ma", red: { at: "psu1.+" }, black: { at: b.at("d5") } }) }); // prettier-ignore
  return { doc: b.doc, at: { far: b.at("a5") } };
}

/** A 10 kΩ resistor (or a 1N4148, anode up) from a hole to ground, the
    meter's red probe on its top and black on ground. */
function meterAcross(ref, setting) {
  const b = bench();
  const part = b.seat("p1", ref, "a20", ref === "resistor" ? { ohms: 10e3 } : {}); // prettier-ignore
  b.gnd(part.get(2));
  meterBrick(b, setting, part.get(1), part.get(2));
  return { doc: b.doc, at: { a: b.at(part.get(1)) } };
}

/** An LM358 inverting Schmitt trigger on 5 V: a 10 Hz sine through 10 kΩ
    into IN−, IN+ between 10 kΩ to each rail with 47 kΩ from OUT; a
    CD4069UB reads OUT. */
function opAmpSchmitt() {
  const b = bench();
  const u = b.seat("u1", "LM358", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(4));
  b.gnd(u.get(5));
  b.link(u.get(6), u.get(7));
  waveClock(b, "sine", 10, "e5");
  const rin = b.seat("ri", "resistor", "a5", { ohms: 10e3 });
  b.link(rin.get(2), u.get(2));
  const up = b.seat("ra", "resistor", "a30", { ohms: 10e3 });
  b.vcc(up.get(1));
  b.link(up.get(2), u.get(3));
  const down = b.seat("rb", "resistor", "a35", { ohms: 10e3 });
  b.link(down.get(1), u.get(3));
  b.gnd(down.get(2));
  const rf = b.seat("rf", "resistor", "a40", { ohms: 47e3 });
  b.link(rf.get(1), u.get(1));
  b.link(rf.get(2), u.get(3));
  const inv = b.seat("u2", "CD4069UB", "e45");
  b.vcc(inv.get(14));
  b.gnd(inv.get(7));
  b.link(inv.get(1), u.get(1));
  return { doc: b.doc, at: { out: b.at(u.get(1)) } };
}

/** A 5 V relay's coil from +5 V into a 2N3904's collector (base 1 kΩ from a
    flag HIGH for 20 ms), a 1N4148 across the coil; COM on +5 V, NO into
    1 kΩ to ground. */
function relaySwitch() {
  const b = bench();
  const k = b.seat("k1", "relay", "a40");
  const q = b.seat("q1", "npn", "a20");
  b.gnd(q.get(1));
  const rb = b.seat("rb", "resistor", "a10", { ohms: 1e3 });
  b.link(rb.get(2), q.get(2));
  b.signal("s1", rb.get(1), "low");
  b.vcc(k.get(1));
  b.link(k.get(2), q.get(3));
  const d = b.seat("d1", "diode", "f20");
  b.link(d.get(1), q.get(3));
  b.vcc(d.get(2));
  b.vcc(k.get(3));
  const rl = b.seat("rl", "resistor", "a50", { ohms: 1e3 });
  b.link(rl.get(1), k.get(4));
  b.gnd(rl.get(2));
  return { doc: b.doc, at: { collector: b.at(q.get(3)), no: b.at(k.get(4)) }, signals: { s1: [[0, "high"], [0.02, "low"]] } }; // prettier-ignore
}

/** A MOSFET of `type` (`params`), its gate on its source, its body diode
    carrying `ohms`' current: an N's source fed from +5 V, its drain on
    ground; a P's source to ground through `ohms`, its drain on +5 V. */
function bodyDiode(type, params, ohms) {
  const b = bench();
  const q = b.seat("q1", type, "a10", params);
  const r = b.seat("r1", "resistor", "a20", { ohms });
  b.link(q.get(1), q.get(2));
  b.link(r.get(1), q.get(1));
  if (type === "nmos") {
    b.vcc(r.get(2));
    b.gnd(q.get(3));
  } else {
    b.gnd(r.get(2));
    b.vcc(q.get(3));
  }
  return { doc: b.doc, at: { source: b.at(q.get(1)) } };
}

/** A 1 kHz square clock through 10 µF into `kind`: "clamp", a red LED (or
    a small-signal diode, `part`) from the far plate to ground; "pump", that
    and a second from 100 µF ∥ 10 kΩ (the pump's output, `out`, below
    ground) into the plate. */
function coupledEdge(kind, part = "led") {
  const b = bench();
  const c1 = b.seat("c1", "cap-electrolytic", "a10", { farads: 10e-6 });
  waveClock(b, "square", 1000, c1.get(1));
  const junction = part === "led" ? { color: "red" } : {};
  const d1 = b.seat("d1", part, "a20", junction);
  b.link(c1.get(2), d1.get(1));
  b.gnd(d1.get(2));
  const at = { x: b.at(c1.get(2)) };
  if (kind === "pump") {
    const d2 = b.seat("d2", part, "a30", junction);
    const c2 = b.seat("c2", "cap-electrolytic", "a40", { farads: 100e-6 });
    const r = b.seat("r1", "resistor", "a50", { ohms: 10e3 });
    b.link(d2.get(2), c1.get(2));
    b.link(d2.get(1), c2.get(2));
    b.gnd(c2.get(1));
    b.link(r.get(1), c2.get(2));
    b.gnd(r.get(2));
    at.out = b.at(c2.get(2));
  }
  return { doc: b.doc, at };
}

/** A 1 kHz square clock through 100 nF into a 2N3904's base, 10 kΩ from it
    to ground, its collector 1 kΩ from +5 V. */
function coupledBase() {
  const b = bench();
  const q = b.seat("q1", "npn", "a10");
  b.gnd(q.get(1));
  const c = b.seat("c1", "cap-ceramic", "a20", { farads: 100e-9 });
  waveClock(b, "square", 1000, c.get(1));
  b.link(c.get(2), q.get(2));
  const rb = b.seat("rb", "resistor", "a30", { ohms: 10e3 });
  b.link(rb.get(1), q.get(2));
  b.gnd(rb.get(2));
  const rc = b.seat("rc", "resistor", "a40", { ohms: 1e3 });
  b.vcc(rc.get(1));
  b.link(rc.get(2), q.get(3));
  return { doc: b.doc, at: { b: b.at(q.get(2)), c: b.at(q.get(3)) } };
}

/** A 12 V~ 60 Hz AC adapter through a small-signal diode into `farads` ∥
    1 kΩ, the adapter's S2 on the ground rail. */
function halfWave(farads) {
  const b = bench();
  const d = b.seat("d1", "diode", "a10");
  const c = b.seat("c1", "cap-electrolytic", "a20", { farads });
  const r = b.seat("r1", "resistor", "a30", { ohms: 1000 });
  b.link(d.get(2), c.get(1));
  b.link(c.get(1), r.get(1));
  b.link(c.get(2), r.get(2));
  b.gnd(c.get(2));
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -40, y: 40, params: partDef("adapter").normalizeParams({ hz: 60, rms: 12 }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wl", from: "adp1.S1", to: b.at(d.get(1)), color: "red" },
    { id: "wn", from: "adp1.S2", to: b.at(c.get(2)), color: "black" },
  );
  return { doc: b.doc, at: { out: b.at(c.get(1)) } };
}

/** A transistor of `type` driven hard on: its base `rb` from the rail that
    turns it on, its emitter on the other, its collector `rc` to the first. */
function deepSaturation(type, rb, rc) {
  const b = bench();
  const q = b.seat("q1", type, "a10");
  const base = b.seat("rb", "resistor", "a20", { ohms: rb });
  const load = b.seat("rc", "resistor", "a30", { ohms: rc });
  b.link(q.get(2), base.get(1));
  b.link(q.get(3), load.get(1));
  const on = type === "npn" ? (h) => b.vcc(h) : (h) => b.gnd(h);
  const off = type === "npn" ? (h) => b.gnd(h) : (h) => b.vcc(h);
  on(base.get(2));
  on(load.get(2));
  off(q.get(1));
  return { doc: b.doc, at: { b: b.at(q.get(2)), c: b.at(q.get(3)) } };
}

/** +5 V through `ohms` into a diode of `grade` to ground. */
function diodeLoad(ohms, grade) {
  const b = bench();
  const r = b.seat("r1", "resistor", "a20", { ohms });
  const d = b.seat("d1", "diode", "a30", { grade });
  b.vcc(r.get(1));
  b.link(r.get(2), d.get(1));
  b.gnd(d.get(2));
  return { doc: b.doc, at: {} };
}

/** 12 V through 470 Ω into a 5.1 V Zener (cathode up), and `load` across
    it. */
function zenerShunt(load) {
  const b = bench({ volts: 12 });
  const r = b.seat("r1", "resistor", "a20", { ohms: 470 });
  const z = b.seat("z1", "zener", "a30", { zenerVolts: 5.1 });
  b.vcc(r.get(1));
  b.link(r.get(2), z.get(2));
  b.gnd(z.get(1));
  if (load) {
    const rl = b.seat("rl", "resistor", "a40", { ohms: load });
    b.link(rl.get(1), z.get(2));
    b.gnd(rl.get(2));
  }
  return { doc: b.doc, at: { out: b.at(z.get(2)) } };
}

/** 9 V through `ohms` into `n` LEDs of `color` in series. */
function ledString(color, n, ohms) {
  const b = bench({ volts: 9 });
  const r = b.seat("r1", "resistor", "a5", { ohms });
  b.vcc(r.get(1));
  let prev = r.get(2);
  for (let k = 1; k <= n; k++) {
    const d = b.seat(`d${k}`, "led", `a${5 + 8 * k}`, { color });
    b.link(prev, d.get(1));
    prev = d.get(2);
  }
  b.gnd(prev);
  return { doc: b.doc, at: {} };
}

/** A display's segment `seg` lit from +5 V through 330 Ω into its anode,
    its cathode on ground. */
function segmentLit(ref, seg) {
  const b = bench();
  const def = partDef(ref);
  const x = b.seat("x1", ref, def.package ? "e20" : "a20");
  const s = def.segments.find((g) => g.id === seg);
  const r = b.seat("r1", "resistor", "a50", { ohms: 330 });
  b.vcc(r.get(1));
  // (A common-anode part's anode IS its common.)
  b.link(r.get(2), x.get(s.anodePin));
  b.gnd(x.get(s.cathodePin));
  return { doc: b.doc, at: {} };
}

/** A character LCD powered, its backlight's A on +5 V and K on ground. */
function lcdBacklight(ref) {
  const b = bench();
  const x = b.seat("x1", ref, "a10");
  b.gnd(x.get(1));
  b.vcc(x.get(2));
  b.vcc(x.get(15));
  b.gnd(x.get(16));
  return { doc: b.doc, at: {} };
}

/** A CD4049UB (inverting) or CD4050B buffer's first unit HIGH into `ohms`
    to ground, or LOW with `ohms` from +5 V. */
function bufferStage(ref, side, ohms) {
  const b = bench();
  const u = b.seat("u1", ref, "e10");
  b.vcc(u.get(1));
  b.gnd(u.get(8));
  const high = side === "high";
  // A 4049 inverts: its input LOW for a HIGH.
  if (high === (ref === "CD4049UB")) b.gnd(u.get(3));
  else b.vcc(u.get(3));
  const r = b.seat("r1", "resistor", "a30", { ohms });
  b.link(r.get(1), u.get(2));
  if (high) b.gnd(r.get(2));
  else b.vcc(r.get(2));
  return { doc: b.doc, at: { out: b.at(u.get(2)) } };
}

/** A CD4511B decoding 0 (D–A LOW, LT and BL HIGH, LE LOW): segment a
    through 330 Ω into a red LED. */
function decoderSegment() {
  const b = bench();
  const u = b.seat("u1", "CD4511B", "e10");
  b.vcc(u.get(16));
  b.gnd(u.get(8));
  for (const n of [1, 2, 6, 7, 5]) b.gnd(u.get(n));
  for (const n of [3, 4]) b.vcc(u.get(n));
  const r = b.seat("r1", "resistor", "a30", { ohms: 330 });
  b.link(r.get(1), u.get(13));
  const d = b.seat("d1", "led", "a40", { color: "red" });
  b.link(r.get(2), d.get(1));
  b.gnd(d.get(2));
  return { doc: b.doc, at: { out: b.at(u.get(13)) } };
}

/** A CD4007UB on `volts`: pair 3 an inverter (11 on VDD, 9 on VSS, its
    gates grounded) HIGH into 1 kΩ — or Q1's N-channel on (gate 6 on VDD),
    its drain 8 1 kΩ from VDD. */
function mosfetArray(use, volts) {
  const b = bench({ volts });
  const u = b.seat("u1", "CD4007UB", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.gnd(u.get(3));
  const r = b.seat("r1", "resistor", "a30", { ohms: 1e3 });
  if (use === "inverter") {
    b.vcc(u.get(11));
    b.gnd(u.get(9));
    b.gnd(u.get(10));
    b.gnd(u.get(6));
    b.link(r.get(1), u.get(12));
    b.gnd(r.get(2));
    return { doc: b.doc, at: { out: b.at(u.get(12)) } };
  }
  b.vcc(u.get(6));
  b.gnd(u.get(10));
  b.vcc(r.get(1));
  b.link(r.get(2), u.get(8));
  return { doc: b.doc, at: { out: b.at(u.get(8)) } };
}

/** One analog switch channel on between 1 kΩ from +5 V (`a`) and 1 kΩ to
    ground (`b`): the CD4066B's A, the CD4051B's channel 5, the CD4052B's
    X channel 2, the CD4053B's B section on Y. Every other control on a
    rail. */
function switchChannel(ref) {
  const b = bench();
  const u = b.seat("u1", ref, "e10");
  const wiring = {
    CD4066B: { vdd: 14, gnd: [7, 5, 6, 12], high: [13], a: 1, b: 2 },
    CD4051B: { vdd: 16, gnd: [7, 8, 6, 10], high: [9, 11], a: 3, b: 5 },
    CD4052B: { vdd: 16, gnd: [7, 8, 6, 10], high: [9], a: 13, b: 15 },
    CD4053B: { vdd: 16, gnd: [7, 8, 6, 9, 11], high: [10], a: 15, b: 1 },
  }[ref];
  b.vcc(u.get(wiring.vdd));
  for (const n of wiring.gnd) b.gnd(u.get(n));
  for (const n of wiring.high) b.vcc(u.get(n));
  const up = b.seat("r1", "resistor", "a30", { ohms: 1e3 });
  b.vcc(up.get(1));
  b.link(up.get(2), u.get(wiring.a));
  const down = b.seat("r2", "resistor", "a40", { ohms: 1e3 });
  b.link(down.get(1), u.get(wiring.b));
  b.gnd(down.get(2));
  return { doc: b.doc, at: { a: b.at(u.get(wiring.a)), b: b.at(u.get(wiring.b)) } }; // prettier-ignore
}

/** An 8 K ROM enabled at address 1 (A0 HIGH, the rest LOW; CE and OE
    LOW), its byte there 0: Q0 under 1 kΩ and Q1 under 330 Ω from +5 V. */
function romOutputs() {
  const b = bench();
  const u = b.seat("u1", "rom-8k", "e10");
  b.vcc(u.get(28));
  b.gnd(u.get(14));
  b.vcc(u.get(1));
  for (const n of [2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25, 26, 27]) b.gnd(u.get(n)); // prettier-ignore
  const r0 = b.seat("r1", "resistor", "a45", { ohms: 1e3 });
  b.link(r0.get(1), u.get(9));
  b.vcc(r0.get(2));
  const r1 = b.seat("r2", "resistor", "a50", { ohms: 330 });
  b.vcc(r1.get(1));
  b.link(r1.get(2), u.get(10));
  return { doc: b.doc, at: { q0: b.at(u.get(9)), q1: b.at(u.get(10)) } };
}

/** A CD4093B NAND relaxation oscillator: B on VDD, `r` from J back to A,
    `c` from A to ground. */
function nandRelaxation(r, c) {
  const b = bench();
  const u = chip(b, "u1", "CD4093B", "e10");
  b.vcc(u.get(2));
  const res = b.seat("r1", "resistor", "a30", { ohms: r });
  b.link(res.get(1), u.get(1));
  b.link(res.get(2), u.get(3));
  const cap = b.seat("c1", "cap-electrolytic", "a40", { farads: c });
  b.link(cap.get(1), u.get(1));
  b.gnd(cap.get(2));
  return { doc: b.doc, at: { out: b.at(u.get(3)) } };
}

/** The 555 monostable (SLFS022K Figure 6-1): `r` from VCC to DISCH + THRES,
    `c` from there to GND, RESET HIGH, TRIG from a flag resting HIGH and
    pulsed LOW for 1 ms every `every` seconds (the first at `every`/5). */
function monostable555(r, c, { every, pulses }) {
  const b = bench();
  const u = b.seat("u1", "NE555", "e10");
  b.vcc(u.get(8));
  b.gnd(u.get(1));
  b.vcc(u.get(4));
  b.link(u.get(6), u.get(7));
  const cap = b.seat("c1", "cap-electrolytic", "a30", { farads: c });
  b.link(cap.get(1), u.get(6));
  b.gnd(cap.get(2));
  const res = b.seat("r1", "resistor", "a40", { ohms: r });
  b.vcc(res.get(1));
  b.link(res.get(2), u.get(7));
  b.signal("s1", u.get(2), "high");
  const steps = [[0, "high"]];
  for (let k = 0; k < pulses; k++) {
    const t = every / 5 + k * every;
    steps.push([t, "low"], [t + 1e-3, "high"]);
  }
  return { doc: b.doc, at: { out: b.at(u.get(3)) }, signals: { s1: steps } };
}

/** +5 V through 1 Ω and a 1 mH coil (its own 0.74 Ω) onto 10 µF. */
function lcRing() {
  const b = bench();
  const r = b.seat("r1", "resistor", "a20", { ohms: 1 });
  const l = b.seat("l1", "inductor", "a30", { henries: 1e-3, style: "coil" });
  const c = b.seat("c1", "cap-electrolytic", "a45", { farads: 10e-6 });
  b.vcc(r.get(1));
  b.link(r.get(2), l.get(1));
  b.link(l.get(2), c.get(1));
  b.gnd(c.get(2));
  return { doc: b.doc, at: { cap: b.at(c.get(1)) } };
}

/** An rnet9 of 10 kΩ (COM on +5 V), its pin 2 into 4.7 kΩ and pin 3 into
    1 kΩ to ground; a 10 kΩ pot from +5 V to ground at 30 %, its wiper
    into 10 kΩ. */
function networkAndPot() {
  const b = bench();
  const n = b.seat("rn1", "rnet9", "a10", { ohms: 10e3 });
  b.vcc(n.get(1));
  const r2 = b.seat("r2", "resistor", "f10", { ohms: 4.7e3 });
  b.link(r2.get(1), n.get(2));
  b.gnd(r2.get(2));
  const r3 = b.seat("r3", "resistor", "f20", { ohms: 1e3 });
  b.link(r3.get(1), n.get(3));
  b.gnd(r3.get(2));
  const p = b.seat("pot1", "pot", "a40", { ohms: 10e3, position: 30 });
  b.vcc(p.get(1));
  b.gnd(p.get(3));
  const rw = b.seat("rw", "resistor", "a50", { ohms: 10e3 });
  b.link(rw.get(1), p.get(2));
  b.gnd(rw.get(2));
  return { doc: b.doc, at: { n2: b.at(n.get(2)), n3: b.at(n.get(3)), wiper: b.at(p.get(2)) } }; // prettier-ignore
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
