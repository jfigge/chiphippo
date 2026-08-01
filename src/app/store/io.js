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
 * io.js — Low-level filesystem primitives for the main-process storage layer.
 *
 * All writes use a write-to-tmp-then-rename pattern for atomicity, with an
 * fsync of both the file and its directory so a rename survives a crash.
 * Writes are synchronous, which makes them inherently serialized in this
 * single-threaded process (there is no separate async write queue to reason
 * about).
 *
 * The ONE exception is a Mac App Store build writing to a file the user chose:
 * the sandbox denies the sibling temp file, so `atomicWrite` falls back to a
 * durable in-place write. See `sandboxDenied` below for why, and what it
 * costs.
 *
 * Ported from Port Hippo's storage layer (src/app/store/io.js); the schema
 * migrations hook arrives with Feature 20's desk-document store.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const { isMas } = require("../store-build");

// ── Directory helpers ─────────────────────────────────────────────────────────

/**
 * Ensure a directory (and parents) exist.
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Temp-file naming ──────────────────────────────────────────────────────────

/**
 * Distinctive infix marking write temp files. Real data files never contain
 * it, so cleanup can match orphans with no risk of touching real documents.
 */
const TEMP_INFIX = ".chiphippotmp-";

/** Suffix appended after the unique counter. */
const TEMP_SUFFIX = ".tmp";

/** Matches a temp file name produced by {@link tempPathFor}. */
const TEMP_FILE_RE = /\.chiphippotmp-\d+\.tmp$/;

/** Process-local monotonic counter keeping concurrent temp names unique. */
let tempCounter = 0;

/**
 * Build a unique temp path for an atomic write to `filePath`.
 * @param {string} filePath
 * @returns {string}
 */
function tempPathFor(filePath) {
  tempCounter += 1;
  return `${filePath}${TEMP_INFIX}${tempCounter}${TEMP_SUFFIX}`;
}

/**
 * @param {string} name A bare file name (not a full path).
 * @returns {boolean} True if `name` is one of our write temp files.
 */
function isTempFileName(name) {
  return TEMP_FILE_RE.test(name);
}

// ── Atomic write ──────────────────────────────────────────────────────────────

/**
 * Best-effort fsync of a directory so a rename into it survives a crash.
 *
 * Silently ignores platforms that disallow opening or fsyncing a directory
 * (notably Windows, where opening a directory throws EISDIR/EPERM). On POSIX
 * this is what makes a freshly-renamed file's *name* durable, not just its
 * contents.
 *
 * @param {string} dir
 */
function fsyncDir(dir) {
  let dirFd;
  try {
    dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
  } catch {
    /* directory fsync unsupported / not permitted — best effort */
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Block the current thread for `ms` — a rare Windows rename-retry backoff.
 * Atomics.wait times out (the value never changes) without spinning the CPU;
 * main-thread Atomics.wait is permitted in Node.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * renameSync, retried on Windows when the destination is transiently locked.
 * Windows refuses a rename over a file another handle holds open — antivirus
 * scanning the just-written temp, a search indexer, or the target mmap'd
 * elsewhere — with EPERM/EBUSY/EACCES; a short bounded backoff usually clears
 * it. POSIX renames atomically over an open destination, so this is win32-only
 * and leaves every other platform's behaviour byte-for-byte unchanged.
 */
function renameWithRetry(from, to) {
  if (process.platform !== "win32") {
    fs.renameSync(from, to);
    return;
  }
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const transient =
        err.code === "EPERM" || err.code === "EBUSY" || err.code === "EACCES";
      if (!transient || attempt >= MAX_ATTEMPTS - 1) throw err;
      sleepSync(20 * (attempt + 1)); // 20, 40, 60, 80 ms
    }
  }
}

/**
 * Atomically and durably write `data` to `filePath` using a
 * write-temp → fsync → rename → fsync-dir strategy.
 *
 * The fsync of the temp file flushes its bytes before the rename, and the
 * directory fsync persists the rename itself — without these a crash or
 * power-loss shortly after the rename can leave a zero-length or truncated
 * file (the rename's metadata reaches disk while the data blocks do not).
 * `fs.writeFileSync` alone only guarantees the bytes reached the OS page
 * cache, not durable storage.
 *
 * @param {string} filePath
 * @param {string|Buffer} data
 */
