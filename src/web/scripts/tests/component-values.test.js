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

// Tests for the component values: the ONE parser every value field shares —
// what a person types, picked or free-hand, read into base units and printed
// back in its canonical form (model/component-value.js) — the lists the
// combo boxes offer, the fields built over them (catalog/value-fields.js),
// the values printed on the desk (ohm-/farad-format.js), and a resistance as
// its colour code (model/resistor-bands.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  CERAMIC_VALUES,
  ELECTROLYTIC_VALUES,
  INDUCTOR_VALUES,
  RESISTOR_VALUES,
  TRANSISTOR_PARTS,
  VALUE_RANGES,
  ZENER_DIODES,
  e12Series,
  formatComponentValue,
  formatComponentValueAscii,
  nearestStandard,
  parseComponentValue,
  parseTransistorPart,
  parseZener,
} from "../model/component-value.js";
import { formatOhms } from "../model/ohm-format.js";
import { formatFarads } from "../model/farad-format.js";
import {
  BAND_COLORS,
  DIGIT_COLORS,
  resistorBands,
} from "../model/resistor-bands.js";
import { partDef } from "../catalog/index.js";

const R = VALUE_RANGES;
const read = (text, unit, range) => parseComponentValue(text, unit, range);
/** What a field shows for `text`, or the error code. */
const shown = (text, unit, range) => {
  const r = read(text, unit, range);
  return r.error ?? r.display;
};

// ── The parser: the cases the spec names ────────────────────────────────────

test("the spec's table: every listed input reads as it says", () => {
  const cases = [
    ["100 kilo ohms", "ohm", R.resistor, "100kΩ"],
    ["100k", "ohm", R.resistor, "100kΩ"],
    ["4k7", "ohm", R.resistor, "4.7kΩ"],
    ["2R2", "ohm", R.resistor, "2.2Ω"],
    ["4700", "ohm", R.resistor, "4.7kΩ"],
    ["1meg", "ohm", R.resistor, "1MΩ"],
    ["1M", "ohm", R.resistor, "1MΩ"],
    ["1m", "ohm", R.resistor, "range"], // a milliohm — strict, never mega
    ["10uF", "ohm", R.resistor, "wrongUnit"],
    ["100n", "farad", R.ceramic, "100nF"],
    ["0.1uF", "farad", R.ceramic, "100nF"],
    ["10 microfarads", "farad", R.electrolytic, "10µF"],
    ["4n7", "farad", R.ceramic, "4.7nF"],
    ["1 millihenry", "henry", R.inductor, "1mH"],
    ["-5k", "ohm", R.resistor, "notValue"],
    ["abc", "ohm", R.resistor, "notValue"],
    ["4.7kk", "ohm", R.resistor, "notValue"],
  ];
  for (const [text, unit, range, want] of cases) {
    assert.equal(shown(text, unit, range), want, `${text} (${unit})`);
  }
  // …and the Zener's, which pair a voltage with a part.
  assert.deepEqual(
    [parseZener("5V1").display, parseZener("5V1").partNumber],
    ["5.1V", "1N4733A"],
  );
  assert.deepEqual(
    [parseZener("1n4742").display, parseZener("1n4742").partNumber],
    ["12V", "1N4742A"],
  );
  assert.deepEqual(
    [parseZener("11").display, parseZener("11").partNumber],
    ["11V", null],
  );
});

test("values are stored in base units, and read back as themselves", () => {
  assert.equal(read("4k7", "ohm").value, 4700);
  assert.equal(read("100n", "farad").value, 1e-7);
  assert.equal(read("4.7u", "farad").value, 4.7e-6);
  assert.equal(read("10µH", "henry").value, 1e-5);
  assert.equal(read("5V1", "volt").value, 5.1);
  for (const unit of ["ohm", "farad", "henry", "volt"]) {
    for (const value of [1, 4.7, 22, 470, 4.7e3, 1e-7, 4.7e-6, 0.47]) {
      const text = formatComponentValue(value, unit);
      assert.equal(read(text, unit).value, value, text);
    }
  }
});

