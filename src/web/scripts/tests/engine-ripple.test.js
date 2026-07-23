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

// Feature 220 fixtures: an output→clock RIPPLE chain must settle to the correct
// sequence WITHIN one tick (the engine iterates the sequential step to a state
// fixpoint). Circuits are built in code and clocked edge by edge; we assert the
// settled counts. The headline is a 74LS90 decade counter wired QA→CKB — before
// this feature it counted 1,0,2,3,… instead of 1,2,3,4,… because the ÷5 stage
// never saw QA fall on the tick it happened. A regression case (a synchronous
// 74161 ENT/ENP cascade) proves synchronous designs are unchanged, and a
// self-oscillating ring proves the tick terminates rather than hanging.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { tick as engineTick } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

// ── Fixture builders (shared shape with engine-seq.test.js) ──────────────────

let wireSeq = 0;
const wire = (from, to) => ({ id: `w${++wireSeq}`, from, to, color: "black" });

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

// ── 74LS90 decade counter (QA→CKB): the headline ripple case ─────────────────

test("a 74LS90 wired QA→CKB counts 0→9 and rolls over on CKA falls", () => {
  const h = holesOf("74LS90", "e10");
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      clock("clk1", 90),
      chip("c1", "74LS90", "e10"),
    ],
    wires: [
      ...power("psu1", h, 5, 10), // VCC=5, GND=10 (non-standard power pins)
      wire("clk1.out", strip(h, 14, 0)), // clock → CKA
      wire(strip(h, 12, 0), strip(h, 1, 0)), // QA → CKB (the ripple feedback)
      wire(strip(h, 2, 0), LO(3)), // R0(1) → GND  (resets inactive)
      wire(strip(h, 3, 0), LO(4)), // R0(2) → GND
      wire(strip(h, 6, 0), LO(5)), // R9(1) → GND
      wire(strip(h, 7, 0), LO(6)), // R9(2) → GND
    ],
  };
  const bench = new Harness(doc);
  const count = () =>
    (bench.pin(h, 12) === H ? 1 : 0) + // QA
    (bench.pin(h, 9) === H ? 2 : 0) + // QB
    (bench.pin(h, 8) === H ? 4 : 0) + // QC
    (bench.pin(h, 11) === H ? 8 : 0); // QD
  bench.tick(); // settle the power-up state
  assert.equal(count(), 0, "starts at 0");
  const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1];
  for (let i = 0; i < expected.length; i++) {
    bench.fall("clk1");
    assert.equal(count(), expected[i], `after CKA fall ${i + 1}`);
  }
});

// ── 74LS107 two-bit ripple counter (Q0→CLK1): output→clock within one tick ────

test("a 74LS107 ripple pair (Q0→2CLK) counts 0,1,2,3 and rolls over", () => {
  // Both JK FFs are negative-edge and default to toggle (J,K,CLR float → H).
  // 1Q (pin 3) drives 2CLK (pin 9): the classic 2-bit ripple up-counter.
  const h = holesOf("74LS107", "e10");
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      clock("clk1", 90),
      chip("c1", "74LS107", "e10"),
    ],
    wires: [
      ...power("psu1", h, 14, 7),
      wire("clk1.out", strip(h, 12, 0)), // clock → 1CLK
      wire(strip(h, 3, 0), strip(h, 9, 0)), // 1Q → 2CLK (the ripple)
    ],
  };
  const bench = new Harness(doc);
  const count = () =>
    (bench.pin(h, 3) === H ? 1 : 0) + // Q0 = 1Q
    (bench.pin(h, 5) === H ? 2 : 0); // Q1 = 2Q
  bench.tick();
  assert.equal(count(), 0, "starts at 0");
  const expected = [1, 2, 3, 0, 1];
  for (let i = 0; i < expected.length; i++) {
    bench.fall("clk1");
    assert.equal(count(), expected[i], `after clock fall ${i + 1}`);
  }
});

// ── Three-stage ripple divider (÷8): cascade through two 74LS107s ────────────

test("a three-stage 74LS107 ripple counter divides by eight (0→7)", () => {
  const h1 = holesOf("74LS107", "e10");
  const h2 = holesOf("74LS107", "e40");
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      clock("clk1", 90),
      chip("c1", "74LS107", "e10"),
      chip("c2", "74LS107", "e40"),
    ],
    wires: [
      ...power("psu1", h1, 14, 7),
      wire(strip(h2, 14, 0), HI(4)), // c2 VCC → +5 rail
      wire(strip(h2, 7, 0), LO(4)), // c2 GND → ground rail
      wire("clk1.out", strip(h1, 12, 0)), // clock → stage A (c1 1CLK)
      wire(strip(h1, 3, 0), strip(h1, 9, 0)), // A.Q → stage B (c1 2CLK)
      wire(strip(h1, 5, 0), strip(h2, 12, 0)), // B.Q → stage C (c2 1CLK)
    ],
  };
  const bench = new Harness(doc);
  const count = () =>
    (bench.pin(h1, 3) === H ? 1 : 0) + // stage A
    (bench.pin(h1, 5) === H ? 2 : 0) + // stage B
    (bench.pin(h2, 3) === H ? 4 : 0); // stage C
  bench.tick();
  assert.equal(count(), 0, "starts at 0");
  const expected = [1, 2, 3, 4, 5, 6, 7, 0, 1];
  for (let i = 0; i < expected.length; i++) {
    bench.fall("clk1");
    assert.equal(count(), expected[i], `after clock fall ${i + 1}`);
  }
});

