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

// Tests for mem-store.js — the main-process byte store behind a ROM chip's
// backing file (Features 180/190). create() fills a fresh file with noise sized
// exactly to the chip and never clobbers an existing one; program() copies an
// image to the START (prefix on short, truncate on long); writeAll overwrites;
// remove() deletes; all writes are atomic (no temp file left behind).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const mem = require("../store/mem-store");
const { isTempFileName } = require("../store/io");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-mem-"));
}
const noTemp = (dir) =>
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => isTempFileName(n)),
    [],
    "no temp file left behind",
  );

test("create() makes a file of EXACTLY the byte size, non-zero (noise)", () => {
  const dir = tempDir();
  const file = path.join(dir, "rom.bin");
  const { created } = mem.create(file, 4096);
  assert.equal(created, true);
  const buf = fs.readFileSync(file);
  assert.equal(buf.length, 4096, "exactly the requested size");
  assert.ok(
    buf.some((b) => b !== 0),
    "filled with noise, not zeros",
  );
  noTemp(dir);
});

test("create() never clobbers an existing file", () => {
  const dir = tempDir();
  const file = path.join(dir, "rom.bin");
  fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
  const { created } = mem.create(file, 4);
  assert.equal(created, false, "reports it did not create");
  assert.deepEqual(
    [...fs.readFileSync(file)],
    [1, 2, 3, 4],
    "contents untouched",
  );
});

test("load() pads / truncates to the byte size", () => {
  const dir = tempDir();
  const file = path.join(dir, "img.bin");
  fs.writeFileSync(file, Buffer.from([1, 2, 3]));
  assert.deepEqual([...mem.load(file, 5)], [1, 2, 3, 0, 0]);
  assert.deepEqual([...mem.load(file, 2)], [1, 2]);
});

test("program() copies a SHORT image to the start and keeps the tail", () => {
  const dir = tempDir();
  const file = path.join(dir, "rom.bin");
  fs.writeFileSync(file, Buffer.from([9, 9, 9, 9, 9, 9]));
  const info = mem.program(file, Uint8Array.from([1, 2, 3]), 6);
  assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3, 9, 9, 9]);
  assert.deepEqual(info, {
    written: 3,
    imageLength: 3,
    memLength: 6,
    truncated: false,
    short: true,
  });
  noTemp(dir);
});

test("program() truncates a LONG image to the memory size", () => {
  const dir = tempDir();
  const file = path.join(dir, "rom.bin");
  mem.create(file, 4);
  const info = mem.program(file, Uint8Array.from([1, 2, 3, 4, 5, 6]), 4);
  assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3, 4]);
  assert.equal(info.truncated, true);
  assert.equal(info.written, 4);
});

test("program() of an exact-size image reports no mismatch", () => {
  const dir = tempDir();
  const file = path.join(dir, "rom.bin");
  const info = mem.program(file, Uint8Array.from([1, 2, 3, 4]), 4);
  assert.equal(info.short, false);
  assert.equal(info.truncated, false);
});

test("writeAll() overwrites the whole file", () => {
  const dir = tempDir();
  const file = path.join(dir, "img.bin");
  fs.writeFileSync(file, Buffer.from([9, 9, 9, 9, 9]));
  mem.writeAll(file, Uint8Array.from([1, 2, 3]));
  assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3]);
});

test("remove() deletes the file; a missing file is not an error", () => {
  const dir = tempDir();
  const file = path.join(dir, "gone.bin");
  fs.writeFileSync(file, Buffer.from([1]));
  assert.deepEqual(mem.remove(file), { removed: true });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(
    mem.remove(file),
    { removed: false },
    "second remove is a no-op",
  );
});

test("a blank path is rejected with INVALID_ARG", () => {
  assert.throws(
    () => mem.load("", 4),
    (e) => e.code === "INVALID_ARG",
  );
  assert.throws(
    () => mem.create("   ", 4),
    (e) => e.code === "INVALID_ARG",
  );
});
