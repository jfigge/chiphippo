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
import { partPinHoles } from "../model/occupancy.js";
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
  return holesOfNode("full", nodeOf("full", hole)).filter((h) => h !== hole);
}

/** Assemble a document + build its netlist + settle. */
function simulate(doc, warmStart) {
  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist, warmStart });
  return {
    result,
    levelAt: (address) => result.netLevels.get(netlist.netOfPoint.get(address)),
  };
}

const board = { id: "bb1", type: "full", x: 0, y: 0 };
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

/** Power a chip at `anchor`: VCC (pin 14) → psu+, GND (pin 7) → psu−. */
function powerWires(psuId, holes, gndMateIndex = 0) {
  return [
    wire(`${psuId}.+`, `bb1.${mates(holes.get(14))[0]}`),
    wire(`${psuId}.-`, `bb1.${mates(holes.get(7))[gndMateIndex]}`),
  ];
}

// ── Combinational: inverter + floating-input NAND ────────────────────────────

test("a powered 7404 inverts a driven-low input to HIGH (and floats read H)", () => {
  const holes = chipHoles("7404", "e10");
  const gnd = mates(holes.get(7)); // c16L free holes
  const doc = {
    boards: [board],
    components: [psu("psu1", 80), chip("c1", "7404", "e10")],
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
    wires: powerWires("psu1", chipHoles("7404", "e10")),
  };
  assert.equal(simulate(floated).levelAt("bb1.e11"), L);
});

test("7400 NAND: one wired-low input → H; both floating → L", () => {
  const holes = chipHoles("7400", "e10");
  const gnd = mates(holes.get(7));
  const base = {
    boards: [board],
    components: [psu("psu1", 80), chip("c1", "7400", "e10")],
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

test("74125: two enabled buffers driving one net disagree → conflict (X)", () => {
  const holes = chipHoles("74125", "e10");
  const gnd = mates(holes.get(7));
  // buf1: en 1G(1,e10), data 1A(2,e11), out 1Y(3,e12).
  // buf2: en 2G(4,e13), data 2A(5,e14), out 2Y(6,e15).
  const doc = {
    boards: [board],
    components: [psu("psu1", 80), chip("c1", "74125", "e10")],
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

test("an SR latch from one 7400 sets, resets, and holds across settles", () => {
  const holes = chipHoles("7400", "e10");
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
    boards: [board],
    components: [psu("psu1", 80), chip("c1", "7400", "e10")],
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
  const holes = chipHoles("7404", "e10");
  // g1 e10→e11, g2 e12→e13, g3 e14→e15; chain the ring.
  const doc = {
    boards: [board],
    components: [psu("psu1", 80), chip("c1", "7404", "e10")],
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
    boards: [board],
    components: [chip("c1", "7400", "e10")], // no PSU
    wires: [],
  });
  assert.equal(result.chipStatus.get("c1").status, "unpowered");
  assert.equal(levelAt("bb1.e12"), Z);
});

test("a 3 V chip is underpowered (inert) and warns", () => {
  const holes = chipHoles("7400", "e10");
  const { result, levelAt } = simulate({
    boards: [board],
    components: [psu("psu1", 80, 3), chip("c1", "7400", "e10")],
    wires: powerWires("psu1", holes),
  });
  assert.equal(result.chipStatus.get("c1").status, "underpowered");
  assert.equal(levelAt("bb1.e12"), Z);
  assert.ok(result.warnings.some((w) => w.type === "underpowered"));
});

test("12 V damages the chip (magic smoke); params are NOT mutated by the pure engine", () => {
  const holes = chipHoles("7400", "e10");
  const doc = {
    boards: [board],
    components: [psu("psu1", 80, 12), chip("c1", "7400", "e10")],
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
      chip("c1", "7400", "e10", { damaged: true }),
    ],
  };
  assert.equal(
    simulate(replaced).result.chipStatus.get("c1").status,
    "damaged",
  );
});

test("opposing supplies on one net → short warning (X)", () => {
  const { result, levelAt } = simulate({
    boards: [board],
    components: [psu("psu1", 80, 5), psu("psu2", 100, 5)],
    // psu1.+ and psu2.− land on the same 5-hole strip (c1L).
    wires: [wire("psu1.+", "bb1.a1"), wire("psu2.-", "bb1.b1")],
  });
  assert.equal(levelAt("bb1.a1"), X);
  assert.ok(result.warnings.some((w) => w.type === "short"));
});
