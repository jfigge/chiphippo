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

// engine-incremental.test.js — the incremental settle's oracle
// (features/done/event-driven-simulation.md).
//
// The incremental settle re-evaluates only the chips whose inputs changed
// and re-resolves only the nets whose drivers did — and must give EXACTLY
// what the full-pass loop gives: every result field, every tick, the order
// of the warnings and of the level maps' keys, the number of passes, what
// the chip debugger's recorder hears, and (under Spice Lite) every analog
// field its hooks feed. Each desk below runs through both modes side by side
// (incremental-fixtures.js `compareRuns`); the targeted ones exist to reach
// each of the incremental path's fallbacks and couplings.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { H, L } from "../sim/levels.js";
import { exampleDesktops } from "../model/example-desktops.js";
import { newCustomChip } from "../model/custom-chip.js";
import { partDef, setCustomChips } from "../catalog/index.js";
import { busyDocument } from "../bench/busy-circuit.js";
import { bench } from "./timing-fixtures.js";
import { buildNetlist } from "../sim/netlist.js";
import { prepareCircuit, tick, tieMemo } from "../sim/engine.js";
import { lampBrightness, lampJunctions } from "../sim/lamp-average.js";
import {
  STEP_S,
  bareLeds,
  bareSwitch,
  compiledMixedDesk,
  compareRuns,
  diodeChain,
  dividerChain,
  floatingMux,
  flopFight,
  railCathode,
  foughtAnode,
  inverterRing,
  loadComputer,
  loadedSupply,
  longSupplyWire,
  mixedFamilies,
  drivenLamp,
  powered,
  projectDesktops,
  railLamp,
  railMosfet,
  relaxation,
  resistorChain,
  ringAndFlop,
  rippleCounter,
  sharedRcNode,
  switchedFight,
  triStateBus,
} from "./incremental-fixtures.js";

const DEMOS = fileURLToPath(new URL("../../demos/", import.meta.url));

/** Every desktop of every shipped example, labelled. */
function examples() {
  const out = [];
  for (const file of readdirSync(DEMOS).filter((f) => f.endsWith(".json"))) {
    const payload = JSON.parse(readFileSync(DEMOS + file, "utf8"));
    for (const d of exampleDesktops(file.replace(/\.json$/, ""), payload)) {
      out.push(d);
    }
  }
  return out;
}

/** A signal stimulus: `levels(i)` → signal id → level (absent: Z). */
const signals = (levels) => (i) => ({
  clockPhase: new Map(),
  signalLevels: new Map(Object.entries(levels(i))),
  now: i * STEP_S,
});

// ── Whole desks ─────────────────────────────────────────────────────────────

test("the busy fixture, 3 and 8 slices: identical tick for tick", () => {
  for (const slices of [3, 8]) {
    const { stats } = compareRuns(`busy ${slices}`, busyDocument(slices), {
      ticks: 100,
      bothContexts: slices === 3,
    });
    // …and it really is incremental: one cold pass a tick, the rest cheap.
    assert.ok(stats.incrementalPasses > stats.coldPasses, JSON.stringify(stats)); // prettier-ignore
    assert.ok(!stats.scopedReadings && !stats.uncertainReadings);
  }
});

test("every shipped example: identical tick for tick", () => {
  const all = examples();
  assert.ok(all.length > 50, `found ${all.length} example desktops`);
  for (const { name, doc } of all) {
    compareRuns(name, doc, { ticks: 16, bothContexts: true });
  }
});

test("the breadboard computers, with their ROMs: identical tick for tick", () => {
  const computers = [
    ["65xx-blink", {}],
    ["65xx-lcd", {}],
    ["eater-core", { romRef: "AT28C256", romSize: 32768, ram: { ref: "HM62256", size: 32768 } }], // prettier-ignore
    ["eater-io", { romRef: "AT28C256", romSize: 32768, ram: { ref: "HM62256", size: 32768 } }], // prettier-ignore
  ];
  for (const [base, opts] of computers) {
    const { doc, images } = loadComputer(base, opts);
    compareRuns(base, doc, { ticks: 40, images });
  }
});

