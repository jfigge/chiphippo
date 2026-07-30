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

// part-move.js — which wires RIDE a part when it is re-seated, and where they
// land (Feature 290, the Option-drag). Pure and DOM-free, over a plain document.
//
// Re-seating a wired part without its wiring is a SILENT REWIRING: the pins move
// to different nodes, every wire stays in the hole it was laid in, and the
// netlist quietly partitions differently. This module is the other option — pick
// the part up with its wiring attached.
//
// RIDING IS A NODE RULE. A wire end rides when its hole is in a node (one 5-hole
// column-half) that one of the part's pins occupies. That is the electrically
// true reading of "the wires around the chip": a wire in `c6L` is not connected
// to a part that only reaches `c5L` and `c8L`, however close it looks. Every
// riding end then keeps its ROW and its offset from the part, so the whole
// cluster translates rigidly and the netlist after the move is the netlist
// before it — which is the entire point.

import {
  formatAddress,
  holeAlongTo,
  nodeOf,
  parseAddress,
  parseHole,
} from "./breadboard.js";
import { partPinAddresses, worldOfAddress } from "./occupancy.js";

/** A refused plan — the caller reddens the drop rather than inventing a hole. */
const REFUSED = Object.freeze({
  moves: Object.freeze([]),
  points: Object.freeze([]),
  resolved: false,
});

/**
 * The node-identity key of an address — `"bb1|c7L"` — or null when it names no
 * grid hole. Keyed per BOARD, since two boards share node ids.
 *
 * GRID HOLES ONLY, deliberately. A rail is one continuous node for its whole
 * length, so "in the same node as a pin" would degenerate to "anywhere on this
 * rail" — the board's entire power distribution rather than the part's own
 * neighbourhood. (Only a `can` part's geometrically-resolved corner can reach a
 * rail from this gesture at all, and its power wiring is not what is being
 * picked up.)
 */
function nodeKeyOf(boards, address) {
  const parsed = parseAddress(address);
  if (!parsed) return null;
  const board = boards.find((b) => b.id === parsed.boardId);
  if (!board) return null;
  try {
    const hole = parseHole(board.type, parsed.hole);
    if (hole?.kind !== "grid") return null;
    return `${board.id}|${nodeOf(board.type, parsed.hole)}`;
  } catch {
    return null; // a junk board type owns no node
  }
}

/**
 * The set of node keys a seated part's pins occupy, as `"<boardId>|<node>"`. A
 * floating lead owns nothing. Empty for a desk brick (its terminals are not
 * holes) or a part that doesn't resolve.
 *
 * @param {{ boards: Array }} doc
 * @param {{ ref:string, board:string, anchor:string, params?:object }} comp
 */
