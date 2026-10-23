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

// pin-fields-editor.js — the Properties card's "Pins" control for an Output
// or Input element (the `"pin-fields"` field type): the element's ordered
// FIELDS, each a bit, a byte or a word, with the name that becomes its
// parameter in the generated Arduino code.
//
// One row per field — the pins it covers, its name, its type, and a remove
// button — then an Add row with one button per type, each disabled when it
// would take the element past sixteen pins. The tags on the desk are numbered
// by PIN, so re-shaping here moves no tag; the pins column is what says which
// numbers a field now owns.
//
// Like every Properties control it applies LIVE: each change reports the whole
// new list through `onChange` (a name commits on blur/Enter, not per key, so
// it does not spam the undo history), and the editor re-renders itself from
// that list, since the card never rebuilds its rows — EXCEPT for a name. A
// name commits on the blur that a press elsewhere causes, i.e. at MOUSEDOWN
// on "+ Byte", ×, or a type; rebuilding then replaces that button before its
// mouseup, and the browser drops the click. A name changes nothing else a row
// shows, so its input is corrected in place instead.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import {
  FIELD_PINS,
  FIELD_TYPES,
  MAX_ELEMENT_PINS,
  defaultFieldName,
  fieldSpans,
  normalizeFields,
  pinCount,
} from "../model/integration.js";
import { integrationNameProblem } from "../model/integration-names.js";

/**
 * Why a name an Output, Input, Data bus or field is given cannot be used, in
 * words — or null when it can (model/integration-names.js decides).
 * @param {string} name
 * @param {{field?: boolean}} [opts]
 * @returns {string|null}
 */
export function integrationNameMessage(name, opts) {
  const problem = integrationNameProblem(name, opts);
  if (!problem) return null;
  return problem.code === "reserved"
    ? t("integration.nameProblem.reserved", {
        word: problem.word,
        language: problem.language,
      })
    : t("integration.nameProblem.control");
}

/**
 * Show on a text box whether its text is acceptable — red, with the reason as
 * its tooltip, while it is not. Returns the reason, or null.
 * @param {HTMLInputElement} input
 * @param {string|null} message
 */
export function markNameInput(input, message) {
  if (message) {
    input.setAttribute("aria-invalid", "true");
    input.title = message;
  } else {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("title");
  }
  return message;
}

/** "1–8" / "9" — the pins a field covers. */
const pinsText = (span) =>
  span.first === span.last ? String(span.first) : `${span.first}–${span.last}`;

/**
 * @param {object} opts
 * @param {Array<{type: string, name: string}>} opts.value the current fields
 * @param {(fields: Array) => void} opts.onChange
 * @param {string} [opts.ariaLabel]
 * @returns {HTMLElement}
 */
export function buildPinFieldsEditor({ value, onChange, ariaLabel }) {
  let fields = normalizeFields(value);
  const root = el("div", {
    class: "pin-fields",
    role: "group",
    ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
  });

  const commit = (next, { rerender = true } = {}) => {
    fields = normalizeFields(next);
    onChange(fields.map((f) => ({ ...f })));
    if (rerender) render();
  };

  const typeLabel = (type) => t(`integration.fieldType.${type}`);
  const markField = (input) =>
    markNameInput(input, integrationNameMessage(input.value, { field: true }));
  // A name stored before this check (an older file) opens red the same way —
  // and is not altered: the generator renames it, and says so.
  const markOpening = (input) => {
    markField(input);
    return input;
  };

  function render() {
    const spans = fieldSpans(fields);
    const used = pinCount(fields);
    const rows = spans.map((span, i) =>
      el("div", { class: "pin-fields-row" }, [
        el("span", {
          class: "pin-fields-pins",
          title: t("integration.fields.pinsTitle", { pins: pinsText(span) }),
          text: pinsText(span),
        }),
        markOpening(
          el("input", {
            type: "text",
            class: "pin-fields-name",
            value: span.name,
            spellcheck: false,
            "aria-label": t("integration.fields.nameAria", {
              pins: pinsText(span),
            }),
            // A name no generated code could hold is refused AT THE FIELD,
            // as a combo refuses text that does not read: red as it is typed,
            // the reason its tooltip, nothing committed, the text left to fix.
            onInput: (e) => markField(e.target),
            onChange: (e) => {
              if (markField(e.target)) return;
              const next = fields.map((f) => ({ ...f }));
              next[i].name = e.target.value;
              commit(next, { rerender: false });
              e.target.value = fields[i].name; // trimmed, or the default if blank
            },
          }),
        ),
        el(
          "select",
          {
            class: "pin-fields-type",
            "aria-label": t("integration.fields.typeAria", {
              pins: pinsText(span),
            }),
            onChange: (e) => {
              const type = e.target.value;
              const next = fields.map((f) => ({ ...f }));
              next[i] = { type, name: next[i].name };
              // A type that would overflow is refused by putting the old one
              // back, rather than silently dropping the fields after it.
              if (pinCount(next) > MAX_ELEMENT_PINS) {
                e.target.value = fields[i].type;
                return;
              }
              commit(next);
            },
          },
          FIELD_TYPES.map((type) =>
            el("option", {
              value: type,
              text: typeLabel(type),
              selected: type === span.type,
              disabled:
                type !== span.type &&
                used - FIELD_PINS[span.type] + FIELD_PINS[type] >
                  MAX_ELEMENT_PINS,
            }),
          ),
        ),
        el("button", {
          type: "button",
          class: "pin-fields-remove",
          text: "×",
          title: t("integration.fields.remove"),
          "aria-label": t("integration.fields.remove"),
          disabled: fields.length <= 1,
          onClick: () => commit(fields.filter((_, k) => k !== i)),
        }),
      ]),
    );
    const add = el("div", { class: "pin-fields-add" }, [
      el("span", {
        class: "pin-fields-count",
        text: t("integration.fields.count", {
          used,
          max: MAX_ELEMENT_PINS,
        }),
      }),
      ...FIELD_TYPES.map((type) =>
        el("button", {
          type: "button",
          class: "pin-fields-add-btn",
          text: `+ ${typeLabel(type)}`,
          disabled: used + FIELD_PINS[type] > MAX_ELEMENT_PINS,
          onClick: () =>
            commit([
              ...fields,
              { type, name: defaultFieldName(type, used + 1) },
            ]),
        }),
      ),
    ]);
    root.replaceChildren(...rows, add);
  }

  render();
  return root;
}
