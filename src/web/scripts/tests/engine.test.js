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

// Engine fixtures: build small circuits in code (board + chip + PSU + wires),
// settle them, and assert the resolved net levels — inverter, floating-input
// NAND, tri-state conflict, SR latch set/reset/HOLD, inverter-ring
// oscillation, and the power ladder (unpowered / underpowered / damaged /
// shorted supplies).

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z, X } from "../sim/levels.js";
import { settle, MAX_ITERATIONS } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { partPinAddresses, partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

// ── Fixture helpers ──────────────────────────────────────────────────────────

let wireSeq = 0;
const wire = (from, to) => ({ id: `w${++wireSeq}`, from, to, color: "black" });

/** Pin number → its seated hole (e.g. 14 → "f10") for a chip at `anchor`. */
function chipHoles(ref, anchor) {
  const map = new Map();
  for (const { pin, hole } of partPinHoles(ref, anchor)) map.set(pin, hole);
  return map;
}

/** The free strip-mates of a hole (same node, excluding the hole itself). */
function mates(hole) {
  return holesOfNode("pins-full", nodeOf("pins-full", hole)).filter(
    (h) => h !== hole,
  );
}

/**
 * Pin number → its seated BARE hole (e.g. 3 → "f16") for a `def.can` part at
 * `anchor` on "bb1", rot 0. Unlike chipHoles, this resolves against a full
 * document: 3 of a can's 4 pins are {dx, dy} offsets from the anchor (see
 * model/occupancy.js's `def.can` branch), not footprint-derived like a
 * chip's, so they need partPinAddresses (board-aware), not bare partPinHoles.
 */
function canHoles(anchor, ref = "osc-full") {
  const doc = { boards, components: [], wires: [] };
  const comp = { ref, board: "bb1", anchor, params: {} };
  const map = new Map();
  for (const { pin, address } of partPinAddresses(doc, comp)) {
    map.set(pin, address ? address.split(".")[1] : null);
  }
  return map;
}

/** Assemble a document + build its netlist + settle. */
function simulate(doc, warmStart, clockPhase) {
  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist, warmStart, clockPhase });
  return {
    result,
    levelAt: (address) => result.netLevels.get(netlist.netOfPoint.get(address)),
    // The level from supplies/chip outputs alone — no resistor pulls.
    strongAt: (address) =>
      result.strongLevels.get(netlist.netOfPoint.get(address)),
  };
}

// One full breadboard, as the strips it is really made of: the pin-board plus
// the two power-rail strips that dovetail onto its edges. Every fixture gets
// all three so a circuit can reach a rail whenever it needs one.
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
const chip = (id, ref, anchor, params = {}) => ({
  id,
  kind: "chip",
  ref,
  board: "bb1",
  anchor,
  params,
});
const part = (id, ref, anchor, params = {}) => ({
  id,
  kind: "discrete",
  ref,
  board: "bb1",
  anchor,
  params,
});

/** Power a chip at `anchor`: VCC (pin 14) → psu+, GND (pin 7) → psu−. */
function powerWires(psuId, holes, gndMateIndex = 0) {
  return [
    wire(`${psuId}.+`, `bb1.${mates(holes.get(14))[0]}`),
    wire(`${psuId}.-`, `bb1.${mates(holes.get(7))[gndMateIndex]}`),
  ];
}

// ── Combinational: inverter + floating-input NAND ────────────────────────────

test("a powered 74LS04 inverts a driven-low input to HIGH (and floats read H)", () => {
  const holes = chipHoles("74LS04", "e10");
  const gnd = mates(holes.get(7)); // c16L free holes
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS04", "e10")],
    wires: [
      ...powerWires("psu1", holes),
      // Drive input pin 1 (e10) LOW by tying its strip to the GND strip.
      wire(`bb1.${mates(holes.get(1))[0]}`, `bb1.${gnd[1]}`),
    ],
  };
  const { result, levelAt } = simulate(doc);
  assert.equal(result.settled, true);
  assert.equal(result.chipStatus.get("c1").status, "ok");
  assert.equal(levelAt("bb1.e10"), L); // input tied low
  assert.equal(levelAt("bb1.e11"), H); // 1Y = INV(L)

  // Remove the pull-down: the input floats → reads H → output L.
  const floated = {
    ...doc,
    wires: powerWires("psu1", chipHoles("74LS04", "e10")),
  };
  assert.equal(simulate(floated).levelAt("bb1.e11"), L);
});

