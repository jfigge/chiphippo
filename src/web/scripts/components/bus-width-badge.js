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

// bus-width-badge.js — the Bus toolbar button's width badge: the second pill
// readout that is also the PICKER for what it shows, built to the contract
// components/wire-color-dot.js established. Clicking it opens a small popover
// holding one circled number per BUS_WIDTHS preset (2…8, 16), laid out in a
// row so the picker reads as the badge's own list; picking one closes the
// popover and reports the bus NAME (`D[3:0]`), which is what the tool parses.
//
// Picking does NOT arm the bus tool: the segment arms when its label is
// clicked, so — exactly as with the wire dot — the readout has to be the one
// place that doesn't, or there would be no way to set the pending width
// without entering the tool (1–8, the keyboard path, are themselves gated on
// the tool being armed).
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

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { BUS_WIDTHS } from "../model/desk-doc.js";

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
      title: `${preset.bits}-bit — ${preset.name}`,
      "aria-label": `${preset.bits}-bit bus`,
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
 *   current, whatever changed it: a digit key, or a pick of its own).
 * @param {(name: string) => void} opts.onPick - fires once the popover has
 *   closed, with the chosen preset's bus name.
 * @returns {{ element: HTMLSpanElement, setName: (name: string) => void }}
 */
export function createBusWidthBadge({ getName, onPick }) {
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
      PopupManager.popover({
        x: rect.left,
        y: rect.bottom + GAP,
        element: buildOptions(getName(), (name) => {
          // Close FIRST, then report — the order menu()/confirm() use, so a
          // callback that opens something of its own is never QUEUED behind
          // this popover. Picking the width it already is closes too: the
          // click answered the question.
          PopupManager.close();
          onPick(name);
        }),
      });
    },
  });

  const setName = (name) => {
    element.textContent = busWidthGlyph(name);
    element.title = `Bus width: ${name} — click to change (1–8 while the bus tool is armed)`;
  };

  return { element, setName };
}
