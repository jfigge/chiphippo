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
 * file (Features 180/190). Only NON-VOLATILE chips (ROM / EPROM / EEPROM) are
 * file-backed; the file is a `.bin` sidecar in the app working folder keyed by a
 * per-chip GUID (main maps the GUID to a path — this module is purely
 * path-oriented and byte-oriented, so it's testable against a temp dir). Writes
 * go through io.js atomic primitives, so a crash mid-op never leaves a half-
 * written `.bin`.
 *
 * - create(path, byteLength)     → create the file at EXACTLY byteLength bytes
 *                                  of random noise IF it's missing (an
 *                                  unprogrammed chip reads garbage, like real
 *                                  hardware); an existing file is left untouched.
 * - load(path, byteLength)       → a Buffer of exactly byteLength (padded /
 *                                  truncated).
 * - program(path, bytes, len)    → the in-app "external programmer": copy an
 *                                  image to the START of the file, keeping the
 *                                  rest — short files write a prefix, long files
 *                                  are truncated.
 * - writeAll(path, bytes)        → overwrite the whole file (inspector Save).
 * - remove(path)                 → delete the file (chip removed).
 *
 * The document stores only the GUID; the bytes are this sidecar, so a
 * `.chiphippo` stays small and text.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
 * Create the backing file at exactly `byteLength` bytes of random noise when it
 * does NOT already exist — an unprogrammed ROM reads garbage, like real silicon,
 * never clean zeros. An existing file is left exactly as it was (its programmed
 * contents survive). Returns whether a fresh file was written.
 *
 * @param {string} filePath
 * @param {number} byteLength
 * @returns {{ created: boolean }}
 */
function create(filePath, byteLength) {
  const resolved = resolvePath(filePath);
  const len = coerceLength(byteLength);
  if (fs.existsSync(resolved)) return { created: false };
  io.atomicWrite(resolved, crypto.randomBytes(len));
  return { created: true };
}

/**
 * Read the file into a Buffer of exactly `byteLength` bytes: its bytes up to
 * that length, zero-padded past the end (or all-zero when absent).
 *
 * @param {string} filePath
 * @param {number} byteLength
 * @returns {Buffer}
 */
function load(filePath, byteLength) {
  const resolved = resolvePath(filePath);
  const len = coerceLength(byteLength);
  const out = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(resolved, "r");
  } catch (err) {
    if (err.code === "ENOENT") return out; // absent → all zeros
    throw err;
  }
  // Read AT MOST `len` bytes straight into the pre-sized buffer rather than
  // slurping the whole file: a tampered/corrupt sidecar of arbitrary size must
  // not be pulled into memory just to return a small chip-sized view. A shorter
  // file leaves the tail zero-filled (Buffer.alloc); a longer one is ignored.
  try {
    fs.readSync(fd, out, 0, len, 0);
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/**
 * The in-app external programmer: copy `bytes` (a `.bin`/`.hex` image the
 * renderer already decoded) to the START of the file, keeping any bytes past
 * the image intact. A shorter image writes only its prefix; a longer image is
 * truncated to the memory size. Atomic. Returns what actually happened so the
 * caller can warn on a size mismatch.
 *
 * @param {string} filePath
 * @param {number[]|Uint8Array|Buffer} bytes
 * @param {number} byteLength  the chip's memory size in bytes
 * @returns {{ written: number, imageLength: number, memLength: number,
 *   truncated: boolean, short: boolean }}
 */
function program(filePath, bytes, byteLength) {
  const resolved = resolvePath(filePath);
  const len = coerceLength(byteLength);
  // A too-long image is normally truncated to the chip size (below), but reject
  // one past the cap BEFORE Buffer.from allocates, so a bogus renderer array
  // can't force an unbounded allocation.
  const srcLen = bytes?.length ?? 0;
  if (srcLen > MAX_BYTES) {
    const err = new Error(`memory image too large: ${srcLen} bytes`);
    err.code = "INVALID_ARG";
    throw err;
  }
  const image = Buffer.from(bytes ?? []);
  const buf = load(resolved, len); // keep whatever is past the image
  const written = Math.min(image.length, len);
  image.copy(buf, 0, 0, written);
  io.atomicWrite(resolved, buf);
  return {
    written,
    imageLength: image.length,
    memLength: len,
    truncated: image.length > len,
    short: image.length < len,
  };
}

/**
 * Overwrite the whole file with `bytes` (inspector Save). Atomic. Returns the
 * resolved path written.
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

/**
 * Delete the backing file (its chip was removed). Missing is not an error.
 * @param {string} filePath
 * @returns {{ removed: boolean }}
 */
function remove(filePath) {
  const resolved = resolvePath(filePath);
  try {
    fs.unlinkSync(resolved);
    return { removed: true };
  } catch (err) {
    if (err.code === "ENOENT") return { removed: false };
    throw err;
  }
}

module.exports = { create, load, program, writeAll, remove };
