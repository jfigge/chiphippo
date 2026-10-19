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

// The transformer (catalog/ac-parts.js), Spice Lite's alone: two windings
// whose currents are coupled by their mutual inductance (spice/inductors.js,
// the inductance matrix of spice/engine.js `runGroup`). Its figures and
// presets, and its secondary against the phasor answer of the same two
// coupled coils — open, loaded, with less coupling, with more winding
// resistance, and at a Custom… ratio. The logic engine has no magnetism: to
// it the windings are two open ends. The Step-down example desktop is proved
// in spice-ac-examples.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TRANSFORMER_CUSTOM,
  TRANSFORMER_DEF,
  TRANSFORMER_DEFAULT,
  TRANSFORMER_PRESETS,
  acPeakOf,
  transformerBadge,
  transformerWindings,
} from "../catalog/ac-parts.js";
import { partDef } from "../catalog/index.js";
import { buildNetlist } from "../sim/netlist.js";
import { bench, runner } from "./timing-fixtures.js";

const HZ = 60;
const PEAK = acPeakOf(120);

// ── Figures ────────────────────────────────────────────────────────────────

test("a transformer's windings: L over the turns ratio squared, M = k·√(L1·L2)", () => {
  for (const preset of TRANSFORMER_PRESETS) {
    const w = transformerWindings(preset);
    const l2 = preset.primaryHenries / preset.turns ** 2;
    assert.equal(w.primary.henries, preset.primaryHenries, preset.value);
    assert.equal(w.primary.ohms, preset.primaryOhms);
    assert.ok(Math.abs(w.secondary.henries - l2) < 1e-15, preset.value);
    assert.equal(w.secondary.ohms, preset.secondaryOhms);
    assert.ok(Math.abs(w.mutual - 0.99 * Math.sqrt(preset.primaryHenries * l2)) < 1e-12); // prettier-ignore
    assert.equal(w.coupling, 0.99);
  }
});

test("a transformer's params: the 120 V → 12 V preset by default, each figure held to its range", () => {
  const norm = (raw) => TRANSFORMER_DEF.normalizeParams(raw);
  const { value: _v, label: _l, ...figures } = TRANSFORMER_DEFAULT;
  assert.deepEqual(norm({}), figures);
  // Coupling is never 1 (no leakage at all is a singular inductance matrix).
  assert.equal(norm({ coupling: 1 }).coupling, 0.99);
  assert.equal(norm({ coupling: 0.999 }).coupling, 0.999);
  assert.equal(norm({ turns: 0 }).turns, 10);
  assert.equal(norm({ turns: 2.5 }).turns, 2.5);
  assert.equal(partDef("transformer").spiceOnly, true);
  assert.deepEqual(partDef("transformer").terminals.map((t) => t.id), ["P1", "P2", "S1", "S2"]); // prettier-ignore
});

test("a transformer's Rating and badge: a preset by its label, anything else by its ratio", () => {
  const rating = TRANSFORMER_DEF.properties.find((f) => f.key === "rating");
  assert.equal(rating.selected(TRANSFORMER_PRESETS[3]), "230-12");
  assert.equal(rating.selected({ ...TRANSFORMER_DEFAULT, turns: 7 }), TRANSFORMER_CUSTOM); // prettier-ignore
  assert.equal(rating.pick({}, "120-5").turns, 24);
  // Custom… opens on the figures it already has.
  assert.equal(rating.pick({ ...TRANSFORMER_DEFAULT, turns: 7 }, TRANSFORMER_CUSTOM).turns, 7); // prettier-ignore
  assert.equal(transformerBadge({}), "120 V → 12 V");
  assert.equal(transformerBadge({ turns: 7.25 }), "7.25:1");
});

// ── The secondary, against the phasor answer ───────────────────────────────

