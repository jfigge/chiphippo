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

// The logic analyzer's two x axes (model/scope-axis.js): Timing's scale
// ladder and its placement by each column's moment, and Transitions' slices,
// folds and settle-gap threshold.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BLOCK_PX,
  BREAK_PX,
  MARK_STEPS,
  MAX_TRACK_PX,
  SEC_PER_DIV,
  SLICE_PX,
  columnAtX,
  columnTimes,
  fitSecPerDiv,
  joined,
  minSecPerDiv,
  normalizeAxisMode,
  stepSecPerDiv,
  timingAxis,
  transitionAxis,
} from "../model/scope-axis.js";

/** A column of one channel, "a": a level or bus word, and maybe volts. */
const col = (at, cell, volts = null) => ({
  at,
  cells: new Map([["a", cell]]),
  ...(volts == null ? {} : { volts: new Map([["a", volts]]) }),
});

test("the scale ladder runs 1-2-5 from 100 ns to 5000 s", () => {
  assert.equal(SEC_PER_DIV[0], 1e-7);
  assert.equal(SEC_PER_DIV.at(-1), 5000);
  assert.deepEqual(SEC_PER_DIV.slice(12, 18), [0.001, 0.002, 0.005, 0.01, 0.02, 0.05]); // prettier-ignore
  assert.equal(normalizeAxisMode("transitions"), "transitions");
  assert.equal(normalizeAxisMode(undefined), "timing");
});

test("Fit takes the finest step that shows the span, and a step is one rung", () => {
  // 800 px is eight divisions: 40 ms needs 5 ms each, 41 ms needs 10.
  assert.equal(fitSecPerDiv(0.04, 800), 0.005);
  assert.equal(fitSecPerDiv(0.041, 800), 0.01);
  assert.equal(fitSecPerDiv(0, 800), SEC_PER_DIV[0], "nothing yet: the finest");
  assert.equal(stepSecPerDiv(0.005, -1), 0.002);
  assert.equal(stepSecPerDiv(0.005, 1), 0.01);
  assert.equal(stepSecPerDiv(SEC_PER_DIV[0], -1), SEC_PER_DIV[0]);
  assert.equal(stepSecPerDiv(5000, 1), 5000);
  // Held to the trace's floor: no finer than the track can be wide.
  const floor = minSecPerDiv(10);
  assert.ok((10 / floor) * 100 <= MAX_TRACK_PX);
  assert.equal(stepSecPerDiv(floor, -1, floor), floor);
});

test("each column's moment never goes back, and one with none sits at the last", () => {
  const times = columnTimes([{ at: 1 }, {}, { at: 0.5 }, { at: 3 }]);
  assert.deepEqual([...times], [1, 1, 1, 3]);
});

test("Timing puts each column at its moment, the right edge at the run's end", () => {
  const cols = [col(0.1, "L"), col(0.1025, "H"), col(0.11, "L")];
  const axis = timingAxis(cols, { secPerDiv: 0.001, end: 0.12 });
  // 1 ms a 100 px division: 100 000 px a second, from the first column.
  assert.equal(axis.t0, 0.1);
  assert.deepEqual([...axis.xs].map((x) => Math.round(x)), [0, 250, 1000, 2000]); // prettier-ignore
  assert.equal(Math.round(axis.width), 2000);
  // An end before the last column is no end: the trace stops there.
  assert.equal(Math.round(timingAxis(cols, { secPerDiv: 0.001, end: 0 }).width), 1000); // prettier-ignore
});