// ── Regression: a synchronous 74161 ENT/ENP cascade is unaffected ─────────────

test("a synchronous 74161 ENT/ENP cascade counts without spurious ripple", () => {
  // Two counters on ONE shared clock. c1.RCO → c2.ENT: c2 advances only on the
  // clock edge where c1 is at 15 — the edge is present in the shared clock net
  // for both, so no re-iteration fires c2 twice. This is the synchronous path
  // the ripple fixpoint must leave byte-for-byte unchanged.
  const h1 = holesOf("74LS161", "e10");
  const h2 = holesOf("74LS161", "e40");
  const doc = {
    boards,
    components: [
      psu("psu1", 80),
      clock("clk1", 90),
      chip("c1", "74LS161", "e10"),
      chip("c2", "74LS161", "e40"),
    ],
    wires: [
      ...power("psu1", h1, 16, 8),
      wire(strip(h2, 16, 0), HI(4)),
      wire(strip(h2, 8, 0), LO(4)),
      wire("clk1.out", strip(h1, 2, 0)), // clock → c1 CLK
      wire(strip(h1, 2, 1), strip(h2, 2, 0)), // shared clock → c2 CLK
      wire(strip(h1, 15, 0), strip(h2, 10, 0)), // c1 RCO → c2 ENT
    ],
  };
  const bench = new Harness(doc);
  const lo = () =>
    (bench.pin(h1, 14) === H ? 1 : 0) +
    (bench.pin(h1, 13) === H ? 2 : 0) +
    (bench.pin(h1, 12) === H ? 4 : 0) +
    (bench.pin(h1, 11) === H ? 8 : 0);
  const hi = () =>
    (bench.pin(h2, 14) === H ? 1 : 0) +
    (bench.pin(h2, 13) === H ? 2 : 0) +
    (bench.pin(h2, 12) === H ? 4 : 0) +
    (bench.pin(h2, 11) === H ? 8 : 0);
  // 15 edges: c1 climbs to 15, c2 stays 0 (ENT only high AT 15, before rollover).
  for (let i = 0; i < 15; i++) bench.rise("clk1");
  assert.equal(lo(), 15, "low counter at 15");
  assert.equal(hi(), 0, "high counter still 0");
  // 16th edge: c1 rolls 15→0, c2 samples RCO=H and advances to 1 (once, not twice).
  bench.rise("clk1");
  assert.equal(lo(), 0, "low counter rolled over");
  assert.equal(hi(), 1, "high counter advanced exactly once");
  // 17th edge: c1 → 1, c2 holds (RCO now low).
  bench.rise("clk1");
  assert.equal(lo(), 1);
  assert.equal(hi(), 1, "high counter holds");
});

// ── Warm-start latch hold still holds through a tick ─────────────────────────

test("a cross-coupled NAND latch holds its state across ticks", () => {
  const h = holesOf("74LS00", "e10");
  const gnd = mates(h.get(7));
  const crossCouple = [
    wire(`bb1.${mates(h.get(3))[0]}`, `bb1.${mates(h.get(5))[0]}`), // Q ↔ 2B
    wire(`bb1.${mates(h.get(6))[0]}`, `bb1.${mates(h.get(2))[0]}`), // Q̄ ↔ 1B
  ];
  const wires = [...power("psu1", h, 14, 7), ...crossCouple];
  const set = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS00", "e10")],
    wires: [...wires, wire(`bb1.${mates(h.get(1))[0]}`, `bb1.${gnd[1]}`)],
  }; // S̄ low
  const idle = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS00", "e10")],
    wires,
  };

  const s = new Harness(set);
  s.tick();
  assert.equal(s.level("bb1.e12"), H, "S̄ low → Q high");
  // Carry warm start + state into the idle circuit: the latch must HOLD Q high.
  const hold = new Harness(idle);
  hold.warm = s.warm;
  hold.tick();
  assert.equal(
    hold.level("bb1.e12"),
    H,
    "latch HELD the set state (warm start)",
  );
});

// ── A self-clocking ring terminates (no hang) with an oscillation warning ─────

test("a self-oscillating inverter ring reports oscillation through tick, no hang", () => {
  const h = holesOf("74LS04", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS04", "e10")],
    wires: [
      ...power("psu1", h, 14, 7),
      wire(`bb1.${mates(h.get(2))[0]}`, `bb1.${mates(h.get(3))[0]}`), // g1→g2
      wire(`bb1.${mates(h.get(4))[0]}`, `bb1.${mates(h.get(5))[0]}`), // g2→g3
      wire(`bb1.${mates(h.get(6))[0]}`, `bb1.${mates(h.get(1))[0]}`), // g3→g1
    ],
  };
  const bench = new Harness(doc);
  const r = bench.tick(); // must return — the settle cap prevents an infinite loop
  assert.equal(r.settled, false, "never settles");
  assert.ok(
    r.warnings.some((w) => w.type === "oscillation"),
    "oscillation reported",
  );
});
