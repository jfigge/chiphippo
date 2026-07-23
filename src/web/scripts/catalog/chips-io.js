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

// chips-io.js — the 65xx peripheral-interface wave: the WDC W65C21 PIA and
// W65C22 VIA, the CMOS 6521/6522. These are microprocessor peripherals, not
// TTL logic: a register file addressed over a bus (RSx / CSx / RWB / PHI2 /
// D0–D7) plus bidirectional I/O ports and, on the VIA, two timers and a shift
// register. Behavior is DATA referencing the pure state machines in
// sim/w65c21.js / sim/w65c22.js — the same "genuine per-part code behind the
// standard sequential contract" pattern the HD44780 uses. Datasheet-exact
// 40-pin DIP pinouts (WDC W65C21 / W65C22 data sheets, Figure 2 / Figure 3-1).
//
// There is no CPU in this catalog, so the bus is driven BY HAND: set the address
// (RSx), chip selects, RWB, and (for a write) D0–D7, then pulse PHI2 — the
// transfer commits on PHI2's falling edge, exactly as the LCD latches on E.

import { w65c21Unit } from "../sim/w65c21.js";
import { w65c22Unit } from "../sim/w65c22.js";
import { w65c02Unit } from "../sim/w65c02.js";

/** Pin builders (mirror chips-seq.js / chips-mem.js). */
const pin = (n, name, role) => ({ n, name, role });
const input = (n, name) => pin(n, name, "input");
const output = (n, name) => pin(n, name, "output");
/** A bidirectional line: the data bus, an I/O port bit, or a control line. */
const io = (n, name) => pin(n, name, "io");
const nc = (n) => pin(n, "NC", "nc");
const gnd = (n, name = "VSS") => pin(n, name, "gnd");
const vcc = (n, name = "VDD") => pin(n, name, "vcc");

