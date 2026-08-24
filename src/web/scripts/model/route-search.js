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

// route-search.js — one wire's path through the routing space (Feature 360).
//
// A* over `route-space.js`'s track grid, with two departures from the textbook
// that the routing requirements force:
//
//   · THE STATE CARRIES A HEADING. A search whose state is just "which node" has
//     nowhere to put a turn cost, and turn cost is the difference between a
//     route that reads as one run with two corners and a staircase of the same
//     length. So the state is (node, heading) and a bend is priced on the
//     TRANSITION. It also gives the crossing rule its natural home: a wire
//     crosses another at a node exactly when it passes THROUGH — enters and
//     leaves on the same heading — which is knowable only here.
//
//   · THE HEURISTIC IS SCALED BY THE CHEAPEST POSSIBLE EDGE. The cost model
//     hands out bundle and corridor DISCOUNTS, so an edge can cost less than its
//     length. A Manhattan heuristic would then overestimate and the search would
//     stop being optimal — silently, still returning routes, just not the best
//     ones. `minUnitCost` comes from route-config.js, where it is DERIVED from
//     the discounts rather than typed beside them.
//
// Everything policy — what an edge costs, what is blocked, what a crossing is
// worth — is INJECTED. This file knows only how to search, which is what lets
// `autoroute.js` change the costs between rounds (negotiated congestion) and
// re-run the same search unchanged.
//
// Deterministic by construction: the heap's comparator is a TOTAL order down to
// the state index, because a binary heap is not stable and a track grid produces
// equal-cost routes constantly. Two runs over the same input return the same
// path, and so do two runs over the same input in a different order.

/**
 * Reusable per-state scratch, stamped rather than cleared.
 *
 * Sized to the largest grid seen and never shrunk; the stamp advances on every
 * search, so a state whose `gen` is stale reads as unvisited without anything
 * having to be written to it. Single-threaded by construction — a renderer
 * routes one desk at a time — and it holds no result, so reusing it cannot make
 * two identical runs differ.
 */
let SCRATCH = null;

function scratchFor(size) {
  if (!SCRATCH || SCRATCH.g.length < size) {
    SCRATCH = {
      g: new Float64Array(size),
      from: new Int32Array(size),
      gen: new Int32Array(size),
      doneGen: new Int32Array(size),
      stamp: 0,
    };
  }
  SCRATCH.stamp += 1;
  return SCRATCH;
}

/** Headings. 4 is "not yet moving" — the start state, which owes no turn. */
const DIRS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];
const NO_DIR = 4;
const STATES_PER_NODE = 5;

/** Horizontal moves are axis 0, vertical axis 1 — the same numbering the cost
    model and the occupancy map use. */
const axisOf = (dir) => (dir < 2 ? 0 : 1);

/**
 * The fewest turns a rectilinear path can take from a heading to a goal offset.
 * Admissible, and the half of the heuristic that stops the search wandering
 * along a cheap corridor that points the wrong way.
 */
export function minTurns(dir, dx, dy) {
  if (dx === 0 && dy === 0) return 0;
  if (dir === NO_DIR) return dx !== 0 && dy !== 0 ? 1 : 0;
  const d = DIRS[dir];
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (dy === 0) {
    if (d.dx === sx) return 0; // already pointing at it
    return d.dx === -sx ? 2 : 1; // doubling back, or one turn off the axis
  }
  if (dx === 0) {
    if (d.dy === sy) return 0;
    return d.dy === -sy ? 2 : 1;
  }
  // Off-axis in both: one turn if the heading already makes progress, else two.
  return d.dx === sx || d.dy === sy ? 1 : 2;
}

/** A binary min-heap over a total order — see the header on why stability is
    not optional here. */
class Heap {
  #items = [];

  get size() {
    return this.#items.length;
  }

  /** Lower is better: cheapest f, then DEEPEST g (a tie-break that pushes the
      frontier forward rather than fanning it out), then the state index, which
      makes the order total and therefore reproducible. */
  #before(a, b) {
    if (a.f !== b.f) return a.f < b.f;
    if (a.g !== b.g) return a.g > b.g;
    return a.state < b.state;
  }

  push(item) {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#before(items[i], items[p])) break;
      [items[i], items[p]] = [items[p], items[i]];
      i = p;
    }
  }

  pop() {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && this.#before(items[l], items[best])) best = l;
        if (r < items.length && this.#before(items[r], items[best])) best = r;
        if (best === i) break;
        [items[i], items[best]] = [items[best], items[i]];
        i = best;
      }
    }
    return top;
  }
}

/**
 * Search one route.
 *
 * @param {object} space a `buildRouteSpace` result
 * @param {object} plan
 * @param {number} plan.start node index
 * @param {number} plan.goal node index
 * @param {(n:number) => boolean} plan.nodeOpen
 * @param {(axis:number, e:number) => boolean} plan.edgeOpen
 * @param {(axis:number, e:number, len:number) => number} plan.edgeCost
 * @param {(n:number, axis:number) => number} plan.crossCost cost of passing
 *   THROUGH node `n` along `axis` (i.e. what the wires already crossing there
 *   are worth)
 * @param {(from:number, to:number) => number} plan.enterCost node-kind change —
 *   this is where leaving the boards for a bridge is charged, once
 * @param {number} plan.turnCost
 * @param {number} plan.minUnitCost
 * @param {{i0:number,i1:number,j0:number,j1:number}} [plan.window]
 * @param {number} [plan.maxCost] an upper bound: states whose f reaches it are
 *   pruned. Because the heuristic never overestimates, a route cheaper than the
 *   bound is still guaranteed to be found — so a bound taken from a route
 *   already in hand prunes hard while costing nothing in quality.
 * @returns {{nodes:number[], cost:number, bends:number}|null}
 */
