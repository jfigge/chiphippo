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

// chips-cd4000-timers.js — the CD4000 parts that keep time with an external
// resistor and capacitor: the CD4047B multivibrator, the CD4060B counter with
// its own oscillator, the CD4098B, CD4528B and CD4538B dual monostables and
// the CD4541B programmable timer. Stamped CD4000 in catalog/index.js like
// chips-cd4000.js, so they share its supply range, floating-input rule and
// tray folder.
//
// EVERY PINOUT AND FORMULA IS FROM THE PART'S DATASHEET, cited at each def —
// TI's for all but one, every one of them a Harris scan read from rendered
// pages. The CD4538B is TI's SCHS093C, written for the CD14538B: TI no longer
// prints a CD4538B sheet, and that one states it is pin-compatible with the
// CD4538B, replaces it, and gives the CD4538B's own period in a footnote
// (T = Rx·Cx). The CD4528B has no TI sheet at all; its pinout, truth table
// and pulse width are from HGSEMI's CD4528B sheet (V1.4), a current second
// source whose tables are Fairchild's CD4528BC sheet's.
//
// The R and C are READ off the wiring by the shared trace (sim/rc-trace.js);
// how each part turns them into time is its own (sim/monostable.js,
// sim/ripple-oscillator.js, sim/programmable-timer.js). Their RC terminals
// are `timing` pins — neither input nor output (pin-builders.js says what
// that buys).

import { input, output, nc, timing, gnd, vcc } from "./pin-builders.js";
import {
  cd4047Logic,
  cd4047Silicon,
  dualMonostableLogic,
  dualMonostableSilicon,
} from "../sim/monostable.js";
import { cd4060Logic, cd4060Silicon } from "../sim/ripple-oscillator.js";
import { cd4541Logic, cd4541Silicon } from "../sim/programmable-timer.js";

const VDD = (n) => vcc(n, "VDD");
const VSS = (n) => gnd(n, "VSS");

/**
 * The CD4098B/CD4538B pinout — identical on both sheets' terminal
 * assignments: CX1 1, RX CX1 2, RESET1 3, +TR1 4, −TR1 5, Q1 6, Q̄1 7, VSS 8,
 * Q̄2 9, Q2 10, −TR2 11, +TR2 12, RESET2 13, RX CX2 14, CX2 15, VDD 16. RESET is
 * active LOW (its bar dropped, as every CD4000 name here drops one).
 */
const DUAL_MONO_PINS = [
  timing(1, "CX1"),
  timing(2, "RX CX1"),
  input(3, "RESET1"),
  input(4, "+TR1"),
  input(5, "-TR1"),
  output(6, "Q1"),
  output(7, "Q̄1"),
  VSS(8),
  output(9, "Q̄2"),
  output(10, "Q2"),
  input(11, "-TR2"),
  input(12, "+TR2"),
  input(13, "RESET2"),
  timing(14, "RX CX2"),
  timing(15, "CX2"),
  VDD(16),
];

/** The sections' pins — the CD4528B's too, whose terminals are the same
    functions on the same pins under its own names (below). */
const SECTION_PINS = [
  { cx: 1, rxcx: 2, reset: 3, plus: 4, minus: 5, q: 6, qn: 7 },
  { cx: 15, rxcx: 14, reset: 13, plus: 12, minus: 11, q: 10, qn: 9 },
];

const DUAL_MONO_SECTIONS = SECTION_PINS.map((s) => ({
  ...s,
  cxName: "CX",
  rxcxName: "RX CX",
}));

/**
 * The CD4528B's pinout (HGSEMI V1.4 connection diagram): T1A 1, T2A 2, CDA 3,
 * A 4, B 5, QA 6, Q̄A 7, VSS 8, Q̄B 9, QB 10, B 11, A 12, CDB 13, T2B 14,
 * T1B 15, VDD 16 — the 4098's functions on the 4098's pins: Cx between T1
 * and T2, Rx from T2 to VDD, CD (clear) active LOW, A the rising trigger, B
 * the falling one. Its A and B inputs are named for their section here
 * (AA, BA, AB, BB), since the sheet tells the two A pins apart only by the
 * block they sit in.
 */
