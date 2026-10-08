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
 * v3 → v4 (Feature 130) adds buses (pure additive).
 * v4 → v5 (Feature 150) adds an optional per-component schematic position hint
 *   (no doc-level state — a pure version bump; absence is valid).
 * v5 → v6 (HD44780 LCD) adds the `nextLcdId` brick counter (pure additive).
 * v6 → v7 adds an optional Name/Description pair to every board and
 *   component (the shared Properties dialog) — no doc-level state, a pure
 *   version bump; absence is valid.
 * v7 → v8 adds an optional Name/Description pair to every wire too (the wire
 *   context menu now opens the same shared Properties dialog) — no doc-level
 *   state, a pure version bump; absence is valid.
 * v8 → v9 adds a wire's optional `layout`/`points` (the Routed layout method) —
 *   absence is the DIRECT default every wire had, so a pure version bump.
 * v9 → v10 RETIRES `nextLcdId`: the HD44780 stopped being a desk brick and
 *   became two board-seated modules, so its brick counter has nothing left to
 *   count. Subtractive — the only migration so far that takes a field away.
 * v10 → v11 re-stacks dovetailed strips onto the MEASURED vertical heights.
 * v11 → v12 turns every `rnet9` end-for-end, because its pin numbering was
 *   renumbered to the real part's: the common bus moved from pin 9 to pin 1,
 *   which also moved it from the last hole to the anchor. Stamping `rot: 180`
 *   reverses the numbering back, so the common stays in the very hole the user
 *   wired it to — the part is renumbered, the CIRCUIT is untouched.
 * v12 → v13 (Feature 370) adds external signals — `signals` + `nextSignalId` —
 *   and, in the same step, the two fields Feature 210 forgot: `scopeChannels`
 *   and `nextScopeChannelId`. Pure additive, like v2 → v3 and v3 → v4.
 *
 *   The forgotten pair is why this step exists at all rather than relying on
 *   the renderer to fill a missing list. `migrateDeskDocument` merges
 *   `defaultDeskDocument()` UNDER the raw document BEFORE any step runs, so a
 *   field absent from main's default is a field main's chain can never see or
 *   repair — the analyzer's channels have survived purely because the
 *   renderer's normalizeDocument rebuilds from its own empty document. That is
 *   a load-bearing accident, not a design; this puts both back in shape.
 * v13 → v14 adds the Arduino serial integration's Output and Input elements —
 *   `integrations` + `nextOutputId` + `nextInputId`. Pure additive: an absent
 *   list is an empty one.
 * v14 → v15 powers every clock brick. A clock gained a `vcc` terminal and now
 *   runs only from a supply (+ on `vcc`, − on `gnd`), so a desk saved before
 *   that — whose clocks were wired `out` (and maybe `gnd`) and nothing else —
 *   gets a jumper from each clock's `vcc` to the + rail of the supply it
 *   already uses (and from `gnd` to its − rail, when that was never wired).
 */
"use strict";

const DESK_DOC_VERSION = 15;

