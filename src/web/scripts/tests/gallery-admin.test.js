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

// The maintainer's take-down tool (scripts/gallery-admin.mjs): its pure half —
// which files are an entry's, the tree that deletes them, the message.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deletionTree,
  entryBlobs,
  entryIds,
  removalMessage,
  seedNamed,
} from "../../../../scripts/gallery-admin.mjs";

const blob = (path, mode = "100644") => ({ path, mode, type: "blob", sha: "x" }); // prettier-ignore
const TREE = [
  blob("README.md"),
  { path: "entries", type: "tree", mode: "040000", sha: "t" },
  blob("entries/.gitkeep"),
  { path: "entries/clock-abcdef", type: "tree", mode: "040000", sha: "t" },
  blob("entries/clock-abcdef/entry.json"),
  blob("entries/clock-abcdef/design.desktop.chiphippo"),
  blob("entries/clock-abcdef-copy-123456/entry.json"),
  blob("entries/not_an_id/entry.json"),
];

test("an entry's blobs are its own folder's, never a neighbour sharing its prefix", () => {
  assert.deepEqual(
    entryBlobs(TREE, "clock-abcdef").map((b) => b.path),
    ["entries/clock-abcdef/entry.json", "entries/clock-abcdef/design.desktop.chiphippo"], // prettier-ignore
  );
  assert.deepEqual(entryBlobs(TREE, "gone-000000"), []);
});

test("the listed ids are the folders named as entry ids", () => {
  assert.deepEqual(entryIds(TREE), [
    "clock-abcdef",
    "clock-abcdef-copy-123456",
  ]);
});

test("the deletion tree nulls each blob on the base tree, keeping its mode", () => {
  const body = deletionTree("base", [blob("entries/a-000000/thumb.png", "100755")]); // prettier-ignore
  assert.deepEqual(body, {
    base_tree: "base",
    tree: [{ path: "entries/a-000000/thumb.png", mode: "100755", type: "blob", sha: null }], // prettier-ignore
  });
});

test("the commit names the entry, and a reason only when given", () => {
  assert.equal(removalMessage("clock-abcdef", "Clock", undefined), "Remove Clock (clock-abcdef)\n"); // prettier-ignore
  assert.equal(removalMessage("clock-abcdef", undefined, "spam"), "Remove clock-abcdef\n\nTaken down: spam\n"); // prettier-ignore
});

test("a seed is recognised, so it is never looked for in the repos", () => {
  const seed = JSON.parse(
    readFileSync(new URL("../../../../website/gallery/seed.json", import.meta.url), "utf8"), // prettier-ignore
  );
  const first = seed.entries[0];
  assert.equal(seedNamed(seed, first.id), first);
  assert.equal(seedNamed(seed, "nobody-000000"), null);
});
