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

// wire-model.js — the desk's wiring in 3D: jumpers, ribbon buses, and the
// flags external signals and Arduino Output/Input tags plug into the board.
//
// Every end is the ADDRESS the document stores, resolved through
// model/part-geometry.js's `addressWorld` — the function the desk's own wire
// layer uses — so a wire in 3D goes into the hole the netlist says it does.
//
//   · A DIRECT wire is a flexible jumper: its tinned tips go down into their
//     holes and the insulated run arches between them, higher the longer it
//     is — the 3D reading of the desk's sagging curve.
//   · A ROUTED wire is a pre-formed jumper: it lies along the board through
//     its waypoints, its tips bent down into the holes.
//   · A BUS is a ribbon cable: its members leave their holes, gather side by
//     side at the collars desk/ribbon-path.js places, and run as one flat
//     cable between them — the desk's ribbon layout, lifted off the board.
//
// Collisions are ignored, as everywhere in this first pass: a wire may pass
// through a part it crosses.

import { parseAddress } from "../model/breadboard.js";
import { addressWorld } from "../model/part-geometry.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import {
  centroid,
  ribbonLayout,
  ribbonSpread,
  ribbonWidth,
} from "../desk/ribbon-path.js";
import { add, length, lerp, normalize, scale, sub } from "./mat4.js";
import { cubicPoints } from "./mesh.js";
import { namedColor } from "./palette.js";
import { HOLE_DEPTH, TERMINAL_Y, WIRE_RADIUS } from "./scene-builder.js";

/** How high a routed jumper lies over the board. */
const ROUTE_Y = 0.3;

/** Where a direct jumper's insulation starts above its hole. */
const TIP_Y = 0.3;

/** A ribbon cable's height above the board. */
const RIBBON_Y = 2.2;

/** A tinned tip's radius — the bare copper is thinner than the insulation. */
const TIP_RADIUS = 0.06;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Where an address is in 3D: `{p, hole}` — a board hole on the board's top
 * face, or a bench brick's terminal at the top of its binding post — or null
 * for an address that resolves to nothing.
 */
export function endOf(doc, address) {
  const w = addressWorld(doc.boards, doc.components, address);
  if (!w) return null;
  const parsed = parseAddress(address);
  const hole = Boolean(
    parsed && doc.boards.some((b) => b.id === parsed.boardId),
  );
  return { p: [w.x, hole ? 0 : TERMINAL_Y, w.y], hole };
}

/** A tinned tip from inside its hole up into the insulation. */
function tip(sb, end, top) {
  if (!end.hole) return;
  sb.lead(
    [
      [end.p[0], -HOLE_DEPTH, end.p[2]],
      [end.p[0], top, end.p[2]],
    ],
    TIP_RADIUS,
  );
}

/** The point where an end's insulation starts (`y` above a hole; the post
    top for a terminal). */
const startOf = (end, y) => (end.hole ? [end.p[0], y, end.p[2]] : end.p);

/**
 * The arch a flexible jumper makes between two ends: straight up out of each,
 * over and down. Its height grows with the run, so a long jumper clears the
 * parts it crosses more often than not — but nothing guarantees it (no
 * collision avoidance in this pass).
 */
export function archPoints(a, b) {
  const run = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const rise = clamp(0.3 * run + 0.6, 0.9, 7);
  const top = Math.max(a[1], b[1]) + rise;
  const steps = clamp(Math.ceil(run * 1.2), 10, 32);
  return cubicPoints(a, [a[0], top, a[2]], [b[0], top, b[2]], b, steps);
}

/**
 * Add one wire that is not a bus member.
 * @param {import("./scene-builder.js").SceneBuilder} sb
 */
export function buildWire(sb, doc, wire) {
  const A = endOf(doc, wire.from);
  const B = endOf(doc, wire.to);
  if (!A || !B) return false;
  const color = namedColor(sb.palette, wire.color);
  if (wire.layout === "routed") {
    const path = [startOf(A, ROUTE_Y)];
    for (const q of wire.points ?? []) path.push([q.x, ROUTE_Y, q.y]);
    path.push(startOf(B, ROUTE_Y));
    tip(sb, A, ROUTE_Y);
    tip(sb, B, ROUTE_Y);
    sb.mesh.tube(path, WIRE_RADIUS, color, { sides: 7 });
    return true;
  }
  tip(sb, A, TIP_Y + 0.05);
  tip(sb, B, TIP_Y + 0.05);
  sb.mesh.tube(
    archPoints(startOf(A, TIP_Y), startOf(B, TIP_Y)),
    WIRE_RADIUS,
    color,
    {
      sides: 7,
    },
  );
  return true;
}

