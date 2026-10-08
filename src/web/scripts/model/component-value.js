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

// component-value.js — the ONE way a component's value is read from what a
// person typed and printed back: a resistance, a capacitance, an inductance or
// a voltage, picked from a list or typed free-hand into a Properties combo box
// (components/value-combobox.js). Pure and DOM-free, so the rules are tested
// without a window and every value field — and the loader, reading an old
// document — takes the same path.
//
// What it reads (whitespace anywhere is ignored):
//   · a plain number, in the field's base unit — `470`, `0.1`, `1e3`;
//   · a number and an SI prefix — `4.7k`, `100n`, `10u`, `2.2M`, `1meg` —
//     as a LETTER (p n u µ μ m k M G) or a WORD (pico … giga, and SPICE's
//     `meg`). Letters are case-blind but for `m` (milli) and `M` (mega);
//     words are case-blind;
//   · then, optionally, the unit — `Ω`/`ohm`/`ohms`/`R`, `F`/`farad(s)`,
//     `H`/`henry`/`henries`/`henrys`, `V`/`volt(s)`. A unit is never required
//     (the field knows its own), but a WRONG one is an error, not a guess;
//   · the RKM form printed on the parts themselves, a prefix or unit letter
//     standing where the decimal point would — `4k7`, `2R2`, `4n7`, `5V1`,
//     `R47`.
// Anything else — a sign, a second number, a stray letter, zero — is refused.
// Nothing is rounded: a value typed to four figures is kept to four.
//
// Plus the lists the combo boxes offer (E12 resistors, the usual capacitors
// and inductors, the common Zener diodes and transistors) and the light
// part-number rule a transistor's field applies.

/** The four quantities a value field reads, by base unit. */
export const UNITS = Object.freeze({
  ohm: Object.freeze({ symbol: "Ω" }),
  farad: Object.freeze({ symbol: "F" }),
  henry: Object.freeze({ symbol: "H" }),
  volt: Object.freeze({ symbol: "V" }),
});

/**
 * What each field accepts, inclusive. A stored value outside its field's
 * range is KEPT (the loader alters nothing) and shown red when its card opens.
 */
export const VALUE_RANGES = Object.freeze({
  resistor: Object.freeze({ min: 0.1, max: 100e6 }),
  ceramic: Object.freeze({ min: 1e-12, max: 100e-6 }),
  electrolytic: Object.freeze({ min: 100e-9, max: 100e-3 }),
  inductor: Object.freeze({ min: 1e-9, max: 10 }),
  zener: Object.freeze({ min: 1.8, max: 200 }),
});

/** Significant digits a value keeps: enough for any value a part is sold
    in, few enough that 4.7 × 1e-6 reads back as 4.7e-6. */
const KEEP = 12;
const tidy = (value) => Number(value.toPrecision(KEEP));

/** Prefix letters. `m`/`M` are matched exactly; the rest case-blind. */
const PREFIX_LETTERS = Object.freeze({
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6, // U+00B5 MICRO SIGN
  μ: 1e-6, // U+03BC GREEK SMALL LETTER MU — what many keyboards type
  m: 1e-3,
  M: 1e6,
  k: 1e3,
  g: 1e9,
});

/** Prefix words, case-blind, longest first so `mega` is not read as `meg`
    and an `a`. */
const PREFIX_WORDS = Object.freeze([
  ["micro", 1e-6],
  ["milli", 1e-3],
  ["mega", 1e6],
  ["giga", 1e9],
  ["kilo", 1e3],
  ["nano", 1e-9],
  ["pico", 1e-12],
  ["meg", 1e6],
]);

/** Unit spellings, case-blind, longest first. */
const UNIT_WORDS = Object.freeze([
  ["henries", "henry"],
  ["henrys", "henry"],
  ["henry", "henry"],
  ["farads", "farad"],
  ["farad", "farad"],
  ["volts", "volt"],
  ["volt", "volt"],
  ["ohms", "ohm"],
  ["ohm", "ohm"],
  ["Ω", "ohm"], // U+03A9 GREEK CAPITAL OMEGA
  ["Ω", "ohm"], // U+2126 OHM SIGN — what a symbol picker inserts
  ["r", "ohm"],
  ["f", "farad"],
  ["h", "henry"],
  ["v", "volt"],
]);

/** The letters that may stand for the decimal point (RKM), with the scale
    or unit each carries. */
const rkmMark = (letter) => {
  const prefix = prefixLetter(letter);
  if (prefix != null) return { scale: prefix, unit: null };
  const unit = unitOf(letter);
  return unit && letter.length === 1 ? { scale: 1, unit } : null;
};

function prefixLetter(letter) {
  if (letter === "m" || letter === "M") return PREFIX_LETTERS[letter];
  return PREFIX_LETTERS[letter.toLowerCase()] ?? null;
}

