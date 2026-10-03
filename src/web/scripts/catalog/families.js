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

// families.js — the logic FAMILIES a chip can belong to (Feature 400), as
// pure data. A family is what a part's datasheet has to say about the whole
// line rather than about the part: the supply it runs from, what a floating
// input reads, and how many LS inputs one of its outputs can hold LOW.
//
// Only LOGIC chips carry a family (`def.family`, stamped per module in
// catalog/index.js). The CPUs, the 65xx peripherals and every memory are
// family-LESS on purpose: none of them is a 74LS part, and tagging them would
// hide a Z80 in CD4000 mode. A family-less part reads a floating input HIGH,
// as it always has (a Z80 test depends on a floating bus reading $FF), and is
// powered by the 5 V envelope it always was.
//
// Everything that branches on a family asks THIS module, never `def.family`
// by hand — the engine's power gate and floating-input rule, the boundary
// warnings, the tray, the AI builder.

/** The families a logic chip can declare, in tray order. */
export const LOGIC_FAMILIES = Object.freeze(["74LS", "CD4000"]);

/**
 * The tray's family modes (Settings ▸ Data Sheets): one family, or both.
 * The stored value of `settings.logicFamily`.
 */
export const FAMILY_MODES = Object.freeze(["74LS", "CD4000", "combined"]);
export const DEFAULT_FAMILY_MODE = "74LS";

/**
 * Per-family facts, from the datasheets.
 *
 * `supply` is the recommended VCC/VDD range: below `min` a part is
 * underpowered (inert), above `max` it is damaged. 74LS: 4.75–5.25 V (every
 * LS sheet's recommended operating conditions); CD4000B: 3–18 V (the "B"
 * series recommended range — TI's sheets, e.g. SCHS015C/SCHS021D, state it
 * for the whole series).
 *
 * `floating` is what an input on a net nothing drives reads: a TTL input's
 * emitter pulls itself HIGH; a CMOS input is a gate with nothing on it and
 * reads nothing at all, so the engine calls it unknown (`X`).
 *
 * `lsFanout` is how many 74LS inputs one output can hold LOW within spec: an
 * LS input sinks up to 0.4 mA (IIL), and a standard B-series output sinks
 * 0.51 mA minimum at VOL 0.4 V, VDD 5 V (25 °C) — ONE LS load. A part with a
 * stronger output states its own (`def.lsFanout`; the CD4049UB/CD4050B sink
 * ≥ 3.3 mA there, eight). 74LS outputs are not counted (null).
 */
const FAMILY_FACTS = Object.freeze({
  "74LS": Object.freeze({
    supply: Object.freeze({ min: 4.75, max: 5.25, nominal: 5 }),
    floating: "high",
    lsFanout: null,
  }),
  CD4000: Object.freeze({
    supply: Object.freeze({ min: 3, max: 18 }),
    floating: "unknown",
    lsFanout: 1,
  }),
});

/** The envelope every family-less part has always been held to: 5 V. */
const DEFAULT_SUPPLY = FAMILY_FACTS["74LS"].supply;

/** A def's family, or null for a family-less part. */
export function familyOf(def) {
  return LOGIC_FAMILIES.includes(def?.family) ? def.family : null;
}

/** The recommended supply range for a def: `{ min, max }` in volts. */
export function supplyRange(def) {
  return FAMILY_FACTS[familyOf(def)]?.supply ?? DEFAULT_SUPPLY;
}

/**
 * The supply a def is rated for, as a message states it: "5 V" for a part
 * with one nominal supply, "3–18 V" for a range. Digits and the unit symbol
 * only — nothing to translate.
 */
export function supplyText(def) {
  const { min, max, nominal } = supplyRange(def);
  return nominal != null ? `${nominal} V` : `${min}–${max} V`;
}

/** True when a floating input of this def reads unknown (`X`), not HIGH. */
export function floatsUnknown(def) {
  return FAMILY_FACTS[familyOf(def)]?.floating === "unknown";
}

/**
 * How many 74LS inputs one output of this def may drive, or null when the
 * question does not apply (a 74LS part, a family-less part).
 */
export function lsFanoutOf(def) {
  if (familyOf(def) !== "CD4000") return null;
  return def.lsFanout ?? FAMILY_FACTS.CD4000.lsFanout;
}

/**
 * The families a tray in `mode` shows, widened by any family the open project
 * already uses (so a CD4000 project opened in 74LS mode still offers the parts
 * that are on its desk). An unknown mode reads as the default.
 * @param {string} mode - one of FAMILY_MODES.
 * @param {Iterable<string>} [inUse] - families the open project contains.
 * @returns {Set<string>}
 */
export function familiesShown(mode, inUse = []) {
  const shown = new Set(
    mode === "combined"
      ? LOGIC_FAMILIES
      : [LOGIC_FAMILIES.includes(mode) ? mode : DEFAULT_FAMILY_MODE],
  );
  for (const family of inUse) {
    if (LOGIC_FAMILIES.includes(family)) shown.add(family);
  }
  return shown;
}

/** Coerce a stored mode to a valid one (unknown → the default). */
export function normalizeFamilyMode(raw) {
  return FAMILY_MODES.includes(raw) ? raw : DEFAULT_FAMILY_MODE;
}
