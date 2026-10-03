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

// The CD4000 CMOS family (Feature 400): what makes it a different family and
// not just 25 more part numbers.
//
//   · a floating CMOS input reads UNKNOWN, where a TTL one reads HIGH — for
//     the gates AND for the stateful parts, whose units carry an unknown state;
//   · every flip-flop and counter rule its datasheet states (edge, active
//     level, async vs sync), one assertion each;
//   · power is held to the family's own supply range (3–18 V), so a 9 V rail
//     runs a CD4000 part and smokes the 74LS part beside it;
//   · the family boundaries the engine cannot express as a level — a 74LS
//     HIGH into a CMOS input, too many LS loads on one CMOS output, two
//     supplies on one net — are reported, with the fix.
//
// The gate truth tables themselves are proved exhaustively by
// truth-table.test.js (every gate unit of every chip) and against the
// datasheets by the demo benches (gate-demos.test.js).

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z, X } from "../sim/levels.js";
import {
  evaluate,
  inputLevels,
  initialState,
  outputsOf,
  stepChip,
} from "../sim/chip-eval.js";
import { settle } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { chipDef, familiesUsed } from "../catalog/index.js";
import {
  familiesShown,
  floatsUnknown,
  lsFanoutOf,
  normalizeFamilyMode,
  supplyRange,
  supplyText,
} from "../catalog/families.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const levels = (obj) =>
  new Map(Object.entries(obj).map(([pin, lv]) => [Number(pin), lv]));

/**
 * A stateful chip on a bench of its own: every input starts at the level
 * `rest` gives it (a CMOS part must have each one tied), and `set` changes
 * some and steps the chip once, edges detected against the sample before —
 * exactly the engine's contract for one tick.
 */
function bench(ref, rest) {
  const def = chipDef(ref);
  const raw = levels(rest); // pin → level as wired; Z (or absent) floats
  let state = initialState(def);
  let ins = inputLevels(def, raw);
  const api = {
    set(changes) {
      for (const [pin, lv] of Object.entries(changes)) raw.set(Number(pin), lv);
      const prev = ins;
      ins = inputLevels(def, raw);
      state = stepChip(def, state, ins, prev);
      return api;
    },
    out(pin) {
      return outputsOf(def, state, ins).get(pin);
    },
    outs(pins) {
      const o = outputsOf(def, state, ins);
      return pins.map((p) => o.get(p));
    },
  };
  return api;
}

// ── The family data ──────────────────────────────────────────────────────────

test("families: supply ranges, floating rules and LS fan-out", () => {
  assert.deepEqual({ ...supplyRange(chipDef("CD4011B")) }, { min: 3, max: 18 });
  assert.equal(supplyRange(chipDef("74LS00")).min, 4.75);
  // Family-less parts keep the 5 V envelope they always had.
  assert.equal(supplyRange(chipDef("Z80A")).max, 5.25);
  assert.equal(supplyText(chipDef("74LS00")), "5 V");
  assert.equal(supplyText(chipDef("CD4011B")), "3–18 V");
  assert.equal(floatsUnknown(chipDef("CD4011B")), true);
  assert.equal(floatsUnknown(chipDef("74LS00")), false);
  assert.equal(floatsUnknown(chipDef("Z80A")), false);
  assert.equal(lsFanoutOf(chipDef("CD4011B")), 1);
  assert.equal(lsFanoutOf(chipDef("CD4050B")), 8);
  assert.equal(lsFanoutOf(chipDef("74LS00")), null);
});

test("families: tray modes, widened by what the project uses", () => {
  assert.deepEqual([...familiesShown("74LS")], ["74LS"]);
  assert.deepEqual([...familiesShown("CD4000")], ["CD4000"]);
  assert.deepEqual([...familiesShown("combined")].sort(), ["74LS", "CD4000"]);
  assert.deepEqual([...familiesShown("74LS", ["CD4000"])].sort(), [
    "74LS",
    "CD4000",
  ]);
  assert.deepEqual([...familiesShown("nonsense")], ["74LS"]);
  assert.equal(normalizeFamilyMode("combined"), "combined");
  assert.equal(normalizeFamilyMode(undefined), "74LS");
  assert.deepEqual(
    [
      ...familiesUsed([
        { components: [{ ref: "CD4011B" }, { ref: "psu" }] },
        { components: [{ ref: "74LS00" }, { ref: "Z80A" }] },
      ]),
    ].sort(),
    ["74LS", "CD4000"],
  );
});

