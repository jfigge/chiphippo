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

// route-debug-layer.js — draw what the auto-router was looking at (Feature 360).
//
// Option-clicking Auto-route leaves this behind: the legal region, the bridges
// out to anything off the boards, every obstacle AS INFLATED (not as drawn — the
// gap between the two is a wire's own width, and it is the thing that is hardest
// to reason about from the numbers), and the corridor tracks the cost model
// discounts. A second Option-click clears it.
//
// It draws NO TEXT, deliberately. Every string in this app goes through the
// catalog, and a debugging overlay would be seven translations of "inflated
// obstacle" that nobody outside this file will ever read. The numbers already
// have a home — `routeDesk` returns a per-wire cost breakdown, which is what the
// tests assert on and what a console dump prints. This draws the geometry, which
// is the part a number cannot show.
//
// World px, in the pointer-inert overlay layer, so the camera scales it for free
// and it can never intercept a click.

import { svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

const px = (n) => n * PX_PER_UNIT;

export class RouteDebugLayer {
  #svg;
  #layer;

  /** @param {HTMLElement} overlayLayer - the `.layer-overlay` element. */
  constructor(overlayLayer) {
    this.#layer = overlayLayer;
    // A zero-size <svg> renders nothing per spec, so it needs a token box and
    // `overflow: visible` — the same trick every other overlay here uses.
    this.#svg = svgEl("svg", {
      class: "route-debug",
      width: 1,
      height: 1,
      "aria-hidden": "true",
    });
  }

  get visible() {
    return this.#svg.isConnected;
  }

  /** Draw a `buildRouteSpace` result. Replaces whatever was there. */
  show(space) {
    this.clear();
    const rect = (r, cls) =>
      svgEl("rect", {
        class: cls,
        x: px(r.x0),
        y: px(r.y0),
        width: px(r.x1 - r.x0),
        height: px(r.y1 - r.y0),
      });

    for (const r of space.boardRects) {
      this.#svg.append(rect(r, "route-debug-region"));
    }
    for (const r of space.bridges) {
      this.#svg.append(rect(r, "route-debug-bridge"));
    }
    // The corridor tracks — the hole-free lanes the cost model prefers. Drawn
    // across the whole region's width/height, since that is what they are.
    const x0 = Math.min(...space.xs);
    const x1 = Math.max(...space.xs);
    const y0 = Math.min(...space.ys);
    const y1 = Math.max(...space.ys);
    for (let j = 0; j < space.ys.length; j += 1) {
      if (!space.yCorridor[j]) continue;
      this.#svg.append(
        svgEl("line", { class: "route-debug-lane", x1: px(x0), y1: px(space.ys[j]), x2: px(x1), y2: px(space.ys[j]) }), // prettier-ignore
      );
    }
    for (let i = 0; i < space.xs.length; i += 1) {
      if (!space.xCorridor[i]) continue;
      this.#svg.append(
        svgEl("line", { class: "route-debug-lane", x1: px(space.xs[i]), y1: px(y0), x2: px(space.xs[i]), y2: px(y1) }), // prettier-ignore
      );
    }
    // Obstacles last, over the lanes, because they are what a route had to
    // answer to. INFLATED, not drawn: the difference is the clearance.
    for (const o of space.inflated) {
      this.#svg.append(rect(o.rect, "route-debug-obstacle"));
    }
    this.#layer.append(this.#svg);
  }

  clear() {
    this.#svg.replaceChildren();
    this.#svg.remove();
  }
}
