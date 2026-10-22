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

// Mains and the AC adapter (catalog/ac-parts.js), Spice Lite's alone: mains'
// params and fields, its badge, the sine (spice/waves.js `acGenerator`)
// through both halves, the signed values, an AC wave's crossings as edges,
// what a sine does to a logic input wired straight on — a 74LS input's
// clamp diode (spice/params.js TTL_CLAMP) or past its 7 V, a CD4000's
// protection diodes — and the warning said the moment such a wire is placed
// (model/ac-wiring.js, components/ac-wiring-monitor.js). The example
// desktops are proved in spice-ac-examples.test.js; the adapter in
// ac-adapter.test.js; the transformer in spice-transformer.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AC_DEFAULT_HZ,
  AC_SUPPLY_DEF,
  MAINS_FALLBACK,
  acBadge,
  acPeakOf,
  adapterParamsFor,
  mainsForCountry,
  mainsParamsFor,
  mainsSineOf,
} from "../catalog/ac-parts.js";
import { partDef } from "../catalog/index.js";
import { AC_PIECE_S, acGenerator, acSwing } from "../sim/spice/waves.js";
import {
  formatComponentValue,
  formatComponentValueAscii,
  parseComponentValue,
} from "../model/component-value.js";
import { acIntoLogicInputs, hasAcSource } from "../model/ac-wiring.js";
import { buildNetlist } from "../sim/netlist.js";
import { astable555, bench, runner } from "./timing-fixtures.js";
import { MIN_SHOWN_S } from "../sim/timing.js";
import { resetDom } from "./jsdom-setup.js";

const norm = (raw) => AC_SUPPLY_DEF.normalizeParams(raw);
const fieldOf = (key) => AC_SUPPLY_DEF.properties.find((f) => f.key === key);

// ── Params, presets and the badge ──────────────────────────────────────────

test("mains' params: 120 V~ at 60 Hz by default — the wall's four voltages, its two frequencies", () => {
  assert.deepEqual(norm({}), { hz: 60, rms: 120 });
  assert.deepEqual(norm({ rms: 230, hz: 50 }), { hz: 50, rms: 230 });
  assert.equal(acPeakOf(12), 16.9705627485);
  assert.equal(acPeakOf(120), 169.705627485);
  assert.deepEqual(mainsSineOf({ rms: 120 }), { hz: 60, peak: acPeakOf(120), trough: -acPeakOf(120) }); // prettier-ignore
  // A voltage or frequency the wall has not: the nearest that it has.
  assert.equal(norm({ rms: 110 }).rms, 120);
  assert.equal(norm({ hz: 1000 }).hz, 60);
  assert.equal(norm({ hz: 52 }).hz, 50);
  assert.equal(norm({ hz: "fast" }).hz, AC_DEFAULT_HZ);
  // A brick stored as its two peaks (before 2026-10-22): the nearest.
  assert.deepEqual(norm({ peak: acPeakOf(230), trough: -acPeakOf(230), hz: 50 }), { hz: 50, rms: 230 }); // prettier-ignore
  assert.equal(norm({ peak: 1, trough: -1 }).rms, 100);
  // Mains is always earthed: an isolated one from before there were
  // adapters loads earthed.
  assert.equal("neutral" in norm({ neutral: "isolated" }), false);
});

test("mains' fields: Output and Frequency, segmented, no Custom…", () => {
  const output = fieldOf("rms");
  assert.equal(output.type, "segmented");
  assert.equal(output.labelKey, "output");
  assert.deepEqual(
    output.options.map((o) => o.value),
    [100, 120, 230, 240],
  );
  assert.deepEqual(output.options.map((o) => o.label), ["100 V~", "120 V~", "230 V~", "240 V~"]); // prettier-ignore
  const frequency = fieldOf("hz");
  assert.equal(frequency.type, "segmented");
  assert.equal(frequency.labelKey, "frequency");
  assert.deepEqual(
    frequency.options.map((o) => o.value),
    [50, 60],
  );
  assert.equal(AC_SUPPLY_DEF.properties.length, 2);
});

test("mains' badge: its RMS volts and its frequency", () => {
  assert.deepEqual(acBadge({}), { volts: "120 V~", hz: "60 Hz" });
  assert.deepEqual(acBadge({ rms: 230, hz: 50 }), { volts: "230 V~", hz: "50 Hz" }); // prettier-ignore
});

/** The moment SimController ticks a desk next (`#nextEvent`): its wake,
    never sooner than MIN_SHOWN_S after the last tick — or a running AC
    wave's edge (`edgeAt`), at its own moment. */
