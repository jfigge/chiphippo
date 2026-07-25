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

// design-clip.js — copy/paste of a WHOLE DESIGN: the boards of a sub-assembly,
// everything seated on them, the desk bricks selected with them, and all the
// wiring between them — captured as one rigid arrangement and re-stamped
// somewhere else. That "somewhere else" is usually ANOTHER DESKTOP (a project
// tab, Feature 240): work a reference design out on a sub-desktop, copy it,
// and drop it into the main build.
//
// This is `paste-cluster.js` one level up. That module carries loose PARTS and
// re-seats each on whatever board it lands over; this one carries the BOARDS
// too, so the design brings its own holes with it and its internal wiring
// survives the trip. The two are deliberately separate: a part cluster asks
// "does each member find a free hole?", while a design asks only "is there room
// on the desk?" — the wiring inside it is already known to be sound.
//
// The capture is BOARDS-FIRST and total. Given a set of board ids it takes:
//   · those boards (type, rotation, position, group, name/description),
//   · EVERY component seated on them — the whole board comes, not just what a
//     marquee happened to touch,
//   · the desk bricks (PSU / clock / LCD) explicitly named in the selection,
//   · every wire whose BOTH endpoints land on a captured owner (a wire with one
//     end outside would have to be cut, so it is simply not part of the design),
//   · and the metadata riding those wires and parts — buses whose members are
//     all captured, net names bound to captured addresses, and labels anchored
//     to captured parts.
// Everything is stored in the SOURCE's own world coordinates plus a `center`
// (the arrangement's bounding-box middle), so a paste is one integer-pitch
// translation away — exactly the paste-cluster contract, and for the same
// reason: the desk is an integer 0.1-in lattice, so a rigid integer shift maps
// holes onto holes and can never land a design half a hole off.
//
// Legality is per-BOARD and per-BRICK only, and the clip is ALL-OR-NOTHING.
// A rigid translation preserves the arrangement, so the parts and wires inside
// a captured design can only ever conflict with each other in ways they already
// didn't; the one thing that can go wrong is a board (or brick) landing on top
// of something already on the destination desk. And unlike a part cluster —
// where a red member is simply dropped from the paste — half a design is not a
// design: leaving a board behind would silently cut every wire that crossed to
// it. So `resolveDesign` reports one verdict for the whole clip.
//
// Pure and DOM-free: the controller renders the clip, the document stamps it.

import { partDef } from "../catalog/index.js";
import { formatAddress, parseAddress } from "./breadboard.js";
import { boardRect, snapCorrection } from "./mating.js";

/**
 * A copied part's params: a deep copy with everything RUN-VOLATILE or
 * per-instance stripped. `damaged` is run state (a fresh part is never
 * pre-damaged) and a memory chip's `storage`/`programmed` binding belongs to
 * the chip it was minted for — the paste mints its own file (the controller's
 * `#provisionMemory`), so a copy must never inherit the source's bytes.
 */
function freshParams(params) {
  const copy = params ? structuredClone(params) : {};
  delete copy.damaged;
  delete copy.storage;
  delete copy.programmed;
  return copy;
}

/** A desk brick's footprint rect, or null for a part with no declared size. */
function brickRect(comp) {
  const size = partDef(comp.ref)?.size;
  return size
    ? { x: comp.x, y: comp.y, width: size.width, height: size.height }
    : null;
}

/** Copy `name`/`description` across when present (omit-when-empty, as the
    document itself stores them). */
function withMeta(target, source) {
  if (source.name) target.name = source.name;
  if (source.description) target.description = source.description;
  return target;
}

/**
 * Capture a design from a document. `boardIds` drives everything — a clip with
 * no board is not a design (loose parts are `paste-cluster.js`'s job), so this
 * returns null. `componentIds` only ever adds DESK BRICKS: board parts come
 * with their board, whether or not the selection named them.
 *
 * @param {{boards:Array, components:Array, wires:Array, buses?:Array,
 *   netNames?:Array, annotations?:Array}} doc - the live document (plain).
 * @param {{boardIds?: string[], componentIds?: string[]}} selection
 * @returns {object|null} the clip, or null when there is nothing to copy.
 */
