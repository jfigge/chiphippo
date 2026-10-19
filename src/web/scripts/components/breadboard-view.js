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

// breadboard-view.js — a breadboard drawn on the desk. Each board is one
// absolutely positioned `.board` element containing a single inline <svg>
// built ONCE from the Feature 20 spec (body, trench groove, rail stripes,
// row/column labels, and every hole). The SVG's viewBox is in pitch units, so
// it scales with the camera for free — pan/zoom never touches it.
//
// NO per-hole DOM events or ids: 830 holes × N boards stay inert; all hole
// interaction is holeAt() math from pointer coordinates (DeskController).
// All colors come from theme.css tokens via the SVG part classes.

import { el, svgEl } from "../dom.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import {
  holePosition,
  holes,
  spec,
  stripLetters,
} from "../model/breadboard.js";
import { railStripes } from "../desk/rail-stripes.js";
import { veroCopper } from "../desk/vero-copper.js";

/** Corner radius of the board body (pitch units). */
const BODY_RADIUS = 0.6;

/** Hole square: side and corner radius (pitch units). */
const HOLE_SIZE = 0.44;
const HOLE_RADIUS = 0.08;

/** A veroboard hole's drawn radius (pitch units): a 1 mm drill. */
const VERO_HOLE_R = 0.2;

/** The least margin (pitch units, edge to first hole) a veroboard prints its
    strip letters or hole numbers in; a tighter board goes unprinted there. */
const VERO_LABEL_MARGIN = 0.55;

/** Unique ids for each veroboard's hole pattern (an SVG id is document-wide,
    and two boards of different sizes put their holes at different phases). */
let veroPatternSeq = 0;

/**
 * Build a board's complete SVG from its Feature 20 spec. Pure DOM
 * construction (unit-testable under jsdom): geometry comes exclusively from
 * the model API — holes()/holePosition() — never hand arithmetic.
 *
 * @param {string} type - "full" | "half" | "tiny", a strip, or a veroboard size
 * @param {{cuts?: string[]}} [opts] - a veroboard's cut tracks
 * @returns {SVGSVGElement}
 */
