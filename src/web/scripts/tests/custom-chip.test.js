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

// Custom chips (the chip designer): the stored record and what is derived
// from it (model/custom-chip.js), the catalog def a project's chips become
// (catalog/custom-chips.js + catalog/index.js `setCustomChips`), and that
// def run through the REAL engine — combinational, clocked, replicated.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z } from "../sim/levels.js";
import { tick as engineTick } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";
import { packageSpec, packageName } from "../model/footprints.js";
import {
  autoAssign,
  chipRegistry,
  chipsMissingFrom,
  customChipProblems,
  customPackage,
  customPins,
  duplicateCustomChip,
  isCustomRef,
  newCustomChip,
  normalizeCustomChip,
  normalizeCustomChips,
  resizeCustomChip,
  setPorts,
  setUnitCount,
} from "../model/custom-chip.js";
import {
  chipMarking,
  customChipDefs,
  familiesUsed,
  partDef,
  setCustomChips,
} from "../catalog/index.js";

const chipWith = (over = {}) => ({ ...newCustomChip([]), ...over });

// ── The stored record ──────────────────────────────────────────────────────

test("a new chip is a 2-input NAND on a DIP-14 with a fresh id", () => {
  const a = newCustomChip([]);
  assert.ok(isCustomRef(a.id));
  assert.equal(a.name, "CUSTOM1");
  const b = newCustomChip([a]);
  assert.equal(b.name, "CUSTOM2");
  assert.notEqual(a.id, b.id);
  assert.deepEqual(customChipProblems(a), []);
  assert.equal(customPackage(a), "DIP-14");
});

test("normalisation is lenient: bad pins come off, bad ports go, junk is null", () => {
  assert.equal(normalizeCustomChip({ id: "nope" }), null);
  const c = normalizeCustomChip({
    id: "custom-0000abcd",
    name: "X1",
    pinsPerSide: 4,
    ports: [{ name: "A", dir: "input" }, { name: "A" }, { dir: "output" }],
    units: [{ A: [99] }],
    vcc: 8,
    gnd: 4,
  });
  assert.deepEqual(c.ports, [{ name: "A", dir: "input", width: 1 }]);
  assert.deepEqual(c.units, [{ A: [0] }]);
  assert.equal(c.family, "74LS");
  const list = normalizeCustomChips([c, c, null]);
  assert.equal(list.length, 1);
});

test("custom packages: any size, either width, named for the table where it can be", () => {
  assert.equal(packageName(14, 300), "DIP-14");
  assert.equal(packageName(14, 600), "DIP-14-600");
  assert.equal(packageName(18, 300), "DIP-18-300");
  assert.equal(packageName(28, 600), "DIP-28");
  assert.deepEqual(packageSpec("DIP-18-300"), { pins: 18, halfPins: 9, body: 300 }); // prettier-ignore
  assert.equal(packageSpec("DIP-14-600").body, 600);
  assert.throws(() => packageSpec("DIP-15-300"), { code: "INVALID_PACKAGE" });
  assert.throws(() => packageSpec("DIP-42-300"), { code: "INVALID_PACKAGE" });
});

test("replicated units: unit-numbered pin names; a shared input keeps the bare name", () => {
  let c = chipWith({
    ports: [
      { name: "CLK", dir: "input", width: 1 },
      { name: "D", dir: "input", width: 1 },
      { name: "Q", dir: "output", width: 1 },
    ],
    units: [{ CLK: [1], D: [2], Q: [3] }],
  });
  c = setUnitCount(c, 2);
  c.units[1] = { CLK: [1], D: [4], Q: [5] };
  const byPin = new Map(customPins(c).map((p) => [p.n, p]));
  assert.equal(byPin.get(1).name, "CLK");
  assert.equal(byPin.get(2).name, "1D");
  assert.equal(byPin.get(5).name, "2Q");
  assert.equal(byPin.get(5).role, "output");
  assert.equal(byPin.get(7).name, "GND");
  assert.deepEqual(customChipProblems(c), []);
  // An output may never share.
  c.units[1].Q = [3];
  assert.ok(customChipProblems(c).some((p) => p.code === "outputShared"));
});

test("vector ports name their pins by bit; auto-assign fills only the gaps", () => {
  let c = chipWith({ ports: [], units: [{}], code: "" });
  c = setPorts(c, [
    { name: "D", dir: "input", width: 4 },
    { name: "Q", dir: "output", width: 4 },
  ]);
  assert.deepEqual(c.units[0].D, [0, 0, 0, 0]);
  assert.ok(customChipProblems(c).some((p) => p.code === "bitUnassigned"));
  c = autoAssign(c);
  assert.deepEqual(c.units[0].D, [1, 2, 3, 4]);
  assert.deepEqual(c.units[0].Q, [5, 6, 8, 9]); // 7 is GND
  const names = customPins(c).map((p) => p.name);
  assert.deepEqual(names.slice(0, 6), ["D0", "D1", "D2", "D3", "Q0", "Q1"]);
});

