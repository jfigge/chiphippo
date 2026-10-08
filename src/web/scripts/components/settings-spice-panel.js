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

// settings-spice-panel.js — Settings ▸ Spice Lite (features/spice-lite.md
// §5): whether Run uses the second engine, the settle gap for a node nothing
// listens to, and each logic family's electrical numbers. A module of its own
// so settings-dialog.js does not grow another panel's worth of rows.
//
// THE SETTING IS ONE OBJECT (`settings.spiceLite`), replaced whole by a
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
// number outside a field's range (spice/config.js FIELD_RANGES, which its
// tooltip states) is set to the nearest end of it. A value that will not do —
// no number at all, or VIL not under VIH — stays on screen, red, with the
// stored one kept, and a line under it says why.

import { el } from "../dom.js";
import { formatNumber, t } from "../i18n.js";
import { LOGIC_FAMILIES, familiesShown } from "../catalog/families.js";
import {
  DEFAULT_GAP_PERCENT,
  FIELD_RANGES,
  GAP_PERCENT_RANGE,
  clampField,
  clampToRange,
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

/** A range's end as the range sentence shows it: grouped, in the reader's
    locale (10,000 ns reads better than 10000 in a sentence). */
const shownEnd = (value) =>
  formatNumber(value, { maximumSignificantDigits: 6 });

/** What a field accepts, as a sentence: its tooltip, and what it says under
    itself when a value is refused for being outside it. */
const rangeText = ({ min, max }, unit) =>
  t("settings.spice.range", { min: shownEnd(min), max: shownEnd(max), unit });

/** The line under a field that says why its value was refused — hidden
    until one is. */
const problemLine = (id) =>
  el("p", {
    class: "settings-hint spice-problem",
    id,
    "aria-live": "polite",
    hidden: true,
  });

/** Mark a field as holding a value that will not do (the stored one is
    kept) and say why on its problem line — or, with no problem, clear both. */
function markInvalid(input, line, problem) {
  if (problem) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  line.textContent = problem ?? "";
  line.hidden = !problem;
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
  let config = normalizeSpiceConfig(settings.spiceLite);
  const inUse = [...projectFamilies];
  let shownFamilies = familiesShown(settings.logicFamily, inUse);
  let picked = [...shownFamilies][0];

  const commit = (next) => {
    config = normalizeSpiceConfig(next);
    emit({ spiceLite: config });
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
  const gapRange = rangeText(GAP_PERCENT_RANGE, "%");
  const gapProblem = problemLine("set-spice-gap-problem");
  const gapInput = el("input", {
    class: "settings-text-input spice-number",
    id: "set-spice-gap",
    type: "text",
    inputmode: "decimal",
    value: shown(config.gapPercent),
    title: gapRange,
    "aria-describedby": "set-spice-gap-unit set-spice-gap-problem",
  });
  const applyGap = () => {
    // Emptied, the default; outside the range, its nearest end; only text
    // that is no number is refused.
    const gapPercent =
      gapInput.value.trim() === ""
        ? DEFAULT_GAP_PERCENT
        : clampToRange(GAP_PERCENT_RANGE, readNumber(gapInput.value));
    markInvalid(gapInput, gapProblem, gapPercent == null ? gapRange : null);
    if (gapPercent == null) return;
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
    const { inputs, problems, reset } = sections.get(family);
    for (const [key, input] of inputs) {
      input.value = shown(valueOf(family, key));
      markInvalid(input, problems.get(key), null);
    }
    reset.disabled = !Object.keys(overridesOf(family)).length;
  };

  for (const family of LOGIC_FAMILIES) {
    const inputs = new Map();
    const problems = new Map(); // key → its problem line
    const fieldRows = SPICE_FIELDS.map(({ key, unit }) => {
      const id = `set-spice-${family}-${key}`;
      const range = rangeText(FIELD_RANGES[key], unit);
      const problem = problemLine(`${id}-problem`);
      const input = el("input", {
        class: "settings-text-input spice-number",
        id,
        type: "text",
        inputmode: "decimal",
        title: range,
        "aria-describedby": `${id}-problem`,
        "data-key": key,
      });
      inputs.set(key, input);
      problems.set(key, problem);
      const apply = () => {
        // An emptied field asks for its default — which is held to the same
        // rules as a typed value (a default VIH under a typed VIL is no band).
        // A number outside the field's range (spice/config.js FIELD_RANGES)
        // is set to the nearest end of it, as a stored one is; only text
        // that is no number is refused.
        const value =
          input.value.trim() === ""
            ? FAMILY_DEFAULTS[family][key]
            : clampField(key, readNumber(input.value));
        // Thresholds must keep VIL under VIH, or there is no band to cross.
        const vil = key === "vilV" ? value : valueOf(family, "vilV");
        const vih = key === "vihV" ? value : valueOf(family, "vihV");
        // A refusal says which rule it broke.
        const why =
          value == null
            ? range
            : vil >= vih
              ? key === "vihV"
                ? t("settings.spice.aboveVil", { vil: shown(vil) })
                : t("settings.spice.belowVih", { vih: shown(vih) })
              : null;
        markInvalid(input, problem, why);
        if (why) return;
        setOverride(family, key, value);
        refreshFamily(family);
      };
      input.addEventListener("change", apply);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") apply();
      });
      return [
        el("div", { class: "settings-row settings-row--field spice-field" }, [
          el("label", {
            class: "settings-label",
            for: id,
            text: t(`settings.spice.field.${key}`),
          }),
          // The Gap row's shape, so every field lines up down the panel.
          el("div", { class: "spice-number-group" }, [
            input,
            el("span", { class: "spice-unit", text: unit }),
          ]),
        ]),
        problem,
      ];
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
          ...fieldRows.flat(),
        ]),
      ],
    );
    sections.set(family, { section, inputs, problems, reset });
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
    gapProblem,
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
