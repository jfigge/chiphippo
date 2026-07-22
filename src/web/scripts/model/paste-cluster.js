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

// paste-cluster.js — copy/paste of a MULTI-SELECTION as one rigidly-arranged
// cluster of FRESH parts. Copy captures each member's kind/ref/params (with
// run-volatile state stripped — a paste is brand new) and the world point it is
// anchored at; paste translates the whole arrangement by a single integer-pitch
// shift and asks, per member, "does this land legally?".
//
// The whole desk lives on the integer 0.1-in lattice (every hole is at an
// integer pitch coordinate), so a rigid integer shift preserves the arrangement
// exactly: a hole-anchored member either lands squarely on another hole or over
// nothing at all — never half a hole off. That is what makes "is every pin over
// an open hole?" a crisp yes/no per member.
//
// Pure and DOM-free: the controller feeds it a plain `{boards, components,
// wires}` and gets back a per-member seat + legality. Board-part collision
// stays occupancy's authority (canPlacePart); brick collision stays the
// document's (a passed canPlaceBrick).
//
// There is deliberately NO member-vs-member collision check. A captured cluster
// comes from a document where every pin already owns a distinct hole and no two
// bricks overlap, and a rigid integer translation preserves both (it's
// injective on holes and overlap-preserving on rects). So the ONLY way a member
// is illegal is by colliding with the EXISTING document or landing off a board
// — never with a sibling. (A source lead that floats over bare desk can't
// change that: to contend with a sibling's pin it would have had to sit on that
// sibling's occupied hole at the source, which no valid document allows.)

import { partDef } from "../catalog/index.js";
import { formatAddress, parseAddress } from "./breadboard.js";
import { addressAtWorld, canPlacePart, worldOfAddress } from "./occupancy.js";

/**
 * A member's placement FORM — drives its ghost drawing and how its seat
 * resolves. Null for an unknown ref.
 */
export function memberForm(ref, params) {
  const def = partDef(ref);
  if (!def) return null;
  if (def.package) return "chip"; // DIP straddling the trench
  if (def.kind === "psu" || def.kind === "clock") return "brick"; // desk-level
  if (def.rotatable && params?.rot === 90) return "turned"; // two free ends
  return "discrete"; // linear footprint along one grid row
}

/**
 * The world (pitch) point a component's placement is anchored to — its anchor
 * hole for a board part (chip: row-e pin 1; discrete/turned: pin 1's hole), or
 * its stored top-left for a desk brick. Null when it can't be resolved.
 */
export function memberAnchorWorld(boards, comp) {
  if (comp.board == null) {
    return Number.isFinite(comp.x) && Number.isFinite(comp.y)
      ? { x: comp.x, y: comp.y }
      : null;
  }
  return worldOfAddress(boards, formatAddress(comp.board, comp.anchor));
}

/**
 * Capture a fresh cluster from a set of source components. Each member keeps
 * only its kind/ref/params (deep-copied, with run-volatile 12 V damage stripped
 * — a paste is a brand-new part, never a reference to its source) and the world
 * point it is anchored at, so the arrangement can be re-stamped rigidly.
 * Members whose anchor can't resolve are skipped; null when nothing usable
 * remains.
 *
 * @param {Array} boards
 * @param {Array} comps - full component objects (from doc.getComponent)
 * @returns {{members: Array, center: {x:number,y:number}}|null}
 */
export function captureCluster(boards, comps) {
  const members = [];
  for (const comp of comps ?? []) {
    if (!comp || !partDef(comp.ref)) continue;
    const anchorWorld = memberAnchorWorld(boards, comp);
    if (!anchorWorld) continue;
    const params = comp.params ? JSON.parse(JSON.stringify(comp.params)) : {};
    delete params.damaged; // run-volatile — a fresh part is never pre-damaged
    members.push({ kind: comp.kind, ref: comp.ref, params, anchorWorld });
  }
  if (members.length === 0) return null;
  // The grab reference: the arrangement's bounding-box centre, so the cluster
  // tracks the cursor from its middle. Fractional is fine — the shift rounds.
  const xs = members.map((m) => m.anchorWorld.x);
  const ys = members.map((m) => m.anchorWorld.y);
  const center = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
  return { members, center };
}

/**
 * Resolve every member of a cluster shifted by `shift` (integer pitch): its
 * target seat and whether it lands legally. A board part is legal when it lands
 * with EVERY pin over a free hole (occupancy's canPlacePart); a brick when
 * `canPlaceBrick`. A member over bare desk (no hole under its anchor) is
 * illegal. See the module note on why no member-vs-member check is needed.
 *
 * @param {{boards:Array, components:Array, wires?:Array}} doc - the live document
 * @param {Array} members - from captureCluster
 * @param {{dx:number, dy:number}} shift - integer pitch translation
 * @param {(ref:string, x:number, y:number)=>boolean} canPlaceBrick
 * @returns {Array<{kind,ref,params,anchorWorld,form,seat,legal}>}
 *   seat: board part → {board, anchor}; brick → {x, y}; null when unresolved.
 */
export function resolveCluster(doc, members, shift, canPlaceBrick) {
  const boards = doc.boards ?? [];
  return (members ?? []).map((m) => {
    const form = memberForm(m.ref, m.params);
    const ax = m.anchorWorld.x + shift.dx;
    const ay = m.anchorWorld.y + shift.dy;
    if (form === "brick") {
      return {
        ...m,
        form,
        seat: { x: ax, y: ay },
        legal: canPlaceBrick(m.ref, ax, ay),
      };
    }
    // A board part: the shifted anchor either lands squarely on a hole or over
    // nothing. No hole → nowhere to seat → illegal.
    const parsed = parseAddress(addressAtWorld(boards, ax, ay));
    if (!parsed) return { ...m, form, seat: null, legal: false };
    const seat = { board: parsed.boardId, anchor: parsed.hole };
    const legal = canPlacePart(doc, {
      ref: m.ref,
      board: seat.board,
      anchor: seat.anchor,
      params: m.params,
    });
    return { ...m, form, seat, legal };
  });
}