test("a rename keeps its pins; a resize keeps what still exists", () => {
  let c = newCustomChip([]);
  c = setPorts(c, [
    { name: "IN1", dir: "input", width: 1, from: "A" },
    { name: "B", dir: "input", width: 1 },
    { name: "Y", dir: "output", width: 1 },
  ]);
  assert.deepEqual(c.units[0].IN1, [1]);
  const small = resizeCustomChip({ ...c, units: [{ IN1: [1], B: [2], Y: [6] }] }, 2); // prettier-ignore
  assert.equal(small.pinsPerSide, 2);
  assert.deepEqual(small.units[0].Y, [0]);
  assert.deepEqual([small.gnd, small.vcc], [2, 4]);
});

test("a duplicate gets a new id and a free name", () => {
  const a = newCustomChip([]);
  const b = duplicateCustomChip(a, [a]);
  assert.notEqual(a.id, b.id);
  assert.equal(b.name, "CUSTOM1-2");
  assert.equal(b.code, a.code);
});

test("reserved and bad port names are problems", () => {
  const c = chipWith({ ports: [{ name: "VCC", dir: "input", width: 1 }, { name: "2x", dir: "input", width: 1 }], units: [{ VCC: [1], "2x": [2] }] }); // prettier-ignore
  const codes = customChipProblems(c).map((p) => p.code);
  assert.ok(codes.includes("reservedPortName"));
  assert.ok(codes.includes("badPortName"));
});

// ── The catalog def ────────────────────────────────────────────────────────

test("setCustomChips makes a project's chips catalog defs", () => {
  const c = chipWith({ name: "NAND1", family: "CD4000" });
  setCustomChips([c]);
  const def = partDef(c.id);
  assert.equal(def.kind, "chip");
  assert.equal(def.custom, true);
  assert.equal(chipMarking(def), "NAND1");
  assert.equal(chipMarking(partDef("74LS00")), "74LS00");
  assert.equal(def.pins.find((p) => p.n === 14).name, "VDD");
  assert.deepEqual(
    customChipDefs().map((d) => d.id),
    [c.id],
  );
  // The same stored chip yields the same def object.
  setCustomChips([c]);
  assert.equal(partDef(c.id), def);
  // A custom chip opens no family shelf.
  assert.deepEqual([...familiesUsed([{ components: [{ ref: c.id }] }])], []);
  setCustomChips([]);
  assert.equal(partDef(c.id), null);
});

test("a chip whose code does not compile is inert: every output Z", () => {
  const c = chipWith({ code: "assign Y = Q;" });
  setCustomChips([c]);
  const def = partDef(c.id);
  assert.equal(def.customRuntime, null);
  assert.equal(def.customCompiled.errors[0].code, "undeclared");
  assert.deepEqual([...def.logic.outputs([], new Map())], [[3, Z]]);
  setCustomChips([]);
});

// ── Through the engine ─────────────────────────────────────────────────────

let wireSeq = 0;
const wire = (from, to) => ({ id: `w${++wireSeq}`, from, to, color: "black" });
const boards = [
  { id: "bb1", type: "pins-full", x: 0, y: 3.5 },
  { id: "bb2", type: "rail-full", x: 0, y: 0 },
  { id: "bb3", type: "rail-full", x: 0, y: 17.52 },
];
const HI = (k) => `bb2.+${k}`;
const LO = (k) => `bb3.-${k}`;
const holesOf = (ref, anchor) =>
  new Map(partPinHoles(ref, anchor).map(({ pin, hole }) => [pin, hole]));
const mates = (hole) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole);
const strip = (holes, pin, i = 0) => `bb1.${mates(holes.get(pin))[i]}`;

function bench(chip, extra = (_h) => [], { clock = false } = {}) {
  setCustomChips([chip]);
  const h = holesOf(chip.id, "e10");
  const doc = {
    boards,
    components: [
      {
        id: "psu1",
        kind: "psu",
        ref: "psu",
        x: 80,
        y: 0,
        params: { volts: 5 },
      },
      ...(clock ? [{ id: "clk1", kind: "clock", ref: "clock", x: 90, y: 12, params: { hz: "manual" } }] : []), // prettier-ignore
      { id: "c1", kind: "chip", ref: chip.id, board: "bb1", anchor: "e10", params: {} }, // prettier-ignore
    ],
    wires: [
      wire("psu1.+", HI(1)),
      wire("psu1.-", LO(1)),
      wire(strip(h, chip.vcc), HI(2)),
      wire(strip(h, chip.gnd), LO(2)),
      ...extra(h),
    ],
  };
  const netlist = buildNetlist(doc);
  const s = {
    warm: new Map(),
    state: new Map(),
    prev: new Map(),
    phase: new Map(clock ? [["clk1", L]] : []),
  };
  const run = () => {
    const r = engineTick({
      document: doc,
      netlist,
      warmStart: s.warm,
      state: s.state,
      prevPinLevels: s.prev,
      clockPhase: s.phase,
    });
    s.warm = r.netLevels;
    s.state = r.state;
    s.prev = r.pinLevels;
    return r;
  };
  return {
    run,
    clock(level) {
      s.phase.set("clk1", level);
      return run();
    },
    pin: (pin) => s.warm.get(netlist.netOfPoint.get(`bb1.${h.get(pin)}`)),
    holes: h,
  };
}

