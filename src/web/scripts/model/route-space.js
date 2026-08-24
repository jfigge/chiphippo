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

// route-space.js — where a wire is ALLOWED to be (Feature 360).
//
// The auto-router's graph is not a grid laid over the desk; it is the board's
// own feature lines. Every x at which a hole or a brick terminal sits becomes a
// vertical track, every row and rail line a horizontal one, and any gap wider
// than one pitch is filled evenly. Three things fall out of building it that way
// rather than by subdividing a uniform lattice:
//
//   · EVERY WIRE ENDPOINT IS ALREADY A NODE. Board x is an integer, row y is a
//     fixed 2-decimal constant, and a brick's terminals sit at integer offsets
//     from an integer origin (catalog/parts.js says so, deliberately). So a route
//     leaves its hole along a track with no transition geometry at all, and it
//     terminates ON the connection point rather than near it.
//
//   · A ROTATED RAIL COSTS NOTHING. Its holes land on fractional x; a uniform
//     lattice would miss them and a finer one would breach the clearance floor.
//     Reading the tracks off the actual hole positions handles it by
//     construction.
//
//   · CLEARANCE IS MOSTLY STRUCTURAL. 1.5 mm of wire plus 0.5 mm of air is 0.787
//     pitch, so two wires one pitch apart clear each other and two a half-pitch
//     apart do not (route-config.js). Tracks never land closer than that WITHIN a
//     board, so parallel runs are legal by construction; the only way to breach
//     it is two separately-placed boards sitting at pathological offsets, which
//     is what the per-track CONFLICT RANGES below exist to catch.
//
// The other half of the file is the legal REGION. "Stay on the board" cannot be
// absolute, because a wire legitimately ends on a PSU or clock brick standing
// off the boards — so rather than weaken the rule, the region is stated
// explicitly: board rects are free, and everything else a wire may legally reach
// (the corridor out to an off-board terminal, the bridge across a gap between
// two board groups) is a BRIDGE, which costs `gapCrossCost` to enter. Anything
// outside both is not in the graph at all, so there is no penalty for leaving
// the boards — there is simply no edge that does.
//
// Pure and DOM-free. The one thing it cannot compute for itself is a part's
// drawn BODY: `chipBox`/`discreteBox` live in the view layer and `model/` may
// not import `components/`, so the caller injects `bodyBox`. Without it a part
// falls back to its pin extent, which is right for a DIP and honest for anything
// else — but wrong for, say, a 7-segment digit, whose nine pins lie along one
// row while the block stands seven pitch above them.

import { boardRect } from "./mating.js";
import { holePosition, holes } from "./breadboard.js";
import { addressWorld, partPinsWorld } from "./part-geometry.js";
import { buildOccupancy } from "./occupancy.js";
import { boxOf } from "./wire-crossing.js";
import { partDef } from "../catalog/index.js";
import { ROUTE_CONFIG } from "./route-config.js";

/** Coordinates are quantized to 0.01 everywhere they are stored, so tracks are
    compared on the same grid. Anything finer is float noise. */
const Q = 100;
const q = (n) => Math.round(n * Q) / Q;

/** Slack for "these two rects touch". Mated strips meet EXACTLY flush, but the
    arithmetic that puts them there (3.5 + 14.02) is not exact in binary, and a
    seam that fails by an ulp is a board a wire cannot step across. */
const TOUCH_EPS = 1e-6;

/** A node's standing in the region. */
export const OUTSIDE = 0;
export const ON_BOARD = 1;
export const ON_BRIDGE = 2;

/** How wide (pitch) a corridor out to an off-board terminal is opened. Three
    pitch leaves room for a lead to approach the terminal from either side
    without the corridor becoming a second desk. */
const CORRIDOR_HALF_WIDTH = 1.5;

const rect = (x, y, width, height) => ({
  x0: q(x),
  y0: q(y),
  x1: q(x + width),
  y1: q(y + height),
});

const inflate = (r, by) => ({
  x0: r.x0 - by,
  y0: r.y0 - by,
  x1: r.x1 + by,
  y1: r.y1 + by,
});

const covers = (r, x, y) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Do two rects share area or an edge? Touching counts — a mated kit is one
    region, not three that a wire may not step between. */
const touches = (a, b) =>
  a.x0 <= b.x1 + TOUCH_EPS &&
  b.x0 <= a.x1 + TOUCH_EPS &&
  a.y0 <= b.y1 + TOUCH_EPS &&
  b.y0 <= a.y1 + TOUCH_EPS;