// ── The parser: every form ──────────────────────────────────────────────────

test("a plain number is the field's own unit, exponent and all", () => {
  assert.equal(shown("470", "ohm"), "470Ω");
  assert.equal(shown("0.1", "ohm"), "0.1Ω");
  assert.equal(shown("1e3", "ohm"), "1kΩ");
  assert.equal(shown(".5k", "ohm"), "500Ω");
  // A plain number on a capacitance is FARADS — so 100 is out of range.
  assert.equal(shown("100", "farad", R.ceramic), "range");
});

test("prefix letters: case-blind but for m (milli) and M (mega)", () => {
  const forms = {
    "10p": 10e-12,
    "10P": 10e-12,
    "10n": 10e-9,
    "10N": 10e-9,
    "10u": 10e-6,
    "10U": 10e-6,
    "10µ": 10e-6, // U+00B5 MICRO SIGN
    "10μ": 10e-6, // U+03BC GREEK SMALL LETTER MU
    "10m": 10e-3,
    "10M": 10e6,
    "10k": 10e3,
    "10K": 10e3,
    "10G": 10e9,
    "10g": 10e9,
  };
  for (const [text, value] of Object.entries(forms)) {
    assert.equal(read(text, "ohm").value, value, text);
  }
});

test("prefix and unit words, spelled out and case-blind", () => {
  assert.equal(shown("100 kiloohm", "ohm"), "100kΩ");
  assert.equal(shown("100 KILO OHMS", "ohm"), "100kΩ");
  assert.equal(shown("2.2 mega", "ohm"), "2.2MΩ");
  assert.equal(shown("1 Megohm", "ohm"), "1MΩ");
  assert.equal(shown("1MEG", "ohm"), "1MΩ", "SPICE's meg, any case");
  assert.equal(shown("4.7 nanofarads", "farad"), "4.7nF");
  assert.equal(shown("22 picofarad", "farad"), "22pF");
  assert.equal(shown("10 microhenries", "henry"), "10µH");
  assert.equal(shown("3 henrys", "henry"), "3H");
  assert.equal(shown("1 giga", "ohm"), "1GΩ");
  assert.equal(shown("12 volts", "volt"), "12V");
});

test("units: Ω and Ω, ohm, R, F, H, V — optional, never required", () => {
  assert.equal(shown("470Ω", "ohm"), "470Ω"); // U+03A9 GREEK CAPITAL OMEGA
  assert.equal(shown("470\u2126", "ohm"), "470Ω"); // U+2126 OHM SIGN
  assert.equal(shown("4.7 kΩ", "ohm"), "4.7kΩ");
  assert.equal(shown("470R", "ohm"), "470Ω");
  assert.equal(shown("100 nF", "farad"), "100nF");
  assert.equal(shown("10pf", "farad"), "10pF");
  assert.equal(shown("1F", "farad"), "1F");
  assert.equal(shown("10uH", "henry"), "10µH");
  assert.equal(shown("5.1v", "volt"), "5.1V");
});

test("RKM: the prefix or unit letter stands where the decimal point would", () => {
  assert.equal(shown("4k7", "ohm"), "4.7kΩ");
  assert.equal(shown("2M2", "ohm"), "2.2MΩ");
  assert.equal(shown("4R7", "ohm"), "4.7Ω");
  assert.equal(shown("R47", "ohm"), "0.47Ω", "with no leading digit");
  assert.equal(shown("k47", "ohm"), "470Ω");
  assert.equal(shown("4u7", "farad"), "4.7µF");
  assert.equal(shown("n47", "farad"), "470pF");
  assert.equal(shown("4n7F", "farad"), "4.7nF", "with the unit after");
  assert.equal(shown("5V1", "volt"), "5.1V");
  assert.equal(shown("3V3", "volt"), "3.3V");
});

