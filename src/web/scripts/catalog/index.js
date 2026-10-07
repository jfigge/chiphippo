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

// catalog/index.js — the assembled parts catalog. Later waves (sequential
// chips, MSI parts) concatenate their own def modules here; consumers only
// ever see the exported lists and lookups.

import { keepRunLatches } from "./run-latches.js";
import { CHIPS_GATES } from "./chips-gates.js";
import { CHIPS_SEQ } from "./chips-seq.js";
import { CHIPS_74LS } from "./chips-74ls.js";
import { CHIPS_MEM } from "./chips-mem.js";
import { CHIPS_IO } from "./chips-io.js";
import { CHIPS_CPU } from "./chips-cpu.js";
import { CHIPS_CD4000 } from "./chips-cd4000.js";
import { CHIPS_CD4000_TIMERS } from "./chips-cd4000-timers.js";
import { CHIPS_555 } from "./chips-555.js";
import { PART_DEFS } from "./parts.js";
import { familyOf } from "./families.js";
import { customCatalogDef } from "./custom-chips.js";
import { normalizeCustomChips } from "../model/custom-chip.js";

/** Stamp a logic family (catalog/families.js) on every def of one module —
    the family is a fact about the MODULE's line of parts, so it is stated
    once per module rather than once per def. A def's own field wins. */
const ofFamily = (family, defs) => defs.map((def) => ({ family, ...def }));

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
    sequential & MSI wave, then the CD4000 CMOS family and its RC-timed
    parts). The logic modules are stamped with their `family`; memory, the 65xx
    peripherals, the CPUs and the 555 are family-less (catalog/families.js says
    why — the 555 is shelved under COMPONENTS, palette-panel.js says why). `kind` is stamped uniformly, and a
    `normalizeParams` that preserves the `damaged` flag (Feature 90's
    magic-smoke bookkeeping) and, for a non-volatile memory chip, its backing-
    file `storage` (the guid, plus the file its image was loaded from) and its
    `programmed` flag (Feature 190) — chips otherwise carry no params. */
/** Every chip's params: only non-default flags are stored, so a plain chip
    keeps `params: {}`. `rot: 180` is the flipped orientation — same holes,
    reversed numbering. */
function normalizeChipParams(raw) {
  const params = {};
  // 12 V's magic smoke and Spice Lite's brown smoke (catalog/run-latches.js).
  keepRunLatches(raw, params);
  if (raw?.rot === 180) params.rot = 180;
  const storage = normalizeStorage(raw);
  if (storage) params.storage = storage;
  // A ROM flagged programmed by the in-app programmer — drives the
  // "backing file went missing" loss warning after a delete + undo.
  if (raw?.programmed === true) params.programmed = true;
  return params;
}

export const CHIP_DEFS = Object.freeze(
  [
    ...ofFamily("74LS", CHIPS_GATES),
    ...ofFamily("74LS", CHIPS_SEQ),
    ...ofFamily("74LS", CHIPS_74LS),
    ...ofFamily("CD4000", CHIPS_CD4000),
    ...ofFamily("CD4000", CHIPS_CD4000_TIMERS),
    ...CHIPS_MEM,
    ...CHIPS_IO,
    ...CHIPS_CPU,
    ...CHIPS_555,
  ].map((def) =>
    Object.freeze({
      kind: "chip",
      normalizeParams: normalizeChipParams,
      ...def,
    }),
  ),
);

/** Chips first, then discrete parts + power — the palette's full listing. */
export const PALETTE_DEFS = Object.freeze([...CHIP_DEFS, ...PART_DEFS]);

const CHIPS_BY_ID = new Map(CHIP_DEFS.map((def) => [def.id, def]));
const ALL_BY_ID = new Map(PALETTE_DEFS.map((def) => [def.id, def]));

/**
 * The CUSTOM chips (the chip designer), by ref. Unlike every def above they
 * are not the app's but the user's — the machine's chip library together with
 * the chips the open project's file carries (ProjectWorkspace merges the two,
 * the project's copy of a chip winning) — so the catalog holds whichever set
 * it is handed (`setCustomChips`), and the lookups below find them as they
 * find a 74LS00. A custom chip's ref is a random id minted when it was
 * designed, so one set at a time is the whole story.
 */
let CUSTOM_BY_ID = new Map();

/**
 * Make `chips` (stored custom chips, model/custom-chip.js) the custom chips
 * the catalog knows. Called whenever the set changes — before any desk
 * document holding them is loaded, since a part whose ref resolves to nothing
 * is dropped on load.
 * @param {object[]} chips
 */
export function setCustomChips(chips) {
  // Uncapped: the caps are for STORED lists, and what is registered here is
  // the library and the open project's chips together, every one of which a
  // document may name.
  CUSTOM_BY_ID = new Map(
    normalizeCustomChips(chips, { limit: Infinity }).map((chip) => [
      chip.id,
      customCatalogDef(chip, normalizeChipParams),
    ]),
  );
}

