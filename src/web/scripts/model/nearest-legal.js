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

// nearest-legal.js — the shared "snap to the nearest valid drop point"
// search: a drag whose exact drop point misses (nothing there, or occupied)
// shouldn't just fail — it should recover onto whatever legal spot is
// closest, the way real drag-and-drop UIs forgive a near-miss. Pure and
// domain-free: callers supply `isLegal(dx, dy)` over integer pitch-unit
// OFFSETS from whatever anchor they care about (a cursor world point for a
// single endpoint, a whole-wire/whole-bus translation delta for a rigid
// move) — this module only knows how to search a growing neighborhood of
// offsets, closest ring first, and stop at the first one that's legal.
//
// The search is INCREMENTAL (ring by ring, `nearestLegalOffset` bails out at
// the first hit) rather than pre-building and sorting one big square, so an
// "always find the nearest, however far" search (the default `maxRadius`)
// stays cheap in the common case — something legal is usually close — and
// only pays for the full search in the rare case nothing is nearby at all.

/** A safety backstop for an "always find the nearest" search — large enough
    to cover any reasonably sized desk layout (a Full breadboard is 63 pitch
    units wide), small enough that a truly empty desk still bails out
    promptly rather than searching forever. Callers wanting a tight
    near-miss forgiveness margin instead of "always" pass their own smaller
    radius (see wire-tools.js's whole-wire / bus-tools.js's whole-bus rigid
    drags, which deliberately stay small — a big rigid jump reads as
    teleporting the whole wire/bus, not recovering a near-miss). */
export const DEFAULT_SEARCH_RADIUS = 200;

/**
 * Every integer `(dx, dy)` at EXACTLY Chebyshev distance `r` from the
 * origin — the boundary of a `(2r+1)x(2r+1)` square, i.e. the ring a search
 * up to `r-1` hasn't covered yet — sorted by TRUE Euclidean distance
 * ascending (ties broken top-to-bottom, left-to-right). `r <= 0` is just
 * the origin itself.
 *
 * Rings are Chebyshev (square), not Euclidean (circular): a far corner of
 * ring `r` (distance `r*sqrt(2)`) can rarely be marginally farther than a
 * cardinal point of ring `r+1` (distance `r+1`), so a search that stops at
 * the first hit within a ring isn't a mathematically perfect
 * nearest-neighbor for every possible layout. That's an accepted, minor
 * approximation for a UX nicety — same spirit as wireSag not being a true
 * catenary — not a correctness bug: it still finds A legal point close by.
 *
 * @param {number} r
 * @returns {{dx:number, dy:number, dist:number}[]}
 */
export function ringOffsets(r) {
  if (r <= 0) return [{ dx: 0, dy: 0, dist: 0 }];
  const pts = [];
  for (let dx = -r; dx <= r; dx += 1) {
    pts.push({ dx, dy: -r, dist: Math.hypot(dx, r) });
    pts.push({ dx, dy: r, dist: Math.hypot(dx, r) });
  }
  for (let dy = -r + 1; dy <= r - 1; dy += 1) {
    pts.push({ dx: -r, dy, dist: Math.hypot(r, dy) });
    pts.push({ dx: r, dy, dist: Math.hypot(r, dy) });
  }
  pts.sort((a, b) => a.dist - b.dist || a.dy - b.dy || a.dx - b.dx);
  return pts;
}

/**
 * The nearest integer `(dx, dy)` offset — `(0, 0)` (the exact spot) tried
 * first, then an expanding ring of neighbors — for which `isLegal(dx, dy)`
 * is true, or null when nothing within `maxRadius` qualifies.
 *
 * @param {(dx:number, dy:number) => boolean} isLegal
 * @param {number} [maxRadius] - pitch units; defaults to
 *   DEFAULT_SEARCH_RADIUS ("always" find the nearest). Pass a small value
 *   for a bounded near-miss forgiveness margin instead.
 * @returns {{dx:number, dy:number}|null}
 */
export function nearestLegalOffset(isLegal, maxRadius = DEFAULT_SEARCH_RADIUS) {
  for (let r = 0; r <= maxRadius; r += 1) {
    for (const { dx, dy } of ringOffsets(r)) {
      if (isLegal(dx, dy)) return { dx, dy };
    }
  }
  return null;
}