test("74LS00 NAND: one wired-low input → H; both floating → L", () => {
  const holes = chipHoles("74LS00", "e10");
  const gnd = mates(holes.get(7));
  const base = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS00", "e10")],
  };
  // Gate 1: 1A(e10)/1B(e11) → 1Y(e12). Pull 1A low, leave 1B floating.
  const oneLow = simulate({
    ...base,
    wires: [
      ...powerWires("psu1", holes),
      wire(`bb1.${mates(holes.get(1))[0]}`, `bb1.${gnd[1]}`),
    ],
  });
  assert.equal(oneLow.levelAt("bb1.e12"), H); // NAND(L, H-floating) = H

  const bothFloat = simulate({ ...base, wires: powerWires("psu1", holes) });
  assert.equal(bothFloat.levelAt("bb1.e12"), L); // NAND(H, H) = L
});

// ── Tri-state conflict ───────────────────────────────────────────────────────

test("74LS125: two enabled buffers driving one net disagree → conflict (X)", () => {
  const holes = chipHoles("74LS125", "e10");
  const gnd = mates(holes.get(7));
  // buf1: en 1G(1,e10), data 1A(2,e11), out 1Y(3,e12).
  // buf2: en 2G(4,e13), data 2A(5,e14), out 2Y(6,e15).
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS125", "e10")],
    wires: [
      ...powerWires("psu1", holes),
      // Tie the two outputs together.
      wire(`bb1.${mates(holes.get(3))[0]}`, `bb1.${mates(holes.get(6))[0]}`),
      // Enable both buffers (G low).
      wire(`bb1.${mates(holes.get(1))[0]}`, `bb1.${gnd[1]}`),
      wire(`bb1.${mates(holes.get(4))[0]}`, `bb1.${gnd[2]}`),
      // Data: 1A floats (→H), 2A tied low.
      wire(`bb1.${mates(holes.get(5))[0]}`, `bb1.${gnd[3]}`),
    ],
  };
  const { result, levelAt } = simulate(doc);
  assert.equal(levelAt("bb1.e12"), X); // H vs L on the tied output
  assert.ok(result.warnings.some((w) => w.type === "conflict"));
});

// ── SR latch (the settle-loop proof): set, reset, and HOLD ──────────────────

test("an SR latch from one 74LS00 sets, resets, and holds across settles", () => {
  const holes = chipHoles("74LS00", "e10");
  const gnd = mates(holes.get(7));
  // Gate 1: 1A(1,e10)=S, 1B(2,e11)=Qbar → 1Y(3,e12)=Q.
  // Gate 2: 2A(4,e13)=R, 2B(5,e14)=Q    → 2Y(6,e15)=Qbar.
  const crossCouple = [
    // Q (1Y,e12) ↔ 2B (e14).
    wire(`bb1.${mates(holes.get(3))[0]}`, `bb1.${mates(holes.get(5))[0]}`),
    // Qbar (2Y,e15) ↔ 1B (e11).
    wire(`bb1.${mates(holes.get(6))[0]}`, `bb1.${mates(holes.get(2))[0]}`),
  ];
  const common = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS00", "e10")],
  };
  const idle = {
    ...common,
    wires: [...powerWires("psu1", holes), ...crossCouple],
  };
  // Assert one activation low at a time (active-low S̄ / R̄).
  const pullLow = (pin, gndHole) =>
    wire(`bb1.${mates(holes.get(pin))[0]}`, `bb1.${gndHole}`);
  const setDoc = { ...idle, wires: [...idle.wires, pullLow(1, gnd[1])] }; // S low
  const resetDoc = { ...idle, wires: [...idle.wires, pullLow(4, gnd[1])] }; // R low

  const Q = (sim) => sim.levelAt("bb1.e12");

  let warm;
  // Set: S̄ = L → Q = H.
  let sim = simulate(setDoc);
  assert.equal(Q(sim), H);
  warm = sim.result.netLevels;
  // Hold: release S̄ (floats H) — warm start keeps Q = H.
  sim = simulate(idle, warm);
  assert.equal(Q(sim), H, "latch HELD the set state");
  warm = sim.result.netLevels;
  // Reset: R̄ = L → Q = L.
  sim = simulate(resetDoc, warm);
  assert.equal(Q(sim), L);
  warm = sim.result.netLevels;
  // Hold: release R̄ — warm start keeps Q = L.
  sim = simulate(idle, warm);
  assert.equal(Q(sim), L, "latch HELD the reset state");
});

