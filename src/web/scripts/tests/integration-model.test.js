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

// Tests for model/integration.js — the Arduino serial integration's pure
// vocabulary: field presets and shapes, pin roles, tag keys, edge detection,
// packing a value off the pins and unpacking one onto them, wire indices, and
// the tag glyph.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TRIGGER_EDGE,
  DROP_WIDTHS,
  MAX_ELEMENT_PINS,
  TRIGGER_EDGES,
  TRIGGER_KEY,
  connectionsUsed,
  edgeFired,
  elementIndex,
  elementKindOf,
  elementSeq,
  fieldSpans,
  hasTagKey,
  isAutoTrigger,
  normalizeElementFields,
  normalizeFields,
  packValue,
  parseTagId,
  pinCount,
  pinRole,
  presetFields,
  tagId,
  tagKeys,
  tagLabelPoint,
  tagPolygon,
  TAG_KEY_R,
  TAG_LEN,
  TAG_W,
  triggerGlyph,
  unpackLevels,
} from "../model/integration.js";
import {
  FLAG_KEY_R,
  FLAG_LEN,
  FLAG_W,
  flagKeyPoint,
  flagPolygon,
  SIGNAL_COLORS,
} from "../model/signals.js";

test("ids say their kind and their sequence", () => {
  assert.equal(elementKindOf("out3"), "output");
  assert.equal(elementKindOf("in12"), "input");
  assert.equal(elementKindOf("sig1"), null);
  assert.equal(elementKindOf("out0"), null);
  assert.equal(elementSeq("in7"), 7);
  assert.equal(elementSeq("bogus"), null);
});

test("drop-time widths are presets: 1/2/4 bits, 8 a byte, 16 a word", () => {
  assert.deepEqual(DROP_WIDTHS, [1, 2, 4, 8, 16]);
  assert.deepEqual(
    presetFields(4).map((f) => f.type),
    ["bit", "bit", "bit", "bit"],
  );
  assert.deepEqual(presetFields(8), [{ type: "byte", name: "value" }]);
  assert.deepEqual(presetFields(16), [{ type: "word", name: "value" }]);
  for (const w of DROP_WIDTHS) assert.equal(pinCount(presetFields(w)), w);
  assert.equal(pinCount(presetFields(99)), 1, "junk falls back to one bit");
});

test("normalizeFields keeps a mixed list, caps at 16 pins, never empties", () => {
  const mixed = normalizeFields([
    { type: "byte", name: "data" },
    { type: "bit", name: " strobe " },
    { type: "bit", name: "" },
    { type: "nibble", name: "x" },
    null,
  ]);
  assert.deepEqual(mixed, [
    { type: "byte", name: "data" },
    { type: "bit", name: "strobe" },
    { type: "bit", name: "bit9" },
  ]);
  const over = normalizeFields([
    { type: "word", name: "a" },
    { type: "bit", name: "b" },
  ]);
  assert.equal(pinCount(over), MAX_ELEMENT_PINS, "the bit past 16 pins goes");
  assert.deepEqual(normalizeFields([]), presetFields(1));
  assert.deepEqual(normalizeFields("junk"), presetFields(1));
});

test("fieldSpans and pinRole say what each pin number means", () => {
  const fields = [
    { type: "byte", name: "data" },
    { type: "bit", name: "strobe" },
  ];
  assert.deepEqual(fieldSpans(fields), [
    { type: "byte", name: "data", first: 1, last: 8 },
    { type: "bit", name: "strobe", first: 9, last: 9 },
  ]);
  assert.deepEqual(pinRole(fields, 3), {
    field: 0,
    name: "data",
    type: "byte",
    bit: 2,
  });
  assert.equal(pinRole(fields, 9).name, "strobe");
  assert.equal(pinRole(fields, 10), null);
});

test("tag keys run 1…N then the trigger, and composite ids round-trip", () => {
  const element = { fields: presetFields(4) };
  assert.deepEqual(tagKeys(element), ["1", "2", "3", "4", TRIGGER_KEY]);
  assert.ok(hasTagKey(element, "4"));
  assert.ok(!hasTagKey(element, "5"));
  assert.ok(hasTagKey(element, "T"));
  assert.equal(tagId("out2", "16"), "out2:16");
  assert.deepEqual(parseTagId("out2:16"), { elementId: "out2", key: "16" });
  assert.deepEqual(parseTagId("in1:T"), { elementId: "in1", key: "T" });
  assert.equal(parseTagId("out2"), null);
});

test("an element on Auto has pin tags and no trigger tag", () => {
  const element = { fields: presetFields(2), triggerEdge: "auto" };
  assert.ok(isAutoTrigger(element));
  assert.deepEqual(tagKeys(element), ["1", "2"]);
  assert.ok(hasTagKey(element, "2"));
  assert.ok(!hasTagKey(element, TRIGGER_KEY));
  assert.ok(!isAutoTrigger({ triggerEdge: "rising" }));
});

