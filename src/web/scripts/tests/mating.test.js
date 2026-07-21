/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Tests for the pure mating rule and its magnetic pull (model/mating.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  SNAP_RANGE,
  boardRect,
  matingEdge,
  rectMatingEdge,
  snapCorrection,
} from "../model/mating.js";

const rect = (x, y, width, height) => ({ x, y, width, height });

/** A pin-board and a rail, in the real proportions. */
const PINS = (x, y) => rect(x, y, 64, 13);
const RAIL = (x, y) => rect(x, y, 64, 3);

test("rectMatingEdge: flush and matching mates; a gap does not", () => {
  const a = PINS(0, 3);
  assert.equal(rectMatingEdge(a, RAIL(0, 0)), "above");
  assert.equal(rectMatingEdge(a, RAIL(0, 16)), "below");
  assert.equal(rectMatingEdge(a, PINS(64, 3)), "right");
  assert.equal(rectMatingEdge(a, PINS(-64, 3)), "left");
  // One pitch of daylight is not a dovetail.
  assert.equal(rectMatingEdge(a, PINS(65, 3)), null);
  assert.equal(rectMatingEdge(a, RAIL(0, 17)), null);
});

test("rectMatingEdge: sizes must match across the shared edge", () => {
  // Flush, aligned — but a half-width strip cannot stack on a full one.
  assert.equal(rectMatingEdge(PINS(0, 3), rect(0, 0, 31, 3)), null);
  // Side by side, flush — but the heights differ.
  assert.equal(rectMatingEdge(PINS(0, 0), rect(64, 0, 64, 3)), null);
});

test("matingEdge: the same rule, stated in board types", () => {
  const board = (type, x, y) => ({ type, x, y });
  assert.equal(
    matingEdge(board("pins-full", 0, 3), board("rail-full", 0, 0)),
    "above",
  );
  // A half rail is the wrong width to stack under a full pin-board.
  assert.equal(
    matingEdge(board("pins-full", 0, 3), board("rail-half", 0, 16)),
    null,
  );
  assert.deepEqual(boardRect(board("pins-tiny", 5, 7)), rect(5, 7, 18, 13));
});

test("snapCorrection: nothing to pull towards", () => {
  assert.deepEqual(snapCorrection([], [PINS(0, 0)]), { dx: 0, dy: 0 });
  assert.deepEqual(snapCorrection([PINS(0, 0)], []), { dx: 0, dy: 0 });
});

test("snapCorrection: a board dropped beside another is pulled flush", () => {
  // Two pitch of gap, one pitch low — both within range.
  const pull = snapCorrection([PINS(66, 1)], [PINS(0, 0)]);
  assert.deepEqual(pull, { dx: -2, dy: -1 });
});

test("snapCorrection: a board dropped under another is pulled flush", () => {
  const pull = snapCorrection([RAIL(1, 15)], [PINS(0, 0)]);
  assert.deepEqual(pull, { dx: -1, dy: -2 }); // onto y = 13, x = 0
});

test("snapCorrection: already dovetailed, so nothing moves", () => {
  assert.deepEqual(snapCorrection([PINS(64, 0)], [PINS(0, 0)]), {
    dx: 0,
    dy: 0,
  });
});

test("snapCorrection: out of range on either axis, no pull", () => {
  const board = PINS(0, 0);
  // Too far along the mating axis…
  assert.deepEqual(snapCorrection([PINS(64 + SNAP_RANGE + 1, 0)], [board]), {
    dx: 0,
    dy: 0,
  });
  // …and flush but too far off along the other one.
  assert.deepEqual(snapCorrection([PINS(64, SNAP_RANGE + 1)], [board]), {
    dx: 0,
    dy: 0,
  });
});

test("snapCorrection: mismatched sizes never attract", () => {
  // A half-width board sitting exactly where it would stack, if it fitted.
  assert.deepEqual(snapCorrection([rect(0, 13, 31, 13)], [PINS(0, 0)]), {
    dx: 0,
    dy: 0,
  });
});

test("snapCorrection: the nearest of several candidates wins", () => {
  // Between two boards: 2 pitch from the left one, 1 from the right one.
  const pull = snapCorrection([PINS(66, 0)], [PINS(0, 0), PINS(131, 0)]);
  assert.deepEqual(pull, { dx: 1, dy: 0 }); // pulled right, the shorter hop
});

test("snapCorrection: a whole kit is pulled by whichever strip is closest", () => {
  // A kit (rail · pins · rail) dropped one pitch shy of another board's edge:
  // the pin-board is the strip that finds the mate, and the set moves as one.
  const kit = [RAIL(65, 0), PINS(65, 3), RAIL(65, 16)];
  const pull = snapCorrection(kit, [PINS(0, 3)]);
  assert.deepEqual(pull, { dx: -1, dy: 0 });
});

test("snapCorrection: the range is configurable", () => {
  const far = [PINS(69, 0)]; // 5 pitch of gap
  assert.deepEqual(snapCorrection(far, [PINS(0, 0)]), { dx: 0, dy: 0 });
  assert.deepEqual(snapCorrection(far, [PINS(0, 0)], 5), { dx: -5, dy: 0 });
});

test("an upright rail never snaps to a flat one — orientation is the rect", () => {
  const flat = { type: "rail-full", x: 0, y: 0, rot: 0 }; // 64 × 3
  const upright = { type: "rail-full", x: 64, y: 0, rot: 90 }; // 3 × 64
  assert.deepEqual(boardRect(upright), rect(64, 0, 3, 64));
  // Flush along the shared edge, but no edge they MATCH on: no mate, no pull.
  assert.equal(matingEdge(flat, upright), null);
  assert.deepEqual(snapCorrection([boardRect(upright)], [boardRect(flat)]), {
    dx: 0,
    dy: 0,
  });
});

test("two upright rails of the same size snap side by side and end to end", () => {
  const a = { type: "rail-full", x: 0, y: 0, rot: 90 }; // occupies x 0…3
  assert.equal(
    matingEdge(a, { type: "rail-full", x: 3, y: 0, rot: 90 }),
    "right",
  );
  assert.equal(
    matingEdge(a, { type: "rail-full", x: 0, y: 64, rot: 90 }),
    "below",
  );
  // …and the magnet closes a two-pitch gap between them.
  assert.deepEqual(
    snapCorrection(
      [boardRect({ type: "rail-full", x: 5, y: 0, rot: 90 })],
      [boardRect(a)],
    ),
    { dx: -2, dy: 0 },
  );
});

test("an upright rail does not mate with the board it runs beside", () => {
  // The whole point of the signal bus: it sits against a breadboard without
  // becoming part of it, so dragging the board never drags the bus.
  const rail = { type: "rail-full", x: 64, y: 0, rot: 90 };
  assert.equal(matingEdge(rail, { type: "pins-full", x: 0, y: 0 }), null);
});
