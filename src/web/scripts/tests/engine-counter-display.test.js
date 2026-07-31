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

// A clocked 74LS161 counter driving an LED bar — the second circuit fixture,
// chosen because it is structurally UNLIKE engine-adder.test.js on every axis
// that matters to a netlist→board compiler:
//
//   adder                          this
//   ─────                          ────
//   combinational (`settle`)       sequential (`tick`, a clock brick, edges)
//   outputs read as pin levels     outputs read as LIGHT (sim/junction.js)
//   no display, no resistor        a display that BURNS without a series resistor
//
// That last row is the one this fixture exists for. The catalog used to claim
// LEDs were "idealized — no series resistor required"; they are not, and a
// generated circuit that omits the resistor produces a display that reads burnt
// rather than lit. Both variants are built here, so the requirement is proven
// rather than asserted in a comment.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { tick as engineTick } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { junctionState, isLit } from "../sim/junction.js";
import { normalizeDocument } from "../model/desk-doc.js";
import { partPinHoles } from "../model/occupancy.js";
import { spec, holesOfNode, nodeOf } from "../model/breadboard.js";

const BOARD = "pins-full";
// A kit's own stack, at the strips' MEASURED heights (board-types.js): a rail
// is 3.70 pitch tall and a pin-board 14.02, so nothing here is a whole number
// and nothing here may be written as one — `normalizeDocument` drops a board
// that overlaps its neighbour, which is what a stale literal would produce.
const RAIL_H = spec("rail-full").height;
const boards = [
  { id: "bb1", type: "rail-full", x: 0, y: 0 },
  { id: "bb2", type: BOARD, x: 0, y: RAIL_H },
  { id: "bb3", type: "rail-full", x: 0, y: RAIL_H + spec(BOARD).height },
];

let wireSeq = 0;
const wire = (from, to, color = "black") => ({
  id: `w${++wireSeq}`,
  from,
  to,
  color,
});

function holesOf(ref, anchor, params) {
  const m = new Map();
  for (const { pin, hole } of partPinHoles(ref, anchor, params))
    m.set(pin, hole);
  return m;
}

/** One lead per hole — see engine-adder.test.js for why a naive picker fails. */
function allocator(components) {
  const claimed = new Set();
  for (const c of components) {
    if (!c.board) continue;
    for (const { hole } of partPinHoles(c.ref, c.anchor, c.params) ?? []) {
      if (hole != null) claimed.add(`${c.board}.${hole}`);
    }
  }
  return function freeAt(holes, pin) {
    for (const h of holesOfNode(BOARD, nodeOf(BOARD, holes.get(pin)))) {
      const addr = `bb2.${h}`;
      if (!claimed.has(addr)) {
        claimed.add(addr);
        return addr;
      }
    }
    throw new Error(`no free hole on the node of pin ${pin}`);
  };
}

const HI = (k) => `bb1.+${k}`;
const LO = (k) => `bb3.-${k}`;

// 74LS161 (catalog/chips-seq.js) and bar8 (catalog/parts.js).
const CTR = {
  CLR: 1,
  CLK: 2,
  ENP: 7,
  GND: 8,
  LOAD: 9,
  ENT: 10,
  Q: [14, 13, 12, 11], // QA..QD, LSB first
  RCO: 15,
  VCC: 16,
};
const BAR_K = 9;

const AT = { CTR: 3, BAR: 20, RES: 32 };

/**
 * The counter + bar display. With `limited: false` the bar's common cathode
 * goes straight to the − rail — the wiring the old documentation recommended,
 * and the one that burns.
 */
function buildCounter({ limited = true } = {}) {
  wireSeq = 0;
  const ctr = holesOf("74LS161", `e${AT.CTR}`);
  const bar = holesOf("bar8", `a${AT.BAR}`);
  const res = holesOf("resistor", `a${AT.RES}`);

  const components = [
    { id: "psu1", kind: "psu", ref: "psu", x: 70, y: 0, params: { volts: 5 } },
    {
      id: "clk1",
      kind: "clock",
      ref: "clock",
      x: 70,
      y: 12,
      params: { hz: "manual" },
    },
    {
      id: "c1",
      kind: "chip",
      ref: "74LS161",
      board: "bb2",
      anchor: `e${AT.CTR}`,
      params: {},
    },
    {
      id: "c2",
      kind: "discrete",
      ref: "bar8",
      board: "bb2",
      anchor: `a${AT.BAR}`,
      params: {},
    },
  ];
  if (limited) {
    components.push({
      id: "c3",
      kind: "discrete",
      ref: "resistor",
      board: "bb2",
      anchor: `a${AT.RES}`,
      params: { ohms: 330 },
    });
  }

  const at = allocator(components);
  const wires = [
    wire("psu1.+", HI(1), "red"),
    wire("psu1.-", LO(1), "black"),
    wire(HI(2), "bb3.+1", "red"), // a kit's two rail strips share no node
    wire(LO(2), "bb1.-1", "black"),
    wire(at(ctr, CTR.VCC), HI(3), "red"),
    wire(at(ctr, CTR.GND), LO(3), "black"),
    // Free-run: clear and load inactive (both active-low), both enables high.
    wire(at(ctr, CTR.CLR), HI(4), "red"),
    wire(at(ctr, CTR.LOAD), HI(5), "red"),
    wire(at(ctr, CTR.ENP), HI(6), "red"),
    wire(at(ctr, CTR.ENT), HI(7), "red"),
    wire("clk1.out", at(ctr, CTR.CLK), "green"),
    wire("clk1.gnd", LO(4), "black"),
  ];
  // QA..QD light bars 1..4.
  for (let i = 0; i < 4; i++) {
    wires.push(wire(at(ctr, CTR.Q[i]), at(bar, i + 1), "blue"));
  }
  // The common cathode's path to ground — through a resistor, or not.
  if (limited) {
    wires.push(
      wire(at(bar, BAR_K), at(res, 1), "black"),
      wire(at(res, 2), LO(5), "black"),
    );
  } else {
    wires.push(wire(at(bar, BAR_K), LO(5), "black"));
  }

  return { raw: { boards, components, wires }, bar, ctr };
}

