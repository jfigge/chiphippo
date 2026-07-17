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
