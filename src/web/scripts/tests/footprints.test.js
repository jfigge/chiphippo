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

// Tests for the pure DIP footprint derivation (model/footprints.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DIP_PACKAGES,
  allPinHoles,
  coveredHoles,
  dipRows,
  flippedPin,
  isWidePackage,
  packageSpec,
  pinOffset,
  seatRow,
} from "../model/footprints.js";

test("packageSpec: known packages; junk throws INVALID_PACKAGE", () => {
  // The small logic DIPs are 300-mil; the wide memory DIPs (24…40) are 600-mil.
  // DIP-2/DIP-4 aren't chips — they're the 1-/2-position DIP switch bank
  // bodies (catalog/parts.js's dipSwitchBankDef).
  assert.deepEqual(packageSpec("DIP-2"), { pins: 2, halfPins: 1, body: 300 });
  assert.deepEqual(packageSpec("DIP-4"), { pins: 4, halfPins: 2, body: 300 });
  assert.deepEqual(packageSpec("DIP-8"), { pins: 8, halfPins: 4, body: 300 });
  assert.deepEqual(packageSpec("DIP-14"), { pins: 14, halfPins: 7, body: 300 });
  assert.deepEqual(packageSpec("DIP-16"), { pins: 16, halfPins: 8, body: 300 });
  assert.deepEqual(packageSpec("DIP-20"), {
    pins: 20,
    halfPins: 10,
    body: 300,
  });
  assert.deepEqual(packageSpec("DIP-24"), {
    pins: 24,
    halfPins: 12,
    body: 600,
  });
  assert.deepEqual(packageSpec("DIP-28"), {
    pins: 28,
    halfPins: 14,
    body: 600,
  });
  assert.deepEqual(packageSpec("DIP-32"), {
    pins: 32,
    halfPins: 16,
    body: 600,
  });
  assert.deepEqual(packageSpec("DIP-40"), {
    pins: 40,
    halfPins: 20,
    body: 600,
  });
  assert.throws(() => packageSpec("DIP-12"), { code: "INVALID_PACKAGE" });
  assert.throws(() => packageSpec(undefined), { code: "INVALID_PACKAGE" });
});

test("pinOffset: standard counterclockwise DIP numbering, notch left", () => {
  // DIP-14: 1…7 left→right along e; 8…14 right→left along f.
  assert.deepEqual(pinOffset("DIP-14", 1), { row: "e", dcol: 0 });
  assert.deepEqual(pinOffset("DIP-14", 7), { row: "e", dcol: 6 });
  assert.deepEqual(pinOffset("DIP-14", 8), { row: "f", dcol: 6 });
  assert.deepEqual(pinOffset("DIP-14", 14), { row: "f", dcol: 0 });
  // Pin 14 sits directly above pin 1 (the notch end).
  assert.equal(pinOffset("DIP-14", 14).dcol, pinOffset("DIP-14", 1).dcol);
  // DIP-16/20 corners.
  assert.deepEqual(pinOffset("DIP-16", 8), { row: "e", dcol: 7 });
  assert.deepEqual(pinOffset("DIP-16", 9), { row: "f", dcol: 7 });
  assert.deepEqual(pinOffset("DIP-20", 20), { row: "f", dcol: 0 });
  // DIP-8 (half-can oscillator footprint): pins 4/5 adjacent at the far end,
  // pins 1/8 adjacent at the notch end.
  assert.deepEqual(pinOffset("DIP-8", 4), { row: "e", dcol: 3 });
  assert.deepEqual(pinOffset("DIP-8", 5), { row: "f", dcol: 3 });
  assert.deepEqual(pinOffset("DIP-8", 8), { row: "f", dcol: 0 });
});

test("pinOffset: a 600-mil package seats six pitches across, rows d and h", () => {
  // DIP-28: 1…14 left→right along d; 15…28 right→left along h.
  assert.deepEqual(pinOffset("DIP-28", 1), { row: "d", dcol: 0 });
  assert.deepEqual(pinOffset("DIP-28", 14), { row: "d", dcol: 13 });
  assert.deepEqual(pinOffset("DIP-28", 15), { row: "h", dcol: 13 });
  assert.deepEqual(pinOffset("DIP-28", 28), { row: "h", dcol: 0 });
  assert.deepEqual(pinOffset("DIP-40", 21), { row: "h", dcol: 19 });
  // …unless anchored in row e: the narrow seat a desk saved before wide
  // seating gave it, kept as it was.
  assert.deepEqual(pinOffset("DIP-28", 1, "e"), { row: "e", dcol: 0 });
  assert.deepEqual(pinOffset("DIP-28", 28, "e"), { row: "f", dcol: 0 });
  // A 300-mil package has no wide seat, and nothing anchors in another row.
  assert.equal(pinOffset("DIP-14", 1, "d"), null);
  assert.equal(pinOffset("DIP-28", 1, "c"), null);
});