// ── Floating inputs ──────────────────────────────────────────────────────────

test("a floating CD4000 input reads unknown; a floating 74LS input reads HIGH", () => {
  // CD4011B gate 1: A(1)·B(2) → J(3).
  const cmos = chipDef("CD4011B");
  assert.equal(evaluate(cmos, levels({ 1: Z, 2: H })).get(3), X);
  // A dominant input still decides: NAND with a LOW is HIGH whatever the other.
  assert.equal(evaluate(cmos, levels({ 1: Z, 2: L })).get(3), H);
  // Nothing wired at all: unknown, never a confident LOW.
  assert.equal(evaluate(cmos, new Map()).get(3), X);
  // The same gate in TTL reads the float as HIGH.
  assert.equal(evaluate(chipDef("74LS00"), levels({ 1: Z, 2: H })).get(3), L);
  // NOR's dominant level is HIGH: CD4001B A(1)+B(2) → J(3).
  const nor = chipDef("CD4001B");
  assert.equal(evaluate(nor, levels({ 1: Z, 2: H })).get(3), L);
  assert.equal(evaluate(nor, levels({ 1: Z, 2: L })).get(3), X);
});

test("a stateful CD4000 part reads its floating inputs as unknown too", () => {
  for (const level of inputLevels(chipDef("CD4013B"), new Map()).values()) {
    assert.equal(level, X);
  }
  for (const level of inputLevels(chipDef("74LS74"), new Map()).values()) {
    assert.equal(level, H);
  }
  // The CPUs are family-less and keep floating-reads-HIGH.
  for (const level of inputLevels(chipDef("Z80A"), new Map()).values()) {
    assert.equal(level, H);
  }
});

// ── The new gate vocabulary: XNOR, BUF, and the 8-input dual-output gates ────

test("CD4077B is XNOR and CD4070B XOR, on the same pinout", () => {
  const cases = [
    [L, L],
    [L, H],
    [H, L],
    [H, H],
  ];
  for (const [a, b] of cases) {
    const same = a === b ? H : L;
    assert.equal(
      evaluate(chipDef("CD4077B"), levels({ 1: a, 2: b })).get(3),
      same,
    );
    assert.equal(
      evaluate(chipDef("CD4070B"), levels({ 1: a, 2: b })).get(3),
      same === H ? L : H,
    );
  }
});

test("CD4050B buffers, CD4049UB inverts (the sheet's function tables)", () => {
  for (const lv of [H, L]) {
    assert.equal(evaluate(chipDef("CD4050B"), levels({ 3: lv })).get(2), lv);
    assert.equal(
      evaluate(chipDef("CD4049UB"), levels({ 3: lv })).get(2),
      lv === H ? L : H,
    );
  }
});

test("CD4068B and CD4078B drive both the true and the complemented output", () => {
  const all = (lv) =>
    levels({ 2: lv, 3: lv, 4: lv, 5: lv, 9: lv, 10: lv, 11: lv, 12: lv });
  const nand = chipDef("CD4068B");
  assert.equal(evaluate(nand, all(H)).get(1), H); // K = AND
  assert.equal(evaluate(nand, all(H)).get(13), L); // J = NAND
  const oneLow = new Map([...all(H), [9, L]]);
  assert.equal(evaluate(nand, oneLow).get(1), L);
  assert.equal(evaluate(nand, oneLow).get(13), H);
  const nor = chipDef("CD4078B");
  assert.equal(evaluate(nor, all(L)).get(1), L); // K = OR
  assert.equal(evaluate(nor, all(L)).get(13), H); // J = NOR
  const oneHigh = new Map([...all(L), [12, H]]);
  assert.equal(evaluate(nor, oneHigh).get(1), H);
  assert.equal(evaluate(nor, oneHigh).get(13), L);
});

// ── CD4013B: dual D flip-flop, active-HIGH set/reset ─────────────────────────

// Flip-flop 1: D 5, CLOCK 3, SET 6, RESET 4 → Q 1, Q̄ 2.
const FF_REST = { 3: L, 4: L, 5: L, 6: L, 8: L, 9: L, 10: L, 11: L };

