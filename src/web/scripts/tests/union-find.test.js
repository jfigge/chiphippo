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

// Tests for the disjoint-set forest (sim/union-find.js).

import test from "node:test";
import assert from "node:assert/strict";

import { UnionFind } from "../sim/union-find.js";

test("find: unseen keys are their own singleton", () => {
  const uf = new UnionFind();
  assert.equal(uf.find("a"), "a");
  assert.equal(uf.find("b"), "b");
  assert.deepEqual(uf.keys().sort(), ["a", "b"]);
});

test("union merges sets; find agrees on a representative", () => {
  const uf = new UnionFind();
  uf.union("a", "b");
  uf.union("b", "c");
  assert.equal(uf.find("a"), uf.find("c"));
  uf.union("x", "y");
  assert.notEqual(uf.find("a"), uf.find("x"));
});

test("union is idempotent and order-independent", () => {
  const uf = new UnionFind();
  uf.union("a", "b");
  uf.union("b", "a");
  uf.union("a", "b");
  const groups = uf.groups();
  assert.equal(groups.size, 1);
  assert.deepEqual([...groups.values()][0].sort(), ["a", "b"]);
});

test("groups: every key present exactly once, grouped by root", () => {
  const uf = new UnionFind();
  for (const k of ["a", "b", "c", "d", "e"]) uf.add(k);
  uf.union("a", "b");
  uf.union("c", "d");
  const groups = uf.groups();
  const sizes = [...groups.values()].map((g) => g.length).sort();
  assert.deepEqual(sizes, [1, 2, 2]); // {a,b} {c,d} {e}
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  assert.equal(total, 5);
});

test("large chains stay linear (path compression sanity)", () => {
  const uf = new UnionFind();
  for (let i = 0; i < 10000; i++) uf.union(`n${i}`, `n${i + 1}`);
  assert.equal(uf.find("n0"), uf.find("n10000"));
  assert.equal(uf.groups().size, 1);
});
