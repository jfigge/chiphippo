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

// occupancy.js — the app-wide collision authority: ONE hole holds at most one
// lead, whether it's a chip pin or a wire end. buildOccupancy() derives an
// address → occupant index from a desk document; chip and wire placement
// legality both check against it — never a second bookkeeping structure.
//
// Pure and DOM-free. Pin positions are always DERIVED (footprint + anchor),
// never stored.

import { partDef } from "../catalog/index.js";
import { allPinHoles } from "./footprints.js";
import {
  formatAddress,
  holePosition,
  parseAddress,
  parseHole,
} from "./breadboard.js";

const CHIP_ANCHOR_RE = /^e([1-9]\d*)$/; // a chip anchor: pin 1's hole, row e
const GRID_ANCHOR_RE = /^([a-j])([1-9]\d*)$/; // a discrete anchors in ANY row

/**
 * The seated hole of every pin of a board part (chip OR discrete):
 * `ref` + `anchor` → derived `[{ pin, hole }]`, or null when the ref is
 * unknown, isn't a board-seated part, or the anchor doesn't fit its
 * footprint (chips: row e; discretes: any grid row). Whether each hole
 * exists on a given board type is the caller's check — this is pure
 * footprint arithmetic.
 */
export function partPinHoles(ref, anchor, params) {
  const def = partDef(ref);
  if (!def || typeof anchor !== "string") return null;
  if (def.package) {
    // DIP chip straddling the trench.
    const m = CHIP_ANCHOR_RE.exec(anchor);
    if (!m) return null;
    const seated = allPinHoles(def.package, Number(m[1])).map(
      ({ pin, row, col }) => ({ pin, hole: `${row}${col}` }),
    );
    if (params?.rot !== 180) return seated;
    // Flipped 180°: a DIP's footprint maps onto ITSELF (same two rows, same
    // columns), so only the pin numbering turns half a lap — pin 1 lands where
    // the opposite corner pin sat. Applying it twice returns the original.
    const count = seated.length;
    const half = count / 2;
    const holeOfPin = new Map(seated.map((s) => [s.pin, s.hole]));
    return seated.map(({ pin }) => ({
      pin,
      hole: holeOfPin.get(((pin + half - 1) % count) + 1),
    }));
  }
  if (def.footprint) {
    // Rotated (vertical) two-free-ends form: pin 1 at the anchor hole, pin 2 at
    // `params.end` (any hole — rail or grid), instead of a footprint offset.
    if (def.rotatable && params?.rot === 90) {
      if (typeof params.end !== "string") return null;
      return [
        { pin: def.pins[0].n, hole: anchor },
        { pin: def.pins[1].n, hole: params.end },
      ];
    }
    // Linear discrete along one grid row.
    const m = GRID_ANCHOR_RE.exec(anchor);
    if (!m) return null;
    const [, row, colStr] = m;
    const col = Number(colStr);
    return def.footprint.offsets.map((offset, i) => ({
      pin: def.pins[i].n,
      hole: `${row}${col + offset}`,
    }));
  }
  return null; // a PSU has terminals, not board pins
}

/** Back-compat alias (Feature 40 name) — same derivation for chips. */
export const chipPinHoles = partPinHoles;

/**
 * Build the address → occupant index for a document. Occupants:
 *   { kind: "pin", componentId, pin }   — a seated chip pin
 *   { kind: "wire", wireId, end }       — a wire end ("from" | "to")
 *
 * Unresolvable entries (unknown ref, malformed anchor/address) contribute
 * nothing — normalizeDocument drops them on load anyway.
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @returns {Map<string, object>}
 */
export function buildOccupancy(doc) {
  const map = new Map();
  for (const comp of doc.components ?? []) {
    if (!comp || (comp.kind !== "chip" && comp.kind !== "discrete")) continue;
    const pins = partPinHoles(comp.ref, comp.anchor, comp.params);
    if (!pins) continue;
    for (const { pin, hole } of pins) {
      map.set(formatAddress(comp.board, hole), {
        kind: "pin",
        componentId: comp.id,
        pin,
      });
    }
  }
  // PSU terminals are connection POINTS like holes: free until a wire lands.
  for (const wire of doc.wires ?? []) {
    if (!wire || typeof wire !== "object") continue;
    for (const end of ["from", "to"]) {
      if (typeof wire[end] !== "string") continue;
      map.set(wire[end], { kind: "wire", wireId: wire.id, end });
    }
  }
  return map;
}

/**
 * Does `address` name a real connection point — a hole on an existing
 * board, or a terminal of an existing desk component (psu1.+)?
 */
