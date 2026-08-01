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

// chips-cpu.js — the PROCESSOR wave: the two 8-bit microprocessors this app can
// actually run a program on. Each is a full instruction-set simulation living in
// sim/ behind the STANDARD sequential contract ({ state0, step, outputs }) — the
// same "genuine per-part code behind a standard contract" pattern the 65xx
// peripherals and the HD44780 use, just a great deal more of it.
//
// ── The two disagree about the clock, and it shows on the pins ───────────────
// The W65C02 makes exactly ONE bus access per PHI2 cycle, so its address bus
// advances once per clock and sim/w65c02.js needs no notion of a sub-cycle.
// The Z80 does not: an opcode fetch is four T-states with a REFRESH cycle glued
// to its back half, a memory read is three, an I/O cycle is four. So sim/z80.js
// runs a real M-cycle / T-state machine off a single CLK — which is what makes
// /M1, /RFSH and /WAIT mean anything — and a Z80 instruction therefore takes
// several clock cycles where a 6502 one takes a few. Both are correct; they are
// simply different parts, and the transport's speed control is there for it.
//
// ── Naming ───────────────────────────────────────────────────────────────────
// A pin carries the name its own manufacturer prints. WDC really does spell its
// active-low pins with a trailing B (RWB, IRQB, RESB), so the W65C02 does. Zilog
// prints an overbar, which this app has no way to draw, so the Z80 uses the
// leading slash that every Z80 schematic and databook falls back to in ASCII —
// thirteen of its pins are active low and eight of those are outputs, so "which
// of these is asserted low" is the question the pin map most needs to answer.

import { w65c02Unit } from "../sim/w65c02.js";
import { z80Unit } from "../sim/z80.js";
import { input, output, io, nc, gnd, vcc } from "./pin-builders.js";

export const CHIPS_CPU = Object.freeze([
  {
    id: "W65C02",
    title: "W65C02 CPU",
    blurb:
      "WDC W65C02S 8-bit microprocessor — the heart of the 65xx computer. Wire " +
      "A0–A15 to the address bus, D0–D7 to the data bus, RWB to RAM/ROM " +
      "write/output-enable logic, and clock PHI2: one memory access per cycle, " +
      "so the address bus advances as it runs. Boots from the reset vector at " +
      "$FFFC/$FFFD (it powers up in reset — wire RESB to a button to hold it). " +
      "IRQB/NMIB are the maskable / non-maskable interrupt inputs; SYNC pulses " +
      "high on each opcode fetch. Logic-level, bus-access-accurate.",
    group: "PROCESSOR",
    package: "DIP-40",
    pins: [
      output(1, "VPB"),
      input(2, "RDY"),
      output(3, "PHI1O"),
      input(4, "IRQB"),
      output(5, "MLB"),
      input(6, "NMIB"),
      output(7, "SYNC"),
      vcc(8, "VDD"),
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
      gnd(21, "VSS"),
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
  {
    id: "Z80A",
    title: "Z80A CPU",
    blurb:
      "Zilog Z80A 8-bit microprocessor — the other half of the 8-bit era. Wire " +
      "A0–A15 to the address bus, D0–D7 to the data bus, /MREQ to RAM/ROM chip " +
      "select and /RD//WR to output-enable and write, then clock CLK: a real " +
      "M-cycle/T-state machine, so /M1 marks each opcode fetch and /RFSH pulses " +
      "the refresh address behind it. /IORQ picks out a separate 256-port I/O " +
      "space — the thing the 65xx bus has no equivalent for. Boots at $0000 " +
      "with no reset vector (it powers up in reset — wire /RESET to a button to " +
      "hold it). /INT is maskable in three interrupt modes and /NMI is not; " +
      "/WAIT stretches a cycle and /BUSRQ//BUSACK hand the buses over. EVERY " +
      "control line is active LOW. Logic-level, bus-cycle-accurate.",
    group: "PROCESSOR",
    package: "DIP-40",
    pins: [
      output(1, "A11"),
      output(2, "A12"),
      output(3, "A13"),
      output(4, "A14"),
      output(5, "A15"),
      input(6, "CLK"),
      io(7, "D4"),
      io(8, "D3"),
      io(9, "D5"),
      io(10, "D6"),
      vcc(11),
      io(12, "D2"),
      io(13, "D7"),
      io(14, "D0"),
      io(15, "D1"),
      input(16, "/INT"),
      input(17, "/NMI"),
      output(18, "/HALT"),
      output(19, "/MREQ"),
      output(20, "/IORQ"),
      output(21, "/RD"),
      output(22, "/WR"),
      output(23, "/BUSACK"),
      input(24, "/WAIT"),
      input(25, "/BUSRQ"),
      input(26, "/RESET"),
      output(27, "/M1"),
      output(28, "/RFSH"),
      gnd(29),
      output(30, "A0"),
      output(31, "A1"),
      output(32, "A2"),
      output(33, "A3"),
      output(34, "A4"),
      output(35, "A5"),
      output(36, "A6"),
      output(37, "A7"),
      output(38, "A8"),
      output(39, "A9"),
      output(40, "A10"),
    ],
    logic: z80Unit({
      // A0…A15 — the run wraps from one side of the package to the other, which
      // is simply where Zilog put them.
      addr: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2, 3, 4, 5],
      data: [14, 15, 12, 8, 7, 9, 10, 13], // D0…D7 — famously scrambled
      clk: 6,
      m1: 27,
      mreq: 19,
      iorq: 20,
      rd: 21,
      wr: 22,
      rfsh: 28,
      halt: 18,
      busak: 23,
      int: 16,
      nmi: 17,
      wait: 24,
      busrq: 25,
      reset: 26,
    }),
    pinGroups: [
      {
        name: "A",
        pins: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2, 3, 4, 5],
        dir: "out",
      },
      { name: "D", pins: [14, 15, 12, 8, 7, 9, 10, 13], dir: "io" },
    ],
  },
]);
