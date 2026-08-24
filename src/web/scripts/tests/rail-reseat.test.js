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

// rail-reseat.test.js — the one address the auto-router changes (Feature 360).
//
// The planner's whole claim is "this is the same circuit, drawn shorter", so
// most of what is checked here is the ways that claim could be false: a lead
// that hops to a rail it is not actually connected to, a rail left orphaned
// behind a lead that moved off it, a switch's contact mistaken for a wire, a
// spine link sliding into the middle of the board. Pure: documents built in
// code, no DOM.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc } from "../model/desk-doc.js";
import {
  electricalPartition,
  planRailReseats,
  railLineOf,
  withReseats,
} from "../model/rail-reseat.js";

/** A full 830 kit at the origin: rail, pin-board, rail. */
function bench(y = 0) {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, y);
  const pins = doc.boards.find((b) => b.type === "pins-full");
  const rails = doc.boards.filter((b) => b.type === "rail-full");
  return { doc, pins: pins.id, top: rails[0].id, bottom: rails[1].id };
}

/** Two 830 kits dovetailed into one flush run, the way a bench is built. */
function stack() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  doc.addKit("full", 0, 21.02);
  const rails = doc.boards.filter((b) => b.type === "rail-full").map((b) => b.id); // prettier-ignore
  const pins = doc.boards.filter((b) => b.type === "pins-full").map((b) => b.id); // prettier-ignore
  return { doc, rails, pins };
}

const plan = (doc, opts) => planRailReseats(doc.toJSON(), opts);

test("railLineOf names the LINE, so + and − can never be confused", () => {
  const { doc, pins, top } = bench();
  const json = doc.toJSON();
  assert.equal(railLineOf(json.boards, `${top}.+7`), `${top}.+`);
  assert.equal(railLineOf(json.boards, `${top}.-7`), `${top}.-`);
  assert.equal(railLineOf(json.boards, `${pins}.a7`), null, "a grid hole");
  assert.equal(railLineOf(json.boards, "nope.+7"), null, "no such board");
});

test("a stretched lead slides along its own rail to the nearest free hole", () => {
  const { doc, pins, top } = bench();
  doc.addWire({ from: `${top}.+50`, to: `${pins}.j3` });
  const moves = plan(doc);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].wireId, "w1");
  assert.equal(moves[0].end, "from", "the RAIL end is the one that moves");
  assert.equal(moves[0].from, `${top}.+50`);
  // Rail hole 1 sits at x = 3, directly above the pin-board's column 3 — the
  // hole a bench would reach for.
  assert.equal(moves[0].to, `${top}.+1`);
  assert.ok(moves[0].gain > 40, `saved ${moves[0].gain} pitch`);
});

test("a lead already in the right place is left alone", () => {
  const { doc, pins, top } = bench();
  doc.addWire({ from: `${top}.+1`, to: `${pins}.j3` });
  assert.deepEqual(plan(doc), []);
});

test("a one-hole shuffle is not worth the change to the build guide", () => {
  // `reseatMinGain` in pitch. A move has a cost outside the drawing — an
  // address is what the build guide tells you to plug in — so a gain under it
  // is declined, and the same move IS made once the threshold says so.
  const { doc, pins, top } = bench();
  doc.addWire({ from: `${top}.+2`, to: `${pins}.j3` });
  assert.deepEqual(plan(doc), [], "one hole over is not worth it");
  assert.equal(plan(doc, { minGain: 0.5 })[0].to, `${top}.+1`, "but it IS an improvement"); // prettier-ignore
});

test("the SPINE never moves — both its ends are on rails", () => {
  // A rail-to-rail link is deliberately at the end of the run: it has to cross
  // the pin-board and cannot be routed round. Free to shorten itself it would
  // slide into the middle, straight over the chips.
  const { doc, top, bottom } = bench();
  doc.addWire({ from: `${top}.+50`, to: `${bottom}.+50` });
  assert.deepEqual(plan(doc), []);
});

test("a hole another lead is in is not an open hole", () => {
  const { doc, pins, top } = bench();
  doc.addWire({ from: `${top}.+1`, to: `${pins}.a3` }); // sitting in the good hole
  doc.addWire({ from: `${top}.+50`, to: `${pins}.j3` });
  const moves = plan(doc);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].wireId, "w2");
  assert.equal(moves[0].to, `${top}.+2`, "it took the next one along");
});

test("two leads wanting one hole: the most stretched gets it", () => {
  const { doc, pins, top } = bench();
  doc.addWire({ from: `${top}.+20`, to: `${pins}.j3` }); // 22 pitch out
  doc.addWire({ from: `${top}.+50`, to: `${pins}.i3` }); // 58 pitch out
  const moves = plan(doc);
  assert.equal(moves.length, 2);
  const byWire = new Map(moves.map((m) => [m.wireId, m.to]));
  assert.equal(byWire.get("w2"), `${top}.+1`, "the worse one gets the hole");
  assert.equal(byWire.get("w1"), `${top}.+2`, "and nothing is double-booked");
});

