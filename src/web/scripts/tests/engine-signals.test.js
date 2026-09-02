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
// Circuit fixtures for external signals (Feature 370): a planted flag drives
// its net at OUTPUT strength, exactly as a clock source does.
//
// The most valuable assertions here are the ones with NO new engine code
// behind them: two signals disagreeing, and a signal fighting a chip output,
// both report a conflict purely because a signal is a chip-tier driver.

import test from "node:test";
import assert from "node:assert/strict";

import { buildNetlist } from "../sim/netlist.js";
import { settle, tick } from "../sim/engine.js";
import { H, L, X, Z } from "../sim/levels.js";
import { partPinHoles } from "../model/occupancy.js";
import { holesOfNode, nodeOf } from "../model/breadboard.js";

const boards = [
  { id: "bb2", type: "rail-full", x: 0, y: 0 },
  { id: "bb1", type: "pins-full", x: 0, y: 4 },
  { id: "bb3", type: "rail-full", x: 0, y: 18 },
];

const signal = (id, color, anchor, extra = {}) => ({
  id,
  color,
  type: "momentary",
  rest: "low",
  ...extra,
  ...(anchor ? { flag: { anchor, rot: 0 } } : {}),
});

function sim(doc, signalLevels) {
  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist, signalLevels });
  return {
    result,
    at: (address) => result.netLevels.get(netlist.netOfPoint.get(address)),
  };
}

test("a planted flag drives its whole node, both levels", () => {
  const doc = {
    boards,
    components: [],
    wires: [],
    signals: [signal("sig1", "red", "bb1.a12")],
  };
  for (const level of [H, L]) {
    const { at } = sim(doc, new Map([["sig1", level]]));
    assert.equal(at("bb1.a12"), level, "the anchor hole");
    assert.equal(at("bb1.e12"), level, "and the rest of its column-half");
  }
});

test("an UNPLACED signal drives nothing at all", () => {
  const doc = {
    boards,
    components: [],
    wires: [],
    signals: [signal("sig1", "red", null)],
  };
  assert.equal(
    sim(doc, new Map([["sig1", H]])).at("bb1.a12"),
    Z,
    "the hole is a net, and nothing is driving it",
  );
  // The very same signal, planted, DOES drive it — so it is the flag that
  // decides, not the level it happens to be holding.
  const planted = { ...doc, signals: [signal("sig1", "red", "bb1.a12")] };
  assert.equal(sim(planted, new Map([["sig1", H]])).at("bb1.a12"), H);
});

test("a signal with no level given contributes nothing (Z)", () => {
  const doc = {
    boards,
    components: [],
    wires: [],
    signals: [signal("sig1", "red", "bb1.a12")],
  };
  assert.equal(sim(doc, new Map()).at("bb1.a12"), Z);
});

test("a signal reaches across a wire, like any other driver", () => {
  const doc = {
    boards,
    components: [],
    wires: [{ id: "w1", from: "bb1.b12", to: "bb1.b40", color: "red" }],
    signals: [signal("sig1", "red", "bb1.a12")],
  };
  assert.equal(sim(doc, new Map([["sig1", H]])).at("bb1.a40"), H);
});

test("two signals AGREEING on one net is fine; disagreeing is a conflict", () => {
  const doc = {
    boards,
    components: [],
    wires: [],
    signals: [
      signal("sig1", "red", "bb1.a12"),
      signal("sig2", "blue", "bb1.c12"),
    ],
  };
  const agree = sim(
    doc,
    new Map([
      ["sig1", H],
      ["sig2", H],
    ]),
  );
  assert.equal(agree.at("bb1.a12"), H);
  assert.deepEqual(agree.result.warnings, []);

  const fight = sim(
    doc,
    new Map([
      ["sig1", H],
      ["sig2", L],
    ]),
  );
  assert.equal(fight.at("bb1.a12"), X);
  assert.deepEqual(
    fight.result.warnings.map((w) => w.type),
    ["conflict"],
    "chip-tier, so resolve.js reports it with no new code",
  );
});

test("a supply BEATS a signal — the tiers are unchanged", () => {
  const doc = {
    boards,
    components: [
      {
        id: "psu1",
        kind: "psu",
        ref: "psu",
        x: 40,
        y: 0,
        params: { volts: 5 },
      },
    ],
    wires: [{ id: "w1", from: "psu1.+", to: "bb1.b12", color: "red" }],
    signals: [signal("sig1", "red", "bb1.a12")],
  };
  assert.equal(
    sim(doc, new Map([["sig1", L]])).at("bb1.a12"),
    H,
    "supply wins",
  );
});

test("a signal fighting a powered chip OUTPUT is a conflict", () => {
  // A 74LS04 inverter: pin 1 in, pin 2 out. Drive its OUTPUT from a signal.
  const holes = partPinHoles("74LS04", "e20", {});
  const addr = (pin) => `bb1.${holes.find((h) => h.pin === pin).hole}`;
  const mate = (address) => {
    const [, hole] = address.split(".");
    return `bb1.${holesOfNode("pins-full", nodeOf("pins-full", hole)).find((h) => h !== hole)}`;
  };
  const doc = {
    boards,
    components: [
      {
        id: "psu1",
        kind: "psu",
        ref: "psu",
        x: 40,
        y: 0,
        params: { volts: 5 },
      },
      {
        id: "c1",
        kind: "chip",
        ref: "74LS04",
        board: "bb1",
        anchor: "e20",
        params: {},
      },
    ],
    wires: [
      { id: "w1", from: "psu1.+", to: "bb2.+1", color: "red" },
      { id: "w2", from: "psu1.-", to: "bb2.-1", color: "black" },
      { id: "w3", from: mate(addr(14)), to: "bb2.+20", color: "red" },
      { id: "w4", from: mate(addr(7)), to: "bb2.-20", color: "black" },
      // Pin 1 (1A) tied LOW, so the inverter's output (pin 2) drives HIGH.
      { id: "w5", from: mate(addr(1)), to: "bb2.-25", color: "black" },
    ],
    // The flag plugs into the OUTPUT pin's node.
    signals: [signal("sig1", "red", mate(addr(2)))],
  };
  const quiet = sim(doc, new Map([["sig1", H]]));
  assert.equal(quiet.at(addr(2)), H, "agreeing with the output is no conflict");
  assert.deepEqual(quiet.result.warnings, []);

  const fight = sim(doc, new Map([["sig1", L]]));
  assert.equal(fight.at(addr(2)), X);
  assert.ok(fight.result.warnings.some((w) => w.type === "conflict"));
});

test("tick() carries signal levels too — all three settle passes", () => {
  const doc = {
    boards,
    components: [],
    wires: [],
    signals: [signal("sig1", "red", "bb1.a12")],
  };
  const netlist = buildNetlist(doc);
  const result = tick({
    document: doc,
    netlist,
    signalLevels: new Map([["sig1", H]]),
  });
  assert.equal(result.netLevels.get(netlist.netOfPoint.get("bb1.a12")), H);
});
