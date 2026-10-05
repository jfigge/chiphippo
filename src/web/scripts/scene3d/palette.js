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

// palette.js — the 3D view's colours ARE the desk's: every one is read from
// the same `--color-*` token in styles/theme.css that the 2D parts are filled
// with, so a theme change (or a token retuned) reaches both views at once and
// the two can never disagree about what colour a part is. WebGL cannot read a
// CSS variable, so the view resolves the tokens once per build through
// `readPalette(getVar)` — `getVar` is getComputedStyle in the app and a plain
// lookup in a test — and hands the result to the pure scene builder.
//
// Every token carries the DARK theme's value as its fallback, so a missing
// token (a test with no stylesheet, a token renamed) still draws a sensible
// part rather than a black one.

import { WIRE_COLORS } from "../model/wire-colors.js";

/** `#rgb` / `#rrggbb` / `rgb(…)` → `[r, g, b]` in 0…1, or null. */
export function parseColor(text) {
  if (typeof text !== "string") return null;
  const s = text.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    return [...m[1]].map((h) => parseInt(h + h, 16) / 255);
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) {
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
  if (m) return [m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)) / 255);
  return null;
}

/** `[r, g, b]` scaled by `k` (darker below 1, brighter above), clamped. */
export const shade = (rgb, k) =>
  rgb.map((c) => Math.min(1, Math.max(0, c * k)));

/** `a` blended toward `b` by `t`. */
export const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

