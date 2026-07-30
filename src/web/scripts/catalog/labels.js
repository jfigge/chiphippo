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

// labels.js — the ONE place a catalog record's user-facing name is translated.
//
// The catalog itself is pure DATA evaluated at import time, long before a
// message catalog is loaded, so its `title`/`label` fields cannot be `t()` calls
// (see i18n.js — never call t() at module scope). They are also not only UI
// text: the BOM export, `scripts/demo-specs.mjs`, and the catalog's own
// integrity tests all read them under Node with no renderer at all.
//
// So the English stays in the catalog as the DATA and the translations live
// under `parts.*` / `boards.*` in the locale files, resolved here through `tf()`
// — which falls back to the catalog's own English rather than to a raw key, so a
// part added without a catalog entry reads correctly, just untranslated.
// `tests/i18n-catalog.test.js` is what stops that from going unnoticed.
//
// WHAT IS NOT TRANSLATED, deliberately: a part's `blurb`. It is datasheet prose
// — active-low this, open-collector that, a paragraph of bus protocol for the
// 65xx parts — which is reference DOCUMENTATION about the part rather than the
// application's own words, and it sits with the user guide on the English side
// of that line. `partBlurb()` exists anyway so the decision has exactly one
// place to be revisited: give it the same `tf()` shape as `partTitle()` and add
// `parts.<id>.blurb` keys, and every call site follows.

import { tf } from "../i18n.js";

/**
 * A part's short display name — the palette row, the pinout window heading, the
 * BOM line, the schematic symbol caption.
 * @param {{id: string, title: string}} def a catalog part def
 * @returns {string}
 */
export function partTitle(def) {
  return tf(`parts.${def.id}.title`, def.title);
}

/**
 * A part's long description. English by design (see the note above) — this is
 * the seam that decision lives behind, not an oversight.
 * @param {{blurb: string}} def a catalog part def
 * @returns {string}
 */
export function partBlurb(def) {
  return def.blurb;
}

/**
 * A board kit's display name ("Full-size", "Half power rail", …).
 * @param {string} key the kit key (`full`, `pins-half`, `rail-full`, …)
 * @param {{label: string}} kit the BREADBOARD_KITS / BOARD_TYPES record
 * @returns {string}
 */
export function kitLabel(key, kit) {
  return tf(`boards.${key}`, kit?.label ?? key);
}
