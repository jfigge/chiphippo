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
  SAG_MAX,
  SAG_MIN,
  SAG_RATIO,
  wirePath,
  wireSag,
} from "../desk/wire-path.js";

const PATH_RE =
  /^M (-?[\d.]+) (-?[\d.]+) Q (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/;

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
