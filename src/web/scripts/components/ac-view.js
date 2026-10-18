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

// ac-view.js — the AC supply brick on the desk (.layer-parts): its body, a
// sine, its output ("12 V~", or "+5/−3 V~" for a pair of peaks of its own)
// and frequency on the badge, and its L and N terminals — the line in the
// mains' brown-orange, the neutral in its blue — whose centres are its wire
// points (ac1.L / ac1.N). Nothing live: the sine it puts out is the probe's
// and the analyzer's to show.

import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";
import { acBadge } from "../catalog/ac-parts.js";
import { BrickView } from "./brick-view.js";

/** One cycle of a sine across `w` units, `h` tall, from (x, y)'s left end
    at its centre line. */
function sinePath(x, y, w, h) {
  const steps = 24;
  const pts = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    pts.push(`${(x + t * w).toFixed(3)} ${(y - (h / 2) * Math.sin(2 * Math.PI * t)).toFixed(3)}`); // prettier-ignore
  }
  return `M ${pts.join(" L ")}`;
}

/**
 * Build an AC supply brick's SVG from its params. Pure DOM construction
 * (unit-testable under jsdom).
 */
export function buildAcSvg(params = {}) {
  const def = partDef("ac");
  const { width, height } = def.size;
  const svg = svgEl("svg", {
    class: "part-ac-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  svg.append(
    svgEl("rect", { class: "part-ac-body", x: 0.1, y: 0.1, width: width - 0.2, height: height - 0.2, rx: 0.5 }), // prettier-ignore
    svgEl("path", { class: "part-ac-sine", d: sinePath(0.7, 1.35, 1.6, 1.1) }),
  );
  const { volts, hz } = acBadge(params);
  const badge = svgEl("text", { class: "part-ac-badge", x: 5, y: 1.75, "text-anchor": "middle" }); // prettier-ignore
  badge.textContent = volts;
  if (volts.length > 7) {
    badge.setAttribute("textLength", 5);
    badge.setAttribute("lengthAdjust", "spacingAndGlyphs");
  }
  const rate = svgEl("text", { class: "part-ac-hz", x: width / 2, y: 2.85, "text-anchor": "middle" }); // prettier-ignore
  rate.textContent = hz;
  svg.append(badge, rate);
  for (const t of def.terminals) {
    const line = t.id === "L";
    svg.append(
      svgEl("circle", {
        class: `part-psu-terminal part-ac-terminal--${line ? "line" : "neutral"}`,
        cx: t.dx,
        cy: t.dy,
        r: 0.55,
      }),
    );
    const glyph = svgEl("text", { class: "part-psu-terminal-glyph", x: t.dx, y: t.dy + 0.22, "text-anchor": "middle" }); // prettier-ignore
    glyph.textContent = t.id;
    svg.append(glyph);
  }
  return svg;
}

export class AcView extends BrickView {
  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} ac
   * @param {object} [callbacks]
   */
  constructor(layer, ac, callbacks = {}) {
    super(layer, ac, "part-ac", callbacks);
    this.updateParams(ac.params);
  }

  /** Rebuild the SVG (the badge shows the output and frequency). */
  updateParams(params) {
    this.element.querySelector("svg")?.remove();
    this.element.prepend(buildAcSvg(params));
  }
}
