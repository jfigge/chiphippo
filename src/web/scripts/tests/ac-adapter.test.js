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

// Mains and the AC adapter (catalog/ac-parts.js). Mains is earthed — its N a
// ground like a PSU's − — so straight into a bridge rectifier whose − is on
// the ground rail it shorts a diode across itself every other half-cycle and
// burns it. An AC adapter — plugged into the wall, wired to nothing but its
// output — puts out an ISOLATED sine (spice/analog-devices.js "v", its sine
// on a net inside it, spice/ac-supplies.js), whose circuit floats until
// something grounds it —
// and where nothing does, sim/floating-grounds.js says where its ground is:
// the analyzer's ground lead, a − rail, a bridge's −, a regulator's GND, S2.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTER_DEF,
  ADAPTER_OUTPUTS,
  AC_CUSTOM,
  AC_SUPPLY_DEF,
  acPeakOf,
  adapterBadge,
  adapterOhms,
  adapterSineOf,
} from "../catalog/ac-parts.js";
import { partDef } from "../catalog/index.js";
import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { readVoltsAgainst } from "../model/scope-recorder.js";
import { buildNetlist } from "../sim/netlist.js";
import { conductingSides, floatingGrounds } from "../sim/floating-grounds.js";
import { acSupplies } from "../sim/spice/ac-supplies.js";
import { acGenerator, acSwing } from "../sim/spice/waves.js";
import { ENGINES } from "../sim/engines.js";
import { sampleAnalog } from "../sim/spice/sample.js";
import { resetDom } from "./jsdom-setup.js";
import { bench, runner } from "./timing-fixtures.js";

const { buildAdapterSvg } = await import("../components/adapter-view.js");

const HZ = 60;
const MAINS = AC_SUPPLY_DEF.normalizeParams({ peak: acPeakOf(120), trough: -acPeakOf(120), hz: HZ }); // prettier-ignore
const PEAK = acPeakOf(12);

/** 120 V~ 60 Hz mains, off the board. */
function addMains(b) {
  b.doc.components.push({ id: "ac1", kind: "ac", ref: "ac", x: -40, y: 30, params: MAINS }); // prettier-ignore
}

/** A 12 V~ 60 Hz adapter, off the board. */
function addAdapter(b, params = {}) {
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -40, y: 40, params: ADAPTER_DEF.normalizeParams(params) }); // prettier-ignore
}

/** A DB105 at e10 (+ e10, − e12, ~ f10 and f12), its + across 470 µF and
    1 kΩ to the − rail strip bb2 (no supply on it unless `psu`), its − on
    that strip too, fed at its ~ pins by `from` (two terminals). */
function bridgeDesk(from, { psu = false } = {}) {
  const b = bench();
  if (!psu) b.doc.components = b.doc.components.filter((c) => c.id !== "psu1");
  b.doc.boards.push({ id: "bb2", type: "rail-full", x: 0, y: -5 });
  if (psu) b.doc.wires.push({ id: "wpsu", from: "psu1.-", to: "bb2.-40", color: "black" }); // prettier-ignore
  b.seat("br1", "bridge-rectifier", "e10");
  const r = b.seat("r1", "resistor", "a30", { ohms: 1000 });
  b.link("e10", r.get(1));
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 470e-6 });
  b.link("e10", c.get(1));
  b.doc.wires.push(
    { id: "wm", from: b.at("c12"), to: "bb2.-10", color: "black" },
    { id: "wr", from: b.at(r.get(2).replace(/^a/, "c")), to: "bb2.-20", color: "black" }, // prettier-ignore
    { id: "wc", from: b.at(c.get(2).replace(/^a/, "c")), to: "bb2.-24", color: "black" }, // prettier-ignore
    { id: "wl", from: from[0], to: b.at("g10"), color: "red" },
    { id: "wn", from: from[1], to: b.at("g12"), color: "black" },
  );
  return b;
}

/** Run a desk on Spice Lite to `stop`, `steps` ticks a cycle; each tick's
    readings at the named addresses, and whatever burnt. */
