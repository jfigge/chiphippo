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

// preset-field.js — the ONE control a part's PRESET is picked in, when picking
// one sets several parameters together (features/component-value-entry-
// spec.md §5, "Tier 2"): a transistor's Spice Lite Grade. A non-editable list
// of the presets ending in **Custom…**, and under it the preset's FIGURES as
// typed fields — shown only for Custom….
//
//   · picking a preset sets it (its figures with it) and hides the figures;
//   · picking Custom… opens the figures FILLED from the preset shown just
//     before — custom starts from a known-good part, never from blank;
//   · each figure is a value box (value-combobox.js, with no list): read on
//     Enter or leaving it, through the one value parser, red and uncommitted
//     when it does not read — the Tier 1 field's rules exactly;
//   · going back to a preset overwrites the figures with its own.
// Which entry the card OPENS on is the field's to say (`selected`): a stored
// set that is a preset's own figures is that preset, anything else Custom…
// with its figures open — the card never names a preset over figures that
// are not it.
//
// It knows nothing about transistors: the descriptor (catalog/discretes.js
// `gradeField`) states the presets, the figures, and the PATCH each choice
// commits; the dialog hands in the words and the commit.

import { el } from "../dom.js";
import { buildValueCombobox } from "./value-combobox.js";
import {
  formatComponentValue,
  parseComponentValue,
} from "../model/component-value.js";

/**
 * Build a preset row: its label and list, and the Custom figures under it.
 *
 * @param {object} opts
 * @param {object} opts.field - a `"preset"` descriptor: `options` (the
 *   presets: `{value, label, detail?}`), `customValue`, `figures` (`{key,
 *   unit, range}`), `selected(values)`, `figuresOf(values)`, `pick(values,
 *   value)` and `setFigure(values, key, number)` — the last two answering a
 *   PATCH.
 * @param {object} opts.values - the card's values as they stand NOW (the
 *   dialog's live copy, so every read is current).
 * @param {(patch: object) => void} opts.applyPatch
 * @param {string} opts.label - the row's label.
 * @param {(opt: object) => string} opts.optionText - a preset's text.
 * @param {string} opts.customText - Custom…'s text.
 * @param {(figure: object) => string} opts.figureLabel
 * @param {(message: object) => string} opts.message - a refusal, in words.
 * @param {string} opts.toggleLabel
 * @returns {HTMLElement}
 */
export function buildPresetField({
  field,
  values,
  applyPatch,
  label,
  optionText,
  customText,
  figureLabel,
  message,
  toggleLabel,
}) {
  const custom = field.customValue;
  const select = el(
    "select",
    { class: "properties-select", "aria-label": label },
    [
      ...field.options.map((opt) =>
        el("option", { value: opt.value, text: optionText(opt) }),
      ),
      el("option", { value: custom, text: customText }),
    ],
  );
  select.value = String(field.selected(values));
  const figures = el("div", {
    class: "properties-preset-custom",
    role: "group",
    "aria-label": customText,
  });

  /** One figure's box: its value, read as the field's own unit and range. */
  const figureRow = (figure, number) =>
    el("div", { class: "properties-row" }, [
      el("span", { class: "properties-label", text: figureLabel(figure) }),
      buildValueCombobox({
        text: formatComponentValue(number, figure.unit),
        options: [],
        read: (text) => {
          const read = parseComponentValue(text, figure.unit, figure.range);
          return read.error
            ? { ok: false, message: message(read) }
            : { ok: true, text: read.display, commit: read.value };
        },
        onCommit: (n) => applyPatch(field.setFigure(values, figure.key, n)),
        ariaLabel: figureLabel(figure),
        toggleLabel,
      }),
    ]);

  /** The figures, filled from what the card holds now, shown for Custom…
      alone. */
  const showFigures = () => {
    const open = select.value === custom;
    figures.hidden = !open;
    if (!open) {
      figures.replaceChildren();
      return;
    }
    const now = field.figuresOf(values);
    figures.replaceChildren(
      ...field.figures.map((f) => figureRow(f, now[f.key])),
    );
  };

  select.addEventListener("change", () => {
    applyPatch(field.pick(values, select.value));
    showFigures();
  });
  showFigures();

  return el("div", { class: "properties-preset" }, [
    el("div", { class: "properties-row" }, [
      el("span", { class: "properties-label", text: label }),
      select,
    ]),
    figures,
  ]);
}
