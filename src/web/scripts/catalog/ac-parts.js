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

// ac-parts.js — the AC bricks, Spice Lite's alone (`spiceOnly`): an AC
// SUPPLY, a sine between a negative peak and a positive one, and a
// TRANSFORMER, two coupled windings. Pure data, as the rest of the catalog.
//
// Neither has a logic-engine meaning — the logic engine has no voltage below
// 0 V, nothing that alternates, and no magnetism — so there each is nothing
// at all: no net driven or grounded, no winding joining its two ends (a
// brick's terminals are never bridged, sim/netlist.js). Under Spice Lite the
// supply's L is a wave node about its N, a ground (spice/ac-supplies.js), and
// the transformer's windings are two inductors whose currents are coupled by
// their mutual inductance (spice/inductors.js `transformerCoils`, the
// inductance matrix of spice/engine.js `runGroup`).
//
// The transformer is figured as a bench transformer is specified: a turns
// ratio, the primary's magnetising inductance (the secondary's is that over
// the ratio squared), each winding's resistance and the coupling between
// them — never a "volts out" figure, which is what those make of a load.

import { VALUE_RANGES } from "../model/component-value.js";

// ── The AC supply ───────────────────────────────────────────────────────────

/** An AC supply's frequencies on offer, Hz: the world's two mains. Any
    other in `AC_HZ_RANGE` is Custom…. */
export const AC_HZ = Object.freeze([50, 60]);
export const AC_DEFAULT_HZ = 60;
/** A Custom… frequency, Hz, inclusive — the clock's range, since the
    supply's edges are scheduled as a clock's are. */
export const AC_HZ_RANGE = VALUE_RANGES.clock;

/** The outputs on offer, by their RMS volts as AC is labelled — a wall
    adapter's 12 and 24 V AC, and the two mains. Its peaks are √2 times
    that, either side of 0 V. */
export const AC_OUTPUTS = Object.freeze([12, 24, 120, 230]);
export const AC_DEFAULT_RMS = 12;

/** A Custom… output's peaks, volts, inclusive: the positive one above 0 V,
    the negative one below. */
export const AC_PEAK_RANGE = Object.freeze({ min: 0.01, max: 1000 });
export const AC_TROUGH_RANGE = Object.freeze({ min: -1000, max: -0.01 });

/** The Output preset that opens the peaks. */
export const AC_CUSTOM = "custom";

/** A figure as stored: twelve significant figures (√2 × 12 reads back as
    it was written). */
const tidy = (x) => Number(x.toPrecision(12));

/** An RMS output's peak, volts. */
export const acPeakOf = (rms) => tidy(rms * Math.SQRT2);

/** An AC output's label: "12 V~" (IEC 60417's ~, which reads the same in
    every language). */
const acLabel = (rms) => `${rms} V~`;

/** A frequency held to the supply's range, or the default. */
function acHz(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return AC_DEFAULT_HZ;
  return Math.min(AC_HZ_RANGE.max, Math.max(AC_HZ_RANGE.min, raw));
}

/** A stored peak in `range`, or `fallback`. */
function inRange(raw, range, fallback) {
  const x = Number(raw);
  return Number.isFinite(x) && x >= range.min && x <= range.max ? x : fallback;
}

/** The RMS output a supply's peaks are, or null for any other pair. */
function acOutputOf(params) {
  return (
    AC_OUTPUTS.find(
      (rms) =>
        params?.peak === acPeakOf(rms) && params?.trough === -acPeakOf(rms),
    ) ?? null
  );
}

