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

// The AC supply (catalog/ac-parts.js), Spice Lite's alone: its params and
// presets, its badge, its sine (spice/waves.js `acGenerator`) through both
// halves, the signed values its negative peak is typed in, what it does to a
// logic input wired straight on — a 74LS input's clamp diode (spice/params.js
// TTL_CLAMP) or past its 7 V, a CD4000's protection diodes — and the warning
// said the moment such a wire is placed (model/ac-wiring.js,
// components/ac-wiring-monitor.js). The four example desktops are proved in
// spice-ac-examples.test.js; the transformer in spice-transformer.test.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  AC_CUSTOM,
  AC_DEFAULT_HZ,
  AC_HZ_RANGE,
  AC_SUPPLY_DEF,
  acBadge,
  acPeakOf,
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
import { bench, runner } from "./timing-fixtures.js";
import { resetDom } from "./jsdom-setup.js";

const norm = (raw) => AC_SUPPLY_DEF.normalizeParams(raw);
const fieldOf = (key) => AC_SUPPLY_DEF.properties.find((f) => f.key === key);

// ── Params, presets and the badge ──────────────────────────────────────────

test("an AC supply's params: 12 V~ at 60 Hz by default, its peaks √2 times the RMS", () => {
  assert.deepEqual(norm({}), { hz: 60, peak: acPeakOf(12), trough: -acPeakOf(12) }); // prettier-ignore
  assert.equal(acPeakOf(12), 16.9705627485);
  assert.equal(acPeakOf(120), 169.705627485);
  // A peak outside its range — or on the wrong side of 0 V — is the default's.
  assert.equal(norm({ peak: -3 }).peak, acPeakOf(12));
  assert.equal(norm({ trough: 3 }).trough, -acPeakOf(12));
  assert.equal(norm({ peak: 2000 }).peak, acPeakOf(12));
  // Custom peaks are kept as they are, lopsided or not.
  assert.deepEqual(norm({ peak: 5, trough: -0.7, hz: 50 }), { hz: 50, peak: 5, trough: -0.7 }); // prettier-ignore
  // A frequency is held to the clock's range; one that is no number is 60.
  assert.equal(norm({ hz: 1e9 }).hz, AC_HZ_RANGE.max);
  assert.equal(norm({ hz: 0 }).hz, AC_HZ_RANGE.min);
  assert.equal(norm({ hz: "fast" }).hz, AC_DEFAULT_HZ);
});

test("an AC supply's Output: four presets by their RMS volts, or Custom… and its two peaks", () => {
  const output = fieldOf("output");
  assert.deepEqual(output.options.map((o) => o.label), ["12 V~", "24 V~", "120 V~", "230 V~"]); // prettier-ignore
  assert.equal(output.selected(norm({})), "12");
  assert.equal(output.selected(norm({ peak: 5, trough: -5 })), AC_CUSTOM);
  assert.deepEqual(output.pick({}, "230"), { peak: acPeakOf(230), trough: -acPeakOf(230) }); // prettier-ignore
  // Custom… opens on the peaks the supply already has.
  assert.deepEqual(output.pick(norm({ peak: 5, trough: -3 }), AC_CUSTOM), { peak: 5, trough: -3 }); // prettier-ignore
  assert.deepEqual(output.setFigure({}, "trough", -2), { trough: -2 });
  const frequency = fieldOf("frequency");
  assert.equal(frequency.selected({ hz: 50 }), 50);
  assert.equal(frequency.selected({ hz: 400 }), AC_CUSTOM);
  assert.deepEqual(frequency.pick({ hz: 400 }, AC_CUSTOM), { hz: 400 });
  assert.deepEqual(frequency.pick({}, "50"), { hz: 50 });
});