/** Every custom chip's def, in the project's order. */
export function customChipDefs() {
  return [...CUSTOM_BY_ID.values()];
}

/** The chip def for a catalog id, or null (chips only). */
export function chipDef(ref) {
  return CHIPS_BY_ID.get(ref) ?? CUSTOM_BY_ID.get(ref) ?? null;
}

/** The def for ANY catalog id — chip, discrete, or psu — or null. */
export function partDef(ref) {
  return ALL_BY_ID.get(ref) ?? CUSTOM_BY_ID.get(ref) ?? null;
}

/**
 * What is PRINTED on a chip — its part number. A catalog chip's is its id; a
 * custom chip's is the name the user gave it (its id is an opaque ref that
 * never changes, so a rename touches nothing on the desk).
 * @param {object|null} def
 * @param {string} [ref] - the fallback when there is no def.
 */
export function chipMarking(def, ref = "") {
  return def?.marking ?? def?.id ?? ref;
}

/**
 * The hole offsets a linear part's pins take along its row, for THESE params:
 * the def's own `footprint.offsets`, unless the def sizes itself from its
 * params (`offsetsFor` — an inductor set to three holes between its leads
 * instead of two). Every reader of a seated part's footprint asks here, so a
 * part that grows grows everywhere at once.
 * @param {object|null} def - a catalog def.
 * @param {object|null} [params]
 * @returns {readonly number[]|null}
 */
export function footprintOffsets(def, params) {
  return def?.offsetsFor?.(params) ?? def?.footprint?.offsets ?? null;
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
 * modules share the ONE controller sheet (HD44780). A CUSTOM chip is the
 * exception to the first half: it is a DIP, but the user designed it, and no
 * datasheet was ever printed for it.
 *
 * The one place this is not the whole story is the pinout WINDOW's default
 * size, which main sizes against the same file — main has no catalog, so the
 * renderer hands it this name (see app.js's `onOpenPinout`).
 * @param {object|null} def - a catalog def.
 * @returns {string|null}
 */
export function datasheetCrop(def) {
  if (def?.custom) return null;
  return def?.datasheet ?? (def?.package ? def.id : null);
}

/**
 * The pins that must ALL be at their enabling level for a part's outputs to
 * drive, each with that level: `{ n, on }`, `on` "L" for an active-LOW enable
 * and "H" for an active-HIGH one.
 *
 * A tri-state logic part DECLARES them — `outputEnable` for active-LOW (every
 * 74xx ŌĒ and Ḡ) and `outputEnableHigh` for active-HIGH (the CD4094B's OUTPUT
 * ENABLE) — and tests/chips-tristate.test.js proves each against the evaluator,
 * polarity included. A memory chip carries the same fact already, as the chip
 * and output enables its own `logic.memory` gates its data pins on
 * (sim/sequential.js `memUnit`), so they are READ from there rather than
 * declared a second time — a copy that could come to disagree with what the
 * chip actually does. A memory's active-HIGH `ce2` is a chip SELECT, not an
 * output enable, and is not listed.
 *
 * @param {object|null} def
 * @returns {Array<{n: number, on: "L"|"H"}>}
 */
export function outputEnablePins(def) {
  const m = def?.logic?.memory;
  const low = def?.outputEnable?.length
    ? def.outputEnable
    : m
      ? [m.ceN, m.oeN].filter((n) => n != null)
      : [];
  return [
    ...low.map((n) => ({ n, on: "L" })),
    ...(def?.outputEnableHigh ?? []).map((n) => ({ n, on: "H" })),
  ];
}

/** Just the pin numbers of `outputEnablePins`, whatever their polarity. */
export function outputEnables(def) {
  return outputEnablePins(def).map((e) => e.n);
}

/**
 * The logic families a set of desk documents uses (Feature 400) — what the
 * tray has to keep showing whatever its mode, so a project's own parts can
 * always be added to.
 * @param {Array<{components?: Array<{ref: string}>}>} docs
 * @returns {Set<string>}
 */
export function familiesUsed(docs) {
  const used = new Set();
  for (const doc of docs ?? []) {
    for (const comp of doc?.components ?? []) {
      const def = partDef(comp.ref);
      // A custom chip names a family for how it reads its pins, not for a
      // shelf: it has its own, and a CD4000 one must not open the CD4000 tray.
      if (def?.custom) continue;
      const family = familyOf(def);
      if (family) used.add(family);
    }
  }
  return used;
}

/** A chip's `pinGroups` (Feature 130 bus taps), or an empty list. */
export function pinGroupsOf(ref) {
  return partDef(ref)?.pinGroups ?? [];
}

/** The pin group `pin` belongs to on `ref`, or null (bus tap-mode lookup). */
export function pinGroupContaining(ref, pin) {
  return pinGroupsOf(ref).find((g) => g.pins.includes(pin)) ?? null;
}
