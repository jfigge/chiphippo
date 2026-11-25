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

// segmented-picker.js — the ONE either/or picker shared by the Settings dialog
// (Appearance ▸ Theme, Appearance ▸ Wire layout, AI ▸ Provider) and the Part
// Properties dialog (a `"segmented"` field, e.g. a wire's Layout Method). It is
// a DIALOG's form of the toolbar pill: one bordered track holding borderless
// segments, the chosen one filled — so a short, closed set of choices reads the
// same wherever it is offered, and never as a dropdown you have to open to see
// what it holds.
//
// Same shape (and the same reason) as color-swatches.js: a caller hands over
// the options, the current value, and an `onPick`, and this is the only place
// that knows how to turn that into DOM. Generic over `{ value, label }`, so the
// next either/or setting reuses it rather than growing a third copy.

import { el } from "../dom.js";

/**
 * Build a segmented picker over `options`. Clicking a segment updates every
 * segment's active state in place and calls `onPick(value)`.
 *
 * @param {object} opts
 * @param {Array<{value: any, label: string}>} opts.options
 * @param {any} opts.value - the currently chosen option's value.
 * @param {(value: any) => void} opts.onPick - fires on click.
 * @param {string} [opts.ariaLabel] - label for the radiogroup.
 * @param {string} [opts.className] - an extra class on the track, for a variant
 *   that needs different metrics (see `--numeric`).
 */
export function buildSegmented({
  options,
  value,
  ariaLabel,
  onPick,
  className,
}) {
  const buttons = options.map((opt) =>
    el("button", {
      class: `segmented-option${opt.value === value ? " segmented-option--active" : ""}`, // prettier-ignore
      type: "button",
      role: "radio",
      "aria-checked": String(opt.value === value),
      // Through `dataset`, not as a bare `data-value` prop: `el()` treats a
      // prop worth `false` as an absent attribute and `true` as a valueless
      // one, so a BOOLEAN option would land as `data-value=""` or as nothing
      // at all. The dataset branch stringifies whatever it is given.
      dataset: { value: opt.value },
      text: opt.label,
      // An option the caller greys (a TO-220 on a TO-92's bent legs) stays
      // in the track, saying why on hover.
      disabled: opt.disabled === true,
      ...(opt.title ? { title: opt.title } : {}),
      onClick: () => {
        // Compare the OPTIONS, never their rendered attributes: an attribute
        // is a string, and every non-string value has to survive a round trip
        // through it to match itself back. Settings ▸ About's auto-check is
        // `true`/`false`, and under the old `data-value` comparison NEITHER
        // segment matched — clicking one left the whole track unchecked, which
        // read as a setting that would not stay set (it was stored fine). The
        // buttons are built from `options` in order, so the index IS identity.
        buttons.forEach((b, i) => {
          const on = options[i] === opt;
          b.classList.toggle("segmented-option--active", on);
          b.setAttribute("aria-checked", String(on));
        });
        rove();
        onPick?.(opt.value);
      },
    }),
  );
  // A radio group is ONE tab stop — the chosen segment (or the first one
  // that can be chosen) — and the arrow keys move the choice within it, as
  // a native radio group does (WAI-ARIA radiogroup).
  const enabled = () => buttons.filter((b) => !b.disabled);
  const rove = () => {
    const on = buttons.find((b) => b.getAttribute("aria-checked") === "true" && !b.disabled) ?? enabled()[0]; // prettier-ignore
    for (const b of buttons) b.tabIndex = b === on ? 0 : -1;
  };
  const STEP = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const onKeyDown = (e) => {
    const list = enabled();
    const at = list.indexOf(e.target);
    if (at < 0 || !list.length) return;
    let next = null;
    if (e.key in STEP)
      next = list[(at + STEP[e.key] + list.length) % list.length]; // prettier-ignore
    else if (e.key === "Home") next = list[0];
    else if (e.key === "End") next = list[list.length - 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
    if (next.getAttribute("aria-checked") !== "true") next.click();
  };
  rove();
  return el(
    "div",
    {
      class: `segmented-picker${className ? ` ${className}` : ""}`,
      role: "radiogroup",
      "aria-label": ariaLabel,
      onKeydown: onKeyDown,
    },
    buttons,
  );
}
