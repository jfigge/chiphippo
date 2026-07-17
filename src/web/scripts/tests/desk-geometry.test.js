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

// Tests for the pure desk camera math (desk/desk-geometry.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  GRID_COARSE_BELOW_ZOOM,
  GRID_COARSE_STEP,
  GRID_HIDE_BELOW_ZOOM,
  PX_PER_UNIT,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampZoom,
  gridForCamera,
  normalizeCamera,
  panBy,
  roundTransform,
  screenToWorld,
  stepZoom,
  surfaceTransform,
  wheelZoom,
  worldToScreen,
  zoomAboutPoint,
} from "../desk/desk-geometry.js";

const VIEWPORT = { width: 1200, height: 700 };

function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) < epsilon,
    `expected ${actual} ≈ ${expected}`,
  );
}

// ── clampZoom / stepZoom / wheelZoom ─────────────────────────────────────────

test("clampZoom: clamps to [ZOOM_MIN, ZOOM_MAX] and defaults junk to 1", () => {
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  assert.equal(clampZoom(99), ZOOM_MAX);
  assert.equal(clampZoom(1.5), 1.5);
  assert.equal(clampZoom(NaN), 1);
  assert.equal(clampZoom(undefined), 1);
  assert.equal(clampZoom(Infinity), 1);
});

test("stepZoom: exponential steps that compose and clamp", () => {
  approx(stepZoom(1, 1), ZOOM_STEP);
  approx(stepZoom(ZOOM_STEP, -1), 1);
  approx(stepZoom(1, 3), ZOOM_STEP ** 3);
  assert.equal(stepZoom(ZOOM_MAX, 1), ZOOM_MAX);
  assert.equal(stepZoom(ZOOM_MIN, -1), ZOOM_MIN);
});

test("wheelZoom: negative deltaY zooms in, positive zooms out, clamps", () => {
  assert.ok(wheelZoom(1, -100) > 1);
  assert.ok(wheelZoom(1, 100) < 1);
  approx(wheelZoom(1, 0), 1);
  assert.equal(wheelZoom(ZOOM_MAX, -10000), ZOOM_MAX);
  assert.equal(wheelZoom(ZOOM_MIN, 10000), ZOOM_MIN);
});

// ── normalizeCamera ──────────────────────────────────────────────────────────

test("normalizeCamera: passes a valid camera through", () => {
  assert.deepEqual(normalizeCamera({ cx: 3, cy: -4, zoom: 2 }), {
    cx: 3,
    cy: -4,
    zoom: 2,
  });
});

test("normalizeCamera: junk falls back to the origin at 100%", () => {
  const home = { cx: 0, cy: 0, zoom: 1 };
  assert.deepEqual(normalizeCamera(null), home);
  assert.deepEqual(normalizeCamera("nope"), home);
  assert.deepEqual(normalizeCamera({ cx: "a", cy: NaN, zoom: 0 }), {
    cx: 0,
    cy: 0,
    zoom: ZOOM_MIN,
  });
});

// ── world ↔ screen round-trips ───────────────────────────────────────────────

test("worldToScreen/screenToWorld: the camera center maps to the viewport center", () => {
  const cam = { cx: 12.5, cy: -3, zoom: 1.7 };
  const s = worldToScreen(cam, VIEWPORT, { x: 12.5, y: -3 });
  approx(s.x, VIEWPORT.width / 2);
  approx(s.y, VIEWPORT.height / 2);
});

test("worldToScreen ∘ screenToWorld round-trips", () => {
  const cam = { cx: -20, cy: 33, zoom: 0.4 };
  for (const p of [
    { x: 0, y: 0 },
    { x: 640, y: 17 },
    { x: -55.5, y: 981 },
  ]) {
    const w = screenToWorld(cam, VIEWPORT, p);
    const back = worldToScreen(cam, VIEWPORT, w);
    approx(back.x, p.x);
    approx(back.y, p.y);
  }
});

test("worldToScreen: scales by PX_PER_UNIT × zoom", () => {
  const cam = { cx: 0, cy: 0, zoom: 2 };
  const s = worldToScreen(cam, VIEWPORT, { x: 1, y: 0 });
  approx(s.x - VIEWPORT.width / 2, PX_PER_UNIT * 2);
});

// ── surfaceTransform ─────────────────────────────────────────────────────────

test("surfaceTransform: the world origin lands at (tx, ty)", () => {
  const cam = { cx: 7, cy: -2, zoom: 1.3 };
  const t = surfaceTransform(cam, VIEWPORT);
  const s = worldToScreen(cam, VIEWPORT, { x: 0, y: 0 });
  approx(t.tx, s.x);
  approx(t.ty, s.y);
  assert.equal(t.scale, cam.zoom);
});

