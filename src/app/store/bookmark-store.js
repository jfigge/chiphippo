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

// bookmark-store.js — how a Mac App Store build remembers a path it is allowed
// to touch.
//
// THE SANDBOX FORGETS EVERY LAUNCH. A sandboxed app may read or write a path
// only if a native dialog handed that path over — and the grant dies with the
// process. Chip Hippo persists two paths and re-reads them in a LATER session:
//
//   • settings.recentProjects — Open Recent, and `bootProject`'s startup
//     fallback when the working slot is gone.
//   • settings.datasheetDir   — read when a pin-assignments window opens, to
//     find <dir>/<ref>.pdf.
//
// Both would simply be denied in a store build. A security-scoped bookmark is
// the fix macOS offers: an opaque blob, minted by the dialog that granted the
// path, that can be redeemed in a later launch for the same access. This module
// is the ONE place that mints, stores and redeems them.
//
// WHERE THEY LIVE, and why not settings.json: that file is plaintext and is
// handed BACK to the renderer in full on every `settings:get`. A bookmark is a
// capability — the right to touch a path outside the container — so it gets its
// own main-only sidecar, exactly as the API key does (credential-store.js).
// There is no IPC channel and no preload export: the renderer never learns
// bookmarks exist. Whether the RENDERER may aim main at a path is a different
// question with a different answer (`knownPath` in main.js), and a bookmark
// never bypasses it.
//
// A BOOKMARK GOES STALE and Electron will not say so — `startAccessing…` hands
// back a stop function, not a resolved path, so a dead blob and a live one are
// the same value. That was once treated as "staleness is somebody else's
// problem": every caller's next step is an `existsSync`, which was taken to
// answer false for anything unreachable.
//
// IT DOES NOT. The sandbox answers metadata questions about paths it refuses to
// open, so `existsSync` reports TRUE for a file that then raises EPERM — and
// the app went on believing it held access it did not have. Worse, the commonest
// bookmark in the app is stale by construction: a SAVE panel with
// `securityScopedBookmarks` creates a blank file and mints a bookmark against
// it that never resolves again (electron/electron#32544, open upstream), so
// every project created with Save As failed to reopen on the next launch.
//
// So the scope is PROVED, by the read the caller is about to do (`readable`
// below). A blob that does not survive that is dropped on the spot, and
// `canAccess` lets a caller tell "gone" from "denied" — which need opposite
// offers: forget the entry, or re-grant it through an open panel (an OPEN
// panel's bookmarks are sound, which is what makes the repair permanent).
//
// Outside a MAS build every method is inert, so no call site branches: a direct
// build's dialogs, reads and writes behave exactly as they always have.
//
// NOTE a document opened by LaunchServices (a double-clicked .chiphippo, or
// `app.on("open-file")`) needs NO bookmark — that grant covers the process
// lifetime. Chip Hippo has no such path today; if one is added, it does not
// belong here.
"use strict";

const path = require("path");
const fs = require("fs");

const io = require("./io");
const { isMas } = require("../store-build");

/** Schema version of the sidecar, so a later format change has a hinge. The
    shape is `{ version, bookmarks: { <absolute path>: <base64 blob> } }`. */
const VERSION = 1;

/**
 * Can this path be READ — really, by the operation that would be used on it?
 *
 * Deliberately not `existsSync`/`accessSync`: the App Sandbox answers metadata
 * questions about paths it will not open, so both report success for a file
 * that is about to raise EPERM. A directory is probed by listing it and a file
 * by opening it, because those are the calls the app actually makes.
 *
 * @param {string} target An absolute path.
 * @returns {boolean}
 */