test("the hand-built NE555 project, every desktop: identical tick for tick", () => {
  for (const { name, doc } of projectDesktops("ne555.chiphippo")) {
    compareRuns(`NE555 ${name}`, doc, { ticks: 40 });
  }
});

// ── Targeted: the couplings and the fallbacks ──────────────────────────────

test("a CD4051B with a floating select bit (channels read every way)", () => {
  const { stats } = compareRuns("floating mux", floatingMux(), { ticks: 12 });
  assert.ok(stats.scopedReadings > 0, "the readings were taken");
  // …on the switch's own components: no pass fell back to the whole desk.
  assert.ok(stats.incrementalPasses + stats.coldPasses >= stats.passes, JSON.stringify(stats)); // prettier-ignore
});

test("a bare powered CD4066B: sixteen readings, read on its channels alone", () => {
  const doc = bareSwitch();
  const { stats } = compareRuns("bare switch", doc, { ticks: 12, bothContexts: true }); // prettier-ignore
  assert.ok(stats.scopedReadings > 0, "the readings were taken");
  // Sixteen whole-desk readings a pass was 16 × every net (the 2026-10-26
  // review: a busy desk 0.27 → 10.7 ms a tick); read on the channels'
  // components, each component's two distinct readings, a pass resolves
  // fewer nets than the desk has.
  const nets = buildNetlist(doc).nets.size;
  assert.ok(stats.resolutions / stats.passes < nets, `${stats.resolutions / stats.passes} resolutions a pass, ${nets} nets`); // prettier-ignore
});

test("diodes: a chain, and an anode two outputs fight over", () => {
  compareRuns("diode chain", diodeChain(), { ticks: 12 });
  const { stats } = compareRuns("fought anode", foughtAnode(), {
    ticks: 8,
    stimulus: signals((i) => (i % 4 < 2 ? { s1: L, s2: H } : { s1: H, s2: H })),
  });
  assert.ok(stats.uncertainReadings > 0, "the uncertain reading was taken");
  // …on its own components: no pass of it fell back to the whole desk.
  assert.ok(stats.incrementalPasses + stats.coldPasses >= stats.passes, JSON.stringify(stats)); // prettier-ignore
});

test("a diode into the + rail: the rail is no LOW cathode, in either mode", () => {
  const { doc, anode } = railCathode();
  const net = buildNetlist(doc).netOfPoint.get(anode);
  compareRuns("rail cathode", doc, {
    ticks: 8,
    stimulus: signals((i) => ({ s: i % 2 ? L : H })),
    // The 74LS04's LOW onto the rail is a fight the rail wins; the anode,
    // a TTL input alone, floats whatever that output does.
    check: (i, r) => assert.equal(r.netLevels.get(net), "Z", `tick ${i}`),
  });
});

test("an uncertain settle, then a re-solve that ends the fight", () => {
  const { stats } = compareRuns("flop fight", flopFight(), {
    ticks: 12,
    stimulus: signals((i) => ({ clk: i % 2 ? H : L, s2: L })),
  });
  assert.ok(stats.uncertainReadings > 0 && stats.solves > 12, JSON.stringify(stats)); // prettier-ignore
});

test("resistor chains: one that converges, one that never does", () => {
  compareRuns("resistor chain", resistorChain(), { ticks: 12 });
  compareRuns("divider chain", dividerChain(), { ticks: 4 });
});

test("a ring of inverters oscillates — and its strong map IS its level map", () => {
  let oscillated = false;
  const { stats } = compareRuns("inverter ring", inverterRing(), {
    ticks: 3,
    check: (_, r) => {
      oscillated ||= r.warnings.some((w) => w.type === "oscillation");
    },
  });
  assert.ok(oscillated, "the ring is reported oscillating");
  assert.ok(stats.cappedSolves > 0, "a solve ran to its cap");
});

