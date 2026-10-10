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

// wire-color-dot.js — the Wire toolbar button's color dot: the one pill
// readout that is also the PICKER for what it shows. Clicking it opens a small
// popover holding the SAME eight swatches the wire's Properties dialog offers
// (components/color-swatches.js), and picking one closes the popover and
// reports the color. Picking does NOT arm the wire tool: the segment already
// arms when its label is clicked, so the dot has to be the one place that
// doesn't — otherwise there is no way to set the pending color without
// entering the tool.
//
// The dot is a <span> INSIDE the Wire <button>, not a button of its own: a
// nested <button> is invalid HTML, and re-splitting the pill segment is
// exactly what the toolbar redesign removed. So the click contract lives here
// — stopPropagation(), so choosing a color never toggles the tool underneath
// it — and it is why this is a module rather than a few lines in app.js: that
// contract is the thing most likely to regress, and app.js is mounted by no
// test.
//
// While the circuit RUNS the Wire segment is disabled, and the dot goes with
// it — but not for free: a disabled <button> suppresses its OWN activation,
// not clicks on its descendants, so the dot checks (see below).
//
// The dot stays `aria-hidden` and unfocusable. A focusable (or `role="button"`)
// descendant of a <button> is the ARIA equivalent of the nested button being
// avoided, so this is a POINTER shortcut to something already reachable
// another way: 1–8 while the wire tool is armed (DeskController.handleKeyDown),
// or a placed wire's own Properties dialog. The one real gap — no keyboard
// path while the tool is DISARMED — is what it was before this existed.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { WIRE_COLORS } from "../model/desk-doc.js";
import { wireColorName } from "../model/wire-colors.js";
import { buildColorSwatches } from "./color-swatches.js";

/** How far below the dot the popover's top edge sits (px). */
const GAP = 6;

/** Open the picker under `anchor`, showing `color` as the chosen one. */
function openPicker(anchor, color, onPick) {
  const swatches = buildColorSwatches({
    colors: WIRE_COLORS,
    value: color,
    ariaLabel: t("toolbar.wire.colorLabel"),
    onPick: (picked) => {
      // Close FIRST, then report — the order menu()/confirm() use, so a
      // callback that opens something of its own is never QUEUED behind this
      // popover. Picking the color it already is closes too: the click
      // answered the question, and setting it again changes nothing.
      PopupManager.close();
      onPick(picked);
    },
  });
  // Land focus on the CURRENT color rather than on the first swatch, so the
  // popover opens where the keyboard already is (mount() honors this).
  const selected = swatches.querySelector(".color-swatch--selected");
  if (selected) selected.dataset.autofocus = "true";

  const rect = anchor.getBoundingClientRect();
  PopupManager.popover({
    x: rect.left,
    y: rect.bottom + GAP,
    element: swatches,
  });
}

/**
 * Build the Wire button's color dot.
 *
 * @param {object} opts
 * @param {() => string} opts.getColor - the active wire color, read at CLICK
 *   time (never captured at construction — the popover must open showing what
 *   is current, whatever changed it).
 * @param {(color: string) => void} opts.onPick - fires once the popover has
 *   closed, with the chosen color.
 * @returns {{ element: HTMLSpanElement, setColor: (color: string) => void }}
 */
export function createWireColorDot({ getColor, onPick }) {
  const element = el("span", {
    class: "wire-swatch-dot",
    "aria-hidden": "true",
    onClick: (event) => {
      event.stopPropagation(); // never toggle the tool the dot sits inside
      // A DISABLED button (the circuit is running) does not make its own
      // descendants inert — the click still lands here, measured, not assumed.
      // So the dot asks the button it is in, and the CSS matches with
      // pointer-events:none so it doesn't offer a hover ring it won't honor.
      if (element.closest("button")?.disabled) return;
      openPicker(element, getColor(), onPick);
    },
  });

  const setColor = (color) => {
    // el()'s `style` prop bag can't set a CUSTOM property (CSSStyleDeclaration
    // ignores plain assignment for `--*` keys) — setProperty is the only way,
    // same as color-swatches.js's own swatches.
    element.style.setProperty("--wire-color", `var(--color-wire-${color})`);
    element.title = t("toolbar.wire.colorTitle", { color: wireColorName(color) }); // prettier-ignore
  };

  return { element, setColor };
}
