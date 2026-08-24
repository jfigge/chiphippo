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

// rail-reseat.js — move a POWER LEAD's rail end to a nearer free hole
// (Feature 360). Pure, DOM-free, and the narrow half of D11's `reseatEnds`.
//
// Why this exists at all. A rail is ONE electrical node for the whole length of
// its strip, so every hole on it is the same connection — which is exactly why a
// power lead is the one wire on the desk whose end can be moved with nothing to
// argue about. Move a chip and its signal wires follow it (Feature 290's ride
// rule); its POWER leads do not, because they end on a rail hole that belongs to
// no node the chip occupies. So the leads stretch, and a desk that has been
// edited for a while ends up with supply wires crossing the whole bench to reach
// a rail hole that was next to the chip three moves ago. No amount of routing
// fixes that: the router draws the best path between two holes, and one of those
// holes is simply in the wrong place.
//
// THREE RULES, and each of them is load-bearing:
//
//  1. **Only an end whose OTHER end is not itself on a rail.** A rail-to-rail
//     wire is a SPINE link (the "Power layout" rules, 2) — it ties two strips
//     together and it is deliberately at the END of the run, because it has to
//     cross the pin-board and cannot be routed around. Left free to shorten
//     itself it would slide into the middle of the board, straight over the
//     chips. So the spine never moves, and what moves is the lead that ends on a
//     PIN or a terminal.
//
//  2. **A target hole must be on a rail line in the SAME wiring-only net.**
//     Within one strip that is trivially true. Across strips it is true exactly
//     when the spine has tied them, which is the case that matters — the lead
//     stretched four boards up is fixed by landing it on the rail beside the
//     chip, and that rail is the same net only because a bridge says so.
//     `bridges: false` is deliberate: a switch thrown to a rail merges its net
//     while it is thrown, and a hole chosen on that basis would be wrong the
//     moment the switch moved.
//
//  3. **The whole plan is VERIFIED, not merely argued.** Rule 2 says the target
//     is in the net; it does not say the SOURCE rail stays in it. If the moving
//     wire was the only path between the two — R1 → a pin, that pin → R2 — then
//     landing it on R2 orphans R1 and everything else plugged into it. So the
//     partition is taken before and after and must be identical, over every
//     point on the desk. It is cheap (one union-find pass) and it turns "this
//     ought to be safe" into "this is the same circuit". A move that fails it
//     is DROPPED, not retried against its second-choice hole: the wire is then
//     left exactly as it was, which is never wrong — merely not improved.
//
// The result is a list of address changes, not a mutation: `routeDesk` routes
// against them and `DeskDoc.applyRoutes` writes them in the same transaction as
// the waypoints, so the whole thing is one undo step.

import { buildNetlist } from "../sim/netlist.js";
import { formatAddress, parseAddress, parseHole, spec } from "./breadboard.js";
import { buildOccupancy, canReendWire } from "./occupancy.js";
import { addressWorld } from "./part-geometry.js";

/** The other end's name — a wire has exactly two. */
const OTHER_END = { from: "to", to: "from" };

/** "w12" → 12, for a deterministic order that reads the way ids do. */
const idNumber = (id) => Number.parseInt(String(id).slice(1), 10) || 0;

/** Manhattan, which is the metric the router itself works in — an orthogonal
    route's length IS |dx| + |dy|, so a gain measured this way is the wire the
    move actually saves rather than a straight-line guess at it. */
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * The rail LINE an address sits on — `"bb3.+"` — or null for anything else (a
 * grid hole, a brick terminal, an address naming no board).
 *
 * A line, not a strip: a rail strip carries both polarities and they are two
 * separate nodes, so `+` and `-` can never be confused for one another here.
 */
export function railLineOf(boards, address) {
  const parsed = parseAddress(address);
  if (!parsed) return null;
  const board = (boards ?? []).find((b) => b?.id === parsed.boardId);
  if (!board) return null;
  const hole = parseHole(board.type, parsed.hole);
  return hole?.kind === "rail" ? `${board.id}.${hole.railId}` : null;
}