/** The supply's Output: a preset of the four, or its two peaks. */
const AC_OUTPUT_FIELD = Object.freeze({
  key: "output",
  label: "Output",
  type: "preset",
  options: Object.freeze(
    AC_OUTPUTS.map((rms) =>
      Object.freeze({
        value: String(rms),
        label: acLabel(rms),
        detail: `±${acPeakOf(rms).toFixed(1)} V`,
      }),
    ),
  ),
  customValue: AC_CUSTOM,
  customLabel: "Custom…",
  figures: Object.freeze([
    Object.freeze({ key: "peak", label: "Positive peak", unit: "volt", range: AC_PEAK_RANGE }), // prettier-ignore
    Object.freeze({ key: "trough", label: "Negative peak", unit: "volt", range: AC_TROUGH_RANGE }), // prettier-ignore
  ]),
  selected(values) {
    const rms = acOutputOf(values);
    return rms == null ? AC_CUSTOM : String(rms);
  },
  figuresOf(values) {
    const p = AC_SUPPLY_DEF.normalizeParams(values);
    return { peak: p.peak, trough: p.trough };
  },
  pick(values, value) {
    if (value === AC_CUSTOM) return this.figuresOf(values);
    const rms = AC_OUTPUTS.find((v) => String(v) === String(value)) ?? AC_DEFAULT_RMS; // prettier-ignore
    return { peak: acPeakOf(rms), trough: -acPeakOf(rms) };
  },
  setFigure(_values, key, volts) {
    return { [key]: volts };
  },
});

/** The supply's Frequency: 50 or 60 Hz, or Custom…. */
const AC_FREQUENCY_FIELD = Object.freeze({
  key: "frequency",
  label: "Frequency",
  type: "preset",
  options: Object.freeze(
    AC_HZ.map((hz) => Object.freeze({ value: hz, label: `${hz} Hz` })),
  ),
  customValue: AC_CUSTOM,
  customLabel: "Custom…",
  figures: Object.freeze([
    Object.freeze({ key: "customHz", label: "Custom rate", unit: "hertz", range: AC_HZ_RANGE }), // prettier-ignore
  ]),
  selected(values) {
    const hz = acHz(values?.hz);
    return AC_HZ.includes(hz) ? hz : AC_CUSTOM;
  },
  figuresOf(values) {
    return { customHz: acHz(values?.hz) };
  },
  pick(values, value) {
    if (value === AC_CUSTOM) return { hz: this.figuresOf(values).customHz };
    return { hz: AC_HZ.find((hz) => String(hz) === String(value)) ?? AC_DEFAULT_HZ }; // prettier-ignore
  },
  setFigure(_values, _key, hz) {
    return { hz };
  },
});

export const AC_SUPPLY_DEF = Object.freeze({
  id: "ac",
  kind: "ac",
  title: "AC supply",
  blurb:
    "A sine-wave supply — mains, or an AC wall adapter's output: its L " +
    "terminal swings between a positive and a negative peak about its N, " +
    "which is a ground like a power supply's −. Pick 12 or 24 V AC (an " +
    "adapter's), 120 or 230 V AC (mains, for a transformer's primary), or " +
    "set the two peaks; 50 or 60 Hz, or any rate. It goes below 0 V, which " +
    "no logic input survives wired straight on — put a resistor and a clamp " +
    "(a diode or a Zener) in the way, or a transformer and a rectifier. " +
    "Spice Lite only: the logic engine has no voltage below 0 V, so the " +
    "tray shows it only while Spice Lite is on, and there it does nothing.",
  group: "Power",
  // Offered only while Spice Lite is on (components/palette-panel.js).
  spiceOnly: true,
  size: Object.freeze({ width: 8, height: 5 }),
  // `L` and `N`, never `+`/`-`: an address ending in either is read as a
  // PSU's own terminal (schematic-layout.js `netPolarity`).
  terminals: [
    { id: "L", dx: 2, dy: 4 },
    { id: "N", dx: 6, dy: 4 },
  ],
  properties: [AC_OUTPUT_FIELD, AC_FREQUENCY_FIELD],
  normalizeParams(raw) {
    const peak = inRange(raw?.peak, AC_PEAK_RANGE, acPeakOf(AC_DEFAULT_RMS));
    const trough = inRange(raw?.trough, AC_TROUGH_RANGE, -acPeakOf(AC_DEFAULT_RMS)); // prettier-ignore
    return { hz: acHz(raw?.hz), peak, trough };
  },
});

