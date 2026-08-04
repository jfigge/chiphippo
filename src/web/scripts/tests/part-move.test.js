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

// Tests for which wires RIDE a re-seated part and where they land
// (model/part-move.js, Feature 290's Option-drag).

import test from "node:test";
import assert from "node:assert/strict";

import {
  partNodeKeys,
  partsRidingPart,
  planPartMove,
  wiresRidingPart,
} from "../model/part-move.js";
import { DeskDoc } from "../model/desk-doc.js";
import { buildNetlist } from "../sim/netlist.js";

const FULL = { id: "bb1", type: "pins-full", x: 0, y: 0 };
const HALF = { id: "bb2", type: "pins-half", x: 80, y: 0 };
const TINY = { id: "bb3", type: "pins-tiny", x: 160, y: 0 };
const RAIL = { id: "bb4", type: "rail-full", x: 0, y: -4 };

/** A 74LS00 (DIP-14) at `anchor`, plus whatever parts and wires are listed. */
function scene({
  boards = [FULL],
  anchor = "e5",
  ref = "74LS00",
  parts = [],
  wires = [],
}) {
  return {
    boards,
    components: [
      { id: "c1", kind: "chip", ref, board: "bb1", anchor },
      ...parts,
    ],
    wires: wires.map((w, i) => ({ id: `w${i + 1}`, color: "red", ...w })),
  };
}

/** A resistor standing on its two free ends: pin 1 in `anchor`, pin 2 `end`
    away from it. The form a lead has to be in to bend at all. */
const resistor = (id, anchor, end, board = "bb1") => ({
  id,
  kind: "discrete",
  ref: "resistor",
  board,
  anchor,
  params: { rot: 90, end, ohms: 220 },
});

const ridingOf = (doc) => wiresRidingPart(doc, "c1");

test("partNodeKeys: a DIP owns both halves of every column it spans", () => {
  const keys = partNodeKeys(scene({}), {
    ref: "74LS00",
    board: "bb1",
    anchor: "e5",
  });
  // Pins in rows e and f, columns 5–11 → 7 lower + 7 upper nodes.
  assert.equal(keys.size, 14);
  assert.ok(keys.has("bb1|c5L") && keys.has("bb1|c5U"));
  assert.ok(keys.has("bb1|c11L") && keys.has("bb1|c11U"));
  assert.ok(!keys.has("bb1|c4L"), "the column before it is not the chip's");
  assert.ok(!keys.has("bb1|c12U"), "and neither is the one after");
});

test("partNodeKeys: keys are per BOARD, since two boards share node ids", () => {
  const doc = {
    boards: [FULL, HALF],
    components: [],
    wires: [],
  };
  const here = partNodeKeys(doc, { ref: "74LS00", board: "bb1", anchor: "e5" });
  const there = partNodeKeys(doc, {
    ref: "74LS00",
    board: "bb2",
    anchor: "e5",
  });
  assert.ok(here.has("bb1|c5L") && !here.has("bb2|c5L"));
  assert.ok(there.has("bb2|c5L") && !there.has("bb1|c5L"));
});

test("riding is a NODE rule: same column-half as a pin, either side of the trench", () => {
  const doc = scene({
    wires: [
      { from: "bb1.a5", to: "bb1.a40" }, // w1 — under pin 1, rides by `from`
      { from: "bb1.j11", to: "bb1.j40" }, // w2 — above pin 8, rides by `from`
      { from: "bb1.a4", to: "bb1.a41" }, // w3 — one column short: no
      { from: "bb1.a12", to: "bb1.a42" }, // w4 — one column past: no
    ],
  });
  assert.deepEqual(ridingOf(doc), [
    { wireId: "w1", ends: ["from"] },
    { wireId: "w2", ends: ["from"] },
  ]);
});

test("riding is a NODE rule, NOT a column rule — a skipped column is not the part's", () => {
  // A push button's footprint is offsets [0, 2]: at a5 it seats a5 and a7, so
  // c6L is a column it merely spans and has no pin in.
  const doc = scene({
    ref: "sw-push",
    anchor: "a5",
    wires: [
      { from: "bb1.b5", to: "bb1.b40" }, // w1 — c5L, a real pin node
      { from: "bb1.b6", to: "bb1.b41" }, // w2 — c6L, spanned but unconnected
      { from: "bb1.b7", to: "bb1.b42" }, // w3 — c7L, a real pin node
    ],
  });
  assert.deepEqual(ridingOf(doc), [
    { wireId: "w1", ends: ["from"] },
    { wireId: "w3", ends: ["from"] },
  ]);
});

