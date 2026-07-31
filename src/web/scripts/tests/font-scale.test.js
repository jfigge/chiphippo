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

// font-scale.test.js — the Editor font size: the ladder, the arithmetic, the
// two ⌘ chords, and the one property it writes. No DOM: every export but
// `followFontSize` is pure, and `applyFontSize` takes its root as an argument
// precisely so a stub can stand in for one.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FONT_SIZES,
  DEFAULT_FONT_SIZE,
  normalizeFontSize,
  stepFontSize,
  scaleStepForEvent,
  applyFontSize,
} from "../font-scale.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A stand-in for `document.documentElement.style`, recording what it is told. */
function stubRoot() {
  const props = new Map();
  return {
    props,
    style: {
      setProperty: (k, v) => props.set(k, v),
      removeProperty: (k) => props.delete(k),
    },
  };
}

test("FONT_SIZES is a frozen, ascending, unique ladder holding the default", () => {
  assert.ok(Object.isFrozen(FONT_SIZES));
  assert.deepEqual([...FONT_SIZES], [11, 12, 13, 14, 16, 18]);
  assert.equal(new Set(FONT_SIZES).size, FONT_SIZES.length);
  for (let i = 1; i < FONT_SIZES.length; i++) {
    assert.ok(FONT_SIZES[i] > FONT_SIZES[i - 1], "ascending");
  }
  assert.ok(FONT_SIZES.includes(DEFAULT_FONT_SIZE));
});

test("the shipped default is the one theme.css declares", () => {
  // Two places state the size the app ships at — this constant and the
  // stylesheet the type scale is derived in. This is what stops them drifting.
  const css = fs.readFileSync(
    path.join(HERE, "..", "..", "styles", "theme.css"),
    "utf8",
  );
  const m = css.match(/^\s*--font-size:\s*(\d+)px;/m);
  assert.ok(m, "theme.css declares --font-size");
  assert.equal(Number(m[1]), DEFAULT_FONT_SIZE);
});

test("normalizeFontSize returns every legal step unchanged", () => {
  for (const px of FONT_SIZES) assert.equal(normalizeFontSize(px), px);
});

test("normalizeFontSize falls back only for what is not a number", () => {
  for (const junk of [undefined, null, NaN, {}, [], "abc", true, false]) {
    assert.equal(normalizeFontSize(junk), DEFAULT_FONT_SIZE, String(junk));
  }
  // A numeric string is a number that has been through JSON, not junk.
  assert.equal(normalizeFontSize("14"), 14);
});

test("normalizeFontSize REPAIRS an off-ladder value to the nearest step", () => {
  assert.equal(normalizeFontSize(14.6), 14);
  assert.equal(normalizeFontSize(15.4), 16);
  // The tie breaks UPWARD — the setting exists to make text readable, so a
  // value it cannot resolve must not resolve smaller.
  assert.equal(normalizeFontSize(15), 16);
  assert.equal(normalizeFontSize(17), 18);
});

test("normalizeFontSize clamps beyond either end", () => {
  assert.equal(normalizeFontSize(9), 11);
  assert.equal(normalizeFontSize(-3), 11);
  assert.equal(normalizeFontSize(72), 18);
});

test("stepFontSize walks the LIST, not the numbers", () => {
  assert.equal(stepFontSize(13, 1), 14);
  // 15 is not a step: proving the ladder drives this and not `+1`.
  assert.equal(stepFontSize(14, 1), 16);
  assert.equal(stepFontSize(16, -1), 14);
  assert.equal(stepFontSize(12, -1), 11);
});

test("stepFontSize saturates at both ends rather than wrapping", () => {
  assert.equal(stepFontSize(18, 1), 18);
  assert.equal(stepFontSize(11, -1), 11);
});

test("stepFontSize normalizes first, so an illegal start is defined", () => {
  assert.equal(stepFontSize(15, -1), 14); // 15 → 16, then down
  assert.equal(stepFontSize("junk", 1), 14); // → 13, then up
});