/** What an AC supply's badge says — on the desk, in the 3D view and on the
    schematic: an output by its RMS volts ("12 V~"), any other pair by its
    peaks ("±1 V~", "+5/−3 V~"), and its frequency. */
export function acBadge(params) {
  const p = AC_SUPPLY_DEF.normalizeParams(params);
  const rms = acOutputOf(p);
  const volts =
    rms != null
      ? `${rms} V~`
      : p.peak === -p.trough
        ? `±${tidyShort(p.peak)} V~`
        : `+${tidyShort(p.peak)}/−${tidyShort(-p.trough)} V~`;
  return { volts, hz: `${tidyShort(p.hz)} Hz` };
}

/** A figure in three significant figures, no trailing zeros. */
const tidyShort = (x) => String(Number(x.toPrecision(3)));

// ── The transformer ─────────────────────────────────────────────────────────

/**
 * The transformer's presets: a small (~12 VA) bench transformer of each
 * common ratio, its figures typical of the class — a magnetising inductance
 * that draws a few tens of mA unloaded off its rated primary, a primary of
 * tens of ohms (hundreds at 230 V) and a secondary of under an ohm, and a
 * coupling of 0.99 (a percent of leakage). Assumptions, flagged: no maker's
 * part is copied, and a real one's open-circuit secondary sits a little above
 * its rating (this one's ratio IS its rating, so it sags below under load).
 */
export const TRANSFORMER_PRESETS = Object.freeze(
  [
    { value: "120-12", label: "120 V → 12 V", turns: 10, primaryHenries: 8, primaryOhms: 40, secondaryOhms: 0.6 }, // prettier-ignore
    { value: "120-9", label: "120 V → 9 V", turns: 13.33, primaryHenries: 8, primaryOhms: 40, secondaryOhms: 0.4 }, // prettier-ignore
    { value: "120-5", label: "120 V → 5 V", turns: 24, primaryHenries: 8, primaryOhms: 40, secondaryOhms: 0.15 }, // prettier-ignore
    { value: "230-12", label: "230 V → 12 V", turns: 19.17, primaryHenries: 25, primaryOhms: 150, secondaryOhms: 0.6 }, // prettier-ignore
    { value: "230-5", label: "230 V → 5 V", turns: 46, primaryHenries: 25, primaryOhms: 150, secondaryOhms: 0.15 }, // prettier-ignore
  ].map((p) => Object.freeze({ ...p, coupling: 0.99 })),
);
export const TRANSFORMER_DEFAULT = TRANSFORMER_PRESETS[0];

/** The figures a transformer is set by, in the order Custom… shows them. */
export const TRANSFORMER_FIGURES = Object.freeze(
  [
    { key: "turns", label: "Turns ratio", unit: "ratio", range: { min: 0.01, max: 1000 } }, // prettier-ignore
    { key: "primaryHenries", label: "Primary inductance", unit: "henry", range: { min: 1e-3, max: 100 } }, // prettier-ignore
    { key: "primaryOhms", label: "Primary resistance", unit: "ohm", range: { min: 0.01, max: 10e3 } }, // prettier-ignore
    { key: "secondaryOhms", label: "Secondary resistance", unit: "ohm", range: { min: 0.01, max: 10e3 } }, // prettier-ignore
    // Never 1: two windings coupled perfectly have a singular inductance
    // matrix — no leakage at all — and no real one does.
    { key: "coupling", label: "Coupling", unit: "ratio", range: { min: 0.5, max: 0.999 } }, // prettier-ignore
  ].map((f) => Object.freeze({ ...f, range: Object.freeze(f.range) })),
);

/** The transformer's Rating preset that opens its figures. */
export const TRANSFORMER_CUSTOM = "custom";

/** The preset a transformer's figures are, or null. */
function transformerPresetOf(params) {
  return (
    TRANSFORMER_PRESETS.find((p) =>
      TRANSFORMER_FIGURES.every((f) => params?.[f.key] === p[f.key]),
    ) ?? null
  );
}

