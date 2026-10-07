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
// (features/event-driven-simulation.md).
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
import { setCustomChips } from "../catalog/index.js";
import { busyDocument } from "../bench/busy-circuit.js";
import { bench } from "./timing-fixtures.js";
import {
  STEP_S,
  bareLeds,
  compiledMixedDesk,
  compareRuns,
  diodeChain,
  dividerChain,
  floatingMux,
  flopFight,
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
    assert.ok(!stats.readingsFallbacks && !stats.uncertainFallbacks);
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
  assert.ok(stats.readingsFallbacks > 0, "the readings fallback fired");
});

test("diodes: a chain, and an anode two outputs fight over", () => {
  compareRuns("diode chain", diodeChain(), { ticks: 12 });
  const { stats } = compareRuns("fought anode", foughtAnode(), {
    ticks: 8,
    stimulus: signals((i) => (i % 4 < 2 ? { s1: L, s2: H } : { s1: H, s2: H })),
  });
  assert.ok(stats.uncertainFallbacks > 0, "the uncertain fallback fired");
  assert.ok(stats.incrementalPasses > 0, "…and the certain passes did not");
});

test("an uncertain settle, then a re-solve that ends the fight", () => {
  const { stats } = compareRuns("flop fight", flopFight(), {
    ticks: 12,
    stimulus: signals((i) => ({ clk: i % 2 ? H : L, s2: L })),
  });
  assert.ok(stats.uncertainFallbacks > 0 && stats.solves > 12, JSON.stringify(stats)); // prettier-ignore
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
