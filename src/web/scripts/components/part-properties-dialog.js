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
// project's or a desktop's Location, which Save As is what changes),
// `"wire-gauge"` (the workshop drawing of a wire, dimensioned in cm — see
// below), `"pin-fields"` (an Output/Input element's ordered bit/byte/word
// fields — pin-fields-editor.js; its value is the whole list), `"combo"` (a
// component's value or part number, picked from a list or typed — a
// resistor's Resistance, a transistor's part number; see below), `"range"`
// (a slider over `min`…`max` in `step`s —
// a potentiometer's Position; see below), and `"separator"` (a plain
// divider, no key/control).
//
// `"range"` is the one value control that applies AS IT MOVES (the `input`
// event, not `change`): it stands for a knob, and turning one while the
// circuit runs and watching what it does is the point of having it. Each
// step is still one coalesced undo entry, as every live change here is. Its
// value is read out as a percentage beside it — unless the field carries
// `ends(values)`, returning the two texts to show at either END of the track
// instead (a pot's `1.5k ⟵⟶ 8.5k`: what the position MEANS). Those are asked
// with the card's current values after every change, not just the slider's,
// since what they say can rest on another field — a pot's on its Resistance.
//
// `"combo"` is the editable combo box of components/value-combobox.js: the
// common values in a list, and any value typed the way a bench writes it
// ("4k7", "100 kilo ohms"), STORED as a number. Its descriptor
// (catalog/value-fields.js) says how a stored value SHOWS, how typed text
// READS and what each entry SETS, all as data and message CODES this file
// words (`comboMessage`). Text that does not read is refused AT THE FIELD: a
// reason under the box, `onChange` never called, the stored value as it was
// — the live-apply rule would otherwise write a half-typed value into the
// part — and the text left there to be fixed. A stored value that does not
// read, or lies outside the field's range (a capacitor swapped to a type that
// cannot be that value), opens red the same way, and is not altered. What a
// combo sets is a PATCH: a Zener's voltage brings its part number with it, so
// every key is applied and any other row it touched is rebuilt to match. A
// value field may also
// carry an `action` (`{key, label, icon}`): the same command an `"action"`
// field fires, drawn as an icon button to the RIGHT of the control, for a
// command that belongs to that one row.
//
// A value field may also carry `disabledWhen(values)`: a row that means
// nothing under another row's current choice (an Output's "Trigger starts"
// once its Trigger is Auto) stays in the card, greyed and inert, rather than
// leaving it — a row that vanished would move every control below it under
// the pointer. It is asked with the values as they stand NOW (the opening
// values with every change made here laid over them), on open and after
// every change, since this card never rebuilds its rows.
//
// The CALLER may refuse a change: `onChange` answering `false` means "that
// cannot be done here" (an inductor grown to three holes between its leads,
// with the hole its lead would move to taken). The dialog then puts the row
// back as it was — rebuilt at the value that is still true, the one row this
// card ever rebuilds — and says why under it: the field's `refused` sentence,
// `properties.refused.<key>`. The next change that goes through clears it.
//
// A value may also be edited ELSEWHERE while the card is open — a custom
// chip's Name and Description ARE its part number and description, which the
// chip designer's window edits too. The caller says so with `follow` (an
// event, and the values to re-read when it fires), and the card shows each
// value that moved: a text box is written in place, unless the user is typing
// in it, and any other control is rebuilt.
//
// `"wire-gauge"` is the one field type named after what it draws rather than
// after a KIND of control, and deliberately so: it is a picture, not an editor.
// Like `"separator"` it carries no key and reads nothing out of `values` — the
// caller states what to draw (`color`, and a `measure()` returning the wire's
// hole-to-hole run in mm) in the descriptor itself — and it takes the whole row with no label,
// because the dimension line under the wire already says what it is. Length is a
// CALLBACK rather than a number because it is not a property of the record: it
// is measured off the drawn wire, and a change made in this dialog can move it.
// So the dialog re-asks after every change, and repaints on a colour pick — see
// `open` for both, and wire-gauge.js for why each is one call and not a rebuild.
//
// BELOW every field sits the one section that is not a property at all: the
// part's live WARNINGS — the same faults its badge is drawing on the desk
// (unpowered, underpowered, reversed, damaged, an unprogrammed ROM), written
// out as sentences under a rule of their own. It is the shell's own structure
// rather than a field type, exactly as the Name/Description pair at the top
// is: "last, under a separator, only when there is something to say" is one
// rule, and a caller appending its own separator would double the one `open()`
// already inserts between Name/Description and a def's fields. The desk can
// only draw a triangle; this is where it says what the triangle MEANS, next to
// the properties that may be what fixes it (a PSU's volts, a ROM's Load
// image…).
//
// It is a CALLBACK (`warnings()`), not a list, for the reason the wire gauge's
// `measure()` is one: a run is a moving target. The dialog re-asks on every
// `chiphippo:sim-state` for its OPEN LIFETIME — a chip that lets its smoke out
// while the card is up says so — and rebuilds only when the text actually
// changes, since that event fires on every tick.
//
// Like the Settings dialog, it is deliberately dumb and applies live: every
// value control commits `onChange(key, value)` (text/textarea commit on
// blur/Enter via the `change` event, not per keystroke, so they don't spam
// the undo history), and the caller (desk-controller.js) owns persisting it
// through DeskDoc.setComponentParams/setComponentMeta/setBoardParams + the
// undo/redo commit seam. An action button calls `onAction(key)` instead and
// closes the dialog — it's a command, not a value the dialog needs to keep
// showing.