function nextTick(result, t) {
  let at = result.wakeAt == null ? Infinity : Math.max(result.wakeAt, t + MIN_SHOWN_S); // prettier-ignore
  if (result.edgeAt != null && result.edgeAt > t) at = Math.min(at, result.edgeAt); // prettier-ignore
  return at;
}

/** Tick a desk as SimController does up to `end`, tick `end` itself, and
    hand `each(r)` every tick. */
function cadence(r, end, each = () => {}) {
  let t = 0;
  for (;;) {
    r.run(t);
    each(r);
    if (t >= end) return r;
    t = Math.min(end, nextTick(r.result, t));
  }
}

/** A 3 V~ 60 Hz adapter (S2 on the supply's −) through 1 kΩ into a 74LS14
    at e10: ±4.2 V, its trough held a diode below ground by the clamp. */
function schmittDesk() {
  const b = bench();
  const u = b.seat("u1", "74LS14", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  const r = b.seat("rs", "resistor", "a40", { ohms: 1000 });
  b.link(r.get(2), u.get(1));
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: { hz: 60, rms: 3 } }); // prettier-ignore
  b.doc.wires.push(
    { id: "wl", from: "adp1.S1", to: b.at(r.get(1).replace(/^a/, "c")), color: "red" }, // prettier-ignore
    { id: "wn", from: "adp1.S2", to: "psu1.-", color: "black" },
  );
  return { b, u };
}

test("an AC wave crossing a pin's threshold is an edge: ticked at its own moment, every flip shown", () => {
  // Held back to MIN_SHOWN_S, a fast sine's ticks all landed on one phase
  // of it and a 74LS14's output read steady (2026-10-22). Six cycles at
  // 60 Hz: every crossing a flip.
  const { b, u } = schmittDesk();
  const out = b.at(u.get(2));
  let flips = 0;
  let last = null;
  cadence(runner(b.doc, { engine: "spice" }), 0.1, (r) => {
    const level = r.result.netLevels.get(r.netlist.netOfPoint.get(out));
    if (last && level !== last) flips++;
    last = level;
  });
  assert.equal(flips, 2 * 60 * 0.1, "every crossing shown");
  // A tick's edge is the wave's next crossing, ahead of it.
  const r = runner(schmittDesk().b.doc, { engine: "spice" });
  r.run(0.001);
  assert.ok(r.result.edgeAt > 0.001 && r.result.edgeAt < 0.001 + 1 / 60, `${r.result.edgeAt}`); // prettier-ignore
  // No AC wave, no edge: a 555's crossings keep MIN_SHOWN_S.
  const timer = runner(astable555({ ra: 1e3, rb: 1e3, c: 10e-9, capRef: "cap-ceramic" }).doc, { engine: "spice" }); // prettier-ignore
  timer.run(0.001);
  assert.equal(timer.result.edgeAt, null);
  assert.ok(timer.result.wakeAt != null);
  // An AC wave nothing listens to: no edge either (its RC is closed-form).
  const rc = bench();
  rc.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: { hz: 60, rms: 3 } }); // prettier-ignore
  const r1 = rc.seat("r1", "resistor", "a10", { ohms: 1000 });
  rc.gnd(r1.get(2));
  rc.doc.wires.push(
    { id: "wl", from: "adp1.S1", to: rc.at(r1.get(1).replace(/^a/, "c")), color: "red" }, // prettier-ignore
    { id: "wn", from: "adp1.S2", to: "psu1.-", color: "black" },
  );
  const quiet = runner(rc.doc, { engine: "spice" });
  quiet.run(0.001);
  assert.equal(quiet.result.edgeAt, null);
});

test("a sine into a 74LS14 and a ÷10: every cycle counted, at SimController's cadence", () => {
  // Each crossing its own tick (`edgeAt`), and the counter counts each
  // rising one. Read half way through a cycle, its rise long past: cycle k
  // is the (k + 1)th count.
  for (const k of [6, 13, 29]) {
    const { b, u } = schmittDesk();
    const c = b.seat("u2", "74LS90", "e30");
    b.vcc(c.get(5));
    b.gnd(c.get(10));
    for (const p of [2, 3, 6, 7]) b.gnd(c.get(p));
    b.link(u.get(2), c.get(14));
    b.link(c.get(12), c.get(1));
    const r = cadence(runner(b.doc, { engine: "spice" }), (k + 0.5) / 60);
    const bit = (n) => (r.result.netLevels.get(r.netlist.netOfPoint.get(b.at(c.get(n)))) === "H" ? 1 : 0); // prettier-ignore
    const count = bit(12) + 2 * bit(9) + 4 * bit(8) + 8 * bit(11);
    assert.equal(count, (k + 1) % 10, `count after cycle ${k}`);
  }
});