export function findRoute(space, plan) {
  const { nx, ny, xs, ys } = space;
  const nodes = nx * ny;
  const { start, goal, window } = plan;
  if (start < 0 || goal < 0 || start >= nodes || goal >= nodes) return null;
  if (start === goal) return { nodes: [start], cost: 0, bends: 0 };

  const limit = plan.maxCost ?? Infinity;
  const i0 = window?.i0 ?? 0;
  const i1 = window?.i1 ?? nx - 1;
  const j0 = window?.j0 ?? 0;
  const j1 = window?.j1 ?? ny - 1;
  const inWindow = (i, j) => i >= i0 && i <= i1 && j >= j0 && j <= j1;

  const gx = xs[goal % nx];
  const gy = ys[Math.floor(goal / nx)];
  const heuristic = (n, dir) => {
    const x = xs[n % nx];
    const y = ys[Math.floor(n / nx)];
    const dx = gx - x;
    const dy = gy - y;
    return (
      plan.minUnitCost * (Math.abs(dx) + Math.abs(dy)) +
      plan.turnCost * minTurns(dir, dx, dy)
    );
  };

  // Scratch is REUSED across searches, stamped rather than cleared. A desk of
  // three boards is ~40 000 nodes, so the per-state arrays are the better part
  // of two megabytes — allocating and zeroing them once per wire per round cost
  // more than the search itself. A generation stamp makes "unvisited" a
  // comparison instead of a memset.
  const { g, from, gen, doneGen, stamp } = scratchFor(nodes * STATES_PER_NODE);
  const costAt = (state) => (gen[state] === stamp ? g[state] : Infinity);
  const open = new Heap();

  const startState = start * STATES_PER_NODE + NO_DIR;
  g[startState] = 0;
  gen[startState] = stamp;
  // Explicitly, because the scratch is stamped rather than cleared: without it
  // the walk back from the goal reads whatever the previous search left here.
  from[startState] = -1;
  open.push({ f: heuristic(start, NO_DIR), g: 0, state: startState });

  let goalState = -1;
  let expanded = 0;
  while (open.size > 0) {
    const top = open.pop();
    if (doneGen[top.state] === stamp) continue;
    doneGen[top.state] = stamp;
    expanded += 1;
    const node = Math.floor(top.state / STATES_PER_NODE);
    const dir = top.state % STATES_PER_NODE;
    if (node === goal) {
      goalState = top.state;
      break;
    }
    const i = node % nx;
    const j = Math.floor(node / nx);
    for (let d = 0; d < 4; d += 1) {
      const ni = i + DIRS[d].dx;
      const nj = j + DIRS[d].dy;
      if (ni < 0 || ni >= nx || nj < 0 || nj >= ny) continue;
      if (!inWindow(ni, nj)) continue;
      const next = nj * nx + ni;
      if (!plan.nodeOpen(next)) continue;
      const axis = axisOf(d);
      const edge =
        axis === 0
          ? space.hEdge(j, Math.min(i, ni))
          : space.vEdge(i, Math.min(j, nj));
      if (!plan.edgeOpen(axis, edge)) continue;
      const len =
        axis === 0 ? Math.abs(xs[ni] - xs[i]) : Math.abs(ys[nj] - ys[j]);

      let step = plan.edgeCost(axis, edge, len) + plan.enterCost(node, next);
      if (dir !== NO_DIR) {
        if (dir === d) {
          // Straight through this node — which is the only thing that can
          // CROSS another wire here. A route that turns merely touches.
          step += plan.crossCost(node, axis);
        } else {
          // A reversal is two right angles, and priced as such so the search
          // cannot buy a doubling-back for the price of one corner.
          step += plan.turnCost * (axisOf(dir) === axis ? 2 : 1);
        }
      }
      const nextState = next * STATES_PER_NODE + d;
      if (doneGen[nextState] === stamp) continue;
      const tentative = top.g + step;
      if (tentative >= costAt(nextState)) continue;
      const f = tentative + heuristic(next, d);
      if (f >= limit) continue; // cannot beat what the caller already holds
      g[nextState] = tentative;
      gen[nextState] = stamp;
      from[nextState] = top.state;
      open.push({ f, g: tentative, state: nextState });
    }
  }

  if (goalState < 0) return null;

  const path = [];
  let bends = 0;
  let s = goalState;
  let lastDir = -1;
  while (s >= 0) {
    const node = Math.floor(s / STATES_PER_NODE);
    const dir = s % STATES_PER_NODE;
    if (lastDir >= 0 && dir !== NO_DIR && dir !== lastDir) bends += 1;
    if (dir !== NO_DIR) lastDir = dir;
    path.push(node);
    s = from[s];
  }
  path.reverse();
  return { nodes: path, cost: g[goalState], bends, expanded };
}

/**
 * A node path reduced to its CORNERS — the world points a wire actually needs
 * as waypoints. The endpoints are kept; every node the route runs straight
 * through is dropped, because a waypoint there would be a bend the user could
 * grab that does nothing.
 */
export function pathCorners(space, nodes) {
  const points = nodes.map((n) => space.pointOf(n));
  if (points.length <= 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const straight =
      (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    if (!straight) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}