function readable(target) {
  try {
    if (fs.statSync(target).isDirectory()) {
      fs.readdirSync(target);
      return true;
    }
  } catch {
    return false; // gone, or not even stat-able
  }
  let fd;
  try {
    fd = fs.openSync(target, "r");
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

class BookmarkStore {
  /**
   * @param {string} dataDir - the app's userData directory.
   * @param {{startAccessingSecurityScopedResource?: Function}} electronApp -
   *   Electron's `app` (injected, so this is testable with no Electron
   *   runtime — the same shape credential-store.js takes `safeStorage` in).
   * @param {{enabled?: boolean}} [opts] - override the MAS gate, for tests.
   */
  constructor(dataDir, electronApp, { enabled = isMas() } = {}) {
    this._file = path.join(dataDir, "bookmarks.json");
    this._app = electronApp ?? null;
    this._gate = enabled;
    /** slot name → { path, stop } for session-long access. */
    this._holds = new Map();
  }

  /**
   * Whether bookmarks do anything at all here: a Mac App Store build, with the
   * Electron API actually present. Everything below no-ops when false.
   */
  enabled() {
    if (!this._gate) return false;
    return (
      typeof this._app?.startAccessingSecurityScopedResource === "function"
    );
  }

  // ── The sidecar ───────────────────────────────────────────────────────────

  _read() {
    const doc = io.readJSON(this._file);
    const marks = doc?.bookmarks;
    return marks && typeof marks === "object" && !Array.isArray(marks)
      ? marks
      : {};
  }

  _write(bookmarks) {
    io.writeJSON(this._file, { version: VERSION, bookmarks });
  }

  _drop(key) {
    const entries = this._read();
    if (!(key in entries)) return;
    delete entries[key];
    this._write(entries);
  }

  /** Merge `[path, blob]` pairs into the sidecar, skipping anything junk. */
  _store(pairs) {
    const entries = this._read();
    let changed = false;
    for (const [file, blob] of pairs) {
      // An EMPTY STRING is what a dialog returns when the app is not entitled
      // for bookmarks (or is not a MAS build) — storing it would leave an
      // entry that can never be redeemed, so it is dropped here rather than
      // failing later at the redeem.
      if (typeof file !== "string" || !file) continue;
      if (typeof blob !== "string" || !blob) continue;
      entries[path.resolve(file)] = blob;
      changed = true;
    }
    if (changed) this._write(entries);
  }

  // ── Minting ───────────────────────────────────────────────────────────────

  /**
   * The ONE change a dialog call site makes: ask the panel to mint bookmarks
   * alongside the paths it returns.
   * @param {object} opts - `dialog.showOpenDialog`/`showSaveDialog` options.
   * @returns {object}
   */
  dialogOpts(opts) {
    if (!this.enabled()) return opts;
    return { ...opts, securityScopedBookmarks: true };
  }

  /**
   * Record the bookmarks from a `showOpenDialog` result — `filePaths[i]` pairs
   * with `bookmarks[i]`.
   */
  captureOpen(result) {
    if (!this.enabled()) return;
    const files = Array.isArray(result?.filePaths) ? result.filePaths : [];
    const blobs = Array.isArray(result?.bookmarks) ? result.bookmarks : [];
    this._store(files.map((file, i) => [file, blobs[i]]));
  }

  /**
   * Record the bookmark from a `showSaveDialog` result. Note the SINGULAR
   * `bookmark`/`filePath` — the save panel returns one of each where the open
   * panel returns arrays, and reading the wrong shape stores nothing at all,
   * silently, until a later launch cannot open the file.
   */
  captureSave(result) {
    if (!this.enabled()) return;
    this._store([[result?.filePath, result?.bookmark]]);
  }

  /** Whether a bookmark is on file for `filePath`. */
  has(filePath) {
    if (!this.enabled() || typeof filePath !== "string" || !filePath) {
      return false;
    }
    return Boolean(this._read()[path.resolve(filePath)]);
  }

  // ── Redeeming ─────────────────────────────────────────────────────────────

  /**
   * Begin access to `filePath`, or null when there is nothing to begin (not a
   * store build, no bookmark on file, or a blob the OS refused). A refused blob
   * is DROPPED: it names a file that has moved or a signing identity that has
   * changed, and either way it will never work again.
   * @returns {(() => void)|null} the stop function, to be called exactly once.
   */
  _start(filePath) {
    if (!this.enabled() || typeof filePath !== "string" || !filePath) {
      return null;
    }
    const key = path.resolve(filePath);
    const blob = this._read()[key];
    if (typeof blob !== "string" || !blob) return null;
    let stop;
    try {
      stop = this._app.startAccessingSecurityScopedResource(blob);
    } catch {
      this._drop(key);
      return null;
    }
    if (typeof stop !== "function") return null;
    // THE SCOPE IS VERIFIED, NOT ASSUMED. `startAccessingSecurityScopedResource`
    // hands back a stop function whether or not the blob actually resolved, so
    // a STALE bookmark is indistinguishable from a live one at this line — and
    // a bookmark minted by the SAVE panel for a file that did not yet exist is
    // stale from the very next launch (electron/electron#32544: the panel
    // creates a blank file, and the bookmark it mints against it never resolves
    // again). Believing it cost the caller an EPERM several frames later, with
    // nothing to attribute it to.
    //
    // `existsSync` is NOT the check: the sandbox permits stat() on paths it
    // denies open() on, so it answers true for a file we cannot read. Only a
    // real read proves a real grant.
    if (readable(key)) return stop;
    stop();
    this._drop(key);
    return null;
  }

  /**
   * Whether `filePath` can actually be READ right now — scope redeemed if there
   * is a bookmark for it, and proved with a real read either way.
   *
   * This is what separates "that file is gone" from "macOS will not let us
   * touch it", which look identical from outside and need opposite offers: one
   * is forgotten, the other is re-granted through an open panel. With no
   * bookmark (every path inside the container, and every path in a direct
   * build) it is simply the read, which is the right answer there.
   */
  canAccess(filePath) {
    if (typeof filePath !== "string" || !filePath) return false;
    const stop = this._start(filePath);
    try {
      return readable(path.resolve(filePath));
    } finally {
      stop?.();
    }
  }

  /**
   * Run `fn` with access to `filePath` held, and stop it afterwards — on the
   * throw path too, and (when `fn` returns a thenable) not until it settles,
   * which is what lets a caller hold access across an `await`.
   *
   * With no bookmark this is just `fn()`, which is the right answer for every
   * path inside the container: userData is always ours.
   * @returns {*} whatever `fn` returns.
   */
  withAccess(filePath, fn) {
    const stop = this._start(filePath);
    if (!stop) return fn();
    let result;
    try {
      result = fn();
    } catch (err) {
      stop();
      throw err;
    }
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          stop();
          return value;
        },
        (err) => {
          stop();
          throw err;
        },
      );
    }
    stop();
    return result;
  }

  /**
   * Hold access for a named slot until it is released — the open project needs
   * it for the whole session, because ⌘S writes back to a file that was opened
   * (perhaps) many minutes ago. Taking a slot releases whatever it held before;
   * re-holding the same path is a no-op, so this is safe to call on every
   * adopt.
   */
  hold(slot, filePath) {
    const key =
      typeof filePath === "string" && filePath ? path.resolve(filePath) : null;
    const current = this._holds.get(slot);
    if (current && current.path === key) return;
    this.release(slot);
    if (!key) return;
    const stop = this._start(key);
    if (stop) this._holds.set(slot, { path: key, stop });
  }

  /** Stop and forget one slot's access. */
  release(slot) {
    const held = this._holds.get(slot);
    if (!held) return;
    this._holds.delete(slot);
    try {
      held.stop();
    } catch {
      /* a stop that fails leaves nothing to do but forget it */
    }
  }

  /** Stop every held access — the app is going away. */
  releaseAll() {
    for (const slot of [...this._holds.keys()]) this.release(slot);
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  /**
   * Keep only the bookmarks still worth having. The recent list is capped at 10
   * and the datasheet folder is one path, so without this the sidecar would
   * grow a line per file ever opened. Live holds are untouched: forgetting a
   * bookmark is not the same as revoking access already in use.
   * @param {string[]} keepPaths
   */
  prune(keepPaths) {
    if (!this.enabled()) return;
    const keep = new Set(
      (Array.isArray(keepPaths) ? keepPaths : [])
        .filter((p) => typeof p === "string" && p)
        .map((p) => path.resolve(p)),
    );
    const entries = this._read();
    const next = {};
    let dropped = false;
    for (const [key, blob] of Object.entries(entries)) {
      if (keep.has(key)) next[key] = blob;
      else dropped = true;
    }
    if (dropped) this._write(next);
  }
}

module.exports = { BookmarkStore };