test("spaces anywhere sensible", () => {
  assert.equal(shown(" 4.7 k ", "ohm"), "4.7kΩ");
  assert.equal(shown("100 k ohm", "ohm"), "100kΩ");
  assert.equal(shown("100 n F", "farad"), "100nF");
});

test("a wrong unit is an error naming both quantities, never a guess", () => {
  assert.deepEqual(read("10uF", "ohm"), {
    error: "wrongUnit",
    unit: "ohm",
    got: "farad",
  });
  assert.equal(read("2R2", "farad").got, "ohm");
  assert.equal(read("10mH", "farad").got, "henry");
  assert.equal(read("5V", "ohm").got, "volt");
  assert.equal(read("1 ohm", "henry").got, "ohm");
});

test("anything else is refused: signs, zero, two numbers, stray letters", () => {
  for (const text of [
    "-5k",
    "+5",
    "0",
    "0k",
    "abc",
    "4.7kk",
    "4k7k",
    "4u7u",
    "1.2.3",
    "1 2",
    "Infinity",
    "NaN",
    "1e",
    "k",
    "Ω",
    "10 kilo kilo",
  ]) {
    assert.equal(read(text, "ohm").error, "notValue", JSON.stringify(text));
  }
  assert.deepEqual(read("", "ohm"), { error: "empty" });
  assert.deepEqual(read("   ", "ohm"), { error: "empty" });
});

test("a value out of range says the range, in canonical form", () => {
  assert.deepEqual(read("1m", "ohm", R.resistor), {
    error: "range",
    unit: "ohm",
    min: "0.1Ω",
    max: "100MΩ",
  });
  assert.equal(read("200M", "ohm", R.resistor).error, "range");
  assert.equal(read("100M", "ohm", R.resistor).display, "100MΩ", "inclusive");
  assert.equal(read("220u", "farad", R.ceramic).max, "100µF");
  assert.equal(read("47n", "farad", R.electrolytic).min, "100nF");
  assert.equal(read("100m", "farad", R.electrolytic).display, "100mF");
  assert.equal(read("0.5n", "henry", R.inductor).error, "range");
  assert.equal(read("1.5", "volt", R.zener).min, "1.8V");
});

// ── Canonical display ───────────────────────────────────────────────────────

test("canonical display: the largest prefix keeping 1 or more, no spaces, µ", () => {
  assert.equal(formatComponentValue(4700, "ohm"), "4.7kΩ");
  assert.equal(formatComponentValue(0.0000001, "farad"), "100nF");
  assert.equal(formatComponentValue(4.7e-6, "farad"), "4.7µF");
  assert.equal(formatComponentValue(0.01, "henry"), "10mH");
  assert.equal(formatComponentValue(5.1, "volt"), "5.1V");
  assert.equal(formatComponentValue(1e6, "ohm"), "1MΩ");
  assert.equal(formatComponentValue(100, "ohm"), "100Ω");
  // A resistance under an ohm stays in ohms.
  assert.equal(formatComponentValue(0.47, "ohm"), "0.47Ω");
  // Trailing zeros go; more than three figures are KEPT, never rounded.
  assert.equal(shown("4.70k", "ohm"), "4.7kΩ");
  assert.equal(shown("100.0", "ohm"), "100Ω");
  assert.equal(shown("4.753k", "ohm"), "4.753kΩ");
  assert.equal(shown("4753", "ohm"), "4.753kΩ");
  // Typed with a micro sign or a u, it shows µ.
  assert.equal(shown("4.7uF", "farad"), "4.7µF");
  assert.equal(formatComponentValue(0, "ohm"), "");
  assert.equal(formatComponentValue(Number.NaN, "ohm"), "");
});

// ── The lists ───────────────────────────────────────────────────────────────

