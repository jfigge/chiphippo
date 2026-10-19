/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
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

import { footprintOffsets, partDef } from "../catalog/index.js";
import {
  dipRows,
  isWidePackage,
  packageSpec,
  seatedRows,
  seatRow,
  seatsWide,
  WIDE_SEAT_ROWS,
} from "./footprints.js";
import {
  boardSize,
  clampColumn,
  columnAt,
  holePosition,
  ROTATIONS,
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

/** How far a seated chip's drawing reaches past its outer pin rows (its legs
    and the body's edge — chip-view.js `chipBox`), in pitch units. */
const LEG_REACH = 0.6;

/** A row's y in a strip's own frame (every column shares it), or null. */
function rowY(type, row) {
  return holePosition(type, `${row}1`)?.y ?? null;
}

/** The y halfway between a seat's two pin rows — the middle of the chip. */
function seatMiddle(type, rows) {
  const lower = rowY(type, rows.lower);
  const upper = rowY(type, rows.upper);
  return lower == null || upper == null ? null : (lower + upper) / 2;
}

/**
 * Does a chip in this seat seat from a pointer at `y`? Anywhere it is DRAWN
 * over (its two pin rows and the legs past them), so it can be picked up by
 * any part of it and dragged — and, however narrow it is, anywhere within
 * SEAT_BAND of the trench, so a ghost snaps onto the trench from a band away.
 */
function seatsFrom(type, rows, y) {
  const lower = rowY(type, rows.lower);
  const upper = rowY(type, rows.upper);
  if (lower == null || upper == null) return false;
  const top = Math.min(lower, upper) - LEG_REACH;
  const bottom = Math.max(lower, upper) + LEG_REACH;
  return (y >= top && y <= bottom) || trenchOffset(type, y) <= SEAT_BAND;
}

/**
 * The seats a package may take when it is placed or moved on its own, the one
 * it takes with nothing to choose between them first: e/f for a 300-mil
 * package; for a 600-mil one every pair of rows six pitches apart across the
 * trench — d/h, then c/g, e/i and b/f (footprints.js `WIDE_SEAT_ROWS`).
 * @returns {Array<{ row: string, wide: boolean, rows: object }>}
 */
function freshSeats(pkg) {
  const first = seatRow(pkg);
  if (!isWidePackage(pkg)) {
    return [{ row: first, wide: false, rows: dipRows(pkg, first) }];
  }
  const rows = [first, ...WIDE_SEAT_ROWS.filter((r) => r !== first)];
  return rows.map((row) => ({
    row,
    wide: true,
    rows: dipRows(pkg, row, true),
  }));
}

/**
 * The seat a DIP takes for a pointer at `y`: the one whose MIDDLE is nearest
 * `y - grabDy` — the cursor for a ghost (which is drawn centred on it), the
 * point the grab started from for a drag (so a chip picked up by its top edge
 * does not jump a seat on the first move). Ties go to the earlier seat.
 */
function nearestSeat(type, pkg, y, grabDy) {
  const target = y - grabDy;
  let best = null;
  let bestGap = Infinity;
  for (const seat of freshSeats(pkg)) {
    const middle = seatMiddle(type, seat.rows);
    if (middle == null) continue;
    const gap = Math.abs(middle - target);
    if (gap < bestGap - 1e-9) {
      best = seat;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * How far below the middle of its seat (world units, + downward) a point on a
 * seated chip is — what a drag that begins there passes as `grabDy`, so the
 * chip moves between seats by the pointer's travel rather than its position.
 * 0 for anything that is not a seated DIP.
 * @param {Array<{id:string,type:string,y:number}>} boards
 * @param {{ref:string, board:string, anchor:string, params?:object}} comp
 * @param {{x:number,y:number}} world
 */
export function seatGrabDy(boards, comp, world) {
  const pkg = partDef(comp?.ref)?.package;
  const board = (boards ?? []).find((b) => b.id === comp?.board);
  if (!pkg || !board) return 0;
  const rows = seatedRows(pkg, comp.anchor, comp.params);
  const middle = rows ? seatMiddle(board.type, rows) : null;
  return middle == null ? 0 : world.y - (board.y + middle);
}

/** How far the cursor may sit from a grid row and still seat a discrete on it. */
export const ROW_BAND = 0.8;

/**
 * The seat a part would take under a world point, or null.
 *
 * `grabOffsetCols` is null for a ghost (the footprint centres on the cursor)
 * and otherwise the column offset captured when a drag began, so a dragged
 * part keeps the grab point under the finger instead of jumping to its centre.
 * A drag held at pin 1's own column has an offset of 0 — a number like any
 * other, which is why the ghost is null and not 0: read as the ghost, that
 * grab threw a chip half its length left on the first move.
 *
 * A board whose box contains the point but which cannot host the part does NOT
 * end the search — flush strips share an inclusive seam, so both neighbours
 * claim a point on it and the answer would otherwise depend on board order.
 *
 * @param {Array<{id:string,type:string,x:number,y:number,rot?:number}>} boards
 * @param {string} ref
 * @param {{x:number,y:number}} world
 * @param {number|null} [grabOffsetCols]
 * @param {{rot?:number}|null} [params] - a `def.can` part's current
 *   quarter-turn, and a linear part's size where it has one (an inductor's
 *   holes between its leads — catalog/index.js `footprintOffsets`).
 *   A DIP's params say whether row e is its wide e/i seat (`seatsWide`).
 * @param {{chipRow?:string, grabDy?:number}} [opts] - `chipRow` seats a DIP
 *   with pin 1 in THAT row (and `params`' e/i marker) rather than the seat
 *   nearest the pointer: a chip carried in a rigid group keeps the seat it has
 *   — see cluster-move.js. `grabDy` is a drag's `seatGrabDy`.
 * @returns {{board:string, anchor:string, wide?:boolean}|null} — `wide` for a
 *   600-mil DIP: whether the seat is the e/i one (footprints.js `withSeat`
 *   writes it into the chip's params).
 */
export function partSeatAt(
  boards,
  ref,
  world,
  grabOffsetCols = null,
  params = null,
  { chipRow = null, grabDy = 0 } = {},
) {
  const def = partDef(ref);
  if (!def) return null;
  for (const board of boards ?? []) {
    const local = localPoint(board, world);
    if (!local) continue;
    const turn = def.turns && ROTATIONS.includes(params?.rot) ? params.rot : 0;
    const seat = def.can
      ? canSeat(board, def, local, grabOffsetCols, params?.rot ?? 0)
      : turn !== 0
        ? rigidSeat(board, turnedSpan(def, params, turn), local, grabOffsetCols)
        : def.package
          ? chipSeat(board, def.package, local, grabOffsetCols, {
              chipRow,
              wide: seatsWide(params),
              grabDy,
            })
          : discreteSeat(board, def, local, grabOffsetCols, params);
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

/**
 * A DIP straddles the trench: pin 1 in row e for a 300-mil package; a 600-mil
 * one at its true width, its pins six pitches apart in whichever of rows
 * b/f, c/g, d/h and e/i the pointer is nearest (`nearestSeat`). `chipRow`
 * (with `wide`, the e/i marker) asks for one seat instead; a row the package
 * cannot anchor in seats nowhere.
 */
function chipSeat(
  board,
  pkg,
  local,
  grabOffsetCols,
  { chipRow, wide, grabDy },
) {
  const { colSpan } = packageSpec(pkg);
  // Rails carry no trench at all — nothing can straddle them.
  if (trenchOffset(board.type, local.y) == null) return null;
  const seat =
    chipRow != null
      ? { row: chipRow, wide, rows: dipRows(pkg, chipRow, wide) }
      : nearestSeat(board.type, pkg, local.y, grabDy);
  if (!seat?.rows || !seatsFrom(board.type, seat.rows, local.y)) return null;
  const cursorCol = columnAt(board.type, local.x);
  const col =
    grabOffsetCols == null
      ? cursorCol - colSpan / 2 // ghost: chip centred on the cursor
      : cursorCol + grabOffsetCols; // drag: keep the grab point
  const anchor = clampColumn(board.type, col, colSpan);
  if (anchor == null) return null;
  const at = { board: board.id, anchor: `${seat.row}${anchor}` };
  // Only a 600-mil package has an e/i seat to say yes or no to.
  return isWidePackage(pkg) ? { ...at, wide: seat.row === "e" && seat.wide } : at; // prettier-ignore
}

/** A discrete lies along ONE grid row — whichever row the cursor is nearest. */
function discreteSeat(board, def, local, grabOffsetCols, params) {
  const offsets = footprintOffsets(def, params);
  if (!offsets) return null; // a brick has terminals, not a board seat
  const span = offsets[offsets.length - 1];
  const row = rowNear(board.type, local.y, ROW_BAND);
  if (!row) return null; // rails / trench / margins
  const cursorCol = columnAt(board.type, local.x);
  const col =
    grabOffsetCols == null ? cursorCol - span / 2 : cursorCol + grabOffsetCols;
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
  return rigidSeat(
    board,
    rotateOffset({ dx: width, dy: -height }, rot),
    local,
    grabOffsetCols,
  );
}

/** A `def.turns` part turned off its row (the speaker): pin 1 → its far leg,
    the footprint's span turned as occupancy.js turns it. */
function turnedSpan(def, params, rot) {
  return rotateOffset({ dx: footprintOffsets(def, params).at(-1), dy: 0 }, rot);
}

/**
 * A rigid shape seated by pin 1 and the far corner `diag` from it (a can's
 * diagonal, a turned speaker's span): pin 1 in any grid row, the far corner
 * on a real row too, and the SHAPE centred on the cursor while placing.
 */
function rigidSeat(board, diag, local, grabOffsetCols) {
  // Ghost: centre the SHAPE on the cursor (pin 1 sits half the diagonal back
  // from the centre) — the two-axis generalization of discreteSeat's
  // `cursorCol - span / 2`. Dragging keeps the grabbed point under the
  // finger instead (grabOffsetCols is already anchor-relative).
  const target =
    grabOffsetCols == null
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
    (grabOffsetCols == null ? cursorCol : cursorCol + grabOffsetCols) + lo;
  const clampedLeft = clampColumn(board.type, leftCol, span);
  return clampedLeft == null
    ? null
    : { board: board.id, anchor: `${row}${clampedLeft - lo}` };
}
