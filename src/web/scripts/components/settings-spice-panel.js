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

// settings-spice-panel.js — Settings ▸ Spice Light (features/spice-light.md
// §5): whether Run uses the second engine, the settle gap for a node nothing
// listens to, and each logic family's electrical numbers. A module of its own
// so settings-dialog.js does not grow another panel's worth of rows.
//
// THE SETTING IS ONE OBJECT (`settings.spiceLight`), replaced whole by a
// patch, so every control here edits the panel's own normalized copy and
// emits all of it. A family stores only what differs from its datasheet
// default (spice/params.js): a value typed back to its default is dropped,
// and Reset drops the family's entry.
//
// Layout: the toggle and the gap; a TTL | CMOS strip showing only the
// families the tray shows (the chip-family setting, widened by any family the
// open project uses — catalog/families.js `familiesShown`, as the tray does);
// under it the family's source and Reset, and halfway down an "Advanced"
// disclosure with every number. Live like the rest of Settings: a field
// applies when it is left or Enter is pressed, never per keystroke, and a
// value that will not read stays on screen, red, with the stored one kept.

import { el } from "../dom.js";
import { formatNumber, t } from "../i18n.js";
import { LOGIC_FAMILIES, familiesShown } from "../catalog/families.js";
import {
  DEFAULT_GAP_PERCENT,
  GAP_PERCENT_RANGE,
  normalizeSpiceConfig,
} from "../sim/spice/config.js";
import { FAMILY_DEFAULTS } from "../sim/spice/params.js";
import { buildSegmented } from "./segmented-picker.js";

/** The family numbers the Advanced section shows, in order, with their units
    (stated as symbols — a unit is not a word). */
export const SPICE_FIELDS = Object.freeze([
  Object.freeze({ key: "delayNs", unit: "ns" }),
  Object.freeze({ key: "sourceMa", unit: "mA" }),
  Object.freeze({ key: "sinkMa", unit: "mA" }),
  Object.freeze({ key: "inputHighUa", unit: "µA" }),
  Object.freeze({ key: "inputLowUa", unit: "µA" }),
  Object.freeze({ key: "supplyMa", unit: "mA" }),
  Object.freeze({ key: "vilV", unit: "V" }),
  Object.freeze({ key: "vihV", unit: "V" }),
  Object.freeze({ key: "loadPf", unit: "pF" }),
]);

/** The strip's label for a family: what the bench calls it, not its prefix. */
const familyLabel = (family) =>
  family === "CD4000" ? t("settings.spice.cmos") : t("settings.spice.ttl");

/** A number as a field shows it, in the reader's locale. */
const shown = (value) =>
  formatNumber(value, { maximumSignificantDigits: 6, useGrouping: false });

/** A typed number, read either decimal mark — or NaN. */
function readNumber(text) {
  const trimmed = String(text).trim().replace(",", ".");
  return trimmed === "" ? Number.NaN : Number(trimmed);
}

/** Mark a field as holding a value that will not read (the stored one is
    kept), or clear the mark. */