export function buildBoardSvg(type, { cuts } = {}) {
  const s = spec(type);
  if (s.kind === "vero") return buildVeroSvg(type, cuts);
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
  // Rail strips have no grid, so no trench.
  if (s.trench) {
    svg.append(
      svgEl("rect", {
        class: "board-trench",
        x: 0,
        y: s.trench.centerY - s.trench.height / 2,
        width: s.width,
        height: s.trench.height,
      }),
    );
  }

  // Rail color stripes: red beside each `+` row, blue beside each `-` row,
  // one per rail SEGMENT — so a split rail prints broken where its halves
  // part (desk/rail-stripes.js, shared with the 3D view).
  for (const stripe of railStripes(type)) {
    const plus = stripe.polarity === "+";
    svg.append(
      svgEl("rect", {
        class: `board-rail-stripe board-rail-stripe--${plus ? "plus" : "minus"}`,
        x: stripe.x0,
        y: stripe.y0,
        width: stripe.x1 - stripe.x0,
        height: stripe.y1 - stripe.y0,
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

/**
 * A veroboard, seen from the component side: the substrate, the copper strips
 * showing through it (each RUN its own rect, so a cut is a real gap — the same
 * rects the 3D underside draws, desk/vero-copper.js), the strip letters and
 * hole numbers, and the holes. A cut is shown by its gap alone — no mark is
 * left on the board; the Cut Track tool's ring says so on hover.
 *
 * THE HOLES ARE ONE RECT, filled with a pattern, never a rect each: a 12 × 17 in
 * sheet has 20 400 of them, and the lattice is regular by construction. The
 * copper is its own group (`.vero-copper`) so a cut redraws only that
 * (`drawVeroCopper`).
 */
function buildVeroSvg(type, cuts) {
  const s = spec(type);
  const svg = svgEl("svg", {
    class: "board-svg board-svg--vero",
    viewBox: `0 0 ${s.width} ${s.height}`,
    width: s.width * PX_PER_UNIT,
    height: s.height * PX_PER_UNIT,
    "aria-hidden": "true",
  });
  svg.append(
    svgEl("rect", {
      class: "board-body board-body--vero",
      x: 0,
      y: 0,
      width: s.width,
      height: s.height,
      rx: 0.15,
    }),
  );

  const copper = svgEl("g", { class: "vero-copper" });
  drawVeroCopper(copper, type, cuts);
  svg.append(copper);

  // Strip letters along the top edge and hole numbers down the left, at the
  // first and every fifth — the breadboard's own cadence — printed in the
  // margin a stripboard has, so only where it has room for them.
  const labels = svgEl("g", { class: "board-col-labels" });
  const label = (x, y, anchor, text) => {
    const t = svgEl("text", { class: "vero-label", x, y, "text-anchor": anchor }); // prettier-ignore
    t.textContent = text;
    labels.append(t);
  };
  const marked = (n) => n === 1 || n % 5 === 0;
  if (s.rowStartY >= VERO_LABEL_MARGIN) {
    for (let strip = 1; strip <= s.cols; strip++) {
      if (marked(strip)) label(s.colStartX + strip - 1, s.rowStartY - 0.3, "middle", stripLetters(strip)); // prettier-ignore
    }
  }
  if (s.colStartX >= VERO_LABEL_MARGIN) {
    for (let index = 1; index <= s.rows; index++) {
      if (marked(index)) label(s.colStartX - 0.26, s.rowStartY + index - 0.89, "end", String(index)); // prettier-ignore
    }
  }
  svg.append(labels);

  const id = `vero-holes-${++veroPatternSeq}`;
  const defs = svgEl("defs");
  const pattern = svgEl("pattern", {
    id,
    patternUnits: "userSpaceOnUse",
    x: s.colStartX - 0.5,
    y: s.rowStartY - 0.5,
    width: 1,
    height: 1,
  });
  pattern.append(
    svgEl("circle", { class: "vero-hole", cx: 0.5, cy: 0.5, r: VERO_HOLE_R }),
  );
  defs.append(pattern);
  svg.append(
    defs,
    svgEl("rect", {
      class: "vero-holes",
      x: s.colStartX - 0.5,
      y: s.rowStartY - 0.5,
      width: s.cols,
      height: s.rows,
      fill: `url(#${id})`,
    }),
  );
  return svg;
}

/**
 * (Re)draw a veroboard's copper into its `.vero-copper` group: one rect per
 * run, so a cut is the gap between two. Called once at build and again for
 * every cut, so a cut costs a few hundred rects at most, never the holes.
 */
export function drawVeroCopper(group, type, cuts) {
  const { rects } = veroCopper(type, cuts);
  group.replaceChildren(
    ...rects.map((r) =>
      svgEl("rect", {
        class: "vero-strip",
        x: r.x0,
        y: r.y0,
        width: r.x1 - r.x0,
        height: r.y1 - r.y0,
      }),
    ),
  );
}

/**
 * Spin a strip element a quarter lap at a time. The SVG is built ONCE in the
 * strip's own frame and turned with a CSS transform; the translate keeps it
 * pinned to its top-left corner, so `left`/`top` still mean the board origin
 * at every angle — which is exactly what holePosition assumes. Shared by the
 * placed view and the placement ghost so the two can never disagree.
 */
export function applyBoardRotation(element, type, rot) {
  const { width, height } = spec(type);
  const [w, h] = [width * PX_PER_UNIT, height * PX_PER_UNIT];
  const transform = {
    90: `translateX(${h}px) rotate(90deg)`,
    180: `translate(${w}px, ${h}px) rotate(180deg)`,
    270: `translateY(${w}px) rotate(270deg)`,
  }[rot];
  element.style.transform = transform ?? "";
  element.style.transformOrigin = "0 0";
}

export class BreadboardView {
  #el;
  #id;
  #type;

  /**
   * @param {HTMLElement} layer - the `.layer-boards` element to mount into.
   * @param {{id:string,type:string,x:number,y:number}} board
   * @param {object} [callbacks]
   * @param {(id: string, e: PointerEvent) => void} [callbacks.onPointerDown]
   * @param {(id: string, e: MouseEvent) => void} [callbacks.onContextMenu]
   */
  constructor(layer, board, { onPointerDown, onContextMenu } = {}) {
    this.#id = board.id;
    this.#type = board.type;
    this.#el = el("div", { class: "board", dataset: { boardId: board.id } });
    this.#el.append(buildBoardSvg(board.type, { cuts: board.cuts }));
    this.setRotation(board.rot ?? 0);
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

  /**
   * Turn the strip a quarter lap at a time. The SVG is built ONCE in the
   * strip's own frame and spun with a CSS transform — the translate keeps the
   * turned strip pinned to its top-left corner, so `left`/`top` still mean the
   * board origin at every angle (which is exactly what holePosition assumes).
   */
  setRotation(rot) {
    applyBoardRotation(this.#el, this.#type, rot);
  }

  /** Redraw a veroboard's copper for a new cut list — the copper only; the
      holes and the labels are untouched. A no-op on any other board. */
  setCuts(cuts) {
    const group = this.#el.querySelector(".vero-copper");
    if (group) drawVeroCopper(group, this.#type, cuts);
  }

  setSelected(on) {
    this.#el.classList.toggle("board--selected", on);
  }

  setDragging(on) {
    this.#el.classList.toggle("board--dragging", on);
  }

  /** Part of the set the current grab will move — lit as one block. */
  setDragSet(on) {
    this.#el.classList.toggle("board--drag-set", on);
  }

  remove() {
    this.#el.remove();
  }
}