test("a ripple counter re-solves within the tick, its work carried", () => {
  const { stats } = compareRuns("ripple counter", rippleCounter(), {
    ticks: 12,
    stimulus: signals((i) => ({ clk: i % 2 ? H : L })),
  });
  assert.ok(stats.solves > 12, `re-solved within a tick: ${stats.solves}`);
});

test("outputs straight onto LEDs: the LED rule's own resolution", () => {
  compareRuns("bare LEDs", bareLeds(), { ticks: 8 });
});

test("a MOSFET across the rails: a transistor short, then a held gate", () => {
  compareRuns("rail MOSFET", railMosfet(), {
    ticks: 9,
    stimulus: signals((i) => [{ g: L }, { g: H }, {}][i % 3]),
  });
});

test("a tri-state bus: one driver, none, both — and a bench lead on it", () => {
  compareRuns("tri-state bus", triStateBus(), {
    ticks: 16,
    stimulus: signals((i) => ({
      ...[
        { g1: L, g2: H },
        { g1: H, g2: H },
        { g1: H, g2: L },
        { g1: L, g2: L },
      ][i % 4],
      ...(i >= 8 ? { bus: i % 2 ? H : L } : {}),
    })),
  });
});

test("a fight across a switch, and one on a pulled-up net", () => {
  const seen = new Set();
  compareRuns("switched fight", switchedFight(), {
    ticks: 16,
    stimulus: signals((i) => ({ ctl: i % 2 ? H : L, oe: i % 4 < 2 ? H : L })),
    check: (_, r) => {
      for (const w of r.warnings) seen.add(w.type);
    },
  });
  assert.ok(seen.has("conflict"), [...seen].join());
});

test("a capped settle, then a re-solve in the same tick", () => {
  let capped = 0;
  const { stats } = compareRuns("ring and flop", ringAndFlop(), {
    ticks: 8,
    stimulus: signals((i) => ({ en: i % 2 ? H : L })),
    check: (_, r) => {
      if (r.warnings.some((w) => w.type === "oscillation")) capped++;
    },
  });
  assert.ok(capped >= 3, `the ring oscillates on each edge: ${capped}`);
  assert.ok(stats.solves > 8 && stats.cappedSolves >= 3, JSON.stringify(stats)); // prettier-ignore
});

test("a custom chip under the debugger's observer: the same record", () => {
  const chip = {
    ...newCustomChip([]),
    code: "reg q = 0;\nalways @(posedge A) q <= ~q;\nassign Y = q ^ B;\n",
  };
  setCustomChips([chip]);
  try {
    const b = bench();
    const u = b.seat("c1", chip.id, "e10");
    b.vcc(u.get(14));
    b.gnd(u.get(7));
    const inv = powered(b, "u2", "74LS04", "e30");
    b.signal("a", u.get(1), "low");
    b.signal("b", u.get(2), "low");
    b.link(u.get(3), inv.get(1));
    b.link(inv.get(2), inv.get(3));
    compareRuns("custom chip", b.doc, {
      ticks: 12,
      watch: new Set(["c1"]),
      stimulus: signals((i) => ({ a: i % 2 ? H : L, b: i % 6 < 3 ? L : H })),
    });
  } finally {
    setCustomChips([]);
  }
});

// ── Spice Lite ─────────────────────────────────────────────────────────────

const spiceRun = (label, doc, opts = {}) =>
  compareRuns(`Spice Lite: ${label}`, doc, { engine: "spice", ...opts });

test("Spice Lite, every shipped example: identical tick for tick", () => {
  for (const { name, doc } of examples()) spiceRun(name, doc, { ticks: 16 });
});

