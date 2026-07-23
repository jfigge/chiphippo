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

// desk-geometry.js — pure camera math for the infinite desk. DOM-free (tested
// with node --test); DeskView is a thin shell over these functions.
//
// Coordinate spaces:
//   world units  — 1 unit = one breadboard pitch (0.1 in). Board geometry and
//                  desk positions are integer-friendly in this space.
//   world px     — world units × PX_PER_UNIT; children of .desk-surface are
//                  absolutely positioned in world px.
//   screen px    — CSS px relative to the viewport's top-left corner.
//
// The camera is `{ cx, cy, zoom }`: the world point (units) at the viewport
// center plus the zoom factor. The surface carries
// `transform: translate(tx px, ty px) scale(zoom)`.

/** World px per world unit at zoom 1.0 (a Full board ≈ 650 px wide at 100%). */
export const PX_PER_UNIT = 10;

// 5% is also the floor "fit to screen" needs for a sprawling layout.
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;

/** One keyboard/button zoom step (~15% — exponential, so steps compose). */
export const ZOOM_STEP = 1.15;

/** Wheel/pinch zoom sensitivity: zoom scales by e^(−deltaY × this). */
export const WHEEL_ZOOM_SENSITIVITY = 0.0035;

/** Below this zoom the dot grid coarsens to one dot per GRID_COARSE_STEP. */
export const GRID_COARSE_BELOW_ZOOM = 0.6;

/** Below this zoom the dot grid is hidden entirely. */
export const GRID_HIDE_BELOW_ZOOM = 0.3;

/** Pitches per dot when the grid is coarse. */
export const GRID_COARSE_STEP = 5;

/** Clamp a zoom factor to the allowed range (non-finite input → 1). */
export function clampZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** Step the zoom by `steps` exponential increments (negative zooms out). */
export function stepZoom(zoom, steps = 1) {
  return clampZoom(clampZoom(zoom) * ZOOM_STEP ** steps);
}

/** Map a wheel/pinch delta to a new zoom factor (clamped). */
export function wheelZoom(zoom, deltaY) {
  const dy = Number.isFinite(deltaY) ? deltaY : 0;
  return clampZoom(clampZoom(zoom) * Math.exp(-dy * WHEEL_ZOOM_SENSITIVITY));
}

/** Coerce persisted/unknown data into a valid camera. */
export function normalizeCamera(camera) {
  const c = camera && typeof camera === "object" ? camera : {};
  return {
    cx: Number.isFinite(c.cx) ? c.cx : 0,
    cy: Number.isFinite(c.cy) ? c.cy : 0,
    zoom: clampZoom(c.zoom),
  };
}

/**
 * The `.desk-surface` CSS transform for a camera in a viewport of
 * `{ width, height }` CSS px: screen = worldPx × zoom + (tx, ty).
 */
export function surfaceTransform(camera, viewport) {
  const k = PX_PER_UNIT * camera.zoom;
  return {
    tx: viewport.width / 2 - camera.cx * k,
    ty: viewport.height / 2 - camera.cy * k,
    scale: camera.zoom,
  };
}

/**
 * Round a surface transform's translation to whole device pixels (applied at
 * rest so world-px children render crisp; scale is left untouched).
 */
export function roundTransform(transform, devicePixelRatio = 1) {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  return {
    tx: Math.round(transform.tx * dpr) / dpr,
    ty: Math.round(transform.ty * dpr) / dpr,
    scale: transform.scale,
  };
}

/** World units → screen px (relative to the viewport's top-left). */
export function worldToScreen(camera, viewport, point) {
  const k = PX_PER_UNIT * camera.zoom;
  return {
    x: (point.x - camera.cx) * k + viewport.width / 2,
    y: (point.y - camera.cy) * k + viewport.height / 2,
  };
}

/** Screen px (relative to the viewport's top-left) → world units. */
export function screenToWorld(camera, viewport, point) {
  const k = PX_PER_UNIT * camera.zoom;
  return {
    x: (point.x - viewport.width / 2) / k + camera.cx,
    y: (point.y - viewport.height / 2) / k + camera.cy,
  };
}

/**
 * Pan the camera by a screen-px delta so the world follows the pointer:
 * dragging right (dx > 0) moves the camera center left in world space.
 */
export function panBy(camera, dx, dy) {
  const k = PX_PER_UNIT * camera.zoom;
  return {
    cx: camera.cx - dx / k,
    cy: camera.cy - dy / k,
    zoom: camera.zoom,
  };
}

/**
 * Change zoom while keeping the world point under the screen-px `anchor`
 * exactly where it is (cursor-anchored zoom). Returns a new camera.
 */
export function zoomAboutPoint(camera, viewport, anchor, newZoom) {
  const zoom = clampZoom(newZoom);
  const w = screenToWorld(camera, viewport, anchor);
  const k = PX_PER_UNIT * zoom;
  return {
    cx: w.x - (anchor.x - viewport.width / 2) / k,
    cy: w.y - (anchor.y - viewport.height / 2) / k,
    zoom,
  };
}

/**
 * The dot-grid background for a camera: tile `spacing` (CSS px) and the
 * `background-position` offsets that keep dots on world-unit multiples.
 *
 * Assumes the dot is CENTERED in its tile (a `radial-gradient(circle, …)`
 * background tile), so the tile origin sits half a tile before each dot.
 * One dot per pitch; one per GRID_COARSE_STEP pitches below
 * GRID_COARSE_BELOW_ZOOM; hidden below GRID_HIDE_BELOW_ZOOM.
 *
 * `transform` defaults to the camera's exact surface transform; pass the
 * (device-pixel-rounded) transform actually applied to the surface so the
 * grid and future world-px children stay perfectly aligned.
 */
export function gridForCamera(
  camera,
  viewport,
  transform = surfaceTransform(camera, viewport),
) {
  if (camera.zoom < GRID_HIDE_BELOW_ZOOM) return { visible: false };
  const per = camera.zoom < GRID_COARSE_BELOW_ZOOM ? GRID_COARSE_STEP : 1;
  const spacing = PX_PER_UNIT * camera.zoom * per;
  const mod = (v, m) => ((v % m) + m) % m;
  return {
    visible: true,
    per,
    spacing,
    offsetX: mod(transform.tx - spacing / 2, spacing),
    offsetY: mod(transform.ty - spacing / 2, spacing),
  };
}
