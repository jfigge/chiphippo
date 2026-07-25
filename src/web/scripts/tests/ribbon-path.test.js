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

// Tests for the pure ribbon-cable geometry (desk/ribbon-path.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  COLLAR_SETBACK,
  ribbonLayout,
  ribbonSpread,
} from "../desk/ribbon-path.js";

test("ribbonLayout: collars land COLLAR_SETBACK/run of the way in from each end", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 }; // run=400, well over 2x the setback
  const { collarA, collarB, trunk } = ribbonLayout(a, b);
  // x is a plain lerp along the chord (the sag term only ever offsets y).
  assert.equal(collarA.x, COLLAR_SETBACK);
  assert.equal(collarB.x, 400 - COLLAR_SETBACK);
  assert.ok(trunk, "a real body between two distinct collars");
});

test("ribbonLayout: equal-height endpoints keep both collars at equal height", () => {
  const a = { x: 20, y: 50 };
  const b = { x: 300, y: 50 };
  const { collarA, collarB } = ribbonLayout(a, b);
  assert.equal(collarA.y, collarB.y); // the sag bulge is symmetric end to end
  assert.ok(collarA.y > 50 - 1e-9); // sags downward (never upward)
});

test("ribbonLayout: a run shorter than 2x setback collapses both collars together", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 }; // well under 2 * COLLAR_SETBACK
  const { collarA, collarB, trunk } = ribbonLayout(a, b);
  assert.deepEqual(collarA, collarB);
  assert.equal(trunk, null);
});

test("ribbonLayout: a zero-length run doesn't divide by zero", () => {
  const a = { x: 5, y: 5 };
  const { collarA, collarB, trunk } = ribbonLayout(a, { x: 5, y: 5 });
  assert.deepEqual(collarA, collarB);
  assert.ok(Number.isFinite(collarA.x) && Number.isFinite(collarA.y));
  assert.equal(trunk, null);
});

test("ribbonSpread: a single member lands exactly on the collar, both ends", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 };
  const { collarA, collarB } = ribbonLayout(a, b);
  const { spreadA, spreadB } = ribbonSpread(a, b, 20, 1);
  assert.deepEqual(spreadA, [collarA]);
  assert.deepEqual(spreadB, [collarB]);
});

test("ribbonSpread: zero members spreads to nothing", () => {
  const { spreadA, spreadB } = ribbonSpread(
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    20,
    0,
  );
  assert.deepEqual(spreadA, []);
  assert.deepEqual(spreadB, []);
});

test("ribbonSpread: N members land evenly spaced and centered on the collar", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 };
  const { collarA } = ribbonLayout(a, b);
  const width = 21;
  const count = 8;
  const { spreadA } = ribbonSpread(a, b, width, count);
  assert.equal(spreadA.length, count);

  // Consecutive points are equally spaced (width/count apart).
  const step = width / count;
  for (let i = 1; i < spreadA.length; i += 1) {
    const dist = Math.hypot(
      spreadA[i].x - spreadA[i - 1].x,
      spreadA[i].y - spreadA[i - 1].y,
    );
    assert.ok(Math.abs(dist - step) < 1e-9, `gap ${i}: ${dist} vs ${step}`);
  }

  // The whole run is centered on the collar.
  const mean = spreadA.reduce(
    (acc, p) => ({ x: acc.x + p.x / count, y: acc.y + p.y / count }),
    { x: 0, y: 0 },
  );
  assert.ok(Math.abs(mean.x - collarA.x) < 1e-9);
  assert.ok(Math.abs(mean.y - collarA.y) < 1e-9);
});

test("ribbonSpread: bit order runs in REVERSE across the pipe's face", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 };
  const width = 21;
  const count = 8;
  const { spreadA, spreadB } = ribbonSpread(a, b, width, count);
  // a→b points along +x, so the perpendicular the spread runs along is +y.
  // Member 0 takes the FAR side (+width/2) and the last member the near one,
  // i.e. the leads fan out in the reverse of the order the cable carries.
  assert.ok(spreadA[0].y > spreadA[count - 1].y, "member 0 on the +y side");
  for (let i = 1; i < count; i += 1) {
    assert.ok(spreadA[i].y < spreadA[i - 1].y, `A descends at ${i}`);
    assert.ok(spreadB[i].y < spreadB[i - 1].y, `B descends at ${i}`);
  }
  // Same direction at BOTH ends — the cable still doesn't twist.
  for (let i = 0; i < count; i += 1) {
    assert.ok(Math.abs(spreadA[i].y - spreadB[i].y) < 1e-9, `no twist at ${i}`);
  }
});

test("ribbonSpread: a collapsed (too-short) run still spreads to finite points", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 }; // well under 2 * COLLAR_SETBACK
  const { spreadA, spreadB } = ribbonSpread(a, b, 20, 4);
  for (const p of [...spreadA, ...spreadB]) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});
