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

// Bus-name grammar (Feature 130): `D[7:0]` / `A[0:15]` / a bare name, and the
// bit-number-per-member order the pin-tap wires by.

import test from "node:test";
import assert from "node:assert/strict";

import { parseBusName, MAX_BUS_WIDTH } from "../model/desk-doc.js";

test("D[7:0] is a width-8, msb-first bus", () => {
  const p = parseBusName("D[7:0]");
  assert.equal(p.base, "D");
  assert.equal(p.width, 8);
  assert.equal(p.hi, 7);
  assert.equal(p.lo, 0);
  assert.equal(p.order, "desc");
  // member 0 carries bit 7 (the msb) → a pin-tap wires it to the high pin.
  assert.deepEqual(p.bits, [7, 6, 5, 4, 3, 2, 1, 0]);
});

test("A[0:15] is a width-16, lsb-first bus", () => {
  const p = parseBusName("A[0:15]");
  assert.equal(p.width, 16);
  assert.equal(p.order, "asc");
  assert.equal(p.bits[0], 0);
  assert.equal(p.bits[15], 15);
});

test("a bare name is a degenerate width-1 bus", () => {
  const p = parseBusName("CLK");
  assert.equal(p.base, "CLK");
  assert.equal(p.width, 1);
  assert.deepEqual(p.bits, [0]);
});

test("[3:3] is a single-bit slice", () => {
  const p = parseBusName("Q[3:3]");
  assert.equal(p.width, 1);
  assert.deepEqual(p.bits, [3]);
});

test("whitespace inside the brackets is tolerated", () => {
  assert.equal(parseBusName("D[ 7 : 0 ]").width, 8);
});

test("junk and over-wide names are rejected", () => {
  assert.equal(parseBusName(""), null);
  assert.equal(parseBusName("   "), null);
  assert.equal(parseBusName(42), null);
  assert.equal(parseBusName(null), null);
  // A width past the guard would try to lay too many wires.
  assert.equal(parseBusName(`D[${MAX_BUS_WIDTH}:0]`), null); // width MAX+1
  assert.ok(parseBusName(`D[${MAX_BUS_WIDTH - 1}:0]`)); // width MAX — ok
});
