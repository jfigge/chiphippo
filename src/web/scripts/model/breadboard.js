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

// breadboard.js — the pure breadboard model: hole addresses ⇄ positions ⇄
// internal electrical nodes, all derived from the specs in board-types.js.
// DOM-free and Electron-free; fully covered by node --test.
//
// "Board" here means one STRIP — a pin-board or a power rail. Each is its own
// entity on the desk (see board-types.js); a breadboard is a kit of them.
//
// Vocabulary (see CLAUDE.md → Domain reference):
//   hole    — "a12", "j63", "+7"        (row+column, or rail id + index)
//   address — "bb1.a12"                 (<boardId>.<hole>, the global currency)
//   node    — "c12L", "c12U", "+"       (what is electrically common inside
//              one strip: a 5-hole column-half, or a continuous rail)
//
// A VEROBOARD (board-types.js `veroSpec`) is the third kind: holes "C14"
// (strip C, hole 14 from the top), and a node is a run of copper — "SC" for a
// whole strip, "SC/15" for the segment that starts at hole 15 once the strip
// is cut, "SCx14" for the pad a cut at C14 has isolated. Its cuts are per
// BOARD, so the node functions take them as a trailing `cuts` argument and
// `boardNodeOf`/`boardHolesOfNode` hand a board's own over.
//
// Positions are PITCH UNITS relative to the strip's top-left origin. Nothing
// outside this module converts row/column arithmetic by hand — INCLUDING the
// quarter-turn a power rail may be placed at: hole ids and nodes are stated in
// the strip's own unrotated frame, and `rotatePoint`/`unrotatePoint` are the
// only bridge between that frame and the desk.

import { boardSpec } from "./board-types.js";

/** How close (pitch units) a point must be to a hole for holeAt to match. */
export const HOLE_HIT_RADIUS = 0.45;

/** The quarter-turns a strip can be placed at. */
export const ROTATIONS = Object.freeze([0, 90, 180, 270]);

/**
 * A pitch-unit vector turned one quarter-turn clockwise (screen/SVG y-down
 * frame — the same formula `rotate(90)` uses natively, so a view can spin a
 * canonical drawing with a plain SVG transform and the pin math never
 * disagrees with what's on screen). Apply `rot / 90` times for 0/90/180/270.
 */
function quarterTurn({ dx, dy }) {
  return { dx: -dy, dy: dx };
}

/**
 * `{dx, dy}` rotated by a quarter-turn count (0/90/180/270), CCW-invalid
 * values coerced to 0. Shared by every part footprint that spins a rigid
 * multi-pin shape in place (an oscillator can, say) — pin offsets and the
 * view's SVG rotation both derive from this ONE primitive.
 */
export function rotateOffset(offset, rot = 0) {
  let v = { dx: offset?.dx ?? 0, dy: offset?.dy ?? 0 };
  const turns = ROTATIONS.includes(rot) ? rot / 90 : 0;
  for (let i = 0; i < turns; i++) v = quarterTurn(v);
  // Negating a zero component yields -0: equal to 0 under ===, distinct under
  // Object.is, so it would survive into a stored offset and then fail a
  // deepStrictEqual round-trip (the same -0 trap normalizeLeadOffset guards
  // against). Fold it here, the one chokepoint every rotated offset passes
  // through.
  return { dx: v.dx === 0 ? 0 : v.dx, dy: v.dy === 0 ? 0 : v.dy };
}

/** Grid row letters, bottom row first (a is nearest the bottom edge). */
export const ROW_LETTERS = Object.freeze([
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
]);

/** Rows a–e form the lower (L) strip of a column; f–j the upper (U) strip. */
const LOWER_ROWS = new Set(["a", "b", "c", "d", "e"]);

const GRID_HOLE_RE = /^([a-j])([1-9]\d*)$/;
const RAIL_HOLE_RE = /^([+-])([1-9]\d*)$/;
const STRIP_NODE_RE = /^c([1-9]\d*)(L|U)$/;
const VERO_HOLE_RE = /^([A-Z]{1,2})([1-9]\d*)$/;
const VERO_NODE_RE = /^S([A-Z]{1,2})(?:\/([1-9]\d*)|x([1-9]\d*))?$/;

/** A veroboard strip's letters from its 1-based number: 1 → A, 26 → Z,
    27 → AA (bijective base 26, so every spelling is one strip). */
