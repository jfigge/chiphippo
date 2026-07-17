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

// breadboard-view.js — a breadboard drawn on the desk. Each board is one
// absolutely positioned `.board` element containing a single inline <svg>
// built ONCE from the Feature 20 spec (body, trench groove, rail stripes,
// row/column labels, and every hole). The SVG's viewBox is in pitch units, so
// it scales with the camera for free — pan/zoom never touches it.
//
// NO per-hole DOM events or ids: 830 holes × N boards stay inert; all hole
// interaction is holeAt() math from pointer coordinates (DeskController).
// All colors come from theme.css tokens via the SVG part classes.

import { el } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition, holes, spec } from "../model/breadboard.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** createElementNS + attributes, for the builder below. */
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  return node;
}

/** Corner radius of the board body (pitch units). */
const BODY_RADIUS = 0.6;

/** Hole square: side and corner radius (pitch units). */
const HOLE_SIZE = 0.44;
const HOLE_RADIUS = 0.08;

/** Rail color stripe: thickness and end overhang past the outer holes. */
const STRIPE_HEIGHT = 0.22;
const STRIPE_OVERHANG = 0.7;

/**
 * Build a board's complete SVG from its Feature 20 spec. Pure DOM
 * construction (unit-testable under jsdom): geometry comes exclusively from
 * the model API — holes()/holePosition() — never hand arithmetic.
 *
 * @param {string} type - "full" | "half" | "tiny"
 * @returns {SVGSVGElement}
 */
export function buildBoardSvg(type) {
  const s = spec(type);
  const svg = svgEl("svg", {
    class: "board-svg",
    viewBox: `0 0 ${s.width} ${s.height}`,
    width: s.width * PX_PER_UNIT,
    height: s.height * PX_PER_UNIT,
    "aria-hidden": "true",
  });

  // Body: the plastic slab.
  svg.append(
    svgEl("rect", {
      class: "board-body",
      x: 0,
      y: 0,
      width: s.width,
      height: s.height,
      rx: BODY_RADIUS,
    }),
  );

  // Trench groove between the two column halves (DIP chips straddle it).
  svg.append(
    svgEl("rect", {
      class: "board-trench",
      x: 0,
      y: s.trench.centerY - s.trench.height / 2,
      width: s.width,
      height: s.trench.height,
    }),
  );

  // Rail color stripes: red beside each `+` row, blue beside each `-` row,
  // running the length of the rail's holes (outer side of each rail pair).
  for (const rail of s.rails) {
    const first = holePosition(type, `${rail.id}1`);
    const last = holePosition(type, `${rail.id}${s.railHoles}`);
    const plus = rail.polarity === "+";
    svg.append(
      svgEl("rect", {
        class: `board-rail-stripe board-rail-stripe--${plus ? "plus" : "minus"}`,
        x: first.x - STRIPE_OVERHANG,
        y: plus ? rail.y - 0.8 : rail.y + 0.58,
        width: last.x - first.x + 2 * STRIPE_OVERHANG,
        height: STRIPE_HEIGHT,
      }),
    );
  }

  // Row letters at both ends of every grid row.
  const rowLabels = svgEl("g", { class: "board-row-labels" });
  for (const row of Object.keys(s.rowY)) {
    const left = holePosition(type, `${row}1`);
    const right = holePosition(type, `${row}${s.cols}`);
    for (const [x, anchor] of [
      [left.x - 0.5, "end"],
      [right.x + 0.5, "start"],
    ]) {
      const label = svgEl("text", {
        class: "board-row-label",
        x,
        y: left.y + 0.22,
        "text-anchor": anchor,
      });
      label.textContent = row;
      rowLabels.append(label);
    }
  }
  svg.append(rowLabels);

  // Column numerals (1, 5, 10, …) above row j and below row a.
  const colLabels = svgEl("g", { class: "board-col-labels" });
  for (let col = 1; col <= s.cols; col++) {
    if (col !== 1 && col % 5 !== 0) continue;
    const top = holePosition(type, `j${col}`);
    const bottom = holePosition(type, `a${col}`);
    for (const [x, y] of [
      [top.x, top.y - 0.5],
      [bottom.x, bottom.y + 0.85],
    ]) {
      const label = svgEl("text", {
        class: "board-col-label",
        x,
        y,
        "text-anchor": "middle",
      });
      label.textContent = String(col);
      colLabels.append(label);
    }
  }
  svg.append(colLabels);

  // Every tie point as a small dark rounded square — inert (no ids, no
  // listeners); one group so the builder test can count them.
  const holesGroup = svgEl("g", { class: "board-holes" });
  for (const hole of holes(type)) {
    const pos = holePosition(type, hole);
    holesGroup.append(
      svgEl("rect", {
        class: "board-hole",
        x: pos.x - HOLE_SIZE / 2,
        y: pos.y - HOLE_SIZE / 2,
        width: HOLE_SIZE,
        height: HOLE_SIZE,
        rx: HOLE_RADIUS,
      }),
    );
  }
  svg.append(holesGroup);

  return svg;
}

export class BreadboardView {
  #el;
  #id;

  /**
   * @param {HTMLElement} layer - the `.layer-boards` element to mount into.
   * @param {{id:string,type:string,x:number,y:number}} board
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   */
  constructor(layer, board, { onPointerDown, onContextMenu } = {}) {
    this.#id = board.id;
    this.#el = el("div", { class: "board", dataset: { boardId: board.id } });
    this.#el.append(buildBoardSvg(board.type));
    this.setPosition(board.x, board.y);
    this.#el.addEventListener("pointerdown", (e) =>
      onPointerDown?.(this.#id, e),
    );
    this.#el.addEventListener("contextmenu", (e) =>
      onContextMenu?.(this.#id, e),
    );
    layer.append(this.#el);
  }

  get id() {
    return this.#id;
  }

  get element() {
    return this.#el;
  }

  /** Move the element to a board origin in pitch units (world px inside). */
  setPosition(x, y) {
    this.#el.style.left = `${x * PX_PER_UNIT}px`;
    this.#el.style.top = `${y * PX_PER_UNIT}px`;
  }

  setSelected(on) {
    this.#el.classList.toggle("board--selected", on);
  }

  setDragging(on) {
    this.#el.classList.toggle("board--dragging", on);
  }

  setIllegal(on) {
    this.#el.classList.toggle("board--illegal", on);
  }

  remove() {
    this.#el.remove();
  }
}