/** Complex arithmetic, as much as two coupled coils need. */
const cx = (re, im = 0) => ({ re, im });
const add = (a, b) => cx(a.re + b.re, a.im + b.im);
const mul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => {
  const d = b.re * b.re + b.im * b.im;
  return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const abs = (a) => Math.hypot(a.re, a.im);

/**
 * The secondary's peak in the steady state, a `load` ohms across it
 * (Infinity: open): V = Z1·I1 + Zm·I2, 0 = Zm·I1 + Z2·I2, with Z1 = R1 +
 * jωL1, Z2 = R2 + RL + jωL2, Zm = jωM.
 */
function phasorPeak(params, load) {
  const w = transformerWindings(params);
  const om = 2 * Math.PI * HZ;
  const z1 = cx(w.primary.ohms, om * w.primary.henries);
  const zm = cx(0, om * w.mutual);
  if (load === Infinity) return abs(mul(zm, div(cx(PEAK), z1)));
  const z2 = cx(w.secondary.ohms + load, om * w.secondary.henries);
  const i1 = div(cx(PEAK), add(z1, mul(cx(-1), div(mul(zm, zm), z2))));
  return abs(mul(div(mul(zm, i1), z2), cx(load)));
}

/**
 * 120 V~ 60 Hz across a transformer of `params`, its secondary across a
 * resistor of `load` ohms (none: open), S2 on the supply's −. Run a second
 * — five of the magnetising current's time constants, its offset gone — then
 * read half the secondary's peak-to-peak over a whole cycle.
 */
function secondaryPeak(params, load = null) {
  const b = bench();
  b.doc.components.push(
    { id: "ac1", kind: "ac", ref: "ac", x: -40, y: 30, params: partDef("ac").normalizeParams({ peak: PEAK, trough: -PEAK, hz: HZ }) }, // prettier-ignore
    { id: "xfmr1", kind: "transformer", ref: "transformer", x: -20, y: 30, params: TRANSFORMER_DEF.normalizeParams(params) }, // prettier-ignore
  );
  b.doc.wires.push(
    { id: "wp1", from: "ac1.L", to: "xfmr1.P1", color: "red" },
    { id: "wp2", from: "ac1.N", to: "xfmr1.P2", color: "black" },
    { id: "wn", from: "ac1.N", to: "psu1.-", color: "black" },
    { id: "ws2", from: "xfmr1.S2", to: "psu1.-", color: "black" },
  );
  // S1 on a board node: the resistor's lead, or a hole of its own.
  let s1 = b.at("a10");
  if (load != null) {
    const r = b.seat("r1", "resistor", "a10", { ohms: load });
    b.gnd(r.get(2));
    s1 = b.at(r.get(1));
  }
  b.doc.wires.push({ id: "ws1", from: "xfmr1.S1", to: b.at("c10"), color: "blue" }); // prettier-ignore
  const r = runner(b.doc, { engine: "spice" });
  r.run(0);
  r.run(1);
  const v = () => {
    const at = (a) => r.result.nodeVolts.get(r.netlist.netOfPoint.get(a));
    return at(s1) - at("xfmr1.S2");
  };
  let hi = -Infinity;
  let lo = Infinity;
  const steps = 480;
  for (let k = 1; k <= steps; k++) {
    r.run(1 + k / (steps * HZ));
    hi = Math.max(hi, v());
    lo = Math.min(lo, v());
  }
  return (hi - lo) / 2;
}

const near = (got, want, rel, what) =>
  assert.ok(
    Math.abs(got - want) <= rel * Math.abs(want),
    `${what}: ${got}, want ${want} ±${rel * 100} %`,
  );

test("the secondary, open and loaded, is the phasor answer of its two coupled coils", () => {
  const open = secondaryPeak({});
  near(open, phasorPeak({}, Infinity), 5e-4, "open");
  assert.ok(
    open < PEAK / 10,
    "a little under the ratio: the primary's own drop",
  );
  const loaded = secondaryPeak({}, 100);
  near(loaded, phasorPeak({}, 100), 5e-4, "across 100 Ω");
  near(secondaryPeak({}, 10), phasorPeak({}, 10), 5e-4, "across 10 Ω");
  assert.ok(loaded < open, "a load sags it");
});

test("less coupling and more winding resistance each lower the loaded secondary", () => {
  const base = secondaryPeak({}, 10);
  const leaky = { ...TRANSFORMER_DEFAULT, coupling: 0.9 };
  const resistive = { ...TRANSFORMER_DEFAULT, secondaryOhms: 2 };
  const leakyPeak = secondaryPeak(leaky, 10);
  const resistivePeak = secondaryPeak(resistive, 10);
  near(leakyPeak, phasorPeak(leaky, 10), 5e-4, "coupling 0.9");
  near(resistivePeak, phasorPeak(resistive, 10), 5e-4, "a 2 Ω secondary");
  assert.ok(leakyPeak < base, `leakage: ${leakyPeak} < ${base}`);
  assert.ok(resistivePeak < base, `resistance: ${resistivePeak} < ${base}`);
});

test("a Custom… ratio steps down by what it is set to", () => {
  const five = { ...TRANSFORMER_DEFAULT, turns: 5 };
  const peak = secondaryPeak(five, 100);
  near(peak, phasorPeak(five, 100), 5e-4, "5:1 across 100 Ω");
  // A fifth of the primary's, less the two windings' drops.
  near(peak, PEAK / 5, 0.05, "about a fifth of the primary's");
});

/**
 * The primary's peak current, read across a 1 Ω sense resistor between the
 * supply's L and P1, with the secondary `shorted` (S1 wired to S2) or open.
 */
function primaryPeakAmps(shorted) {
  const b = bench();
  b.doc.components.push(
    { id: "ac1", kind: "ac", ref: "ac", x: -40, y: 30, params: partDef("ac").normalizeParams({ peak: PEAK, trough: -PEAK, hz: HZ }) }, // prettier-ignore
    { id: "xfmr1", kind: "transformer", ref: "transformer", x: -20, y: 30, params: TRANSFORMER_DEF.normalizeParams({}) }, // prettier-ignore
  );
  const rs = b.seat("rs", "resistor", "a20", { ohms: 1 });
  const [l, p1] = [`c${rs.get(1).slice(1)}`, `c${rs.get(2).slice(1)}`];
  b.doc.wires.push(
    { id: "wl", from: "ac1.L", to: b.at(l), color: "red" },
    { id: "wp1", from: "xfmr1.P1", to: b.at(p1), color: "red" },
    { id: "wp2", from: "ac1.N", to: "xfmr1.P2", color: "black" },
    { id: "wn", from: "ac1.N", to: "psu1.-", color: "black" },
  );
  if (shorted) {
    b.doc.wires.push({ id: "ws", from: "xfmr1.S1", to: "xfmr1.S2", color: "blue" }); // prettier-ignore
  }
  const r = runner(b.doc, { engine: "spice" });
  r.run(0);
  r.run(1);
  const at = (a) => r.result.nodeVolts.get(r.netlist.netOfPoint.get(b.at(a)));
  let hi = -Infinity;
  let lo = Infinity;
  const steps = 480;
  for (let k = 1; k <= steps; k++) {
    r.run(1 + k / (steps * HZ));
    const amps = at(l) - at(p1);
    hi = Math.max(hi, amps);
    lo = Math.min(lo, amps);
  }
  return (hi - lo) / 2;
}

test("a shorted secondary loads the primary as the phasor answer says, not as an open one", () => {
  const w = transformerWindings({});
  const om = 2 * Math.PI * HZ;
  const z1 = cx(w.primary.ohms + 1, om * w.primary.henries);
  const zm = cx(0, om * w.mutual);
  const z2 = cx(w.secondary.ohms, om * w.secondary.henries);
  const open = primaryPeakAmps(false);
  near(open, abs(div(cx(PEAK), z1)), 1e-3, "open: the magnetising current");
  const shorted = primaryPeakAmps(true);
  const want = abs(div(cx(PEAK), add(z1, mul(cx(-1), div(mul(zm, zm), z2)))));
  near(shorted, want, 1e-3, "shorted");
  assert.ok(shorted > 10 * open, `a short draws far more: ${shorted} vs ${open}`); // prettier-ignore
});

test("the logic engine has no magnetism: the windings are two open ends", () => {
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.doc.components.push({ id: "xfmr1", kind: "transformer", ref: "transformer", x: -20, y: 30, params: TRANSFORMER_DEF.normalizeParams({}) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wp1", from: "psu1.+", to: "xfmr1.P1", color: "red" },
    { id: "wp2", from: "psu1.-", to: "xfmr1.P2", color: "black" },
    { id: "ws1", from: "xfmr1.S1", to: b.at(`a${u.get(1).slice(1)}`), color: "blue" }, // prettier-ignore
  );
  const netlist = buildNetlist(b.doc);
  const net = (a) => netlist.netOfPoint.get(a);
  assert.notEqual(net("xfmr1.P1"), net("xfmr1.P2"), "no wire through the primary"); // prettier-ignore
  assert.notEqual(net("xfmr1.S1"), net("xfmr1.S2"), "nor through the secondary"); // prettier-ignore
  assert.notEqual(net("xfmr1.P1"), net("xfmr1.S1"), "nor across");
  const r = runner(b.doc).run(0);
  // The input it feeds floats, as a 74LS input does: read HIGH, its
  // inverter's output LOW.
  assert.equal(r.result.netLevels.get(net("xfmr1.S1")), "Z");
  assert.equal(r.level(u.get(2)), "L");
});
