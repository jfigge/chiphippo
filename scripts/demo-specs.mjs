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
// entry per catalog chip; scripts/demo-bench.mjs turns it into a breadboard
// and scripts/demo-build.mjs proves it works before a file is written. The
// entries are grouped exactly as the catalog groups them, because that is how
// they are shipped: one project per group, one desktop per chip.
//
// A spec is deliberately close to the datasheet, because that is what it has
// to be checked against:
//
//   inputs   — the switched logic sources, left to right, and which chip pins
//              each one feeds (one switch may feed several).
//   bank     — the 8-position DIP-switch alternative, for a part with more
//              inputs than slide switches will fit.
//   route    — an SPDT that hands the CLOCK to one of two pins ('193).
//   ties     — pins held at a rail: an enable asserted, an unused input parked.
//   links    — chip pin → chip pin, the demo's own topology (an inverter chain,
//              a flip-flop's Q̄ folded back to its D, a '90's ripple).
//   clock    — the clock brick's rate and the pins it drives.
//   leds     — one read-out per output pin; `activeLow` inverts the LED so an
//              active-low output LIGHTS it (see Bench.led).
//   defaults — how the demo OPENS: the position of every switched input.
//   expect   — the truth table, WRITTEN OUT BY HAND from the datasheet rather
//              than derived from the catalog's own logic block: that is what
//              makes the check a wiring proof and not a tautology. Return null
//              for a combination the demo does not pin down.
//   cases    — for a wide part, the input vectors to check instead of sweeping
//              every one of 2^n.
//   sequential — for a clocked (or level-latched) demo: `expect(edges)`, an
//              optional `edges` count, and `phases` that work the switches
//              part-way through a run.
//
// Everything else (which hole, which rail, which colour) is the bench's.

// ── Shared helpers ───────────────────────────────────────────────────────

const and = (...v) => v.every(Boolean);
const or = (...v) => v.some(Boolean);

/** A little-endian bit list → its number (LSB first, as every bus here is). */
const num = (bits) => bits.reduce((n, b, i) => n + (b ? 1 << i : 0), 0);

/** `count` bits of a vector from `at`, as a number. */
const word = (v, at, count) => num(v.slice(at, at + count));

/** A number → `count` bits, LSB first. */
const bitsOf = (value, count) =>
  Array.from({ length: count }, (_, i) => Boolean(value & (1 << i)));

/**
 * The two quad-2-input pin maps in the 74xx catalog. Most parts put the
 * outputs on 3/6/8/11 with the inputs in pairs before them; the '01 and the
 * '02 put the outputs FIRST (1/4/10/13). Everything else about the demo is
 * identical, which is exactly why the map is data.
 */
const QUAD_OUT_LAST = {
  in: [
    [1, 2],
    [4, 5],
    [9, 10],
    [12, 13],
  ],
  out: [3, 6, 8, 11],
};
const QUAD_OUT_FIRST = {
  in: [
    [2, 3],
    [5, 6],
    [8, 9],
    [11, 12],
  ],
  out: [1, 4, 10, 13],
};

/**
 * Four 2-input gates fed by four switches in a RING — gate 1 takes A·B, gate 2
 * B·C, gate 3 C·D, gate 4 D·A — so no two gates see the same pair and all four
 * read-outs say something different.
 */
