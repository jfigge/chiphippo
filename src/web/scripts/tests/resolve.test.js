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

// Tests for single-net driver resolution (sim/resolve.js).

import test from "node:test";
import assert from "node:assert/strict";

import { H, L, Z, X } from "../sim/levels.js";
import { resolveNet } from "../sim/resolve.js";

test("supply beats chip outputs; + → H, − → L", () => {
  assert.deepEqual(resolveNet({ supplyPlus: true, chipLevels: [L] }), {
    level: H,
  });
  assert.deepEqual(resolveNet({ supplyMinus: true, chipLevels: [H] }), {
    level: L,
  });
});

test("opposing supplies are a short → X", () => {
  assert.deepEqual(resolveNet({ supplyPlus: true, supplyMinus: true }), {
    level: X,
    warning: "short",
  });
});

test("an undriven net floats (Z); Z drivers contribute nothing", () => {
  assert.deepEqual(resolveNet({}), { level: Z });
  assert.deepEqual(resolveNet({ chipLevels: [Z, Z] }), { level: Z });
});

test("agreeing chip outputs pass through; a lone X passes without conflict", () => {
  assert.deepEqual(resolveNet({ chipLevels: [H, Z, H] }), { level: H });
  assert.deepEqual(resolveNet({ chipLevels: [L] }), { level: L });
  assert.deepEqual(resolveNet({ chipLevels: [X, Z] }), { level: X });
});

test("disagreeing chip outputs → conflict (X)", () => {
  assert.deepEqual(resolveNet({ chipLevels: [H, L] }), {
    level: X,
    warning: "conflict",
  });
  assert.deepEqual(resolveNet({ chipLevels: [H, X] }), {
    level: X,
    warning: "conflict",
  });
});