const CD4528_PINS = [
  timing(1, "T1A"),
  timing(2, "T2A"),
  input(3, "CDA"),
  input(4, "AA"),
  input(5, "BA"),
  output(6, "QA"),
  output(7, "Q̄A"),
  VSS(8),
  output(9, "Q̄B"),
  output(10, "QB"),
  input(11, "BB"),
  input(12, "AB"),
  input(13, "CDB"),
  timing(14, "T2B"),
  timing(15, "T1B"),
  VDD(16),
];

const CD4528_SECTIONS = SECTION_PINS.map((s, i) => ({
  ...s,
  cxName: i ? "T1B" : "T1A",
  rxcxName: i ? "T2B" : "T2A",
}));

export const CHIPS_CD4000_TIMERS = Object.freeze([
  {
    // SCHS044C (CD4047B): terminal diagram, functional terminal connections
    // table, Figs. 32–34, "Astable/Monostable Mode Design Information":
    // tA (Q, Q̄) = 4.40 RC, OSC OUT period 2.20 RC, tM = 2.48 RC.
    id: "CD4047B",
    title: "Monostable/astable multivibrator",
    blurb:
      "One timer, either kind, with a resistor between R (2) and RC COMMON " +
      "(3) and a capacitor between C (1) and RC COMMON. ASTABLE HIGH (or " +
      "ASTABLĒ LOW) makes it free-run: Q and Q̄ square-wave with a period of " +
      "4.40·RC and OSC OUT at twice that rate. Otherwise it is a one-shot: " +
      "+TRIGGER rising (with −TRIGGER LOW) or −TRIGGER falling (with +TRIGGER " +
      "HIGH) gives a 2.48·RC pulse on Q, which another trigger does not " +
      "restart. RETRIGGER rising during the pulse, or held HIGH, runs it on " +
      "by whole 2.2·RC periods of the internal oscillator. EXT RESET HIGH " +
      "holds Q LOW. Tie every unused input.",
    group: "Timer",
    package: "DIP-14",
    pins: [
      timing(1, "C"),
      timing(2, "R"),
      timing(3, "RC COMMON"),
      input(4, "ASTABLĒ"),
      input(5, "ASTABLE"),
      input(6, "-TRIGGER"),
      VSS(7),
      input(8, "+TRIGGER"),
      input(9, "EXT RESET"),
      output(10, "Q"),
      output(11, "Q̄"),
      input(12, "RETRIGGER"),
      output(13, "OSC OUT"),
      VDD(14),
    ],
    logic: cd4047Logic(),
    // Its supply current is the family's: SCHS044C's quiescent IDD is
    // 0.02 µA typical at 5 V, and what it draws timing (Figs. 26–28) is the
    // current its outputs drive into R and C, which the solve books itself.
    silicon: cd4047Silicon(),
  },
  {
    // SCHS049C (CD4060B): functional diagram, Fig. 1 logic diagram, Fig. 12
    // RC circuit (Rs = 2–10·Rx, T = 2.2·Rx·Cx). Advances on each NEGATIVE
    // transition of φI; RESET HIGH clears every stage and stops the
    // oscillator. Q1–Q3 and Q11 have no pin.
    id: "CD4060B",
    title: "14-stage ripple counter with oscillator",
    blurb:
      "A 14-stage binary ripple counter with its own oscillator in front. " +
      "For the RC oscillator, put Cx from φO (9), Rx from φ̄O (10) and Rs " +
      "(2–10 × Rx) from φI (11) all on one junction: it runs at 1/(2.2·Rx·Cx). " +
      "Or drive φI from an external clock and leave φO and φ̄O to drive " +
      "nothing but logic. It counts on each FALLING edge of φI; RESET HIGH " +
      "clears it and stops the oscillator. Only Q4–Q10 and Q12–Q14 are " +
      "brought out.",
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
      output(9, "φO"),
      output(10, "φ̄O"),
      input(11, "φI"),
      input(12, "RESET"),
      output(13, "Q9"),
      output(14, "Q8"),
      output(15, "Q10"),
      VDD(16),
    ],
    logic: cd4060Logic(),
    // Its supply current is the family's: SCHS049C's quiescent IDD is
    // 0.04 µA typical; its oscillator's draw is its outputs' into Rx, Rs
    // and Cx, which the solve books itself.
    silicon: cd4060Silicon(),
  },
  {
    // SCHS065C (CD4098B): terminal assignment, Table I, Fig. 4. T = ½·Rx·Cx
    // (for Cx ≥ 0.01 µF; below that the sheet gives the period only as the
    // curves of Fig. 8). Rx ≥ 5 kΩ, Cx ≤ 100 µF. Terminals 1, 8 and 15 are
    // connected inside the part.
    id: "CD4098B",
    title: "Dual monostable multivibrator",
    blurb:
      "Two retriggerable, resettable one-shots. For each, a capacitor from RX " +
      "CX to CX (or GND — CX is VSS inside the part) and a resistor from RX CX " +
      "to VDD set the pulse: T = ½·Rx·Cx. +TR rising (with −TR HIGH) or −TR " +
      "falling (with +TR LOW) starts it, and every new trigger extends it one " +
      "full period. RESET LOW ends it at once. For a non-retriggerable pulse " +
      "feed Q̄ back to −TR (or Q to +TR). Tie unused RESETs HIGH; an unused " +
      "section's inputs all to VDD or VSS.",
    group: "Timer",
    package: "DIP-16",
    pins: DUAL_MONO_PINS.map((p) => ({ ...p })),
    logic: dualMonostableLogic({
      width: (r, c) => 0.5 * r * c,
      cxInside: true,
      // SCHS065C p.1: "The maximum value of external capacitance, Cx, is
      // 100 uF."
      cxMaxFarads: 100e-6,
      vdd: 16,
      sections: DUAL_MONO_SECTIONS,
    }),
    silicon: dualMonostableSilicon({
      k: () => 0.5,
      cxInside: true,
      vss: 8,
      // SCHS065C p.1: "The minimum value of external resistance, Rx, is
      // 5 kΩ." Its quiescent IDD (0.02 µA typical at 5 V) is the family's
      // own figure, so it books no supply current of its own.
      rxMinOhms: 5000,
      sections: DUAL_MONO_SECTIONS,
    }),
  },
  {
    // HGSEMI CD4528B V1.4 (Fairchild's CD4528BC tables): connection diagram,
    // truth table, block and logic diagrams, and the AC table's "for Cx >
    // 0.01 µF use PWout = 0.2·Rx·Cx·ln(VDD − VSS)" (below that the sheet
    // gives the width only as Fig. 1's curves). Retriggerable and resettable;
    // "externally ground pins 1 and 15 to pin 8".
    id: "CD4528B",
    title: "Dual monostable multivibrator",
    blurb:
      "Two retriggerable, resettable one-shots, the CD4098B's functions on " +
      "the CD4098B's pins. For each, a capacitor from T2 to T1 and a resistor " +
      "from T2 to VDD set the pulse: T = 0.2·Rx·Cx·ln(VDD), so it lengthens " +
      "with the supply. T1 is NOT grounded inside the part — wire T1A (1) and " +
      "T1B (15) to GND. A rising (with B HIGH) or B falling (with A LOW) " +
      "starts it, and every new trigger extends it one full period. CD LOW " +
      "ends it at once. Tie unused CDs HIGH; an unused section's inputs all " +
      "to VDD or VSS.",
    group: "Timer",
    package: "DIP-16",
    pins: CD4528_PINS.map((p) => ({ ...p })),
    logic: dualMonostableLogic({
      width: (r, c, volts) =>
        volts > 1 ? 0.2 * r * c * Math.log(volts) : null,
      cxInside: false,
      vdd: 16,
      sections: CD4528_SECTIONS,
    }),
    silicon: dualMonostableSilicon({
      k: (vdd) => 0.2 * Math.log(vdd),
      cxInside: false,
      vss: 8,
      // DERIVED: the HGSEMI sheet states no least Rx; 5 kΩ is the smallest
      // its own AC table is tested at ("Cx = 15 pF, Rx = 5.0 kΩ"), the
      // CD4098B's figure on the same pins. Quiescent 5 nA per package
      // (typical) — the family's figure.
      rxMinOhms: 5000,
      sections: CD4528_SECTIONS,
    }),
  },
  {
    // SCHS093C (CD14538B, "Replaces CD4538B Type"): terminal assignment, the
    // "CD4538B Functional Terminal Connections" Table I, and the footnote
    // giving the CD4538B's period — T = Rx·Cx, Cx ≥ 5000 pF. Rx ≥ 4 kΩ,
    // Cx ≤ 100 µF. Pin-compatible with the CD4098B.
    id: "CD4538B",
    title: "Dual precision monostable multivibrator",
    blurb:
      "Two retriggerable, resettable precision one-shots, pin for pin the " +
      "CD4098B's. For each, a capacitor from RX CX to CX (or GND) and a " +
      "resistor from RX CX to VDD set the pulse: T = Rx·Cx. +TR rising (with " +
      "−TR HIGH) or −TR falling (with +TR LOW) starts it, and every new " +
      "trigger extends it one full period. RESET LOW ends it at once. Tie " +
      "unused RESETs HIGH; an unused section's inputs all to VDD or VSS.",
    group: "Timer",
    package: "DIP-16",
    pins: DUAL_MONO_PINS.map((p) => ({ ...p })),
    logic: dualMonostableLogic({
      width: (r, c) => r * c,
      cxInside: true,
      // SCHS093C p.1: Cx's "minimum and maximum values ... are 0 pF and
      // 100 uF".
      cxMaxFarads: 100e-6,
      vdd: 16,
      sections: DUAL_MONO_SECTIONS,
    }),
    silicon: dualMonostableSilicon({
      k: () => 1,
      cxInside: true,
      vss: 8,
      // SCHS093C p.1: "The minimum value of external resistance, Rx, is
      // 4 kΩ." Quiescent IDD 0.04 µA typical — the family's figure.
      rxMinOhms: 4000,
      sections: DUAL_MONO_SECTIONS,
    }),
  },
  {
    // SCHS085E (CD4541B): pinout, Fig. 1 functional diagram, Fig. 2 RC
    // oscillator, the Frequency Selection Table and the Truth Table;
    // f = 1/(2.3·Rtc·Ctc), Rs ≈ 2·Rtc and ≥ 10 kΩ. Fig. 2 drives RTC and CTC
    // from inverters, and its clock is RS inverted. Pins 4 and 11 are NC.
    id: "CD4541B",
    title: "Programmable timer",
    blurb:
      "A 16-stage counter with its own RC oscillator. Put Ctc from CTC (2), " +
      "Rtc from RTC (1) and Rs (about 2·Rtc, at least 10 kΩ) from RS (3) all " +
      "on one junction: it runs at 1/(2.3·Rtc·Ctc). Or clock RS from outside " +
      "and leave CTC and RTC to drive nothing but logic; it counts on RS's " +
      "FALLING edges. A and B pick " +
      "the output's stage: 2^13 (both LOW), 2^10 (B HIGH), 2^8 (A HIGH) or " +
      "2^16 (both). MODE HIGH recycles — a square wave at f/2^N; MODE LOW " +
      "makes ONE transition, 2^(N−1) counts after a reset, and holds it. " +
      "Q/Q̄ SELECT HIGH inverts the output. MASTER RESET HIGH clears and " +
      "stops it. With AUTO RESET LOW it starts at power-up; HIGH, it waits " +
      "for a MASTER RESET pulse.",
    group: "Timer",
    package: "DIP-14",
    pins: [
      output(1, "RTC"),
      output(2, "CTC"),
      input(3, "RS"),
      nc(4),
      input(5, "AUTO RESET"),
      input(6, "MASTER RESET"),
      VSS(7),
      output(8, "OUTPUT"),
      input(9, "Q/Q̄ SELECT"),
      input(10, "MODE"),
      nc(11),
      input(12, "A"),
      input(13, "B"),
      VDD(14),
    ],
    logic: cd4541Logic(),
    silicon: cd4541Silicon(),
  },
]);