function quadGate(ref, title, op, blurb, map = QUAD_OUT_LAST, opts = {}) {
  const { activeLow = false, note = null } = opts;
  const ring = [
    [map.in[0][0], map.in[3][1]], // A
    [map.in[0][1], map.in[1][0]], // B
    [map.in[1][1], map.in[2][0]], // C
    [map.in[2][1], map.in[3][0]], // D
  ];
  return {
    ref,
    title,
    note:
      note ??
      `${ref} — ${title}\n` +
        "Each gate gets a different pair:\n" +
        "1Y = A·B   2Y = B·C   3Y = C·D   4Y = D·A\n" +
        blurb,
    inputs: ["A", "B", "C", "D"].map((label, i) => ({ label, pins: ring[i] })),
    defaults: [true, false, true, true],
    leds: map.out.map((pin, i) => ({
      pin,
      label: `${i + 1}Y`,
      ...(activeLow ? { activeLow: true } : {}),
    })),
    // An active-low read-out lights when the output is pulled DOWN, so the
    // lamp is the gate's complement — which is the whole point of showing it.
    expect: ([a, b, c, d]) =>
      [op(a, b), op(b, c), op(c, d), op(d, a)].map((y) => (activeLow ? !y : y)),
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

/**
 * The '04/'05/'14 hex inverters share one pinout — inputs 1/3/5/9/11/13 into
 * outputs 2/4/6/8/10/12. Two switches drive three gates each, so the row of
 * read-outs splits down the middle.
 */
function hexInverter(ref, title, note, { activeLow = false } = {}) {
  const inputs = [1, 3, 5, 9, 11, 13];
  const outputs = [2, 4, 6, 8, 10, 12];
  return {
    ref,
    title,
    note,
    inputs: [
      { label: "A", pins: inputs.slice(0, 3) },
      { label: "B", pins: inputs.slice(3) },
    ],
    defaults: [true, false],
    leds: outputs.map((pin, i) => ({
      pin,
      label: `${i + 1}Y`,
      ...(activeLow ? { activeLow: true } : {}),
    })),
    expect: ([a, b]) =>
      [a, a, a, b, b, b].map((input) => (activeLow ? input : !input)),
  };
}

/**
 * The four JK flip-flops ('73/'76/'107/'112) get one demo shape: flip-flop 1
 * strapped J=K=HIGH so it TOGGLES (a divide-by-two), flip-flop 2 taking J and
 * K from switches, and one /CLR switch over both. All four parts clock on the
 * FALLING edge, so a toggle lands between the rising edges the run counts.
 */
function jkFlipFlop(ref, title, map, extra = "") {
  const ties = [{ pins: [map.j1, map.k1], rail: "+" }]; // FF1: J=K=1, toggle
  if (map.preN) ties.push({ pins: map.preN, rail: "+" });
  return {
    ref,
    title,
    note:
      `${ref} — ${title}\n` +
      "FF1 is strapped J=K=1, so it TOGGLES: a\n" +
      "divide-by-two on the clock. FF2 takes J\n" +
      "and K from switches — J=1, K=0 SETS it.\n" +
      `Both clock on the FALLING edge.${extra}`,
    inputs: [
      { label: "J", pins: [map.j2] },
      { label: "K", pins: [map.k2] },
      { label: "/CLR", pins: map.clrN },
    ],
    defaults: [true, false, true],
    ties,
    clock: { hz: 1, pins: map.clk },
    leds: [
      { pin: map.q1, label: "1Q", color: "green" },
      { pin: map.qn1, label: "1Q̄" },
      { pin: map.q2, label: "2Q", color: "green" },
      { pin: map.qn2, label: "2Q̄" },
    ],
    sequential: {
      // A falling edge lands between the rising ones, so after `edges` rises
      // exactly edges−1 falls have been seen.
      expect: (edges) => {
        const falls = edges - 1;
        const q1 = falls % 2 === 1; // toggling
        const q2 = falls >= 1; // J=1, K=0 → set on the first fall, then held
        return [q1, !q1, q2, !q2];
      },
    },
  };
}

/** Two eight-bit patterns, used wherever a demo loads a word and changes it. */
const PATTERN_A = [true, false, true, true, false, false, true, false];
const PATTERN_B = [false, true, false, false, true, true, false, true];

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

/** The '153's two 4-input words, and the '157/'257's two 4-bit sources. */
const MUX1 = [false, true, true, false];
const MUX2 = [true, false, false, true];
const SEL_A = [true, false, true, true];
const SEL_B = [false, true, true, false];

/**
 * The 74LS181's logic-mode functions (M = HIGH), from the datasheet's
 * ACTIVE-HIGH data table, keyed by S3S2S1S0. Only the functions the demo pins
 * down are here — the rest of the table is the part's business, not this
 * demo's claim.
 */
const ALU_LOGIC = Object.freeze({
  0b0000: (a) => ~a, // Ā
  0b0011: () => 0, // logic 0
  0b0110: (a, b) => a ^ b, // A ⊕ B
  0b1001: (a, b) => ~(a ^ b), // A ⊙ B
  0b1011: (a, b) => a & b, // A · B
  0b1100: () => 0xf, // logic 1
  0b1110: (a, b) => a | b, // A + B
  0b1111: (a) => a, // A
});

/** An octal part's eight bank labels. */
const OCTAL = (prefix) =>
  Array.from({ length: 8 }, (_, i) => `${prefix}${i + 1}`);

export const DEMOS = Object.freeze([
  // ── NAND ───────────────────────────────────────────────────────────────
  quadGate("74LS00", "Quad 2-input NAND", (...v) => !and(...v), "An output is LOW only with BOTH inputs HIGH."), // prettier-ignore
  tripleGate("74LS10", "Triple 3-input NAND", (...v) => !and(...v), "A NAND output is LOW only when every\ninput is HIGH."), // prettier-ignore

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
    "74LS01",
    "Quad 2-input NAND (open-collector)",
    (...v) => !and(...v),
    "",
    QUAD_OUT_FIRST,
    {
      activeLow: true,
      note:
        "74LS01 — Quad 2-input NAND, open-collector\n" +
        "An open-collector output only ever pulls\n" +
        "DOWN, so each LED is its PULL-UP: the lamp\n" +
        "lights when its gate asserts LOW — that is,\n" +
        "when both of its inputs are HIGH. Note the\n" +
        "outputs are on 1/4/10/13, not the '00's.",
    },
  ),

  quadGate(
    "74LS03",
    "Quad 2-input NAND (open-collector)",
    (...v) => !and(...v),
    "",
    QUAD_OUT_LAST,
    {
      activeLow: true,
      note:
        "74LS03 — Quad 2-input NAND, open-collector\n" +
        "The '01's gate on the '00's pinout. Each LED\n" +
        "is the pull-up its open-collector output\n" +
        "needs, so a lit lamp means that gate is\n" +
        "pulling its line LOW.",
    },
  ),

  // ── NOR ────────────────────────────────────────────────────────────────
  quadGate("74LS02", "Quad 2-input NOR", (...v) => !or(...v), "An output is HIGH only with BOTH inputs LOW.", QUAD_OUT_FIRST), // prettier-ignore
  tripleGate("74LS27", "Triple 3-input NOR", (...v) => !or(...v), "A NOR output is HIGH only while every\ninput is LOW."), // prettier-ignore

  // ── Inverter ───────────────────────────────────────────────────────────
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

  hexInverter(
    "74LS05",
    "Hex inverter (open-collector)",
    "74LS05 — Hex inverter, open-collector\n" +
      "Switch A drives gates 1–3, switch B gates\n" +
      "4–6. The outputs only pull DOWN, so each\n" +
      "LED is its own pull-up: a lamp lights when\n" +
      "its inverter asserts LOW — input HIGH.",
    { activeLow: true },
  ),

  hexInverter(
    "74LS14",
    "Hex Schmitt-trigger inverter",
    "74LS14 — Hex Schmitt-trigger inverter\n" +
      "Switch A drives gates 1–3, switch B gates\n" +
      "4–6. The hysteresis that cleans up a slow\n" +
      "edge is an ANALOG property — to the logic\n" +
      "simulation this is a plain hex inverter.",
  ),

  // ── AND ────────────────────────────────────────────────────────────────
  quadGate("74LS08", "Quad 2-input AND", and, "An output is HIGH only with BOTH inputs HIGH."), // prettier-ignore
  tripleGate("74LS11", "Triple 3-input AND", and, "An output is HIGH only with all three\ninputs HIGH."), // prettier-ignore

  // ── OR ─────────────────────────────────────────────────────────────────
  quadGate("74LS32", "Quad 2-input OR", or, "An output is HIGH with EITHER input HIGH."), // prettier-ignore

  // ── XOR ────────────────────────────────────────────────────────────────
  quadGate("74LS86", "Quad 2-input XOR", (x, y) => x !== y, "An output is HIGH while the inputs DIFFER."), // prettier-ignore

  // ── Buffer ─────────────────────────────────────────────────────────────
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

  octalBuffer(
    "74LS240",
    "Octal buffer/line driver (inverting)",
    "74LS240 — Octal buffer, inverting, tri-state\n" +
      "Eight switches in, eight lamps out — but\n" +
      "INVERTED. 1Ḡ enables the first four, 2Ḡ the\n" +
      "second four; a disabled half floats, so its\n" +
      "lamps go dark whatever the switches say.",
    { invert: true },
  ),

  octalBuffer(
    "74LS244",
    "Octal buffer/line driver",
    "74LS244 — Octal buffer, tri-state\n" +
      "Eight switches in, eight lamps out. 1Ḡ\n" +
      "enables the first four, 2Ḡ the second four;\n" +
      "a disabled half floats, so its lamps go dark\n" +
      "whatever the switches say. The bus driver\n" +
      "every 8-bit design has a pair of.",
  ),

  {
    ref: "74LS245",
    title: "Octal bus transceiver",
    note:
      "74LS245 — Octal bus transceiver, tri-state\n" +
      "DIR is tied HIGH, so the part drives A→B:\n" +
      "the switch bank feeds the A side and the\n" +
      "lamps read the B side. ŌĒ floats BOTH sides\n" +
      "— the state that lets two of these share\n" +
      "one bus without a fight.",
    bank: { labels: OCTAL("A"), pins: [2, 3, 4, 5, 6, 7, 8, 9] },
    inputs: [{ label: "/OE", pins: [19] }],
    defaults: [...PATTERN_A, false], // ŌĒ asserted (LOW): the bus is driven
    ties: [{ pins: [1], rail: "+" }], // DIR high: A → B
    leds: [18, 17, 16, 15, 14, 13, 12, 11].map((pin, i) => ({
      pin,
      label: `B${i + 1}`,
      color: "green",
    })),
    cases: [
      [...PATTERN_A, false],
      [...PATTERN_B, false],
      [...PATTERN_A, true], // disabled: the B side floats
    ],
    expect: (v) => (v[8] ? Array(8).fill(false) : v.slice(0, 8)),
  },

  // ── Flip-flop ──────────────────────────────────────────────────────────
  jkFlipFlop("74LS73", "Dual JK flip-flop, clear", {
    clk: [1, 5],
    j1: 14,
    k1: 3,
    j2: 7,
    k2: 10,
    clrN: [2, 6],
    q1: 12,
    qn1: 13,
    q2: 9,
    qn2: 8,
  }),

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

  jkFlipFlop(
    "74LS76",
    "Dual JK flip-flop, preset & clear",
    {
      clk: [1, 6],
      j1: 4,
      k1: 16,
      j2: 9,
      k2: 12,
      clrN: [3, 8],
      preN: [2, 7],
      q1: 14,
      qn1: 15,
      q2: 11,
      qn2: 10,
    },
    "\nNote the non-standard power pins: 5 and 13.",
  ),

  jkFlipFlop("74LS107", "Dual JK flip-flop, clear", {
    clk: [12, 9],
    j1: 1,
    k1: 4,
    j2: 8,
    k2: 11,
    clrN: [13, 10],
    q1: 3,
    qn1: 2,
    q2: 5,
    qn2: 6,
  }),

  jkFlipFlop("74LS112", "Dual JK flip-flop, preset & clear", {
    clk: [1, 13],
    j1: 3,
    k1: 2,
    j2: 11,
    k2: 12,
    clrN: [15, 14],
    preN: [4, 10],
    q1: 5,
    qn1: 6,
    q2: 9,
    qn2: 7,
  }),

  {
    ref: "74LS175",
    title: "Quad D flip-flop",
    note:
      "74LS175 — Quad D flip-flop\n" +
      "One clock and one clear over four D\n" +
      "flip-flops: whatever the D switches say is\n" +
      "captured on the rising edge and HELD until\n" +
      "the next one. A 4-bit register.",
    inputs: [
      { label: "1D", pins: [4] },
      { label: "2D", pins: [5] },
      { label: "3D", pins: [12] },
      { label: "4D", pins: [13] },
      { label: "/CLR", pins: [1] },
    ],
    defaults: [true, false, true, false, true],
    clock: { hz: 1, pins: [9] },
    leds: [
      { pin: 2, label: "1Q", color: "green" },
      { pin: 7, label: "2Q", color: "green" },
      { pin: 10, label: "3Q", color: "green" },
      { pin: 15, label: "4Q", color: "green" },
    ],
    sequential: {
      edges: 6,
      phases: [
        { untilEdge: 3, inputs: { "1D": true, "2D": false, "3D": true, "4D": false } }, // prettier-ignore
        { untilEdge: Infinity, inputs: { "1D": false, "2D": true, "3D": false, "4D": true } }, // prettier-ignore
      ],
      expect: (edges) =>
        edges <= 3 ? [true, false, true, false] : [false, true, false, true],
    },
  },

  {
    ref: "74LS174",
    title: "Hex D flip-flop",
    note:
      "74LS174 — Hex D flip-flop\n" +
      "The '175 six wide (and with no Q̄): one\n" +
      "clock, one clear, six bits captured on the\n" +
      "rising edge. Change the switches and\n" +
      "nothing moves until the next edge.",
    inputs: [
      { label: "1D", pins: [3] },
      { label: "2D", pins: [4] },
      { label: "3D", pins: [6] },
      { label: "4D", pins: [11] },
      { label: "5D", pins: [13] },
      { label: "6D", pins: [14] },
      { label: "/CLR", pins: [1] },
    ],
    defaults: [true, false, true, true, false, false, true],
    clock: { hz: 1, pins: [9] },
    leds: [2, 5, 7, 10, 12, 15].map((pin, i) => ({
      pin,
      label: `${i + 1}Q`,
      color: "green",
    })),
    sequential: {
      edges: 6,
      phases: [
        { untilEdge: 3, inputs: { "1D": true, "2D": false, "3D": true, "4D": true, "5D": false, "6D": false } }, // prettier-ignore
        { untilEdge: Infinity, inputs: { "1D": false, "2D": true, "3D": false, "4D": false, "5D": true, "6D": true } }, // prettier-ignore
      ],
      expect: (edges) =>
        edges <= 3
          ? [true, false, true, true, false, false]
          : [false, true, false, false, true, true],
    },
  },

  {
    ref: "74LS273",
    title: "Octal D flip-flop, clear",
    note:
      "74LS273 — Octal D flip-flop with clear\n" +
      "A whole byte captured on one rising edge.\n" +
      "Set the switch bank, clock it, and the row\n" +
      "of lamps holds that byte until the next\n" +
      "edge — or until /CLR wipes it.",
    bank: { labels: OCTAL("D"), pins: [3, 4, 7, 8, 13, 14, 17, 18] },
    inputs: [{ label: "/CLR", pins: [1] }],
    defaults: [...PATTERN_A, true],
    clock: { hz: 1, pins: [11] },
    leds: [2, 5, 6, 9, 12, 15, 16, 19].map((pin, i) => ({
      pin,
      label: `${i + 1}Q`,
      color: "green",
    })),
    sequential: {
      edges: 6,
      phases: [
        { untilEdge: 3, inputs: bankOverride(OCTAL("D"), PATTERN_A) },
        { untilEdge: Infinity, inputs: bankOverride(OCTAL("D"), PATTERN_B) },
      ],
      expect: (edges) => (edges <= 3 ? PATTERN_A : PATTERN_B),
    },
  },

  // ── Latch ──────────────────────────────────────────────────────────────
  {
    ref: "74LS75",
    title: "4-bit bistable latch",
    note:
      "74LS75 — 4-bit transparent latch\n" +
      "This one has no clock EDGE at all: while E\n" +
      "is HIGH each Q simply FOLLOWS its D, and\n" +
      "the moment E goes LOW the four of them\n" +
      "freeze. Transparent, then latched.",
    inputs: [
      { label: "1D", pins: [2] },
      { label: "2D", pins: [3] },
      { label: "3D", pins: [6] },
      { label: "4D", pins: [7] },
      { label: "E", pins: [13, 4] },
    ],
    defaults: [true, false, true, false, true],
    leds: [
      { pin: 16, label: "1Q", color: "green" },
      { pin: 15, label: "2Q", color: "green" },
      { pin: 10, label: "3Q", color: "green" },
      { pin: 9, label: "4Q", color: "green" },
    ],
    sequential: {
      edges: 6,
      phases: [
        { untilEdge: 2, inputs: { "1D": true, "2D": false, "3D": true, "4D": false, E: true } }, // prettier-ignore
        { untilEdge: 4, inputs: { "1D": false, "2D": true, "3D": false, "4D": true, E: false } }, // prettier-ignore
        { untilEdge: Infinity, inputs: { "1D": false, "2D": true, "3D": false, "4D": true, E: true } }, // prettier-ignore
      ],
      expect: (edges) =>
        edges <= 4
          ? [true, false, true, false] // followed, then held through E low
          : [false, true, false, true], // transparent again
    },
  },

  {
    ref: "74LS279",
    title: "Quad S̄R̄ latch",
    note:
      "74LS279 — Quad S̄R̄ latch\n" +
      "The simplest memory there is. Latch 1 is on\n" +
      "the switches: pull /S low to SET, /R low to\n" +
      "RESET, both high to HOLD. The other three\n" +
      "are strapped set, reset and holding, so all\n" +
      "four states are on the board at once.",
    inputs: [
      { label: "/S", pins: [2] }, // latch 1 set (its S2 is tied high)
      { label: "/R", pins: [1] },
    ],
    defaults: [true, true], // holding
    ties: [
      { pins: [3], rail: "+" }, // 1S2 inactive — one set input is enough
      { pins: [6], rail: "-" }, // latch 2: strapped SET
      { pins: [5], rail: "+" },
      { pins: [10], rail: "-" }, // latch 3: strapped RESET
      { pins: [11, 12], rail: "+" },
      { pins: [14, 15], rail: "+" }, // latch 4: both inputs idle → holds
    ],
    leds: [
      { pin: 4, label: "1Q", color: "green" },
      { pin: 7, label: "2Q" },
      { pin: 9, label: "3Q" },
      { pin: 13, label: "4Q" },
    ],
    sequential: {
      edges: 6,
      phases: [
        { untilEdge: 2, inputs: { "/S": false, "/R": true } }, // set
        { untilEdge: 4, inputs: { "/S": true, "/R": true } }, // hold
        { untilEdge: Infinity, inputs: { "/S": true, "/R": false } }, // reset
      ],
      // Latch 2 is strapped set, latch 3 strapped reset, latch 4 holds the
      // state it powered up in (cleared).
      expect: (edges) => [edges <= 4, true, false, false],
    },
  },

  {
    ref: "74LS259",
    title: "8-bit addressable latch",
    note:
      "74LS259 — 8-bit addressable latch\n" +
      "Eight latches behind three address lines:\n" +
      "pick one with A0–A2, put a bit on D, and\n" +
      "pull Ḡ low to write JUST that one. The\n" +
      "other seven keep what they had. /CLR wipes\n" +
      "the lot.",
    inputs: [
      { label: "A0", pins: [1] },
      { label: "A1", pins: [2] },
      { label: "A2", pins: [3] },
      { label: "D", pins: [13] },
      { label: "/G", pins: [14] },
      { label: "/CLR", pins: [15] },
    ],
    defaults: [false, false, false, true, true, true],
    leds: [4, 5, 6, 7, 9, 10, 11, 12].map((pin, i) => ({
      pin,
      label: `Q${i}`,
      color: "green",
    })),
    sequential: {
      edges: 8,
      phases: [
        // Write a 1 into latch 0, then into latch 3, then hold, then clear.
        { untilEdge: 2, inputs: { A0: false, A1: false, A2: false, D: true, "/G": false } }, // prettier-ignore
        { untilEdge: 4, inputs: { A0: true, A1: true, A2: false, D: true, "/G": false } }, // prettier-ignore
        { untilEdge: 6, inputs: { "/G": true } },
        { untilEdge: Infinity, inputs: { "/G": true, "/CLR": false } },
      ],
      expect: (edges) => {
        if (edges <= 2) return [true, false, false, false, false, false, false, false]; // prettier-ignore
        if (edges <= 6) return [true, false, false, true, false, false, false, false]; // prettier-ignore
        return Array(8).fill(false); // cleared
      },
    },
  },

  octalLatch(
    "74LS533",
    "Octal transparent latch (inverting)",
    "74LS533 — Octal latch, inverting, tri-state\n" +
      "The '573's twin with INVERTED outputs — and\n" +
      "the older interleaved pinout, D and Q̄ in\n" +
      "pairs down the package. LE high follows,\n" +
      "LE low freezes, ŌĒ floats the lot.",
    {
      invert: true,
      d: [3, 4, 7, 8, 13, 14, 17, 18],
      q: [2, 5, 6, 9, 12, 15, 16, 19],
    },
  ),

  octalLatch(
    "74LS573",
    "Octal transparent latch",
    "74LS573 — Octal latch, tri-state\n" +
      "A whole byte held with no clock edge: LE\n" +
      "HIGH and the lamps follow the switches, LE\n" +
      "LOW and they freeze. ŌĒ floats the outputs\n" +
      "so something else can drive the bus. Note\n" +
      "the tidy pinout — all D one side, all Q the\n" +
      "other.",
    { d: [2, 3, 4, 5, 6, 7, 8, 9], q: [19, 18, 17, 16, 15, 14, 13, 12] },
  ),

  // ── Counter ────────────────────────────────────────────────────────────
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
        return [...bitsOf(n, 4), n === 15];
      },
    },
  },

  {
    ref: "74LS193",
    title: "Synchronous up/down counter",
    note:
      "74LS193 — Up/down 4-bit counter\n" +
      "This part has TWO clock inputs — one to\n" +
      "count up, one to count down — so the clock\n" +
      "goes through a switch that hands it to one\n" +
      "or the other. Whichever is not selected\n" +
      "floats HIGH, which is its idle level.",
    route: { label: "UP/DN", pins: [5, 4] }, // throw 1 → CPU, throw 2 → CPD
    clock: { hz: 2, pins: [] },
    defaults: [true], // counting up
    ties: [
      { pins: [11], rail: "+" }, // LOAD inactive
      { pins: [14], rail: "-" }, // CLR (active HIGH) inactive
      { pins: [15, 1, 10, 9], rail: "-" }, // preset data
    ],
    leds: [
      { pin: 3, label: "QA", color: "green" },
      { pin: 2, label: "QB", color: "green" },
      { pin: 6, label: "QC", color: "green" },
      { pin: 7, label: "QD", color: "green" },
      { pin: 12, label: "CO", activeLow: true, color: "yellow" },
      { pin: 13, label: "BO", activeLow: true, color: "yellow" },
    ],
    sequential: {
      edges: 12,
      phases: [
        { untilEdge: 5, inputs: { "UP/DN": true } },
        { untilEdge: Infinity, inputs: { "UP/DN": false } },
      ],
      expect: (edges) => {
        const n = edges <= 5 ? edges : (5 - (edges - 5) + 16) % 16;
        // C̄O and B̄O only assert while their own clock is LOW, and the LEDs
        // are read just after a rising edge — so they are dark here.
        return [...bitsOf(n, 4), false, false];
      },
    },
  },

  {
    ref: "74LS169",
    title: "Synchronous up/down counter",
    note:
      "74LS169 — Up/down 4-bit counter\n" +
      "One clock, and a DIRECTION input: U/D̄ high\n" +
      "counts up, low counts down. Both count\n" +
      "enables are tied low (always counting) and\n" +
      "LOAD̄ high. RCŌ asserts at the end of the\n" +
      "run — 15 going up, 0 going down.",
    inputs: [{ label: "U/D", pins: [1] }],
    defaults: [true],
    ties: [
      { pins: [7, 10], rail: "-" }, // ENP̄, ENT̄ asserted
      { pins: [9], rail: "+" }, // LOAD̄ inactive
      { pins: [3, 4, 5, 6], rail: "-" }, // preset data
    ],
    clock: { hz: 2, pins: [2] },
    leds: [
      { pin: 14, label: "QA", color: "green" },
      { pin: 13, label: "QB", color: "green" },
      { pin: 12, label: "QC", color: "green" },
      { pin: 11, label: "QD", color: "green" },
      { pin: 15, label: "RCO", activeLow: true, color: "yellow" },
    ],
    sequential: {
      edges: 12,
      phases: [
        { untilEdge: 5, inputs: { "U/D": true } },
        { untilEdge: Infinity, inputs: { "U/D": false } },
      ],
      expect: (edges) => {
        const up = edges <= 5;
        const n = up ? edges : (5 - (edges - 5) + 16) % 16;
        const terminal = up ? n === 15 : n === 0;
        return [...bitsOf(n, 4), terminal];
      },
    },
  },

  {
    ref: "74LS90",
    title: "Decade (÷10) ripple counter",
    note:
      "74LS90 — Decade ripple counter\n" +
      "Two counters in one package: a ÷2 on QA and\n" +
      "a ÷5 on QB–QD. Wire QA into CKB — the blue\n" +
      "jumper — and they become the ÷10 the part\n" +
      "is named for. RESET forces 0.",
    inputs: [{ label: "RESET", pins: [2] }],
    defaults: [false], // counting
    links: [[12, 1]], // QA → CKB: the ripple that makes it a decade
    ties: [
      { pins: [3], rail: "+" }, // R0(2) high, so RESET alone gates the reset
      { pins: [6, 7], rail: "-" }, // R9(1), R9(2): no set-to-nine
    ],
    clock: { hz: 2, pins: [14] }, // CKA
    leds: [
      { pin: 12, label: "QA", color: "green" },
      { pin: 9, label: "QB", color: "green" },
      { pin: 8, label: "QC", color: "green" },
      { pin: 11, label: "QD", color: "green" },
    ],
    sequential: {
      // A '90 clocks on the FALLING edge, which lands between the rising ones.
      expect: (edges) => bitsOf((edges - 1) % 10, 4),
    },
  },

  // ── Shift register ─────────────────────────────────────────────────────
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

  {
    ref: "74LS165",
    title: "8-bit PISO shift register",
    note:
      "74LS165 — Parallel-in, serial-out\n" +
      "The '164 backwards: the switch bank is\n" +
      "loaded in PARALLEL while LOAD̄ is low, then\n" +
      "LOAD̄ goes high and each clock edge walks\n" +
      "the byte out of QH one bit at a time —\n" +
      "H first, A last.",
    bank: { labels: OCTAL("D"), pins: [11, 12, 13, 14, 3, 4, 5, 6] },
    inputs: [{ label: "/LOAD", pins: [1] }],
    defaults: [...PATTERN_A, false], // sitting in load, showing the byte
    ties: [
      { pins: [15], rail: "-" }, // INH̄: never inhibited
      { pins: [10], rail: "-" }, // SER: zeros follow the byte out
    ],
    clock: { hz: 1, pins: [2] },
    leds: [
      { pin: 9, label: "QH", color: "green" },
      { pin: 7, label: "Q̄H" },
    ],
    sequential: {
      edges: 10,
      phases: [
        { untilEdge: 1, inputs: { "/LOAD": false } }, // load the byte
        { untilEdge: Infinity, inputs: { "/LOAD": true } }, // then shift it out
      ],
      // Bit H (index 7) is at QH after the load; each edge brings the next
      // one down. Past the eighth, SER's zeros arrive.
      expect: (edges) => {
        const q = edges <= 8 ? PATTERN_A[8 - edges] : false;
        return [q, !q];
      },
    },
  },

  {
    ref: "74LS595",
    title: "8-bit shift register with output latch",
    note:
      "74LS595 — Shift register + storage latch\n" +
      "TWO registers in one part. Bits shift along\n" +
      "the first on every clock edge, and nothing\n" +
      "shows: the lamps hang off the second one.\n" +
      "Flip LATCH to copy the shifted byte across —\n" +
      "which is how a display keeps still while\n" +
      "the data behind it is still moving.",
    inputs: [
      { label: "SER", pins: [14] },
      { label: "LATCH", pins: [12] }, // RCLK, pulsed by hand
      { label: "/SRCLR", pins: [10] },
    ],
    defaults: [true, false, true],
    ties: [{ pins: [13], rail: "-" }], // ŌĒ: outputs always driven
    clock: { hz: 1, pins: [11] }, // SRCLK only
    leds: [15, 1, 2, 3, 4, 5, 6, 7].map((pin, i) => ({
      pin,
      label: `Q${"ABCDEFGH"[i]}`,
      color: "green",
    })),
    sequential: {
      edges: 8,
      phases: [
        // Shift three ones in with the latch held low — the lamps stay dark…
        { untilEdge: 3, inputs: { SER: true, LATCH: false } },
        // …then one rising edge on LATCH publishes exactly those three.
        { untilEdge: Infinity, inputs: { SER: true, LATCH: true } },
      ],
      expect: (edges) =>
        Array.from({ length: 8 }, (_, i) => edges > 3 && i < 3),
    },
  },

  // ── Decoder ────────────────────────────────────────────────────────────
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
    expect: (v) => {
      const sel = word(v, 0, 3);
      return Array.from({ length: 8 }, (_, i) => i === sel);
    },
  },

  {
    ref: "74LS139",
    title: "Dual 2-to-4 line decoder",
    note:
      "74LS139 — Dual 2-to-4 decoder\n" +
      "Two independent decoders in one package,\n" +
      "each with its own active-low enable. Both\n" +
      "sets of outputs are active LOW, so the\n" +
      "lamps are wired the other way up: one lit\n" +
      "per half, none at all while its Ḡ is high.",
    inputs: [
      { label: "1G", pins: [1] },
      { label: "1A", pins: [2] },
      { label: "1B", pins: [3] },
      { label: "2G", pins: [15] },
      { label: "2A", pins: [14] },
      { label: "2B", pins: [13] },
    ],
    defaults: [false, true, false, false, false, true],
    leds: [
      ...[4, 5, 6, 7].map((pin, i) => ({ pin, label: `1Y${i}`, activeLow: true, color: "green" })), // prettier-ignore
      ...[12, 11, 10, 9].map((pin, i) => ({ pin, label: `2Y${i}`, activeLow: true, color: "yellow" })), // prettier-ignore
    ],
    expect: ([g1, a1, b1, g2, a2, b2]) => {
      const one = num([a1, b1]);
      const two = num([a2, b2]);
      return [
        ...Array.from({ length: 4 }, (_, i) => !g1 && i === one),
        ...Array.from({ length: 4 }, (_, i) => !g2 && i === two),
      ];
    },
  },

  // ── Register ───────────────────────────────────────────────────────────
  {
    ref: "74LS173",
    title: "4-bit D register (tri-state)",
    note:
      "74LS173 — 4-bit register, tri-state\n" +
      "A register with a DATA enable as well as a\n" +
      "clock: with Ḡ low the switches are captured\n" +
      "on each rising edge, with Ḡ high the clock\n" +
      "keeps running and the register simply holds.",
    inputs: [
      { label: "1D", pins: [14] },
      { label: "2D", pins: [13] },
      { label: "3D", pins: [12] },
      { label: "4D", pins: [11] },
      { label: "/G", pins: [9, 10] },
    ],
    defaults: [true, false, true, false, false],
    ties: [
      { pins: [1, 2], rail: "-" }, // M̄, N̄: outputs always enabled
      { pins: [15], rail: "-" }, // CLR (active HIGH) inactive
    ],
    clock: { hz: 1, pins: [7] },
    leds: [3, 4, 5, 6].map((pin, i) => ({
      pin,
      label: `${i + 1}Q`,
      color: "green",
    })),
    sequential: {
      edges: 6,
      phases: [
        { untilEdge: 2, inputs: { "1D": true, "2D": false, "3D": true, "4D": false, "/G": false } }, // prettier-ignore
        { untilEdge: 4, inputs: { "1D": false, "2D": true, "3D": false, "4D": true, "/G": true } }, // prettier-ignore
        { untilEdge: Infinity, inputs: { "1D": false, "2D": true, "3D": false, "4D": true, "/G": false } }, // prettier-ignore
      ],
      expect: (edges) =>
        edges <= 4
          ? [true, false, true, false] // loaded, then HELD through Ḡ high
          : [false, true, false, true],
    },
  },

  // ── Multiplexer ────────────────────────────────────────────────────────
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
    expect: (v) => {
      const y = MUX_PATTERN[word(v, 0, 3)];
      return [y, !y];
    },
  },

  {
    ref: "74LS153",
    title: "Dual 4-to-1 multiplexer",
    note:
      "74LS153 — Dual 4-to-1 multiplexer\n" +
      "Two muxes sharing one pair of select lines:\n" +
      "A and B pick the same position out of each\n" +
      "of two hard-wired words (0110 and 1001), so\n" +
      "1Y and 2Y read out two different patterns\n" +
      "from one address.",
    inputs: [
      { label: "A", pins: [14] },
      { label: "B", pins: [2] },
    ],
    defaults: [true, false],
    ties: [
      { pins: [1, 15], rail: "-" }, // both strobes enabled
      { pins: [6, 5, 4, 3].filter((_, i) => MUX1[i]), rail: "+" },
      { pins: [6, 5, 4, 3].filter((_, i) => !MUX1[i]), rail: "-" },
      { pins: [10, 11, 12, 13].filter((_, i) => MUX2[i]), rail: "+" },
      { pins: [10, 11, 12, 13].filter((_, i) => !MUX2[i]), rail: "-" },
    ],
    leds: [
      { pin: 7, label: "1Y", color: "green" },
      { pin: 9, label: "2Y", color: "yellow" },
    ],
    expect: (v) => {
      const sel = word(v, 0, 2);
      return [MUX1[sel], MUX2[sel]];
    },
  },

  selector(
    "74LS157",
    "Quad 2-to-1 selector",
    "74LS157 — Quad 2-to-1 selector\n" +
      "Four bits of A or four bits of B, picked by\n" +
      "ONE switch: S low passes A (1011), S high\n" +
      "passes B (0110). Ḡ high forces every output\n" +
      "LOW — driven, not floating.",
    { enable: 15, tristate: false },
  ),

  selector(
    "74LS257",
    "Quad 2-to-1 selector (tri-state)",
    "74LS257 — Quad 2-to-1 selector, tri-state\n" +
      "The '157 with three-state outputs: same A/B\n" +
      "selection, but ŌĒ high FLOATS the outputs\n" +
      "instead of forcing them low — the version\n" +
      "you can hang on a shared bus.",
    { enable: 15, tristate: true },
  ),

  // ── Display driver ─────────────────────────────────────────────────────
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

  // ── Comparator ─────────────────────────────────────────────────────────
  {
    ref: "74LS85",
    title: "4-bit magnitude comparator",
    note:
      "74LS85 — 4-bit magnitude comparator\n" +
      "Two 4-bit words off one switch bank: A on\n" +
      "the left four, B on the right four. Exactly\n" +
      "one of the three lamps is lit — greater,\n" +
      "equal, or less. The cascade inputs are\n" +
      "strapped for a single stage (A=B high).",
    bank: {
      labels: ["A0", "A1", "A2", "A3", "B0", "B1", "B2", "B3"],
      pins: [10, 12, 13, 15, 9, 11, 14, 1],
    },
    defaults: [true, false, true, false, false, true, false, false], // 5 vs 2
    ties: [
      { pins: [3], rail: "+" }, // IA=B high…
      { pins: [4, 2], rail: "-" }, // …IA>B and IA<B low: one stage on its own
    ],
    leds: [
      { pin: 5, label: "A>B", color: "green" },
      { pin: 6, label: "A=B", color: "yellow" },
      { pin: 7, label: "A<B" },
    ],
    expect: (v) => {
      const a = word(v, 0, 4);
      const b = word(v, 4, 4);
      return [a > b, a === b, a < b];
    },
  },

  // ── Encoder ────────────────────────────────────────────────────────────
  {
    ref: "74LS148",
    title: "8-to-3 priority encoder",
    note:
      "74LS148 — 8-to-3 priority encoder\n" +
      "The mirror of the '138. Its inputs are\n" +
      "ACTIVE LOW, so OPENING a switch is what\n" +
      "requests that line, and the highest one\n" +
      "open wins. A0–A2 read out its number, GS\n" +
      "says something asked, EO says nothing did.",
    bank: {
      labels: ["I0", "I1", "I2", "I3", "I4", "I5", "I6", "I7"],
      pins: [10, 11, 12, 13, 1, 2, 3, 4],
    },
    // Every line idle but I5 — the demo opens showing the code for 5.
    defaults: [true, true, true, true, true, false, true, true],
    ties: [{ pins: [5], rail: "-" }], // EI̅: the encoder is enabled
    leds: [
      { pin: 9, label: "A0", activeLow: true, color: "green" },
      { pin: 7, label: "A1", activeLow: true, color: "green" },
      { pin: 6, label: "A2", activeLow: true, color: "green" },
      { pin: 14, label: "GS", activeLow: true, color: "yellow" },
      { pin: 15, label: "EO", activeLow: true },
    ],
    expect: (v) => {
      // A closed switch is HIGH — and these inputs are active LOW, so an OPEN
      // switch is the one asking. Highest index wins.
      let highest = -1;
      v.forEach((closed, i) => {
        if (!closed) highest = i;
      });
      if (highest < 0) return [false, false, false, false, true]; // only EO
      return [...bitsOf(highest, 3), true, false];
    },
  },

  // ── Arithmetic ─────────────────────────────────────────────────────────
  adder(
    "74LS283",
    "4-bit binary full adder",
    "74LS283 — 4-bit full adder\n" +
      "A on the left four switches, B on the right\n" +
      "four, and the lamps are their SUM: four\n" +
      "bits plus the carry out. Carry in is tied\n" +
      "low. Every one of the 256 sums is checked.",
    {
      a: [5, 3, 14, 12],
      b: [6, 2, 15, 11],
      cin: 7,
      s: [4, 1, 13, 10],
      cout: 9,
    },
  ),

  adder(
    "74LS83",
    "4-bit binary adder (original pinout)",
    "74LS83 — 4-bit adder, the ORIGINAL pinout\n" +
      "Electrically the '283, but from before the\n" +
      "corners were standardised: VCC is on pin 5\n" +
      "and ground on pin 12. The bench wires\n" +
      "whatever the datasheet says.",
    {
      a: [10, 8, 3, 1],
      b: [11, 7, 4, 16],
      cin: 13,
      s: [9, 6, 2, 15],
      cout: 14,
    },
  ),

  {
    ref: "74LS181",
    title: "4-bit Arithmetic Logic Unit",
    note:
      "74LS181 — 4-bit ALU\n" +
      "The chip at the heart of a 1970s CPU. A and\n" +
      "B come off the switch bank; S0–S3 pick the\n" +
      "function. M is tied HIGH, so this desktop\n" +
      "is in LOGIC mode: NOT, AND, OR, XOR and the\n" +
      "rest of the sixteen, on four bits at once.",
    bank: {
      labels: ["A0", "A1", "A2", "A3", "B0", "B1", "B2", "B3"],
      pins: [2, 23, 21, 19, 1, 22, 20, 18],
    },
    inputs: [
      { label: "S0", pins: [6] },
      { label: "S1", pins: [5] },
      { label: "S2", pins: [4] },
      { label: "S3", pins: [3] },
    ],
    // A = 1010 (10), B = 0110 (6), S = 0110 → A ⊕ B.
    defaults: [false, true, false, true, false, true, true, false, false, true, true, false], // prettier-ignore
    ties: [
      { pins: [8], rail: "+" }, // M: logic mode
      { pins: [7], rail: "+" }, // Cn: unused with M high
    ],
    leds: [9, 10, 11, 13].map((pin, i) => ({
      pin,
      label: `F${i}`,
      color: "green",
    })),
    // Twelve switched inputs is 4096 combinations — check the functions the
    // demo actually claims, against two fixed operands.
    cases: Object.keys(ALU_LOGIC).map((sel) => [
      ...bitsOf(0b1010, 4), // A = 10
      ...bitsOf(0b0110, 4), // B = 6
      ...bitsOf(Number(sel), 4),
    ]),
    expect: (v) => {
      const fn = ALU_LOGIC[word(v, 8, 4)];
      if (!fn) return null; // a function this demo doesn't pin down
      return bitsOf(fn(word(v, 0, 4), word(v, 4, 4)) & 0xf, 4);
    },
  },
]);