function run(b, at, { stop = 0.1, steps = 48 } = {}) {
  const r = runner(b.doc, { engine: "spice" });
  const rows = [];
  for (let k = 0; k <= stop * HZ * steps; k++) {
    const t = k / (HZ * steps);
    r.run(t);
    const volts = (a) => r.result.nodeVolts?.get(r.netlist.netOfPoint.get(a));
    rows.push({ t, ...Object.fromEntries(Object.entries(at).map(([k2, a]) => [k2, volts(a)])) }); // prettier-ignore
  }
  const burnt = [...(r.result.lamps?.entries() ?? [])].filter(([, v]) => v.burnt).map(([k]) => k); // prettier-ignore
  return { rows, burnt };
}

// ── The adapter's params ───────────────────────────────────────────────────

test("an adapter's params: 12 V~ at 60 Hz by default — its output alone", () => {
  const norm = (raw) => ADAPTER_DEF.normalizeParams(raw);
  assert.deepEqual(norm({}), { hz: 60, rms: 12 });
  assert.deepEqual(norm({ hz: 50, rms: 16 }), { hz: 50, rms: 16 });
  // A frequency no mains has, an output out of range: the defaults; and the
  // rated input an adapter once had is dropped.
  assert.deepEqual(norm({ hz: 55, rms: 500, mainsRms: 230 }), { hz: 60, rms: 12 }); // prettier-ignore
  assert.equal(partDef("adapter"), ADAPTER_DEF);
  assert.equal(ADAPTER_DEF.spiceOnly, true);
  assert.deepEqual(
    ADAPTER_DEF.terminals.map((t) => t.id),
    ["S1", "S2"],
  );
  assert.deepEqual(ADAPTER_DEF.properties.map((f) => f.key), ["output", "hz"]); // prettier-ignore
});

test("an adapter's Output: presets by their RMS volts, or Custom…; its badge and its sag", () => {
  const output = ADAPTER_DEF.properties.find((f) => f.key === "output");
  assert.deepEqual(output.options.map((o) => o.value), ADAPTER_OUTPUTS.map(String)); // prettier-ignore
  assert.deepEqual(ADAPTER_OUTPUTS, [9, 12, 16, 18, 24]);
  assert.equal(output.selected({ rms: 12 }), "12");
  assert.equal(output.selected({ rms: 13.5 }), AC_CUSTOM);
  assert.deepEqual(output.pick({}, "24"), { rms: 24 });
  assert.deepEqual(output.pick({ rms: 13.5 }, AC_CUSTOM), { rms: 13.5 });
  assert.deepEqual(output.setFigure({}, "customRms", 7), { rms: 7 });
  assert.deepEqual(adapterBadge({ hz: 50, rms: 9 }), { volts: "9 V~", hz: "50 Hz" }); // prettier-ignore
  // Its Frequency: the wall's, 50 or 60 Hz, named as the mains' is.
  const frequency = ADAPTER_DEF.properties.find((f) => f.key === "hz");
  assert.equal(frequency.type, "segmented");
  assert.equal(frequency.labelKey, "frequency");
  assert.deepEqual(
    frequency.options.map((o) => o.value),
    [50, 60],
  );
  // 10 % at its rated 1 A.
  assert.equal(adapterOhms({ rms: 12 }), 1.2);
  assert.equal(adapterOhms({ rms: 24 }), 2.4);
});

test("an adapter puts out its rating's sine at its frequency", () => {
  assert.deepEqual(adapterSineOf({ rms: 12 }), { hz: 60, peak: PEAK, trough: -PEAK }); // prettier-ignore
  const out = adapterSineOf({ hz: 50, rms: 24 });
  assert.equal(out.hz, 50);
  assert.equal(out.peak, acPeakOf(24));
});

test("acSupplies: an adapter is an isolated source of its own, no mains brick needed", () => {
  const b = bench();
  addAdapter(b);
  b.doc.wires.push({ id: "ws1", from: "adp1.S1", to: b.at("a30"), color: "red" }, { id: "ws2", from: "adp1.S2", to: b.at("a33"), color: "black" }); // prettier-ignore
  const adapter = acSupplies(b.doc, buildNetlist(b.doc)).find((s) => s.id === "adp1"); // prettier-ignore
  assert.equal(adapter.isolated, true);
  assert.equal(adapter.ohms, 1.2);
  assert.deepEqual(adapter.params, { hz: 60, peak: PEAK, trough: -PEAK });
});

