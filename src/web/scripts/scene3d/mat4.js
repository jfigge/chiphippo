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

// mat4.js — the little linear algebra the 3D view needs, and nothing more:
// 3-vectors as plain `[x, y, z]` arrays and 4×4 matrices as COLUMN-MAJOR
// Float32Arrays (the layout WebGL's `uniformMatrix4fv` takes with transpose
// false). Pure and DOM-free, so the camera maths is testable under node.
//
// World axes, fixed for the whole 3D view: x is the desk's x, z is the desk's
// y (so "down the screen" in the 2D desk is "towards the viewer" here), and y
// is UP, out of the desk. One unit is one breadboard pitch, as everywhere else.

/** a + b */
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** a − b */
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** a · k */
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

/** a · b */
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** a × b */
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** |a| */
export const length = (a) => Math.hypot(a[0], a[1], a[2]);

/** a / |a|, or `fallback` for a zero vector (a degenerate direction must not
    turn into NaNs that poison every vertex after it). */
export function normalize(a, fallback = [0, 1, 0]) {
  const len = length(a);
  return len > 1e-12 ? [a[0] / len, a[1] / len, a[2] / len] : [...fallback];
}

/** a + (b − a)·t */
export const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Any unit vector perpendicular to the unit vector `v`. */
export function perpendicular(v) {
  // Cross with whichever axis `v` is least aligned to — never near-parallel.
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  const other =
    ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(v, other));
}

/** The 4×4 identity. */
export function identity() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a · b (both column-major), so the result applies b first, then a. */
export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * A right-handed perspective projection (OpenGL clip space, z in −1…1).
 * @param {number} fovy - vertical field of view, radians
 * @param {number} aspect - width / height
 * @param {number} near
 * @param {number} far
 */
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

/**
 * The view matrix of a camera at `eye` looking at `target`, `up` roughly up.
 * @returns {Float32Array}
 */
export function lookAt(eye, target, up = [0, 1, 0]) {
  const z = normalize(sub(eye, target), [0, 0, 1]);
  let x = cross(up, z);
  // Looking straight along `up` leaves no right vector; any will do.
  x = length(x) < 1e-9 ? perpendicular(z) : normalize(x);
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0];
  m[1] = y[0];
  m[2] = z[0];
  m[4] = x[1];
  m[5] = y[1];
  m[6] = z[1];
  m[8] = x[2];
  m[9] = y[2];
  m[10] = z[2];
  m[12] = -dot(x, eye);
  m[13] = -dot(y, eye);
  m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

/**
 * Transform the point `p` by `m` with the perspective divide — clip space to
 * normalized device coordinates. Used by tests (and anything that wants to ask
 * where a world point lands on screen).
 * @returns {number[]} `[x, y, z]` in NDC
 */
export function project(m, p) {
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [x / w, y / w, z / w];
}