function unitOf(text) {
  // Both sides lowered: an omega lowers to ω, so the table's own spelling has
  // to be lowered alongside what was typed.
  const lower = text.toLowerCase();
  return (
    UNIT_WORDS.find(([spelling]) => spelling.toLowerCase() === lower)?.[1] ??
    null
  );
}

/** `rest` (what follows the number) as `{scale, unit}`, or null when it is
    not a prefix and/or a unit and nothing else. */
function readSuffix(rest) {
  if (rest === "") return { scale: 1, unit: null };
  const lower = rest.toLowerCase();
  const prefixes = [
    ...PREFIX_WORDS.filter(([word]) => lower.startsWith(word)),
    ...(prefixLetter(rest[0]) != null
      ? [[rest[0], prefixLetter(rest[0])]]
      : []),
    ["", 1],
  ];
  for (const [prefix, scale] of prefixes) {
    const tail = rest.slice(prefix.length);
    if (tail === "") return { scale, unit: null };
    const unit = unitOf(tail);
    if (unit) return { scale, unit };
  }
  return null;
}

/** An unsigned decimal, optionally with an exponent: `470`, `4.7`, `.47`,
    `1e3`. */
const NUMBER = /^(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
/** The RKM form: digits, a mark, digits, an optional unit. */
const RKM = /^(\d*)([^\d.])(\d+)(.*)$/u;

/** The words a unit's errors and messages are keyed by. */
const QUANTITY_OF = Object.freeze({
  ohm: "resistance",
  farad: "capacitance",
  henry: "inductance",
  volt: "voltage",
});
export { QUANTITY_OF };

/**
 * Read a typed value.
 *
 * @param {string} text - what was typed (or picked).
 * @param {"ohm"|"farad"|"henry"|"volt"} unit - the field's own unit.
 * @param {{min: number, max: number}} [range] - inclusive; checked after the
 *   value reads, so a well-formed value outside it says so.
 * @returns {{value: number, display: string}
 *   | {error: "empty"}
 *   | {error: "notValue", unit: string}
 *   | {error: "wrongUnit", unit: string, got: string}
 *   | {error: "range", unit: string, min: string, max: string}}
 */
export function parseComponentValue(text, unit, range = null) {
  const raw = String(text ?? "");
  const s = raw.replace(/\s+/gu, "");
  if (!s) return { error: "empty" };
  const notValue = { error: "notValue", unit };
  // Spaces go anywhere sensible — but between two digits they part two
  // numbers ("1 2"), and stripped they would make one.
  if (/[\d.]\s+[\d.]/u.test(raw)) return notValue;
  let mantissa = null;
  let suffix = null;
  const number = NUMBER.exec(s);
  if (number) {
    mantissa = Number(number[0]);
    suffix = readSuffix(s.slice(number[0].length));
  }
  if (!suffix) {
    // RKM: the mark stands where the decimal point would.
    const rkm = RKM.exec(s);
    const mark = rkm && rkmMark(rkm[2]);
    const tail =
      rkm && (rkm[4] === "" ? { unit: null } : { unit: unitOf(rkm[4]) });
    if (!mark || !tail || (rkm[4] !== "" && !tail.unit)) return notValue;
    if (mark.unit && tail.unit && mark.unit !== tail.unit) return notValue;
    mantissa = Number(`${rkm[1] || "0"}.${rkm[3]}`);
    suffix = { scale: mark.scale, unit: mark.unit ?? tail.unit };
  }
  if (suffix.unit && suffix.unit !== unit) {
    return { error: "wrongUnit", unit, got: suffix.unit };
  }
  const value = mantissa * suffix.scale;
  if (!Number.isFinite(value) || value <= 0) return notValue;
  const tidied = tidy(value);
  if (range && (tidied < range.min || tidied > range.max)) {
    return {
      error: "range",
      unit,
      min: formatComponentValue(range.min, unit),
      max: formatComponentValue(range.max, unit),
    };
  }
  return { value: tidied, display: formatComponentValue(tidied, unit) };
}

/** Display prefixes, largest first. */
const DISPLAY_STEPS = Object.freeze([
  ["G", 1e9],
  ["M", 1e6],
  ["k", 1e3],
  ["", 1],
  ["m", 1e-3],
  ["µ", 1e-6],
  ["n", 1e-9],
  ["p", 1e-12],
]);

/** A resistance under an ohm is written as one — `0.47Ω`, never `470mΩ`,
    which reads as a typo for megohms. */
const OHM_STEPS = DISPLAY_STEPS.slice(0, 4);

/**
 * A value as the combo boxes and the BOM print it: the largest prefix that
 * keeps the number at 1 or more (a resistance takes none below k, so 0.47 Ω
 * is `0.47Ω`), the number as precise as it was stored
 * (trailing zeros dropped — `4.7k`, `4.753k`, `100`), no spaces, and the
 * unit's symbol — `100kΩ`, `4.7µF`, `10mH`, `5.1V`. Always `µ`, however it
 * was typed.
 * @param {number} value
 * @param {"ohm"|"farad"|"henry"|"volt"} unit
 * @returns {string} "" for anything but a positive finite number
 */
export function formatComponentValue(value, unit) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }
  const steps = unit === "ohm" ? OHM_STEPS : DISPLAY_STEPS;
  let step = steps.findIndex(([, scale]) => value >= scale * (1 - 1e-12));
  if (step < 0) step = steps.length - 1;
  let mantissa = tidy(value / steps[step][1]);
  // Tidying can carry a mantissa to 1000 (999.9999999999999 → 1000), which is
  // the next prefix's 1.
  if (mantissa >= 1000 && step > 0) {
    step -= 1;
    mantissa = tidy(value / steps[step][1]);
  }
  return `${mantissa}${steps[step][0]}${UNITS[unit]?.symbol ?? ""}`;
}