test("a jumper between two of the part's OWN nodes rides by both ends", () => {
  const doc = scene({ wires: [{ from: "bb1.a5", to: "bb1.d9" }] });
  assert.deepEqual(ridingOf(doc), [{ wireId: "w1", ends: ["from", "to"] }]);
});

test("a RAIL end never rides — a rail is one node for its whole length", () => {
  // The far end is on a power rail, which is electrically one node from hole 1
  // to hole 50. Counting that as "the part's node" would pick up every wire on
  // the board's power distribution.
  const doc = scene({
    boards: [FULL, RAIL],
    wires: [{ from: "bb1.a5", to: "bb4.+1" }],
  });
  assert.deepEqual(ridingOf(doc), [{ wireId: "w1", ends: ["from"] }]);
});

test("a floating lead owns no node, so nothing rides it", () => {
  // A resistor turned 90° with its bent lead over bare desk: pin 1 seats, pin 2
  // resolves to nothing.
  const doc = {
    boards: [FULL],
    components: [
      {
        id: "c1",
        kind: "discrete",
        ref: "resistor",
        board: "bb1",
        anchor: "a5",
        params: { rot: 90, end: { dx: 0, dy: 40 } },
      },
    ],
    wires: [{ id: "w1", from: "bb1.b5", to: "bb1.b40", color: "red" }],
  };
  const keys = partNodeKeys(doc, doc.components[0]);
  assert.deepEqual([...keys], ["bb1|c5L"], "only the seated lead owns a node");
  assert.deepEqual(ridingOf(doc), [{ wireId: "w1", ends: ["from"] }]);
});

// ── planPartMove ────────────────────────────────────────────────────────────

test("a riding end keeps its ROW and its column offset", () => {
  const doc = scene({
    wires: [
      { from: "bb1.a5", to: "bb1.a40" },
      { from: "bb1.j11", to: "bb1.j40" },
    ],
  });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb1",
    anchor: "e3", // two columns left
  });
  assert.equal(plan.resolved, true);
  assert.deepEqual(plan.moves, [
    { id: "w1", from: "bb1.a3", to: "bb1.a40" },
    { id: "w2", from: "bb1.j9", to: "bb1.j40" },
  ]);
  assert.deepEqual(plan.points, [], "no routed wires here");
});

test("THE INVARIANT: a riding destination is never a hole this part's pins want", () => {
  // Why the two legality checks compose instead of interfering. A rigid column
  // shift preserves each hole's row, and a riding end is by construction in a
  // NON-pin row at its column offset (the pin's own hole is taken — one hole,
  // one lead). Swept over every shift that keeps the chip on the board, with a
  // rider in every non-pin row of the chip's first and last columns.
  const rows = ["a", "b", "c", "d", "g", "h", "i", "j"];
  const wires = rows.flatMap((r) => [
    { from: `bb1.${r}5`, to: `bb1.${r}40` },
    { from: `bb1.${r}11`, to: `bb1.${r}41` },
  ]);
  const doc = scene({ wires });
  const riding = ridingOf(doc);
  assert.equal(riding.length, 16, "every non-pin row of both end columns");

  for (let dcol = -4; dcol <= 4; dcol++) {
    const plan = planPartMove(doc, {
      id: "c1",
      riding,
      board: "bb1",
      anchor: `e${5 + dcol}`,
    });
    assert.equal(plan.resolved, true, `dcol ${dcol}`);
    // The chip's pin holes at the new seat…
    const pins = new Set();
    for (let c = 5 + dcol; c <= 11 + dcol; c++) pins.add(`bb1.e${c}`);
    for (let c = 5 + dcol; c <= 11 + dcol; c++) pins.add(`bb1.f${c}`);
    // …share nothing with where the riders land.
    for (const move of plan.moves) {
      assert.ok(!pins.has(move.from), `${move.from} at dcol ${dcol}`);
      assert.ok(!pins.has(move.to), `${move.to} at dcol ${dcol}`);
    }
  }
});

