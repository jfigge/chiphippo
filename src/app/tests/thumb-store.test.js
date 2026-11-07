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

/**
 * tests/thumb-store.test.js — the recent projects' pictures: kept under a
 * hash of the path (never the path), only a real PNG, read back as a data:
 * URL with the desktop count, and pruned to the MRU list.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  MAX_THUMB_BYTES,
  thumbKey,
  writeThumb,
  readThumb,
  pruneThumbs,
} = require("../store/thumb-store");

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("not really the rest of a png"),
]);

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "thumbs-"));

test("a picture is kept under the path's hash and read back as a data: URL", () => {
  const dir = tmpDir();
  assert.equal(
    writeThumb(dir, "/home/clock.chiphippo", PNG, { desktops: 3 }),
    true,
  );
  const names = fs.readdirSync(dir).sort();
  const key = thumbKey("/home/clock.chiphippo");
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(names, [`${key}.json`, `${key}.png`]);
  assert.ok(!names.some((n) => n.includes("clock")), "no path in a file name");
  const { thumb, desktops } = readThumb(dir, "/home/clock.chiphippo");
  assert.equal(thumb, `data:image/png;base64,${PNG.toString("base64")}`);
  assert.equal(desktops, 3);
});

test("a project with no picture reads as nulls", () => {
  assert.deepEqual(readThumb(tmpDir(), "/nowhere.chiphippo"), {
    thumb: null,
    desktops: null,
  });
});

test("only a PNG, and only up to the cap, is kept", () => {
  const dir = tmpDir();
  assert.equal(writeThumb(dir, "/a.chiphippo", Buffer.from("GIF89a")), false);
  assert.equal(writeThumb(dir, "/a.chiphippo", "a string"), false);
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_THUMB_BYTES)]);
  assert.equal(writeThumb(dir, "/a.chiphippo", big), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a nonsense desktop count is not kept", () => {
  const dir = tmpDir();
  writeThumb(dir, "/a.chiphippo", PNG, { desktops: Number.NaN });
  assert.equal(readThumb(dir, "/a.chiphippo").desktops, null);
});

test("pruning keeps the listed projects' pictures and nothing that is not ours", () => {
  const dir = tmpDir();
  writeThumb(dir, "/keep.chiphippo", PNG);
  writeThumb(dir, "/gone.chiphippo", PNG);
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
  assert.equal(pruneThumbs(dir, ["/keep.chiphippo"]), 2);
  const key = thumbKey("/keep.chiphippo");
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    `${key}.json`,
    `${key}.png`,
    "notes.txt",
  ]);
  assert.equal(pruneThumbs(path.join(dir, "missing"), []), 0);
});
