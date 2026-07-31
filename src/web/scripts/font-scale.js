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

// font-scale.js — Settings ▸ Appearance ▸ Editor font size: the six steps, the
// arithmetic for walking them, the one line that applies the choice, and the
// keyboard policy for BOTH of the app's scales (see scaleStepForEvent).
//
// An app-wide seam like `i18n.js`, and for the same reason: all four renderers
// import it at boot. It owns the SIZE; `styles/theme.css` owns the SCALE — one
// base (`--font-size`) with every rank derived off it — so this module writes
// exactly one custom property and the whole of the app's chrome follows.
//
// WHAT IT DELIBERATELY DOES NOT REACH is the desk. Chip labels, board row and
// column markings, schematic symbols and annotations are drawn in WORLD units
// (one unit = one breadboard pitch): they are printed on the circuit, not
// chrome, and they scale with the desk camera. A user's text size must never be
// able to slide a label off the part it names.
//
// Everything here but `applyFontSize`/`followFontSize` is pure.

/**
 * The sizes the picker offers and the shortcuts walk, ascending. A DISCRETE
 * ladder, not a range: 15 and 17 are deliberately absent, so every step lands
 * on a value the type scale was checked at and a key press is one visible move
 * rather than an imperceptible one.
 */
export const FONT_SIZES = Object.freeze([11, 12, 13, 14, 16, 18]);

/** The shipped size, and what ⌥⌘0 restores. Reproduces the app's original
 *  type scale exactly — see the table above `--font-size` in theme.css. */
export const DEFAULT_FONT_SIZE = 13;

/**
 * Any stored or received value → the nearest legal step. REPAIRS rather than
 * rejects: a settings.json hand-edited to 15 comes back as 16, not as a silent
 * reset to the default — the user asked for "bigger than 14" and got it. Only
 * a value that is not a number at all falls back.
 *
 * Ties break UPWARD (15 → 16), biased toward legibility: this setting exists to
 * make text readable, so when it cannot tell which of two sizes was meant it
 * should not be the one that guesses smaller.
 *
 * @param {unknown} value
 * @returns {number} a member of FONT_SIZES
 */
export function normalizeFontSize(value) {
  // Numbers, and strings that hold one. NOT `Number(value)` on anything else:
  // it reads `null`, `[]` and `""` as 0, which would clamp to the SMALLEST step
  // — so an absent setting would come up at 11px rather than at the default.
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  let best = FONT_SIZES[0];
  let bestGap = Infinity;
  for (const px of FONT_SIZES) {
    const gap = Math.abs(px - n);
    // `<=` is what breaks a tie upward: FONT_SIZES ascends, so the later (and
    // therefore larger) of two equally-distant steps is the one kept.
    if (gap <= bestGap) {
      best = px;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * One step along the ladder. SATURATES at both ends rather than wrapping — a
 * shortcut that jumped from 18 back to 11 would look like a misfire, and the
 * caller uses "the value did not move" to know it is at a limit.
 *
 * Normalizes first, so stepping from an illegal stored value is defined.
 *
 * @param {unknown} value
 * @param {number} dir - +1 to grow, -1 to shrink.
 * @returns {number} a member of FONT_SIZES
 */
export function stepFontSize(value, dir) {
  const from = normalizeFontSize(value);
  const i = FONT_SIZES.indexOf(from);
  const next = i + (dir > 0 ? 1 : -1);
  if (next < 0 || next >= FONT_SIZES.length) return from;
  return FONT_SIZES[next];
}

/**
 * Which of the app's two SCALES does this keydown ask to change, and how?
 * → `{ target: "font" | "desk", step: "in" | "out" | "reset" }`, or null.
 *
 * Both live here because they are ONE policy that differs by a single
 * modifier — ⌘= resizes the app's own text, ⌥⌘= zooms the desk camera — so
 * splitting them across two modules would let the two halves drift into
 * chords that overlap. Bare ⌘ is the text, because that is the one a reader
 * who cannot see the screen reaches for first; the desk already has a zoom
 * cluster, a Fit button and a scroll wheel.
 *
 * Matched on `e.code`, NOT `e.key`, and that is the whole reason this is a
 * function rather than a few lines inline. With Option held macOS reports the
 * alt-layout CHARACTER — ⌥= is "≠", ⌥- is "–", ⌥0 is "º" — so `e.key` cannot
 * name the desk pair's keys at all, and the app's usual `e.key` convention
 * would produce a chord that silently never fires. The `e.key` forms are OR'd
 * in behind the codes for layouts that do not remap, and `e.code` alone would
 * miss those.
 *
 * Takes a plain object, so the trap above is testable with no DOM.
 *
 * @param {{metaKey?:boolean, ctrlKey?:boolean, altKey?:boolean,
 *          shiftKey?:boolean, code?:string, key?:string}} e
 */
export function scaleStepForEvent(e) {
  if (!e || !(e.metaKey || e.ctrlKey) || e.shiftKey) return null;
  const target = e.altKey ? "desk" : "font";
  const { code, key } = e;
  if (code === "Equal" || code === "NumpadAdd" || key === "=" || key === "+") {
    return { target, step: "in" };
  }
  if (
    code === "Minus" ||
    code === "NumpadSubtract" ||
    key === "-" ||
    key === "_"
  ) {
    return { target, step: "out" };
  }
  if (code === "Digit0" || code === "Numpad0" || key === "0") {
    return { target, step: "reset" };
  }
  return null;
}

/**
 * Apply a size by writing the base of the type scale onto the document root.
 * The DEFAULT removes the property instead of restating it, so theme.css stays
 * the one place the shipped 13px is written and the two can never disagree.
 *
 * Mirrors app.js's `--color-selection` branch exactly, and is idempotent — a
 * window may be told the same size twice (its own apply, then main's fan-out)
 * with no second effect.
 *
 * @returns {number} the normalized size actually applied.
 */
export function applyFontSize(value, root = document.documentElement) {
  const px = normalizeFontSize(value);
  if (px === DEFAULT_FONT_SIZE) {
    root.style.removeProperty("--font-size");
  } else {
    root.style.setProperty("--font-size", `${px}px`);
  }
  return px;
}

/**
 * Boot + subscribe, for a renderer that does not OWN the setting: read the
 * stored size over the bridge, apply it, then follow main's fan-out. The three
 * auxiliary windows (pinout, memory inspector, user guide) have no settings UI
 * — they only ever follow — so this exists so each is one line rather than six.
 *
 * The app window does NOT use this: it applies the size through its own
 * `applySettings`, the seam every other live setting already goes through.
 *
 * @param {object} bridge - `window.chiphippo`.
 * @param {(px: number) => void} [onChange] - run after each apply, for a
 *   window with geometry of its own to re-measure (the hex grid's row height).
 */
export async function followFontSize(bridge, onChange, root) {
  const apply = (value) => {
    const px = applyFontSize(value, root ?? document.documentElement);
    onChange?.(px);
  };
  window.addEventListener("chiphippo:font-size-changed", (e) =>
    apply(e.detail?.size),
  );
  try {
    apply((await bridge?.settings?.get())?.fontSize);
  } catch (err) {
    // A settings read that fails must not stop the window from painting; the
    // default is already in the stylesheet.
    console.error("[renderer] font size: settings:get failed:", err);
  }
}