export function stripLetters(n) {
  let out = "";
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) {
    out = String.fromCharCode(65 + ((k - 1) % 26)) + out;
  }
  return out;
}

/** The inverse of `stripLetters`: "A" → 1, "AA" → 27. */
export function stripNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** A veroboard hole id: strip 3, hole 14 → "C14". */
function veroHole(strip, index) {
  return `${stripLetters(strip)}${index}`;
}

/** Is this string SPELT like a veroboard hole (`C14`)? Syntax only — whether
    a given board has it is `parseHole`'s question. */
export function isVeroHoleId(hole) {
  return typeof hole === "string" && VERO_HOLE_RE.test(hole);
}

/**
 * A veroboard hole id moved `dStrip` strips across and `dIndex` holes down,
 * with no board in hand — the footprint arithmetic a part's pins are derived
 * by before anyone asks which board they are on (occupancy.js; `parseHole`
 * then says whether the board has the hole). Null for an id that is not a
 * veroboard hole, or a move off the top or the left edge.
 */
export function shiftVeroHole(hole, dStrip, dIndex) {
  const m = typeof hole === "string" ? VERO_HOLE_RE.exec(hole) : null;
  if (!m || !Number.isInteger(dStrip) || !Number.isInteger(dIndex)) return null;
  const strip = stripNumber(m[1]) + dStrip;
  const index = Number(m[2]) + dIndex;
  return strip >= 1 && index >= 1 ? veroHole(strip, index) : null;
}

/**
 * The spec table entry for a board type (throws code INVALID_TYPE on junk —
 * callers pass user/document data through here to validate it).
 */
export function spec(type) {
  const s = boardSpec(type);
  if (!s) {
    const err = new Error(`unknown board type: ${type}`);
    err.code = "INVALID_TYPE";
    throw err;
  }
  return s;
}

/**
 * Can this strip type be turned? Only power rails: a pin-board's trench — and
 * every DIP seated across it — is built for one orientation, so pin-boards
 * are pinned at 0. A rail is just two lines of holes, so it reads the same
 * standing up, which is what makes it usable as a signal bus beside a board.
 */
export function canRotate(type) {
  return spec(type).kind === "rail";
}

/** Coerce anything to a quarter-turn this type can actually hold. */
export function normalizeRotation(type, rot) {
  if (!canRotate(type)) return 0;
  return ROTATIONS.includes(rot) ? rot : 0;
}

/** A strip's footprint on the desk — width and height swap on a quarter turn. */
export function boardSize(type, rot = 0) {
  const s = spec(type);
  const turned = rot === 90 || rot === 270;
  return {
    width: turned ? s.height : s.width,
    height: turned ? s.width : s.height,
  };
}

/**
 * A point in the strip's own (unrotated) frame → the same point relative to
 * the strip's desk origin. The strip stays pinned to its own top-left corner
 * at every angle, so `board.x`/`board.y` mean one thing however it is turned.
 */
export function rotatePoint(type, { x, y }, rot = 0) {
  const s = spec(type);
  if (rot === 90) return { x: s.height - y, y: x };
  if (rot === 180) return { x: s.width - x, y: s.height - y };
  if (rot === 270) return { x: y, y: s.width - x };
  return { x, y };
}

/** The inverse of `rotatePoint`: desk-relative → the strip's own frame. */
export function unrotatePoint(type, { x, y }, rot = 0) {
  const s = spec(type);
  if (rot === 90) return { x: y, y: s.height - x };
  if (rot === 180) return { x: s.width - x, y: s.height - y };
  if (rot === 270) return { x: s.width - y, y: x };
  return { x, y };
}

/**
 * Parse a within-board hole id against a type.
 * @returns {{kind:"grid",row:string,col:number}
 *          |{kind:"rail",railId:string,index:number}
 *          |{kind:"vero",strip:number,index:number}
 *          |null} null when the id is malformed or out of range for the type.
 */
