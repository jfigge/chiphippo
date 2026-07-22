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

// chips-mem.js — the memory wave (Feature 170): address-indexed ROM / SRAM /
// EEPROM on the wide DIP packages (DIP-24…40). Behavior is DATA over the ONE
// `memUnit` builder in sim/sequential.js — no per-chip evaluator code. Reads
// are combinational (the addressed word drives the data pins, or Z when
// deselected); writes are REPORTED by the engine and applied by the renderer's
// SimController, which owns the run-volatile byte image (Feature 180 makes it
// file-backed behind the same contract).
//
// Data pins carry the `io` role for writable parts (SRAM/EEPROM) and `output`
// for the read-only EPROM. A part's address/data buses are exposed as Feature
// 130 `pinGroups` so a whole bus wires in one gesture.
//
// Real 600-mil memories are wider than one breadboard trench; this stage models
// every DIP straddling the standard e/f rows (pin 1 at row e) so a part is
// buildable on one board — the `body: 600` hint in footprints.js is drawn/notes
// only. A true two-board straddle is a later footprint stage.

import { memUnit } from "../sim/sequential.js";

/** Pin builders (mirror chips-gates.js / chips-seq.js). */
const pin = (n, name, role) => ({ n, name, role });
const input = (n, name) => pin(n, name, "input");
const output = (n, name) => pin(n, name, "output");
/** A bidirectional data-bus pin (SRAM/EEPROM): read while writing, driven while reading. */
const io = (n, name) => pin(n, name, "io");
const nc = (n) => pin(n, "NC", "nc");
const gnd = (n, name = "GND") => pin(n, name, "gnd");
const vcc = (n) => pin(n, "VCC", "vcc");

/** A byte ramp (address N → byte N mod 256) — a satisfying out-of-the-box ROM demo. */
const rampBytes = (size) => {
  const a = new Uint8Array(size);
  for (let i = 0; i < size; i++) a[i] = i & 0xff;
  return a;
};