test("seatRow / dipRows: the body width decides the rows, the anchor row the seat", () => {
  for (const pkg of Object.keys(DIP_PACKAGES)) {
    const wide = packageSpec(pkg).body === 600;
    assert.equal(isWidePackage(pkg), wide, pkg);
    assert.equal(seatRow(pkg), wide ? "d" : "e", pkg);
    // A new seat: 300-mil straight across the trench, 600-mil six pitches.
    const rows = dipRows(pkg);
    assert.deepEqual(
      [rows.lower, rows.upper, rows.span],
      wide ? ["d", "h", 6] : ["e", "f", 3],
      pkg,
    );
    assert.deepEqual([...rows.covers], wide ? ["e", "f", "g"] : [], pkg);
    // Row e is a seat every package can have.
    assert.deepEqual([dipRows(pkg, "e").lower, dipRows(pkg, "e").upper], ["e", "f"]); // prettier-ignore
    assert.equal(dipRows(pkg, "d") !== null, wide, pkg);
  }
  assert.throws(() => dipRows("DIP-12", "e"), { code: "INVALID_PACKAGE" });
});

test("coveredHoles: rows e, f and g in every column under a wide body; nothing under a narrow one", () => {
  const holes = coveredHoles("DIP-24", 10);
  assert.equal(holes.length, 3 * 12);
  assert.deepEqual([...new Set(holes.map((h) => h.row))], ["e", "f", "g"]);
  assert.deepEqual(
    [...new Set(holes.map((h) => h.col))],
    Array.from({ length: 12 }, (_, i) => 10 + i),
  );
  // None of them is a pin's.
  const pins = new Set(allPinHoles("DIP-24", 10).map((h) => `${h.row}${h.col}`)); // prettier-ignore
  assert.ok(holes.every((h) => !pins.has(`${h.row}${h.col}`)));
  assert.deepEqual(coveredHoles("DIP-24", 10, "e"), []);
  assert.deepEqual(coveredHoles("DIP-14", 10), []);
});

test("pinOffset: out-of-range pins are null", () => {
  assert.equal(pinOffset("DIP-14", 0), null);
  assert.equal(pinOffset("DIP-14", 15), null);
  assert.equal(pinOffset("DIP-14", 1.5), null);
});

test("flippedPin: swaps each pin with the one halfway around the package; its own inverse", () => {
  // DIP-16 (bar8iso): pin 1 trades with pin 9, pin 8 with pin 16.
  assert.equal(flippedPin("DIP-16", 1), 9);
  assert.equal(flippedPin("DIP-16", 9), 1);
  assert.equal(flippedPin("DIP-16", 8), 16);
  assert.equal(flippedPin("DIP-16", 16), 8);
  // Applying it twice returns the original pin, for every package/pin.
  for (const pkg of Object.keys(DIP_PACKAGES)) {
    const { pins } = packageSpec(pkg);
    for (let pin = 1; pin <= pins; pin++) {
      assert.equal(flippedPin(pkg, flippedPin(pkg, pin)), pin);
    }
  }
});

test("allPinHoles: every pin exactly once, anchored at the given column", () => {
  for (const pkg of Object.keys(DIP_PACKAGES)) {
    const { pins, halfPins } = packageSpec(pkg);
    const holes = allPinHoles(pkg, 12);
    assert.equal(holes.length, pins);
    assert.equal(new Set(holes.map((h) => `${h.row}${h.col}`)).size, pins);
    // Row split: half in each pin row — e/f across the trench for a 300-mil
    // part, d/h for a 600-mil one; columns span 12 … 12+halfPins-1.
    const { lower, upper } = dipRows(pkg);
    assert.equal(holes.filter((h) => h.row === lower).length, halfPins);
    assert.equal(holes.filter((h) => h.row === upper).length, halfPins);
    const cols = holes.map((h) => h.col);
    assert.equal(Math.min(...cols), 12);
    assert.equal(Math.max(...cols), 12 + halfPins - 1);
    // The narrow seat an older desk kept is still every package's.
    const narrow = allPinHoles(pkg, 12, "e");
    assert.equal(narrow.filter((h) => h.row === "e").length, halfPins);
    assert.equal(narrow.filter((h) => h.row === "f").length, halfPins);
  }
  // A row the package cannot anchor in seats nothing.
  assert.deepEqual(allPinHoles("DIP-14", 12, "d"), []);
});