export const CHIPS_IO = Object.freeze([
  {
    id: "w65c21",
    title: "W65C21 PIA",
    blurb:
      "WDC W65C21 Peripheral Interface Adapter (CMOS 6521/6821): two 8-bit " +
      "bidirectional ports (PA/PB) with per-line data-direction registers, plus " +
      "four handshake/interrupt control lines (CA1/CA2, CB1/CB2). Address a " +
      "register with RS0/RS1 (+ control-register bit 2), select the chip with " +
      "CS0·CS1 high and CS2B low, set RWB, and pulse PHI2 — writes latch on " +
      "PHI2's falling edge. IRQAB/IRQBB are open-drain (wire a pull-up).",
    group: "Interface",
    package: "DIP-40",
    pins: [
      gnd(1),
      io(2, "PA0"),
      io(3, "PA1"),
      io(4, "PA2"),
      io(5, "PA3"),
      io(6, "PA4"),
      io(7, "PA5"),
      io(8, "PA6"),
      io(9, "PA7"),
      io(10, "PB0"),
      io(11, "PB1"),
      io(12, "PB2"),
      io(13, "PB3"),
      io(14, "PB4"),
      io(15, "PB5"),
      io(16, "PB6"),
      io(17, "PB7"),
      input(18, "CB1"),
      io(19, "CB2"),
      vcc(20),
      input(21, "RWB"),
      input(22, "CS0"),
      input(23, "CS2B"),
      input(24, "CS1"),
      input(25, "PHI2"),
      io(26, "D7"),
      io(27, "D6"),
      io(28, "D5"),
      io(29, "D4"),
      io(30, "D3"),
      io(31, "D2"),
      io(32, "D1"),
      io(33, "D0"),
      input(34, "RESB"),
      input(35, "RS1"),
      input(36, "RS0"),
      output(37, "IRQBB"),
      output(38, "IRQAB"),
      io(39, "CA2"),
      input(40, "CA1"),
    ],
    logic: w65c21Unit({
      pa: [2, 3, 4, 5, 6, 7, 8, 9],
      pb: [10, 11, 12, 13, 14, 15, 16, 17],
      d: [33, 32, 31, 30, 29, 28, 27, 26], // D0…D7
      ca1: 40,
      ca2: 39,
      cb1: 18,
      cb2: 19,
      rs0: 36,
      rs1: 35,
      cs0: 22,
      cs1: 24,
      cs2b: 23,
      rwb: 21,
      phi2: 25,
      resb: 34,
      irqab: 38,
      irqbb: 37,
    }),
    pinGroups: [
      { name: "PA", pins: [2, 3, 4, 5, 6, 7, 8, 9], dir: "io" },
      { name: "PB", pins: [10, 11, 12, 13, 14, 15, 16, 17], dir: "io" },
      { name: "D", pins: [33, 32, 31, 30, 29, 28, 27, 26], dir: "io" },
    ],
  },
  {
    id: "w65c22",
    title: "W65C22 VIA",
    blurb:
      "WDC W65C22 Versatile Interface Adapter (CMOS 6522): two 8-bit " +
      "bidirectional ports (PA/PB) with data-direction registers, two 16-bit " +
      "interval timers (T1/T2), an 8-bit shift register, and CA1/CA2/CB1/CB2 " +
      "handshake lines. Address one of 16 registers with RS0–RS3, select with " +
      "CS1 high and CS2B low, set RWB, and pulse PHI2 (writes latch on the " +
      "falling edge). Timers count PHI2 cycles; IRQB is open-drain. Logic-level " +
      "only — no wall-clock timing.",
    group: "Interface",
    package: "DIP-40",
    pins: [
      gnd(1),
      io(2, "PA0"),
      io(3, "PA1"),
      io(4, "PA2"),
      io(5, "PA3"),
      io(6, "PA4"),
      io(7, "PA5"),
      io(8, "PA6"),
      io(9, "PA7"),
      io(10, "PB0"),
      io(11, "PB1"),
      io(12, "PB2"),
      io(13, "PB3"),
      io(14, "PB4"),
      io(15, "PB5"),
      io(16, "PB6"),
      io(17, "PB7"),
      io(18, "CB1"),
      io(19, "CB2"),
      vcc(20),
      output(21, "IRQB"),
      input(22, "RWB"),
      input(23, "CS2B"),
      input(24, "CS1"),
      input(25, "PHI2"),
      io(26, "D7"),
      io(27, "D6"),
      io(28, "D5"),
      io(29, "D4"),
      io(30, "D3"),
      io(31, "D2"),
      io(32, "D1"),
      io(33, "D0"),
      input(34, "RESB"),
      input(35, "RS3"),
      input(36, "RS2"),
      input(37, "RS1"),
      input(38, "RS0"),
      io(39, "CA2"),
      input(40, "CA1"),
    ],
    logic: w65c22Unit({
      pa: [2, 3, 4, 5, 6, 7, 8, 9],
      pb: [10, 11, 12, 13, 14, 15, 16, 17],
      d: [33, 32, 31, 30, 29, 28, 27, 26], // D0…D7
      ca1: 40,
      ca2: 39,
      cb1: 18,
      cb2: 19,
      rs: [38, 37, 36, 35], // RS0, RS1, RS2, RS3
      cs1: 24,
      cs2b: 23,
      rwb: 22,
      phi2: 25,
      resb: 34,
      irqb: 21,
    }),
    pinGroups: [
      { name: "PA", pins: [2, 3, 4, 5, 6, 7, 8, 9], dir: "io" },
      { name: "PB", pins: [10, 11, 12, 13, 14, 15, 16, 17], dir: "io" },
      { name: "D", pins: [33, 32, 31, 30, 29, 28, 27, 26], dir: "io" },
    ],
  },
  {
    id: "w65c02",
    title: "W65C02 CPU",
    blurb:
      "WDC W65C02S 8-bit microprocessor — the heart of the 65xx computer. Wire " +
      "A0–A15 to the address bus, D0–D7 to the data bus, RWB to RAM/ROM " +
      "write/output-enable logic, and clock PHI2: one memory access per cycle, " +
      "so the address bus advances as it runs. Boots from the reset vector at " +
      "$FFFC/$FFFD (it powers up in reset — wire RESB to a button to hold it). " +
      "IRQB/NMIB are the maskable / non-maskable interrupt inputs; SYNC pulses " +
      "high on each opcode fetch. Logic-level, bus-access-accurate.",
    group: "Interface",
    package: "DIP-40",
    pins: [
      output(1, "VPB"),
      input(2, "RDY"),
      output(3, "PHI1O"),
      input(4, "IRQB"),
      output(5, "MLB"),
      input(6, "NMIB"),
      output(7, "SYNC"),
      vcc(8),
      output(9, "A0"),
      output(10, "A1"),
      output(11, "A2"),
      output(12, "A3"),
      output(13, "A4"),
      output(14, "A5"),
      output(15, "A6"),
      output(16, "A7"),
      output(17, "A8"),
      output(18, "A9"),
      output(19, "A10"),
      output(20, "A11"),
      gnd(21),
      output(22, "A12"),
      output(23, "A13"),
      output(24, "A14"),
      output(25, "A15"),
      io(26, "D7"),
      io(27, "D6"),
      io(28, "D5"),
      io(29, "D4"),
      io(30, "D3"),
      io(31, "D2"),
      io(32, "D1"),
      io(33, "D0"),
      output(34, "RWB"),
      nc(35),
      input(36, "BE"),
      input(37, "PHI2"),
      input(38, "SOB"),
      output(39, "PHI2O"),
      input(40, "RESB"),
    ],
    logic: w65c02Unit({
      addr: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25],
      data: [33, 32, 31, 30, 29, 28, 27, 26], // D0…D7
      rwb: 34,
      sync: 7,
      phi2: 37,
      resb: 40,
      irqb: 4,
      nmib: 6,
      rdy: 2,
      be: 36,
      vpb: 1,
      mlb: 5,
      phi1o: 3,
      phi2o: 39,
    }),
    pinGroups: [
      {
        name: "A",
        pins: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25],
        dir: "out",
      },
      { name: "D", pins: [33, 32, 31, 30, 29, 28, 27, 26], dir: "io" },
    ],
  },
]);
