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

// Tests for model/ohm-format.js — the ONE way a resistance is printed.
//
// Every case below except the plain ones is a value the two private formatters
// this module replaced disagreed about; see its header for the table.

import test from "node:test";
import assert from "node:assert/strict";

import { formatOhms } from "../model/ohm-format.js";

test("the ordinary bench values, which both old copies already agreed on", () => {
  assert.equal(formatOhms(220), "220");
  assert.equal(formatOhms(330), "330");
  assert.equal(formatOhms(1000), "1k");
  assert.equal(formatOhms(4700), "4.7k");
  assert.equal(formatOhms(10000), "10k");
  assert.equal(formatOhms(47000), "47k");
});

test("a megohm is a megohm — the disagreement that prompted this module", () => {
  // The desk printed "1M" and the schematic "1000k" for the SAME resistor.
  assert.equal(formatOhms(1e6), "1M");
  assert.equal(formatOhms(4.7e6), "4.7M");
  assert.equal(formatOhms(1e9), "1G");
});

test("three significant figures, so a symbol never spills full precision", () => {
  // The schematic used to print "4.753k".
  assert.equal(formatOhms(4753), "4.75k");
  assert.equal(formatOhms(12345), "12.3k");
  assert.equal(formatOhms(123456), "123k");
});

test("ROUNDING CARRIES into the next prefix instead of printing 1000 of one", () => {
  // The desk formatter printed "1000k" here, which is not how anyone writes it.
  assert.equal(formatOhms(999999), "1M");
  assert.equal(formatOhms(999.9), "1k");
  assert.equal(formatOhms(999999999), "1G");
  // …and one promotion is always enough: the carried mantissa lands at ~1.
  assert.equal(formatOhms(999500), "1M");
});

test("a value with no prefix to promote INTO is left as it is", () => {
  // Past the top of the table there is nothing above "G" to carry into.
  assert.equal(formatOhms(1e12), "1000G");
});

test("sub-ohm values fall through to the bare step rather than off the end", () => {
  assert.equal(formatOhms(0.5), "0.5");
  assert.equal(formatOhms(4.7), "4.7");
});

test("a non-value prints NOTHING — never the word 'undefined' on a part", () => {
  // The desk formatter returned String(undefined) and drew it on the silkscreen.
  assert.equal(formatOhms(undefined), "");
  assert.equal(formatOhms(null), "");
  assert.equal(formatOhms(NaN), "");
  assert.equal(formatOhms(Infinity), "");
  assert.equal(formatOhms(-100), "");
  assert.equal(formatOhms(0), "");
});

test("no trailing zeros survive the rounding", () => {
  assert.equal(formatOhms(4700), "4.7k"); // not "4.70k"
  assert.equal(formatOhms(10000), "10k"); // not "10.0k"
  assert.equal(formatOhms(100), "100"); // not "100.00"
});
