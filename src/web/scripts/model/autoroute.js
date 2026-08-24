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

// autoroute.js — route every wire on the desk (Feature 360).
//
// `route-space.js` says where a wire may be and `route-search.js` finds one wire
// a path; this decides WHICH wire goes where, which is the part that makes a
// desk look built rather than merely connected.
//
// THE ORDERING PROBLEM, AND WHY ORDERING IS NOT THE ANSWER. Route wire A then
// wire B and A takes the good corridor for no better reason than that its id is
// smaller; B detours around a choice nobody made. Sorting by difficulty only
// changes who gets the unearned advantage. The fix is NEGOTIATED CONGESTION
// (McMurchie & Ebeling's PathFinder): route everything, find the edges more than
// one wire wants, raise a PERSISTENT history cost on those edges, throw every
// route away and do it again. An edge two wires both want grows more expensive
// for BOTH of them, round on round, until the one with a cheap alternative
// leaves and the one with no alternative stays. History only ever rises, so it
// converges; and because both the wire order and the search are deterministic,
// it converges to the same answer every time.
//
// The initial order is therefore a SEED, not a verdict — most-boxed-in first,
// because a wire with one way out that is routed last has none.
//
// THE ESCALATION LADDER. Hard obstacles can genuinely box a wire in: chips
// seated edge to edge across a board leave no way between the halves except
// round the ends, and if those are taken there is no way at all. A router that
// shrugs at that is worse than one that says so, so each wire gets, in order:
// the honest attempt; a straighter retry when the route came back over the
// twenty-waypoint limit the file format imposes; an attempt with part bodies
// demoted from hard to merely expensive (which is what a person does when boxed
// in — they run the lead over the chip); and failing all three, it is left
// exactly as it was and named in the report. Nothing is ever silently mangled.
//
// THE ONE THING THAT IS NOT JUST A DRAWING. A power lead's rail end is moved to
// a nearer free hole on the same net before any routing starts
// (`rail-reseat.js`) — the one address change the router makes, because a
// stretched supply wire is not a path problem and no route can fix it. It is
// verified against the netlist rather than argued for; everything else here
// leaves the addresses exactly as it found them.
//
// Pure and DOM-free: a plain document in, a plan out. Nothing here mutates the
// document, and a waypoint is only ever a drawing — the netlist cannot see one,
// so no route this file produces can change what the circuit does.
//
// ROUTING IS SLOW ENOUGH TO NEED INTERRUPTING, which is why the work is written
// once as a GENERATOR (`routeDeskSteps`) and driven twice: `routeDesk` runs it
// to completion synchronously, which is what every test and the corpus use, and
// `routeDeskAsync` runs it in slices, yielding to the host between them so the
// window keeps painting and a Cancel button keeps working. Two drivers, one
// implementation — the alternative is a second copy of the negotiation loop
// that can silently disagree with the first.

import { addressWorld } from "./part-geometry.js";
import { MAX_WIRE_POINTS } from "./desk-doc.js";
import { formatAddress, holesOfNode, nodeOf, parseAddress } from "./breadboard.js"; // prettier-ignore
import { planRailReseats, withReseats } from "./rail-reseat.js";
import { ROUTE_CONFIG } from "./route-config.js";
import { OUTSIDE, ON_BOARD, ON_BRIDGE, bridgeMaskFor, buildRouteSpace, exemptObstacles } from "./route-space.js"; // prettier-ignore
import { findRoute, pathCorners } from "./route-search.js";

/** Why a wire was left alone. Stable, English, never translated — these are
    codes a report quotes, in the shape `desk-review.js` uses for the same job. */
export const SKIP_BUS_MEMBER = "BUS_MEMBER";
export const SKIP_UNRESOLVED = "UNRESOLVED_ENDPOINT";
export const SKIP_OFF_LATTICE = "ENDPOINT_OFF_LATTICE";
export const SKIP_NO_PATH = "NO_LEGAL_PATH";

/** How a route was arrived at, worst last — the escalation ladder's rungs. */
export const VIA_DIRECT = "direct";
export const VIA_STRAIGHTENED = "straightened";
export const VIA_OVER_PART = "over-part";

/** A wire id's number, for a deterministic order that reads the way the ids do
    (`w2` before `w10`, which a string sort gets backwards). */
const idNumber = (id) => Number.parseInt(String(id).slice(1), 10) || 0;

/**
 * The mutable state one round shares: who is on which edge, who passes through
 * which node in which direction, and the history that outlives the round.
 */
function makeOccupancy() {
  return {
    h: new Map(), // horizontal edge index → Set<wireId>
    v: new Map(), // vertical edge index   → Set<wireId>
    pass: new Map(), // node index → [Set<wireId> horizontal, Set<wireId> vertical]
  };
}

const addTo = (map, key, id) => {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(id);
};

const dropFrom = (map, key, id) => {
  const s = map.get(key);
  if (!s) return;
  s.delete(id);
  if (s.size === 0) map.delete(key);
};

/** Walk a node path, reporting each edge and each pass-through so occupancy and
    the cost breakdown are derived from ONE traversal rule rather than two that
    could disagree. */
function walkRoute(space, nodes, visit) {
  const { nx } = space;
  let prevAxis = -1;
  for (let k = 1; k < nodes.length; k += 1) {
    const a = nodes[k - 1];
    const b = nodes[k];
    const ai = a % nx;
    const aj = Math.floor(a / nx);
    const bi = b % nx;
    const bj = Math.floor(b / nx);
    const axis = aj === bj ? 0 : 1;
    const edge =
      axis === 0
        ? space.hEdge(aj, Math.min(ai, bi))
        : space.vEdge(ai, Math.min(aj, bj));
    const len =
      axis === 0
        ? Math.abs(space.xs[bi] - space.xs[ai])
        : Math.abs(space.ys[bj] - space.ys[aj]);
    visit({ axis, edge, len, from: a, to: b, through: prevAxis === axis ? a : -1, turned: prevAxis >= 0 && prevAxis !== axis }); // prettier-ignore
    prevAxis = axis;
  }
}

/** Put a route into the occupancy structure (or take it out again). */
function occupy(space, occ, id, nodes, add) {
  walkRoute(space, nodes, ({ axis, edge, through }) => {
    const map = axis === 0 ? occ.h : occ.v;
    if (add) addTo(map, edge, id);
    else dropFrom(map, edge, id);
    if (through < 0) return;
    let pair = occ.pass.get(through);
    if (!pair) occ.pass.set(through, (pair = [new Set(), new Set()]));
    if (add) pair[axis].add(id);
    else pair[axis].delete(id);
  });
}

/**
 * Put the wires the router does NOT own onto the grid, so they can be routed
 * around rather than through.
 *
 * A bus member keeps its ribbon, a wire outside the selection keeps its shape,
 * and a wire the router failed to place keeps whatever it had — but all three
 * are still wire lying on the desk. Left out of the occupancy they are invisible,
 * and "auto-route the selection" would cheerfully lay every new run straight over
 * the wiring already there.
 *
 * They are marked by PROXIMITY rather than by exact intersection, because a
 * sagging chord is not on the lattice at all: every node within a clearance of
 * the drawn shape records a pass-through on that segment's own axis (so a route
 * crossing it pays the crossing), and every edge with BOTH ends that close
 * records occupancy (so a route running ALONGSIDE it pays the overload). One
 * scan, both effects, and the same two costs a routed wire would have earned.
 *
 * They are never given a route, so nothing can rip them up: they are terrain.
 */