/** Merge a list of `[lo, hi]` intervals, joining ones that touch. Flush strips
    produce exactly-touching intervals, and they must come out as ONE span or a
    vertical edge could not cross the seam between a rail and its pin-board. */
function mergeSpans(spans) {
  if (spans.length === 0) return spans;
  spans.sort((a, b) => a[0] - b[0]);
  const out = [spans[0]];
  for (let i = 1; i < spans.length; i += 1) {
    const last = out[out.length - 1];
    if (spans[i][0] <= last[1] + TOUCH_EPS) {
      if (spans[i][1] > last[1]) last[1] = spans[i][1];
    } else {
      out.push(spans[i]);
    }
  }
  return out;
}

/** Is `[lo, hi]` wholly inside one of the merged `spans`? */
function spanned(spans, lo, hi) {
  for (const s of spans) {
    if (s[0] > lo + TOUCH_EPS) return false; // sorted — no later span can start earlier
    if (s[1] >= hi - TOUCH_EPS) return true;
  }
  return false;
}

/**
 * For every track, the merged intervals of `rects` that lie ON it.
 *
 * This is what makes edge legality EXACT rather than sampled: an axis-aligned
 * edge is legal exactly when its own interval is covered, which two endpoint
 * tests cannot tell you (they both pass over a notch between two rects).
 */
function spansPerTrack(rects, tracks, axis) {
  const perTrack = tracks.map(() => []);
  for (const r of rects) {
    const [lo, hi, alo, ahi] =
      axis === "x"
        ? [r.y0, r.y1, r.x0, r.x1] // a horizontal edge sits on a y track
        : [r.x0, r.x1, r.y0, r.y1];
    for (let k = 0; k < tracks.length; k += 1) {
      const t = tracks[k];
      if (t >= lo - TOUCH_EPS && t <= hi + TOUCH_EPS) perTrack[k].push([alo, ahi]); // prettier-ignore
    }
  }
  return perTrack.map(mergeSpans);
}

/** Sorted, de-duplicated track coordinates, with filler inserted wherever a gap
    would be wider than `fillMax`. Filler is spaced evenly, so the 3.00-pitch
    trench becomes three 1.00 steps and the 2.76 dovetail margin three of 0.92 —
    both over the clearance floor, which is what `fillMax` is chosen for. */
function buildTracks(seeds, fillMax, minSeparation) {
  const sorted = [...new Set(seeds.map(q))].sort((a, b) => a - b);
  if (sorted.length === 0) return { coords: [], seeded: [] };
  const coords = [sorted[0]];
  const seeded = [true];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    // As many pieces as the grid granularity asks for, but never so many that
    // two tracks land closer than two runs need to read as two runs. Without
    // the second half a 2.76 dovetail margin split into sixths of 0.46 — under
    // the lane spacing, so the extra lanes were unusable and merely made the
    // grid bigger.
    const pieces = Math.max(
      1,
      Math.min(
        Math.ceil(gap / fillMax - TOUCH_EPS),
        Math.floor(gap / minSeparation + TOUCH_EPS),
      ),
    );
    for (let k = 1; k < pieces; k += 1) {
      coords.push(q(sorted[i - 1] + (gap * k) / pieces));
      seeded.push(false);
    }
    coords.push(sorted[i]);
    seeded.push(true);
  }
  return { coords, seeded };
}

/** For each track, the half-open index range of tracks too close to clear it.
    Within a board nothing lands here; between two boards at unlucky offsets it
    is the only thing that notices. */
function conflictRanges(coords, minSeparation) {
  const lo = new Int32Array(coords.length);
  const hi = new Int32Array(coords.length);
  for (let i = 0; i < coords.length; i += 1) {
    let a = i;
    while (a > 0 && coords[i] - coords[a - 1] < minSeparation - TOUCH_EPS)
      a -= 1;
    let b = i;
    while (b < coords.length - 1 && coords[b + 1] - coords[i] < minSeparation - TOUCH_EPS) b += 1; // prettier-ignore
    lo[i] = a;
    hi[i] = b;
  }
  return { lo, hi };
}