/**
 * The same value in plain ASCII, as an exported file states it (a KiCad
 * Value field, which SPICE and BOM scripts read): `u` for micro, and a
 * resistance with no unit symbol at all, the schematic convention — `4.7k`,
 * `470`, `4.7uF`, `10uH`, `5.1V`. Every figure is kept, as on screen.
 * @param {number} value
 * @param {"ohm"|"farad"|"henry"|"volt"} unit
 * @returns {string} "" for anything but a positive finite number
 */
export function formatComponentValueAscii(value, unit) {
  return formatComponentValue(value, unit)
    .replace("µ", "u")
    .replace(UNITS.ohm.symbol, "");
}

// ── The lists ───────────────────────────────────────────────────────────────

/** The E12 series' twelve figures. */
const E12 = Object.freeze([10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82]);

/** Every E12 resistance from 10 Ω to 820 kΩ, then 1 MΩ — built from the
    twelve figures, a decade at a time. */
export const RESISTOR_VALUES = Object.freeze([
  ...[1, 10, 100, 1e3, 1e4].flatMap((decade) =>
    E12.map((figure) => tidy(figure * decade)),
  ),
  1e6,
]);

/** The common ceramics. */
export const CERAMIC_VALUES = Object.freeze(
  [10e-12, 22e-12, 100e-12, 1e-9, 10e-9, 100e-9, 1e-6].map(tidy),
);

/** The common electrolytics. */
export const ELECTROLYTIC_VALUES = Object.freeze(
  [1e-6, 10e-6, 22e-6, 47e-6, 100e-6, 220e-6, 470e-6, 1000e-6].map(tidy),
);

/** The common inductors. */
export const INDUCTOR_VALUES = Object.freeze(
  [1e-6, 10e-6, 22e-6, 47e-6, 100e-6, 220e-6, 1e-3, 10e-3, 100e-3].map(tidy),
);

/**
 * The common Zener diodes, voltage paired with a part — the 1 W 1N47xxA
 * series, which starts at 3.3 V, and the 500 mW BZX55 below it.
 */
export const ZENER_DIODES = Object.freeze(
  [
    [2.4, "BZX55C2V4"],
    [2.7, "BZX55C2V7"],
    [3.3, "1N4728A"],
    [4.7, "1N4732A"],
    [5.1, "1N4733A"],
    [5.6, "1N4734A"],
    [6.2, "1N4735A"],
    [7.5, "1N4737A"],
    [8.2, "1N4738A"],
    [9.1, "1N4739A"],
    [12, "1N4742A"],
    [15, "1N4744A"],
    [18, "1N4746A"],
    [24, "1N4749A"],
    [30, "1N4751A"],
  ].map(([volts, partNumber]) => Object.freeze({ volts, partNumber })),
);

/** The table's Zener for a voltage, or null. */
export function zenerByVolts(volts) {
  return (
    ZENER_DIODES.find((z) => Math.abs(z.volts - volts) < 1e-9 * volts) ?? null
  );
}

/** The table's Zener a typed part number names — case-blind, its trailing
    `A` optional (`1n4733` is the 1N4733A) — or null. */
export function zenerByPart(text) {
  const t = String(text ?? "")
    .replace(/\s+/gu, "")
    .toUpperCase();
  if (!t) return null;
  return (
    ZENER_DIODES.find((z) => z.partNumber === t || z.partNumber === `${t}A`) ??
    null
  );
}