// ── Oscillation ──────────────────────────────────────────────────────────────

test("a ring of three inverters never settles → oscillation warning", () => {
  const holes = chipHoles("74LS04", "e10");
  // g1 e10→e11, g2 e12→e13, g3 e14→e15; chain the ring.
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS04", "e10")],
    wires: [
      ...powerWires("psu1", holes),
      wire(`bb1.${mates(holes.get(2))[0]}`, `bb1.${mates(holes.get(3))[0]}`), // g1→g2
      wire(`bb1.${mates(holes.get(4))[0]}`, `bb1.${mates(holes.get(5))[0]}`), // g2→g3
      wire(`bb1.${mates(holes.get(6))[0]}`, `bb1.${mates(holes.get(1))[0]}`), // g3→g1
    ],
  };
  const { result } = simulate(doc);
  assert.equal(result.settled, false);
  assert.equal(result.iterations, MAX_ITERATIONS); // the cap held — no hang
  assert.ok(result.warnings.some((w) => w.type === "oscillation"));
});

// ── Power ladder ─────────────────────────────────────────────────────────────

test("an unpowered chip drives nothing (outputs Z)", () => {
  const { result, levelAt } = simulate({
    boards,
    components: [chip("c1", "74LS00", "e10")], // no PSU
    wires: [],
  });
  assert.equal(result.chipStatus.get("c1").status, "unpowered");
  assert.equal(levelAt("bb1.e12"), Z);
});

test("a 3 V chip is underpowered (inert) and warns", () => {
  const holes = chipHoles("74LS00", "e10");
  const { result, levelAt } = simulate({
    boards,
    components: [psu("psu1", 80, 3), chip("c1", "74LS00", "e10")],
    wires: powerWires("psu1", holes),
  });
  assert.equal(result.chipStatus.get("c1").status, "underpowered");
  assert.equal(levelAt("bb1.e12"), Z);
  assert.ok(result.warnings.some((w) => w.type === "underpowered"));
});

test("12 V damages the chip (magic smoke); params are NOT mutated by the pure engine", () => {
  const holes = chipHoles("74LS00", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80, 12), chip("c1", "74LS00", "e10")],
    wires: powerWires("psu1", holes),
  };
  const { result, levelAt } = simulate(doc);
  assert.equal(result.chipStatus.get("c1").status, "damaged");
  assert.equal(levelAt("bb1.e12"), Z);
  assert.ok(result.warnings.some((w) => w.type === "damaged"));
  assert.equal(doc.components[1].params.damaged, undefined); // engine is pure

  // A chip already flagged damaged stays inert even back at 5 V.
  const replaced = {
    ...doc,
    components: [
      psu("psu1", 80, 5),
      chip("c1", "74LS00", "e10", { damaged: true }),
    ],
  };
  assert.equal(
    simulate(replaced).result.chipStatus.get("c1").status,
    "damaged",
  );
});