test("mains for a country: North America's 120 V 60 Hz, Japan's 100 V, 230 V elsewhere", () => {
  assert.deepEqual(mainsForCountry("US"), { rms: 120, hz: 60 });
  assert.deepEqual(mainsForCountry("ca"), { rms: 120, hz: 60 });
  assert.deepEqual(mainsForCountry("JP"), { rms: 100, hz: 50 });
  assert.deepEqual(mainsForCountry("KR"), { rms: 230, hz: 60 });
  assert.deepEqual(mainsForCountry("GB"), { rms: 230, hz: 50 });
  assert.deepEqual(mainsForCountry("DE"), { rms: 230, hz: 50 });
  // Nothing said, or nonsense: North America's.
  assert.deepEqual(mainsForCountry(""), MAINS_FALLBACK);
  assert.deepEqual(mainsForCountry("USA"), MAINS_FALLBACK);
  assert.deepEqual(mainsForCountry(null), MAINS_FALLBACK);
  // A new brick's params: the country's.
  assert.deepEqual(norm(mainsParamsFor("FR")), { hz: 50, rms: 230 });
  // An adapter runs at the country's frequency.
  assert.deepEqual(adapterParamsFor("JP"), { hz: 50, rms: 12 });
  assert.deepEqual(adapterParamsFor("US"), { hz: 60, rms: 12 });
});

test("an AC supply is Spice Lite's alone: offered only there, two terminals L and N", () => {
  const def = partDef("ac");
  assert.equal(def, AC_SUPPLY_DEF);
  assert.equal(def.spiceOnly, true);
  assert.deepEqual(
    def.terminals.map((t) => t.id),
    ["L", "N"],
  );
});

// ── The sine ───────────────────────────────────────────────────────────────

test("acGenerator: a sine from its centre, rising at Run, through the negative half", () => {
  const swing = acSwing({ peak: 10, trough: -10 });
  assert.equal(swing.floor, -Infinity, "nothing clips it");
  assert.equal(swing.ceil, Infinity);
  const hz = 50;
  const at = (t) => acGenerator(swing, hz, t);
  const close = (got, want, what) =>
    assert.ok(Math.abs(got - want) < 1e-9, `${what}: ${got}, want ${want}`);
  close(at(0).value, 0, "Run");
  assert.ok(at(0).aux > 0, "on its way up");
  close(at(0.005).value, 10, "a quarter: the positive peak");
  close(at(0.01).value, 0, "a half");
  close(at(0.015).value, -10, "three quarters: the negative peak");
  close(at(0.02 + 0.0025).value, 10 * Math.SQRT1_2, "an eighth into the next cycle"); // prettier-ignore
  // In quadrature: value − mid and aux are the cosine and sine of one angle.
  const g = at(0.0137);
  close(Math.hypot(g.value - g.mid, g.aux), 10, "its amplitude");
  assert.equal(g.omega, 2 * Math.PI * hz);
  assert.equal(g.period, 1 / hz);
  // A piece runs to the next quarter second, never past it.
  assert.equal(at(0.1).end, AC_PIECE_S);
  assert.equal(at(AC_PIECE_S).end, 2 * AC_PIECE_S);
});

test("a Frequency edited mid-run carries the sine on from where it stood, at its new rate", () => {
  const b = bench();
  // A 10 V-peak adapter (S2 on the supply's −) into 1 MΩ: its own ohm or so
  // takes nothing.
  const rms = 10 / Math.SQRT2;
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: { rms, hz: 60 } }); // prettier-ignore
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 1e6 });
  b.gnd(r1.get(2));
  b.doc.wires.push(
    { id: "wn", from: "adp1.S2", to: "psu1.-", color: "black" },
    { id: "wl", from: "adp1.S1", to: b.at(`c${r1.get(1).slice(1)}`), color: "red" }, // prettier-ignore
  );
  const r = runner(b.doc, { engine: "spice" });
  const line = () => r.result.nodeVolts.get(r.netlist.netOfPoint.get(b.at(r1.get(1)))); // prettier-ignore
  const T = 0.1031;
  // (Within a millivolt: the solve's own tolerance. Without the carried
  // phase the edit jumped the line by ~0.9 V here.)
  r.run(0);
  r.run(T);
  const before = line();
  assert.ok(Math.abs(before - 10 * Math.sin(2 * Math.PI * 60 * T)) < 1e-3, `at 60 Hz: ${before}`); // prettier-ignore
  // The edit, at T: the same moment ticked again on the new Frequency.
  b.doc.components.find((c) => c.id === "adp1").params = { rms, hz: 50 };
  r.rebuild();
  r.run(T);
  assert.ok(Math.abs(line() - before) < 1e-3, `no jump: ${line()} vs ${before}`); // prettier-ignore
  // On from there at 50 Hz: half a period on, the other side; a whole, back.
  r.run(T + 1 / 100);
  assert.ok(Math.abs(line() + before) < 1e-3, `half a 50 Hz cycle on: ${line()}`); // prettier-ignore
  r.run(T + 1 / 50);
  assert.ok(Math.abs(line() - before) < 1e-3, `a whole one: ${line()}`);
});