test("the resistors are the E12 series from 10Ω to 1MΩ", () => {
  const figures = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
  assert.equal(RESISTOR_VALUES.length, 5 * 12 + 1);
  assert.deepEqual(RESISTOR_VALUES.slice(0, 12), figures);
  assert.equal(formatComponentValue(RESISTOR_VALUES[12], "ohm"), "100Ω");
  assert.equal(formatComponentValue(RESISTOR_VALUES[24], "ohm"), "1kΩ");
  assert.equal(formatComponentValue(RESISTOR_VALUES[37], "ohm"), "12kΩ");
  assert.equal(formatComponentValue(RESISTOR_VALUES.at(-2), "ohm"), "820kΩ");
  assert.equal(formatComponentValue(RESISTOR_VALUES.at(-1), "ohm"), "1MΩ");
});

test("the capacitors, inductors, Zeners and transistors on offer", () => {
  const list = (values, unit) =>
    values.map((v) => formatComponentValue(v, unit)).join(" ");
  assert.equal(
    list(CERAMIC_VALUES, "farad"),
    "10pF 22pF 100pF 1nF 10nF 100nF 1µF",
  );
  assert.equal(
    list(ELECTROLYTIC_VALUES, "farad"),
    "1µF 10µF 22µF 47µF 100µF 220µF 470µF 1mF",
  );
  assert.equal(
    list(INDUCTOR_VALUES, "henry"),
    "1µH 1.5µH 2.2µH 3.3µH 4.7µH 6.8µH 10µH 15µH 22µH 33µH 47µH 68µH 100µH 150µH 220µH 330µH 470µH 680µH 1mH 1.5mH 2.2mH 3.3mH 4.7mH 6.8mH 10mH 22mH 33mH 47mH 100mH", // prettier-ignore
  );
  assert.equal(ZENER_DIODES.length, 21);
  assert.deepEqual(
    [ZENER_DIODES[0].volts, ZENER_DIODES[0].partNumber],
    [2.4, "BZX55C2V4"],
  );
  assert.deepEqual(
    [ZENER_DIODES.at(-1).volts, ZENER_DIODES.at(-1).partNumber],
    [30, "1N4751A"],
  );
  assert.deepEqual(TRANSISTOR_PARTS.npn, ["2N2222A", "2N3904", "BC547", "TIP120", "TIP31C"]); // prettier-ignore
  assert.deepEqual(TRANSISTOR_PARTS.pnp, ["2N2907A", "2N3906", "BC557", "TIP125", "TIP32C"]); // prettier-ignore
  assert.deepEqual(TRANSISTOR_PARTS.nmos, ["2N7000", "BS170", "IRF540N", "IRLZ44N"]); // prettier-ignore
  assert.deepEqual(TRANSISTOR_PARTS.pmos, ["BS250", "IRF9540N"]);
});

// ── Zener and transistor part numbers ───────────────────────────────────────

test("a Zener reads by voltage or by part, and pairs the two when it can", () => {
  for (const text of [
    "5.1",
    "5.1V",
    "5V1",
    "5.1 volts",
    "1N4733A",
    "1n4733",
    " 1N4733 ",
  ]) {
    const z = parseZener(text);
    assert.deepEqual([z.value, z.partNumber], [5.1, "1N4733A"], text);
  }
  // An entry's own text reads back as itself.
  assert.equal(parseZener("5.1V (1N4733A)").partNumber, "1N4733A");
  // Any other valid voltage stands alone.
  assert.deepEqual(
    [parseZener("13").value, parseZener("13").partNumber],
    [13, null],
  );
  assert.equal(parseZener("1.5").error, "range");
  assert.equal(parseZener("BZX99").error, "notValue");
});