test("swapped supply wires read as reversed (inert) and warn", () => {
  const holes = chipHoles("74LS00", "e10");
  const doc = {
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS00", "e10")],
    // The mirror of powerWires: + on the GND pin, − on the VCC pin.
    wires: [
      wire("psu1.+", `bb1.${mates(holes.get(7))[0]}`),
      wire("psu1.-", `bb1.${mates(holes.get(14))[0]}`),
    ],
  };
  const { result, levelAt } = simulate(doc);
  assert.equal(result.chipStatus.get("c1").status, "reversed");
  assert.equal(levelAt("bb1.e12"), Z);
  assert.ok(result.warnings.some((w) => w.type === "reversed"));
  assert.equal(doc.components[1].params.damaged, undefined); // never persisted
});

test("only one power pin miswired is unpowered, NOT reversed", () => {
  // A flipped chip whose GND pin landed on the + rail while VCC reaches a rail
  // with no supply on it: one pin is wrong, so we must not accuse the user of
  // wiring it backwards.
  const holes = chipHoles("74LS00", "e10");
  const { result } = simulate({
    boards,
    components: [psu("psu1", 80), chip("c1", "74LS00", "e10")],
    wires: [wire("psu1.+", `bb1.${mates(holes.get(7))[0]}`)],
  });
  assert.equal(result.chipStatus.get("c1").status, "unpowered");
  assert.ok(!result.warnings.some((w) => w.type === "reversed"));
});

// ── Oscillator can: a board-seated, power-gated clock source ──

// Canonical can pin numbers (both sizes — see catalog/parts.js's `def.can`
// defs): 1 NC, 2 GND, 3 OUT, 4 VCC.

test("osc-full: OUTPUT (pin 3) follows clockPhase while powered", () => {
  const holes = canHoles("e10", "osc-full");
  const doc = {
    boards,
    components: [psu("psu1", 80), part("c1", "osc-full", "e10")],
    wires: [
      wire("psu1.+", `bb1.${mates(holes.get(4))[0]}`), // VCC
      wire("psu1.-", `bb1.${mates(holes.get(2))[0]}`), // GND
    ],
  };
  for (const level of [H, L, H]) {
    const { result, levelAt } = simulate(
      doc,
      undefined,
      new Map([["c1", level]]),
    );
    assert.equal(result.chipStatus.get("c1").status, "ok");
    assert.equal(levelAt(`bb1.${holes.get(3)}`), level);
  }
});

test("osc-half: OUTPUT (pin 3) follows clockPhase on the smaller footprint", () => {
  const holes = canHoles("e10", "osc-half");
  const doc = {
    boards,
    components: [psu("psu1", 80), part("c1", "osc-half", "e10")],
    wires: [
      wire("psu1.+", `bb1.${mates(holes.get(4))[0]}`), // VCC
      wire("psu1.-", `bb1.${mates(holes.get(2))[0]}`), // GND
    ],
  };
  const { result, levelAt } = simulate(doc, undefined, new Map([["c1", H]]));
  assert.equal(result.chipStatus.get("c1").status, "ok");
  assert.equal(levelAt(`bb1.${holes.get(3)}`), H);
});

test("osc-full: unpowered drives nothing, whatever clockPhase says", () => {
  const holes = canHoles("e10", "osc-full");
  const { result, levelAt } = simulate(
    { boards, components: [part("c1", "osc-full", "e10")], wires: [] },
    undefined,
    new Map([["c1", H]]),
  );
  assert.equal(result.chipStatus.get("c1").status, "unpowered");
  assert.equal(levelAt(`bb1.${holes.get(3)}`), Z);
});

test("osc-full: 12 V damages the can (same magic smoke as a chip)", () => {
  const holes = canHoles("e10", "osc-full");
  const doc = {
    boards,
    components: [psu("psu1", 80, 12), part("c1", "osc-full", "e10")],
    wires: [
      wire("psu1.+", `bb1.${mates(holes.get(4))[0]}`),
      wire("psu1.-", `bb1.${mates(holes.get(2))[0]}`),
    ],
  };
  const { result, levelAt } = simulate(doc, undefined, new Map([["c1", H]]));
  assert.equal(result.chipStatus.get("c1").status, "damaged");
  assert.equal(levelAt(`bb1.${holes.get(3)}`), Z);
  assert.ok(result.warnings.some((w) => w.type === "damaged"));
});

