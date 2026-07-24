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

// part-properties-dialog.js — the shared "Properties…" modal every part's
// context menu opens (desk-controller.js's #onOpenProperties). ONE dialog
// shell rendering a data-driven list of fields; a part declares which
// properties it has and how to edit them in its catalog def (`properties`,
// e.g. the LED's `color`, the PSU's `volts`), and this component is the only
// place that knows how to turn a field descriptor into a control. Adding
// properties to a new part later is purely a catalog change — this file and
// the desk-controller wiring never need to touch that part specifically.
// Three field types today: `"color"` (a row of swatches), `"select"` (a
// dropdown over `options: [{value, label}]`), and `"action"` (a button that
// fires a named command rather than editing a param, e.g. a memory chip's
// "Inspect memory…" — see desk-controller.js's #propertyFieldsFor).
//
// Like the Settings dialog, it is deliberately dumb and applies live: every
// value control calls `onChange(key, value)` immediately (no Save/Cancel),
// and the caller (desk-controller.js) owns persisting it through
// DeskDoc.setComponentParams + the undo/redo commit seam. An action button
// calls `onAction(key)` instead and closes the dialog — it's a command, not
// a value the dialog needs to keep showing.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { buildColorSwatches } from "./color-swatches.js";

/** A close "×" glyph for the header button (matches settings-dialog.js's). */
const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
  'aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/** A dropdown over `field.options: [{value, label}]`. A <select>'s value is
    ALWAYS a string (`3` becomes `"3"`), but an option's real value may be a
    number (PSU volts) or mixed (clock rate: numbers + the string "manual") —
    onPick looks the typed value back up by its stringified match rather than
    handing the raw string on to normalizeParams, which compares by ===. */
function buildSelect(field, value, onPick) {
  return el(
    "select",
    {
      class: "properties-select",
      onChange: (e) => {
        const opt = field.options.find(
          (o) => String(o.value) === e.target.value,
        );
        onPick(opt ? opt.value : e.target.value);
      },
    },
    field.options.map((opt) =>
      el("option", {
        value: opt.value,
        text: opt.label,
        selected: opt.value === value,
      }),
    ),
  );
}

/** A full-width command button — fires `onFire()` and does not stay around
    to reflect a "current value" the way the other field types do. */
function buildActionButton(field, onFire) {
  return el("button", {
    class: "properties-action",
    type: "button",
    text: field.actionLabel ?? field.label,
    onClick: onFire,
  });
}

/** Build one field's control by its declared `type`. New types extend this
    switch alone — the dialog shell and every part's catalog def stay
    untouched. An unrecognized type falls back to a read-only value. */
function buildControl(field, value, onChange) {
  if (field.type === "color") {
    return buildColorSwatches({
      colors: field.options,
      value,
      ariaLabel: field.label,
      onPick: (v) => onChange(field.key, v),
    });
  }
  if (field.type === "select") {
    return buildSelect(field, value, (v) => onChange(field.key, v));
  }
  return el("span", { class: "properties-value", text: String(value ?? "") });
}

function buildRow(field, value, onChange, onAction) {
  if (field.type === "action") {
    return el("div", { class: "properties-row properties-row--action" }, [
      buildActionButton(field, () => onAction(field.key)),
    ]);
  }
  return el("div", { class: "properties-row" }, [
    el("span", { class: "properties-label", text: field.label }),
    buildControl(field, value, onChange),
  ]);
}

export class PartPropertiesDialog {
  static #open = false;

  /**
   * Show the shared Properties dialog for one part (a no-op when one is
   * already open — same singleton convention as About/Settings).
   * @param {object} opts
   * @param {string} opts.title - the dialog header (e.g. "LED Properties").
   * @param {Array<{key:string,label:string,type:string,options?:Array<{value,label}>,actionLabel?:string}>} opts.fields -
   *   the part's catalog `properties` list (plus any instance-conditional
   *   action fields desk-controller.js appends).
   * @param {object} opts.values - the component's current params.
   * @param {(key: string, value: any) => void} opts.onChange - fires live,
   *   once per value-field control change.
   * @param {(key: string) => void} [opts.onAction] - fires once when an
   *   `"action"`-type field's button is clicked; the dialog closes first.
   */
  static open({ title, fields, values = {}, onChange, onAction }) {
    if (PartPropertiesDialog.#open) return;
    PartPropertiesDialog.#open = true;

    const closeBtn = el("button", {
      class: "popup-close",
      type: "button",
      title: "Close",
      "aria-label": "Close properties",
      onClick: () => PopupManager.close(),
    });
    closeBtn.innerHTML = CLOSE_SVG;

    const fireAction = (key) => {
      PopupManager.close();
      onAction?.(key);
    };
    const rows = fields.map((field) =>
      buildRow(field, values[field.key], onChange, fireAction),
    );

    const element = el(
      "div",
      {
        class: "popup properties-popup",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
      },
      [
        el("div", { class: "popup-header" }, [
          el("span", { class: "popup-title", text: title }),
          closeBtn,
        ]),
        el("div", { class: "popup-body properties-popup-body" }, rows),
      ],
    );

    // onClose fires only when THIS popup closes (not when a popup it was
    // queued behind closes), so the guard never resets while still up.
    PopupManager.open({
      element,
      onMaskClick: () => PopupManager.close(),
      onClose: () => {
        PartPropertiesDialog.#open = false;
      },
    });
  }
}