test("a custom NAND settles like a 74LS00 gate (a floating TTL input reads HIGH)", () => {
  const c = newCustomChip([]); // A=1, B=2, Y=3
  const b = bench(c, (h) => [wire(strip(h, 1), LO(3))]); // A low, B floats
  const r = b.run();
  assert.equal(r.chipStatus.get("c1").status, "ok");
  assert.equal(b.pin(3), H);
  const b2 = bench(c, () => []); // both float high
  b2.run();
  assert.equal(b2.pin(3), L);
  setCustomChips([]);
});

test("a custom D flip-flop clocks from a clock brick", () => {
  const c = chipWith({
    ports: [
      { name: "CLK", dir: "input", width: 1 },
      { name: "D", dir: "input", width: 1 },
      { name: "Q", dir: "output", width: 1 },
    ],
    units: [{ CLK: [1], D: [2], Q: [3] }],
    code: "reg q = 1'b0;\nalways @(posedge CLK) q <= D;\nassign Q = q;\n",
  });
  const b = bench(c, (h) => [wire("clk1.out", strip(h, 1))], { clock: true }); // D floats high
  b.run();
  assert.equal(b.pin(3), L);
  b.clock(H);
  assert.equal(b.pin(3), H);
  setCustomChips([]);
});

test("a dual unit chip: each unit its own state, a shared clock", () => {
  let c = chipWith({
    ports: [
      { name: "CLK", dir: "input", width: 1 },
      { name: "Q", dir: "output", width: 1 },
    ],
    units: [{ CLK: [1], Q: [2] }],
    code: "reg t = 1'b0;\nalways @(posedge CLK) t <= ~t;\nassign Q = t;\n",
  });
  c = setUnitCount(c, 2);
  c.units[1] = { CLK: [1], Q: [3] };
  const b = bench(c, (h) => [wire("clk1.out", strip(h, 1))], { clock: true });
  b.run();
  assert.deepEqual([b.pin(2), b.pin(3)], [L, L]);
  b.clock(H);
  assert.deepEqual([b.pin(2), b.pin(3)], [H, H]);
  b.clock(L);
  b.clock(H);
  assert.deepEqual([b.pin(2), b.pin(3)], [L, L]);
  setCustomChips([]);
});

test("a ripple: one custom toggle clocking another inside one tick", () => {
  let c = chipWith({
    ports: [
      { name: "CLK", dir: "input", width: 1 },
      { name: "Q", dir: "output", width: 1 },
    ],
    units: [{ CLK: [1], Q: [2] }],
    code: "reg t = 1'b0;\nalways @(negedge CLK) t <= ~t;\nassign Q = t;\n",
  });
  c = setUnitCount(c, 2);
  c.units[1] = { CLK: [4], Q: [5] };
  // Unit 1's Q drives unit 2's CLK: a two-stage ripple divider.
  const b = bench(
    c,
    (h) => [wire("clk1.out", strip(h, 1)), wire(strip(h, 2), strip(h, 4))],
    { clock: true },
  );
  b.run();
  const seen = [];
  for (let n = 0; n < 4; n++) {
    b.clock(H);
    b.clock(L);
    seen.push(`${b.pin(2)}${b.pin(5)}`);
  }
  assert.deepEqual(seen, ["HL", "LH", "HH", "LL"]);
  setCustomChips([]);
});

// ── The library and a project's copies ──────────────────────────────────────

test("the registry is the library, with the project's own copies standing in", () => {
  const a = chipWith({ id: "custom-0000000a", name: "A" });
  const b = chipWith({ id: "custom-0000000b", name: "B" });
  const own = { ...b, name: "B-OLD" };
  const only = chipWith({ id: "custom-0000000c", name: "ONLY" });
  assert.deepEqual(
    chipRegistry([a, b], [own, only]).map((c) => c.name),
    ["A", "B-OLD", "ONLY"],
    "library order, the project's copy in its place, project-only chips last",
  );
  assert.deepEqual(chipRegistry([], []), []);
});

test("what joins the library is what it lacks — never a replacement", () => {
  const a = chipWith({ id: "custom-0000000a" });
  const changed = { ...a, name: "CHANGED" };
  const fresh = chipWith({ id: "custom-0000000f" });
  assert.deepEqual(
    chipsMissingFrom([a], [changed, fresh]).map((c) => c.id),
    [fresh.id],
  );
});

test("the registry outgrows a stored list's cap without losing a chip", () => {
  const many = Array.from({ length: 300 }, (_v, i) =>
    chipWith({ id: `custom-${i.toString(16).padStart(8, "0")}` }),
  );
  setCustomChips(many);
  assert.equal(customChipDefs().length, 300);
  setCustomChips([]);
});
