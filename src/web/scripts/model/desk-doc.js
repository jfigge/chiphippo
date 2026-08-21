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
// instance, mutates it through these methods, and the serialized form travels
// as one desktop of the open PROJECT — the single file every desk is saved in
// (model/project-doc.js, window.chiphippo.project.save).
//
// A "board" is one STRIP — a pin-board or a power rail (board-types.js). A
// breadboard is a KIT of strips placed together in one action and joined by a
// shared `group` id (`g<n>`, or null for a loose strip). Strips in a group
// drag as one rigid unit, the way a real board's snapped-together halves do.
//
// Board x/y are strip-origin world coordinates in PITCH UNITS, snapped to
// integers so every hole lands on the global 0.1-in lattice (holes are
// integer offsets within a strip — see board-types.js). Board ids are
// `bb<n>` and component ids `c<n>`, from per-document counters that never
// reuse an id, even across delete + save + reload (`nextBoardId` /
// `nextComponentId` persist in the document).
//
// Components are `{ id, kind, ref, board, anchor, params }` — kind "chip"
// now ("discrete"/"psu" later), `ref` a catalog id, `anchor` pin 1's seated
// hole (row e). Pin positions are always DERIVED (footprints + occupancy),
// never stored; occupancy.js is the single collision authority.

import { BOARD_TYPES, BREADBOARD_KITS } from "./board-types.js";
import {
  boardSize,
  canRotate,
  formatAddress,
  holePosition,
  normalizeRotation,
  parseAddress,
  parseHole,
  ROTATIONS,
  rotateOffset,
  spec,
} from "./breadboard.js";
import { partDef } from "../catalog/index.js";
import {
  boardRect as outlineRect,
  FLUSH_EPS,
  matingEdge,
  snapCorrection,
} from "./mating.js";
import { snapDesign } from "./design-clip.js";
import {
  clusterMembers,
  partsRidingCluster,
  planClusterRiders,
  resolveClusterTargets,
  wiresRidingCluster,
} from "./cluster-move.js";
import { partsRidingPart, planPartMove, wiresRidingPart } from "./part-move.js";
import {
  addressAtWorld,
  buildOccupancy,
  canCornerOffset,
  canMoveWire,
  canPlacePart,
  canPlaceWire,
  canReendWire,
  isFreeHole,
  isRealPoint,
  partPinAddresses,
  partPinHoles,
} from "./occupancy.js";

/**
 * The schema version stamped on every document this side writes.
 *
 * It MUST equal main's `DESK_DOC_VERSION` (app/store/migrations.js), and
 * `app/tests/migrations.test.js` holds the two together. `normalizeDocument`
 * rebuilds from `emptyDocument()` and never carries a loaded document's own
 * version forward, so this number is what EVERY saved desk claims — which is
 * what lets a migration tell a document written before its change from one
 * written after. Left behind at 6 while the chain reached 11, it silently
 * meant the opposite: every desk the app wrote re-entered the chain five
 * steps back, so a migration keyed on a version could never fire once and
 * once only.
 */
export const DOC_VERSION = 12;

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

/**
 * How a wire gets from one end to the other — its "Layout Method" (the wire's
 * own Properties dialog; the app-wide default for a NEW wire is Settings ▸
 * Appearance ▸ "Wire layout").
 *
 * · `"direct"` — the sagging bezier every wire has always been: hole to hole,
 *   nothing to decide, which is why it is the default and why the AI builder
 *   emits nothing else (a compiler places holes, not hand-drawn routes).
 * · `"routed"` — a straight run the user BENDS by dragging waypoints into it,
 *   so a wire can be taken around a board instead of over it.
 *
 * Stored omit-when-default (a direct wire carries no `layout` and no `points`),
 * the same convention as a wire's Name/Description — so a document that never
 * routed anything round-trips to the shape it had before this existed.
 */
export const WIRE_LAYOUTS = Object.freeze(["direct", "routed"]);

/** The most waypoints ONE routed wire may carry. A bend is a hand gesture, and
    twenty of them is already far past what any real jumper needs — the cap is
    what keeps a stuck drag from filling a document with them. */
export const MAX_WIRE_POINTS = 20;

/** The bus-width presets the bus tool's toolbar/keyboard shortcuts pick from —
    `name` is the grammar the tool parses (see parseBusName); 8-bit is the
    default. Listed narrowest-first, which is NOT the order the digit keys walk
    (see busWidthForKey). */
export const BUS_WIDTHS = Object.freeze([
  Object.freeze({ bits: 2, name: "D[1:0]" }),
  Object.freeze({ bits: 3, name: "D[2:0]" }),
  Object.freeze({ bits: 4, name: "D[3:0]" }),
  Object.freeze({ bits: 5, name: "D[4:0]" }),
  Object.freeze({ bits: 6, name: "D[5:0]" }),
  Object.freeze({ bits: 7, name: "D[6:0]" }),
  Object.freeze({ bits: 8, name: "D[7:0]" }),
  Object.freeze({ bits: 16, name: "D[15:0]" }),
]);

/**
 * The preset the digit keys 1–8 pick while the bus tool is armed. Every digit
 * but one NAMES ITS OWN WIDTH — `4` lays a 4-bit run — which is the whole
 * reason the mapping isn't the list's index order: a key you have to count to
 * is a key you have to look up. `1` is the 16-bit bus, because no single digit
 * can spell 16 and the widest bus is the one worth the first key.
 *
 * @returns {{bits:number, name:string}|null} null for a digit with no preset.
 */
export function busWidthForKey(digit) {
  const bits = digit === 1 ? 16 : digit;
  return BUS_WIDTHS.find((w) => w.bits === bits) ?? null;
}

/**
 * The common net names offered as quick-picks when naming a net (Feature 120).
 * They carry NO special power — the engine still derives power from PSU volts
 * and rail polarity; a name is documentation. Any string is legal.
 */
export const RESERVED_NET_NAMES = Object.freeze(["VCC", "GND", "CLK"]);

/** Annotation kinds (Feature 120): a one-line label vs a multi-line note. */
const ANNOTATION_KINDS = new Set(["label", "note"]);

/** The widest bus the name grammar will mint — a guard against a `D[0:9999]`
    typo trying to lay ten thousand wires. */
export const MAX_BUS_WIDTH = 64;

const BUS_NAME_RE = /^(.*?)\[\s*(\d+)\s*:\s*(\d+)\s*\]$/;

/**
 * Parse a bus name into its width + bit order (Feature 130). The grammar is a
 * base plus an optional `[hi:lo]` (msb:lsb, e.g. `D[7:0]`) or `[lo:hi]`
 * (`A[0:15]`); a bare name is a width-1 "bus" (a named single wire). The `bits`
 * array is the bit NUMBER each ordered member carries — `D[7:0]` → [7,6,…,0],
 * so member 0 is the msb and a pin-tap wires it to the high pin.
 *
 * @returns {{ base:string, width:number, hi:number, lo:number,
 *   order:"asc"|"desc"|"single", bits:number[] }|null} null for junk or a
 *   width past MAX_BUS_WIDTH.
 */
export function parseBusName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const m = BUS_NAME_RE.exec(trimmed);
  if (!m) {
    return {
      base: trimmed,
      width: 1,
      hi: 0,
      lo: 0,
      order: "single",
      bits: [0],
    };
  }
  const a = Number(m[2]);
  const b = Number(m[3]);
  const width = Math.abs(a - b) + 1;
  if (width > MAX_BUS_WIDTH) return null;
  const step = a <= b ? 1 : -1;
  const bits = [];
  for (let i = 0; i < width; i += 1) bits.push(a + i * step);
  return {
    base: m[1].trim(),
    width,
    hi: Math.max(a, b),
    lo: Math.min(a, b),
    order: a <= b ? "asc" : "desc",
    bits,
  };
}

const BOARD_ID_RE = /^bb([1-9]\d*)$/;
const GROUP_ID_RE = /^g([1-9]\d*)$/;
const COMPONENT_ID_RE = /^c([1-9]\d*)$/;
const PSU_ID_RE = /^psu([1-9]\d*)$/;
const CLOCK_ID_RE = /^clk([1-9]\d*)$/;
const WIRE_ID_RE = /^w([1-9]\d*)$/;
const ANNOTATION_ID_RE = /^an([1-9]\d*)$/;
const BUS_ID_RE = /^bus([1-9]\d*)$/;
const SCOPE_CHANNEL_ID_RE = /^sc([1-9]\d*)$/;

/** Logic-analyzer channel kinds (Feature 210): a single net or a whole bus. */
const SCOPE_CHANNEL_KINDS = new Set(["net", "bus"]);

/** Desk-level bricks (no board): kind → { id regex, id prefix, next counter }. */
const BRICKS = Object.freeze({
  psu: { re: PSU_ID_RE, prefix: "psu", counter: "nextPsuId" },
  clock: { re: CLOCK_ID_RE, prefix: "clk", counter: "nextClockId" },
});

/** Params coerced through the def's own contract (chips have none). */
function normalizeParams(def, raw) {
  return def.normalizeParams ? def.normalizeParams(raw) : {};
}

/**
 * Params coerced on the way IN from a stored document, which is the same thing
 * MINUS the run state.
 *
 * `damaged` is a chip's 12 V kill, and it is in the document only because the
 * pure engine reads the document — it is the latch that keeps a chip dead for
 * the rest of the run (see `SimController#persistDamage`). It is not a property
 * of the CIRCUIT, and a stop clears it, so a document must never load one in:
 * that would be a dead chip nothing could revive short of deleting it. Two ways
 * one can be in a file at all — a project saved mid-run, and any document
 * written before damage became run-volatile — and this covers both, along with
 * every import and paste, since everything reaches the desk through here.
 *
 * Deliberately NOT folded into `normalizeParams` itself: `setComponentParams`
 * shares that path, and the latch has to be able to get in while running.
 */
function loadParams(def, raw) {
  const params = normalizeParams(def, raw);
  delete params.damaged;
  return params;
}

/**
 * A component's optional `schematicPos` nudge (Feature 150): a finite `{x,y}`
 * or undefined. Purely a layout hint for the derived schematic view — the desk
 * placement is unaffected.
 */
function normalizeSchematicPos(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const { x, y } = raw;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

/**
 * Apply an optional Name/Description pair (the shared Properties dialog) to a
 * board or component record, present only when set to a non-empty string —
 * same omit-when-empty convention as schematicPos, so a record that never had
 * one round-trips to the identical shape it had before these fields existed.
 */
function applyMeta(record, raw) {
  if (typeof raw?.name === "string" && raw.name) record.name = raw.name;
  if (typeof raw?.description === "string" && raw.description) {
    record.description = raw.description;
  }
}

function taggedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** A routed wire's waypoint, in world pitch units. Unlike everything else on
    the desk a waypoint is NOT on the lattice — it is a free point in the space
    between the boards, so it keeps two decimals rather than rounding to a hole
    it has nothing to do with. */
function wireCoord(n) {
  return Math.round(n * 100) / 100;
}

/**
 * A board coordinate on the grid the document STORES boards on: two decimals,
 * the same quantum a wire waypoint keeps.
 *
 * It used to be whole pitches, which was right while every strip was a whole
 * number of them tall. It is not any more: board-types.js measures a rail at
 * 3.70 pitches and a pin-board at 14.02, so the strips of an ordinary 830 kit
 * sit at y 0, 3.70 and 17.72 — and `Math.round` here would jam each of them
 * back into the one above it. Every vertical dimension in board-types.js is an
 * exact multiple of 0.01, so a stack lands on this grid exactly and stays
 * flush through a save and a reload.
 *
 * WHAT KEEPS THE COLUMNS LINED UP is not this function but the two things that
 * feed it: a board is PLACED at a whole-pitch x (`placeX`), and a drag moves it
 * by a whole-pitch delta. The only thing that ever puts a board on a fractional
 * x is a dovetail against something whose width is fractional — an upright rail
 * is 3.70 wide — which is precisely a case where the exact value is the point.
 */
function boardCoord(n) {
  return Math.round(n * 100) / 100;
}

/** Where a board is PLACED: x snaps to the integer column lattice, so a strip
    dropped anywhere on the desk lines its columns up with every other. */
function placeX(n) {
  return Math.round(n);
}

/** A magnetic pull, on the same grid. `snapCorrection` is pure rect geometry
    and works in whatever the caller hands it, so the difference of two measured
    strip heights comes back as 2.0000000000000036 — true enough to snap with,
    but not something to store or to state. Quantizing here lands the drop
    exactly flush and keeps the reported pull readable. */
function quantizePull({ dx, dy }) {
  return { dx: boardCoord(dx), dy: boardCoord(dy) };
}

/** Coerce a raw waypoint list: real finite points only, capped at
    MAX_WIRE_POINTS. Junk is dropped rather than refused — a hand-edited or
    foreign document should lose a bad bend, not its wire. */
function normalizeWirePoints(raw) {
  if (!Array.isArray(raw)) return [];
  const points = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    points.push({ x: wireCoord(p.x), y: wireCoord(p.y) });
    if (points.length === MAX_WIRE_POINTS) break;
  }
  return points;
}

/** Apply a wire's layout to a record, omit-when-default: a direct wire carries
    neither field, so it stays byte-identical to a pre-routing document. */
function applyWireLayout(record, layout, points) {
  if (layout !== "routed") return record;
  record.layout = "routed";
  const list = normalizeWirePoints(points);
  if (list.length > 0) record.points = list;
  return record;
}

/** A defensive copy of a wire — its waypoints are copied too, so a caller can
    never reach back into the document through the array it was handed. */
function copyWire(wire) {
  const copy = { ...wire };
  if (wire.points) copy.points = wire.points.map((p) => ({ ...p }));
  return copy;
}

/** A fresh, empty desk document. */
export function emptyDocument() {
  return {
    version: DOC_VERSION,
    boards: [],
    components: [],
    wires: [],
    buses: [],
    netNames: [],
    annotations: [],
    scopeChannels: [],
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextWireId: 1,
    nextBusId: 1,
    nextAnnotationId: 1,
    nextScopeChannelId: 1,
  };
}

/** Every list a desk's CONTENT lives in, read off the empty document itself so
    a list added later can never be forgotten here. */
const CONTENT_KEYS = Object.freeze(
  Object.entries(emptyDocument())
    .filter(([, value]) => Array.isArray(value))
    .map(([key]) => key),
);

/**
 * Is there NOTHING on this desk? No boards, parts, wires, buses, net names,
 * labels, or scope channels — so there is nothing in it to keep or to lose.
 *
 * The `next*Id` counters are deliberately not read: they say what a desk has
 * ever HELD, not what it holds. A board placed and then deleted leaves the
 * desk as empty as it started, and this must say so.
 */