test("an AC supply's badge: a preset by its RMS, any other pair by its peaks", () => {
  assert.deepEqual(acBadge({}), { volts: "12 V~", hz: "60 Hz" });
  assert.deepEqual(acBadge({ peak: acPeakOf(230), trough: -acPeakOf(230), hz: 50 }), { volts: "230 V~", hz: "50 Hz" }); // prettier-ignore
  assert.equal(acBadge({ peak: 1, trough: -1 }).volts, "±1 V~");
  assert.equal(acBadge({ peak: 5, trough: -3 }).volts, "+5/−3 V~");
  assert.equal(acBadge({ hz: 1234.5 }).hz, "1230 Hz");
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
  b.doc.components.push({ id: "ac1", kind: "ac", ref: "ac", x: -20, y: 30, params: norm({ peak: 10, trough: -10, hz: 60 }) }); // prettier-ignore
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 10000 });
  b.gnd(r1.get(2));
  b.doc.wires.push(
    { id: "wn", from: "ac1.N", to: "psu1.-", color: "black" },
    { id: "wl", from: "ac1.L", to: b.at(`c${r1.get(1).slice(1)}`), color: "red" }, // prettier-ignore
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
  b.doc.components.find((c) => c.id === "ac1").params = norm({ peak: 10, trough: -10, hz: 50 }); // prettier-ignore
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

test("a negative peak is typed with a minus sign — or without, since it can only be below 0 V", () => {
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

/** A powered chip at e10 and an AC supply of `params`, its N on the
    supply's −; `into(b, u)` wires its L wherever the test says. */
function acBench(ref, params, into) {
  const b = bench();
  const u = b.seat("u1", ref, "e10");
  b.vcc(u.get(ref === "LM358" ? 8 : 14));
  b.gnd(u.get(ref === "LM358" ? 4 : 7));
  b.doc.components.push({ id: "ac1", kind: "ac", ref: "ac", x: -20, y: 30, params: norm(params) }); // prettier-ignore
  b.doc.wires.push({ id: "wn", from: "ac1.N", to: "psu1.-", color: "black" });
  into(b, u);
  return b;
}

/** Wire the AC supply's L straight to a hole's node. */
const lineTo = (b, hole) =>
  b.doc.wires.push({ id: "wl", from: "ac1.L", to: freeHole(b, hole), color: "red" }); // prettier-ignore

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
  const b = acBench("74LS04", {}, (b, u) => lineTo(b, u.get(1)));
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
  assert.ok(Math.min(...down.map((w) => w.volts)) < -16.9);
  assert.ok(down.every((w) => w.amps > 0.05), "past the 50 mA it is taken to survive"); // prettier-ignore
  // The logic engine has no AC: there the supply is nothing at all.
  assert.deepEqual(runner(b.doc).run(0.004).result.warnings, []);
});

test("an AC supply with its N unwired drives nothing: no return, no current", () => {
  const b = acBench("74LS04", {}, (b, u) => lineTo(b, u.get(1)));
  b.doc.wires = b.doc.wires.filter((w) => w.id !== "wn");
  assert.deepEqual(spiceWarnings(b.doc), []);
});

test("±1 V~ into a 74LS input: the clamp warns at its trough, and does not burn", () => {
  const b = acBench("74LS04", { peak: 1, trough: -1 }, (b, u) => lineTo(b, u.get(1))); // prettier-ignore
  const seen = spiceWarnings(b.doc);
  assert.ok(seen.length > 0, "a warning at the trough");
  for (const w of seen) {
    assert.equal(w.type, "input-clamp");
    assert.equal(w.smoke, false);
    assert.ok(w.amps > 0.018 && w.amps < 0.05, `18–50 mA: ${w.amps}`);
  }
});

test("a sine that stays above −0.3 V and under 5 V troubles a 74LS input not at all", () => {
  const b = acBench("74LS04", { peak: 5, trough: -0.3 }, (b, u) => lineTo(b, u.get(1))); // prettier-ignore
  assert.deepEqual(spiceWarnings(b.doc), []);
});

test("12 V~ straight into a CD4000 input: its protection diodes burn on both halves", () => {
  const b = acBench("CD4069UB", {}, (b, u) => lineTo(b, u.get(1)));
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

// ── The wire-time warning ──────────────────────────────────────────────────

test("acIntoLogicInputs: an AC source's net holding a logic input, and only that", () => {
  const hits = (b) => acIntoLogicInputs(b.doc, buildNetlist(b.doc));
  // Straight on.
  const straight = acBench("74LS04", {}, (b, u) => lineTo(b, u.get(1)));
  assert.equal(hasAcSource(straight.doc), true);
  assert.deepEqual(
    hits(straight).map(({ source, terminal, chip, pin }) => ({ source, terminal, chip, pin })), // prettier-ignore
    [{ source: "ac1", terminal: "L", chip: "u1", pin: 1 }],
  );
  // Through a resistor: the circuit the warning asks for.
  const through = acBench("74LS04", {}, (b, u) => {
    const r = b.seat("r1", "resistor", "a30", { ohms: 10e3 });
    lineTo(b, r.get(1));
    b.link(r.get(2), u.get(1));
  });
  assert.deepEqual(hits(through), []);
  // An op-amp's input is an amplifier's, not a logic input's.
  const opAmp = acBench("LM358", {}, (b, u) => lineTo(b, u.get(3)));
  assert.deepEqual(hits(opAmp), []);
  // N is a ground, no source.
  const neutral = acBench("74LS04", {}, (b, u) => {
    b.doc.wires.push({ id: "wl", from: "ac1.N", to: freeHole(b, u.get(1)), color: "red" }); // prettier-ignore
  });
  assert.deepEqual(hits(neutral), []);
  // No AC source on the desk at all.
  const none = bench();
  none.seat("u1", "74LS04", "e10");
  assert.equal(hasAcSource(none.doc), false);
  assert.deepEqual(hits(none), []);
});

test("acIntoLogicInputs: a transformer's winding is a source, a terminal on a rail is not", () => {
  const b = acBench("74LS04", {}, (b, u) => {
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
  const b = acBench("74LS04", {}, (b, u) => {
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
  assert.equal(said[0].key, "ac-input:ac1:u1:1");
  assert.equal(said[0].variant, "warning");
  assert.equal(said[0].title, "AC on a logic input");
  assert.match(said[0].message, /^<ac1> is wired straight onto <u1> pin 1\./);
  fire("part-state");
  fire("doc-changed");
  assert.equal(said.length, 1, "said once while it stands");

  // A second input joined onto the same net is its own connection.
  b.link(pins.get(1), pins.get(3));
  fire("doc-changed");
  assert.deepEqual(
    said.slice(1).map((n) => n.key),
    ["ac-input:ac1:u1:3"],
  );

  // The supply gone: forgotten, so a new one is said again.
  const ac = b.doc.components.find((c) => c.id === "ac1");
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
  const wired = acBench("74LS04", {}, (b, u) => lineTo(b, u.get(1)));
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
  const boot = acBench("74LS04", {}, (b, u) => lineTo(b, u.get(1)));
  const bootSaid = [];
  new AcWiringMonitor({ get: () => buildNetlist(boot.doc) }, { notify: (n) => bootSaid.push(n) }, () => boot.doc); // prettier-ignore
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  assert.equal(bootSaid.length, 0, "the launch desk's standing connection is not news"); // prettier-ignore
});
