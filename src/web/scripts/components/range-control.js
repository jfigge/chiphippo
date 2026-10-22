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

// range-control.js — the slider a `"range"` field is drawn as: the Properties
// card's (part-properties-dialog.js) and a floated slider window's
// (slider-panel.js), so the two read the same. `min`…`max` in `step`s,
// committing on every `input` so the part follows the thumb. With no `ends`
// the value is read out beside it as a percentage of the range — locale-
// formatted, since "50 %" is how several of the shipped languages write it.
// With `ends`, a readout stands at each end of the track instead, left EMPTY
// here: what they say can rest on other fields, so the caller fills them
// (`fillRangeEnds`) whenever the values change.

import { formatNumber } from "../i18n.js";
import { el } from "../dom.js";

/**
 * @param {{key: string, min?: number, max?: number, step?: number,
 *   default?: number, valuePercent?: boolean, ends?: unknown}} field
 * @param {number} value - where the thumb starts
 * @param {(key: string, value: number) => void} onChange - every move
 * @param {string} label - the slider's accessible name
 * @returns {HTMLElement}
 */
export function buildRangeControl(field, value, onChange, label) {
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const fallback = Number.isFinite(field.default) ? field.default : min;
  const start = Number.isFinite(value) ? value : fallback;
  const input = el("input", {
    type: "range",
    class: "properties-range-input",
    min,
    max,
    step: field.step ?? 1,
    value: start,
    "aria-label": label,
  });
  if (field.ends) {
    input.addEventListener("input", () =>
      onChange(field.key, Number(input.value)),
    );
    return el("span", { class: "properties-range" }, [
      el("output", {
        class: "properties-range-end properties-range-end--start",
      }),
      input,
      el("output", { class: "properties-range-end properties-range-end--end" }),
    ]);
  }
  const percent = (v) =>
    formatNumber(field.valuePercent ? v / 100 : (v - min) / (max - min || 1), {
      style: "percent",
    });
  const readout = el("output", {
    class: "properties-range-value",
    text: percent(start),
  });
  input.addEventListener("input", () => {
    const v = Number(input.value);
    readout.textContent = percent(v);
    input.setAttribute("aria-valuetext", readout.textContent);
    onChange(field.key, v);
  });
  input.setAttribute("aria-valuetext", readout.textContent);
  return el("span", { class: "properties-range" }, [input, readout]);
}

/** Write a slider's two end readouts into `container` (holding a
    `buildRangeControl` with `ends`) and hand the pair to assistive tech as
    the thumb's value. */
export function fillRangeEnds(container, [start, end]) {
  container.querySelector(".properties-range-end--start").textContent = start;
  container.querySelector(".properties-range-end--end").textContent = end;
  container
    .querySelector(".properties-range-input")
    .setAttribute("aria-valuetext", `${start} – ${end}`);
}
