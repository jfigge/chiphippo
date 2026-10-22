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

// transformer-view.js — the transformer brick on the desk (.layer-parts):
// its body, its rating on the badge ("120 V → 12 V", or "10:1" for figures
// of its own), the schematic's two windings either side of a core between
// them, and its four terminals — P1 P2 the primary on the left, S1 S2 the
// secondary on the right, a dot by each winding's 1 end — whose centres are
// its wire points (xfmr1.P1 …). Nothing live.

import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";
import { transformerBadge } from "../catalog/ac-parts.js";
import { BrickView } from "./brick-view.js";

/** A winding's four loops, top to bottom from (x, y0), bulging toward
    `dir` (−1 left, +1 right). */
function windingPath(x, y0, dir) {
  const loop = 0.42;
  let d = `M ${x} ${y0}`;
  for (let k = 0; k < 4; k++) {
    const y = y0 + k * loop;
    d += ` C ${x + dir * 0.45} ${y} ${x + dir * 0.45} ${y + loop} ${x} ${y + loop}`; // prettier-ignore
  }
  return d;
}

/**
 * Build a transformer brick's SVG from its params. Pure DOM construction
 * (unit-testable under jsdom).
 */
export function buildTransformerSvg(params = {}) {
  const def = partDef("transformer");
  const { width, height } = def.size;
  const svg = svgEl("svg", {
    class: "part-transformer-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  const mid = width / 2;
  svg.append(
    svgEl("rect", { class: "part-transformer-body", x: 0.1, y: 0.1, width: width - 0.2, height: height - 0.2, rx: 0.5 }), // prettier-ignore
    svgEl("path", { class: "part-transformer-winding", d: windingPath(mid - 0.75, 1.3, -1) }), // prettier-ignore
    svgEl("path", { class: "part-transformer-winding", d: windingPath(mid + 0.75, 1.3, 1) }), // prettier-ignore
    svgEl("line", { class: "part-transformer-core", x1: mid - 0.15, y1: 1.2, x2: mid - 0.15, y2: 3.1 }), // prettier-ignore
    svgEl("line", { class: "part-transformer-core", x1: mid + 0.15, y1: 1.2, x2: mid + 0.15, y2: 3.1 }), // prettier-ignore
    // The dots: each winding's 1 end, where the two are in phase.
    svgEl("circle", { class: "part-transformer-dot", cx: mid - 1.35, cy: 1.35, r: 0.13 }), // prettier-ignore
    svgEl("circle", { class: "part-transformer-dot", cx: mid + 1.35, cy: 1.35, r: 0.13 }), // prettier-ignore
  );
  const badge = svgEl("text", { class: "part-transformer-badge", x: mid, y: 0.95, "text-anchor": "middle" }); // prettier-ignore
  badge.textContent = transformerBadge(params);
  svg.append(badge);
  for (const t of def.terminals) {
    svg.append(
      svgEl("circle", { class: "part-psu-terminal part-transformer-terminal", cx: t.dx, cy: t.dy, r: 0.55 }), // prettier-ignore
    );
    const glyph = svgEl("text", { class: "part-transformer-terminal-glyph", x: t.dx, y: t.dy + 0.19, "text-anchor": "middle" }); // prettier-ignore
    glyph.textContent = t.id;
    svg.append(glyph);
  }
  return svg;
}

export class TransformerView extends BrickView {
  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} transformer
   * @param {object} [callbacks]
   */
  constructor(layer, transformer, callbacks = {}) {
    super(layer, transformer, "part-transformer", callbacks);
    this.updateParams(transformer.params);
  }

  /** Rebuild the SVG (the badge shows the rating). */
  updateParams(params) {
    this.element.querySelector("svg")?.remove();
    this.element.prepend(buildTransformerSvg(params));
  }
}
