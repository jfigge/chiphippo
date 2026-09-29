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

// Tests for the pure union-boundary math (desk/rect-outline.js).

import test from "node:test";
import assert from "node:assert/strict";

import { outlinePath, unionOutline } from "../desk/rect-outline.js";

const rect = (x, y, width, height) => ({ x, y, width, height });

/** The ring's bounding box, for shape assertions. */
function bbox(ring) {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

test("unionOutline: nothing to trace", () => {
  assert.deepEqual(unionOutline([]), []);
  assert.deepEqual(unionOutline([rect(0, 0, 0, 10)]), []);
});

test("unionOutline: one rect is its four corners", () => {
  const [ring] = unionOutline([rect(10, 20, 100, 50)]);
  assert.equal(ring.length, 4);
  assert.deepEqual(bbox(ring), { x: 10, y: 20, right: 110, bottom: 70 });
});

test("unionOutline: a margin grows the box on every side", () => {
  const [ring] = unionOutline([rect(10, 20, 100, 50)], 3);
  assert.deepEqual(bbox(ring), { x: 7, y: 17, right: 113, bottom: 73 });
});

test("unionOutline: flush strips trace as ONE seamless rectangle", () => {
  // A breadboard kit: rail, pin-board, rail — stacked flush, same width.
  const rings = unionOutline([
    rect(0, 0, 100, 10),
    rect(0, 10, 100, 40),
    rect(0, 50, 100, 10),
  ]);
  assert.equal(rings.length, 1);
  // Four corners only: no seam points survive along the joins.
  assert.equal(rings[0].length, 4);
  assert.deepEqual(bbox(rings[0]), { x: 0, y: 0, right: 100, bottom: 60 });
});

test("unionOutline: overlapping strips still trace as one ring", () => {
  const rings = unionOutline([rect(0, 0, 100, 30), rect(0, 20, 100, 30)]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 4);
  assert.deepEqual(bbox(rings[0]), { x: 0, y: 0, right: 100, bottom: 50 });
});

test("unionOutline: an L-shaped set keeps its concave corner", () => {
  // A short rail beside a tall pin-board — the union is not a rectangle.
  const rings = unionOutline([rect(0, 0, 100, 100), rect(100, 0, 50, 40)]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 6); // 5 convex + 1 reflex corner
  assert.deepEqual(bbox(rings[0]), { x: 0, y: 0, right: 150, bottom: 100 });
  assert.ok(
    rings[0].some((p) => p.x === 100 && p.y === 40),
    "the reflex corner is on the ring",
  );
});

test("unionOutline: detached groups trace as separate rings", () => {
  const rings = unionOutline([rect(0, 0, 10, 10), rect(50, 50, 10, 10)]);
  assert.equal(rings.length, 2);
  const boxes = rings.map(bbox).sort((a, b) => a.x - b.x);
  assert.deepEqual(boxes[0], { x: 0, y: 0, right: 10, bottom: 10 });
  assert.deepEqual(boxes[1], { x: 50, y: 50, right: 60, bottom: 60 });
});

test("unionOutline: a hole in the set becomes its own ring", () => {
  // Four strips around an empty middle.
  const rings = unionOutline([
    rect(0, 0, 30, 10),
    rect(0, 20, 30, 10),
    rect(0, 10, 10, 10),
    rect(20, 10, 10, 10),
  ]);
  assert.equal(rings.length, 2);
  const boxes = rings.map(bbox).sort((a, b) => b.right - a.right);
  assert.deepEqual(boxes[0], { x: 0, y: 0, right: 30, bottom: 30 });
  assert.deepEqual(boxes[1], { x: 10, y: 10, right: 20, bottom: 20 });
});

test("unionOutline: rings run interior-on-the-right (clockwise on screen)", () => {
  const [ring] = unionOutline([rect(0, 0, 10, 20)]);
  // Shoelace with y down: a negative signed area is clockwise on screen.
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  assert.ok(area > 0, "signed area is positive with y running down");
});

test("outlinePath: a square path, closed", () => {
  const d = outlinePath(unionOutline([rect(0, 0, 10, 10)]));
  assert.equal(d, "M 0 0 L 10 0 L 10 10 L 0 10 Z");
});

test("outlinePath: rounding replaces every corner with an arc", () => {
  const d = outlinePath(unionOutline([rect(0, 0, 100, 100)]), 8);
  assert.equal((d.match(/A /g) ?? []).length, 4);
  assert.ok(d.startsWith("M 0 8"), `unexpected start: ${d}`);
  assert.ok(d.endsWith("Z"));
  assert.ok(!d.includes("NaN"));
});

test("outlinePath: the radius clamps to half the shortest run", () => {
  // A 6-wide strip cannot take a radius of 20 — corners must not overshoot.
  const d = outlinePath(unionOutline([rect(0, 0, 6, 100)]), 20);
  assert.ok(d.includes("A 3 3"), `radius not clamped: ${d}`);
});

test("outlinePath: nothing in, nothing out", () => {
  assert.equal(outlinePath([]), "");
  assert.equal(outlinePath(unionOutline([])), "");
});
