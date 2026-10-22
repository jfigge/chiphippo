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

// ac-parts.js — the AC bricks, Spice Lite's alone (`spiceOnly`): MAINS, the
// wall's sine about an earthed neutral; an AC ADAPTER, a wall transformer
// plugged into the wall whose isolated output is what reaches the board; and
// a TRANSFORMER, two coupled windings. Pure data, as the rest of the catalog.
//
// None has a logic-engine meaning — the logic engine has no voltage below
// 0 V, nothing that alternates, and no magnetism — so there each is nothing
// at all: no net driven or grounded, no winding joining its two ends (a
// brick's terminals are never bridged, sim/netlist.js). Under Spice Lite the
// mains' L is a wave node about its N, a ground (spice/ac-supplies.js); an
// adapter's S1 is held at its S2 plus its own sine (spice/analog-devices.js
// "v"), its circuit floating; and the
// transformer's windings are two inductors whose currents are coupled by
// their mutual inductance (spice/inductors.js `transformerCoils`, the
// inductance matrix of spice/engine.js `runGroup`).
//
// The transformer is figured as a bench transformer is specified: a turns
// ratio, the primary's magnetising inductance (the secondary's is that over
// the ratio squared), each winding's resistance and the coupling between
// them — never a "volts out" figure, which is what those make of a load. An
// adapter is figured as one is labelled: OUTPUT 12 V~ 60 Hz.

import { formatComponentValue } from "../model/component-value.js";

// ── Mains ───────────────────────────────────────────────────────────────────

/** The mains' frequencies, Hz: the world's two. */
export const AC_HZ = Object.freeze([50, 60]);
export const AC_DEFAULT_HZ = 60;

/** The mains voltages, by their RMS volts as AC is labelled — Japan's 100,
    North America's 120, and the 230 and 240 of most of the rest of the
    world. Its peaks are √2 times that, either side of 0 V. Nothing else: a
    low-voltage sine is an adapter's. */
export const AC_OUTPUTS = Object.freeze([100, 120, 230, 240]);
export const AC_DEFAULT_RMS = 120;

/** The Output preset that opens a figure (the adapter's). */
export const AC_CUSTOM = "custom";

/** A figure as stored: twelve significant figures (√2 × 12 reads back as
    it was written). */
const tidy = (x) => Number(x.toPrecision(12));

/** An RMS output's peak, volts. */
export const acPeakOf = (rms) => tidy(rms * Math.SQRT2);

/** An AC output's label: "12 V~" (IEC 60417's ~, which reads the same in
    every language). */
const acLabel = (rms) => `${rms} V~`;

/** A stored figure in `range`, or `fallback`. */
function inRange(raw, range, fallback) {
  const x = Number(raw);
  return Number.isFinite(x) && x >= range.min && x <= range.max ? x : fallback;
}

/** Of `options`, the one nearest `x`. */
const nearest = (options, x) =>
  options.reduce((best, o) => (Math.abs(o - x) < Math.abs(best - x) ? o : best)); // prettier-ignore

/** A frequency the wall has: 50 or 60 Hz, whichever is nearer. */
function wallHz(raw) {
  const hz = Number(raw);
  return Number.isFinite(hz) && hz > 0 ? nearest(AC_HZ, hz) : AC_DEFAULT_HZ;
}

/** The mains' Output: its four voltages. Its param is `rms`. */
const AC_OUTPUT_FIELD = Object.freeze({
  key: "rms",
  labelKey: "output",
  label: "Output",
  type: "segmented",
  options: Object.freeze(
    AC_OUTPUTS.map((rms) => Object.freeze({ value: rms, label: acLabel(rms) })),
  ),
});

/** A Frequency: the wall's 50 or 60 Hz — the mains', and an adapter's.
    Its param is `hz`, a clock's "Rate", so it says which label it wears. */
export const WALL_FREQUENCY_FIELD = Object.freeze({
  key: "hz",
  labelKey: "frequency",
  label: "Frequency",
  type: "segmented",
  options: Object.freeze(
    AC_HZ.map((hz) => Object.freeze({ value: hz, label: `${hz} Hz` })),
  ),
});

/** Mains is always EARTHED: its neutral is bonded to earth at the
    service, so N is a ground like a PSU's − (spice/ac-supplies.js). It is
    one of the wall's four voltages at one of its two frequencies — no
    Custom… (Jason, 2026-10-22: mains and the transformer are the pair for
    looking inside a linear supply; any other sine is the signal
    generator's). */