test("an adapter's Frequency edited mid-run carries its sine on from where it stood", () => {
  const b = bench();
  addAdapter(b);
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  b.gnd(r1.get(2));
  b.doc.wires.push(
    { id: "ws2", from: "adp1.S2", to: "psu1.-", color: "black" },
    { id: "ws1", from: "adp1.S1", to: b.at(`c${r1.get(1).slice(1)}`), color: "red" }, // prettier-ignore
  );
  const r = runner(b.doc, { engine: "spice" });
  const line = () => r.result.nodeVolts.get(r.netlist.netOfPoint.get(b.at(r1.get(1)))); // prettier-ignore
  // Behind its 1.2 Ω into 1 kΩ.
  const k = 1000 / 1001.2;
  const T = 0.1031;
  r.run(0);
  r.run(T);
  const before = line();
  assert.ok(Math.abs(before - k * PEAK * Math.sin(2 * Math.PI * 60 * T)) < 1e-3, `at 60 Hz: ${before}`); // prettier-ignore
  b.doc.components.find((c) => c.id === "adp1").params = ADAPTER_DEF.normalizeParams({ hz: 50, rms: 12 }); // prettier-ignore
  r.rebuild();
  r.run(T);
  assert.ok(Math.abs(line() - before) < 1e-3, `no jump: ${line()} vs ${before}`); // prettier-ignore
  // Half a 50 Hz cycle on, the other side.
  r.run(T + 1 / 100);
  assert.ok(Math.abs(line() + before) < 1e-3, `half a 50 Hz cycle on: ${line()}`); // prettier-ignore
});

test("the adapter brick wears its output, its frequency and the isolation mark", () => {
  resetDom();
  const svg = buildAdapterSvg({ hz: 50, rms: 16 });
  assert.equal(svg.querySelector(".part-adapter-badge").textContent, "16 V~");
  assert.equal(svg.querySelector(".part-adapter-hz").textContent, "50 Hz");
  assert.equal(svg.querySelectorAll(".part-adapter-isolated").length, 2);
  assert.equal(svg.querySelectorAll(".part-psu-terminal").length, 2);
});

// ── Running ────────────────────────────────────────────────────────────────

test("mains straight into a bridge whose − is on the ground rail: a diode across the mains, burnt", () => {
  const b = bridgeDesk(["ac1.L", "ac1.N"], { psu: true });
  addMains(b);
  const { burnt } = run(b, {}, { stop: 0.03 });
  assert.ok(
    burnt.some((k) => k.startsWith("br1#")),
    `burnt: ${burnt}`,
  );
});

test("through an adapter, the same wiring: full-wave, + a peak less two drops, S2 swinging with it", () => {
  const b = bridgeDesk(["adp1.S1", "adp1.S2"], { psu: true });
  addAdapter(b);
  const { rows, burnt } = run(b, { out: b.at("e10"), n: b.at("g12"), l: b.at("g10") }); // prettier-ignore
  assert.deepEqual(burnt, [], "nothing burns");
  const late = rows.filter((x) => x.t > 0.07);
  for (const x of late) {
    assert.ok(x.out > 13 && x.out < PEAK - 1.3, `+ at ${x.out} V`);
    // Whichever terminal is low sits a diode drop under ground.
    assert.ok(Math.min(x.l, x.n) > -1.1, `S1 ${x.l}, S2 ${x.n}`);
  }
  // S2 is no ground: it rides up a whole peak while S1 is the low side.
  assert.ok(Math.max(...late.map((x) => x.n)) > 13, "S2 rises");
});

test("an adapter whose circuit nothing grounds: read from its − rail, the reservoir a peak less two drops above it", () => {
  const b = bridgeDesk(["adp1.S1", "adp1.S2"]);
  addAdapter(b);
  const { rows, burnt } = run(b, { out: b.at("e10"), minus: b.at("c12"), s1: b.at("g10"), s2: b.at("g12") }, { stop: 0.05 }); // prettier-ignore
  assert.deepEqual(burnt, []);
  for (const x of rows)
    assert.ok(Math.abs(x.minus) < 1e-9, `− at ${x.minus} V`);
  // Once the reservoir has filled: two drops and the adapter's own sag
  // (1.2 Ω) under the peak.
  const peaks = rows.filter((x) => x.t > 0.03 && Math.abs(Math.sin(2 * Math.PI * HZ * x.t)) > 0.99); // prettier-ignore
  assert.ok(peaks.length > 2);
  for (const x of peaks) assert.ok(x.out > PEAK - 3 && x.out < PEAK - 1.3, `+ ${x.out} V at a peak`); // prettier-ignore
  // S1 − S2 is the adapter's sine, less its drop while the bridge conducts
  // (a filled reservoir's charging pulses, under an amp through 1.2 Ω).
  for (const x of rows.filter((y) => y.t > 0.03)) {
    const sine = acGenerator(acSwing({ peak: PEAK, trough: -PEAK }), HZ, x.t).value; // prettier-ignore
    assert.ok(Math.abs(x.s1 - x.s2 - sine) < 1.2, `S1 − S2 ${x.s1 - x.s2} vs ${sine}`); // prettier-ignore
  }
});

