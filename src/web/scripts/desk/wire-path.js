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

/** Below this, a corner is straight enough that rounding it would only add
    float noise to the path (radians). */
const COLLINEAR_EPS = 1e-6;

/**
 * How far a fillet's arc may depart from the corner it is rounding, as a
 * multiple of its own radius. Past this the corner is drawn SHARP.
 *
 * This is not fussiness, it is the difference between rounding a corner and
 * deleting one. A circle tangent to both legs touches them `r / tan(θ/2)` from
 * the apex, which runs away to infinity as the corner sharpens: on a hairpin the
 * tangent points sit right back at the far ends of both legs, and the "rounded"
 * path cuts straight across, throwing away half the wire's length and all of its
 * shape. Bounding the DEVIATION instead of the tangent makes the test purely one
 * of angle — the radius cancels — and it comes out at about 29°, comfortably
 * below anything an orthogonal route produces and comfortably above the fold a
 * hand-placed hairpin makes.
 */
const MAX_APEX_DEVIATION = 3;

/** sin(θ/2) must be at least this for a corner to be worth rounding. */
const MIN_CORNER_SINE = 1 / (MAX_APEX_DEVIATION + 1);

/**
 * One corner's fillet — the circular arc a real lead turns through instead of
 * the mathematically sharp corner a polyline states (Feature 360).
 *
 * A 1.5 mm jumper cannot be folded to a point, so a routed wire drawn with
 * square corners is a picture of something nobody can build. `radius` is the
 * ARC radius; the tangent length it needs is `r / tan(θ/2)` (at a right angle,
 * exactly `r`), clamped to HALF each adjacent segment so two corners sharing a
 * short segment can never eat into each other — the clamp `outlinePath` already
 * applies for the same reason.
 *
 * @returns {{start, end, radius, sweep, tangent, arc}|null} null when the corner
 *   is straight or degenerate, i.e. when there is nothing to round.
 */
function cornerFillet(a, p, b, radius) {
  const l1 = Math.hypot(a.x - p.x, a.y - p.y);
  const l2 = Math.hypot(b.x - p.x, b.y - p.y);
  if (!(l1 > 0) || !(l2 > 0) || !(radius > 0)) return null;
  const u1 = { x: (a.x - p.x) / l1, y: (a.y - p.y) / l1 };
  const u2 = { x: (b.x - p.x) / l2, y: (b.y - p.y) / l2 };
  const cos = Math.min(1, Math.max(-1, u1.x * u2.x + u1.y * u2.y));
  const theta = Math.acos(cos); // the interior angle at p
  if (theta <= COLLINEAR_EPS || theta >= Math.PI - COLLINEAR_EPS) return null;
  if (Math.sin(theta / 2) < MIN_CORNER_SINE) return null; // too sharp to round
  const half = Math.tan(theta / 2);
  const tangent = Math.min(radius / half, l1 / 2, l2 / 2);
  if (!(tangent > 0)) return null;
  // The clamp may have shrunk the tangent, so the radius that actually fits is
  // read back from it rather than assumed.
  const r = tangent * half;
  // Same convention as rect-outline.js: y is down, so a positive cross product
  // of the incoming and outgoing directions is a clockwise turn.
  const inDir = { x: -u1.x, y: -u1.y };
  const sweep = inDir.x * u2.y - inDir.y * u2.x > 0 ? 1 : 0;
  return {
    start: { x: p.x + u1.x * tangent, y: p.y + u1.y * tangent },
    end: { x: p.x + u2.x * tangent, y: p.y + u2.y * tangent },
    radius: r,
    sweep,
    tangent,
    arc: r * (Math.PI - theta),
  };
}

/**
 * `polylinePath` with every corner rounded to `radius` — what an auto-routed
 * wire is actually drawn with.
 *
 * `radius` is in the SAME units as the points (the wire layer works in world
 * px, so it passes `BEND_RADIUS_PX`). A radius of 0 gives the plain polyline
 * back, so a caller that does not care can leave it out.
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {number} [radius]
 * @returns {string} an SVG `d` attribute
 */
export function filletedPolylinePath(points, radius = 0) {
  if (!(radius > 0) || points.length < 3) return polylinePath(points);
  let d = `M ${r3(points[0].x)} ${r3(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const f = cornerFillet(points[i - 1], points[i], points[i + 1], radius);
    if (!f) {
      d += ` L ${r3(points[i].x)} ${r3(points[i].y)}`;
      continue;
    }
    d += ` L ${r3(f.start.x)} ${r3(f.start.y)}`;
    d += ` A ${r3(f.radius)} ${r3(f.radius)} 0 0 ${f.sweep} ${r3(f.end.x)} ${r3(f.end.y)}`; // prettier-ignore
  }
  const last = points[points.length - 1];
  return `${d} L ${r3(last.x)} ${r3(last.y)}`;
}

/**
 * The run length of `filletedPolylinePath` — shorter than the bare polyline,
 * because each rounded corner replaces `2 × tangent` of straight line with an
 * arc of `radius × (π − θ)` (at a right angle, a saving of about 0.43 × the
 * radius).
 *
 * This exists so `model/wire-length.js` can stay THE one measurement: the BOM's
 * cutting list and the wire gauge both quote what is drawn, and a drawing that
 * disagrees with the number beside it is the exact failure that file prevents.
 */
export function filletedPolylineLength(points, radius = 0) {
  let total = polylineLength(points);
  if (!(radius > 0) || points.length < 3) return total;
  for (let i = 1; i < points.length - 1; i += 1) {
    const f = cornerFillet(points[i - 1], points[i], points[i + 1], radius);
    if (f) total += f.arc - 2 * f.tangent;
  }
  return total;
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
 * `bend` is the corner radius the whole wire is drawn with, so a stub that
 * turns a corner inside its own fade is rounded exactly as the rest of the run
 * is — the two halves of one wire must not be drawn to different rules.
 *
 * @param {Array<{x:number,y:number}>} points - world px, two or more
 * @param {number} [bend] - corner radius, world px
 * @returns {{d: string, radius: number}}
 */
export function fadedPolyline(points, bend = 0) {
  const run = polylineLength(points);
  const radius = fadeRadius(run / 2);
  const cut = radius * FADE_OVERCUT;
  const path = (p) => filletedPolylinePath(p, bend);
  if (run <= cut * 2) return { d: path(points), radius }; // nothing to cut
  const head = trimPolyline(points, cut);
  const tail = trimPolyline([...points].reverse(), cut).reverse();
  return { d: `${path(head)} ${path(tail)}`, radius };
}
