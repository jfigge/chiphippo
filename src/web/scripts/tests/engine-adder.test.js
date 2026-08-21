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

// An 8-bit adder with carry, built from the catalog and proven by the engine.
//
// Two 74LS283 4-bit adders ripple-carried (U1.C4 → U2.C0), operands set on two
// sw-dip8 banks, each bank pulled down by an rnet9 so an OPEN switch reads a
// clean L instead of floating. The circuit is purely combinational, so `settle`
// is the right primitive — no clock, no tick, no sequential state.
//
// Switch state is a NETLIST INPUT (a closed position's internalBridges
// conduct), so changing operands means rebuilding the netlist, not just
// re-settling — that is the contract, and asserting through it is the point.
//
// The wiring here is deliberately the arrangement a person would build on a
// bench, including the trick that earns its keep: the rnet9 sits in row `a` at
// the SAME start column as its switch bank in row `e`, so its eight elements
// land on the same lower nodes (c<col>L) as the bank's row-e pins. Eight
// pull-downs for one wire (COM → −rail) instead of eight.
//
// It goes in TURNED ROUND (`rot: 180`), which is what puts the eight elements
// over the bank and leaves the common bus overhanging one column clear of it —
// pin 1 is COM on a bussed SIP, at the end the printed dot marks, so the other
// way round would sit COM on switch position 1's node and the elements one
// column adrift. It is the same way round model/autobuild.js seats one.

import test from "node:test";
import assert from "node:assert/strict";

import { H, L } from "../sim/levels.js";
import { settle } from "../sim/engine.js";
import { buildNetlist } from "../sim/netlist.js";
import { normalizeDocument } from "../model/desk-doc.js";
import { partPinHoles } from "../model/occupancy.js";
import { spec, holesOfNode, nodeOf } from "../model/breadboard.js";

// ── Fixture builders (shared shape with engine-ripple/engine-seq) ────────────

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

/**
 * One lead per hole. A naive "first mate of the node" picker is not enough
 * here: the rnet9 deliberately sits on the SAME nodes as its switch bank, so
 * some of those mates already hold a pin. Track what is claimed and hand out
 * the first genuinely free hole — the same primitive scripts/make-demos.mjs
 * calls `freeAt`, and the one a netlist→board compiler needs.
 */
function allocator(components) {
  const claimed = new Set();
  for (const c of components) {
    if (!c.board) continue;
    for (const { hole } of partPinHoles(c.ref, c.anchor, c.params) ?? []) {
      if (hole != null) claimed.add(`${c.board}.${hole}`);
    }
  }
  /** A free hole address on the node carrying `pin` of `holes`. */
  return function freeAt(holes, pin) {
    const hole = holes.get(pin);
    for (const h of holesOfNode(BOARD, nodeOf(BOARD, hole))) {
      const addr = `bb2.${h}`;
      if (!claimed.has(addr)) {
        claimed.add(addr);
        return addr;
      }
    }
    throw new Error(`no free hole on the node of ${hole}`);
  };
}

const HI = (k) => `bb1.+${k}`;
const LO = (k) => `bb3.-${k}`;

// 74LS283 pinout (catalog/chips-74ls.js), LSB first.
const ADD = {
  A: [5, 3, 14, 12],
  B: [6, 2, 15, 11],
  S: [4, 1, 13, 10],
  C0: 7,
  C4: 9,
  VCC: 16,
  GND: 8,
};

// Column plan — each part gets a contiguous run on the one pins-full board.
const AT = { U1: 3, U2: 12, SWA: 22, RNA: 22, SWB: 32, RNB: 32 };

/** The full adder document, with both operand banks set from `a` and `b`. */
/** Both arrays go in end-for-end — see the header note. */
const TURNED = Object.freeze({ rot: 180 });

function buildAdder(a, b) {
  wireSeq = 0;
  const bits = (v) => Array.from({ length: 8 }, (_, i) => ((v >> i) & 1) === 1);

  const u1 = holesOf("74LS283", `e${AT.U1}`);
  const u2 = holesOf("74LS283", `e${AT.U2}`);
  const swa = holesOf("sw-dip8", `e${AT.SWA}`);
  const swb = holesOf("sw-dip8", `e${AT.SWB}`);
  const rna = holesOf("rnet9", `a${AT.RNA}`, TURNED);
  const rnb = holesOf("rnet9", `a${AT.RNB}`, TURNED);

  const components = [
    { id: "psu1", kind: "psu", ref: "psu", x: 70, y: 0, params: { volts: 5 } },
    {
      id: "c1",
      kind: "chip",
      ref: "74LS283",
      board: "bb2",
      anchor: `e${AT.U1}`,
      params: {},
    },
    {
      id: "c2",
      kind: "chip",
      ref: "74LS283",
      board: "bb2",
      anchor: `e${AT.U2}`,
      params: {},
    },
    {
      id: "c3",
      kind: "discrete",
      ref: "sw-dip8",
      board: "bb2",
      anchor: `e${AT.SWA}`,
      params: { states: bits(a) },
    },
    {
      id: "c4",
      kind: "discrete",
      ref: "sw-dip8",
      board: "bb2",
      anchor: `e${AT.SWB}`,
      params: { states: bits(b) },
    },
    {
      id: "c5",
      kind: "discrete",
      ref: "rnet9",
      board: "bb2",
      anchor: `a${AT.RNA}`,
      params: TURNED,
    },
    {
      id: "c6",
      kind: "discrete",
      ref: "rnet9",
      board: "bb2",
      anchor: `a${AT.RNB}`,
      params: TURNED,
    },
  ];

  const at = allocator(components);

  const wires = [
    // Power in, and the two rail strips of a kit are electrically SEPARATE —
    // bridge them or the bottom rail is dead.
    wire("psu1.+", HI(1), "red"),
    wire("psu1.-", LO(1), "black"),
    wire(HI(2), `bb3.+1`, "red"),
    wire(LO(2), `bb1.-1`, "black"),
    // Chip power.
    wire(at(u1, ADD.VCC), HI(3), "red"),
    wire(at(u1, ADD.GND), LO(3), "black"),
    wire(at(u2, ADD.VCC), HI(4), "red"),
    wire(at(u2, ADD.GND), LO(4), "black"),
    // Ripple carry: the low nibble's carry-in is grounded, its carry-out feeds
    // the high nibble.
    wire(at(u1, ADD.C0), LO(5), "black"),
    wire(at(u1, ADD.C4), at(u2, ADD.C0), "green"),
    // Pull-down commons (pin 1 = COM on each rnet9).
    wire(at(rna, 1), LO(6), "black"),
    wire(at(rnb, 1), LO(7), "black"),
  ];

  // Operand bits. A closed switch position k bridges its row-e pin k to its
  // row-f pin 17-k; wiring that row-f pin to the + rail makes a closed switch
  // read H, while the rnet9 under the row-e pins holds an open one at L.
  for (let i = 0; i < 8; i++) {
    const k = i + 1;
    const chip = i < 4 ? u1 : u2;
    const nib = i % 4;
    wires.push(
      wire(at(swa, 17 - k), HI(10 + i), "red"),
      wire(at(swb, 17 - k), HI(20 + i), "red"),
      // Row-e pin of the bank → the adder's A/B input for that bit.
      wire(at(swa, k), at(chip, ADD.A[nib]), "blue"),
      wire(at(swb, k), at(chip, ADD.B[nib]), "yellow"),
    );
  }

  return {
    doc: { boards, components, wires },
    pins: { u1, u2 },
  };
}