test("an adapter wired at one end puts out nothing", () => {
  const b = bridgeDesk(["adp1.S1", "adp1.S2"]);
  addAdapter(b);
  b.doc.wires = b.doc.wires.filter((w) => w.id !== "wl");
  const { rows } = run(b, { out: b.at("e10") }, { stop: 0.02 });
  for (const x of rows) assert.ok(x.out == null || Math.abs(x.out) < 1e-3, `+ at ${x.out} V`); // prettier-ignore
});

/** Jason's Regulated 5V desk as it should be built: a 12 V~ adapter → a DB105 whose − goes only to a rail strip no supply is on →
    470 µF → an LM7805 with its GND on that strip, `outCap` farads on OUT
    (or none) and 1 kΩ. */
function floatingRegulator(outCap) {
  const b = bench();
  b.doc.components = b.doc.components.filter((c) => c.id !== "psu1");
  b.doc.boards.push({ id: "bb2", type: "rail-full", x: 0, y: -5 });
  b.seat("br1", "bridge-rectifier", "e10");
  const g = b.seat("g1", "LM7805", "a30");
  b.link("e10", g.get(1));
  const c = b.seat("c1", "cap-electrolytic", "a40", { farads: 470e-6 });
  b.link("e10", c.get(1));
  const r = b.seat("r1", "resistor", "a50", { ohms: 1000 });
  b.link(g.get(3), r.get(1));
  b.doc.wires.push(
    { id: "wm", from: b.at("c12"), to: "bb2.-10", color: "black" },
    { id: "wg", from: b.at("c31"), to: "bb2.-12", color: "black" },
    { id: "wc", from: b.at(c.get(2).replace(/^a/, "c")), to: "bb2.-14", color: "black" }, // prettier-ignore
    { id: "wr", from: b.at(r.get(2).replace(/^a/, "c")), to: "bb2.-16", color: "black" }, // prettier-ignore
    { id: "wl", from: "adp1.S1", to: b.at("g10"), color: "red" },
    { id: "wn", from: "adp1.S2", to: b.at("g12"), color: "black" },
  );
  if (outCap) {
    const o = b.seat("c2", "cap-ceramic", "a60", { farads: outCap });
    b.link(g.get(3), o.get(1));
    b.doc.wires.push({ id: "wo", from: b.at(o.get(2).replace(/^a/, "c")), to: "bb2.-18", color: "black" }); // prettier-ignore
  }
  addAdapter(b);
  return { b, out: b.at(g.get(3)) };
}

test("a regulator off an adapter's bridge: 5 V on OUT against its ground rail, flat, never hot", () => {
  for (const outCap of [100e-9, null]) {
    const { b, out } = floatingRegulator(outCap);
    const r = runner(b.doc, { engine: "spice" });
    let t = 0;
    const hot = [];
    const outs = [];
    while (t <= 0.2) {
      r.run(t);
      for (const w of r.result.warnings) if (w.type === "regulator-hot") hot.push(t); // prettier-ignore
      if (t > 0.1) outs.push(r.result.nodeVolts.get(r.netlist.netOfPoint.get(out))); // prettier-ignore
      t = Math.max(r.result.wakeAt ?? Infinity, t + 1e-6);
      if (!Number.isFinite(t)) break;
    }
    assert.deepEqual(hot, [], `hot at ${hot}`);
    assert.ok(outs.length > 10);
    // Read from the ground rail, as a meter's black lead on it reads it.
    for (const v of outs) assert.ok(Math.abs(v - 5) < 0.01, `OUT ${v} V`);
  }
});