export const CHIPS_MEM = Object.freeze([
  // ── Generic teaching parts (clean logical pinouts) ──────────────────────────
  {
    id: "rom-8k",
    title: "8K×8 ROM",
    blurb:
      "Generic asynchronous 8K×8 read-only memory: drive the 13 address lines " +
      "and the addressed byte appears on the data pins while CE and OE are low; " +
      "the data pins float (high-Z) when deselected. Seeded with a byte ramp.",
    group: "Memory",
    package: "DIP-28",
    pins: [
      input(1, "A0"),
      input(2, "A1"),
      input(3, "A2"),
      input(4, "A3"),
      input(5, "A4"),
      input(6, "A5"),
      input(7, "A6"),
      input(8, "A7"),
      output(9, "Q0"),
      output(10, "Q1"),
      output(11, "Q2"),
      output(12, "Q3"),
      output(13, "Q4"),
      gnd(14),
      nc(15),
      nc(16),
      output(17, "Q5"),
      output(18, "Q6"),
      output(19, "Q7"),
      nc(20),
      input(21, "A8"),
      input(22, "A9"),
      input(23, "A10"),
      input(24, "A11"),
      input(25, "A12"),
      input(26, "CE"),
      input(27, "OE"),
      vcc(28),
    ],
    logic: memUnit({
      size: 8192,
      width: 8,
      addr: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25],
      data: [9, 10, 11, 12, 13, 17, 18, 19],
      ceN: 26,
      oeN: 27,
      initial: rampBytes,
    }),
    pinGroups: [
      {
        name: "A",
        pins: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25],
        dir: "in",
      },
      { name: "Q", pins: [9, 10, 11, 12, 13, 17, 18, 19], dir: "out" },
    ],
  },
  {
    id: "ram-8k",
    title: "8K×8 SRAM",
    blurb:
      "Generic asynchronous 8K×8 static RAM: while CE is low a low OE reads the " +
      "addressed byte onto the data pins, and a low WE writes the data present " +
      "on them. Data pins float (high-Z) when deselected. Contents reset on Run.",
    group: "Memory",
    package: "DIP-28",
    pins: [
      input(1, "A0"),
      input(2, "A1"),
      input(3, "A2"),
      input(4, "A3"),
      input(5, "A4"),
      input(6, "A5"),
      input(7, "A6"),
      input(8, "A7"),
      io(9, "DQ0"),
      io(10, "DQ1"),
      io(11, "DQ2"),
      io(12, "DQ3"),
      io(13, "DQ4"),
      gnd(14),
      nc(15),
      nc(16),
      io(17, "DQ5"),
      io(18, "DQ6"),
      io(19, "DQ7"),
      input(20, "WE"),
      input(21, "A8"),
      input(22, "A9"),
      input(23, "A10"),
      input(24, "A11"),
      input(25, "A12"),
      input(26, "CE"),
      input(27, "OE"),
      vcc(28),
    ],
    logic: memUnit({
      size: 8192,
      width: 8,
      addr: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25],
      data: [9, 10, 11, 12, 13, 17, 18, 19],
      ceN: 26,
      oeN: 27,
      weN: 20,
      volatile: true, // SRAM — lost at power-off, never file-backed
    }),
    pinGroups: [
      {
        name: "A",
        pins: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25],
        dir: "in",
      },
      { name: "DQ", pins: [9, 10, 11, 12, 13, 17, 18, 19], dir: "io" },
    ],
  },
  // ── Real parts (datasheet-exact pinouts) ────────────────────────────────────
  {
    id: "28C16",
    title: "2K×8 EEPROM",
    blurb:
      "2K×8 parallel EEPROM (28C16 shape): asynchronous read on CE·OE low; a " +
      "CE·WE-low cycle writes the byte on the data pins. Programming timing and " +
      "the internal write cycle are not modelled — the write is immediate.",
    group: "Memory",
    package: "DIP-24",
    pins: [
      input(1, "A7"),
      input(2, "A6"),
      input(3, "A5"),
      input(4, "A4"),
      input(5, "A3"),
      input(6, "A2"),
      input(7, "A1"),
      input(8, "A0"),
      io(9, "DQ0"),
      io(10, "DQ1"),
      io(11, "DQ2"),
      gnd(12),
      io(13, "DQ3"),
      io(14, "DQ4"),
      io(15, "DQ5"),
      io(16, "DQ6"),
      io(17, "DQ7"),
      input(18, "CE"),
      input(19, "A10"),
      input(20, "OE"),
      input(21, "WE"),
      input(22, "A9"),
      input(23, "A8"),
      vcc(24),
    ],
    logic: memUnit({
      size: 2048,
      width: 8,
      addr: [8, 7, 6, 5, 4, 3, 2, 1, 19, 22, 23],
      data: [9, 10, 11, 13, 14, 15, 16, 17],
      ceN: 18,
      oeN: 20,
      weN: 21,
    }),
    pinGroups: [
      { name: "A", pins: [8, 7, 6, 5, 4, 3, 2, 1, 19, 22, 23], dir: "in" },
      { name: "DQ", pins: [9, 10, 11, 13, 14, 15, 16, 17], dir: "io" },
    ],
  },
  {
    id: "HM62256",
    title: "32K×8 static RAM",
    blurb:
      "Hitachi HM62256-family 32K×8 low-power SRAM (600-mil DIP-28): CE·OE low " +
      "reads the addressed byte, CE·WE low writes the data-bus byte; data pins " +
      "float when deselected. Contents reset on Run.",
    group: "Memory",
    package: "DIP-28",
    pins: [
      input(1, "A14"),
      input(2, "A12"),
      input(3, "A7"),
      input(4, "A6"),
      input(5, "A5"),
      input(6, "A4"),
      input(7, "A3"),
      input(8, "A2"),
      input(9, "A1"),
      input(10, "A0"),
      io(11, "DQ0"),
      io(12, "DQ1"),
      io(13, "DQ2"),
      gnd(14),
      io(15, "DQ3"),
      io(16, "DQ4"),
      io(17, "DQ5"),
      io(18, "DQ6"),
      io(19, "DQ7"),
      input(20, "CE"),
      input(21, "A10"),
      input(22, "OE"),
      input(23, "A11"),
      input(24, "A9"),
      input(25, "A8"),
      input(26, "A13"),
      input(27, "WE"),
      vcc(28),
    ],
    logic: memUnit({
      size: 32768,
      width: 8,
      addr: [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1],
      data: [11, 12, 13, 15, 16, 17, 18, 19],
      ceN: 20,
      oeN: 22,
      weN: 27,
      volatile: true, // SRAM — lost at power-off, never file-backed
    }),
    pinGroups: [
      {
        name: "A",
        pins: [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1],
        dir: "in",
      },
      { name: "DQ", pins: [11, 12, 13, 15, 16, 17, 18, 19], dir: "io" },
    ],
  },
  {
    id: "AS6C1024",
    title: "128K×8 static RAM",
    blurb:
      "Alliance AS6C1024-family 128K×8 low-power SRAM (600-mil DIP-32): two " +
      "chip-enables (CE active-low AND CE2 active-high) gate the part; CE·OE " +
      "read, CE·WE write. Data pins float when deselected. Contents reset on Run.",
    group: "Memory",
    package: "DIP-32",
    pins: [
      nc(1),
      input(2, "A16"),
      input(3, "A14"),
      input(4, "A12"),
      input(5, "A7"),
      input(6, "A6"),
      input(7, "A5"),
      input(8, "A4"),
      input(9, "A3"),
      input(10, "A2"),
      input(11, "A1"),
      input(12, "A0"),
      io(13, "DQ0"),
      io(14, "DQ1"),
      io(15, "DQ2"),
      gnd(16, "VSS"),
      io(17, "DQ3"),
      io(18, "DQ4"),
      io(19, "DQ5"),
      io(20, "DQ6"),
      io(21, "DQ7"),
      input(22, "CE"),
      input(23, "A10"),
      input(24, "OE"),
      input(25, "A11"),
      input(26, "A9"),
      input(27, "A8"),
      input(28, "A13"),
      input(29, "WE"),
      input(30, "CE2"),
      input(31, "A15"),
      vcc(32),
    ],
    logic: memUnit({
      size: 131072,
      width: 8,
      addr: [12, 11, 10, 9, 8, 7, 6, 5, 27, 26, 23, 25, 4, 28, 3, 31, 2],
      data: [13, 14, 15, 17, 18, 19, 20, 21],
      ceN: 22,
      oeN: 24,
      weN: 29,
      ce2: 30,
      volatile: true, // SRAM — lost at power-off, never file-backed
    }),
    pinGroups: [
      {
        name: "A",
        pins: [12, 11, 10, 9, 8, 7, 6, 5, 27, 26, 23, 25, 4, 28, 3, 31, 2],
        dir: "in",
      },
      { name: "DQ", pins: [13, 14, 15, 17, 18, 19, 20, 21], dir: "io" },
    ],
  },
  {
    id: "AM27C1024",
    title: "64K×16 EPROM",
    blurb:
      "AMD/ST 27C1024-family 64K×16 UV EPROM (600-mil DIP-40, read-only here): " +
      "CE·OE low presents the addressed 16-bit word on Q0–Q15, else high-Z. Two " +
      "VSS pins — both must be grounded. Reads zeros until file-backed (later).",
    group: "Memory",
    package: "DIP-40",
    pins: [
      input(1, "VPP"),
      input(2, "CE"),
      output(3, "Q15"),
      output(4, "Q14"),
      output(5, "Q13"),
      output(6, "Q12"),
      output(7, "Q11"),
      output(8, "Q10"),
      output(9, "Q9"),
      output(10, "Q8"),
      gnd(11, "VSS"),
      output(12, "Q7"),
      output(13, "Q6"),
      output(14, "Q5"),
      output(15, "Q4"),
      output(16, "Q3"),
      output(17, "Q2"),
      output(18, "Q1"),
      output(19, "Q0"),
      input(20, "OE"),
      input(21, "A0"),
      input(22, "A1"),
      input(23, "A2"),
      input(24, "A3"),
      input(25, "A4"),
      input(26, "A5"),
      input(27, "A6"),
      input(28, "A7"),
      input(29, "A8"),
      gnd(30, "VSS"),
      input(31, "A9"),
      input(32, "A10"),
      input(33, "A11"),
      input(34, "A12"),
      input(35, "A13"),
      input(36, "A14"),
      input(37, "A15"),
      nc(38),
      input(39, "P"),
      vcc(40),
    ],
    logic: memUnit({
      size: 65536,
      width: 16,
      addr: [21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 34, 35, 36, 37],
      data: [19, 18, 17, 16, 15, 14, 13, 12, 10, 9, 8, 7, 6, 5, 4, 3],
      ceN: 2,
      oeN: 20,
    }),
    pinGroups: [
      {
        name: "A",
        pins: [21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 34, 35, 36, 37],
        dir: "in",
      },
      {
        name: "Q",
        pins: [19, 18, 17, 16, 15, 14, 13, 12, 10, 9, 8, 7, 6, 5, 4, 3],
        dir: "out",
      },
    ],
  },
]);