export const AC_SUPPLY_DEF = Object.freeze({
  id: "ac",
  kind: "ac",
  title: "Mains",
  blurb:
    "The wall socket, for looking inside a linear power supply: wire it " +
    "to a transformer's primary and follow the AC down to DC. Its L (line) " +
    "terminal swings about its N (neutral), which is earthed — a ground " +
    "like a power supply's −. Pick 100, 120, 230 or 240 V AC and 50 or " +
    "60 Hz (a new one starts at your country's). It swings hundreds of " +
    "volts either side of 0 V, which nothing on a breadboard survives " +
    "wired straight on. For low-voltage AC on the board, use an AC " +
    "adapter. Spice Lite only: " +
    "the logic engine has no voltage below 0 V, so the tray shows it only " +
    "while Spice Lite is on, and there it does nothing.",
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
  properties: [AC_OUTPUT_FIELD, WALL_FREQUENCY_FIELD],
  /** `{hz, rms}`. A desk from before 2026-10-22 stored its two peaks
      (`peak`/`trough`, any pair): read as the nearest of the four. */
  normalizeParams(raw) {
    let rms = Number(raw?.rms);
    if (!AC_OUTPUTS.includes(rms)) {
      const peak = Math.max(Math.abs(Number(raw?.peak)), Math.abs(Number(raw?.trough))); // prettier-ignore
      rms = Number.isFinite(peak) && peak > 0 ? nearest(AC_OUTPUTS, peak / Math.SQRT2) : AC_DEFAULT_RMS; // prettier-ignore
    }
    return { hz: wallHz(raw?.hz), rms };
  },
});

/** What mains puts out: `{hz, peak, trough}`, the shape every AC source's
    sine is given in (spice/ac-supplies.js). */
export function mainsSineOf(params) {
  const { hz, rms } = AC_SUPPLY_DEF.normalizeParams(params);
  return { hz, peak: acPeakOf(rms), trough: -acPeakOf(rms) };
}

/**
 * The mains a country's sockets carry, by its ISO 3166 code (Electron's
 * `app.getLocaleCountryCode()`): `{rms, hz}` — what a NEW mains brick starts
 * at, and a new adapter's frequency. The 120 V / 60 Hz countries, Japan's
 * 100 V (50 Hz: Tokyo's, the east), the 230 V / 60 Hz ones, and 230 V /
 * 50 Hz everywhere else — the IEC's nominal for Europe, the UK and
 * Australia alike (their 240 V is an older figure, offered as a preset).
 * Countries between (Brazil's 127/220 V, Taiwan's 110 V) take the nearest.
 * Unknown → North America's.
 */
const MAINS_120_60 = new Set(["US", "CA", "MX", "PR", "GU", "VI", "AS", "MP", "UM", "TW", "BR", "CO", "VE", "EC", "CR", "PA", "GT", "HN", "SV", "NI", "DO", "CU", "JM", "BS", "BZ", "HT", "BM", "KY", "TT", "LR", "SR", "AW", "CW"]); // prettier-ignore
const MAINS_230_60 = new Set(["KR", "PH", "SA", "PE", "BO", "CL", "PY", "UY", "GY"]); // prettier-ignore
export const MAINS_FALLBACK = Object.freeze({ rms: 120, hz: 60 });

export function mainsForCountry(code) {
  const cc = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!/^[A-Z]{2}$/.test(cc)) return MAINS_FALLBACK;
  if (MAINS_120_60.has(cc)) return MAINS_FALLBACK;
  if (cc === "JP") return Object.freeze({ rms: 100, hz: 50 });
  if (MAINS_230_60.has(cc)) return Object.freeze({ rms: 230, hz: 60 });
  return Object.freeze({ rms: 230, hz: 50 });
}

/** A new mains brick's params for a country (`mainsForCountry`). */
export function mainsParamsFor(code) {
  const { rms, hz } = mainsForCountry(code);
  return { hz, rms };
}

/** What mains' badge says — on the desk, in the 3D view and on the
    schematic: its output ("120 V~") and its frequency ("60 Hz"). */
export function acBadge(params) {
  const { hz, rms } = AC_SUPPLY_DEF.normalizeParams(params);
  return { volts: acLabel(rms), hz: `${hz} Hz` };
}

/** A figure in three significant figures, no trailing zeros. */
const tidyShort = (x) => String(Number(x.toPrecision(3)));

// ── The AC adapter ──────────────────────────────────────────────────────────

/** Its outputs on offer, RMS volts as the label says — the wall
    transformers sold for doorbells, thermostats, pedals and bench work.
    Any other in `ADAPTER_RMS_RANGE` is Custom…. */
export const ADAPTER_OUTPUTS = Object.freeze([9, 12, 16, 18, 24]);
export const ADAPTER_DEFAULT_RMS = 12;
export const ADAPTER_RMS_RANGE = Object.freeze({ min: 1, max: 48 });

/** Its rated current, amps, and how far its output sags at it — 10 %, a
    linear wall transformer's (assumptions, flagged: no maker's part is
    copied). Its output is its rating with nothing drawn, behind
    `adapterOhms` — 1.2 Ω for a 12 V one. */
export const ADAPTER_RATED_AMPS = 1;
export const ADAPTER_REGULATION = 0.1;

/** An adapter's source resistance, Ω (`ADAPTER_REGULATION`). */
export function adapterOhms(params) {
  const { rms } = ADAPTER_DEF.normalizeParams(params);
  return tidy((ADAPTER_REGULATION * rms) / ADAPTER_RATED_AMPS);
}

