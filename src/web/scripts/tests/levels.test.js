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

// Tests for the signal-level vocabulary + ternary gate primitives.

import test from "node:test";
import assert from "node:assert/strict";

import {
  H,
  L,
  X,
  Z,
  and,
  asInput,
  buf3,
  inv,
  nand,
  nor,
  or,
  xor,
} from "../sim/levels.js";

test("asInput: a floating input (Z) reads HIGH; others pass through", () => {
  assert.equal(asInput(Z), H);
  assert.equal(asInput(H), H);
  assert.equal(asInput(L), L);
  assert.equal(asInput(X), X);
});

test("AND / OR: dominant value first, then X, then the default", () => {
  assert.equal(and(H, H), H);
  assert.equal(and(H, L), L);
  assert.equal(and(L, X), L); // L dominates
  assert.equal(and(H, X), X);
  assert.equal(or(L, L), L);
  assert.equal(or(H, L), H);
  assert.equal(or(H, X), H); // H dominates
  assert.equal(or(L, X), X);
});

test("NAND / NOR: the dominant input forces the result past X", () => {
  assert.equal(nand(H, H), L);
  assert.equal(nand(H, L), H);
  assert.equal(nand(L, X), H); // any L → H regardless of X
  assert.equal(nand(H, X), X);
  assert.equal(nor(L, L), H);
  assert.equal(nor(H, L), L);
  assert.equal(nor(H, X), L); // any H → L regardless of X
  assert.equal(nor(L, X), X);
});

test("XOR: parity, but any X is unknown (no dominant value)", () => {
  assert.equal(xor(H, L), H);
  assert.equal(xor(L, H), H);
  assert.equal(xor(H, H), L);
  assert.equal(xor(L, L), L);
  assert.equal(xor(H, X), X);
});

test("INV: H↔L and X stays X", () => {
  assert.equal(inv(H), L);
  assert.equal(inv(L), H);
  assert.equal(inv(X), X);
});

test("buf3: active-low enable drives, floats, or is unknown", () => {
  assert.equal(buf3(H, L), H); // enabled → passes data
  assert.equal(buf3(L, L), L);
  assert.equal(buf3(X, L), X); // enabled, unknown data
  assert.equal(buf3(H, H), Z); // disabled → high impedance
  assert.equal(buf3(H, X), X); // unknown enable
});
