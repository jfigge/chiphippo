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

// demo-specs.mjs — WHAT each demonstration desktop wires up, as data. One
// entry per chip; scripts/demo-bench.mjs turns it into a breadboard and
// scripts/make-gate-demos.mjs proves it works before writing the file.
//
// A spec is deliberately close to the datasheet, because that is what it has
// to be checked against:
//
//   inputs   — the switched logic sources, left to right, and which chip pins
//              each one feeds (one switch may feed several).
//   bank     — the 8-position DIP-switch alternative, for a chip with too many
//              inputs to give each its own slide switch.
//   ties     — pins held at a rail: an enable asserted, an unused input parked.
//   links    — chip pin → chip pin, the demo's own topology (an inverter chain,
//              a flip-flop's Q̄ folded back to its D).
//   clock    — the clock brick's rate and the pins it drives.
//   leds     — one read-out per output pin; `activeLow` inverts the LED so an
//              active-low output LIGHTS it (see Bench.led).
//   expect   — the truth table, WRITTEN OUT BY HAND from the datasheet rather
//              than derived from the catalog's own logic block: that is what
//              makes the check a wiring proof and not a tautology.
//   verify   — for a clocked demo, what to assert after each edge instead.
//
// Everything else (which hole, which rail, which colour) is the bench's.

/** Segment letters in the order the seg8ca's pins run — a…g, then dp. */
const SEG = ["a", "b", "c", "d", "e", "f", "g"];

/**
 * The digits a 74LS47 lights, by hand from the datasheet's function table —
 * INCLUDING the part's two famous quirks: its 6 has no top bar and its 9 no
 * bottom bar.
 */
const SEG7 = Object.freeze({
  0: "abcdef",
  1: "bc",
  2: "abdeg",
  3: "abcdg",
  4: "bcfg",
  5: "acdfg",
  6: "cdefg", // no `a`
  7: "abc",
  8: "abcdefg",
  9: "abcfg", // no `d`
});

/** The 74LS151 demo's hard-wired data pattern, D0…D7. */
const MUX_PATTERN = [false, true, true, false, true, false, false, true];

/** Two 2-input gate demos differ only in the operator — so share the shape. */
function quadGate(ref, title, op, blurb) {
  return {
    ref,
    title,
    note:
      `${ref} — ${title}\n` +
      "Each gate gets a different pair:\n" +
      "1Y = A·B   2Y = B·C   3Y = C·D   4Y = D·A\n" +
      blurb,
    inputs: [
      { label: "A", pins: [1, 13] },
      { label: "B", pins: [2, 4] },
      { label: "C", pins: [5, 9] },
      { label: "D", pins: [10, 12] },
    ],
    defaults: [true, false, true, true],
    leds: [
      { pin: 3, label: "1Y" },
      { pin: 6, label: "2Y" },
      { pin: 8, label: "3Y" },
      { pin: 11, label: "4Y" },
    ],
    expect: ([a, b, c, d]) => [op(a, b), op(b, c), op(c, d), op(d, a)],
  };
}

/** The '10/'11/'27 triples share one pinout: (1,2,13) (3,4,5) (9,10,11). */
function tripleGate(ref, title, op, blurb) {
  return {
    ref,
    title,
    note:
      `${ref} — ${title}\n` +
      "Gate 1 = A·B·C   Gate 2 = B·C·D\n" +
      "Gate 3 = C·D·A\n" +
      blurb,
    inputs: [
      { label: "A", pins: [1, 11] },
      { label: "B", pins: [2, 3] },
      { label: "C", pins: [13, 4, 9] },
      { label: "D", pins: [5, 10] },
    ],
    defaults: [true, false, true, true],
    leds: [
      { pin: 12, label: "1Y" },
      { pin: 6, label: "2Y" },
      { pin: 8, label: "3Y" },
    ],
    expect: ([a, b, c, d]) => [op(a, b, c), op(b, c, d), op(c, d, a)],
  };
}

const and = (...v) => v.every(Boolean);
const or = (...v) => v.some(Boolean);

