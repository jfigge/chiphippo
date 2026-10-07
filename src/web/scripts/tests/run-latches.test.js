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

// run-latches.test.js — the params a run writes into the document
// (catalog/run-latches.js): every latchable part keeps them through its
// normalizer, and every road into a desk strips them.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RUN_LATCHES,
  dropRunLatches,
  keepRunLatches,
} from "../catalog/run-latches.js";
import { PALETTE_DEFS, partDef } from "../catalog/index.js";

test("the latches: 12 V's magic smoke and Spice Lite's brown smoke", () => {
  assert.deepEqual([...RUN_LATCHES], ["damaged", "overloaded"]);
  assert.ok(Object.isFrozen(RUN_LATCHES));
});

test("keepRunLatches carries each latch only when it is exactly true", () => {
  assert.deepEqual(keepRunLatches({ damaged: true, overloaded: true }, {}), {
    damaged: true,
    overloaded: true,
  });
  assert.deepEqual(
    keepRunLatches({ damaged: "yes", overloaded: 1, other: true }, { a: 1 }),
    { a: 1 },
  );
  assert.deepEqual(keepRunLatches(null, { a: 1 }), { a: 1 });
  const params = {};
  assert.equal(
    keepRunLatches({ overloaded: true }, params),
    params,
    "in place",
  );
});

test("dropRunLatches strips every latch in place and nothing else", () => {
  const params = { damaged: true, overloaded: true, rot: 90 };
  assert.equal(dropRunLatches(params), params);
  assert.deepEqual(params, { rot: 90 });
});

test("every chip's normalizer keeps both latches", () => {
  // A latch a normalizer drops never holds: the next tick's write is undone.
  for (const def of PALETTE_DEFS) {
    if (def.kind !== "chip") continue;
    const params = partDef(def.id).normalizeParams({
      damaged: true,
      overloaded: true,
    });
    for (const key of RUN_LATCHES) {
      assert.equal(params[key], true, `${def.id} keeps ${key}`);
    }
  }
});