test("a transistor's part number is read lightly, and another type's warned", () => {
  assert.deepEqual(parseTransistorPart(" 2n2222a ", "npn"), {
    value: "2N2222A",
  });
  assert.deepEqual(parseTransistorPart("MPSA42", "npn"), { value: "MPSA42" });
  assert.deepEqual(parseTransistorPart("TIP-120", "npn"), { value: "TIP-120" });
  assert.deepEqual(parseTransistorPart("", "npn"), { value: null }, "clears");
  assert.deepEqual(parseTransistorPart("2N3906", "npn"), {
    value: "2N3906",
    warning: { code: "foreignPart", part: "2N3906", type: "pnp" },
  });
  for (const bad of ["2N 2222", "2N2222/A", "A".repeat(21), "µA741"]) {
    assert.deepEqual(
      parseTransistorPart(bad, "npn"),
      { error: "notPart" },
      bad,
    );
  }
});

// ── Printed on the desk ─────────────────────────────────────────────────────

test("a label on the desk prints at three figures, the next prefix at 1000", () => {
  assert.equal(formatOhms(4700), "4.7k");
  assert.equal(formatOhms(999999), "1M");
  assert.equal(formatFarads(100e-12), "100p");
  assert.equal(formatFarads(4700e-6), "4.7m");
  assert.equal(formatFarads(999.9e-9), "1µ", "rounding promotes");
  assert.equal(formatFarads(0), "");
});

// ── Colour bands ────────────────────────────────────────────────────────────

test("two-figure values get the four-band code: digit, digit, multiplier, gold", () => {
  const four = {
    0.1: ["brown", "black", "silver", "gold"],
    0.47: ["yellow", "violet", "silver", "gold"],
    1: ["brown", "black", "gold", "gold"],
    4.7: ["yellow", "violet", "gold", "gold"],
    10: ["brown", "black", "black", "gold"],
    220: ["red", "red", "brown", "gold"],
    470: ["yellow", "violet", "brown", "gold"],
    1000: ["brown", "black", "red", "gold"],
    4700: ["yellow", "violet", "red", "gold"],
    10000: ["brown", "black", "orange", "gold"],
    47000: ["yellow", "violet", "orange", "gold"],
    330000: ["orange", "orange", "yellow", "gold"],
    1e6: ["brown", "black", "green", "gold"],
    2.2e6: ["red", "red", "green", "gold"],
    56e6: ["green", "blue", "blue", "gold"],
    1e9: ["brown", "black", "grey", "gold"],
  };
  for (const [ohms, bands] of Object.entries(four)) {
    assert.deepEqual(resistorBands(Number(ohms)), bands, ohms);
  }
});

test("three-figure values get the five-band precision code, ending brown", () => {
  assert.deepEqual(resistorBands(4750), [
    "yellow",
    "violet",
    "green",
    "brown",
    "brown",
  ]);
  assert.deepEqual(resistorBands(1020000), [
    "brown",
    "black",
    "red",
    "yellow",
    "brown",
  ]);
  // A fourth figure is rounded away, exactly as the label rounds it.
  assert.deepEqual(resistorBands(4753), resistorBands(4750));
  assert.equal(formatOhms(4753), "4.75k");
});

test("a value no code can state draws no bands at all", () => {
  for (const ohms of [0, -1, NaN, 0.05, 1e12]) {
    assert.deepEqual(resistorBands(ohms), [], String(ohms));
  }
});

test("every band colour is one of the twelve the stylesheet holds", () => {
  assert.equal(new Set(BAND_COLORS).size, 12);
  assert.equal(DIGIT_COLORS.length, 10);
  for (const ohms of [0.1, 1, 47, 4700, 4750, 1e6, 9.99e8]) {
    for (const c of resistorBands(ohms)) assert.ok(BAND_COLORS.includes(c), c);
  }
});

// ── The catalog's fields ─────────────────────────────────────────────────────