/**
 * A seated part's body as a world rect, or null when nothing can size it.
 *
 * `bodyBox` is the injected view-layer geometry (pitch units, origin at pin 1's
 * hole). A part it declines to size — a rotated two-terminal part is the real
 * case, since its two leads can be on different strips and there is no box to
 * place — falls back to its PIN EXTENT plus the same 0.45 margin the AI
 * compiler's crossing test has always used.
 */
function partRect(doc, comp, bodyBox) {
  const board = doc.boards.find((b) => b.id === comp.board);
  if (!board) return null;
  const box = bodyBox?.(comp) ?? null;
  if (box) {
    const anchor = holePosition(board.type, comp.anchor, board.rot ?? 0);
    if (anchor) {
      return rect(
        board.x + anchor.x + box.minX,
        board.y + anchor.y + box.minY,
        box.width,
        box.height,
      );
    }
  }
  const pins = partPinsWorld(doc.boards, comp);
  const b = boxOf((pins ?? []).filter((p) => p.address));
  return b ? { x0: q(b.x0), y0: q(b.y0), x1: q(b.x1), y1: q(b.y1) } : null;
}

/** Every obstacle on the desk: seated parts by their drawn body, bricks by the
    rect `canPlaceBrick` already holds them to. Annotations are deliberately not
    here — a label is not on the board. */
function buildObstacles(doc, bodyBox) {
  const out = [];
  for (const comp of doc.components ?? []) {
    if (comp.board == null) {
      const size = partDef(comp.ref)?.size;
      if (size) out.push({ id: comp.id, rect: rect(comp.x, comp.y, size.width, size.height) }); // prettier-ignore
      continue;
    }
    const r = partRect(doc, comp, bodyBox);
    if (r) out.push({ id: comp.id, rect: r });
  }
  return out;
}

/** Connected groups of board rects — a mated kit is ONE, two loose kits are
    two. What is between two of them is a gap, and only a gap needs a bridge. */
function regionComponents(rects) {
  const owner = rects.map((_, i) => i);
  const find = (i) => (owner[i] === i ? i : (owner[i] = find(owner[i])));
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (touches(rects[i], rects[j])) owner[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < rects.length; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(rects[i]);
  }
  return [...groups.values()];
}

/** The bounding rect of a group. */
const boundsOf = (rects) => ({
  x0: Math.min(...rects.map((r) => r.x0)),
  y0: Math.min(...rects.map((r) => r.y0)),
  x1: Math.max(...rects.map((r) => r.x1)),
  y1: Math.max(...rects.map((r) => r.y1)),
});

/**
 * Bridges across the gaps between separately-placed board groups: for each pair
 * whose projections overlap on one axis, the rect spanning that overlap and the
 * gap. Wide on purpose — the wire may cross anywhere along the facing edges,
 * and pinning it to one column would be a routing decision made in the wrong
 * file.
 */
function buildBridges(groups) {
  const out = [];
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = boundsOf(groups[i]);
      const b = boundsOf(groups[j]);
      const joins = [i, j];
      const xLo = Math.max(a.x0, b.x0);
      const xHi = Math.min(a.x1, b.x1);
      if (xHi > xLo) {
        const [lo, hi] = a.y1 <= b.y0 ? [a.y1, b.y0] : [b.y1, a.y0];
        if (hi > lo) out.push({ x0: xLo, y0: lo, x1: xHi, y1: hi, joins });
      }
      const yLo = Math.max(a.y0, b.y0);
      const yHi = Math.min(a.y1, b.y1);
      if (yHi > yLo) {
        const [lo, hi] = a.x1 <= b.x0 ? [a.x1, b.x0] : [b.x1, a.x0];
        if (hi > lo) out.push({ x0: lo, y0: yLo, x1: hi, y1: yHi, joins });
      }
    }
  }
  return out;
}

/**
 * An L-shaped corridor from an off-board point to the nearest board rect — the
 * only way a wire can reach a PSU or clock terminal, and the reason "stay inside
 * the boards" is stated as a region rather than as a rule with an exception.
 *
 * It is a BRIDGE, not free board: leaving the boards costs `gapCrossCost`, which
 * every such lead pays equally, so it cannot distort the choice between them.
 */