test("Spice Lite: a wave's island paused beside one with corners — told what it was last solved at", () => {
  // Mains on a ground of its own into 14.4 kΩ, and an AC adapter's 12 V~
  // (its S2 on the PSU's −) through 10 kΩ and a diode: two supply groups, so a tick for the diode's
  // corners pauses the mains' island. Its node was told where a PASS last
  // solved it, though a resolve had solved it since — the carried settle took
  // that for no change, the full one solved it again (2026-10-21).
  const b = bench();
  const mains = { hz: 60, rms: 120 };
  const low = { hz: 60, rms: 12 };
  b.doc.components.push({ id: "ac1", kind: "ac", ref: "ac", x: -40, y: 30, params: mains }); // prettier-ignore
  const r0 = b.seat("r0", "resistor", "a5", { ohms: 14400 });
  b.doc.wires.push(
    { id: "wl", from: "ac1.L", to: b.at(r0.get(1).replace(/^a/, "c")), color: "red" }, // prettier-ignore
    { id: "wn", from: "ac1.N", to: b.at(r0.get(2).replace(/^a/, "c")), color: "black" }, // prettier-ignore
  );
  const r = b.seat("r1", "resistor", "a30", { ohms: 10000 });
  const d = b.seat("d1", "diode", "a40", {});
  b.link(r.get(2), d.get(2));
  b.gnd(d.get(1));
  b.doc.components.push({ id: "adp1", kind: "adapter", ref: "adapter", x: -40, y: 50, params: low }); // prettier-ignore
  b.doc.wires.push(
    { id: "w2", from: "adp1.S1", to: b.at(r.get(1).replace(/^a/, "c")), color: "red" }, // prettier-ignore
    { id: "w3", from: "adp1.S2", to: "psu1.-", color: "black" },
  );
  spiceRun("paused wave island", b.doc, { ticks: 8 });
});

test("Spice Lite, the busy fixture: carried voltages, held wire drops", () => {
  // Every LED lit through a resistor or an rnet9, every chip's supply a
  // millivolt down its wires (spice/sag.js) — so each tick books its demand
  // at the set voltage and re-solves what the clock moved, nothing more.
  spiceRun("busy 3", busyDocument(3), { ticks: 40 });
});

test("Spice Lite: a compiled mixed-family desk with LEDs", () => {
  spiceRun("compiled mixed desk", compiledMixedDesk(), { ticks: 16 });
  compareRuns("compiled mixed desk", compiledMixedDesk(), { ticks: 16 });
});

test("Spice Lite: mixed families hold their outputs (outputs + busy)", () => {
  spiceRun("mixed families", mixedFamilies(), {
    ticks: 10,
    stimulus: signals((i) => ({ in: i % 2 ? H : L })),
  });
});

test("Spice Lite: one RC node, two thresholds (input + levels)", () => {
  spiceRun("shared RC node", sharedRcNode(), { ticks: 20 });
});

test("Spice Lite: a CD40106B relaxation oscillator", () => {
  spiceRun("40106 relaxation", relaxation("CD40106B"), { ticks: 20 });
});

test("Spice Lite: a supply past its limit, and a long supply wire", () => {
  const stimulus = signals((i) => ({ s1: i % 2 ? H : L }));
  spiceRun("loaded supply", loadedSupply(), { ticks: 8, stimulus });
  spiceRun("long supply wire", longSupplyWire(), { ticks: 8, stimulus });
});

test("Spice Lite: LED networks", () => {
  spiceRun("rail lamp", railLamp(), { ticks: 4 });
  spiceRun("bare rail lamp", railLamp({ ohms: 0 }), { ticks: 4 });
  const stimulus = signals((i) => ({ s1: i % 2 ? H : L }));
  spiceRun("74LS lamp", drivenLamp("74LS04"), { ticks: 8, stimulus });
  spiceRun("CD4000 lamp", drivenLamp("CD4069UB", { ohms: 0 }), { ticks: 8, stimulus }); // prettier-ignore
});

