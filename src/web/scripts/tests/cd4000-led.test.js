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

// The LED rule meets the CD4000 family: a B-series output is too weak to burn
// an LED wired straight onto it — at 5 V and below (catalog/families.js
// `ledLimit`, with the datasheet numbers). Through the WHOLE engine, with a
// real LED on the bench, read the way every view reads it (junctionState over
// `netLevels` and `strongLevels`):
//
//   · a CD4000 output, sourcing or sinking, lights an LED with no resistor at
//     3 and 5 V, and burns it from 9 V up;
//   · a 74LS output burns it at 5 V, as it always has;
//   · a part with a high-current stage burns it on THAT side only — the
//     CD4049UB's sink, the CD4511B's segment source;
//   · a CD4066B channel's on-resistance limits it at 5 V — whatever drives the
//     far side, a supply rail included — and does not at 9 V.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { settle } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { junctionState, isLit } from "../sim/junction.js";
import { chipDef } from "../catalog/index.js";
import { limitsLedCurrent } from "../catalog/families.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

// ── A bench built in code ────────────────────────────────────────────────────

const boards = [
  { id: "bb2", type: "rail-full", x: 0, y: 0 },
  { id: "bb1", type: "pins-full", x: 0, y: 4 },
  { id: "bb3", type: "rail-full", x: 0, y: 18 },
];
let seq = 0;
const wire = (from, to) => ({ id: `w${++seq}`, from, to, color: "black" });
const psu = (volts) => ({
  id: "psu1",
  kind: "psu",
  ref: "psu",
  x: 80,
  y: 30,
  params: { volts },
});
/** The i-th free hole sharing `hole`'s column-half. */
const mate = (hole, i = 0) =>
  holesOfNode("pins-full", nodeOf("pins-full", hole)).filter((h) => h !== hole)[
    i
  ];

/**
 * One chip at `anchor` and the LED at a40 (anode a40, cathode a41). `ties`
 * puts pins on a rail (`+`/`-`); every supply pin is powered; `led` names
 * what each leg is wired to — a pin number or a rail. Returns the junction's
 * state as the desk would draw it.
 */
function bench({ ref, volts, ties = {}, led, anchor = "e10" }) {
  const def = chipDef(ref);
  const holes = new Map(
    partPinHoles(ref, anchor).map(({ pin, hole }) => [pin, hole]),
  );
  const used = new Map();
  const free = (pin) => {
    const i = used.get(pin) ?? 0;
    used.set(pin, i + 1);
    return `bb1.${mate(holes.get(pin), i)}`;
  };
  const to = (end) => (typeof end === "number" ? free(end) : `psu1.${end}`);
  const wires = [];
  for (const p of def.pins) {
    if (p.role === "vcc") wires.push(wire("psu1.+", free(p.n)));
    if (p.role === "gnd") wires.push(wire("psu1.-", free(p.n)));
  }
  for (const [pin, rail] of Object.entries(ties)) {
    wires.push(wire(`psu1.${rail}`, free(Number(pin))));
  }
  wires.push(wire(to(led.anode), `bb1.${mate("a40")}`));
  wires.push(wire(to(led.cathode), `bb1.${mate("a41")}`));
  const doc = {
    boards,
    components: [
      psu(volts),
      { id: "c1", kind: "chip", ref, board: "bb1", anchor, params: {} },
      { id: "d1", kind: "discrete", ref: "led", board: "bb1", anchor: "a40" },
    ],
    wires,
  };
  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist });
  const net = (hole) => netlist.netOfPoint.get(`bb1.${hole}`);
  return junctionState({
    anode: result.netLevels.get(net("a40")),
    cathode: result.netLevels.get(net("a41")),
    anodeStrong: result.strongLevels.get(net("a40")),
    cathodeStrong: result.strongLevels.get(net("a41")),
  });
}

/** Every input of `ref` but `used`, tied to `rail` — a CMOS part's spares. */
const spares = (ref, used, rail = "-") =>
  Object.fromEntries(
    chipDef(ref)
      .pins.filter((p) => p.role === "input" && !used.includes(p.n))
      .map((p) => [p.n, rail]),
  );

const lit = (state) => assert.ok(isLit(state), "lit, not burnt");
const burnt = (state) => {
  assert.equal(state.conducting, true, "conducting");
  assert.equal(state.unlimited, true, "burnt");
};