test("scaleStepForEvent: OPTION is the whole difference between the two scales", () => {
  // Bare ⌘ resizes the app's own text; ⌥⌘ zooms the desk camera. One modifier
  // apart, which is why one function decides both.
  const text = { metaKey: true, code: "Equal" };
  assert.deepEqual(scaleStepForEvent(text), { target: "font", step: "in" });
  assert.deepEqual(scaleStepForEvent({ ...text, altKey: true }), {
    target: "desk",
    step: "in",
  });
  assert.deepEqual(
    scaleStepForEvent({ ctrlKey: true, code: "Minus" }),
    { target: "font", step: "out" },
    "Ctrl stands in for Cmd off macOS",
  );
});

test("scaleStepForEvent: needs a mod, refuses Shift, ignores other keys", () => {
  const base = { metaKey: true, code: "Equal" };
  assert.equal(scaleStepForEvent({ ...base, metaKey: false }), null);
  assert.equal(scaleStepForEvent({ ...base, shiftKey: true }), null);
  assert.equal(scaleStepForEvent({ ...base, code: "KeyI" }), null);
  assert.equal(scaleStepForEvent({ code: "Equal" }), null, "bare = is not it");
  assert.equal(scaleStepForEvent(null), null);
});

test("scaleStepForEvent survives macOS rewriting e.key under Option", () => {
  // THE trap this function exists for, and it now guards the DESK pair: with
  // Option down macOS reports the alt-layout character, so the key NAME is
  // unusable and only `e.code` names the physical key. An `e.key` match would
  // make the whole chord dead.
  const mac = (code, key) => ({ metaKey: true, altKey: true, code, key });
  assert.deepEqual(scaleStepForEvent(mac("Equal", "≠")), { target: "desk", step: "in" }); // prettier-ignore
  assert.deepEqual(scaleStepForEvent(mac("Minus", "–")), { target: "desk", step: "out" }); // prettier-ignore
  assert.deepEqual(scaleStepForEvent(mac("Digit0", "º")), { target: "desk", step: "reset" }); // prettier-ignore
});

test("scaleStepForEvent takes the numpad and every key spelling", () => {
  const chord = (o) => scaleStepForEvent({ metaKey: true, ...o });
  assert.equal(chord({ code: "NumpadAdd" }).step, "in");
  assert.equal(chord({ code: "NumpadSubtract" }).step, "out");
  assert.equal(chord({ code: "Numpad0" }).step, "reset");
  assert.equal(chord({ key: "+" }).step, "in");
  assert.equal(chord({ key: "_" }).step, "out");
  assert.equal(chord({ key: "0" }).step, "reset");
});

test("applyFontSize writes the base of the scale, and REMOVES it at the default", () => {
  const root = stubRoot();
  assert.equal(applyFontSize(16, root), 16);
  assert.equal(root.props.get("--font-size"), "16px");

  // The default is the stylesheet's to state, so applying it clears the
  // override rather than restating the same number in a second place.
  assert.equal(applyFontSize(DEFAULT_FONT_SIZE, root), DEFAULT_FONT_SIZE);
  assert.equal(root.props.has("--font-size"), false);

  // Junk lands on the default, and therefore also clears.
  applyFontSize(18, root);
  assert.equal(applyFontSize("nonsense", root), DEFAULT_FONT_SIZE);
  assert.equal(root.props.has("--font-size"), false);
});

test("the derived ranks stay readable at the smallest base and distinct at the largest", () => {
  // Recomputes theme.css's own arithmetic, so a token edit that pushes a rank
  // under the readable floor — or flattens the ramp at the top, where this
  // setting is actually aimed — fails here rather than on someone's screen.
  const ranks = (base) => ({
    xs: Math.max(10, base - 2),
    sm: Math.max(11, base - 1),
    md: base,
    lg: base + 1,
    xl: base + 2,
  });
  for (const base of FONT_SIZES) {
    const r = ranks(base);
    assert.ok(r.xs >= 10, `xs stays readable at base ${base}`);
    assert.ok(r.xs <= r.sm && r.sm <= r.md, `ramp ascends at base ${base}`);
  }
  assert.deepEqual(ranks(13), { xs: 11, sm: 12, md: 13, lg: 14, xl: 15 });
  const big = ranks(18);
  assert.ok(big.xs < big.sm && big.sm < big.md, "no flattening at the top");
});