import { formatNumber, t, tf } from "../i18n.js";
import { el, svgEl } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { buildColorSwatches } from "./color-swatches.js";
import { buildSegmented } from "./segmented-picker.js";
import { buildValueCombobox } from "./value-combobox.js";
import { buildPinFieldsEditor } from "./pin-fields-editor.js";
import {
  buildWireGauge,
  setWireGaugeColor,
  setWireGaugeRun,
} from "./wire-gauge.js";

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

/** What a select or a track shows while its param is unstored: the field's
    `default` — or what it answers for the card's values, when it rests on
    another field (a transistor's Grade, on its Package). */
const defaultOf = (field, values) =>
  typeof field.default === "function" ? field.default(values) : field.default;

/** A select's options: `field.options`, or what it answers for the card's
    current values when it is a function (an inductor's Winding, each option
    stating the resistance it gives). */
const selectOptions = (field, values) =>
  typeof field.options === "function" ? field.options(values) : field.options;

/** One option's text: its name, and its `detail` beside it when it has one —
    a figure with a unit ("1.2Ω"), which reads the same in every language. */
const selectOptionText = (opt) =>
  opt.detail ? `${optionLabel(opt)} — ${opt.detail}` : optionLabel(opt);

/** A dropdown over `field.options: [{value, label, detail?}]` — or a function
    of the card's values returning them, whose texts the dialog re-asks after
    every change (`refreshOptions` in `open`). A <select>'s value is
    ALWAYS a string (`3` becomes `"3"`), but an option's real value may be a
    number (PSU volts) or mixed (clock rate: numbers + the string "manual") —
    onPick looks the typed value back up by its stringified match rather than
    handing the raw string on to normalizeParams, which compares by ===. */
