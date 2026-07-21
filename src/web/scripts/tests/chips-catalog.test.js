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

// Catalog integrity: every def must be internally consistent — the catalog is
// data + this validation, never chip-specific code paths. Covers the
// combinational gate wave (Feature 40/80), the combinational MSI wave
// (decoders/mux, `COMB` units whose inputs fan out), and the sequential wave
// (Feature 100, `state0`/`step`/`outputs`).

import test from "node:test";
import assert from "node:assert/strict";

import { CHIP_DEFS, chipDef } from "../catalog/index.js";
import { packageSpec } from "../model/footprints.js";
import {
  hasLogic,
  isSequential,
  hasBehavior,
  initialState,
  outputsOf,
  inputLevels,
} from "../sim/chip-eval.js";

// `io` is a BIDIRECTIONAL pin (the 74245 transceiver's bus lines): a unit both
// reads it and drives it, so it counts as an input AND an output below.
const ROLES = new Set(["input", "output", "vcc", "gnd", "nc", "io"]);

const GATE_WAVE = [
  "74LS00",
  "7402",
  "7404",
  "7408",
  "7410",
  "7411",
  "7420",
  "7427",
  "7430",
  "7432",
  "7486",
  "74125",
];
const SEQ_WAVE = [
  "7473",
  "7474",
  "7475",
  "7476",
  "74107",
  "74175",
  "74161",
  "74193",
  "74164",
  "74165",
  "74138",
  "74139",
  "74151",
  "74157",
];
// The 74LS wave (a broad batch of Low-power Schottky parts). Duplicates of the
// plain-TTL functions carry their own LS id; the electrical LS/TTL difference
// is analog and invisible to the zero-delay engine.
const LS_WAVE = [
  "74LS05",
  "74LS14",
  "74LS112",
  "74LS173",
  "74LS174",
  "74LS273",
  "74LS279",
  "74LS151",
  "74LS153",
  "74LS157",
  "74LS257",
  "74LS240",
  "74LS244",
  "74LS245",
  "74LS47",
  "74LS85",
  "74LS148",
  "74LS283",
  "74LS169",
  "74LS259",
  "74LS533",
  "74LS573",
  "74LS595",
  "74LS90",
];

test("the catalog contains the gate wave plus the sequential/MSI + 74LS waves", () => {
  assert.deepEqual(
    CHIP_DEFS.map((d) => d.id).sort(),
    [...GATE_WAVE, ...SEQ_WAVE, ...LS_WAVE].sort(),
  );
  for (const id of [...GATE_WAVE, ...SEQ_WAVE, ...LS_WAVE]) {
    assert.ok(chipDef(id), id);
  }
  assert.equal(chipDef("9999"), null);
});

for (const def of CHIP_DEFS) {
  test(`catalog def ${def.id} is valid`, () => {
    // Identity fields present.
    assert.ok(def.title.length > 0);
    assert.ok(def.blurb.length > 0);
    assert.ok(def.group.length > 0);

    // Pin count matches the package, numbered 1…2n exactly once.
    const { pins } = packageSpec(def.package);
    assert.equal(def.pins.length, pins);
    assert.deepEqual(
      def.pins.map((p) => p.n).sort((a, b) => a - b),
      Array.from({ length: pins }, (_, i) => i + 1),
    );

    // Roles valid; exactly one vcc + one gnd (position may be non-standard —
    // real parts like the 7473/7475/7476 don't always use the corners).
    for (const p of def.pins) assert.ok(ROLES.has(p.role), `${def.id} ${p.n}`);
    assert.equal(def.pins.filter((p) => p.role === "vcc").length, 1);
    assert.equal(def.pins.filter((p) => p.role === "gnd").length, 1);

    // Names unique among functional pins (NC may repeat).
    const names = def.pins.filter((p) => p.role !== "nc").map((p) => p.name);
    assert.equal(new Set(names).size, names.length, `${def.id} names`);

    // Every def carries SOME behavior (combinational or sequential).
    assert.ok(hasBehavior(def), `${def.id} has no behavior`);

    const inputPins = def.pins
      .filter((p) => p.role === "input")
      .map((p) => p.n);
    const outputPins = def.pins
      .filter((p) => p.role === "output")
      .map((p) => p.n);
    const ioPins = def.pins.filter((p) => p.role === "io").map((p) => p.n);
    const pinRole = new Map(def.pins.map((p) => [p.n, p.role]));

    if (hasLogic(def)) {
      // ── Combinational: units reference real pins; a unit may only READ an
      //    input/io pin and only DRIVE an output/io pin. Every input is used
      //    (fan-out allowed for MSI), every output driven exactly once, and
      //    every bidirectional io pin BOTH driven once AND read (the 74245).
      const usedAsInput = new Set();
      const driveCount = new Map();
      for (const unit of def.logic.units) {
        const inPins = [...unit.inputs];
        if (unit.enable != null) inPins.push(unit.enable);
        for (const p of inPins) {
          assert.ok(
            pinRole.get(p) === "input" || pinRole.get(p) === "io",
            `${def.id} reads pin ${p} (role ${pinRole.get(p)})`,
          );
          usedAsInput.add(p);
        }
        const o = unit.output;
        assert.ok(
          pinRole.get(o) === "output" || pinRole.get(o) === "io",
          `${def.id} drives pin ${o} (role ${pinRole.get(o)})`,
        );
        driveCount.set(o, (driveCount.get(o) ?? 0) + 1);
      }
      for (const p of inputPins) {
        assert.ok(usedAsInput.has(p), `${def.id} input pin ${p} unused`);
      }
      for (const p of outputPins) {
        assert.equal(
          driveCount.get(p),
          1,
          `${def.id} output pin ${p} driven once`,
        );
      }
      for (const p of ioPins) {
        assert.equal(driveCount.get(p), 1, `${def.id} io pin ${p} driven once`);
        assert.ok(usedAsInput.has(p), `${def.id} io pin ${p} not read`);
      }
    } else {
      // ── Sequential: a pure state0/step/outputs block whose initial outputs
      //    cover exactly the output-role pins.
      assert.ok(isSequential(def), `${def.id} sequential`);
      assert.equal(typeof def.logic.state0, "function");
      assert.equal(typeof def.logic.step, "function");
      assert.equal(typeof def.logic.outputs, "function");
      const out = outputsOf(
        def,
        initialState(def),
        inputLevels(def, new Map()),
      );
      assert.deepEqual(
        [...out.keys()].sort((a, b) => a - b),
        [...outputPins].sort((a, b) => a - b),
        `${def.id} outputs cover the output pins`,
      );
      for (const pin of out.keys()) {
        assert.equal(pinRole.get(pin), "output", `${def.id} drives pin ${pin}`);
      }
    }
  });
}
