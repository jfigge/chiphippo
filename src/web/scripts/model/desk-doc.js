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

// desk-doc.js — the in-memory desk document: the boards on the desk, the
// components seated on them (chips now; discrete parts in Feature 60), and —
// from Feature 50 — wires. Pure model, DOM-free; the renderer holds one
// instance, mutates it through these methods, and autosaves the serialized
// form over window.chiphippo.desk.save.
//
// Board x/y are board-origin world coordinates in PITCH UNITS, snapped to
// integers so every hole lands on the global 0.1-in lattice (holes are
// integer offsets within a board — see board-types.js). Board ids are
// `bb<n>` and component ids `c<n>`, from per-document counters that never
// reuse an id, even across delete + save + reload (`nextBoardId` /
// `nextComponentId` persist in the document).
//
// Components are `{ id, kind, ref, board, anchor, params }` — kind "chip"
// now ("discrete"/"psu" later), `ref` a catalog id, `anchor` pin 1's seated
// hole (row e). Pin positions are always DERIVED (footprints + occupancy),
// never stored; occupancy.js is the single collision authority.

import { BOARD_TYPES } from "./board-types.js";
import { parseAddress, parseHole, spec } from "./breadboard.js";
import { chipDef } from "../catalog/index.js";
import { canPlaceChip, canPlaceWire, isFreeHole } from "./occupancy.js";

export const DOC_VERSION = 1;

/** The fixed jumper-wire palette (theme.css defines a token per name). */
export const WIRE_COLORS = Object.freeze([
  "red",
  "black",
  "blue",
  "green",
  "yellow",
  "orange",
  "white",
  "purple",
]);

const BOARD_ID_RE = /^bb([1-9]\d*)$/;
const COMPONENT_ID_RE = /^c([1-9]\d*)$/;
const WIRE_ID_RE = /^w([1-9]\d*)$/;

function taggedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** A fresh, empty desk document. */
export function emptyDocument() {
  return {
    version: DOC_VERSION,
    boards: [],
    components: [],
    wires: [],
    nextBoardId: 1,
    nextComponentId: 1,
    nextWireId: 1,
  };
}

/**
 * Coerce a loaded (possibly junk/foreign) document into a valid one: arrays
 * forced; board/component entries with bad ids, types/refs, coords, or
 * dangling board references dropped; coordinates snapped to integers; and
 * the id counters advanced past every surviving id. Wires are carried
 * through verbatim (Feature 50 normalizes them).
 */