test("every value field is a combo over the one parser and its own list", () => {
  const field = (ref, key) =>
    partDef(ref).properties.find((f) => f.key === key);
  const resistance = field("resistor", "ohms");
  assert.equal(resistance.type, "combo");
  assert.deepEqual(resistance.read("4k7"), {
    text: "4.7kΩ",
    patch: { ohms: 4700 },
  });
  assert.equal(resistance.options().length, RESISTOR_VALUES.length);
  for (const ref of ["rnet9", "pot"]) {
    assert.equal(field(ref, "ohms").type, "combo", ref);
  }
  // Each capacitor its own range and list.
  const ceramic = field("cap-ceramic", "farads");
  const electrolytic = field("cap-electrolytic", "farads");
  assert.deepEqual(
    ceramic.options().map((o) => o.text),
    ["10pF", "22pF", "100pF", "1nF", "10nF", "100nF", "1µF"],
  );
  assert.equal(electrolytic.options().at(-1).text, "1mF");
  assert.equal(ceramic.read("220u").error.error, "range");
  assert.deepEqual(electrolytic.read("220u").patch, { farads: 220e-6 });
  // A stored value out of range shows as itself, red.
  assert.deepEqual(electrolytic.show({ farads: 1e-9 }), {
    text: "1nF",
    error: { error: "range", unit: "farad", min: "100nF", max: "100mF" },
  });
  assert.deepEqual(ceramic.show({ farads: 1e-9 }), { text: "1nF" });
  // Text an older document kept, unread, shows as it is, red.
  assert.equal(ceramic.show({ farads: "lots" }).text, "lots");
  assert.equal(ceramic.show({ farads: "lots" }).error.error, "notValue");
  // An optional value may be cleared.
  const inductance = field("inductor", "henries");
  assert.deepEqual(inductance.read("  "), {
    text: "",
    patch: { henries: null },
  });
  assert.deepEqual(inductance.show({}), { text: "" });
  assert.equal(
    ceramic.read("").error.error,
    "empty",
    "a capacitance is not optional",
  );
});

test("a Zener's voltage field sets the part with it", () => {
  const field = partDef("zener").properties.find((f) => f.key === "zenerVolts");
  assert.equal(field.type, "combo");
  const entries = field.options();
  assert.equal(entries.length, 21);
  assert.deepEqual(
    entries.find((e) => e.text === "5.1V"),
    {
      label: "5.1V (1N4733A)",
      text: "5.1V",
      search: "1N4733A",
      patch: { zenerVolts: 5.1, partNumber: "1N4733A" },
    },
  );
  assert.deepEqual(field.read("1n4742", {}).patch, {
    zenerVolts: 12,
    partNumber: "1N4742A",
  });
  // A voltage off the table drops a table part, now wrong…
  assert.deepEqual(field.read("11", { partNumber: "1N4733A" }).patch, {
    zenerVolts: 11,
    partNumber: null,
  });
  // …but keeps a part number the user typed.
  assert.deepEqual(field.read("11", { partNumber: "BZX79-C11" }).patch, {
    zenerVolts: 11,
    partNumber: "BZX79-C11",
  });
});

test("a transistor's part number field lists its own type's parts", () => {
  const field = (ref) =>
    partDef(ref).properties.find((f) => f.key === "partNumber");
  assert.deepEqual(
    field("npn")
      .options()
      .map((o) => o.text),
    TRANSISTOR_PARTS.npn,
  );
  assert.deepEqual(
    field("pmos")
      .options()
      .map((o) => o.text),
    TRANSISTOR_PARTS.pmos,
  );
  assert.deepEqual(field("npn").read("2n3906").warning, {
    code: "foreignPart",
    part: "2N3906",
    type: "pnp",
  });
  assert.deepEqual(field("npn").read("2n3906").patch, { partNumber: "2N3906" });
  assert.equal(field("npn").show({ partNumber: "2N3906" }).warning.type, "pnp");
});

