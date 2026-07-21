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

// part-geometry.js — where things SIT on the desk, in world (pitch) units, and
// what a pointer is over. Pure geometry over a document's boards + components:
// resolving pin/terminal/address positions and hit-testing them. The desk
// controller was the only home for this maths; pulling it here makes it
// independently testable and keeps the controller a thin view of it.
//
// Everything takes plain arrays (a board is `{id,type,x,y,rot}`, a component
// `{id,kind,ref,board,anchor,params,x,y}`), so a test builds a scene as data.
// A missing/unresolvable part contributes nothing — it never throws.

import { formatAddress, holePosition, parseAddress } from "./breadboard.js";
// holePosition drives partPinsWorld below; addressWorld uses the canonical
// worldOfAddress from occupancy.
import {
  holeAtWorld,
  partPinAddresses,
  partPinHoles,
  worldOfAddress,
} from "./occupancy.js";
import { partDef } from "../catalog/index.js";

/** How close (pitch units) a point must be to a pin/terminal to hit it. */
export const PIN_HIT_RADIUS = 0.45;

/** How close the cursor must come to a wire's end cap to grab it. */
export const WIRE_END_GRAB_RADIUS = 0.6;

/**
 * Every pin of a seated board part as `{ pin, address, x, y }` — the world
 * position each lead sits at (a bent lead by where it lands, floating or not)
 * plus the address it resolves to (null when floating). Null when the part
 * doesn't resolve. `boards` may carry a moved origin for a live board drag.
 */
export function partPinsWorld(boards, comp) {
  const board = boards.find((b) => b.id === comp.board);
  const pins = board && partPinHoles(comp.ref, comp.anchor, comp.params);
  if (!pins) return null;
  const addressed = partPinAddresses({ boards }, comp);
  if (!addressed) return null;
  // Hole ids are stated in the strip's own unrotated frame, so every
  // holePosition here needs the strip's angle — exactly as partPinAddresses
  // resolves it. Without it the drawn pins and the addressed ones disagree.
  const rot = board.rot ?? 0;
  const anchorPos = holePosition(board.type, comp.anchor, rot);
  if (!anchorPos) return null;
  const out = [];
  for (const [i, { pin, hole, offset }] of pins.entries()) {
    const address = addressed[i].address;
    if (offset) {
      out.push({
        pin,
        address,
        x: board.x + anchorPos.x + offset.dx,
        y: board.y + anchorPos.y + offset.dy,
      });
      continue;
    }
    // A seated pin lives in a hole of its own board — no hole, no geometry.
    const pos = holePosition(board.type, hole, rot);
    if (!pos) return null;
    out.push({ pin, address, x: board.x + pos.x, y: board.y + pos.y });
  }
  return out;
}

/**
 * The world position of an address — a board hole (via the canonical,
 * rotation-aware worldOfAddress) or a brick terminal.
 */
export function addressWorld(boards, components, address) {
  const hole = worldOfAddress(boards, address);
  if (hole) return hole;
  const parsed = parseAddress(address);
  const comp = parsed && components.find((c) => c.id === parsed.boardId);
  const t = partDef(comp?.ref)?.terminals?.find((x) => x.id === parsed.hole);
  return t ? { x: comp.x + t.dx, y: comp.y + t.dy } : null;
}

/**
 * The nearest connection point (board hole or brick terminal) to a world
 * point, as `{ address, x, y }`, or null over nothing. Holes win outright
 * (via holeAtWorld); terminals match within PIN_HIT_RADIUS.
 */
export function connectionPointAt(boards, components, world) {
  const hole = holeAtWorld(boards, world.x, world.y);
  if (hole) {
    return {
      address: formatAddress(hole.board.id, hole.hole),
      x: hole.x,
      y: hole.y,
    };
  }
  for (const comp of components) {
    const terminals = partDef(comp.ref)?.terminals;
    if (!terminals) continue;
    for (const t of terminals) {
      const x = comp.x + t.dx;
      const y = comp.y + t.dy;
      if (Math.hypot(world.x - x, world.y - y) > PIN_HIT_RADIUS) continue;
      return { address: formatAddress(comp.id, t.id), x, y };
    }
  }
  return null;
}

/**
 * World positions of a component's connection points: a board part's derived
 * pin holes, or a desk brick's terminals. Empty when they don't resolve — an
 * unresolvable part is never marquee-selectable.
 */