function seedStatic(space, occ, shapes) {
  const cfg = space.config;
  const reach = cfg.minSeparation;
  for (const { id, points } of shapes) {
    const near = new Set();
    for (let k = 1; k < points.length; k += 1) {
      const a = points[k - 1];
      const b = points[k];
      const axis = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 0 : 1;
      const x0 = Math.min(a.x, b.x) - reach;
      const x1 = Math.max(a.x, b.x) + reach;
      const y0 = Math.min(a.y, b.y) - reach;
      const y1 = Math.max(a.y, b.y) + reach;
      for (let i = 0; i < space.nx; i += 1) {
        if (space.xs[i] < x0 || space.xs[i] > x1) continue;
        for (let j = 0; j < space.ny; j += 1) {
          if (space.ys[j] < y0 || space.ys[j] > y1) continue;
          if (pointToSegment(space.xs[i], space.ys[j], a, b) > reach) continue;
          const n = j * space.nx + i;
          near.add(n);
          let pair = occ.pass.get(n);
          if (!pair) occ.pass.set(n, (pair = [new Set(), new Set()]));
          pair[axis].add(id);
        }
      }
    }
    // An edge whose two ends are both alongside the static wire is a stretch of
    // run this wire has already taken.
    for (const n of near) {
      const i = n % space.nx;
      const j = Math.floor(n / space.nx);
      if (i + 1 < space.nx && near.has(n + 1)) addTo(occ.h, space.hEdge(j, i), id); // prettier-ignore
      if (j + 1 < space.ny && near.has(n + space.nx)) addTo(occ.v, space.vEdge(i, j), id); // prettier-ignore
    }
  }
}

/** Distance from a point to a segment — the only square root in the file, and
    it is in the terrain scan rather than in any cost the search compares. */
function pointToSegment(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((px - a.x) * dx + (py - a.y) * dy) / len2;
  const c = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + dx * c), py - (a.y + dy * c));
}

/**
 * Which OTHER wires this route lies along — the collinear case, where two wires
 * draw as one line and nothing shows which of them turned off.
 *
 * It answers with the rivals rather than a yes/no because that is what the
 * hardening pass needs. Re-routing a wire while forbidding every edge ANY other
 * wire touches is hopeless on a real board — measured on the demo corpus it
 * failed every single time, because a wire cannot even leave its own hole when
 * another run passes through it. Forbidding only the wires it is actually
 * doubled up with is the same fix, asked for at the scale of the problem.
 */
function sharedWith(space, occ, id, nodes) {
  const rivals = new Set();
  walkRoute(space, nodes, ({ axis, edge }) => {
    const users = (axis === 0 ? occ.h : occ.v).get(edge);
    if (!users) return;
    for (const other of users) if (other !== id) rivals.add(other);
  });
  return rivals;
}

/**
 * What an EXISTING route would cost if it were being chosen now.
 *
 * The hardening pass has to compare the route a wire already has against one it
 * could move to, and the cost recorded when it was routed is no basis for that:
 * it was computed part-way through a round, against a board holding only the
 * wires placed before it. By the time the pass runs the board is full, and a
 * wire that was cheap when it was laid may since have been crossed six times
 * over. Comparing a fresh number with that stale one is how a plainly better
 * route gets refused — measured on a real desk, it was the single biggest source
 * of routes nobody would have drawn by hand.
 *
 * Mirrors the step accounting in `route-search.js`. A REVERSAL reads here as a
 * pass-through rather than two turns; a shortest path does not contain one, and
 * the alternative is threading headings through `walkRoute` for a case that
 * cannot arise.
 */
function costOfPath(space, model, nodes) {
  let total = 0;
  walkRoute(space, nodes, ({ axis, edge, len, from, to, through, turned }) => {
    total += model.edgeCost(axis, edge, len) + model.enterCost(from, to);
    if (through >= 0) total += model.crossCost(through, axis);
    else if (turned) total += model.turnCost;
  });
  return total;
}

/** How much of this route (in pitch) runs along an edge another wire is on.
    The quantity the hardening pass must strictly reduce — moving a wire off one
    rival is no gain if it lands on the next, and a yes/no answer cannot tell
    those apart. */
function sharedLength(space, occ, id, nodes) {
  let total = 0;
  walkRoute(space, nodes, ({ axis, edge, len }) => {
    const users = (axis === 0 ? occ.h : occ.v).get(edge);
    if (!users) return;
    for (const other of users) {
      if (other !== id) {
        total += len;
        break;
      }
    }
  });
  return total;
}

/**
 * The cost model for ONE wire in the current state of the board.
 *
 * Everything the feature plan lists as a soft cost is here and nowhere else, so
 * the router's priorities can be read (and argued with) in one place. The two
 * BONUSES are discounts against a baseline of 1.0 floored at
 * `minEdgeCostPerUnit`, which route-search.js also uses to scale its heuristic —
 * negative edge weights would otherwise cost the search its optimality.
 */