test("acGenerator: lopsided peaks swing about their middle", () => {
  const swing = acSwing({ peak: 5, trough: -3 });
  const at = (t) => acGenerator(swing, 100, t).value;
  assert.ok(Math.abs(at(0) - 1) < 1e-9, "the middle at Run");
  assert.ok(Math.abs(at(0.0025) - 5) < 1e-9, "+5 V at a quarter");
  assert.ok(Math.abs(at(0.0075) + 3) < 1e-9, "−3 V at three quarters");
  // Peaks given the wrong way round still swing between them.
  assert.deepEqual(
    [acSwing({ peak: -3, trough: 5 }).lo, acSwing({ peak: -3, trough: 5 }).hi],
    [-3, 5],
  );
});

// ── Signed values ──────────────────────────────────────────────────────────

test("a signed value: below a range under 0 V a sign is optional; across 0 V it is as typed", () => {
  const trough = { min: -1000, max: -0.01 };
  assert.deepEqual(parseComponentValue("-5", "volt", trough), { value: -5, display: "−5V" }); // prettier-ignore
  assert.deepEqual(parseComponentValue("5", "volt", trough), { value: -5, display: "−5V" }); // prettier-ignore
  assert.equal(parseComponentValue("−3.3V", "volt", trough).value, -3.3);
  assert.equal(parseComponentValue("– 2 V", "volt", trough).value, -2);
  assert.equal(parseComponentValue("-", "volt", trough).error, "notValue");
  assert.equal(parseComponentValue("-0", "volt", trough).error, "notValue");
  assert.equal(parseComponentValue("-2000", "volt", trough).error, "range");
  // A range across zero reads an unsigned value as above it.
  const across = { min: -10, max: 10 };
  assert.equal(parseComponentValue("3", "volt", across).value, 3);
  assert.equal(parseComponentValue("-3", "volt", across).value, -3);
  // Every other field is unsigned, as it always was.
  assert.equal(parseComponentValue("-5", "volt", { min: 0.01, max: 1000 }).error, "notValue"); // prettier-ignore
  assert.equal(parseComponentValue("-5", "volt").error, "notValue");
  assert.equal(parseComponentValue("-5k", "ohm").error, "notValue");
});

test("a negative value is shown after a minus sign, and as ASCII after a hyphen", () => {
  assert.equal(formatComponentValue(-17, "volt"), "−17V");
  assert.equal(formatComponentValue(-0.0025, "volt"), "−2.5mV");
  assert.equal(formatComponentValueAscii(-17, "volt"), "-17V");
  assert.equal(formatComponentValue(0, "volt"), "");
  assert.equal(formatComponentValue(16.97, "volt"), "16.97V");
});

// ── AC on a logic input ────────────────────────────────────────────────────

/** A powered chip at e10 and an AC adapter of `rms` volts (12 V~, ±17 V,
    unless said) at 60 Hz, its S2 on the supply's −; `into(b, u)` wires its
    S1 wherever the test says. */
function acBench(ref, rms, into) {
  const b = bench();
  const u = b.seat("u1", ref, "e10");
  b.vcc(u.get(ref === "LM358" ? 8 : 14));
  b.gnd(u.get(ref === "LM358" ? 4 : 7));
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: { rms: rms ?? 12, hz: 60 } }); // prettier-ignore
  b.doc.wires.push({
    id: "wn",
    from: "adp1.S2",
    to: "psu1.-",
    color: "black",
  });
  into(b, u);
  return b;
}

/** Wire the adapter's S1 straight to a hole's node. */
const lineTo = (b, hole) =>
  b.doc.wires.push({ id: "wl", from: "adp1.S1", to: freeHole(b, hole), color: "red" }); // prettier-ignore

/** A free hole in the same column-half as `hole` (row a or j): the bench
    builder's own picks start at the top of a node, so the far end is free. */