function atomicWrite(filePath, data) {
  try {
    ensureDir(path.dirname(filePath));
    const tmpPath = tempPathFor(filePath);
    try {
      // Open an fd so the contents can be fsync'd before the rename;
      // writeFileSync(path, …) would close the fd internally with no flush.
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, data, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      renameWithRetry(tmpPath, filePath);
      fsyncDir(path.dirname(filePath));
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
  } catch (err) {
    if (!sandboxDenied(err)) throw err;
    writeInPlace(filePath, data);
  }
}

/**
 * Is this the App Sandbox refusing the temp file, rather than a real failure?
 *
 * A Mac App Store build gets its access to a user's file from the save panel
 * that chose it — and that grant covers THAT FILE, not the folder holding it.
 * So creating `<file>.chiphippotmp-N.tmp` beside it is denied, and the temp
 * name is not in the same-basename form the sandbox would forgive as a related
 * item. Only a store build is ever let down this path: a direct build's
 * atomicity is untouched, and a genuine EACCES there still throws as it always
 * did.
 */
function sandboxDenied(err) {
  const code = err?.code;
  return isMas() && (code === "EPERM" || code === "EACCES" || code === "EROFS");
}

/**
 * The store build's fallback: truncate the existing file and write through it,
 * fsync'd so the bytes are durable.
 *
 * THIS IS NOT ATOMIC, and that is the cost of shipping to the Mac App Store —
 * a crash mid-write leaves a truncated file where the rename strategy would
 * have left the old one intact. It applies ONLY to files the user chose
 * themselves; everything the app owns lives under `userData`, inside the
 * container, where the atomic path above works normally. That includes the
 * 30-second autosave slot, so the work is still recoverable.
 */
function writeInPlace(filePath, data) {
  const fd = fs.openSync(filePath, "w");
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

/**
 * Write `obj` as pretty-printed JSON to `filePath`, atomically.
 * @param {string} filePath
 * @param {*} obj
 */
function writeJSON(filePath, obj) {
  const json = JSON.stringify(obj, null, 2);
  if (typeof json !== "string") {
    throw new Error(`refusing to write non-serializable JSON to ${filePath}`);
  }
  atomicWrite(filePath, json);
}

/**
 * Move a corrupt/unparseable JSON file aside so a single damaged document
 * can't brick the whole load, while preserving its bytes for manual recovery.
 * Best-effort: if the rename itself fails (e.g. permissions), we still degrade
 * to "missing" rather than throw.
 *
 * @param {string} filePath The corrupt file.
 * @param {Error}  parseErr The JSON.parse failure, for the log line.
 */
function quarantineCorruptFile(filePath, parseErr) {
  // Timestamp + short random token so two corrupt reads of the same path
  // within the same millisecond can't clobber each other's quarantine copy.
  const dest = `${filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(filePath, dest);
    console.warn(
      `[store] Corrupt JSON at ${filePath} (${parseErr.message}); quarantined to ${dest} and treating as empty.`,
    );
  } catch (renameErr) {
    console.warn(
      `[store] Corrupt JSON at ${filePath} (${parseErr.message}); could not quarantine (${renameErr.message}); treating as empty.`,
    );
  }
}

/**
 * Read and parse JSON from `filePath`.
 *
 * Returns `null` silently if the file does not exist. A file whose contents
 * are not valid JSON (truncated by a crash, hand-edited, disk corruption) is
 * quarantined aside (see {@link quarantineCorruptFile}) and likewise reported
 * as `null`, so one bad document degrades gracefully instead of failing the
 * entire load. Other read errors (EACCES, EISDIR) still throw.
 * @param {string} filePath
 * @returns {*}
 */
function readJSON(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Parse failure ⇒ the file is corrupt. Quarantine + degrade to "missing".
    quarantineCorruptFile(filePath, err);
    return null;
  }
}

module.exports = {
  ensureDir,
  atomicWrite,
  writeJSON,
  readJSON,
  isTempFileName,
};