/**
 * Every rail line on the desk, with its holes' world positions and the net it
 * belongs to. Built once per plan; a full 830 kit's rail strip is 100 holes and
 * a four-board stack is 400, so this is a small table scanned many times rather
 * than a big one built many times.
 */
function railLines(doc, netOfPoint) {
  const out = [];
  for (const board of doc.boards ?? []) {
    const s = spec(board.type);
    if (!s?.rails?.length) continue;
    for (const rail of s.rails) {
      const holes = [];
      for (let i = 1; i <= s.railHoles; i += 1) {
        const address = formatAddress(board.id, `${rail.id}${i}`);
        const at = addressWorld(doc.boards, doc.components, address);
        if (at) holes.push({ address, at });
      }
      if (holes.length === 0) continue;
      out.push({
        key: `${board.id}.${rail.id}`,
        net: netOfPoint.get(holes[0].address),
        holes,
      });
    }
  }
  return out;
}

/**
 * A stable fingerprint of what is connected to what — every point on the desk
 * and the net it landed in, by WIRING ALONE.
 *
 * This is the whole safety argument for moving an address, so it is deliberately
 * the strictest form available: not "no pin changed net" but "no POINT changed
 * net", which additionally catches a rail losing its supply while still holding
 * other leads. Wiring-only (`bridges: false`) because a switch's position is not
 * a fact about the build — and because a partition unchanged by wiring is
 * unchanged with bridges on too, the bridge set being untouched by an address
 * move.
 */
export function electricalPartition(doc) {
  const { netOfPoint } = buildNetlist(doc, new Map(), { bridges: false });
  return [...netOfPoint.entries()]
    .map(([point, net]) => `${point}=${net}`)
    .sort()
    .join("|");
}

/**
 * The document as a set of moves would leave it — a shallow copy with the moved
 * wires replaced. Nothing here mutates its input, which is what lets a plan be
 * tried, measured and thrown away.
 *
 * @param {object} doc a plain desk document
 * @param {Array<{wireId:string, end:string, to:string}>} moves
 */
export function withReseats(doc, moves) {
  if (!moves || moves.length === 0) return doc;
  const byWire = new Map();
  for (const move of moves) {
    const list = byWire.get(move.wireId) ?? [];
    list.push(move);
    byWire.set(move.wireId, list);
  }
  return {
    ...doc,
    wires: (doc.wires ?? []).map((wire) => {
      const list = byWire.get(wire.id);
      if (!list) return wire;
      const copy = { ...wire };
      for (const move of list) copy[move.end] = move.to;
      return copy;
    }),
  };
}

/**
 * Plan every power lead worth moving.
 *
 * @param {{boards:Array, components:Array, wires:Array, buses:Array}} doc a
 *   PLAIN desk document — nothing here mutates it.
 * @param {object} [opts]
 * @param {Set<string>|null} [opts.only] consider just these wires (the
 *   selection). A wire outside it still holds its hole, it just cannot move.
 * @param {number} [opts.minGain] the least Manhattan distance (pitch) a move
 *   must save to be worth making.
 * @returns {Array<{wireId:string, end:"from"|"to", from:string, to:string,
 *   gain:number}>} in wire-id order, ready for `withReseats`.
 */