test("Auto leads the trigger choices; an Output defaults to Rising, an Input to Auto", () => {
  assert.deepEqual(TRIGGER_EDGES, ["auto", "rising", "falling", "either"]);
  assert.deepEqual(DEFAULT_TRIGGER_EDGE, { output: "rising", input: "auto" });
  // The kind comes off the id when there is one, never a field beside it…
  assert.equal(normalizeElementFields({ id: "in3" }).triggerEdge, "auto");
  assert.equal(
    normalizeElementFields({ id: "out3", kind: "input" }).triggerEdge,
    "rising",
  );
  // …and off `kind` for an element still being minted.
  assert.equal(normalizeElementFields({ kind: "input" }).triggerEdge, "auto");
  assert.equal(
    normalizeElementFields({ id: "in3", triggerEdge: "sideways" }).triggerEdge,
    "auto",
    "junk takes the kind's default",
  );
  assert.equal(
    normalizeElementFields({ id: "in3", triggerEdge: "rising" }).triggerEdge,
    "rising",
  );
});

test("element fields normalize, repairing a colour rather than refusing it", () => {
  const n = normalizeElementFields({ color: "black" }, [{ color: "red" }]);
  assert.ok(SIGNAL_COLORS.includes(n.color));
  assert.notEqual(n.color, "black");
  assert.equal(n.connection, null);
  assert.equal(n.triggerEdge, "rising");
  assert.equal(n.triggerInit, "low");
  const kept = normalizeElementFields({
    color: "blue",
    connection: "nano",
    triggerEdge: "either",
    triggerInit: "high",
  });
  assert.equal(kept.color, "blue");
  assert.equal(kept.connection, "nano");
  assert.equal(kept.triggerEdge, "either");
  assert.equal(kept.triggerInit, "high");
});

test("edgeFired: rising, falling, either — and no change is never an edge", () => {
  assert.equal(edgeFired("rising", false, true), true);
  assert.equal(edgeFired("rising", true, false), false);
  assert.equal(edgeFired("falling", true, false), true);
  assert.equal(edgeFired("falling", false, true), false);
  assert.equal(edgeFired("either", false, true), true);
  assert.equal(edgeFired("either", true, false), true);
  for (const e of ["rising", "falling", "either"]) {
    assert.equal(edgeFired(e, true, true), false);
    assert.equal(edgeFired(e, false, false), false);
  }
  // Auto watches no line: no transition is its edge.
  assert.equal(edgeFired("auto", false, true), false);
  assert.equal(edgeFired("auto", true, false), false);
});

test("packValue is right-aligned: pin 1 is bit 0", () => {
  const fields = [
    { type: "byte", name: "data" },
    { type: "bit", name: "strobe" },
  ];
  const high = new Set([1, 3, 9]);
  assert.deepEqual(
    packValue(fields, (pin) => high.has(pin)),
    {
      width: 9,
      value: 0b1_0000_0101,
    },
  );
});

test("unpackLevels drives exactly the element's pins", () => {
  const levels = unpackLevels(4, 0b1010);
  assert.deepEqual(
    [...levels],
    [
      [1, "L"],
      [2, "H"],
      [3, "L"],
      [4, "H"],
    ],
  );
});

test("an element's wire index counts its connection's elements of its kind", () => {
  const elements = [
    { id: "out1", kind: "output", connection: "a" },
    { id: "in1", kind: "input", connection: "a" },
    { id: "out2", kind: "output", connection: "b" },
    { id: "out3", kind: "output", connection: "a" },
  ];
  assert.equal(elementIndex(elements, elements[0]), 0);
  assert.equal(elementIndex(elements, elements[1]), 0);
  assert.equal(elementIndex(elements, elements[2]), 0);
  assert.equal(elementIndex(elements, elements[3]), 1);
  assert.deepEqual(connectionsUsed(elements), ["a", "b"]);
});

test("the tag IS a signal flag: the same glyph, point at the anchor", () => {
  assert.equal(TAG_W, FLAG_W, "one width for every lead from the bench");
  assert.equal(TAG_LEN, FLAG_LEN);
  assert.equal(TAG_KEY_R, FLAG_KEY_R, "one plate for a pin and a key");
  for (const rot of [0, 90, 180, 270]) {
    const at = { x: 7, y: 3 };
    assert.deepEqual(tagPolygon(at, rot), flagPolygon(at, rot), `rot ${rot}`);
    assert.deepEqual(tagLabelPoint(at, rot), flagKeyPoint(at, rot));
  }
  const poly = tagPolygon({ x: 10, y: 5 }, 0);
  assert.deepEqual(poly[0], { x: 10, y: 5 });
  const ys = poly.map((p) => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) <= TAG_W + 1e-9);
  // Turned a quarter, the body hangs below the point and the label follows.
  const down = tagPolygon({ x: 0, y: 0 }, 90);
  assert.ok(down.every((p) => p.y >= -1e-9));
  const label = tagLabelPoint({ x: 0, y: 0 }, 90);
  assert.ok(Math.abs(label.x) < 1e-9 && label.y > 0);
});

test("the trigger tag prints its edge as a glyph", () => {
  assert.equal(triggerGlyph("rising"), "↑");
  assert.equal(triggerGlyph("falling"), "↓");
  assert.equal(triggerGlyph("either"), "↕");
});
