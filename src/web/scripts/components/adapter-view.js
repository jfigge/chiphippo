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

// adapter-view.js — the AC adapter brick on the desk (.layer-parts): a wall
// transformer's black body, its output ("12 V~") on the badge and its
// frequency ("60 Hz") under it, its output's S1 and S2 terminals — whose
// centres are its wire points (adp1.S1 / adp1.S2) — and between them IEC
// 60417-5172's two nested squares, the mark an isolating adapter's label
// carries. Nothing live: what it puts out is the probe's and the analyzer's
// to show.

import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";
import { adapterBadge } from "../catalog/ac-parts.js";
import { BrickView } from "./brick-view.js";

/**
 * Build an AC adapter brick's SVG from its params. Pure DOM construction
 * (unit-testable under jsdom).
 */
export function buildAdapterSvg(params = {}) {
  const def = partDef("adapter");
  const { width, height } = def.size;
  const svg = svgEl("svg", {
    class: "part-adapter-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  svg.append(
    svgEl("rect", { class: "part-adapter-body", x: 0.1, y: 0.1, width: width - 0.2, height: height - 0.2, rx: 0.5 }), // prettier-ignore
  );
  const { volts, hz } = adapterBadge(params);
  const badge = svgEl("text", { class: "part-adapter-badge", x: width / 2, y: 1.6, "text-anchor": "middle" }); // prettier-ignore
  badge.textContent = volts;
  const rate = svgEl("text", { class: "part-adapter-hz", x: width / 2, y: 2.55, "text-anchor": "middle" }); // prettier-ignore
  rate.textContent = hz;
  svg.append(badge, rate);
  // The isolation mark, between the two terminals.
  const cx = width / 2;
  const cy = def.terminals[0].dy;
  for (const half of [0.5, 0.28]) {
    svg.append(svgEl("rect", { class: "part-adapter-isolated", x: cx - half, y: cy - half, width: 2 * half, height: 2 * half })); // prettier-ignore
  }
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

export class AdapterView extends BrickView {
  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} adapter
   * @param {object} [callbacks]
   */
  constructor(layer, adapter, callbacks = {}) {
    super(layer, adapter, "part-adapter", callbacks);
    this.updateParams(adapter.params);
  }

  /** Rebuild the SVG (the badge shows the output and frequency). */
  updateParams(params) {
    this.element.querySelector("svg")?.remove();
    this.element.prepend(buildAdapterSvg(params));
  }
}
