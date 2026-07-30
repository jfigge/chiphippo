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

// ribbon-path.js — pure geometry for a bus's ribbon-cable rendering: given
// the centroid of a bundle's `from` holes and the centroid of its `to` holes,
// where does the flat ribbon body end and its individual leads flare out?
// Real IDC ribbon cable stays flat right up to a short "collar" near each
// connector, then each conductor splits off to its own pin — WireLayer draws
// the trunk between the two collars and, per member wire, a short lead from
// its own collar out to its own actual hole (desk/wire-path.js sag math both
// ends). DOM-free and tested; WireLayer only applies the returned points/path.
//
// `busEndHandleNear` answers the same geometry's other consumer: WireTools'
// per-wire endpoint drag needs to know, at pointerdown, whether the click is
// close enough to a bus's own end-handle collar that the handle should win
// instead (see wire-tools.js — measured, not hypothetical: an 8-bit bus can
// park a collar within a couple of screen px of one member's own hole, since
// the collar is a fixed offset from the CENTROID, not from any member).

import { wirePath, wireSag } from "./wire-path.js";

/** How far (world px) a collar sits back from the bundle's true endpoint. */
export const COLLAR_SETBACK = 16;

/**
 * A ribbon's drawn width (world px), scaled modestly with bit count. Every
 * consumer of the pipe's width takes it from here — WireLayer's leads spread
 * across it and its visible body is drawn to it, and model/wire-length.js
 * measures a member's lead against the same spread — so nothing can disagree
 * about how wide the pipe reads.
 */
export function ribbonWidth(memberCount) {
  return Math.max(8, Math.min(24, 5 + memberCount));
}

/** An end handle's invisible grab radius (world px) — WireLayer draws the
    matching hit circle at this same radius; keep the two in lockstep. */
export const HANDLE_HIT_RADIUS = 6;

/** The average of a non-empty list of world-px points. */
export function centroid(points) {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), {
    x: 0,
    y: 0,
  });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** The quadratic bezier's own control point for `wirePath(a, b)`. */
function controlPoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + wireSag(a, b) };
}

/** The point at bezier parameter `t` along `wirePath(a, b)`. */
function pointAt(a, b, t) {
  const c = controlPoint(a, b);
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

/** The (unnormalized) tangent of `wirePath(a, b)` at parameter `t`, pointing
    in the direction of increasing `t` (from `a` toward `b`). */
function tangentAt(a, b, t) {
  const c = controlPoint(a, b);
  const u = 1 - t;
  return {
    x: 2 * u * (c.x - a.x) + 2 * t * (b.x - c.x),
    y: 2 * u * (c.y - a.y) + 2 * t * (b.y - c.y),
  };
}

/** How far in (0, 0.5] a collar sits from each end, as a bezier parameter —
    shared by ribbonLayout and ribbonSpread so they always agree on WHERE a
    collar is, not just how it's drawn. */
function collarParam(a, b) {
  const run = Math.hypot(b.x - a.x, b.y - a.y);
  return run > 0 ? Math.min(0.5, COLLAR_SETBACK / run) : 0.5;
}

/**
 * The ribbon layout between a bundle's `from` centroid `a` and `to` centroid
 * `b`: the two collar points (pulled back `COLLAR_SETBACK` from each end, or
 * collapsed together for a run shorter than twice that) and the trunk path
 * between them. `trunk` is null when the collars coincide — too short a run
 * to show a flat body, so the caller should fall back to drawing only leads.
 *
 * @param {{x:number,y:number}} a - world px
 * @param {{x:number,y:number}} b - world px
 * @returns {{ collarA:{x,y}, collarB:{x,y}, trunk:string|null }}
 */
export function ribbonLayout(a, b) {
  const t = collarParam(a, b);
  const collarA = pointAt(a, b, t);
  const collarB = pointAt(a, b, 1 - t);
  const collapsed = collarA.x === collarB.x && collarA.y === collarB.y;
  return {
    collarA,
    collarB,
    trunk: collapsed ? null : wirePath(collarA, collarB),
  };
}

/**
 * `count` points evenly spread across `width` world px, perpendicular to the
 * ribbon's own local direction at bezier parameter `t`, centered on the
 * point AT that parameter (the SAME collar `ribbonLayout` returns for the
 * matching end — `collarParam` guarantees the two agree).
 *
 * Bit order runs the OTHER way along the pipe's face than it does across the
 * holes: member 0 takes the +width/2 side, the last member -width/2. So the
 * fan of leads reads in the reverse of the order the cable carries them.
 * Whatever the order, it is the SAME at both ends — the perpendicular is
 * always taken relative to the tangent's fixed a→b direction (never flipped
 * per end) and the index mapping is shared, so a real ribbon cable's "no
 * twist" still holds. Each member's own HOLE is untouched by any of this;
 * only where its lead leaves the pipe changes.
 *
 * Falls back to a horizontal spread when the tangent degenerates (a run
 * collapsed to a single point).
 */
function spreadAt(a, b, t, width, count) {
  if (count <= 0) return [];
  const center = pointAt(a, b, t);
  const d = tangentAt(a, b, t);
  const len = Math.hypot(d.x, d.y);
  const nx = len > 0 ? -d.y / len : 1;
  const ny = len > 0 ? d.x / len : 0;
  const step = width / count;
  const start = -width / 2 + step / 2;
  const points = [];
  for (let i = 0; i < count; i += 1) {
    const offset = start + (count - 1 - i) * step;
    points.push({ x: center.x + nx * offset, y: center.y + ny * offset });
  }
  return points;
}

/**
 * The `count` member leads' attachment points at each collar, evenly spread
 * across `width` world px (typically the ribbon's own drawn width) instead
 * of all converging to one point — a real IDC ribbon cable's conductors run
 * side by side right up to the connector. They are laid out in REVERSE bit
 * order across the pipe's face (member 0 last), the same way at both ends;
 * see spreadAt for that and for the "no twist" guarantee.
 *
 * @param {{x:number,y:number}} a - world px, the bundle's `from` centroid
 * @param {{x:number,y:number}} b - world px, the bundle's `to` centroid
 * @param {number} width - world px
 * @param {number} count - member count
 * @returns {{ spreadA:{x,y}[], spreadB:{x,y}[] }}
 */
export function ribbonSpread(a, b, width, count) {
  const t = collarParam(a, b);
  return {
    spreadA: spreadAt(a, b, t, width, count),
    spreadB: spreadAt(a, b, 1 - t, width, count),
  };
}

/**
 * Which end handle (if either) sits within `radius` of `point` — the SAME
 * collar geometry WireLayer renders the handles at, derived fresh from the
 * bundle's own resolved member endpoints rather than threading the collar
 * points through. `froms`/`tos` are every member's own `from`/`to` world-px
 * point; empty on either side (no member currently resolves) reads as no
 * bus geometry at all. Ties go to `"from"`.
 *
 * @param {{x:number,y:number}[]} froms - world px
 * @param {{x:number,y:number}[]} tos - world px
 * @param {{x:number,y:number}} point - world px
 * @param {number} radius - world px
 * @returns {"from"|"to"|null}
 */
export function busEndHandleNear(froms, tos, point, radius) {
  if (froms.length === 0 || tos.length === 0) return null;
  const { collarA, collarB } = ribbonLayout(centroid(froms), centroid(tos));
  const distA = Math.hypot(point.x - collarA.x, point.y - collarA.y);
  const distB = Math.hypot(point.x - collarB.x, point.y - collarB.y);
  if (distA <= radius && distA <= distB) return "from";
  if (distB <= radius) return "to";
  return null;
}