const freeHole = (b, hole) => b.at(hole.replace(/^[a-e]/, "a").replace(/^[f-j]/, "j")); // prettier-ignore

/** Every warning a Spice Lite run of the desk raises at eighths of a 60 Hz
    cycle through its first. */
function spiceWarnings(doc) {
  const r = runner(doc, { engine: "spice" });
  const seen = [];
  for (let k = 0; k <= 8; k++) {
    for (const w of r.run(k / 480).result.warnings) seen.push({ t: k / 480, ...w }); // prettier-ignore
  }
  return seen;
}

test("12 V~ straight into a 74LS input: past 7 V on the way up, its clamp diode burning on the way down", () => {
  const b = acBench("74LS04", null, (b, u) => lineTo(b, u.get(1)));
  const seen = spiceWarnings(b.doc);
  const up = seen.filter((w) => w.type === "input-overvoltage");
  const down = seen.filter((w) => w.type === "input-clamp");
  assert.ok(up.length > 0, "over 7 V in the positive half");
  assert.ok(up.every((w) => w.t < 1 / 120 && w.smoke && w.pin === 1));
  assert.ok(
    Math.max(...up.map((w) => w.volts)) > 16.9,
    "the whole peak on the pin",
  );
  assert.ok(down.length > 0, "the clamp conducting in the negative half");
  assert.ok(down.every((w) => w.t > 1 / 120 && w.smoke && w.chip === "u1"));
  // Held a few volts below ground by the clamp: the adapter's own 1.2 Ω
  // takes the rest, at amps.
  assert.ok(Math.min(...down.map((w) => w.volts)) < -0.7);
  assert.ok(down.every((w) => w.amps > 0.05), "past the 50 mA it is taken to survive"); // prettier-ignore
  // The logic engine has no AC: there the adapter is nothing at all.
  assert.deepEqual(runner(b.doc).run(0.004).result.warnings, []);
});

test("an adapter with its S2 unwired drives nothing: no return, no current", () => {
  const b = acBench("74LS04", null, (b, u) => lineTo(b, u.get(1)));
  b.doc.wires = b.doc.wires.filter((w) => w.id !== "wn");
  assert.deepEqual(spiceWarnings(b.doc), []);
});

test("1 V~ through 22 Ω into a 74LS input: the clamp warns at its trough, and does not burn", () => {
  const b = acBench("74LS04", 1, (b, u) => {
    const r = b.seat("r1", "resistor", "a30", { ohms: 22 });
    lineTo(b, r.get(1));
    b.link(r.get(2), u.get(1));
  });
  const seen = spiceWarnings(b.doc);
  assert.ok(seen.length > 0, "a warning at the trough");
  for (const w of seen) {
    assert.equal(w.type, "input-clamp");
    assert.equal(w.smoke, false);
    assert.ok(w.amps > 0.018 && w.amps < 0.05, `18–50 mA: ${w.amps}`);
  }
});

test("a sine between the rails troubles a 74LS input not at all", () => {
  // A clock brick's 0–5 V sine, 60 Hz, straight in.
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: -20, y: 30, params: partDef("clock").normalizeParams({ hz: 60, wave: "sine" }) }); // prettier-ignore
  b.doc.wires.push(
    { id: "wv", from: "psu1.+", to: "clk1.vcc", color: "red" },
    { id: "wg", from: "psu1.-", to: "clk1.gnd", color: "black" },
    { id: "wo", from: "clk1.out", to: freeHole(b, u.get(1)), color: "yellow" }, // prettier-ignore
  );
  assert.deepEqual(spiceWarnings(b.doc), []);
});

test("12 V~ straight into a CD4000 input: its protection diodes burn on both halves", () => {
  const b = acBench("CD4069UB", null, (b, u) => lineTo(b, u.get(1)));
  const clamp = spiceWarnings(b.doc).filter((w) => w.type === "input-clamp");
  assert.ok(
    clamp.some((w) => w.volts > 5 && w.smoke),
    "above VDD",
  );
  assert.ok(
    clamp.some((w) => w.volts < 0 && w.smoke),
    "below VSS",
  );
  assert.ok(clamp.every((w) => w.max === 0.01));
});

// ── Rectified ──────────────────────────────────────────────────────────────

/** A 12 V~ adapter's ±17 V into a bridge of four discrete diodes on bb1 —
    S1 on column 1, S2 on column 7 (each wired across the trench), + at j4,
    − at a4 — and `load(b, pos, neg)` wiring what it feeds. Floating, its
    ground is S2 (sim/floating-grounds.js). */