// ── Spec shapes shared by a whole family ─────────────────────────────────
// Declared after DEMOS purely so the table above reads top-down; hoisting
// makes them available to it.

/** Every bank label → its bit in `pattern` (a phase override for a whole word). */
function bankOverride(labels, pattern) {
  return Object.fromEntries(labels.map((label, i) => [label, pattern[i]]));
}

/**
 * The '240/'244 octal line drivers: a switch bank in, eight lamps out, and two
 * active-low enables that float half the outputs each.
 */
function octalBuffer(ref, title, note, { invert = false } = {}) {
  return {
    ref,
    title,
    note,
    bank: { labels: OCTAL("A"), pins: [2, 4, 6, 8, 11, 13, 15, 17] },
    inputs: [
      { label: "/1G", pins: [1] },
      { label: "/2G", pins: [19] },
    ],
    defaults: [...PATTERN_A, false, false], // both halves enabled
    leds: [18, 16, 14, 12, 9, 7, 5, 3].map((pin, i) => ({
      pin,
      label: `Y${i + 1}`,
      color: "green",
    })),
    cases: [
      [...PATTERN_A, false, false],
      [...PATTERN_B, false, false],
      [...PATTERN_A, true, false], // first half floating
      [...PATTERN_A, false, true], // second half floating
      [...PATTERN_A, true, true], // both floating
    ],
    expect: (v) => {
      const drive = (bit, off) => (off ? false : invert ? !bit : bit);
      return v.slice(0, 8).map((bit, i) => drive(bit, i < 4 ? v[8] : v[9]));
    },
  };
}

