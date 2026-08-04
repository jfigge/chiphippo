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

// cluster-move.js — dragging a MULTI-SELECTION of parts as one rigid group, and
// (with Option) the wiring that rides it. Pure and DOM-free, over a plain
// document. The ride rule itself stays in `part-move.js`, which this calls once
// per member: there is one answer to "where does a rider land", and it lives in
// one file.
//
// THE WHOLE GROUP MOVES BY ONE WORLD DELTA, AND THAT DELTA IS THE GRABBED
// MEMBER'S OWN. Every form already knows how to resolve itself under the
// pointer — a footprint part through `partSeatAt` (which snaps to a row and
// CLAMPS at the end of a strip), a rotatable part by snapping pin 1 to the hole
// under it, a desk brick by whole units — so the grabbed member answers exactly
// as it would if it were dragged alone, and everything else is carried by the
// vector its answer implies. The alternative, rounding the pointer's own travel
// to whole pitches, cannot express the one move that matters most: a dovetailed
// stack puts the board below at 17.52 pitch, so an integer delta can never take
// a selection from one board to the next.
//
// A member on a board at some OTHER offset than the grabbed member's
// source→target pair lands between holes and the drop reddens. That is honest
// rather than a gap: two strips at different offsets have no common lattice, so
// there is no rigid move that seats parts on both.

import { partDef } from "../catalog/index.js";
import { formatAddress, parseAddress } from "./breadboard.js";
import { addressAtWorld, holeAtWorld, worldOfAddress } from "./occupancy.js";
import { memberAnchorWorld } from "./paste-cluster.js";
import {
  leadsRiding,
  partNodeKeys,
  partRideShift,
  planRidingLead,
  ridePointShift,
  wiresRidingPart,
} from "./part-move.js";
import { partSeatAt } from "./seating.js";

/** A refused plan — the caller reddens the drop rather than inventing a hole. */
const REFUSED = Object.freeze({
  moves: Object.freeze([]),
  points: Object.freeze([]),
  parts: Object.freeze([]),
  resolved: false,
});

/**
 * A member's DRAG form — which resolver it takes and how it commits.
 *
 * Deliberately NOT `paste-cluster.js`'s `memberForm`: there the question is what
 * shape to DRAW, so a rotatable part at rot 0 is a plain linear footprint. Here
 * the question is which gesture it belongs to, and `#onPartPointerDown` routes
 * on `def.rotatable` alone — a rot-0 LED drags by its two ends exactly as a
 * turned one does. Null for an unknown ref.
 */
export function memberDragForm(comp) {
  const def = comp ? partDef(comp.ref) : null;
  if (!def) return null;
  if (comp.board == null) return "brick"; // desk-level (PSU, clock)
  if (def.rotatable) return "lead"; // pin 1 seats, pin 2 is a bend from it
  return "footprint";
}

/**
 * Normalise a selection into draggable members, in DOCUMENT order so a cluster
 * lays out the same way however the selection was built.
 *
 * Null when ANY id fails to resolve — an unknown ref, a brick with no position,
 * a part whose anchor names no hole. The press then starts no drag at all,
 * which beats a gesture that is red wherever it goes.
 *
 * @param {{ boards: Array, components: Array }} doc
 * @param {Iterable<string>} ids
 * @returns {Array<object>|null}
 */
export function clusterMembers(doc, ids) {
  const want = new Set(ids ?? []);
  if (want.size === 0) return null;
  const boards = doc?.boards ?? [];
  const members = [];
  for (const comp of doc?.components ?? []) {
    if (!comp || !want.has(comp.id)) continue;
    const form = memberDragForm(comp);
    if (!form) return null;
    const anchorWorld = memberAnchorWorld(boards, comp);
    if (!anchorWorld) return null;
    members.push({
      id: comp.id,
      ref: comp.ref,
      kind: comp.kind,
      params: comp.params,
      form,
      board: comp.board,
      anchor: comp.anchor,
      x: comp.x,
      y: comp.y,
      anchorWorld,
    });
  }
  return members.length === want.size ? members : null;
}