test("Spice Lite: two flags on one net, each changing on its own", () => {
  // Only the second flag moves at tick 5: the net must be re-solved (and its
  // fight seen) all the same.
  const b = bench();
  const u = b.seat("u1", "74LS04", "e10");
  b.vcc(u.get(14));
  b.gnd(u.get(7));
  b.signal("s0", u.get(1), "low");
  b.signal("s1", u.get(1), "high");
  const seq = [
    [H, L],
    [H, L],
    [L, H],
    [L, H],
    [H, H],
    [H, L],
    [L, L],
    [L, H],
  ];
  spiceRun("shared flags", b.doc, {
    ticks: 16,
    stimulus: signals((i) => ({ s0: seq[i % 8][0], s1: seq[i % 8][1] })),
  });
});

test("Spice Lite: chips off the rails, and transistors across them", () => {
  // A 74LS04 fed through 47 Ω lighting an LED, a CD4069UB on a diode-lifted
  // ground, and an N-channel MOSFET straight from + to ground: their stages
  // are branches of their supply's network, and the MOSFET is booked by the
  // rails' own report — each kept as the full solve keeps it.
  const b = bench();
  const ls = b.seat("u1", "74LS04", "e10");
  const feed = b.seat("r1", "resistor", "a20", { ohms: 47 });
  b.vcc(feed.get(1));
  b.link(feed.get(2), ls.get(14));
  b.gnd(ls.get(7));
  b.signal("in", ls.get(1), "low");
  const rl = b.seat("rl", "resistor", "a25", { ohms: 100 });
  b.link(ls.get(2), rl.get(1));
  const led = b.seat("d1", "led", "j25", { color: "red" });
  b.link(rl.get(2), led.get(1));
  b.gnd(led.get(2));
  const cmos = b.seat("u2", "CD4069UB", "e33");
  b.vcc(cmos.get(14));
  const dg = b.seat("d2", "diode", "a42");
  b.link(dg.get(1), cmos.get(7));
  b.gnd(dg.get(2));
  b.link(ls.get(2), cmos.get(1));
  const q = b.seat("q1", "nmos", "a50");
  b.gnd(q.get(1));
  b.vcc(q.get(3));
  b.link(cmos.get(2), q.get(2));
  spiceRun("off the rails", b.doc, {
    ticks: 12,
    stimulus: signals((i) => ({ in: i % 3 ? H : L })),
  });
});

test("Spice Lite: a switch control two readers read differently, and one off the rails", () => {
  // A CD4066B's control on a divider at ~1.06 V that a 74LS input reads too:
  // the CMOS control reads L, the 74LS input X, so the net SHOWS X. Its
  // channel joins a 74LS HIGH to a 74LS input pulled down through 1 kΩ. The
  // digital engine's join once read the shown X — closing the channel
  // "maybe" and turning the far net X — while the solve read the control's
  // own L and never re-solved that network: the carried `disagree` went
  // stale, and the incremental settle showed X where the full one showed L.
  const two = bench();
  const sw = two.seat("u1", "CD4066B", "e2");
  two.vcc(sw.get(14));
  two.gnd(sw.get(7));
  const inv = two.seat("u2", "74LS04", "e12");
  two.vcc(inv.get(14));
  two.gnd(inv.get(7));
  const top = two.seat("r1", "resistor", "j20", { ohms: 10000 });
  const bottom = two.seat("r2", "resistor", "j26", { ohms: 2700 });
  two.signal("s0", top.get(1), "low");
  two.link(top.get(2), sw.get(13)); // A's control
  two.link(bottom.get(1), sw.get(13));
  two.gnd(bottom.get(2));
  two.link(inv.get(1), sw.get(13)); // …read by a 74LS input too
  two.gnd(inv.get(3)); // 2Y HIGH
  two.link(inv.get(4), sw.get(1));
  const pull = two.seat("r3", "resistor", "j32", { ohms: 1000 });
  two.link(pull.get(1), sw.get(2));
  two.gnd(pull.get(2));
  two.link(inv.get(5), sw.get(2));
  const stimulus = signals((i) => ({ s0: (i >> 1) % 2 ? H : L }));
  spiceRun("mixed readers on a control", two.doc, { ticks: 8, stimulus });
  spiceRun("mixed readers on a control, watched", two.doc, { ticks: 8, stimulus, watch: new Set(["u2"]) }); // prettier-ignore

  // The same through a switch off the rails: its ground a diode up, so the
  // 74LS HIGH both controls share reads H to the one on the rails and X to
  // it — its control clamped against its own supply pins all the same.
  const off = bench();
  const ls = off.seat("u2", "74LS04", "e2");
  off.vcc(ls.get(14));
  off.gnd(ls.get(7));
  const on = off.seat("u1", "CD4066B", "e12");
  off.vcc(on.get(14));
  off.gnd(on.get(7));
  const lifted = off.seat("u3", "CD4066B", "e22");
  off.vcc(lifted.get(14));
  const d = off.seat("d1", "diode", "j32");
  off.link(d.get(1), lifted.get(7));
  off.gnd(d.get(2));
  off.signal("s0", ls.get(1), "low");
  off.link(ls.get(2), on.get(13));
  off.link(ls.get(2), lifted.get(13));
  off.gnd(ls.get(3));
  off.link(ls.get(4), on.get(1));
  const r = off.seat("r1", "resistor", "j40", { ohms: 1000 });
  off.link(on.get(2), r.get(1));
  off.gnd(r.get(2));
  off.link(on.get(2), ls.get(5));
  spiceRun("a switch off the rails", off.doc, { ticks: 8, stimulus, watch: new Set(["u2"]) }); // prettier-ignore
});