test("a pure ROW move within one column-half re-addresses no wire", () => {
  // A push button slid from row a to row c keeps every pin on the same node, so
  // its riders are already exactly where they belong. The plan still NAMES each
  // of them — restating the address it is staying in, which is what tells a
  // batch check the hole is spoken for — it just doesn't move any of them.
  const doc = scene({
    ref: "sw-push",
    anchor: "a5",
    wires: [{ from: "bb1.b5", to: "bb1.b40" }],
  });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb1",
    anchor: "c5",
  });
  assert.equal(plan.resolved, true);
  assert.deepEqual(
    plan.moves,
    [{ id: "w1", from: "bb1.b5", to: "bb1.b40" }],
    "named, and exactly where it was",
  );
});

test("re-seating ACROSS THE TRENCH takes the wiring over, keeping the SPACING", () => {
  // Rows a and g are the same column, opposite halves — separate nodes. A rider
  // that only kept its row would be stranded in the half its pin had just left,
  // so it travels by the pin's own row delta instead: the wire is one hole from
  // the part before and one hole from it after, wherever the part lands.
  const doc = scene({
    ref: "sw-push",
    anchor: "a5",
    wires: [{ from: "bb1.b5", to: "bb1.b40" }],
  });
  for (const [anchor, landed] of [
    ["f5", "g5"],
    ["g5", "h5"],
    ["h5", "i5"],
    ["i5", "j5"],
  ]) {
    const plan = planPartMove(doc, {
      id: "c1",
      riding: ridingOf(doc),
      board: "bb1",
      anchor,
    });
    assert.equal(plan.resolved, true, anchor);
    assert.deepEqual(
      plan.moves,
      [{ id: "w1", from: `bb1.${landed}`, to: "bb1.b40" }],
      `${anchor}: the near end crossed, the far end did not`,
    );
  }
});

test("…and it never MIRRORS — the wiring keeps the side of the part it was on", () => {
  // Two riders straddling the part: one row below it, one row above. Reflecting
  // them across the trench would swap which side of the part each ends up on;
  // travelling with it keeps the arrangement the user built.
  const doc = scene({
    ref: "sw-push",
    anchor: "c5", // pins c5 and c7, so b and d are its neighbours
    wires: [
      { from: "bb1.b5", to: "bb1.b40" }, // one row toward the bottom edge
      { from: "bb1.d7", to: "bb1.d40" }, // one row toward the trench
    ],
  });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb1",
    anchor: "h8", // three columns right and over the trench
  });
  assert.equal(plan.resolved, true);
  // c → h is +5 rows, so b → g and d → i: still one either side, same order.
  assert.deepEqual(plan.moves, [
    { id: "w1", from: "bb1.g8", to: "bb1.b40" },
    { id: "w2", from: "bb1.i10", to: "bb1.d40" },
  ]);
});

test("…and it refuses rather than squash the arrangement to make it fit", () => {
  // Row a to row j is nine rows, so a rider in b would need a tenth that isn't
  // there. Refusing says so; landing it anywhere free would quietly rearrange
  // the circuit the user is trying to carry intact. One row nearer the trench
  // fits, which is the fix and is what the red is telling them.
  const doc = scene({
    ref: "sw-push",
    anchor: "a5",
    wires: [{ from: "bb1.b5", to: "bb1.b40" }],
  });
  const off = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb1",
    anchor: "j5",
  });
  assert.equal(off.resolved, false);
});

test("a WITHIN-half move still leaves every rider exactly where it is", () => {
  // The mirror is reached only when the pin actually changes half: its own row
  // is tried first, and while that still lands in the pin's node it wins.
  const doc = scene({
    ref: "sw-push",
    anchor: "a5",
    wires: [{ from: "bb1.b5", to: "bb1.b40" }],
  });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb1",
    anchor: "d5",
  });
  assert.deepEqual(plan.moves, [{ id: "w1", from: "bb1.b5", to: "bb1.b40" }]);
});

test("a riding end shifted off the end of the strip refuses the whole plan", () => {
  // A full board's last column is 63. A rider is always somewhere inside the
  // part's own span, so on ONE board it runs out of strip exactly when the part
  // does — which is the honest reason both refusals arrive together.
  const doc = scene({
    anchor: "e57", // spans columns 57–63
    wires: [{ from: "bb1.a63", to: "bb1.a40" }],
  });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb1",
    anchor: "e58", // the rider would need column 64
  });
  assert.equal(plan.resolved, false);
  assert.deepEqual(plan.moves, []);
});

