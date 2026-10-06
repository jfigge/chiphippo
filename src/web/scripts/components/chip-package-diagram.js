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

// chip-package-diagram.js — a custom chip's package as a datasheet draws it
// (the chip designer): pin 1 top-left, down the left side, back up the right,
// each pin's number beside the package and its name beside that. The body
// wears the marks it has on the desk — the custom plastic, the folded corner,
// the `</>` — so the window and the board show recognisably the same part.
//
// It is the package half of the designer's two-way hover linking: hovering a
// pin reports it (`onPinHover`), and `setLinked` lights the pins the code's
// hovered name refers to. In the debugger it shows each pin's live level.
//
// HTML, not SVG: its text is chrome, and has to grow with the app's font size
// like any other label (the desk's chips are drawn in world units instead).

import { el } from "../dom.js";
import { chipMarkingOf, customPins } from "../model/custom-chip.js";

/** The `</>` mark, as the tray and the desk draw it. */
const GLYPH =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 10" width="1.2em" ' +
  'height="0.75em" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M4 1 1 5l3 4M7.5 9l1-8M12 1l3 4-3 4"/></svg>';

const LEVEL_CLASS = { H: "h", L: "l", Z: "z", X: "x" };

export class ChipPackageDiagram {
  #root;
  #onPinHover;
  #onPinClick;
  #pinNodes = new Map(); // pin → [name cell, number cell]
  #hovered = null;

  /**
   * @param {object} [opts]
   * @param {(pin: number|null) => void} [opts.onPinHover]
   * @param {(pin: number) => void} [opts.onPinClick]
   */
  constructor({ onPinHover, onPinClick } = {}) {
    this.#onPinHover = onPinHover;
    this.#onPinClick = onPinClick;
    this.#root = el("div", { class: "cd-package" });
  }

  get element() {
    return this.#root;
  }

  /**
   * Draw a chip.
   * @param {object} chip - a stored custom chip.
   * @param {object} [opts]
   * @param {Map<number, string>} [opts.levels] - each pin's level (running).
   */
  render(chip, { levels = null } = {}) {
    this.#pinNodes.clear();
    if (!chip) {
      this.#root.replaceChildren();
      return;
    }
    const pins = customPins(chip);
    const per = chip.pinsPerSide;
    const glyph = el("span", { class: "cd-package-glyph", "aria-hidden": "true" }); // prettier-ignore
    glyph.innerHTML = GLYPH;
    const body = el(
      "div",
      {
        class: `cd-package-body${chip.wide ? " cd-package-body--wide" : ""}`,
        style: { gridRow: `1 / span ${per}` },
      },
      [
        el("span", { class: "cd-package-notch", "aria-hidden": "true" }),
        el("span", { class: "cd-package-fold", "aria-hidden": "true" }),
        glyph,
        el("span", { class: "cd-package-marking", text: chipMarkingOf(chip) }),
      ],
    );
    const cells = [body];
    for (let row = 0; row < per; row++) {
      const left = pins[row]; // 1 … N, top to bottom
      const right = pins[2 * per - 1 - row]; // 2N … N+1, top to bottom
      cells.push(...this.#pinCells(left, "left", row, levels));
      cells.push(...this.#pinCells(right, "right", row, levels));
    }
    const grid = el(
      "div",
      {
        class: "cd-package-grid",
        style: { gridTemplateRows: `repeat(${per}, auto)` },
      },
      cells,
    );
    this.#root.replaceChildren(grid);
  }

  /** Light these pins (null or empty: none). */
  setLinked(pins) {
    const lit = new Set(pins ?? []);
    for (const [pin, nodes] of this.#pinNodes) {
      for (const n of nodes) n.classList.toggle("cd-pin--linked", lit.has(pin));
    }
  }

  #pinCells(pin, side, row, levels) {
    const level = levels?.get(pin.n);
    const classes = [
      "cd-pin",
      `cd-pin--${side}`,
      `cd-pin--${pin.role}`,
      level ? `cd-pin--level-${LEVEL_CLASS[level] ?? "z"}` : "",
    ].filter(Boolean).join(" "); // prettier-ignore
    const gridRow = String(row + 1);
    const name = el("div", {
      class: `${classes} cd-pin-name`,
      style: { gridRow, gridColumn: side === "left" ? "1" : "5" },
      text: pin.name,
      title: pin.name,
      dataset: { pin: String(pin.n) },
    });
    const number = el("div", {
      class: `${classes} cd-pin-number`,
      style: { gridRow, gridColumn: side === "left" ? "2" : "4" },
      text: String(pin.n),
      dataset: { pin: String(pin.n) },
    });
    for (const node of [name, number]) {
      node.addEventListener("mouseenter", () => this.#hover(pin.n));
      node.addEventListener("mouseleave", () => this.#hover(null));
      node.addEventListener("click", () => this.#onPinClick?.(pin.n));
    }
    this.#pinNodes.set(pin.n, [name, number]);
    return [name, number];
  }

  #hover(pin) {
    if (pin === this.#hovered) return;
    this.#hovered = pin;
    this.#onPinHover?.(pin);
  }
}
