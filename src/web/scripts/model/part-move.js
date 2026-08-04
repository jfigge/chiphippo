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
// riding end then keeps its ROW and its offset from the part — or, where its pin
// crossed the TRENCH into the other half, travels the same number of rows the
// pin did — so the netlist after the move is the netlist before it, which is the
// entire point, and the ARRANGEMENT after it is the arrangement before it too.
//
// AND A RIDER FOLLOWS THE PIN WHOSE NODE IT SITS IN — not the part's anchor.
// For a footprint part the two are the same thing (every pin sits on one board
// and shifts by one column delta, the anchor's), but they part company as soon
// as a part's pins do NOT: a rotatable part seats pin 1 in ANY hole and measures
// pin 2 as a bend from it, so the two can be on different strips, and pin 1 may
// well be on a RAIL — which owns no node at all, a rail being one continuous
// node for its whole length. Reading the shift off the anchor therefore refused
// that part outright even though its GRID pin had a perfectly ordinary
// neighbourhood to carry. Per pin, the rule is a strict superset of per anchor,
// so nothing about a chip's drag changes.
//
// A WIRE END IS NOT THE ONLY THING IN A NODE. A resistor with one leg in the
// column-half a moving pin occupies is connected to it exactly as a jumper laid
// in the next hole along is, and leaving it behind is the same silent rewiring
// this module exists to prevent — so a two-terminal part's LEAD rides on the
// same rule, and the part BENDS around whichever of its legs is staying put.
// Only a `rotatable` part qualifies, because it is the only kind whose leads
// move independently: a DIP's pins are fixed to its body, so "carry the chip
// next door because a wire's worth of copper joins them" would be a different
// gesture (and one that cascades). Ride by BOTH legs and it translates rigidly
// instead, keeping whichever form it is stored in.
//
// THE RULE CLOSES AT ONE HOP, which is why nothing here recurses. A riding lead
// lands in the node its pin lands in, and every OTHER rider in that same node
// travels with it; a lead that stays put leaves its own node untouched. So a
// rider never strands something behind it, and there is nothing further to
// follow — the alternative, a transitive closure, would pick up the whole
// circuit from one nudge.

import { partDef } from "../catalog/index.js";
import {
  formatAddress,
  holeAcross,
  holeAlongTo,
  nodeOf,
  parseAddress,
  parseHole,
  rowsBetween,
} from "./breadboard.js";
import { partPinAddresses, worldOfAddress } from "./occupancy.js";
import { partPinsWorld } from "./part-geometry.js";

