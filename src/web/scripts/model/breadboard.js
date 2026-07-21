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
// Positions are PITCH UNITS relative to the strip's top-left origin. Nothing
// outside this module converts row/column arithmetic by hand — INCLUDING the
// quarter-turn a power rail may be placed at: hole ids and nodes are stated in
// the strip's own unrotated frame, and `rotatePoint`/`unrotatePoint` are the
// only bridge between that frame and the desk.

import { BOARD_TYPES } from "./board-types.js";

/** How close (pitch units) a point must be to a hole for holeAt to match. */
export const HOLE_HIT_RADIUS = 0.45;

/** The quarter-turns a strip can be placed at. */
export const ROTATIONS = Object.freeze([0, 90, 180, 270]);

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

/**
 * The spec table entry for a board type (throws code INVALID_TYPE on junk —
 * callers pass user/document data through here to validate it).
 */
export function spec(type) {
  const s = BOARD_TYPES[type];
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
 *          |null} null when the id is malformed or out of range for the type.
 */
export function parseHole(type, hole) {
  const s = spec(type);
  if (typeof hole !== "string") return null;
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

/** x of rail hole `index` (1-based): groups of railGroup with an extra gap. */
function railHoleX(s, index) {
  const k = index - 1;
  return s.railStartX + k + Math.floor(k / s.railGroup);
}

/** Every hole id of a board type (grid rows a→j, then rails in spec order). */
export function holes(type) {
  const s = spec(type);
  const out = [];
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
    parsed.kind === "grid"
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
 * How far `localY` sits from the trench's centre line, or null on a strip
 * with no trench (a rail — nothing can straddle it).
 */
export function trenchOffset(type, localY) {
  const { trench } = spec(type);
  return trench ? Math.abs(localY - trench.centerY) : null;
}

/**
 * The internal electrical node a hole belongs to: `c<col>L` / `c<col>U` for
 * a grid hole (the trench isolates L from U), or the rail id for a rail hole
 * (a rail is one continuous node for the whole strip — no mid-strip split).
 * Null for ids that don't exist on this type.
 */
export function nodeOf(type, hole) {
  const parsed = parseHole(type, hole);
  if (!parsed) return null;
  if (parsed.kind === "rail") return parsed.railId;
  return `c${parsed.col}${LOWER_ROWS.has(parsed.row) ? "L" : "U"}`;
}

/**
 * Every hole id in a node, or null for a node that doesn't exist on this
 * type. Inverse of nodeOf: a strip lists its 5 rows; a rail all its holes.
 */
export function holesOfNode(type, node) {
  const s = spec(type);
  if (typeof node !== "string") return null;
  const m = STRIP_NODE_RE.exec(node);
  if (m) {
    const col = Number(m[1]);
    if (col > s.cols) return null;
    const rows = ROW_LETTERS.filter(
      (r) => LOWER_ROWS.has(r) === (m[2] === "L"),
    );
    return rows.map((row) => `${row}${col}`);
  }
  if (s.rails.some((r) => r.id === node)) {
    const out = [];
    for (let i = 1; i <= s.railHoles; i++) out.push(`${node}${i}`);
    return out;
  }
  return null;
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
