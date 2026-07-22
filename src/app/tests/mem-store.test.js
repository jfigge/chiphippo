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

// Tests for mem-store.js — the main-process byte store behind a memory chip's
// backing file (Feature 180). load() pads/truncates to size; flush() applies a
// sparse batch atomically (no temp file left behind); writeAll() overwrites.

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

test("load() of a missing file returns a zero-filled buffer of the size", () => {
  const dir = tempDir();
  const buf = mem.load(path.join(dir, "absent.bin"), 8);
  assert.equal(buf.length, 8);
  assert.ok(buf.every((b) => b === 0));
});

test("load() zero-pads a short file up to the requested size", () => {
  const dir = tempDir();
  const file = path.join(dir, "short.bin");
  fs.writeFileSync(file, Buffer.from([1, 2, 3]));
  const buf = mem.load(file, 6);
  assert.deepEqual([...buf], [1, 2, 3, 0, 0, 0]);
});

test("load() truncates a file longer than the requested size", () => {
  const dir = tempDir();
  const file = path.join(dir, "long.bin");
  fs.writeFileSync(file, Buffer.from([1, 2, 3, 4, 5, 6]));
  const buf = mem.load(file, 4);
  assert.deepEqual([...buf], [1, 2, 3, 4]);
});

test("flush() applies a sparse byte batch and sizes the file to byteLength", () => {
  const dir = tempDir();
  const file = path.join(dir, "scratch.bin");
  mem.flush(
    file,
    [
      { addr: 0, value: 0xaa },
      { addr: 3, value: 0xff },
    ],
    4,
  );
  assert.deepEqual([...fs.readFileSync(file)], [0xaa, 0, 0, 0xff]);
});

test("flush() is read-modify-write: it preserves existing bytes", () => {
  const dir = tempDir();
  const file = path.join(dir, "rmw.bin");
  fs.writeFileSync(file, Buffer.from([10, 20, 30, 40]));
  mem.flush(file, [{ addr: 1, value: 99 }], 4);
  assert.deepEqual([...fs.readFileSync(file)], [10, 99, 30, 40]);
});

test("flush() ignores out-of-range and masks the value to a byte", () => {
  const dir = tempDir();
  const file = path.join(dir, "range.bin");
  mem.flush(
    file,
    [
      { addr: -1, value: 5 },
      { addr: 2, value: 0x1ff }, // masks to 0xff
      { addr: 99, value: 7 }, // beyond size → dropped
    ],
    4,
  );
  assert.deepEqual([...fs.readFileSync(file)], [0, 0, 0xff, 0]);
});

test("flush() leaves no temp file behind (atomic rename)", () => {
  const dir = tempDir();
  const file = path.join(dir, "atomic.bin");
  mem.flush(file, [{ addr: 0, value: 1 }], 4);
  const leftover = fs.readdirSync(dir).filter((n) => isTempFileName(n));
  assert.deepEqual(leftover, []);
});

test("writeAll() overwrites the whole file with the given bytes", () => {
  const dir = tempDir();
  const file = path.join(dir, "full.bin");
  fs.writeFileSync(file, Buffer.from([9, 9, 9, 9, 9]));
  mem.writeAll(file, Uint8Array.from([1, 2, 3]));
  assert.deepEqual([...fs.readFileSync(file)], [1, 2, 3]);
});

test("a blank path is rejected with INVALID_ARG", () => {
  assert.throws(
    () => mem.load("", 4),
    (e) => e.code === "INVALID_ARG",
  );
  assert.throws(
    () => mem.flush("   ", [], 4),
    (e) => e.code === "INVALID_ARG",
  );
});
