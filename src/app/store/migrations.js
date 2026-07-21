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

/**
 * migrations.js — desk-document schema migrations, keyed on `version`.
 *
 * load() upgrades old documents in memory (persisted lazily by the next
 * autosave). A document from a NEWER app version is returned untouched
 * (never downgraded); the renderer's normalizeDocument treats unknown fields
 * defensively.
 *
 * v1 → v2 (Feature 110) splits the one-piece breadboard into strips.
 * v2 → v3 (Feature 120) adds net names + annotations (pure additive).
 */
"use strict";

const DESK_DOC_VERSION = 3;

/** A fresh, empty desk document (main's copy of the renderer's shape). */
function defaultDeskDocument() {
  return {
    version: DESK_DOC_VERSION,
    boards: [],
    components: [],
    wires: [],
    netNames: [],
    annotations: [],
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
    nextAnnotationId: 1,
  };
}

/**
 * v1 → v2: a breadboard stops being one entity and becomes its real parts.
 *
 * A full/half board keeps its id as the centre PIN-BOARD and gains two new
 * power-rail strips above and below it, all three joined by a fresh group.
 * Keeping the old id on the pin-board is deliberate: grid addresses
 * (`bb1.a12`) and every component's `board` ref stay valid untouched, so only
 * the four rail rows need rewriting.
 *
 * The assembly gets slightly more compact: v1 padded each rail and the grid
 * with an extra half-pitch, which is what left the holes sitting high in
 * their plastic. v2 centres them, so a kit is 19 tall rather than 21.7 and
 * the grid rides one pitch higher within it. Nothing changes electrically —
 * every hole keeps its identity and every strip moves as one group.
 * A tiny board had no rails, so it only renames its type.
 */
const V1_KITS = {
  full: { pins: "pins-full", rail: "rail-full" },
  half: { pins: "pins-half", rail: "rail-half" },
};

/** Old rail id → [which new strip, new rail id]. */
const V1_RAILS = {
  "t+": ["top", "+"],
  "t-": ["top", "-"],
  "b+": ["bottom", "+"],
  "b-": ["bottom", "-"],
};

const RAIL_OFFSET_Y = 3; // pin-board sits one rail-height down
const BOTTOM_OFFSET_Y = 16; // = rail height (3) + pin-board height (13)

/**
 * The geometry either side of this migration, frozen here on purpose.
 *
 * A migration is a snapshot of a schema TRANSITION, so it must not import the
 * live board specs — those keep changing. These are the numbers as they stood
 * at the v1 → v2 boundary, in pitch units.
 */
const V1_BOARD_TYPES = new Set(["full", "half", "tiny"]);

const V1_RAIL_START_X = { full: 3, half: 2 };

/**
 * The v2 strip geometry, likewise frozen at this version boundary.
 *
 * The v2 rows sit 4 higher than v1's (rails lost a pitch of margin and the
 * pin-board starts at 1, not 5), so a bend measured in the v1 frame would be
 * WRONG across the rail/grid boundary. Both endpoints are therefore mapped
 * into the v2 frame before subtracting.
 */
const V2_ROW_Y = {
  j: 1,
  i: 2,
  h: 3,
  g: 4,
  f: 5,
  e: 8,
  d: 9,
  c: 10,
  b: 11,
  a: 12,
};
const V2_RAIL_LOCAL_Y = { "+": 1, "-": 2 };
const V2_STRIP_DY = { top: 0, bottom: BOTTOM_OFFSET_Y };

/** Position of a v1 hole in the v2 KIT frame (origin = the kit's top-left). */
function v2HolePosition(type, hole) {
  const grid = /^([a-j])([1-9]\d*)$/.exec(hole);
  if (grid) {
    if (!V1_BOARD_TYPES.has(type)) return null;
    const dy = type === "tiny" ? 0 : RAIL_OFFSET_Y;
    return { x: Number(grid[2]), y: dy + V2_ROW_Y[grid[1]] };
  }
  const rail = /^([tb][+-])([1-9]\d*)$/.exec(hole);
  if (!rail) return null;
  const startX = V1_RAIL_START_X[type];
  if (startX === undefined) return null; // tiny had no rails
  const [strip, polarity] = V1_RAILS[rail[1]];
  const k = Number(rail[2]) - 1;
  // Rail hole x is unchanged by the split: groups of 5 with an extra pitch
  // of gap between groups, from the same railStartX.
  return {
    x: startX + k + Math.floor(k / 5),
    y: V2_STRIP_DY[strip] + V2_RAIL_LOCAL_Y[polarity],
  };
}

/**
 * v1 stored a rotated part's far lead as a hole id on the SAME board. Now
 * that rails are their own strip, that lead is a `{dx, dy}` bend from the
 * anchor, resolved against whatever strip lies under it.
 *
 * Both ends are resolved in the v2 kit frame, so the bend is exact even when
 * it crosses from the pin-board onto a rail.
 */
function convertLeadEnd(comp, boardType) {
  const params = comp?.params;
  if (!params || params.rot !== 90 || typeof params.end !== "string")
    return comp;
  const from = v2HolePosition(boardType, comp.anchor);
  const to = v2HolePosition(boardType, params.end);
  // Unconvertible (junk anchor/end) → drop the bend; the part keeps its seat.
  const end = from && to ? { dx: to.x - from.x, dy: to.y - from.y } : null;
  return { ...comp, params: { ...params, end } };
}

