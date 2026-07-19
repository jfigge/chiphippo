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

// chip-view.js — a seated DIP chip drawn on the desk (.layer-parts): black
// body with a subtle top-light gradient, left notch, pin-1 dot, centered
// part number, and stub legs reaching the seated holes. One static SVG per
// chip (crisp at all zooms, no rebuilds on camera moves); NO per-pin DOM —
// pin hover is math over derived positions in DeskController.
//
// Local SVG coordinates are pitch units with the ORIGIN AT PIN 1's hole
// (row e, the component anchor); row f is exactly 3 pitches above (fixed by
// the board geometry every DIP relies on).

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition } from "../model/breadboard.js";
import { packageSpec } from "../model/footprints.js";
import { chipDef } from "../catalog/index.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

/** Footprint-box geometry shared by the builder and the ghost/controller. */
export function chipBox(pkg) {
  const { halfPins } = packageSpec(pkg);
  // x spans the pin columns ± body overhang; y spans row f → row e ± legs.
  return {
    minX: -0.6,
    minY: -3.6,
    width: halfPins - 1 + 1.2,
    height: 4.2,
  };
}

/** Body edges (pitch units, local coords): between the rows, inset. */
const BODY_TOP = -2.55;
const BODY_BOTTOM = -0.45;
const LEG_WIDTH = 0.28;

/**
 * Build a chip's complete SVG from its catalog def. Pure DOM construction
 * (unit-testable under jsdom).
 * @param {string} ref - catalog id, e.g. "7400"
 * @returns {SVGSVGElement}
 */
export function buildChipSvg(ref) {
  const def = chipDef(ref);
  if (!def) {
    const err = new Error(`unknown catalog ref: ${ref}`);
    err.code = "INVALID_REF";
    throw err;
  }
  const { halfPins } = packageSpec(def.package);
  const box = chipBox(def.package);

  const svg = svgEl("svg", {
    class: "part-chip-svg",
    viewBox: `${box.minX} ${box.minY} ${box.width} ${box.height}`,
    width: box.width * PX_PER_UNIT,
    height: box.height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  // Legs first (under the body edge): stubs from the body to each hole.
  // Row e holes sit at local y=0, row f at y=-3; the body spans between.
  const legs = svgEl("g", { class: "part-chip-legs" });
  for (let dcol = 0; dcol < halfPins; dcol++) {
    for (const [y, h] of [
      [BODY_BOTTOM - 0.05, 0.6], // down over the row-e holes
      [-3.1, BODY_TOP + 3.1], // up from the row-f holes to the body
    ]) {
      legs.append(
        svgEl("rect", {
          class: "part-chip-leg",
          x: dcol - LEG_WIDTH / 2,
          y,
          width: LEG_WIDTH,
          height: h,
        }),
      );
    }
  }
  svg.append(legs);

  // Body slab with the molded top-light sheen.
  svg.append(
    svgEl("rect", {
      class: "part-chip-body",
      x: box.minX + 0.1,
      y: BODY_TOP,
      width: box.width - 0.2,
      height: BODY_BOTTOM - BODY_TOP,
      rx: 0.18,
    }),
  );

  // Left notch (semicircle biting into the body) + pin-1 dot (bottom-left).
  svg.append(
    svgEl("path", {
      class: "part-chip-notch",
      d: `M ${box.minX + 0.1} -1.82 A 0.32 0.32 0 0 1 ${box.minX + 0.1} -1.18 Z`,
    }),
  );
  svg.append(
    svgEl("circle", {
      class: "part-chip-dot",
      cx: 0.12,
      cy: -0.82,
      r: 0.12,
    }),
  );

  // Centered part number.
  const label = svgEl("text", {
    class: "part-chip-label",
    x: (halfPins - 1) / 2,
    y: -1.28,
    "text-anchor": "middle",
  });
  label.textContent = def.id;
  svg.append(label);

  return svg;
}

export class ChipView {
  #el;
  #id;
  #ref;

  /**
   * @param {HTMLElement} layer - the `.layer-parts` element.
   * @param {{id:string,ref:string}} component
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onDoubleClick] -
   *   opens the pin-assignments window (Feature 100 wiring aid).
   */
  constructor(
    layer,
    component,
    { onPointerDown, onContextMenu, onDoubleClick } = {},
  ) {
    this.#id = component.id;
    this.#ref = component.ref;
    this.#el = el("div", {
      class: "part part-chip",
      dataset: { componentId: component.id },
    });
    this.#el.append(buildChipSvg(component.ref));
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

  get ref() {
    return this.#ref;
  }

  get element() {
    return this.#el;
  }

  /**
   * Seat the element: the SVG box is anchored on pin 1's hole, so the world
   * position is board origin + anchor hole position + the box offsets.
   * @param {{type:string,x:number,y:number}} board
   * @param {string} anchor - pin 1's hole id (row e)
   */
  updatePlacement(board, anchor) {
    const pos = holePosition(board.type, anchor);
    if (!pos) return; // defensive: never seat a view on a phantom hole
    const box = chipBox(chipDef(this.#ref).package);
    this.#el.style.left = `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`;
    this.#el.style.top = `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`;
  }

  /**
   * Reflect the simulator's power/health status (Feature 90): a colored badge
   * corner — grey unpowered, amber underpowered, red damaged; null clears it
   * (editing / stopped).
   */
  setStatus(status) {
    for (const s of ["unpowered", "underpowered", "damaged"]) {
      this.#el.classList.toggle(`part-chip--${s}`, status === s);
    }
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
