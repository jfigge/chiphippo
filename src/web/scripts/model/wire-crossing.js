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
 * Audit a finished document: every wire that runs over a part it does not end
 * on. Used by the compiler to warn, and by tests to hold the routing honest.
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
  const owns = new Map(); // component id → the addresses it occupies
  for (const comp of doc.components ?? []) {
    if (!comp.board) continue;
    const pins = (pinsOf(comp) ?? []).filter((p) => p.address);
    const box = boxOf(pins.map((p) => world(p.address)).filter(Boolean));
    if (!box) continue;
    boxes.set(comp.id, box);
    owns.set(comp.id, new Set(pins.map((p) => p.address)));
  }
  const out = [];
  for (const wire of doc.wires ?? []) {
    const a = world(wire.from);
    const b = world(wire.to);
    if (!a || !b) continue;
    const ends = new Set([ownerOf(wire.from), ownerOf(wire.to)]);
    for (const [id, box] of boxes) {
      // A wire whose end sits inside a body — or on a node that body owns — is
      // attached to it, not over it.
      if (ends.has(id)) continue;
      if (inside(a, box) || inside(b, box)) continue;
      if (!segmentHitsBox(a, b, box)) continue;
      out.push({
        wire: wire.id,
        part: id,
        ref: doc.components.find((c) => c.id === id)?.ref ?? "",
      });
    }
  }
  return out;
}
