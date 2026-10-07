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

// spice/config.js — what the Spice Lite setting says, coerced into one shape.
// Pure and DOM-free.
//
// Settings ▸ Spice Lite writes `settings.spiceLite` (app-wide, as
// `logicFamily` is: a way of SIMULATING, not a property of a design, so it
// never dirties a project). Main stores the object unvalidated, as it does
// `ai`; this is the one place it is read, so a hand-edited or older
// settings.json can only ever reach the engine as a well-formed config.
//
//   enabled     the toggle — false (the digital engine) unless exactly true
//   gapPercent  when a node NOTHING listens to stops asking for display wakes:
//               its remaining gap to its asymptote, as a percentage of the
//               final value (features/spice-lite.md §4)
//   families    per-family OVERRIDES of the defaults, keyed by family; only
//               what the user changed is stored, so Reset is deleting a
//               family's entry

import { LOGIC_FAMILIES } from "../../catalog/families.js";
import { FAMILY_DEFAULTS } from "./params.js";

/** The fallback remaining-gap threshold, percent (about 5 time constants). */
export const DEFAULT_GAP_PERCENT = 1;

/** What the gap threshold may be set to, percent. Below 0.1 % costs passes
    for nothing anyone can see (0.001 % is ~11 τ); above 10 % releases a node
    visibly short of where it is going. */
export const GAP_PERCENT_RANGE = Object.freeze({ min: 0.1, max: 10 });

/** The setting as a new install has it: off, everything at its default. */
export const DEFAULT_SPICE_CONFIG = Object.freeze({
  enabled: false,
  gapPercent: DEFAULT_GAP_PERCENT,
  families: Object.freeze({}),
});

const isPlainObject = (v) =>
  v != null && typeof v === "object" && !Array.isArray(v);

/** One family's overrides: each key the parameter table has (spice/
    params.js FAMILY_DEFAULTS), holding a positive finite number. Anything
    else — a key from a later version, a hand-edited string — is dropped,
    which leaves that parameter at its default. */
function familyOverrides(family, raw) {
  if (!isPlainObject(raw)) return null;
  const known = FAMILY_DEFAULTS[family];
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(known, key)) continue;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  // The input thresholds must leave a band (VIL under VIH) — the panel
  // refuses anything else, and a stored pair that does not is dropped
  // together, back to the family's own.
  const vil = out.vilV ?? known.vilV;
  const vih = out.vihV ?? known.vihV;
  if (!(vil < vih)) {
    delete out.vilV;
    delete out.vihV;
  }
  return Object.keys(out).length ? Object.freeze(out) : null;
}

/**
 * Coerce whatever `settings.spiceLite` holds into a config.
 * @param {unknown} raw
 * @returns {{enabled: boolean, gapPercent: number,
 *   families: Readonly<Record<string, Readonly<Record<string, number>>>>}}
 */
export function normalizeSpiceConfig(raw) {
  if (!isPlainObject(raw)) return DEFAULT_SPICE_CONFIG;
  const gap = Number(raw.gapPercent);
  const gapPercent =
    Number.isFinite(gap) && gap >= GAP_PERCENT_RANGE.min
      ? Math.min(gap, GAP_PERCENT_RANGE.max)
      : DEFAULT_GAP_PERCENT;
  const families = {};
  if (isPlainObject(raw.families)) {
    for (const family of LOGIC_FAMILIES) {
      const own = familyOverrides(family, raw.families[family]);
      if (own) families[family] = own;
    }
  }
  return Object.freeze({
    enabled: raw.enabled === true,
    gapPercent,
    families: Object.freeze(families),
  });
}
