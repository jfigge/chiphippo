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