function buildSelect(field, value, onPick, values = {}) {
  const options = selectOptions(field, values);
  return el(
    "select",
    {
      class: "properties-select",
      onChange: (e) => {
        const opt = options.find((o) => String(o.value) === e.target.value);
        onPick(opt ? opt.value : e.target.value);
      },
    },
    options.map((opt) =>
      el("option", {
        value: opt.value,
        text: selectOptionText(opt),
        // A param stored only when it differs from its default (a PSU's
        // current limit) shows that default when absent.
        selected: opt.value === (value ?? defaultOf(field, values)),
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

/** The glyphs a trailing action may carry, by name — so a descriptor stays
    data and this file stays the one place that draws a control. Line-drawn
    24-unit icons at the size the Settings card's inline buttons use. */
const ACTION_ICONS = {
  /** The gear — this action leads to Settings, as the header's own does. */
  settings:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06' +
    "-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A" +
    "1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l" +
    ".06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1" +
    ".65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l" +
    ".06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.6" +
    "5 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-." +
    "06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-." +
    '09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
};

/** An icon button riding to the right of a field's control — `field.action`,
    `{key, label, icon}` — for a command that belongs to THAT row (a
    Connection's "Manage connections…" beside the picker) rather than one
    that deserves a full-width row of its own. Fires like an `"action"` field
    (the dialog closes, then `onAction(key)`); the label, resolved the same
    way, is its tooltip and accessible name, since the glyph is all it shows. */
function withTrailingAction(control, action, onFire) {
  const label = tf(`properties.action.${action.key}`, action.label ?? "");
  const btn = el("button", {
    class: "properties-icon-action",
    type: "button",
    title: label,
    "aria-label": label,
    onClick: onFire,
  });
  btn.innerHTML = ACTION_ICONS[action.icon] ?? "";
  return el("span", { class: "properties-control-group" }, [control, btn]);
}

/** A single-line text field (Name) — commits on the `change` event (blur/
    Enter), not per keystroke, so it doesn't spam the remount + undo-history
    commit every field change fires. */
function buildTextInput(field, value, onChange) {
  return el("input", {
    type: "text",
    class: "properties-text-input",
    value: value ?? "",
    maxLength: field.maxLength,
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
    maxLength: field.maxLength,
    "aria-label": fieldLabel(field),
    onChange: (e) => onChange(field.key, e.target.value),
  });
}

/** A value the dialog SHOWS but does not edit — a project's or a desktop's
    Location, which Save As is what changes. The full text is on the title too,
    since a path can be longer than the row. A `wrap` field (a timer's Timing
    readout) is prose rather than a path, so it wraps at words, in the body
    face. */
function buildReadonly(field, value) {
  const shown = value == null || value === "" ? "" : String(value);
  return el("span", {
    class: field.wrap
      ? "properties-value properties-value--wrap"
      : "properties-value properties-value--path",
    text: shown,
    title: shown,
    "aria-label": fieldLabel(field),
  });
}

/** The sentence a row shows when the caller refused its change —
    `properties.refused.<key>`, the catalog's English as the fallback. */
const refusedMessage = (field) =>
  tf(`properties.refused.${field.key}`, field.refused ?? "");

/**
 * A combo field's reason, in words: a value that does not read, a wrong unit,
 * a value out of range, a part number that is not one — or, as a warning, a
 * transistor's part number that names another type.
 * @param {{error?: string, code?: string, unit?: string, got?: string,
 *   min?: string, max?: string, part?: string, type?: string}} m
 */
function comboMessage(m) {
  switch (m.error ?? m.code) {
    case "range":
      return t("properties.combo.range", { min: m.min, max: m.max });
    case "wrongUnit":
      return t(`properties.combo.wrongUnit.${m.unit}.${m.got}`);
    case "notPart":
      return t("properties.combo.notPart");
    case "foreignPart":
      return t(`properties.combo.foreignPart.${m.type}`, { part: m.part });
    default:
      // "notValue", or a required value left empty.
      return t(`properties.combo.notValue.${m.unit ?? "ohm"}`);
  }
}

/**
 * A value picked or typed (see the note at the top of this file): the
 * field's own list and reading, through the one combo box every value uses.
 * `ctx.values` are the card's values as they stand now; `ctx.applyPatch`
 * sets what a commit sets.
 */
function buildCombo(field, ctx) {
  const shown = field.show(ctx.values);
  const opening = shown.error ?? shown.warning;
  return buildValueCombobox({
    text: shown.text,
    message: opening ? comboMessage(opening) : null,
    invalid: Boolean(shown.error),
    options: field.options(ctx.values).map((o) => ({
      label: o.label,
      text: o.text,
      search: o.search,
      commit: o.patch,
    })),
    read: (text) => {
      const read = field.read(text, ctx.values);
      return read.error
        ? { ok: false, message: comboMessage(read.error) }
        : {
            ok: true,
            text: read.text,
            commit: read.patch,
            warning: read.warning ? comboMessage(read.warning) : undefined,
          };
    },
    onCommit: (patch) => ctx.applyPatch(field.key, patch),
    ariaLabel: fieldLabel(field),
    toggleLabel: t("properties.combo.show"),
  });
}

/**
 * A slider (see the note at the top of this file): `min`…`max` in `step`s,
 * committing on every `input` so the part follows the thumb. With no `ends`
 * the value is read out beside it as a percentage of the range — locale-
 * formatted, since "50 %" is how several of the shipped languages write it.
 * With `ends`, a readout stands at each end of the track instead, left EMPTY
 * here: what they say can rest on other fields, so the dialog fills them
 * (`refreshEnds` in `open`) from its current values.
 */
function buildRange(field, value, onChange) {
  const min = field.min ?? 0;
  const max = field.max ?? 100;
  const start = Number.isFinite(value) ? value : min;
  const input = el("input", {
    type: "range",
    class: "properties-range-input",
    min,
    max,
    step: field.step ?? 1,
    value: start,
    "aria-label": fieldLabel(field),
  });
  if (typeof field.ends === "function") {
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
    formatNumber((v - min) / (max - min || 1), { style: "percent" });
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

/** Build one field's control by its declared `type`. New types extend this
    switch alone — the dialog shell and every part's catalog def stay
    untouched. An unrecognized type falls back to a read-only value. */
function buildControl(field, value, onChange, ctx) {
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
    return buildSelect(field, value, (v) => onChange(field.key, v), ctx?.values); // prettier-ignore
  }
  if (field.type === "segmented") {
    return buildSegmented({
      options: field.options.map((opt) => ({
        ...opt,
        label: optionLabel(opt),
      })),
      value: value ?? defaultOf(field, ctx?.values ?? {}),
      ariaLabel: fieldLabel(field),
      onPick: (v) => onChange(field.key, v),
    });
  }
  if (field.type === "text") {
    return buildTextInput(field, value, onChange);
  }
  if (field.type === "combo") {
    return buildCombo(field, ctx);
  }
  if (field.type === "range") {
    return buildRange(field, value, onChange);
  }
  if (field.type === "textarea") {
    return buildTextarea(field, value, onChange);
  }
  if (field.type === "pin-fields") {
    return buildPinFieldsEditor({
      value,
      ariaLabel: fieldLabel(field),
      onChange: (v) => onChange(field.key, v),
    });
  }
  return el("span", { class: "properties-value", text: String(value ?? "") });
}

/** A plain divider between the universal Name/Description pair and a part's
    own catalog-declared properties. */
const STACKED_TYPES = new Set([
  "text",
  "textarea",
  "readonly",
  "pin-fields",
  "combo",
  "range",
]);

function buildRow(field, value, onChange, onAction, ctx) {
  if (field.type === "separator") {
    return el("hr", { class: "properties-separator" });
  }
  if (field.type === "wire-gauge") {
    // A drawing rather than a control: the full width of the card, no label
    // column — it is dimensioned, so it states its own measurement.
    return el("div", { class: "properties-row properties-row--figure" }, [
      buildWireGauge({ color: field.color, runMm: field.measure() }),
    ]);
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
  const control = buildControl(field, value, onChange, ctx);
  return el("div", { class: rowClass }, [
    el("span", { class: "properties-label", text: fieldLabel(field) }),
    field.action
      ? withTrailingAction(control, field.action, () =>
          onAction(field.action.key),
        )
      : control,
  ]);
}

/** Grey a row out (or bring it back): every control in it stops taking
    input, and the row says so for the stylesheet. `disabledWhen`'s one
    effect — see the note at the top of this file. */
function setRowDisabled(row, disabled) {
  row.classList.toggle("properties-row--disabled", disabled);
  for (const control of row.querySelectorAll(
    "button, input, select, textarea",
  )) {
    control.disabled = disabled;
  }
}

/** The warning triangle, drawn small enough to sit in a line of text — the
    same sign the part is showing on the desk (part-symbols.js draws that one
    in pitch units, so it can't be the same node). Decorative: the sentence
    beside it is the accessible content. */
const warningIcon = () =>
  svgEl(
    "svg",
    {
      class: "properties-warning-icon",
      viewBox: "0 0 16 16",
      width: 13,
      height: 13,
      "aria-hidden": "true",
    },
    [
      svgEl("path", { d: "M8 2 L15 14 H1 Z" }),
      svgEl("path", { d: "M8 6.5 V9.5" }),
      svgEl("circle", { cx: 8, cy: 11.6, r: 0.85 }),
    ],
  );

/** One fault, as a triangle and the sentence explaining it. */
const warningLine = (message) =>
  el("li", { class: "properties-warning" }, [
    warningIcon(),
    el("span", { class: "properties-warning-text", text: message }),
  ]);

/** Every part and every board gets these two fields, always, at the top of
    the dialog — this is the one place that rule lives, so neither caller
    (desk-controller.js's part or board flow) has to repeat it. A caller may
    still say MORE about either (`universal`): a custom chip's pair is its
    part number and description, which have a length, a rule a part number
    must follow, and nothing to change while the circuit runs. */
const nameDescriptionFields = (universal = {}) => [
  {
    ...universal.name,
    key: "name",
    label: t("properties.name"),
    type: "text",
  },
  {
    ...universal.description,
    key: "description",
    label: t("properties.description"),
    type: "textarea",
  },
];

/** The field types whose control is a text box the user TYPES into — which a
    followed value (see `follow` in `open`) is written into in place, since a
    rebuilt row would take the focus and the caret with it. */
const TYPED_TYPES = new Set(["text", "textarea"]);

export class PartPropertiesDialog {
  static #open = false;

  /**
   * Show the shared Properties dialog for one part or board (a no-op when
   * one is already open — same singleton convention as About/Settings).
   * Name/Description always come first; `fields` (if any) follow a separator.
   * @param {object} opts
   * @param {string} opts.title - the dialog header (e.g. "LED Properties").
   * @param {Array<{key?:string,label?:string,type:string,options?:Array<{value,label}>,actionLabel?:string,action?:{key:string,label?:string,icon:string},color?:string,measure?:() => number,disabledWhen?:(values: object) => boolean,ends?:(values: object) => string[]}>} [opts.fields] -
   *   the part's catalog `properties` list (plus any instance-conditional
   *   action fields desk-controller.js appends) — empty/omitted for a board
   *   or a part with nothing beyond Name/Description.
   * @param {object} opts.values - the component's current params (merged
   *   with its name/description) or the board itself.
   * @param {(key: string, value: any) => void} opts.onChange - fires live,
   *   once per value-field control change (text/textarea: on blur/Enter).
   * @param {(key: string) => void} [opts.onAction] - fires once when an
   *   `"action"`-type field's button (or a field's trailing `action` icon)
   *   is clicked; the dialog closes first.
   * @param {() => string[]} [opts.warnings] - the faults the part is showing
   *   right now, as sentences. Re-asked on every sim tick for the dialog's
   *   open lifetime; an empty list keeps the section out of the card
   *   entirely. Omit it for a subject that can't have a fault at all — a
   *   board, a wire, a desktop, the project.
   * @param {{name?: object, description?: object}} [opts.universal] - more
   *   about the Name/Description pair (`maxLength`, `refused`,
   *   `disabledWhen`), merged into the two fields every card leads with.
   * @param {{event: string, values: () => object|null}} [opts.follow] -
   *   values that can change ELSEWHERE while the card is open (a custom
   *   chip's part number and description, which the chip designer edits
   *   too). On every `event` the card re-reads `values()` and shows each one
   *   that moved: written into its text box in place — unless the user is
   *   typing in that very box — and any other control rebuilt.
   */
  static open({
    title,
    fields = [],
    values = {},
    onChange,
    onAction,
    warnings,
    universal,
    follow,
  }) {
    if (PartPropertiesDialog.#open) return;
    PartPropertiesDialog.#open = true;

    const allFields = fields.length
      ? [...nameDescriptionFields(universal), { type: "separator" }, ...fields]
      : nameDescriptionFields(universal);
    const fireAction = (key) => {
      PopupManager.close();
      onAction?.(key);
    };
    // A `"wire-gauge"` is a live PICTURE of two of the record's values, and this
    // card applies changes live and never rebuilds its rows — so a change made
    // here has to reach the drawing or it keeps showing what it opened with.
    // Both halves are one call each, and every other field type is untouched:
    //   • its COLOUR is one custom property (setWireGaugeColor);
    //   • its RUN is re-asked for (`field.measure()`) after EVERY change, not
    //     only the ones that look relevant. Switching Layout Method to Direct
    //     throws a wire's bends away and shortens it, and the dialog has no
    //     business knowing which field that was — the caller owns the
    //     measurement, so the caller is asked again.
    const gauges = [];
    const colorKeys = new Set(
      allFields.filter((f) => f.type === "color").map((f) => f.key),
    );
    const current = { ...values };
    const dependents = [];
    const refreshDisabled = () => {
      for (const { row, field } of dependents) {
        setRowDisabled(row, Boolean(field.disabledWhen(current)));
      }
    };
    // A slider's end readouts (`"range"` with `ends`), re-asked after EVERY
    // change for the wire gauge's reason: what they say may rest on another
    // field, and this card never rebuilds its rows. The thumb's own value goes
    // to assistive tech as the same two texts.
    const ranges = [];
    const refreshEnds = () => {
      for (const { row, field } of ranges) {
        const [start, end] = field.ends(current);
        row.querySelector(".properties-range-end--start").textContent = start;
        row.querySelector(".properties-range-end--end").textContent = end;
        row
          .querySelector(".properties-range-input")
          .setAttribute("aria-valuetext", `${start} – ${end}`);
      }
    };
    // A select whose options or default are a function of the values (an
    // inductor's Winding, each stating its resistance; a transistor's Grade,
    // defaulting by its Package) has them re-asked after every change too,
    // for the same reason: they rest on other fields.
    const selects = [];
    const refreshOptions = () => {
      for (const { row, field } of selects) {
        const texts = selectOptions(field, current).map(selectOptionText);
        row.querySelectorAll("option").forEach((option, i) => {
          if (texts[i] != null && option.textContent !== texts[i]) {
            option.textContent = texts[i];
          }
        });
        const select = row.querySelector("select");
        const shown = String(current[field.key] ?? defaultOf(field, current));
        if (select && select.value !== shown) select.value = shown;
      }
    };
    // A combo's commit is a PATCH (see the note at the top of this file):
    // every key it sets is applied, and any other row it touched is rebuilt
    // to show it — a Zener's Part number, set by picking its voltage.
    const applyPatch = (ownKey, patch) => {
      const keys = Object.keys(patch);
      for (const key of keys) change(key, patch[key]);
      for (const key of keys) if (key !== ownKey) rebuildRow(key);
    };
    const ctx = { values: current, applyPatch };
    // A row rebuilt at the value it holds NOW — the one way this card ever
    // redraws a control, for a refusal or another row's patch.
    const rebuildRow = (key) => {
      const i = allFields.findIndex((f) => f.key === key);
      if (i < 0) return null;
      const fresh = buildRow(allFields[i], current[key], change, fireAction, ctx); // prettier-ignore
      for (const entry of [...dependents, ...ranges, ...selects]) {
        if (entry.row === rows[i]) entry.row = fresh;
      }
      rows[i].replaceWith(fresh);
      rows[i] = fresh;
      refreshDisabled();
      return fresh;
    };
    // A refused change (see the note at the top of this file): its row is
    // rebuilt at the value still TRUE, with the reason under it.
    const refusals = new Map(); // key → the sentence shown under its row
    const refuse = (key) => {
      const fresh = rebuildRow(key);
      if (!fresh) return;
      const i = allFields.findIndex((f) => f.key === key);
      refusals.get(key)?.remove();
      const error = el("span", {
        class: "properties-field-error properties-field-error--row",
        role: "alert",
        text: refusedMessage(allFields[i]),
      });
      fresh.after(error);
      refusals.set(key, error);
      refreshDisabled();
      refreshEnds();
      refreshOptions();
    };
    const change = (key, value) => {
      if (onChange(key, value) === false) {
        refuse(key);
        return;
      }
      refusals.get(key)?.remove();
      refusals.delete(key);
      current[key] = value;
      refreshDisabled();
      refreshEnds();
      refreshOptions();
      for (const { svg, field } of gauges) {
        if (colorKeys.has(key)) setWireGaugeColor(svg, value);
        setWireGaugeRun(svg, field.measure());
      }
      // A followed value comes back as it was STORED (a part number trimmed),
      // which is what the box should show now that the edit is in.
      if (follow) refreshFollowed(key);
    };
    // Values the caller says can change elsewhere (`follow`). The one that
    // was just committed here (`committed`) is always written back; any other
    // is left alone while the user is typing in its box — the edit they are
    // making wins when they commit it — and a value that did not move is
    // never written at all, so a change to something ELSE never throws away
    // text the user has typed and not yet committed.
    const refreshFollowed = (committed = null) => {
      const next = follow.values?.();
      if (!next) return;
      for (const [key, value] of Object.entries(next)) {
        const i = allFields.findIndex((f) => f.key === key);
        if (i < 0) continue;
        const moved = !Object.is(current[key], value);
        current[key] = value;
        if (!moved && key !== committed) continue;
        if (!TYPED_TYPES.has(allFields[i].type)) {
          rebuildRow(key);
          continue;
        }
        const box = rows[i].querySelector("input, textarea");
        const typing =
          key !== committed &&
          box === document.activeElement &&
          document.hasFocus();
        if (box && !typing && box.value !== String(value ?? "")) {
          box.value = value ?? "";
        }
      }
      refreshDisabled();
      refreshEnds();
      refreshOptions();
    };
    const rows = allFields.map((field) =>
      buildRow(field, values[field.key], change, fireAction, ctx),
    );
    allFields.forEach((field, i) => {
      const svg = rows[i].querySelector?.(".wire-gauge");
      if (svg) gauges.push({ svg, field });
      if (typeof field.disabledWhen === "function") {
        dependents.push({ row: rows[i], field });
      }
      if (field.type === "range" && typeof field.ends === "function") {
        ranges.push({ row: rows[i], field });
      }
      if (
        field.type === "select" &&
        (typeof field.options === "function" ||
          typeof field.default === "function")
      ) {
        selects.push({ row: rows[i], field });
      }
    });
    refreshDisabled();
    refreshEnds();

    // The warnings section (see the note at the top of this file): the LAST
    // thing in the card, gone entirely while the part is healthy. Its divider
    // is its own `border-top` rather than a second `<hr>` — one element to
    // hide, and nothing left behind claiming to separate two things when only
    // one of them is showing. `hidden` is the single source of truth, which is
    // why `.properties-warnings[hidden]` exists in the stylesheet: a class that
    // sets a `display` outranks the UA sheet's `[hidden]` rule, so without it
    // the attribute would change nothing.
    //
    // A subject that cannot have a fault at all (a board, a wire, a desktop,
    // the project) passes no callback and gets no node — not an empty one kept
    // hidden, which would leave a card ending in something nobody can see.
    const warningList =
      warnings && el("ul", { class: "properties-warning-list" });
    const warningBox =
      warnings &&
      el("div", { class: "properties-warnings", hidden: true }, [
        el("span", {
          class: "properties-warnings-title",
          text: t("properties.warnings"),
        }),
        warningList,
      ]);
    let shown = null; // last rendered text: a tick that changes nothing costs nothing
    const refreshWarnings = () => {
      if (!warningBox) return;
      const messages = warnings() ?? [];
      const key = messages.join("\n");
      if (key === shown) return;
      shown = key;
      warningList.replaceChildren(...messages.map(warningLine));
      warningBox.hidden = messages.length === 0;
    };
    refreshWarnings();
    // Every tick republishes the fault set, so the card can't go stale under a
    // running circuit. Dropped in onClose, like the About panel's updater
    // listeners — the subscription belongs to the dialog's open lifetime.
    if (warningBox) {
      window.addEventListener("chiphippo:sim-state", refreshWarnings);
    }
    // The followed values' event, for the same open lifetime.
    const onFollowed = () => refreshFollowed();
    if (follow?.event) window.addEventListener(follow.event, onFollowed);

    // onClose fires only when THIS popup closes (not when a popup it was
    // queued behind closes), so the guard never resets while still up.
    PopupManager.dialog({
      title,
      closeAriaLabel: t("properties.close"),
      className: "properties-popup",
      bodyClass: "properties-popup-body",
      body: warningBox ? [...rows, warningBox] : rows,
      onClose: () => {
        window.removeEventListener("chiphippo:sim-state", refreshWarnings);
        if (follow?.event) window.removeEventListener(follow.event, onFollowed); // prettier-ignore
        PartPropertiesDialog.#open = false;
      },
    });
  }
}
