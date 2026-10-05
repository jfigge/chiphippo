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

// orbit-camera.js — the 3D view's camera as plain data and pure functions,
// the way desk/desk-geometry.js is the desk's: a TARGET point on the desk, and
// the camera on a sphere round it — `yaw` (round the vertical), `pitch` (up
// from the desk) and `distance`. Every gesture is a function from one camera
// to the next, so the view only translates pointer events and the arithmetic
// is testable under node.
//
// yaw 0 looks along −z: from the bottom edge of the 2D desk up it, so the 3D
// view opens the same way round as the breadboard the user has been looking
// at. Pitch is clamped short of both the desk (from below there is nothing to
// see but the underside of the boards) and the zenith (straight down, the
// orbit's "up" degenerates and the yaw stops meaning anything).

import {
  add,
  dot,
  lookAt,
  multiply,
  perspective,
  project,
  scale,
  sub,
} from "./mat4.js";

/** Vertical field of view, radians (≈ 40°: a normal lens, little distortion). */
export const FOVY = (40 * Math.PI) / 180;

/** Pitch limits, radians — 5° off the desk to 88° (nearly straight down). */
export const PITCH_MIN = (5 * Math.PI) / 180;
export const PITCH_MAX = (88 * Math.PI) / 180;

/** Distance limits, in pitch units — close enough to read a chip's legs, far
    enough to take in a desk of many boards. */
export const DISTANCE_MIN = 4;
export const DISTANCE_MAX = 4000;

/** Radians of orbit per pixel dragged. */
export const ORBIT_RATE = 0.005;

/** The pitch a fit settles on: looking down at the desk at about 55°, enough
    to see that the parts stand up off the boards without losing the layout. */
export const FIT_PITCH = (55 * Math.PI) / 180;

/** The camera a view starts on before it has anything to frame. */
export const DEFAULT_CAMERA = Object.freeze({
  target: Object.freeze([0, 0, 0]),
  yaw: 0,
  pitch: FIT_PITCH,
  distance: 80,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A camera with every field repaired to something usable.
 * @param {object} [cam]
 */
export function normalizeCamera(cam) {
  const t =
    Array.isArray(cam?.target) && cam.target.every(Number.isFinite)
      ? [cam.target[0], cam.target[1], cam.target[2]]
      : [...DEFAULT_CAMERA.target];
  const yaw = Number.isFinite(cam?.yaw) ? cam.yaw : DEFAULT_CAMERA.yaw;
  const pitch = Number.isFinite(cam?.pitch) ? cam.pitch : DEFAULT_CAMERA.pitch;
  const distance = Number.isFinite(cam?.distance)
    ? cam.distance
    : DEFAULT_CAMERA.distance;
  return {
    target: t,
    yaw,
    pitch: clamp(pitch, PITCH_MIN, PITCH_MAX),
    distance: clamp(distance, DISTANCE_MIN, DISTANCE_MAX),
  };
}

/** Where the camera is: on its sphere round the target. */
export function eyeOf(cam) {
  const cp = Math.cos(cam.pitch);
  return add(cam.target, [
    cam.distance * cp * Math.sin(cam.yaw),
    cam.distance * Math.sin(cam.pitch),
    cam.distance * cp * Math.cos(cam.yaw),
  ]);
}

/**
 * Orbit by a pointer drag of (dx, dy) screen pixels: across turns round the
 * vertical, down tips the camera up over the desk — the grab-the-world feel
 * every 3D viewer has, so the desk follows the hand.
 */
export function orbitBy(cam, dx, dy) {
  return normalizeCamera({
    ...cam,
    yaw: cam.yaw - dx * ORBIT_RATE,
    pitch: cam.pitch + dy * ORBIT_RATE,
  });
}

/**
 * Slide the target over the desk by a drag of (dx, dy) screen pixels in a
 * viewport `height` pixels tall, so the point under the pointer stays under
 * it (exactly so at the target's depth). Panning moves ALONG the desk, never
 * up off it — the target stays on the plane it was on.
 */
export function panBy(cam, dx, dy, height) {
  const perPixel =
    (2 * cam.distance * Math.tan(FOVY / 2)) / Math.max(1, height);
  const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)];
  // The camera's forward direction laid flat on the desk. A drag down the
  // screen pulls the desk toward the viewer, which is the camera going
  // forward; at a shallow pitch one pixel covers more desk, hence the divide.
  const forward = [-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw)];
  const along = perPixel / Math.max(Math.sin(cam.pitch), 0.2);
  const move = add(scale(right, -dx * perPixel), scale(forward, dy * along));
  return normalizeCamera({ ...cam, target: add(cam.target, move) });
}