export function componentPoints(boards, comp) {
  const def = partDef(comp.ref);
  if (!def) return [];
  if (comp.board == null) {
    return (def.terminals ?? []).map((t) => ({
      x: comp.x + t.dx,
      y: comp.y + t.dy,
    }));
  }
  // A bent lead counts by where it SITS, floating or not — the marquee
  // encloses what the user can see.
  const pins = partPinsWorld(boards, comp);
  return pins ? pins.map(({ x, y }) => ({ x, y })) : [];
}

const inRect = (rect, p) =>
  p &&
  p.x >= rect.minX &&
  p.x <= rect.maxX &&
  p.y >= rect.minY &&
  p.y <= rect.maxY;

/** Ids of components whose EVERY pin/terminal lies inside the world rect. */
export function componentsInRect(boards, components, rect) {
  const ids = [];
  for (const comp of components) {
    const points = componentPoints(boards, comp);
    if (points.length > 0 && points.every((p) => inRect(rect, p))) {
      ids.push(comp.id);
    }
  }
  return ids;
}

/** Ids of wires with BOTH endpoints inside the world rect. */
export function wiresInRect(boards, components, wires, rect) {
  return wires
    .filter(
      (w) =>
        inRect(rect, addressWorld(boards, components, w.from)) &&
        inRect(rect, addressWorld(boards, components, w.to)),
    )
    .map((w) => w.id);
}

/**
 * The nearest wire endpoint within WIRE_END_GRAB_RADIUS of a world point, as
 * `{ wireId, end, origin, dist }`, or null — how a cap-grab drag begins.
 */
export function wireEndNear(boards, components, wires, world) {
  let best = null;
  for (const wire of wires) {
    for (const end of ["from", "to"]) {
      const p = addressWorld(boards, components, wire[end]);
      if (!p) continue;
      const dist = Math.hypot(world.x - p.x, world.y - p.y);
      if (dist > WIRE_END_GRAB_RADIUS) continue;
      if (!best || dist < best.dist) {
        best = { wireId: wire.id, end, origin: wire[end], dist };
      }
    }
  }
  return best;
}

/**
 * What a hover is over: a part pin/terminal (they sit above), else a bare
 * hole, as `{ key, label, address, x, y }`, or null. `key` is a stable hover
 * identity; `address` is the conductive point (null for a floating lead).
 */
export function hoverHitAt(boards, components, world) {
  const pin = pinHitAt(boards, components, world);
  if (pin) return pin;
  const hole = holeAtWorld(boards, world.x, world.y);
  if (!hole) return null;
  const address = formatAddress(hole.board.id, hole.hole);
  return { key: address, label: address, address, x: hole.x, y: hole.y };
}

function pinHitAt(boards, components, world) {
  for (const comp of components) {
    const def = partDef(comp.ref);
    // Desk-level bricks (PSU, clock) expose terminals as connection points.
    if (comp.board == null && def?.terminals) {
      for (const t of def.terminals) {
        const x = comp.x + t.dx;
        const y = comp.y + t.dy;
        if (Math.hypot(world.x - x, world.y - y) > PIN_HIT_RADIUS) continue;
        const address = formatAddress(comp.id, t.id);
        let note = "";
        if (comp.kind === "psu") {
          note = t.id === "+" ? ` · +${comp.params.volts} V` : " · 0 V";
        } else if (comp.kind === "clock") {
          note = t.id === "out" ? " · clock out" : " · gnd";
        }
        return {
          key: `${comp.id}#${t.id}`,
          label: `${address}${note}`,
          address,
          x,
          y,
        };
      }
      continue;
    }
    const pins = partPinsWorld(boards, comp);
    if (!pins) continue;
    for (const { pin, address, x, y } of pins) {
      if (Math.hypot(world.x - x, world.y - y) > PIN_HIT_RADIUS) continue;
      const name = def.pins.find((p) => p.n === pin)?.name ?? "?";
      return {
        key: `${comp.id}#${pin}`,
        // A floating lead is still hoverable — it just has no net to name.
        label: `${comp.ref} pin ${pin} · ${name} → ${address ?? "floating"}`,
        address, // a pin resolves to the net of its seated hole
        x,
        y,
      };
    }
  }
  return null;
}
