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
// its own oscillator, and the CD4098B and CD4538B dual monostables. Stamped
// CD4000 in catalog/index.js like chips-cd4000.js, so they share its supply
// range, floating-input rule and tray folder.
//
// EVERY PINOUT AND FORMULA IS FROM THE PART'S TI DATASHEET, cited at each def —
// all four are Harris scans, read from rendered pages. The CD4538B is TI's
// SCHS093C, written for the CD14538B: TI no longer prints a CD4538B sheet,
// and that one states it is pin-compatible with the CD4538B, replaces it, and
// gives the CD4538B's own period in a footnote (T = Rx·Cx). The CD4528B,
// asked for beside them, has no TI datasheet at all and is not here.
//
// The R and C are READ off the wiring by the shared trace (sim/rc-trace.js);
// how each part turns them into time is its own (sim/monostable.js,
// sim/ripple-oscillator.js). Their RC terminals are `timing` pins — neither
// input nor output (pin-builders.js says what that buys).

import { input, output, timing, gnd, vcc } from "./pin-builders.js";
import { cd4047Logic, dualMonostableLogic } from "../sim/monostable.js";
import { cd4060Logic } from "../sim/ripple-oscillator.js";

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

const DUAL_MONO_SECTIONS = [
  { cx: 1, rxcx: 2, reset: 3, plus: 4, minus: 5, q: 6, qn: 7 },
  { cx: 15, rxcx: 14, reset: 13, plus: 12, minus: 11, q: 10, qn: 9 },
];

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
      "HIGH) gives a 2.48·RC pulse on Q; a rising RETRIGGER during the pulse " +
      "restarts it. EXT RESET HIGH holds Q LOW. Tie every unused input.",
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
    logic: dualMonostableLogic({ k: 0.5, sections: DUAL_MONO_SECTIONS }),
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
    logic: dualMonostableLogic({ k: 1, sections: DUAL_MONO_SECTIONS }),
  },
]);