// ── Where a floating circuit's ground is ───────────────────────────────────

test("floatingGrounds: the lead, else a − rail, else a bridge's −, else a regulator's GND, else S2", () => {
  const grounds = (doc) => floatingGrounds(doc, buildNetlist(doc));
  const netOf = (doc, a) => buildNetlist(doc).netOfPoint.get(a);
  // The regulator desk: its − rail.
  const { b } = floatingRegulator(null);
  assert.equal(grounds(b.doc).get("adp1"), netOf(b.doc, "bb2.-10"));
  // The ground lead on the reservoir's +: there.
  const led = structuredClone(b.doc);
  led.scopeGround = b.at("e10");
  assert.equal(grounds(led).get("adp1"), netOf(led, b.at("e10")));
  // No rail strip: the bridge's −.
  const bare = structuredClone(b.doc);
  bare.boards = bare.boards.filter((x) => x.id !== "bb2");
  bare.wires = bare.wires.filter((w) => !w.to.startsWith("bb2."));
  bare.wires.push({ id: "wj", from: b.at("b12"), to: b.at("b31"), color: "black" }); // prettier-ignore
  assert.equal(grounds(bare).get("adp1"), netOf(bare, b.at("c12")));
  // A PSU's − anywhere on the island: the island is that supply's, left alone.
  const fed = structuredClone(b.doc);
  fed.components.push({ id: "psu1", kind: "psu", ref: "psu", x: 0, y: 30, params: { volts: 5 } }); // prettier-ignore
  fed.wires.push({ id: "wp", from: "psu1.-", to: "bb2.-40", color: "black" });
  assert.equal(grounds(fed).size, 0);
  // Nothing at all on its output: S2.
  const lone = bench();
  addAdapter(lone);
  lone.doc.wires.push({ id: "ws1", from: "adp1.S1", to: lone.at("a30"), color: "red" }, { id: "ws2", from: "adp1.S2", to: lone.at("a33"), color: "black" }); // prettier-ignore
  assert.equal(grounds(lone.doc).get("adp1"), netOf(lone.doc, "adp1.S2"));
});

test("conductingSides: a capacitor, a transformer, an opto and a relay keep their sides apart", () => {
  assert.deepEqual(conductingSides(partDef("cap-ceramic"), ["1", "2"]), [["1"], ["2"]]); // prettier-ignore
  assert.deepEqual(conductingSides(partDef("transformer"), ["P1", "P2", "S1", "S2"]), [["P1", "P2"], ["S1", "S2"]]); // prettier-ignore
  assert.deepEqual(conductingSides(partDef("adapter"), ["S1", "S2"]), [["S1", "S2"]]); // prettier-ignore
  assert.deepEqual(conductingSides(partDef("PC817"), ["1", "2", "3", "4"]), [["1", "2"], ["3", "4"]]); // prettier-ignore
  assert.deepEqual(conductingSides(partDef("relay"), ["1", "2", "3", "4", "5"]), [["1", "2"], ["3", "4", "5"]]); // prettier-ignore
  assert.deepEqual(conductingSides(partDef("resistor"), ["1", "2"]), [["1", "2"]]); // prettier-ignore
});

