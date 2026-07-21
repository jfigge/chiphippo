/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// chips-74ls.js — the 74LS wave: a broad batch of Low-power Schottky parts,
// datasheet-exact pinouts (TI SDLS sheets) with DATA-only behavior. Every def
// reuses the shared vocabulary (sim/chip-eval.js gate/COMB units and the pure
// family builders in sim/sequential.js) — never per-chip evaluator code. Where
// the batch needed shapes the vocabulary lacked (single-clock up/down counter,
// tri-state register/latch, addressable latch, SR latch, 595 shift+storage,
// decade counter, inverting/tri-state bus drivers), the builder was ADDED to
// sequential.js and this file only supplies pin maps.
//
// Schottky vs plain TTL is an analog speed/power distinction the zero-delay,
// power-agnostic engine doesn't model, so a 74LSxx behaves identically to its
// 74xx cousin here — the value is the real pinouts and the wider part shelf.

import {
  seqChip,
  jkUnit,
  dffUnit,
  muxUnits,
  selectorUnits,
  selectorTsUnits,
  busDriverUnits,
  adder4Units,
  comparator4Units,
  priorityEncoder8Units,
  bcd7segUnits,
  upDownCounter4Sync,
  registerTs4,
  latchTs,
  addressableLatch8,
  srLatchUnit,
  shiftRegister595,
  decadeCounter7490,
} from "../sim/sequential.js";

/** Pin builders (mirror chips-gates.js / chips-seq.js). */
const pin = (n, name, role) => ({ n, name, role });
const input = (n, name) => pin(n, name, "input");
const output = (n, name) => pin(n, name, "output");
const nc = (n) => pin(n, "NC", "nc");
const gnd = (n) => pin(n, "GND", "gnd");
const vcc = (n) => pin(n, "VCC", "vcc");
const unit = (fn, inputs, output) => ({ fn, inputs, output });
/** A tri-state buffer: `data` in, active-low `enable`, `output` (74125-style). */
const buf3 = (data, enable, output) => ({
  fn: "BUF3",
  inputs: [data],
  enable,
  output,
});

// The 7447 segment font: for BCD value 0…15, which of segments a…g light
// (1 = on). The classic quirks are baked in — 6 has no top bar (a off), 9 no
// bottom bar (d off), and 10…15 are the datasheet's non-numeric patterns.
const SEG7_PATTERNS = Object.freeze(
  [
    [1, 1, 1, 1, 1, 1, 0], // 0
    [0, 1, 1, 0, 0, 0, 0], // 1
    [1, 1, 0, 1, 1, 0, 1], // 2
    [1, 1, 1, 1, 0, 0, 1], // 3
    [0, 1, 1, 0, 0, 1, 1], // 4
    [1, 0, 1, 1, 0, 1, 1], // 5
    [0, 0, 1, 1, 1, 1, 1], // 6 (no top bar)
    [1, 1, 1, 0, 0, 0, 0], // 7
    [1, 1, 1, 1, 1, 1, 1], // 8
    [1, 1, 1, 0, 0, 1, 1], // 9 (no bottom bar)
    [0, 0, 0, 1, 1, 0, 1], // 10
    [0, 0, 1, 1, 0, 0, 1], // 11
    [0, 1, 0, 0, 0, 1, 1], // 12
    [1, 0, 0, 1, 0, 1, 1], // 13
    [0, 0, 0, 1, 1, 1, 1], // 14
    [0, 0, 0, 0, 0, 0, 0], // 15 (blank)
  ].map((row) => Object.freeze(row)),
);

