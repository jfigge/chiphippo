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

// lcd-view.js — the LIVE half of an HD44780 character-LCD module. The module
// itself is an ordinary board-seated discrete: its PCB, bezel, glass and 16-way
// header are drawn by discrete-view.js's buildCharacterDisplay (shared with the
// placement ghost), and it seats, drags, selects and reports its power status
// through DiscreteView like any other part. All this subclass adds is the
// <canvas> laid over the display glass and `renderFramebuffer`, which the
// SimOverlay feeds from chiphippo:sim-state. The controller logic, the font and
// the cursor blink live elsewhere — this view only paints what it's told.

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";
import { glyphRows } from "../sim/hd44780-cgrom.js";
import { DiscreteView } from "./discrete-view.js";

/** HD44780 5×8 character cell (dots) + a one-dot gap between cells. */
const CELL_W = 5;
const CELL_H = 8;
const CELL_GAP = 1;
/** Device px per dot in the canvas buffer (bigger = crisper, scaled by CSS). */
const DOT_PX = 3;

export class LcdView extends DiscreteView {
  #canvas = null;
  #grid = { cols: 16, rows: 2 };
  #fb = null; // last framebuffer (re-rendered on resize/recolour)
  #dotColor = null; // resolved from the theme token, cached per COLOUR
  #dotColorFor = null;

  constructor(layer, component, callbacks = {}) {
    super(layer, component, callbacks);
    // DiscreteView's constructor calls updateParams() before this line runs
    // (the same super()-ordering hazard brick-view.js documents), so the
    // override below no-ops on that first pass. Build the canvas and re-run it.
    this.#canvas = el("canvas", { class: "part-lcd-screen" });
    this.updateParams(component.params);
  }

  /** Rebuild the module SVG, then re-lay the character canvas over its glass. */
  updateParams(params) {
    super.updateParams(params);
    // Called from super(), this subclass's fields do not exist yet — and a
    // private field that has not been installed does not read as undefined,
    // it THROWS. Hence the brand check rather than a plain null test.
    if (!(#canvas in this) || !this.#canvas) return;

    const def = partDef(this.ref);
    const cd = def.characterDisplay;
    const { color } = def.normalizeParams(params);
    this.#grid = { cols: cd.cols, rows: cd.rows };
    // The lit-dot colour is per-module, so the cache has to be too: a red
    // module recoloured blue would otherwise keep painting dark dots on a blue
    // field until something remounted it.
    if (color !== this.#dotColorFor) {
      this.#dotColor = null;
      this.#dotColorFor = color;
    }

    if (!this.element.contains(this.#canvas)) this.element.append(this.#canvas);

    // Position the canvas over the ACTIVE AREA (world px; the part element's
    // top-left IS the body box's origin) and give it a grid-proportioned
    // backing buffer (device px).
    const { body, screen } = cd;
    this.#canvas.style.left = `${(screen.x - body.minX) * PX_PER_UNIT}px`;
    this.#canvas.style.top = `${(screen.y - body.minY) * PX_PER_UNIT}px`;
    this.#canvas.style.width = `${screen.width * PX_PER_UNIT}px`;
    this.#canvas.style.height = `${screen.height * PX_PER_UNIT}px`;
    // The buffer models the active area, so it drops its own TRAILING
    // inter-character gap exactly as the real active area does. Without that
    // the CSS stretch squeezes every cell by one gap's worth. It is the same
    // arithmetic the catalog derives `charPitch` with, which is what keeps the
    // drawn cells on the module's own pitch rather than near it.
    this.#canvas.width = (cd.cols * (CELL_W + CELL_GAP) - CELL_GAP) * DOT_PX;
    this.#canvas.height = (cd.rows * (CELL_H + CELL_GAP) - CELL_GAP) * DOT_PX;

    this.renderFramebuffer(this.#fb);
  }

  /**
   * Paint the visible character grid. `fb` is the framebuffer derived by the
   * SimController (chars + cgram + cursor + displayOn), or null to blank the
   * screen (not running / display off). The font comes from the CGROM module.
   */
  renderFramebuffer(fb) {
    this.#fb = fb;
    const ctx = this.#canvas?.getContext?.("2d");
    if (!ctx) return; // jsdom canvas has no 2d context — safe no-op
    const W = this.#canvas.width;
    const H = this.#canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!fb || !fb.displayOn) return; // the blank backlit panel shows through

    const cols = Math.min(fb.cols, this.#grid.cols);
    const rows = Math.min(fb.rows, this.#grid.rows);
    const cellW = (CELL_W + CELL_GAP) * DOT_PX;
    const cellH = (CELL_H + CELL_GAP) * DOT_PX;
    ctx.fillStyle = this.#resolveDotColor(); // a lit dot, on the backlit field

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const code = fb.chars[r * fb.cols + c];
        const rowsBits = glyphRows(code, fb.cgram);
        const ox = c * cellW;
        const oy = r * cellH;
        for (let gy = 0; gy < CELL_H; gy++) {
          const bits = rowsBits[gy];
          for (let gx = 0; gx < CELL_W; gx++) {
            // Bit 4 (0b10000) is the leftmost of the 5 dot columns.
            if (bits & (1 << (CELL_W - 1 - gx))) {
              ctx.fillRect(ox + gx * DOT_PX, oy + gy * DOT_PX, DOT_PX, DOT_PX);
            }
          }
        }
      }
    }

    // Cursor: a solid underline on the bottom dot-row of its cell; blink is a
    // view concern (a CSS/rAF toggle) — the framebuffer only says where/whether.
    if (fb.cursor?.on && fb.cursor.row < rows && fb.cursor.col < cols) {
      const ox = fb.cursor.col * cellW;
      const oy = fb.cursor.row * cellH;
      ctx.fillRect(ox, oy + (CELL_H - 1) * DOT_PX, CELL_W * DOT_PX, DOT_PX);
    }
  }

  /**
   * The lit-dot colour for THIS module's backlight, from the theme token.
   * Every panel but blue is positive-mode (dark dots on a tinted field); the
   * classic blue one is negative-mode, light dots on blue — which is why the
   * colour can't be one token, and why this is read rather than assumed.
   */
  #resolveDotColor() {
    if (this.#dotColor) return this.#dotColor;
    const v = getComputedStyle(this.element)
      .getPropertyValue(`--color-lcd-dot-${this.#dotColorFor}`)
      .trim();
    this.#dotColor = v || "#16261a";
    return this.#dotColor;
  }
}
