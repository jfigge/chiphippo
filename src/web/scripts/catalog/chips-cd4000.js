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

// chips-cd4000.js — the CD4000B CMOS family (Feature 400): the basic gates,
// the buffers, D and JK flip-flops, the counters, a shift-and-store register,
// a decoder and a display driver. The family is stamped on in
// catalog/index.js, which is what makes every floating input here read
// UNKNOWN rather than HIGH (catalog/families.js) and holds each part to the
// 3–18 V CMOS supply range instead of TTL's 5 V.
//
// EVERY PINOUT IS FROM THE PART'S TI DATASHEET, cited at each def by its
// literature number. Most of these are Harris originals that TI scanned, whose
// diagrams are images — so they were read from rendered pages, not from the
// text layer. Pin NAMES are the datasheet's own (A–M for gate inputs and
// outputs, `0`–`9` for the 4017/4022/4028's decoded outputs, VDD/VSS for
// power — VCC on the 4049/4050, whose current sheet prints it so), which is
// why they look nothing like the 74LS parts' `1A`/`1Y`. An active-LOW input or
// output drops the sheet's bar (the 4511's LT and BL, the counters' CARRY IN
// and CARRY OUT), as the 74LS parts' names do; its blurb says which it is.
//
// Behaviour is data over the same vocabulary as the TTL parts: gate units for
// the combinational parts (`XNOR` and `BUF` joined it for the 4077 and the
// 4050), and the unknown-aware units in sim/sequential.js for the rest.

import {
  dffUnit,
  jkUnit,
  johnsonCounter,
  binaryCounter,
  presetUpDownCounter,
  shiftStoreRegister,
  bcdDecimalUnits,
  bcd7segLatch,
  seqChip,
} from "../sim/sequential.js";
import { input, output, nc, gnd, vcc, unit } from "./pin-builders.js";

const VDD = (n) => vcc(n, "VDD");
const VSS = (n) => gnd(n, "VSS");

/**
 * The quad 2-input layout most of the 14-pin gates share (4001/4011/4081/
 * 4093/4030/4070/4077): A·B→J (3), C·D→K (4), E·F→L (10), G·H→M (11), with
 * the inputs on 1-2, 5-6, 8-9 and 12-13 — the 7400's corners, not the 7402's.
 */
function quad2(fn) {
  return {
    pins: [
      input(1, "A"),
      input(2, "B"),
      output(3, "J"),
      output(4, "K"),
      input(5, "C"),
      input(6, "D"),
      VSS(7),
      input(8, "E"),
      input(9, "F"),
      output(10, "L"),
      output(11, "M"),
      input(12, "G"),
      input(13, "H"),
      VDD(14),
    ],
    logic: {
      units: [
        unit(fn, [1, 2], 3),
        unit(fn, [5, 6], 4),
        unit(fn, [8, 9], 10),
        unit(fn, [12, 13], 11),
      ],
    },
  };
}

/**
 * The dual 4-input layout (4002/4012/4072): J (1) = f(A–D on 2–5),
 * K (13) = f(E–H on 9–12); pins 6 and 8 are no connection.
 */
function dual4(fn) {
  return {
    pins: [
      output(1, "J"),
      input(2, "A"),
      input(3, "B"),
      input(4, "C"),
      input(5, "D"),
      nc(6),
      VSS(7),
      nc(8),
      input(9, "E"),
      input(10, "F"),
      input(11, "G"),
      input(12, "H"),
      output(13, "K"),
      VDD(14),
    ],
    logic: {
      units: [unit(fn, [2, 3, 4, 5], 1), unit(fn, [9, 10, 11, 12], 13)],
    },
  };
}

/**
 * The triple 3-input layout (4023/4025/4073): J (9) = f(A 1, B 2, C 8),
 * K (6) = f(D 3, E 4, F 5), L (10) = f(I 11, H 12, G 13).
 */
function triple3(fn) {
  return {
    pins: [
      input(1, "A"),
      input(2, "B"),
      input(3, "D"),
      input(4, "E"),
      input(5, "F"),
      output(6, "K"),
      VSS(7),
      input(8, "C"),
      output(9, "J"),
      output(10, "L"),
      input(11, "I"),
      input(12, "H"),
      input(13, "G"),
      VDD(14),
    ],
    logic: {
      units: [
        unit(fn, [1, 2, 8], 9),
        unit(fn, [3, 4, 5], 6),
        unit(fn, [11, 12, 13], 10),
      ],
    },
  };
}

/**
 * The 8-input layout with BOTH outputs (4068/4078): K (1) is the true
 * function, J (13) its complement, over A–D (2–5) and E–H (9–12); pins 6 and
 * 8 are no connection. Two units over the same eight inputs.
 */