function markInvalid(input, invalid) {
  if (invalid) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

/**
 * Build the panel's rows.
 * @param {object} settings - the dialog's settings snapshot
 * @param {(patch: object) => void} emit - the dialog's patch emitter
 * @param {object} opts
 * @param {Function} opts.rowWithNote - the dialog's row-with-(i) builder
 * @param {Iterable<string>} [opts.projectFamilies] - families the open project
 *   uses (always shown)
 * @returns {{rows: HTMLElement[], setFamilyMode: (mode: string) => void}}
 */
export function buildSpicePanel(
  settings,
  emit,
  { rowWithNote, projectFamilies = [] },
) {
  // prettier-ignore
  let config = normalizeSpiceConfig(settings.spiceLight);
  const inUse = [...projectFamilies];
  let shownFamilies = familiesShown(settings.logicFamily, inUse);
  let picked = [...shownFamilies][0];

  const commit = (next) => {
    config = normalizeSpiceConfig(next);
    emit({ spiceLight: config });
  };

  // ── On / Off ─────────────────────────────────────────────────────────────
  const enabledPicker = buildSegmented({
    options: [
      { value: true, label: t("settings.spice.enabledOn") },
      { value: false, label: t("settings.spice.enabledOff") },
    ],
    value: config.enabled,
    ariaLabel: t("settings.spice.enabled"),
    onPick: (enabled) => commit({ ...config, enabled }),
  });

  // ── The gap ──────────────────────────────────────────────────────────────
  const gapInput = el("input", {
    class: "settings-text-input spice-number",
    id: "set-spice-gap",
    type: "text",
    inputmode: "decimal",
    value: shown(config.gapPercent),
    "aria-describedby": "set-spice-gap-unit",
  });
  const applyGap = () => {
    const value = readNumber(gapInput.value);
    const ok =
      gapInput.value.trim() === "" ||
      (value >= GAP_PERCENT_RANGE.min && value <= GAP_PERCENT_RANGE.max);
    markInvalid(gapInput, !ok);
    if (!ok) return;
    const gapPercent = gapInput.value.trim() === "" ? DEFAULT_GAP_PERCENT : value; // prettier-ignore
    gapInput.value = shown(gapPercent);
    if (gapPercent !== config.gapPercent) commit({ ...config, gapPercent });
  };
  gapInput.addEventListener("change", applyGap);
  gapInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyGap();
  });

  // ── The families ─────────────────────────────────────────────────────────
  const sections = new Map(); // family → {section, inputs, reset}
  const overridesOf = (family) => config.families[family] ?? {};
  const valueOf = (family, key) =>
    overridesOf(family)[key] ?? FAMILY_DEFAULTS[family][key];

  const setOverride = (family, key, value) => {
    const own = { ...overridesOf(family) };
    if (value === FAMILY_DEFAULTS[family][key]) delete own[key];
    else own[key] = value;
    const families = { ...config.families, [family]: own };
    if (!Object.keys(own).length) delete families[family];
    commit({ ...config, families });
  };

  const refreshFamily = (family) => {
    const { inputs, reset } = sections.get(family);
    for (const [key, input] of inputs) {
      input.value = shown(valueOf(family, key));
      markInvalid(input, false);
    }
    reset.disabled = !Object.keys(overridesOf(family)).length;
  };

  for (const family of LOGIC_FAMILIES) {
    const inputs = new Map();
    const fieldRows = SPICE_FIELDS.map(({ key, unit }) => {
      const id = `set-spice-${family}-${key}`;
      const input = el("input", {
        class: "settings-text-input spice-number",
        id,
        type: "text",
        inputmode: "decimal",
        "data-key": key,
      });
      inputs.set(key, input);
      const apply = () => {
        // An emptied field asks for its default — which is held to the same
        // rules as a typed value (a default VIH under a typed VIL is no band).
        const value =
          input.value.trim() === ""
            ? FAMILY_DEFAULTS[family][key]
            : readNumber(input.value);
        // Thresholds must keep VIL under VIH, or there is no band to cross.
        const vil = key === "vilV" ? value : valueOf(family, "vilV");
        const vih = key === "vihV" ? value : valueOf(family, "vihV");
        const ok = Number.isFinite(value) && value > 0 && vil < vih;
        markInvalid(input, !ok);
        if (!ok) return;
        setOverride(family, key, value);
        refreshFamily(family);
      };
      input.addEventListener("change", apply);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply();
      });
      return el(
        "div",
        { class: "settings-row settings-row--field spice-field" },
        [
          // prettier-ignore
          el("label", {
          class: "settings-label",
          for: id,
          text: t(`settings.spice.field.${key}`),
        }),
          input,
          el("span", { class: "spice-unit", text: unit }),
        ],
      );
    });

    const reset = el("button", {
      class: "settings-action",
      type: "button",
      text: t("settings.spice.reset"),
      onClick: () => {
        const families = { ...config.families };
        delete families[family];
        commit({ ...config, families });
        refreshFamily(family);
      },
    });
    const section = el(
      "section",
      { class: "spice-family", "data-family": family, hidden: true },
      [
        el("div", { class: "settings-row spice-family-head" }, [
          el("p", {
            class: "settings-hint spice-family-source",
            text: t(`settings.spice.source.${family}`),
          }),
          reset,
        ]),
        el("details", { class: "spice-advanced" }, [
          el("summary", { text: t("settings.spice.advanced") }),
          ...fieldRows,
        ]),
      ],
    );
    sections.set(family, { section, inputs, reset });
    refreshFamily(family);
  }

  const stripHost = el("div", { class: "spice-family-strip" });
  const showPicked = () => {
    for (const [family, { section }] of sections) {
      section.hidden = family !== picked;
    }
  };
  const renderStrip = () => {
    if (!shownFamilies.has(picked)) picked = [...shownFamilies][0];
    stripHost.replaceChildren(
      buildSegmented({
        options: LOGIC_FAMILIES.filter((f) => shownFamilies.has(f)).map(
          (family) => ({ value: family, label: familyLabel(family) }),
        ),
        value: picked,
        ariaLabel: t("settings.spice.family"),
        onPick: (family) => {
          picked = family;
          showPicked();
        },
      }),
    );
    showPicked();
  };
  renderStrip();

  const rows = [
    rowWithNote({
      label: t("settings.spice.enabled"),
      control: enabledPicker,
      notes: [t("settings.spice.enabledHint")],
    }),
    rowWithNote({
      label: t("settings.spice.gap"),
      htmlFor: "set-spice-gap",
      control: el("div", { class: "spice-number-group" }, [
        gapInput,
        el("span", { class: "spice-unit", id: "set-spice-gap-unit", text: "%" }), // prettier-ignore
      ]),
      notes: [t("settings.spice.gapHint")],
    }),
    stripHost,
    ...[...sections.values()].map(({ section }) => section),
  ];

  return {
    rows,
    /** The chip-family setting moved while the card is open (Data Sheets):
        offer the families it now shows. */
    setFamilyMode(mode) {
      shownFamilies = familiesShown(mode, inUse);
      renderStrip();
    },
  };
}