/**
 * The rigid world delta the GRABBED member's own resolver yields for a pointer
 * at `world` — the one vector the whole cluster travels by.
 *
 * Null when the grabbed member seats nowhere (off the boards, between rows).
 * The caller then keeps the last good delta and reddens the drop, exactly as
 * `#resolvePartSeat` leaves `d.seat` alone and drops `d.legal` — a cluster that
 * snapped back to its origin every time the pointer strayed off a strip would be
 * unusable.
 *
 * @param {Array} boards
 * @param {{form:string, ref:string, params?:object, anchorWorld:{x,y},
 *   startWorld:{x,y}, grabOffsetCols?:number}} grab
 * @param {{x:number, y:number}} world
 * @param {Array} [members] - the whole cluster; see the brick case below
 * @returns {{dx:number, dy:number}|null}
 */
export function clusterDelta(boards, grab, world, members) {
  const travel = {
    dx: world.x - grab.startWorld.x,
    dy: world.y - grab.startWorld.y,
  };
  const raw = { dx: Math.round(travel.dx), dy: Math.round(travel.dy) };
  // The hole an anchor lands in, tried at the RAW travel first and the rounded
  // one second. Rounding assumes a lattice, and there is only one HORIZONTALLY:
  // the vertical heights are MEASURED, so the next pin-board of a spanned run
  // sits 17.52 pitch down and a rounded dy lands the anchor 0.48 off the hole it
  // aimed at — past holeAt's 0.45 radius, so a selection could not cross between
  // two boards at all. The rounded fallback keeps a same-board drag exactly as
  // it was, including the sliver between two rows where the raw point is nearest
  // to nothing; on one board the two always name the same hole whenever either
  // does.
  const snap = (anchorWorld) =>
    holeAtWorld(boards, anchorWorld.x + travel.dx, anchorWorld.y + travel.dy) ??
    holeAtWorld(boards, anchorWorld.x + raw.dx, anchorWorld.y + raw.dy);
  if (grab.form === "brick") {
    // A brick lives on the free desk, in whole units — but the GROUP's lattice
    // is the board's the moment the group holds anything seated on one, and
    // whole units are not fine enough for it. Two mated kits are 21.02 apart
    // (the heights are measured, not typed), so a rounded delta lands every
    // board part a hundredth of a pitch beside the holes it aimed at, and a
    // selection dragged BY ITS PSU could not cross between them at all. Snap
    // through a seated member instead — the same snap a `lead` grab makes, one
    // step over — and the brick follows the group rather than the group the
    // brick. With nothing seated there is no other lattice, so whole units it
    // is.
    const seated = (members ?? []).find((m) => m.form !== "brick");
    if (!seated) return raw;
    const hit = snap(seated.anchorWorld);
    if (!hit) return null;
    return {
      dx: hit.x - seated.anchorWorld.x,
      dy: hit.y - seated.anchorWorld.y,
    };
  }
  if (grab.form === "lead") {
    // Pin 1 rides the travel, then snaps to the hole it landed on — the hole's
    // own centre, which on a dovetailed rail is a fraction of a pitch off the
    // pin-board's rows. Take the rounded delta instead and the cluster would sit
    // a hair beside every hole it aimed at.
    const hit = snap(grab.anchorWorld);
    if (!hit) return null;
    return { dx: hit.x - grab.anchorWorld.x, dy: hit.y - grab.anchorWorld.y };
  }
  const seat = partSeatAt(
    boards,
    grab.ref,
    world,
    grab.grabOffsetCols ?? 0,
    grab.params,
  );
  if (!seat) return null;
  const landed = worldOfAddress(boards, formatAddress(seat.board, seat.anchor));
  if (!landed) return null;
  return {
    dx: landed.x - grab.anchorWorld.x,
    dy: landed.y - grab.anchorWorld.y,
  };
}