function costModelFor(
  space,
  occ,
  history,
  wireId,
  exempt,
  softBodies,
  pressure = 1,
  avoid = null,
  bridgeMask = -1,
  ownNodes = null,
) {
  // prettier-ignore
  const cfg = space.config;
  const { nx, ny } = space;
  const hSpan = Math.max(1, nx - 1);
  const vSpan = Math.max(1, ny - 1);
  const trackOf = (axis, e) => Math.floor(e / (axis === 0 ? hSpan : vSpan));
  const spanOf = (axis, e) => e % (axis === 0 ? hSpan : vSpan);
  const edgeAt = (axis, track, span) =>
    track * (axis === 0 ? hSpan : vSpan) + span;

  const blockersOf = (axis, e) =>
    axis === 0 ? space.hBlockers.get(e) : space.vBlockers.get(e);
  const allExempt = (list) => !list || list.every((id) => exempt.has(id));

  const usersAt = (axis, e) => {
    const s = (axis === 0 ? occ.h : occ.v).get(e);
    if (!s) return 0;
    return s.has(wireId) ? s.size - 1 : s.size;
  };

  /** Is one of the wires this route is being kept away from on this edge? */
  const avoided = (axis, e) => {
    const s = (axis === 0 ? occ.h : occ.v).get(e);
    if (!s) return false;
    for (const other of s)
      if (other !== wireId && avoid.has(other)) return true;
    return false;
  };

  /**
   * How much OTHER wire is already lying where this edge goes: its own users,
   * plus anyone on a track too close to clear it. The second half is the
   * clearance check the grid cannot make structurally, since two separately
   * placed boards can sit at any offset at all.
   *
   * `edgeCost` prices this and `edgeOpen` can FORBID it — the two must read the
   * same number, or a route could be admitted and then charged for something the
   * gate said was not there.
   */
  const loadAt = (axis, e) => {
    const track = trackOf(axis, e);
    const span = spanOf(axis, e);
    const conflict = axis === 0 ? space.yConflict : space.xConflict;
    let load = usersAt(axis, e);
    for (let t = conflict.lo[track]; t <= conflict.hi[track]; t += 1) {
      if (t !== track) load += usersAt(axis, edgeAt(axis, t, span));
    }
    return load;
  };

  return {
    nodeOpen(n) {
      if (space.nodeKind[n] === OUTSIDE) return false;
      // The air between two boards is not a short cut. A wire may go out there
      // only when it genuinely has to, and then only through the gaps that lie
      // between its OWN two boards — never a gap somewhere else on the desk
      // that merely happens to be empty (see bridgeMaskFor).
      if (
        space.nodeKind[n] === ON_BRIDGE &&
        (space.nodeBridge[n] & bridgeMask) === 0
      ) {
        return false;
      }
      // A tie point with a lead already standing in it is not free space: a
      // wire lying flat across the board cannot pass through the point where
      // another one plugs in. Its OWN two ends are the exception, since it has
      // to reach them.
      if (!softBodies && space.leadNodes.has(n) && !ownNodes?.has(n)) {
        return false;
      }
      const list = space.nodeBlockers.get(n);
      return softBodies || allExempt(list);
    },
    edgeOpen(axis, e) {
      const kind = axis === 0 ? space.hKind[e] : space.vKind[e];
      if (kind === OUTSIDE) return false;
      // Two wires along one edge are COLLINEAR — they draw as a single line,
      // and where one turns off there is nothing to say which of them did. A
      // price cannot fix that (the whole defect is that you cannot see it), so
      // the hardening pass forbids the specific wires this one is doubled up
      // with, and falls back only when there is no other way through.
      if (avoid) {
        if (avoided(axis, e)) return false;
        const track = trackOf(axis, e);
        const span = spanOf(axis, e);
        const conflict = axis === 0 ? space.yConflict : space.xConflict;
        for (let t = conflict.lo[track]; t <= conflict.hi[track]; t += 1) {
          if (t !== track && avoided(axis, edgeAt(axis, t, span))) return false;
        }
      }
      return softBodies || allExempt(blockersOf(axis, e));
    },
    edgeCost(axis, e, len) {
      const track = trackOf(axis, e);
      const span = spanOf(axis, e);
      const conflict = axis === 0 ? space.yConflict : space.xConflict;
      const corridor =
        axis === 0 ? space.yCorridor[track] : space.xCorridor[track];
      const load = loadAt(axis, e);

      // Bundling: a neighbouring PARALLEL track carrying a wire over this same
      // span makes this edge cheaper, which is what collects wires into shared
      // corridors instead of letting each take a private optimum. Only a
      // neighbour far enough away to be legal counts — one inside the conflict
      // range is already being charged for above, and rewarding it too would be
      // perverse.
      let bundled = false;
      for (const t of [track - 1, track + 1]) {
        if (t < 0) continue;
        if (axis === 0 ? t >= ny : t >= nx) continue;
        if (t >= conflict.lo[track] && t <= conflict.hi[track]) continue;
        if (usersAt(axis, edgeAt(axis, t, span)) > 0) bundled = true;
      }

      let unit = cfg.lengthCost;
      if (bundled) unit -= cfg.bundleBonus;
      if (corridor) unit -= cfg.corridorBonus;
      unit = Math.max(cfg.minEdgeCostPerUnit, unit);

      // A bridge is not board: it is the air between two of them, and it costs
      // for every pitch you spend out there, not just to step into it.
      const offBoard =
        (axis === 0 ? space.hKind[e] : space.vKind[e]) === ON_BRIDGE;
      const hist = history.get(axis === 0 ? `h${e}` : `v${e}`) ?? 0;
      // `pressure` ramps the present-congestion term across rounds — the other
      // half of PathFinder. Early rounds route as if the board were empty, which
      // is what lets each wire find the shape it actually wants; later rounds
      // squeeze, so the wires that have somewhere else to go leave first and the
      // one with nowhere is the one still there at the end. Enforcing it hard
      // from round 1 just freezes in whatever the first arrival happened to do.
      let cost =
        len * unit * (1 + hist) +
        len * cfg.overloadCost * pressure * load +
        (offBoard ? len * cfg.gapCostPerUnit : 0);
      if (softBodies && !allExempt(blockersOf(axis, e))) {
        cost += cfg.overPartCost;
      }
      return cost;
    },
    crossCost(n, axis) {
      const pair = occ.pass.get(n);
      if (!pair) return 0;
      // A crossing is the PERPENDICULAR traffic through this node: two wires
      // that both run straight through, one across the other.
      const other = pair[axis === 0 ? 1 : 0];
      const n2 = other.has(wireId) ? other.size - 1 : other.size;
      return n2 * cfg.crossWireCost;
    },
    enterCost(from, to) {
      return space.nodeKind[from] === ON_BOARD &&
        space.nodeKind[to] === ON_BRIDGE
        ? cfg.gapCrossCost
        : 0;
    },
    turnCost: cfg.bendCost,
    minUnitCost: cfg.minEdgeCostPerUnit,
  };
}

/** Route one wire, walking the escalation ladder. Returns null only when even
    the last rung fails. */
function routeOne(space, occ, history, job, pressure = 1, avoid = null) {
  const cfg = space.config;
  // With sharing forbidden there is no point demoting part bodies: the two
  // relaxations answer different problems, and mixing them would trade a
  // visible defect for a worse one. A caller that gets null here falls back to
  // the ordinary ladder.
  const attempts = avoid
    ? [
        { softBodies: false, bendScale: 1, via: VIA_DIRECT },
        { softBodies: false, bendScale: cfg.bendBudgetRetryFactor, via: VIA_STRAIGHTENED }, // prettier-ignore
      ]
    : [
        { softBodies: false, bendScale: 1, via: VIA_DIRECT },
        { softBodies: false, bendScale: cfg.bendBudgetRetryFactor, via: VIA_STRAIGHTENED }, // prettier-ignore
        { softBodies: true, bendScale: 1, via: VIA_OVER_PART },
      ];
  for (const attempt of attempts) {
    const model = costModelFor(space, occ, history, job.id, job.exempt, attempt.softBodies, pressure, avoid, job.bridgeMask, job.ownNodes); // prettier-ignore
    model.turnCost = cfg.bendCost * attempt.bendScale;
    // THE WHOLE GRID, always. There used to be a search WINDOW here — the
    // endpoints' bounding box plus a margin — widened only when the search came
    // back empty. It silently cost quality: a route that is merely WORSE inside
    // the window is still a route, so the widening never fired, and a far better
    // path just outside was never considered. On a real desk one wire cost 200
    // through seven crossings while a route round the end of the board, outside
    // the window, cost 116 and crossed nothing.
    //
    // Searching it all is affordable because the search's scratch is reused
    // rather than reallocated (route-search.js) — that, not the extent of the
    // grid, was where the time was going.
    {
      const found = findRoute(space, {
        ...model,
        start: job.start,
        goal: job.goal,
      });
      if (!found) continue;
      const corners = pathCorners(space, found.nodes);
      // The waypoint cap is the FILE FORMAT's, not the UI's: normalizeDocument
      // truncates at twenty on load, so a longer route would round-trip through
      // a save as a shorter one joined by a straight line through whatever is in
      // the way. Over the cap is a failed attempt, not a route to trim — so it
      // falls THROUGH to the next rung, which is the whole reason rung 2 exists
      // (`bendCost × 8`: buy a straighter, longer route). It used to `break`,
      // abandoning the ladder at the one rung written for this exact failure,
      // and a wire that needed twenty-one corners was reported as having no
      // legal path at all.
      if (corners.length - 2 > MAX_WIRE_POINTS) continue;
      return { ...found, corners, via: attempt.via };
    }
  }
  return null;
}

