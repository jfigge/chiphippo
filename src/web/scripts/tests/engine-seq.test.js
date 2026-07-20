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

// Feature 100 engine fixtures: the two-phase tick over sequential & MSI parts.
// Circuits are built in code (board + PSU + clock + chip + wires) and clocked
// edge by edge; we assert settled output levels. Covers the two-phase
// race-through contract, a 7474 divide-by-two, JK toggling, the 74161 counter
// (count / carry / async clear), a 74164 shift, and the combinational MSI
// (74138 decoder, 74151 mux, 7475 latch transparency, 74193 up/down).

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { tick as engineTick } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

// ── Fixture builders ─────────────────────────────────────────────────────────

let wireSeq = 0;
const wire = (from, to) => ({ id: `w${++wireSeq}`, from, to, color: "black" });

// One full breadboard, as the strips it is really made of: the pin-board
// (bb1) plus the top/bottom power-rail strips (bb2/bb3) that dovetail on.
const board = { id: "bb1", type: "pins-full", x: 0, y: 4 };
const railTop = { id: "bb2", type: "rail-full", x: 0, y: 0 };
const railBottom = { id: "bb3", type: "rail-full", x: 0, y: 18 };
const boards = [board, railTop, railBottom];

const psu = (id, x, volts = 5) => ({
  id,
  kind: "psu",
  ref: "psu",
  x,
  y: 0,
  params: { volts },
});
const clock = (id, x) => ({
  id,
  kind: "clock",
  ref: "clock",
  x,
  y: 12,
  params: { hz: "manual" },
});
const chip = (id, ref, anchor) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params: {},
});

function holesOf(ref, anchor) {
  const m = new Map();
  for (const { pin, hole } of partPinHoles(ref, anchor)) m.set(pin, hole);
  return m;
}
const mates = (hole) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole);
/** A free hole address on the strip of pin `pin` (index picks among mates). */
const strip = (holes, pin, i = 0) => `bb1.${mates(holes.get(pin))[i]}`;

// The rail strips carry the +5 V and ground buses (each rail is one node with
// 50 holes — plenty of tie points, unlike a 5-hole column strip).
const HI = (k) => `bb2.+${k}`;
const LO = (k) => `bb3.-${k}`;

/** Power a chip: VCC/GND pins tie to the rails energized by the PSU. */
const power = (psuId, holes, vccPin, gndPin) => [
  wire(`${psuId}.+`, HI(1)),
  wire(`${psuId}.-`, LO(1)),
  wire(strip(holes, vccPin, 0), HI(2)),
  wire(strip(holes, gndPin, 0), LO(2)),
];

/** A tiny stepping harness over the pure engine. */
class Harness {
  constructor(doc) {
    this.doc = doc;
    this.netlist = buildNetlist(doc);
    this.warm = new Map();
    this.state = new Map();
    this.prev = new Map();
    this.phase = new Map();
    for (const c of doc.components) {
      if (c.kind === "clock") this.phase.set(c.id, L); // clocks idle low
    }
  }
  set(id, level) {
    this.phase.set(id, level);
    return this.tick();
  }
  tick() {
    const r = engineTick({
      document: this.doc,
      netlist: this.netlist,
      warmStart: this.warm,
      state: this.state,
      prevPinLevels: this.prev,
      clockPhase: this.phase,
    });
    this.warm = r.netLevels;
    this.state = r.state;
    this.prev = r.pinLevels;
    this.last = r;
    return r;
  }
  /** One rising edge (low, then high). */
  rise(id) {
    this.set(id, L);
    return this.set(id, H);
  }
  /** One falling edge (high, then low). */
  fall(id) {
    this.set(id, H);
    return this.set(id, L);
  }
  level(addr) {
    return this.warm.get(this.netlist.netOfPoint.get(addr));
  }
  /** The level on the strip carrying chip pin `pin`. */
  pin(holes, pin) {
    return this.level(`bb1.${holes.get(pin)}`);
  }
}

// ── Two-phase correctness: the classic race-through check ─────────────────────

test("chained 7474 FFs shift without falling through in one tick", () => {
  // Both FFs share one clock; Q1 → D2. On a rising edge FF2 must capture the
  // PRE-edge Q1, not the value FF1 takes this same tick.
  const h = holesOf("7474", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), clock("clk1", 90), chip("c1", "7474", "e10")],
    wires: [
      ...power("psu1", h, 14, 7),
      wire("clk1.out", strip(h, 3, 0)), // clock → 1CLK
      wire(strip(h, 3, 1), strip(h, 11, 0)), // 1CLK strip → 2CLK strip (shared)
      wire(strip(h, 5, 0), strip(h, 12, 0)), // 1Q → 2D
      // 1D (pin 2) floats → H (the value shifting in).
    ],
  };
  const bench = new Harness(doc);
  // First rising edge: FF1 latches D1=H → Q1=H; FF2 latches OLD Q1=L → Q2=L.
  bench.rise("clk1");
  assert.equal(bench.pin(h, 5), H, "Q1 high after first edge");
  assert.equal(bench.pin(h, 9), L, "Q2 still low — no fall-through");
  // Second rising edge: FF2 now sees Q1=H → Q2=H.
  bench.rise("clk1");
  assert.equal(bench.pin(h, 9), H, "Q2 follows one edge behind");
});