/**
 * The '533/'573 octal transparent latches: a switch bank in, eight lamps out,
 * an LE that freezes them and an ŌĒ that floats them.
 */
function octalLatch(ref, title, note, { invert = false, d, q }) {
  const labels = OCTAL("D");
  return {
    ref,
    title,
    note,
    bank: { labels, pins: d },
    inputs: [
      { label: "LE", pins: [11] },
      { label: "/OE", pins: [1] },
    ],
    defaults: [...PATTERN_A, true, false], // transparent, and driving
    leds: q.map((pin, i) => ({
      pin,
      label: `${i + 1}Q${invert ? "̄" : ""}`,
      color: "green",
    })),
    sequential: {
      edges: 8,
      phases: [
        { untilEdge: 2, inputs: { ...bankOverride(labels, PATTERN_A), LE: true, "/OE": false } }, // prettier-ignore
        { untilEdge: 4, inputs: { ...bankOverride(labels, PATTERN_B), LE: false, "/OE": false } }, // prettier-ignore
        { untilEdge: 6, inputs: { ...bankOverride(labels, PATTERN_B), LE: false, "/OE": true } }, // prettier-ignore
        { untilEdge: Infinity, inputs: { ...bankOverride(labels, PATTERN_B), LE: true, "/OE": false } }, // prettier-ignore
      ],
      expect: (edges) => {
        const shown = (bits) => bits.map((b) => (invert ? !b : b));
        if (edges <= 2) return shown(PATTERN_A); // following D
        if (edges <= 4) return shown(PATTERN_A); // …and held when LE fell
        if (edges <= 6) return Array(8).fill(false); // outputs floating
        return shown(PATTERN_B); // transparent again
      },
    },
  };
}