function octal8(trueFn, invFn) {
  const ins = [2, 3, 4, 5, 9, 10, 11, 12];
  return {
    pins: [
      output(1, "K"),
      input(2, "A"),
      input(3, "B"),
      input(4, "C"),
      input(5, "D"),
      nc(6),
      VSS(7),
      nc(8),
      input(9, "E"),
      input(10, "F"),
      input(11, "G"),
      input(12, "H"),
      output(13, "J"),
      VDD(14),
    ],
    logic: { units: [unit(invFn, ins, 13), unit(trueFn, ins, 1)] },
  };
}

/** The hex inverter layout (4069UB/40106B): A→G … F→L, the 7404's pinout. */
function hex14(fn) {
  return {
    pins: [
      input(1, "A"),
      output(2, "G"),
      input(3, "B"),
      output(4, "H"),
      input(5, "C"),
      output(6, "I"),
      VSS(7),
      output(8, "J"),
      input(9, "D"),
      output(10, "K"),
      input(11, "E"),
      output(12, "L"),
      input(13, "F"),
      VDD(14),
    ],
    logic: {
      units: [
        unit(fn, [1], 2),
        unit(fn, [3], 4),
        unit(fn, [5], 6),
        unit(fn, [9], 8),
        unit(fn, [11], 10),
        unit(fn, [13], 12),
      ],
    },
  };
}

/**
 * The 16-pin hex buffer layout (4049UB/4050B) — the family's odd one out:
 * power is VCC on pin 1 and VSS on pin 8 (NOT the corners 16/8), pins 13 and
 * 16 are no connection, and outputs sit BESIDE their inputs (A 3 → G 2).
 */
function hex16(fn) {
  return {
    pins: [
      vcc(1, "VCC"),
      output(2, "G"),
      input(3, "A"),
      output(4, "H"),
      input(5, "B"),
      output(6, "I"),
      input(7, "C"),
      gnd(8, "VSS"),
      input(9, "D"),
      output(10, "J"),
      input(11, "E"),
      output(12, "K"),
      nc(13),
      input(14, "F"),
      output(15, "L"),
      nc(16),
    ],
    logic: {
      units: [
        unit(fn, [3], 2),
        unit(fn, [5], 4),
        unit(fn, [7], 6),
        unit(fn, [9], 10),
        unit(fn, [11], 12),
        unit(fn, [14], 15),
      ],
    },
  };
}

/**
 * The CD4510B/CD4516B pinout, which the two share exactly (SCHS071B): the
 * 4029's, with RESET on pin 9 where the 4029 has BINARY/DECADE, and the jam
 * inputs named P1–P4.
 */
function upDown4510(decade) {
  return {
    pins: [
      input(1, "PRESET ENABLE"),
      output(2, "Q4"),
      input(3, "P4"),
      input(4, "P1"),
      input(5, "CARRY IN"),
      output(6, "Q1"),
      output(7, "CARRY OUT"),
      VSS(8),
      input(9, "RESET"),
      input(10, "UP/DOWN"),
      output(11, "Q2"),
      input(12, "P2"),
      input(13, "P3"),
      output(14, "Q3"),
      input(15, "CLOCK"),
      VDD(16),
    ],
    logic: seqChip([
      presetUpDownCounter({
        clk: 15,
        ciN: 5,
        pe: 1,
        reset: 9,
        ud: 10,
        decade,
        jam: [4, 12, 13, 3],
        q: [6, 11, 14, 2],
        coN: 7,
      }),
    ]),
  };
}

/**
 * The CD4511B's digits, segments a…g, by hand from its truth table (SCHS072B):
 * a 6 with no top bar and a 9 with no bottom bar, as the 74LS47's — and,
 * unlike the '47, codes 10–15 BLANK rather than showing symbols.
 */
const CD4511_FONT = Object.freeze(
  [
    "1111110", // 0
    "0110000", // 1
    "1101101", // 2
    "1111001", // 3
    "0110011", // 4
    "1011011", // 5
    "0011111", // 6 — no a
    "1110000", // 7
    "1111111", // 8
    "1110011", // 9 — no d
    ...Array(6).fill("0000000"), // 10–15: blank
  ].map((mask) => Object.freeze([...mask].map(Number))),
);

