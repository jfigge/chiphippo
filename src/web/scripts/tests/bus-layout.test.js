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

// Bus layout geometry (Feature 130): the run-mode and pin-tap address plans.

import test from "node:test";
import assert from "node:assert/strict";

import { DeskDoc, parseBusName } from "../model/desk-doc.js";
import { busRunAddresses, busTapAddresses } from "../model/bus-layout.js";
import { holeAlong, nodeOf, parseAddress } from "../model/breadboard.js";
import { partPinAddresses } from "../model/occupancy.js";
import { pinGroupContaining } from "../catalog/index.js";

test("holeAlong marches a grid row and a rail, off-strip → null", () => {
  assert.equal(holeAlong("pins-full", "a1", 3), "a4");
  assert.equal(holeAlong("pins-full", "j5", -2), "j3");
  assert.equal(holeAlong("pins-full", "a63", 1), null); // past the last column
  assert.equal(holeAlong("pins-full", "a1", -1), null); // before the first
  assert.equal(holeAlong("rail-full", "+1", 4), "+5");
  assert.equal(holeAlong("pins-full", "zz", 1), null); // malformed
});

test("busRunAddresses lays width pairs down two aligned runs", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb2 = pins-full
  const pairs = busRunAddresses(doc.boards, "bb2.a1", "bb2.j1", 4);
  assert.deepEqual(pairs, [
    { from: "bb2.a1", to: "bb2.j1" },
    { from: "bb2.a2", to: "bb2.j2" },
    { from: "bb2.a3", to: "bb2.j3" },
    { from: "bb2.a4", to: "bb2.j4" },
  ]);
});

test("busRunAddresses fails when a run walks off its strip", () => {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0);
  assert.equal(busRunAddresses(doc.boards, "bb2.a62", "bb2.j62", 4), null);
  assert.equal(busRunAddresses(doc.boards, "bb9.a1", "bb2.j1", 4), null);
});

/** A full kit with a 74LS573 (octal latch) seated on the pin-board. */
function docWithLatch() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb2 = pins-full
  const comp = doc.addComponent({
    kind: "chip",
    ref: "74LS573",
    board: "bb2",
    anchor: "e5",
  });
  return { doc, comp };
}

test("busTapAddresses fans a bus onto a chip's D group in bit order", () => {
  const { doc, comp } = docWithLatch();
  const group = pinGroupContaining("74LS573", 2); // the D group
  const { bits } = parseBusName("D[7:0]");
  const raw = doc.toJSON();
  const isFree = (a) => doc.isHoleFree(a);
  const pairs = busTapAddresses(raw, "bb2.j40", comp, group, bits, isFree);
  assert.equal(pairs.length, 8);

  // Source holes march j40, j41, … in member order.
  pairs.forEach((p, i) => assert.equal(p.from, `bb2.j${40 + i}`));

  // Every destination is a real, free, distinct hole in the SAME electrical
  // node as the pin carrying that member's bit — i.e. wired "to the right pin".
  const pinAddr = new Map(
    partPinAddresses(raw, comp).map((p) => [p.pin, p.address]),
  );
  const seen = new Set();
  pairs.forEach((p, i) => {
    assert.ok(!seen.has(p.to), "distinct tap holes");
    seen.add(p.to);
    assert.ok(isFree(p.to), "tap hole is free");
    const pin = group.pins[bits[i]]; // bit bits[i] → its group pin
    const pinHole = parseAddress(pinAddr.get(pin));
    const tapHole = parseAddress(p.to);
    assert.equal(tapHole.boardId, pinHole.boardId);
    assert.equal(
      nodeOf("pins-full", tapHole.hole),
      nodeOf("pins-full", pinHole.hole),
      `member ${i} taps pin ${pin}'s node`,
    );
    assert.notEqual(p.to, pinAddr.get(pin)); // never the pin's own hole
  });
});

test("busTapAddresses refuses a width that doesn't match the group", () => {
  const { doc, comp } = docWithLatch();
  const group = pinGroupContaining("74LS573", 2);
  const { bits } = parseBusName("D[3:0]"); // width 4 ≠ group width 8
  const raw = doc.toJSON();
  assert.equal(
    busTapAddresses(raw, "bb2.j40", comp, group, bits, () => true),
    null,
  );
});

test("busTapAddresses fails when the source run walks off its strip", () => {
  const { doc, comp } = docWithLatch();
  const group = pinGroupContaining("74LS573", 2);
  const { bits } = parseBusName("D[7:0]");
  const raw = doc.toJSON();
  const isFree = (a) => doc.isHoleFree(a);
  assert.equal(
    busTapAddresses(raw, "bb2.j60", comp, group, bits, isFree),
    null, // j60..j67 runs past column 63
  );
});