// ── Resistors: weak pull-down / pull-up / series conduction ──────────────────

test("a pull-down resistor makes a floating chip input read LOW", () => {
  const holes = chipHoles("74LS04", "e10"); // 1A(e10) → 1Y(e11)
  const r = chipHoles("resistor", "a30"); // leads at a30 (col30) and a33 (col33)
  const base = {
    boards,
    components: [
      psu("psu1", 80),
      chip("c1", "74LS04", "e10"),
      part("r1", "resistor", "a30"),
    ],
  };

  // Baseline: input pin 1 floats → reads H → inverter output (e11) LOW.
  const floating = { ...base, wires: powerWires("psu1", holes) };
  assert.equal(simulate(floating).levelAt("bb1.e11"), L);

  // Wire the resistor as a pull-down: one lead on the input strip, the other on
  // the GND strip. The floating input now reads LOW → inverter output HIGH.
  const pulled = {
    ...base,
    wires: [
      ...powerWires("psu1", holes),
      wire(`bb1.${mates(r.get(1))[0]}`, `bb1.${mates(holes.get(1))[0]}`),
      wire(`bb1.${mates(r.get(2))[0]}`, `bb1.${mates(holes.get(7))[1]}`),
    ],
  };
  const { levelAt } = simulate(pulled);
  assert.equal(levelAt("bb1.e10"), L); // pulled to ground through the resistor
  assert.equal(levelAt("bb1.e11"), H); // 1Y = INV(L)
});

test("a bussed resistor array pulls every free pin toward its grounded common", () => {
  // rnet9 seated at a10 → pins 1–8 at a10…a17, common (pin 9) at a18.
  const r = chipHoles("rnet9", "a10");
  const { levelAt, strongAt } = simulate({
    boards,
    components: [psu("psu1", 80), part("r1", "rnet9", "a10")],
    wires: [
      // Ground the common bus (pin 9) via the bottom − rail.
      wire("psu1.-", "bb3.-2"),
      wire("bb3.-3", `bb1.${mates(r.get(9))[0]}`),
      // Strongly drive one element pin (pin 3, a12) HIGH straight off the + rail.
      wire("psu1.+", "bb2.+2"),
      wire("bb2.+3", `bb1.${mates(r.get(3))[0]}`),
    ],
  });
  // Every OTHER (free) pin floats to LOW through its own resistor to the
  // grounded common — eight independent pull-downs, one shared bus.
  assert.equal(levelAt("bb1.a11"), L); // pin 2
  assert.equal(levelAt("bb1.a17"), L); // pin 8
  // …but only WEAKLY: nothing strongly drives them (the PULL tier, not a rail).
  assert.notEqual(strongAt("bb1.a11"), L);
  // A strongly-driven pin overrides its own weak pull and stays HIGH; the weak
  // pull it exerts back on the bus can't flip the strongly-grounded common.
  assert.equal(levelAt("bb1.a12"), H); // pin 3, wired to +5
  assert.equal(strongAt("bb1.a12"), H);
  assert.equal(levelAt("bb1.a18"), L); // common stays grounded
});

test("strongLevels separate a direct rail feed from one through a resistor", () => {
  // Two columns fed from +5 V: a10 straight off the rail, a20 through R.
  const r = chipHoles("resistor", "a30"); // a30 ── a33
  const { levelAt, strongAt } = simulate({
    boards,
    components: [psu("psu1", 80), part("r1", "resistor", "a30")],
    wires: [
      wire("psu1.+", "bb2.+1"),
      wire("bb2.+2", `bb1.${mates(r.get(1))[0]}`), // rail → resistor pin 1
      wire(`bb1.${mates(r.get(2))[0]}`, "bb1.a20"), // resistor pin 2 → column
      wire("bb2.+3", "bb1.a10"), // rail → column, nothing in between
    ],
  });

  // Both columns READ high…
  assert.equal(levelAt("bb1.a10"), H);
  assert.equal(levelAt("bb1.a20"), H);
  // …but only the direct one is STRONGLY high; the resistor-fed column is
  // undriven on its own. That difference is what saves an LED from burning.
  assert.equal(strongAt("bb1.a10"), H);
  assert.notEqual(strongAt("bb1.a20"), H);
});

