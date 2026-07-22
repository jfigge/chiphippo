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

// lcd-view.js — an HD44780 character-LCD module on the desk (.layer-parts): a
// bezel body, a green display panel, and the 16 wireable terminal pads (the
// addressable wire points lcd1.VDD / lcd1.RS / lcd1.DB0 …). The static body +
// terminals are `buildLcdSvg` (shared with the placement ghost); the live
// characters are drawn onto an overlaid `<canvas>` by `renderFramebuffer`,
// which the SimOverlay feeds from chiphippo:sim-state. The controller logic,
// font, and cursor blink live elsewhere — this view only paints what it's told.

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";
import { lcdGeometry } from "../catalog/parts.js";
import { glyphRows } from "../sim/hd44780-cgrom.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

/** The display panel rectangle within the body (pitch units). The canvas that
    draws the characters is positioned exactly over this. */
export const LCD_PANEL = Object.freeze({ x: 2, y: 1.5, w: 22, h: 8 });

/** HD44780 5×8 character cell (dots) + a one-dot gap between cells. */
const CELL_W = 5;
const CELL_H = 8;
const CELL_GAP = 1;
/** Device px per dot in the canvas buffer (bigger = crisper, scaled by CSS). */
const DOT_PX = 3;

/** Terminal id → colour family (power / control / data / aux) for the pad CSS. */
function terminalKind(id) {
  if (id === "VSS" || id === "VDD") return "power";
  if (id === "RS" || id === "RW" || id === "E") return "ctrl";
  if (id.startsWith("DB")) return "data";
  return "aux";
}

/**
 * Build the LCD module's static SVG (body + panel + terminal pads). Pure DOM,
 * unit-testable under jsdom; the ghost uses it directly (no live canvas).
 */