export const CHIPS_74LS = Object.freeze([
  // ── Inverters ──────────────────────────────────────────────────────────────
  {
    id: "74LS05",
    title: "Hex inverter (open-collector)",
    blurb:
      "Six independent NOT gates with open-collector outputs (the outputs " +
      "pull low only — an external pull-up is assumed; modelled as a plain " +
      "inverter here).",
    group: "Inverter",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      output(2, "1Y"),
      input(3, "2A"),
      output(4, "2Y"),
      input(5, "3A"),
      output(6, "3Y"),
      gnd(7),
      output(8, "4Y"),
      input(9, "4A"),
      output(10, "5Y"),
      input(11, "5A"),
      output(12, "6Y"),
      input(13, "6A"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("INV", [1], 2),
        unit("INV", [3], 4),
        unit("INV", [5], 6),
        unit("INV", [9], 8),
        unit("INV", [11], 10),
        unit("INV", [13], 12),
      ],
    },
  },
  {
    id: "74LS14",
    title: "Hex Schmitt-trigger inverter",
    blurb:
      "Six inverters with Schmitt-trigger inputs (input hysteresis cleans up " +
      "slow/noisy edges — an analog property the logic sim treats as a plain " +
      "inverter).",
    group: "Inverter",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      output(2, "1Y"),
      input(3, "2A"),
      output(4, "2Y"),
      input(5, "3A"),
      output(6, "3Y"),
      gnd(7),
      output(8, "4Y"),
      input(9, "4A"),
      output(10, "5Y"),
      input(11, "5A"),
      output(12, "6Y"),
      input(13, "6A"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("INV", [1], 2),
        unit("INV", [3], 4),
        unit("INV", [5], 6),
        unit("INV", [9], 8),
        unit("INV", [11], 10),
        unit("INV", [13], 12),
      ],
    },
  },

  // ── Flip-flops / registers ───────────────────────────────────────────────
  {
    id: "74LS112",
    title: "Dual JK flip-flop, preset & clear",
    blurb:
      "Two negative-edge JK flip-flops, each with async active-low preset and " +
      "clear.",
    group: "Flip-flop",
    package: "DIP-16",
    pins: [
      input(1, "1CLK"),
      input(2, "1K"),
      input(3, "1J"),
      input(4, "1PRE"),
      output(5, "1Q"),
      output(6, "1Q̄"),
      output(7, "2Q̄"),
      gnd(8),
      output(9, "2Q"),
      input(10, "2PRE"),
      input(11, "2J"),
      input(12, "2K"),
      input(13, "2CLK"),
      input(14, "2CLR"),
      input(15, "1CLR"),
      vcc(16),
    ],
    logic: seqChip([
      jkUnit({
        j: 3,
        k: 2,
        clk: 1,
        preN: 4,
        clrN: 15,
        q: 5,
        qn: 6,
        edge: "fall",
      }),
      jkUnit({
        j: 11,
        k: 12,
        clk: 13,
        preN: 10,
        clrN: 14,
        q: 9,
        qn: 7,
        edge: "fall",
      }),
    ]),
  },
  {
    id: "74LS173",
    title: "4-bit D register, tri-state",
    blurb:
      "Positive-edge 4-bit D register with 3-state outputs: two active-low " +
      "output-enables (M̄,N̄), two active-low data-enables (G1̄,G2̄, both low to " +
      "load), and an active-HIGH clear.",
    group: "Register",
    package: "DIP-16",
    pins: [
      input(1, "M"),
      input(2, "N"),
      output(3, "1Q"),
      output(4, "2Q"),
      output(5, "3Q"),
      output(6, "4Q"),
      input(7, "CLK"),
      gnd(8),
      input(9, "G1"),
      input(10, "G2"),
      input(11, "4D"),
      input(12, "3D"),
      input(13, "2D"),
      input(14, "1D"),
      input(15, "CLR"),
      vcc(16),
    ],
    logic: registerTs4({
      clk: 7,
      clr: 15,
      gN: [9, 10],
      oeN: [1, 2],
      d: [14, 13, 12, 11],
      q: [3, 4, 5, 6],
    }),
  },
  {
    id: "74LS174",
    title: "Hex D flip-flop",
    blurb:
      "Six positive-edge D flip-flops with a common clock and common " +
      "async active-low clear (Q outputs only).",
    group: "Flip-flop",
    package: "DIP-16",
    pins: [
      input(1, "CLR"),
      output(2, "1Q"),
      input(3, "1D"),
      input(4, "2D"),
      output(5, "2Q"),
      input(6, "3D"),
      output(7, "3Q"),
      gnd(8),
      input(9, "CLK"),
      output(10, "4Q"),
      input(11, "4D"),
      output(12, "5Q"),
      input(13, "5D"),
      input(14, "6D"),
      output(15, "6Q"),
      vcc(16),
    ],
    logic: seqChip([
      dffUnit({ d: 3, clk: 9, clrN: 1, q: 2, edge: "rise" }),
      dffUnit({ d: 4, clk: 9, clrN: 1, q: 5, edge: "rise" }),
      dffUnit({ d: 6, clk: 9, clrN: 1, q: 7, edge: "rise" }),
      dffUnit({ d: 11, clk: 9, clrN: 1, q: 10, edge: "rise" }),
      dffUnit({ d: 13, clk: 9, clrN: 1, q: 12, edge: "rise" }),
      dffUnit({ d: 14, clk: 9, clrN: 1, q: 15, edge: "rise" }),
    ]),
  },
  {
    id: "74LS273",
    title: "Octal D flip-flop, clear",
    blurb:
      "Eight positive-edge D flip-flops with a common clock and common " +
      "async active-low clear (master reset).",
    group: "Flip-flop",
    package: "DIP-20",
    pins: [
      input(1, "CLR"),
      output(2, "1Q"),
      input(3, "1D"),
      input(4, "2D"),
      output(5, "2Q"),
      output(6, "3Q"),
      input(7, "3D"),
      input(8, "4D"),
      output(9, "4Q"),
      gnd(10),
      input(11, "CLK"),
      output(12, "5Q"),
      input(13, "5D"),
      input(14, "6D"),
      output(15, "6Q"),
      output(16, "7Q"),
      input(17, "7D"),
      input(18, "8D"),
      output(19, "8Q"),
      vcc(20),
    ],
    logic: seqChip([
      dffUnit({ d: 3, clk: 11, clrN: 1, q: 2, edge: "rise" }),
      dffUnit({ d: 4, clk: 11, clrN: 1, q: 5, edge: "rise" }),
      dffUnit({ d: 7, clk: 11, clrN: 1, q: 6, edge: "rise" }),
      dffUnit({ d: 8, clk: 11, clrN: 1, q: 9, edge: "rise" }),
      dffUnit({ d: 13, clk: 11, clrN: 1, q: 12, edge: "rise" }),
      dffUnit({ d: 14, clk: 11, clrN: 1, q: 15, edge: "rise" }),
      dffUnit({ d: 17, clk: 11, clrN: 1, q: 16, edge: "rise" }),
      dffUnit({ d: 18, clk: 11, clrN: 1, q: 19, edge: "rise" }),
    ]),
  },
  {
    id: "74LS279",
    title: "Quad S̄R̄ latch",
    blurb:
      "Four cross-coupled NAND (S̄R̄) latches: S̄ low sets, R̄ low resets, both " +
      "high holds. Latches 1 and 3 have two set inputs (either low sets).",
    group: "Latch",
    package: "DIP-16",
    pins: [
      input(1, "1R"),
      input(2, "1S1"),
      input(3, "1S2"),
      output(4, "1Q"),
      input(5, "2R"),
      input(6, "2S"),
      output(7, "2Q"),
      gnd(8),
      output(9, "3Q"),
      input(10, "3R"),
      input(11, "3S1"),
      input(12, "3S2"),
      output(13, "4Q"),
      input(14, "4R"),
      input(15, "4S"),
      vcc(16),
    ],
    logic: seqChip([
      srLatchUnit({ sN: [2, 3], rN: 1, q: 4 }),
      srLatchUnit({ sN: 6, rN: 5, q: 7 }),
      srLatchUnit({ sN: [11, 12], rN: 10, q: 9 }),
      srLatchUnit({ sN: 15, rN: 14, q: 13 }),
    ]),
  },

  // ── Multiplexers / selectors ─────────────────────────────────────────────
  {
    id: "74LS151",
    title: "8-to-1 line multiplexer",
    blurb:
      "Eight-input mux with 3 select lines, active-low strobe, and " +
      "complementary outputs (Y and W̄).",
    group: "Multiplexer",
    package: "DIP-16",
    pins: [
      input(1, "D3"),
      input(2, "D2"),
      input(3, "D1"),
      input(4, "D0"),
      output(5, "Y"),
      output(6, "W"),
      input(7, "G"),
      gnd(8),
      input(9, "C"),
      input(10, "B"),
      input(11, "A"),
      input(12, "D7"),
      input(13, "D6"),
      input(14, "D5"),
      input(15, "D4"),
      vcc(16),
    ],
    logic: {
      units: muxUnits({
        sel: [11, 10, 9],
        data: [4, 3, 2, 1, 15, 14, 13, 12],
        strobeN: 7,
        y: 5,
        yn: 6,
      }),
    },
  },
  {
    id: "74LS153",
    title: "Dual 4-to-1 multiplexer",
    blurb:
      "Two independent 4-input muxes sharing two select lines, each with its " +
      "own active-low strobe (disabled → output LOW).",
    group: "Multiplexer",
    package: "DIP-16",
    pins: [
      input(1, "1G"),
      input(2, "B"),
      input(3, "1C3"),
      input(4, "1C2"),
      input(5, "1C1"),
      input(6, "1C0"),
      output(7, "1Y"),
      gnd(8),
      output(9, "2Y"),
      input(10, "2C0"),
      input(11, "2C1"),
      input(12, "2C2"),
      input(13, "2C3"),
      input(14, "A"),
      input(15, "2G"),
      vcc(16),
    ],
    logic: {
      units: [
        ...muxUnits({ sel: [14, 2], data: [6, 5, 4, 3], strobeN: 1, y: 7 }),
        ...muxUnits({
          sel: [14, 2],
          data: [10, 11, 12, 13],
          strobeN: 15,
          y: 9,
        }),
      ],
    },
  },
  {
    id: "74LS157",
    title: "Quad 2-to-1 selector",
    blurb:
      "Four 2-input multiplexers sharing one select and an active-low enable " +
      "(select low → A, high → B; disabled → output LOW).",
    group: "Multiplexer",
    package: "DIP-16",
    pins: [
      input(1, "S"),
      input(2, "1A"),
      input(3, "1B"),
      output(4, "1Y"),
      input(5, "2A"),
      input(6, "2B"),
      output(7, "2Y"),
      gnd(8),
      output(9, "3Y"),
      input(10, "3B"),
      input(11, "3A"),
      output(12, "4Y"),
      input(13, "4B"),
      input(14, "4A"),
      input(15, "G"),
      vcc(16),
    ],
    logic: {
      units: selectorUnits({
        sel: 1,
        strobeN: 15,
        units: [
          { a: 2, b: 3, y: 4 },
          { a: 5, b: 6, y: 7 },
          { a: 11, b: 10, y: 9 },
          { a: 14, b: 13, y: 12 },
        ],
      }),
    },
  },
  {
    id: "74LS257",
    title: "Quad 2-to-1 selector, tri-state",
    blurb:
      "Four 2-input multiplexers sharing one select and an active-low " +
      "output-enable — disabled outputs go high-impedance (the '157 with " +
      "3-state outputs).",
    group: "Multiplexer",
    package: "DIP-16",
    pins: [
      input(1, "S"),
      input(2, "1A"),
      input(3, "1B"),
      output(4, "1Y"),
      input(5, "2A"),
      input(6, "2B"),
      output(7, "2Y"),
      gnd(8),
      output(9, "3Y"),
      input(10, "3B"),
      input(11, "3A"),
      output(12, "4Y"),
      input(13, "4B"),
      input(14, "4A"),
      input(15, "OE"),
      vcc(16),
    ],
    logic: {
      units: selectorTsUnits({
        sel: 1,
        oeN: 15,
        units: [
          { a: 2, b: 3, y: 4 },
          { a: 5, b: 6, y: 7 },
          { a: 11, b: 10, y: 9 },
          { a: 14, b: 13, y: 12 },
        ],
      }),
    },
  },

  // ── Octal bus buffers / line drivers ─────────────────────────────────────
  {
    id: "74LS240",
    title: "Octal buffer/line driver, inverting, tri-state",
    blurb:
      "Eight inverting 3-state buffers in two 4-bit groups, each with an " +
      "active-low output-enable; inputs and outputs on opposite package sides.",
    group: "Buffer",
    package: "DIP-20",
    pins: [
      input(1, "1G"),
      input(2, "1A1"),
      output(3, "2Y4"),
      input(4, "1A2"),
      output(5, "2Y3"),
      input(6, "1A3"),
      output(7, "2Y2"),
      input(8, "1A4"),
      output(9, "2Y1"),
      gnd(10),
      input(11, "2A1"),
      output(12, "1Y4"),
      input(13, "2A2"),
      output(14, "1Y3"),
      input(15, "2A3"),
      output(16, "1Y2"),
      input(17, "2A4"),
      output(18, "1Y1"),
      input(19, "2G"),
      vcc(20),
    ],
    logic: {
      units: [
        ...busDriverUnits({
          enableN: 1,
          invert: true,
          pairs: [
            { a: 2, y: 18 },
            { a: 4, y: 16 },
            { a: 6, y: 14 },
            { a: 8, y: 12 },
          ],
        }),
        ...busDriverUnits({
          enableN: 19,
          invert: true,
          pairs: [
            { a: 11, y: 9 },
            { a: 13, y: 7 },
            { a: 15, y: 5 },
            { a: 17, y: 3 },
          ],
        }),
      ],
    },
  },
  {
    id: "74LS244",
    title: "Octal buffer/line driver, tri-state",
    blurb:
      "Eight non-inverting 3-state buffers in two 4-bit groups, each with an " +
      "active-low output-enable; inputs and outputs on opposite package sides.",
    group: "Buffer",
    package: "DIP-20",
    pins: [
      input(1, "1G"),
      input(2, "1A1"),
      output(3, "2Y4"),
      input(4, "1A2"),
      output(5, "2Y3"),
      input(6, "1A3"),
      output(7, "2Y2"),
      input(8, "1A4"),
      output(9, "2Y1"),
      gnd(10),
      input(11, "2A1"),
      output(12, "1Y4"),
      input(13, "2A2"),
      output(14, "1Y3"),
      input(15, "2A3"),
      output(16, "1Y2"),
      input(17, "2A4"),
      output(18, "1Y1"),
      input(19, "2G"),
      vcc(20),
    ],
    logic: {
      units: [
        buf3(2, 1, 18),
        buf3(4, 1, 16),
        buf3(6, 1, 14),
        buf3(8, 1, 12),
        buf3(11, 19, 9),
        buf3(13, 19, 7),
        buf3(15, 19, 5),
        buf3(17, 19, 3),
      ],
    },
  },

  // ── Decoders / arithmetic / comparators ──────────────────────────────────
  {
    id: "74LS47",
    title: "BCD to 7-segment decoder/driver",
    blurb:
      "Decodes BCD (A–D) to active-low seven-segment drives (a–g) for a " +
      "common-anode display, with lamp-test (LT̄), ripple-blank-in (RBĪ), and " +
      "a blanking input (BĪ) that forces every segment off. Pairs with the " +
      "seg8 display.",
    group: "Display driver",
    package: "DIP-16",
    pins: [
      input(1, "B"),
      input(2, "C"),
      input(3, "LT"),
      input(4, "BI"),
      input(5, "RBI"),
      input(6, "D"),
      input(7, "A"),
      gnd(8),
      output(9, "e"),
      output(10, "d"),
      output(11, "c"),
      output(12, "b"),
      output(13, "a"),
      output(14, "g"),
      output(15, "f"),
      vcc(16),
    ],
    logic: {
      units: bcd7segUnits({
        bcd: [7, 1, 2, 6], // A, B, C, D (LSB first)
        biN: 4,
        ltN: 3,
        rbiN: 5,
        seg: [13, 12, 11, 10, 9, 15, 14], // a, b, c, d, e, f, g
        patterns: SEG7_PATTERNS,
      }),
    },
  },
  {
    id: "74LS85",
    title: "4-bit magnitude comparator",
    blurb:
      "Compares two 4-bit words A and B, driving A>B / A=B / A<B; three " +
      "cascade inputs chain stages into a wider comparator.",
    group: "Comparator",
    package: "DIP-16",
    pins: [
      input(1, "B3"),
      input(2, "IA<B"),
      input(3, "IA=B"),
      input(4, "IA>B"),
      output(5, "A>B"),
      output(6, "A=B"),
      output(7, "A<B"),
      gnd(8),
      input(9, "B0"),
      input(10, "A0"),
      input(11, "B1"),
      input(12, "A1"),
      input(13, "A2"),
      input(14, "B2"),
      input(15, "A3"),
      vcc(16),
    ],
    logic: {
      units: comparator4Units({
        a: [10, 12, 13, 15], // A0..A3 (LSB first)
        b: [9, 11, 14, 1], // B0..B3 (LSB first)
        gtIn: 4,
        eqIn: 3,
        ltIn: 2,
        gtOut: 5,
        eqOut: 6,
        ltOut: 7,
      }),
    },
  },
  {
    id: "74LS148",
    title: "8-to-3 priority encoder",
    blurb:
      "Encodes eight active-low inputs to a 3-bit active-low code of the " +
      "highest-priority active line, with enable-in, group-strobe, and " +
      "enable-out for cascading.",
    group: "Encoder",
    package: "DIP-16",
    pins: [
      input(1, "4"),
      input(2, "5"),
      input(3, "6"),
      input(4, "7"),
      input(5, "EI"),
      output(6, "A2"),
      output(7, "A1"),
      gnd(8),
      output(9, "A0"),
      input(10, "0"),
      input(11, "1"),
      input(12, "2"),
      input(13, "3"),
      output(14, "GS"),
      output(15, "EO"),
      vcc(16),
    ],
    logic: {
      units: priorityEncoder8Units({
        data: [10, 11, 12, 13, 1, 2, 3, 4], // I0..I7
        eiN: 5,
        a: [9, 7, 6], // A0, A1, A2
        gsN: 14,
        eoN: 15,
      }),
    },
  },
  {
    id: "74LS283",
    title: "4-bit binary full adder",
    blurb:
      "Adds two 4-bit words plus a carry-in with internal carry-lookahead, " +
      "driving a 4-bit sum and carry-out.",
    group: "Arithmetic",
    package: "DIP-16",
    pins: [
      output(1, "S2"),
      input(2, "B2"),
      input(3, "A2"),
      output(4, "S1"),
      input(5, "A1"),
      input(6, "B1"),
      input(7, "C0"),
      gnd(8),
      output(9, "C4"),
      output(10, "S4"),
      input(11, "B4"),
      input(12, "A4"),
      output(13, "S3"),
      input(14, "A3"),
      input(15, "B3"),
      vcc(16),
    ],
    logic: {
      units: adder4Units({
        a: [5, 3, 14, 12], // A1..A4 (LSB first)
        b: [6, 2, 15, 11], // B1..B4 (LSB first)
        cin: 7,
        s: [4, 1, 13, 10], // S1..S4 (LSB first)
        cout: 9,
      }),
    },
  },

  // ── Counter / addressable latch / octal latches / shift register ─────────
  {
    id: "74LS169",
    title: "Sync 4-bit up/down counter",
    blurb:
      "Synchronous 4-bit binary up/down counter: one clock, a direction " +
      "input (U/D̄, high = up), active-low count-enables (ENP̄, ENT̄), " +
      "synchronous active-low load, and active-low ripple carry.",
    group: "Counter",
    package: "DIP-16",
    pins: [
      input(1, "U/D"),
      input(2, "CLK"),
      input(3, "A"),
      input(4, "B"),
      input(5, "C"),
      input(6, "D"),
      input(7, "ENP"),
      gnd(8),
      input(9, "LOAD"),
      input(10, "ENT"),
      output(11, "QD"),
      output(12, "QC"),
      output(13, "QB"),
      output(14, "QA"),
      output(15, "RCO"),
      vcc(16),
    ],
    logic: upDownCounter4Sync({
      clk: 2,
      updn: 1,
      enPN: 7,
      enTN: 10,
      loadN: 9,
      data: [3, 4, 5, 6],
      q: [14, 13, 12, 11],
      rcoN: 15,
    }),
  },
  {
    id: "74LS259",
    title: "8-bit addressable latch",
    blurb:
      "Eight addressable latches: three address lines pick one of eight " +
      "outputs. Modes via Ḡ and CLR̄ — addressable latch, memory, 1-of-8 " +
      "demultiplexer, and clear.",
    group: "Latch",
    package: "DIP-16",
    pins: [
      input(1, "A0"),
      input(2, "A1"),
      input(3, "A2"),
      output(4, "Q0"),
      output(5, "Q1"),
      output(6, "Q2"),
      output(7, "Q3"),
      gnd(8),
      output(9, "Q4"),
      output(10, "Q5"),
      output(11, "Q6"),
      output(12, "Q7"),
      input(13, "D"),
      input(14, "G"),
      input(15, "CLR"),
      vcc(16),
    ],
    logic: addressableLatch8({
      sel: [1, 2, 3],
      d: 13,
      gN: 14,
      clrN: 15,
      q: [4, 5, 6, 7, 9, 10, 11, 12],
    }),
  },
  {
    id: "74LS533",
    title: "Octal transparent latch, inverting, tri-state",
    blurb:
      "Eight transparent D latches with inverting 3-state outputs (the '373 " +
      "interleaved pinout): latch-enable LE is transparent while high; the " +
      "active-low output-enable floats the pins.",
    group: "Latch",
    package: "DIP-20",
    pins: [
      input(1, "OE"),
      output(2, "1Q̄"),
      input(3, "1D"),
      input(4, "2D"),
      output(5, "2Q̄"),
      output(6, "3Q̄"),
      input(7, "3D"),
      input(8, "4D"),
      output(9, "4Q̄"),
      gnd(10),
      input(11, "LE"),
      output(12, "5Q̄"),
      input(13, "5D"),
      input(14, "6D"),
      output(15, "6Q̄"),
      output(16, "7Q̄"),
      input(17, "7D"),
      input(18, "8D"),
      output(19, "8Q̄"),
      vcc(20),
    ],
    logic: latchTs({
      d: [3, 4, 7, 8, 13, 14, 17, 18],
      q: [2, 5, 6, 9, 12, 15, 16, 19],
      le: 11,
      oeN: 1,
      invert: true,
    }),
  },
  {
    id: "74LS573",
    title: "Octal transparent latch, tri-state",
    blurb:
      "Eight transparent D latches with non-inverting 3-state outputs " +
      "(flow-through pinout — all D on one side, all Q on the other): " +
      "latch-enable LE is transparent while high; active-low output-enable.",
    group: "Latch",
    package: "DIP-20",
    pins: [
      input(1, "OE"),
      input(2, "1D"),
      input(3, "2D"),
      input(4, "3D"),
      input(5, "4D"),
      input(6, "5D"),
      input(7, "6D"),
      input(8, "7D"),
      input(9, "8D"),
      gnd(10),
      input(11, "LE"),
      output(12, "8Q"),
      output(13, "7Q"),
      output(14, "6Q"),
      output(15, "5Q"),
      output(16, "4Q"),
      output(17, "3Q"),
      output(18, "2Q"),
      output(19, "1Q"),
      vcc(20),
    ],
    logic: latchTs({
      d: [2, 3, 4, 5, 6, 7, 8, 9],
      q: [19, 18, 17, 16, 15, 14, 13, 12],
      le: 11,
      oeN: 1,
    }),
  },
  {
    id: "74LS595",
    title: "8-bit shift register, output latch",
    blurb:
      "Serial-in, parallel-out 8-bit shift register with a separate output " +
      "storage latch and 3-state parallel outputs: a shift clock and a latch " +
      "clock, active-low output-enable, active-low shift-register reset, and " +
      "a serial output (QH′) for daisy-chaining.",
    group: "Shift register",
    package: "DIP-16",
    pins: [
      output(1, "QB"),
      output(2, "QC"),
      output(3, "QD"),
      output(4, "QE"),
      output(5, "QF"),
      output(6, "QG"),
      output(7, "QH"),
      gnd(8),
      output(9, "QH'"),
      input(10, "SRCLR"),
      input(11, "SRCLK"),
      input(12, "RCLK"),
      input(13, "OE"),
      input(14, "SER"),
      output(15, "QA"),
      vcc(16),
    ],
    logic: shiftRegister595({
      ds: 14,
      shcp: 11,
      stcp: 12,
      mrN: 10,
      oeN: 13,
      q: [15, 1, 2, 3, 4, 5, 6, 7], // QA..QH
      q7s: 9,
    }),
  },
  {
    id: "74LS90",
    title: "Decade (÷10) ripple counter",
    blurb:
      "Decade counter built from a ÷2 section (CKA→QA) and a ÷5 section " +
      "(CKB→QB,QC,QD), both falling-edge; gated reset-to-zero (R0) and " +
      "set-to-nine (R9). Wire QA→CKB for a BCD count. Non-standard power pins.",
    group: "Counter",
    package: "DIP-14",
    pins: [
      input(1, "CKB"),
      input(2, "R0(1)"),
      input(3, "R0(2)"),
      nc(4),
      vcc(5),
      input(6, "R9(1)"),
      input(7, "R9(2)"),
      output(8, "QC"),
      output(9, "QB"),
      gnd(10),
      output(11, "QD"),
      output(12, "QA"),
      nc(13),
      input(14, "CKA"),
    ],
    logic: decadeCounter7490({
      cka: 14,
      ckb: 1,
      r0: [2, 3],
      r9: [6, 7],
      qa: 12,
      qb: 9,
      qc: 8,
      qd: 11,
    }),
  },
]);