function terminalCorridor(point, rects) {
  if (rects.length === 0) return [];
  let best = null;
  for (const r of rects) {
    const cx = Math.min(Math.max(point.x, r.x0), r.x1);
    const cy = Math.min(Math.max(point.y, r.y0), r.y1);
    const d = Math.abs(point.x - cx) + Math.abs(point.y - cy);
    if (!best || d < best.d) best = { d, x: cx, y: cy };
  }
  const h = CORRIDOR_HALF_WIDTH;
  return [
    // The leg along x at the point's own y, then the leg along y at the board's.
    {
      x0: Math.min(point.x, best.x) - h,
      x1: Math.max(point.x, best.x) + h,
      y0: point.y - h,
      y1: point.y + h,
    },
    {
      x0: best.x - h,
      x1: best.x + h,
      y0: Math.min(point.y, best.y) - h,
      y1: Math.max(point.y, best.y) + h,
    },
  ];
}

/**
 * Build the routing space for a document.
 *
 * @param {{boards:Array, components:Array, wires:Array}} doc a PLAIN document
 * @param {object} [opts]
 * @param {(comp:object) => ({minX,minY,width,height}|null)} [opts.bodyBox]
 * @param {object} [opts.config] a `makeRouteConfig` result
 * @param {Array<{x:number,y:number}>} [opts.extraPoints] world points that must
 *   be nodes — the off-board terminals wires actually end on
 * @returns {object} the frozen space (see the fields on the returned object)
 */