test("CD4013B: D is taken on the RISING clock edge, never the falling", () => {
  const ff = bench("CD4013B", FF_REST);
  ff.set({ 5: H });
  assert.deepEqual(ff.outs([1, 2]), [L, H], "no edge, no change");
  ff.set({ 3: H });
  assert.deepEqual(ff.outs([1, 2]), [H, L], "rising edge takes D");
  ff.set({ 5: L, 3: L });
  assert.deepEqual(ff.outs([1, 2]), [H, L], "the falling edge does nothing");
  ff.set({ 3: H });
  assert.deepEqual(ff.outs([1, 2]), [L, H]);
});

test("CD4013B: SET and RESET are active HIGH and asynchronous; both HIGH drives both outputs HIGH", () => {
  const ff = bench("CD4013B", FF_REST);
  ff.set({ 6: H });
  assert.deepEqual(ff.outs([1, 2]), [H, L], "SET, with no clock");
  ff.set({ 6: L });
  assert.deepEqual(ff.outs([1, 2]), [H, L], "and it holds");
  ff.set({ 4: H });
  assert.deepEqual(ff.outs([1, 2]), [L, H], "RESET, with no clock");
  ff.set({ 6: H });
  assert.deepEqual(ff.outs([1, 2]), [H, H], "both: Q and Q̄ both HIGH");
  // Set/reset override the clock.
  ff.set({ 6: L, 5: H });
  ff.set({ 3: H });
  assert.deepEqual(ff.outs([1, 2]), [L, H], "RESET held beats the clock");
});

test("CD4013B: a floating D, clock or reset makes Q unknown; a clean edge or reset recovers", () => {
  const ff = bench("CD4013B", FF_REST);
  ff.set({ 5: Z });
  ff.set({ 3: H });
  assert.deepEqual(ff.outs([1, 2]), [X, X], "floating D taken on an edge");
  ff.set({ 5: L, 3: L });
  ff.set({ 3: H });
  assert.deepEqual(
    ff.outs([1, 2]),
    [L, H],
    "a clean edge with clean D recovers",
  );

  const clk = bench("CD4013B", FF_REST);
  clk.set({ 5: H });
  clk.set({ 3: Z });
  assert.deepEqual(
    clk.outs([1, 2]),
    [X, X],
    "a floating clock might have clocked",
  );
  // …unless what it would take is what it already holds.
  const same = bench("CD4013B", FF_REST);
  same.set({ 3: Z });
  assert.deepEqual(same.outs([1, 2]), [L, H], "D LOW, Q LOW: no doubt");

  const rst = bench("CD4013B", FF_REST);
  rst.set({ 4: Z });
  assert.deepEqual(rst.outs([1, 2]), [X, X], "a floating RESET");
  rst.set({ 4: H });
  rst.set({ 4: L });
  assert.deepEqual(rst.outs([1, 2]), [L, H], "a clean reset recovers");
});

// ── CD4017B: decade counter, ten decoded outputs ─────────────────────────────

// Outputs for counts 0…9, in count order; CARRY OUT 12; CLOCK INHIBIT 13;
// CLOCK 14; RESET 15.
const DECODED = [3, 2, 4, 7, 10, 1, 5, 6, 9, 11];
const COUNTER_REST = { 13: L, 14: L, 15: L };
const countOf = (c) => {
  const hot = c.outs(DECODED).map((lv, i) => (lv === H ? i : null));
  return hot.filter((i) => i !== null);
};
const clock = (c, n = 1) => {
  for (let i = 0; i < n; i++) c.set({ 14: H }).set({ 14: L });
  return c;
};

test("CD4017B: counts 0–9 on rising clocks, exactly one decoded output HIGH, then wraps", () => {
  const c = bench("CD4017B", COUNTER_REST);
  assert.deepEqual(countOf(c), [0]);
  for (let n = 1; n <= 12; n++) {
    clock(c);
    assert.deepEqual(countOf(c), [n % 10], `after ${n} clocks`);
  }
});

test("CD4017B: CARRY OUT is HIGH for counts 0–4 and LOW for 5–9", () => {
  const c = bench("CD4017B", COUNTER_REST);
  const carry = [];
  for (let n = 0; n < 10; n++) {
    carry.push(c.out(12));
    clock(c);
  }
  assert.deepEqual(carry, [H, H, H, H, H, L, L, L, L, L]);
  assert.equal(c.out(12), H, "and rises as the count wraps to 0");
});

