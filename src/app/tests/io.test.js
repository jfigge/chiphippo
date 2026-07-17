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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const io = require("../store/io");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-io-"));
}

test("writeJSON/readJSON round-trip a document", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "doc.json");
    io.writeJSON(file, { a: 1, nested: { b: [2, 3] } });
    assert.deepEqual(io.readJSON(file), { a: 1, nested: { b: [2, 3] } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readJSON: a missing file reads as null", () => {
  const dir = tempDir();
  try {
    assert.equal(io.readJSON(path.join(dir, "absent.json")), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readJSON: corrupt JSON is quarantined and reads as null", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "settings.json");
    fs.writeFileSync(file, "{ not json ///");
    assert.equal(io.readJSON(file), null);
    // The damaged bytes were moved aside, not deleted.
    assert.equal(fs.existsSync(file), false);
    const quarantined = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("settings.json.corrupt-"));
    assert.equal(quarantined.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJSON: refuses non-serializable input", () => {
  const dir = tempDir();
  try {
    assert.throws(() => io.writeJSON(path.join(dir, "x.json"), undefined));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWrite: leaves no temp files behind", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "out.txt");
    io.atomicWrite(file, "hello");
    assert.equal(fs.readFileSync(file, "utf8"), "hello");
    const leftovers = fs.readdirSync(dir).filter(io.isTempFileName);
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
