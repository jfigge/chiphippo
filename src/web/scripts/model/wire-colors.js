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

// wire-colors.js — a colour name, in the user's language.
//
// `WIRE_COLORS` (model/desk-doc.js) and `LED_COLOR_OPTIONS` (catalog/parts.js)
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
