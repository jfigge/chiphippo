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

// wire-crossing.js — does this wire run over that part?
//
// A generated layout can be short and still unreadable, because "short" says
// nothing about what a wire passes OVER. On a real bench you route around a
// chip; a compiler that only minimises length will happily lay a wire straight
// across three of them, and the result is a circuit nobody can trace with a
// finger — which is most of what these boards are for.
//
// The geometry that makes this tractable: parts sit in known ROWS, and so do
// wires. A DIP straddles the trench with its pins in rows e and f, so its body
// is a band across the middle; everything else the compiler seats — a resistor
// network, an LED bar — lies along row a. A wire attaches not to a pin but to
// a free hole on that pin's NODE, and a lower-half node offers rows a–e. So
// the row a wire attaches at decides what it flies over, and the cheapest
// possible fix is to attach at row b, c or d rather than row a, where all the
// discretes live. That choice is worth at most four pitch of extra length and
// routinely saves a wire from crossing a part outright.
//
// Pure and DOM-free: boxes in, hit tests out. `autobuild.js` uses it while
// choosing holes; a caller with a finished document can use `wireCrossings` to
// audit one.

import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { wireSag } from "../desk/wire-path.js";

/** A part's body as an axis-aligned box, from the points it occupies. */
export function boxOf(points, margin = 0.45) {
  if (!points?.length) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x0: Math.min(...xs) - margin,
    x1: Math.max(...xs) + margin,
    y0: Math.min(...ys) - margin,
    y1: Math.max(...ys) + margin,
  };
}

const inside = (p, b) =>
  p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

/**
 * Does the segment `a`→`b` touch the box?
 *
 * Liang–Barsky clipping rather than sampling along the segment: sampling misses
 * a box the wire only clips the corner of, and the near-misses are exactly the
 * cases worth getting right — a wire grazing a chip reads as crossing it.
 */
export function segmentHitsBox(a, b, box) {
  if (!a || !b || !box) return false;
  if (inside(a, box) || inside(b, box)) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - box.x0, box.x1 - a.x, a.y - box.y0, box.y1 - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false; // parallel and outside this slab
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return true;
}

/**
 * How many of `boxes` the segment runs over.
 *
 * `skip` names the parts the wire legitimately TERMINATES on — its own ends —
 * because a lead leaving a resistor network necessarily starts inside that
 * network's own body, and counting it would make every part cross itself.
 *
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {Iterable<[string, object]>} boxes  id → box
 * @param {Set<string>} [skip]
 */
export function crossingCount(a, b, boxes, skip) {
  let n = 0;
  for (const [id, box] of boxes) {
    if (skip?.has(id)) continue;
    if (segmentHitsBox(a, b, box)) n++;
  }
  return n;
}

/**
 * The wire `a`→`b` as it is DRAWN, as a polyline (pitch units): the sagging
 * quadratic of `desk/wire-path.js`, whose control point hangs `wireSag` below
 * the chord's midpoint. A long run hangs a pitch or two below its chord, which
 * is enough to carry it across the row of parts beneath — the very thing a
 * straight-chord test cannot see.
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {number} [steps]
 * @returns {Array<{x:number,y:number}>}
 */
export function drawnWire(a, b, steps = 12) {
  const sag =
    wireSag(
      { x: a.x * PX_PER_UNIT, y: a.y * PX_PER_UNIT },
      { x: b.x * PX_PER_UNIT, y: b.y * PX_PER_UNIT },
    ) / PX_PER_UNIT;
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + sag };
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push({
      x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    });
  }
  return out;
}

/** Does the wire as DRAWN (a `drawnWire` polyline) cross the box? */
function drawnHitsBox(line, box) {
  for (let i = 1; i < line.length; i++) {
    if (segmentHitsBox(line[i - 1], line[i], box)) return true;
  }
  return false;
}

/**
 * How many parts the wire `a`→`b` is DRAWN over — `crossingCount` along the
 * curve as drawn (`drawnWire`), sag and all, because a run that clears a row of
 * parts as a chord can still hang down across it, and a wire is drawn ABOVE the
 * parts. A part is excused while an end of the wire lies inside its body —
 * that is attachment — and so is any part named in `excused`. The compiler's
 * router names none: a lead from beside a part back across it (a switch's
 * supply lead over its own knob) is drawn over it all the same. Its report of
 * residual crossings excuses the parts a wire ends on, as `wireCrossings` does.
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {Iterable<[string, object]>} boxes  id → box
 * @param {Set<string>} [excused]
 */
export function drawnCrossings(a, b, boxes, excused) {
  const line = drawnWire(a, b);
  let n = 0;
  for (const [id, box] of boxes) {
    if (excused?.has(id)) continue;
    if (inside(a, box) || inside(b, box)) continue;
    if (drawnHitsBox(line, box)) n++;
  }
  return n;
}

/**
 * Audit a finished document: every wire DRAWN over a part it does not end on —
 * the compiler's own warning rule, for tests to hold the routing honest.
 *
 * `ownerOf` names the part an address BELONGS to — the one whose node it sits
 * on, not merely whose body it falls inside. Without it a lead leaving a
 * resistor network from the row above its pins reads as flying over the
 * network, which is the one thing it certainly is not doing.
 *
 * @param {object} doc            a normalized desk document
 * @param {(address:string) => ({x:number,y:number}|null)} world
 * @param {(comp:object) => Array<{address:string|null}>} pinsOf
 * @param {(address:string) => (string|null)} [ownerOf]
 * @returns {Array<{wire:string, part:string, ref:string}>}
 */
export function wireCrossings(doc, world, pinsOf, ownerOf = () => null) {
  const boxes = new Map();
  for (const comp of doc.components ?? []) {
    if (!comp.board) continue;
    const pins = (pinsOf(comp) ?? []).filter((p) => p.address);
    const box = boxOf(pins.map((p) => world(p.address)).filter(Boolean));
    if (!box) continue;
    boxes.set(comp.id, box);
  }
  const out = [];
  for (const wire of doc.wires ?? []) {
    const a = world(wire.from);
    const b = world(wire.to);
    if (!a || !b) continue;
    const ends = new Set([ownerOf(wire.from), ownerOf(wire.to)]);
    const line = drawnWire(a, b);
    for (const [id, box] of boxes) {
      // A wire whose end sits inside a body — or on a node that body owns — is
      // attached to it, not over it.
      if (ends.has(id)) continue;
      if (inside(a, box) || inside(b, box)) continue;
      if (!drawnHitsBox(line, box)) continue;
      out.push({
        wire: wire.id,
        part: id,
        ref: doc.components.find((c) => c.id === id)?.ref ?? "",
      });
    }
  }
  return out;
}