export function parseHole(type, hole) {
  const s = spec(type);
  if (typeof hole !== "string") return null;
  if (s.kind === "vero") {
    const v = VERO_HOLE_RE.exec(hole);
    if (!v) return null;
    const strip = stripNumber(v[1]);
    const index = Number(v[2]);
    if (strip > s.cols || index > s.rows) return null;
    return { kind: "vero", strip, index };
  }
  let m = GRID_HOLE_RE.exec(hole);
  if (m) {
    const col = Number(m[2]);
    if (col > s.cols) return null;
    return { kind: "grid", row: m[1], col };
  }
  m = RAIL_HOLE_RE.exec(hole);
  if (m) {
    const railId = m[1];
    const index = Number(m[2]);
    if (!s.rails.some((r) => r.id === railId)) return null;
    if (index > s.railHoles) return null;
    return { kind: "rail", railId, index };
  }
  return null;
}

/**
 * The fraction of a pitch a board's holes sit at from its own left edge —
 * 0 for every strip (their columns start on whole pitches), a veroboard's
 * margin's fraction otherwise. DeskDoc places a board so its HOLES land on the
 * desk's whole-pitch columns, which this is the offset for.
 */
export function holePhaseX(type) {
  const s = spec(type);
  if (s.kind !== "vero") return 0;
  return Math.round((s.colStartX - Math.floor(s.colStartX)) * 100) / 100;
}

/** `n` held to 1…max. */
function clampTo(n, max) {
  return Math.min(max, Math.max(1, n));
}

/** x of rail hole `index` (1-based): groups of railGroup with an extra gap. */
function railHoleX(s, index) {
  const k = index - 1;
  return s.railStartX + k + Math.floor(k / s.railGroup);
}

/** Every hole id of a board type (grid rows a→j, then rails in spec order;
    a veroboard's strip by strip, each top to bottom). */
export function holes(type) {
  const s = spec(type);
  const out = [];
  if (s.kind === "vero") {
    for (let strip = 1; strip <= s.cols; strip++) {
      const letters = stripLetters(strip);
      for (let i = 1; i <= s.rows; i++) out.push(`${letters}${i}`);
    }
    return out;
  }
  for (const row of ROW_LETTERS) {
    for (let col = 1; col <= s.cols; col++) out.push(`${row}${col}`);
  }
  for (const rail of s.rails) {
    for (let i = 1; i <= s.railHoles; i++) out.push(`${rail.id}${i}`);
  }
  return out;
}

/**
 * Position of a hole in pitch units from the board origin, at the strip's
 * placed rotation, or null for an id that doesn't exist on this type.
 */
export function holePosition(type, hole, rot = 0) {
  const s = spec(type);
  const parsed = parseHole(type, hole);
  if (!parsed) return null;
  const local =
    parsed.kind === "vero"
      ? {
          x: s.colStartX + (parsed.strip - 1),
          y: s.rowStartY + (parsed.index - 1),
        }
      : parsed.kind === "grid"
        ? { x: s.colStartX + (parsed.col - 1), y: s.rowY[parsed.row] }
        : {
            x: railHoleX(s, parsed.index),
            y: s.rails.find((r) => r.id === parsed.railId).y,
          };
  return rotatePoint(type, local, rot);
}

/**
 * The hole under a pitch-unit point, with a forgiving HOLE_HIT_RADIUS, or
 * null when nothing is close enough (e.g. the dead zone between two holes,
 * the trench, or outside the board).
 */
export function holeAt(type, px, py, rot = 0) {
  const s = spec(type);
  // Hit-test in the strip's own frame; the rest of the math never turns.
  const { x, y } = unrotatePoint(type, { x: px, y: py }, rot);
  let best = null;
  let bestDist = HOLE_HIT_RADIUS;

  const consider = (hole, hx, hy) => {
    const dist = Math.hypot(x - hx, y - hy);
    if (dist <= bestDist) {
      best = hole;
      bestDist = dist;
    }
  };

  // Veroboard: one regular lattice, so the nearest hole is a rounding away.
  if (s.kind === "vero") {
    const strip = clampTo(Math.round(x - s.colStartX) + 1, s.cols);
    const index = clampTo(Math.round(y - s.rowStartY) + 1, s.rows);
    consider(
      veroHole(strip, index),
      s.colStartX + (strip - 1),
      s.rowStartY + (index - 1),
    );
    return best;
  }

  // Grid rows: the nearest column in each row is the only candidate there.
  const col = Math.min(s.cols, Math.max(1, Math.round(x - s.colStartX) + 1));
  const colX = s.colStartX + (col - 1);
  for (const [row, rowY] of Object.entries(s.rowY)) {
    consider(`${row}${col}`, colX, rowY);
  }

  // Rails: invert the grouped layout. Blocks of railGroup holes start every
  // railGroup+1 units; check the two nearest blocks so a point in a group
  // gap resolves against both neighbours.
  if (s.railHoles > 0) {
    const stride = s.railGroup + 1;
    const blocks = Math.ceil(s.railHoles / s.railGroup);
    const u = x - s.railStartX;
    const b0 = Math.min(blocks - 1, Math.max(0, Math.floor(u / stride)));
    for (const rail of s.rails) {
      for (const b of new Set([b0, Math.min(blocks - 1, b0 + 1)])) {
        const offset = Math.min(
          s.railGroup - 1,
          Math.max(0, Math.round(u - b * stride)),
        );
        const index = b * s.railGroup + offset + 1;
        if (index > s.railHoles) continue;
        consider(`${rail.id}${index}`, railHoleX(s, index), rail.y);
      }
    }
  }

  return best;
}