function bridgeBench(load) {
  const b = bench();
  const diode = (id, anchor, dx) =>
    b.doc.components.push({ id, kind: "discrete", ref: "diode", board: "bb1", anchor, params: { rot: 90, end: { dx, dy: 0 } } }); // prettier-ignore
  diode("d1", "i1", 3); // L → +
  diode("d2", "h7", -3); // N → +
  diode("d3", "d4", -3); // − → L
  diode("d4", "c4", 3); // − → N
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -20, y: 30, params: { rms: 12, hz: 60 } }); // prettier-ignore
  b.doc.wires.push(
    { id: "wl", from: "adp1.S1", to: "bb1.g1", color: "red" },
    { id: "wn", from: "adp1.S2", to: "bb1.g7", color: "black" },
    { id: "wlx", from: "bb1.f1", to: "bb1.e1", color: "red" },
    { id: "wnx", from: "bb1.f7", to: "bb1.e7", color: "black" },
  );
  load(b, "bb1.j4", "bb1.a4");
  return b;
}

test("a bridge of four diodes: its + and − have voltages, |L| less two drops apart", () => {
  // Reached through diodes alone, the DC side was never HELD, so it had no
  // voltage at all; a junction that conducts now holds the net it feeds.
  const b = bridgeBench((b, pos, neg) => {
    b.doc.components.push({ id: "rl", kind: "discrete", ref: "resistor", board: "bb1", anchor: "h20", params: { ohms: 1000, rot: 90, end: { dx: 3, dy: 0 } } }); // prettier-ignore
    b.doc.wires.push(
      { id: "wp", from: pos, to: "bb1.g20", color: "red" },
      { id: "wm", from: "bb1.g23", to: neg, color: "black" },
    );
  });
  const r = runner(b.doc, { engine: "spice" });
  const volts = (at) => r.result.nodeVolts.get(r.netlist.netOfPoint.get(at));
  const peak = acPeakOf(12);
  for (const [t, sign] of [
    [1 / 240, 1],
    [3 / 240, -1],
  ]) {
    r.run(t);
    const pos = volts("bb1.j4");
    const neg = volts("bb1.a4");
    assert.ok(Number.isFinite(pos) && Number.isFinite(neg), `${t} s: + ${pos}, − ${neg}`); // prettier-ignore
    const across = pos - neg;
    assert.ok(across > peak - 2 && across < peak - 1.2, `${t} s: ${across} V across the load`); // prettier-ignore
    // Against S2: the + a drop under the peak in the positive half, a drop
    // under 0 V in the negative one.
    if (sign > 0) assert.ok(pos > peak - 1 && neg > 0 && neg < 1, `+ ${pos}, − ${neg}`); // prettier-ignore
    else assert.ok(pos < 0 && pos > -1 && neg < -(peak - 1), `+ ${pos}, − ${neg}`); // prettier-ignore
  }
});

test("a 7805 off a bridge whose − never reaches its GND floats — no runaway", () => {
  // The desk the bug was found on: OUT into 10 mF and 10 kΩ back to GND, GND
  // to nothing else. Its quiescent current with no return used to climb by
  // 5 GV every tick.
  const b = bridgeBench((b, pos) => {
    b.doc.components.push(
      { id: "g1", kind: "discrete", ref: "LM7805", board: "bb1", anchor: "h11", params: {} }, // prettier-ignore
      { id: "c1", kind: "discrete", ref: "cap-electrolytic", board: "bb1", anchor: "h16", params: { farads: 0.01, rot: 90, end: { dx: 3, dy: 0 } } }, // prettier-ignore
      { id: "rl", kind: "discrete", ref: "resistor", board: "bb1", anchor: "i16", params: { ohms: 10000, rot: 90, end: { dx: 3, dy: 0 } } }, // prettier-ignore
    );
    b.doc.wires.push(
      { id: "wi", from: pos, to: "bb1.j11", color: "red" },
      { id: "wo", from: "bb1.j13", to: "bb1.j16", color: "red" },
      { id: "wg", from: "bb1.j12", to: "bb1.j19", color: "black" },
    );
  });
  const r = runner(b.doc, { engine: "spice" });
  for (let k = 1; k <= 40; k++) {
    r.run(k / 1200);
    for (const at of ["bb1.j13", "bb1.j12"]) {
      const v = r.result.nodeVolts.get(r.netlist.netOfPoint.get(at));
      assert.ok(v == null || Math.abs(v) < 2 * acPeakOf(12), `${at} at ${k}/1200 s: ${v} V`); // prettier-ignore
    }
  }
});

