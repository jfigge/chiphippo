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

// The allocator's job is to make two failures UNREPRESENTABLE rather than
// merely detectable:
//
//   * two parts sharing a column-half — electrically shorted, and silent:
//     canPlacePart checks hole occupancy, not node sharing, and the resulting
//     document simulates perfectly while computing something else;
//   * two leads in one hole — which normalizeDocument drops on load, turning a
//     wire you emitted into a quiet open circuit.

import test from "node:test";
import assert from "node:assert/strict";

import { createAllocator } from "../model/column-allocator.js";
import { nodeOf } from "../model/breadboard.js";

const boards = [
  { id: "bb1", type: "rail-full" },
  { id: "bb2", type: "pins-full" },
  { id: "bb3", type: "rail-full" },
];
const make = () => createAllocator(boards);

test("column runs are exclusive and handed out left to right", () => {
  const a = make();
  assert.equal(a.reserveColumns("bb2", 8), 1);
  assert.equal(a.reserveColumns("bb2", 8), 9, "the next run starts after");
  assert.equal(a.reserveColumns("bb2", 4), 17);
});

test("a run that will not fit is refused, not truncated", () => {
  const a = make();
  assert.equal(a.columns("bb2"), 63);
  assert.equal(a.reserveColumns("bb2", 64), null);
  assert.equal(a.reserveColumns("bb2", 60), 1);
  assert.equal(a.reserveColumns("bb2", 8), null, "only 3 columns left");
  assert.equal(a.reserveColumns("bb2", 3), 61, "but 3 still fit");
});

test("a seated DIP owns BOTH halves of its columns", () => {
  const a = make();
  const seat = a.seat("bb2", "74LS283", "e5", {});
  assert.equal(seat.ok, true);
  // A DIP-16 spans 8 columns from 5, straddling the trench. Nothing may take
  // columns 5-12 in either half afterwards.
  assert.equal(
    a.reserveColumns("bb2", 1, "lower"),
    1,
    "column 1 is still free",
  );
  const next = a.reserveColumns("bb2", 8);
  assert.ok(next >= 13, `next free run starts past the chip, got ${next}`);
});

test("a row-a part blocks its columns' LOWER half — the short that would be silent", () => {
  const a = make();
  const bar = a.seat("bb2", "bar8", "a20", {});
  assert.equal(bar.ok, true);
  // bar8 spans 9 columns from 20. Seating anything else on 20-28 in the lower
  // half would join their pins into one node with no error anywhere.
  const run = a.reserveColumns("bb2", 9, "lower");
  assert.ok(run > 28 || run + 8 < 20, `overlapping run handed out at ${run}`);
});

test("seat refuses a part that runs off the end of its board", () => {
  const a = make();
  const r = a.seat("bb2", "74LS283", "e60", {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /falls off/);
});

test("seat refuses an anchor the footprint cannot take", () => {
  const a = make();
  assert.equal(
    a.seat("bb2", "74LS283", "a5", {}).ok,
    false,
    "a DIP wants row e",
  );
  assert.equal(a.seat("bb2", "nonesuch", "e5", {}).ok, false, "unknown ref");
});

test("seat refuses to double-book a hole", () => {
  const a = make();
  assert.equal(a.seat("bb2", "74LS283", "e5", {}).ok, true);
  const again = a.seat("bb2", "74LS283", "e5", {});
  assert.equal(again.ok, false);
  assert.match(again.reason, /already occupied/);
});

test("freeAt hands out distinct holes on the pin's own node", () => {
  const a = make();
  const seat = a.seat("bb2", "74LS283", "e5", {});
  const hole = seat.holes.get(1); // pin 1 → e5
  const node = nodeOf("pins-full", hole);

  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const addr = a.freeAt("bb2", hole);
    assert.ok(addr, `spare hole ${i + 1} exists`);
    assert.equal(seen.has(addr), false, "never handed out twice");
    seen.add(addr);
    assert.equal(nodeOf("pins-full", addr.split(".")[1]), node, "same node");
    assert.notEqual(addr, `bb2.${hole}`, "never the pin's own hole");
  }
  // A column-half is five holes; the pin holds one, so four spares and no more.
  assert.equal(a.freeAt("bb2", hole), null, "the node is exhausted");
});

test("rails are deep enough to hub any realistic net", () => {
  const a = make();
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const addr = a.freeRail("bb1", "+");
    assert.ok(addr, `rail hole ${i + 1}`);
    assert.equal(seen.has(addr), false);
    seen.add(addr);
  }
  assert.equal(a.freeRail("bb1", "+"), null, "and then it is full");
  assert.ok(a.freeRail("bb1", "-"), "the other polarity is untouched");
});

test("claim is one-shot", () => {
  const a = make();
  assert.equal(a.claim("bb2.a1"), true);
  assert.equal(a.claim("bb2.a1"), false);
  assert.equal(a.isClaimed("bb2.a1"), true);
  assert.equal(a.isClaimed("bb2.a2"), false);
});