/** A fresh, empty desk document (main's copy of the renderer's shape). */
function defaultDeskDocument() {
  return {
    version: DESK_DOC_VERSION,
    boards: [],
    components: [],
    wires: [],
    buses: [],
    netNames: [],
    annotations: [],
    scopeChannels: [],
    signals: [],
    integrations: [],
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
    nextBusId: 1,
    nextAnnotationId: 1,
    nextScopeChannelId: 1,
    nextSignalId: 1,
    nextOutputId: 1,
    nextInputId: 1,
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

/**
 * v3 → v4: buses arrive (Feature 130). A pure additive migration — buses are
 * metadata over the existing wires — that defaults the new array + id counter
 * for documents saved before they existed.
 */
function migrateV3ToV4(doc) {
  return {
    ...doc,
    version: 4,
    buses: Array.isArray(doc.buses) ? doc.buses : [],
    nextBusId:
      Number.isInteger(doc.nextBusId) && doc.nextBusId > 0 ? doc.nextBusId : 1,
  };
}

/**
 * v4 → v5: the schematic view (Feature 150) arrives. Its only persisted state
 * is an OPTIONAL per-component `schematicPos` hint whose absence is valid, so
 * there is nothing to default at the document level — this is a pure version
 * bump that keeps the version monotonic with the feature waves.
 */
function migrateV4ToV5(doc) {
  return { ...doc, version: 5 };
}

/**
 * v5 → v6: the HD44780 character-LCD brick arrives. A pure additive migration
 * that defaults its id counter for documents saved before it existed (the
 * brick itself is a new component kind — old docs simply have none).
 */
function migrateV5ToV6(doc) {
  return {
    ...doc,
    version: 6,
    nextLcdId:
      Number.isInteger(doc.nextLcdId) && doc.nextLcdId > 0 ? doc.nextLcdId : 1,
  };
}

/**
 * v6 → v7: every board and component gains an optional Name/Description pair
 * (the shared Properties dialog). A pure additive migration — an absent
 * name/description is valid, so there is nothing to default at the document
 * level.
 */
function migrateV6ToV7(doc) {
  return { ...doc, version: 7 };
}

/**
 * v7 → v8: every wire gains an optional Name/Description pair too (the wire
 * context menu now opens the same shared Properties dialog as every other
 * part). A pure additive migration — nothing to default.
 */
function migrateV7ToV8(doc) {
  return { ...doc, version: 8 };
}

/**
 * v8 → v9: a wire gains an optional `layout` ("routed") and, with it, the
 * `points` it is bent through. A pure additive migration: absence IS the
 * default (a wire with neither is the sagging direct curve every wire was),
 * so there is nothing to fill in.
 */
function migrateV8ToV9(doc) {
  return { ...doc, version: 9 };
}

/**
 * v9 → v10: the HD44780 character LCD stops being a desk BRICK (a free {x, y}
 * module wired by terminal) and becomes two board-seated parts, lcd16x2 and
 * lcd20x4, whose pins are breadboard holes. So `nextLcdId` — the brick id
 * counter v6 added — has nothing left to count.
 *
 * The LCD COMPONENTS need no step here, deliberately: the renderer's
 * normalizeDocument drops any component whose ref has left the catalog and
 * cascades its wires with it, which is exactly the right outcome for a brick
 * that can no longer be represented (a migration cannot invent the board and
 * anchor a seated part needs). This only takes the dead field out of the shape.
 */
function migrateV9ToV10(doc) {
  const { nextLcdId: _retired, ...rest } = doc;
  return { ...rest, version: 10 };
}

/**
 * v10 → v11: the vertical geometry stopped being whole pitches and started
 * being MEASURED (src/web/scripts/model/board-types.js). A rail was 3 pitches
 * tall and is 3.50 (8.9 mm); a pin-board was 13 and is 14.02 (35.6). So every
 * stack of strips in an existing desk is now too short for its own contents:
 * the 830 kit that sat at y 0 · 3 · 16 has its pin-board reaching 3 → 17.02,
 * straight through the bottom rail at 16 — and the renderer's
 * `normalizeDocument` DROPS a board that overlaps one already loaded, taking
 * everything seated on it with it. Without this step, opening a saved desk
 * silently deletes a rail and every wire that reached it.
 *
 * The fix is the only one that can be stated without knowing what the desk
 * MEANT: re-flow each flush vertical run at the new heights, keeping its
 * topmost strip where the user put it. Boards that merely sit near each other
 * are left alone — a gap is a gap, and the strips' own growth is under a
 * quarter of one.
 *
 * THE GEOMETRY IS FROZEN HERE, BOTH SIDES OF IT, as every migration's is: this
 * step is a snapshot of one transition, and importing the live specs would
 * make it silently re-interpret itself the next time a strip is re-measured.
 */
const V10_SIZE = {
  "pins-full": { width: 64, height: 13 },
  "pins-half": { width: 31, height: 13 },
  "pins-tiny": { width: 18, height: 13 },
  "rail-full": { width: 64, height: 3 },
  "rail-half": { width: 31, height: 3 },
};
const V11_SIZE = {
  "pins-full": { width: 64, height: 14.02 },
  "pins-half": { width: 31, height: 14.02 },
  "pins-tiny": { width: 18, height: 14.02 },
  "rail-full": { width: 64, height: 3.5 },
  "rail-half": { width: 31, height: 3.5 },
};

/** A strip's footprint at its placed rotation — width and height swap on a
    quarter turn, exactly as `boardSize` does on the live side. */
function stripSize(table, board) {
  const size = table[board?.type];
  if (!size) return null;
  const turned = board.rot === 90 || board.rot === 270;
  return turned
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

const q2 = (n) => Math.round(n * 100) / 100;

function migrateV10ToV11(doc) {
  const boards = Array.isArray(doc.boards) ? doc.boards : [];
  const sized = boards
    .map((b) => ({ b, was: stripSize(V10_SIZE, b), now: stripSize(V11_SIZE, b) }))
    .filter((e) => e.was && e.now && Number.isFinite(e.b.x) && Number.isFinite(e.b.y)); // prettier-ignore
  if (sized.length === 0) return { ...doc, version: 11 };

  // Who sits flush UNDER whom, in the v10 frame — the same test the live
  // mating rule uses (same x, same width, bottom edge meets top edge).
  const below = new Map();
  const hasAbove = new Set();
  for (const a of sized) {
    for (const b of sized) {
      if (a === b || below.has(a)) continue;
      if (a.b.x !== b.b.x || a.was.width !== b.was.width) continue;
      if (a.b.y + a.was.height !== b.b.y) continue;
      below.set(a, b);
      hasAbove.add(b);
    }
  }

  // Re-flow each run from its top strip down. A strip in no run keeps its y,
  // and so does the top of every run: the user placed that one.
  const moved = new Map();
  for (const head of sized) {
    if (hasAbove.has(head)) continue; // not the top of its run
    let y = head.b.y;
    for (let e = head; e; e = below.get(e)) {
      moved.set(e.b, q2(y));
      y = q2(y + e.now.height);
    }
  }

  return {
    ...doc,
    version: 11,
    boards: boards.map((b) => (moved.has(b) ? { ...b, y: moved.get(b) } : b)),
  };
}

/**
 * v11 → v12 — the bussed resistor array's pins were renumbered to match the
 * part in the drawer: COM is pin 1 (the end the printed dot marks) and the
 * eight elements are pins 2–9, where COM used to be pin 9 and the elements
 * 1–8.
 *
 * Pin 1 is the ANCHOR hole, so that renumbering also swaps which END of the
 * nine holes is the common bus — and a desk saved before it has a wire running
 * from a rail to the hole that WAS the common and is now an element. Turning
 * each array end-for-end (`rot: 180`, the same half lap a DIP flip stores)
 * reverses the numbering back over the same nine holes: every lead keeps the
 * hole it is plugged into, the common bus keeps its wire, and nothing moves on
 * the desk. What changes is the label on each pin and the dot's end — which is
 * the point of the renumbering.
 *
 * Not conditional on finding one: a document with no array is a plain version
 * bump, and `components` may be absent or junk (this runs before the renderer's
 * normalizeDocument ever sees it).
 */
function migrateV11ToV12(doc) {
  const components = Array.isArray(doc.components) ? doc.components : [];
  return {
    ...doc,
    version: 12,
    components: components.map((c) =>
      c && typeof c === "object" && c.ref === "rnet9"
        ? { ...c, params: { ...c.params, rot: 180 } }
        : c,
    ),
  };
}

/**
 * v12 → v13: external signals (Feature 370), plus the analyzer's two fields.
 *
 * Additive only — an absent list is an empty one, so there is nothing to
 * transform and nothing that can go wrong. A doc that already carries either
 * list keeps it verbatim.
 */
function migrateV12ToV13(doc) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const counter = (value) => (Number.isInteger(value) && value > 0 ? value : 1);
  return {
    ...doc,
    version: 13,
    signals: list(doc.signals),
    nextSignalId: counter(doc.nextSignalId),
    scopeChannels: list(doc.scopeChannels),
    nextScopeChannelId: counter(doc.nextScopeChannelId),
  };
}

/**
 * v13 → v14: the serial integration's Output and Input elements. Additive
 * only, like v12 → v13 — a doc already carrying the list keeps it verbatim.
 */
function migrateV13ToV14(doc) {
  const counter = (value) => (Number.isInteger(value) && value > 0 ? value : 1);
  return {
    ...doc,
    version: 14,
    integrations: Array.isArray(doc.integrations) ? doc.integrations : [],
    nextOutputId: counter(doc.nextOutputId),
    nextInputId: counter(doc.nextInputId),
  };
}

/**
 * v14 → v15: a clock brick runs from a supply (Jason, 2026-10-07).
 *
 * The clock gained a `vcc` terminal between `out` and `gnd` (both of which
 * kept their places), and the engine now drives a clock's output only when
 * `vcc` sits on a PSU's + net and `gnd` on a − net. A desk saved before that
 * has no wire on `vcc` — the terminal did not exist — so without this step
 * every clock in it would open dead. Each such clock gets ONE red jumper from
 * `vcc` to the + side of the supply it already uses; and if its `gnd` was
 * never wired either (the old clock did not need it), a black one from `gnd`
 * to that supply's − side.
 *
 * WHICH SUPPLY. The one whose − terminal the clock's `gnd` already reaches
 * (through wires and rail strips); when several share that ground, the lowest
 * voltage, so a clock never drives a chip above its own supply. A clock whose
 * `gnd` reaches nothing takes the desk's supply only when every PSU on the
 * desk is at one voltage — otherwise there is no right answer to guess, and
 * the clock is left for the "clock not powered" warning to explain.
 *
 * WHERE. The free hole on a rail strip of that supply's net nearest the
 * clock's terminal; failing that, the PSU's own terminal when nothing is on
 * it. A clock that cannot get BOTH leads it needs is left exactly as it was —
 * half a fix would be a wire that does nothing.
 *
 * "Free" is read from what can sit in a rail hole: wire ends, a part anchored
 * there, a bent lead landing within reach of it, a signal flag or an Output/
 * Input tag. The renderer's `normalizeDocument` is the backstop: a jumper
 * that still landed on a taken hole is dropped there, leaving the clock as
 * unpowered as it would have been anyway.
 *
 * THE GEOMETRY IS FROZEN HERE, as every migration's is: the strips and brick
 * terminals as they stand at this boundary, never the live specs.
 */
const V15_STRIPS = {
  "pins-full": { width: 64, height: 14.02, cols: 63 },
  "pins-half": { width: 31, height: 14.02, cols: 30 },
  "pins-tiny": { width: 18, height: 14.02, cols: 17 },
  "rail-full": { width: 64, height: 3.5, holes: 50, startX: 3 },
  "rail-half": { width: 31, height: 3.5, holes: 25, startX: 2 },
};
const V15_ROW_Y = {
  j: 1.51,
  i: 2.51,
  h: 3.51,
  g: 4.51,
  f: 5.51,
  e: 8.51,
  d: 9.51,
  c: 10.51,
  b: 11.51,
  a: 12.51,
};
const V15_RAIL_Y = { "+": 1.25, "-": 2.25 };
const V15_RAIL_GROUP = 5;
const V15_CLOCK_TERMINALS = { vcc: { dx: 4, dy: 4 }, gnd: { dx: 6, dy: 4 } };
/** A bent lead lands on the hole under it; anything this close is taken. */
const V15_LEAD_REACH = 0.6;

/** A hole id's position in its strip's own frame, or null. */
function v15LocalHole(type, hole) {
  const spec = V15_STRIPS[type];
  if (!spec || typeof hole !== "string") return null;
  const rail = /^([+-])([1-9]\d*)$/.exec(hole);
  if (rail) {
    const k = Number(rail[2]);
    if (!spec.holes || k > spec.holes) return null;
    const x = spec.startX + (k - 1) + Math.floor((k - 1) / V15_RAIL_GROUP);
    return { x, y: V15_RAIL_Y[rail[1]] };
  }
  const grid = /^([a-j])([1-9]\d*)$/.exec(hole);
  if (grid) {
    const col = Number(grid[2]);
    if (!spec.cols || col > spec.cols) return null;
    return { x: col, y: V15_ROW_Y[grid[1]] };
  }
  return null;
}

/** A strip-frame point on the desk, at the strip's placed rotation (the same
    quarter-turn arithmetic as the live `rotatePoint`). */
function v15World(board, local) {
  const s = V15_STRIPS[board.type];
  const { x, y } = local;
  let p = { x, y };
  if (board.rot === 90) p = { x: s.height - y, y: x };
  else if (board.rot === 180) p = { x: s.width - x, y: s.height - y };
  else if (board.rot === 270) p = { x: y, y: s.width - x };
  return { x: (Number(board.x) || 0) + p.x, y: (Number(board.y) || 0) + p.y };
}

function migrateV14ToV15(doc) {
  const bumped = { ...doc, version: 15 };
  const components = Array.isArray(doc.components) ? doc.components : [];
  const wires = Array.isArray(doc.wires) ? doc.wires : [];
  const isClock = (c) => c && c.kind === "clock" && typeof c.id === "string";
  const ends = new Set();
  for (const w of wires) {
    if (!w || typeof w !== "object") continue;
    if (typeof w.from === "string") ends.add(w.from);
    if (typeof w.to === "string") ends.add(w.to);
  }
  const dead = components.filter((c) => isClock(c) && !ends.has(`${c.id}.vcc`));
  if (dead.length === 0) return bumped;

  const boards = new Map();
  for (const b of Array.isArray(doc.boards) ? doc.boards : []) {
    if (b && typeof b.id === "string" && V15_STRIPS[b.type])
      boards.set(b.id, b);
  }
  const split = (address) => {
    const dot = typeof address === "string" ? address.indexOf(".") : -1;
    return dot > 0 ? [address.slice(0, dot), address.slice(dot + 1)] : [null, null]; // prettier-ignore
  };
  /** The electrical node a point belongs to by the boards alone: a rail line
      is one node, a grid column-half another, anything else is itself. */
  const nodeOf = (address) => {
    const [owner, hole] = split(address);
    const board = boards.get(owner);
    if (!board || !v15LocalHole(board.type, hole)) return address;
    if (hole[0] === "+" || hole[0] === "-") return `${owner}.${hole[0]}`;
    return `${owner}.${"abcde".includes(hole[0]) ? "lo" : "hi"}${hole.slice(1)}`;
  };
  const parent = new Map();
  const find = (k) => {
    while (parent.has(k) && parent.get(k) !== k) k = parent.get(k);
    return k;
  };
  const union = (a, b) => {
    const ra = find(nodeOf(a));
    const rb = find(nodeOf(b));
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const w of wires) {
    if (w && typeof w.from === "string" && typeof w.to === "string") {
      union(w.from, w.to);
    }
  }

  // What already sits in a hole — and the desk points bent leads land on.
  const taken = new Set(ends);
  const leadTips = [];
  for (const c of components) {
    if (!c || typeof c !== "object") continue;
    const board = boards.get(c.board);
    if (!board || typeof c.anchor !== "string") continue;
    taken.add(`${c.board}.${c.anchor}`);
    const end = c.params?.end;
    const local = v15LocalHole(board.type, c.anchor);
    if (local && end && Number.isFinite(end.dx) && Number.isFinite(end.dy)) {
      const at = v15World(board, local);
      leadTips.push({ x: at.x + end.dx, y: at.y + end.dy });
    }
  }
  for (const s of Array.isArray(doc.signals) ? doc.signals : []) {
    if (typeof s?.flag?.anchor === "string") taken.add(s.flag.anchor);
  }
  for (const el of Array.isArray(doc.integrations) ? doc.integrations : []) {
    for (const tag of Object.values(el?.tags ?? {})) {
      if (typeof tag?.anchor === "string") taken.add(tag.anchor);
    }
  }

  const railHoles = []; // { address, node, at }
  for (const board of boards.values()) {
    const spec = V15_STRIPS[board.type];
    for (const sign of spec.holes ? ["+", "-"] : []) {
      for (let k = 1; k <= spec.holes; k++) {
        const address = `${board.id}.${sign}${k}`;
        const at = v15World(board, v15LocalHole(board.type, `${sign}${k}`));
        railHoles.push({ address, node: `${board.id}.${sign}`, at });
      }
    }
  }
  const free = (h) =>
    !taken.has(h.address) &&
    !leadTips.some(
      (p) => Math.hypot(p.x - h.at.x, p.y - h.at.y) < V15_LEAD_REACH,
    );

  /** The free point on `terminal`'s net nearest `from`: a rail hole, else
      the terminal itself when nothing is on it. */
  const placeOn = (terminal, from) => {
    const node = find(nodeOf(terminal));
    let best = null;
    for (const h of railHoles) {
      if (find(h.node) !== node || !free(h)) continue;
      const d = Math.hypot(h.at.x - from.x, h.at.y - from.y);
      if (!best || d < best.d) best = { address: h.address, d };
    }
    if (best) return best.address;
    return taken.has(terminal) ? null : terminal;
  };

  const psus = components.filter(
    (c) => c && c.kind === "psu" && typeof c.id === "string",
  );
  const voltsOf = (p) => (Number.isFinite(p.params?.volts) ? p.params.volts : 5); // prettier-ignore
  const oneVoltage = new Set(psus.map(voltsOf)).size === 1;

  let nextWireId = Number.isInteger(doc.nextWireId) ? doc.nextWireId : 1;
  for (const w of wires) {
    const m = typeof w?.id === "string" ? /^w([1-9]\d*)$/.exec(w.id) : null;
    if (m) nextWireId = Math.max(nextWireId, Number(m[1]) + 1);
  }
  const added = [];
  const lay = (from, to, color) => {
    added.push({ id: `w${nextWireId++}`, from, to, color });
    taken.add(from);
    taken.add(to);
    union(from, to);
  };

  for (const clock of dead) {
    const gnd = `${clock.id}.gnd`;
    const gndWired = ends.has(gnd);
    const candidates = gndWired
      ? psus.filter((p) => find(nodeOf(`${p.id}.-`)) === find(nodeOf(gnd)))
      : oneVoltage
        ? psus
        : [];
    candidates.sort((a, b) => voltsOf(a) - voltsOf(b));
    const origin = { x: Number(clock.x) || 0, y: Number(clock.y) || 0 };
    const at = (t) => ({
      x: origin.x + V15_CLOCK_TERMINALS[t].dx,
      y: origin.y + V15_CLOCK_TERMINALS[t].dy,
    });
    for (const psu of candidates) {
      const plus = placeOn(`${psu.id}.+`, at("vcc"));
      if (!plus) continue;
      let minus = null;
      if (!gndWired) {
        // Reserve the + hole first, so a desk whose + and − nets were
        // jumpered together can't hand both leads the same hole.
        taken.add(plus);
        minus = placeOn(`${psu.id}.-`, at("gnd"));
        taken.delete(plus);
        if (!minus) continue;
      }
      lay(`${clock.id}.vcc`, plus, "red");
      if (minus) lay(gnd, minus, "black");
      break;
    }
  }

  return added.length
    ? { ...bumped, wires: [...wires, ...added], nextWireId }
    : bumped;
}

/** version → one-step upgrade fn returning the doc at version + 1. */
const MIGRATIONS = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
  3: migrateV3ToV4,
  4: migrateV4ToV5,
  5: migrateV5ToV6,
  6: migrateV6ToV7,
  7: migrateV7ToV8,
  8: migrateV8ToV9,
  9: migrateV9ToV10,
  10: migrateV10ToV11,
  11: migrateV11ToV12,
  12: migrateV12ToV13,
  13: migrateV13ToV14,
  14: migrateV14ToV15,
};

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
