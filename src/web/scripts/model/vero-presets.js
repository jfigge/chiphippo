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

// vero-presets.js — the veroboard (stripboard) sizes the palette offers, as
// pure data. A preset is a PHYSICAL SIZE in millimetres, not a hole count:
// commercial boards of the same nominal size differ by maker, so the holes are
// DERIVED from the size, the pitch and the edge margin (board-types.js
// `veroSpec`), unless a preset states its layout outright (`cols`/`rows`) the
// way a maker's catalogue does.
//
// A board type key IS its size — `vero-92x54` — so a custom board and a preset
// are the same model, and a preset is only the size it names plus the margin
// and layout facts it carries. The key is written in the board's PLACED
// orientation: `vero-54x92` is the same preset stood on end, with its strips
// running the long way (the copper always runs top → bottom on the desk).
//
// Adding a size is one line here: the palette, the labels, the hole grid, the
// netlist and both renderers read it.

/** The one pitch a veroboard can have here: the desk's world unit IS 0.1 in,
    and every part's legs are drawn on it. Carried per preset so the data says
    what it is, and held to this by the tests. */
export const VERO_PITCH_MM = 2.54;

/** Copper-to-edge allowance when a preset says nothing: half a pitch, i.e. a
    board cut down the middle between two rows of holes. */
export const VERO_DEFAULT_MARGIN_MM = 1.27;

/** What the Custom… dialog accepts, per side, in millimetres. The upper bound
    clears the largest sheet (431.8 mm) with room to spare. */
export const VERO_LIMITS = Object.freeze({ minMm: 10, maxMm: 500 });

/** Palette groups, in menu order. */
export const VERO_CATEGORIES = Object.freeze(["compact", "medium", "large"]);

const preset = (id, category, widthMm, heightMm, extra = {}) =>
  Object.freeze({
    id,
    category,
    widthMm,
    heightMm,
    pitchMm: VERO_PITCH_MM,
    marginMm: VERO_DEFAULT_MARGIN_MM,
    ...extra,
  });

/**
 * The presets, in menu order. `id` is a stable, key-safe name (it keys the
 * translations); `widthMm × heightMm` is the board as it lands on the desk —
 * strips run along the HEIGHT. `inches` is the size a supplier quotes, shown
 * beside the millimetres where the request named one.
 */
export const VERO_PRESETS = Object.freeze([
  // ── Compact / pedal boards ──
  preset("c92x54", "compact", 92, 54, { inches: "3⅝ × 2⅛ in" }),
  preset("c93x55", "compact", 93, 55, { inches: "3.66 × 2.17 in" }),
  preset("c25x64", "compact", 25, 64),

  // ── Medium boards ──
  // Sold as "24 columns × 56 pins long": 24 strips of 56 holes, which the
  // derivation alone would make 25 strips (65 mm holds 25 at a 1.27 mm edge),
  // so the maker's layout is stated.
  preset("m65x144", "medium", 65, 144, { cols: 24, rows: 56 }),
  preset("m122x102", "medium", 122, 102),
  preset("m121x102", "medium", 121, 102),
  preset("m70x90", "medium", 70, 90),
  preset("m100x150", "medium", 100, 150),

  // ── Large / Eurocard-style boards ──
  preset("l100x160", "large", 100, 160),
  preset("l38x215", "large", 38.1, 214.6),
  preset("l12x17in", "large", 304.8, 431.8, { inches: "12 × 17 in" }),
]);

/** The type key a size places as — `vero-92x54`, `vero-38.1x214.6`. */
export function veroTypeKey(widthMm, heightMm) {
  return `vero-${mmText(widthMm)}x${mmText(heightMm)}`;
}

/** A millimetre figure as a key writes it: at most one decimal, no trailing
    zero (92, 38.1). */
export function mmText(mm) {
  return String(Math.round(mm * 10) / 10);
}

const VERO_KEY_RE = /^vero-(\d{1,3}(?:\.\d)?)x(\d{1,3}(?:\.\d)?)$/;

/**
 * `vero-92x54` → `{ widthMm: 92, heightMm: 54 }`, or null for anything that
 * is not a well-formed veroboard key inside VERO_LIMITS. The key must be in
 * its canonical spelling (`92`, not `92.0`), so one size has one key.
 */
export function parseVeroKey(key) {
  if (typeof key !== "string") return null;
  const m = VERO_KEY_RE.exec(key);
  if (!m) return null;
  const widthMm = Number(m[1]);
  const heightMm = Number(m[2]);
  if (veroTypeKey(widthMm, heightMm) !== key) return null;
  const ok = (mm) => mm >= VERO_LIMITS.minMm && mm <= VERO_LIMITS.maxMm;
  if (!ok(widthMm) || !ok(heightMm)) return null;
  return { widthMm, heightMm };
}

/** Is this string a veroboard type key? */
export function isVeroKey(key) {
  return parseVeroKey(key) !== null;
}

/**
 * The preset a size is, in either orientation, as `{ preset, turned }` —
 * `turned` when the board is the preset stood on end — or null for a custom
 * size.
 */
export function presetForSize(widthMm, heightMm) {
  for (const p of VERO_PRESETS) {
    if (p.widthMm === widthMm && p.heightMm === heightMm) {
      return { preset: p, turned: false };
    }
    if (p.widthMm === heightMm && p.heightMm === widthMm) {
      return { preset: p, turned: true };
    }
  }
  return null;
}

/** The type key a preset places as, flat (as listed). */
export function presetKey(p) {
  return veroTypeKey(p.widthMm, p.heightMm);
}

/** The same board turned a quarter: W × H → H × W (strips the other way). */
export function turnedVeroKey(key) {
  const size = parseVeroKey(key);
  return size ? veroTypeKey(size.heightMm, size.widthMm) : null;
}
