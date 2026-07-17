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

// Tests for the pure breadboard model (model/breadboard.js + board-types.js).

import test from "node:test";
import assert from "node:assert/strict";

import { BOARD_TYPES, BOARD_TYPE_KEYS } from "../model/board-types.js";
import {
  HOLE_HIT_RADIUS,
  formatAddress,
  holeAt,
  holePosition,
  holes,
  holesOfNode,
  nodeOf,
  parseAddress,
  parseHole,
  spec,
} from "../model/breadboard.js";

// ── Tie-point counts (the roadmap's locked numbers) ──────────────────────────

test("tie-point counts are exactly 830 / 400 / 170", () => {
  assert.equal(holes("full").length, 830);
  assert.equal(holes("half").length, 400);
  assert.equal(holes("tiny").length, 170);
});

test("every type's derived count matches its declared tiePoints, no dupes", () => {
  for (const key of BOARD_TYPE_KEYS) {
    const all = holes(key);
    assert.equal(all.length, BOARD_TYPES[key].tiePoints, key);
    assert.equal(new Set(all).size, all.length, `${key} has duplicate holes`);
  }
});

test("spec throws INVALID_TYPE on junk", () => {
  assert.throws(() => spec("mega"), { code: "INVALID_TYPE" });
  assert.throws(() => spec(undefined), { code: "INVALID_TYPE" });
});

// ── Node grouping (strips, rails, trench) ────────────────────────────────────

test("a1..e1 share one node; f1 is across the trench", () => {
  const lower = ["a1", "b1", "c1", "d1", "e1"].map((h) => nodeOf("full", h));
  assert.deepEqual(new Set(lower).size, 1);
  assert.equal(lower[0], "c1L");
  assert.equal(nodeOf("full", "f1"), "c1U");
  assert.notEqual(nodeOf("full", "e1"), nodeOf("full", "f1"));
});

test("adjacent columns are separate nodes", () => {
  assert.notEqual(nodeOf("tiny", "a1"), nodeOf("tiny", "a2"));
});

test("rails are continuous end-to-end (one node, no mid-board split)", () => {
  assert.equal(nodeOf("full", "t+1"), "t+");
  assert.equal(nodeOf("full", "t+50"), "t+");
  assert.equal(nodeOf("half", "b-25"), "b-");
  assert.equal(holesOfNode("full", "t+").length, 50);
  assert.equal(holesOfNode("half", "t-").length, 25);
});

test("holesOfNode inverts nodeOf for every hole of every type", () => {
  for (const key of BOARD_TYPE_KEYS) {
    for (const hole of holes(key)) {
      const node = nodeOf(key, hole);
      const members = holesOfNode(key, node);
      assert.ok(members.includes(hole), `${key} ${hole} ∉ ${node}`);
      // A strip is exactly its 5 rows; a rail all its holes.
      const expected = /^c/.test(node) ? 5 : spec(key).railHoles;
      assert.equal(members.length, expected, `${key} ${node}`);
    }
  }
});

test("holesOfNode rejects nodes that don't exist on the type", () => {
  assert.equal(holesOfNode("tiny", "t+"), null); // Tiny has no rails
  assert.equal(holesOfNode("tiny", "c18L"), null); // beyond 17 columns
  assert.equal(holesOfNode("full", "c64U"), null);
  assert.equal(holesOfNode("full", "x1"), null);
});

// ── Positions & hit testing ──────────────────────────────────────────────────

test("holePosition ⇄ holeAt round-trips for every hole of every type", () => {
  for (const key of BOARD_TYPE_KEYS) {
    for (const hole of holes(key)) {
      const pos = holePosition(key, hole);
      assert.ok(pos, `${key} ${hole} has no position`);
      assert.equal(holeAt(key, pos.x, pos.y), hole, `${key} ${hole}`);
    }
  }
});

