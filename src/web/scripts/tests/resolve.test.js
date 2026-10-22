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

import { H, L, Z, X, OC_X } from "../sim/levels.js";
import { resolveNet } from "../sim/resolve.js";

test("supply beats chip outputs; + → H, − → L — and an output fighting it says so", () => {
  assert.deepEqual(resolveNet({ supplyPlus: true, chipLevels: [L] }), {
    level: H,
    warning: "conflict",
  });
  assert.deepEqual(resolveNet({ supplyMinus: true, chipLevels: [H] }), {
    level: L,
    warning: "conflict",
  });
  // One agreeing with it (an output tied to its own level) is no fight.
  assert.deepEqual(resolveNet({ supplyPlus: true, chipLevels: [H, Z, X] }), {
    level: H,
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
  // A Z pull is nothing; an X pull is an unknown level arriving through a
  // resistor — unknown, not floating (2026-10-22) — where nothing definite
  // pulls beside it: against an H it was a feedback loop's own X, which
  // latched the loop X for good.
  assert.deepEqual(resolveNet({ pullLevels: [Z] }), { level: Z });
  assert.deepEqual(resolveNet({ pullLevels: [Z, X] }), { level: X });
  assert.deepEqual(resolveNet({ pullLevels: [H, X] }), { level: H });
  assert.deepEqual(resolveNet({ pullLevels: [L, X, X] }), { level: L });
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

test("an open-collector output that may sink: a LOW beside it wins, anything else is X", () => {
  // A wired-AND: any LOW pulls it down, so an unknown open-collector output
  // (it sinks, or it lets go) changes nothing there. It fought it as an X.
  assert.deepEqual(resolveNet({ chipLevels: [OC_X, L] }), { level: L });
  assert.deepEqual(resolveNet({ chipLevels: [OC_X], pullLevels: [H] }), {
    level: X,
  });
  assert.deepEqual(resolveNet({ chipLevels: [OC_X, H] }), { level: X });
  assert.deepEqual(resolveNet({ chipLevels: [OC_X, Z] }), { level: X });
  // …and a rail decides as ever, with nothing certain to fight it.
  assert.deepEqual(resolveNet({ supplyPlus: true, chipLevels: [OC_X] }), {
    level: H,
  });
});