export function buildRouteSpace(doc, opts = {}) {
  const config = opts.config ?? ROUTE_CONFIG;
  const bodyBox = opts.bodyBox ?? null;
  const boards = doc.boards ?? [];

  const boardRects = boards.map((b) => {
    const r = boardRect(b);
    return rect(r.x, r.y, r.width, r.height);
  });
  const groups = regionComponents(boardRects);
  const bridges = buildBridges(groups);
  const extras = opts.extraPoints ?? [];
  for (const p of extras) {
    if (!boardRects.some((r) => covers(r, p.x, p.y))) {
      bridges.push(...terminalCorridor(p, boardRects));
    }
  }
  const regionRects = [...boardRects, ...bridges];

  // ── Tracks ──────────────────────────────────────────────────────────────
  const seedX = [];
  const seedY = [];
  for (const board of boards) {
    const rot = board.rot ?? 0;
    for (const hole of holes(board.type)) {
      const p = holePosition(board.type, hole, rot);
      if (!p) continue;
      seedX.push(board.x + p.x);
      seedY.push(board.y + p.y);
    }
  }
  for (const p of extras) {
    seedX.push(p.x);
    seedY.push(p.y);
  }
  // A hole track and a filler track are told apart because a wire on a track
  // with no holes covers no tie points — which is what a bench corridor IS.
  const holeX = new Set(seedX.map(q));
  const holeY = new Set(seedY.map(q));
  const xt = buildTracks(seedX, config.trackFillMax, config.minSeparation);
  const yt = buildTracks(seedY, config.trackFillMax, config.minSeparation);
  const xs = xt.coords;
  const ys = yt.coords;
  const nx = xs.length;
  const ny = ys.length;
  const xCorridor = xs.map((c) => !holeX.has(c));
  const yCorridor = ys.map((c) => !holeY.has(c));
  const xConflict = conflictRanges(xs, config.minSeparation);
  const yConflict = conflictRanges(ys, config.minSeparation);
  const xAt = new Map(xs.map((c, i) => [c, i]));
  const yAt = new Map(ys.map((c, i) => [c, i]));

  // ── Coverage ────────────────────────────────────────────────────────────
  const boardRowSpans = spansPerTrack(boardRects, ys, "x");
  const boardColSpans = spansPerTrack(boardRects, xs, "y");
  const rowSpans = spansPerTrack(regionRects, ys, "x");
  const colSpans = spansPerTrack(regionRects, xs, "y");

  // ── Nodes ───────────────────────────────────────────────────────────────
  const nodeKind = new Uint8Array(nx * ny);
  // Which board GROUP a node sits on (-1 off the boards). A bridge exists so a
  // wire can get from one group to another; this is what lets the router tell a
  // wire that needs one from a wire that would just be taking a short cut
  // through the empty air between two boards.
  const nodeGroup = new Int16Array(nx * ny).fill(-1);
  // Which BRIDGES a node belongs to, as a bitmask — a wire may use only the ones
  // that lie between its own two boards (see `bridgeMaskFor`).
  const nodeBridge = new Int32Array(nx * ny);
  const groupOf = new Map();
  groups.forEach((rects, i) => {
    for (const r of rects) groupOf.set(r, i);
  });
  const nodeBlockers = new Map();
  const obstacles = buildObstacles(doc, bodyBox);

  // ── Holes with something already in them ────────────────────────────────
  // A tie point with a lead standing in it is not free space. A wire lying flat
  // across the board cannot pass through the point where another wire plugs in,
  // or where a part's pin does — on a real bench the lead is physically in the
  // way. Routing over one is the single most obviously impossible thing the
  // router did: a run straight down a row of end caps.
  //
  // This is `occupancy.js`'s map, which is the app's one collision authority, so
  // the router cannot disagree with it about what is occupied. A wire's OWN two
  // ends are of course in it, and are exempted per wire by the caller.
  const leadNodes = new Set();
  for (const address of buildOccupancy(doc).keys()) {
    const p = addressWorld(boards, doc.components ?? [], address);
    if (!p) continue;
    const i = xAt.get(q(p.x));
    const j = yAt.get(q(p.y));
    if (i === undefined || j === undefined) continue;
    leadNodes.add(j * nx + i);
  }
  const inflated = obstacles.map((o) => ({
    id: o.id,
    rect: inflate(o.rect, config.inflation),
  }));
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const x = xs[i];
      const y = ys[j];
      const n = j * nx + i;
      const on = boardRects.find((r) => covers(r, x, y));
      if (on) {
        nodeKind[n] = ON_BOARD;
        nodeGroup[n] = groupOf.get(on) ?? -1;
      } else {
        let mask = 0;
        bridges.forEach((r, bi) => {
          if (bi < 31 && covers(r, x, y)) mask |= 1 << bi;
        });
        if (mask === 0) continue;
        nodeKind[n] = ON_BRIDGE;
        nodeBridge[n] = mask;
      }
      const hit = inflated.filter((o) => covers(o.rect, x, y)).map((o) => o.id);
      if (hit.length > 0) nodeBlockers.set(n, hit);
    }
  }

  // ── Edges ───────────────────────────────────────────────────────────────
  // Horizontal edge (j, i) runs along y track j from x track i to i+1.
  const hKind = new Uint8Array(ny * Math.max(0, nx - 1));
  const vKind = new Uint8Array(nx * Math.max(0, ny - 1));
  const hBlockers = new Map();
  const vBlockers = new Map();
  const segBlockers = (o, lo, hi, t, axis) => {
    const r = o.rect;
    return axis === "x"
      ? t >= r.y0 && t <= r.y1 && lo <= r.x1 && hi >= r.x0
      : t >= r.x0 && t <= r.x1 && lo <= r.y1 && hi >= r.y0;
  };
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx - 1; i += 1) {
      const e = j * (nx - 1) + i;
      const lo = xs[i];
      const hi = xs[i + 1];
      if (spanned(boardRowSpans[j], lo, hi)) hKind[e] = ON_BOARD;
      else if (spanned(rowSpans[j], lo, hi)) hKind[e] = ON_BRIDGE;
      else continue;
      const hit = inflated
        .filter((o) => segBlockers(o, lo, hi, ys[j], "x"))
        .map((o) => o.id);
      if (hit.length > 0) hBlockers.set(e, hit);
    }
  }
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny - 1; j += 1) {
      const e = i * (ny - 1) + j;
      const lo = ys[j];
      const hi = ys[j + 1];
      if (spanned(boardColSpans[i], lo, hi)) vKind[e] = ON_BOARD;
      else if (spanned(colSpans[i], lo, hi)) vKind[e] = ON_BRIDGE;
      else continue;
      const hit = inflated
        .filter((o) => segBlockers(o, lo, hi, xs[i], "y"))
        .map((o) => o.id);
      if (hit.length > 0) vBlockers.set(e, hit);
    }
  }

  return Object.freeze({
    config,
    xs,
    ys,
    nx,
    ny,
    xCorridor,
    yCorridor,
    xConflict,
    yConflict,
    nodeKind,
    nodeGroup,
    nodeBridge,
    nodeBlockers,
    leadNodes,
    hKind,
    vKind,
    hBlockers,
    vBlockers,
    obstacles,
    inflated,
    boardRects,
    bridges,
    regionRects,
    groups: groups.length,

    /** The node index of a world point, or -1 when it is not on the lattice. */
    nodeAt(x, y) {
      const i = xAt.get(q(x));
      const j = yAt.get(q(y));
      return i === undefined || j === undefined ? -1 : j * nx + i;
    },
    /** A node index back to world coordinates. */
    pointOf(n) {
      return { x: xs[n % nx], y: ys[Math.floor(n / nx)] };
    },
    colOf: (n) => n % nx,
    rowOf: (n) => Math.floor(n / nx),
    /** Horizontal / vertical edge indices. `i` is the LOWER x/y track. */
    hEdge: (j, i) => j * (nx - 1) + i,
    vEdge: (i, j) => i * (ny - 1) + j,
  });
}