/** A grid node — one column-half, five holes. A RAIL node (`+` / `-`) is the
    whole strip and belongs to the pre-pass, not to this. */
const GRID_NODE = /^c\d+[LU]$/;

/**
 * The other holes a wire's end could sit in without changing one thing about
 * the circuit: the rest of its own five-hole column-half.
 *
 * This needs no netlist check and no argument. Those five holes are not merely
 * the same NET, they are the same NODE — the strip of copper inside the board
 * that joins them — so a lead moved from `a12` to `d12` is connected to exactly
 * what it was connected to before, and there is no wiring anywhere on the desk
 * that could make that false.
 *
 * What it buys is the ROW. Every occupied hole is a hard obstacle, so which of
 * the five a lead stands in decides whether the run leaves cleanly or has to
 * climb out past the neighbouring leads first.
 *
 * @returns {Array<{node:number, address:string}>} the current hole included, and
 *   empty for an end this pass may not touch (a rail hole, a brick terminal, a
 *   hole whose board is gone).
 */
function nodeAlternatives(space, doc, address) {
  const parsed = parseAddress(address);
  if (!parsed) return [];
  const board = (doc.boards ?? []).find((b) => b?.id === parsed.boardId);
  if (!board) return []; // a brick terminal stands alone
  const node = nodeOf(board.type, parsed.hole);
  if (!node || !GRID_NODE.test(node)) return [];
  const out = [];
  for (const hole of holesOfNode(board.type, node) ?? []) {
    const at = formatAddress(board.id, hole);
    const p = addressWorld(doc.boards, doc.components ?? [], at);
    if (!p) continue;
    const n = space.nodeAt(p.x, p.y);
    if (n >= 0) out.push({ node: n, address: at });
  }
  return out;
}

/** Rungs of the escalation ladder, worst last — so a swap can be told to prefer
    a route that needed no compromise over one that did, which a cost alone
    cannot say (an over-part route's price is not in `costOfPath`). */
const RUNG = { [VIA_DIRECT]: 0, [VIA_STRAIGHTENED]: 1, [VIA_OVER_PART]: 2 };

/**
 * Offer every wire the other holes of its own tie-point strip, and keep the
 * swap when the route it buys is strictly better.
 *
 * Everything else in this file draws a better line between two fixed points.
 * This is the one pass that questions the points — and it is allowed to because
 * the alternatives are the same NODE, so nothing electrical can move (see
 * `nodeAlternatives`). It is the general half of what `rail-reseat.js` does for
 * power leads, at the scale a signal wire actually has: five holes, not fifty.
 *
 * Three things keep it from trading one defect for another:
 *
 *  · **A lead is never planted under a run.** A free hole is only free from the
 *    router's point of view if nothing is drawn across it — so a candidate whose
 *    node any other route (or any piece of TERRAIN) touches is refused. The hole
 *    the wire vacates needs no such care: freeing one can only help.
 *  · **The ladder rung may not get worse.** A swap that turns a clean route into
 *    one over a chip is not an improvement however it prices, and
 *    `costOfPath` cannot see the difference because the over-part charge lives
 *    in the search's own edge cost.
 *  · **Collinear run may not grow.** The hardening pass above spends its whole
 *    effort on that, and a swap that quietly gives it back would make the two
 *    passes fight.
 *
 * ONE END AT A TIME, deliberately: the cross product of two five-hole nodes is
 * twenty-five routing attempts per wire per sweep, and the pass is already the
 * most expensive thing here. Moving each end in turn finds nearly all of it —
 * the two ends are rarely both wrong — for a quarter of the searches.
 *
 * `vacated` is what makes the result APPLICABLE. A swap frees the hole it came
 * from, and the next wire along would happily claim it — but the document is
 * written one endpoint at a time, and `setWireEndpoint` refuses a hole that is
 * still occupied by the wire that has not moved out of it yet. Rather than
 * teach the writer to order a chain of moves (and to give up on a cycle, where
 * two wires want each other's holes and neither can go first), a hole a swap
 * has vacated is simply never offered to anyone else. The plan is then
 * order-independent by construction, which is the same discipline
 * `rail-reseat.js` keeps by only ever claiming holes free in the original doc.
 */
function* swapEnds(
  space,
  occ,
  history,
  jobs,
  found,
  pressure,
  swaps,
  vacated,
  label,
) {
  // prettier-ignore
  // Which nodes are spoken for by something DRAWN, as opposed to something
  // plugged in: `space.leadNodes` answers the second, this answers the first.
  const drawn = new Map();
  for (const [id, route] of found) {
    for (const n of route.nodes) addTo(drawn, n, id);
  }
  let changed = 0;
  let swept = 0;
  for (const job of jobs) {
    swept += 1;
    yield { ...label, done: swept, total: jobs.length };
    const current = found.get(job.id);
    if (!current) continue;
    if (job.altFrom.length + job.altTo.length <= 2) continue;

    occupy(space, occ, job.id, current.nodes, false);
    for (const n of current.nodes) dropFrom(drawn, n, job.id);
    // Its own two holes stop being obstacles while the alternatives are weighed
    // — it is about to be standing in one of them either way.
    space.leadNodes.delete(job.start);
    space.leadNodes.delete(job.goal);

    const live = costModelFor(space, occ, history, job.id, job.exempt, false, pressure, null, job.bridgeMask, job.ownNodes); // prettier-ignore
    let keep = current;
    let keepCost = costOfPath(space, live, current.nodes);
    let keepShared = sharedLength(space, occ, job.id, current.nodes);
    let keepStart = job.start;
    let keepGoal = job.goal;
    let keepExempt = job.exempt;
    // Per END, because both of them may move and each is its own address
    // change. Recording only the last one wrote a route drawn for a hole the
    // wire was never moved into, and left the hole it HAD looking free.
    const moved = { from: null, to: null };

    const taken = (n) =>
      space.leadNodes.has(n) ||
      (vacated.has(n) && vacated.get(n) !== job.id) ||
      (drawn.get(n)?.size ?? 0) > 0 ||
      (occ.pass.get(n)?.some((s) => s.size > 0) ?? false);

    for (const end of ["from", "to"]) {
      const alts = end === "from" ? job.altFrom : job.altTo;
      for (const alt of alts) {
        const start = end === "from" ? alt.node : keepStart;
        const goal = end === "from" ? keepGoal : alt.node;
        if (start === goal) continue;
        if (start === keepStart && goal === keepGoal) continue;
        if (taken(alt.node)) continue;
        const ownNodes = new Set([start, goal]);
        const trial = {
          ...job,
          start,
          goal,
          ownNodes,
          exempt: exemptObstacles(space, [
            space.pointOf(start),
            space.pointOf(goal),
          ]),
        };
        const cand = routeOne(space, occ, history, trial, pressure);
        if (!cand) continue;
        if (RUNG[cand.via] > RUNG[keep.via]) continue;
        const shared = sharedLength(space, occ, job.id, cand.nodes);
        if (shared > keepShared) continue;
        const cost = costOfPath(space, live, cand.nodes);
        if (RUNG[cand.via] === RUNG[keep.via] && cost >= keepCost) continue;
        keep = cand;
        keepCost = cost;
        keepShared = shared;
        keepStart = start;
        keepGoal = goal;
        keepExempt = trial.exempt;
        moved[end] = alt.address;
      }
    }

    if (moved.from || moved.to) {
      changed += 1;
      // Before `job.start`/`job.goal` are reassigned: the hole being GIVEN UP is
      // the one they still name, and it is what has to be marked vacated.
      for (const end of ["from", "to"]) {
        if (!moved[end]) continue;
        const key = end === "from" ? "fromAddress" : "toAddress";
        swaps.push({ wireId: job.id, end, from: job[key], to: moved[end] });
        job[key] = moved[end];
        vacated.set(end === "from" ? job.start : job.goal, job.id);
      }
      job.start = keepStart;
      job.goal = keepGoal;
      job.ownNodes = new Set([keepStart, keepGoal]);
      job.exempt = keepExempt;
      // The node it can move within has not changed — only which of its holes
      // it is standing in — so the alternatives list stays as it was.
    }
    found.set(job.id, keep);
    occupy(space, occ, job.id, keep.nodes, true);
    for (const n of keep.nodes) addTo(drawn, n, job.id);
    space.leadNodes.add(job.start);
    space.leadNodes.add(job.goal);
  }
  return changed;
}

