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

// Unit tests for model/signals.js — the pure half of external signals
// (Feature 370): the colour allocation that IS the cap, the rail ordering the
// digit keys index into, and the flag polygon.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FLAG_LEN,
  FLAG_W,
  MAX_SIGNALS,
  SIGNAL_COLORS,
  SIGNAL_DIGITS,
  assertedLevel,
  availableSignalColors,
  flagPolygon,
  isPlanted,
  nextFlagRotation,
  normalizeFlagRotation,
  normalizeSignalFields,
  railOrder,
  restLevel,
  signalDigit,
  signalForDigit,
} from "../model/signals.js";
import { WIRE_COLORS } from "../model/wire-colors.js";

test("black is not a signal colour, and the cap follows from that", () => {
  // Black is the bench's ground colour — a black flag reads as a ground tie,
  // and its button's dot vanishes against the dark rail. Withdrawing it is
  // what took the cap from 8 to 7, and the two are ONE fact: the cap is the
  // signal palette's length, never a typed number.
  assert.ok(WIRE_COLORS.includes("black"), "still a jumper colour");
  assert.ok(!SIGNAL_COLORS.includes("black"), "but never a signal colour");
  assert.deepEqual(
    SIGNAL_COLORS,
    WIRE_COLORS.filter((c) => c !== "black"),
    "derived by subtraction, so a new jumper colour reaches signals for free",
  );
  assert.equal(MAX_SIGNALS, SIGNAL_COLORS.length);
  assert.equal(MAX_SIGNALS, 7);
});

test("the digit keys reach every signal there can be", () => {
  // A separate fact from the cap: there are only nine digits, so a palette
  // that outgrew them must leave signals unreachable rather than mis-bound.
  assert.equal(SIGNAL_DIGITS, Math.min(MAX_SIGNALS, 9));
  assert.equal(SIGNAL_DIGITS, MAX_SIGNALS, "today the cap binds");
});

test("nextSignalColor walks the palette and then runs out", async () => {
  const { nextSignalColor } = await import("../model/signals.js");
  const signals = [];
  for (const expected of SIGNAL_COLORS) {
    const color = nextSignalColor(signals);
    assert.equal(color, expected);
    signals.push({ color });
  }
  assert.equal(nextSignalColor(signals), null);
});

test("availableSignalColors offers the free ones plus the signal's own", () => {
  const signals = [
    { id: "sig1", color: "red" },
    { id: "sig2", color: "blue" },
  ];
  const offered = availableSignalColors(signals, "sig1");
  assert.ok(offered.includes("red"), "its own colour stays offered");
  assert.ok(!offered.includes("blue"), "another signal's colour is withheld");
  assert.equal(offered.length, SIGNAL_COLORS.length - 1);
});

test("normalizeSignalFields repairs a clash instead of rejecting the signal", () => {
  const fields = normalizeSignalFields(
    { color: "red", type: "nonsense", rest: "sideways" },
    new Set(["red"]),
  );
  assert.notEqual(fields.color, "red");
  assert.equal(fields.type, "momentary");
  assert.equal(fields.rest, "low");
});

test("normalizeSignalFields returns null only when no colour is left", () => {
  assert.equal(normalizeSignalFields({}, new Set(SIGNAL_COLORS)), null);
});

test("a stored BLACK signal is repaired, never rejected", () => {
  // Every project saved before black was withdrawn arrives needing this.
  const fields = normalizeSignalFields(
    { color: "black", type: "toggle", rest: "high" },
    new Set(),
  );
  assert.ok(fields, "the signal survives");
  assert.notEqual(fields.color, "black");
  assert.equal(fields.type, "toggle", "and nothing else about it moves");
  assert.equal(fields.rest, "high");
});

test("railOrder is document order, and the digits index into it", () => {
  const signals = [{ id: "sig9" }, { id: "sig2" }, { id: "sig5" }];
  assert.deepEqual(
    railOrder(signals).map((s) => s.id),
    ["sig9", "sig2", "sig5"],
  );
  assert.equal(signalForDigit(signals, 1).id, "sig9");
  assert.equal(signalForDigit(signals, 3).id, "sig5");
  assert.equal(signalForDigit(signals, 4), null);
  assert.equal(signalForDigit(signals, 0), null);
  assert.equal(signalDigit(signals, "sig2"), 2);
  assert.equal(signalDigit(signals, "nope"), null);
});

test("rest and asserted levels are opposites", () => {
  assert.equal(restLevel({ rest: "high" }), "high");
  assert.equal(assertedLevel({ rest: "high" }), "low");
  assert.equal(restLevel({}), "low");
  assert.equal(assertedLevel({}), "high");
});

test("isPlanted asks only whether there is an anchor", () => {
  assert.equal(isPlanted({ flag: { anchor: "bb1.a1" } }), true);
  assert.equal(isPlanted({ flag: { rot: 90 } }), false);
  assert.equal(isPlanted({}), false);
});

test("the flag's apex sits EXACTLY on the anchor, at every rotation", () => {
  const at = { x: 7, y: -3 };
  for (const rot of [0, 90, 180, 270]) {
    const [apex] = flagPolygon(at, rot);
    assert.deepEqual(apex, at, `rot ${rot}`);
  }
});

test("the point is the other two sides of an equilateral triangle", () => {
  // The two triangle corners sit FLAG_W apart, each one side-length from the
  // apex — which is what makes the notch equilateral rather than merely
  // pointed.
  const [apex, c1, , , c2] = flagPolygon({ x: 0, y: 0 }, 0);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(Math.abs(dist(c1, c2) - FLAG_W) < 1e-9, "corners are FLAG_W apart");
  assert.ok(Math.abs(dist(apex, c1) - FLAG_W) < 1e-9, "side one");
  assert.ok(Math.abs(dist(apex, c2) - FLAG_W) < 1e-9, "side two");
});

test("every rotation is the same rigid shape, one quarter-turn on", () => {
  const base = flagPolygon({ x: 0, y: 0 }, 0);
  const edgeLengths = (poly) =>
    poly.map((p, i) => {
      const q = poly[(i + 1) % poly.length];
      return Math.round(Math.hypot(p.x - q.x, p.y - q.y) * 1e6) / 1e6;
    });
  for (const rot of [90, 180, 270]) {
    assert.deepEqual(
      edgeLengths(flagPolygon({ x: 0, y: 0 }, rot)),
      edgeLengths(base),
    );
  }
  // rot 0 runs right of the point; rot 90 runs down from it.
  assert.equal(Math.max(...base.map((p) => p.x)), FLAG_LEN);
  assert.equal(
    Math.max(...flagPolygon({ x: 0, y: 0 }, 90).map((p) => p.y)),
    FLAG_LEN,
  );
});

test("R cycles the four quarter-turns and junk coerces to 0", () => {
  assert.deepEqual([0, 90, 180, 270].map(nextFlagRotation), [90, 180, 270, 0]);
  assert.equal(nextFlagRotation(45), 90);
  assert.equal(normalizeFlagRotation(45), 0);
  assert.equal(normalizeFlagRotation(270), 270);
});
