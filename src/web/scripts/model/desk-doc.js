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

// desk-doc.js — the in-memory desk document: the boards on the desk (and,
// from Features 40–60, components and wires). Pure model, DOM-free; the
// renderer holds one instance, mutates it through these methods, and
// autosaves the serialized form over window.chiphippo.desk.save.
//
// Board x/y are board-origin world coordinates in PITCH UNITS, snapped to
// integers so every hole lands on the global 0.1-in lattice (holes are
// integer offsets within a board — see board-types.js). Board ids are
// `bb<n>` from a per-document counter that never reuses an id, even across
// delete + save + reload (`nextBoardId` persists in the document).

import { BOARD_TYPES } from "./board-types.js";
import { spec } from "./breadboard.js";

export const DOC_VERSION = 1;

const BOARD_ID_RE = /^bb([1-9]\d*)$/;

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
    components: [], // reserved — Feature 40+
    wires: [], // reserved — Feature 50
    nextBoardId: 1,
  };
}

/**
 * Coerce a loaded (possibly junk/foreign) document into a valid one: arrays
 * forced, board entries with bad ids/types/coords dropped, coordinates
 * snapped to integers, and the id counter advanced past every surviving id.
 * Components/wires are carried through verbatim (their owning features
 * normalize them).
 */
export function normalizeDocument(raw) {
  const doc = emptyDocument();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return doc;

  let maxSeq = 0;
  const seenIds = new Set();
  const boards = Array.isArray(raw.boards) ? raw.boards : [];
  for (const b of boards) {
    if (!b || typeof b !== "object") continue;
    const m = typeof b.id === "string" ? BOARD_ID_RE.exec(b.id) : null;
    if (!m || seenIds.has(b.id)) continue;
    if (!BOARD_TYPES[b.type]) continue;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    seenIds.add(b.id);
    maxSeq = Math.max(maxSeq, Number(m[1]));
    doc.boards.push({
      id: b.id,
      type: b.type,
      x: Math.round(b.x),
      y: Math.round(b.y),
    });
  }

  if (Array.isArray(raw.components)) {
    doc.components = structuredClone(raw.components);
  }
  if (Array.isArray(raw.wires)) doc.wires = structuredClone(raw.wires);

  const storedNext =
    Number.isInteger(raw.nextBoardId) && raw.nextBoardId > 0
      ? raw.nextBoardId
      : 1;
  doc.nextBoardId = Math.max(storedNext, maxSeq + 1);
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

  /** Remove a board. Throws NOT_FOUND. */
  removeBoard(id) {
    const i = this.#doc.boards.findIndex((b) => b.id === id);
    if (i === -1) throw taggedError(`no board ${id}`, "NOT_FOUND");
    this.#doc.boards.splice(i, 1);
  }

  /** The serializable document (a deep copy — safe to hand to IPC). */
  toJSON() {
    return structuredClone(this.#doc);
  }
}