/**
 * Where every member lands under one rigid delta.
 *
 * A board part's anchor either falls squarely on a hole or on nothing — no hole
 * means nowhere to seat, and `resolved` goes false for the WHOLE cluster, since
 * a group drag that quietly left one part behind would be a silent edit. A desk
 * brick has no lattice to miss and always resolves; whether it OVERLAPS anything
 * is legality's question, not this one.
 *
 * @param {Array} boards
 * @param {Array} members - from clusterMembers
 * @param {{dx:number, dy:number}} delta
 * @returns {{targets: Array, resolved: boolean}}
 *   target: brick → {id, form, x, y}; board part → {id, form, board, anchor}
 */
export function resolveClusterTargets(boards, members, delta) {
  const targets = [];
  let resolved = true;
  for (const m of members ?? []) {
    if (m.form === "brick") {
      targets.push({
        id: m.id,
        form: m.form,
        x: Math.round(m.x + delta.dx),
        y: Math.round(m.y + delta.dy),
      });
      continue;
    }
    const parsed = parseAddress(
      addressAtWorld(
        boards,
        m.anchorWorld.x + delta.dx,
        m.anchorWorld.y + delta.dy,
      ),
    );
    if (!parsed) {
      resolved = false;
      targets.push({ id: m.id, form: m.form, board: null, anchor: null });
      continue;
    }
    targets.push({
      id: m.id,
      form: m.form,
      board: parsed.boardId,
      anchor: parsed.hole,
    });
  }
  return { targets, resolved };
}

/**
 * The wires riding the WHOLE cluster, merged per wire with each end attributed
 * to the member it rides — `[{ wireId, ends: [{ end, memberId }] }]`, in
 * document order.
 *
 * One wire can ride two different members, one end each: that is the ordinary
 * case of a jumper between two parts you selected together, and it is exactly
 * why the attribution has to be per END rather than per wire. Where two members
 * share a node (a chip pin in `e5` and a discrete pin in `a5` are both in
 * `bb1|c5L`) the first in document order owns the end — under a rigid move they
 * would carry it to the same place anyway.
 *
 * Read ONCE at pointerdown and frozen for the gesture, for the reason
 * `wiresRidingPart` states: re-derived per sample the set would grow and shrink
 * as the parts slid over other wires' holes, so the drop would depend on the
 * path taken to it rather than on where it landed.
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @param {Iterable<string>} ids
 */
export function wiresRidingCluster(doc, ids) {
  const want = new Set(ids ?? []);
  const claims = new Map(); // wireId → Map<end, memberId>
  for (const comp of doc?.components ?? []) {
    if (!comp || !want.has(comp.id)) continue;
    for (const { wireId, ends } of wiresRidingPart(doc, comp.id)) {
      let byEnd = claims.get(wireId);
      if (!byEnd) {
        byEnd = new Map();
        claims.set(wireId, byEnd);
      }
      for (const end of ends) if (!byEnd.has(end)) byEnd.set(end, comp.id);
    }
  }
  const riding = [];
  for (const wire of doc?.wires ?? []) {
    const byEnd = wire ? claims.get(wire.id) : null;
    if (!byEnd) continue;
    riding.push({
      wireId: wire.id,
      ends: ["from", "to"]
        .filter((end) => byEnd.has(end))
        .map((end) => ({ end, memberId: byEnd.get(end) })),
    });
  }
  return riding;
}

/**
 * The two-terminal PARTS riding the WHOLE cluster, each of their riding LEADS
 * attributed to the member it follows — `[{ id, pins: [{ pin, memberId }] }]`,
 * in document order. A resistor bridging two selected parts rides by both legs
 * and translates rigidly; one bridging a selected part and a fixed one rides by
 * the leg that is connected to the mover, and bends around the other.
 *
 * Members are excluded: a selected part travels as a MEMBER, not as its
 * neighbour's lead. Frozen at pointerdown with everything else.
 *
 * @param {{ boards: Array, components: Array }} doc
 * @param {Iterable<string>} ids
 */