test("a display frame reads an analyzer net that is no node as the nodes make it, not held at the last tick", () => {
  // An adapter's S1 is no node (its sine runs on a net inside it): a frame
  // between two ticks read it at the last tick's value, and the analyzer's
  // lane went flat between ticks (2026-10-22). Stated in the nodes
  // (`statements`), a frame reads it where a tick at that moment would.
  const b = bench();
  addAdapter(b);
  const r1 = b.seat("r1", "resistor", "a10", { ohms: 1000 });
  const c1 = b.seat("c1", "cap-ceramic", "a20", { farads: 100e-9 });
  b.link(r1.get(2), c1.get(1));
  b.gnd(c1.get(2));
  b.doc.wires.push(
    { id: "ws1", from: "adp1.S1", to: b.at(r1.get(1).replace(/^a/, "c")), color: "red" }, // prettier-ignore
    { id: "ws2", from: "adp1.S2", to: "psu1.-", color: "black" },
  );
  const netlist = buildNetlist(b.doc, new Map(), { inductors: "branch" });
  const s1 = netlist.netOfPoint.get("adp1.S1");
  const tick = (now, prev, frameNets) =>
    ENGINES.spice.tick({ document: b.doc, netlist, warmStart: prev?.netLevels ?? new Map(), state: prev?.state ?? new Map(), prevPinLevels: prev?.pinLevels ?? new Map(), signalLevels: new Map(), now, spice: { config: { enabled: true }, analog: prev?.analog ?? null, waveFrames: true, frameNets } }); // prettier-ignore
  // (Just past a zero crossing, where the sine moves fastest: 0.62 of a
  // cycle.)
  const T = 0.0104;
  const at = tick(T, tick(0, null, new Set([s1])), new Set([s1]));
  assert.ok(at.analog.statements?.has(s1), "S1 stated in the nodes");
  for (const dt of [0.0005, 0.001, 0.002]) {
    const frame = sampleAnalog(at.analog, T + dt).volts.get(s1);
    const truth = tick(T + dt, at).nodeVolts.get(s1);
    assert.ok(Math.abs(frame - truth) < 1e-3, `+${dt} s: frame ${frame} V, tick ${truth} V`); // prettier-ignore
    assert.ok(Math.abs(frame - at.nodeVolts.get(s1)) > 0.1, "and it moved");
  }
  // Nothing recorded: nothing stated.
  assert.equal(tick(T, tick(0, null)).analog.statements, null);
});

test("the analyzer's ground lead: lanes read against it, and a floating circuit is grounded there", () => {
  // The recorder's arithmetic.
  const netlist = { netOfPoint: new Map([["a", "n1"], ["g", "n2"], ["x", "n3"]]) }; // prettier-ignore
  const detail = {
    netlist,
    nodeVolts: new Map([
      ["n1", 7],
      ["n2", 2],
    ]),
  };
  assert.equal(readVoltsAgainst("a", null, detail), 7);
  assert.equal(readVoltsAgainst("a", "g", detail), 5);
  // A lead on a net with no voltage reads as 0 V.
  assert.equal(readVoltsAgainst("a", "x", detail), 7);
  assert.equal(readVoltsAgainst("x", "g", detail), null);
  // On the regulator desk, the lead on OUT puts 0 V there and the rail at −5.
  const { b, out } = floatingRegulator(100e-9);
  b.doc.scopeGround = out;
  const r = runner(b.doc, { engine: "spice" });
  let t = 0;
  while (t <= 0.15) {
    r.run(t);
    t = Math.max(r.result.wakeAt ?? Infinity, t + 1e-6);
    if (!Number.isFinite(t)) break;
  }
  const volts = (a) => r.result.nodeVolts.get(r.netlist.netOfPoint.get(a));
  assert.ok(Math.abs(volts(out)) < 1e-9, `OUT ${volts(out)} V`);
  assert.ok(Math.abs(volts("bb2.-10") + 5) < 0.01, `rail ${volts("bb2.-10")} V`); // prettier-ignore
});

test("the document keeps the ground lead and the adapter's ids", () => {
  const doc = new DeskDoc();
  assert.equal(doc.scopeGround, null);
  assert.equal(doc.setScopeGround("bb1.a1"), true);
  assert.equal(doc.setScopeGround("bb1.a1"), false);
  assert.equal(doc.toJSON().scopeGround, "bb1.a1");
  assert.throws(() => doc.setScopeGround("nonsense"), /not an address/);
  assert.equal(doc.setScopeGround(null), true);
  assert.equal("scopeGround" in doc.toJSON(), false);
  // Loaded: kept when it parses, dropped when it does not.
  assert.equal(normalizeDocument({ scopeGround: "psu1.-" }).scopeGround, "psu1.-"); // prettier-ignore
  assert.equal("scopeGround" in normalizeDocument({ scopeGround: 7 }), false);
  // An adapter is adp<n>, its counter stored once one is placed.
  assert.equal(doc.toJSON().nextAdapterId, undefined);
  const a = doc.addBrick("adapter", 40, 40, {});
  assert.equal(a.id, "adp1");
  assert.deepEqual(a.params, { hz: 60, rms: 12 });
  assert.equal(doc.toJSON().nextAdapterId, 2);
  assert.equal(normalizeDocument(doc.toJSON()).nextAdapterId, 2);
});
