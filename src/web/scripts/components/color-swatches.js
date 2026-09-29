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

// color-swatches.js — the ONE color-picker control shared by the Part
// Properties dialog (a part's `"color"` field, e.g. the LED's `color`) and
// the Settings dialog ("Default LED color"). A row of clickable circle
// swatches over the `--color-wire-<name>` tokens the wire tool and the LED
// body already share; the selected one gets a ring. Both callers just need
// the list of color names, the current value, and an `onPick` callback —
// this is the only place that knows how to turn that into DOM.

import { el } from "../dom.js";
import { wireColorLabel } from "../model/wire-colors.js";

/**
 * Build a row of clickable color swatches, one per `colors` entry. Clicking
 * one updates every swatch's selected/ring state in place and calls
 * `onPick(color)`.
 * @param {object} opts
 * @param {string[]} opts.colors - color names (`LED_COLOR_OPTIONS`).
 * @param {string} opts.value - the currently selected color.
 * @param {(color: string) => void} opts.onPick - fires on click.
 * @param {string} [opts.ariaLabel] - label for the radiogroup.
 */
export function buildColorSwatches({ colors, value, onPick, ariaLabel }) {
  const buttons = [];
  for (const color of colors) {
    const btn = el("button", {
      class:
        "color-swatch" + (color === value ? " color-swatch--selected" : ""),
      type: "button",
      dataset: { color },
      title: wireColorLabel(color),
      "aria-label": wireColorLabel(color),
      "aria-pressed": String(color === value),
      onClick: () => {
        for (const b of buttons) {
          const selected = b.dataset.color === color;
          b.classList.toggle("color-swatch--selected", selected);
          b.setAttribute("aria-pressed", String(selected));
        }
        onPick(color);
      },
    });
    // el()'s `style` prop bag can't set a CUSTOM property (CSSStyleDeclaration
    // ignores plain assignment for `--*` keys) — setProperty is the only way,
    // same as the toolbar's wire-color dot in app.js.
    btn.style.setProperty("--wire-color", `var(--color-wire-${color})`);
    buttons.push(btn);
  }
  return el(
    "div",
    { class: "color-swatches", role: "radiogroup", "aria-label": ariaLabel },
    buttons,
  );
}