export const DEMOS = Object.freeze([
  {
    ref: "74LS04",
    title: "Hex inverter",
    note: "74LS04 — Hex inverter\nAll six gates are chained: A → 1A,\n1Y → 2A, 2Y → 3A, and so on.\nEvery second LED lights, and the whole\nrow flips over when A does.",
    inputs: [{ label: "A", pins: [1] }],
    links: [
      [2, 3],
      [4, 5],
      [6, 9],
      [8, 11],
      [10, 13],
    ],
    leds: [
      { pin: 2, label: "1Y" },
      { pin: 4, label: "2Y" },
      { pin: 6, label: "3Y" },
      { pin: 8, label: "4Y" },
      { pin: 10, label: "5Y" },
      { pin: 12, label: "6Y" },
    ],
    expect: ([a]) => [!a, a, !a, a, !a, a],
  },

  quadGate("74LS08", "Quad 2-input AND", and, "An output is HIGH only with BOTH inputs HIGH."), // prettier-ignore
  tripleGate("74LS10", "Triple 3-input NAND", (...v) => !and(...v), "A NAND output is LOW only when every\ninput is HIGH."), // prettier-ignore
  tripleGate("74LS11", "Triple 3-input AND", and, "An output is HIGH only with all three\ninputs HIGH."), // prettier-ignore

  {
    ref: "74LS20",
    title: "Dual 4-input NAND",
    note: "74LS20 — Dual 4-input NAND\nGate 1 takes A·B·C·D. Gate 2 takes\nA·B·C with its fourth input TIED HIGH —\nhow a wide gate is used narrow.\nThe two differ only when D is LOW.",
    inputs: [
      { label: "A", pins: [1, 9] },
      { label: "B", pins: [2, 10] },
      { label: "C", pins: [4, 12] },
      { label: "D", pins: [5] },
    ],
    defaults: [true, true, true, false],
    ties: [{ pins: [13], rail: "+" }],
    leds: [
      { pin: 6, label: "1Y" },
      { pin: 8, label: "2Y" },
    ],
    expect: ([a, b, c, d]) => [!and(a, b, c, d), !and(a, b, c)],
  },

  tripleGate("74LS27", "Triple 3-input NOR", (...v) => !or(...v), "A NOR output is HIGH only while every\ninput is LOW."), // prettier-ignore

  {
    ref: "74LS30",
    title: "8-input NAND",
    note: "74LS30 — 8-input NAND\nAll eight inputs come from one DIP\nswitch bank, held LOW by a bussed\nresistor network. The output goes LOW\nonly with every switch closed.",
    bank: {
      labels: ["A", "B", "C", "D", "E", "F", "G", "H"],
      pins: [1, 2, 3, 4, 5, 6, 11, 12],
    },
    // Opens one switch short of the whole word, so closing H is what pulls
    // the output down — the gate's entire behaviour in a single flip.
    defaults: [true, true, true, true, true, true, true, false],
    leds: [{ pin: 8, label: "Y" }],
    expect: (v) => [!v.every(Boolean)],
  },

  quadGate(
    "74LS32",
    "Quad 2-input OR",
    or,
    "An output is HIGH with EITHER input HIGH.",
  ),

  {
    ref: "74LS47",
    title: "BCD to 7-segment decoder",
    note: "74LS47 — BCD to 7-segment decoder\nSwitches A–D set a BCD digit. The seven\nactive-LOW outputs SINK the segments of\na common-anode display; LT, BI and RBI\nare tied HIGH (all inactive).",
    inputs: [
      { label: "A", pins: [7] },
      { label: "B", pins: [1] },
      { label: "C", pins: [2] },
      { label: "D", pins: [6] },
    ],
    defaults: [true, false, true, false], // BCD 5
    ties: [{ pins: [3, 4, 5], rail: "+" }],
    // Outputs a…g (pins 13, 12, 11, 10, 9, 15, 14) → display pins 1…7.
    display: { segPins: [13, 12, 11, 10, 9, 15, 14] },
    digits: SEG7,
    segments: SEG,
  },

  {
    ref: "74LS74",
    title: "Dual D flip-flop",
    note: "74LS74 — Dual D flip-flop\nFF1 samples switch D on every rising\nclock edge. FF2 has its own Q̄ folded\nback to its D, so it TOGGLES — a\ndivide-by-two. Preset/clear tied HIGH.",
    inputs: [{ label: "D", pins: [2] }],
    ties: [{ pins: [1, 4, 10, 13], rail: "+" }],
    links: [[8, 12]], // 2Q̄ → 2D: the toggle connection
    clock: { hz: 1, pins: [3, 11] },
    leds: [
      { pin: 5, label: "1Q", color: "green" },
      { pin: 6, label: "1Q̄" },
      { pin: 9, label: "2Q", color: "green" },
      { pin: 8, label: "2Q̄" },
    ],
    sequential: {
      // Q after each rising edge, given D held HIGH from the start.
      expect: (edges) => {
        const q1 = true; // FF1 follows D (held HIGH)
        const q2 = edges % 2 === 1; // FF2 toggles from its cleared state
        return [q1, !q1, q2, !q2];
      },
    },
  },

  quadGate("74LS86", "Quad 2-input XOR", (x, y) => x !== y, "An output is HIGH while the inputs DIFFER."), // prettier-ignore

  {
    ref: "74LS125",
    title: "Quad bus buffer (tri-state)",
    note: "74LS125 — Quad bus buffer, tri-state\nSwitch G enables buffers 1 and 4 (it is\nactive LOW). Buffer 2 is permanently\nenabled, buffer 3 permanently disabled —\nits LED never lights, because a disabled\noutput drives nothing at all.",
    inputs: [
      { label: "A", pins: [2, 5] },
      { label: "B", pins: [9, 12] },
      { label: "G", pins: [1, 13] },
    ],
    defaults: [true, true, false], // A, B HIGH; G asserted (LOW)
    ties: [
      { pins: [4], rail: "-" }, // buffer 2: enabled always
      { pins: [10], rail: "+" }, // buffer 3: disabled always
    ],
    leds: [
      { pin: 3, label: "1Y" },
      { pin: 6, label: "2Y" },
      { pin: 8, label: "3Y" },
      { pin: 11, label: "4Y" },
    ],
    expect: ([a, b, g]) => [!g && a, a, false, !g && b],
  },

  {
    ref: "74LS138",
    title: "3-to-8 line decoder",
    note: "74LS138 — 3-to-8 line decoder\nSwitches A, B, C select one of eight\noutputs; G1 is tied HIGH and both G2s\nLOW, so the part is always enabled.\nThe outputs are active LOW, so each LED\nis wired the other way up: exactly one\nlights, and it is the one selected.",
    inputs: [
      { label: "A", pins: [1] },
      { label: "B", pins: [2] },
      { label: "C", pins: [3] },
    ],
    defaults: [false, true, false], // select Y2
    ties: [
      { pins: [6], rail: "+" },
      { pins: [4, 5], rail: "-" },
    ],
    leds: [15, 14, 13, 12, 11, 10, 9, 7].map((pin, i) => ({
      pin,
      label: `Y${i}`,
      activeLow: true,
      color: "green",
    })),
    expect: ([a, b, c]) => {
      const sel = (a ? 1 : 0) + (b ? 2 : 0) + (c ? 4 : 0);
      return Array.from({ length: 8 }, (_, i) => i === sel);
    },
  },

  {
    ref: "74LS151",
    title: "8-to-1 multiplexer",
    note: "74LS151 — 8-to-1 multiplexer\nD0–D7 are hard-wired to the pattern\n0 1 1 0 1 0 0 1. Switches A, B, C pick\none of them: Y shows the bit, W̄ its\ncomplement. The strobe is tied LOW.",
    inputs: [
      { label: "A", pins: [11] },
      { label: "B", pins: [10] },
      { label: "C", pins: [9] },
    ],
    defaults: [true, false, false], // select D1 (a HIGH bit)
    ties: [
      { pins: [7], rail: "-" }, // strobe: always enabled
      // D0…D7 sit on pins 4, 3, 2, 1, 15, 14, 13, 12.
      { pins: [4, 3, 2, 1, 15, 14, 13, 12].filter((_, i) => MUX_PATTERN[i]), rail: "+" }, // prettier-ignore
      { pins: [4, 3, 2, 1, 15, 14, 13, 12].filter((_, i) => !MUX_PATTERN[i]), rail: "-" }, // prettier-ignore
    ],
    leds: [
      { pin: 5, label: "Y", color: "green" },
      { pin: 6, label: "W̄" },
    ],
    expect: ([a, b, c]) => {
      const y = MUX_PATTERN[(a ? 1 : 0) + (b ? 2 : 0) + (c ? 4 : 0)];
      return [y, !y];
    },
  },

  {
    ref: "74LS161",
    title: "Synchronous 4-bit counter",
    note: "74LS161 — Synchronous 4-bit counter\nPress Run: it counts on every rising\nclock edge. Switch EN holds both count\nenables; /CLR clears it while LOW. LOAD\nis tied HIGH and A–D LOW (nothing to\nload). RCO lights on the last of the 16.",
    inputs: [
      { label: "EN", pins: [7, 10] },
      { label: "/CLR", pins: [1] },
    ],
    ties: [
      { pins: [9], rail: "+" }, // LOAD inactive
      { pins: [3, 4, 5, 6], rail: "-" }, // preset data
    ],
    clock: { hz: 2, pins: [2] },
    leds: [
      { pin: 14, label: "QA", color: "green" },
      { pin: 13, label: "QB", color: "green" },
      { pin: 12, label: "QC", color: "green" },
      { pin: 11, label: "QD", color: "green" },
      { pin: 15, label: "RCO", color: "yellow" },
    ],
    sequential: {
      expect: (edges) => {
        const n = edges % 16;
        return [
          Boolean(n & 1),
          Boolean(n & 2),
          Boolean(n & 4),
          Boolean(n & 8),
          n === 15,
        ];
      },
    },
  },

  {
    ref: "74LS164",
    title: "8-bit shift register",
    note: "74LS164 — 8-bit shift register (SIPO)\nSwitch DATA feeds both serial inputs\n(the part ANDs them); every rising clock\nedge shifts it one place along the row.\n/CLR empties the register while LOW.",
    inputs: [
      { label: "DATA", pins: [1, 2] },
      { label: "/CLR", pins: [9] },
    ],
    clock: { hz: 1, pins: [8] },
    leds: [3, 4, 5, 6, 10, 11, 12, 13].map((pin, i) => ({
      pin,
      label: `Q${i}`,
      color: "green",
    })),
    sequential: {
      // DATA held HIGH from a cleared register: the ones march across.
      expect: (edges) =>
        Array.from({ length: 8 }, (_, i) => i < Math.min(edges, 8)),
    },
  },
]);