export function captureDesign(doc, { boardIds = [], componentIds = [] } = {}) {
  const wanted = new Set(boardIds);
  const boards = (doc.boards ?? []).filter((b) => wanted.has(b.id));
  if (boards.length === 0) return null;
  const named = new Set(componentIds);
  const components = doc.components ?? [];
  const bricks = components.filter((c) => c.board == null && named.has(c.id));
  const parts = components.filter(
    (c) => c.board != null && wanted.has(c.board),
  );

  // A wire, a name, or a bus only travels when EVERYTHING it touches does.
  const owners = new Set([...wanted, ...bricks.map((b) => b.id)]);
  const inside = (address) => {
    const parsed = parseAddress(address);
    return parsed && owners.has(parsed.boardId) ? parsed : null;
  };
  const wires = [];
  for (const w of doc.wires ?? []) {
    const from = inside(w.from);
    const to = inside(w.to);
    if (!from || !to) continue;
    wires.push(
      withMeta(
        {
          key: w.id,
          from: { owner: from.boardId, point: from.hole },
          to: { owner: to.boardId, point: to.hole },
          color: w.color,
        },
        w,
      ),
    );
  }
  const wireKeys = new Set(wires.map((w) => w.key));
  const buses = (doc.buses ?? [])
    .filter(
      (b) => b.members.length > 0 && b.members.every((m) => wireKeys.has(m)),
    ) // prettier-ignore
    .map((b) => ({
      name: b.name,
      color: b.color,
      members: [...b.members],
    }));
  const netNames = (doc.netNames ?? [])
    .map((n) => ({ parsed: inside(n.address), name: n.name }))
    .filter((n) => n.parsed)
    .map((n) => ({
      owner: n.parsed.boardId,
      point: n.parsed.hole,
      name: n.name,
    }));
  // Only ANCHORED labels ride along — a label pinned to a captured part is
  // part of that part's documentation. A free-floating one belongs to the desk
  // it was written on, not to the design.
  const partKeys = new Set(parts.map((c) => c.id));
  const annotations = (doc.annotations ?? [])
    .filter((a) => a.anchor && partKeys.has(a.anchor))
    .map((a) => structuredClone(a));

  // The grab reference: the bounding box of everything with a FOOTPRINT (the
  // boards and bricks), so the design tracks the cursor from its middle the
  // way a kit ghost does.
  const rects = [
    ...boards.map(boardRect),
    ...bricks.map(brickRect).filter(Boolean),
  ];
  const center = {
    x: (Math.min(...rects.map((r) => r.x)) + Math.max(...rects.map((r) => r.x + r.width))) / 2, // prettier-ignore
    y: (Math.min(...rects.map((r) => r.y)) + Math.max(...rects.map((r) => r.y + r.height))) / 2, // prettier-ignore
  };
  return {
    center,
    boards: boards.map((b) =>
      withMeta(
        {
          key: b.id,
          type: b.type,
          x: b.x,
          y: b.y,
          rot: b.rot ?? 0,
          group: b.group ?? null,
        },
        b,
      ),
    ),
    bricks: bricks.map((c) => ({
      key: c.id,
      kind: c.kind,
      ref: c.ref,
      x: c.x,
      y: c.y,
      params: freshParams(c.params),
    })),
    parts: parts.map((c) =>
      withMeta(
        {
          key: c.id,
          board: c.board,
          anchor: c.anchor,
          kind: c.kind,
          ref: c.ref,
          params: freshParams(c.params),
        },
        c,
      ),
    ),
    wires,
    buses,
    netNames,
    annotations,
  };
}

/**
 * The integer-pitch shift that puts a clip's centre under a world point.
 * Fractional is fine going in — the rounding here is what keeps every hole on
 * the lattice.
 */
export function shiftFor(clip, world) {
  return {
    dx: Math.round(world.x - clip.center.x),
    dy: Math.round(world.y - clip.center.y),
  };
}

/**
 * Resolve a clip translated by `shift`: where every board and brick lands, and
 * whether the design as a whole may be dropped there. See the module note on
 * why the verdict is all-or-nothing and why only footprints are checked.
 *
 * @param {object} clip - from captureDesign
 * @param {{dx:number, dy:number}} shift - integer pitch translation
 * @param {object} tests
 * @param {(type:string, x:number, y:number, rot:number)=>boolean}
 *   tests.canPlaceBoard
 * @param {(ref:string, x:number, y:number)=>boolean} tests.canPlaceBrick
 * @returns {{boards:Array, bricks:Array, legal:boolean}}
 */
export function resolveDesign(clip, shift, { canPlaceBoard, canPlaceBrick }) {
  const boards = clip.boards.map((b) => {
    const x = b.x + shift.dx;
    const y = b.y + shift.dy;
    return { ...b, x, y, legal: canPlaceBoard(b.type, x, y, b.rot) };
  });
  const bricks = clip.bricks.map((b) => {
    const x = b.x + shift.dx;
    const y = b.y + shift.dy;
    return { ...b, x, y, legal: canPlaceBrick(b.ref, x, y) };
  });
  return {
    boards,
    bricks,
    legal:
      boards.every((b) => b.legal) &&
      bricks.every((b) => b.legal) &&
      clip.boards.length > 0,
  };
}

/**
 * The magnetic pull on a design about to be dropped: the extra (dx, dy) that
 * would land one of its boards flush against a board already on the desk it
 * can dovetail with. The same `snapCorrection` a board drag and a kit ghost
 * use, so a pasted design mates exactly like a placed one.
 *
 * @param {object} clip
 * @param {{dx:number, dy:number}} shift
 * @param {Array<{x,y,width,height}>} stationary - rects of the existing boards
 */
export function snapDesign(clip, shift, stationary) {
  if (clip.boards.length === 0) return { dx: 0, dy: 0 };
  return snapCorrection(
    clip.boards.map((b) =>
      boardRect({ ...b, x: b.x + shift.dx, y: b.y + shift.dy }),
    ),
    stationary,
  );
}

/**
 * A clip re-expressed as a stand-alone `{boards, components, wires}` at the
 * origin its capture recorded — the shape the geometry helpers
 * (`addressWorld`, `partPinsWorld`) already read, so the GHOST can lay itself
 * out with the same code the desk uses instead of a parallel copy of the
 * arithmetic. Board/brick keys stand in as ids, so a clip wire's endpoint
 * address resolves against it unchanged.
 */
export function clipScene(clip) {
  return {
    boards: clip.boards.map(({ key, type, x, y, rot }) => ({
      id: key,
      type,
      x,
      y,
      rot,
    })),
    components: [
      ...clip.bricks.map(({ key, kind, ref, x, y, params }) => ({
        id: key,
        kind,
        ref,
        x,
        y,
        params,
        board: null,
      })),
      ...clip.parts.map(({ key, board, anchor, kind, ref, params }) => ({
        id: key,
        kind,
        ref,
        board,
        anchor,
        params,
      })),
    ],
    wires: clip.wires.map((w) => ({
      id: w.key,
      from: formatAddress(w.from.owner, w.from.point),
      to: formatAddress(w.to.owner, w.to.point),
      color: w.color,
    })),
  };
}