export function normalizeDocument(raw) {
  const doc = emptyDocument();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return doc;

  let maxBoardSeq = 0;
  const boardIds = new Set();
  const boards = Array.isArray(raw.boards) ? raw.boards : [];
  for (const b of boards) {
    if (!b || typeof b !== "object") continue;
    const m = typeof b.id === "string" ? BOARD_ID_RE.exec(b.id) : null;
    if (!m || boardIds.has(b.id)) continue;
    if (!BOARD_TYPES[b.type]) continue;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    boardIds.add(b.id);
    maxBoardSeq = Math.max(maxBoardSeq, Number(m[1]));
    doc.boards.push({
      id: b.id,
      type: b.type,
      x: Math.round(b.x),
      y: Math.round(b.y),
    });
  }

  let maxCompSeq = 0;
  const compIds = new Set();
  const components = Array.isArray(raw.components) ? raw.components : [];
  for (const c of components) {
    if (!c || typeof c !== "object") continue;
    const m = typeof c.id === "string" ? COMPONENT_ID_RE.exec(c.id) : null;
    if (!m || compIds.has(c.id)) continue;
    if (c.kind !== "chip") continue; // discrete/psu arrive in Feature 60
    if (!chipDef(c.ref)) continue;
    if (!boardIds.has(c.board)) continue; // seated on a surviving board
    if (typeof c.anchor !== "string") continue;
    compIds.add(c.id);
    maxCompSeq = Math.max(maxCompSeq, Number(m[1]));
    doc.components.push({
      id: c.id,
      kind: "chip",
      ref: c.ref,
      board: c.board,
      anchor: c.anchor,
      params:
        c.params && typeof c.params === "object" && !Array.isArray(c.params)
          ? structuredClone(c.params)
          : {},
    });
  }

  // Wires: both endpoints must parse onto surviving boards' real holes and
  // be distinct; junk colors fall back to the first palette entry.
  let maxWireSeq = 0;
  const wireIds = new Set();
  const boardType = (boardId) =>
    doc.boards.find((b) => b.id === boardId)?.type ?? null;
  const validEndpoint = (address) => {
    if (typeof address !== "string") return false;
    const parsed = parseAddress(address);
    if (!parsed) return false;
    const type = boardType(parsed.boardId);
    return type !== null && parseHole(type, parsed.hole) !== null;
  };
  const wires = Array.isArray(raw.wires) ? raw.wires : [];
  for (const w of wires) {
    if (!w || typeof w !== "object") continue;
    const m = typeof w.id === "string" ? WIRE_ID_RE.exec(w.id) : null;
    if (!m || wireIds.has(w.id)) continue;
    if (!validEndpoint(w.from) || !validEndpoint(w.to)) continue;
    if (w.from === w.to) continue;
    wireIds.add(w.id);
    maxWireSeq = Math.max(maxWireSeq, Number(m[1]));
    doc.wires.push({
      id: w.id,
      from: w.from,
      to: w.to,
      color: WIRE_COLORS.includes(w.color) ? w.color : WIRE_COLORS[0],
    });
  }

  const storedNextBoard =
    Number.isInteger(raw.nextBoardId) && raw.nextBoardId > 0
      ? raw.nextBoardId
      : 1;
  doc.nextBoardId = Math.max(storedNextBoard, maxBoardSeq + 1);
  const storedNextComp =
    Number.isInteger(raw.nextComponentId) && raw.nextComponentId > 0
      ? raw.nextComponentId
      : 1;
  doc.nextComponentId = Math.max(storedNextComp, maxCompSeq + 1);
  const storedNextWire =
    Number.isInteger(raw.nextWireId) && raw.nextWireId > 0 ? raw.nextWireId : 1;
  doc.nextWireId = Math.max(storedNextWire, maxWireSeq + 1);
  return doc;
}

/** Strict rect overlap — boards may touch edge-to-edge but not intersect. */
function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function outlineRect(board) {
  const s = spec(board.type);
  return { x: board.x, y: board.y, width: s.width, height: s.height };
}

export class DeskDoc {
  #doc;

  /** @param {object|null} raw - a loaded document (normalized here) or null. */
  constructor(raw = null) {
    this.#doc = normalizeDocument(raw);
  }

  /** Copies of the boards on the desk. */
  get boards() {
    return this.#doc.boards.map((b) => ({ ...b }));
  }

  /** A copy of one board, or null. */
  getBoard(id) {
    const b = this.#doc.boards.find((x) => x.id === id);
    return b ? { ...b } : null;
  }