export function isEmptyDocument(doc) {
  if (!doc || typeof doc !== "object") return true;
  return CONTENT_KEYS.every((key) => (doc[key]?.length ?? 0) === 0);
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

  // The board outlines accepted so far — see the OVERLAP note below.
  const taken = [];

  let maxBoardSeq = 0;
  let maxGroupSeq = 0;
  const boardIds = new Set();
  const boards = Array.isArray(raw.boards) ? raw.boards : [];
  for (const b of boards) {
    if (!b || typeof b !== "object") continue;
    const m = typeof b.id === "string" ? BOARD_ID_RE.exec(b.id) : null;
    if (!m || boardIds.has(b.id)) continue;
    if (!BOARD_TYPES[b.type]) continue;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    // A junk group id degrades to a loose strip rather than dropping it.
    const g = typeof b.group === "string" ? GROUP_ID_RE.exec(b.group) : null;
    const board = {
      id: b.id,
      type: b.type,
      x: boardCoord(b.x),
      y: boardCoord(b.y),
      rot: normalizeRotation(b.type, b.rot),
      group: g ? b.group : null,
    };
    // OVERLAP IS AS LOADABLE AS ANY OTHER NONSENSE, so it is checked here like
    // the rest. `canPlace` refuses it at placement time and `canMoveBoardsBy`
    // at drop time, but neither runs on the way in — so a hand-edited or
    // corrupt file could seat two strips through each other, and then NEITHER
    // could ever be moved: every drag re-checks against the other and is
    // refused, with no cue but a drop that will not take. Exactly the shape of
    // the seated-component check below ("a DIP anchored past the end of a strip
    // used to load clean … while the chip sat there electrically dead") — a
    // desk you cannot rearrange is the same bug wearing geometry.
    //
    // First-wins, like every other dedupe here. Dropping the LATER strip also
    // cascades correctly for free: its seated parts fail `boardIds.has`, and
    // its wires fail `validEndpoint`.
    const rect = outlineRect(board);
    if (taken.some((r) => rectsOverlap(rect, r))) continue;
    taken.push(rect);
    boardIds.add(b.id);
    maxBoardSeq = Math.max(maxBoardSeq, Number(m[1]));
    if (g) maxGroupSeq = Math.max(maxGroupSeq, Number(g[1]));
    applyMeta(board, b);
    doc.boards.push(board);
  }

  let maxCompSeq = 0;
  const maxBrickSeq = { psu: 0, clock: 0 };
  const compIds = new Set();
  // Every hole an accepted part's pins already claim — see the ONE HOLE, ONE
  // LEAD note below. Bricks are absent by construction: a terminal (`psu1.+`)
  // is its own address space and can never collide with a board hole.
  const claimedPoints = new Set();
  const components = Array.isArray(raw.components) ? raw.components : [];
  for (const c of components) {
    if (!c || typeof c !== "object" || compIds.has(c.id)) continue;
    const def = partDef(c.ref);
    if (!def) continue;
    const brick = BRICKS[c.kind];
    if (brick && def.kind === c.kind) {
      const m = typeof c.id === "string" ? brick.re.exec(c.id) : null;
      if (!m) continue;
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      compIds.add(c.id);
      maxBrickSeq[c.kind] = Math.max(maxBrickSeq[c.kind], Number(m[1]));
      const brickRecord = {
        id: c.id,
        kind: c.kind,
        ref: c.ref,
        x: Math.round(c.x),
        y: Math.round(c.y),
        params: normalizeParams(def, c.params),
      };
      // A BRICK's footprint is deliberately NOT checked here, though
      // `canPlaceBrick` refuses one over a board — because the two overlaps
      // are not the same problem. Two overlapping BOARDS deadlock: every drag
      // of either re-checks against the other and is refused, so neither can
      // ever be moved again. An overlapping brick is only a nuisance — it
      // cannot be dragged over a board, but it can always be dragged off one —
      // and dropping it on load would be a silent deletion to fix a nuisance.
      // (The `65xx-lcd` demo used to be the live example, its LCD module
      // sitting squarely on a breadboard; that module is a SEATED part now,
      // so no shipped document relies on this leniency any more.)
      applyMeta(brickRecord, c);
      doc.components.push(brickRecord);
      continue;
    }
    if (c.kind !== def.kind || (c.kind !== "chip" && c.kind !== "discrete")) {
      continue;
    }
    const m = typeof c.id === "string" ? COMPONENT_ID_RE.exec(c.id) : null;
    if (!m) continue;
    if (!boardIds.has(c.board)) continue; // seated on a surviving board
    if (typeof c.anchor !== "string") continue;
    // …and actually SEATED on it: the anchor has to fit the part's footprint,
    // and every hole that footprint lands on has to exist on that board. A DIP
    // anchored past the end of a strip used to load "clean" with its
    // overhanging pins resolving to nothing — the counts matched, so even an
    // entity-count check passed, while the chip sat there electrically dead.
    // A rotated part's BENT lead is deliberately exempt: it carries an
    // {offset} rather than a hole and may legally resolve to nothing, which is
    // the documented state a part falls into when a rail moves out from under
    // it. Floating is a state you fall into, never one you load into.
    const params = loadParams(def, c.params);
    const seat = partPinHoles(c.ref, c.anchor, params);
    if (!seat) continue; // anchor doesn't fit the footprint at all
    const seatBoard = doc.boards.find((b) => b.id === c.board);
    if (
      seat.some((p) => p.hole != null && !parseHole(seatBoard.type, p.hole))
    ) {
      continue;
    }
    const record = {
      id: c.id,
      kind: c.kind,
      ref: c.ref,
      board: c.board,
      anchor: c.anchor,
      params,
    };
    // ONE HOLE, ONE LEAD — the other half of "seated", and the half the check
    // above cannot see. That one proves each pin's hole EXISTS; this proves it
    // is FREE. `addComponent` has always refused an overlap (`canPlacePart`),
    // so only a hand-edited or corrupt file can carry one — and it loaded
    // clean, with `buildOccupancy`'s last-writer-wins silently masking the
    // loser's pins ENTIRELY: two 14-pin DIPs in one set of columns produced 14
    // occupancy entries, so the hover readout, the probe and the build guide
    // all named one chip where two sat, while the netlist joined both. Exactly
    // the shape of the board OVERLAP check above, one level down.
    //
    // Resolved through `partPinAddresses` rather than the `seat` holes, so a
    // rotated part's BENT lead is checked too — it lands on whatever strip lies
    // under it, which is as real a claim on that hole as a footprint pin's. A
    // lead resolving to nothing claims nothing (floating is legal).
    //
    // First wins, like every other dedupe here. Nothing cascades: dropping the
    // loser FREES holes rather than removing any, so every wire that was legal
    // stays legal — which is why the wire loop below still re-derives occupancy
    // from the surviving parts instead of reading this set.
    const claims = [];
    for (const { address } of partPinAddresses(doc, record) ?? []) {
      if (address != null) claims.push(address);
    }
    if (claims.some((a) => claimedPoints.has(a))) continue;
    for (const a of claims) claimedPoints.add(a);
    compIds.add(c.id);
    maxCompSeq = Math.max(maxCompSeq, Number(m[1]));
    const schematicPos = normalizeSchematicPos(c.schematicPos);
    if (schematicPos) record.schematicPos = schematicPos; // Feature 150 nudge
    applyMeta(record, c);
    doc.components.push(record);
  }

  // Wires: both endpoints must parse onto surviving boards' real holes (or
  // surviving PSU terminals) and be distinct; junk colors fall back to the
  // first palette entry.
  let maxWireSeq = 0;
  const wireIds = new Set();
  const validEndpoint = (address) => {
    if (typeof address !== "string") return false;
    const parsed = parseAddress(address);
    if (!parsed) return false;
    const board = doc.boards.find((b) => b.id === parsed.boardId);
    if (board) return parseHole(board.type, parsed.hole) !== null;
    const comp = doc.components.find((c) => c.id === parsed.boardId);
    if (!comp) return false;
    const def = partDef(comp.ref);
    return Boolean(def?.terminals?.some((t) => t.id === parsed.hole));
  };
  // One lead per point: validEndpoint only proves an endpoint is a REAL hole/
  // terminal, not that it is FREE. Seed the claimed set with the seated parts'
  // pin holes (doc.wires is still empty, so buildOccupancy yields pins only),
  // then claim each wire's ends as they load. A foreign/hand-edited doc with
  // two leads on one hole would otherwise have the loser silently hidden by
  // buildOccupancy's last-writer-wins.
  const claimed = new Set(buildOccupancy(doc).keys());
  const wires = Array.isArray(raw.wires) ? raw.wires : [];
  for (const w of wires) {
    if (!w || typeof w !== "object") continue;
    const m = typeof w.id === "string" ? WIRE_ID_RE.exec(w.id) : null;
    if (!m || wireIds.has(w.id)) continue;
    if (!validEndpoint(w.from) || !validEndpoint(w.to)) continue;
    if (w.from === w.to) continue;
    if (claimed.has(w.from) || claimed.has(w.to)) continue; // point already taken
    wireIds.add(w.id);
    claimed.add(w.from);
    claimed.add(w.to);
    maxWireSeq = Math.max(maxWireSeq, Number(m[1]));
    const wireRecord = {
      id: w.id,
      from: w.from,
      to: w.to,
      color: WIRE_COLORS.includes(w.color) ? w.color : WIRE_COLORS[0],
    };
    applyWireLayout(wireRecord, w.layout, w.points);
    applyMeta(wireRecord, w);
    doc.wires.push(wireRecord);
  }

  // Buses (Feature 130): metadata over wires — `{ id, name, width, color,
  // members: [wireId…] }`. Each member must be a surviving wire; junk names
  // drop the bus. `width` is repaired up so it never undercounts its members
  // (a name change may have shrunk the declared width below what was laid).
  let maxBusSeq = 0;
  const busIds = new Set();
  const buses = Array.isArray(raw.buses) ? raw.buses : [];
  for (const bus of buses) {
    if (!bus || typeof bus !== "object") continue;
    const m = typeof bus.id === "string" ? BUS_ID_RE.exec(bus.id) : null;
    if (!m || busIds.has(bus.id)) continue;
    const parsed = parseBusName(bus.name);
    if (!parsed) continue; // an unparseable name is not a bus
    busIds.add(bus.id);
    maxBusSeq = Math.max(maxBusSeq, Number(m[1]));
    const seen = new Set();
    const members = [];
    for (const wid of Array.isArray(bus.members) ? bus.members : []) {
      if (wireIds.has(wid) && !seen.has(wid)) {
        seen.add(wid);
        members.push(wid);
      }
    }
    doc.buses.push({
      id: bus.id,
      name: bus.name.trim(),
      width: Math.max(parsed.width, members.length, 1),
      color: WIRE_COLORS.includes(bus.color) ? bus.color : WIRE_COLORS[0],
      members,
    });
  }

  // Net names (Feature 120): a binding is `{ address, name }` — the user names
  // a net by pointing at ONE member hole/terminal on it, so the name survives a
  // net-key change. Drop a binding whose address no longer parses; dedupe by
  // address (first wins). Never resolved here — that is the netlist's job.
  const namedAddresses = new Set();
  const netNames = Array.isArray(raw.netNames) ? raw.netNames : [];
  for (const b of netNames) {
    if (!b || typeof b !== "object") continue;
    if (!parseAddress(b.address)) continue;
    if (typeof b.name !== "string" || b.name.trim() === "") continue;
    if (namedAddresses.has(b.address)) continue;
    namedAddresses.add(b.address);
    doc.netNames.push({ address: b.address, name: b.name.trim() });
  }

  // Annotations (Feature 120): pure desk decoration — a `label` (one-line) or a
  // `note` (multi-line), positioned in world pitch units, ignored by occupancy,
  // the netlist, and the engine. `anchor` (a component id) makes it ride that
  // part's moves; `color` is an optional CSS color string.
  let maxAnnSeq = 0;
  const annIds = new Set();
  const annotations = Array.isArray(raw.annotations) ? raw.annotations : [];
  for (const a of annotations) {
    if (!a || typeof a !== "object") continue;
    const m = typeof a.id === "string" ? ANNOTATION_ID_RE.exec(a.id) : null;
    if (!m || annIds.has(a.id)) continue;
    if (!ANNOTATION_KINDS.has(a.kind)) continue;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    annIds.add(a.id);
    maxAnnSeq = Math.max(maxAnnSeq, Number(m[1]));
    const ann = {
      id: a.id,
      kind: a.kind,
      x: a.x,
      y: a.y,
      text: typeof a.text === "string" ? a.text : "",
    };
    if (typeof a.color === "string" && a.color) ann.color = a.color;
    if (typeof a.anchor === "string" && a.anchor) ann.anchor = a.anchor;
    doc.annotations.push(ann);
  }

  // Scope channels (Feature 210): the logic-analyzer's instrument setup — an
  // ordered list of { kind:"net"|"bus", ref } bindings (ref = a member address
  // or a bus id) with an optional label/color. Additive and passive: they touch
  // neither occupancy, the netlist, nor the engine, so a stale ref simply reads
  // as undriven until its target returns.
  let maxScopeSeq = 0;
  const scopeIds = new Set();
  const scopeChannels = Array.isArray(raw.scopeChannels)
    ? raw.scopeChannels
    : [];
  for (const s of scopeChannels) {
    if (!s || typeof s !== "object") continue;
    const m = typeof s.id === "string" ? SCOPE_CHANNEL_ID_RE.exec(s.id) : null;
    if (!m || scopeIds.has(s.id)) continue;
    if (!SCOPE_CHANNEL_KINDS.has(s.kind)) continue;
    if (typeof s.ref !== "string" || !s.ref) continue;
    scopeIds.add(s.id);
    maxScopeSeq = Math.max(maxScopeSeq, Number(m[1]));
    const ch = { id: s.id, kind: s.kind, ref: s.ref };
    if (typeof s.label === "string" && s.label) ch.label = s.label;
    if (typeof s.color === "string" && s.color) ch.color = s.color;
    doc.scopeChannels.push(ch);
  }

  const storedNextBoard =
    Number.isInteger(raw.nextBoardId) && raw.nextBoardId > 0
      ? raw.nextBoardId
      : 1;
  doc.nextBoardId = Math.max(storedNextBoard, maxBoardSeq + 1);
  const storedNextGroup =
    Number.isInteger(raw.nextGroupId) && raw.nextGroupId > 0
      ? raw.nextGroupId
      : 1;
  doc.nextGroupId = Math.max(storedNextGroup, maxGroupSeq + 1);
  const storedNextComp =
    Number.isInteger(raw.nextComponentId) && raw.nextComponentId > 0
      ? raw.nextComponentId
      : 1;
  doc.nextComponentId = Math.max(storedNextComp, maxCompSeq + 1);
  const storedNextPsu =
    Number.isInteger(raw.nextPsuId) && raw.nextPsuId > 0 ? raw.nextPsuId : 1;
  doc.nextPsuId = Math.max(storedNextPsu, maxBrickSeq.psu + 1);
  const storedNextClock =
    Number.isInteger(raw.nextClockId) && raw.nextClockId > 0
      ? raw.nextClockId
      : 1;
  doc.nextClockId = Math.max(storedNextClock, maxBrickSeq.clock + 1);
  const storedNextWire =
    Number.isInteger(raw.nextWireId) && raw.nextWireId > 0 ? raw.nextWireId : 1;
  doc.nextWireId = Math.max(storedNextWire, maxWireSeq + 1);
  const storedNextBus =
    Number.isInteger(raw.nextBusId) && raw.nextBusId > 0 ? raw.nextBusId : 1;
  doc.nextBusId = Math.max(storedNextBus, maxBusSeq + 1);
  const storedNextAnnotation =
    Number.isInteger(raw.nextAnnotationId) && raw.nextAnnotationId > 0
      ? raw.nextAnnotationId
      : 1;
  doc.nextAnnotationId = Math.max(storedNextAnnotation, maxAnnSeq + 1);
  const storedNextScope =
    Number.isInteger(raw.nextScopeChannelId) && raw.nextScopeChannelId > 0
      ? raw.nextScopeChannelId
      : 1;
  doc.nextScopeChannelId = Math.max(storedNextScope, maxScopeSeq + 1);
  return doc;
}

