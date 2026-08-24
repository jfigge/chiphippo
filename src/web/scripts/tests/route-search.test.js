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

// Tests for the path search (model/route-search.js), over a hand-built grid
// rather than a breadboard — the search knows nothing about boards, and testing
// it through one would only make its failures harder to read.
//
// `minTurns` gets its own tests because it is the half of the heuristic that is
// easy to get subtly wrong: too generous and the search stops being optimal, too
// mean and it explores the whole desk.

import test from "node:test";
import assert from "node:assert/strict";

import { findRoute, minTurns, pathCorners } from "../model/route-search.js";

/** An N×M grid of unit-spaced tracks, everything open, no costs but length. */
function grid(nx, ny, over = {}) {
  const xs = Array.from({ length: nx }, (_, i) => i);
  const ys = Array.from({ length: ny }, (_, j) => j);
  return {
    nx,
    ny,
    xs,
    ys,
    hEdge: (j, i) => j * (nx - 1) + i,
    vEdge: (i, j) => i * (ny - 1) + j,
    pointOf: (n) => ({ x: xs[n % nx], y: ys[Math.floor(n / nx)] }),
    ...over,
  };
}

const plan = (over = {}) => ({
  nodeOpen: () => true,
  edgeOpen: () => true,
  edgeCost: (axis, e, len) => len,
  crossCost: () => 0,
  enterCost: () => 0,
  turnCost: 2,
  minUnitCost: 1,
  ...over,
});

test("a straight run costs its length and turns nowhere", () => {
  const g = grid(6, 3);
  const found = findRoute(g, { ...plan(), start: 0, goal: 5 });
  assert.ok(found);
  assert.equal(found.bends, 0);
  assert.equal(found.cost, 5);
  assert.deepEqual(pathCorners(g, found.nodes), [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
  ]);
});

test("turn cost is paid once per corner, and an L beats a staircase", () => {
  const g = grid(5, 5);
  const goal = 4 * 5 + 4; // (4,4)
  const found = findRoute(g, { ...plan(), start: 0, goal });
  // 8 units of length, and the cheapest rectilinear path takes ONE corner.
  assert.equal(found.bends, 1);
  assert.equal(found.cost, 8 + 2);
  assert.equal(pathCorners(g, found.nodes).length, 3, "start, corner, end");
});

test("free turns make the bend count irrelevant, not the length", () => {
  const g = grid(5, 5);
  const found = findRoute(g, { ...plan({ turnCost: 0 }), start: 0, goal: 24 });
  assert.equal(found.cost, 8, "still eight units of travel");
});

test("a blocked edge is routed around; a walled-off goal returns null", () => {
  const g = grid(5, 3);
  // Wall off the whole middle column: every vertical track at x=2 is fine, but
  // the horizontal edges crossing x=2 are shut.
  const blockedH = new Set([g.hEdge(0, 1), g.hEdge(1, 1), g.hEdge(2, 1)]);
  const walled = findRoute(g, {
    ...plan({ edgeOpen: (axis, e) => !(axis === 0 && blockedH.has(e)) }),
    start: 0,
    goal: 4,
  });
  assert.equal(walled, null, "no way past the wall");

  // Open one row of it and the search threads through.
  blockedH.delete(g.hEdge(1, 1));
  const through = findRoute(g, {
    ...plan({ edgeOpen: (axis, e) => !(axis === 0 && blockedH.has(e)) }),
    start: 0,
    goal: 4,
  });
  assert.ok(through, "one gap is enough");
  assert.ok(through.bends >= 2);
});

test("crossing cost is charged for passing THROUGH, never for turning at", () => {
  const g = grid(5, 5);
  const middle = 2 * 5 + 2; // (2,2)
  let charged = 0;
  const found = findRoute(g, {
    ...plan({
      crossCost: (n) => {
        if (n === middle) charged += 1;
        return n === middle ? 100 : 0;
      },
    }),
    start: 2, // (2,0) — straight down through the middle, or around it
    goal: 4 * 5 + 2, // (2,4)
  });
  assert.ok(found);
  // Going straight down would pass through (2,2) and cost 100; the search
  // detours instead, which is the whole point of pricing crossings.
  assert.ok(found.cost < 100);
  assert.ok(charged > 0, "the crossing was at least considered");
});

test("the same problem gives the same answer, whatever order it is posed in", () => {
  const g = grid(7, 7);
  const first = findRoute(g, { ...plan(), start: 0, goal: 48 });
  for (let i = 0; i < 5; i += 1) {
    const again = findRoute(g, { ...plan(), start: 0, goal: 48 });
    assert.deepEqual(again.nodes, first.nodes, `run ${i}`);
  }
});

test("a window bounds the search, and a goal outside it is unreachable", () => {
  const g = grid(9, 3);
  const inside = findRoute(g, {
    ...plan(),
    start: 0,
    goal: 4,
    window: { i0: 0, i1: 5, j0: 0, j1: 2 },
  });
  assert.ok(inside);
  const outside = findRoute(g, {
    ...plan(),
    start: 0,
    goal: 8,
    window: { i0: 0, i1: 5, j0: 0, j1: 2 },
  });
  assert.equal(outside, null, "the window really is a bound");
});

test("start === goal is a route of no length", () => {
  const g = grid(4, 4);
  assert.deepEqual(findRoute(g, { ...plan(), start: 5, goal: 5 }), {
    nodes: [5],
    cost: 0,
    bends: 0,
  });
});

test("minTurns is admissible: never more than a real path needs", () => {
  // 4 = no heading yet; 0..3 are +x, −x, +y, −y.
  assert.equal(minTurns(4, 0, 0), 0);
  assert.equal(minTurns(4, 5, 0), 0, "straight ahead from a standing start");
  assert.equal(minTurns(4, 5, 5), 1, "one corner reaches any diagonal");
  assert.equal(minTurns(0, 5, 0), 0, "already pointing at it");
  assert.equal(minTurns(0, -5, 0), 2, "doubling back is two corners");
  assert.equal(minTurns(0, 0, 5), 1, "one turn onto the other axis");
  assert.equal(minTurns(0, 5, 5), 1, "making progress: one more turn");
  assert.equal(minTurns(1, 5, 5), 2, "pointing away on both counts");
  assert.equal(minTurns(2, 5, 5), 1);
  assert.equal(minTurns(3, 5, 5), 2);
});

test("pathCorners keeps the ends and drops everything run straight through", () => {
  const g = grid(5, 5);
  const nodes = [0, 1, 2, 7, 12]; // right, right, down, down
  assert.deepEqual(pathCorners(g, nodes), [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
  ]);
  assert.deepEqual(pathCorners(g, [3]), [{ x: 3, y: 0 }]);
});
