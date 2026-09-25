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
// (Feature 370): the digit keys that ARE the cap, the colour cycle, the rail
// ordering the keys index into, and the flag polygon.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FLAG_KEY_R,
  FLAG_LEN,
  FLAG_W,
  MAX_SIGNALS,
  SIGNAL_COLORS,
  SIGNAL_KEYS,
  assertedLevel,
  flagKeyPoint,
  flagPolygon,
  isPlanted,
  nextFlagRotation,
  nextSignalColor,
  normalizeFlagRotation,
  normalizeSignalFields,
  railOrder,
  restLevel,
  signalForKey,
  signalKey,
} from "../model/signals.js";
import { WIRE_COLORS } from "../model/wire-colors.js";

test("black is not a signal colour", () => {
  // Black is the bench's ground colour — a black flag reads as a ground tie,
  // and its button's dot vanishes against the dark rail.
  assert.ok(WIRE_COLORS.includes("black"), "still a jumper colour");
  assert.ok(!SIGNAL_COLORS.includes("black"), "but never a signal colour");
  assert.deepEqual(
    SIGNAL_COLORS,
    WIRE_COLORS.filter((c) => c !== "black"),
    "derived by subtraction, so a new jumper colour reaches signals for free",
  );
});

test("the cap is the digit row: 1–9, then 0", () => {
  // One signal per key, so the cap is the key list's length — and NOT the
  // colour palette's, which is shorter: colours repeat, keys do not.
  assert.deepEqual(SIGNAL_KEYS, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]); // prettier-ignore
  assert.equal(MAX_SIGNALS, SIGNAL_KEYS.length);
  assert.equal(MAX_SIGNALS, 10);
  assert.ok(MAX_SIGNALS > SIGNAL_COLORS.length, "so a lap must wrap");
});

test("nextSignalColor walks the sequence, then starts a second lap", () => {
  const signals = [];
  for (let i = 0; i < MAX_SIGNALS; i++) {
    signals.push({ color: nextSignalColor(signals) });
  }
  assert.deepEqual(
    signals.map((s) => s.color),
    [...SIGNAL_COLORS, ...SIGNAL_COLORS.slice(0, MAX_SIGNALS - SIGNAL_COLORS.length)], // prettier-ignore
    "red, blue, green … purple, then red, blue, green again",
  );
  assert.equal(nextSignalColor([]), SIGNAL_COLORS[0]);
  assert.equal(nextSignalColor(null), SIGNAL_COLORS[0]);
});

test("nextSignalColor fills the gap a deleted signal left first", () => {
  // Mid-lap: the first colour nobody holds, not the one after the last.
  const three = SIGNAL_COLORS.slice(0, 3).map((color) => ({ color }));
  three.splice(1, 1); // delete the second
  assert.equal(nextSignalColor(three), SIGNAL_COLORS[1]);
  // Second lap: a colour down to zero uses beats every colour on one.
  const full = SIGNAL_COLORS.map((color) => ({ color }));
  full.push({ color: SIGNAL_COLORS[0] });
  full.splice(3, 1); // the fourth colour's only holder goes
  assert.equal(nextSignalColor(full), SIGNAL_COLORS[3]);
  // Junk and black count as nothing.
  assert.equal(nextSignalColor([{ color: "black" }, {}]), SIGNAL_COLORS[0]);
});

test("normalizeSignalFields keeps a duplicate colour and coerces the rest", () => {
  const fields = normalizeSignalFields(
    { color: "red", type: "nonsense", rest: "sideways" },
    [{ color: "red" }],
  );
  assert.equal(fields.color, "red", "two signals may share a colour");
  assert.equal(fields.type, "momentary");
  assert.equal(fields.rest, "low");
});

test("a stored BLACK signal is repaired into the gap, never rejected", () => {
  // Every project saved before black was withdrawn arrives needing this.
  const fields = normalizeSignalFields(
    { color: "black", type: "toggle", rest: "high" },
    [{ color: SIGNAL_COLORS[0] }],
  );
  assert.ok(fields, "the signal survives");
  assert.equal(fields.color, SIGNAL_COLORS[1], "the first colour not in use");
  assert.equal(fields.type, "toggle", "and nothing else about it moves");
  assert.equal(fields.rest, "high");
  assert.equal(normalizeSignalFields({}).color, SIGNAL_COLORS[0]);
});

test("railOrder is document order, and the keys index into it", () => {
  const signals = [{ id: "sig9" }, { id: "sig2" }, { id: "sig5" }];
  assert.deepEqual(
    railOrder(signals).map((s) => s.id),
    ["sig9", "sig2", "sig5"],
  );
  assert.equal(signalForKey(signals, "1").id, "sig9");
  assert.equal(signalForKey(signals, "3").id, "sig5");
  assert.equal(signalForKey(signals, "4"), null, "no button there");
  assert.equal(signalForKey(signals, "0"), null, "no tenth button");
  assert.equal(signalForKey(signals, "x"), null);
  assert.equal(signalKey(signals, "sig2"), "2");
  assert.equal(signalKey(signals, "nope"), null);
});

test("the tenth signal is key 0", () => {
  const signals = Array.from({ length: MAX_SIGNALS }, (_, i) => ({
    id: `sig${i + 1}`,
  }));
  assert.equal(signalKey(signals, "sig9"), "9");
  assert.equal(signalKey(signals, "sig10"), "0");
  assert.equal(signalForKey(signals, "0").id, "sig10");
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

test("the key sits mid-body, clear of the point, at every rotation", () => {
  const at = { x: 7, y: -3 };
  const round = (p) => ({
    x: Math.round(p.x * 1e6) / 1e6,
    y: Math.round(p.y * 1e6) / 1e6,
  });
  for (const rot of [0, 90, 180, 270]) {
    const poly = flagPolygon(at, rot);
    // The body rectangle is vertices 1–4; the key is its centre.
    const body = poly.slice(1);
    const centre = {
      x: body.reduce((n, p) => n + p.x, 0) / body.length,
      y: body.reduce((n, p) => n + p.y, 0) / body.length,
    };
    assert.deepEqual(round(flagKeyPoint(at, rot)), round(centre), `rot ${rot}`);
  }
});

test("the key's disc fits inside the body rectangle, clear of the point", () => {
  const bodyStart = flagPolygon({ x: 0, y: 0 }, 0)[1].x; // where the point ends
  const centre = flagKeyPoint({ x: 0, y: 0 }, 0);
  assert.ok(FLAG_KEY_R < FLAG_W / 2, "narrower than the body");
  assert.ok(centre.x - FLAG_KEY_R >= bodyStart, "never over the point");
  assert.ok(centre.x + FLAG_KEY_R <= FLAG_LEN, "never off the end");
});

test("R cycles the four quarter-turns and junk coerces to 0", () => {
  assert.deepEqual([0, 90, 180, 270].map(nextFlagRotation), [90, 180, 270, 0]);
  assert.equal(nextFlagRotation(45), 90);
  assert.equal(normalizeFlagRotation(45), 0);
  assert.equal(normalizeFlagRotation(270), 270);
});