test("CD4017B: CLOCK INHIBIT HIGH holds; INHIBIT falling while CLOCK is HIGH advances", () => {
  const c = bench("CD4017B", COUNTER_REST);
  c.set({ 13: H });
  clock(c, 3);
  assert.deepEqual(countOf(c), [0], "inhibited");
  c.set({ 14: H }); // CLOCK high under the inhibit: nothing yet
  assert.deepEqual(countOf(c), [0]);
  c.set({ 13: L }); // the datasheet's other way in
  assert.deepEqual(countOf(c), [1]);
});

test("CD4017B: RESET HIGH returns it to 0, asynchronously", () => {
  const c = clock(bench("CD4017B", COUNTER_REST), 7);
  assert.deepEqual(countOf(c), [7]);
  c.set({ 15: H });
  assert.deepEqual(countOf(c), [0]);
  clock(c, 2);
  assert.deepEqual(countOf(c), [0], "held in reset");
  c.set({ 15: L });
  clock(c);
  assert.deepEqual(countOf(c), [1]);
});

test("CD4017B: a floating RESET leaves the count unknown until a clean reset", () => {
  const c = clock(bench("CD4017B", COUNTER_REST), 3);
  c.set({ 15: Z });
  assert.deepEqual(c.outs([...DECODED, 12]), Array(11).fill(X));
  c.set({ 15: L });
  clock(c);
  assert.deepEqual(c.outs(DECODED), Array(10).fill(X), "counting from unknown");
  c.set({ 15: H }).set({ 15: L });
  assert.deepEqual(countOf(c), [0], "a clean reset recovers");
});

test("CD4017B: a floating INHIBIT only matters once CLOCK is HIGH", () => {
  const c = bench("CD4017B", COUNTER_REST);
  c.set({ 13: Z });
  assert.deepEqual(countOf(c), [0], "CLOCK LOW gates the doubt away");
  c.set({ 14: H });
  assert.deepEqual(c.outs(DECODED), Array(10).fill(X));
});

// ── CD4040B: 12-stage binary ripple counter ──────────────────────────────────

// Q1…Q12 (LSB first); φ 10; R 11.
const Q = [9, 7, 6, 5, 3, 2, 4, 13, 12, 14, 15, 1];
const valueOf = (c) =>
  c.outs(Q).reduce((n, lv, i) => n + (lv === H ? 1 << i : 0), 0);
const pulse = (c, n = 1) => {
  for (let i = 0; i < n; i++) c.set({ 10: H }).set({ 10: L });
  return c;
};

test("CD4040B: counts on the FALLING edge of φ, Q1 the least significant stage", () => {
  const c = bench("CD4040B", { 10: L, 11: L });
  c.set({ 10: H });
  assert.equal(valueOf(c), 0, "the rising edge does nothing");
  c.set({ 10: L });
  assert.equal(valueOf(c), 1);
  pulse(c, 4);
  assert.equal(valueOf(c), 5);
  assert.deepEqual(c.outs([9, 7, 6]), [H, L, H]);
});

test("CD4040B: wraps after 4096 counts; R HIGH clears every stage", () => {
  const c = pulse(bench("CD4040B", { 10: L, 11: L }), 4095);
  assert.equal(valueOf(c), 4095);
  pulse(c);
  assert.equal(valueOf(c), 0);
  pulse(c, 300);
  c.set({ 11: H });
  assert.equal(valueOf(c), 0);
});

test("CD4040B: a floating R or φ makes the count unknown", () => {
  const c = pulse(bench("CD4040B", { 10: L, 11: L }), 9);
  c.set({ 11: Z });
  assert.deepEqual(c.outs(Q), Array(12).fill(X));
  c.set({ 11: H }).set({ 11: L });
  assert.equal(valueOf(c), 0);
  c.set({ 10: Z });
  assert.deepEqual(c.outs(Q), Array(12).fill(X));
});

// ── In circuit: power, floating-input and boundary warnings ──────────────────

const boards = [
  { id: "bb2", type: "rail-full", x: 0, y: 0 },
  { id: "bb1", type: "pins-full", x: 0, y: 4 },
  { id: "bb3", type: "rail-full", x: 0, y: 18 },
];
let seq = 0;
const wire = (from, to) => ({ id: `w${++seq}`, from, to, color: "black" });
const psu = (id, x, volts) => ({
  id,
  kind: "psu",
  ref: "psu",
  x,
  y: 30,
  params: { volts },
});
const chip = (id, ref, anchor) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params: {},
});
const resistor = (id, anchor) => ({
  id,
  kind: "discrete",
  ref: "resistor",
  board: "bb1",
  anchor,
  params: {},
});
const holesOf = (ref, anchor) =>
  new Map(partPinHoles(ref, anchor).map(({ pin, hole }) => [pin, hole]));
