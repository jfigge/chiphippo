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

// wire-path.js — pure geometry for jumper wires: two world-px endpoints → a
// quadratic bezier that sags gently downward like a real lead. DOM-free and
// tested; WireLayer only applies the returned path strings.
//
// `fadedWire` serves the "fade wires" view toggle: the same curve cut back to
// a short stub at each end, plus the gradient offsets that ramp that stub away
// — the geometry and the fade are derived together so the drawn cut always
// lands where the gradient has already reached zero.
//
// A ROUTED wire (the wire's "Layout Method" property — see model/desk-doc.js's
// WIRE_LAYOUTS) is not a curve at all: it is the straight run through its own
// waypoints, so it gets the `polyline*` half of this file. The two halves are
// deliberately symmetric — a path, a faded pair of stubs, and the length math
// behind both (`wireLength` / `polylineLength`, which is what the wire's own
// Properties dialog dimensions it by) — so WireLayer picks a layout and nothing
// downstream of it cares which it got. `nearestOnPolyline` is the one piece that serves INPUT rather
// than drawing: it is how a press on a routed wire's body learns which of its
// segments it landed on, hence where a new waypoint belongs.

/** Sag as a fraction of the endpoint-to-endpoint run. */
export const SAG_RATIO = 0.12;

/** Sag bounds (world px): short hops barely sag, long runs stay tidy. */
export const SAG_MIN = 3;
export const SAG_MAX = 36;

/**
 * The downward sag (world px) for a wire between two world-px points:
 * proportional to the run length, clamped to [SAG_MIN, SAG_MAX].
 */
export function wireSag(a, b) {
  const run = Math.hypot(b.x - a.x, b.y - a.y);
  return Math.min(SAG_MAX, Math.max(SAG_MIN, run * SAG_RATIO));
}

/**
 * The SVG path for a wire: a quadratic bezier from `a` to `b` whose control
 * point hangs `wireSag` below the midpoint (downward = +y). The curve starts
 * and ends EXACTLY on the endpoints, so caps drawn there always line up.
 *
 * @param {{x:number,y:number}} a - world px
 * @param {{x:number,y:number}} b - world px
 * @returns {string} an SVG `d` attribute
 */
export function wirePath(a, b) {
  const sag = wireSag(a, b);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 + sag;
  return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`;
}

/**
 * The SVG path for a ROUTED wire: straight segments through every point in
 * order (world px, two or more — the two endpoints with any waypoints between
 * them). No sag: a routed wire is placed by hand, so it must go exactly where
 * it was put.
 *
 * @param {Array<{x:number,y:number}>} points
 * @returns {string} an SVG `d` attribute
 */
export function polylinePath(points) {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${r3(p.x)} ${r3(p.y)}`)
    .join(" ");
}

/** The total run length (world px) along a polyline. */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y); // prettier-ignore
  }
  return total;
}

/** How many straight samples `wireLength` measures the curve over. A quadratic
    this shallow (the sag is at most SAG_RATIO of the run) is barely off its own
    chord, so 24 is already finer than the tenth of a millimetre anything reads
    the answer to. */
const LENGTH_SAMPLES = 24;

/**
 * The length (world px) of the sagging curve `wirePath(a, b)` draws —
 * `polylineLength`'s counterpart for the DIRECT layout, so "how long is this
 * wire" is answered about the run on screen rather than about the straight line
 * between its two holes (which is shorter than any real lead spanning them).
 *
 * @param {{x:number,y:number}} a - world px
 * @param {{x:number,y:number}} b - world px
 */
export function wireLength(a, b) {
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + wireSag(a, b) };
  const points = [];
  for (let i = 0; i <= LENGTH_SAMPLES; i += 1) {
    points.push(bezierAt(a, c, b, i / LENGTH_SAMPLES));
  }
  return polylineLength(points);
}

/**
 * Where on a polyline a point lands: the closest point on the closest SEGMENT,
 * as `{ index, point, distance }` — `index` being the segment's own index, so
 * a waypoint inserted at that index falls exactly where the press was. Null
 * for a degenerate (under two points) polyline.
 *
 * @param {Array<{x:number,y:number}>} points - world px
 * @param {{x:number,y:number}} p - world px
 */
export function nearestOnPolyline(points, p) {
  let best = null;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    // The projection onto the segment, clamped to it — a press past either end
    // belongs to that end, not to the infinite line it sits on.
    const t = len2 === 0 ? 0 : (p.x - a.x) * (dx / len2) + (p.y - a.y) * (dy / len2); // prettier-ignore
    const clamped = Math.max(0, Math.min(1, t));
    const point = { x: a.x + dx * clamped, y: a.y + dy * clamped };
    const distance = Math.hypot(p.x - point.x, p.y - point.y);
    if (!best || distance < best.distance) best = { index: i, point, distance };
  }
  return best;
}

/** How far from its hole a faded wire stays FULLY drawn (world px — 10 px is
    one 0.1-in pitch, so this stub is a shade over 3 mm). */
export const FADE_SOLID = 12;

/** How much further it takes to ramp to invisible (world px, ~2.5 mm). */
export const FADE_RAMP = 10;