// ── 7474 divide-by-two ───────────────────────────────────────────────────────

test("a 7474 wired Q̄→D divides the clock by two", () => {
  const h = holesOf("7474", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), clock("clk1", 90), chip("c1", "7474", "e10")],
    wires: [
      ...power("psu1", h, 14, 7),
      wire("clk1.out", strip(h, 3, 0)), // clock → 1CLK
      wire(strip(h, 6, 0), strip(h, 2, 0)), // 1Q̄ → 1D
    ],
  };
  const bench = new Harness(doc);
  const q = () => bench.pin(h, 5); // 1Q
  bench.tick(); // settle the power-up state
  assert.equal(q(), L, "starts low");
  bench.rise("clk1");
  assert.equal(q(), H, "toggles on edge 1");
  bench.rise("clk1");
  assert.equal(q(), L, "toggles on edge 2 — half the clock rate");
  bench.rise("clk1");
  assert.equal(q(), H, "toggles on edge 3");
});

// ── JK toggling (negative-edge 7476) ─────────────────────────────────────────

test("a 7476 with J=K=H toggles on each falling edge", () => {
  // J(4), K(16) float → H (toggle); PRE(2)/CLR(3) float → H (inactive).
  const h = holesOf("7476", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), clock("clk1", 90), chip("c1", "7476", "e10")],
    wires: [...power("psu1", h, 5, 13), wire("clk1.out", strip(h, 1, 0))], // 1CLK
  };
  const bench = new Harness(doc);
  const q = () => bench.pin(h, 14); // 1Q
  bench.tick(); // settle the power-up state
  assert.equal(q(), L);
  bench.fall("clk1");
  assert.equal(q(), H, "toggle on falling edge 1");
  bench.fall("clk1");
  assert.equal(q(), L, "toggle on falling edge 2");
  // A rising edge must NOT clock a negative-edge FF.
  bench.set("clk1", H);
  assert.equal(q(), L, "rising edge ignored");
});

// ── 74161 synchronous counter ────────────────────────────────────────────────

test("a 74161 counts 0→15, asserts RCO at 15, then rolls over", () => {
  // CLR̄(1), LOAD̄(9), ENP(7), ENT(10) all float → H (count enabled).
  const h = holesOf("74161", "e10");
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      clock("clk1", 90),
      chip("c1", "74161", "e10"),
    ],
    wires: [...power("psu1", h, 16, 8), wire("clk1.out", strip(h, 2, 0))], // CLK
  };
  const bench = new Harness(doc);
  const count = () =>
    (bench.pin(h, 14) === H ? 1 : 0) +
    (bench.pin(h, 13) === H ? 2 : 0) +
    (bench.pin(h, 12) === H ? 4 : 0) +
    (bench.pin(h, 11) === H ? 8 : 0);
  assert.equal(count(), 0);
  for (let i = 1; i <= 15; i++) {
    bench.rise("clk1");
    assert.equal(count(), i, `count ${i}`);
  }
  assert.equal(bench.pin(h, 15), H, "RCO high at terminal count 15");
  bench.rise("clk1");
  assert.equal(count(), 0, "rolls over to 0");
  assert.equal(bench.pin(h, 15), L, "RCO low again");
});

test("a 74161 held in async clear never counts", () => {
  const h = holesOf("74161", "e10");
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      clock("clk1", 90),
      chip("c1", "74161", "e10"),
    ],
    wires: [
      ...power("psu1", h, 16, 8),
      wire("clk1.out", strip(h, 2, 0)),
      wire(strip(h, 1, 0), LO(3)), // CLR̄ → GND (low)
    ],
  };
  const bench = new Harness(doc);
  bench.rise("clk1");
  bench.rise("clk1");
  assert.equal(bench.pin(h, 14), L, "QA stays low under async clear");
});

// ── 74164 serial-in shift register ───────────────────────────────────────────

test("a 74164 shifts a HIGH along its stages, and clear zeroes it", () => {
  // A(1), B(2) float → H → serial = H; CLR̄(9) float → H.
  const h = holesOf("74164", "e10");
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      clock("clk1", 90),
      chip("c1", "74164", "e10"),
    ],
    wires: [...power("psu1", h, 14, 7), wire("clk1.out", strip(h, 8, 0))], // CLK
  };
  const bench = new Harness(doc);
  bench.tick(); // settle the power-up state
  assert.equal(bench.pin(h, 3), L, "Q0 starts low");
  bench.rise("clk1");
  assert.equal(bench.pin(h, 3), H, "Q0 = serial after edge 1");
  assert.equal(bench.pin(h, 4), L, "Q1 not yet");
  bench.rise("clk1");
  assert.equal(bench.pin(h, 3), H);
  assert.equal(bench.pin(h, 4), H, "the HIGH shifted into Q1");
});