export function partsRidingCluster(doc, ids) {
  const want = new Set(ids ?? []);
  // Node → the member that owns it, first in document order winning a shared
  // one, exactly as wiresRidingCluster attributes an end.
  const owners = new Map();
  for (const comp of doc?.components ?? []) {
    if (!comp || !want.has(comp.id)) continue;
    for (const key of partNodeKeys(doc, comp)) {
      if (!owners.has(key)) owners.set(key, comp.id);
    }
  }
  return leadsRiding(doc, owners, want);
}

/**
 * Where the cluster's riders land — the same four fields `planPartMove` answers
 * with, and the same contract:
 *
 *   `moves`    — EXACTLY one entry per riding wire, always, both ends stated.
 *                A wire that doesn't actually move still restates the addresses
 *                it is staying in, which is what tells the batch check those
 *                holes are still spoken for.
 *   `points`   — waypoint translations, only for a routed wire riding by BOTH
 *                ends whose two ends agree on where they are going. Disagreeing
 *                ends mean the wire is being STRETCHED between two members that
 *                resolved differently, and a bend drawn for the old shape has no
 *                claim on the new one.
 *   `parts`    — one entry per riding two-terminal part: where it lands, and the
 *                form it lands in (see `planRidingLead`).
 *   `resolved` — false when any rider has nowhere to land.
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @param {{members: Array, targets: Array, riding: Array,
 *   ridingParts: Array}} plan
 */
export function planClusterRiders(
  doc,
  { members, targets, riding, ridingParts },
) {
  const list = riding ?? [];
  const legs = ridingParts ?? [];
  if (list.length === 0 && legs.length === 0) {
    return { moves: [], points: [], parts: [], resolved: true };
  }
  const boards = doc?.boards ?? [];
  const byId = new Map((members ?? []).map((m) => [m.id, m]));
  const seatById = new Map((targets ?? []).map((t) => [t.id, t]));

  // One ride lookup per member, built once for the whole batch.
  const shifts = new Map();
  const shiftFor = (memberId) => {
    if (shifts.has(memberId)) return shifts.get(memberId);
    const member = byId.get(memberId);
    const seat = seatById.get(memberId);
    if (!member || !seat || seat.board == null) return null;
    // The bend of a rotatable member is carried untouched — it is measured
    // FROM the anchor, so a rigid translation needs no rewrite.
    const shift = partRideShift(doc, member, {
      ...member,
      board: seat.board,
      anchor: seat.anchor,
    });
    shifts.set(memberId, shift);
    return shift;
  };
  for (const { ends } of list) {
    for (const { memberId } of ends) if (!shiftFor(memberId)) return REFUSED;
  }
  for (const { pins } of legs) {
    for (const { memberId } of pins) if (!shiftFor(memberId)) return REFUSED;
  }

  const wires = new Map((doc?.wires ?? []).map((w) => [w.id, w]));
  const moves = [];
  const points = [];
  for (const { wireId, ends } of list) {
    const wire = wires.get(wireId);
    if (!wire) return REFUSED; // the frozen set names a wire since deleted
    const next = { id: wireId, from: wire.from, to: wire.to };
    for (const { end, memberId } of ends) {
      const landed = shifts.get(memberId)(wire[end]);
      if (!landed) return REFUSED;
      next[end] = landed;
    }
    moves.push(next);
    const bends = ridePointShift(boards, wire, next, ends.length === 2);
    if (bends) points.push({ id: wireId, ...bends });
  }

  const byIdComp = new Map((doc?.components ?? []).map((c) => [c.id, c]));
  const parts = [];
  for (const { id, pins } of legs) {
    const rider = byIdComp.get(id);
    if (!rider) return REFUSED; // the frozen set names a part since deleted
    const seat = planRidingLead(
      doc,
      rider,
      pins.map(({ pin, memberId }) => ({ pin, shift: shifts.get(memberId) })),
    );
    if (!seat) return REFUSED;
    parts.push(seat);
  }
  return { moves, points, parts, resolved: true };
}