test("CROSS-BOARD: a rider re-addresses onto the target strip, narrower or not", () => {
  const doc = scene({
    boards: [FULL, HALF],
    anchor: "e50",
    wires: [{ from: "bb1.a52", to: "bb1.a20" }],
  });
  // Column 52 exists on a full board and not on a half one — the trip has to be
  // judged by where it LANDS, which is what holeAlongTo's second type is for.
  const plan = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb2",
    anchor: "e3",
  });
  assert.equal(plan.resolved, true);
  assert.deepEqual(plan.moves, [{ id: "w1", from: "bb2.a5", to: "bb1.a20" }]);
});

test("CROSS-BOARD: a strip too narrow to hold the riders refuses", () => {
  const doc = scene({
    boards: [FULL, TINY],
    wires: [{ from: "bb1.a11", to: "bb1.a40" }],
  });
  // A tiny board has 17 columns; a DIP-14 at e5 needs the rider at column 11
  // plus the seat's own shift.
  const plan = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb3",
    anchor: "e12",
  });
  assert.equal(plan.resolved, false, "column 18 is off a tiny board");
});

test("a routed rider translates its waypoints only when BOTH ends ride", () => {
  const doc = scene({
    wires: [
      // Both ends inside the chip's nodes — rigid, so the bend comes too.
      {
        from: "bb1.a5",
        to: "bb1.d9",
        layout: "routed",
        points: [{ x: 10, y: 20 }],
      },
      // One end pinned outside — the user's bend stays where they put it.
      {
        from: "bb1.b5",
        to: "bb1.b40",
        layout: "routed",
        points: [{ x: 30, y: 40 }],
      },
    ],
  });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: ridingOf(doc),
    board: "bb1",
    anchor: "e7", // +2 columns, so +2 world units in x
  });
  assert.equal(plan.resolved, true);
  assert.deepEqual(plan.points, [{ id: "w1", dx: 2, dy: 0 }]);
});

test("a frozen riding set naming a wire since deleted refuses rather than skips", () => {
  const doc = scene({ wires: [{ from: "bb1.a5", to: "bb1.a40" }] });
  const riding = ridingOf(doc);
  doc.wires = [];
  const plan = planPartMove(doc, {
    id: "c1",
    riding,
    board: "bb1",
    anchor: "e7",
  });
  assert.equal(plan.resolved, false);
});

test("an empty riding set plans trivially — Option over an unwired part", () => {
  const doc = scene({});
  const plan = planPartMove(doc, {
    id: "c1",
    riding: [],
    board: "bb1",
    anchor: "e9",
  });
  assert.deepEqual(plan, { moves: [], points: [], parts: [], resolved: true });
});

// ── Riding PARTS: a two-terminal lead is in a node like anything else ───────

test("a resistor with a LEG in one of the part's nodes rides it", () => {
  // The bench case: a resistor plugged into the same column-half as a pin is
  // connected to it exactly as a jumper in the next hole along is.
  const doc = scene({
    parts: [resistor("c2", "a7", { dx: 13, dy: 0 })], // a7 (c7L) … a20 (c20L)
  });
  assert.deepEqual(partsRidingPart(doc, "c1"), [
    { id: "c2", pins: [{ pin: 1, memberId: "c1" }] },
  ]);
});

test("only a ROTATABLE part rides — a DIP's pins are not leads", () => {
  const doc = scene({
    parts: [
      { id: "c2", kind: "chip", ref: "74LS00", board: "bb1", anchor: "e7" },
      {
        id: "c3",
        kind: "discrete",
        ref: "sw-push",
        board: "bb1",
        anchor: "a7",
      },
    ],
  });
  assert.deepEqual(partsRidingPart(doc, "c1"), []);
});

test("a resistor bridging TWO of the part's nodes rides by both legs", () => {
  // a7 is in c7L and j7 in c7U — both halves of a column the chip spans.
  const doc = scene({ parts: [resistor("c2", "a7", { dx: 0, dy: -11 })] });
  assert.deepEqual(partsRidingPart(doc, "c1"), [
    {
      id: "c2",
      pins: [
        { pin: 1, memberId: "c1" },
        { pin: 2, memberId: "c1" },
      ],
    },
  ]);
});

