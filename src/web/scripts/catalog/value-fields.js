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

// value-fields.js — the Properties fields a component's VALUE is set in, as
// data: one editable combo box each (part-properties-dialog.js's `"combo"`
// type, components/value-combobox.js), over the ONE parser every value takes
// (model/component-value.js). A field states its list, how a stored value
// SHOWS (and whether it is out of range), and how typed text READS — as
// message CODES, never sentences, since the catalog is data evaluated before
// any language is loaded; the dialog words them.
//
// A combo field is:
//   { key, label, type: "combo",
//     options(values)   → [{label, text, search?, patch}]  — the list;
//     show(values)      → {text, error?, warning?}         — the box on open;
//     read(text, values) → {text, patch, warning?} | {error} }
// where a `patch` is the params it sets — usually its own key, but a Zener's
// voltage brings its part number with it.

import {
  ZENER_DIODES,
  VALUE_RANGES,
  TRANSISTOR_PARTS,
  TRANSISTOR_PART_FACTS,
  formatComponentValue,
  parseComponentValue,
  parseTransistorPart,
  parseZener,
  zenerByPart,
  zenerLabel,
} from "../model/component-value.js";

/** `params.partNumber`, trimmed, or null. (discretes.js's partNumberOf, which
    imports this module, cannot be imported back.) */
const partNumberIn = (values) => {
  const text =
    typeof values?.partNumber === "string" ? values.partNumber.trim() : "";
  return text || null;
};

/**
 * How a stored value shows: its tidy text — or, for one that does not read
 * (a string an old document kept) or lies outside the field's range, that
 * text and why, so the card opens red rather than the value being altered.
 */
function shownValue(stored, unit, range) {
  if (stored == null || stored === "") return { text: "" };
  const read = parseComponentValue(String(stored), unit, range);
  if (!read.error) return { text: read.display };
  const text =
    typeof stored === "number"
      ? formatComponentValue(stored, unit) || String(stored)
      : String(stored);
  return { text, error: read };
}

/**
 * A numeric value's combo field: its unit, its range, its list of common
 * values, and whether it may be left blank (an inductor's inductance).
 * @param {object} spec
 * @param {string} spec.key
 * @param {string} spec.label
 * @param {"ohm"|"farad"|"henry"|"volt"} spec.unit
 * @param {{min: number, max: number}} spec.range
 * @param {readonly number[]} spec.values
 * @param {boolean} [spec.optional]
 */
export function valueField({ key, label, unit, range, values, optional }) {
  return Object.freeze({
    key,
    label,
    type: "combo",
    unit,
    range,
    optional: optional === true,
    options: () =>
      values.map((value) => {
        const text = formatComponentValue(value, unit);
        return { label: text, text, patch: { [key]: value } };
      }),
    show: (params) => shownValue(params?.[key], unit, range),
    read(text) {
      if (optional && !String(text).trim()) {
        return { text: "", patch: { [key]: null } };
      }
      const read = parseComponentValue(text, unit, range);
      return read.error
        ? { error: read }
        : { text: read.display, patch: { [key]: read.value } };
    },
  });
}

/**
 * A Zener's voltage — paired with a part number. Its list is the common
 * Zeners (`5.1V (1N4733A)`), and taking one sets both; a typed voltage the
 * table has brings that part with it, and a typed part number from the table
 * is its entry. Any other voltage is stored on its own: it drops a part number
 * from the TABLE, which would now be wrong, but keeps one typed into the Part
 * number field, which the user chose.
 */
export const ZENER_VOLTS_FIELD = Object.freeze({
  key: "zenerVolts",
  label: "Zener voltage",
  type: "combo",
  unit: "volt",
  range: VALUE_RANGES.zener,
  optional: true,
  options: () =>
    ZENER_DIODES.map((z) => ({
      label: zenerLabel(z),
      text: formatComponentValue(z.volts, "volt"),
      search: z.partNumber,
      patch: { zenerVolts: z.volts, partNumber: z.partNumber },
    })),
  show: (params) => shownValue(params?.zenerVolts, "volt", VALUE_RANGES.zener),
  read(text, values) {
    if (!String(text).trim()) return { text: "", patch: { zenerVolts: null } };
    const read = parseZener(text);
    if (read.error) return { error: read };
    const current = partNumberIn(values);
    const partNumber =
      read.partNumber ?? (current && zenerByPart(current) ? null : current);
    return {
      text: read.display,
      patch: { zenerVolts: read.value, partNumber },
    };
  },
});

/**
 * A transistor's part number: its type's common parts, or any typed part —
 * read lightly (uppercased, letters, digits and `-`), and one from ANOTHER
 * type's list kept with a warning saying what it is.
 * @param {"npn"|"pnp"|"nmos"|"pmos"} type
 */
export function transistorPartField(type) {
  const warned = (partNumber) => parseTransistorPart(partNumber, type);
  return Object.freeze({
    key: "partNumber",
    label: "Part number",
    type: "combo",
    // A listed part brings its package and its Spice Lite grade
    // (TRANSISTOR_PART_FACTS) — the package first, since a grade left at its
    // default is read against it.
    options: () =>
      TRANSISTOR_PARTS[type].map((partNumber) => ({
        label: partNumber,
        text: partNumber,
        patch: { partNumber, ...TRANSISTOR_PART_FACTS[partNumber] },
      })),
    show(params) {
      const partNumber = partNumberIn(params);
      if (!partNumber) return { text: "" };
      const read = warned(partNumber);
      return {
        text: partNumber,
        error: read.error && read,
        warning: read.warning,
      };
    },
    read(text) {
      const read = warned(text);
      return read.error
        ? { error: read }
        : {
            text: read.value ?? "",
            patch: { partNumber: read.value },
            warning: read.warning,
          };
    },
  });
}

/**
 * The Type field a part that can be SWAPPED for a sibling carries — a
 * capacitor's ceramic or electrolytic, a transistor's four kinds. Its value
 * is the part's catalog id, and choosing another swaps the part in place
 * (DeskDoc.setComponentRef): the same holes and wiring, the new part's card.
 * @param {Array<{value: string, label: string}>} options - the siblings.
 * @param {"segmented"|"select"} [type] - a track for two, a list for more.
 */
export function partTypeField(options, type = "segmented") {
  return Object.freeze({
    key: "ref",
    label: "Type",
    type,
    swapsPart: true,
    options: Object.freeze(options.map((o) => Object.freeze({ ...o }))),
  });
}

/**
 * A stored value as the loader keeps it: a positive number as it is, text an
 * older document holds read through the same parser (kept VERBATIM when it
 * does not read, so its card can open red rather than the value being
 * thrown away), anything else the fallback.
 * @param {unknown} raw
 * @param {"ohm"|"farad"|"henry"|"volt"} unit
 * @param {number} [fallback]
 * @returns {number|string|undefined}
 */
export function storedValue(raw, unit, fallback) {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
  if (typeof raw === "string" && raw.trim()) {
    const read = parseComponentValue(raw, unit);
    return read.error ? raw : read.value;
  }
  return fallback;
}
