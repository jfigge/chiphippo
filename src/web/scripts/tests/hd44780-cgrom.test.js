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

// hd44780-cgrom.test.js — the character font (sim/hd44780-cgrom.js): ROM glyphs
// for printable ASCII, custom glyphs from CGRAM (codes 0x00–0x0F, with 0x08–0x0F
// aliasing 0x00–0x07), and a blank fallback for unmapped codes.

import test from "node:test";
import assert from "node:assert/strict";

import { CGROM_A00, glyphRows } from "../sim/hd44780-cgrom.js";

test("every ROM glyph is eight 5-bit rows", () => {
  for (const [code, rows] of Object.entries(CGROM_A00)) {
    assert.equal(rows.length, 8, `code ${code} has 8 rows`);
    for (const r of rows)
      assert.ok(r >= 0 && r <= 0x1f, `code ${code} row ≤ 5 bits`);
  }
});

test("glyphRows returns the ROM bitmap for a printable ASCII code", () => {
  // 'A' (0x41): the top row is a centred triple (0b01110).
  const a = glyphRows(0x41);
  assert.equal(a.length, 8);
  assert.equal(a[0], 0b01110);
  assert.deepEqual([...a], [...CGROM_A00[0x41]]);
});

test("an unmapped code renders blank (never throws)", () => {
  const blank = glyphRows(0xff);
  assert.equal(blank.length, 8);
  assert.ok([...blank].every((r) => r === 0));
});

test("codes 0x00–0x0F read the 8 CGRAM glyphs (0x08–0x0F alias 0x00–0x07)", () => {
  const cgram = new Uint8Array(64);
  const glyph = [0x1f, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x1f, 0x00];
  for (let i = 0; i < 8; i++) cgram[8 + i] = glyph[i]; // custom glyph 1

  assert.deepEqual([...glyphRows(0x01, cgram)], glyph);
  // 0x09 aliases to CGRAM glyph 1 (0x09 & 0x07 === 1).
  assert.deepEqual([...glyphRows(0x09, cgram)], glyph);
  // Without a cgram argument, custom codes fall back to blank.
  assert.ok([...glyphRows(0x01)].every((r) => r === 0));
});
