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

// chips-seq.js — the sequential & MSI wave of the 74xx catalog (Feature 100):
// flip-flops, latches, counters, shift registers, decoders, and multiplexers.
// Datasheet-exact pinouts (including the non-standard power pins of the 74LS73 /
// 74LS75 / 74LS76 — real parts don't always put VCC/GND on the corners). Behavior
// is DATA + the pure family builders in sim/sequential.js — no per-chip engine
// code. Stateful parts carry a `logic` block of `{ state0, step, outputs }`;
// combinational decoders/mux carry `logic.units` of `COMB` units the generic
// evaluator walks.

import {
  seqChip,
  dffUnit,
  jkUnit,
  latchUnit,
  syncCounter4,
  upDownCounter4,
  shiftSipo,
  shiftPiso,
  decoderUnits,
  muxUnits,
  selectorUnits,
} from "../sim/sequential.js";
import { H, L } from "../sim/levels.js";

/** Pin builders (mirror chips-gates.js). */
const pin = (n, name, role) => ({ n, name, role });
const input = (n, name) => pin(n, name, "input");
const output = (n, name) => pin(n, name, "output");
const gnd = (n) => pin(n, "GND", "gnd");
const vcc = (n) => pin(n, "VCC", "vcc");

export const CHIPS_SEQ = Object.freeze([
  {
    id: "74LS73",
    title: "Dual JK flip-flop, clear",
    blurb:
      "Two negative-edge JK flip-flops with async active-low clear (no preset).",
    group: "Flip-flop",
    package: "DIP-14",
    pins: [
      input(1, "1CLK"),
      input(2, "1CLR"),
      input(3, "1K"),
      vcc(4),
      input(5, "2CLK"),
      input(6, "2CLR"),
      input(7, "2J"),
      output(8, "2Q̄"),
      output(9, "2Q"),
      input(10, "2K"),
      gnd(11),
      output(12, "1Q"),
      output(13, "1Q̄"),
      input(14, "1J"),
    ],
    logic: seqChip([
      jkUnit({ j: 14, k: 3, clk: 1, clrN: 2, q: 12, qn: 13, edge: "fall" }),
      jkUnit({ j: 7, k: 10, clk: 5, clrN: 6, q: 9, qn: 8, edge: "fall" }),
    ]),
  },
  {
    id: "74LS74",
    title: "Dual D flip-flop, preset & clear",
    blurb:
      "Two positive-edge D flip-flops with async active-low preset and clear.",
    group: "Flip-flop",
    package: "DIP-14",
    pins: [
      input(1, "1CLR"),
      input(2, "1D"),
      input(3, "1CLK"),
      input(4, "1PRE"),
      output(5, "1Q"),
      output(6, "1Q̄"),
      gnd(7),
      output(8, "2Q̄"),
      output(9, "2Q"),
      input(10, "2PRE"),
      input(11, "2CLK"),
      input(12, "2D"),
      input(13, "2CLR"),
      vcc(14),
    ],
    logic: seqChip([
      dffUnit({ d: 2, clk: 3, preN: 4, clrN: 1, q: 5, qn: 6, edge: "rise" }),
      dffUnit({
        d: 12,
        clk: 11,
        preN: 10,
        clrN: 13,
        q: 9,
        qn: 8,
        edge: "rise",
      }),
    ]),
  },
  {
    id: "74LS75",
    title: "4-bit bistable latch",
    blurb:
      "Four transparent D latches; while its enable is HIGH a latch follows D, " +
      "otherwise it holds. Enables are shared in pairs (non-standard power pins).",
    group: "Latch",
    package: "DIP-16",
    pins: [
      output(1, "1Q̄"),
      input(2, "1D"),
      input(3, "2D"),
      input(4, "E34"),
      vcc(5),
      input(6, "3D"),
      input(7, "4D"),
      output(8, "4Q̄"),
      output(9, "4Q"),
      output(10, "3Q"),
      output(11, "3Q̄"),
      gnd(12),
      input(13, "E12"),
      output(14, "2Q̄"),
      output(15, "2Q"),
      output(16, "1Q"),
    ],
    logic: seqChip([
      latchUnit({ d: 2, en: 13, q: 16, qn: 1 }),
      latchUnit({ d: 3, en: 13, q: 15, qn: 14 }),
      latchUnit({ d: 6, en: 4, q: 10, qn: 11 }),
      latchUnit({ d: 7, en: 4, q: 9, qn: 8 }),
    ]),
  },
  {
    id: "74LS76",
    title: "Dual JK flip-flop, preset & clear",
    blurb:
      "Two negative-edge JK flip-flops with async active-low preset and clear " +
      "(non-standard power pins).",
    group: "Flip-flop",
    package: "DIP-16",
    pins: [
      input(1, "1CLK"),
      input(2, "1PRE"),
      input(3, "1CLR"),
      input(4, "1J"),
      vcc(5),
      input(6, "2CLK"),
      input(7, "2PRE"),
      input(8, "2CLR"),
      input(9, "2J"),
      output(10, "2Q̄"),
      output(11, "2Q"),
      input(12, "2K"),
      gnd(13),
      output(14, "1Q"),
      output(15, "1Q̄"),
      input(16, "1K"),
    ],
    logic: seqChip([
      jkUnit({
        j: 4,
        k: 16,
        clk: 1,
        preN: 2,
        clrN: 3,
        q: 14,
        qn: 15,
        edge: "fall",
      }),
      jkUnit({
        j: 9,
        k: 12,
        clk: 6,
        preN: 7,
        clrN: 8,
        q: 11,
        qn: 10,
        edge: "fall",
      }),
    ]),
  },
  {
    id: "74107",
    title: "Dual JK flip-flop, clear",
    blurb:
      "Two negative-edge JK flip-flops with async active-low clear (no preset).",
    group: "Flip-flop",
    package: "DIP-14",
    pins: [
      input(1, "1J"),
      output(2, "1Q̄"),
      output(3, "1Q"),
      input(4, "1K"),
      output(5, "2Q"),
      output(6, "2Q̄"),
      gnd(7),
      input(8, "2J"),
      input(9, "2CLK"),
      input(10, "2CLR"),
      input(11, "2K"),
      input(12, "1CLK"),
      input(13, "1CLR"),
      vcc(14),
    ],
    logic: seqChip([
      jkUnit({ j: 1, k: 4, clk: 12, clrN: 13, q: 3, qn: 2, edge: "fall" }),
      jkUnit({ j: 8, k: 11, clk: 9, clrN: 10, q: 5, qn: 6, edge: "fall" }),
    ]),
  },
  {
    id: "74175",
    title: "Quad D flip-flop",
    blurb:
      "Four positive-edge D flip-flops with a common clock and common " +
      "async active-low clear.",
    group: "Flip-flop",
    package: "DIP-16",
    pins: [
      input(1, "CLR"),
      output(2, "1Q"),
      output(3, "1Q̄"),
      input(4, "1D"),
      input(5, "2D"),
      output(6, "2Q̄"),
      output(7, "2Q"),
      gnd(8),
      input(9, "CLK"),
      output(10, "3Q"),
      output(11, "3Q̄"),
      input(12, "3D"),
      input(13, "4D"),
      output(14, "4Q̄"),
      output(15, "4Q"),
      vcc(16),
    ],
    logic: seqChip([
      dffUnit({ d: 4, clk: 9, clrN: 1, q: 2, qn: 3, edge: "rise" }),
      dffUnit({ d: 5, clk: 9, clrN: 1, q: 7, qn: 6, edge: "rise" }),
      dffUnit({ d: 12, clk: 9, clrN: 1, q: 10, qn: 11, edge: "rise" }),
      dffUnit({ d: 13, clk: 9, clrN: 1, q: 15, qn: 14, edge: "rise" }),
    ]),
  },
  {
    id: "74161",
    title: "Sync 4-bit binary counter",
    blurb:
      "Presettable synchronous 4-bit counter: async clear, sync load, " +
      "count-enable P & T, ripple-carry out.",
    group: "Counter",
    package: "DIP-16",
    pins: [
      input(1, "CLR"),
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
    logic: syncCounter4({
      clk: 2,
      clrN: 1,
      loadN: 9,
      enP: 7,
      enT: 10,
      data: [3, 4, 5, 6],
      q: [14, 13, 12, 11],
      rco: 15,
    }),
  },
  {
    id: "74193",
    title: "Sync up/down 4-bit counter",
    blurb:
      "Synchronous 4-bit up/down counter with separate up and down clocks, " +
      "async parallel load, async master reset, carry and borrow.",
    group: "Counter",
    package: "DIP-16",
    pins: [
      input(1, "B"),
      output(2, "QB"),
      output(3, "QA"),
      input(4, "CPD"),
      input(5, "CPU"),
      output(6, "QC"),
      output(7, "QD"),
      gnd(8),
      input(9, "D"),
      input(10, "C"),
      input(11, "LOAD"),
      output(12, "CO"),
      output(13, "BO"),
      input(14, "CLR"),
      input(15, "A"),
      vcc(16),
    ],
    logic: upDownCounter4({
      cpu: 5,
      cpd: 4,
      loadN: 11,
      clr: 14,
      data: [15, 1, 10, 9],
      q: [3, 2, 6, 7],
      coN: 12,
      boN: 13,
    }),
  },
  {
    id: "74164",
    title: "8-bit SIPO shift register",
    blurb:
      "Serial-in parallel-out 8-bit shift register (serial data is A AND B) " +
      "with async active-low clear.",
    group: "Shift register",
    package: "DIP-14",
    pins: [
      input(1, "A"),
      input(2, "B"),
      output(3, "Q0"),
      output(4, "Q1"),
      output(5, "Q2"),
      output(6, "Q3"),
      gnd(7),
      input(8, "CLK"),
      input(9, "CLR"),
      output(10, "Q4"),
      output(11, "Q5"),
      output(12, "Q6"),
      output(13, "Q7"),
      vcc(14),
    ],
    logic: shiftSipo({
      a: 1,
      b: 2,
      clk: 8,
      clrN: 9,
      q: [3, 4, 5, 6, 10, 11, 12, 13],
    }),
  },
  {
    id: "74165",
    title: "8-bit PISO shift register",
    blurb:
      "Parallel-in serial-out 8-bit shift register: async parallel load, " +
      "clock inhibit, serial input, and complementary serial outputs.",
    group: "Shift register",
    package: "DIP-16",
    pins: [
      input(1, "LOAD"),
      input(2, "CLK"),
      input(3, "E"),
      input(4, "F"),
      input(5, "G"),
      input(6, "H"),
      output(7, "Q̄H"),
      gnd(8),
      output(9, "QH"),
      input(10, "SER"),
      input(11, "A"),
      input(12, "B"),
      input(13, "C"),
      input(14, "D"),
      input(15, "INH"),
      vcc(16),
    ],
    logic: shiftPiso({
      shLdN: 1,
      clk: 2,
      clkInhN: 15,
      ser: 10,
      data: [11, 12, 13, 14, 3, 4, 5, 6],
      qh: 9,
      qhN: 7,
    }),
  },
  {
    id: "74138",
    title: "3-to-8 line decoder",
    blurb:
      "One-of-eight active-low decoder with three enables (G1 high, G2A & " +
      "G2B low to enable).",
    group: "Decoder",
    package: "DIP-16",
    pins: [
      input(1, "A"),
      input(2, "B"),
      input(3, "C"),
      input(4, "G2A"),
      input(5, "G2B"),
      input(6, "G1"),
      output(7, "Y7"),
      gnd(8),
      output(9, "Y6"),
      output(10, "Y5"),
      output(11, "Y4"),
      output(12, "Y3"),
      output(13, "Y2"),
      output(14, "Y1"),
      output(15, "Y0"),
      vcc(16),
    ],
    logic: {
      units: decoderUnits({
        sel: [1, 2, 3],
        enable: [6, 4, 5],
        enabled: (byPin) =>
          byPin.get(6) === H && byPin.get(4) === L && byPin.get(5) === L,
        out: [15, 14, 13, 12, 11, 10, 9, 7],
      }),
    },
  },
  {
    id: "74139",
    title: "Dual 2-to-4 line decoder",
    blurb:
      "Two independent one-of-four active-low decoders, each with an " +
      "active-low enable.",
    group: "Decoder",
    package: "DIP-16",
    pins: [
      input(1, "1G"),
      input(2, "1A"),
      input(3, "1B"),
      output(4, "1Y0"),
      output(5, "1Y1"),
      output(6, "1Y2"),
      output(7, "1Y3"),
      gnd(8),
      output(9, "2Y3"),
      output(10, "2Y2"),
      output(11, "2Y1"),
      output(12, "2Y0"),
      input(13, "2B"),
      input(14, "2A"),
      input(15, "2G"),
      vcc(16),
    ],
    logic: {
      units: [
        ...decoderUnits({
          sel: [2, 3],
          enable: [1],
          enabled: (byPin) => byPin.get(1) === L,
          out: [4, 5, 6, 7],
        }),
        ...decoderUnits({
          sel: [14, 13],
          enable: [15],
          enabled: (byPin) => byPin.get(15) === L,
          out: [12, 11, 10, 9],
        }),
      ],
    },
  },
  {
    id: "74151",
    title: "8-to-1 line multiplexer",
    blurb:
      "Eight-input mux with 3 select lines, active-low strobe, and " +
      "complementary outputs.",
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
    id: "74157",
    title: "Quad 2-to-1 selector",
    blurb:
      "Four 2-input multiplexers sharing one select and an active-low enable " +
      "(select low → A, high → B).",
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
]);