/**
 * Every hole within `radius` of a pitch-unit point, nearest first, as
 * `[{ hole, dist }]` — `holeAt` widened from "the one under the point" to "the
 * ones around it". This is how a drag finds the nearest hole it may LAND in:
 * walk the answer in order and take the first legal one.
 *
 * It enumerates the REAL holes rather than sampling points around the input,
 * and that is the whole reason it exists. A cursor is not on the lattice, so
 * whole-pitch steps taken from one land between the holes: half a pitch off a
 * column, every sample is half a pitch from every hole on the strip and
 * `holeAt` sees none of them — while a strip on another lattice (a turned
 * rail's holes sit on quarters) answers from several pitches away.
 */
export function holesNear(type, px, py, radius, rot = 0) {
  const s = spec(type);
  const { x, y } = unrotatePoint(type, { x: px, y: py }, rot);
  const out = [];
  const consider = (hole, hx, hy) => {
    const dist = Math.hypot(x - hx, y - hy);
    if (dist <= radius) out.push({ hole, dist });
  };

  if (s.kind === "vero") {
    const sLo = Math.max(1, Math.ceil(x - s.colStartX + 1 - radius));
    const sHi = Math.min(s.cols, Math.floor(x - s.colStartX + 1 + radius));
    const iLo = Math.max(1, Math.ceil(y - s.rowStartY + 1 - radius));
    const iHi = Math.min(s.rows, Math.floor(y - s.rowStartY + 1 + radius));
    for (let strip = sLo; strip <= sHi; strip++) {
      for (let index = iLo; index <= iHi; index++) {
        consider(
          veroHole(strip, index),
          s.colStartX + (strip - 1),
          s.rowStartY + (index - 1),
        );
      }
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  // Grid: only the columns within reach, then every row within reach.
  const lo = Math.max(1, Math.ceil(x - s.colStartX + 1 - radius));
  const hi = Math.min(s.cols, Math.floor(x - s.colStartX + 1 + radius));
  for (let col = lo; col <= hi; col++) {
    const colX = s.colStartX + (col - 1);
    for (const [row, rowY] of Object.entries(s.rowY)) {
      if (Math.abs(y - rowY) <= radius) consider(`${row}${col}`, colX, rowY);
    }
  }

  // Rails: a line is at most a few dozen holes, so walk the one within reach.
  for (const rail of s.rails) {
    if (Math.abs(y - rail.y) > radius) continue;
    for (let index = 1; index <= s.railHoles; index++) {
      consider(`${rail.id}${index}`, railHoleX(s, index), rail.y);
    }
  }

  return out.sort((a, b) => a.dist - b.dist);
}

// ── Lattice arithmetic ──────────────────────────────────────────────────────
// Placing a part is a LOOSER search than holeAt's: a ghost seats from a whole
// row-band or trench-band away, not just within HOLE_HIT_RADIUS. These are the
// primitives that search takes, so the row/column arithmetic behind it stays
// in this module — every offset below is in the strip's own unrotated frame.

/**
 * The grid column at a local x, 1-based and unrounded (so a caller can centre
 * a footprint on it before rounding). Meaningless on a strip with no grid.
 */
export function columnAt(type, localX) {
  return localX - spec(type).colStartX + 1;
}

/**
 * `hole` on `fromType`, shifted `delta` steps along its own run, validated as a
 * hole of `toType` — the CROSS-STRIP form of `holeAlong`. A grid hole moves
 * along its row (column ± delta), a rail hole along its rail (index ± delta).
 * Null when `hole` doesn't exist on `fromType`, or the shifted id doesn't exist
 * on `toType`.
 *
 * Two types, because a part re-seated onto a NARROWER strip carries its wiring
 * with it (Feature 290): a hole at column 52 of a full board shifted by −47
 * lands at column 5, which a half board has — but the same-type form would
 * refuse that trip at its ORIGIN (`a52` is not a half-board hole), which is not
 * the question being asked.
 */
export function holeAlongTo(fromType, toType, hole, delta) {
  if (!Number.isInteger(delta)) return null;
  const parsed = parseHole(fromType, hole);
  if (!parsed) return null;
  const next =
    parsed.kind === "vero"
      ? parsed.strip + delta >= 1
        ? veroHole(parsed.strip + delta, parsed.index)
        : null
      : parsed.kind === "grid"
        ? `${parsed.row}${parsed.col + delta}`
        : `${parsed.railId}${parsed.index + delta}`;
  if (next == null) return null;
  // parseHole re-validates the bounds on the DESTINATION type (col ≤ cols /
  // index ≤ railHoles, and ≥ 1 — the regexes reject `a0` and `a-1` outright).
  return parseHole(toType, next) ? next : null;
}

/**
 * The hole `delta` steps further along `hole`'s own run, on ONE strip. This is
 * the lattice primitive the bus tool marches a run of consecutive holes with,
 * so no caller does column/index arithmetic by hand.
 */
export function holeAlong(type, hole, delta) {
  return holeAlongTo(type, type, hole, delta);
}

/**
 * `hole` shifted `delta` ROWS up its own column — the `holeAlong` of the other
 * axis. Null for a rail hole (a rail has no rows) or when the shift walks off
 * the top or bottom of the grid.
 *
 * Rows are counted as HOLES, not as distance: `e` + 1 is `f`, straight across
 * the trench, even though that gap is three pitches wide and every other is
 * one. Anything moving by rows is moving by holes — it is what a hand does on
 * the real part — and it is what keeps two things a fixed number of holes apart
 * still that far apart after a move that crosses.
 */
export function holeAcross(type, hole, delta) {
  if (!Number.isInteger(delta)) return null;
  const parsed = parseHole(type, hole);
  // A veroboard's rows are its hole numbers: down the strip.
  if (parsed?.kind === "vero") return holeOffset(type, hole, 0, delta);
  if (parsed?.kind !== "grid") return null;
  const i = ROW_LETTERS.indexOf(parsed.row) + delta;
  const row = i >= 0 ? ROW_LETTERS[i] : undefined;
  if (!row) return null;
  const next = `${row}${parsed.col}`;
  return parseHole(type, next) ? next : null;
}

/**
 * A veroboard hole moved `dStrip` strips across and `dIndex` holes down its
 * strip — the lattice step every rigid footprint on a veroboard is built from
 * (a DIP's far row, a resistor's far lead). Null off the board, for a hole
 * that isn't on it, or on any other kind of board (their lattices have a
 * trench and rails in them; `holeAlong`/`holeAcross` are theirs).
 */
export function holeOffset(type, hole, dStrip, dIndex) {
  if (!Number.isInteger(dStrip) || !Number.isInteger(dIndex)) return null;
  const parsed = parseHole(type, hole);
  if (parsed?.kind !== "vero") return null;
  const strip = parsed.strip + dStrip;
  const index = parsed.index + dIndex;
  const s = spec(type);
  if (strip < 1 || index < 1 || strip > s.cols || index > s.rows) return null;
  return veroHole(strip, index);
}

/**
 * The column a hole is in — a pin-board's column, a veroboard's strip — or
 * null for a rail hole (or one the type does not have). The lattice a part's
 * pin 1 is pinned to across, which is what keeps a drag's grab point under
 * the finger (`columnAt` is the cursor's half of that sum).
 */
export function anchorColumn(type, hole) {
  const parsed = parseHole(type, hole);
  if (parsed?.kind === "grid") return parsed.col;
  if (parsed?.kind === "vero") return parsed.strip;
  return null;
}

/**
 * The hole number (1-based, unrounded) at a local y on a veroboard — the
 * other axis of `columnAt`, which gives the strip. Meaningless on any other
 * board.
 */
export function veroIndexAt(type, localY) {
  return localY - spec(type).rowStartY + 1;
}

/**
 * The veroboard hole at a strip number and a hole number, or null off the
 * board — how a seat search turns lattice coordinates into an id without
 * spelling one by hand.
 */
export function veroHoleAt(type, strip, index) {
  const s = spec(type);
  if (s.kind !== "vero") return null;
  if (!Number.isInteger(strip) || !Number.isInteger(index)) return null;
  if (strip < 1 || index < 1 || strip > s.cols || index > s.rows) return null;
  return veroHole(strip, index);
}

/**
 * How many ROWS apart two grid rows are, `to` minus `from` — `a`→`c` is +2, and
 * `e`→`f` is +1, counting holes rather than distance (see `holeAcross`). Null
 * when either is not a grid row.
 */
export function rowsBetween(fromRow, toRow) {
  const a = ROW_LETTERS.indexOf(fromRow);
  const b = ROW_LETTERS.indexOf(toRow);
  return a < 0 || b < 0 ? null : b - a;
}

/**
 * Clamp an anchor column so a footprint spanning `span` columns past it still
 * fits on the strip. Returns null when the type is too narrow to hold it.
 */
export function clampColumn(type, col, span) {
  const { cols } = spec(type);
  if (cols < span + 1) return null;
  return Math.min(cols - span, Math.max(1, Math.round(col)));
}

/**
 * The grid row whose y is nearest `localY`, within `band` — or null when the
 * point is over the trench, the margins, or a strip with no grid at all.
 */
export function rowNear(type, localY, band) {
  let best = null;
  let bestDist = band;
  for (const [row, y] of Object.entries(spec(type).rowY)) {
    const dist = Math.abs(localY - y);
    if (dist <= bestDist) {
      best = row;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * The row whose Y sits exactly `delta` pitch-units from `row`'s, or null when
 * no row on this type has that Y — the trench gap (e.g. row `g` + 3 lands in
 * empty space, not row `e`), or off the strip's top/bottom edge. `delta` may
 * be negative. Lets a rigid multi-row footprint (an oscillator can spanning
 * more than the one-row discretes use) find its far corner's row without any
 * caller hand-deriving row-letter arithmetic.
 */
export function rowOffsetBy(type, row, delta) {
  const s = spec(type);
  const y0 = s.rowY[row];
  if (y0 == null) return null;
  const target = y0 + delta;
  // Row y's live on a 0.01 grid, which binary floats do not: 4.51 − 3 is
  // 1.5099999999999998, so an exact test never found row j from below it.
  for (const [r, y] of Object.entries(s.rowY)) {
    if (Math.abs(y - target) < 1e-6) return r;
  }
  return null;
}

/**
 * How far `localY` sits from the trench's centre line, or null on a strip
 * with no trench (a rail — nothing can straddle it).
 */
export function trenchOffset(type, localY) {
  const { trench } = spec(type);
  return trench ? Math.abs(localY - trench.centerY) : null;
}

/**
 * A strip's rails as electrical SEGMENTS, in its own unrotated frame:
 * `{node, railId, polarity, first, last}` with `first`/`last` hole indices.
 * A continuous rail is one segment whose node IS the rail id (`+`, `-`); a
 * split strip (`railSplit` > 0) cuts each rail after hole `railSplit` into
 * `L<id>` (holes 1…railSplit) and `R<id>` (the rest). The polarity stays the
 * LAST character of every node id on purpose — `netPolarity` and the
 * exporters read a rail's polarity off the end of `<board>.<node>`. Empty for
 * a strip with no rails. Both renderers draw one stripe per segment, so the
 * printed break and the electrical one are the same fact.
 */
export function railSegments(type) {
  const cached = SEGMENTS.get(type);
  if (cached) return cached;
  const s = spec(type);
  const cut = s.railSplit > 0 && s.railSplit < s.railHoles ? s.railSplit : 0;
  const out = [];
  for (const rail of s.rails) {
    const base = { railId: rail.id, polarity: rail.polarity };
    if (!cut) {
      out.push({ ...base, node: rail.id, first: 1, last: s.railHoles });
      continue;
    }
    out.push({ ...base, node: `L${rail.id}`, first: 1, last: cut });
    out.push({ ...base, node: `R${rail.id}`, first: cut + 1, last: s.railHoles }); // prettier-ignore
  }
  const frozen = Object.freeze(out.map((g) => Object.freeze(g)));
  SEGMENTS.set(type, frozen);
  return frozen;
}

/** `railSegments` per type — nodeOf is on the netlist's hot path. */
const SEGMENTS = new Map();

/** The rail segment rail hole `index` of `railId` lies in, or null. */
function railSegmentOf(type, railId, index) {
  return (
    railSegments(type).find(
      (g) => g.railId === railId && index >= g.first && index <= g.last,
    ) ?? null
  );
}

// ── Veroboard cuts ──────────────────────────────────────────────────────────
// A cut is a SPOT-FACE AT A HOLE, which is what a stripboard cutter makes: the
// copper ring round that hole is drilled away, so the pad is isolated from
// both sides and the strip either side of it becomes two runs. A lead in a
// cut hole is legal and touches no copper — it floats, as it would on the
// bench. A cut is named by its hole id (`C14`); a board's cuts are the sorted
// list `board.cuts`, absent when there are none.

/** Can a cut go at this hole? Any hole of a veroboard — the end holes too
    (a cut there isolates just that pad). */
export function isCuttable(type, hole) {
  return parseHole(type, hole)?.kind === "vero";
}

/** Hole order on a veroboard: strip, then down the strip. */
function compareVeroHoles(type, a, b) {
  const pa = parseHole(type, a);
  const pb = parseHole(type, b);
  return pa.strip - pb.strip || pa.index - pb.index;
}

/**
 * A cut list as a board stores it: only real holes of this veroboard, each
 * once, strip by strip, top to bottom — so one set of cuts has one spelling
 * and a document round-trips byte-identical. Empty for any other board.
 */
export function normalizeCuts(type, cuts) {
  if (!Array.isArray(cuts) || spec(type).kind !== "vero") return [];
  const kept = new Set(
    cuts.filter((h) => typeof h === "string" && isCuttable(type, h)),
  );
  return [...kept].sort((a, b) => compareVeroHoles(type, a, b));
}

/** Per cut list: strip number → its cut hole numbers, ascending. Keyed on the
    list itself — a board's `cuts` is replaced, never edited, when it changes
    — because nodeOf is on the netlist's hot path. */
const CUT_INDEX = new WeakMap();

function cutsByStrip(type, cuts) {
  if (!Array.isArray(cuts) || cuts.length === 0) return null;
  const hit = CUT_INDEX.get(cuts);
  if (hit && hit.type === type) return hit.byStrip;
  const byStrip = new Map();
  for (const h of cuts) {
    const p = parseHole(type, h);
    if (p?.kind !== "vero") continue;
    if (!byStrip.has(p.strip)) byStrip.set(p.strip, []);
    byStrip.get(p.strip).push(p.index);
  }
  for (const list of byStrip.values()) list.sort((a, b) => a - b);
  CUT_INDEX.set(cuts, { type, byStrip });
  return byStrip;
}

/**
 * A veroboard's copper as RUNS — `{strip, first, last}`, each a stretch of one
 * strip with no cut in it, strip by strip, top to bottom — plus the cut holes
 * themselves as `{strip, index}`. The single statement of where copper is,
 * which both renderers draw (desk/vero-copper.js) and `nodeOf` agrees with
 * hole for hole: every run is one node, every cut a node of its own. Empty
 * for any other board.
 */
export function veroRuns(type, cuts) {
  const s = spec(type);
  if (s.kind !== "vero") return { runs: [], cuts: [] };
  const byStrip = cutsByStrip(type, cuts);
  const runs = [];
  const cutHoles = [];
  for (let strip = 1; strip <= s.cols; strip++) {
    let first = 1;
    for (const c of byStrip?.get(strip) ?? []) {
      if (c > first) runs.push({ strip, first, last: c - 1 });
      cutHoles.push({ strip, index: c });
      first = c + 1;
    }
    if (first <= s.rows) runs.push({ strip, first, last: s.rows });
  }
  return { runs, cuts: cutHoles };
}

/** The node of a veroboard hole under `cuts` (see the header). */
function veroNodeOf(type, { strip, index }, cuts) {
  const letters = stripLetters(strip);
  const cutAt = cutsByStrip(type, cuts)?.get(strip);
  if (!cutAt || cutAt.length === 0) return `S${letters}`;
  if (cutAt.includes(index)) return `S${letters}x${index}`;
  let first = 1;
  for (const c of cutAt) if (c < index) first = c + 1;
  return `S${letters}/${first}`;
}

/** The holes of a veroboard node under `cuts`, or null for a node that does
    not exist with those cuts. */
function veroHolesOfNode(type, node, cuts) {
  const s = spec(type);
  const m = VERO_NODE_RE.exec(node);
  if (!m) return null;
  const strip = stripNumber(m[1]);
  if (strip > s.cols) return null;
  const cutAt = cutsByStrip(type, cuts)?.get(strip) ?? [];
  const run = (from, to) => {
    const out = [];
    for (let i = from; i <= to; i++) out.push(veroHole(strip, i));
    return out;
  };
  if (m[3] != null) {
    const index = Number(m[3]);
    return cutAt.includes(index) ? [veroHole(strip, index)] : null;
  }
  if (m[2] == null) return cutAt.length === 0 ? run(1, s.rows) : null;
  const first = Number(m[2]);
  if (cutAt.length === 0 || first > s.rows || cutAt.includes(first))
    return null;
  if (first !== 1 && !cutAt.includes(first - 1)) return null;
  const next = cutAt.find((c) => c > first);
  return run(first, next != null ? next - 1 : s.rows);
}

/**
 * The internal electrical node a hole belongs to: `c<col>L` / `c<col>U` for
 * a grid hole (the trench isolates L from U), or the rail SEGMENT's node for
 * a rail hole — the bare rail id on a continuous rail, `L+`/`R+`/`L-`/`R-` on
 * a split one (`railSegments`), or a veroboard hole's run of copper under
 * `cuts` (the board's own — `boardNodeOf` passes them). Null for ids that
 * don't exist on this type.
 */
export function nodeOf(type, hole, cuts) {
  const parsed = parseHole(type, hole);
  if (!parsed) return null;
  if (parsed.kind === "vero") return veroNodeOf(type, parsed, cuts);
  if (parsed.kind === "rail")
    return railSegmentOf(type, parsed.railId, parsed.index)?.node ?? null;
  return `c${parsed.col}${LOWER_ROWS.has(parsed.row) ? "L" : "U"}`;
}

/**
 * Every hole id in a node, or null for a node that doesn't exist on this
 * type. Inverse of nodeOf: a strip lists its 5 rows; a rail segment its holes.
 */
export function holesOfNode(type, node, cuts) {
  const s = spec(type);
  if (typeof node !== "string") return null;
  if (s.kind === "vero") return veroHolesOfNode(type, node, cuts);
  const m = STRIP_NODE_RE.exec(node);
  if (m) {
    const col = Number(m[1]);
    if (col > s.cols) return null;
    const rows = ROW_LETTERS.filter(
      (r) => LOWER_ROWS.has(r) === (m[2] === "L"),
    );
    return rows.map((row) => `${row}${col}`);
  }
  const seg = railSegments(type).find((g) => g.node === node);
  if (!seg) return null;
  const out = [];
  for (let i = seg.first; i <= seg.last; i++) out.push(`${seg.railId}${i}`);
  return out;
}

/** `nodeOf` for a placed board — its type AND its own cuts. Every caller that
    has the board should ask this, so a veroboard's cuts are never missed. */
export function boardNodeOf(board, hole) {
  return nodeOf(board.type, hole, board.cuts);
}

/** `holesOfNode` for a placed board (see `boardNodeOf`). */
export function boardHolesOfNode(board, node) {
  return holesOfNode(board.type, node, board.cuts);
}

/** "bb1" + "f12" → "bb1.f12" (the global address currency). */
export function formatAddress(boardId, hole) {
  return `${boardId}.${hole}`;
}

/**
 * Split a global address at its first dot: "bb1.t+7" →
 * `{ boardId: "bb1", hole: "t+7" }`. Purely syntactic (no type context here);
 * null when either part is empty or the input isn't a string.
 */
export function parseAddress(address) {
  if (typeof address !== "string") return null;
  const dot = address.indexOf(".");
  if (dot <= 0 || dot === address.length - 1) return null;
  return { boardId: address.slice(0, dot), hole: address.slice(dot + 1) };
}
