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

import {
  ALL_KIT_KEYS,
  BOARD_TYPES,
  BOARD_TYPE_KEYS,
  BREADBOARD_KITS,
  STRIP_KIT_KEYS,
} from "../model/board-types.js";
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

test("strip tie-point counts are exactly 630 / 300 / 170 / 100 / 50", () => {
  assert.equal(holes("pins-full").length, 630);
  assert.equal(holes("pins-half").length, 300);
  assert.equal(holes("pins-tiny").length, 170);
  assert.equal(holes("rail-full").length, 100);
  assert.equal(holes("rail-half").length, 50);
});

test("assembled kits are exactly 830 / 400 / 170 tie points", () => {
  const kitHoles = (key) =>
    BREADBOARD_KITS[key].strips.reduce((n, s) => n + holes(s.type).length, 0);
  assert.equal(kitHoles("full"), 830);
  assert.equal(kitHoles("half"), 400);
  assert.equal(kitHoles("tiny"), 170);
  // Every kit's declared total agrees with the strips it is built from.
  for (const key of ALL_KIT_KEYS) {
    assert.equal(kitHoles(key), BREADBOARD_KITS[key].tiePoints, key);
  }
});

test("a loose-strip kit is exactly one strip, named for its type", () => {
  for (const key of STRIP_KIT_KEYS) {
    const strips = BREADBOARD_KITS[key].strips;
    assert.equal(strips.length, 1, `${key}: not a single strip`);
    // The kit IS the strip, so the two keys must not drift apart.
    assert.equal(strips[0].type, key, `${key}: kit key names another type`);
    assert.deepEqual({ dx: strips[0].dx, dy: strips[0].dy }, { dx: 0, dy: 0 });
  }
});

test("every type's derived count matches its declared tiePoints, no dupes", () => {
  for (const key of BOARD_TYPE_KEYS) {
    const all = holes(key);
    assert.equal(all.length, BOARD_TYPES[key].tiePoints, key);
    assert.equal(new Set(all).size, all.length, `${key} has duplicate holes`);
  }
});

test("a pin-board has no rails; a rail strip has no grid", () => {
  for (const key of BOARD_TYPE_KEYS) {
    const s = spec(key);
    const pins = s.kind === "pins";
    assert.equal(s.cols > 0, pins, key);
    assert.equal(Boolean(s.trench), pins, key);
    assert.equal(s.rails.length, pins ? 0 : 2, key);
    assert.equal(s.railHoles > 0, !pins, key);
  }
});

test("spec throws INVALID_TYPE on junk", () => {
  assert.throws(() => spec("mega"), { code: "INVALID_TYPE" });
  assert.throws(() => spec("full"), { code: "INVALID_TYPE" }); // a kit, not a strip
  assert.throws(() => spec(undefined), { code: "INVALID_TYPE" });
});

// ── Node grouping (strips, rails, trench) ────────────────────────────────────

test("a1..e1 share one node; f1 is across the trench", () => {
  const lower = ["a1", "b1", "c1", "d1", "e1"].map((h) =>
    nodeOf("pins-full", h),
  );
  assert.deepEqual(new Set(lower).size, 1);
  assert.equal(lower[0], "c1L");
  assert.equal(nodeOf("pins-full", "f1"), "c1U");
  assert.notEqual(nodeOf("pins-full", "e1"), nodeOf("pins-full", "f1"));
});

test("adjacent columns are separate nodes", () => {
  assert.notEqual(nodeOf("pins-tiny", "a1"), nodeOf("pins-tiny", "a2"));
});

test("rails are continuous end-to-end (one node, no mid-strip split)", () => {
  assert.equal(nodeOf("rail-full", "+1"), "+");
  assert.equal(nodeOf("rail-full", "+50"), "+");
  assert.equal(nodeOf("rail-half", "-25"), "-");
  assert.notEqual(nodeOf("rail-full", "+1"), nodeOf("rail-full", "-1"));
  assert.equal(holesOfNode("rail-full", "+").length, 50);
  assert.equal(holesOfNode("rail-half", "-").length, 25);
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
  assert.equal(holesOfNode("pins-tiny", "+"), null); // a pin-board has no rails
  assert.equal(holesOfNode("rail-full", "c1L"), null); // a rail strip has no grid
  assert.equal(holesOfNode("pins-tiny", "c18L"), null); // beyond 17 columns
  assert.equal(holesOfNode("pins-full", "c64U"), null);
  assert.equal(holesOfNode("pins-full", "x1"), null);
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
  const pos = holePosition("pins-full", "f12");
  // 0.3/0.2 off → dist ≈ 0.36 < 0.45 still hits.
  assert.equal(holeAt("pins-full", pos.x + 0.3, pos.y - 0.2), "f12");
});