/** A refused plan — the caller reddens the drop rather than inventing a hole. */
const REFUSED = Object.freeze({
  moves: Object.freeze([]),
  points: Object.freeze([]),
  parts: Object.freeze([]),
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
 * The two-terminal PARTS that ride, in document order, as
 * `[{ id, pins: [{ pin, memberId }, …] }]` — one entry per part, listing which
 * of its LEADS ride and which moving part each of them follows.
 *
 * `owners` maps a riding node key to the moving part that owns it, so one call
 * serves a solo drag (one owner) and a cluster (many, first in document order
 * winning a shared node). `moving` is the set that is already being dragged in
 * its own right — a member rides as a member, never as its own neighbour's lead.
 *
 * Only a `rotatable` part is offered: see the module note on why a DIP's pins
 * are not leads. Frozen at pointerdown with everything else.
 *
 * @param {{ boards: Array, components: Array }} doc
 * @param {Map<string, string>} owners - node key → moving component id
 * @param {Set<string>} moving
 */
export function leadsRiding(doc, owners, moving = new Set()) {
  const boards = doc?.boards ?? [];
  const riding = [];
  for (const comp of doc?.components ?? []) {
    if (!comp || moving.has(comp.id) || comp.board == null) continue;
    if (!partDef(comp.ref)?.rotatable) continue;
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    const legs = [];
    for (const { pin, address } of pins) {
      if (address == null) continue; // a floating lead is connected to nothing
      const owner = owners.get(nodeKeyOf(boards, address));
      if (owner) legs.push({ pin, memberId: owner });
    }
    if (legs.length > 0) riding.push({ id: comp.id, pins: legs });
  }
  return riding;
}

/** The parts riding ONE moving part — `leadsRiding` over its own nodes. */
export function partsRidingPart(doc, compId) {
  const comp = (doc.components ?? []).find((c) => c && c.id === compId);
  const keys = partNodeKeys(doc, comp);
  if (keys.size === 0) return [];
  const owners = new Map([...keys].map((key) => [key, compId]));
  return leadsRiding(doc, owners, new Set([compId]));
}

/**
 * Where a riding two-terminal part lands — `{ id, board, anchor, params }` — or
 * null when one of its riding leads has nowhere to go.
 *
 * BOTH leads riding is a rigid translation, so the part keeps whichever form it
 * is stored in and only its anchor moves. ONE lead riding is a BEND, and only
 * the two-free-ends form can express one — so a part sitting in its footprint
 * form is rewritten into it, exactly as dragging one of its legs by hand does.
 *
 * @param {{ boards: Array, components: Array }} doc
 * @param {object} comp - the rider, as the document has it
 * @param {Array<{pin:number, shift:Function}>} riding - a `partRideShift` per leg
 */
export function planRidingLead(doc, comp, riding) {
  const boards = doc?.boards ?? [];
  const def = partDef(comp?.ref);
  const pins = partPinsWorld(boards, comp);
  if (!def?.rotatable || !pins || pins.length !== 2) return null;

  const byPin = new Map((riding ?? []).map((r) => [r.pin, r.shift]));
  const landed = new Map();
  for (const { pin, address } of pins) {
    const shift = byPin.get(pin);
    if (!shift) continue;
    const to = address == null ? null : shift(address);
    if (!to) return null; // nowhere for this leg to go
    landed.set(pin, to);
  }
  if (landed.size === 0) return null;

  const [one, two] = pins;
  const anchorAddress =
    landed.get(one.pin) ?? formatAddress(comp.board, comp.anchor);
  const seat = parseAddress(anchorAddress);
  if (!seat) return null;
  const at = { id: comp.id, board: seat.boardId, anchor: seat.hole };
  if (landed.size === 2) return { ...at, params: comp.params };

  const anchorWorld = worldOfAddress(boards, anchorAddress);
  const far = landed.has(two.pin)
    ? worldOfAddress(boards, landed.get(two.pin))
    : { x: two.x, y: two.y }; // it stays exactly where it is
  if (!anchorWorld || !far) return null;
  // Bends are measured from the anchor and NOT rounded — the two ends are
  // resolved holes, so the vector between them is exact, and a rail's rows are
  // not on the pin-board's lattice (see #trackResistorEndDrag).
  const params = def.normalizeParams({
    ...comp.params,
    rot: 90,
    end: { dx: far.x - anchorWorld.x, dy: far.y - anchorWorld.y },
  });
  return { ...at, params };
}

/**
 * How the ends riding ONE part re-address when it moves from `before` to
 * `after` — the ride rule itself, as a function of a rider's address.
 *
 * A rider follows the PIN whose node it sits in: it keeps its ROW, shifts by
 * THAT pin's own column delta, lands on THAT pin's target board, and must still
 * be in that pin's node afterwards. Where two pins share a node (a rotated
 * part's two ends can), the first in pin order owns it — under any move that
 * keeps the part in one piece they agree anyway.
 *
 * The returned lookup answers three different things, and the caller has to
 * tell them apart:
 *   `string`     — where the rider lands.
 *   `null`       — it has nowhere to land: neither its own row nor that row
 *                  reflected across the trench is a hole of the pin's new node.
 *                  Stated as "must be in the node", not as a list of ways to
 *                  fail, so anything the footprint vocabulary grows is caught by
 *                  construction rather than enumerated.
 *   `undefined`  — that address is in no node of this part at all, i.e. it never
 *                  rode it. Only reachable from a stale frozen set.
 *
 * Null overall when either state doesn't resolve (unknown ref, missing board, an
 * anchor the footprint doesn't fit).
 *
 * @param {{ boards: Array }} doc
 * @param {{ ref:string, board:string, anchor:string, params?:object }} before
 * @param {{ ref:string, board:string, anchor:string, params?:object }} after
 * @returns {((address:string) => string|null|undefined)|null}
 */
export function partRideShift(doc, before, after) {
  const boards = doc?.boards ?? [];
  if (!before || !after || before.board == null || after.board == null) {
    return null;
  }
  if (!boards.some((b) => b.id === after.board)) return null;
  const was = partPinAddresses(doc, before);
  const now = partPinAddresses(doc, after);
  if (!was || !now || was.length !== now.length) return null;

  // One entry per node the part's pins occupy BEFORE the move: which strip that
  // pin lands on, how far along it travels, and the node it has to end up in.
  const byNode = new Map();
  for (let i = 0; i < was.length; i += 1) {
    const fromAddr = was[i]?.address;
    const toAddr = now[i]?.address;
    if (fromAddr == null || toAddr == null) continue; // a floating lead carries nothing
    const key = nodeKeyOf(boards, fromAddr);
    if (!key || byNode.has(key)) continue; // rails own no node; first pin wins
    const afterKey = nodeKeyOf(boards, toAddr);
    if (!afterKey) continue; // this pin left the grid — it can carry nothing
    const a = parseAddress(fromAddr);
    const b = parseAddress(toAddr);
    const fromBoard = boards.find((x) => x.id === a?.boardId);
    const toBoard = boards.find((x) => x.id === b?.boardId);
    if (!fromBoard || !toBoard) continue;
    let one = null;
    let two = null;
    try {
      one = parseHole(fromBoard.type, a.hole);
      two = parseHole(toBoard.type, b.hole);
    } catch {
      continue; // a junk board type shifts nothing
    }
    if (one?.kind !== "grid" || two?.kind !== "grid") continue;
    byNode.set(key, {
      fromType: fromBoard.type,
      toType: toBoard.type,
      toBoardId: toBoard.id,
      dcol: two.col - one.col,
      drow: rowsBetween(one.row, two.row) ?? 0,
      afterKey,
    });
  }

  return (address) => {
    const key = nodeKeyOf(boards, address);
    if (!key) return undefined;
    const entry = byNode.get(key);
    if (!entry) return undefined;
    const parsed = parseAddress(address);
    const hole = holeAlongTo(
      entry.fromType,
      entry.toType,
      parsed.hole,
      entry.dcol,
    );
    if (!hole) return null; // off the end of the strip it is landing on
    // Its own row first, then the row that keeps it the same number of HOLES
    // from the pin as it was — the pin's own row delta applied to it. Two
    // candidates, not a search, and staying put wins whenever staying put works,
    // which is every move that leaves the pin in its own half.
    //
    // The second one is what lets a selection cross the TRENCH. Rows a–e and f–j
    // are separate nodes, so a rider that only ever kept its row was stranded in
    // the half its pin had just left and the plan could only refuse — which read
    // as "there is no room over there" when there was plenty. Travelling with
    // the pin instead keeps the ARRANGEMENT: a wire two holes above a part is
    // still two holes above it afterwards, which is also why the pins and their
    // riders stay disjoint (it is one rigid shift of both).
    //
    // Run the wiring off the end of the board and it refuses, which is honest —
    // the row simply isn't there. Dropping a row nearer the trench fits.
    for (const candidate of [
      hole,
      holeAcross(entry.toType, hole, entry.drow),
    ]) {
      if (!candidate) continue;
      const landed = formatAddress(entry.toBoardId, candidate);
      if (nodeKeyOf(boards, landed) === entry.afterKey) return landed;
    }
    return null;
  };
}

/**
 * The waypoint translation a routed wire's bends take when it rides — or null
 * for "leave them exactly where the user put them".
 *
 * Waypoints are the one part of a wire that is NOT an address, so they are the
 * one part that has to be moved by hand (as `translateAll` and `pasteDesign`
 * also do). Only a wire riding by BOTH ends translates: with one end pinned the
 * bend still belongs where it was drawn. The shift is read off the ENDS rather
 * than off the part's anchor, because those are not the same vector — a rider
 * keeps its ROW and shifts by a COLUMN, so a discrete slid `a5 → c7` moves its
 * riders (2, 0) while its anchor moves (2, 2), and the bends would come out two
 * rows below the wire they belong to. The two ends must agree, which for one
 * part they always do and for a CLUSTER is the test of whether the wire is being
 * carried or stretched.
 *
 * @param {Array} boards
 * @param {{from:string, to:string, layout?:string, points?:Array}} wire
 * @param {{from:string, to:string}} next
 * @param {boolean} bothEndsRide
 */
export function ridePointShift(boards, wire, next, bothEndsRide) {
  if (!bothEndsRide || wire?.layout !== "routed" || !wire.points?.length) {
    return null;
  }
  const shifts = ["from", "to"].map((end) => {
    const a = worldOfAddress(boards, wire[end]);
    const b = worldOfAddress(boards, next[end]);
    return a && b ? { dx: b.x - a.x, dy: b.y - a.y } : null;
  });
  const [a, b] = shifts;
  if (!a || !b || a.dx !== b.dx || a.dy !== b.dy) return null;
  return a.dx === 0 && a.dy === 0 ? null : a;
}

/**
 * Where `riding` lands when part `id` re-seats at `board`.`anchor`:
 *
 *   `moves`    — `[{ id, from, to }]` for `DeskDoc.moveWiresBatch`, BOTH ends
 *                stated (a fixed end restates its own address). EXACTLY one
 *                entry per riding wire, always — including one that doesn't
 *                actually move (a discrete slid along its own column-half stays
 *                in the same node, so its riders stay in their holes). The
 *                no-op entry is not noise: it is what tells a batch check the
 *                hole is still SPOKEN FOR, and it lets every caller
 *                length-check `moves` against the frozen riding set with no
 *                second convention to remember.
 *   `points`    — `[{ id, dx, dy }]` waypoint translations, for the routed wires
 *                riding by BOTH ends; see `ridePointShift`.
 *   `parts`     — `[{ id, board, anchor, params }]`, one per riding two-terminal
 *                PART: where it lands, and the form it lands in. Same
 *                always-named rule as `moves`.
 *   `resolved`  — false when any rider has nowhere to land. The caller reddens
 *                the drop; it never invents a hole or drops a rider.
 *
 * `params` states the form the part is landing IN, for the one mover whose form
 * changes as it moves: a rotatable part's body drag rewrites it into the
 * two-free-ends form. Omit it and the part keeps what it has.
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @param {{ id:string, riding:Array, ridingParts:Array, board:string,
 *   anchor:string, params?:object }} target
 */
export function planPartMove(
  doc,
  { id, riding, ridingParts, board: boardId, anchor, params },
) {
  const comp = (doc.components ?? []).find((c) => c && c.id === id);
  if (!comp || comp.board == null) return REFUSED;
  const shift = partRideShift(doc, comp, {
    ...comp,
    board: boardId,
    anchor,
    params: params ?? comp.params,
  });
  if (!shift) return REFUSED;

  const list = riding ?? [];
  const legs = ridingParts ?? [];
  if (list.length === 0 && legs.length === 0) {
    return { moves: [], points: [], parts: [], resolved: true };
  }

  const boards = doc.boards ?? [];
  const byId = new Map((doc.wires ?? []).map((w) => [w.id, w]));
  const moves = [];
  const points = [];
  for (const { wireId, ends } of list) {
    const wire = byId.get(wireId);
    if (!wire) return REFUSED; // the frozen set names a wire since deleted
    const next = { id: wireId, from: wire.from, to: wire.to };
    for (const end of ends) {
      const landed = shift(wire[end]);
      // Both refusals are the same answer to the caller: `null` is a rider with
      // nowhere to go, `undefined` a frozen set that no longer describes the
      // part. Neither is a hole to invent.
      if (!landed) return REFUSED;
      next[end] = landed;
    }
    moves.push(next);
    const bends = ridePointShift(boards, wire, next, ends.length === 2);
    if (bends) points.push({ id: wireId, ...bends });
  }

  const parts = [];
  for (const { id: leadId, pins } of legs) {
    const rider = (doc.components ?? []).find((c) => c && c.id === leadId);
    if (!rider) return REFUSED; // the frozen set names a part since deleted
    const seat = planRidingLead(
      doc,
      rider,
      pins.map(({ pin }) => ({ pin, shift })),
    );
    if (!seat) return REFUSED;
    parts.push(seat);
  }

  return { moves, points, parts, resolved: true };
}
