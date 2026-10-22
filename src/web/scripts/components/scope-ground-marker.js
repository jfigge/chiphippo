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

// scope-ground-marker.js — the analyzer's ground lead on the desk: a black
// clip ringing the hole it is on, the ground symbol beside it. Drawn in the
// pointer-inert overlay layer (it is a reminder of where the lanes are read
// from, never a thing to grab: the probe's menu moves it and the analyzer's
// header takes it off), and re-placed whenever the document changes — a
// board carried elsewhere takes its hole with it.

import { el, svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

/** The clip's ring radius, pitch units — as the hover ring's, a shade over
    one hole. */
const CLIP_RADIUS = 0.55;

/** The marker's box, pitch units: the ring, and the ground symbol hanging
    off its lower right. */
const BOX = Object.freeze({ w: 2.6, h: 2.6 });

/** The marker's drawing, in its own pitch units (the hole at (r, r)). */
function buildMarkerSvg() {
  const r = CLIP_RADIUS;
  const svg = svgEl("svg", {
    class: "scope-ground-marker-svg",
    viewBox: `0 0 ${BOX.w} ${BOX.h}`,
    width: BOX.w * PX_PER_UNIT,
    height: BOX.h * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  const x = r + 1.25; // the symbol's stem
  svg.append(
    svgEl("circle", { class: "scope-ground-marker-clip", cx: r, cy: r, r: r - 0.06 }), // prettier-ignore
    svgEl("path", { class: "scope-ground-marker-lead", d: `M ${r + 0.4} ${r + 0.4} L ${x} ${r + 0.4} L ${x} ${r + 1.05}` }), // prettier-ignore
    svgEl("path", { class: "scope-ground-marker-symbol", d: `M ${x - 0.55} ${r + 1.05} H ${x + 0.55} M ${x - 0.35} ${r + 1.3} H ${x + 0.35} M ${x - 0.15} ${r + 1.55} H ${x + 0.15}` }), // prettier-ignore
  );
  return svg;
}

export class ScopeGroundMarker {
  #el;
  #where; // () → {x, y} | null — the lead's hole, in world pitch units

  /**
   * @param {HTMLElement} layer - the desk's overlay layer (pointer-inert).
   * @param {() => ({x:number, y:number}|null)} where - the lead's world
   *   point, or null while there is none (or its hole has gone).
   */
  constructor(layer, where) {
    this.#where = where;
    this.#el = el("div", { class: "scope-ground-marker", hidden: true }, [
      buildMarkerSvg(),
    ]);
    layer.append(this.#el);
    window.addEventListener("chiphippo:doc-changed", () => this.refresh());
    window.addEventListener("chiphippo:desk-loaded", () => this.refresh());
    this.refresh();
  }

  /** Put the marker on the lead's hole, or take it off the desk. */
  refresh() {
    const at = this.#where();
    this.#el.hidden = !at;
    if (!at) return;
    const r = CLIP_RADIUS * PX_PER_UNIT;
    this.#el.style.left = `${at.x * PX_PER_UNIT - r}px`;
    this.#el.style.top = `${at.y * PX_PER_UNIT - r}px`;
  }
}
