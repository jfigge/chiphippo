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

// part-symbols.js — the fault symbols the simulator paints over a part: the
// red X + rising smoke of a burnt-out one, and the warning triangle of an
// inert one. Shared by discrete-view.js (LEDs burnt with no series resistor)
// and chip-view.js (chips killed by reversed polarity or 12 V, and chips with
// no power at all).
//
// Both are built ONCE at render time and hidden by CSS until the owning view
// adds its status class — nothing rebuilds when the simulation state changes.
//
// Coordinates are pitch units in the CALLER's local SVG frame. Callers must
// append these OUTSIDE any rotated group: smoke has to rise in SCREEN space,
// and a flipped warning triangle would read upside down.

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

/**
 * The red X + rising smoke drawn over a burnt-out part.
 * @param {number} cx - centre, pitch units in the caller's frame
 * @param {number} cy
 * @param {number} [r] - half-width of the X
 * @returns {SVGGElement}
 */
export function buildBurnOverlay(cx, cy, r = 0.8) {
  const g = svgEl("g", { class: "part-burn" });
  g.append(
    svgEl("line", {
      class: "part-burn-x",
      x1: cx - r,
      y1: cy - r,
      x2: cx + r,
      y2: cy + r,
    }),
    svgEl("line", {
      class: "part-burn-x",
      x1: cx + r,
      y1: cy - r,
      x2: cx - r,
      y2: cy + r,
    }),
  );
  // Four staggered puffs, so the smoke reads as a continuous plume rather than
  // a wisp. Sized off the overlay so a chip's column stays proportional to an
  // LED's; the delay spacing is the cycle divided by the puff count.
  for (const [i, dx] of [-0.24, 0.14, -0.06, 0.2].entries()) {
    const puff = svgEl("circle", {
      class: "part-burn-smoke",
      cx: cx + dx,
      cy: cy - r,
      r: r * 0.52,
    });
    puff.style.animationDelay = `${i * 0.6}s`;
    g.append(puff);
  }
  return g;
}

/**
 * The warning triangle drawn over an inert part — filled body plus an
 * exclamation mark punched out in the desk colour.
 * @param {number} cx - centre, pitch units in the caller's frame
 * @param {number} cy
 * @param {number} [r] - half-height of the triangle's bounding box
 * @returns {SVGGElement}
 */
export function buildWarnOverlay(cx, cy, r = 0.7) {
  const g = svgEl("g", { class: "part-warn" });
  const half = r * 0.98; // half the base, so the triangle reads equilateral
  const top = cy - r * 0.85;
  const base = cy + r * 0.85;
  g.append(
    svgEl("path", {
      class: "part-warn-tri",
      d: `M ${cx} ${top} L ${cx + half} ${base} L ${cx - half} ${base} Z`,
    }),
    svgEl("line", {
      class: "part-warn-mark",
      x1: cx,
      y1: cy - r * 0.3,
      x2: cx,
      y2: cy + r * 0.2,
    }),
    svgEl("circle", {
      class: "part-warn-mark",
      cx,
      cy: cy + r * 0.47,
      r: r * 0.1,
    }),
  );
  return g;
}