/** The '157/'257 quad 2-to-1 selectors, which differ only in what disabling does. */
function selector(ref, title, note, { enable, tristate }) {
  return {
    ref,
    title,
    note,
    inputs: [
      { label: "S", pins: [1] },
      { label: tristate ? "/OE" : "/G", pins: [enable] },
    ],
    defaults: [false, false], // passing A, enabled
    ties: [
      { pins: [2, 5, 11, 14].filter((_, i) => SEL_A[i]), rail: "+" },
      { pins: [2, 5, 11, 14].filter((_, i) => !SEL_A[i]), rail: "-" },
      { pins: [3, 6, 10, 13].filter((_, i) => SEL_B[i]), rail: "+" },
      { pins: [3, 6, 10, 13].filter((_, i) => !SEL_B[i]), rail: "-" },
    ],
    leds: [4, 7, 9, 12].map((pin, i) => ({
      pin,
      label: `${i + 1}Y`,
      color: "green",
    })),
    // Disabled reads the same either way — a floating output and one forced
    // LOW both leave the lamp dark; the difference matters on a shared bus.
    expect: ([s, off]) =>
      off ? Array(4).fill(false) : (s ? SEL_B : SEL_A).slice(),
  };
}

/** The '283/'83 4-bit adders: same arithmetic, two different pinouts. */
function adder(ref, title, note, pins) {
  return {
    ref,
    title,
    note,
    bank: {
      labels: ["A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4"],
      pins: [...pins.a, ...pins.b],
    },
    defaults: [true, false, true, false, false, true, true, false], // 5 + 6
    ties: [{ pins: [pins.cin], rail: "-" }], // carry in: zero
    leds: [
      ...pins.s.map((pin, i) => ({ pin, label: `S${i + 1}`, color: "green" })),
      { pin: pins.cout, label: "C4", color: "yellow" },
    ],
    expect: (v) => {
      const sum = word(v, 0, 4) + word(v, 4, 4);
      return bitsOf(sum, 5);
    },
  };
}
