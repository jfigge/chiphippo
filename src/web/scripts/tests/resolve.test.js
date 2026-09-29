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

test("a resistor pull decides an otherwise-floating net (weakest tier)", () => {
  // Nothing else driving → the pull wins (pull-up/pull-down).
  assert.deepEqual(resolveNet({ pullLevels: [H] }), { level: H });
  assert.deepEqual(resolveNet({ pullLevels: [L] }), { level: L });
  // Any supply or chip driver overrides a pull.
  assert.deepEqual(resolveNet({ supplyMinus: true, pullLevels: [H] }), {
    level: L,
  });
  assert.deepEqual(resolveNet({ chipLevels: [L], pullLevels: [H] }), {
    level: L,
  });
  // Only clean H/L pulls; Z/X pulls contribute nothing.
  assert.deepEqual(resolveNet({ pullLevels: [Z, X] }), { level: Z });
  // Opposing pulls (a divider across VCC↔GND) → weak indeterminate X, but NOT
  // a driver "conflict" (nothing is actually fighting at output strength).
  assert.deepEqual(resolveNet({ pullLevels: [H, L] }), { level: X });
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
