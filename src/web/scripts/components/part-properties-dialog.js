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

// part-properties-dialog.js — the shared "Properties…" modal every part's AND
// every board's context menu opens (desk-controller.js's #onOpenProperties /
// #onOpenBoardProperties). ONE dialog shell rendering a data-driven list of
// fields; a part declares which extra properties it has and how to edit them
// in its catalog def (`properties`, e.g. the LED's `color`, the PSU's
// `volts`), and this component is the only place that knows how to turn a
// field descriptor into a control. Adding properties to a new part later is
// purely a catalog change — this file and the desk-controller wiring never
// need to touch that part specifically.
//
// EVERY call gets a Name (`"text"`) and Description (`"textarea"`) field for
// free — `open()` prepends them unconditionally — so the dialog is never
// empty, even for a part/board with no catalog-declared properties at all. The
// caller's own `fields` (if any) are appended below a `"separator"` divider.
// Field types: `"text"` (single-line input), `"textarea"` (multi-line,
// stacked label-above-control layout), `"color"` (a row of swatches),
// `"select"` (a dropdown over `options: [{value, label}]`), `"segmented"`
// (the SAME options shown as one bordered track of segments — the shared
// `segmented-picker.js` the Settings dialog's Theme and Wire layout pickers
// use; pick it over `"select"` for a short, closed either/or set, where the
// choices should be readable without opening anything, and `"select"` only
// once the list is long enough that a track would not fit), `"action"` (a
// button that fires a named command rather than editing a value, e.g. a
// memory chip's "Inspect memory…" — see desk-controller.js's
// #propertyFieldsFor), `"readonly"` (a value shown but not edited — a
// project's or a desktop's Location, which Save As is what changes), and
// `"separator"` (a plain divider, no key/control).
//
// Like the Settings dialog, it is deliberately dumb and applies live: every
// value control commits `onChange(key, value)` (text/textarea commit on
// blur/Enter via the `change` event, not per keystroke, so they don't spam
// the undo history), and the caller (desk-controller.js) owns persisting it
// through DeskDoc.setComponentParams/setComponentMeta/setBoardParams + the
// undo/redo commit seam. An action button calls `onAction(key)` instead and
// closes the dialog — it's a command, not a value the dialog needs to keep
// showing.

import { t, tf } from "../i18n.js";
import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { buildColorSwatches } from "./color-swatches.js";
import { buildSegmented } from "./segmented-picker.js";

/**
 * A field's own LABEL, and an option's, translated.
 *
 * A catalog def declares its `properties` as pure module-level DATA (see
 * catalog/labels.js for why `t()` cannot be used there), so the English label
 * travels with the field and is resolved HERE — the one consumer of that list.
 * `properties.field.<key>` names the row ("Color", "Voltage", "Rate", "Size");
 * `properties.option.<value>` names a choice, which in practice means the one
 * word among them ("manual" → "Manual"), since the rest are numbers with a unit
 * ("5 V", "1 Hz", "16×2") that read the same in every language and fall back to
 * the catalog's own text.
 */
const fieldLabel = (field) =>
  tf(`properties.field.${field.key}`, field.label ?? field.key);
const optionLabel = (opt) =>
  tf(`properties.option.${opt.value}`, opt.label ?? String(opt.value));

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
        text: optionLabel(opt),
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
    // `actionLabel` is the English source when the field came from a catalog
    // def; a field minted in the app carries none, and the key alone names it.
    text: tf(
      `properties.action.${field.key}`,
      field.actionLabel ?? field.label ?? "",
    ),
    onClick: onFire,
  });
}

/** A single-line text field (Name) — commits on the `change` event (blur/
    Enter), not per keystroke, so it doesn't spam the remount + undo-history
    commit every field change fires. */
function buildTextInput(field, value, onChange) {
  return el("input", {
    type: "text",
    class: "properties-text-input",
    value: value ?? "",
    "aria-label": fieldLabel(field),
    onChange: (e) => onChange(field.key, e.target.value),
  });
}

/** A multi-line text field (Description) — same commit-on-`change` style as
    buildTextInput. */
function buildTextarea(field, value, onChange) {
  return el("textarea", {
    class: "properties-textarea",
    rows: 3,
    value: value ?? "",
    "aria-label": fieldLabel(field),
    onChange: (e) => onChange(field.key, e.target.value),
  });
}

/** A value the dialog SHOWS but does not edit — a project's or a desktop's
    Location, which Save As is what changes. The full text is on the title too,
    since a path can be longer than the row. */