/**
 * The obstacles a wire is allowed to ignore: exactly those whose inflated body
 * CONTAINS one of its own endpoints.
 *
 * The exemption exists because some parts cover the very holes they are wired
 * through — a resistor network's body stands over the rows beside its pins, and
 * a PSU terminal is a pad on the brick itself — so without it those wires could
 * not leave their own holes and would have no route at all.
 *
 * Stating it as "contains the endpoint" rather than "the wire is attached to
 * this part" is what keeps it tight. A chip's slab stops half a pitch short of
 * rows e and f, so a wire on that chip's node attaches OUTSIDE the body and the
 * chip is not exempt — which is the whole point, since a blanket
 * attached-to-it exemption would let a wire leaving pin 3 fly straight across
 * the chip it just left.
 *
 * @param {object} space a `buildRouteSpace` result
 * @param {Array<{x:number,y:number}>} points the wire's two endpoints
 * @returns {Set<string>} component ids
 */
export function exemptObstacles(space, points) {
  const out = new Set();
  for (const o of space.inflated) {
    if (points.some((p) => p && covers(o.rect, p.x, p.y))) out.add(o.id);
  }
  return out;
}

/**
 * The bridges a wire may cross, as a bitmask over `space.bridges`.
 *
 * A wire that spans two boards has to leave one of them, but that is no licence
 * to use EVERY gap on the desk. Given three stacked boards, a wire from the top
 * one to the middle one was free to dive into the gap BELOW the middle board and
 * run along it — an empty, part-free, hole-free lane, and by some distance the
 * cheapest real estate available. It produced exactly the routes that read as
 * "why has it gone all the way down there?".
 *
 * So only the gaps on a shortest path between the wire's own two boards are
 * open to it, plus — when one of its ends is a brick standing off the boards
 * altogether — the corridor out to that terminal.
 *
 * @param {object} space
 * @param {number} from  board group of one end, -1 when off the boards
 * @param {number} to    board group of the other
 * @returns {number} bitmask; 0 means "no bridge at all"
 */
export function bridgeMaskFor(space, from, to) {
  const bridges = space.bridges;
  // An end that is not on a board can only be reached through a corridor, and a
  // corridor joins no groups — so those are exactly the untagged bridges.
  const terminalMask = bridges.reduce(
    (m, r, i) => (i < 31 && !r.joins ? m | (1 << i) : m),
    0,
  );
  if (from < 0 || to < 0) return -1; // a brick lead: every corridor is fair game
  if (from === to) return 0;

  // Shortest paths through the graph of groups joined by gaps.
  const adjacency = new Map();
  bridges.forEach((r, i) => {
    if (!r.joins || i >= 31) return;
    const [a, b] = r.joins;
    if (!adjacency.has(a)) adjacency.set(a, []);
    if (!adjacency.has(b)) adjacency.set(b, []);
    adjacency.get(a).push([b, i]);
    adjacency.get(b).push([a, i]);
  });
  const sweep = (start) => {
    const dist = new Map([[start, 0]]);
    const queue = [start];
    for (let k = 0; k < queue.length; k += 1) {
      const at = queue[k];
      for (const [next] of adjacency.get(at) ?? []) {
        if (dist.has(next)) continue;
        dist.set(next, dist.get(at) + 1);
        queue.push(next);
      }
    }
    return dist;
  };
  const fromStart = sweep(from);
  const fromGoal = sweep(to);
  const span = fromStart.get(to);
  if (span === undefined) return terminalMask; // not reachable board to board
  let mask = terminalMask;
  bridges.forEach((r, i) => {
    if (!r.joins || i >= 31) return;
    const [a, b] = r.joins;
    const ab =
      (fromStart.get(a) ?? Infinity) + 1 + (fromGoal.get(b) ?? Infinity);
    const ba =
      (fromStart.get(b) ?? Infinity) + 1 + (fromGoal.get(a) ?? Infinity);
    if (ab === span || ba === span) mask |= 1 << i;
  });
  return mask;
}
