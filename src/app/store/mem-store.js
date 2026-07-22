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

/**
 * mem-store.js — the main-process byte store behind a memory chip's backing
 * file (Feature 180). Everything here is BYTE-oriented: the renderer's
 * SimController packs/unpacks 8- or 16-bit words to/from byte offsets, so this
 * module never needs to know a chip's data width. All three operations go
 * through io.js atomic primitives, so a crash mid-run can never leave a half-
 * written `.bin`.
 *
 * - load(path, byteLength)     → a Buffer of exactly byteLength (zero-padded /
 *                                truncated), or throws on an unreadable file.
 * - flush(path, writes, len)   → read-modify-write a batch of { addr, value }
 *                                byte writes back to the file (atomic).
 * - writeAll(path, bytes)      → overwrite the whole file (Save / Export).
 *
 * The document stores only the binding (a path + a rom/ram mode); the bytes are
 * this sidecar file, so a `.chiphippo` stays small and text.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const io = require("./io");

/** The largest backing file we'll allocate in one buffer (guards a bad size). */
const MAX_BYTES = 1 << 24; // 16 MiB — far above any modelled memory

/** Coerce/validate a caller-supplied path to a non-empty absolute string. */
function resolvePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    const err = new Error("memory file path must be a non-empty string");
    err.code = "INVALID_ARG";
    throw err;
  }
  return path.resolve(filePath);
}

/** Coerce a byte length to a sane integer in [0, MAX_BYTES]. */
function coerceLength(byteLength) {
  const n = Math.floor(Number(byteLength));
  if (!Number.isFinite(n) || n < 0 || n > MAX_BYTES) {
    const err = new Error(`invalid memory byte length: ${byteLength}`);
    err.code = "INVALID_ARG";
    throw err;
  }
  return n;
}

/**
 * Read the file into a Buffer of exactly `byteLength` bytes: the file's bytes
 * up to that length, zero-padded past the end (or a fully-zero buffer when the
 * file is absent — a fresh, never-written binding is not an error).
 *
 * @param {string} filePath
 * @param {number} byteLength
 * @returns {Buffer}
 */
function load(filePath, byteLength) {
  const resolved = resolvePath(filePath);
  const len = coerceLength(byteLength);
  const out = Buffer.alloc(len);
  let raw;
  try {
    raw = fs.readFileSync(resolved);
  } catch (err) {
    if (err.code === "ENOENT") return out; // unwritten binding → all zeros
    throw err;
  }
  raw.copy(out, 0, 0, Math.min(raw.length, len));
  return out;
}

/**
 * Apply a batch of byte writes to the file atomically (read-modify-write). The
 * on-disk file is grown/truncated to `byteLength` so it always matches the
 * chip's address space; out-of-range writes are ignored. The IPC payload is
 * only the dirty bytes since the last flush — the whole image is never streamed.
 *
 * @param {string} filePath
 * @param {Array<{addr:number,value:number}>} writes
 * @param {number} byteLength
 */
function flush(filePath, writes, byteLength) {
  const resolved = resolvePath(filePath);
  const len = coerceLength(byteLength);
  const buf = load(resolved, len); // current contents, sized to byteLength
  for (const w of writes ?? []) {
    const addr = Math.floor(Number(w?.addr));
    if (!Number.isInteger(addr) || addr < 0 || addr >= len) continue;
    buf[addr] = Number(w.value) & 0xff;
  }
  io.atomicWrite(resolved, buf);
  return resolved;
}

/**
 * Overwrite the whole file with `bytes` (an Array/Uint8Array/Buffer). Used by
 * the inspector's Save and Export (Feature 190) — a full image write, still
 * atomic. Returns the resolved path written.
 *
 * @param {string} filePath
 * @param {number[]|Uint8Array|Buffer} bytes
 */
function writeAll(filePath, bytes) {
  const resolved = resolvePath(filePath);
  const buf = Buffer.from(bytes ?? []);
  if (buf.length > MAX_BYTES) {
    const err = new Error(`memory image too large: ${buf.length} bytes`);
    err.code = "INVALID_ARG";
    throw err;
  }
  io.atomicWrite(resolved, buf);
  return resolved;
}

module.exports = { load, flush, writeAll };