/**
 * Read what was typed into a Zener's voltage field: a part from the table
 * (by its number), or a voltage — paired with the table's part when it has
 * one at that voltage. A picked entry's own text (`5.1V (1N4733A)`) reads
 * back as itself.
 * @param {string} text
 * @returns {{value: number, display: string, partNumber: string|null}
 *   | {error: string, unit?: string}}
 */
export function parseZener(text) {
  const raw = String(text ?? "").trim();
  const labelled = /^(.*?)\s*\(([^()]*)\)$/u.exec(raw);
  const byPart = zenerByPart(labelled ? labelled[2] : raw);
  if (byPart) {
    return {
      value: byPart.volts,
      display: formatComponentValue(byPart.volts, "volt"),
      partNumber: byPart.partNumber,
    };
  }
  const read = parseComponentValue(
    labelled ? labelled[1] : raw,
    "volt",
    VALUE_RANGES.zener,
  );
  if (read.error) return read;
  return { ...read, partNumber: zenerByVolts(read.value)?.partNumber ?? null };
}

/** What a Zener's entry is called in its list: `5.1V (1N4733A)`. */
export const zenerLabel = (z) =>
  `${formatComponentValue(z.volts, "volt")} (${z.partNumber})`;

/** The common transistors, by type — every Spice Lite grade's representative
    among them (catalog/discretes.js `TRANSISTOR_GRADES`). */
export const TRANSISTOR_PARTS = Object.freeze({
  npn: Object.freeze(["2N2222A", "2N3904", "BC547", "TIP120", "TIP31C"]),
  pnp: Object.freeze(["2N2907A", "2N3906", "BC557", "TIP125", "TIP32C"]),
  nmos: Object.freeze(["2N7000", "BS170", "IRF540N", "IRLZ44N"]),
  pmos: Object.freeze(["BS250", "IRF9540N"]),
});

/** What each listed transistor IS, picked from its list: its Spice Lite
    grade and its package — a listed part brings both, as a listed Zener
    brings its voltage. A typed part number brings neither. */
export const TRANSISTOR_PART_FACTS = Object.freeze({
  "2N2222A": Object.freeze({ grade: "general", case: "TO-92" }),
  "2N3904": Object.freeze({ grade: "small-signal", case: "TO-92" }),
  BC547: Object.freeze({ grade: "small-signal", case: "TO-92" }),
  TIP120: Object.freeze({ grade: "darlington", case: "TO-220" }),
  TIP31C: Object.freeze({ grade: "power", case: "TO-220" }),
  "2N2907A": Object.freeze({ grade: "general", case: "TO-92" }),
  "2N3906": Object.freeze({ grade: "small-signal", case: "TO-92" }),
  BC557: Object.freeze({ grade: "small-signal", case: "TO-92" }),
  TIP125: Object.freeze({ grade: "darlington", case: "TO-220" }),
  TIP32C: Object.freeze({ grade: "power", case: "TO-220" }),
  "2N7000": Object.freeze({ grade: "logic", case: "TO-92" }),
  BS170: Object.freeze({ grade: "logic", case: "TO-92" }),
  IRF540N: Object.freeze({ grade: "power", case: "TO-220" }),
  IRLZ44N: Object.freeze({ grade: "logic-power", case: "TO-220" }),
  BS250: Object.freeze({ grade: "logic", case: "TO-92" }),
  IRF9540N: Object.freeze({ grade: "power", case: "TO-220" }),
});

/** The type whose list holds `partNumber`, or null for one on no list. */
export function transistorTypeOf(partNumber) {
  const t = String(partNumber ?? "").toUpperCase();
  return (
    Object.keys(TRANSISTOR_PARTS).find((type) =>
      TRANSISTOR_PARTS[type].includes(t),
    ) ?? null
  );
}

/** The longest part number a transistor's field takes. */
export const MAX_TRANSISTOR_PART = 20;

/**
 * Read a transistor's typed part number — lightly, since no list holds every
 * part: trimmed and uppercased, letters, digits and `-` only, at most 20.
 * Empty clears it. One of ANOTHER type's list is kept, with a warning saying
 * what it is.
 * @param {string} text
 * @param {string} type - the transistor's own type (npn, pnp, nmos, pmos).
 * @returns {{value: string|null, warning?: {code: "foreignPart", part:
 *   string, type: string}} | {error: "notPart"}}
 */
export function parseTransistorPart(text, type) {
  const t = String(text ?? "")
    .trim()
    .toUpperCase();
  if (!t) return { value: null };
  if (!/^[A-Z0-9-]+$/.test(t) || t.length > MAX_TRANSISTOR_PART) {
    return { error: "notPart" };
  }
  const owner = transistorTypeOf(t);
  return owner && owner !== type
    ? { value: t, warning: { code: "foreignPart", part: t, type: owner } }
    : { value: t };
}
