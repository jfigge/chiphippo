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

// Tests for the pure "snap to nearest legal offset" search (model/nearest-legal.js).

import test from "node:test";
import assert from "node:assert/strict";

import { nearestLegalOffset, ringOffsets } from "../model/nearest-legal.js";

test("ringOffsets: r<=0 is just the origin", () => {
  assert.deepEqual(ringOffsets(0), [{ dx: 0, dy: 0, dist: 0 }]);
  assert.deepEqual(ringOffsets(-3), [{ dx: 0, dy: 0, dist: 0 }]);
});

test("ringOffsets: every point is at Chebyshev distance EXACTLY r", () => {
  const r = 3;
  for (const { dx, dy } of ringOffsets(r)) {
    assert.equal(Math.max(Math.abs(dx), Math.abs(dy)), r);
  }
});

test("ringOffsets: sorted by true Euclidean distance ascending within the ring", () => {
  const points = ringOffsets(4);
  for (let i = 1; i < points.length; i += 1) {
    assert.ok(points[i].dist >= points[i - 1].dist);
  }
  // The cardinal point is the ring's closest; a corner is its farthest.
  assert.equal(points[0].dist, 4);
  assert.ok(Math.abs(points.at(-1).dist - 4 * Math.SQRT2) < 1e-9);
});

test("ringOffsets: a ring has exactly the boundary of its square, no duplicates, no interior", () => {
  const r = 2;
  const points = ringOffsets(r);
  const keys = new Set(points.map((p) => `${p.dx},${p.dy}`));
  assert.equal(keys.size, points.length, "no duplicate offsets");
  assert.equal(points.length, 8 * r, "a Chebyshev ring at r has 8r points");
  for (const { dx, dy } of points) {
    assert.ok(Math.abs(dx) <= r && Math.abs(dy) <= r);
  }
});

test("nearestLegalOffset: the exact spot wins when it's already legal", () => {
  const found = nearestLegalOffset(() => true, 2);
  assert.deepEqual(found, { dx: 0, dy: 0 });
});

test("nearestLegalOffset: returns the CLOSEST legal offset, not just the first found in scan order", () => {
  const legal = new Set(["2,0", "1,1", "0,2"]); // Chebyshev ring 2, 1, 2
  const found = nearestLegalOffset((dx, dy) => legal.has(`${dx},${dy}`), 3);
  assert.deepEqual(
    found,
    { dx: 1, dy: 1 },
    "(1,1) is in ring 1, checked before ring 2's (2,0)/(0,2)",
  );
});

test("nearestLegalOffset: null when nothing within maxRadius qualifies", () => {
  const found = nearestLegalOffset((dx, dy) => dx === 5 && dy === 5, 2);
  assert.equal(found, null);
});

test("nearestLegalOffset: a maxRadius of 0 only ever checks the exact spot", () => {
  const calls = [];
  const found = nearestLegalOffset((dx, dy) => {
    calls.push([dx, dy]);
    return false;
  }, 0);
  assert.equal(found, null);
  assert.deepEqual(calls, [[0, 0]]);
});

test("nearestLegalOffset: the default radius finds a match far beyond a small custom one", () => {
  // Nothing legal until Chebyshev distance 40 — well past any small
  // "near-miss forgiveness" radius a caller might pass, but still well
  // within the default ("always find the nearest") search.
  const found = nearestLegalOffset((dx, dy) => dx === 40 && dy === 0);
  assert.deepEqual(found, { dx: 40, dy: 0 });
});

test("nearestLegalOffset: stops at the first hit — doesn't scan past the answer", () => {
  let calls = 0;
  const found = nearestLegalOffset((dx, dy) => {
    calls += 1;
    return dx === 1 && dy === 0;
  });
  assert.deepEqual(found, { dx: 1, dy: 0 });
  // Origin (1 call) + ring 1 up to and including (1,0) — nowhere near the
  // full default-radius search space (a couple hundred rings).
  assert.ok(
    calls < 10,
    `only searched nearby, not the whole radius (${calls} calls)`,
  );
});