/** Strict rect overlap — boards may touch edge-to-edge but not intersect. */
/**
 * Do two rects INTERSECT — as opposed to merely touching?
 *
 * The distinction is the whole point: strips are MEANT to sit flush (a kit is
 * `rail · pins · rail`, dovetailed edge to edge), so an overlap test that
 * counted a shared edge would refuse every legal breadboard. A bare `<` gets
 * that right only when the arithmetic is exact — and vertical geometry is
 * MEASURED, not lattice (board-types.js), so it is not. A rail at y -9.03 is
 * 3.50 tall and ends at -5.529999999999999; the pin-board flush under it begins
 * at -5.53. Strictly, those overlap. By 8.9×10^-16.
 *
 * That is not a rounding curiosity — it is silent data loss, because
 * `normalizeDocument` DROPS an overlapping board and cascades away every part
 * seated on it and every wire touching it. It struck about one flush joint in
 * six (only the pairs whose sum happens to round the wrong way), and Fit's
 * whole-desk recentre re-rolls the dice on every load, so a different board
 * vanished each time.
 *
 * So the test carries `mating.js`'s own FLUSH_EPS, which exists for exactly
 * this and is imported rather than restated. An "overlap" thinner than 10^-6 of
 * a pitch (2.5 nanometres) is two strips touching; a real one is at least 0.01,
 * the quantum a board coordinate is held to.
 */
function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width - FLUSH_EPS &&
    b.x < a.x + a.width - FLUSH_EPS &&
    a.y < b.y + b.height - FLUSH_EPS &&
    b.y < a.y + a.height - FLUSH_EPS
  );
}

/** Is a desk point inside a rect? INCLUSIVE of every edge — unlike
    rectsOverlap, which has to let two strips sit flush without intersecting,
    this asks which strip a free coordinate is drawn over, and a bend right on
    a board's edge is better carried by it than left behind. */
function pointInRect(p, rect) {
  return (
    p.x >= rect.x &&
    p.x <= rect.x + rect.width &&
    p.y >= rect.y &&
    p.y <= rect.y + rect.height
  );
}

/** The edges a directional break travels along. */
const CHAIN_EDGES = Object.freeze({
  forward: Object.freeze(["below", "right"]),
  backward: Object.freeze(["above", "left"]),
});

/**
 * Partition `boards` into the runs that are still mated to one another —
 * used after a break to find which pieces are left holding together. Pure;
 * considers only the boards passed in, so a split can never absorb an
 * outsider that merely happens to sit flush.
 *
 * @returns {Array<Array<object>>} components, each in the given order.
 */
