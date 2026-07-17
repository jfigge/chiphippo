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

import { chipDef } from "../catalog/index.js";
import { allPinHoles } from "./footprints.js";
import { formatAddress, parseAddress, parseHole } from "./breadboard.js";

const ANCHOR_RE = /^e([1-9]\d*)$/; // a chip anchor is pin 1's hole, row e

/**
 * The seated hole of every pin of a chip: `ref` + `anchor` → derived
 * `[{ pin, hole }]`, or null when the ref is unknown or the anchor isn't a
 * row-e hole id. (Whether each hole exists on a given board type is the
 * caller's check — this is pure footprint arithmetic.)
 */
export function chipPinHoles(ref, anchor) {
  const def = chipDef(ref);
  if (!def) return null;
  const m = ANCHOR_RE.exec(typeof anchor === "string" ? anchor : "");
  if (!m) return null;
  return allPinHoles(def.package, Number(m[1])).map(({ pin, row, col }) => ({
    pin,
    hole: `${row}${col}`,
  }));
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
    if (!comp || comp.kind !== "chip") continue;
    const pins = chipPinHoles(comp.ref, comp.anchor);
    if (!pins) continue;
    for (const { pin, hole } of pins) {
      map.set(formatAddress(comp.board, hole), {
        kind: "pin",
        componentId: comp.id,
        pin,
      });
    }
  }
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
 * Is `address` a real, unoccupied hole? True when it parses, its board
 * exists, the hole exists on that board's type, and no lead sits in it.
 *
 * @param {{ boards: Array, components: Array, wires: Array }} doc
 * @param {string} address - e.g. "bb1.j5"
 */
export function isFreeHole(doc, address) {
  const parsed = parseAddress(address);
  if (!parsed) return false;
  const board = (doc.boards ?? []).find((b) => b.id === parsed.boardId);
  if (!board) return false;
  if (!parseHole(board.type, parsed.hole)) return false;
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
 * May a chip seat here? True when the board exists, the anchor is a row-e
 * hole, EVERY pin's hole exists on the board type (rows e/f across the one
 * trench by construction), and every hole is free — ignoring the pins of
 * `ignoreId` (a chip may move within its own footprint).
 *
 * @param {{ boards: Array, components: Array }} doc
 * @param {{ ref: string, board: string, anchor: string, ignoreId?: string|null }} opts
 */
export function canPlaceChip(
  doc,
  { ref, board: boardId, anchor, ignoreId = null },
) {
  const board = (doc.boards ?? []).find((b) => b.id === boardId);
  if (!board) return false;
  const pins = chipPinHoles(ref, anchor);
  if (!pins) return false;
  const occupancy = buildOccupancy(doc);
  for (const { hole } of pins) {
    if (!parseHole(board.type, hole)) return false; // off the board
    const occupant = occupancy.get(formatAddress(boardId, hole));
    if (occupant && occupant.componentId !== ignoreId) return false;
  }
  return true;
}