  /**
   * Would a `type` board fit at (x, y) (after integer snapping) without
   * overlapping any existing board's outline? `ignoreId` excludes a board
   * from the check (moving a board over its own footprint is fine).
   */
  canPlace(type, x, y, { ignoreId = null } = {}) {
    const s = spec(type);
    const rect = {
      x: Math.round(x),
      y: Math.round(y),
      width: s.width,
      height: s.height,
    };
    return this.#doc.boards.every(
      (b) => b.id === ignoreId || !rectsOverlap(rect, outlineRect(b)),
    );
  }

  /**
   * Add a board (coordinates snapped to integers). Throws INVALID_TYPE /
   * INVALID_ARG / OVERLAP. Returns a copy of the new board.
   */
  addBoard(type, x, y) {
    spec(type); // validates — throws INVALID_TYPE
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("board position must be finite", "INVALID_ARG");
    }
    if (!this.canPlace(type, x, y)) {
      throw taggedError(
        `a ${type} board at ${Math.round(x)},${Math.round(y)} overlaps an existing board`,
        "OVERLAP",
      );
    }
    const board = {
      id: `bb${this.#doc.nextBoardId++}`,
      type,
      x: Math.round(x),
      y: Math.round(y),
    };
    this.#doc.boards.push(board);
    return { ...board };
  }

  /**
   * Move a board (coordinates snapped to integers). Throws NOT_FOUND /
   * INVALID_ARG / OVERLAP. Returns a copy of the updated board.
   */
  moveBoard(id, x, y) {
    const board = this.#doc.boards.find((b) => b.id === id);
    if (!board) throw taggedError(`no board ${id}`, "NOT_FOUND");
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("board position must be finite", "INVALID_ARG");
    }
    if (!this.canPlace(board.type, x, y, { ignoreId: id })) {
      throw taggedError(
        `moving ${id} to ${Math.round(x)},${Math.round(y)} overlaps another board`,
        "OVERLAP",
      );
    }
    board.x = Math.round(x);
    board.y = Math.round(y);
    return { ...board };
  }

  /**
   * Remove a board AND everything attached to it — seated components and
   * every wire with an endpoint on it (the UI confirms first when anything
   * would go with it). Throws NOT_FOUND.
   */
  removeBoard(id) {
    const i = this.#doc.boards.findIndex((b) => b.id === id);
    if (i === -1) throw taggedError(`no board ${id}`, "NOT_FOUND");
    this.#doc.boards.splice(i, 1);
    this.#doc.components = this.#doc.components.filter((c) => c.board !== id);
    this.#doc.wires = this.#doc.wires.filter(
      (w) => !this.#wireTouchesBoard(w, id),
    );
  }

  #wireTouchesBoard(wire, boardId) {
    return (
      parseAddress(wire.from)?.boardId === boardId ||
      parseAddress(wire.to)?.boardId === boardId
    );
  }

  // ── Components (chips now; discrete parts in Feature 60) ────────────────

  /** Copies of the components on the desk. */
  get components() {
    return this.#doc.components.map((c) => ({ ...c }));
  }

  /** A copy of one component, or null. */
  getComponent(id) {
    const c = this.#doc.components.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  /** Copies of the components seated on one board. */
  componentsOnBoard(boardId) {
    return this.#doc.components
      .filter((c) => c.board === boardId)
      .map((c) => ({ ...c }));
  }

  /**
   * May a chip seat here? Delegates to occupancy — the single collision
   * authority. `ignoreId` excludes one component's own pins (moves).
   */
  canPlaceChip(ref, boardId, anchor, { ignoreId = null } = {}) {
    return canPlaceChip(this.#doc, { ref, board: boardId, anchor, ignoreId });
  }

  /**
   * Seat a chip: pin 1 at `anchor` (row e) on `boardId`. Throws INVALID_KIND
   * / INVALID_REF / NOT_FOUND / ILLEGAL_PLACEMENT. Returns a copy.
   */
  addComponent({ kind, ref, board: boardId, anchor, params = {} }) {
    if (kind !== "chip") {
      throw taggedError(`unsupported component kind: ${kind}`, "INVALID_KIND");
    }
    if (!chipDef(ref)) {
      throw taggedError(`unknown catalog ref: ${ref}`, "INVALID_REF");
    }
    if (!this.#doc.boards.some((b) => b.id === boardId)) {
      throw taggedError(`no board ${boardId}`, "NOT_FOUND");
    }
    if (!this.canPlaceChip(ref, boardId, anchor)) {
      throw taggedError(
        `a ${ref} cannot seat at ${boardId}.${anchor}`,
        "ILLEGAL_PLACEMENT",
      );
    }
    const component = {
      id: `c${this.#doc.nextComponentId++}`,
      kind: "chip",
      ref,
      board: boardId,
      anchor,
      params: structuredClone(params),
    };
    this.#doc.components.push(component);
    return { ...component };
  }

  /**
   * Re-seat a component (same or another board). Throws NOT_FOUND /
   * ILLEGAL_PLACEMENT. Returns a copy of the updated component.
   */
  moveComponent(id, boardId, anchor) {
    const comp = this.#doc.components.find((c) => c.id === id);
    if (!comp) throw taggedError(`no component ${id}`, "NOT_FOUND");
    if (!this.#doc.boards.some((b) => b.id === boardId)) {
      throw taggedError(`no board ${boardId}`, "NOT_FOUND");
    }
    if (!this.canPlaceChip(comp.ref, boardId, anchor, { ignoreId: id })) {
      throw taggedError(
        `${id} cannot seat at ${boardId}.${anchor}`,
        "ILLEGAL_PLACEMENT",
      );
    }
    comp.board = boardId;
    comp.anchor = anchor;
    return { ...comp };
  }

  /** Remove a component. Throws NOT_FOUND. */
  removeComponent(id) {
    const i = this.#doc.components.findIndex((c) => c.id === id);
    if (i === -1) throw taggedError(`no component ${id}`, "NOT_FOUND");
    this.#doc.components.splice(i, 1);
  }

  // ── Wires (Feature 50) ───────────────────────────────────────────────────

  /** Copies of the wires on the desk. */
  get wires() {
    return this.#doc.wires.map((w) => ({ ...w }));
  }

  /** A copy of one wire, or null. */
  getWire(id) {
    const w = this.#doc.wires.find((x) => x.id === id);
    return w ? { ...w } : null;
  }

  /** Copies of the wires with an endpoint on one board. */
  wiresOnBoard(boardId) {
    return this.#doc.wires
      .filter((w) => this.#wireTouchesBoard(w, boardId))
      .map((w) => ({ ...w }));
  }

  /** Is `address` a real, unoccupied hole? (occupancy delegation) */
  isHoleFree(address) {
    return isFreeHole(this.#doc, address);
  }

  /** May a wire connect these holes? (occupancy delegation) */
  canPlaceWire(from, to) {
    return canPlaceWire(this.#doc, from, to);
  }

  /**
   * Connect two free holes. Throws INVALID_ARG (bad color) /
   * ILLEGAL_PLACEMENT (either end unreal, occupied, or from === to).
   * Returns a copy of the new wire.
   */
  addWire({ from, to, color = WIRE_COLORS[0] }) {
    if (!WIRE_COLORS.includes(color)) {
      throw taggedError(`unknown wire color: ${color}`, "INVALID_ARG");
    }
    if (!canPlaceWire(this.#doc, from, to)) {
      throw taggedError(
        `a wire cannot connect ${from} → ${to}`,
        "ILLEGAL_PLACEMENT",
      );
    }
    const wire = { id: `w${this.#doc.nextWireId++}`, from, to, color };
    this.#doc.wires.push(wire);
    return { ...wire };
  }

  /** Change a wire's color. Throws NOT_FOUND / INVALID_ARG. */
  recolorWire(id, color) {
    const wire = this.#doc.wires.find((w) => w.id === id);
    if (!wire) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    if (!WIRE_COLORS.includes(color)) {
      throw taggedError(`unknown wire color: ${color}`, "INVALID_ARG");
    }
    wire.color = color;
    return { ...wire };
  }

  /** Remove a wire. Throws NOT_FOUND. */
  removeWire(id) {
    const i = this.#doc.wires.findIndex((w) => w.id === id);
    if (i === -1) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    this.#doc.wires.splice(i, 1);
  }

  /** The serializable document (a deep copy — safe to hand to IPC). */
  toJSON() {
    return structuredClone(this.#doc);
  }
}