export function partNodeKeys(doc, comp) {
  const keys = new Set();
  if (!comp || comp.board == null) return keys;
  const pins = partPinAddresses(doc, comp);
  if (!pins) return keys;
  for (const { address } of pins) {
    if (address == null) continue;
    const key = nodeKeyOf(doc.boards ?? [], address);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * The wires that ride part `compId`, in document order, as
 * `[{ wireId, ends: ["from"|"to", …] }]` — one entry per wire, listing which of
 * its ends ride. A jumper between two of the part's OWN nodes rides by both, and
 * then translates rigidly.
 *
 * Read ONCE at pointerdown and frozen for the gesture: recomputing per pointer
 * sample would grow and shrink the set as the part slid over other wires' holes,
 * so the drop would depend on the path taken to it rather than where it landed.
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 */
export function wiresRidingPart(doc, compId) {
  const comp = (doc.components ?? []).find((c) => c && c.id === compId);
  const keys = partNodeKeys(doc, comp);
  if (keys.size === 0) return [];
  const boards = doc.boards ?? [];
  const riding = [];
  for (const wire of doc.wires ?? []) {
    if (!wire || typeof wire !== "object") continue;
    const ends = [];
    for (const end of ["from", "to"]) {
      const key = nodeKeyOf(boards, wire[end]);
      if (key && keys.has(key)) ends.push(end);
    }
    if (ends.length > 0) riding.push({ wireId: wire.id, ends });
  }
  return riding;
}

/**
 * Where `riding` lands when part `id` re-seats at `board`.`anchor`:
 *
 *   `moves`    — `[{ id, from, to }]` for `DeskDoc.moveWiresBatch`, BOTH ends
 *                stated (a fixed end restates its own address). EITHER empty or
 *                exactly one entry per riding wire, never a partial list — the
 *                shift is a column/board change, so every riding end moves or
 *                none does, and the caller's prepared batch predicate is
 *                length-checked against the frozen riding set.
 *   `points`    — `[{ id, dx, dy }]` waypoint translations, for the routed wires
 *                riding by BOTH ends.
 *   `resolved`  — false when any riding end has nowhere to land. The caller
 *                reddens the drop; it never invents a hole or drops a wire.
 *
 * Note what `resolved:false` covers besides running off the end of a strip: a
 * part re-seated ACROSS THE TRENCH (row `a` → row `g`) flips which half of each
 * column its pins are in, so a riding end that keeps its row is no longer on the
 * pin's node at all. The check is stated generally — every landing address must
 * be in a node the part occupies AFTER the move — so that case, and any other
 * the footprint vocabulary grows, is caught by construction rather than enumerated.
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @param {{ id:string, riding:Array, board:string, anchor:string }} target
 */
export function planPartMove(doc, { id, riding, board: boardId, anchor }) {
  const comp = (doc.components ?? []).find((c) => c && c.id === id);
  if (!comp || comp.board == null) return REFUSED;
  const boards = doc.boards ?? [];
  const from = boards.find((b) => b.id === comp.board);
  const to = boards.find((b) => b.id === boardId);
  if (!from || !to) return REFUSED;

  // The shift is the part's own anchor delta, in columns.
  let origin = null;
  let seat = null;
  try {
    origin = parseHole(from.type, comp.anchor);
    seat = parseHole(to.type, anchor);
  } catch {
    return REFUSED;
  }
  if (origin?.kind !== "grid" || seat?.kind !== "grid") return REFUSED;
  const dcol = seat.col - origin.col;

  const list = riding ?? [];
  if (list.length === 0) return { moves: [], points: [], resolved: true };

  // Whether any ADDRESS changes at all. A pure row move within one column-half
  // (a discrete slid from row a to row c) leaves every riding end exactly where
  // it is — still on the pin's node — so there is nothing to move, only the
  // node check below to pass.
  const shifting = dcol !== 0 || boardId !== comp.board;
  // The nodes the part's pins will occupy after the move — what every riding end
  // has to still be in.
  const after = partNodeKeys(doc, { ...comp, board: boardId, anchor });
  const byId = new Map((doc.wires ?? []).map((w) => [w.id, w]));

  const moves = [];
  const points = [];
  for (const { wireId, ends } of list) {
    const wire = byId.get(wireId);
    if (!wire) return REFUSED; // the frozen set names a wire since deleted
    const next = { id: wireId, from: wire.from, to: wire.to };
    for (const end of ends) {
      const parsed = parseAddress(wire[end]);
      // A riding end sits in a node of the part's OWN board by construction, so
      // it re-addresses onto the target board.
      if (!parsed || parsed.boardId !== comp.board) return REFUSED;
      const hole = holeAlongTo(from.type, to.type, parsed.hole, dcol);
      if (!hole) return REFUSED; // off the end of the strip it is landing on
      const address = formatAddress(boardId, hole);
      if (!after.has(nodeKeyOf(boards, address))) return REFUSED;
      next[end] = address;
    }
    if (!shifting) continue;
    moves.push(next);
    if (ends.length === 2 && wire.layout === "routed" && wire.points?.length) {
      points.push({ id: wireId, dx: 0, dy: 0 }); // filled in below
    }
  }

  if (points.length > 0) {
    // Waypoints are the one part of a wire that is NOT an address, so they are
    // the one part that has to be moved by hand (as `translateAll` and
    // `pasteDesign` also do). Only a wire riding by BOTH ends translates: with
    // one end pinned, the user's bend still belongs where they put it.
    const a = worldOfAddress(boards, formatAddress(comp.board, comp.anchor));
    const b = worldOfAddress(boards, formatAddress(boardId, anchor));
    if (!a || !b) return REFUSED;
    for (const p of points) {
      p.dx = b.x - a.x;
      p.dy = b.y - a.y;
    }
  }

  return { moves, points, resolved: true };
}