/** A wire's cost broken out, so a route can be argued with rather than trusted. */
function describeRoute(space, occ, history, job, found) {
  const cfg = space.config;
  const model = costModelFor(space, occ, history, job.id, job.exempt, found.via === VIA_OVER_PART); // prettier-ignore
  const out = {
    // Re-priced under the CURRENT occupancy, so the total agrees with the
    // breakdown beside it. `found.cost` is what the search paid when the wire
    // was laid, against a board holding only the wires placed before it — a
    // useful number for the search and a misleading one in a report.
    total: 0,
    length: 0,
    bends: 0,
    crossings: 0,
    overlap: 0,
    corridor: 0,
    gap: 0,
    overPart: 0,
  };
  let lengthUnits = 0;
  walkRoute(
    space,
    found.nodes,
    ({ axis, edge, len, from, to, through, turned }) => {
      // prettier-ignore
      lengthUnits += len;
      out.length += len * cfg.lengthCost;
      if (turned) out.bends += cfg.bendCost;
      if (through >= 0) out.crossings += model.crossCost(through, axis);
      const users = (axis === 0 ? occ.h : occ.v).get(edge);
      const others = users ? users.size - (users.has(job.id) ? 1 : 0) : 0;
      if (others > 0) out.overlap += len * cfg.overloadCost * others;
      const track =
        axis === 0
          ? Math.floor(edge / Math.max(1, space.nx - 1))
          : Math.floor(edge / Math.max(1, space.ny - 1));
      if (axis === 0 ? space.yCorridor[track] : space.xCorridor[track]) {
        out.corridor += len * cfg.corridorBonus;
      }
      out.gap += model.enterCost(from, to);
      const blockers = axis === 0 ? space.hBlockers.get(edge) : space.vBlockers.get(edge); // prettier-ignore
      if (blockers && !blockers.every((id) => job.exempt.has(id))) {
        out.overPart += cfg.overPartCost;
      }
    },
  );
  out.total = costOfPath(space, model, found.nodes);
  return { cost: out, lengthUnits, bends: found.bends, via: found.via };
}

/**
 * Give every wire its own plane (Feature 360).
 *
 * The routing grid IS the board's hole lattice, and its lanes sit one pitch
 * apart because that is the finest spacing 1.5 mm wire can clear. A dense board
 * has fewer lanes than wires, so runs have to share one — and two runs sharing a
 * lane land on exactly the same line. They then draw as a single wire, and where
 * one turns off there is nothing at all to say which of them did it. No amount
 * of routing cost fixes that: the alternatives are genuinely worse, which is why
 * raising the overlap penalty twentyfold moves the count by nothing.
 *
 * A real board does not have the problem, because real jumpers arch at different
 * HEIGHTS: look down on a well-wired bench and no two wires are ever exactly
 * collinear, and each leaves its hole at a slight angle before settling parallel
 * to the board. This is that, in two dimensions — the runs sharing a lane are
 * fanned out either side of it, so each is its own line.
 *
 * Two things keep it honest:
 *
 *   · THE ENDS DO NOT MOVE. A wire still terminates exactly on its hole; only
 *     the run between is nudged, so the first and last segments pick up the
 *     short angled lead-in a real lead has leaving its hole. That is the
 *     transition the routing requirements always allowed for.
 *
 *   · THE NUDGE STAYS INSIDE THE CLEARANCE. An obstacle was inflated by half a
 *     wire plus its clearance before the route was found, so a run displaced by
 *     less than that cannot be pushed into a part.
 *
 * Deterministic: runs are fanned in wire-id order, so the same desk always fans
 * the same way.
 */
function separateLanes(routes, config) {
  const step = config.laneOffset;
  if (!(step > 0)) return;

  // Every straight RUN on the desk, tagged with the lane it sits on. A run's
  // lane is its constant coordinate: y for a horizontal run, x for a vertical.
  const runs = [];
  for (const [id, route] of routes) {
    const pts = [route.ends[0], ...route.points, route.ends[1]];
    route.pts = pts;
    route.offsets = new Array(pts.length - 1).fill(0);
    for (let i = 1; i < pts.length; i += 1) {
      const a = pts[i - 1];
      const b = pts[i];
      const horizontal = Math.abs(a.y - b.y) < 1e-9;
      runs.push({
        id,
        route,
        seg: i - 1,
        axis: horizontal ? 0 : 1,
        lane: horizontal ? a.y : a.x,
        lo: Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y),
        hi: Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y),
      });
    }
  }

  // Group by lane, then by overlapping span within it: two runs on one lane that
  // never overlap are already two separate lines and want no nudging at all.
  const lanes = new Map();
  for (const run of runs) {
    const key = `${run.axis}:${run.lane}`;
    if (!lanes.has(key)) lanes.set(key, []);
    lanes.get(key).push(run);
  }
  for (const group of lanes.values()) {
    group.sort((a, b) => a.lo - b.lo || idNumber(a.id) - idNumber(b.id) || a.seg - b.seg); // prettier-ignore
    let cluster = [];
    let reach = -Infinity;
    const flush = () => {
      if (cluster.length > 1) {
        // Fan the sharers about the lane, widest first so the middle of an odd
        // cluster stays exactly on it — the lane keeps meaning what it says.
        const members = [...cluster].sort(
          (a, b) => idNumber(a.id) - idNumber(b.id) || a.seg - b.seg,
        );
        const spread = Math.min(step, (2 * config.laneOffsetMax) / (members.length - 1)); // prettier-ignore
        members.forEach((run, i) => {
          run.route.offsets[run.seg] = (i - (members.length - 1) / 2) * spread;
        });
      }
      cluster = [];
      reach = -Infinity;
    };
    for (const run of group) {
      if (run.lo >= reach - 1e-9) flush();
      cluster.push(run);
      reach = Math.max(reach, run.hi);
    }
    flush();
  }

  // Rebuild each wire from its runs. A corner is where two runs meet, so it
  // takes one coordinate from each — and both bring their own offset.
  for (const route of routes.values()) {
    const pts = route.pts;
    const off = route.offsets;
    if (!off.some((v) => v !== 0)) {
      delete route.pts;
      delete route.offsets;
      continue;
    }
    const laneOf = (i) =>
      Math.abs(pts[i].y - pts[i + 1].y) < 1e-9
        ? { axis: 0, y: pts[i].y + off[i] }
        : { axis: 1, x: pts[i].x + off[i] };
    // A straight hole-to-hole wire has no corner to nudge, so it is given a
    // shallow BOW instead — two waypoints lifting its middle off the lane. That
    // is the shape a real jumper takes anyway when it has to share a run with
    // its neighbour, and without it the one case that reads worst of all (two
    // dead-straight wires exactly on top of each other) is the one case left
    // unfixed.
    if (pts.length === 2) {
      const [a, b] = pts;
      const horizontal = Math.abs(a.y - b.y) < 1e-9;
      const lift = off[0];
      const bow = (t) => ({
        x: q2(a.x + (b.x - a.x) * t + (horizontal ? 0 : lift)),
        y: q2(a.y + (b.y - a.y) * t + (horizontal ? lift : 0)),
      });
      route.points = [bow(0.25), bow(0.75)];
      delete route.pts;
      delete route.offsets;
      continue;
    }
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i += 1) {
      const before = laneOf(i - 1);
      const after = laneOf(i);
      // One of the pair is horizontal and the other vertical, so between them
      // they name both coordinates of the corner.
      out.push({
        x: q2(before.axis === 1 ? before.x : after.x),
        y: q2(before.axis === 0 ? before.y : after.y),
      });
    }
    out.push(pts[pts.length - 1]);
    route.points = out.slice(1, -1);
    route.ends = [out[0], out[out.length - 1]];
    delete route.pts;
    delete route.offsets;
  }
}