test("a rotated resistor pulls a grid column to a rail's level (rail↔column)", () => {
  // Vertical two-end resistor straddling the trench: pin 1 at the anchor a10,
  // pin 2 bent 11 pitches UP to j10 (the far lead is a {dx, dy} offset now,
  // not a hole id). The lower half is jumpered to the bottom − rail strip, so
  // grounding that rail makes the far half read LOW through the pull.
  const { levelAt } = simulate({
    boards,
    components: [
      psu("psu1", 80),
      part("r1", "resistor", "a10", { rot: 90, end: { dx: 0, dy: -11 } }),
    ],
    wires: [
      // Ground the − rail via a different hole on the same (continuous) node.
      wire("psu1.-", "bb3.-2"),
      wire("bb3.-3", "bb1.b10"), // − rail → the resistor's pin-1 strip
    ],
  });
  assert.equal(levelAt("bb3.-1"), L); // the − rail is GND
  assert.equal(levelAt("bb1.j10"), L); // column pulled LOW through the resistor
});

test("a rotated resistor whose rail is gone floats: the pull dies, the rest settles", () => {
  // Pin 1 at a10 (world 10,16), the free lead bent 4 pitches DOWN onto the
  // bottom rail strip — bb3.-7 (world 10,20) — which the PSU grounds.
  const components = [
    psu("psu1", 80),
    part("r1", "resistor", "a10", { rot: 90, end: { dx: 0, dy: 4 } }),
  ];
  const bent = simulate({
    boards,
    components,
    wires: [
      wire("psu1.-", "bb3.-2"), // ground the rail the free lead reaches
      wire("psu1.+", "bb1.a20"), // an unrelated column, driven directly
    ],
  });
  assert.equal(bent.levelAt("bb1.a10"), L); // pulled down through the resistor
  assert.equal(bent.levelAt("bb1.a20"), H);

  // Now pull that strip off the desk (its wires go with it, as removeBoard
  // does) WITHOUT moving the resistor — exactly the state the doc lands in.
  const floated = simulate({
    boards: [board, railTop],
    components,
    wires: [wire("psu1.+", "bb1.a20")],
  });
  assert.equal(floated.result.settled, true); // a floating leg is not an error
  assert.equal(floated.levelAt("bb1.a10"), Z); // nothing pulls the column now
  assert.equal(floated.levelAt("bb1.a20"), H); // …and the rest is untouched
});

test("a strong driver overrides a pull-up; a series resistor conducts a level", () => {
  const r = chipHoles("resistor", "a30"); // a30 (col30) ── a33 (col33)
  // Drive the resistor's pin-1 net HIGH from the supply +; leave pin-2 isolated.
  const { levelAt } = simulate({
    boards,
    components: [psu("psu1", 80), part("r1", "resistor", "a30")],
    wires: [wire("psu1.+", `bb1.${mates(r.get(1))[0]}`)],
  });
  assert.equal(levelAt("bb1.a30"), H); // strongly driven end
  assert.equal(levelAt("bb1.a33"), H); // conducted weakly through the resistor
});

test("opposing supplies on one net → short warning (X)", () => {
  const { result, levelAt } = simulate({
    boards,
    components: [psu("psu1", 80, 5), psu("psu2", 100, 5)],
    // psu1.+ and psu2.− land on the same 5-hole strip (c1L).
    wires: [wire("psu1.+", "bb1.a1"), wire("psu2.-", "bb1.b1")],
  });
  assert.equal(levelAt("bb1.a1"), X);
  assert.ok(result.warnings.some((w) => w.type === "short"));
});