test("ONE leg riding BENDS the part — the other stays exactly where it is", () => {
  const doc = scene({ parts: [resistor("c2", "a7", { dx: 13, dy: 0 })] });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: [],
    ridingParts: partsRidingPart(doc, "c1"),
    board: "bb1",
    anchor: "e8", // three columns right
  });
  assert.equal(plan.resolved, true);
  assert.equal(plan.parts.length, 1);
  const [seat] = plan.parts;
  assert.equal(seat.anchor, "a10", "the connected leg followed the pin");
  assert.equal(seat.params.rot, 90);
  // Pin 2 was at a20 and has not moved: the bend is now three shorter.
  assert.deepEqual(seat.params.end, { dx: 10, dy: 0 });
});

test("BOTH legs riding TRANSLATES it — same form, same bend", () => {
  const doc = scene({ parts: [resistor("c2", "a7", { dx: 0, dy: -11 })] });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: [],
    ridingParts: partsRidingPart(doc, "c1"),
    board: "bb1",
    anchor: "e8",
  });
  assert.equal(plan.resolved, true);
  assert.equal(plan.parts[0].anchor, "a10");
  assert.deepEqual(plan.parts[0].params.end, { dx: 0, dy: -11 }, "untouched");
});

test("a footprint-form part riding by one leg is rewritten so it CAN bend", () => {
  // A rot-0 LED has both legs in adjacent holes of one row. Only one is in the
  // chip's node, so it has to become the two-free-ends form to follow it.
  const doc = scene({
    parts: [
      {
        id: "c2",
        kind: "discrete",
        ref: "led",
        board: "bb1",
        anchor: "a11", // legs a11 (c11L, the chip's) and a12 (c12L, not)
        params: { rot: 0, color: "red" },
      },
    ],
  });
  const plan = planPartMove(doc, {
    id: "c1",
    riding: [],
    ridingParts: partsRidingPart(doc, "c1"),
    board: "bb1",
    anchor: "e7", // two columns right
  });
  assert.equal(plan.resolved, true);
  const [seat] = plan.parts;
  assert.equal(seat.anchor, "a13", "the connected leg moved with the pin");
  assert.equal(seat.params.rot, 90, "and the LED stood up to reach back");
  assert.deepEqual(seat.params.end, { dx: -1, dy: 0 }, "a12 is where it was");
});

test("a bend the part can't physically make is the BATCH's refusal, not the plan's", () => {
  // A plan is not a legality verdict. Squeezing a resistor's legs to one column
  // apart is a perfectly well-defined answer to "where does this leg go" — it
  // is `canPlacePart`'s minimum-span rule that says the body won't fit, and it
  // says so through the prepared batch check like every other refusal.
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: "bb1",
    anchor: "a11", // the chip's last column…
    params: { rot: 90, end: { dx: 3, dy: 0 }, ohms: 220 },
  }); // …and a14, three clear of it

  const ridingParts = doc.partsRidingPart("c1");
  assert.equal(ridingParts.length, 1);
  const check = doc.prepareClusterMove({ componentIds: ["c1", "c2"] });

  const ok = doc.planPartMove("c1", {
    board: "bb1",
    anchor: "e6",
    ridingParts,
  });
  assert.equal(ok.resolved, true);
  assert.deepEqual(ok.parts[0].params.end, { dx: 2, dy: 0 }, "still 2 apart");
  assert.equal(
    check([{ id: "c1", board: "bb1", anchor: "e6" }, ...ok.parts], []),
    false,
    "and 2 is already under the quarter-watt body's 2.5",
  );

  const fine = doc.planPartMove("c1", {
    board: "bb1",
    anchor: "e4",
    ridingParts,
  });
  assert.deepEqual(fine.parts[0].params.end, { dx: 4, dy: 0 }, "the other way");
  assert.equal(
    check([{ id: "c1", board: "bb1", anchor: "e4" }, ...fine.parts], []),
    true,
  );
});

// ── Against the real document: occupancy and the netlist ────────────────────

/**
 * A full board, a 74LS00 at e5, and one rider in every non-pin row of the chip's
 * columns 5–8 — the shape the batch check has to survive. Each rider ends in its
 * OWN far column (40–47): a column-half is one 5-hole node, so parking every far
 * end in column 40 would short them all into a single net and make the
 * wiring-preserved assertion below prove nothing.
 */
