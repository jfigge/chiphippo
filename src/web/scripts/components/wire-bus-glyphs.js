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

// wire-bus-glyphs.js — the Wire and Bus segments as ICON buttons.
//
// The label brief's §5, built as a provisional change and KEPT by Jason after
// a look in the running app (2026-11-09). Not a setting, on purpose: one
// toolbar.
//
// It rebuilds the two segments app.js already made, and touches nothing they
// do: the button still toggles its tool, the dot and the badge are the SAME
// readout-and-picker elements (wire-color-dot.js, bus-width-badge.js — their
// click contract unchanged), the tooltips and keyboard paths are untouched.
// What changes is only the face:
//
//   Wire — one trace, pad to pad, stepping up and over the corner, with the
//          dot turned into a rounded square on its corner — the Bus badge's
//          size, filled with the wire colour — that opens the colour picker.
//          (A caret was tried first: too small a target.)
//   Bus  — three such traces side by side, the active width as the badge on
//          its corner, which still opens the width picker.
//
// The glyphs are drawn like every other tool's — in the ink colour, green
// when armed. (Tinting them in the wire colour was tried, 2026-11-09, and
// dropped: black and white needed halos, and the armed green was lost. The
// square alone says the colour.)
//
// Both become `--icon` segments, so they are square like their neighbours and
// pick up the toolbar labels' layout; the WORD they showed becomes their label
// (`.toolbar-pill-label`), under the glyph when Settings ▸ Appearance ▸
// Toolbar labels is On. The label is also what app.js's language relabel
// already rewrites (the first span that is not the dot), so a language change
// needs nothing new here except the accessible name, which a hidden label can
// no longer give the button.
//
// The armed state is the pill's own (`toolbar-btn--active`, set by app.js):
// the segment fills and the glyph and label turn green.

import { t } from "../i18n.js";
import { LABEL_CLASS } from "./toolbar-labels.js";

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/** A wire: a trace from a pad at the bottom left, stepping up to a pad at the
    top right — up and OVER the colour square on the glyph's lower-right
    corner, which it never crosses. */
export const WIRE_GLYPH_SVG =
  SVG_OPEN +
  '<circle cx="4" cy="19.5" r="2.2"/>' +
  '<path d="M5.6 17.9 10 13.5h2.5L17 9"/>' +
  '<circle cx="18.6" cy="7.4" r="2.2"/></svg>';

/** A bus: three of those traces side by side, each ending on its pad at the
    top right; the width badge sits over the lower-right corner (the traces
    may run behind it). */
export const BUS_GLYPH_SVG =
  SVG_OPEN +
  [0, 4, 8]
    .map(
      (o) =>
        `<path d="M2 ${21 - o} 6 ${17 - o}h6l4.5-4.5"/>` +
        `<circle cx="18" cy="${11 - o}" r="1.8"/>`,
    )
    .join("") +
  "</svg>";

/**
 * Turn one word-plus-readout segment into a glyph with the readout on its
 * corner and the word as its label.
 */
function glyphSegment(btn, readout, svg, nameKey) {
  const word = [...btn.children].find(
    (c) => c.tagName === "SPAN" && c !== readout,
  );
  const stack = document.createElement("span");
  stack.className = "toolbar-glyph-stack";
  stack.innerHTML = svg;
  stack.append(readout);
  word?.classList.add(LABEL_CLASS);
  word?.setAttribute("aria-hidden", "true");
  // The label FIRST in the DOM (the flex `order` draws it under the glyph):
  // app.js's relabel rewrites the first span that is not the readout.
  btn.replaceChildren(...(word ? [word] : []), stack);
  btn.classList.remove("toolbar-pill-btn--tool");
  btn.classList.add("toolbar-pill-btn--icon", "toolbar-pill-btn--glyph-tool");
  const name = () => btn.setAttribute("aria-label", t(nameKey));
  name();
  return name;
}

/**
 * Give the Wire and Bus segments their glyph faces.
 *
 * @param {object} parts - what buildDeskToolPill made
 * @param {HTMLButtonElement} parts.wire
 * @param {{element: HTMLElement, setColor: (c: string) => void}} parts.wireDot
 * @param {HTMLButtonElement} parts.bus
 * @param {{element: HTMLElement}} parts.busWidth
 */
export function glyphWireBus({ wire, wireDot, bus, busWidth }) {
  const nameWire = glyphSegment(
    wire,
    wireDot.element,
    WIRE_GLYPH_SVG,
    "toolbar.wire.label",
  );
  const nameBus = glyphSegment(
    bus,
    busWidth.element,
    BUS_GLYPH_SVG,
    "toolbar.bus.label",
  );
  wireDot.element.classList.add("wire-swatch-dot--corner");
  busWidth.element.classList.add("bus-width-badge--corner");
  // The square names its colour on the button, so the CSS can give the two
  // that vanish into a theme (black, white) a contrasting border: every
  // repaint of the dot (a swatch, 1–8, a desktop switched to) goes through
  // setColor.
  const setColor = wireDot.setColor;
  wireDot.setColor = (color) => {
    setColor(color);
    wire.dataset.wireColor = color;
  };
  window.addEventListener("chiphippo:locale-changed", () => {
    nameWire();
    nameBus();
  });
}