// ── 74138 decoder (combinational, rides the tick) ────────────────────────────

test("a 74138 drives exactly one active-low output for its address", () => {
  // Enable: G1(6) high, G2A(4)/G2B(5) low. Address A/B/C via ties.
  const h = holesOf("74138", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74138", "e10")],
    wires: [
      ...power("psu1", h, 16, 8),
      wire(strip(h, 6, 0), HI(3)), // G1 → +5 V (high)
      wire(strip(h, 4, 0), LO(3)), // G2A → GND
      wire(strip(h, 5, 0), LO(4)), // G2B → GND
      wire(strip(h, 1, 0), LO(5)), // A → GND
      wire(strip(h, 2, 0), LO(6)), // B → GND
      wire(strip(h, 3, 0), LO(7)), // C → GND  → address 0
    ],
  };
  const bench = new Harness(doc);
  bench.tick();
  assert.equal(bench.pin(h, 15), L, "Y0 selected (active low)");
  assert.equal(bench.pin(h, 14), H, "Y1 idle high");
  assert.equal(bench.pin(h, 7), H, "Y7 idle high");
});

// ── 74151 multiplexer (combinational) ────────────────────────────────────────

test("a 74151 routes the addressed data input to Y", () => {
  // Strobe G(7) low (enabled); address A/B/C floating → H → 7 → selects D7.
  // Tie D0(4) low and leave D7(12) floating → H; Y should read D7 = H.
  const h = holesOf("74151", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74151", "e10")],
    wires: [
      ...power("psu1", h, 16, 8),
      wire(strip(h, 7, 0), `bb1.${mates(h.get(8))[1]}`), // G → GND (enabled)
      wire(strip(h, 4, 0), `bb1.${mates(h.get(8))[2]}`), // D0 → GND
    ],
  };
  const bench = new Harness(doc);
  bench.tick();
  assert.equal(bench.pin(h, 5), H, "Y = D7 (floating → H)");
  assert.equal(bench.pin(h, 6), L, "W = Ȳ");
});

// ── 7475 transparent latch: transparent vs held ──────────────────────────────

test("a 7475 latch is transparent while enabled and holds while not", () => {
  // Latch 1: D1(2), E12(13), Q1(16). D1 floats → H.
  const h = holesOf("7475", "e10");
  const enabled = {
    boards,
    components: [psu("psu1", 80), chip("c1", "7475", "e10")],
    // E12(13) floats → H → transparent → Q1 follows D1 = H.
    wires: [...power("psu1", h, 5, 12)],
  };
  const t1 = new Harness(enabled);
  t1.tick();
  assert.equal(t1.pin(h, 16), H, "transparent: Q1 follows D1 (H)");

  const held = {
    boards,
    components: [psu("psu1", 80), chip("c1", "7475", "e10")],
    wires: [
      ...power("psu1", h, 5, 12),
      wire(strip(h, 13, 0), `bb1.${mates(h.get(12))[1]}`), // E12 → GND (latched)
    ],
  };
  const t2 = new Harness(held);
  t2.tick();
  assert.equal(t2.pin(h, 16), L, "latched at power-up state (L), ignoring D");
});

// ── 74193 up/down counter ────────────────────────────────────────────────────

test("a 74193 counts up on CPU edges and down on CPD edges", () => {
  // MR(14) low via GND; LOAD̄(11) high (float); CPU(5)/CPD(4) from two clocks.
  const h = holesOf("74193", "e10");
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      clock("up", 90),
      clock("dn", 100),
      chip("c1", "74193", "e10"),
    ],
    wires: [
      ...power("psu1", h, 16, 8),
      wire("up.out", strip(h, 5, 0)), // CPU
      wire("dn.out", strip(h, 4, 0)), // CPD
      wire(strip(h, 14, 0), `bb1.${mates(h.get(8))[1]}`), // MR → GND (no reset)
    ],
  };
  const bench = new Harness(doc);
  const count = () =>
    (bench.pin(h, 3) === H ? 1 : 0) +
    (bench.pin(h, 2) === H ? 2 : 0) +
    (bench.pin(h, 6) === H ? 4 : 0) +
    (bench.pin(h, 7) === H ? 8 : 0);
  bench.set("dn", L); // keep down-clock idle low
  bench.rise("up");
  bench.rise("up");
  assert.equal(count(), 2, "two up edges → 2");
  bench.set("up", L); // park up-clock low
  bench.rise("dn");
  assert.equal(count(), 1, "one down edge → 1");
});
