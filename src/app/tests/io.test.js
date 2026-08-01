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

// ── The Mac App Store write fallback ─────────────────────────────────────────
// A sandboxed build's grant on a user-chosen file does not extend to its
// folder, so the sibling temp file is denied and `atomicWrite` writes in place
// instead. Simulated here by taking write permission off the DIRECTORY while
// leaving it on the file — the same shape the sandbox produces (creating a new
// entry fails, writing the existing one succeeds), reachable without a signed
// build.

const canSimulateSandbox =
  process.platform !== "win32" && process.getuid?.() !== 0;

/** Run `fn` with process.mas forced, restoring it afterwards. */
function withMas(value, fn) {
  const had = "mas" in process ? process.mas : undefined;
  try {
    process.mas = value;
    fn();
  } finally {
    process.mas = had;
  }
}

/** A read-only directory holding one writable file, and its cleanup. */
function lockedDir() {
  const dir = tempDir();
  const file = path.join(dir, "doc.json");
  fs.writeFileSync(file, "old", "utf8");
  fs.chmodSync(dir, 0o500);
  return {
    file,
    cleanup() {
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  "atomicWrite: a direct build still throws when the temp cannot be made",
  {
    skip: !canSimulateSandbox && "needs POSIX permissions and a non-root user",
  },
  () => {
    const { file, cleanup } = lockedDir();
    try {
      withMas(undefined, () => {
        // Unchanged behaviour: no store build, no fallback, and the error is the
        // filesystem's own.
        assert.throws(() => io.atomicWrite(file, "new"), { code: "EACCES" });
        assert.equal(fs.readFileSync(file, "utf8"), "old");
      });
    } finally {
      cleanup();
    }
  },
);

test(
  "atomicWrite: a store build falls back to writing in place",
  {
    skip: !canSimulateSandbox && "needs POSIX permissions and a non-root user",
  },
  () => {
    const { file, cleanup } = lockedDir();
    try {
      withMas(true, () => {
        io.atomicWrite(file, "new bytes");
        assert.equal(fs.readFileSync(file, "utf8"), "new bytes");
      });
    } finally {
      cleanup();
    }
  },
);
