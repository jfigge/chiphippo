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

// chips-gates.js — the combinational-gate wave of the 74xx catalog: real
// pinouts (Feature 40) AND behavior (Feature 80). Each def's `logic` block is
// DATA the generic evaluator (sim/chip-eval.js) walks — never per-chip code.
// A `logic` is `{ units: [{ fn, inputs: [pin…], output: pin, enable? }] }`
// with `fn ∈ NAND | NOR | AND | OR | XOR | INV | BUF3`. Unit pin numbers must
// match the `pins` table below (the catalog integrity test enforces it): the
// units cover every input- and output-role pin exactly once.
//
// Behavior only — power (VCC/GND), timing, and damage are the engine's job
// (Feature 90). The truth-table harness enumerates every unit exhaustively.

import { input, output, nc, gnd, vcc, unit, buf3 } from "./pin-builders.js";

export const CHIPS_GATES = Object.freeze([
  {
    id: "74LS00",
    title: "Quad 2-input NAND",
    blurb: "Four independent 2-input NAND gates — the classic TTL workhorse.",
    group: "NAND",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      input(2, "1B"),
      output(3, "1Y"),
      input(4, "2A"),
      input(5, "2B"),
      output(6, "2Y"),
      gnd(7),
      output(8, "3Y"),
      input(9, "3A"),
      input(10, "3B"),
      output(11, "4Y"),
      input(12, "4A"),
      input(13, "4B"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("NAND", [1, 2], 3),
        unit("NAND", [4, 5], 6),
        unit("NAND", [9, 10], 8),
        unit("NAND", [12, 13], 11),
      ],
    },
  },
  {
    id: "74LS02",
    title: "Quad 2-input NOR",
    blurb: "Four independent 2-input NOR gates (outputs on the low pins).",
    group: "NOR",
    package: "DIP-14",
    pins: [
      output(1, "1Y"),
      input(2, "1A"),
      input(3, "1B"),
      output(4, "2Y"),
      input(5, "2A"),
      input(6, "2B"),
      gnd(7),
      input(8, "3A"),
      input(9, "3B"),
      output(10, "3Y"),
      input(11, "4A"),
      input(12, "4B"),
      output(13, "4Y"),
      vcc(14),
    ],
    // NOR's outputs sit on the LOW pins — the unit wiring proves the order.
    logic: {
      units: [
        unit("NOR", [2, 3], 1),
        unit("NOR", [5, 6], 4),
        unit("NOR", [8, 9], 10),
        unit("NOR", [11, 12], 13),
      ],
    },
  },
  {
    id: "74LS04",
    title: "Hex inverter",
    blurb: "Six independent NOT gates.",
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
    id: "74LS08",
    title: "Quad 2-input AND",
    blurb: "Four independent 2-input AND gates.",
    group: "AND",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      input(2, "1B"),
      output(3, "1Y"),
      input(4, "2A"),
      input(5, "2B"),
      output(6, "2Y"),
      gnd(7),
      output(8, "3Y"),
      input(9, "3A"),
      input(10, "3B"),
      output(11, "4Y"),
      input(12, "4A"),
      input(13, "4B"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("AND", [1, 2], 3),
        unit("AND", [4, 5], 6),
        unit("AND", [9, 10], 8),
        unit("AND", [12, 13], 11),
      ],
    },
  },
  {
    id: "74LS10",
    title: "Triple 3-input NAND",
    blurb: "Three independent 3-input NAND gates.",
    group: "NAND",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      input(2, "1B"),
      input(3, "2A"),
      input(4, "2B"),
      input(5, "2C"),
      output(6, "2Y"),
      gnd(7),
      output(8, "3Y"),
      input(9, "3A"),
      input(10, "3B"),
      input(11, "3C"),
      output(12, "1Y"),
      input(13, "1C"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("NAND", [1, 2, 13], 12),
        unit("NAND", [3, 4, 5], 6),
        unit("NAND", [9, 10, 11], 8),
      ],
    },
  },
  {
    id: "74LS11",
    title: "Triple 3-input AND",
    blurb: "Three independent 3-input AND gates.",
    group: "AND",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      input(2, "1B"),
      input(3, "2A"),
      input(4, "2B"),
      input(5, "2C"),
      output(6, "2Y"),
      gnd(7),
      output(8, "3Y"),
      input(9, "3A"),
      input(10, "3B"),
      input(11, "3C"),
      output(12, "1Y"),
      input(13, "1C"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("AND", [1, 2, 13], 12),
        unit("AND", [3, 4, 5], 6),
        unit("AND", [9, 10, 11], 8),
      ],
    },
  },
  {
    id: "74LS20",
    title: "Dual 4-input NAND",
    blurb: "Two independent 4-input NAND gates.",
    group: "NAND",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      input(2, "1B"),
      nc(3),
      input(4, "1C"),
      input(5, "1D"),
      output(6, "1Y"),
      gnd(7),
      output(8, "2Y"),
      input(9, "2A"),
      input(10, "2B"),
      nc(11),
      input(12, "2C"),
      input(13, "2D"),
      vcc(14),
    ],
    logic: {
      units: [unit("NAND", [1, 2, 4, 5], 6), unit("NAND", [9, 10, 12, 13], 8)],
    },
  },
  {
    id: "74LS27",
    title: "Triple 3-input NOR",
    blurb: "Three independent 3-input NOR gates.",
    group: "NOR",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      input(2, "1B"),
      input(3, "2A"),
      input(4, "2B"),
      input(5, "2C"),
      output(6, "2Y"),
      gnd(7),
      output(8, "3Y"),
      input(9, "3A"),
      input(10, "3B"),
      input(11, "3C"),
      output(12, "1Y"),
      input(13, "1C"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("NOR", [1, 2, 13], 12),
        unit("NOR", [3, 4, 5], 6),
        unit("NOR", [9, 10, 11], 8),
      ],
    },
  },
  {
    id: "74LS30",
    title: "8-input NAND",
    blurb: "A single 8-input NAND gate.",
    group: "NAND",
    package: "DIP-14",
    pins: [
      input(1, "A"),
      input(2, "B"),
      input(3, "C"),
      input(4, "D"),
      input(5, "E"),
      input(6, "F"),
      gnd(7),
      output(8, "Y"),
      nc(9),
      nc(10),
      input(11, "G"),
      input(12, "H"),
      nc(13),
      vcc(14),
    ],
    logic: {
      units: [unit("NAND", [1, 2, 3, 4, 5, 6, 11, 12], 8)],
    },
  },
  {
    id: "74LS32",
    title: "Quad 2-input OR",
    blurb: "Four independent 2-input OR gates.",
    group: "OR",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      input(2, "1B"),
      output(3, "1Y"),
      input(4, "2A"),
      input(5, "2B"),
      output(6, "2Y"),
      gnd(7),
      output(8, "3Y"),
      input(9, "3A"),
      input(10, "3B"),
      output(11, "4Y"),
      input(12, "4A"),
      input(13, "4B"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("OR", [1, 2], 3),
        unit("OR", [4, 5], 6),
        unit("OR", [9, 10], 8),
        unit("OR", [12, 13], 11),
      ],
    },
  },
  {
    id: "74LS86",
    title: "Quad 2-input XOR",
    blurb: "Four independent 2-input exclusive-OR gates.",
    group: "XOR",
    package: "DIP-14",
    pins: [
      input(1, "1A"),
      input(2, "1B"),
      output(3, "1Y"),
      input(4, "2A"),
      input(5, "2B"),
      output(6, "2Y"),
      gnd(7),
      output(8, "3Y"),
      input(9, "3A"),
      input(10, "3B"),
      output(11, "4Y"),
      input(12, "4A"),
      input(13, "4B"),
      vcc(14),
    ],
    logic: {
      units: [
        unit("XOR", [1, 2], 3),
        unit("XOR", [4, 5], 6),
        unit("XOR", [9, 10], 8),
        unit("XOR", [12, 13], 11),
      ],
    },
  },
  {
    id: "74LS125",
    title: "Quad bus buffer, tri-state",
    blurb:
      "Four independent buffers with active-low output-enable (tri-state).",
    group: "Buffer",
    package: "DIP-14",
    // ACTIVE-LOW output enable(s): one per buffer — each gates its own Y. Declared so the AI
    // prompt can name them and the verifier can say "tie pin N low"
    // instead of "nothing drives it"; proved against the evaluator
    // in tests/chips-tristate.test.js.
    outputEnable: Object.freeze([1, 4, 10, 13]),
    pins: [
      input(1, "1G"),
      input(2, "1A"),
      output(3, "1Y"),
      input(4, "2G"),
      input(5, "2A"),
      output(6, "2Y"),
      gnd(7),
      output(8, "3Y"),
      input(9, "3A"),
      input(10, "3G"),
      output(11, "4Y"),
      input(12, "4A"),
      input(13, "4G"),
      vcc(14),
    ],
    // Each buffer drives its output only while its G (enable) is LOW; a HIGH
    // (or floating → HIGH) enable puts the output in high-impedance (Z).
    logic: {
      units: [buf3(2, 1, 3), buf3(5, 4, 6), buf3(9, 10, 8), buf3(12, 13, 11)],
    },
  },
]);
