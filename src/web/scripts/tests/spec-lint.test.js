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

// Tests for model/spec-lint.js — the electrical rules a generated netlist is
// held to that the engine, rightly, lets through: which outputs can share a
// net, and which inputs a part is using without anything connected to them.

import test from "node:test";
import assert from "node:assert/strict";

import { outputEnables, partDef } from "../catalog/index.js";
import {
  floatingInputs,
  netDrivers,
  switchableOutputs,
} from "../model/spec-lint.js";

const names = (ref, pins) =>
  [...pins].map((n) => partDef(ref).pins.find((p) => p.n === n).name).sort();

const part = (id, ref) => ({ id, def: partDef(ref) });
const net = (...members) => ({
  pins: members.map(([partId, pin]) => ({ partId, kind: "pin", pin })),
});

test("switchable outputs are PROBED, not assumed from the enable", () => {
  assert.deepEqual(names("74LS244", switchableOutputs(partDef("74LS244"))), [
    "1Y1",
    "1Y2",
    "1Y3",
    "1Y4",
    "2Y1",
    "2Y2",
    "2Y3",
    "2Y4",
  ]);
  // The '595's OE floats the parallel outputs and leaves the serial QH'
  // driving — so QH' can never share a net with another driver.
  const s595 = switchableOutputs(partDef("74LS595"));
  assert.equal(s595.size, 8);
  assert.ok(!s595.has(9), "QH' is always driven");
  // A plain gate has nothing to switch off.
  assert.equal(switchableOutputs(partDef("74LS00")).size, 0);
});

test("a memory's data outputs are switchable, on its OWN chip and output enables", () => {
  // Read from `logic.memory`, never declared twice.
  const rom = partDef("rom-8k");
  assert.deepEqual(outputEnables(rom), [
    rom.logic.memory.ceN,
    rom.logic.memory.oeN,
  ]);
  assert.equal(switchableOutputs(rom).size, 8, "Q0–Q7");
  // The AS6C1024's CE2 is active-HIGH: not an output enable.
  const sram = partDef("AS6C1024");
  assert.ok(!outputEnables(sram).includes(sram.logic.memory.ce2));
});

test("netDrivers splits a net's outputs into the ones that can be switched off", () => {
  const parts = new Map([
    ["U1", part("U1", "74LS244")],
    ["U2", part("U2", "74LS04")],
    ["U3", part("U3", "74LS04")],
  ]);
  const d = netDrivers(net(["U1", 18], ["U2", 2], ["U3", 1]).pins, parts);
  assert.deepEqual(
    d.switchable.map((x) => `${x.partId}.${x.name}`),
    ["U1.1Y1"],
  );
  assert.deepEqual(
    d.hard.map((x) => `${x.partId}.${x.name}`),
    ["U2.1Y"],
  );
});

test("the spare gates of a 7400 may float; the gate in use may not", () => {
  // Only gate 1's output (pin 3) is used, so only its inputs are required.
  const loose = floatingInputs(
    [part("U1", "74LS00")],
    [net(["U1", 3], ["X", 1]), net(["U1", 1], ["X", 2])],
  );
  assert.deepEqual(loose, [
    { partId: "U1", ref: "74LS00", pins: [{ n: 2, name: "1B" }] },
  ]);
});

test("a decoder whose outputs are wired needs every select AND enable", () => {
  const loose = floatingInputs(
    [part("U1", "74LS138")],
    [
      net(["U1", 15], ["X", 1]),
      net(["U1", 1], ["X", 2]),
      net(["U1", 6], ["X", 3]),
    ],
  );
  assert.deepEqual(
    loose[0].pins.map((p) => p.name),
    ["B", "C", "G2A", "G2B"],
  );
});

test("a dual flip-flop's unused half may float; the used half's controls may not", () => {
  // Only 1Q is wired, so 1D/1CLK/1PRE/1CLR are required and the whole second
  // flip-flop is not — read off the datasheet's own `1…`/`2…` numbering.
  const loose = floatingInputs(
    [part("U1", "74LS74")],
    [
      net(["U1", 5], ["X", 1]),
      net(["U1", 2], ["X", 2]),
      net(["U1", 3], ["X", 3]),
    ],
  );
  assert.deepEqual(loose[0].pins.map((p) => p.name).sort(), ["1CLR", "1PRE"]);
});

test("a SHARED control is needed as soon as any section is in use", () => {
  // The '175's CLK and CLR serve all four flip-flops.
  const loose = floatingInputs(
    [part("U1", "74LS175")],
    [net(["U1", 2], ["X", 1]), net(["U1", 4], ["X", 2])],
  );
  assert.deepEqual(loose[0].pins.map((p) => p.name).sort(), ["CLK", "CLR"]);
});

test("a counter's load data is needed even while LOAD holds it inert", () => {
  // Tying unused inputs is the rule the prompt states and the bench follows;
  // the alternative is a part whose behaviour depends on what HIGH means there.
  const loose = floatingInputs(
    [part("U1", "74LS161")],
    [
      net(["U1", 14], ["X", 1]),
      net(["U1", 1], ["U1", 9], ["U1", 7], ["U1", 10]),
      net(["U1", 2], ["X", 2]),
    ],
  );
  assert.deepEqual(
    loose[0].pins.map((p) => p.name),
    ["A", "B", "C", "D"],
  );
});

test("a part nothing uses asks for nothing", () => {
  assert.deepEqual(floatingInputs([part("U1", "74LS74")], []), []);
  // Nor does a part with no inputs at all.
  assert.deepEqual(
    floatingInputs([part("D1", "bar8")], [net(["D1", 1], ["X", 1])]),
    [],
  );
});
