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

// net-highlight.js — the connectivity-inspector overlay: one SVG in the
// overlay layer that lights up every point of ONE net — glow dots on member
// holes/terminals, glow rings on member chip pins, glow strokes on member
// wires. Regenerated per highlighted net (not per frame); it contains NO set
// arithmetic — it draws exactly what the NetInfo lists, positioned by the
// geometry lookups the controller passes in.

import { clear } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { wirePath } from "../desk/wire-path.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Glow marker radii (world px — scale with the camera). */
const DOT_RADIUS = 3.2;
const PIN_RING_RADIUS = 5;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

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
   */
  show(net, geometry, pinned = false) {
    clear(this.#svg);
    this.#svg.classList.toggle("net-highlight--pinned", pinned);
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