/** Settle a freshly-built document and expose level lookups. */
function run(a, b) {
  const { doc: raw, pins } = buildAdder(a, b);
  const doc = normalizeDocument(raw);
  // The loader silently drops anything malformed, so a count comparison is the
  // only way to know the fixture survived intact (make-demos.mjs's assertClean).
  assert.equal(
    doc.boards.length,
    raw.boards.length,
    "boards survived the loader",
  );
  assert.equal(
    doc.components.length,
    raw.components.length,
    "components survived the loader",
  );
  assert.equal(doc.wires.length, raw.wires.length, "wires survived the loader");

  const netlist = buildNetlist(doc);
  const result = settle({ document: doc, netlist });
  const level = (addr) => result.netLevels.get(netlist.netOfPoint.get(addr));
  const pin = (holes, p) => level(`bb2.${holes.get(p)}`);
  return { doc, netlist, result, pins, pin };
}

// ── The proof ────────────────────────────────────────────────────────────────

test("the 8-bit adder settles cleanly with both chips powered", () => {
  const { result, doc } = run(0, 0);
  assert.equal(result.settled, true, "reaches a fixpoint");
  assert.deepEqual(result.warnings, [], "no shorts, conflicts or oscillation");
  for (const id of ["c1", "c2"]) {
    assert.equal(
      result.chipStatus.get(id)?.status,
      "ok",
      `${id} is powered and healthy`,
    );
  }
  // Sanity on the fixture itself: one Full-830 kit, and every part seated.
  assert.equal(doc.boards.length, 3, "one full kit: rail · pins · rail");
});

test("A + B is correct across the 8-bit range, carry included", () => {
  const vectors = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
    [15, 1], // carry across the nibble boundary — the ripple joint
    [16, 16],
    [181, 78], // 259: sum 3 with carry out
    [127, 128], // 255: the largest sum with no carry
    [128, 128], // 256: carry with a zero sum
    [255, 255], // 510: both operands saturated
  ];

  for (const [a, b] of vectors) {
    const { pin, pins } = run(a, b);
    const expected = (a + b) & 0xff;
    const expectedCarry = a + b > 0xff;

    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const chip = i < 4 ? pins.u1 : pins.u2;
      const level = pin(chip, ADD.S[i % 4]);
      assert.ok(level === H || level === L, `S${i} of ${a}+${b} is driven`);
      if (level === H) sum |= 1 << i;
    }
    assert.equal(sum, expected, `${a} + ${b} = ${expected} (sum bits)`);
    assert.equal(
      pin(pins.u2, ADD.C4) === H,
      expectedCarry,
      `${a} + ${b} carry-out`,
    );
  }
});

test("the ripple carry is what joins the two nibbles", () => {
  // 15 + 1 = 16: the low adder must hand a carry up, and the high adder must
  // turn it into S4 (bit 4). Reading the joint directly pins the failure to the
  // carry wire rather than to the sum bits.
  const { pin, pins } = run(15, 1);
  assert.equal(pin(pins.u1, ADD.C4), H, "low nibble carries out");
  assert.equal(pin(pins.u2, ADD.C0), H, "high nibble carries in");
  assert.equal(pin(pins.u2, ADD.S[0]), H, "bit 4 of the sum is set");
});

test("open switch positions read L rather than floating", () => {
  // Without the rnet9 pull-downs an open position would leave its input net
  // undriven; "floating reads HIGH" would then invert the switch sense and
  // every operand bit would be wrong. Assert the OFF state is a real L.
  const { pin, pins } = run(0, 0);
  for (let i = 0; i < 8; i++) {
    const chip = i < 4 ? pins.u1 : pins.u2;
    assert.equal(
      pin(chip, ADD.A[i % 4]),
      L,
      `A${i} is pulled down, not floating`,
    );
    assert.equal(
      pin(chip, ADD.B[i % 4]),
      L,
      `B${i} is pulled down, not floating`,
    );
  }
});