function buildReadonly(field, value) {
  const shown = value == null || value === "" ? "" : String(value);
  return el("span", {
    class: "properties-value properties-value--path",
    text: shown,
    title: shown,
    "aria-label": fieldLabel(field),
  });
}

/** Build one field's control by its declared `type`. New types extend this
    switch alone — the dialog shell and every part's catalog def stay
    untouched. An unrecognized type falls back to a read-only value. */
function buildControl(field, value, onChange) {
  if (field.type === "readonly") {
    return buildReadonly(field, value);
  }
  if (field.type === "color") {
    return buildColorSwatches({
      colors: field.options,
      value,
      ariaLabel: fieldLabel(field),
      onPick: (v) => onChange(field.key, v),
    });
  }
  if (field.type === "select") {
    return buildSelect(field, value, (v) => onChange(field.key, v));
  }
  if (field.type === "segmented") {
    return buildSegmented({
      options: field.options.map((opt) => ({
        ...opt,
        label: optionLabel(opt),
      })),
      value,
      ariaLabel: fieldLabel(field),
      onPick: (v) => onChange(field.key, v),
    });
  }
  if (field.type === "text") {
    return buildTextInput(field, value, onChange);
  }
  if (field.type === "textarea") {
    return buildTextarea(field, value, onChange);
  }
  return el("span", { class: "properties-value", text: String(value ?? "") });
}

/** A plain divider between the universal Name/Description pair and a part's
    own catalog-declared properties. */
const STACKED_TYPES = new Set(["text", "textarea", "readonly"]);

function buildRow(field, value, onChange, onAction) {
  if (field.type === "separator") {
    return el("hr", { class: "properties-separator" });
  }
  if (field.type === "action") {
    return el("div", { class: "properties-row properties-row--action" }, [
      buildActionButton(field, () => onAction(field.key)),
    ]);
  }
  // A textarea doesn't fit the narrow flex-shrink control column the other
  // types share, so text/textarea stack the label above a full-width control.
  const rowClass = STACKED_TYPES.has(field.type)
    ? "properties-row properties-row--stacked"
    : "properties-row";
  return el("div", { class: rowClass }, [
    el("span", { class: "properties-label", text: fieldLabel(field) }),
    buildControl(field, value, onChange),
  ]);
}

/** Every part and every board gets these two fields, always, at the top of
    the dialog — this is the one place that rule lives, so neither caller
    (desk-controller.js's part or board flow) has to repeat it. */
const nameDescriptionFields = () => [
  { key: "name", label: t("properties.name"), type: "text" },
  { key: "description", label: t("properties.description"), type: "textarea" },
];

export class PartPropertiesDialog {
  static #open = false;

  /**
   * Show the shared Properties dialog for one part or board (a no-op when
   * one is already open — same singleton convention as About/Settings).
   * Name/Description always come first; `fields` (if any) follow a separator.
   * @param {object} opts
   * @param {string} opts.title - the dialog header (e.g. "LED Properties").
   * @param {Array<{key:string,label:string,type:string,options?:Array<{value,label}>,actionLabel?:string}>} [opts.fields] -
   *   the part's catalog `properties` list (plus any instance-conditional
   *   action fields desk-controller.js appends) — empty/omitted for a board
   *   or a part with nothing beyond Name/Description.
   * @param {object} opts.values - the component's current params (merged
   *   with its name/description) or the board itself.
   * @param {(key: string, value: any) => void} opts.onChange - fires live,
   *   once per value-field control change (text/textarea: on blur/Enter).
   * @param {(key: string) => void} [opts.onAction] - fires once when an
   *   `"action"`-type field's button is clicked; the dialog closes first.
   */
  static open({ title, fields = [], values = {}, onChange, onAction }) {
    if (PartPropertiesDialog.#open) return;
    PartPropertiesDialog.#open = true;

    const allFields = fields.length
      ? [...nameDescriptionFields(), { type: "separator" }, ...fields]
      : nameDescriptionFields();
    const fireAction = (key) => {
      PopupManager.close();
      onAction?.(key);
    };
    const rows = allFields.map((field) =>
      buildRow(field, values[field.key], onChange, fireAction),
    );

    // onClose fires only when THIS popup closes (not when a popup it was
    // queued behind closes), so the guard never resets while still up.
    PopupManager.dialog({
      title,
      closeAriaLabel: t("properties.close"),
      className: "properties-popup",
      bodyClass: "properties-popup-body",
      body: rows,
      onClose: () => {
        PartPropertiesDialog.#open = false;
      },
    });
  }
}
