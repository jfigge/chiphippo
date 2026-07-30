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

// Tests for the pure wire path math (desk/wire-path.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  FADE_REACH,
  SAG_MAX,
  SAG_MIN,
  SAG_RATIO,
  fadeRadius,
  fadedPolyline,
  fadedWire,
  nearestOnPolyline,
  polylineLength,
  polylinePath,
  wireLength,
  wirePath,
  wireSag,
} from "../desk/wire-path.js";

const PATH_RE =
  /^M (-?[\d.]+) (-?[\d.]+) Q (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/;

/** Both subpaths of a faded wire: `M a Q c1 e1 M s2 Q c2 b`. */
const STUBS_RE = new RegExp(
  `^M (-?[\\d.]+) (-?[\\d.]+) Q (-?[\\d.]+) (-?[\\d.]+) (-?[\\d.]+) (-?[\\d.]+) ` +
    `M (-?[\\d.]+) (-?[\\d.]+) Q (-?[\\d.]+) (-?[\\d.]+) (-?[\\d.]+) (-?[\\d.]+)$`,
);

const dist = (p, q) => Math.hypot(q.x - p.x, q.y - p.y);

test("wireSag: proportional in the middle, clamped at both ends", () => {
  const a = { x: 0, y: 0 };
  // Short hop → SAG_MIN.
  assert.equal(wireSag(a, { x: 10, y: 0 }), SAG_MIN);
  // Mid-length run → proportional.
  assert.equal(wireSag(a, { x: 100, y: 0 }), 100 * SAG_RATIO);
  // Cross-desk run → SAG_MAX.
  assert.equal(wireSag(a, { x: 2000, y: 0 }), SAG_MAX);
  // Monotonic between the clamps.
  assert.ok(wireSag(a, { x: 200, y: 0 }) > wireSag(a, { x: 100, y: 0 }));
});

test("wirePath: starts and ends EXACTLY on the endpoints", () => {
  const a = { x: 12.5, y: -30 };
  const b = { x: 480, y: 220 };
  const m = PATH_RE.exec(wirePath(a, b));
  assert.ok(m, "path shape is a single quadratic bezier");
  assert.equal(Number(m[1]), a.x);
  assert.equal(Number(m[2]), a.y);
  assert.equal(Number(m[5]), b.x);
  assert.equal(Number(m[6]), b.y);
});

test("wirePath: the control point hangs sag below the midpoint", () => {
  const a = { x: 0, y: 100 };
  const b = { x: 300, y: 100 };
  const m = PATH_RE.exec(wirePath(a, b));
  assert.equal(Number(m[3]), 150); // mid x
  assert.equal(Number(m[4]), 100 + wireSag(a, b)); // downward = +y
});

test("fadedWire: two stubs, still anchored on the endpoints", () => {
  const a = { x: 20, y: -40 };
  const b = { x: 420, y: 160 };
  const { d, radius } = fadedWire(a, b);
  const m = STUBS_RE.exec(d);
  assert.ok(m, `two quadratic subpaths: ${d}`);
  // The near stub starts exactly on `a`, the far one ends exactly on `b` —
  // the caps are drawn there and must still line up.
  assert.equal(Number(m[1]), a.x);
  assert.equal(Number(m[2]), a.y);
  assert.equal(Number(m[11]), b.x);
  assert.equal(Number(m[12]), b.y);
  // A long run fades over the full standard reach.
  assert.equal(radius, FADE_REACH);
});

test("fadedWire: every stub outruns its own fade circle", () => {
  // The invariant the mask relies on: the cut edge is already outside the
  // circle that fades that end, so it never shows — whichever way the wire
  // runs, and however the sag bends it away from the straight line.
  for (const b of [
    { x: 400, y: 0 }, // level
    { x: 400, y: 300 }, // downhill
    { x: 400, y: -300 }, // uphill
    { x: 0, y: -400 }, // straight up: the sag runs along the wire itself
    { x: -260, y: 90 }, // right to left
    { x: 60, y: 0 }, // short enough for the fade to shrink
  ]) {
    const a = { x: 0, y: 0 };
    const { d, radius } = fadedWire(a, b);
    const m = STUBS_RE.exec(d);
    if (!m) continue; // too short to cut at all — drawn whole
    const headEnd = { x: Number(m[5]), y: Number(m[6]) };
    const tailStart = { x: Number(m[7]), y: Number(m[8]) };
    assert.ok(
      dist(a, headEnd) > radius,
      `cut at ${dist(a, headEnd)} inside r=${radius} for ${JSON.stringify(b)}`,
    );
    assert.ok(dist(b, tailStart) > radius, JSON.stringify(b));
  }
});

test("fadeRadius: the standard reach, shrunk when there is less wire", () => {
  assert.equal(fadeRadius(100), FADE_REACH); // plenty of wire
  assert.equal(fadeRadius(20), 18); // 90% of what runs off this end
  assert.ok(fadeRadius(0) > 0, "a degenerate lead is never erased outright");
});

test("fadedWire: a short hop keeps its whole curve, faded from both ends", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 }; // one hole over — nothing worth cutting
  const { d, radius } = fadedWire(a, b);
  assert.ok(PATH_RE.exec(d), `one unbroken curve: ${d}`);
  assert.ok(radius < FADE_REACH, "and it fades over less than the full reach");
});