test("a capacitor's value is kept as stored, read from text, defaulted when absent", () => {
  const ceramic = partDef("cap-ceramic");
  const electrolytic = partDef("cap-electrolytic");
  assert.equal(ceramic.normalizeParams({}).farads, 100e-9);
  assert.equal(electrolytic.normalizeParams({}).farads, 10e-6);
  assert.equal(ceramic.normalizeParams({ farads: 2.2e-9 }).farads, 2.2e-9);
  assert.equal(ceramic.normalizeParams({ farads: -1 }).farads, 100e-9);
  // Out of the ceramic's range, but KEPT: its card says so.
  assert.equal(ceramic.normalizeParams({ farads: 5 }).farads, 5);
  // Text an older document holds: read, or kept verbatim.
  assert.equal(ceramic.normalizeParams({ farads: "4n7" }).farads, 4.7e-9);
  assert.equal(ceramic.normalizeParams({ farads: "junk" }).farads, "junk");
  // The same two-free-ends geometry as the resistor and the LED.
  assert.deepEqual(
    ceramic.normalizeParams({ farads: 1e-9, rot: 90, end: { dx: 0, dy: -3 } }),
    { farads: 1e-9, rot: 90, end: { dx: 0, dy: -3 } },
  );
});

test("the BOM writes a value as its card does; one that would not read, as none", async () => {
  const { DeskDoc } = await import("../model/desk-doc.js");
  const { buildNetlist } = await import("../sim/netlist.js");
  const { buildPlan } = await import("../model/build-plan.js");
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const json = doc.toJSON();
  const put = (id, ref, anchor, params) =>
    json.components.push({ id, kind: "discrete", ref, board: "bb1", anchor, params }); // prettier-ignore
  put("c1", "cap-ceramic", "a5", { farads: "junk" });
  put("c2", "resistor", "a10", { ohms: "lots" });
  put("c3", "pot", "a20", { ohms: "lots", position: 0 });
  put("c4", "resistor", "a30", { ohms: 4753 });
  put("c5", "resistor", "a40", { ohms: 4750 });
  const loaded = new DeskDoc(json).toJSON();
  const { bom } = buildPlan(loaded, buildNetlist(loaded));
  const titles = Object.values(bom)
    .flat()
    .map((l) => l.title);
  // Listed by what it is, with no value — never a bare unit.
  assert.ok(titles.includes("Capacitor (ceramic)"), titles.join(" | "));
  assert.ok(titles.includes("Resistor"), titles.join(" | "));
  assert.ok(!titles.some((t) => /— F$|— Ω$/.test(t)), titles.join(" | "));
  // A value that reads is written as its card writes it — every figure.
  assert.ok(titles.includes("Resistor — 4.753kΩ"), titles.join(" | "));
  assert.ok(titles.includes("Resistor — 4.75kΩ"), titles.join(" | "));
  // A potentiometer whose track would not read still has a wiper: at 0 % its
  // pin-1 side is a wire, the other side a resistor of no known value.
  const pot = partDef("pot");
  const params = loaded.components.find((c) => c.id === "c3").params;
  assert.deepEqual(pot.internalBridges(params), [[2, 1]]);
  assert.deepEqual(
    pot.weakBridges(params).map(([a, b]) => [a, b]),
    [[2, 3]],
  );
  assert.deepEqual(
    pot.weakBridges({ ...params, position: 50 }).map(([a, b]) => [a, b]),
    [
      [2, 1],
      [2, 3],
    ],
  );
});

test("an exported value is the same figures in plain ASCII", () => {
  const ascii = formatComponentValueAscii;
  assert.equal(ascii(4700, "ohm"), "4.7k");
  assert.equal(ascii(470, "ohm"), "470");
  assert.equal(ascii(0.47, "ohm"), "0.47");
  assert.equal(ascii(4753, "ohm"), "4.753k", "nothing rounded");
  assert.equal(ascii(4.7e-6, "farad"), "4.7uF");
  assert.equal(ascii(100e-9, "farad"), "100nF");
  assert.equal(ascii(10e-6, "henry"), "10uH");
  assert.equal(ascii(5.1, "volt"), "5.1V");
  assert.equal(ascii(NaN, "farad"), "");
  for (const v of [...RESISTOR_VALUES, 2.2e6, 0.1]) {
    assert.match(ascii(v, "ohm"), /^[\x20-\x7e]+$/);
  }
});