test("roundTransform: rounds the translation to device pixels only", () => {
  const t = roundTransform({ tx: 10.26, ty: -3.4, scale: 1.37 }, 2);
  assert.equal(t.tx, 10.5);
  assert.equal(t.ty, -3.5);
  assert.equal(t.scale, 1.37);
  // Junk DPR falls back to 1.
  assert.equal(roundTransform({ tx: 1.4, ty: 0, scale: 1 }, NaN).tx, 1);
});

// ── panBy ────────────────────────────────────────────────────────────────────

test("panBy: the world follows the pointer exactly", () => {
  const cam = { cx: 5, cy: 5, zoom: 2 };
  // The world point under a screen point before the pan…
  const anchorScreen = { x: 300, y: 200 };
  const before = screenToWorld(cam, VIEWPORT, anchorScreen);
  // …must appear dx/dy px further along after panBy(dx, dy).
  const panned = panBy(cam, 40, -25);
  const after = worldToScreen(panned, VIEWPORT, before);
  approx(after.x, anchorScreen.x + 40);
  approx(after.y, anchorScreen.y - 25);
  assert.equal(panned.zoom, cam.zoom);
});

// ── zoomAboutPoint ───────────────────────────────────────────────────────────

test("zoomAboutPoint: the anchor's world point stays fixed on screen", () => {
  let cam = { cx: 0, cy: 0, zoom: 1 };
  const anchor = { x: 150, y: 620 }; // arbitrary off-center screen point
  const anchorWorld = screenToWorld(cam, VIEWPORT, anchor);
  for (const z of [1.3, 2.9, 0.5, ZOOM_MAX, ZOOM_MIN]) {
    cam = zoomAboutPoint(cam, VIEWPORT, anchor, z);
    assert.equal(cam.zoom, z);
    const s = worldToScreen(cam, VIEWPORT, anchorWorld);
    approx(s.x, anchor.x);
    approx(s.y, anchor.y);
  }
});

test("zoomAboutPoint: clamps the requested zoom", () => {
  const cam = zoomAboutPoint(
    { cx: 0, cy: 0, zoom: 1 },
    VIEWPORT,
    { x: 0, y: 0 },
    999,
  );
  assert.equal(cam.zoom, ZOOM_MAX);
});

test("zoomAboutPoint: a center anchor keeps the camera center", () => {
  const center = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
  const cam = zoomAboutPoint({ cx: 8, cy: -1, zoom: 1 }, VIEWPORT, center, 2.5);
  approx(cam.cx, 8);
  approx(cam.cy, -1);
  assert.equal(cam.zoom, 2.5);
});

// ── gridForCamera ────────────────────────────────────────────────────────────

test("gridForCamera: hides below GRID_HIDE_BELOW_ZOOM", () => {
  const cam = { cx: 0, cy: 0, zoom: GRID_HIDE_BELOW_ZOOM - 0.01 };
  assert.deepEqual(gridForCamera(cam, VIEWPORT), { visible: false });
});

test("gridForCamera: coarsens below GRID_COARSE_BELOW_ZOOM", () => {
  const coarse = gridForCamera(
    { cx: 0, cy: 0, zoom: GRID_COARSE_BELOW_ZOOM - 0.01 },
    VIEWPORT,
  );
  assert.equal(coarse.per, GRID_COARSE_STEP);
  const fine = gridForCamera(
    { cx: 0, cy: 0, zoom: GRID_COARSE_BELOW_ZOOM },
    VIEWPORT,
  );
  assert.equal(fine.per, 1);
});

test("gridForCamera: spacing is PX_PER_UNIT × zoom × per", () => {
  const cam = { cx: 3, cy: 4, zoom: 1.5 };
  const g = gridForCamera(cam, VIEWPORT);
  approx(g.spacing, PX_PER_UNIT * 1.5);
});

test("gridForCamera: dot centers land on world-unit multiples", () => {
  // With the dot centered in its tile, a dot center sits at
  // offset + spacing/2 (mod spacing) — which must equal tx (mod spacing),
  // the screen x of the world origin.
  for (const cam of [
    { cx: 0, cy: 0, zoom: 1 },
    { cx: -17.3, cy: 4.2, zoom: 2.6 },
    { cx: 1000.01, cy: -2044, zoom: 0.31 },
  ]) {
    const t = surfaceTransform(cam, VIEWPORT);
    const g = gridForCamera(cam, VIEWPORT, t);
    const mod = (v, m) => ((v % m) + m) % m;
    approx(
      mod(g.offsetX + g.spacing / 2 - t.tx, g.spacing) % g.spacing,
      0,
      1e-6,
    );
    approx(
      mod(g.offsetY + g.spacing / 2 - t.ty, g.spacing) % g.spacing,
      0,
      1e-6,
    );
    assert.ok(g.offsetX >= 0 && g.offsetX < g.spacing);
    assert.ok(g.offsetY >= 0 && g.offsetY < g.spacing);
  }
});