/**
 * Dolly in (factor < 1) or out (> 1), clamped.
 */
export function zoomBy(cam, factor) {
  if (!Number.isFinite(factor) || factor <= 0) return normalizeCamera(cam);
  return normalizeCamera({ ...cam, distance: cam.distance * factor });
}

/** The dolly factor for one wheel event's `deltaY` (pixels or lines) —
    exponential, so every notch is the same proportion at any distance. */
export function wheelFactor(deltaY) {
  return Math.exp(clamp(deltaY, -200, 200) * 0.0015);
}

/**
 * Frame `bounds` ({min:[x,y,z], max:[x,y,z]}) in a viewport of `aspect`
 * (width / height): aim at its centre and come in as close as the view allows
 * while all eight of its corners stay on screen. Keeps the yaw and settles the
 * pitch on FIT_PITCH — a fit is a "show me everything", and that is the view
 * everything is easiest to read from — unless `keepPitch`.
 *
 * The distance is SEARCHED rather than taken from a bounding sphere: a desk
 * is long and flat, and a sphere round it frames a lot of empty floor.
 * @param {object} cam
 * @param {{min:number[], max:number[]}|null} bounds
 * @param {number} aspect
 * @param {{margin?: number, keepPitch?: boolean}} [opts] - margin: the
 *   fraction of the screen's half-width/height the scene may reach to
 */
export function fitBounds(
  cam,
  bounds,
  aspect,
  { margin = 0.92, keepPitch = false } = {},
) {
  if (!bounds) return normalizeCamera(cam);
  const center = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const corners = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) corners.push([x, y, z]);
    }
  }
  const base = {
    target: center,
    yaw: cam?.yaw ?? 0,
    pitch: keepPitch ? (cam?.pitch ?? FIT_PITCH) : FIT_PITCH,
  };
  const fits = (distance) => {
    const c = normalizeCamera({ ...base, distance });
    const eye = eyeOf(c);
    const vp = viewProjection(c, a);
    return corners.every((p) => {
      // Behind (or level with) the camera is never "on screen".
      const toward = sub(p, eye);
      const forward = sub(c.target, eye);
      if (dot(toward, forward) <= 0) return false;
      const [x, y] = project(vp, p);
      return Math.abs(x) <= margin && Math.abs(y) <= margin;
    });
  };
  const search = () => {
    let lo = DISTANCE_MIN;
    let hi = DISTANCE_MAX;
    if (fits(lo)) hi = lo;
    else if (!fits(hi)) lo = hi;
    for (let i = 0; i < 40 && hi - lo > 0.01; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };
  // Seen at an angle, the middle of the box is not the middle of its picture
  // (the near half looks bigger), so the frame is lopsided. Slide the target
  // until the picture is centred, then come in again — twice is plenty.
  const H = 1000;
  const W = H * a;
  let cam2 = normalizeCamera({ ...base, distance: search() });
  for (let pass = 0; pass < 3; pass++) {
    const vp = viewProjection(cam2, a);
    const ndc = corners.map((p) => project(vp, p));
    const cx =
      (Math.min(...ndc.map((q) => q[0])) + Math.max(...ndc.map((q) => q[0]))) /
      2;
    const cy =
      (Math.min(...ndc.map((q) => q[1])) + Math.max(...ndc.map((q) => q[1]))) /
      2;
    cam2 = panBy(cam2, (-cx * W) / 2, (cy * H) / 2, H);
    base.target = cam2.target;
    cam2 = normalizeCamera({ ...base, distance: search() });
  }
  return cam2;
}

/**
 * The near and far clip planes for a camera: as tight round the scene as the
 * distance allows, since the depth buffer's precision is spent between them.
 */
export function clipPlanes(cam) {
  const near = Math.max(0.1, cam.distance / 200);
  const far = cam.distance * 20 + 500;
  return { near, far };
}

/**
 * The combined view-projection matrix for a viewport of `aspect`.
 * @returns {Float32Array} column-major
 */
export function viewProjection(cam, aspect) {
  const { near, far } = clipPlanes(cam);
  const proj = perspective(FOVY, aspect > 0 ? aspect : 1, near, far);
  return multiply(proj, lookAt(eyeOf(cam), cam.target, [0, 1, 0]));
}