test("Spice Lite: a clock fed through a meter's shunt drives its net, in both modes", () => {
  // Its vcc (or gnd) past a meter on mA is off the rails: powered only once
  // the voltage solve says what reaches it, in a context other than the one
  // the settle index was first built from — which listed no source on its
  // out net, so the incremental settle read it Z and the counter never
  // counted (the 2026-10-27 meter round).
  for (const lead of ["+", "-"]) {
    const b = bench();
    const u = b.seat("u1", "74LS161", "e20");
    b.vcc(u.get(16));
    b.gnd(u.get(8));
    for (const p of [1, 7, 9, 10]) b.vcc(u.get(p));
    for (const p of [3, 4, 5, 6]) b.gnd(u.get(p));
    const clock = partDef("clock").normalizeParams({ hz: 100 });
    b.doc.components.push({ id: "clk1", kind: "clock", ref: "clock", x: 40, y: 30, params: clock }); // prettier-ignore
    b.tie("clk1.out", u.get(2));
    b.tie("clk1.vcc", "j50");
    b.tie("clk1.gnd", "a50");
    const [red, black] = lead === "+" ? ["psu1.+", b.at("i50")] : [b.at("b50"), "psu1.-"]; // prettier-ignore
    if (lead === "+") b.gnd("b50");
    else b.vcc("i50");
    const params = partDef("meter").normalizeParams({ dial: "ma", jack: "ma", red: { at: red }, black: { at: black } }); // prettier-ignore
    b.doc.components.push({ id: "dmm1", kind: "meter", ref: "meter", x: 70, y: 0, params }); // prettier-ignore
    const netlist = buildNetlist(b.doc, new Map(), { inductors: "branch" });
    const out = netlist.netOfPoint.get("clk1.out");
    const qa = netlist.netOfPoint.get(b.at(u.get(14)));
    const seen = new Set();
    const { last } = spiceRun(`clock past a meter (${lead} lead)`, b.doc, {
      ticks: 12,
      branch: true, // (the shunt a branch, as SimController builds it)
      check: (i, r) => {
        if (i > 0) assert.notEqual(r.netLevels.get(out), "Z", `tick ${i}: the clock's net is driven`); // prettier-ignore
        seen.add(r.netLevels.get(qa));
      },
    });
    assert.ok(seen.has(H) && seen.has(L), `${lead}: QA toggles`);
    assert.ok(!last.warnings.some((w) => w.type === "clock-unpowered"));
  }
});