function matedComponents(boards) {
  const pool = [...boards];
  const components = [];
  while (pool.length > 0) {
    const component = [pool.shift()];
    for (let i = 0; i < component.length; i += 1) {
      for (let j = pool.length - 1; j >= 0; j -= 1) {
        if (matingEdge(component[i], pool[j])) {
          component.push(pool.splice(j, 1)[0]);
        }
      }
    }
    components.push(component);
  }
  return components;
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
   * Update a board's Name/Description — the shared Properties dialog's only
   * fields for a board (a strip has no other editable properties; its
   * geometry/rotation is fixed once placed). Present only when non-empty, same
   * omit-when-empty convention as setComponentMeta/schematicPos. Throws
   * NOT_FOUND. Returns a copy.
   */
  setBoardParams(id, patch) {
    const board = this.#doc.boards.find((b) => b.id === id);
    if (!board) throw taggedError(`no board ${id}`, "NOT_FOUND");
    if (typeof patch.name === "string") {
      if (patch.name) board.name = patch.name;
      else delete board.name;
    }
    if (typeof patch.description === "string") {
      if (patch.description) board.description = patch.description;
      else delete board.description;
    }
    return { ...board };
  }

  /** The desk rectangles of every brick (PSU, clock) from its def size.
      `ignoreIds` lifts a whole moving SET out at once — a pair of bricks
      dragged together each land over the other's old rect, so ignoring one at
      a time would refuse a move that is perfectly legal. */
  #brickRects({ ignoreId = null, ignoreIds = null } = {}) {
    const skip = ignoreIds ?? (ignoreId == null ? null : new Set([ignoreId]));
    return this.#doc.components
      .filter(
        (c) => c.board == null && !skip?.has(c.id) && partDef(c.ref)?.size,
      )
      .map((c) => {
        const { width, height } = partDef(c.ref).size;
        return { x: c.x, y: c.y, width, height };
      });
  }

  /**
   * Would a `type` board fit at (x, y) (after integer snapping) without
   * overlapping any existing board's outline or PSU brick? `ignoreId`
   * excludes a board from the check (moving over its own footprint is fine).
   */
  canPlace(type, x, y, { ignoreId = null, rot = 0 } = {}) {
    const { width, height } = boardSize(type, normalizeRotation(type, rot));
    // x takes the column lattice (as a placement will); y keeps its two
    // decimals, because a kit's own strips arrive on fractional offsets and
    // rounding them here would check a rect the board will never occupy.
    const rect = { x: placeX(x), y: boardCoord(y), width, height };
    return (
      this.#doc.boards.every(
        (b) => b.id === ignoreId || !rectsOverlap(rect, outlineRect(b)),
      ) && this.#brickRects().every((r) => !rectsOverlap(rect, r))
    );
  }

  /**
   * Would a brick (`ref` sizing) fit at (x, y) — after integer snapping —
   * without covering a board or another brick?
   */
  canPlaceBrick(ref, x, y, { ignoreId = null, ignoreIds = null } = {}) {
    const { width, height } = partDef(ref).size;
    const rect = { x: Math.round(x), y: Math.round(y), width, height };
    return (
      this.#doc.boards.every((b) => !rectsOverlap(rect, outlineRect(b))) &&
      this.#brickRects({ ignoreId, ignoreIds }).every(
        (r) => !rectsOverlap(rect, r),
      )
    );
  }

  /**
   * Add a board (coordinates snapped to integers). Throws INVALID_TYPE /
   * INVALID_ARG / OVERLAP. Returns a copy of the new board.
   */
  addBoard(type, x, y, rot = 0) {
    spec(type); // validates — throws INVALID_TYPE
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("board position must be finite", "INVALID_ARG");
    }
    const turn = normalizeRotation(type, rot);
    if (!this.canPlace(type, x, y, { rot: turn })) {
      throw taggedError(
        `a ${type} board at ${placeX(x)},${boardCoord(y)} overlaps an existing board`,
        "OVERLAP",
      );
    }
    const board = {
      id: `bb${this.#doc.nextBoardId++}`,
      type,
      x: placeX(x),
      y: boardCoord(y),
      rot: turn,
      group: null,
    };
    this.#doc.boards.push(board);
    return { ...board };
  }

  // ── Kits & groups ───────────────────────────────────────────────────────

  /**
   * The strips a kit places, resolved to absolute integer positions. Pure —
   * used for the placement ghost as well as for the real add.
   *
   * @returns {Array<{type:string,x:number,y:number}>}
   */
  static kitPlacements(kitKey, x, y, rot = 0, flipRails = false) {
    const kit = BREADBOARD_KITS[kitKey];
    if (!kit) throw taggedError(`unknown kit: ${kitKey}`, "INVALID_TYPE");
    const ox = placeX(x);
    const oy = boardCoord(y);
    // A kit turns only if EVERY strip in it can: in practice the lone-rail
    // kits. An assembled board holds a pin-board, so it stays flat, and the
    // preset offsets are only ever meaningful at 0. An assembled kit's own
    // rail strips may instead be FLIPPED 180° independently of the pin-board
    // — same footprint (boardSize is identical at 0/180), reversed polarity
    // order — which is what `flipRails` asks for. `turn` wins over a flip
    // when both are somehow asked for; in practice a loose-rail "kit" (the
    // only one `turn` ever applies to) never sets `flipRails`.
    const turn = DeskDoc.canRotateKit(kitKey) ? normalizeRotation(kit.strips[0].type, rot) : 0; // prettier-ignore
    return kit.strips.map((s) => ({
      type: s.type,
      x: ox + s.dx,
      y: boardCoord(oy + s.dy),
      rot: turn !== 0 ? turn : flipRails && canRotate(s.type) ? 180 : 0,
    }));
  }

  /** Can this kit be placed on its side? Only one made purely of rails. */
  static canRotateKit(kitKey) {
    const kit = BREADBOARD_KITS[kitKey];
    if (!kit) throw taggedError(`unknown kit: ${kitKey}`, "INVALID_TYPE");
    return kit.strips.every((s) => canRotate(s.type));
  }

  /**
   * Can this kit's own rail strips be flipped 180° independently, leaving
   * the pin-board fixed? True for an assembled kit with at least one rail
   * (Full 830, Half 400) — false for a bare pin-board (Tiny 170, no rails to
   * flip) and false for a loose single-strip kit (rail-full / rail-half),
   * which already owns R for its own whole-kit rotation via `canRotateKit`.
   */
  static canFlipKitRails(kitKey) {
    const kit = BREADBOARD_KITS[kitKey];
    if (!kit) throw taggedError(`unknown kit: ${kitKey}`, "INVALID_TYPE");
    return (
      !DeskDoc.canRotateKit(kitKey) && kit.strips.some((s) => canRotate(s.type))
    );
  }

  /** The bounding box of a kit, for centring the placement ghost. */
  static kitOutline(kitKey, rot = 0) {
    const strips = DeskDoc.kitPlacements(kitKey, 0, 0, rot);
    const sized = strips.map((s) => ({ s, size: boardSize(s.type, s.rot) }));
    // Quantized like a board origin: the height is a sum of measured strips
    // (3.70 + 14.02 + 3.70), which in binary lands a hair under 21.42 — and
    // this outline is compared against, and drawn, as a stated size.
    return {
      width: Math.max(...sized.map(({ s, size }) => s.x + size.width)),
      height: boardCoord(
        Math.max(...sized.map(({ s, size }) => s.y + size.height)),
      ),
    };
  }

  /** Would every strip of a kit fit at (x, y)? All-or-nothing. */
  canPlaceKit(kitKey, x, y, rot = 0, flipRails = false) {
    return DeskDoc.kitPlacements(kitKey, x, y, rot, flipRails).every((s) =>
      this.canPlace(s.type, s.x, s.y, { rot: s.rot }),
    );
  }

  /**
   * Place a whole breadboard: every strip of the kit, seated at its preset
   * offset and joined into one group so they drag as a unit. `flipRails`
   * mirrors the kit's own rail strips 180° in place (positive/negative row
   * order reversed) while the pin-board stays put — a ghost-only choice
   * baked in at drop time, never editable on a placed board. Throws
   * INVALID_TYPE / INVALID_ARG / OVERLAP — nothing is added on failure.
   *
   * @returns {Array<object>} copies of the new strips, in kit order.
   */
  addKit(kitKey, x, y, rot = 0, flipRails = false) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("kit position must be finite", "INVALID_ARG");
    }
    const placements = DeskDoc.kitPlacements(kitKey, x, y, rot, flipRails);
    if (!this.canPlaceKit(kitKey, x, y, rot, flipRails)) {
      throw taggedError(
        `a ${kitKey} breadboard at ${placeX(x)},${boardCoord(y)} overlaps an existing board`,
        "OVERLAP",
      );
    }
    // A lone strip needs no group — grouping starts at two.
    const group = placements.length > 1 ? `g${this.#doc.nextGroupId++}` : null;
    const added = placements.map((p) => ({
      id: `bb${this.#doc.nextBoardId++}`,
      type: p.type,
      x: p.x,
      y: p.y,
      rot: p.rot,
      group,
    }));
    this.#doc.boards.push(...added);
    return added.map((b) => ({ ...b }));
  }

  /**
   * The strips `id` dovetails with: same width and same left edge (the real
   * part only mates with its own size), and edge-to-edge in y with no gap.
   * Pure — the geometric half of the mating rule, with no group side effects.
   *
   * @returns {Array<object>} copies of the mating strips, document order.
   */
  matingStrips(id) {
    const board = this.#doc.boards.find((b) => b.id === id);
    if (!board) return [];
    return this.#doc.boards
      .filter((b) => b.id !== id && matingEdge(board, b) !== null)
      .map((b) => ({ ...b }));
  }

  /**
   * The strips that travel with `id` when a snap is broken directionally:
   * `id` itself plus everything reachable from it through mating edges that
   * point only one way — `forward` (below / right) or `backward` (above /
   * left). Whatever lies the other way is left behind.
   *
   * The walk stays INSIDE `id`'s group, so a strip merely resting flush
   * against the stack — placed there, never snapped — is never dragged along.
   * Throws INVALID_ARG on an unknown direction.
   *
   * @returns {Array<object>} copies of the chain, in document order.
   */
  matedChain(id, direction = "forward") {
    const edges = CHAIN_EDGES[direction];
    if (!edges) {
      throw taggedError(`unknown chain direction: ${direction}`, "INVALID_ARG");
    }
    const pool = this.groupMembers(id);
    if (pool.length === 0) return [];
    const chained = new Set([id]);
    // Breadth-first along one-way edges: reaching a strip does not license
    // travelling back up from it, so a break only ever runs one way.
    const queue = [pool.find((b) => b.id === id)];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const b of pool) {
        if (chained.has(b.id)) continue;
        if (!edges.includes(matingEdge(current, b))) continue;
        chained.add(b.id);
        queue.push(b);
      }
    }
    return pool.filter((b) => chained.has(b.id));
  }

  /**
   * Mate `id` with every strip it dovetails against: the strips — and the
   * whole group each already belongs to — are united under one group id, so
   * the stack drags as a unit. Reuses an existing group when there is one
   * (the oldest, in document order) and mints `g<n>` only for a stack of
   * loose strips. A no-op returning null when `id` touches nothing.
   *
   * @returns {string|null} the resulting group id.
   */
  joinMatedGroup(id) {
    const mates = this.matingStrips(id);
    if (mates.length === 0) return null;
    // The union spans each mate's whole group, so mating with one strip of an
    // assembled board joins the entire board, not just the strip touched.
    const groups = new Set(mates.map((b) => b.group).filter((g) => g != null));
    const ids = new Set([id, ...mates.map((b) => b.id)]);
    const members = this.#doc.boards.filter(
      (b) => ids.has(b.id) || (b.group != null && groups.has(b.group)),
    );
    const group =
      members.find((b) => b.group != null)?.group ??
      `g${this.#doc.nextGroupId++}`;
    for (const b of members) b.group = group;
    return group;
  }

  /**
   * The strips that move with `id`: its whole group, or just itself when it
   * is loose. Always includes `id`; empty when there is no such board.
   */
  groupMembers(id) {
    const board = this.#doc.boards.find((b) => b.id === id);
    if (!board) return [];
    if (board.group == null) return [{ ...board }];
    return this.#doc.boards
      .filter((b) => b.group === board.group)
      .map((b) => ({ ...b }));
  }

  /**
   * Would translating `id`'s group by (dx, dy) — integers — clear every board
   * and brick outside the group?
   */
  canMoveBoardBy(id, dx, dy) {
    return this.canMoveBoardsBy(
      this.groupMembers(id).map((b) => b.id),
      dx,
      dy,
    );
  }

  /**
   * Would translating exactly `ids` by (dx, dy) clear every board and brick
   * that is NOT moving? False when any id is unknown.
   *
   * The delta is NOT rounded to whole pitches here (nor in `moveBoardsBy`,
   * which must land on exactly the position this cleared). A gesture supplies
   * a whole-pitch delta of its own accord — that is what makes a board drag
   * step pitch by pitch — but the magnetic pull is then ADDED to it, and a
   * dovetail is only ever flush at an exact value: against a 3.70-tall rail
   * that value is fractional, and rounding it away here is a snap that lands a
   * hundredth of a pitch short and silently fails to mate.
   */
  canMoveBoardsBy(ids, dx, dy) {
    const moving = new Set(ids);
    const members = this.#doc.boards.filter((b) => moving.has(b.id));
    if (members.length === 0 || members.length !== moving.size) return false;
    const rects = members.map((b) =>
      outlineRect({
        ...b,
        x: boardCoord(b.x + dx),
        y: boardCoord(b.y + dy),
      }),
    );
    const others = this.#doc.boards.filter((b) => !moving.has(b.id));
    return rects.every(
      (rect) =>
        others.every((b) => !rectsOverlap(rect, outlineRect(b))) &&
        this.#brickRects().every((r) => !rectsOverlap(rect, r)),
    );
  }

  /**
   * The magnetic pull on a drag: the EXTRA (dx, dy) — at most SNAP_RANGE on
   * either axis — that would land `ids`, already translated by (dx, dy),
   * flush against a strip outside the set that it can dovetail with.
   * `{dx: 0, dy: 0}` when nothing is in range or a pair is already flush.
   *
   * Pure geometry: it neither moves nor groups anything, and says nothing
   * about legality — the caller applies the pull only if it likes the result.
   */
  snapBoardsBy(ids, dx, dy) {
    const moving = new Set(ids);
    const [members, others] = [
      this.#doc.boards.filter((b) => moving.has(b.id)),
      this.#doc.boards.filter((b) => !moving.has(b.id)),
    ];
    if (members.length === 0) return { dx: 0, dy: 0 };
    return quantizePull(
      snapCorrection(
        members.map(
          (b) =>
          outlineRect({ ...b, x: boardCoord(b.x + dx), y: boardCoord(b.y + dy) }), // prettier-ignore
        ),
        others.map(outlineRect),
      ),
    );
  }

  /** The same magnetic pull, for a kit not yet placed (the ghost). */
  snapKitAt(kitKey, x, y, rot = 0) {
    return quantizePull(
      snapCorrection(
        DeskDoc.kitPlacements(kitKey, x, y, rot).map(outlineRect),
        this.#doc.boards.map(outlineRect),
      ),
    );
  }

  /** The same magnetic pull, for a design clip about to be pasted at `shift`
      (Feature 240) — so a pasted design mates exactly like a placed kit. */
  snapDesignAt(clip, shift) {
    return snapDesign(clip, shift, this.#doc.boards.map(outlineRect));
  }

  /**
   * Translate `id`'s whole group by (dx, dy). Throws NOT_FOUND /
   * INVALID_ARG / OVERLAP. Returns copies of every moved strip.
   */
  moveBoardBy(id, dx, dy) {
    if (!this.#doc.boards.some((b) => b.id === id)) {
      throw taggedError(`no board ${id}`, "NOT_FOUND");
    }
    return this.moveBoardsBy(
      this.groupMembers(id).map((b) => b.id),
      dx,
      dy,
    );
  }

  /**
   * Which routed waypoints a move of `ids` CARRIES: every point lying over one
   * of those strips' footprints, as `Map<wireId, number[]>` — indices into
   * that wire's own `points`, ascending, wires with none omitted.
   *
   * A wire's ENDS are addresses, so they ride their board for free; its
   * waypoints are free desk coordinates and are therefore the one part of a
   * wire a board move has to carry BY HAND (the same reason `translateAll`
   * and `pasteDesign` shift them explicitly). Leave them and dragging a board
   * drags its wiring out of the routing the user drew.
   *
   * The rule is geometric and PER POINT, because position is the only thing a
   * waypoint has to say where it belongs: a bend drawn over a board was drawn
   * around what is ON that board and travels with it, while one out in the
   * free space between two boards belongs to the gap that just changed size
   * and stays where it was put. So a wire may well carry some of its bends and
   * not others. Containment is inclusive — a point exactly on the moving set's
   * edge rides, since carrying it is the lesser surprise.
   *
   * Pure: nothing is mutated, and the answer is about where the points sit
   * NOW, so a caller previewing a drag must read it BEFORE anything moves.
   */
  wirePointsOverBoards(ids) {
    const moving = new Set(ids);
    const rects = this.#doc.boards
      .filter((b) => moving.has(b.id))
      .map(outlineRect);
    const carried = new Map();
    if (rects.length === 0) return carried;
    for (const wire of this.#doc.wires) {
      const indices = [];
      (wire.points ?? []).forEach((p, i) => {
        if (rects.some((r) => pointInRect(p, r))) indices.push(i);
      });
      if (indices.length > 0) carried.set(wire.id, indices);
    }
    return carried;
  }

  /**
   * Translate exactly `ids` by (dx, dy) — the rigid move behind a directional
   * break. When the set is only PART of a group, the snap breaks: both halves
   * are re-grouped from what is still mated within each, so a run that stays
   * whole keeps travelling as a unit and a strip left on its own goes loose.
   * A group id is never reused across a break. Every routed waypoint over the
   * moving strips travels with them (`wirePointsOverBoards`), in the SAME
   * mutation, so a board and the routing drawn over it are one undo step.
   * Throws NOT_FOUND / INVALID_ARG / OVERLAP — nothing moves on failure.
   *
   * @returns {Array<object>} copies of every moved strip, document order.
   */
  moveBoardsBy(ids, dx, dy) {
    const moving = new Set(ids);
    const members = this.#doc.boards.filter((b) => moving.has(b.id));
    if (members.length === 0 || members.length !== moving.size) {
      throw taggedError(`no such board in [${[...moving]}]`, "NOT_FOUND");
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw taggedError("board delta must be finite", "INVALID_ARG");
    }
    if (!this.canMoveBoardsBy(ids, dx, dy)) {
      throw taggedError(`moving [${[...moving]}] overlaps a board`, "OVERLAP");
    }
    // A group that is only partly moving is being torn apart — note it before
    // the translation, and re-derive both halves from geometry afterwards.
    const torn = [
      ...new Set(members.map((b) => b.group).filter((g) => g != null)),
    ].filter((g) =>
      this.#doc.boards.some((b) => b.group === g && !moving.has(b.id)),
    );
    // Which bends ride, read BEFORE the translation — the rule is where each
    // point sits now, not where the strips are about to be.
    const carried = this.wirePointsOverBoards(ids);
    const moved = [];
    for (const b of this.#doc.boards) {
      if (!moving.has(b.id)) continue;
      b.x = boardCoord(b.x + dx);
      b.y = boardCoord(b.y + dy);
      moved.push(b);
    }
    for (const [wireId, indices] of carried) {
      const points = this.#doc.wires.find((w) => w.id === wireId)?.points ?? [];
      for (const i of indices) {
        points[i].x = wireCoord(points[i].x + dx);
        points[i].y = wireCoord(points[i].y + dy);
      }
    }
    for (const group of torn) this.#regroupAfterBreak(group, moving);
    return moved.map((b) => ({ ...b }));
  }

  /**
   * Re-derive `group` after a break: each half is split into the runs still
   * mated within it, and every run of two or more gets a FRESH id (a lone
   * strip goes loose). Fresh on both sides, so the two halves can never come
   * out sharing an id and silently stay one unit.
   */
  #regroupAfterBreak(group, movedIds) {
    const members = this.#doc.boards.filter((b) => b.group === group);
    this.#regroupRuns(members.filter((b) => movedIds.has(b.id)));
    this.#regroupRuns(members.filter((b) => !movedIds.has(b.id)));
  }

  /**
   * Split a set of strips into the runs still mated within it, minting a fresh
   * group id per run of two or more and going loose for a lone strip. The one
   * place a group id is ever (re)assigned after a break.
   */
  #regroupRuns(members) {
    for (const run of matedComponents(members)) {
      const id = run.length > 1 ? `g${this.#doc.nextGroupId++}` : null;
      for (const b of run) b.group = id;
    }
  }

  /**
   * Move a board to an absolute position (coordinates snapped to integers).
   * Throws NOT_FOUND / INVALID_ARG / OVERLAP. Returns a copy of the updated
   * board. Unlike `moveBoardsBy` — which is what the drag gesture commits
   * through — this carries no routed waypoints with it; anything that moves a
   * strip a USER is looking at wants the relative form.
   */
  moveBoard(id, x, y) {
    const board = this.#doc.boards.find((b) => b.id === id);
    if (!board) throw taggedError(`no board ${id}`, "NOT_FOUND");
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("board position must be finite", "INVALID_ARG");
    }
    // The strip keeps its angle, so the overlap check has to use it — an
    // upright rail sweeps a 3×64 box, not a 64×3 one.
    if (!this.canPlace(board.type, x, y, { ignoreId: id, rot: board.rot })) {
      throw taggedError(
        `moving ${id} to ${placeX(x)},${boardCoord(y)} overlaps another board`,
        "OVERLAP",
      );
    }
    const group = board.group;
    board.x = placeX(x);
    board.y = boardCoord(y);
    // Moving one strip of a group can open a gap the group id would still span,
    // dragging the now-disconnected strips as one unit. Tear it out and
    // re-derive both halves from what is still mated (as moveBoardsBy does).
    if (
      group != null &&
      this.#doc.boards.some((b) => b.group === group && b.id !== id)
    ) {
      this.#regroupAfterBreak(group, new Set([id]));
    }
    return { ...board };
  }

  /**
   * Remove a strip AND everything SEATED on it — components anchored to it
   * and every wire with an endpoint on it (the UI confirms first when
   * anything would go with it). Throws NOT_FOUND.
   *
   * A part anchored on a NEIGHBOURING strip whose free lead happens to reach
   * into this one survives untouched, keeping its position: the lead simply
   * stops resolving to a hole and floats. That is why removal keys on
   * `c.board` (where the part is seated) and never on where a lead lands.
   *
   * Pulling a strip out of the middle of a group BREAKS it exactly as tearing
   * one off does — what is left may no longer touch. So the survivors are
   * re-derived from what is still mated among them, or the two halves would go
   * on dragging as one unit across the gap the removal just opened.
   */
  removeBoard(id) {
    const i = this.#doc.boards.findIndex((b) => b.id === id);
    if (i === -1) throw taggedError(`no board ${id}`, "NOT_FOUND");
    const [removed] = this.#doc.boards.splice(i, 1);
    for (const c of this.#doc.components) {
      if (c.board === id) this.#detachAnnotations(c.id);
    }
    this.#doc.components = this.#doc.components.filter((c) => c.board !== id);
    this.#doc.wires = this.#doc.wires.filter((w) => !this.#wireTouches(w, id));
    this.#pruneBusesToWires();
    if (removed.group != null) {
      this.#regroupRuns(
        this.#doc.boards.filter((b) => b.group === removed.group),
      );
    }
  }

  /** Does a wire endpoint belong to this owner (board or PSU)? */
  #wireTouches(wire, ownerId) {
    return (
      parseAddress(wire.from)?.boardId === ownerId ||
      parseAddress(wire.to)?.boardId === ownerId
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
   * May a board part (chip or discrete) seat here? Delegates to occupancy —
   * the single collision authority. `ignoreId` excludes one component's own
   * pins (moves).
   */
  canPlacePart(ref, boardId, anchor, { ignoreId = null, params = null } = {}) {
    return canPlacePart(this.#doc, {
      ref,
      board: boardId,
      anchor,
      params,
      ignoreId,
    });
  }

  /** Back-compat alias (Feature 40 name). */
  canPlaceChip(ref, boardId, anchor, opts) {
    return this.canPlacePart(ref, boardId, anchor, opts);
  }

  /**
   * Seat a board part: pin 1 at `anchor` on `boardId` (chips row e;
   * discretes any grid row). Params are coerced through the def's contract.
   * Throws INVALID_KIND / INVALID_REF / NOT_FOUND / ILLEGAL_PLACEMENT.
   * Returns a copy.
   */
  addComponent({ kind, ref, board: boardId, anchor, params = {} }) {
    if (kind !== "chip" && kind !== "discrete") {
      throw taggedError(`unsupported component kind: ${kind}`, "INVALID_KIND");
    }
    const def = partDef(ref);
    if (!def || def.kind !== kind) {
      throw taggedError(`unknown ${kind} ref: ${ref}`, "INVALID_REF");
    }
    if (!this.#doc.boards.some((b) => b.id === boardId)) {
      throw taggedError(`no board ${boardId}`, "NOT_FOUND");
    }
    // Normalize FIRST so a rotated resistor's pins (which depend on rot/end)
    // are validated against the params that will actually be stored.
    const normalized = normalizeParams(def, params);
    if (!this.canPlacePart(ref, boardId, anchor, { params: normalized })) {
      throw taggedError(
        `a ${ref} cannot seat at ${boardId}.${anchor}`,
        "ILLEGAL_PLACEMENT",
      );
    }
    const component = {
      id: `c${this.#doc.nextComponentId++}`,
      kind,
      ref,
      board: boardId,
      anchor,
      params: normalized,
    };
    this.#doc.components.push(component);
    return { ...component };
  }

  /**
   * Re-seat a board part (same or another board). Throws NOT_FOUND /
   * INVALID_KIND (PSUs move with movePsu) / ILLEGAL_PLACEMENT. Returns a
   * copy of the updated component.
   */
  moveComponent(id, boardId, anchor) {
    const comp = this.#doc.components.find((c) => c.id === id);
    if (!comp) throw taggedError(`no component ${id}`, "NOT_FOUND");
    if (comp.board == null) {
      // A desk-level brick (PSU / clock) is repositioned with moveBrick.
      throw taggedError(`use moveBrick for ${id}`, "INVALID_KIND");
    }
    if (!this.#doc.boards.some((b) => b.id === boardId)) {
      throw taggedError(`no board ${boardId}`, "NOT_FOUND");
    }
    if (
      !this.canPlacePart(comp.ref, boardId, anchor, {
        ignoreId: id,
        params: comp.params,
      })
    ) {
      throw taggedError(
        `${id} cannot seat at ${boardId}.${anchor}`,
        "ILLEGAL_PLACEMENT",
      );
    }
    comp.board = boardId;
    comp.anchor = anchor;
    return { ...comp };
  }

  // ── Re-seating a part WITH its wiring (Feature 290, the Option-drag) ──────

  /**
   * The wires riding part `id` — every wire end sitting in a node one of its
   * pins occupies, as `[{ wireId, ends }]`. Read once at pointerdown and frozen
   * for the gesture; see model/part-move.js for why the set must not be
   * recomputed per pointer sample.
   */
  wiresRidingPart(id) {
    return wiresRidingPart(this.#doc, id);
  }

  /** The two-terminal PARTS riding part `id` — a rotatable part with a LEAD in
      one of its nodes, as `[{ id, pins }]`. Frozen with the wires. */
  partsRidingPart(id) {
    return partsRidingPart(this.#doc, id);
  }

  /**
   * Where `target.riding`/`target.ridingParts` land when part `id` re-seats at
   * `target.board`.`target.anchor`: `{ moves, points, parts, resolved }`. Pure
   * planning — nothing is mutated, and a plan is not a legality verdict: the
   * caller still runs it past a prepared batch check (occupancy) before
   * committing. `target.params` is for the one mover whose FORM changes as it
   * moves (a rotatable part's body drag); see model/part-move.js.
   */
  planPartMove(id, target) {
    return planPartMove(this.#doc, { id, ...target });
  }

  /**
   * Re-seat a part AND carry everything riding it — wires, and the leads of the
   * two-terminal parts attached to it — as ONE mutation, so ⌘Z restores them
   * together, because they were never two edits. Rolls back wholly on any
   * refusal: half a move would cut the connections it left behind.
   *
   * A solo Option-drag IS a one-member cluster, so this is the cluster commit
   * with the dragged part put at the head of the placements — one transaction
   * rule and one legality rule for both gestures rather than two that could
   * drift apart. `plan` is a `planPartMove` result. Throws ILLEGAL_PLACEMENT.
   *
   * @returns {{component:object, wires:Array}} copies of what moved.
   */
  moveComponentWithWires(id, boardId, anchor, plan) {
    const { components, wires } = this.moveClusterWithWires(
      [{ id, board: boardId, anchor }, ...(plan?.parts ?? [])],
      plan,
    );
    return { component: components[0], wires };
  }

  /**
   * Reposition a rotatable two-terminal part (resistor) by BOTH ends at once —
   * the rigid drag/rotate commit. Pin 1 seats in `anchor` on `boardId`; pin 2
   * is `end`, a `{dx, dy}` lead bend measured in pitch units from that hole,
   * so it may reach onto a NEIGHBOURING strip (typically a power rail). Both
   * ends must land in free, real, distinct holes — a deliberate placement
   * never leaves a lead floating.
   * Throws NOT_FOUND / INVALID_REF / ILLEGAL_PLACEMENT. Returns a copy.
   */
  movePartEnds(id, boardId, anchor, end) {
    const comp = this.#doc.components.find((c) => c.id === id);
    if (!comp) throw taggedError(`no component ${id}`, "NOT_FOUND");
    const def = partDef(comp.ref);
    if (!def?.rotatable) {
      throw taggedError(`${comp.ref} is not rotatable`, "INVALID_REF");
    }
    if (!this.#doc.boards.some((b) => b.id === boardId)) {
      throw taggedError(`no board ${boardId}`, "NOT_FOUND");
    }
    const params = normalizeParams(def, { ...comp.params, rot: 90, end });
    if (
      !this.canPlacePart(comp.ref, boardId, anchor, { ignoreId: id, params })
    ) {
      throw taggedError(
        `${id} cannot sit at ${boardId}.${anchor} + (${end?.dx},${end?.dy})`,
        "ILLEGAL_PLACEMENT",
      );
    }
    comp.board = boardId;
    comp.anchor = anchor;
    comp.params = params;
    return { ...comp };
  }

  /**
   * Rotate a placed part in situ. A rotatable two-lead part (resistor) turns
   * 90° around pin 1: pin 1 stays, pin 2's lead swings a quarter lap (tries CW
   * then CCW), stored in its two-free-ends form (`rot: 90`, `end` a `{dx, dy}`
   * bend). A rigid `def.can` part (an oscillator) spins about its own centre —
   * 180° per call for a non-square can (full-can), a plain 90° for a square one
   * (half-can); see the `def?.can` branch below for why.
   * Throws NOT_FOUND / INVALID_REF (not rotatable) / ILLEGAL_PLACEMENT (no free
   * hole at either rotated position). Returns a copy.
   */
  rotateComponent(id) {
    const comp = this.#doc.components.find((c) => c.id === id);
    if (!comp) throw taggedError(`no component ${id}`, "NOT_FOUND");
    const def = partDef(comp.ref);
    // A rigid multi-corner shape (an oscillator can) spins IN PLACE around its
    // own centre — pin 1 (the stored anchor) moves to a new hole each turn,
    // unlike the pivot-on-pin-1 rotate below. Recover the centre from the
    // current anchor + rot, then find the next rot's anchor near that same
    // centre. A non-square can (the full-can, 6×3) already covers both of its
    // distinct footprints in half a lap, so ROTATING AN ALREADY-SEATED ONE
    // jumps straight 180° (0↔180, 90↔270) rather than stopping at the
    // intermediate 90°/270° swapped-footprint orientation; the ghost while
    // PLACING still steps a full quarter-turn (`desk-controller.js`) so every
    // orientation stays reachable when hunting for a fit. A square can (the
    // half-can) keeps the plain quarter-turn either way.
    if (def?.can) {
      const board = this.#doc.boards.find((b) => b.id === comp.board);
      const anchorPos =
        board && holePosition(board.type, comp.anchor, board.rot ?? 0);
      if (!anchorPos) {
        throw taggedError(`${id} has no pins`, "ILLEGAL_PLACEMENT");
      }
      const anchorWorld = {
        x: board.x + anchorPos.x,
        y: board.y + anchorPos.y,
      };
      const curRot = comp.params?.rot ?? 0;
      const step = def.can.width !== def.can.height ? 2 : 1;
      const nextRot =
        ROTATIONS[(ROTATIONS.indexOf(curRot) + step) % ROTATIONS.length];
      const toCenter = rotateOffset(canCornerOffset(def), curRot);
      const center = {
        x: anchorWorld.x - toCenter.dx,
        y: anchorWorld.y - toCenter.dy,
      };
      const toAnchor = rotateOffset(canCornerOffset(def), nextRot);
      const candidate = addressAtWorld(
        this.#doc.boards,
        center.x + toAnchor.dx,
        center.y + toAnchor.dy,
      );
      const parsed = candidate && parseAddress(candidate);
      const params = normalizeParams(def, { ...comp.params, rot: nextRot });
      if (
        !parsed ||
        !this.canPlacePart(comp.ref, parsed.boardId, parsed.hole, {
          ignoreId: id,
          params,
        })
      ) {
        throw taggedError(`${id} cannot rotate here`, "ILLEGAL_PLACEMENT");
      }
      comp.board = parsed.boardId;
      comp.anchor = parsed.hole;
      comp.params = params;
      return { ...comp };
    }
    // A DIP chip turns a half lap in place: its footprint maps onto itself, so
    // the holes (and every occupancy check) are unchanged — only the pin
    // numbering reverses. Nothing can block it. A `reversible` linear discrete
    // (the bussed resistor array) is the same move on one row: evenly spaced
    // holes, so it covers exactly the nine it already covers and only the
    // numbering — hence which end is the common bus — turns round.
    if (def?.package || def?.reversible) {
      comp.params = normalizeParams(def, {
        ...comp.params,
        rot: comp.params?.rot === 180 ? 0 : 180,
      });
      return { ...comp };
    }
    if (!def?.rotatable) {
      throw taggedError(`${comp.ref} is not rotatable`, "INVALID_REF");
    }
    const board = this.#doc.boards.find((b) => b.id === comp.board);
    const pins = board && partPinHoles(comp.ref, comp.anchor, comp.params);
    if (!pins) throw taggedError(`${id} has no pins`, "ILLEGAL_PLACEMENT");
    // The lead vector as it stands, whichever form the part is stored in: a
    // bend is already an offset; a footprint pair is the gap between its holes.
    let vec = pins[1].offset;
    if (!vec) {
      const p1 = holePosition(board.type, pins[0].hole);
      const p2 = holePosition(board.type, pins[1].hole);
      if (!p1 || !p2) {
        throw taggedError(`${id} has no pins`, "ILLEGAL_PLACEMENT");
      }
      vec = { dx: p2.x - p1.x, dy: p2.y - p1.y };
    }
    // Pivot pin 2 around pin 1 by ±90° (keep pin 1 fixed). Hole offsets are
    // integers, so the swung lead stays on the lattice and lands on a hole
    // whenever one is there — including a NEIGHBOURING strip's rail. Negating
    // a zero component yields -0, which would persist into the document and
    // break value comparisons, so fold it back.
    const swing = (n) => (n === 0 ? 0 : n);
    for (const dir of [1, -1]) {
      const end = { dx: swing(-dir * vec.dy), dy: swing(dir * vec.dx) };
      const params = normalizeParams(def, { ...comp.params, rot: 90, end });
      if (
        this.canPlacePart(comp.ref, comp.board, comp.anchor, {
          ignoreId: id,
          params,
        })
      ) {
        comp.params = params;
        return { ...comp };
      }
    }
    throw taggedError(`${id} cannot rotate here`, "ILLEGAL_PLACEMENT");
  }

  /**
   * Update a component's params through the def's contract (switch position,
   * LED color/flip, PSU volts). Throws NOT_FOUND. Returns a copy.
   */
  setComponentParams(id, patch) {
    const comp = this.#doc.components.find((c) => c.id === id);
    if (!comp) throw taggedError(`no component ${id}`, "NOT_FOUND");
    comp.params = normalizeParams(partDef(comp.ref), {
      ...comp.params,
      ...patch,
    });
    return { ...comp };
  }

  /**
   * Update a component's Name/Description — the shared Properties dialog's
   * universal metadata, kept OUTSIDE `params` so it never touches a def's own
   * normalizeParams contract (every part gets it, chips included, unlike
   * catalog-declared params). Present only when non-empty, same omit-when-empty
   * convention as setBoardParams/schematicPos. Throws NOT_FOUND. Returns a copy.
   */
  setComponentMeta(id, patch) {
    const comp = this.#doc.components.find((c) => c.id === id);
    if (!comp) throw taggedError(`no component ${id}`, "NOT_FOUND");
    if (typeof patch.name === "string") {
      if (patch.name) comp.name = patch.name;
      else delete comp.name;
    }
    if (typeof patch.description === "string") {
      if (patch.description) comp.description = patch.description;
      else delete comp.description;
    }
    return { ...comp };
  }

  /**
   * Set (or, with a non-finite coordinate, clear) a component's schematic-view
   * position nudge (Feature 150). A pure layout hint — the desk placement is
   * untouched — so a re-layout honours the user's arrangement. Throws
   * NOT_FOUND. Returns a copy of the component.
   */
  setSchematicPos(id, x, y) {
    const comp = this.#doc.components.find((c) => c.id === id);
    if (!comp) throw taggedError(`no component ${id}`, "NOT_FOUND");
    const pos = normalizeSchematicPos({ x, y });
    if (pos) comp.schematicPos = pos;
    else delete comp.schematicPos;
    return { ...comp };
  }

  /** Clear every schematic-view position nudge (a full auto-layout reset). */
  clearSchematicPositions() {
    let cleared = 0;
    for (const comp of this.#doc.components) {
      if (comp.schematicPos) {
        delete comp.schematicPos;
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Remove a component. A PSU takes its attached wires with it (terminals
   * would dangle otherwise). Throws NOT_FOUND.
   */
  removeComponent(id) {
    const i = this.#doc.components.findIndex((c) => c.id === id);
    if (i === -1) throw taggedError(`no component ${id}`, "NOT_FOUND");
    const [removed] = this.#doc.components.splice(i, 1);
    this.#detachAnnotations(id); // an anchored label falls free, keeping its spot
    if (removed.board == null) {
      // A desk-level brick (PSU, clock) takes its attached wires with it.
      this.#doc.wires = this.#doc.wires.filter(
        (w) => !this.#wireTouches(w, id),
      );
      this.#pruneBusesToWires();
    }
  }

  // ── Desk-level bricks: PSU + clock (Feature 60 / 100) ─────────────────────

  /**
   * Drop a brick (`kind` ∈ psu | clock) on the desk, snapped to the lattice.
   * Throws INVALID_KIND / INVALID_ARG / OVERLAP. Returns a copy.
   */
  addBrick(kind, x, y, params = {}) {
    const brick = BRICKS[kind];
    if (!brick)
      throw taggedError(`unsupported brick kind: ${kind}`, "INVALID_KIND");
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("brick position must be finite", "INVALID_ARG");
    }
    if (!this.canPlaceBrick(kind, x, y)) {
      throw taggedError(
        `a ${kind} at ${Math.round(x)},${Math.round(y)} covers a board or brick`,
        "OVERLAP",
      );
    }
    const component = {
      id: `${brick.prefix}${this.#doc[brick.counter]++}`,
      kind,
      ref: kind,
      x: Math.round(x),
      y: Math.round(y),
      params: normalizeParams(partDef(kind), params),
    };
    this.#doc.components.push(component);
    return { ...component };
  }

  /** Drop a PSU brick (kind "psu"). */
  addPsu(x, y, params = {}) {
    return this.addBrick("psu", x, y, params);
  }

  /** Move a desk-level brick. Throws NOT_FOUND / INVALID_ARG / OVERLAP. */
  moveBrick(id, x, y) {
    const brick = this.#doc.components.find(
      (c) => c.id === id && c.board == null && BRICKS[c.kind],
    );
    if (!brick) throw taggedError(`no brick ${id}`, "NOT_FOUND");
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("brick position must be finite", "INVALID_ARG");
    }
    if (!this.canPlaceBrick(brick.kind, x, y, { ignoreId: id })) {
      throw taggedError(
        `moving ${id} to ${Math.round(x)},${Math.round(y)} covers something`,
        "OVERLAP",
      );
    }
    brick.x = Math.round(x);
    brick.y = Math.round(y);
    return { ...brick };
  }

  /** Move a PSU brick (back-compat name). */
  movePsu(id, x, y) {
    return this.moveBrick(id, x, y);
  }

  // ── Wires (Feature 50) ───────────────────────────────────────────────────

  /** Copies of the wires on the desk. */
  get wires() {
    return this.#doc.wires.map(copyWire);
  }

  /** A copy of one wire, or null. */
  getWire(id) {
    const w = this.#doc.wires.find((x) => x.id === id);
    return w ? copyWire(w) : null;
  }

  /** Copies of the wires with an endpoint on one owner (board or PSU). */
  wiresTouching(ownerId) {
    return this.#doc.wires
      .filter((w) => this.#wireTouches(w, ownerId))
      .map(copyWire);
  }

  /** Back-compat alias (Feature 50 name). */
  wiresOnBoard(boardId) {
    return this.wiresTouching(boardId);
  }

  /** Is `address` a real, unoccupied hole? (occupancy delegation) */
  isHoleFree(address) {
    return isFreeHole(this.#doc, address);
  }

  /** May a wire connect these holes? (occupancy delegation) */
  canPlaceWire(from, to) {
    return canPlaceWire(this.#doc, from, to);
  }

  /** May wire `id`'s `end` move to `address`? (occupancy delegation) */
  canReendWire(id, end, address) {
    return canReendWire(this.#doc, id, end, address);
  }

  /** May wire `id` move rigidly to connect `from` → `to`? (occupancy) */
  canMoveWire(id, from, to) {
    return canMoveWire(this.#doc, id, from, to);
  }

  /**
   * Connect two free holes. `layout` is the wire's drawing method (see
   * WIRE_LAYOUTS — "direct" unless the app-wide default says otherwise), and
   * `points` its waypoints, which only a routed wire keeps (a paste carries
   * a design's existing routing across). Throws INVALID_ARG (bad color or
   * layout) / ILLEGAL_PLACEMENT (either end unreal, occupied, or from === to).
   * Returns a copy of the new wire.
   */
  addWire({
    from,
    to,
    color = WIRE_COLORS[0],
    layout = "direct",
    points = [],
  }) {
    if (!WIRE_COLORS.includes(color)) {
      throw taggedError(`unknown wire color: ${color}`, "INVALID_ARG");
    }
    if (!WIRE_LAYOUTS.includes(layout)) {
      throw taggedError(`unknown wire layout: ${layout}`, "INVALID_ARG");
    }
    if (!canPlaceWire(this.#doc, from, to)) {
      throw taggedError(
        `a wire cannot connect ${from} → ${to}`,
        "ILLEGAL_PLACEMENT",
      );
    }
    const wire = { id: `w${this.#doc.nextWireId++}`, from, to, color };
    applyWireLayout(wire, layout, points);
    this.#doc.wires.push(wire);
    return copyWire(wire);
  }

  /**
   * Re-address ONE end of a wire (drag-an-endpoint). `end` is "from" | "to".
   * Throws NOT_FOUND (no such wire) / INVALID_ARG (bad end) / ILLEGAL_PLACEMENT
   * (target unreal, occupied, or the wire's other end). Returns the updated wire.
   */
  setWireEndpoint(id, end, address) {
    const wire = this.#doc.wires.find((w) => w.id === id);
    if (!wire) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    if (end !== "from" && end !== "to") {
      throw taggedError(`bad wire end: ${end}`, "INVALID_ARG");
    }
    if (!canReendWire(this.#doc, id, end, address)) {
      throw taggedError(
        `wire ${id} cannot re-end at ${address}`,
        "ILLEGAL_PLACEMENT",
      );
    }
    wire[end] = address;
    return copyWire(wire);
  }

  /**
   * Move BOTH ends of a wire at once (the drag-the-whole-wire gesture, which
   * translates it rigidly). Throws NOT_FOUND (no such wire) / ILLEGAL_PLACEMENT
   * (either target unreal, occupied, or the two coincide). Returns the wire.
   */
  moveWire(id, from, to) {
    const wire = this.#doc.wires.find((w) => w.id === id);
    if (!wire) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    if (!canMoveWire(this.#doc, id, from, to)) {
      throw taggedError(
        `wire ${id} cannot move to ${from} → ${to}`,
        "ILLEGAL_PLACEMENT",
      );
    }
    wire.from = from;
    wire.to = to;
    return copyWire(wire);
  }

  /**
   * Would every move in `moves` (each `{ id, from, to }`) land legally when
   * the whole batch is applied AT ONCE — the rigid whole-bus drag? Legality is
   * judged against a doc with EVERY moving wire lifted out, so members may
   * shuffle among the holes they collectively vacate (a bus shifted by its own
   * pitch), and every target must be a real point, free of any non-moving
   * lead, and claimed by exactly one move.
   *
   * A bus end-handle drag calls this once PER CANDIDATE OFFSET of its
   * snap search (up to thousands of times per drop on a wide bus) — so
   * unlike a single wire's own `isFreeHole` check, this builds the reduced
   * doc's occupancy map ONCE up front and reuses it for every address,
   * instead of `isFreeHole` silently rebuilding the whole map from scratch
   * per address (an O(members) multiplier on top of an already-expensive
   * per-candidate cost that measurably mattered at bus width).
   *
   * A drag probing the SAME wire ids over and over should hoist that map out
   * of its search loop entirely — see `prepareWireBatchMove`, which this is
   * a one-shot wrapper around.
   */
  canMoveWiresBatch(moves) {
    return this.prepareWireBatchMove(moves.map((m) => m.id))(moves);
  }

  /**
   * `canMoveWiresBatch` with the expensive half hoisted out: the reduced doc
   * (every one of `wireIds` lifted out) and its occupancy map are built ONCE
   * here, and the returned `(moves) => boolean` reuses them for every
   * candidate batch over those same ids.
   *
   * This is what a live drag wants. `canMoveWiresBatch` rebuilds the whole
   * document's occupancy — deriving every chip's pin addresses — on each
   * call, and a bus drag's snap search calls it up to 25 times per
   * `pointermove` (`SNAP_RADIUS`'s rings) or thousands of times for an
   * end-handle's unbounded release search. Prepared once per GESTURE that
   * collapses to one build, which is what let the live preview keep up with
   * the cursor on a wide bus.
   *
   * Valid only while the document is unchanged — a gesture holds one of
   * these for its own duration and drops it at the drop, and the commit
   * itself still re-validates through `moveWiresBatch`.
   *
   * @param {string[]} wireIds - the wires the batches will move
   * @returns {(moves: {id:string, from:string, to:string}[]) => boolean}
   */
  prepareWireBatchMove(wireIds) {
    const ids = new Set(wireIds);
    const known = new Set(this.#doc.wires.map((w) => w.id));
    // A wire named twice, or one that isn't in the document, can never make a
    // legal batch — resolve that up front rather than per candidate.
    const usable =
      ids.size === wireIds.length && wireIds.every((id) => known.has(id));
    if (!usable) return () => false;
    // The doc as if the movers were gone — the holes they leave read free.
    const reduced = {
      boards: this.#doc.boards,
      components: this.#doc.components,
      wires: this.#doc.wires.filter((w) => !ids.has(w.id)),
    };
    const occupied = buildOccupancy(reduced);
    return (moves) => {
      if (moves.length !== wireIds.length) return false;
      const moved = new Set();
      const claimed = new Set();
      for (const { id, from, to } of moves) {
        if (!ids.has(id) || moved.has(id)) return false; // a wire moved twice
        moved.add(id);
        if (from === to) return false;
        for (const address of [from, to]) {
          if (claimed.has(address)) return false; // two leads into one hole
          if (!isRealPoint(reduced, address) || occupied.has(address)) {
            return false;
          }
          claimed.add(address);
        }
      }
      return true;
    };
  }

  /**
   * Apply a batch of wire moves atomically (the whole-bus drag commit). Throws
   * ILLEGAL_PLACEMENT if the batch isn't collectively legal — nothing moves on
   * failure. Returns copies of the moved wires.
   */
  moveWiresBatch(moves) {
    if (!this.canMoveWiresBatch(moves)) {
      throw taggedError("wire batch move is illegal", "ILLEGAL_PLACEMENT");
    }
    const byId = new Map(this.#doc.wires.map((w) => [w.id, w]));
    const moved = [];
    for (const { id, from, to } of moves) {
      const wire = byId.get(id);
      wire.from = from;
      wire.to = to;
      moved.push({ ...wire });
    }
    return moved;
  }

  // ── Moving a whole SELECTION at once (the cluster drag) ──────────────────

  /**
   * The whole legality story for a cluster move, hoisted ONCE per gesture — the
   * sibling of `prepareWireBatchMove` above, and prepared for the same reason:
   * a live drag asks it per pointer sample, and `canPlacePart` rebuilds the
   * document's entire occupancy index on every call, which for N members would
   * be N rebuilds a frame.
   *
   * TWO DOCUMENTS, DELIBERATELY. Occupancy comes from the doc as if every
   * mover — components AND wires — were gone, because a member landing in a
   * hole one of its travelling companions is vacating is the ordinary case, not
   * a collision (this is exactly why `prepareWireBatchMove`, which lifts out
   * only the wires, cannot be reused here). But REALNESS is asked of the full
   * component list: a riding wire's far end may sit on a moving brick's
   * terminal (`psu1.+`), and a PSU does not stop existing because it is in the
   * air.
   *
   * ONE CLAIM SET DECIDES EVERYTHING ELSE. Every landing address — each moving
   * pin, both ends of each wire move — is claimed once and may be claimed once.
   * That is what catches a mover wanting a hole another mover wants, and a pin
   * landing on a rider that is STAYING PUT (which happens whenever a part slides
   * along its own column-half: its pins move a row, its riders don't move at
   * all). Note the riders' addresses are lifted out of `occupied`, so nothing
   * else would notice.
   *
   * Valid only while the document is unchanged — a gesture holds one for its own
   * duration, and `moveClusterWithWires` prepares a fresh one to commit through.
   *
   * @param {{componentIds?: string[], wireIds?: string[]}} movers
   * @returns {(placements: Array, wireMoves?: Array) => boolean}
   *   placement: brick → `{id, x, y}`; board part → `{id, board, anchor}`
   */
  prepareClusterMove({ componentIds = [], wireIds = [] } = {}) {
    const compIds = new Set(componentIds);
    const movingWires = new Set(wireIds);
    const byId = new Map(this.#doc.components.map((c) => [c.id, c]));
    const knownWires = new Set(this.#doc.wires.map((w) => w.id));
    // A mover named twice, or one that isn't in the document, can never make a
    // legal batch — resolve that up front rather than per candidate.
    const usable =
      compIds.size === componentIds.length &&
      movingWires.size === wireIds.length &&
      componentIds.every((id) => byId.has(id)) &&
      wireIds.every((id) => knownWires.has(id));
    if (!usable) return () => false;

    const reduced = {
      boards: this.#doc.boards,
      components: this.#doc.components.filter((c) => !compIds.has(c.id)),
      wires: this.#doc.wires.filter((w) => !movingWires.has(w.id)),
    };
    const occupied = buildOccupancy(reduced);
    const real = { boards: this.#doc.boards, components: this.#doc.components };
    const movingBricks = new Set(
      [...compIds].filter((id) => byId.get(id).board == null),
    );

    return (placements, wireMoves = []) => {
      if (placements.length !== componentIds.length) return false;
      if (wireMoves.length !== wireIds.length) return false;
      const seen = new Set();
      const claimed = new Set();
      const bricks = []; // the rects the moving bricks are claiming
      for (const p of placements) {
        if (!compIds.has(p.id) || seen.has(p.id)) return false;
        seen.add(p.id);
        const comp = byId.get(p.id);
        if (comp.board == null) {
          // A brick claims desk AREA, not holes — the one thing the claim set
          // can't express, so its movers check each other by rect.
          const { width, height } = partDef(comp.ref).size;
          const rect = {
            x: Math.round(p.x),
            y: Math.round(p.y),
            width,
            height,
          };
          if (bricks.some((r) => rectsOverlap(rect, r))) return false;
          if (
            !this.canPlaceBrick(comp.ref, p.x, p.y, { ignoreIds: movingBricks })
          ) {
            return false;
          }
          bricks.push(rect);
          continue;
        }
        if (p.board == null || p.anchor == null) return false;
        // A placement may bring its own PARAMS: a two-terminal part riding by
        // one leg bends, which is a change of form (and of the holes it lands
        // on), so the check has to judge the part as it will BE, not as it is.
        const seat = {
          ref: comp.ref,
          board: p.board,
          anchor: p.anchor,
          params: p.params ?? comp.params,
        };
        if (!canPlacePart(reduced, { ...seat, occupancy: occupied })) {
          return false;
        }
        const pins = partPinAddresses(reduced, seat);
        if (!pins) return false;
        for (const { address } of pins) {
          if (address == null || claimed.has(address)) return false;
          claimed.add(address);
        }
      }
      const moved = new Set();
      for (const { id, from, to } of wireMoves) {
        if (!movingWires.has(id) || moved.has(id)) return false;
        moved.add(id);
        if (from === to) return false;
        for (const address of [from, to]) {
          if (claimed.has(address)) return false; // two leads into one hole
          if (!isRealPoint(real, address) || occupied.has(address))
            return false;
          claimed.add(address);
        }
      }
      return true;
    };
  }

  /**
   * Move a whole selection AND everything riding it — wires, and the leads of
   * the two-terminal parts attached to it — as ONE mutation, so ⌘Z restores the
   * group and its wiring together, because they were never several edits.
   *
   * It validates the WHOLE batch through `prepareClusterMove` and only then
   * writes, rather than replaying `moveComponent` / `moveBrick` /
   * `moveWiresBatch` member by member: each of those re-checks against the LIVE
   * document, so the first member to move lands on top of a sibling that hasn't
   * moved yet, and `moveWiresBatch`'s wires-only reduction would refuse a rider
   * heading for a hole a part is vacating. The snapshot still wraps the writes,
   * so a mutation added to this loop later can't leave half a move behind.
   *
   * Throws ILLEGAL_PLACEMENT (the batch isn't collectively legal — nothing
   * moves). Returns copies of what moved.
   *
   * @param {Array} placements - brick `{id, x, y}` / board part
   *   `{id, board, anchor, params?}` (params only when the part's FORM changes)
   * @param {{moves?:Array, points?:Array}} [plan] - from planClusterRiders
   * @returns {{components: Array, wires: Array}}
   */
  moveClusterWithWires(placements, plan = null) {
    const wireMoves = plan?.moves ?? [];
    const check = this.prepareClusterMove({
      componentIds: placements.map((p) => p.id),
      wireIds: wireMoves.map((m) => m.id),
    });
    if (!check(placements, wireMoves)) {
      throw taggedError("cluster move is illegal", "ILLEGAL_PLACEMENT");
    }
    const before = this.snapshot();
    try {
      const byId = new Map(this.#doc.components.map((c) => [c.id, c]));
      const components = placements.map((p) => {
        const comp = byId.get(p.id);
        if (comp.board == null) {
          comp.x = Math.round(p.x);
          comp.y = Math.round(p.y);
        } else {
          // Board and anchor, and PARAMS only when the placement brings them.
          // A rotatable member otherwise keeps whichever form it is stored in —
          // its bend is measured FROM the anchor, so a rigid translation needs
          // no rewrite (a SOLO body drag converts a rot-0 part to the
          // two-free-ends form; a group drag deliberately doesn't). A part
          // riding by ONE leg is the case that does bring them: it BENDS, and
          // only that form can say so.
          comp.board = p.board;
          comp.anchor = p.anchor;
          if (p.params) comp.params = normalizeParams(partDef(comp.ref), p.params); // prettier-ignore
        }
        return { ...comp };
      });
      const wireById = new Map(this.#doc.wires.map((w) => [w.id, w]));
      const wires = wireMoves.map(({ id, from, to }) => {
        const wire = wireById.get(id);
        wire.from = from;
        wire.to = to;
        return copyWire(wire);
      });
      for (const { id, dx, dy } of plan?.points ?? []) {
        for (const p of wireById.get(id)?.points ?? []) {
          p.x = wireCoord(p.x + dx);
          p.y = wireCoord(p.y + dy);
        }
      }
      return { components, wires };
    } catch (err) {
      this.restore(before); // a refused move changes nothing at all
      throw err;
    }
  }

  /**
   * The selection as draggable members, in document order — or null when any id
   * fails to resolve, which is the press declining to start a drag at all.
   */
  clusterMembers(ids) {
    return clusterMembers(this.#doc, ids);
  }

  /** Where every member lands under one rigid world delta. */
  resolveClusterTargets(members, delta) {
    return resolveClusterTargets(this.#doc.boards, members, delta);
  }

  /**
   * The wires riding a whole selection, each end attributed to the member it
   * rides. Read once at pointerdown and frozen for the gesture; see
   * model/cluster-move.js.
   */
  wiresRidingCluster(ids) {
    return wiresRidingCluster(this.#doc, ids);
  }

  /** The two-terminal PARTS riding a whole selection, each riding lead
      attributed to the member it follows. Frozen with the wires. */
  partsRidingCluster(ids) {
    return partsRidingCluster(this.#doc, ids);
  }

  /**
   * Where those riders land — `{ moves, points, parts, resolved }`. Pure
   * planning: a plan is not a legality verdict, and the caller still runs it
   * past a `prepareClusterMove` predicate before committing.
   */
  planClusterRiders(members, targets, riding, ridingParts) {
    return planClusterRiders(this.#doc, {
      members,
      targets,
      riding,
      ridingParts,
    });
  }

  /** Change a wire's color. Throws NOT_FOUND / INVALID_ARG. */
  recolorWire(id, color) {
    const wire = this.#doc.wires.find((w) => w.id === id);
    if (!wire) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    if (!WIRE_COLORS.includes(color)) {
      throw taggedError(`unknown wire color: ${color}`, "INVALID_ARG");
    }
    wire.color = color;
    return copyWire(wire);
  }

  /**
   * Update a wire's Name/Description — the shared Properties dialog's
   * universal metadata, kept separate from `recolorWire` (its one catalog-
   * style field, Color). Present only when non-empty, same omit-when-empty
   * convention as setBoardParams/setComponentMeta. Throws NOT_FOUND. Returns
   * a copy.
   */
  setWireMeta(id, patch) {
    const wire = this.#doc.wires.find((w) => w.id === id);
    if (!wire) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    if (typeof patch.name === "string") {
      if (patch.name) wire.name = patch.name;
      else delete wire.name;
    }
    if (typeof patch.description === "string") {
      if (patch.description) wire.description = patch.description;
      else delete wire.description;
    }
    return copyWire(wire);
  }

  /**
   * Set a wire's layout method (see WIRE_LAYOUTS). Going back to "direct"
   * DROPS every waypoint: a direct wire is the curve between its two holes and
   * has nowhere to keep a bend, so keeping them would leave invisible state
   * that reappeared on a later switch. Throws NOT_FOUND / INVALID_ARG.
   * Returns a copy.
   */
  setWireLayout(id, layout) {
    const wire = this.#doc.wires.find((w) => w.id === id);
    if (!wire) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    if (!WIRE_LAYOUTS.includes(layout)) {
      throw taggedError(`unknown wire layout: ${layout}`, "INVALID_ARG");
    }
    if (layout === "routed") {
      wire.layout = "routed";
    } else {
      delete wire.layout;
      delete wire.points;
    }
    return copyWire(wire);
  }

  /** The routed wire `id`, or a thrown NOT_FOUND / INVALID_ARG — the one place
      "a waypoint only exists on a routed wire" is enforced. */
  #routedWire(id) {
    const wire = this.#doc.wires.find((w) => w.id === id);
    if (!wire) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    if (wire.layout !== "routed") {
      throw taggedError(`wire ${id} is not routed`, "INVALID_ARG");
    }
    wire.points ??= [];
    return wire;
  }

  /**
   * Bend a routed wire: insert a waypoint at `index` (0 … points.length, the
   * index of the SEGMENT the user grabbed). Throws NOT_FOUND / INVALID_ARG
   * (not routed, bad index, unreal point) / ILLEGAL_PLACEMENT at
   * MAX_WIRE_POINTS. Returns a copy of the wire.
   */
  addWirePoint(id, index, point) {
    const wire = this.#routedWire(id);
    if (!Number.isInteger(index) || index < 0 || index > wire.points.length) {
      throw taggedError(`bad waypoint index: ${index}`, "INVALID_ARG");
    }
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      throw taggedError("a waypoint needs finite coordinates", "INVALID_ARG");
    }
    if (wire.points.length >= MAX_WIRE_POINTS) {
      throw taggedError(
        `wire ${id} already has ${MAX_WIRE_POINTS} waypoints`,
        "ILLEGAL_PLACEMENT",
      );
    }
    wire.points.splice(index, 0, { x: wireCoord(point.x), y: wireCoord(point.y) }); // prettier-ignore
    return copyWire(wire);
  }

  /** Move one existing waypoint. Throws NOT_FOUND / INVALID_ARG. Returns a
      copy of the wire. */
  moveWirePoint(id, index, point) {
    const wire = this.#routedWire(id);
    if (!Number.isInteger(index) || index < 0 || index >= wire.points.length) {
      throw taggedError(`bad waypoint index: ${index}`, "INVALID_ARG");
    }
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      throw taggedError("a waypoint needs finite coordinates", "INVALID_ARG");
    }
    wire.points[index] = { x: wireCoord(point.x), y: wireCoord(point.y) };
    return copyWire(wire);
  }

  /** Drop one waypoint (it was dragged onto a neighbour, or onto an end).
      Throws NOT_FOUND / INVALID_ARG. Returns a copy of the wire. */
  removeWirePoint(id, index) {
    const wire = this.#routedWire(id);
    if (!Number.isInteger(index) || index < 0 || index >= wire.points.length) {
      throw taggedError(`bad waypoint index: ${index}`, "INVALID_ARG");
    }
    wire.points.splice(index, 1);
    if (wire.points.length === 0) delete wire.points; // omit-when-empty
    return copyWire(wire);
  }

  /** Remove a wire. A bus that included it simply shrinks. Throws NOT_FOUND. */
  removeWire(id) {
    const i = this.#doc.wires.findIndex((w) => w.id === id);
    if (i === -1) throw taggedError(`no wire ${id}`, "NOT_FOUND");
    this.#doc.wires.splice(i, 1);
    this.#pruneBusesToWires();
  }

  // ── Buses (Feature 130) ──────────────────────────────────────────────────
  // A bus is METADATA over wires: `{ id, name, width, color, members }`, where
  // each member is an ordinary wire that already lives in `doc.wires`. The
  // netlist, occupancy, and the engine never learn buses exist — they still see
  // N plain wires. This is the Feature 110 "strips stay in doc.boards" move
  // applied to wires. `width` comes from the name grammar (parseBusName).

  /** Copies of the buses on the desk (member lists copied too). */
  get buses() {
    return this.#doc.buses.map((b) => ({ ...b, members: [...b.members] }));
  }

  /** A copy of one bus, or null. */
  getBus(id) {
    const b = this.#doc.buses.find((x) => x.id === id);
    return b ? { ...b, members: [...b.members] } : null;
  }

  /** The bus a wire belongs to, or null. */
  busOfWire(wireId) {
    const b = this.#doc.buses.find((x) => x.members.includes(wireId));
    return b ? { ...b, members: [...b.members] } : null;
  }

  /**
   * Bundle existing wires into a bus. `name` sets the width/bit-order via the
   * grammar (`D[7:0]`); `memberIds` are wire ids in bit order (only surviving,
   * de-duplicated ones are kept). Throws INVALID_ARG (unparseable name / bad
   * color). Returns a copy of the new bus.
   */
  addBus(name, memberIds = [], { color = WIRE_COLORS[0] } = {}) {
    const parsed = parseBusName(name);
    if (!parsed) {
      throw taggedError(`bad bus name: ${name}`, "INVALID_ARG");
    }
    if (!WIRE_COLORS.includes(color)) {
      throw taggedError(`unknown bus color: ${color}`, "INVALID_ARG");
    }
    const seen = new Set();
    const members = [];
    for (const wid of memberIds) {
      if (this.#doc.wires.some((w) => w.id === wid) && !seen.has(wid)) {
        seen.add(wid);
        members.push(wid);
      }
    }
    const bus = {
      id: `bus${this.#doc.nextBusId++}`,
      name: name.trim(),
      width: Math.max(parsed.width, members.length, 1),
      color,
      members,
    };
    this.#doc.buses.push(bus);
    return { ...bus, members: [...bus.members] };
  }

  /**
   * Patch a bus's `name` (re-derives width), `color`, or `members`. Throws
   * NOT_FOUND / INVALID_ARG. Returns a copy.
   */
  updateBus(id, patch = {}) {
    const bus = this.#doc.buses.find((b) => b.id === id);
    if (!bus) throw taggedError(`no bus ${id}`, "NOT_FOUND");
    let declaredWidth = null;
    if ("name" in patch) {
      const parsed = parseBusName(patch.name);
      if (!parsed) throw taggedError(`bad bus name: ${patch.name}`, "INVALID_ARG"); // prettier-ignore
      bus.name = patch.name.trim();
      declaredWidth = parsed.width;
    }
    if ("color" in patch) {
      if (!WIRE_COLORS.includes(patch.color)) {
        throw taggedError(`unknown bus color: ${patch.color}`, "INVALID_ARG");
      }
      bus.color = patch.color;
    }
    if ("members" in patch) {
      const seen = new Set();
      const members = [];
      for (const wid of patch.members ?? []) {
        if (this.#doc.wires.some((w) => w.id === wid) && !seen.has(wid)) {
          seen.add(wid);
          members.push(wid);
        }
      }
      bus.members = members;
    }
    // Width always reflects the FINAL name + FINAL members TOGETHER — never a
    // stale mix of one patched field's new value with the other's pre-patch
    // one (patching both in a single call used to do exactly that).
    if ("name" in patch || "members" in patch) {
      if (declaredWidth == null) declaredWidth = parseBusName(bus.name).width;
      bus.width = Math.max(declaredWidth, bus.members.length, 1);
    }
    return { ...bus, members: [...bus.members] };
  }

  /**
   * Remove a bus. With `cascadeWires`, its member wires go too (delete);
   * otherwise the wires stay and simply un-bundle. Throws NOT_FOUND.
   */
  removeBus(id, { cascadeWires = false } = {}) {
    const i = this.#doc.buses.findIndex((b) => b.id === id);
    if (i === -1) throw taggedError(`no bus ${id}`, "NOT_FOUND");
    const [removed] = this.#doc.buses.splice(i, 1);
    if (cascadeWires) {
      const drop = new Set(removed.members);
      this.#doc.wires = this.#doc.wires.filter((w) => !drop.has(w.id));
      this.#pruneBusesToWires(); // a shared wire (there shouldn't be) stays sane
    }
  }

  /** Drop from every bus any member wire that no longer exists. */
  #pruneBusesToWires() {
    const live = new Set(this.#doc.wires.map((w) => w.id));
    for (const bus of this.#doc.buses) {
      bus.members = bus.members.filter((wid) => live.has(wid));
    }
  }

  // ── Net names (Feature 120) ──────────────────────────────────────────────
  // A NAME binds to a member ADDRESS, never the derived net key — the netlist
  // resolves each binding to its current net on every rebuild, so the name
  // survives edits that renumber the key. Metadata only: the engine, netlist
  // partitioning, and occupancy stay unaware of names.

  /** Copies of the net-name bindings on the desk. */
  get netNames() {
    return this.#doc.netNames.map((n) => ({ ...n }));
  }

  /** The name bound to an address, or null. */
  netNameAt(address) {
    return this.#doc.netNames.find((n) => n.address === address)?.name ?? null;
  }

  /**
   * Bind a name to the net that `address` sits on (upsert by address). The
   * address must parse and the name be a non-empty string. Throws INVALID_ARG.
   * Returns a copy of the binding.
   */
  nameNet(address, name) {
    if (!parseAddress(address)) {
      throw taggedError(`bad net address: ${address}`, "INVALID_ARG");
    }
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean) {
      throw taggedError("net name must be a non-empty string", "INVALID_ARG");
    }
    const existing = this.#doc.netNames.find((n) => n.address === address);
    if (existing) existing.name = clean;
    else this.#doc.netNames.push({ address, name: clean });
    return { address, name: clean };
  }

  /** Remove the name binding on `address`. @returns {boolean} true if removed. */
  clearNetName(address) {
    const before = this.#doc.netNames.length;
    this.#doc.netNames = this.#doc.netNames.filter(
      (n) => n.address !== address,
    );
    return this.#doc.netNames.length !== before;
  }

  // ── Annotations: labels & notes (Feature 120) ────────────────────────────
  // Pure desk decoration — pointer-selectable, draggable, and ignored by
  // occupancy, the netlist, and the engine. x/y are absolute world pitch
  // coordinates; an `anchor` (component id) makes the annotation ride that
  // part's moves (the caller shifts x/y by the same delta). Ids are `an<n>`.

  /** Copies of the annotations on the desk. */
  get annotations() {
    return this.#doc.annotations.map((a) => ({ ...a }));
  }

  /** A copy of one annotation, or null. */
  getAnnotation(id) {
    const a = this.#doc.annotations.find((x) => x.id === id);
    return a ? { ...a } : null;
  }

  /**
   * Add a label / note at (x, y) in world pitch units. `extra` may carry
   * `color` and `anchor`. Throws INVALID_KIND / INVALID_ARG. Returns a copy.
   */
  addAnnotation(kind, x, y, text = "", { color = null, anchor = null } = {}) {
    if (!ANNOTATION_KINDS.has(kind)) {
      throw taggedError(`unsupported annotation kind: ${kind}`, "INVALID_KIND");
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("annotation position must be finite", "INVALID_ARG");
    }
    const ann = {
      id: `an${this.#doc.nextAnnotationId++}`,
      kind,
      x,
      y,
      text: typeof text === "string" ? text : "",
    };
    if (color) ann.color = color;
    if (anchor) ann.anchor = anchor;
    this.#doc.annotations.push(ann);
    return { ...ann };
  }

  /**
   * Patch an annotation's `x`, `y`, `text`, `color`, or `anchor` (a null/empty
   * color/anchor clears it). Throws NOT_FOUND. Returns a copy.
   */
  updateAnnotation(id, patch = {}) {
    const ann = this.#doc.annotations.find((a) => a.id === id);
    if (!ann) throw taggedError(`no annotation ${id}`, "NOT_FOUND");
    if (Number.isFinite(patch.x)) ann.x = patch.x;
    if (Number.isFinite(patch.y)) ann.y = patch.y;
    if (typeof patch.text === "string") ann.text = patch.text;
    if ("color" in patch) {
      if (patch.color) ann.color = patch.color;
      else delete ann.color;
    }
    if ("anchor" in patch) {
      if (patch.anchor) ann.anchor = patch.anchor;
      else delete ann.anchor;
    }
    return { ...ann };
  }

  /** Remove an annotation. Throws NOT_FOUND. */
  removeAnnotation(id) {
    const i = this.#doc.annotations.findIndex((a) => a.id === id);
    if (i === -1) throw taggedError(`no annotation ${id}`, "NOT_FOUND");
    this.#doc.annotations.splice(i, 1);
  }

  /** Detach any annotation anchored to a component that is going away. */
  #detachAnnotations(componentId) {
    for (const a of this.#doc.annotations) {
      if (a.anchor === componentId) delete a.anchor;
    }
  }

  // ── Scope channels: the logic-analyzer instrument setup (Feature 210) ──────
  // An ordered list of channel bindings persisted with the design so a saved
  // schematic keeps its analyzer setup. A `net` channel binds to a member
  // ADDRESS (surviving a re-key like a net name); a `bus` channel binds to a
  // bus id. Passive — no occupancy/netlist/engine effect; a dead ref reads as
  // undriven, coming back to life if its target returns (undo, re-add).

  /** Copies of the analyzer channels, in display order. */
  get scopeChannels() {
    return this.#doc.scopeChannels.map((c) => ({ ...c }));
  }

  /** A copy of one channel, or null. */
  getScopeChannel(id) {
    const c = this.#doc.scopeChannels.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  /** True if a channel already tracks this (kind, ref) — avoids duplicate lanes. */
  hasScopeChannel(kind, ref) {
    return this.#doc.scopeChannels.some(
      (c) => c.kind === kind && c.ref === ref,
    );
  }

  /**
   * Append a channel bound to a net address or a bus id. `extra` may carry
   * `label` and `color`. Throws INVALID_KIND / INVALID_ARG. Returns a copy.
   */
  addScopeChannel(kind, ref, { color = null, label = null } = {}) {
    if (!SCOPE_CHANNEL_KINDS.has(kind)) {
      throw taggedError(
        `unsupported scope channel kind: ${kind}`,
        "INVALID_KIND",
      );
    }
    if (typeof ref !== "string" || !ref) {
      throw taggedError(
        "scope channel ref must be a non-empty string",
        "INVALID_ARG",
      );
    }
    const ch = { id: `sc${this.#doc.nextScopeChannelId++}`, kind, ref };
    if (label) ch.label = label;
    if (color) ch.color = color;
    this.#doc.scopeChannels.push(ch);
    return { ...ch };
  }

  /**
   * Patch a channel's `label` or `color` (a null/empty value clears it). Throws
   * NOT_FOUND. Returns a copy.
   */
  updateScopeChannel(id, patch = {}) {
    const ch = this.#doc.scopeChannels.find((c) => c.id === id);
    if (!ch) throw taggedError(`no scope channel ${id}`, "NOT_FOUND");
    if ("label" in patch) {
      if (patch.label) ch.label = patch.label;
      else delete ch.label;
    }
    if ("color" in patch) {
      if (patch.color) ch.color = patch.color;
      else delete ch.color;
    }
    return { ...ch };
  }

  /** Remove a channel. Throws NOT_FOUND. */
  removeScopeChannel(id) {
    const i = this.#doc.scopeChannels.findIndex((c) => c.id === id);
    if (i === -1) throw taggedError(`no scope channel ${id}`, "NOT_FOUND");
    this.#doc.scopeChannels.splice(i, 1);
  }

  /** Reorder a channel to a new (clamped) index. Throws NOT_FOUND. */
  moveScopeChannel(id, index) {
    const from = this.#doc.scopeChannels.findIndex((c) => c.id === id);
    if (from === -1) throw taggedError(`no scope channel ${id}`, "NOT_FOUND");
    const to = Math.max(
      0,
      Math.min(this.#doc.scopeChannels.length - 1, Math.floor(index) || 0),
    );
    const [ch] = this.#doc.scopeChannels.splice(from, 1);
    this.#doc.scopeChannels.splice(to, 0, ch);
  }

  // ── Design paste (Feature 240) ───────────────────────────────────────────

  /**
   * Stamp a captured design (model/design-clip.js) onto this desk, translated
   * by an integer `shift`: its boards, the parts seated on them, the desk
   * bricks that travelled with it, all the wiring between them, and the bus /
   * net-name / anchored-label metadata riding those. Everything arrives with
   * FRESH ids from this document's own counters — a paste is new hardware, not
   * a reference to the design it came from.
   *
   * ALL-OR-NOTHING, and that is the whole reason it lives here rather than in
   * the controller: half a design is not a design (a board left behind silently
   * cuts every wire that crossed to it). The document is snapshotted first, and
   * ANY failure — an overlapping board, an occupied hole — restores it and
   * rethrows, so a refused paste leaves the desk exactly as it was.
   *
   * Mating is NOT applied here: the caller offers the new strips to
   * `joinMatedGroup` afterwards, exactly as it does for a placed kit, so a
   * design dropped flush against an existing board joins its group.
   *
   * @param {object} clip - from captureDesign
   * @param {{dx:number, dy:number}} shift
   * @returns {{boards:Array, components:Array, wires:Array, buses:Array,
   *   annotations:Array}} copies of everything created.
   */
  pasteDesign(clip, shift = { dx: 0, dy: 0 }) {
    const before = this.snapshot();
    const dx = Math.round(shift.dx);
    const dy = Math.round(shift.dy);
    try {
      // Clip key → the id it landed under here. Boards and bricks share one
      // map because a wire endpoint's owner may be either.
      const owners = new Map();
      const groups = new Map(); // clip group → a fresh group id
      const boards = [];
      for (const b of clip.boards) {
        const added = this.addBoard(b.type, b.x + dx, b.y + dy, b.rot);
        if (b.name || b.description) {
          this.setBoardParams(added.id, {
            name: b.name ?? "",
            description: b.description ?? "",
          });
        }
        if (b.group != null) {
          if (!groups.has(b.group)) {
            groups.set(b.group, `g${this.#doc.nextGroupId++}`);
          }
          this.#doc.boards.find((x) => x.id === added.id).group = groups.get(b.group); // prettier-ignore
        }
        owners.set(b.key, added.id);
        boards.push(this.getBoard(added.id));
      }
      const components = [];
      for (const b of clip.bricks) {
        const brick = this.addBrick(b.kind, b.x + dx, b.y + dy, b.params);
        owners.set(b.key, brick.id);
        components.push(brick);
      }
      const parts = new Map(); // clip key → new component id (label anchors)
      for (const p of clip.parts) {
        const boardId = owners.get(p.board);
        if (!boardId) continue; // a part whose board wasn't captured
        const comp = this.addComponent({
          kind: p.kind,
          ref: p.ref,
          board: boardId,
          anchor: p.anchor,
          params: p.params,
        });
        if (p.name || p.description) {
          this.setComponentMeta(comp.id, {
            name: p.name ?? "",
            description: p.description ?? "",
          });
        }
        parts.set(p.key, comp.id);
        components.push(this.getComponent(comp.id));
      }
      const wireIds = new Map(); // clip key → new wire id (bus members)
      const wires = [];
      for (const w of clip.wires) {
        const from = owners.get(w.from.owner);
        const to = owners.get(w.to.owner);
        if (!from || !to) continue;
        const wire = this.addWire({
          from: formatAddress(from, w.from.point),
          to: formatAddress(to, w.to.point),
          color: w.color,
          layout: w.layout ?? "direct",
          // Waypoints are desk coordinates, so unlike the addresses either
          // side of them they have to ride the paste shift themselves.
          points: (w.points ?? []).map((p) => ({ x: p.x + dx, y: p.y + dy })),
        });
        if (w.name || w.description) {
          this.setWireMeta(wire.id, {
            name: w.name ?? "",
            description: w.description ?? "",
          });
        }
        wireIds.set(w.key, wire.id);
        wires.push(this.getWire(wire.id));
      }
      const buses = (clip.buses ?? []).map((b) =>
        this.addBus(
          b.name,
          b.members.map((m) => wireIds.get(m)).filter(Boolean),
          { color: b.color },
        ),
      );
      for (const n of clip.netNames ?? []) {
        const owner = owners.get(n.owner);
        if (owner) this.nameNet(formatAddress(owner, n.point), n.name);
      }
      const annotations = [];
      for (const a of clip.annotations ?? []) {
        const anchor = parts.get(a.anchor);
        if (!anchor) continue;
        annotations.push(
          this.addAnnotation(a.kind, a.x + dx, a.y + dy, a.text, {
            color: a.color ?? null,
            anchor,
          }),
        );
      }
      return { boards, components, wires, buses, annotations };
    } catch (err) {
      this.restore(before); // a refused paste changes nothing at all
      throw err;
    }
  }

  // ── Whole-desk translation ───────────────────────────────────────────────

  /**
   * Slide the ENTIRE desk by an integer (dx, dy): every board, every desk-level
   * brick, and every annotation. Seated parts and wires need nothing — they are
   * stored as board addresses, not coordinates, so they ride their board.
   *
   * The move is RIGID, which is why there is no legality check and no way to
   * refuse it: nothing changes its position relative to anything else, so
   * nothing that was clear can start overlapping and nothing that was mated can
   * come apart. It exists so a design that has wandered far from the origin can
   * be pulled back around it (the fit-to-screen recentre) rather than drifting
   * ever further out into the coordinate range.
   *
   * @returns {{dx:number, dy:number}} the rounded delta actually applied.
   */
  translateAll(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      throw taggedError("desk delta must be finite", "INVALID_ARG");
    }
    // x rounds to the column lattice; y takes the same 0.01 grid a board is
    // stored on, there being no vertical lattice to round to any more. A
    // recentre that rounded y would leave the desk up to half a pitch off the
    // origin — visible on a fit, and enough to leave `make demos` reporting an
    // uncentred bench.
    const [ix, iy] = [Math.round(dx), boardCoord(dy)];
    if (ix === 0 && iy === 0) return { dx: 0, dy: 0 };
    for (const board of this.#doc.boards) {
      // Quantized, not accumulated: a board's y is fractional now (a kit's
      // middle strip sits at 3.70), and `+=` down a session of recentres would
      // walk it off the grid one ulp at a time until a dovetail stopped being
      // flush. The delta itself is a whole pitch, so nothing else moves.
      board.x = boardCoord(board.x + ix);
      board.y = boardCoord(board.y + iy);
    }
    for (const comp of this.#doc.components) {
      // Bricks alone carry desk coordinates; a seated part has board + anchor.
      if (comp.board == null && Number.isFinite(comp.x)) {
        comp.x += ix;
        comp.y += iy;
      }
    }
    // A label's position is absolute even when it is anchored to a part (the
    // anchor only makes it ride that part's drag), so every one moves.
    for (const ann of this.#doc.annotations) {
      ann.x += ix;
      ann.y += iy;
    }
    // A routed wire's waypoints are the one part of a wire that is NOT an
    // address, so they are the one part that has to be moved by hand — leave
    // them and a design slid to the origin would drag its routing behind it.
    for (const wire of this.#doc.wires) {
      for (const p of wire.points ?? []) {
        p.x += ix;
        p.y += iy;
      }
    }
    return { dx: ix, dy: iy };
  }

  /** The serializable document (a deep copy — safe to hand to IPC). */
  toJSON() {
    return structuredClone(this.#doc);
  }

  /**
   * An immutable snapshot of the whole document for the undo/redo history
   * (Feature 200) — a deep copy, so later mutations never bleed into it. Same
   * shape as toJSON; named for its role as a history entry.
   */
  snapshot() {
    return structuredClone(this.#doc);
  }

  /**
   * Replace the whole document with a `snapshot` (an undo/redo restore). The
   * snapshot is deep-copied in, so the caller may keep re-restoring the same
   * one. It is trusted to be a valid document (it came from snapshot()/toJSON),
   * so it is NOT re-normalized — restore is byte-exact, the round-trip
   * undo/redo relies on.
   */
  restore(snapshot) {
    this.#doc = structuredClone(snapshot);
  }

  /**
   * Replace the whole document with one loaded from OUTSIDE — a file, or
   * another project tab (Feature 240). Unlike `restore`, the input is
   * untrusted, so it goes through the same normalization the constructor
   * applies: a hand-edited or older file can never leave a half-valid document
   * on the desk. The counterpart to `restore` (trusted, byte-exact) — pick by
   * where the document came from, never by convenience.
   */
  load(raw) {
    this.#doc = normalizeDocument(raw);
  }
}
