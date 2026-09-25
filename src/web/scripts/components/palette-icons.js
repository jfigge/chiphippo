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

// palette-icons.js — one line-drawn glyph per top-level parts-tray section
// (Boards · Chips · Components · Memory · Annotations · Signals), keyed by the
// section's `key` in palette-panel.js's RAIL_SECTIONS. Pure markup, shared by
// the two places a section is shown: its header in the open tray, and its
// button on the rail the tray shuts down to — the same glyph at the same size
// in both, so shutting the tray changes where an icon is, never what it is.

/** The app's line-icon idiom (24-unit box, 2-unit round-capped strokes, drawn
    in `currentColor`). Its 1em is only an intrinsic size — app.css states the
    real one (`--palette-icon`). */
const ICON_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';

/** Filled dots (tie points) at the given centres. A dot is a FILL, not a
    stroke — a 2-unit stroke around a hole that small closes it up. */
function dots(points) {
  return (
    '<g fill="currentColor" stroke="none">' +
    points.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.2"/>`).join("") +
    "</g>"
  );
}

/**
 * One glyph per section, keyed by the section's `key`. Each draws the THING on
 * that shelf, and they are told apart by silhouette first: the only two
 * rectangles-with-legs (a chip and a memory module) run on different axes.
 */
export const SECTION_ICONS = {
  /** A breadboard: two rows of tie points either side of the centre trench. */
  boards:
    ICON_OPEN +
    '<rect x="2" y="4" width="20" height="16" rx="2"/>' +
    '<path d="M6 12h12"/>' +
    dots([
      [7, 8],
      [12, 8],
      [17, 8],
      [7, 16],
      [12, 16],
      [17, 16],
    ]) +
    "</svg>",
  /** A DIP chip stood on end: pin-1 notch at the top, three legs a side. */
  chips:
    ICON_OPEN +
    '<rect x="6" y="3" width="12" height="18" rx="1.5"/>' +
    '<path d="M10 3a2 2 0 0 0 4 0"/>' +
    '<path d="M2 7h4M2 12h4M2 17h4M18 7h4M18 12h4M18 17h4"/></svg>',
  /** A resistor — the discrete every circuit on the desk starts with. The
      zigzag is point-symmetric about the centre, leads included. */
  components:
    ICON_OPEN +
    '<path d="M2 12h3l1.75-5 3.5 10 3.5-10 3.5 10 1.75-5h3"/></svg>',
  /** A memory module lying flat: two packages on the board, edge contacts
      along the bottom. */
  memory:
    ICON_OPEN +
    '<rect x="2" y="5" width="20" height="11" rx="1.5"/>' +
    '<rect x="5.5" y="8" width="4" height="5" rx=".5"/>' +
    '<rect x="14.5" y="8" width="4" height="5" rx=".5"/>' +
    '<path d="M6 16v3M10 16v3M14 16v3M18 16v3"/></svg>',
  /** A sticky note, corner turned up, with two lines written on it. */
  annotations:
    ICON_OPEN +
    '<path d="M4 4h16v10l-6 6H4z"/>' +
    '<path d="M14 20v-6h6"/>' +
    '<path d="M8 9h8M8 13h3"/></svg>',
  /** A flag on its pole — the palette's own ⚑ for a signal, planted. */
  signals:
    ICON_OPEN +
    '<path d="M5.5 21V4"/>' +
    '<path d="M5.5 4h13l-3 4.5 3 4.5h-13"/></svg>',
};