/** The adapter's Output: a preset, or Custom… and its RMS volts. */
const ADAPTER_OUTPUT_FIELD = Object.freeze({
  key: "output",
  label: "Output",
  type: "preset",
  options: Object.freeze(
    ADAPTER_OUTPUTS.map((rms) =>
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
    Object.freeze({ key: "customRms", label: "Output (RMS)", unit: "volt", range: ADAPTER_RMS_RANGE }), // prettier-ignore
  ]),
  selected(values) {
    const { rms } = ADAPTER_DEF.normalizeParams(values);
    return ADAPTER_OUTPUTS.includes(rms) ? String(rms) : AC_CUSTOM;
  },
  figuresOf(values) {
    return { customRms: ADAPTER_DEF.normalizeParams(values).rms };
  },
  pick(values, value) {
    if (value === AC_CUSTOM) return { rms: this.figuresOf(values).customRms };
    return { rms: ADAPTER_OUTPUTS.find((v) => String(v) === String(value)) ?? ADAPTER_DEFAULT_RMS }; // prettier-ignore
  },
  setFigure(_values, _key, rms) {
    return { rms };
  },
});

/** The adapter is its OUTPUT alone (Jason, 2026-10-22): plugged into the
    wall, never wired to a mains brick — the mains side is the transformer's
    to model. Its frequency is the wall's, 50 or 60 Hz, a new one starting at
    the country's (`adapterParamsFor`). */
export const ADAPTER_DEF = Object.freeze({
  id: "adapter",
  kind: "adapter",
  title: "AC adapter",
  blurb:
    "A wall transformer, plugged into the wall: its two output terminals " +
    "(S1 and S2) bring low-voltage AC to the board — 9, 12, 16, 18 or 24 V " +
    "AC, or any other. The output is isolated from the mains, so it floats: " +
    "a bridge rectifier's − can go on the ground rail, and that is where the " +
    "analyzer reads it from. It runs at 50 or 60 Hz (a new one starts at " +
    "your country's), and is rated 1 A, sagging 10 % at that. To work from the mains itself, use " +
    "a mains brick and a transformer. Spice Lite only: the logic engine has " +
    "no voltage below 0 V, so the tray shows it only while Spice Lite is " +
    "on, and there it does nothing.",
  group: "Power",
  spiceOnly: true,
  size: Object.freeze({ width: 8, height: 5 }),
  // S1 and S2, as a transformer's secondary — S1 the end that leads.
  terminals: [
    { id: "S1", dx: 2, dy: 4 },
    { id: "S2", dx: 6, dy: 4 },
  ],
  properties: [ADAPTER_OUTPUT_FIELD, WALL_FREQUENCY_FIELD],
  normalizeParams(raw) {
    const hz = Number(raw?.hz);
    return {
      hz: AC_HZ.includes(hz) ? hz : AC_DEFAULT_HZ,
      rms: inRange(raw?.rms, ADAPTER_RMS_RANGE, ADAPTER_DEFAULT_RMS),
    };
  },
});

/** A new adapter's params for a country: its mains' frequency. */
export function adapterParamsFor(code) {
  return { hz: mainsForCountry(code).hz, rms: ADAPTER_DEFAULT_RMS };
}

/** What an adapter puts out: its rating's sine at its frequency — as a
    mains brick's own params, `{hz, peak, trough}`. */
export function adapterSineOf(params) {
  const { hz, rms } = ADAPTER_DEF.normalizeParams(params);
  return { hz, peak: acPeakOf(rms), trough: -acPeakOf(rms) };
}

/** What an adapter's badge says: its output ("12 V~") and its frequency
    ("60 Hz"). */
export function adapterBadge(params) {
  const { hz, rms } = ADAPTER_DEF.normalizeParams(params);
  return { volts: acLabel(tidyShort(rms)), hz: `${hz} Hz` };
}

/** The EARTHED AC sources, by kind: the terminal their sine is on, and the
    one that is a ground like a PSU's − — mains' L and N. (An adapter's
    output floats: not here.) */
export const EARTHED_AC = Object.freeze({
  ac: Object.freeze({ line: "L", neutral: "N" }),
});

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
    ratio ("10:1") — or, `exact` (the BOM and the build guide), a Custom…
    one's every figure ("10:1, 8H, 40Ω/0.6Ω, k 0.99"), since two of one ratio
    may be different transformers. */
export function transformerBadge(params, { exact = false } = {}) {
  const p = TRANSFORMER_DEF.normalizeParams(params);
  const preset = transformerPresetOf(p);
  if (preset) return preset.label;
  if (!exact) return `${tidyShort(p.turns)}:1`;
  const v = (key) =>
    formatComponentValue(p[key], TRANSFORMER_FIGURES.find((f) => f.key === key).unit); // prettier-ignore
  return `${v("turns")}:1, ${v("primaryHenries")}, ${v("primaryOhms")}/${v("secondaryOhms")}, k ${v("coupling")}`; // prettier-ignore
}
