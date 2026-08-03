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

// catalog/index.js — the assembled parts catalog. Later waves (sequential
// chips, MSI parts) concatenate their own def modules here; consumers only
// ever see the exported lists and lookups.

import { CHIPS_GATES } from "./chips-gates.js";
import { CHIPS_SEQ } from "./chips-seq.js";
import { CHIPS_74LS } from "./chips-74ls.js";
import { CHIPS_MEM } from "./chips-mem.js";
import { CHIPS_IO } from "./chips-io.js";
import { CHIPS_CPU } from "./chips-cpu.js";
import { PART_DEFS } from "./parts.js";

/**
 * Coerce a non-volatile memory chip's backing-file reference (Feature 190) to a
 * `{ guid, source?, edited? }`, or null. The GUID (a `crypto.randomUUID()` the
 * renderer minted on placement) names a `.bin` sidecar in the app working
 * folder; main is the only place that maps it to a path. A malformed GUID drops
 * the whole reference — without one there is nothing for the rest to describe.
 *
 * `source` is the file the in-app programmer last loaded, and it is a LABEL,
 * NEVER A PATH: nothing resolves it, opens it, or hands it to `fs`, which is
 * what makes it safe to keep an absolute path written on somebody else's
 * machine. It is capped because a hand-edited document could otherwise put a
 * megabyte of text through a `title` attribute. `edited` marks bytes that have
 * been changed in the inspector since — the file is still where they came
 * from, which is what was asked, but it is no longer what the chip holds.
 */
const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SOURCE = 1024;
function normalizeStorage(raw) {
  const guid = raw?.storage?.guid;
  if (typeof guid !== "string" || !GUID_RE.test(guid)) return null;
  const storage = { guid };
  const source = raw.storage.source;
  if (typeof source === "string" && source) {
    storage.source = source.slice(0, MAX_SOURCE);
  }
  if (raw.storage.edited === true) storage.edited = true;
  return storage;
}

/** Every chip def, in palette display order (combinational gates, then the
    sequential & MSI wave). `kind` is stamped uniformly, and a
    `normalizeParams` that preserves the `damaged` flag (Feature 90's
    magic-smoke bookkeeping) and, for a non-volatile memory chip, its backing-
    file `storage` (the guid, plus the file its image was loaded from) and its
    `programmed` flag (Feature 190) — chips otherwise carry no params. */
export const CHIP_DEFS = Object.freeze(
  [
    ...CHIPS_GATES,
    ...CHIPS_SEQ,
    ...CHIPS_74LS,
    ...CHIPS_MEM,
    ...CHIPS_IO,
    ...CHIPS_CPU,
  ].map((def) =>
    Object.freeze({
      kind: "chip",
      // Only non-default flags are stored, so a plain chip keeps `params: {}`.
      // `rot: 180` is the flipped orientation — same holes, reversed numbering.
      normalizeParams: (raw) => {
        const params = {};
        if (raw?.damaged === true) params.damaged = true;
        if (raw?.rot === 180) params.rot = 180;
        const storage = normalizeStorage(raw);
        if (storage) params.storage = storage;
        // A ROM flagged programmed by the in-app programmer — drives the
        // "backing file went missing" loss warning after a delete + undo.
        if (raw?.programmed === true) params.programmed = true;
        return params;
      },
      ...def,
    }),
  ),
);

/** Chips first, then discrete parts + power — the palette's full listing. */
export const PALETTE_DEFS = Object.freeze([...CHIP_DEFS, ...PART_DEFS]);

const CHIPS_BY_ID = new Map(CHIP_DEFS.map((def) => [def.id, def]));
const ALL_BY_ID = new Map(PALETTE_DEFS.map((def) => [def.id, def]));

/** The chip def for a catalog id, or null (chips only). */
export function chipDef(ref) {
  return CHIPS_BY_ID.get(ref) ?? null;
}

/** The def for ANY catalog id — chip, discrete, or psu — or null. */
export function partDef(ref) {
  return ALL_BY_ID.get(ref) ?? null;
}

/**
 * The committed datasheet crop for a def — the basename of
 * `web/datasheets/<name>.png` — or null when the part has none.
 *
 * A DIP-packaged part's crop is named by its own ID: every chip has a datasheet
 * and that is the name the crop is committed under. Anything ELSE has to NAME
 * its sheet (`def.datasheet`), and both halves of that are deliberate — most
 * discretes are parts no datasheet describes, so keying them by id would ask
 * every LED and switch pinout for a file that will never exist; and where a
 * document does exist it need not be per-id, since the two character-LCD
 * modules share the ONE controller sheet (HD44780).
 *
 * The one place this is not the whole story is the pinout WINDOW's default
 * size, which main sizes against the same file — main has no catalog, so the
 * renderer hands it this name (see app.js's `onOpenPinout`).
 * @param {object|null} def - a catalog def.
 * @returns {string|null}
 */
export function datasheetCrop(def) {
  return def?.datasheet ?? (def?.package ? def.id : null);
}

/** A chip's `pinGroups` (Feature 130 bus taps), or an empty list. */
export function pinGroupsOf(ref) {
  return partDef(ref)?.pinGroups ?? [];
}

/** The pin group `pin` belongs to on `ref`, or null (bus tap-mode lookup). */
export function pinGroupContaining(ref, pin) {
  return pinGroupsOf(ref).find((g) => g.pins.includes(pin)) ?? null;
}
