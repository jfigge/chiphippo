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

import { svgEl } from "../dom.js";
import { t } from "../i18n.js";
import { supplyText } from "../catalog/families.js";

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

/** The statuses a fault symbol can show, and so the ones with a hover hint. */
const HINTED = new Set([
  "unpowered",
  "underpowered",
  "reversed",
  "damaged",
  "unprogrammed",
  "timing",
]);

/**
 * The hover hint for a fault symbol — keyed by the status the engine reports,
 * shared by every view with a live setStatus (chip-view.js, discrete-view.js).
 *
 * It is the Properties card's own warning sentence (`properties.warning.*`),
 * so the two can never disagree: this was a hand-kept English list, and it
 * went on telling a burnt chip to "replace this part" after Stop had learnt to
 * restore it, and an underpowered one that VCC was "at 3 V" whatever it was.
 * The voltage the part saw comes from the engine's status (Feature 400) and
 * the rating from its family. A function, not a table: `t()` must not run at
 * module scope.
 * @param {string|null} status
 * @param {{volts?: number|null, def?: object|null, problems?: string[]}} [about]
 * @returns {string} "" for no status
 */
export function statusHint(
  status,
  { volts = null, def = null, problems = [] } = {},
) {
  if (!HINTED.has(status)) return "";
  return t(`properties.warning.${status}`, {
    volts: volts ?? "?",
    rating: supplyText(def),
    // A timed part's wiring problems (model/timing-summary.js), for "timing".
    problems: problems.join("; "),
  });
}