export function buildLcdSvg(params = {}) {
  const def = partDef("lcd");
  const { width, height } = def.size;
  const { size } = def.normalizeParams(params);

  const svg = svgEl("svg", {
    class: "part-lcd-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  svg.append(
    svgEl("rect", {
      class: "part-lcd-body",
      x: 0.1,
      y: 0.1,
      width: width - 0.2,
      height: height - 0.2,
      rx: 0.6,
    }),
    svgEl("rect", {
      class: "part-lcd-panel",
      x: LCD_PANEL.x,
      y: LCD_PANEL.y,
      width: LCD_PANEL.w,
      height: LCD_PANEL.h,
      rx: 0.3,
    }),
  );

  // Size badge in the top margin (like the PSU volts / clock rate badges).
  const badge = svgEl("text", {
    class: "part-lcd-size",
    x: width - 0.5,
    y: 1.2,
    "text-anchor": "end",
  });
  badge.textContent = size.replace("x", "×");
  svg.append(badge);

  for (const t of def.terminals) {
    svg.append(
      svgEl("circle", {
        class: `part-lcd-terminal part-lcd-terminal--${terminalKind(t.id)}`,
        cx: t.dx,
        cy: t.dy,
        r: 0.5,
      }),
    );
    const label = svgEl("text", {
      class: "part-lcd-terminal-label",
      x: t.dx,
      y: t.dy - 0.9,
      "text-anchor": "middle",
    });
    label.textContent = String(t.pin);
    svg.append(label);
  }
  return svg;
}

export class LcdView {
  #el;
  #id;
  #canvas;
  #cols = 16;
  #rows = 2;
  #fb = null; // last framebuffer (re-rendered on resize)
  #dotColor = null; // resolved from --color-lcd-dot on first paint (cached)

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} lcd
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onDoubleClick]
   */
  constructor(
    layer,
    lcd,
    { onPointerDown, onContextMenu, onDoubleClick } = {},
  ) {
    this.#id = lcd.id;
    this.#el = el("div", {
      class: "part part-lcd",
      dataset: { componentId: lcd.id },
    });
    this.#canvas = el("canvas", { class: "part-lcd-screen" });
    this.updateParams(lcd.params);
    this.setPosition(lcd.x, lcd.y);
    this.#el.addEventListener("pointerdown", (e) =>
      onPointerDown?.(this.#id, e),
    );
    this.#el.addEventListener("contextmenu", (e) =>
      onContextMenu?.(this.#id, e),
    );
    this.#el.addEventListener("dblclick", (e) => onDoubleClick?.(this.#id, e));
    layer.append(this.#el);
  }

  get id() {
    return this.#id;
  }

  get element() {
    return this.#el;
  }

  /** Rebuild the body SVG and size the character canvas for the chosen grid. */
  updateParams(params) {
    const { size } = partDef("lcd").normalizeParams(params);
    const geo = lcdGeometry(size);
    this.#cols = geo.cols;
    this.#rows = geo.rows;

    this.#el.querySelector("svg")?.remove();
    this.#el.prepend(buildLcdSvg(params));
    if (!this.#el.contains(this.#canvas)) this.#el.append(this.#canvas);

    // Position the canvas over the panel (world px) and give it a crisp,
    // grid-proportioned backing buffer (device px).
    this.#canvas.style.left = `${LCD_PANEL.x * PX_PER_UNIT}px`;
    this.#canvas.style.top = `${LCD_PANEL.y * PX_PER_UNIT}px`;
    this.#canvas.style.width = `${LCD_PANEL.w * PX_PER_UNIT}px`;
    this.#canvas.style.height = `${LCD_PANEL.h * PX_PER_UNIT}px`;
    this.#canvas.width = this.#cols * (CELL_W + CELL_GAP) * DOT_PX;
    this.#canvas.height = this.#rows * (CELL_H + CELL_GAP) * DOT_PX;

    this.renderFramebuffer(this.#fb);
  }

  /**
   * Paint the visible character grid. `fb` is the framebuffer derived by the
   * SimController (chars + cgram + cursor + displayOn), or null to blank the
   * screen (not running / display off). The font comes from the CGROM module.
   */
  renderFramebuffer(fb) {
    this.#fb = fb;
    const ctx = this.#canvas.getContext?.("2d");
    if (!ctx) return; // jsdom canvas has no 2d context — safe no-op
    const W = this.#canvas.width;
    const H = this.#canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!fb || !fb.displayOn) return; // blank green panel shows through

    const cols = Math.min(fb.cols, this.#cols);
    const rows = Math.min(fb.rows, this.#rows);
    const cellW = (CELL_W + CELL_GAP) * DOT_PX;
    const cellH = (CELL_H + CELL_GAP) * DOT_PX;
    ctx.fillStyle = this.#resolveDotColor(); // lit dot (dark on the green field)

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

  /** The lit-dot colour from the theme token, resolved once and cached. */
  #resolveDotColor() {
    if (this.#dotColor) return this.#dotColor;
    const v = getComputedStyle(this.#el)
      .getPropertyValue("--color-lcd-dot")
      .trim();
    this.#dotColor = v || "#16261a";
    return this.#dotColor;
  }

  /** Reflect power/health (Feature 90): mirror the chip fault classes. */
  setStatus(status) {
    for (const s of ["unpowered", "underpowered", "reversed", "damaged"]) {
      this.#el.classList.toggle(`part-lcd--${s}`, status === s);
    }
  }

  /** Desk origin in pitch units → world px. */
  setPosition(x, y) {
    this.#el.style.left = `${x * PX_PER_UNIT}px`;
    this.#el.style.top = `${y * PX_PER_UNIT}px`;
  }

  setSelected(on) {
    this.#el.classList.toggle("part--selected", on);
  }

  setDragging(on) {
    this.#el.classList.toggle("part--dragging", on);
  }

  setIllegal(on) {
    this.#el.classList.toggle("part--illegal", on);
  }

  remove() {
    this.#el.remove();
  }
}