test("Transitions: a slice per change; a long steady run is a marked break, a short one folds away", () => {
  const cols = [
    col(0, "L"),
    col(1, "H"),
    col(2, "H"),
    col(3, "H"),
    col(7, "L"),
    col(8, "L"),
  ];
  const axis = transitionAxis(cols, ["a"], { end: 9 }); // prettier-ignore
  const S = SLICE_PX;
  const B = BREAK_PX;
  assert.deepEqual([...axis.changed], [1, 1, 0, 0, 1, 0]);
  // The trace steps a second at a time, so a fold is marked past four: the
  // H held from 1 s to 7 s is; the L's last two seconds are not.
  assert.equal(MARK_STEPS, 4);
  assert.deepEqual([...axis.xs], [0, S, 2 * S, 2 * S + B, 2 * S + B, 3 * S + B, 3 * S + B]); // prettier-ignore
  assert.deepEqual(axis.breaks, [{ x: 2 * S, from: 1, to: 7 }]);
});

test("Transitions is the logic view: a voltage is no change of its own", () => {
  // A node creeping 0.4 V a sample, read L, L, X, X, H.
  const cols = ["L", "L", "X", "X", "H"].map((lv, k) =>
    col(k, lv, 1 + 0.4 * k),
  );
  assert.deepEqual([...transitionAxis(cols, ["a"]).changed], [1, 0, 1, 0, 1]);
});

test("Transitions: a level or a bus word is a change by identity", () => {
  const cols = [col(0, 3), col(1, 3), col(2, 4), col(3, "H", 4.4), col(4, "H")];
  assert.deepEqual([...transitionAxis(cols, ["a"]).changed], [1, 0, 1, 1, 0]);
});

test("Transitions: any drawn channel's change is the column's; one not drawn is not", () => {
  const two = (a, b) => ({
    at: 0,
    cells: new Map([
      ["a", a],
      ["b", b],
    ]),
  });
  const cols = [two("L", "L"), two("L", "H"), two("L", "H")];
  assert.deepEqual([...transitionAxis(cols, ["a", "b"]).changed], [1, 1, 0]); // prettier-ignore
  assert.deepEqual([...transitionAxis(cols, ["a"]).changed], [1, 0, 0]); // prettier-ignore
});

test("the column under an x is the last whose edge is at or before it", () => {
  const xs = Float64Array.from([0, 10, 10, 20, 30]); // column 1 folded away
  assert.equal(columnAtX(xs, -5), 0);
  assert.equal(columnAtX(xs, 5), 0);
  assert.equal(columnAtX(xs, 10), 2, "a fold reads as the column after it");
  assert.equal(columnAtX(xs, 25), 3);
  assert.equal(columnAtX(xs, 99), 3);
  assert.equal(columnAtX(Float64Array.from([0]), 4), 0);
});

test("a curve sample is joined to the column before; a tick never is", () => {
  const cols = [{ at: 0 }, { at: 0.001, curve: true }, { at: 0.0015 }, { at: 1, curve: true }]; // prettier-ignore
  assert.equal(joined(cols, 0), false, "the first column starts the trace");
  assert.equal(joined(cols, 1), true, "read off the curve between two ticks");
  assert.equal(joined(cols, 2), false, "a tick: held to its moment, stepped there"); // prettier-ignore
  assert.equal(
    joined(cols, 3),
    true,
    "however far apart, a sample is the curve",
  );
});

test("Transitions: a channel's drawn-cycle stretch is one block — its slowed edges no changes, no break marked in it", () => {
  // H/L every sample (the slowed picture) from 1 s to 5 s, then steady.
  const lv = ["L", "H", "L", "H", "L", "H", "H", "H", "H"];
  const cols = lv.map((cell, k) => col(k, cell));
  const span = { from: 1, to: 5, period: 1e-4 };
  const axis = transitionAxis(cols, ["a"], { periodic: new Map([["a", [span]]]) }); // prettier-ignore
  assert.deepEqual([...axis.changed], [1, 1, 0, 0, 0, 0, 1, 0, 0]);
  assert.deepEqual(
    axis.blocks.map((b) => [b.id, b.k0, b.k1]),
    [["a", 1, 5]],
  );
  assert.equal(axis.xs[2] - axis.xs[1], BLOCK_PX, "the block's own width");
  assert.equal(
    axis.breaks.length,
    0,
    "the fold inside the block is not marked",
  );
});