function migrateV1ToV2(doc) {
  const boards = Array.isArray(doc.boards) ? doc.boards : [];
  let nextBoardId = Number.isInteger(doc.nextBoardId) ? doc.nextBoardId : 1;
  for (const b of boards) {
    const m = typeof b?.id === "string" ? /^bb([1-9]\d*)$/.exec(b.id) : null;
    if (m) nextBoardId = Math.max(nextBoardId, Number(m[1]) + 1);
  }
  let nextGroupId = Number.isInteger(doc.nextGroupId) ? doc.nextGroupId : 1;

  const nextBoards = [];
  // oldBoardId → { top, bottom } strip ids, for rewriting rail addresses.
  const railOwners = new Map();

  for (const b of boards) {
    if (!b || typeof b !== "object" || typeof b.id !== "string") continue;
    if (b.type === "tiny") {
      nextBoards.push({ ...b, type: "pins-tiny", group: null });
      continue;
    }
    const kit = V1_KITS[b.type];
    if (!kit) {
      nextBoards.push({ ...b, group: null }); // unknown type — leave alone
      continue;
    }
    const x = Math.round(Number(b.x) || 0);
    const y = Math.round(Number(b.y) || 0);
    const group = `g${nextGroupId++}`;
    const top = `bb${nextBoardId++}`;
    const bottom = `bb${nextBoardId++}`;
    railOwners.set(b.id, { top, bottom });
    nextBoards.push(
      { id: top, type: kit.rail, x, y, group },
      { ...b, type: kit.pins, x, y: y + RAIL_OFFSET_Y, group },
      { id: bottom, type: kit.rail, x, y: y + BOTTOM_OFFSET_Y, group },
    );
  }

  // "bb1.t+7" → "bb9.+7"; everything else (grid holes, PSU terminals) passes
  // through, since the pin-board inherited the old board id.
  const rewrite = (address) => {
    if (typeof address !== "string") return address;
    const dot = address.indexOf(".");
    if (dot <= 0) return address;
    const owners = railOwners.get(address.slice(0, dot));
    if (!owners) return address;
    const hole = address.slice(dot + 1);
    const rail = V1_RAILS[hole.slice(0, 2)];
    if (!rail) return address;
    return `${owners[rail[0]]}.${rail[1]}${hole.slice(2)}`;
  };

  // A rotated part's far lead becomes a geometric bend (see convertLeadEnd).
  // Its board reference is unchanged: the pin-board inherited the old id, and
  // parts only ever anchor in grid rows.
  const boardTypeById = new Map(
    boards
      .filter((b) => b && typeof b.id === "string")
      .map((b) => [b.id, b.type]),
  );
  const components = Array.isArray(doc.components) ? doc.components : [];
  const nextComponents = components.map((c) =>
    c && typeof c === "object"
      ? convertLeadEnd(c, boardTypeById.get(c.board))
      : c,
  );

  const wires = Array.isArray(doc.wires) ? doc.wires : [];
  return {
    ...doc,
    version: 2,
    boards: nextBoards,
    components: nextComponents,
    wires: wires.map((w) =>
      w && typeof w === "object"
        ? { ...w, from: rewrite(w.from), to: rewrite(w.to) }
        : w,
    ),
    nextBoardId,
    nextGroupId,
  };
}

/**
 * v2 → v3: net names + annotations arrive (Feature 120). A pure additive
 * migration — no address rewriting — that just defaults the two new arrays and
 * the id counter for documents saved before they existed.
 */
function migrateV2ToV3(doc) {
  return {
    ...doc,
    version: 3,
    netNames: Array.isArray(doc.netNames) ? doc.netNames : [],
    annotations: Array.isArray(doc.annotations) ? doc.annotations : [],
    nextAnnotationId:
      Number.isInteger(doc.nextAnnotationId) && doc.nextAnnotationId > 0
        ? doc.nextAnnotationId
        : 1,
  };
}

/** version → one-step upgrade fn returning the doc at version + 1. */
const MIGRATIONS = { 1: migrateV1ToV2, 2: migrateV2ToV3 };

/**
 * Bring a loaded document up to DESK_DOC_VERSION. Junk (null / non-object /
 * array) becomes the default document; missing top-level fields are filled
 * from the defaults before any migration step runs.
 *
 * @param {*} raw The parsed desk.json contents (or null when absent).
 * @returns {object} A document at DESK_DOC_VERSION (or newer, untouched).
 */
function migrateDeskDocument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultDeskDocument();
  }
  let doc = { ...defaultDeskDocument(), ...raw };
  if (!Number.isInteger(doc.version) || doc.version < 1) {
    doc.version = DESK_DOC_VERSION;
  }
  while (doc.version < DESK_DOC_VERSION) {
    const step = MIGRATIONS[doc.version];
    if (!step) break; // gap in the chain — hand over as-is (defensive)
    doc = step(doc);
  }
  return doc;
}

module.exports = { DESK_DOC_VERSION, defaultDeskDocument, migrateDeskDocument };
