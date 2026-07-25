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
  fadedWire,
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
