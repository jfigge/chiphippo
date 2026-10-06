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

test("an inout port's pins are io pins, never shared between units", () => {
  let c = chipWith({
    ports: [
      { name: "D", dir: "inout", width: 2 },
      { name: "OE", dir: "input", width: 1 },
    ],
    units: [{ D: [1, 2], OE: [3] }],
    code: "assign D = OE ? 2'b10 : 2'bz;\n",
  });
  assert.deepEqual(customChipProblems(c), []);
  const pins = customPins(c);
  assert.deepEqual([pins[0].role, pins[1].role, pins[2].role], ["io", "io", "input"]); // prettier-ignore
  assert.equal(normalizeCustomChip(c).ports[0].dir, "inout");
  c = setUnitCount(c, 2);
  c.units[1] = { D: [1, 4], OE: [3] };
  assert.ok(customChipProblems(c).some((p) => p.code === "outputShared" && p.args.pin === 1)); // prettier-ignore
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

// ── An inout bus and a memory, through the engine ─────────────────────────

test("a 32K×8 SRAM written in Verilog behaves as the catalog's HM62256 beside it", () => {
  // The HM62256's own pinout: A0…A14, DQ0…DQ7, /CE 20, /OE 22, /WE 27.
  const ADDR = [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1];
  const DATA = [11, 12, 13, 15, 16, 17, 18, 19];
  const chip = chipWith({
    name: "SRAM32K",
    pinsPerSide: 14,
    wide: true,
    ports: [
      { name: "A", dir: "input", width: 15 },
      { name: "D", dir: "inout", width: 8 },
      { name: "CE_N", dir: "input", width: 1 },
      { name: "OE_N", dir: "input", width: 1 },
      { name: "WE_N", dir: "input", width: 1 },
    ],
    units: [{ A: ADDR, D: DATA, CE_N: [20], OE_N: [22], WE_N: [27] }],
    vcc: 28,
    gnd: 14,
    code: [
      "reg [7:0] mem [0:32767];",
      "always @(posedge WE_N) if (!CE_N) mem[A] <= D;",
      "assign D = (!CE_N && !OE_N && WE_N) ? mem[A] : 8'bz;",
      "",
    ].join("\n"),
  });
  assert.deepEqual(customChipProblems(chip), []);
  setCustomChips([chip]);
  const def = partDef(chip.id);
  assert.equal(def.customCompiled.ok, true);
  assert.deepEqual(
    DATA.map((n) => def.pins[n - 1].role),
    Array(8).fill("io"),
  );

  const ram = holesOf("HM62256", "e5");
  const twin = holesOf(chip.id, "e25");
  const flag = (id, hole) => ({ id, color: "red", type: "toggle", rest: "high", flag: { anchor: `bb1.${hole}`, rot: 0 } }); // prettier-ignore
  const signals = [
    flag("a0", mates(ram.get(10))[1]),
    flag("a14", mates(ram.get(1))[1]),
    flag("oe", mates(ram.get(22))[1]),
    flag("we", mates(ram.get(27))[1]),
    flag("ceRam", mates(ram.get(20))[1]),
    flag("ceTwin", mates(twin.get(20))[1]),
    ...DATA.map((n, b) => flag(`d${b}`, mates(ram.get(n))[1])),
  ];
  let rail = 2;
  const wires = [
    wire("psu1.+", HI(1)),
    wire("psu1.-", LO(1)),
    ...[ram, twin].flatMap((h) => [
      wire(strip(h, 28), HI(++rail)),
      wire(strip(h, 14), LO(rail)),
    ]),
    // Every pin of one chip to the same pin of the other — except /CE, so
    // each can be selected on its own.
    ...[...ADDR, ...DATA, 22, 27].map((n) => wire(strip(ram, n), strip(twin, n))), // prettier-ignore
    // The address lines no signal drives held low: A1…A13.
    ...ADDR.slice(1, 14).map((n) => wire(strip(ram, n, 1), LO(++rail))),
  ];
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
      { id: "ram", kind: "chip", ref: "HM62256", board: "bb1", anchor: "e5", params: {} }, // prettier-ignore
      { id: "c1", kind: "chip", ref: chip.id, board: "bb1", anchor: "e25", params: {} }, // prettier-ignore
    ],
    wires,
    signals,
  };
  const netlist = buildNetlist(doc);
  const image = new Uint8Array(32768);
  const images = new Map([["ram", image]]);
  const s = { warm: new Map(), state: new Map(), prev: new Map() };
  const levels = new Map();
  const set = (patch) => {
    for (const [id, level] of Object.entries(patch)) levels.set(id, level);
    const r = engineTick({
      document: doc,
      netlist,
      warmStart: s.warm,
      state: s.state,
      prevPinLevels: s.prev,
      signalLevels: new Map(levels),
      images,
    });
    s.warm = r.netLevels;
    s.state = r.state;
    s.prev = r.pinLevels;
    for (const w of r.memWrites)
      if (w.compId === "ram") image[w.addr] = w.value;
    return r;
  };
  const bus = () =>
    DATA.map((n) => s.warm.get(netlist.netOfPoint.get(`bb1.${ram.get(n)}`)))
      .reverse()
      .join("");
  const byte = (v) =>
    Array.from({ length: 8 }, (_v, b) => ((v >> (7 - b)) & 1 ? H : L)).join("");
  const drive = (v) =>
    Object.fromEntries(Array.from({ length: 8 }, (_v, b) => [`d${b}`, v == null ? Z : (v >> b) & 1 ? H : L])); // prettier-ignore
  const address = (a14, a0) => ({ a14: a14 ? H : L, a0: a0 ? H : L });

  // Deselected: nothing drives the bus.
  set({ ...address(0, 0), oe: H, we: H, ceRam: H, ceTwin: H, ...drive(null) });
  assert.equal(bus(), "ZZZZZZZZ");
  for (const r of [set({}), set({})]) {
    assert.equal(r.chipStatus.get("c1").status, "ok");
    assert.equal(r.chipStatus.get("ram").status, "ok");
  }

  // Write the same two bytes into both: a /WE pulse with both selected.
  const write = (a14, a0, v) => {
    set({ ...address(a14, a0), ...drive(v), ceRam: L, ceTwin: L });
    set({ we: L });
    set({ we: H });
    set({ ...drive(null), ceRam: H, ceTwin: H });
  };
  write(0, 1, 0x3e);
  write(1, 1, 0xc5);
  assert.equal(image[1], 0x3e);
  assert.equal(image[16385], 0xc5);

  // Read back from each alone, then from both at once — two drivers
  // agreeing, so no conflict: the twin answers exactly as the HM62256 does.
  for (const [a14, a0, v] of [
    [0, 1, 0x3e],
    [1, 1, 0xc5],
  ]) {
    set({ ...address(a14, a0), oe: L, ceRam: H, ceTwin: L });
    assert.equal(bus(), byte(v), "the twin alone");
    set({ ceRam: L, ceTwin: H });
    assert.equal(bus(), byte(v), "the HM62256 alone");
    const r = set({ ceTwin: L });
    assert.equal(bus(), byte(v), "both");
    assert.deepEqual(
      r.warnings.filter((w) => w.type === "conflict"),
      [],
    );
    set({ oe: H, ceRam: H, ceTwin: H });
    assert.equal(bus(), "ZZZZZZZZ");
  }

  // Something else driving the bus while the twin reads onto it: a fight.
  set({ ...address(0, 1), oe: L, ceTwin: L, ...drive(0x00) });
  const r = set({});
  assert.ok(r.warnings.some((w) => w.type === "conflict"));
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