export const CHIPS_CD4000 = Object.freeze([
  // ── NOR ─────────────────────────────────────────────────────────────────
  {
    // SCHS015C (CD4001B/4002B/4025B), functional + terminal diagrams.
    id: "CD4001B",
    title: "Quad 2-input NOR",
    blurb:
      "Four independent 2-input CMOS NOR gates. Unlike the 74LS02, the " +
      "outputs are on pins 3, 4, 10 and 11, the 4011's corners.",
    group: "NOR",
    package: "DIP-14",
    ...quad2("NOR"),
  },
  {
    // SCHS015C.
    id: "CD4002B",
    title: "Dual 4-input NOR",
    blurb: "Two 4-input CMOS NOR gates; pins 6 and 8 are not connected.",
    group: "NOR",
    package: "DIP-14",
    ...dual4("NOR"),
  },
  {
    // SCHS015C.
    id: "CD4025B",
    title: "Triple 3-input NOR",
    blurb: "Three 3-input CMOS NOR gates.",
    group: "NOR",
    package: "DIP-14",
    ...triple3("NOR"),
  },
  {
    // SCHS059C (CD4078B), functional diagram: K (1) = OR, J (13) = NOR.
    id: "CD4078B",
    title: "8-input NOR/OR gate",
    blurb:
      "One 8-input CMOS gate with both outputs: J is the NOR, K the OR. Pins " +
      "6 and 8 are not connected.",
    group: "NOR",
    package: "DIP-14",
    ...octal8("OR", "NOR"),
  },

  // ── NAND ────────────────────────────────────────────────────────────────
  {
    // SCHS021D (CD4011B/4012B/4023B), terminal assignments.
    id: "CD4011B",
    title: "Quad 2-input NAND",
    blurb:
      "Four independent 2-input CMOS NAND gates — the 4000-series workhorse.",
    group: "NAND",
    package: "DIP-14",
    ...quad2("NAND"),
  },
  {
    // SCHS021D.
    id: "CD4012B",
    title: "Dual 4-input NAND",
    blurb: "Two 4-input CMOS NAND gates; pins 6 and 8 are not connected.",
    group: "NAND",
    package: "DIP-14",
    ...dual4("NAND"),
  },
  {
    // SCHS021D.
    id: "CD4023B",
    title: "Triple 3-input NAND",
    blurb: "Three 3-input CMOS NAND gates.",
    group: "NAND",
    package: "DIP-14",
    ...triple3("NAND"),
  },
  {
    // SCHS053C (CD4068B), terminal assignment: K (1) = AND, J (13) = NAND.
    id: "CD4068B",
    title: "8-input NAND/AND gate",
    blurb:
      "One 8-input CMOS gate with both outputs: J is the NAND, K the AND. " +
      "Pins 6 and 8 are not connected.",
    group: "NAND",
    package: "DIP-14",
    ...octal8("AND", "NAND"),
  },
  {
    // SCHS115D (CD4093B), functional diagram — the 4011's pinout.
    id: "CD4093B",
    title: "Quad 2-input NAND Schmitt trigger",
    blurb:
      "Four 2-input NAND gates with Schmitt-trigger inputs. The hysteresis is " +
      "an analog property the logic sim treats as a plain NAND — and with no " +
      "capacitors on the desk, its classic RC oscillator cannot be built here.",
    group: "NAND",
    package: "DIP-14",
    ...quad2("NAND"),
  },

  // ── AND ─────────────────────────────────────────────────────────────────
  {
    // SCHS057C (CD4073B/4081B/4082B), functional diagram.
    id: "CD4081B",
    title: "Quad 2-input AND",
    blurb: "Four independent 2-input CMOS AND gates.",
    group: "AND",
    package: "DIP-14",
    ...quad2("AND"),
  },
  {
    // SCHS057C, functional diagram: J (1) = A·B·C·D, inputs D C B A on 2–5.
    // Pins 6 and 8 are not drawn — no connection, as on the 4002/4012.
    id: "CD4082B",
    title: "Dual 4-input AND",
    blurb: "Two 4-input CMOS AND gates; pins 6 and 8 are not connected.",
    group: "AND",
    package: "DIP-14",
    ...dual4("AND"),
    pins: [
      output(1, "J"),
      input(2, "D"),
      input(3, "C"),
      input(4, "B"),
      input(5, "A"),
      nc(6),
      VSS(7),
      nc(8),
      input(9, "E"),
      input(10, "F"),
      input(11, "G"),
      input(12, "H"),
      output(13, "K"),
      VDD(14),
    ],
  },
  {
    // SCHS057C.
    id: "CD4073B",
    title: "Triple 3-input AND",
    blurb: "Three 3-input CMOS AND gates.",
    group: "AND",
    package: "DIP-14",
    ...triple3("AND"),
  },

  // ── OR ──────────────────────────────────────────────────────────────────
  {
    // SCHS056D (CD4071B/4072B/4075B), functional + logic diagrams: B is pin 1
    // and A pin 2 on this one (the 4081 has them the other way round).
    id: "CD4071B",
    title: "Quad 2-input OR",
    blurb: "Four independent 2-input CMOS OR gates.",
    group: "OR",
    package: "DIP-14",
    ...quad2("OR"),
    pins: [
      input(1, "B"),
      input(2, "A"),
      output(3, "J"),
      output(4, "K"),
      input(5, "D"),
      input(6, "C"),
      VSS(7),
      input(8, "F"),
      input(9, "E"),
      output(10, "L"),
      output(11, "M"),
      input(12, "H"),
      input(13, "G"),
      VDD(14),
    ],
  },
  {
    // SCHS056D.
    id: "CD4072B",
    title: "Dual 4-input OR",
    blurb: "Two 4-input CMOS OR gates; pins 6 and 8 are not connected.",
    group: "OR",
    package: "DIP-14",
    ...dual4("OR"),
  },
  {
    // SCHS056D, functional diagram: C 1, B 2, A 8 → J 9 (the sheet's logic
    // diagram letters the same three A/B/C the other way round — an OR does
    // not care, and the connection diagram is the one followed here).
    id: "CD4075B",
    title: "Triple 3-input OR",
    blurb: "Three 3-input CMOS OR gates.",
    group: "OR",
    package: "DIP-14",
    ...triple3("OR"),
    pins: [
      input(1, "C"),
      input(2, "B"),
      input(3, "F"),
      input(4, "E"),
      input(5, "D"),
      output(6, "K"),
      VSS(7),
      input(8, "A"),
      output(9, "J"),
      output(10, "L"),
      input(11, "I"),
      input(12, "H"),
      input(13, "G"),
      VDD(14),
    ],
  },

  // ── XOR ─────────────────────────────────────────────────────────────────
  {
    // SCHS035C (CD4030B), terminal diagram + truth table.
    id: "CD4030B",
    title: "Quad exclusive-OR",
    blurb:
      "Four 2-input CMOS XOR gates — the original part; the CD4070B is its " +
      "pin-for-pin successor.",
    group: "XOR",
    package: "DIP-14",
    ...quad2("XOR"),
  },
  {
    // SCHS055E (CD4070B/4077B), pinout + truth table.
    id: "CD4070B",
    title: "Quad exclusive-OR",
    blurb: "Four 2-input CMOS XOR gates.",
    group: "XOR",
    package: "DIP-14",
    ...quad2("XOR"),
  },
  {
    // SCHS055E, truth table: J is HIGH when A and B agree.
    id: "CD4077B",
    title: "Quad exclusive-NOR",
    blurb: "Four 2-input CMOS XNOR gates — the 4070's complement, same pinout.",
    group: "XOR",
    package: "DIP-14",
    ...quad2("XNOR"),
  },

  // ── Inverters & buffers ─────────────────────────────────────────────────
  {
    // SCHS054E (CD4069UB), pin functions.
    id: "CD4069UB",
    title: "Hex inverter",
    blurb:
      "Six unbuffered CMOS inverters (the UB): one stage each, which is why " +
      "it is the part crystal and RC oscillators are built around.",
    group: "Inverter",
    package: "DIP-14",
    ...hex14("INV"),
  },
  {
    // SCHS097F (CD40106B), pin functions — the 4069's pinout.
    id: "CD40106B",
    title: "Hex Schmitt-trigger inverter",
    blurb:
      "Six inverters with Schmitt-trigger inputs. The hysteresis is an analog " +
      "property the logic sim treats as a plain inverter, and its classic RC " +
      "oscillator needs a capacitor the desk does not have.",
    group: "Inverter",
    package: "DIP-14",
    ...hex14("INV"),
  },
  {
    // SCHS046L (CD4049UB/4050B), pin functions + function table.
    id: "CD4049UB",
    title: "Hex inverting buffer/converter",
    blurb:
      "Six inverting buffers with a strong output (two standard TTL loads) " +
      "for driving TTL from CMOS. Power is VCC on pin 1 and VSS on pin 8 — " +
      "not the corners — and pins 13 and 16 are not connected.",
    group: "Inverter",
    package: "DIP-16",
    // IOL ≥ 3.3 mA at VOL 0.4 V, VCC 5 V: eight LS inputs (0.4 mA each).
    lsFanout: 8,
    ...hex16("INV"),
  },
  {
    // SCHS046L. Its CD4050B pin table copies the 4049's "Inverting output"
    // wording; the device is NON-inverting, as its own function table shows.
    id: "CD4050B",
    title: "Hex non-inverting buffer/converter",
    blurb:
      "Six non-inverting buffers with a strong output (two standard TTL " +
      "loads) for driving TTL from CMOS. Power is VCC on pin 1 and VSS on " +
      "pin 8 — not the corners — and pins 13 and 16 are not connected.",
    group: "Buffer",
    package: "DIP-16",
    lsFanout: 8,
    ...hex16("BUF"),
  },

  // ── Flip-flop ───────────────────────────────────────────────────────────
  {
    // SCHS023E (CD4013B), pin functions + Table 1: positive-edge triggered;
    // SET and RESET are active HIGH and asynchronous; both HIGH drives Q and
    // Q̄ HIGH together.
    id: "CD4013B",
    title: "Dual D flip-flop, set & reset",
    blurb:
      "Two positive-edge D flip-flops with async active-HIGH set and reset — " +
      "the opposite sense of the 74LS74's. Tie SET and RESET LOW when unused.",
    group: "Flip-flop",
    package: "DIP-14",
    pins: [
      output(1, "Q1"),
      output(2, "Q̄1"),
      input(3, "CLOCK1"),
      input(4, "RESET1"),
      input(5, "D1"),
      input(6, "SET1"),
      VSS(7),
      input(8, "SET2"),
      input(9, "D2"),
      input(10, "RESET2"),
      input(11, "CLOCK2"),
      output(12, "Q̄2"),
      output(13, "Q2"),
      VDD(14),
    ],
    logic: seqChip([
      dffUnit({
        d: 5,
        clk: 3,
        set: 6,
        reset: 4,
        q: 1,
        qn: 2,
        edge: "rise",
        unknown: true,
      }),
      dffUnit({
        d: 9,
        clk: 11,
        set: 8,
        reset: 10,
        q: 13,
        qn: 12,
        edge: "rise",
        unknown: true,
      }),
    ]),
  },
  {
    // SCHS032D (CD4027B), pin functions + device functional modes: J and K
    // are taken on the RISING clock edge (the falling edge changes nothing);
    // SET and RESET are active HIGH and asynchronous; both HIGH drives Q and
    // Q̄ HIGH together.
    id: "CD4027B",
    title: "Dual JK flip-flop, set & reset",
    blurb:
      "Two positive-edge JK flip-flops: J alone sets, K alone resets, both " +
      "toggle. SET and RESET are active HIGH and asynchronous — the opposite " +
      "of the 74LS112's — and raising both drives Q and Q̄ HIGH at once. Tie " +
      "them LOW when unused.",
    group: "Flip-flop",
    package: "DIP-16",
    pins: [
      output(1, "Q2"),
      output(2, "Q̄2"),
      input(3, "CLOCK2"),
      input(4, "RESET2"),
      input(5, "K2"),
      input(6, "J2"),
      input(7, "SET2"),
      VSS(8),
      input(9, "SET1"),
      input(10, "J1"),
      input(11, "K1"),
      input(12, "RESET1"),
      input(13, "CLOCK1"),
      output(14, "Q̄1"),
      output(15, "Q1"),
      VDD(16),
    ],
    logic: seqChip([
      jkUnit({
        j: 10,
        k: 11,
        clk: 13,
        set: 9,
        reset: 12,
        q: 15,
        qn: 14,
        edge: "rise",
        unknown: true,
      }),
      jkUnit({
        j: 6,
        k: 5,
        clk: 3,
        set: 7,
        reset: 4,
        q: 1,
        qn: 2,
        edge: "rise",
        unknown: true,
      }),
    ]),
  },

  // ── Counters ────────────────────────────────────────────────────────────
  {
    // SCHS027C (CD4017B/4022B), terminal diagram, description + Fig. 2
    // timing: advances on CLOCK's rising edge while CLOCK INHIBIT is LOW (or
    // on CLOCK INHIBIT's falling edge while CLOCK is HIGH); RESET HIGH clears
    // to 0; CARRY OUT is HIGH for counts 0–4.
    id: "CD4017B",
    title: "Decade counter, 10 decoded outputs",
    blurb:
      "A Johnson counter with ten decoded outputs: exactly one of 0–9 is HIGH. " +
      "It advances on each rising CLOCK while CLOCK INHIBIT is LOW; RESET HIGH " +
      "returns it to 0, and CARRY OUT rises once every ten counts. Never leave " +
      "RESET or CLOCK INHIBIT floating.",
    group: "Counter",
    package: "DIP-16",
    pins: [
      output(1, "5"),
      output(2, "1"),
      output(3, "0"),
      output(4, "2"),
      output(5, "6"),
      output(6, "7"),
      output(7, "3"),
      VSS(8),
      output(9, "8"),
      output(10, "4"),
      output(11, "9"),
      output(12, "CARRY OUT"),
      input(13, "CLOCK INHIBIT"),
      input(14, "CLOCK"),
      input(15, "RESET"),
      VDD(16),
    ],
    logic: seqChip([
      johnsonCounter({
        clk: 14,
        inh: 13,
        reset: 15,
        outs: [3, 2, 4, 7, 10, 1, 5, 6, 9, 11],
        carry: 12,
      }),
    ]),
  },
  {
    // SCHS027C (CD4017B/4022B), the CD4022B terminal + functional diagrams
    // and Fig. 4 timing: the 4017 with four stages — eight decoded outputs,
    // CARRY OUT HIGH for counts 0–3. Pins 6 and 9 are not connected.
    id: "CD4022B",
    title: "Octal counter, 8 decoded outputs",
    blurb:
      "The CD4017B's divide-by-8 sibling: a Johnson counter with eight " +
      "decoded outputs, exactly one of 0–7 HIGH. It advances on each rising " +
      "CLOCK while CLOCK INHIBIT is LOW; RESET HIGH returns it to 0, and " +
      "CARRY OUT rises once every eight counts. Pins 6 and 9 are not connected.",
    group: "Counter",
    package: "DIP-16",
    pins: [
      output(1, "1"),
      output(2, "0"),
      output(3, "2"),
      output(4, "5"),
      output(5, "6"),
      nc(6),
      output(7, "3"),
      VSS(8),
      nc(9),
      output(10, "7"),
      output(11, "4"),
      output(12, "CARRY OUT"),
      input(13, "CLOCK INHIBIT"),
      input(14, "CLOCK"),
      input(15, "RESET"),
      VDD(16),
    ],
    logic: seqChip([
      johnsonCounter({
        clk: 14,
        inh: 13,
        reset: 15,
        outs: [2, 1, 3, 7, 11, 4, 5, 10],
        carry: 12,
      }),
    ]),
  },
  {
    // SCHS030D (CD4020B/4024B/4040B), the CD4020B terminal + functional
    // diagrams: 14 stages, of which Q2 and Q3 have no pin. Counts on φ's
    // falling edge; RESET HIGH clears every stage.
    id: "CD4020B",
    title: "14-stage binary ripple counter",
    blurb:
      "Fourteen ripple-carry binary stages, Q1 (÷2) to Q14 (÷16384) — but Q2 " +
      "and Q3 are not brought out, so the pins skip from Q1 to Q4. It counts " +
      "on each FALLING edge of φ; RESET HIGH clears it.",
    group: "Counter",
    package: "DIP-16",
    pins: [
      output(1, "Q12"),
      output(2, "Q13"),
      output(3, "Q14"),
      output(4, "Q6"),
      output(5, "Q5"),
      output(6, "Q7"),
      output(7, "Q4"),
      VSS(8),
      output(9, "Q1"),
      input(10, "φ"),
      input(11, "RESET"),
      output(12, "Q9"),
      output(13, "Q8"),
      output(14, "Q10"),
      output(15, "Q11"),
      VDD(16),
    ],
    logic: seqChip([
      binaryCounter({
        clk: 10,
        reset: 11,
        q: [9, null, null, 7, 5, 4, 6, 13, 12, 14, 15, 1, 2, 3],
        edge: "fall",
      }),
    ]),
  },
  {
    // SCHS030D, the CD4024B terminal + functional diagrams: a 14-LEAD part
    // (not the 4020/4040's 16), 7 stages, power on pins 7 and 14, and pins
    // 8, 10 and 13 not connected.
    id: "CD4024B",
    title: "7-stage binary ripple counter",
    blurb:
      "Seven ripple-carry binary stages, Q1 (÷2) to Q7 (÷128), in a 14-pin " +
      "package. It counts on each FALLING edge of φ; RESET HIGH clears it. " +
      "Pins 8, 10 and 13 are not connected.",
    group: "Counter",
    package: "DIP-14",
    pins: [
      input(1, "φ"),
      input(2, "RESET"),
      output(3, "Q7"),
      output(4, "Q6"),
      output(5, "Q5"),
      output(6, "Q4"),
      VSS(7),
      nc(8),
      output(9, "Q3"),
      nc(10),
      output(11, "Q2"),
      output(12, "Q1"),
      nc(13),
      VDD(14),
    ],
    logic: seqChip([
      binaryCounter({
        clk: 1,
        reset: 2,
        q: [12, 11, 9, 6, 5, 4, 3],
        edge: "fall",
      }),
    ]),
  },
  {
    // SCHS030D (CD4020B/4024B/4040B), terminal assignment + description:
    // advances on the NEGATIVE transition of each input pulse (φ, pin 10); a
    // HIGH on RESET (R, pin 11) clears every stage.
    id: "CD4040B",
    title: "12-stage binary ripple counter",
    blurb:
      "Twelve ripple-carry binary stages, Q1 (÷2) to Q12 (÷4096). It counts " +
      "on each FALLING edge of the input pulse φ; R HIGH clears it. The real " +
      "part ripples through intermediate codes; the sim settles at once.",
    group: "Counter",
    package: "DIP-16",
    pins: [
      output(1, "Q12"),
      output(2, "Q6"),
      output(3, "Q5"),
      output(4, "Q7"),
      output(5, "Q4"),
      output(6, "Q3"),
      output(7, "Q2"),
      VSS(8),
      output(9, "Q1"),
      input(10, "φ"),
      input(11, "R"),
      output(12, "Q9"),
      output(13, "Q8"),
      output(14, "Q10"),
      output(15, "Q11"),
      VDD(16),
    ],
    logic: seqChip([
      binaryCounter({
        clk: 10,
        reset: 11,
        q: [9, 7, 6, 5, 3, 2, 4, 13, 12, 14, 15, 1],
        edge: "fall",
      }),
    ]),
  },
  {
    // SCHS034C (CD4029B), terminal diagram, description, control table +
    // Figs. 10/12 timing: counts on CLOCK's rising edge while CARRY IN and
    // PRESET ENABLE are LOW; PRESET ENABLE HIGH jams JAM 1–4 in
    // asynchronously; BINARY/DECADE HIGH binary, LOW decade; UP/DOWN HIGH up;
    // CARRY OUT LOW at the top count going up (15/9) or 0 going down, while
    // CARRY IN is LOW. The sheet does not say where a decade count above 9
    // goes; the CD4510B's logic is used for that (sim/sequential.js).
    id: "CD4029B",
    title: "Presettable up/down counter, binary or decade",
    blurb:
      "A synchronous 4-bit counter that counts up or down (UP/DOWN), in binary " +
      "or in decade (BINARY/DECADE), on each rising CLOCK while CARRY IN is " +
      "LOW. PRESET ENABLE HIGH loads JAM 1–4 at once. CARRY OUT goes LOW at " +
      "the end of the count (15 or 9 going up, 0 going down) — wire it to the " +
      "next counter's CARRY IN to cascade. Tie CARRY IN LOW when unused.",
    group: "Counter",
    package: "DIP-16",
    pins: [
      input(1, "PRESET ENABLE"),
      output(2, "Q4"),
      input(3, "JAM 4"),
      input(4, "JAM 1"),
      input(5, "CARRY IN"),
      output(6, "Q1"),
      output(7, "CARRY OUT"),
      VSS(8),
      input(9, "BINARY/DECADE"),
      input(10, "UP/DOWN"),
      output(11, "Q2"),
      input(12, "JAM 2"),
      input(13, "JAM 3"),
      output(14, "Q3"),
      input(15, "CLOCK"),
      VDD(16),
    ],
    logic: seqChip([
      presetUpDownCounter({
        clk: 15,
        ciN: 5,
        pe: 1,
        ud: 10,
        bd: 9,
        jam: [4, 12, 13, 3],
        q: [6, 11, 14, 2],
        coN: 7,
      }),
    ]),
  },
  {
    // SCHS071B (CD4510B/4516B), terminal assignment, description, truth
    // table + Fig. 15 timing: RESET HIGH clears (and beats PRESET ENABLE);
    // PRESET ENABLE HIGH loads P1–P4; otherwise it counts on CLOCK's rising
    // edge while CARRY IN is LOW, up while UP/DOWN is HIGH. CARRY OUT LOW at
    // 9 up / 0 down while CARRY IN is LOW. "Will count out of non-BCD counter
    // states in a maximum of two clock pulses in the up mode, and a maximum of
    // four clock pulses in the down mode" — the Fig. 3 gates, modelled whole.
    id: "CD4510B",
    title: "Presettable BCD up/down counter",
    blurb:
      "A synchronous decade counter, up or down (UP/DOWN), on each rising " +
      "CLOCK while CARRY IN is LOW. RESET HIGH clears it; PRESET ENABLE HIGH " +
      "loads P1–P4 at once. CARRY OUT goes LOW at 9 going up or 0 going down " +
      "— wire it to the next counter's CARRY IN to cascade. Tie CARRY IN LOW " +
      "when unused.",
    group: "Counter",
    package: "DIP-16",
    ...upDown4510(true),
  },
  {
    // SCHS071B (CD4510B/4516B): the binary member of the pair, same pinout
    // and truth table; CARRY OUT LOW at 15 up / 0 down (Fig. 16).
    id: "CD4516B",
    title: "Presettable binary up/down counter",
    blurb:
      "A synchronous 4-bit binary counter, up or down (UP/DOWN), on each " +
      "rising CLOCK while CARRY IN is LOW. RESET HIGH clears it; PRESET ENABLE " +
      "HIGH loads P1–P4 at once. CARRY OUT goes LOW at 15 going up or 0 going " +
      "down — wire it to the next counter's CARRY IN to cascade. Tie CARRY IN " +
      "LOW when unused.",
    group: "Counter",
    package: "DIP-16",
    ...upDown4510(false),
  },

  // ── Shift register ──────────────────────────────────────────────────────
  {
    // SCHS063B (CD4094B), terminal diagram, description + truth table: data
    // shifts on CLOCK's rising edge; each stage's storage latch follows it
    // while STROBE is HIGH; OUTPUT ENABLE HIGH drives Q1–Q8, LOW leaves them
    // open circuit; QS changes on the rising edge, Q'S on the next falling
    // edge, and neither is ever disabled.
    id: "CD4094B",
    title: "8-stage shift-and-store register, 3-state",
    blurb:
      "Serial data in on DATA, shifted along on each rising CLOCK, with a " +
      "storage latch behind every stage: the outputs follow the shift " +
      "register while STROBE is HIGH and hold while it is LOW. OUTPUT ENABLE " +
      "is active HIGH — LOW floats Q1–Q8 for a shared bus. QS and Q'S chain " +
      "the next 4094 (Q'S half a clock later, for slow clocks).",
    group: "Shift register",
    package: "DIP-16",
    // Active HIGH, unlike every 74xx enable (index.js `outputEnablePins`).
    outputEnableHigh: Object.freeze([15]),
    pins: [
      input(1, "STROBE"),
      input(2, "DATA"),
      input(3, "CLOCK"),
      output(4, "Q1"),
      output(5, "Q2"),
      output(6, "Q3"),
      output(7, "Q4"),
      VSS(8),
      output(9, "QS"),
      output(10, "Q'S"),
      output(11, "Q8"),
      output(12, "Q7"),
      output(13, "Q6"),
      output(14, "Q5"),
      input(15, "OUTPUT ENABLE"),
      VDD(16),
    ],
    logic: seqChip([
      shiftStoreRegister({
        data: 2,
        clk: 3,
        strobe: 1,
        oe: 15,
        q: [4, 5, 6, 7, 14, 13, 12, 11],
        qs: 9,
        qsn: 10,
      }),
    ]),
  },

  // ── Decoder ─────────────────────────────────────────────────────────────
  {
    // SCHS033C (CD4028B), terminal diagram + Table I: output k HIGH for BCD
    // code k; codes 10–15 leave all ten LOW.
    id: "CD4028B",
    title: "BCD-to-decimal decoder",
    blurb:
      "Four inputs, ten active-HIGH outputs: the one numbered by the BCD code " +
      "on D C B A is HIGH. A code of 10–15 is not a digit, and leaves all ten " +
      "LOW. Read as binary, outputs 0–7 make it a 3-to-8 decoder with D as " +
      "an active-LOW enable.",
    group: "Decoder",
    package: "DIP-16",
    pins: [
      output(1, "4"),
      output(2, "2"),
      output(3, "0"),
      output(4, "7"),
      output(5, "9"),
      output(6, "5"),
      output(7, "6"),
      VSS(8),
      output(9, "8"),
      input(10, "A"),
      input(11, "D"),
      input(12, "C"),
      input(13, "B"),
      output(14, "1"),
      output(15, "3"),
      VDD(16),
    ],
    logic: {
      units: bcdDecimalUnits({
        bcd: [10, 13, 12, 11],
        out: [3, 14, 2, 15, 1, 6, 7, 4, 9, 5],
      }),
    },
  },

  // ── Display driver ──────────────────────────────────────────────────────
  {
    // SCHS072B (CD4511B), terminal assignment + truth table: LT LOW lights
    // every segment; BL LOW blanks them; LE LOW decodes the inputs live and
    // LE HIGH holds the code applied while it was LOW; codes 10–15 blank;
    // outputs active HIGH. Its 6 has no top bar and its 9 no bottom bar.
    id: "CD4511B",
    title: "BCD-to-7-segment latch/decoder/driver",
    blurb:
      "Decodes the BCD code on D C B A for a COMMON-CATHODE display — its " +
      "outputs drive HIGH. LT LOW lights every segment (lamp test), BL LOW " +
      "blanks them, and LE HIGH freezes the digit shown while the inputs " +
      "change. A code of 10–15 shows nothing at all. Tie LT and BL HIGH and " +
      "LE LOW when unused.",
    group: "Display driver",
    package: "DIP-16",
    pins: [
      input(1, "B"),
      input(2, "C"),
      input(3, "LT"),
      input(4, "BL"),
      input(5, "LE"),
      input(6, "D"),
      input(7, "A"),
      VSS(8),
      output(9, "e"),
      output(10, "d"),
      output(11, "c"),
      output(12, "b"),
      output(13, "a"),
      output(14, "g"),
      output(15, "f"),
      VDD(16),
    ],
    logic: seqChip([
      bcd7segLatch({
        bcd: [7, 1, 2, 6],
        le: 5,
        ltN: 3,
        blN: 4,
        seg: [13, 12, 11, 10, 9, 15, 14],
        font: CD4511_FONT,
      }),
    ]),
  },
]);
