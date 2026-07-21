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

// rect-outline.js — the OUTER boundary of a union of axis-aligned rectangles,
// as rectilinear rings. Snapped strips are flush rectangles, so a selection
// spanning several of them must be drawn as one shape: outlining each rect
// separately would draw a seam down every join.
//
// Pure math, DOM-free. The algorithm is coordinate compression + boundary
// tracing: every rect edge splits the plane into a small grid, each cell is
// inside-or-out, and the sides between an inside and an outside cell ARE the
// boundary — stitched head-to-tail into closed rings. Concave (L-shaped)
// arrangements and detached groups both fall out for free.

/** Ascending unique values (exact equality — all inputs share one lattice). */
function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

const key = (p) => `${p.x},${p.y}`;

/**
 * Trace the union of `rects`, each `{x, y, width, height}`, growing every one
 * by `margin` first so the outline sits OUTSIDE the shape (and so strips that
 * merely touch overlap, leaving no hairline seam).
 *
 * Rings are returned interior-on-the-right (clockwise on screen, where y runs
 * down), collinear points collapsed, and implicitly closed — the last point
 * is not a repeat of the first.
 *
 * @param {Array<{x:number,y:number,width:number,height:number}>} rects
 * @param {number} [margin]
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function unionOutline(rects, margin = 0) {
  const boxes = rects
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      x0: r.x - margin,
      y0: r.y - margin,
      x1: r.x + r.width + margin,
      y1: r.y + r.height + margin,
    }));
  if (boxes.length === 0) return [];

  const xs = sortedUnique(boxes.flatMap((b) => [b.x0, b.x1]));
  const ys = sortedUnique(boxes.flatMap((b) => [b.y0, b.y1]));
  const cols = xs.length - 1;
  const rows = ys.length - 1;

  // Cell (i, j) is inside when its CENTRE is inside some box — a centre can
  // never land on an edge, so there are no boundary ties to break.
  const inside = new Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const cy = (ys[j] + ys[j + 1]) / 2;
    for (let i = 0; i < cols; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      inside[j * cols + i] = boxes.some(
        (b) => cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1,
      );
    }
  }
  const at = (i, j) =>
    i >= 0 && j >= 0 && i < cols && j < rows && inside[j * cols + i];

  // Every side facing an outside cell, directed so the interior is on the
  // right. Consistent direction is what makes the stitch below unambiguous.
  const edges = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!at(i, j)) continue;
      const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
      if (!at(i, j - 1))
        edges.push([
          { x: x0, y: y0 },
          { x: x1, y: y0 },
        ]);
      if (!at(i + 1, j))
        edges.push([
          { x: x1, y: y0 },
          { x: x1, y: y1 },
        ]);
      if (!at(i, j + 1))
        edges.push([
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ]);
      if (!at(i - 1, j))
        edges.push([
          { x: x0, y: y1 },
          { x: x0, y: y0 },
        ]);
    }
  }
  return stitch(edges);
}

/** Chain directed edges head-to-tail into closed rings. */
function stitch(edges) {
  const outgoing = new Map();
  for (const edge of edges) {
    const k = key(edge[0]);
    if (!outgoing.has(k)) outgoing.set(k, []);
    outgoing.get(k).push(edge);
  }
  const used = new Set();
  const rings = [];

  for (const seed of edges) {
    if (used.has(seed)) continue;
    const ring = [];
    let edge = seed;
    while (edge && !used.has(edge)) {
      used.add(edge);
      ring.push(edge[0]);
      edge = nextEdge(outgoing.get(key(edge[1])) ?? [], edge, used);
    }
    if (ring.length >= 4) rings.push(collapse(ring));
  }
  return rings;
}

/**
 * The continuation of `edge` among the edges leaving its head. Two candidates
 * means a pinch point (rects meeting only at a corner): turning right keeps
 * each blob's ring closed instead of fusing them into a figure eight.
 */
function nextEdge(candidates, edge, used) {
  const dir = {
    x: Math.sign(edge[1].x - edge[0].x),
    y: Math.sign(edge[1].y - edge[0].y),
  };
  let best = null;
  let bestTurn = -Infinity;
  for (const c of candidates) {
    if (used.has(c)) continue;
    const d = {
      x: Math.sign(c[1].x - c[0].x),
      y: Math.sign(c[1].y - c[0].y),
    };
    // Cross product with y running down: > 0 is a right turn on screen.
    const turn = dir.x * d.y - dir.y * d.x;
    if (turn > bestTurn) {
      bestTurn = turn;
      best = c;
    }
  }
  return best;
}

/** Drop the middle point of every straight run. */
function collapse(ring) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i - 1 + ring.length) % ring.length];
    const p = ring[i];
    const next = ring[(i + 1) % ring.length];
    const straight =
      (prev.x === p.x && p.x === next.x) || (prev.y === p.y && p.y === next.y);
    if (!straight) out.push(p);
  }
  return out;
}

/**
 * Rings → one SVG path, corners rounded by up to `radius` (clamped to half
 * the shorter adjacent run, so a short strip end never over-rounds).
 *
 * @param {Array<Array<{x:number,y:number}>>} rings
 * @param {number} [radius]
 * @returns {string} the `d` attribute (empty when there is nothing to draw).
 */
export function outlinePath(rings, radius = 0) {
  return rings
    .filter((ring) => ring.length >= 4)
    .map((ring) => ringPath(ring, radius))
    .join(" ");
}

function ringPath(ring, radius) {
  const n = ring.length;
  if (radius <= 0) {
    const [first, ...rest] = ring;
    return [
      `M ${round(first.x)} ${round(first.y)}`,
      ...rest.map((p) => `L ${round(p.x)} ${round(p.y)}`),
      "Z",
    ].join(" ");
  }

  const parts = [];
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n];
    const p = ring[i];
    const next = ring[(i + 1) % n];
    const inDir = unit(prev, p);
    const outDir = unit(p, next);
    const r = Math.min(radius, dist(prev, p) / 2, dist(p, next) / 2);
    const start = { x: p.x - inDir.x * r, y: p.y - inDir.y * r };
    const end = { x: p.x + outDir.x * r, y: p.y + outDir.y * r };
    parts.push(
      `${i === 0 ? "M" : "L"} ${round(start.x)} ${round(start.y)}`,
      // y runs down, so a positive cross product is a clockwise (sweep 1) arc.
      `A ${round(r)} ${round(r)} 0 0 ${inDir.x * outDir.y - inDir.y * outDir.x > 0 ? 1 : 0} ${round(end.x)} ${round(end.y)}`,
    );
  }
  parts.push("Z");
  return parts.join(" ");
}

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function unit(a, b) {
  const d = dist(a, b) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
}

/** Trim float noise out of the path text. */
function round(v) {
  return Math.round(v * 100) / 100;
}