// ── The wire-time warning ──────────────────────────────────────────────────

test("acIntoLogicInputs: an AC source's net holding a logic input, and only that", () => {
  const hits = (b) => acIntoLogicInputs(b.doc, buildNetlist(b.doc));
  // Straight on.
  const straight = acBench("74LS04", null, (b, u) => lineTo(b, u.get(1)));
  assert.equal(hasAcSource(straight.doc), true);
  assert.deepEqual(
    hits(straight).map(({ source, terminal, chip, pin }) => ({ source, terminal, chip, pin })), // prettier-ignore
    [{ source: "adp1", terminal: "S1", chip: "u1", pin: 1 }],
  );
  // Through a resistor: the circuit the warning asks for.
  const through = acBench("74LS04", null, (b, u) => {
    const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
    lineTo(b, r.get(1));
    b.link(r.get(2), u.get(1));
  });
  assert.deepEqual(hits(through), []);
  // An op-amp's input is an amplifier's, not a logic input's.
  const opAmp = acBench("LM358", null, (b, u) => lineTo(b, u.get(3)));
  assert.deepEqual(hits(opAmp), []);
  // S2 on the supply's − is held there, no source.
  const neutral = acBench("74LS04", null, (b, u) => {
    b.doc.wires.push({ id: "wl", from: "adp1.S2", to: freeHole(b, u.get(1)), color: "red" }); // prettier-ignore
  });
  assert.deepEqual(hits(neutral), []);
  // No AC source on the desk at all.
  const none = bench();
  none.seat("u1", "74LS04", "e10");
  assert.equal(hasAcSource(none.doc), false);
  assert.deepEqual(hits(none), []);
});

test("acIntoLogicInputs: a transformer's winding is a source, a terminal on a rail is not", () => {
  const b = acBench("74LS04", null, (b, u) => {
    b.doc.components.push({ id: "ac1", kind: "ac", ref: "ac", x: -60, y: 30, params: norm({}) }); // prettier-ignore
    b.doc.components.push({ id: "xfmr1", kind: "transformer", ref: "transformer", x: -40, y: 30, params: partDef("transformer").normalizeParams({}) }); // prettier-ignore
    b.doc.wires.push(
      { id: "wp1", from: "ac1.L", to: "xfmr1.P1", color: "red" },
      { id: "wp2", from: "ac1.N", to: "xfmr1.P2", color: "black" },
      { id: "ws1", from: "xfmr1.S1", to: freeHole(b, u.get(3)), color: "blue" }, // prettier-ignore
      { id: "ws2", from: "xfmr1.S2", to: "psu1.-", color: "black" },
    );
  });
  const hits = acIntoLogicInputs(b.doc, buildNetlist(b.doc));
  assert.deepEqual(
    hits.map(({ source, terminal, chip, pin }) => ({ source, terminal, chip, pin })), // prettier-ignore
    [{ source: "xfmr1", terminal: "S1", chip: "u1", pin: 3 }],
  );
});

test("AcWiringMonitor: a toast per new connection, none for one a loaded desk already had", async () => {
  resetDom();
  const { AcWiringMonitor } =
    await import("../components/ac-wiring-monitor.js");
  let pins = null;
  const b = acBench("74LS04", null, (b, u) => {
    pins = u;
    lineTo(b, u.get(1));
  });
  const said = [];
  const cache = { get: () => buildNetlist(b.doc) };
  new AcWiringMonitor(cache, { notify: (n) => said.push(n) }, () => b.doc, (id) => `<${id}>`); // prettier-ignore
  const fire = (type) => window.dispatchEvent(new CustomEvent(`chiphippo:${type}`)); // prettier-ignore

  // Loaded with the wire already there: baselined, not said.
  fire("desk-loaded");
  assert.equal(said.length, 0);
  fire("doc-changed");
  assert.equal(said.length, 0, "a standing connection is not news");

  // Taken away and made again: said, once.
  const wire = b.doc.wires.find((w) => w.id === "wl");
  b.doc.wires = b.doc.wires.filter((w) => w !== wire);
  fire("doc-changed");
  assert.equal(said.length, 0);
  b.doc.wires.push(wire);
  fire("doc-changed");
  assert.equal(said.length, 1);
  assert.equal(said[0].key, "ac-input:adp1:u1:1");
  assert.equal(said[0].variant, "warning");
  assert.equal(said[0].title, "AC on a logic input");
  assert.match(said[0].message, /^<adp1> is wired straight onto <u1> pin 1\./);
  fire("part-state");
  fire("doc-changed");
  assert.equal(said.length, 1, "said once while it stands");

  // A second input joined onto the same net is its own connection.
  b.link(pins.get(1), pins.get(3));
  fire("doc-changed");
  assert.deepEqual(
    said.slice(1).map((n) => n.key),
    ["ac-input:adp1:u1:3"],
  );

  // The supply gone: forgotten, so a new one is said again.
  const ac = b.doc.components.find((c) => c.id === "adp1");
  b.doc.components = b.doc.components.filter((c) => c !== ac);
  fire("doc-changed");
  b.doc.components.push(ac);
  fire("doc-changed");
  assert.equal(said.length, 4);
});

