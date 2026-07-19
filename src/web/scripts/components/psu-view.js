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

// psu-view.js — a power-supply brick on the desk (.layer-parts): rounded
// body, voltage badge, and the red `+` / black `−` terminal pads whose
// centers are the addressable wire points (psu1.+ / psu1.-). Drawn once;
// the badge text updates when the voltage changes.

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { partDef } from "../catalog/index.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

/**
 * Build a PSU brick's SVG from the catalog def + params. Pure DOM
 * construction (unit-testable under jsdom).
 */
export function buildPsuSvg(params = {}) {
  const def = partDef("psu");
  const { width, height } = def.size;
  const { volts } = def.normalizeParams(params);

  const svg = svgEl("svg", {
    class: "part-psu-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  svg.append(
    svgEl("rect", {
      class: "part-psu-body",
      x: 0.1,
      y: 0.1,
      width: width - 0.2,
      height: height - 0.2,
      rx: 0.5,
    }),
  );

  const badge = svgEl("text", {
    class: "part-psu-badge",
    x: width / 2,
    y: 1.9,
    "text-anchor": "middle",
  });
  badge.textContent = `${volts} V`;
  svg.append(badge);

  for (const t of def.terminals) {
    const plus = t.id === "+";
    svg.append(
      svgEl("circle", {
        class: `part-psu-terminal part-psu-terminal--${plus ? "plus" : "minus"}`,
        cx: t.dx,
        cy: t.dy,
        r: 0.55,
      }),
    );
    const glyph = svgEl("text", {
      class: "part-psu-terminal-glyph",
      x: t.dx,
      y: t.dy + 0.22,
      "text-anchor": "middle",
    });
    glyph.textContent = plus ? "+" : "−";
    svg.append(glyph);
  }
  return svg;
}

export class PsuView {
  #el;
  #id;

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} psu
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onDoubleClick] -
   *   opens the terminal-assignments window (Feature 100 wiring aid).
   */
  constructor(
    layer,
    psu,
    { onPointerDown, onContextMenu, onDoubleClick } = {},
  ) {
    this.#id = psu.id;
    this.#el = el("div", {
      class: "part part-psu",
      dataset: { componentId: psu.id },
    });
    this.updateParams(psu.params);
    this.setPosition(psu.x, psu.y);
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

  /** Rebuild the SVG (the badge shows the current volts). */
  updateParams(params) {
    this.#el.querySelector("svg")?.remove();
    this.#el.prepend(buildPsuSvg(params));
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
