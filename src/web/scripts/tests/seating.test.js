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

// Tests for the placement search (model/seating.js) — where a part would sit
// if you dropped it here. Legality (is that seat FREE?) is occupancy's job.

import test from "node:test";
import assert from "node:assert/strict";

import { ROW_BAND, SEAT_BAND, partSeatAt } from "../model/seating.js";
import { spec } from "../model/breadboard.js";

const FULL = { id: "bb1", type: "pins-full", x: 0, y: 0 };
const TINY = { id: "bb2", type: "pins-tiny", x: 100, y: 0 };
const RAIL = { id: "bb3", type: "rail-full", x: 0, y: 13 };

const at = (boards, ref, x, y, grab = 0) =>
  partSeatAt(boards, ref, { x, y }, grab);

test("a DIP centres on the cursor and anchors in row e", () => {
  // pins-full: trench centre 6.5, columns start at x 1.
  const seat = at([FULL], "74LS00", 10, 6.5);
  // A 14-pin DIP is 7 columns wide, so centring on column 10 anchors at 7.
  assert.deepEqual(seat, { board: "bb1", anchor: "e7" });
});

test("a 600-mil DIP anchors in row d — six pitches across, at its true width", () => {
  // DIP-28 is 14 columns wide: centring on column 20 anchors at 20 − 6.5 → 14.
  assert.deepEqual(at([FULL], "HM62256", 20, 6.5), { board: "bb1", anchor: "d14" }); // prettier-ignore
  for (const ref of ["74LS181", "28C16", "AS6C1024", "W65C02", "Z80A"]) {
    assert.equal(at([FULL], ref, 30, 6.5)?.anchor.charAt(0), "d", ref);
  }
  // A 300-mil part is untouched: row e, straight across the trench.
  for (const ref of ["74LS00", "74LS138", "CD4011B"]) {
    assert.equal(at([FULL], ref, 30, 6.5)?.anchor.charAt(0), "e", ref);
  }
});

test("a chip can be asked to keep the width it is seated at", () => {
  // A rigid group move keeps a narrow-seated 600-mil chip narrow (row e) —
  // and a 300-mil part has no wide seat to be asked for.
  const keep = (ref, chipRow) =>
    partSeatAt([FULL], ref, { x: 20, y: 6.5 }, 0, null, { chipRow });
  assert.equal(keep("HM62256", "e")?.anchor, "e14");
  assert.equal(keep("HM62256", "d")?.anchor, "d14");
  assert.equal(keep("74LS00", "d"), null);
});

test("a DIP seats from anywhere inside the trench band, and nowhere beyond", () => {
  const { trench } = spec("pins-full");
  assert.ok(at([FULL], "74LS00", 10, trench.centerY + SEAT_BAND));
  assert.equal(
    at([FULL], "74LS00", 10, trench.centerY + SEAT_BAND + 0.01),
    null,
  );
});

test("a DIP never seats on a rail — no trench to straddle", () => {
  assert.equal(at([RAIL], "74LS00", 10, 14), null);
});

test("an unknown ref seats nowhere", () => {
  assert.ok(at([TINY], "74LS00", 105, 6.5)); // a real DIP fits even the tiny board
  assert.equal(at([TINY], "nonexistent", 105, 6.5), null);
});

test("a discrete seats on the nearest grid row within the band", () => {
  const { rowY } = spec("pins-full");
  // Row j sits at y 1; a cursor a hair above it still lands on j.
  assert.equal(at([FULL], "led", 10, rowY.j)?.anchor.slice(0, 1), "j");
  assert.equal(at([FULL], "led", 10, rowY.a)?.anchor.slice(0, 1), "a");
  // The trench is out of every row's band.
  assert.equal(at([FULL], "led", 10, 6.5), null);
});

test("ROW_BAND bounds a discrete's reach", () => {
  const { rowY } = spec("pins-full");
  // Just inside the band still seats; just outside seats nothing. (The exact
  // boundary is not asserted — rowY.a + ROW_BAND is not representable, so
  // whether it lands in or out is a float accident, not a design decision.)
  assert.ok(at([FULL], "led", 10, rowY.a + ROW_BAND - 0.01));
  assert.equal(at([FULL], "led", 10, rowY.a + ROW_BAND + 0.01), null);
});

test("the anchor is clamped so the whole footprint stays on the strip", () => {
  const { cols, rowY } = spec("pins-full");
  // Hard against the right edge (still ON the board — a cursor off the strip
  // seats nothing at all): a 2-hole LED anchors at the last column that leaves
  // room for its far lead.
  assert.equal(at([FULL], "led", cols, rowY.a).anchor, `a${cols - 1}`);
  // And against the left edge it clamps to column 1, never 0 or negative.
  assert.equal(at([FULL], "led", 0.4, rowY.a).anchor, "a1");
  // Off the strip entirely is not a seat to be clamped — it is no seat.
  assert.equal(at([FULL], "led", cols + 5, rowY.a), null);
});

test("a drag keeps the grab column offset instead of re-centring", () => {
  const { rowY } = spec("pins-full");
  // Ghost (grab 0) centres the 2-wide LED on the cursor.
  assert.equal(at([FULL], "led", 10, rowY.a).anchor, "a10");
  // The same cursor with a +3 grab offset anchors 3 columns further right.
  assert.equal(at([FULL], "led", 10, rowY.a, 3).anchor, "a13");
});

test("a board that cannot host does not end the search", () => {
  // The rail's box is checked first but hosts nothing; the pin-board below it
  // must still be found. Flush strips share an inclusive seam, so this is the
  // ordering hazard in miniature — see occupancy.js holeAtWorld.
  const railAbove = { id: "bb9", type: "rail-full", x: 0, y: -3 };
  const seat = at([railAbove, FULL], "74LS00", 10, 6.5);
  assert.deepEqual(seat, { board: "bb1", anchor: "e7" });
});

test("off every board, and junk board types, seat nothing", () => {
  assert.equal(at([FULL], "led", 500, 500), null);
  assert.equal(at([], "led", 10, 1), null);
  assert.equal(
    at([{ id: "bb7", type: "not-a-board", x: 0, y: 0 }], "led", 1, 1),
    null,
  );
});

test("a brick has terminals, not a board seat", () => {
  assert.equal(at([FULL], "psu", 10, 1), null);
});