/** How far from its hole a faded wire is gone altogether. */
export const FADE_REACH = FADE_SOLID + FADE_RAMP;

/** Where the ramp starts, as a fraction of the reach — the one stop position
    every fade circle shares, whatever its radius (WireLayer's gradient). */
export const FADE_SOLID_FRACTION = FADE_SOLID / FADE_REACH;

/** The most of the wire reaching one end the fade may claim: a hair under all
    of it, so the drawn wire always outlasts its own fade and never shows a cut
    edge. Below that the fade shrinks with the wire instead of overrunning it. */
const FADE_MAX_SHARE = 0.9;

/** Never fade over less than this (world px) — a lead can be shorter than a
    cap is wide, and a zero-radius fade would erase it outright. */
const FADE_MIN_RADIUS = 6;

/** How far past its own fade radius a stub is drawn. The cut is invisible (it
    is outside the fade circle), and being generous absorbs the difference
    between distance-from-the-hole and distance-along-a-sagging-curve. */
const FADE_OVERCUT = 1.5;

/** Trim float noise out of a generated path. */
const r3 = (n) => Math.round(n * 1000) / 1000;

const lerp = (p, q, t) => ({
  x: p.x + (q.x - p.x) * t,
  y: p.y + (q.y - p.y) * t,
});

/** The point at parameter `t` on the quadratic through `a`, control `c`, `b`. */
const bezierAt = (a, c, b, t) => lerp(lerp(a, c, t), lerp(c, b, t), t);

/**
 * The radius one faded end fades over, given `available` px of wire running
 * away from that hole: the standard reach, or less when there isn't that much
 * wire to fade over — a bus lead into the ribbon, or a one-hole hop.
 *
 * A fade is a CIRCLE around the hole, not a ramp along the run, which is what
 * lets the wire leave the hole in any direction and still fade cleanly — a bus
 * member keeps its lead aimed at the ribbon, and a wire is simply visible
 * within so many mm of wherever it lands.
 */
export function fadeRadius(available) {
  return Math.max(
    FADE_MIN_RADIUS,
    Math.min(FADE_REACH, available * FADE_MAX_SHARE),
  );
}

/**
 * A faded wire (the "fade wires" view toggle): the same sagging curve cut back
 * to a stub at each end, and the `radius` both ends fade over. The stub always
 * runs past that radius, so its cut edge is already invisible.
 *
 * @param {{x:number,y:number}} a - world px
 * @param {{x:number,y:number}} b - world px
 * @returns {{d: string, radius: number}} `d` is an SVG `d` attribute — two
 *   subpaths, one stub per end, or the whole curve when it is too short to be
 *   worth cutting.
 */
export function fadedWire(a, b) {
  const run = Math.hypot(b.x - a.x, b.y - a.y);
  const radius = fadeRadius(run / 2);
  const t = run > 0 ? (radius * FADE_OVERCUT) / run : 0.5;
  if (t >= 0.5) return { d: wirePath(a, b), radius }; // nothing left to cut
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + wireSag(a, b) };

  // Split the curve at t (head) and at 1 − t (tail), de Casteljau: the head
  // keeps a and its own control point, the tail keeps b and its.
  const head = lerp(a, c, t);
  const headEnd = bezierAt(a, c, b, t);
  const tailStart = bezierAt(a, c, b, 1 - t);
  const tail = lerp(c, b, 1 - t);
  return {
    d:
      `M ${r3(a.x)} ${r3(a.y)} Q ${r3(head.x)} ${r3(head.y)} ` +
      `${r3(headEnd.x)} ${r3(headEnd.y)} ` +
      `M ${r3(tailStart.x)} ${r3(tailStart.y)} Q ${r3(tail.x)} ${r3(tail.y)} ` +
      `${r3(b.x)} ${r3(b.y)}`,
    radius,
  };
}

/**
 * The head of a polyline, cut at `len` px along its own run (always at least
 * the first two points, so a cut shorter than nothing still draws something).
 */
function trimPolyline(points, len) {
  const out = [points[0]];
  let left = len;
  for (let i = 1; i < points.length; i += 1) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y); // prettier-ignore
    if (seg >= left) {
      out.push(lerp(points[i - 1], points[i], seg === 0 ? 0 : left / seg));
      return out;
    }
    out.push(points[i]);
    left -= seg;
  }
  return out;
}

/**
 * A faded ROUTED wire — `fadedWire`'s counterpart for a polyline: the run cut
 * back to a stub at each end, and the `radius` both ends fade over. The cut is
 * measured ALONG the run (so a stub that turns a corner still reaches past its
 * own fade circle) and, as with the curve, always runs past that radius, so its
 * cut edge is already invisible.
 *
 * @param {Array<{x:number,y:number}>} points - world px, two or more
 * @returns {{d: string, radius: number}}
 */
export function fadedPolyline(points) {
  const run = polylineLength(points);
  const radius = fadeRadius(run / 2);
  const cut = radius * FADE_OVERCUT;
  if (run <= cut * 2) return { d: polylinePath(points), radius }; // nothing to cut
  const head = trimPolyline(points, cut);
  const tail = trimPolyline([...points].reverse(), cut).reverse();
  return { d: `${polylinePath(head)} ${polylinePath(tail)}`, radius };
}