test("a tick's strong levels, read only after the next tick has taken its work", () => {
  // Built on first read from the incremental cache (`strongLater`), which the
  // next tick's warm start changes in place: it copies them first. Held to
  // the full loop's, read late, out of order, through a spread, and set.
  const doc = busyDocument(3);
  const netlist = buildNetlist(doc);
  const run = (mode) => {
    const context = prepareCircuit(doc, netlist);
    const ties = tieMemo();
    let warmStart = new Map();
    let state = new Map();
    let prevPinLevels = new Map();
    let warm = null;
    const out = [];
    for (let i = 0; i < 12; i++) {
      const clockPhase = new Map([["clk1", i % 2 ? L : H]]);
      const r = tick({ document: doc, netlist, warmStart, state, prevPinLevels, clockPhase, context, now: i * STEP_S, mode, warm, ties }); // prettier-ignore
      ({ netLevels: warmStart, state, pinLevels: prevPinLevels } = r);
      warm = r.warm ?? null;
      out.push(r);
    }
    return out;
  };
  const want = run("full").map((r) => r.strongLevels);
  const got = run("incremental");
  for (const i of [7, 2, 11, 0, 5]) {
    assert.deepStrictEqual(got[i].strongLevels, want[i], `tick ${i}`);
    assert.equal(got[i].strongLevels, got[i].strongLevels, "built once");
  }
  assert.deepStrictEqual({ ...got[3] }.strongLevels, want[3], "a spread");
  got[4].strongLevels = new Map();
  assert.equal(got[4].strongLevels.size, 0, "set");
});

test("a tick's strong levels one net at a time (`strongAt`), and the lamps read through it", () => {
  // The lamps read only their own nets (lamp-average.js), so the map is never
  // built for them: each net read where the cache — or the copy the next tick
  // took of it — holds it, the brightness identical to the full loop's map.
  const doc = busyDocument(3);
  const netlist = buildNetlist(doc);
  const junctions = lampJunctions(doc);
  assert.ok(junctions.length > 0, "the fixture has lamps");
  const run = (mode) => {
    const context = prepareCircuit(doc, netlist);
    const ties = tieMemo();
    let warmStart = new Map();
    let state = new Map();
    let prevPinLevels = new Map();
    let warm = null;
    const out = [];
    for (let i = 0; i < 12; i++) {
      const clockPhase = new Map([["clk1", i % 2 ? L : H]]);
      const r = tick({ document: doc, netlist, warmStart, state, prevPinLevels, clockPhase, context, now: i * STEP_S, mode, warm, ties }); // prettier-ignore
      ({ netLevels: warmStart, state, pinLevels: prevPinLevels } = r);
      warm = r.warm ?? null;
      // Read as SimController does, at once (half the ticks), or late.
      out.push({
        r,
        now: i % 2 ? lampBrightness(junctions, netlist, r) : null,
      });
    }
    return out;
  };
  const want = run("full");
  const got = run("incremental");
  const ids = [...netlist.nets.keys(), "no-such-net"];
  let lit = 0;
  for (let i = 0; i < want.length; i++) {
    const full = want[i].r.strongLevels;
    // A plain map, as a result without the accessor hands it over.
    const plain = { netLevels: want[i].r.netLevels, strongLevels: full };
    const expect = lampBrightness(junctions, netlist, plain);
    assert.deepStrictEqual(got[i].now ?? lampBrightness(junctions, netlist, got[i].r), expect, `tick ${i}: brightness`); // prettier-ignore
    assert.deepStrictEqual(want[i].now ?? expect, expect, `tick ${i}: full`);
    for (const id of ids) assert.equal(got[i].r.strongAt(id), full.get(id), `tick ${i}: ${id}`); // prettier-ignore
    assert.deepStrictEqual(
      got[i].r.strongLevels,
      full,
      `tick ${i}: the map after`,
    );
    lit += [...expect.values()].filter((v) => v > 0).length;
  }
  assert.ok(lit > 0, "some lamp lights");
  const set = got[5].r;
  set.strongLevels = new Map();
  assert.equal(set.strongAt(ids[0]), undefined, "a set map is what it reads");
});
