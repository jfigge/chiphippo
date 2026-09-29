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

// net-highlight.js — the connectivity-inspector overlay: one SVG in the
// overlay layer that lights up every point of ONE net — glow dots on member
// holes/terminals, glow rings on member chip pins, glow strokes on member
// wires. Regenerated per highlighted net (not per frame); it contains NO set
// arithmetic — it draws exactly what the NetInfo lists, positioned by the
// geometry lookups the controller passes in.

import { clear, svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { wirePath } from "../desk/wire-path.js";

/** Glow marker radii (world px — scale with the camera). */
const DOT_RADIUS = 3.2;
const PIN_RING_RADIUS = 5;

export class NetHighlight {
  #svg;

  /** @param {HTMLElement} overlayLayer - the `.layer-overlay` element. */
  constructor(overlayLayer) {
    this.#svg = svgEl("svg", { class: "net-highlight", width: 1, height: 1 });
    overlayLayer.append(this.#svg);
  }

  /**
   * Light up a net. `geometry` supplies the positions the NetInfo references
   * (all in world px):
   *   positionOf(address)  → {x,y} | null   (hole or PSU terminal)
   *   wireEndpointsOf(id)  → {a,b} | null   (both endpoints, world px)
   * `pinned` styles the highlight as locked (brighter).
   *
   * @param {import('../sim/netlist.js').NetInfo} net
   * @param {{positionOf: Function, wireEndpointsOf: Function}} geometry
   * @param {boolean} [pinned]
   * @param {string|null} [level] - the net's sim level (H/L/Z/X) while
   *   running, for level tinting; null when not simulating.
   */
  show(net, geometry, pinned = false, level = null) {
    clear(this.#svg);
    this.#svg.classList.toggle("net-highlight--pinned", pinned);
    if (level) this.#svg.dataset.level = level;
    else delete this.#svg.dataset.level;
    if (!net) return;

    // Member wires: a glow stroke tracing each wire's sagging path.
    for (const wireId of net.wires) {
      const ends = geometry.wireEndpointsOf(wireId);
      if (!ends) continue;
      this.#svg.append(
        svgEl("path", {
          class: "net-highlight-wire",
          d: wirePath(ends.a, ends.b),
        }),
      );
    }

    // Member holes + PSU terminals: a glow dot on each point.
    for (const address of [...net.holes, ...net.terminals]) {
      const p = geometry.positionOf(address);
      if (!p) continue;
      this.#svg.append(
        svgEl("circle", {
          class: "net-highlight-dot",
          cx: p.x,
          cy: p.y,
          r: DOT_RADIUS,
        }),
      );
    }

    // Member chip pins: a glow ring around the seated hole.
    for (const pin of net.pins) {
      const p = geometry.positionOf(pin.hole);
      if (!p) continue;
      this.#svg.append(
        svgEl("circle", {
          class: "net-highlight-pin",
          cx: p.x,
          cy: p.y,
          r: PIN_RING_RADIUS,
        }),
      );
    }
  }

  /** Radii exported so a test can convert pitch expectations if needed. */
  static get DOT_RADIUS() {
    return DOT_RADIUS / PX_PER_UNIT;
  }

  clear() {
    clear(this.#svg);
  }

  remove() {
    this.#svg.remove();
  }
}