test("holeAt has a dead zone between holes and misses the trench", () => {
  const a5 = holePosition("pins-full", "a5");
  // Midpoint between a5 and a6 is 0.5 from both — beyond the radius.
  assert.equal(holeAt("pins-full", a5.x + 0.5, a5.y), null);
  // The trench center is 1.5 from both f and e rows.
  const f5 = holePosition("pins-full", "f5");
  assert.equal(holeAt("pins-full", f5.x, f5.y + 1.5), null);
  // Way outside the board.
  assert.equal(holeAt("pins-full", -10, -10), null);
  assert.ok(HOLE_HIT_RADIUS < 0.5, "radius must leave a dead zone");
});

test("rail groups: one extra pitch of gap every 5 holes", () => {
  const x = (h) => holePosition("rail-full", h).x;
  assert.equal(x("+2") - x("+1"), 1);
  assert.equal(x("+5") - x("+4"), 1);
  assert.equal(x("+6") - x("+5"), 2); // group boundary
  assert.equal(x("+50") - x("+1"), 58); // 49 steps + 9 group gaps
});

test("holeAt resolves rail holes on both sides of a group gap", () => {
  const p5 = holePosition("rail-half", "+5");
  const p6 = holePosition("rail-half", "+6");
  assert.equal(holeAt("rail-half", p5.x + 0.3, p5.y), "+5");
  assert.equal(holeAt("rail-half", p6.x - 0.3, p6.y), "+6");
  // Dead center of the 2-unit gap is 1.0 from both — no hit.
  assert.equal(holeAt("rail-half", (p5.x + p6.x) / 2, p5.y), null);
});

// ── parseHole ────────────────────────────────────────────────────────────────

test("parseHole validates against the type", () => {
  assert.deepEqual(parseHole("pins-full", "j63"), {
    kind: "grid",
    row: "j",
    col: 63,
  });
  assert.deepEqual(parseHole("rail-full", "-7"), {
    kind: "rail",
    railId: "-",
    index: 7,
  });
  assert.equal(parseHole("pins-full", "j64"), null); // beyond 63 columns
  assert.equal(parseHole("pins-half", "a31"), null);
  assert.equal(parseHole("pins-tiny", "+1"), null); // a pin-board has no rails
  assert.equal(parseHole("rail-full", "a1"), null); // a rail strip has no grid
  assert.equal(parseHole("rail-full", "+51"), null);
  assert.equal(parseHole("rail-half", "-26"), null);
  assert.equal(parseHole("pins-full", "k1"), null); // no row k
  assert.equal(parseHole("pins-full", "a0"), null);
  assert.equal(parseHole("pins-full", 42), null);
});

// ── Addresses ────────────────────────────────────────────────────────────────

test("formatAddress/parseAddress round-trip", () => {
  for (const [boardId, hole] of [
    ["bb1", "f12"],
    ["bb2", "+7"],
    ["bb17", "-25"],
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

test("every strip's holes are CENTRED in its plastic", () => {
  // The holes must not hug one edge: the midpoint of the hole lattice has to
  // land on the strip's own midpoint, in both axes. This is what makes a
  // stacked kit read as one board rather than three misaligned slabs.
  for (const key of BOARD_TYPE_KEYS) {
    const s = BOARD_TYPES[key];
    const positions = holes(key).map((h) => holePosition(key, h));
    const mid = (vals) => (Math.min(...vals) + Math.max(...vals)) / 2;
    assert.equal(
      mid(positions.map((p) => p.y)),
      s.height / 2,
      `${key}: holes are off-centre vertically`,
    );
    // Horizontal centring is exact everywhere except rail-half, where it is
    // arithmetically impossible: the half board's 30 columns span an ODD 29
    // pitches while its 25-hole rail spans an EVEN 28, so the two lattices
    // cannot share a centre on an integer width. The grid wins (it dominates
    // visually) and the rail sits a known half-pitch right.
    const expectedX = key === "rail-half" ? s.width / 2 + 0.5 : s.width / 2;
    assert.equal(
      mid(positions.map((p) => p.x)),
      expectedX,
      `${key}: holes are off-centre horizontally`,
    );
  }
});

test("a kit's strips tile flush, and its rows stay in order", () => {
  for (const key of ALL_KIT_KEYS) {
    const strips = BREADBOARD_KITS[key].strips;
    let edge = 0;
    for (const strip of strips) {
      // No gap and no overlap: each strip starts where the last one ended.
      assert.equal(strip.dy, edge, `${key}: strip does not abut its neighbour`);
      assert.equal(strip.dx, 0, `${key}: strips must share a left edge`);
      edge += BOARD_TYPES[strip.type].height;
    }
    // Every strip in a kit is the same width, or they could not dovetail.
    const widths = new Set(strips.map((s) => BOARD_TYPES[s.type].width));
    assert.equal(widths.size, 1, `${key}: strips differ in width`);
  }
});
