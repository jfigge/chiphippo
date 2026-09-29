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

// hole-rings.js — the shared hover ring, MANY at once: the overlay set a tool
// outlines a whole GROUP of holes with. The single `.hole-ring` div the desk
// controller owns answers "this one hole", which is the whole question for a
// wire end; a bus lands `width` leads at once, so the honest preview rings
// every hole the gesture would claim — legal in the hover colour, illegal in
// the danger one, exactly as a chip's placement ghost reddens.
//
// The rings are the SAME `.hole-ring` element and class as the shared one, so
// there is one ring look in the app; this only owns how many there are and
// where. They are POOLED — a bus width changes by a digit key, and rebuilding
// eight divs per pointermove to draw the same eight circles is work with
// nothing to show for it — and, being in the pointer-inert overlay layer, they
// can never take a hit test away from the holes they sit on.

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

/** Radius of a ring (pitch units — a shade over one hole). Keep 2× this in
    step with `.hole-ring`'s diameter in app.css: it is what each ring is
    offset by to centre it, so a mismatch reads as a ring sitting a pixel off
    its hole rather than as anything obviously broken. */
export const RING_RADIUS = 0.55;

/**
 * Aim the ONE shared `.hole-ring` (the desk controller's) at a world point —
 * the "it lands here" marker every single-point drag shows (a wire's end, a
 * part's lead, a flag, a tag) — or take it off the desk with a null point.
 *
 * @param {HTMLElement} ring
 * @param {{x:number,y:number}|null} point - world (pitch) centre.
 * @param {boolean} [legal] - false paints it the danger colour.
 */
export function aimRing(ring, point, legal = true) {
  if (!point) {
    ring.hidden = true;
    ring.classList.remove("hole-ring--illegal");
    return;
  }
  const r = RING_RADIUS * PX_PER_UNIT;
  ring.style.left = `${point.x * PX_PER_UNIT - r}px`;
  ring.style.top = `${point.y * PX_PER_UNIT - r}px`;
  ring.classList.toggle("hole-ring--illegal", !legal);
  ring.hidden = false;
}

export class HoleRings {
  #layer;
  #pool = [];

  /** @param {HTMLElement} layer - the desk's overlay layer (pointer-inert). */
  constructor(layer) {
    this.#layer = layer;
  }

  /**
   * Ring exactly `points` and no others.
   *
   * @param {Array<{x:number,y:number}>|null} points - world (pitch) centres.
   * @param {boolean} [legal] - false paints the set as the danger colour.
   */
  show(points, legal = true) {
    const list = points ?? [];
    const r = RING_RADIUS * PX_PER_UNIT;
    for (let i = 0; i < list.length; i += 1) {
      const ring = this.#ringAt(i);
      ring.style.left = `${list[i].x * PX_PER_UNIT - r}px`;
      ring.style.top = `${list[i].y * PX_PER_UNIT - r}px`;
      ring.classList.toggle("hole-ring--illegal", !legal);
      ring.hidden = false;
    }
    // The pool outlives the widest set it has drawn, so the tail is HIDDEN
    // rather than removed — the next wide bus reuses it.
    for (let i = list.length; i < this.#pool.length; i += 1) {
      this.#pool[i].hidden = true;
    }
  }

  /** Take every ring off the desk (the pool stays for the next set). */
  clear() {
    this.show(null);
  }

  #ringAt(i) {
    if (!this.#pool[i]) {
      const ring = el("div", { class: "hole-ring", hidden: true });
      this.#pool[i] = ring;
      this.#layer.append(ring);
    }
    return this.#pool[i];
  }
}