/** A stepping harness over the pure engine (shape shared with engine-ripple). */
class Bench {
  constructor({ limited = true } = {}) {
    const { raw, bar, ctr } = buildCounter({ limited });
    this.doc = normalizeDocument(raw);
    assert.equal(
      this.doc.components.length,
      raw.components.length,
      "components kept",
    );
    assert.equal(this.doc.wires.length, raw.wires.length, "wires kept");

    this.bar = bar;
    this.ctr = ctr;
    this.netlist = buildNetlist(this.doc);
    this.warm = new Map();
    this.state = new Map();
    this.prev = new Map();
    this.phase = new Map([["clk1", L]]);
    this.tick();
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
  set(level) {
    this.phase.set("clk1", level);
    return this.tick();
  }
  /** One rising edge — the 74161 counts on the rise. */
  rise() {
    this.set(L);
    return this.set(H);
  }
  level(addr) {
    return this.last.netLevels.get(this.netlist.netOfPoint.get(addr));
  }
  strong(addr) {
    return this.last.strongLevels.get(this.netlist.netOfPoint.get(addr));
  }
  count() {
    return this.ctrQ().reduce((n, hi, i) => n | (hi ? 1 << i : 0), 0);
  }
  ctrQ() {
    return CTR.Q.map((p) => this.level(`bb2.${this.ctr.get(p)}`) === H);
  }
  /** The junction state of bar segment `i` (1-based), straight from the model. */
  segment(i) {
    const anodeAt = `bb2.${this.bar.get(i)}`;
    const cathodeAt = `bb2.${this.bar.get(BAR_K)}`;
    return junctionState({
      anode: this.level(anodeAt),
      cathode: this.level(cathodeAt),
      anodeStrong: this.strong(anodeAt),
      cathodeStrong: this.strong(cathodeAt),
    });
  }
}

// ── Sequential behaviour ─────────────────────────────────────────────────────

test("the counter powers up healthy and settles", () => {
  const b = new Bench();
  assert.equal(b.last.settled, true);
  assert.deepEqual(b.last.warnings, []);
  assert.equal(b.last.chipStatus.get("c1")?.status, "ok");
});

test("the 74161 counts 0→15 on rising edges and rolls over", () => {
  const b = new Bench();
  assert.equal(b.count(), 0, "starts cleared");
  for (let expected = 1; expected <= 16; expected++) {
    b.rise();
    assert.equal(b.count(), expected % 16, `after rise ${expected}`);
  }
});

// ── The display, through the real junction rule ──────────────────────────────

test("the lit bars track the count", () => {
  const b = new Bench();
  for (let n = 0; n <= 15; n++) {
    if (n > 0) b.rise();
    for (let i = 0; i < 4; i++) {
      const shouldLight = ((n >> i) & 1) === 1;
      assert.equal(
        isLit(b.segment(i + 1)),
        shouldLight,
        `count ${n}: bar ${i + 1}`,
      );
    }
  }
});

test("bars 5-8 stay dark — nothing drives them", () => {
  const b = new Bench();
  b.rise();
  for (let i = 5; i <= 8; i++) {
    assert.equal(isLit(b.segment(i)), false, `bar ${i} has no driver`);
  }
});

// ── Why the compiler must insert the resistor ────────────────────────────────

test("a series resistor is what makes the display light instead of burn", () => {
  const limited = new Bench({ limited: true });
  const bare = new Bench({ limited: false });
  limited.rise(); // count 1 → bar 1 driven high
  bare.rise();

  const withR = limited.segment(1);
  const withoutR = bare.segment(1);

  // Both conduct: the levels are identical, so a logic-only view sees no
  // difference at all. The difference is entirely in the STRENGTH of the
  // cathode net, which is what current limiting means here.
  assert.equal(withR.conducting, true, "conducts through the resistor");
  assert.equal(withoutR.conducting, true, "conducts straight to the rail too");

  assert.equal(withR.unlimited, false, "the resistor limits it");
  assert.equal(isLit(withR), true, "so it lights");

  assert.equal(withoutR.unlimited, true, "nothing limits it");
  assert.equal(isLit(withoutR), false, "so it burns instead of lighting");

  // The mechanism, stated so a regression names itself: a net reached only
  // through a resistor settles to L but is not STRONGLY driven there.
  const cathode = `bb2.${limited.bar.get(BAR_K)}`;
  assert.equal(limited.level(cathode), L, "the cathode still settles low");
  assert.notEqual(limited.strong(cathode), L, "but it is pulled, not driven");
});

test("every driven bar burns when the cathode goes straight to ground", () => {
  // Not just bar 1 — the whole block is compromised by the one missing part,
  // which is why a single resistor in the common leg is the right fix.
  const bare = new Bench({ limited: false });
  bare.rise();
  bare.rise();
  bare.rise(); // count 3 → bars 1 and 2 driven
  for (const i of [1, 2]) {
    assert.equal(bare.segment(i).unlimited, true, `bar ${i} is over-driven`);
    assert.equal(isLit(bare.segment(i)), false, `bar ${i} does not light`);
  }
});
