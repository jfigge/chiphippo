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

// Tests for the typed component values: a resistance and a capacitance as a
// person types them (model/ohm-format.js, model/farad-format.js, on the
// shared rules in model/si-value.js), and a resistance as its colour code
// (model/resistor-bands.js).

import test from "node:test";
import assert from "node:assert/strict";

import { formatOhms, parseOhms } from "../model/ohm-format.js";
import {
  formatFarads,
  formatFaradsAscii,
  parseFarads,
} from "../model/farad-format.js";
import {
  BAND_COLORS,
  DIGIT_COLORS,
  resistorBands,
} from "../model/resistor-bands.js";
import { partDef } from "../catalog/index.js";

// ── Resistance ──────────────────────────────────────────────────────────────

test("every resistance form the field promises reads as ohms", () => {
  const forms = {
    470: 470,
    "470R": 470,
    "470Ω": 470, // U+03A9 GREEK CAPITAL OMEGA
    "470Ω": 470, // U+2126 OHM SIGN — what a symbol picker inserts
    "4.7k": 4700,
    "4k7": 4700,
    "1M": 1e6,
    "2M2": 2.2e6,
  };
  for (const [text, ohms] of Object.entries(forms)) {
    assert.equal(parseOhms(text), ohms, text);
  }
});

test("the other ways a bench writes a resistance read too", () => {
  assert.equal(parseOhms("4.7kΩ"), 4700);
  assert.equal(parseOhms("4.7 k"), 4700, "spaces are ignored");
  assert.equal(parseOhms(" 10 ohms "), 10);
  assert.equal(parseOhms("10K"), 10000, "an uppercase K is a kilo");
  assert.equal(parseOhms("4R7"), 4.7, "R stands for the decimal point");
  assert.equal(parseOhms("R47"), 0.47, "…with no leading digit");
  assert.equal(parseOhms("k47"), 470, "IEC: the k stands where the point is");
  assert.equal(parseOhms("1G"), 1e9);
  assert.equal(parseOhms(".5k"), 500);
});

test("text that is not a resistance is refused, never guessed at", () => {
  for (const text of [
    "",
    "   ",
    "abc",
    "0",
    "-5",
    "1m", // a milliohm, or a typo for M — either way not what was meant
    "4.7kR",
    "4k7k",
    "1e3",
    "2G", // past 1 GΩ
    "0.05", // under 0.1 Ω
    null,
    undefined,
  ]) {
    assert.equal(parseOhms(text), null, JSON.stringify(text));
  }
});

test("a parsed value round-trips through the printed form", () => {
  for (const ohms of [0.47, 10, 220, 4700, 47000, 1e6, 2.2e6]) {
    assert.equal(parseOhms(formatOhms(ohms)), ohms, formatOhms(ohms));
  }
});

// ── Capacitance ─────────────────────────────────────────────────────────────

test("every capacitance form the field promises reads as farads", () => {
  const forms = {
    "100p": 100e-12,
    "100pF": 100e-12,
    "10n": 10e-9,
    "100nF": 100e-9,
    "4.7µ": 4.7e-6, // U+00B5 MICRO SIGN
    "4.7u": 4.7e-6,
    "4u7": 4.7e-6,
    "100µF": 100e-6,
    "1m": 1e-3,
  };
  for (const [text, farads] of Object.entries(forms)) {
    assert.equal(parseFarads(text), farads, text);
  }
});

test("the other ways a capacitance is written read too", () => {
  assert.equal(parseFarads("4.7μ"), 4.7e-6, "U+03BC, a keyboard's mu");
  assert.equal(parseFarads("10pf"), 10e-12, "a lowercase f is the unit");
  assert.equal(parseFarads("n47"), 470e-12, "IEC form, no leading digit");
  assert.equal(parseFarads("2p2"), 2.2e-12);
  assert.equal(parseFarads("100 nF"), 100e-9, "spaces are ignored");
  assert.equal(parseFarads("1F"), 1, "the unit alone is farads");
  assert.equal(parseFarads("47UF"), 47e-6, "an uppercase U is micro");
});

test("text that is not a capacitance is refused, never guessed at", () => {
  for (const text of [
    "",
    "abc",
    "100", // pF on a ceramic, µF on an old schematic — not guessed
    "0.1",
    "1MF", // "MF" is an old microfarad marking, and SI's megafarad
    "0n",
    "-10n",
    "2F", // past 1 F
    "0.1p", // under 1 pF
    "4u7u",
  ]) {
    assert.equal(parseFarads(text), null, JSON.stringify(text));
  }
});

test("a capacitance prints at three figures, the next prefix taken at 1000", () => {
  assert.equal(formatFarads(100e-12), "100p");
  assert.equal(formatFarads(1e-9), "1n");
  assert.equal(formatFarads(100e-9), "100n");
  assert.equal(formatFarads(4.7e-6), "4.7µ");
  assert.equal(formatFarads(4700e-6), "4.7m");
  assert.equal(formatFarads(999.9e-9), "1µ", "rounding promotes");
  assert.equal(formatFarads(0), "");
  assert.equal(formatFaradsAscii(4.7e-6), "4.7u", "ASCII for other programs");
  for (const f of [1e-12, 22e-12, 1e-7, 4.7e-6, 1e-3]) {
    assert.equal(parseFarads(formatFarads(f)), f, formatFarads(f));
  }
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

test("resistors and capacitors carry a typed value field, parsed by these rules", () => {
  const resistance = partDef("resistor").properties.find(
    (f) => f.key === "ohms",
  );
  assert.equal(resistance.type, "quantity");
  assert.equal(resistance.parse("4k7"), 4700);
  assert.equal(resistance.format(4700), "4.7kΩ");
  assert.ok(partDef("rnet9").properties.some((f) => f.key === "ohms"));
  for (const ref of ["cap-ceramic", "cap-electrolytic"]) {
    const field = partDef(ref).properties.find((f) => f.key === "farads");
    assert.equal(field.type, "quantity", ref);
    assert.equal(field.parse("4u7"), 4.7e-6);
    assert.equal(field.format(1e-7), "100nF");
  }
});

test("a capacitor's value is coerced into range, falling back to its default", () => {
  const ceramic = partDef("cap-ceramic");
  const electrolytic = partDef("cap-electrolytic");
  assert.equal(ceramic.normalizeParams({}).farads, 100e-9);
  assert.equal(electrolytic.normalizeParams({}).farads, 10e-6);
  assert.equal(ceramic.normalizeParams({ farads: 2.2e-9 }).farads, 2.2e-9);
  assert.equal(ceramic.normalizeParams({ farads: -1 }).farads, 100e-9);
  assert.equal(ceramic.normalizeParams({ farads: 5 }).farads, 100e-9);
  assert.equal(ceramic.normalizeParams({ farads: "junk" }).farads, 100e-9);
  // The same two-free-ends geometry as the resistor and the LED.
  assert.deepEqual(
    ceramic.normalizeParams({ farads: 1e-9, rot: 90, end: { dx: 0, dy: -3 } }),
    { farads: 1e-9, rot: 90, end: { dx: 0, dy: -3 } },
  );
});
