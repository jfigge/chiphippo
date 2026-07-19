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

// clock-view.js — a clock source brick on the desk (.layer-parts): a body with
// a rate badge (1/2/5/10 Hz or MAN), a pulse indicator that lights while the
// output is HIGH, and the `out` / `gnd` terminal pads (the addressable wire
// points clk1.out / clk1.gnd). The blink is driven from chiphippo:sim-state
// (setLevel) — the timer itself lives in the SimController, never here. In
// manual mode the whole body is a click-to-toggle button (the controller owns
// that gesture, like a slide switch).

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

const rateLabel = (hz) => (hz === "manual" ? "MAN" : `${hz} Hz`);

/** Build a clock brick's SVG from the catalog def + params. */
export function buildClockSvg(params = {}) {
  const def = partDef("clock");
  const { width, height } = def.size;
  const { hz } = def.normalizeParams(params);

  const svg = svgEl("svg", {
    class: "part-clock-svg",
    viewBox: `0 0 ${width} ${height}`,
    width: width * PX_PER_UNIT,
    height: height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  svg.append(
    svgEl("rect", {
      class: "part-clock-body",
      x: 0.1,
      y: 0.1,
      width: width - 0.2,
      height: height - 0.2,
      rx: 0.5,
    }),
  );

  // Pulse lamp (lights while the output is HIGH) + a small square-wave glyph.
  svg.append(
    svgEl("circle", { class: "part-clock-lamp", cx: 1.2, cy: 1.5, r: 0.45 }),
    svgEl("path", {
      class: "part-clock-wave",
      d: "M 2.3 2.0 L 2.3 1.0 L 3.1 1.0 L 3.1 2.0 L 3.9 2.0 L 3.9 1.0 L 4.7 1.0",
    }),
  );

  const badge = svgEl("text", {
    class: "part-clock-badge",
    x: width / 2 + 0.6,
    y: 1.85,
    "text-anchor": "middle",
  });
  badge.textContent = rateLabel(hz);
  svg.append(badge);

  for (const t of def.terminals) {
    svg.append(
      svgEl("circle", {
        class: `part-clock-terminal part-clock-terminal--${t.id}`,
        cx: t.dx,
        cy: t.dy,
        r: 0.55,
      }),
    );
    const glyph = svgEl("text", {
      class: "part-clock-terminal-glyph",
      x: t.dx,
      y: t.dy + 0.22,
      "text-anchor": "middle",
    });
    glyph.textContent = t.id === "out" ? "⎍" : "⏚";
    svg.append(glyph);
  }
  return svg;
}

export class ClockView {
  #el;
  #id;

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,x:number,y:number,params:object}} clock
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onDoubleClick] -
   *   opens the terminal-assignments window (Feature 100 wiring aid).
   */
  constructor(
    layer,
    clock,
    { onPointerDown, onContextMenu, onDoubleClick } = {},
  ) {
    this.#id = clock.id;
    this.#el = el("div", {
      class: "part part-clock",
      dataset: { componentId: clock.id },
    });
    this.updateParams(clock.params);
    this.setPosition(clock.x, clock.y);
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

  /** Rebuild the SVG (the badge shows the current rate). */
  updateParams(params) {
    this.#el.querySelector("svg")?.remove();
    this.#el.prepend(buildClockSvg(params));
  }

  /** Reflect the live output level (Feature 100): lamp on while HIGH. */
  setLevel(on) {
    this.#el.classList.toggle("part-clock--high", on === true);
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
