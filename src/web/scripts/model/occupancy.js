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
//
// A part is always seated on ONE board — for a breadboard kit, the centre
// pin-board. Most pins therefore resolve within that board by footprint
// arithmetic alone. The exception is a rotated two-terminal part's FREE LEAD,
// which is stored as a `{dx, dy}` bend and may land on a neighbouring strip
// (usually a power rail). That lead is resolved GEOMETRICALLY, against
// whatever board lies under it — so pulling the rail away leaves the part
// seated where it was, with the lead floating.

import { partDef } from "../catalog/index.js";
import { allPinHoles } from "./footprints.js";
import {
  boardSize,
  formatAddress,
  holeAt,
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
 *
 * A rotated part's free lead has no hole on the part's own board: its entry
 * is `{ pin, offset }` instead of `{ pin, hole }`, since where it lands
 * depends on the desk. Use partPinAddresses() to resolve it.
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
    // Rotated (vertical) two-free-ends form: pin 1 at the anchor hole, pin 2
    // bent to a {dx, dy} offset instead of a footprint offset. The bend may
    // reach off this board entirely, so it stays geometry here.
    if (def.rotatable && params?.rot === 90) {
      const end = params.end;
      if (!end || !Number.isInteger(end.dx) || !Number.isInteger(end.dy)) {
        return null;
      }
      if (!GRID_ANCHOR_RE.test(anchor)) return null;
      return [
        { pin: def.pins[0].n, hole: anchor },
        { pin: def.pins[1].n, offset: { dx: end.dx, dy: end.dy } },
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
 * The board + hole under a world point, with the hole's exact world position,
 * or null over bare desk (or over a board but between holes).
 *
 * The ONE authority for "what is under this point" — hover, the wire tool,
 * part drags, and addressAtWorld() all come through here, so none of them can
 * drift apart on the boundary cases.
 *
 * Boards never overlap, but mated strips meet FLUSH and the bounds test is
 * inclusive on every edge, so a point on a shared seam falls inside BOTH
 * neighbours' boxes. A box hit with no hole near enough therefore has to keep
 * looking: giving up on the first box would make the answer depend on board
 * order and hide the neighbour's holes along every dovetail.
 *
 * @param {Array<{id:string,type:string,x:number,y:number,rot?:number}>} boards
 * @returns {{board:object, hole:string, x:number, y:number}|null}
 */
export function holeAtWorld(boards, x, y) {
  for (const board of boards ?? []) {
    const rot = board.rot ?? 0;
    let size;
    try {
      size = boardSize(board.type, rot);
    } catch {
      continue; // a foreign/junk board type never owns a hole
    }
    if (x < board.x || y < board.y) continue;
    if (x > board.x + size.width || y > board.y + size.height) continue;
    const hole = holeAt(board.type, x - board.x, y - board.y, rot);
    if (!hole) continue;
    const pos = holePosition(board.type, hole, rot);
    if (!pos) continue;
    return { board, hole, x: board.x + pos.x, y: board.y + pos.y };
  }
  return null;
}

/**
 * The desk address of the hole at a world point, or null over bare desk.
 *
 * @param {Array<{id:string,type:string,x:number,y:number}>} boards
 */
export function addressAtWorld(boards, x, y) {
  const hit = holeAtWorld(boards, x, y);
  return hit ? formatAddress(hit.board.id, hit.hole) : null;
}

/**
 * Every pin of a seated part as a DESK ADDRESS, resolving a rotated part's
 * free lead against whatever board lies under its bend.
 *
 * Returns `[{ pin, address }]` where `address` is null for a lead that
 * currently touches nothing — a floating leg, which is a legal state, not an
 * error. Returns null only when the part itself can't be resolved (unknown
 * ref, missing board, anchor off the footprint).
 *
 * @param {{ boards: Array }} doc
 * @param {{ ref:string, board:string, anchor:string, params?:object }} comp
 */
export function partPinAddresses(doc, comp) {
  const boards = doc?.boards ?? [];
  const board = boards.find((b) => b.id === comp?.board);
  if (!board) return null;
  const pins = partPinHoles(comp.ref, comp.anchor, comp.params);
  if (!pins) return null;

  // The anchor's world position — the origin every bend is measured from.
  // Guarded like addressAtWorld/worldOfAddress: a junk board type resolves to
  // nothing rather than throwing, so one corrupt entry can't take out a whole
  // occupancy rebuild.
  let anchorWorld = null;
  if (pins.some((p) => p.offset)) {
    let pos = null;
    try {
      pos = holePosition(board.type, comp.anchor, board.rot ?? 0);
    } catch {
      return null;
    }
    if (!pos) return null;
    anchorWorld = { x: board.x + pos.x, y: board.y + pos.y };
  }

  return pins.map(({ pin, hole, offset }) => {
    if (hole != null) {
      // On the part's own board — but still only real if the type has it.
      if (!parseHole(board.type, hole)) return { pin, address: null };
      return { pin, address: formatAddress(board.id, hole) };
    }
    return {
      pin,
      address: addressAtWorld(
        boards,
        anchorWorld.x + offset.dx,
        anchorWorld.y + offset.dy,
      ),
    };
  });
}

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
    const pins = partPinAddresses(doc, comp);
    if (!pins) continue;
    for (const { pin, address } of pins) {
      // A floating lead occupies nothing.
      if (address == null) continue;
      map.set(address, { kind: "pin", componentId: comp.id, pin });
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
 * The world position (pitch units) of an address's hole, or null when the
 * board is gone or the hole doesn't exist on its type.
 *
 * @param {Array<{id:string,type:string,x:number,y:number}>} boards
 */
export function worldOfAddress(boards, address) {
  const parsed = parseAddress(address);
  if (!parsed) return null;
  const board = (boards ?? []).find((b) => b.id === parsed.boardId);
  if (!board) return null;
  let pos = null;
  try {
    pos = holePosition(board.type, parsed.hole, board.rot ?? 0);
  } catch {
    return null; // junk board type
  }
  return pos ? { x: board.x + pos.x, y: board.y + pos.y } : null;
}

/**
 * May a board part (chip or discrete) seat here? True when the board exists,
 * the anchor fits the footprint (chips row e; discretes any grid row), EVERY
 * lead lands in a real hole, and every one of those holes is free — ignoring
 * the pins of `ignoreId` (a part may move within its own footprint).
 *
 * Note a rotated part's free lead may legally land on a DIFFERENT board (a
 * power rail alongside the pin-board); it must still land in a real hole.
 * Floating is a state a part falls into when a strip is moved or deleted out
 * from under it — never one you can deliberately place into.
 *
 * @param {{ boards: Array, components: Array }} doc
 * @param {{ ref: string, board: string, anchor: string, ignoreId?: string|null }} opts
 */
export function canPlacePart(
  doc,
  { ref, board: boardId, anchor, params = null, ignoreId = null },
) {
  const boards = doc.boards ?? [];
  if (!boards.some((b) => b.id === boardId)) return false;
  const def = partDef(ref);
  const pins = partPinAddresses(doc, { ref, board: boardId, anchor, params });
  if (!pins) return false;
  if (pins.some((p) => p.address == null)) return false; // a lead in mid-air
  // A rotated part's two ends must be DISTINCT holes (a wire could join a
  // node's own holes; a two-terminal device pinned to one hole is nonsense).
  if (params?.rot === 90 && pins[0].address === pins[1].address) return false;
  // Two-terminal parts with a declared minimum lead span (a resistor's body
  // needs room) must keep their ends that far apart — any angle, any distance
  // beyond it, so a lead can reach the far rail.
  if (def?.minSpan && pins.length === 2) {
    const pa = worldOfAddress(boards, pins[0].address);
    const pb = worldOfAddress(boards, pins[1].address);
    if (!pa || !pb) return false;
    if (Math.hypot(pb.x - pa.x, pb.y - pa.y) < def.minSpan) return false;
  }
  const occupancy = buildOccupancy(doc);
  for (const { address } of pins) {
    const occupant = occupancy.get(address);
    if (occupant && occupant.componentId !== ignoreId) return false;
  }
  return true;
}

/** Back-compat alias (Feature 40 name). */
export const canPlaceChip = canPlacePart;