/** Waypoints are stored to two decimals, so a nudged one is quantized here
    rather than by the document — the route a test reads and the route the desk
    draws must be the same numbers. */
const q2 = (n) => Math.round(n * 100) / 100;

/**
 * Route a whole desk.
 *
 * @param {{boards:Array, components:Array, wires:Array, buses:Array}} doc a
 *   PLAIN desk document (`DeskDoc.toJSON()`), never the live DeskDoc — nothing
 *   here mutates it, and taking the plain form is what keeps this DOM-free.
 * @param {object} [opts]
 * @param {(comp:object) => ({minX,minY,width,height}|null)} [opts.bodyBox] the
 *   injected view-layer body geometry (see route-space.js)
 * @param {object} [opts.config] a `makeRouteConfig` result
 * @param {Set<string>|null} [opts.only] route just these wire ids
 * @yields {{phase:string, round:number, done:number, total:number}} progress,
 *   for a driver that wants to paint between slices. Ignored by `routeDesk`.
 * @returns {{routes: Map<string, object>, reseats: Array, skipped: Array,
 *   diagnostics: object}}
 */
export function* routeDeskSteps(doc, opts = {}) {
  const config = opts.config ?? ROUTE_CONFIG;
  const skipped = [];

  // ── The one address change: nearer holes for the power leads ────────────
  // Before anything is drawn, because everything downstream — the obstacles,
  // the free holes, the endpoints themselves — is read off the document these
  // moves produce. Routing first and moving afterwards would route to the old
  // holes and then quietly invalidate every path that touched one.
  const reseats =
    config.reseatRailEnds === false
      ? []
      : planRailReseats(doc, {
          only: opts.only ?? null,
          minGain: config.reseatMinGain,
        });
  const source = withReseats(doc, reseats);

  const wires = source.wires ?? [];
  const busMembers = new Set(
    (source.buses ?? []).flatMap((b) => b.members ?? []),
  );

  // ── Which wires, and where do they start and end ────────────────────────
  const candidates = [];
  const statics = [];
  for (const wire of wires) {
    const a = addressWorld(source.boards ?? [], source.components ?? [], wire.from); // prettier-ignore
    const b = addressWorld(source.boards ?? [], source.components ?? [], wire.to); // prettier-ignore
    const mine = !opts.only || opts.only.has(wire.id);
    if (mine && busMembers.has(wire.id)) {
      skipped.push({ wireId: wire.id, reason: SKIP_BUS_MEMBER });
    } else if (mine && (!a || !b)) {
      skipped.push({ wireId: wire.id, reason: SKIP_UNRESOLVED });
    } else if (mine) {
      candidates.push({ wire, a, b });
      continue;
    }
    // Everything else is TERRAIN — a bus member, a wire outside the selection,
    // a wire whose ends no longer resolve. It keeps its shape, so the router
    // has to route around it rather than pretend it is not there.
    if (!a || !b) continue;
    statics.push({
      id: wire.id,
      points:
        wire.layout === "routed" ? [a, ...(wire.points ?? []), b] : [a, b],
    });
  }

  const space = buildRouteSpace(source, {
    bodyBox: opts.bodyBox,
    config,
    extraPoints: candidates.flatMap((c) => [c.a, c.b]),
  });

  const jobs = [];
  for (const { wire, a, b } of candidates) {
    const start = space.nodeAt(a.x, a.y);
    const goal = space.nodeAt(b.x, b.y);
    if (start < 0 || goal < 0 || start === goal) {
      skipped.push({ wireId: wire.id, reason: SKIP_OFF_LATTICE });
      continue;
    }
    jobs.push({
      id: wire.id,
      start,
      goal,
      // The addresses travel with the job because `swapEnds` may change them,
      // and what it changes has to come back out as a document edit.
      fromAddress: wire.from,
      toAddress: wire.to,
      altFrom: config.swapNodeEnds ? nodeAlternatives(space, source, wire.from) : [], // prettier-ignore
      altTo: config.swapNodeEnds
        ? nodeAlternatives(space, source, wire.to)
        : [],
      // A wire needs the air between the boards only when its ends are not on
      // the same one — and then only the gaps BETWEEN those two boards.
      // Everything else stays on the board, which is what rule 1 asked for in
      // the first place.
      bridgeMask: bridgeMaskFor(
        space,
        space.nodeGroup[start],
        space.nodeGroup[goal],
      ),
      ownNodes: new Set([start, goal]),
      exempt: exemptObstacles(space, [a, b]),
    });
  }

  // ── Order: most boxed-in first ──────────────────────────────────────────
  // Only a seed. An endpoint with three of its four exits blocked has to be
  // placed while there is still somewhere to go; after that, negotiated
  // congestion decides who keeps what.
  const freedom = (n) => {
    const i = n % space.nx;
    const j = Math.floor(n / space.nx);
    let open = 0;
    if (i > 0 && space.hKind[space.hEdge(j, i - 1)] !== OUTSIDE) open += 1;
    if (i < space.nx - 1 && space.hKind[space.hEdge(j, i)] !== OUTSIDE)
      open += 1;
    if (j > 0 && space.vKind[space.vEdge(i, j - 1)] !== OUTSIDE) open += 1;
    if (j < space.ny - 1 && space.vKind[space.vEdge(i, j)] !== OUTSIDE)
      open += 1;
    return open;
  };
  const reach = (job) => {
    const p = space.pointOf(job.start);
    const q = space.pointOf(job.goal);
    return Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
  };
  for (const job of jobs) {
    job.constraint = 8 - freedom(job.start) - freedom(job.goal);
    job.reach = reach(job);
  }
  jobs.sort(
    (x, y) =>
      y.constraint - x.constraint ||
      x.reach - y.reach ||
      idNumber(x.id) - idNumber(y.id),
  );

  // ── Negotiated congestion ───────────────────────────────────────────────
  const history = new Map();
  let occ = makeOccupancy();
  let found = new Map();
  let rounds = 0;
  let contended = 0;
  let pressure = 1;
  let best = null;
  let bestScore = Infinity;
  for (let round = 0; round < Math.max(1, config.iterations); round += 1) {
    rounds = round + 1;
    pressure = 1 + round * config.pressureRamp;
    occ = makeOccupancy();
    seedStatic(space, occ, statics); // the terrain, before anyone is routed
    found = new Map();
    let placed = 0;
    for (const job of jobs) {
      const route = routeOne(space, occ, history, job, pressure);
      placed += 1;
      // One yield per wire, which is the finest grain the work has: a driver
      // that wants to paint decides how many of these to run between frames,
      // and the sync driver pays a bare `next()` for each. The generator is
      // otherwise untouched by who is driving it — no clock is read here, so
      // the routes cannot depend on how the work was sliced up.
      yield { phase: "route", round: rounds, rounds: Math.max(1, config.iterations), done: placed, total: jobs.length }; // prettier-ignore
      if (!route) continue;
      found.set(job.id, route);
      occupy(space, occ, job.id, route.nodes, true);
    }
    // Contention is OVERUSE — two wires on one edge, or on two tracks too close
    // to clear each other. A crossing is not contention; it is priced and
    // allowed, which is the difference between "undesirable" and "impossible".
    contended = 0;
    for (const [axis, map] of [
      [0, occ.h],
      [1, occ.v],
    ]) {
      for (const [edge, users] of map) {
        if (users.size <= 1) continue;
        contended += 1;
        const key = axis === 0 ? `h${edge}` : `v${edge}`;
        // Proportional to the OVERUSE, not a flat bump: an edge three wires
        // want is a worse bottleneck than one two want, and it has to become
        // expensive faster or the round count decides the outcome.
        history.set(
          key,
          (history.get(key) ?? 0) + config.historyIncrement * (users.size - 1),
        );
      }
    }
    // Score the whole round and keep the BEST one, not the last.
    //
    // PathFinder's rounds are not monotonically better: history rises to break
    // deadlocks, and a later round can trade a good solution for a worse one
    // that merely happens to be legal. Keeping whichever round happened to be
    // last is how a wire ends up going the long way round for no reason anybody
    // could point at. The score is the same cost every route was chosen by, so
    // "best" here means best by the model's own reckoning rather than by a
    // second opinion invented for the purpose.
    let score = 0;
    for (const [id, route] of found) {
      const job = jobs.find((j) => j.id === id);
      const model = costModelFor(space, occ, history, id, job.exempt, false, pressure, null, job.bridgeMask, job.ownNodes); // prettier-ignore
      score += costOfPath(space, model, route.nodes);
    }
    if (best === null || score < bestScore) {
      bestScore = score;
      best = { found, occ, contended };
    }
    if (contended === 0) break;
  }
  if (best) {
    found = best.found;
    occ = best.occ;
    contended = best.contended;
  }

  // ── Hardening ───────────────────────────────────────────────────────────
  // Negotiation gets the wires into roughly the right lanes; what it cannot
  // always finish is the last stretch of COLLINEAR run, where two wires draw as
  // one line and nothing shows which of them turned off. So each wire, in id
  // order, is lifted out and offered a route that may not share an edge with
  // anything — another route, or the terrain. Where one exists it is taken even
  // if it costs more, because a shared run is not a dearer route, it is an
  // unreadable one; where none exists the wire keeps what it had.
  //
  // THE PASS CAN NEVER CREATE SHARING, which is the property that makes it
  // worth running at all: a wire already clean moves only to another clean
  // route, and only when that is strictly cheaper. An earlier version let the
  // ordinary cheaper-route retry run too, and it quietly put back most of what
  // the hardening had just removed.
  //
  // Repeated, because freeing one wire's lane can be what lets the next off its
  // neighbour. It converges: an acceptance either removes sharing or lowers
  // cost, and hardening a wire can never make another one dirty (the route it
  // moves to was, by construction, free of every wire still in place).
  let improved = 0;
  let hardened = 0;
  const byId = [...jobs].sort((x, y) => idNumber(x.id) - idNumber(y.id));
  const passes = Math.max(1, config.hardenPasses);
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = 0;
    let swept = 0;
    for (const job of byId) {
      swept += 1;
      yield { phase: "tidy", round: pass + 1, rounds: passes, done: swept, total: byId.length }; // prettier-ignore
      const current = found.get(job.id);
      if (!current) continue;
      occupy(space, occ, job.id, current.nodes, false);

      let keep = current;
      // What the route it ALREADY has would cost if it were being chosen now.
      // Never `current.cost` — that was priced mid-round against a board holding
      // only the wires laid before it (see costOfPath).
      const live = costModelFor(space, occ, history, job.id, job.exempt, false, pressure, null, job.bridgeMask, job.ownNodes); // prettier-ignore
      let keepCost = costOfPath(space, live, current.nodes);
      let keepShared = sharedLength(space, occ, job.id, current.nodes);
      const avoid = new Set(sharedWith(space, occ, job.id, current.nodes));
      // Up to two goes, GROWING the set of wires to keep away from: the first
      // reroute can land on a wire that was not a rival before, and telling it
      // about that one is usually all it needs. Acceptance is on shared LENGTH,
      // strictly — a move that trades one doubled-up run for another is not
      // progress, and accepting it would let the pass cycle for ever.
      for (let attempt = 0; attempt < 2 && keepShared > 0; attempt += 1) {
        const cand = routeOne(space, occ, history, job, pressure, avoid);
        if (!cand) break;
        const candShared = sharedLength(space, occ, job.id, cand.nodes);
        if (
          candShared < keepShared ||
          (candShared === keepShared && cand.cost < keepCost)
        ) {
          keep = cand;
          keepCost = cand.cost;
          keepShared = candShared;
        }
        if (candShared === 0) break;
        for (const r of sharedWith(space, occ, job.id, cand.nodes))
          avoid.add(r);
      }
      if (keep !== current) {
        changed += 1;
        hardened += 1;
      } else if (keepShared === 0) {
        // Already clean: it still gets its one chance to be shorter or
        // straighter, but only onto another clean route.
        const retry = routeOne(space, occ, history, job, pressure, new Set());
        if (
          retry &&
          retry.cost < keepCost &&
          sharedLength(space, occ, job.id, retry.nodes) === 0
        ) {
          keep = retry;
          changed += 1;
          improved += 1;
        }
      }
      found.set(job.id, keep);
      occupy(space, occ, job.id, keep.nodes, true);
    }
    if (changed === 0) break;
  }

  // ── End swaps ───────────────────────────────────────────────────────────
  // Last, because it is the only pass that questions where a wire ENDS, and it
  // wants the routes to already be as good as fixed endpoints allow — otherwise
  // it spends its swaps buying improvements hardening was about to make anyway.
  const swaps = [];
  if (config.swapNodeEnds) {
    const sweeps = Math.max(1, config.swapPasses);
    const vacated = new Map(); // node → the wire that moved out of it
    for (let pass = 0; pass < sweeps; pass += 1) {
      const label = { phase: "swap", round: pass + 1, rounds: sweeps };
      const changed = yield* swapEnds(space, occ, history, byId, found, pressure, swaps, vacated, label); // prettier-ignore
      if (changed === 0) break;
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────
  const routes = new Map();
  for (const job of byId) {
    const route = found.get(job.id);
    if (!route) {
      skipped.push({ wireId: job.id, reason: SKIP_NO_PATH });
      continue;
    }
    const described = describeRoute(space, occ, history, job, route);
    routes.set(job.id, {
      points: route.corners.slice(1, -1),
      ends: [route.corners[0], route.corners[route.corners.length - 1]],
      nodes: route.nodes,
      ...described,
    });
  }
  // Fan out the runs that had to share a lane, so every wire is its own line.
  if (config.laneOffset > 0) separateLanes(routes, config);

  // A move only travels with a route. A wire the router could not place keeps
  // the layout it had, and moving its end would be an edit to the build guide
  // with nothing on screen to show for it — so the two go together or neither
  // does. (The route the reseat was planned against is gone either way; what
  // is left is the desk exactly as it was for that one wire.)
  const applied = reseats.filter((m) => routes.has(m.wireId));

  // A wire may be offered a better hole twice over two sweeps, so what comes out
  // is the FIRST hole it had and the LAST it took — one move per end, and none
  // at all for a wire that was walked back to where it started.
  const swapped = new Map();
  for (const s of swaps) {
    if (!routes.has(s.wireId)) continue;
    const key = `${s.wireId} ${s.end}`;
    const seen = swapped.get(key);
    if (seen) seen.to = s.to;
    else swapped.set(key, { ...s });
  }
  const endSwaps = [...swapped.values()]
    .filter((s) => s.from !== s.to)
    .sort((a, b) => idNumber(a.wireId) - idNumber(b.wireId) || (a.end < b.end ? -1 : 1)); // prettier-ignore

  skipped.sort((a, b) => idNumber(a.wireId) - idNumber(b.wireId));

  // How much wire is doubled up, in pitch — the honest measure of the one defect
  // negotiation cannot always remove. An edge COUNT says nothing about severity:
  // a dozen one-pitch touches read as nothing, and one ten-pitch shadow reads as
  // a missing wire.
  let overlapUnits = 0;
  let routedUnits = 0;
  const staticIds = new Set(statics.map((x) => x.id));
  for (const [axis, map] of [
    [0, occ.h],
    [1, occ.v],
  ]) {
    const span = Math.max(1, axis === 0 ? space.nx - 1 : space.ny - 1);
    for (const [edge, users] of map) {
      const at = edge % span;
      const len =
        axis === 0
          ? space.xs[at + 1] - space.xs[at]
          : space.ys[at + 1] - space.ys[at];
      // Terrain is not the router's doing, so an edge only IT sits on is not
      // reported as overlap — but a route sharing one with it certainly is.
      const routed = [...users].filter((id) => !staticIds.has(id)).length;
      if (routed === 0) continue;
      routedUnits += len * routed;
      if (users.size > 1) overlapUnits += len * (users.size - 1);
    }
  }

  return {
    routes,
    reseats: applied,
    swaps: endSwaps,
    skipped,
    space,
    diagnostics: {
      rounds,
      contended,
      improved,
      hardened,
      swapped: endSwaps.length,
      reseated: applied.length,
      reseatGain: Math.round(applied.reduce((s, m) => s + m.gain, 0) * 100) / 100, // prettier-ignore
      overlapUnits: Math.round(overlapUnits * 100) / 100,
      routedUnits: Math.round(routedUnits * 100) / 100,
      wires: jobs.length,
      gridNodes: space.nx * space.ny,
      boardGroups: space.groups,
      bridges: space.bridges.length,
    },
  };
}

/**
 * Route a whole desk, synchronously. The signature `routeDeskSteps` documents,
 * run to completion — every test, the corpus and anything that does not need to
 * repaint while it works uses this.
 */
export function routeDesk(doc, opts = {}) {
  const steps = routeDeskSteps(doc, opts);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * Yield the thread back to whoever is waiting for it.
 *
 * `scheduler.yield()` is the one that exists for this: it resumes AFTER pending
 * input and rendering, which is the whole point, and it does not accumulate the
 * nested-timer clamp that would otherwise turn every slice boundary into four
 * idle milliseconds. `MessageChannel` is the same trick by hand and works in
 * Node too, so the async driver is testable; `setTimeout` is the last resort.
 */
const yieldToHost =
  typeof globalThis.scheduler?.yield === "function"
    ? () => globalThis.scheduler.yield()
    : typeof MessageChannel === "function"
      ? () =>
          new Promise((resolve) => {
            const channel = new MessageChannel();
            channel.port1.onmessage = () => {
              channel.port1.close();
              resolve();
            };
            channel.port2.postMessage(0);
          })
      : () => new Promise((resolve) => setTimeout(resolve, 0));

/** How long (ms) the router may hold the thread before letting go of it. About
    a frame and a half: short enough that a click on Cancel is answered while it
    still feels like a click, long enough that the yields themselves are noise. */
const SLICE_MS = 24;

/**
 * Route a whole desk in slices, letting the host paint between them.
 *
 * Same generator, same routes — the clock is read only to decide WHEN to let go
 * of the thread, never what to do next, so a slow machine and a fast one get
 * byte-identical output. (D10 forbids a clock in the router; this is not one.)
 *
 * @param {object} doc a plain desk document
 * @param {object} [opts] everything `routeDeskSteps` takes, plus:
 * @param {AbortSignal} [opts.signal] abort and resolve **null**. Nothing has
 *   been written at that point — the whole result is computed off-document and
 *   applied in one go afterwards — so a cancel leaves the wiring untouched
 *   rather than having to put it back.
 * @param {(progress:object) => void} [opts.onProgress] called once per slice.
 * @returns {Promise<object|null>} the result, or null if it was cancelled.
 */
export async function routeDeskAsync(doc, opts = {}) {
  const { signal, onProgress } = opts;
  const steps = routeDeskSteps(doc, opts);
  const clock = () => globalThis.performance?.now?.() ?? 0;
  let deadline = clock() + SLICE_MS;
  let step = steps.next();
  while (!step.done) {
    if (signal?.aborted) {
      steps.return(undefined); // runs the generator's cleanup, keeps nothing
      return null;
    }
    if (clock() >= deadline) {
      onProgress?.(step.value);
      await yieldToHost();
      deadline = clock() + SLICE_MS;
    }
    step = steps.next();
  }
  return signal?.aborted ? null : step.value;
}

/**
 * The document edit a routing result asks for: every routed wire's waypoints
 * and, where one was planned, its power lead's new hole — ready for
 * `DeskDoc.applyRoutes`, which writes both in one transaction so the pair is
 * one undo step. Wires the router could not place are absent, so they keep
 * whatever layout and whatever addresses they already had.
 */
export function routePlan(result) {
  const ends = new Map();
  // The two kinds of move can never collide: a rail reseat only ever touches a
  // RAIL end and a swap only ever a GRID one, and an end is one or the other.
  for (const move of [...(result.reseats ?? []), ...(result.swaps ?? [])]) {
    const entry = ends.get(move.wireId) ?? {};
    entry[move.end] = move.to;
    ends.set(move.wireId, entry);
  }
  return [...result.routes.entries()]
    .sort((a, b) => idNumber(a[0]) - idNumber(b[0]))
    .map(([id, route]) => ({ id, points: route.points, ...ends.get(id) }));
}
