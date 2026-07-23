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

// seating.js — where a part would SIT if you dropped it here: a world point →
// `{ board, anchor }`, or null over anything that cannot host it.
//
// This is the placement search, and it is deliberately more forgiving than
// holeAt(): a ghost snaps onto a row from a whole band away, and a DIP snaps
// to the trench from further still, so the part follows the cursor instead of
// flickering between holes. Only the BANDS live here — the row/column
// arithmetic itself belongs to breadboard.js and is called, never re-derived.
//
// Pure and DOM-free: the controller passes boards and a point, and gets back an
// address's worth of intent. Whether that seat is actually FREE is occupancy's
// question (canPlacePart), not this module's.

import { partDef } from "../catalog/index.js";
import { packageSpec } from "./footprints.js";
import {
  boardSize,
  clampColumn,
  columnAt,
  rotateOffset,
  rowNear,
  rowOffsetBy,
  trenchOffset,
  unrotatePoint,
} from "./breadboard.js";

/**
 * How far (pitch units) the cursor may sit from a chip's trench centre and
 * still seat its ghost — beyond it (e.g. out over the rails) nothing seats.
 */
export const SEAT_BAND = 2.5;

/** How far the cursor may sit from a grid row and still seat a discrete on it. */
export const ROW_BAND = 0.8;

/**
 * The seat a part would take under a world point, or null.
 *
 * `grabOffsetCols` is 0 for a ghost (the footprint centres on the cursor) and
 * otherwise the column offset captured when a drag began, so a dragged part
 * keeps the grab point under the finger instead of jumping to its centre.
 *
 * A board whose box contains the point but which cannot host the part does NOT
 * end the search — flush strips share an inclusive seam, so both neighbours
 * claim a point on it and the answer would otherwise depend on board order.
 *
 * @param {Array<{id:string,type:string,x:number,y:number,rot?:number}>} boards
 * @param {string} ref
 * @param {{x:number,y:number}} world
 * @param {number} [grabOffsetCols]
 * @param {{rot?:number}|null} [params] - only a `def.can` part's current
 *   quarter-turn matters here; every other seat search ignores it.
 * @returns {{board:string, anchor:string}|null}
 */
export function partSeatAt(
  boards,
  ref,
  world,
  grabOffsetCols = 0,
  params = null,
) {
  const def = partDef(ref);
  if (!def) return null;
  for (const board of boards ?? []) {
    const local = localPoint(board, world);
    if (!local) continue;
    const seat = def.can
      ? canSeat(board, def, local, grabOffsetCols, params?.rot ?? 0)
      : def.package
        ? chipSeat(board, def.package, local, grabOffsetCols)
        : discreteSeat(board, def, local, grabOffsetCols);
    if (seat) return seat;
  }
  return null;
}

/**
 * The point in a board's OWN unrotated frame, or null when it falls outside
 * the strip's footprint. Bounds are inclusive, so a point on a seam belongs to
 * both neighbours — see partSeatAt on why that must not end the search.
 */
function localPoint(board, world) {
  const rot = board.rot ?? 0;
  let size;
  try {
    size = boardSize(board.type, rot);
  } catch {
    return null; // a foreign/junk board type hosts nothing
  }
  const dx = world.x - board.x;
  const dy = world.y - board.y;
  if (dx < 0 || dy < 0 || dx > size.width || dy > size.height) return null;
  return unrotatePoint(board.type, { x: dx, y: dy }, rot);
}

/** A DIP straddles the trench, so its anchor is always row e. */
function chipSeat(board, pkg, local, grabOffsetCols) {
  const { halfPins } = packageSpec(pkg);
  // Rails carry no trench at all — nothing can straddle them.
  const offset = trenchOffset(board.type, local.y);
  if (offset == null || offset > SEAT_BAND) return null;
  const cursorCol = columnAt(board.type, local.x);
  const col =
    grabOffsetCols === 0
      ? cursorCol - (halfPins - 1) / 2 // ghost: chip centred on the cursor
      : cursorCol + grabOffsetCols; // drag: keep the grab point
  const anchor = clampColumn(board.type, col, halfPins - 1);
  return anchor == null ? null : { board: board.id, anchor: `e${anchor}` };
}

/** A discrete lies along ONE grid row — whichever row the cursor is nearest. */
function discreteSeat(board, def, local, grabOffsetCols) {
  const offsets = def.footprint?.offsets;
  if (!offsets) return null; // a brick has terminals, not a board seat
  const span = offsets[offsets.length - 1];
  const row = rowNear(board.type, local.y, ROW_BAND);
  if (!row) return null; // rails / trench / margins
  const cursorCol = columnAt(board.type, local.x);
  const col =
    grabOffsetCols === 0 ? cursorCol - span / 2 : cursorCol + grabOffsetCols;
  const anchor = clampColumn(board.type, col, span);
  return anchor == null ? null : { board: board.id, anchor: `${row}${anchor}` };
}

/**
 * A rigid multi-corner shape (an oscillator can) seats like a discrete — pin
 * 1 in any grid row, including straddling the trench — but its diagonally
 * opposite corner must ALSO land on a real row (rowOffsetBy), and the whole
 * SHAPE centres on the cursor rather than pin 1 alone, since pin 1 is not
 * always its top-left corner once rotated.
 */
function canSeat(board, def, local, grabOffsetCols, rot) {
  const { width, height } = def.can;
  // Pin 1 (the anchor) → the corner diagonally opposite it, at this rotation
  // — the same rotated offset model/occupancy.js's `def.can` branch uses.
  const diag = rotateOffset({ dx: width, dy: -height }, rot);
  // Ghost: centre the SHAPE on the cursor (pin 1 sits half the diagonal back
  // from the centre) — the two-axis generalization of discreteSeat's
  // `cursorCol - span / 2`. Dragging keeps the grabbed point under the
  // finger instead (grabOffsetCols is already anchor-relative).
  const target =
    grabOffsetCols === 0
      ? { x: local.x - diag.dx / 2, y: local.y - diag.dy / 2 }
      : local;

  const row = rowNear(board.type, target.y, ROW_BAND);
  if (!row) return null;
  if (!rowOffsetBy(board.type, row, diag.dy)) return null; // far corner's row

  const cursorCol = columnAt(board.type, target.x);
  // clampColumn assumes a forward-only, non-negative span from its anchor —
  // but pin 1 may be the shape's RIGHT edge (a negative diag.dx). Clamp the
  // shape's actual left edge instead, then shift back to pin 1's column.
  const lo = Math.min(0, diag.dx);
  const span = Math.abs(diag.dx);
  const leftCol =
    (grabOffsetCols === 0 ? cursorCol : cursorCol + grabOffsetCols) + lo;
  const clampedLeft = clampColumn(board.type, leftCol, span);
  return clampedLeft == null
    ? null
    : { board: board.id, anchor: `${row}${clampedLeft - lo}` };
}
