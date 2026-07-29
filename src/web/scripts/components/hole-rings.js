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