/** A free hole sharing `hole`'s column-half. */
const mate = (hole, i = 0) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole)[
    i
  ];
/** Wire a chip's power pins straight to a PSU's terminals. */
function power(psuId, ref, anchor) {
  const def = chipDef(ref);
  const h = holesOf(ref, anchor);
  const vcc = def.pins.find((p) => p.role === "vcc").n;
  const gnd = def.pins.find((p) => p.role === "gnd").n;
  return [
    wire(`${psuId}.+`, `bb1.${mate(h.get(vcc))}`),
    wire(`${psuId}.-`, `bb1.${mate(h.get(gnd))}`),
  ];
}
/** Tie a chip pin to a PSU terminal ("+" or "-"). */
const tie = (psuId, terminal, ref, anchor, pin, i = 1) =>
  wire(`${psuId}.${terminal}`, `bb1.${mate(holesOf(ref, anchor).get(pin), i)}`);
/** Tie EVERY input of a chip to GND, so only what a test adds can float. */
const tieAll = (psuId, ref, anchor, except = []) =>
  chipDef(ref)
    .pins.filter((p) => p.role === "input" && !except.includes(p.n))
    .map((p) => tie(psuId, "-", ref, anchor, p.n));

function run(doc) {
  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist });
  return {
    result,
    at: (address) => result.netLevels.get(netlist.netOfPoint.get(address)),
    warnings: (type) => result.warnings.filter((w) => w.type === type),
  };
}

test("power: a CD4000 part runs anywhere in 3–18 V; a 74LS part beside it smokes above 5 V", () => {
  for (const volts of [3, 5, 9, 12, 15]) {
    const doc = {
      boards,
      components: [
        psu("psu1", 80, volts),
        chip("c1", "CD4011B", "e10"),
        chip("c2", "74LS00", "e30"),
      ],
      wires: [
        ...power("psu1", "CD4011B", "e10"),
        ...power("psu1", "74LS00", "e30"),
        ...tieAll("psu1", "CD4011B", "e10"),
      ],
    };
    const { result } = run(doc);
    const cmos = result.chipStatus.get("c1");
    const ttl = result.chipStatus.get("c2");
    assert.equal(cmos.status, "ok", `CD4011B at ${volts} V`);
    assert.equal(cmos.volts, volts);
    const want = volts === 5 ? "ok" : volts < 5 ? "underpowered" : "damaged";
    assert.equal(ttl.status, want, `74LS00 at ${volts} V`);
    if (want !== "ok") {
      const w = result.warnings.find((x) => x.chip === "c2");
      assert.equal(w.type, want);
      assert.equal(w.volts, volts, "the warning states the voltage");
    }
  }
});

test("a powered CD4000 part with untied inputs is reported — spare gates included", () => {
  const doc = {
    boards,
    components: [psu("psu1", 80, 5), chip("c1", "CD4011B", "e10")],
    wires: [
      ...power("psu1", "CD4011B", "e10"),
      // Gate 1 in use and fully tied; the other three gates left alone.
      tie("psu1", "+", "CD4011B", "e10", 1),
      tie("psu1", "+", "CD4011B", "e10", 2),
    ],
  };
  const { warnings, at } = run(doc);
  const [w] = warnings("floating-input");
  assert.equal(w.chip, "c1");
  assert.deepEqual(w.pins, [5, 6, 8, 9, 12, 13]);
  assert.equal(at("bb1.e12"), L, "the tied gate works");
  // Tie the rest: nothing left to say.
  const tidy = run({
    ...doc,
    wires: [
      ...power("psu1", "CD4011B", "e10"),
      ...tieAll("psu1", "CD4011B", "e10"),
    ],
  });
  assert.deepEqual(tidy.warnings("floating-input"), []);
  // A 74LS part's floating inputs read HIGH and are not the engine's to report.
  const ttl = run({
    boards,
    components: [psu("psu1", 80, 5), chip("c1", "74LS00", "e10")],
    wires: power("psu1", "74LS00", "e10"),
  });
  assert.deepEqual(ttl.warnings("floating-input"), []);
});

