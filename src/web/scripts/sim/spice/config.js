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
//   gapPercent  when an RC node stops asking for display wakes: its
//               remaining gap to its asymptote, as a percentage of the step
//               it is taking (features/spice-lite.md §4). Display only — a
//               node an input listens to is timed by its crossings, and
//               asks for frames alike, so the probe and the analyzer follow
//               it between them.
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

/**
 * What each family number may be set to (units in the key, as in spice/
 * params.js FAMILY_DEFAULTS): wide enough for any part of either family at
 * any supply it runs at, both families' defaults well inside, and narrow
 * enough that the engine is still simulating a logic gate. A stored value
 * outside its range is dropped (its default stands); the panel refuses one.
 */
export const FIELD_RANGES = Object.freeze({
  // 1 ps (far faster than anything here — MAX_HOLD keeps a desk of them from
  // crawling) to 10 µs (a CD4000 MSI part at 3 V is well under 1 µs). Every
  // settle runs on past its moment by its passes × the delay, so a delay of
  // milliseconds ran each tick ahead of the clock that drove it.
  delayNs: Object.freeze({ min: 0.001, max: 10_000 }),
  // 1 µA to 1 A: any logic output, a bus driver's included.
  sourceMa: Object.freeze({ min: 0.001, max: 1000 }),
  sinkMa: Object.freeze({ min: 0.001, max: 1000 }),
  // 1 pA (under CD4000's 10 pA typical) to 10 mA (25 times a 74LS input's).
  inputLowUa: Object.freeze({ min: 1e-6, max: 10_000 }),
  // 1 nA (under CD4000's 10 nA quiescent) to 1 A per package.
  supplyMa: Object.freeze({ min: 1e-6, max: 1000 }),
  // Stated at VDD = 5 V (a CD4000's scale with its supply from there), so
  // inside it.
  vilV: Object.freeze({ min: 0.01, max: 5 }),
  vihV: Object.freeze({ min: 0.01, max: 5 }),
  // 0.1 pF (a bare pin) to 10 nF (a long cable).
  loadPf: Object.freeze({ min: 0.1, max: 10_000 }),
});

/** Whether `value` is a number family field `key` may hold. */
export function inFieldRange(key, value) {
  const range = FIELD_RANGES[key];
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    (!range || (value >= range.min && value <= range.max))
  );
}

/** The setting as a new install has it: off, everything at its default. */
export const DEFAULT_SPICE_CONFIG = Object.freeze({
  enabled: false,
  gapPercent: DEFAULT_GAP_PERCENT,
  families: Object.freeze({}),
});

const isPlainObject = (v) =>
  v != null && typeof v === "object" && !Array.isArray(v);

/** One family's overrides: each key the parameter table has (spice/
    params.js FAMILY_DEFAULTS), holding a number inside its FIELD_RANGES.
    Anything else — a key from a later version, a hand-edited string, a
    delay of seconds — is dropped, which leaves that parameter at its
    default. */
function familyOverrides(family, raw) {
  if (!isPlainObject(raw)) return null;
  const known = FAMILY_DEFAULTS[family];
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(known, key)) continue;
    if (inFieldRange(key, value)) out[key] = value;
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