test("AcWiringMonitor: a desk switched to, or opened at launch, is baselined on its own netlist", async () => {
  resetDom();
  const { AcWiringMonitor } =
    await import("../components/ac-wiring-monitor.js");
  const empty = bench();
  const wired = acBench("74LS04", null, (b, u) => lineTo(b, u.get(1)));
  // The app's shared cache: rebuilt only at doc-changed, so at desk-loaded
  // it still holds the desk that was replaced.
  let doc = empty.doc;
  let cached = buildNetlist(doc);
  window.addEventListener("chiphippo:doc-changed", () => {
    cached = buildNetlist(doc);
  });
  const said = [];
  const fire = (type) => window.dispatchEvent(new CustomEvent(`chiphippo:${type}`)); // prettier-ignore
  new AcWiringMonitor({ get: () => cached }, { notify: (n) => said.push(n) }, () => doc); // prettier-ignore

  // A tab switch onto a desk that already has one: desk-loaded, then
  // doc-changed — neither says it.
  doc = wired.doc;
  fire("desk-loaded");
  fire("doc-changed");
  assert.equal(said.length, 0, "a switched-to desk's standing connection is not news"); // prettier-ignore
  fire("doc-changed");
  assert.equal(said.length, 0);

  // Opened at launch: no desk-loaded at all, and the first edit is quiet.
  resetDom();
  const boot = acBench("74LS04", null, (b, u) => lineTo(b, u.get(1)));
  const bootSaid = [];
  new AcWiringMonitor({ get: () => buildNetlist(boot.doc) }, { notify: (n) => bootSaid.push(n) }, () => boot.doc); // prettier-ignore
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  assert.equal(bootSaid.length, 0, "the launch desk's standing connection is not news"); // prettier-ignore
});

test("AC through a capacitor onto a CMOS input's clamp: the same answer at any tick spacing", () => {
  // A 1 V~ adapter through 1 µF onto a CD40106B input, 1 MΩ to VDD: the input's
  // clamp to VSS clips each trough, so the capacitor charges up (a DC
  // restorer) on top of the RC's own climb, and pin 2 falls when a crest
  // reaches VT+. Ticked every 100 µs it never charged (each tick took the
  // sine's motion since the tick's moment as a jump); ticked only at its
  // wakes it tripped 17 crests late (a driven ring searched past its first
  // fifty periods on a cubic grid).
  const trip = (grid) => {
    const b = bench();
    const u = b.seat("u1", "CD40106B", "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    const c = b.seat("c1", "cap-ceramic", "a40", { farads: 1e-6 });
    const r1 = b.seat("r1", "resistor", "a50", { ohms: 1e6 });
    b.link(u.get(1), c.get(2));
    b.link(u.get(1), r1.get(1));
    b.vcc(r1.get(2));
    b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -40, y: 30, params: { rms: 1, hz: 60 } }); // prettier-ignore
    b.doc.wires.push(
      { id: "wl", from: "adp1.S1", to: b.at(c.get(1)), color: "red" },
      { id: "wn", from: "adp1.S2", to: "psu1.-", color: "black" },
    );
    const r = runner(b.doc, { engine: "spice" });
    const out = r.netlist.netOfPoint.get(b.at(u.get(2)));
    let t = 0;
    while (t <= 0.45) {
      r.run(t);
      if (r.result.netLevels.get(out) === "L") return t;
      const wake = r.result.wakeAt ?? Infinity;
      t = grid ? Math.min(wake, (Math.floor(t / grid + 1e-9) + 1) * grid) : wake; // prettier-ignore
    }
    return null;
  };
  const wakes = trip(null);
  assert.ok(Math.abs(wakes - 0.1704) < 1e-3, `ticked at its wakes: ${wakes} s`);
  for (const grid of [1e-3, 1e-4]) {
    const at = trip(grid);
    assert.ok(Math.abs(at - wakes) < 1e-4, `ticked every ${grid} s: ${at} s`);
  }
});