/** `[r, g, b]` → `#rrggbb`, for the 2D canvases the labels are drawn on. */
export function toHex(rgb) {
  return `#${rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** palette key → [token, dark-theme fallback]. */
const TOKENS = Object.freeze({
  base: ["--color-base", "#1c1c1c"],
  text: ["--color-text", "#e8e8e8"],
  boardBody: ["--color-board-body", "#d9d5c9"],
  boardEdge: ["--color-board-edge", "#b8b3a4"],
  boardTrench: ["--color-board-trench", "#c7c2b4"],
  boardHole: ["--color-board-hole", "#33322e"],
  boardLabel: ["--color-board-label", "#8a8577"],
  railPlus: ["--color-rail-plus", "#c05050"],
  railMinus: ["--color-rail-minus", "#5070c0"],
  chipBody: ["--color-chip-body", "#26262b"],
  chipNotch: ["--color-chip-notch", "#17171a"],
  chipLeg: ["--color-chip-leg", "#9aa0a8"],
  chipLabel: ["--color-chip-label", "#d8d8dc"],
  partBody: ["--color-part-body", "#43474d"],
  partInset: ["--color-part-inset", "#2c2f34"],
  partAccent: ["--color-part-accent", "#c8ccd2"],
  partCap: ["--color-part-cap", "#b25252"],
  partResistor: ["--color-part-resistor", "#c9a26a"],
  ceramic: ["--color-part-ceramic", "#d9892b"],
  ceramicText: ["--color-part-ceramic-text", "#3a2408"],
  capCan: ["--color-part-cap-can", "#2a4a8c"],
  capStripe: ["--color-part-cap-stripe", "#b8c4dc"],
  capText: ["--color-part-cap-text", "#e9eef8"],
  trimpot: ["--color-part-trimpot", "#2f62b5"],
  trimpotText: ["--color-part-trimpot-text", "#eef2fa"],
  screw: ["--color-part-screw", "#c9a347"],
  screwSlot: ["--color-part-screw-slot", "#4a3a12"],
  diode: ["--color-part-diode", "#232326"],
  diodeBand: ["--color-part-diode-band", "#c4c8ce"],
  zener: ["--color-part-zener", "#c9702a"],
  zenerBand: ["--color-part-zener-band", "#1e1e20"],
  inductorCore: ["--color-part-inductor-core", "#2f3034"],
  inductorCopper: ["--color-part-inductor-copper", "#d08a46"],
  inductorDrum: ["--color-part-inductor-drum", "#1b1b1e"],
  inductorText: ["--color-part-inductor-text", "#c9c9ce"],
  transistor: ["--color-part-transistor", "#222226"],
  transistorTab: ["--color-part-transistor-tab", "#b4b9c0"],
  transistorText: ["--color-part-transistor-text", "#d8d8dc"],
  partOn: ["--color-part-on", "#52d273"],
  smoke: ["--color-part-smoke", "#565b62"],
  success: ["--color-success", "#80c080"],
  simHigh: ["--color-sim-high", "#7ce07c"],
  danger: ["--color-danger", "#e07070"],
  psuBody: ["--color-psu-body", "#2e3238"],
  psuBadge: ["--color-psu-badge", "#e4e6ea"],
  lcdPcb: ["--color-lcd-pcb", "#256147"],
  lcdBezel: ["--color-lcd-bezel", "#20242a"],
});

/** The resistor colour code's twelve names (model/resistor-bands.js). */
const BAND_NAMES = Object.freeze([
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
  "grey",
  "white",
  "gold",
  "silver",
]);

const BAND_FALLBACK = Object.freeze({
  black: "#1e1e20",
  brown: "#7a4a22",
  red: "#c8332d",
  orange: "#e07a1f",
  yellow: "#e8cf2a",
  green: "#2f9a45",
  blue: "#2f5fc8",
  violet: "#8a3fc0",
  grey: "#8c8f94",
  white: "#f2f2f0",
  gold: "#a8820f",
  silver: "#bfc3c8",
});

const WIRE_FALLBACK = Object.freeze({
  red: "#d04a4a",
  black: "#26262a",
  blue: "#4a6fd0",
  green: "#4aa04a",
  yellow: "#d0b04a",
  orange: "#d0804a",
  white: "#e8e8e8",
  purple: "#9a5ad0",
});

/** An LCD's backlight colours (its `color` param) — screen and lit dot. */
const LCD_COLORS = Object.freeze(["green", "blue", "red", "yellow", "white"]);
const LCD_SCREEN_FALLBACK = Object.freeze({
  green: "#7cbf5a",
  blue: "#2b5fd9",
  red: "#b8443c",
  yellow: "#d9c24a",
  white: "#dfe6ea",
});
const LCD_DOT_FALLBACK = Object.freeze({
  green: "#16261a",
  blue: "#eaf2ff",
  red: "#2a1010",
  yellow: "#2a2410",
  white: "#1b1f24",
});

/**
 * Resolve every colour the 3D view draws with.
 * @param {(token: string) => string} [getVar] - a CSS custom property's value
 *   (getComputedStyle(root).getPropertyValue in the app); absent → fallbacks.
 * @returns {object} palette key → `[r, g, b]`, plus `band`, `wire`,
 *   `lcdScreen` and `lcdDot` maps keyed by colour name
 */
export function readPalette(getVar = () => "") {
  const read = (token, fallback) =>
    parseColor(safe(getVar, token)) ?? parseColor(fallback);
  const palette = {};
  for (const [key, [token, fallback]] of Object.entries(TOKENS)) {
    palette[key] = read(token, fallback);
  }
  palette.band = Object.fromEntries(
    BAND_NAMES.map((n) => [n, read(`--color-band-${n}`, BAND_FALLBACK[n])]),
  );
  palette.wire = Object.fromEntries(
    WIRE_COLORS.map((n) => [
      n,
      read(`--color-wire-${n}`, WIRE_FALLBACK[n] ?? "#888888"),
    ]),
  );
  palette.lcdScreen = Object.fromEntries(
    LCD_COLORS.map((n) => [
      n,
      read(`--color-lcd-screen-${n}`, LCD_SCREEN_FALLBACK[n]),
    ]),
  );
  palette.lcdDot = Object.fromEntries(
    LCD_COLORS.map((n) => [
      n,
      read(`--color-lcd-dot-${n}`, LCD_DOT_FALLBACK[n]),
    ]),
  );
  return palette;
}

function safe(getVar, token) {
  try {
    return getVar(token);
  } catch {
    return "";
  }
}

/** A wire/LED colour NAME → `[r, g, b]`, red for anything unknown (the
    desk's own fallback for an LED with no colour). */
export function namedColor(palette, name) {
  return palette.wire[name] ?? palette.wire.red;
}