// CD4069UB gate 1: input 1 → output 2.
/** The inverter's output driving an LED to GND (it SOURCES) or from + (it SINKS). */
const inverter = (volts, side) =>
  bench({
    ref: "CD4069UB",
    volts,
    ties: { 1: side === "source" ? "-" : "+", ...spares("CD4069UB", [1]) },
    led:
      side === "source"
        ? { anode: 2, cathode: "-" }
        : { anode: "+", cathode: 2 },
  });

// ── The family fact ─────────────────────────────────────────────────────────

test("limitsLedCurrent: CD4000 outputs at 5 V and below, never a 74LS one", () => {
  const cmos = chipDef("CD4011B");
  for (const v of [3, 5]) {
    assert.equal(limitsLedCurrent(cmos, v, H), true);
    assert.equal(limitsLedCurrent(cmos, v, L), true);
  }
  for (const v of [9, 12, 15])
    assert.equal(limitsLedCurrent(cmos, v, H), false);
  assert.equal(limitsLedCurrent(cmos, null, H), false, "unpowered: no answer");
  assert.equal(limitsLedCurrent(chipDef("74LS00"), 5, H), false);
  assert.equal(limitsLedCurrent(chipDef("Z80A"), 5, H), false);
  // The high-current sides.
  assert.equal(limitsLedCurrent(chipDef("CD4049UB"), 5, L), false);
  assert.equal(limitsLedCurrent(chipDef("CD4049UB"), 5, H), true);
  assert.equal(limitsLedCurrent(chipDef("CD4050B"), 5, L), false);
  assert.equal(limitsLedCurrent(chipDef("CD4511B"), 5, H), false);
  assert.equal(limitsLedCurrent(chipDef("CD4511B"), 5, L), true);
  // A channel (no level) by the switch's supply.
  assert.equal(limitsLedCurrent(chipDef("CD4066B"), 5), true);
  assert.equal(limitsLedCurrent(chipDef("CD4066B"), 9), false);
});

// ── Standard outputs ────────────────────────────────────────────────────────

test("a CD4000 output lights an LED with no resistor at 3 and 5 V", () => {
  for (const volts of [3, 5]) {
    lit(inverter(volts, "source"));
    lit(inverter(volts, "sink"));
  }
});

test("a CD4000 output burns an LED with no resistor from 9 V up", () => {
  for (const volts of [9, 12, 15]) {
    burnt(inverter(volts, "source"));
    burnt(inverter(volts, "sink"));
  }
});

test("a 74LS output still burns an LED with no resistor at 5 V", () => {
  // 74LS04 gate 1: input 1 → output 2; spare inputs may float on TTL.
  burnt(
    bench({
      ref: "74LS04",
      volts: 5,
      ties: { 1: "-" },
      led: { anode: 2, cathode: "-" },
    }),
  );
});

test("an LED straight across the rails burns whatever chips share them", () => {
  burnt(
    bench({
      ref: "CD4069UB",
      volts: 5,
      ties: spares("CD4069UB", []),
      led: { anode: "+", cathode: "-" },
    }),
  );
});

// ── High-current stages ─────────────────────────────────────────────────────

test("CD4049UB: its buffer SINK burns an LED at 5 V; its source does not", () => {
  // Input 3 → output 2.
  const buffer = (input, led) =>
    bench({
      ref: "CD4049UB",
      volts: 5,
      ties: { 3: input, ...spares("CD4049UB", [3]) },
      led,
    });
  burnt(buffer("+", { anode: "+", cathode: 2 }));
  lit(buffer("-", { anode: 2, cathode: "-" }));
});

test("CD4511B: its bipolar segment SOURCE burns an LED at 5 V", () => {
  // LT and BL HIGH, LE LOW, D C B A = 1000 (an 8): segment a (pin 13) HIGH.
  burnt(
    bench({
      ref: "CD4511B",
      volts: 5,
      ties: { 3: "+", 4: "+", 5: "-", 6: "+", 2: "-", 1: "-", 7: "-" },
      led: { anode: 13, cathode: "-" },
    }),
  );
});

// ── Analog switches ─────────────────────────────────────────────────────────

// CD4066B switch A: 1 ↔ 2, CONTROL A 13; B–D held open.
const throughSwitch = (volts, ties) =>
  bench({
    ref: "CD4066B",
    volts,
    ties: { 13: "+", 5: "-", 6: "-", 12: "-", ...ties },
    led: { anode: 2, cathode: "-" },
  });

test("CD4066B: a rail through a 5 V switch lights an LED — its rON limits it", () => {
  lit(throughSwitch(5, { 1: "+" }));
});

test("CD4066B: the same switch at 9 V burns it", () => {
  burnt(throughSwitch(9, { 1: "+" }));
});