/** The transformer's Rating: a preset, or Custom… and its figures. */
const TRANSFORMER_RATING_FIELD = Object.freeze({
  key: "rating",
  label: "Rating",
  type: "preset",
  options: Object.freeze(
    TRANSFORMER_PRESETS.map((p) =>
      Object.freeze({ value: p.value, label: p.label, detail: `${p.turns}:1` }),
    ),
  ),
  customValue: TRANSFORMER_CUSTOM,
  customLabel: "Custom…",
  figures: TRANSFORMER_FIGURES,
  selected(values) {
    return transformerPresetOf(values)?.value ?? TRANSFORMER_CUSTOM;
  },
  figuresOf(values) {
    return TRANSFORMER_DEF.normalizeParams(values);
  },
  /** A preset's figures — or, for Custom…, those shown, to start from. */
  pick(values, value) {
    const preset = TRANSFORMER_PRESETS.find((p) => p.value === value);
    const from = preset ?? this.figuresOf(values);
    return Object.fromEntries(TRANSFORMER_FIGURES.map((f) => [f.key, from[f.key]])); // prettier-ignore
  },
  setFigure(_values, key, n) {
    return { [key]: n };
  },
});

export const TRANSFORMER_DEF = Object.freeze({
  id: "transformer",
  kind: "transformer",
  title: "Transformer",
  blurb:
    "A step-down transformer: an AC voltage across its primary (P1–P2) " +
    "puts out that divided by its turns ratio across its secondary (S1–S2), " +
    "the two windings isolated from each other. Real, not ideal — each " +
    "winding has its resistance and the coupling a little leakage, so the " +
    "secondary sags under load, and the primary draws its magnetising " +
    "current unloaded. Pick a rating (120 or 230 V to 12, 9 or 5 V), or " +
    "set the turns ratio, inductance, winding resistances and coupling. It " +
    "passes only what changes: DC on a winding is a short through its " +
    "resistance. Spice Lite only — the logic engine has no magnetism, so " +
    "there it is two open windings, and the tray shows it only while Spice " +
    "Lite is on.",
  group: "Power",
  spiceOnly: true,
  size: Object.freeze({ width: 10, height: 5 }),
  // The primary on the left, the secondary on the right; the dot ends are 1.
  terminals: [
    { id: "P1", dx: 1, dy: 4 },
    { id: "P2", dx: 3, dy: 4 },
    { id: "S1", dx: 7, dy: 4 },
    { id: "S2", dx: 9, dy: 4 },
  ],
  properties: [TRANSFORMER_RATING_FIELD],
  normalizeParams(raw) {
    return Object.fromEntries(
      TRANSFORMER_FIGURES.map((f) => [
        f.key,
        inRange(raw?.[f.key], f.range, TRANSFORMER_DEFAULT[f.key]),
      ]),
    );
  },
});

/**
 * A transformer's two windings as inductors, and their coupling: the
 * primary's L and the secondary's (L over the turns ratio squared), each
 * winding's resistance, and the mutual inductance M = k·√(L1·L2).
 * @param {object} params
 */
export function transformerWindings(params) {
  const p = TRANSFORMER_DEF.normalizeParams(params);
  const primary = p.primaryHenries;
  const secondary = primary / (p.turns * p.turns);
  return {
    primary: { henries: primary, ohms: p.primaryOhms },
    secondary: { henries: secondary, ohms: p.secondaryOhms },
    mutual: p.coupling * Math.sqrt(primary * secondary),
    coupling: p.coupling,
  };
}

/** What a transformer's badge says: its preset ("120 V → 12 V") or its
    ratio ("10:1"). */
export function transformerBadge(params) {
  const p = TRANSFORMER_DEF.normalizeParams(params);
  return transformerPresetOf(p)?.label ?? `${tidyShort(p.turns)}:1`;
}