test("across strips: the near rail wins, but only because a bridge says so", () => {
  // The case the feature exists for. A chip on the lower board of a stack takes
  // its supply from the rail at the very top; the near rail is the same NET only
  // because the spine ties them, and that is exactly the fact being relied on.
  const { doc, rails, pins } = stack();
  const far = rails[0];
  const near = rails[2];
  doc.addWire({ from: `${far}.+20`, to: `${near}.+20` }); // the spine
  doc.addWire({ from: `${far}.+21`, to: `${pins[1]}.j21` });
  const moves = plan(doc);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].wireId, "w2");
  assert.ok(
    moves[0].to.startsWith(`${near}.+`),
    `came down to the near rail, not ${moves[0].to}`,
  );
});

test("an unbridged rail is a different net, however near it is", () => {
  const { doc, rails, pins } = stack();
  // No spine this time: the near rail is bare copper that happens to be close.
  doc.addWire({ from: `${rails[0]}.+21`, to: `${pins[1]}.j21` });
  const moves = plan(doc);
  for (const move of moves) {
    assert.ok(
      move.to.startsWith(`${rails[0]}.+`),
      `${move.to} is not on the wire's own net`,
    );
  }
});

test("a move that would orphan a rail is dropped", () => {
  // R1 → a pin, that pin → R2. The two rails are one net ONLY through the wire
  // being considered, so landing it on R2 cuts R1 off — and R1 still has a chip
  // plugged into it. Rule 2 says the target is in the net; rule 3 is what
  // notices that the SOURCE would not be.
  const { doc, rails, pins } = stack();
  const r1 = rails[0];
  const r2 = rails[2];
  doc.addComponent({ kind: "chip", ref: "74LS00", board: pins[0], anchor: "e10" }); // prettier-ignore
  doc.addWire({ from: `${r1}.+40`, to: `${pins[0]}.j10` }); // R1's other lead
  doc.addWire({ from: `${pins[1]}.j21`, to: `${r2}.+21` }); // the pin reaches R2
  const stretched = doc.addWire({ from: `${r1}.+22`, to: `${pins[1]}.i21` });

  const before = electricalPartition(doc.toJSON());
  const moves = plan(doc);
  assert.equal(
    electricalPartition(withReseats(doc.toJSON(), moves)),
    before,
    "whatever it decided, the circuit is the same circuit",
  );
  assert.ok(
    !moves.some((m) => m.wireId === stretched.id && m.to.startsWith(`${r2}.`)),
    "the one move that would have cut R1 loose was not made",
  );
});

test("a switch's contact is not a wire — the partition is WIRING alone", () => {
  // A closed slide switch really does join its two pins, and while it is thrown
  // the two rails either side of it read as one net. A hole chosen on that
  // basis would be wrong the moment the switch moved, so `bridges: false` is
  // what candidacy is judged by.
  const { doc, rails, pins } = stack();
  // A slide switch at a10 puts its common on a11 and, resting, bridges it to
  // a10 — so with contacts conducting the two rails below ARE one net.
  doc.addComponent({ kind: "discrete", ref: "sw-slide", board: pins[0], anchor: "a10" }); // prettier-ignore
  doc.addWire({ from: `${rails[0]}.+40`, to: `${pins[0]}.b10` });
  doc.addWire({ from: `${pins[0]}.b11`, to: `${rails[2]}.+40` });
  const lead = doc.addWire({ from: `${rails[0]}.+22`, to: `${pins[1]}.j21` });
  const move = plan(doc).find((m) => m.wireId === lead.id);
  assert.ok(
    !move || move.to.startsWith(`${rails[0]}.+`),
    `${move?.to} was reached through a switch, not through copper`,
  );
});

test("a bus member's ends belong to its ribbon", () => {
  const { doc, pins, top } = bench();
  const a = doc.addWire({ from: `${top}.+50`, to: `${pins}.j3` });
  const b = doc.addWire({ from: `${top}.+49`, to: `${pins}.j4` });
  doc.addBus("D[1:0]", [a.id, b.id]);
  assert.deepEqual(plan(doc), []);
});

test("`only` narrows it to the selection, and the rest keep their holes", () => {
  const { doc, pins, top } = bench();
  doc.addWire({ from: `${top}.+50`, to: `${pins}.j3` });
  doc.addWire({ from: `${top}.+49`, to: `${pins}.j5` });
  const moves = plan(doc, { only: new Set(["w2"]) });
  assert.equal(moves.length, 1);
  assert.equal(moves[0].wireId, "w2");
});

test("withReseats copies; the document it was given is untouched", () => {
  const { doc, pins, top } = bench();
  doc.addWire({ from: `${top}.+50`, to: `${pins}.j3` });
  const json = doc.toJSON();
  const moves = planRailReseats(json);
  const after = withReseats(json, moves);
  assert.equal(json.wires[0].from, `${top}.+50`, "the input is as it was");
  assert.equal(after.wires[0].from, moves[0].to, "the copy carries the move");
  assert.notEqual(after.wires[0], json.wires[0], "and it is a copy, not an alias"); // prettier-ignore
});

test("the plan is the same plan whatever order the wires arrive in", () => {
  const { doc, pins, top } = bench();
  doc.addWire({ from: `${top}.+20`, to: `${pins}.j3` });
  doc.addWire({ from: `${top}.+50`, to: `${pins}.i3` });
  doc.addWire({ from: `${top}.+48`, to: `${pins}.h9` });
  const json = doc.toJSON();
  const forward = planRailReseats(json);
  const reversed = planRailReseats({
    ...json,
    wires: [...json.wires].reverse(),
  });
  assert.deepEqual(reversed, forward);
  assert.deepEqual(planRailReseats(json), forward, "and twice running");
});
