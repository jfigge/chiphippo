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

// bus-width-badge.js — the Bus toolbar button's width badge: the second pill
// readout that is also the PICKER for what it shows, built to the contract
// components/wire-color-dot.js established. Clicking it opens a small popover
// holding one circled number per BUS_WIDTHS preset (2…8, 16), laid out in a
// row so the picker reads as the badge's own list; picking one closes the
// popover and reports the bus NAME (`D[3:0]`), which is what the tool parses.
//
// Picking does NOT toggle the bus tool: the badge is shown only while the
// tool is armed (wire-bus-glyphs.js), and a pick leaves it armed. The width
// has NO keyboard path (Jason, 2026-11-10: 1–8 pick the wire colour with the
// bus tool armed, as with the wire), so this picker is the one place to set
// it — the accepted exception to "a readout is never the only way"
// (ui-chrome.md). A placed bus's rename changes its name, not the width.
//
// The badge is a <span> INSIDE the Bus <button> and stays `aria-hidden` and
// unfocusable, for the reasons wire-color-dot.js sets out at length: a nested
// <button> is invalid HTML, and an interactive DESCENDANT of a button has no
// honest place in the accessibility tree. So this is a POINTER shortcut to
// something already reachable another way, never the only way. The click
// contract — stopPropagation, and the disabled-button guard a running circuit
// needs — is why this is a module rather than a few lines of app.js, which no
// test mounts.
//
// The option row is deliberately local rather than a shared control: unlike
// the color swatches (which the Part Properties and Settings dialogs offer
// too) a bus width is picked in exactly one place.
//
// Since the badge is drawn IN the wire colour (Jason, 2026-11-10), it picks
// that too: the popover holds the width row and, under it, the SAME eight
// swatches the Wire's square opens (components/color-swatches.js) — a bus is
// laid in the active wire colour. Either pick closes it.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { BUS_WIDTHS, WIRE_COLORS } from "../model/desk-doc.js";
import { buildColorSwatches } from "./color-swatches.js";

/** How far below the badge the popover's top edge sits (px). */
const GAP = 6;

/** The glyph a bus name shows as — its preset's bit count, defaulting to the
    8-bit bus for a name that is none of them. */
export function busWidthGlyph(name) {
  return BUS_WIDTHS.find((w) => w.name === name)?.bits.toString() ?? "8";
}

/** The row of circled widths the popover holds, `value` being the active bus
    name (the one that gets the ring). */
function buildOptions(value, onPick) {
  const buttons = BUS_WIDTHS.map((preset) => {
    const selected = preset.name === value;
    const btn = el("button", {
      class:
        "bus-width-option" + (selected ? " bus-width-option--selected" : ""),
      type: "button",
      dataset: { name: preset.name },
      text: preset.bits.toString(),
      title: t("toolbar.bus.optionTitle", {
        bits: preset.bits,
        name: preset.name,
      }),
      "aria-label": t("toolbar.bus.optionLabel", { bits: preset.bits }),
      "aria-pressed": String(selected),
      onClick: () => onPick(preset.name),
    });
    // Open where the keyboard already is, rather than on the narrowest width
    // (mount() honors this).
    if (selected) btn.dataset.autofocus = "true";
    return btn;
  });
  return el(
    "div",
    {
      class: "bus-width-options",
      role: "radiogroup",
      "aria-label": t("toolbar.bus.widthLabel"),
    },
    buttons,
  );
}

/**
 * Build the Bus button's width badge.
 *
 * @param {object} opts
 * @param {() => string} opts.getName - the active bus name, read at CLICK time
 *   (never captured at construction — the popover must open showing what is
 *   current, whatever changed it — today only a pick of its own, but the
 *   badge never assumes it is the only writer).
 * @param {(name: string) => void} opts.onPick - fires once the popover has
 *   closed, with the chosen preset's bus name.
 * @param {() => string} [opts.getColor] - the active wire colour, read at
 *   click time; with `onPickColor`, the popover offers the colour under the
 *   widths.
 * @param {(color: string) => void} [opts.onPickColor] - fires once the
 *   popover has closed, with the chosen colour.
 * @returns {{ element: HTMLSpanElement, setName: (name: string) => void }}
 */
export function createBusWidthBadge({
  getName,
  onPick,
  getColor,
  onPickColor,
}) {
  const element = el("span", {
    class: "bus-width-badge",
    "aria-hidden": "true",
    onClick: (event) => {
      event.stopPropagation(); // never toggle the tool the badge sits inside
      // A DISABLED button (the circuit is running) does not make its own
      // descendants inert — the click still lands here. So the badge asks the
      // button it is in, and the CSS matches with pointer-events:none so it
      // doesn't offer a hover ring it won't honor.
      if (element.closest("button")?.disabled) return;
      const rect = element.getBoundingClientRect();
      // Close FIRST, then report — the order menu()/confirm() use, so a
      // callback that opens something of its own is never QUEUED behind this
      // popover. Picking what it already is closes too: the click answered
      // the question.
      const widths = buildOptions(getName(), (name) => {
        PopupManager.close();
        onPick(name);
      });
      const colours =
        getColor && onPickColor
          ? buildColorSwatches({
              colors: WIRE_COLORS,
              value: getColor(),
              ariaLabel: t("toolbar.wire.colorLabel"),
              onPick: (color) => {
                PopupManager.close();
                onPickColor(color);
              },
            })
          : null;
      PopupManager.popover({
        x: rect.left,
        y: rect.bottom + GAP,
        element: colours
          ? el("div", { class: "bus-width-picker" }, [widths, colours])
          : widths,
      });
    },
  });

  const setName = (name) => {
    element.textContent = busWidthGlyph(name);
    element.title = t("toolbar.bus.widthTitle", { width: name });
  };

  return { element, setName };
}