function wiredDoc() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0); // bb1
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  const rows = ["a", "b", "c", "d", "g", "h", "i", "j"];
  rows.forEach((row, i) => {
    doc.addWire({
      from: `bb1.${row}${5 + (i % 4)}`,
      to: `bb1.${row}${40 + i}`,
    });
  });
  return doc;
}

test("the riding set may shuffle among the holes it collectively vacates", () => {
  // A two-column shift lands riders on holes other riders are leaving. That is
  // legal only because prepareWireBatchMove lifts every mover out first — the
  // exact reason a per-wire isFreeHole check would have been wrong.
  const doc = wiredDoc();
  const riding = doc.wiresRidingPart("c1");
  assert.equal(riding.length, 8);

  const plan = doc.planPartMove("c1", { board: "bb1", anchor: "e7", riding });
  assert.equal(plan.resolved, true);
  assert.equal(plan.moves.length, 8);
  assert.equal(
    doc.prepareWireBatchMove(riding.map((r) => r.wireId))(plan.moves),
    true,
  );
});

test("a rider's destination held by a NON-moving lead refuses the batch", () => {
  // The blocker has to sit OUTSIDE the part's current nodes, or it would ride
  // too and vacate the hole itself. So: a rider in the chip's LAST column (11)
  // shifted +2, landing on column 13 — which the chip does not reach yet.
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({ kind: "chip", ref: "74LS00", board: "bb1", anchor: "e5" });
  doc.addWire({ from: "bb1.a11", to: "bb1.a40" }); // rides
  doc.addWire({ from: "bb1.a13", to: "bb1.a41" }); // does not — and is in the way

  const riding = doc.wiresRidingPart("c1");
  assert.deepEqual(riding, [{ wireId: "w1", ends: ["from"] }]);
  const plan = doc.planPartMove("c1", { board: "bb1", anchor: "e7", riding });
  assert.equal(plan.resolved, true, "the plan resolves — the holes all exist");
  assert.equal(
    doc.prepareWireBatchMove(riding.map((r) => r.wireId))(plan.moves),
    false,
    "but occupancy refuses it",
  );
});

/**
 * Which of c1's pins each wire REACHES, keyed by that wire's far end — the one
 * address in the fixture that never moves, and so the only stable label for
 * "this connection". Net ids are derived from their member addresses, so they
 * legitimately renumber when holes move; and a net lists every hole of a
 * column-half, not just the wired ones, so the holes cannot label it either.
 */
function wiringOf(doc) {
  const json = doc.toJSON();
  const netlist = buildNetlist(json);
  const pinsOfNet = new Map();
  for (const net of netlist.nets.values()) {
    pinsOfNet.set(
      net.id,
      net.pins
        .filter((p) => p.componentId === "c1")
        .map((p) => p.pin)
        .sort((a, b) => a - b),
    );
  }
  const out = {};
  for (const wire of json.wires) {
    const far = /^bb1\.[a-j]4[0-7]$/.test(wire.to) ? wire.to : wire.from;
    out[far] = pinsOfNet.get(netlist.netOfPoint.get(far)) ?? [];
  }
  return out;
}

test("THE POINT OF THE FEATURE: the wiring after the move is the wiring before", () => {
  const doc = wiredDoc();
  const before = wiringOf(doc);
  // Sanity: the fixture really does wire the chip on both sides of the trench.
  assert.deepEqual(before["bb1.a40"], [1], "the rider under pin 1");
  assert.deepEqual(before["bb1.g44"], [14], "and the one above pin 14");

  const riding = doc.wiresRidingPart("c1");
  const plan = doc.planPartMove("c1", { board: "bb1", anchor: "e3", riding });
  doc.moveComponentWithWires("c1", "bb1", "e3", plan);

  assert.deepEqual(wiringOf(doc), before);
});

test("a PLAIN move of the same chip rewires it — what this feature is for", () => {
  const doc = wiredDoc();
  const before = wiringOf(doc);
  doc.moveComponent("c1", "bb1", "e3");
  const after = wiringOf(doc);
  assert.notDeepEqual(
    after,
    before,
    "wires left behind repartition the circuit",
  );
  // Two columns left, and the wire that fed pin 1 now feeds pin 3 — a working
  // circuit quietly computing something else, which is the whole motivation.
  assert.deepEqual(before["bb1.a40"], [1]);
  assert.deepEqual(after["bb1.a40"], [3]);
});
