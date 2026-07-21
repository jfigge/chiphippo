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

// board-outline.js — the selection highlighter for boards: ONE path in the
// overlay layer tracing the outer edge of every strip a grab would move, not
// a box per strip. Snapped strips are flush, so per-strip outlines would draw
// a seam down every join; the union boundary reads as one item.
//
// Draws in world px (the camera transform scales it, exactly as the old CSS
// outline scaled). All set arithmetic lives in the controller — this takes a
// list of rects and draws it.

import { outlinePath, unionOutline } from "../desk/rect-outline.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** How far outside the boards the highlighter sits (world px). */
export const OUTLINE_MARGIN = 3;

/** Corner rounding, matching the board body's own radius plus the margin. */
export const OUTLINE_RADIUS = 6 + OUTLINE_MARGIN;

export class BoardOutline {
  #svg;
  #path;

  /** @param {HTMLElement} overlayLayer - the `.layer-overlay` element. */
  constructor(overlayLayer) {
    // A zero-size <svg> renders nothing, so anchor at 1×1 and overflow.
    this.#svg = document.createElementNS(SVG_NS, "svg");
    this.#svg.setAttribute("class", "board-outline");
    this.#svg.setAttribute("width", "1");
    this.#svg.setAttribute("height", "1");
    this.#svg.setAttribute("aria-hidden", "true");
    this.#path = document.createElementNS(SVG_NS, "path");
    this.#path.setAttribute("class", "board-outline-path");
    this.#svg.append(this.#path);
    this.#svg.hidden = true;
    overlayLayer.append(this.#svg);
  }

  get element() {
    return this.#svg;
  }

  /**
   * Draw the highlighter around the union of `rects` (world px). An empty
   * list hides it.
   *
   * @param {Array<{x:number,y:number,width:number,height:number}>} rects
   * @param {boolean} [illegal] - style the outline as a rejected drop.
   */
  show(rects, illegal = false) {
    const d = outlinePath(unionOutline(rects, OUTLINE_MARGIN), OUTLINE_RADIUS);
    if (!d) {
      this.hide();
      return;
    }
    this.#path.setAttribute("d", d);
    this.#svg.classList.toggle("board-outline--illegal", illegal);
    this.#svg.hidden = false;
  }

  hide() {
    this.#svg.hidden = true;
    this.#path.removeAttribute("d");
    this.#svg.classList.remove("board-outline--illegal");
  }
}