export function planRailReseats(doc, opts = {}) {
  const only = opts.only ?? null;
  const minGain = Number.isFinite(opts.minGain) ? opts.minGain : 2;
  const boards = doc.boards ?? [];
  const wires = doc.wires ?? [];
  if (boards.length === 0 || wires.length === 0) return [];

  const { netOfPoint } = buildNetlist(doc, new Map(), { bridges: false });
  const lines = railLines(doc, netOfPoint);
  if (lines.length === 0) return [];
  const occupancy = buildOccupancy(doc);
  // A bus member's ends belong to its ribbon, which is drawn between them —
  // the same exemption every other part of the router makes (F5).
  const busMembers = new Set(
    (doc.buses ?? []).flatMap((b) => b?.members ?? []),
  );

  // ── Every end that COULD move, and how far it is stretched ───────────────
  const candidates = [];
  for (const wire of wires) {
    if (!wire?.id || busMembers.has(wire.id)) continue;
    if (only && !only.has(wire.id)) continue;
    for (const end of ["from", "to"]) {
      const line = railLineOf(boards, wire[end]);
      if (!line) continue;
      const other = wire[OTHER_END[end]];
      if (railLineOf(boards, other)) continue; // rule 1: the spine stays put
      const target = addressWorld(boards, doc.components ?? [], other);
      const here = addressWorld(boards, doc.components ?? [], wire[end]);
      if (!target || !here) continue;
      candidates.push({
        wireId: wire.id,
        end,
        line,
        from: wire[end],
        net: netOfPoint.get(wire[end]),
        target,
        distance: manhattan(here, target),
        here,
      });
    }
  }
  // Most stretched first, so the worst offender gets first pick of the holes.
  // Greedy, and deliberately so: an exact assignment would be a matching
  // problem, and the wire with the most to gain is the one that should win a
  // contested hole anyway.
  candidates.sort(
    (a, b) =>
      b.distance - a.distance ||
      idNumber(a.wireId) - idNumber(b.wireId) ||
      (a.end < b.end ? -1 : 1),
  );

  // ── Pick each one's nearest free hole on its own net ─────────────────────
  const claimed = new Set();
  const moves = [];
  for (const cand of candidates) {
    let best = null;
    for (const line of lines) {
      if (line.net !== cand.net) continue; // rule 2
      for (const hole of line.holes) {
        if (hole.address === cand.from) continue;
        if (occupancy.has(hole.address) || claimed.has(hole.address)) continue;
        const distance = manhattan(hole.at, cand.target);
        // Ties are common — a rail is a line of holes and two of them are often
        // equally near — so the order is total: nearest, then the one that
        // disturbs the desk least, then the address itself.
        const key = [
          distance,
          line.key === cand.line ? 0 : 1,
          manhattan(hole.at, cand.here),
        ];
        if (
          !best ||
          key[0] < best.key[0] ||
          (key[0] === best.key[0] &&
            (key[1] < best.key[1] ||
              (key[1] === best.key[1] &&
                (key[2] < best.key[2] ||
                  (key[2] === best.key[2] && hole.address < best.address)))))
        ) {
          best = { address: hole.address, distance, key };
        }
      }
    }
    if (!best) continue;
    const gain = cand.distance - best.distance;
    if (gain < minGain) continue;
    // The app's own collision authority has the last word on whether this hole
    // may be taken — the scan above reads the same occupancy map, so this can
    // only ever agree, and that is the point: the router must not have its own
    // opinion about what a free hole is.
    if (!canReendWire(doc, cand.wireId, cand.end, best.address)) continue;
    claimed.add(best.address);
    moves.push({
      wireId: cand.wireId,
      end: cand.end,
      from: cand.from,
      to: best.address,
      gain: Math.round(gain * 100) / 100,
    });
  }
  if (moves.length === 0) return [];

  // ── Rule 3: prove it ─────────────────────────────────────────────────────
  // The common case is that the whole plan is safe and this costs one extra
  // union-find pass. When it is not, the moves are re-offered one at a time —
  // the offender is usually a single wire that was the only path between two
  // rails, and dropping the whole plan for it would throw away every other
  // lead's fix.
  const before = electricalPartition(doc);
  if (electricalPartition(withReseats(doc, moves)) === before) {
    return moves.sort((a, b) => idNumber(a.wireId) - idNumber(b.wireId));
  }
  const kept = [];
  for (const move of moves) {
    if (electricalPartition(withReseats(doc, [...kept, move])) === before) {
      kept.push(move);
    }
  }
  return kept.sort((a, b) => idNumber(a.wireId) - idNumber(b.wireId));
}
