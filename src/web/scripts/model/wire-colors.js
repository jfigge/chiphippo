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

// wire-colors.js — the eight stored jumper-wire colour tokens, and a colour
// name in the user's language.
//
// `WIRE_COLORS` (here) and `LED_COLOR_OPTIONS` (catalog/parts.js)
// are the STORED tokens — `"red"`, `"black"`, … — written into saved documents,
// used as CSS custom-property suffixes (`--color-wire-red`), and compared by
// `===` all over the model. None of that may ever see a translation.
//
// But a colour is also SHOWN: the wire tool's swatch titles, an LED's Properties
// dialog, and the build guide's "Run a red wire" step all name one. This is the
// one place that turns the token into a word, so the eight names are translated
// once rather than in each of those places — and a token with no catalog entry
// falls back to itself, which is exactly what an unknown colour should read as.

import { tf } from "../i18n.js";

/**
 * The fixed jumper-wire palette (theme.css defines a `--color-wire-<name>`
 * token per name). It lives HERE rather than in desk-doc.js — its home until
 * Feature 370 — because a second thing now owns a colour from this list: a
 * SIGNAL (model/signals.js), whose cap IS this array's length. desk-doc.js
 * imports signals.js, so signals.js reaching back for the palette would be an
 * import cycle whose top-level `WIRE_COLORS.length` reads a TDZ binding and
 * throws. desk-doc.js re-exports it, so every existing importer is unchanged.
 */
export const WIRE_COLORS = Object.freeze([
  "red",
  "black",
  "blue",
  "green",
  "yellow",
  "orange",
  "white",
  "purple",
]);

/**
 * The display name for a stored colour token, lower case — for the middle of a
 * sentence ("Run a red wire").
 * @param {string} color a WIRE_COLORS / LED_COLOR_OPTIONS token
 * @returns {string}
 */
export function wireColorName(color) {
  return tf(`colors.${color}`, color);
}

/**
 * The same name sentence-cased, for a LABEL that stands on its own — a swatch's
 * tooltip, a bus context-menu row. CSS cannot do this job here (`::first-letter`
 * does not reach a `title` attribute or a menu label), and a row reading "red"
 * beside "Rename bus…" looks like a bug rather than a colour.
 *
 * `toLocaleUpperCase` and not `toUpperCase`: the two differ for real languages
 * (Turkish dotted/dotless i, most famously), and a display label is exactly the
 * place that difference is visible.
 * @param {string} color a WIRE_COLORS / LED_COLOR_OPTIONS token
 * @returns {string}
 */
export function wireColorLabel(color) {
  const name = wireColorName(color);
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}
