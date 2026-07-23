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
  holePosition,
  normalizeRotation,
  parseAddress,
  parseHole,
  spec,
} from "./breadboard.js";
import { partDef } from "../catalog/index.js";
import {
  boardRect as outlineRect,
  matingEdge,
  snapCorrection,
} from "./mating.js";
import {
  buildOccupancy,
  canMoveWire,
  canPlacePart,
  canPlaceWire,
  canReendWire,
  isFreeHole,
  partPinHoles,
} from "./occupancy.js";

export const DOC_VERSION = 6;

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
const LCD_ID_RE = /^lcd([1-9]\d*)$/;
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
  lcd: { re: LCD_ID_RE, prefix: "lcd", counter: "nextLcdId" },
});

/** Params coerced through the def's own contract (chips have none). */
function normalizeParams(def, raw) {
  return def.normalizeParams ? def.normalizeParams(raw) : {};
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
    buses: [],
    netNames: [],
    annotations: [],
    scopeChannels: [],
    nextBoardId: 1,
    nextGroupId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextClockId: 1,
    nextLcdId: 1,
    nextWireId: 1,
    nextBusId: 1,
    nextAnnotationId: 1,
    nextScopeChannelId: 1,
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
  let maxGroupSeq = 0;
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
    // A junk group id degrades to a loose strip rather than dropping it.
    const g = typeof b.group === "string" ? GROUP_ID_RE.exec(b.group) : null;
    if (g) maxGroupSeq = Math.max(maxGroupSeq, Number(g[1]));
    doc.boards.push({
      id: b.id,
      type: b.type,
      x: Math.round(b.x),
      y: Math.round(b.y),
      rot: normalizeRotation(b.type, b.rot),
      group: g ? b.group : null,
    });
  }

  let maxCompSeq = 0;
  const maxBrickSeq = { psu: 0, clock: 0, lcd: 0 };
  const compIds = new Set();
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
      doc.components.push({
        id: c.id,
        kind: c.kind,
        ref: c.ref,
        x: Math.round(c.x),
        y: Math.round(c.y),
        params: normalizeParams(def, c.params),
      });
      continue;
    }
    if (c.kind !== def.kind || (c.kind !== "chip" && c.kind !== "discrete")) {
      continue;
    }
    const m = typeof c.id === "string" ? COMPONENT_ID_RE.exec(c.id) : null;
    if (!m) continue;
    if (!boardIds.has(c.board)) continue; // seated on a surviving board
    if (typeof c.anchor !== "string") continue;
    compIds.add(c.id);
    maxCompSeq = Math.max(maxCompSeq, Number(m[1]));
    const record = {
      id: c.id,
      kind: c.kind,
      ref: c.ref,
      board: c.board,
      anchor: c.anchor,
      params: normalizeParams(def, c.params),
    };
    const schematicPos = normalizeSchematicPos(c.schematicPos);
    if (schematicPos) record.schematicPos = schematicPos; // Feature 150 nudge
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
    doc.wires.push({
      id: w.id,
      from: w.from,
      to: w.to,
      color: WIRE_COLORS.includes(w.color) ? w.color : WIRE_COLORS[0],
    });
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
  const storedNextLcd =
    Number.isInteger(raw.nextLcdId) && raw.nextLcdId > 0 ? raw.nextLcdId : 1;
  doc.nextLcdId = Math.max(storedNextLcd, maxBrickSeq.lcd + 1);
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
function rectsOverlap(a, b) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
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

  /** The desk rectangles of every brick (PSU, clock) from its def size. */
  #brickRects({ ignoreId = null } = {}) {
    return this.#doc.components
      .filter(
        (c) => c.board == null && c.id !== ignoreId && partDef(c.ref)?.size,
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
    const rect = { x: Math.round(x), y: Math.round(y), width, height };
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
  canPlaceBrick(ref, x, y, { ignoreId = null } = {}) {
    const { width, height } = partDef(ref).size;
    const rect = { x: Math.round(x), y: Math.round(y), width, height };
    return (
      this.#doc.boards.every((b) => !rectsOverlap(rect, outlineRect(b))) &&
      this.#brickRects({ ignoreId }).every((r) => !rectsOverlap(rect, r))
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
        `a ${type} board at ${Math.round(x)},${Math.round(y)} overlaps an existing board`,
        "OVERLAP",
      );
    }
    const board = {
      id: `bb${this.#doc.nextBoardId++}`,
      type,
      x: Math.round(x),
      y: Math.round(y),
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
  static kitPlacements(kitKey, x, y, rot = 0) {
    const kit = BREADBOARD_KITS[kitKey];
    if (!kit) throw taggedError(`unknown kit: ${kitKey}`, "INVALID_TYPE");
    const ox = Math.round(x);
    const oy = Math.round(y);
    // A kit turns only if EVERY strip in it can: in practice the lone-rail
    // kits. An assembled board holds a pin-board, so it stays flat, and the
    // preset offsets are only ever meaningful at 0.
    const turn = DeskDoc.canRotateKit(kitKey) ? normalizeRotation(kit.strips[0].type, rot) : 0; // prettier-ignore
    return kit.strips.map((s) => ({
      type: s.type,
      x: ox + s.dx,
      y: oy + s.dy,
      rot: turn,
    }));
  }

  /** Can this kit be placed on its side? Only one made purely of rails. */
  static canRotateKit(kitKey) {
    const kit = BREADBOARD_KITS[kitKey];
    if (!kit) throw taggedError(`unknown kit: ${kitKey}`, "INVALID_TYPE");
    return kit.strips.every((s) => canRotate(s.type));
  }

  /** The bounding box of a kit, for centring the placement ghost. */
  static kitOutline(kitKey, rot = 0) {
    const strips = DeskDoc.kitPlacements(kitKey, 0, 0, rot);
    const sized = strips.map((s) => ({ s, size: boardSize(s.type, s.rot) }));
    return {
      width: Math.max(...sized.map(({ s, size }) => s.x + size.width)),
      height: Math.max(...sized.map(({ s, size }) => s.y + size.height)),
    };
  }

  /** Would every strip of a kit fit at (x, y)? All-or-nothing. */
  canPlaceKit(kitKey, x, y, rot = 0) {
    return DeskDoc.kitPlacements(kitKey, x, y, rot).every((s) =>
      this.canPlace(s.type, s.x, s.y, { rot: s.rot }),
    );
  }

  /**
   * Place a whole breadboard: every strip of the kit, seated at its preset
   * offset and joined into one group so they drag as a unit. Throws
   * INVALID_TYPE / INVALID_ARG / OVERLAP — nothing is added on failure.
   *
   * @returns {Array<object>} copies of the new strips, in kit order.
   */
  addKit(kitKey, x, y, rot = 0) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw taggedError("kit position must be finite", "INVALID_ARG");
    }
    const placements = DeskDoc.kitPlacements(kitKey, x, y, rot);
    if (!this.canPlaceKit(kitKey, x, y, rot)) {
      throw taggedError(
        `a ${kitKey} breadboard at ${Math.round(x)},${Math.round(y)} overlaps an existing board`,
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
   * Would translating exactly `ids` by (dx, dy) — integers — clear every
   * board and brick that is NOT moving? False when any id is unknown.
   */
  canMoveBoardsBy(ids, dx, dy) {
    const moving = new Set(ids);
    const members = this.#doc.boards.filter((b) => moving.has(b.id));
    if (members.length === 0 || members.length !== moving.size) return false;
    const rects = members.map((b) =>
      outlineRect({ ...b, x: b.x + Math.round(dx), y: b.y + Math.round(dy) }),
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
    return snapCorrection(
      members.map((b) =>
        outlineRect({ ...b, x: b.x + Math.round(dx), y: b.y + Math.round(dy) }),
      ),
      others.map(outlineRect),
    );
  }

  /** The same magnetic pull, for a kit not yet placed (the ghost). */
  snapKitAt(kitKey, x, y, rot = 0) {
    return snapCorrection(
      DeskDoc.kitPlacements(kitKey, x, y, rot).map(outlineRect),
      this.#doc.boards.map(outlineRect),
    );
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
   * Translate exactly `ids` by (dx, dy) — the rigid move behind a directional
   * break. When the set is only PART of a group, the snap breaks: both halves
   * are re-grouped from what is still mated within each, so a run that stays
   * whole keeps travelling as a unit and a strip left on its own goes loose.
   * A group id is never reused across a break. Throws NOT_FOUND /
   * INVALID_ARG / OVERLAP — nothing moves on failure.
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
    const moved = [];
    for (const b of this.#doc.boards) {
      if (!moving.has(b.id)) continue;
      b.x += Math.round(dx);
      b.y += Math.round(dy);
      moved.push(b);
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
   * Move a board (coordinates snapped to integers). Throws NOT_FOUND /
   * INVALID_ARG / OVERLAP. Returns a copy of the updated board.
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
        `moving ${id} to ${Math.round(x)},${Math.round(y)} overlaps another board`,
        "OVERLAP",
      );
    }
    const group = board.group;
    board.x = Math.round(x);
    board.y = Math.round(y);
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
      // A desk-level brick (PSU / clock / LCD) is repositioned with moveBrick.
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
   * Rotate a placed rotatable part (resistor) 90° around pin 1: pin 1 stays,
   * pin 2's lead swings a quarter lap (tries CW then CCW). The part is stored
   * in its two-free-ends form (`rot: 90`, `end` a `{dx, dy}` bend).
   * Throws NOT_FOUND / INVALID_REF (not rotatable) / ILLEGAL_PLACEMENT (no free
   * hole at either rotated position). Returns a copy.
   */
  rotateComponent(id) {
    const comp = this.#doc.components.find((c) => c.id === id);
    if (!comp) throw taggedError(`no component ${id}`, "NOT_FOUND");
    const def = partDef(comp.ref);
    // A DIP chip turns a half lap in place: its footprint maps onto itself, so
    // the holes (and every occupancy check) are unchanged — only the pin
    // numbering reverses. Nothing can block it.
    if (def?.package) {
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
      // A desk-level brick (PSU, clock, LCD) takes its attached wires with it.
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
    return this.#doc.wires.map((w) => ({ ...w }));
  }

  /** A copy of one wire, or null. */
  getWire(id) {
    const w = this.#doc.wires.find((x) => x.id === id);
    return w ? { ...w } : null;
  }

  /** Copies of the wires with an endpoint on one owner (board or PSU). */
  wiresTouching(ownerId) {
    return this.#doc.wires
      .filter((w) => this.#wireTouches(w, ownerId))
      .map((w) => ({ ...w }));
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
    return { ...wire };
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
    return { ...wire };
  }

  /**
   * Would every move in `moves` (each `{ id, from, to }`) land legally when
   * the whole batch is applied AT ONCE — the rigid whole-bus drag? Legality is
   * judged against a doc with EVERY moving wire lifted out, so members may
   * shuffle among the holes they collectively vacate (a bus shifted by its own
   * pitch), and every target must be a real point, free of any non-moving
   * lead, and claimed by exactly one move.
   */
  canMoveWiresBatch(moves) {
    const ids = new Set(moves.map((m) => m.id));
    if (ids.size !== moves.length) return false; // a wire moved twice
    if (!moves.every((m) => this.#doc.wires.some((w) => w.id === m.id))) {
      return false;
    }
    // The doc as if the movers were gone — the holes they leave read free.
    const reduced = {
      boards: this.#doc.boards,
      components: this.#doc.components,
      wires: this.#doc.wires.filter((w) => !ids.has(w.id)),
    };
    const claimed = new Set();
    for (const { from, to } of moves) {
      if (from === to) return false;
      for (const address of [from, to]) {
        if (claimed.has(address)) return false; // two leads into one hole
        if (!isFreeHole(reduced, address)) return false;
        claimed.add(address);
      }
    }
    return true;
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
    if ("name" in patch) {
      const parsed = parseBusName(patch.name);
      if (!parsed) throw taggedError(`bad bus name: ${patch.name}`, "INVALID_ARG"); // prettier-ignore
      bus.name = patch.name.trim();
      bus.width = Math.max(parsed.width, bus.members.length, 1);
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
      bus.width = Math.max(bus.width, bus.members.length, 1);
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
}
