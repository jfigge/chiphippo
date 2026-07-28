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

// The geometry behind "does this wire run over that chip". Pure segment/box
// arithmetic, so it is worth pinning exactly — the compiler's whole routing
// preference is built on its answers, and a hit test that is quietly wrong in
// the corner cases produces layouts that look considered and are not.

import test from "node:test";
import assert from "node:assert/strict";

import {
  boxOf,
  crossingCount,
  segmentHitsBox,
} from "../model/wire-crossing.js";

const at = (x, y) => ({ x, y });

test("a box is the bounding rectangle of the points, plus a margin", () => {
  const box = boxOf([at(2, 5), at(9, 5)], 0.45);
  assert.deepEqual(box, { x0: 1.55, x1: 9.45, y0: 4.55, y1: 5.45 });
  assert.equal(boxOf([]), null);
  assert.equal(boxOf(null), null);
  // A part along ONE row is a zero-height line; the margin is what gives it a
  // body, and without it no wire could ever be found running over a resistor
  // network — which lies flat along row a, exactly where wires want to travel.
  const flat = boxOf([at(1, 0), at(9, 0)]);
  assert.ok(flat.y1 > flat.y0, "a flat part still has height");
});

const BODY = { x0: 4, x1: 10, y0: 4, y1: 6 };

test("a segment crossing the box hits; one passing clear does not", () => {
  assert.equal(
    segmentHitsBox(at(0, 5), at(14, 5), BODY),
    true,
    "straight through",
  );
  assert.equal(segmentHitsBox(at(0, 1), at(14, 1), BODY), false, "above it");
  assert.equal(segmentHitsBox(at(0, 9), at(14, 9), BODY), false, "below it");
  assert.equal(segmentHitsBox(at(1, 0), at(1, 9), BODY), false, "left of it");
  assert.equal(segmentHitsBox(at(0, 0), at(14, 12), BODY), true, "diagonally");
});

test("a segment that stops short does not hit — length matters, not the line", () => {
  // The bug this rules out: treating the wire as an infinite line. Two parts on
  // the same row would then "cross" every wire anywhere along it.
  assert.equal(segmentHitsBox(at(0, 5), at(3, 5), BODY), false, "stops before");
  assert.equal(
    segmentHitsBox(at(11, 5), at(14, 5), BODY),
    false,
    "starts after",
  );
});

test("a corner clip counts, which is why this is not sampled", () => {
  // Enters through the left edge and leaves through the top, crossing a sliver.
  // Sampling every 2% of a long segment steps straight over this.
  assert.equal(segmentHitsBox(at(3.5, 4.5), at(4.6, 3.5), BODY), true);
});

test("an endpoint inside the body counts as touching it", () => {
  assert.equal(segmentHitsBox(at(6, 5), at(20, 20), BODY), true);
  assert.equal(segmentHitsBox(at(20, 20), at(6, 5), BODY), true);
});

test("a degenerate segment is a point test", () => {
  assert.equal(segmentHitsBox(at(6, 5), at(6, 5), BODY), true, "inside");
  assert.equal(segmentHitsBox(at(0, 0), at(0, 0), BODY), false, "outside");
});

test("missing geometry is not a hit", () => {
  assert.equal(segmentHitsBox(null, at(0, 0), BODY), false);
  assert.equal(segmentHitsBox(at(0, 0), null, BODY), false);
  assert.equal(segmentHitsBox(at(0, 0), at(1, 1), null), false);
});

test("crossingCount skips the parts a wire terminates on", () => {
  const boxes = new Map([
    ["chip", BODY],
    ["bar", { x0: 12, x1: 20, y0: 4, y1: 6 }],
  ]);
  assert.equal(crossingCount(at(0, 5), at(22, 5), boxes), 2, "over both");
  assert.equal(
    crossingCount(at(0, 5), at(22, 5), boxes, new Set(["bar"])),
    1,
    "the one it ends on does not count against it",
  );
  assert.equal(
    crossingCount(at(0, 5), at(22, 5), boxes, new Set(["chip", "bar"])),
    0,
  );
});