export function isRealPoint(doc, address) {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  const board = (doc.boards ?? []).find((b) => b.id === parsed.boardId);
  if (board) return parseHole(board.type, parsed.hole) !== null;
  const comp = (doc.components ?? []).find((c) => c.id === parsed.boardId);
  if (comp) {
    const def = partDef(comp.ref);
    return Boolean(def?.terminals?.some((t) => t.id === parsed.hole));
  }
  return false;
}

/**
 * Is `address` a real, unoccupied connection point (hole or terminal)?
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @param {string} address - e.g. "bb1.j5" or "psu1.+"
 */
export function isFreeHole(doc, address) {
  if (!isRealPoint(doc, address)) return false;
  return !buildOccupancy(doc).has(address);
}

/**
 * May a wire connect these two holes? Both ends must be free, real holes,
 * and distinct (one hole holds one lead — a wire may still join two holes
 * of the SAME internal node, which is harmless and real boards do it).
 */
export function canPlaceWire(doc, from, to) {
  return from !== to && isFreeHole(doc, from) && isFreeHole(doc, to);
}

/**
 * May wire `wireId`'s `end` ("from" | "to") be re-addressed to `address`? Like
 * `canPlaceWire`, but for MOVING one end of an existing wire: the target must
 * be a real point, distinct from the wire's OTHER (anchored) end, and free —
 * ignoring the moving wire's own two endpoints (so it slides off its old hole
 * without colliding with itself).
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @param {string} wireId
 * @param {"from"|"to"} end
 * @param {string} address
 */
export function canReendWire(doc, wireId, end, address) {
  const wire = (doc.wires ?? []).find((w) => w && w.id === wireId);
  if (!wire || (end !== "from" && end !== "to")) return false;
  const other = end === "from" ? wire.to : wire.from;
  if (address === other || !isRealPoint(doc, address)) return false;
  const occupant = buildOccupancy(doc).get(address);
  return !occupant || (occupant.kind === "wire" && occupant.wireId === wireId);
}

/**
 * May wire `wireId` move RIGIDLY so its two ends land on `from` and `to` at
 * once (the drag-the-whole-wire gesture)? Both targets must be real, distinct
 * points, and free — ignoring the moving wire's OWN two endpoints, since it
 * slides off both old holes simultaneously.
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @param {string} wireId
 * @param {string} from
 * @param {string} to
 */
export function canMoveWire(doc, wireId, from, to) {
  if (from === to) return false;
  if (!isRealPoint(doc, from) || !isRealPoint(doc, to)) return false;
  const occupancy = buildOccupancy(doc);
  for (const address of [from, to]) {
    const occupant = occupancy.get(address);
    if (occupant && !(occupant.kind === "wire" && occupant.wireId === wireId)) {
      return false;
    }
  }
  return true;
}

/**
 * May a board part (chip or discrete) seat here? True when the board
 * exists, the anchor fits the footprint (chips row e; discretes any grid
 * row), EVERY pin's hole exists on the board type, and every hole is
 * free — ignoring the pins of `ignoreId` (a part may move within its own
 * footprint).
 *
 * @param {{ boards: Array, components: Array }} doc
 * @param {{ ref: string, board: string, anchor: string, ignoreId?: string|null }} opts
 */
export function canPlacePart(
  doc,
  { ref, board: boardId, anchor, params = null, ignoreId = null },
) {
  const board = (doc.boards ?? []).find((b) => b.id === boardId);
  if (!board) return false;
  const def = partDef(ref);
  const pins = partPinHoles(ref, anchor, params);
  if (!pins) return false;
  // A rotated part's two ends must be DISTINCT holes (a wire could join a
  // node's own holes; a two-terminal device pinned to one hole is nonsense).
  if (params?.rot === 90 && pins[0]?.hole === pins[1]?.hole) return false;
  // Two-terminal parts with a declared minimum lead span (a resistor's body
  // needs room) must keep their ends that far apart — any angle, any distance
  // beyond it, so a lead can reach the far rail.
  if (def?.minSpan && pins.length === 2) {
    const pa = holePosition(board.type, pins[0].hole);
    const pb = holePosition(board.type, pins[1].hole);
    if (!pa || !pb) return false;
    if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < def.minSpan) return false;
  }
  const occupancy = buildOccupancy(doc);
  for (const { hole } of pins) {
    if (!parseHole(board.type, hole)) return false; // off the board
    const occupant = occupancy.get(formatAddress(boardId, hole));
    if (occupant && occupant.componentId !== ignoreId) return false;
  }
  return true;
}

/** Back-compat alias (Feature 40 name). */
export const canPlaceChip = canPlacePart;