test("every hole lies at integer offsets inside the outline", () => {
  for (const key of BOARD_TYPE_KEYS) {
    const s = spec(key);
    for (const hole of holes(key)) {
      const { x, y } = holePosition(key, hole);
      assert.ok(Number.isInteger(x) && Number.isInteger(y), `${key} ${hole}`);
      assert.ok(x > 0 && x < s.width, `${key} ${hole} x=${x}`);
      assert.ok(y > 0 && y < s.height, `${key} ${hole} y=${y}`);
    }
  }
});

test("holeAt is forgiving within the hit radius", () => {
  const pos = holePosition("full", "f12");
  // 0.3/0.2 off → dist ≈ 0.36 < 0.45 still hits.
  assert.equal(holeAt("full", pos.x + 0.3, pos.y - 0.2), "f12");
});

test("holeAt has a dead zone between holes and misses the trench", () => {
  const a5 = holePosition("full", "a5");
  // Midpoint between a5 and a6 is 0.5 from both — beyond the radius.
  assert.equal(holeAt("full", a5.x + 0.5, a5.y), null);
  // The trench center is 1.5 from both f and e rows.
  const f5 = holePosition("full", "f5");
  assert.equal(holeAt("full", f5.x, f5.y + 1.5), null);
  // Way outside the board.
  assert.equal(holeAt("full", -10, -10), null);
  assert.ok(HOLE_HIT_RADIUS < 0.5, "radius must leave a dead zone");
});

test("rail groups: one extra pitch of gap every 5 holes", () => {
  const x = (h) => holePosition("full", h).x;
  assert.equal(x("t+2") - x("t+1"), 1);
  assert.equal(x("t+5") - x("t+4"), 1);
  assert.equal(x("t+6") - x("t+5"), 2); // group boundary
  assert.equal(x("t+50") - x("t+1"), 58); // 49 steps + 9 group gaps
});

test("holeAt resolves rail holes on both sides of a group gap", () => {
  const t5 = holePosition("half", "t+5");
  const t6 = holePosition("half", "t+6");
  assert.equal(holeAt("half", t5.x + 0.3, t5.y), "t+5");
  assert.equal(holeAt("half", t6.x - 0.3, t6.y), "t+6");
  // Dead center of the 2-unit gap is 1.0 from both — no hit.
  assert.equal(holeAt("half", (t5.x + t6.x) / 2, t5.y), null);
});

// ── parseHole ────────────────────────────────────────────────────────────────

test("parseHole validates against the type", () => {
  assert.deepEqual(parseHole("full", "j63"), {
    kind: "grid",
    row: "j",
    col: 63,
  });
  assert.deepEqual(parseHole("full", "t-7"), {
    kind: "rail",
    railId: "t-",
    index: 7,
  });
  assert.equal(parseHole("full", "j64"), null); // beyond 63 columns
  assert.equal(parseHole("half", "a31"), null);
  assert.equal(parseHole("tiny", "t+1"), null); // Tiny has no rails
  assert.equal(parseHole("full", "t+51"), null);
  assert.equal(parseHole("full", "k1"), null); // no row k
  assert.equal(parseHole("full", "a0"), null);
  assert.equal(parseHole("full", 42), null);
});

// ── Addresses ────────────────────────────────────────────────────────────────

test("formatAddress/parseAddress round-trip", () => {
  for (const [boardId, hole] of [
    ["bb1", "f12"],
    ["bb2", "t+7"],
    ["bb17", "b-25"],
  ]) {
    const addr = formatAddress(boardId, hole);
    assert.deepEqual(parseAddress(addr), { boardId, hole });
  }
});

test("parseAddress rejects malformed addresses", () => {
  assert.equal(parseAddress("bb1"), null); // no dot
  assert.equal(parseAddress(".f12"), null); // empty board id
  assert.equal(parseAddress("bb1."), null); // empty hole
  assert.equal(parseAddress(null), null);
});

test("parseAddress splits at the FIRST dot only", () => {
  // Future owners may never contain dots, but the hole part must survive one.
  assert.deepEqual(parseAddress("bb1.f12"), { boardId: "bb1", hole: "f12" });
});
