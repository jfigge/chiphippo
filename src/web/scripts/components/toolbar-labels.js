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

// toolbar-labels.js — the one-word labels under the header's icons
// (Settings ▸ Appearance ▸ Toolbar labels, `toolbarLabels`, Off by default).
//
// Every icon segment always CARRIES its label — a `.toolbar-pill-label` span
// after the glyph — and the setting only decides whether it is SHOWN: the
// header's `app-header--labels` class (app.css). So turning the option on or
// off is one class, applied live, with nothing rebuilt and nothing to keep in
// step; a language change rewrites the words whether or not they are showing.
//
// The label is `aria-hidden`: each button already has its accessible name (an
// `aria-label`, or its own text), and it is the name the label shortens. The
// tooltip (`title`) is untouched — a label adds to it, never replaces it.
//
// The icon is a direct-child <svg> beside the label, so a segment whose GLYPH
// changes with state (Fit's Shift preview, Schematic ⇄ Breadboard) swaps only
// the svg through `setSegmentIcon`; writing `innerHTML` would take the label
// with it.

import { el } from "../dom.js";

/** The header class that shows the labels. */
export const LABELS_CLASS = "app-header--labels";

/** The class of a segment's label span. */
export const LABEL_CLASS = "toolbar-pill-label";

/**
 * Give `btn` its label, or rewrite the one it has.
 * @param {HTMLElement} btn
 * @param {string} text
 * @returns {HTMLElement} btn
 */
export function setSegmentLabel(btn, text) {
  let label = btn.querySelector(`:scope > .${LABEL_CLASS}`);
  if (!label) {
    label = el("span", { class: LABEL_CLASS, "aria-hidden": "true" });
    btn.append(label);
  }
  if (label.textContent !== text) label.textContent = text;
  return btn;
}

/**
 * Put `svg` (markup) in as `btn`'s glyph — replacing the glyph it had, and
 * leaving the label (and any readout beside it) where it is.
 * @param {HTMLElement} btn
 * @param {string} svg
 * @returns {HTMLElement} btn
 */
export function setSegmentIcon(btn, svg) {
  btn.querySelector(":scope > svg")?.remove();
  btn.insertAdjacentHTML("afterbegin", svg);
  return btn;
}

/** Show or hide every label under `header`. */
export function showToolbarLabels(header, on) {
  header.classList.toggle(LABELS_CLASS, on === true);
}