test("an unpowered CD4000 part reports no floating inputs (it is reported as unpowered)", () => {
  const { warnings } = run({
    boards,
    components: [chip("c1", "CD4011B", "e10")],
    wires: [],
  });
  assert.deepEqual(warnings("floating-input"), []);
});

/** A 74LS04 output (1Y, pin 2) feeding a CD4011B input (A, pin 1). */
function lsIntoCmos(extraComponents = [], extraWires = []) {
  const ls = holesOf("74LS04", "e10");
  const cmos = holesOf("CD4011B", "e30");
  return {
    boards,
    components: [
      psu("psu1", 80, 5),
      chip("c1", "74LS04", "e10"),
      chip("c2", "CD4011B", "e30"),
      ...extraComponents,
    ],
    wires: [
      ...power("psu1", "74LS04", "e10"),
      ...power("psu1", "CD4011B", "e30"),
      ...tieAll("psu1", "CD4011B", "e30", [1]),
      wire(`bb1.${mate(ls.get(2))}`, `bb1.${mate(cmos.get(1))}`),
      ...extraWires,
    ],
  };
}

test("a 74LS output into a CD4000 input is flagged as marginal — and a pull-up clears it", () => {
  const bare = run(lsIntoCmos());
  const [w] = bare.warnings("marginal-high");
  assert.ok(w, "flagged");
  // The level is NOT changed: it is marginal, not wrong.
  assert.equal(
    bare.at("bb1.e30"),
    L,
    "1A floats HIGH → 1Y LOW → the CMOS input",
  );

  // A resistor from that net to the + supply: the textbook fix.
  const r = holesOf("resistor", "a50");
  const ls = holesOf("74LS04", "e10");
  const fixed = run(
    lsIntoCmos(
      [resistor("r1", "a50")],
      [
        wire(`bb1.${mate(r.get(1))}`, `bb1.${mate(ls.get(2), 1)}`),
        wire("psu1.+", `bb1.${mate(r.get(2))}`),
      ],
    ),
  );
  assert.deepEqual(fixed.warnings("marginal-high"), []);
});

test("one standard CD4000 output driving two 74LS inputs is over its fan-out; a 4050 is not", () => {
  const build = (driver) => {
    const d = holesOf(driver, "e10");
    const ls = holesOf("74LS00", "e30");
    // CD4011B J (3) or CD4050B G (2) → 74LS00 1A (1) and 1B (2).
    const out = driver === "CD4050B" ? 2 : 3;
    return {
      boards,
      components: [
        psu("psu1", 80, 5),
        chip("c1", driver, "e10"),
        chip("c2", "74LS00", "e30"),
      ],
      wires: [
        ...power("psu1", driver, "e10"),
        ...power("psu1", "74LS00", "e30"),
        ...tieAll("psu1", driver, "e10"),
        wire(`bb1.${mate(d.get(out))}`, `bb1.${mate(ls.get(1))}`),
        wire(`bb1.${mate(d.get(out), 1)}`, `bb1.${mate(ls.get(2))}`),
      ],
    };
  };
  const [w] = run(build("CD4011B")).warnings("ls-fanout");
  assert.ok(w);
  assert.equal(w.chip, "c1");
  assert.equal(w.loads, 2);
  assert.equal(w.max, 1);
  assert.deepEqual(run(build("CD4050B")).warnings("ls-fanout"), []);
});

test("one net joining chips on different supplies is reported", () => {
  const a = holesOf("CD4011B", "e10");
  const b = holesOf("CD4011B", "e30");
  const doc = {
    boards,
    components: [
      psu("psu1", 80, 12),
      psu("psu2", 100, 5),
      chip("c1", "CD4011B", "e10"),
      chip("c2", "CD4011B", "e30"),
    ],
    wires: [
      ...power("psu1", "CD4011B", "e10"),
      ...power("psu2", "CD4011B", "e30"),
      // Both grounds must meet, or nothing is a circuit.
      wire("psu1.-", "psu2.-"),
      ...tieAll("psu1", "CD4011B", "e10"),
      ...tieAll("psu2", "CD4011B", "e30", [1]),
      wire(`bb1.${mate(a.get(3))}`, `bb1.${mate(b.get(1))}`),
    ],
  };
  const [w] = run(doc).warnings("mixed-supply");
  assert.ok(w);
  assert.deepEqual(w.volts, [5, 12]);
});