// ── Currents, gains and the nearest standard value ──────────────────────────

test("a current and a gain read through the same parser", () => {
  const amps = (t) => parseComponentValue(t, "amp");
  assert.deepEqual(amps("200mA"), { value: 0.2, display: "200mA" });
  assert.deepEqual(amps("1A5"), { value: 1.5, display: "1.5A" }, "RKM");
  assert.deepEqual(amps("3 amps"), { value: 3, display: "3A" });
  assert.equal(amps("5V").error, "wrongUnit");
  assert.equal(parseComponentValue("5A", "ohm").got, "amp", "a current, not a resistance"); // prettier-ignore
  const gain = (t) => parseComponentValue(t, "ratio");
  assert.deepEqual(gain("1k"), { value: 1000, display: "1000" }, "plain, no prefix shown"); // prettier-ignore
  assert.deepEqual(gain("163"), { value: 163, display: "163" });
  assert.equal(gain("5V").error, "wrongUnit");
  assert.equal(formatComponentValue(64.8, "ratio"), "64.8");
});

test("the E12 values inside a range", () => {
  const r = e12Series(VALUE_RANGES.resistor);
  assert.equal(r[0], 0.1);
  assert.equal(r.at(-1), 100e6);
  assert.ok(r.includes(2700) && r.includes(3300) && r.includes(2.2e6));
  assert.equal(
    r.length,
    8 * 12 + 12 + 1,
    "0.1Ω to 100MΩ: nine decades and the top",
  );
  assert.ok(
    RESISTOR_VALUES.every((v) => r.includes(v)),
    "the list is in it",
  );
  const c = e12Series(VALUE_RANGES.ceramic);
  assert.equal(c[0], 1e-12);
  assert.ok(c.includes(4.7e-9) && c.includes(100e-6));
});

test("nearestStandard: both neighbours, the end past the series, or nothing", () => {
  const e12 = e12Series(VALUE_RANGES.resistor);
  assert.deepEqual(nearestStandard(3000, e12), [2700, 3300]);
  assert.equal(nearestStandard(3300, e12), null, "a standard value");
  assert.equal(nearestStandard(3310, e12), null, "within half a percent");
  assert.deepEqual(nearestStandard(3320, e12), [3300, 3900]);
  assert.equal(nearestStandard(4.7e-6, INDUCTOR_VALUES), null, "4.7u");
  assert.equal(nearestStandard(parseComponentValue("4.70 µH", "henry").value, INDUCTOR_VALUES), null); // prettier-ignore
  assert.deepEqual(nearestStandard(2e-3, INDUCTOR_VALUES), [1.5e-3, 2.2e-3]);
  assert.deepEqual(nearestStandard(0.5e-6, INDUCTOR_VALUES), [1e-6], "below");
  assert.deepEqual(nearestStandard(0.5, INDUCTOR_VALUES), [0.1], "above");
  assert.equal(nearestStandard(Number.NaN, e12), null);
  assert.equal(nearestStandard(3000, []), null);
});

test("the extended lists keep every value they had", () => {
  for (const v of [
    1e-6, 10e-6, 22e-6, 47e-6, 100e-6, 220e-6, 1e-3, 10e-3, 100e-3,
  ]) {
    assert.ok(INDUCTOR_VALUES.includes(v), `${v} H`);
  }
  const zeners = ZENER_DIODES.map((z) => z.volts);
  for (const v of [
    2.4, 2.7, 3, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1, 10,
    12, 15, 18, 24, 30,
  ]) {
    // prettier-ignore
    assert.ok(zeners.includes(v), `${v} V`);
  }
  assert.deepEqual(
    zeners,
    [...zeners].sort((a, b) => a - b),
    "in order",
  );
});