// ── Routed wires: the straight run through a wire's own waypoints ───────────

test("polylinePath: one move + a line per following point, rounded", () => {
  assert.equal(
    polylinePath([
      { x: 0, y: 0 },
      { x: 10, y: 20 },
      { x: 30, y: 20 },
    ]),
    "M 0 0 L 10 20 L 30 20",
  );
  assert.equal(
    polylinePath([
      { x: 1.00049, y: 0 },
      { x: 2, y: 3 },
    ]),
    "M 1 0 L 2 3",
    "float noise is trimmed, as the curve's own path is",
  );
});

test("polylineLength: the sum of its segments", () => {
  assert.equal(
    polylineLength([
      { x: 0, y: 0 },
      { x: 30, y: 40 }, // 50
      { x: 30, y: 60 }, // 20
    ]),
    70,
  );
  assert.equal(polylineLength([{ x: 5, y: 5 }]), 0, "a lone point runs zero");
});

test("wireLength: the sagging curve, always longer than its own chord", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 200, y: 0 };
  const chord = dist(a, b);
  const run = wireLength(a, b);
  assert.ok(run > chord, `${run} > ${chord}: a lead spans more than the gap`);
  // A 200 px run sags 24 px (SAG_RATIO), a shallow parabola — a few percent
  // over the chord, nowhere near the 2 × sag a triangle through the control
  // point would give.
  assert.ok(run < chord * 1.1, `${run} is a sag, not a detour`);
  const triangle = 2 * Math.hypot(chord / 2, wireSag(a, b));
  assert.ok(run < triangle, "the curve cuts inside its control polygon");

  // Symmetric, and blind to which way round the desk the run goes.
  assert.equal(run, wireLength(b, a));
  assert.equal(run, wireLength({ x: 0, y: 50 }, { x: -200, y: 50 }));

  // Two holes in one place still have SAG_MIN of wire hanging between them.
  const nowhere = wireLength(a, a);
  assert.ok(nowhere > 0 && nowhere <= 2 * SAG_MIN, `${nowhere}`);
});

test("nearestOnPolyline: the closest point, and WHICH segment it belongs to", () => {
  const run = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
  ];
  const first = nearestOnPolyline(run, { x: 40, y: 8 });
  assert.equal(first.index, 0, "over the first segment");
  assert.deepEqual(first.point, { x: 40, y: 0 });
  assert.equal(first.distance, 8);

  const second = nearestOnPolyline(run, { x: 92, y: 70 });
  assert.equal(second.index, 1, "over the second");
  assert.deepEqual(second.point, { x: 100, y: 70 });

  // Past an end belongs to that end, not to the infinite line through it.
  const beyond = nearestOnPolyline(run, { x: -30, y: 0 });
  assert.deepEqual(beyond.point, { x: 0, y: 0 });
  assert.equal(beyond.distance, 30);

  assert.equal(nearestOnPolyline([{ x: 0, y: 0 }], { x: 0, y: 0 }), null);
});

test("fadedPolyline: cut ALONG the run, past its own fade radius", () => {
  // A long L: both stubs are cut well before the corner.
  const run = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 300 },
  ];
  const { d, radius } = fadedPolyline(run);
  const subpaths = d.split("M ").filter(Boolean);
  assert.equal(subpaths.length, 2, `one stub per end: ${d}`);
  assert.equal(radius, FADE_REACH, "plenty of wire to fade over");
  // Each stub starts exactly on its own end and outlasts the fade circle.
  assert.ok(d.startsWith("M 0 0 L "), d);
  assert.ok(d.endsWith("L 300 300"), d);
  const headEnd = { x: Number(subpaths[0].trim().split(/[ L]+/)[2]), y: 0 };
  assert.ok(dist({ x: 0, y: 0 }, headEnd) > radius, "the cut is invisible");
});

test("fadedPolyline: a short run keeps its whole shape, corner and all", () => {
  const run = [
    { x: 0, y: 0 },
    { x: 6, y: 0 },
    { x: 6, y: 6 },
  ];
  const { d } = fadedPolyline(run);
  assert.equal(d, polylinePath(run), "nothing left to cut");
});