/**
 * Add a bus as a ribbon: the collar and spread points are desk/ribbon-path.js's
 * (`ribbonLayout` + `ribbonSpread`, in world px exactly as the desk's wire
 * layer calls them), so member i leaves the cable where the desk shows it
 * leave, and the conductors keep the desk's order — no twist end to end.
 * @returns {Set<string>} the member wires it drew
 */
export function buildBus(sb, doc, bus, wiresById) {
  const drawn = new Set();
  const members = [];
  for (const wid of bus.members) {
    const wire = wiresById.get(wid);
    const A = wire && endOf(doc, wire.from);
    const B = wire && endOf(doc, wire.to);
    members.push(A && B ? { wire, A, B } : null);
  }
  const live = members.filter(Boolean);
  if (live.length === 0) return drawn;
  const px = (end) => ({
    x: end.p[0] * PX_PER_UNIT,
    y: end.p[2] * PX_PER_UNIT,
  });
  const A = centroid(live.map((m) => px(m.A)));
  const B = centroid(live.map((m) => px(m.B)));
  const width = ribbonWidth(bus.members.length);
  const { collarA, collarB } = ribbonLayout(A, B);
  const { spreadA, spreadB } = ribbonSpread(A, B, width, bus.members.length);
  const world = (q) => [q.x / PX_PER_UNIT, RIBBON_Y, q.y / PX_PER_UNIT];
  const cA = world(collarA);
  const cB = world(collarB);
  const trunk = sub(cB, cA);
  const run = length(trunk);
  const dir = normalize(trunk, [1, 0, 0]);
  // Conductors lie side by side across the ribbon's width.
  const radius = Math.min(
    WIRE_RADIUS,
    (width / PX_PER_UNIT / Math.max(1, bus.members.length)) * 0.48,
  );
  const arch = clamp(run * 0.12, 0, 3);
  const steps = clamp(Math.ceil(run), 2, 24);
  members.forEach((m, i) => {
    if (!m) return;
    const sA = spreadA[i] ? world(spreadA[i]) : cA;
    const sB = spreadB[i] ? world(spreadB[i]) : cB;
    const offA = sub(sA, cA);
    const offB = sub(sB, cB);
    // The flat run between the collars, offset to this conductor's place.
    const flat = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const centre = lerp(cA, cB, t);
      centre[1] += arch * 4 * t * (1 - t);
      flat.push(add(centre, lerp(offA, offB, t)));
    }
    // The fan-out at each end: up out of the hole and round into the cable.
    const a0 = startOf(m.A, TIP_Y);
    const b0 = startOf(m.B, TIP_Y);
    const reach = Math.min(1.5, run / 3 + 0.5);
    const leadA = cubicPoints(
      a0,
      [a0[0], RIBBON_Y, a0[2]],
      add(sA, scale(dir, -reach)),
      sA,
      10,
    );
    const leadB = cubicPoints(
      sB,
      add(sB, scale(dir, reach)),
      [b0[0], RIBBON_Y, b0[2]],
      b0,
      10,
    );
    const path = [...leadA, ...flat.slice(1, -1), ...leadB];
    tip(sb, m.A, TIP_Y + 0.05);
    tip(sb, m.B, TIP_Y + 0.05);
    sb.mesh.tube(path, radius, namedColor(sb.palette, m.wire.color), {
      sides: 6,
    });
    drawn.add(m.wire.id);
  });
  return drawn;
}

/**
 * A flag on a pin: a signal's, or one of an Output/Input element's tags — a
 * post in the hole it plugs into and a pennant in its colour, pointing the
 * way the desk draws it (`rot`, a desk rotation).
 */
export function buildFlag(sb, doc, anchor, rot, colorName) {
  const end = endOf(doc, anchor);
  if (!end) return false;
  const [x, , z] = end.p;
  const top = 2.6;
  sb.lead(
    [
      [x, -HOLE_DEPTH, z],
      [x, top, z],
    ],
    0.08,
  );
  const a = ((Number.isFinite(rot) ? rot : 0) * Math.PI) / 180;
  const d = [Math.cos(a), 0, Math.sin(a)];
  const tipPoint = [x + d[0] * 1.7, top - 0.45, z + d[2] * 1.7];
  const side = [-d[2] * 0.05, 0, d[0] * 0.05];
  const color = namedColor(sb.palette, colorName);
  const base = [[x, top, z], tipPoint, [x, top - 0.9, z]];
  sb.mesh.extrude(
    base.map((q) => sub(q, side)),
    scale(side, 2),
    color,
  );
  return true;
}
