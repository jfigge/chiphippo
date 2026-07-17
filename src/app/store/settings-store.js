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
 * settings-store.js — App-wide preferences. A single JSON document under
 * userData; `get()` returns the stored values layered over the frozen
 * DEFAULTS, `set(patch)` shallow-merges a patch and persists atomically.
 * Object-valued keys (like `viewport`) are replaced whole by a patch, not
 * deep-merged — callers write the full object.
 */
"use strict";

const path = require("path");
const io = require("./io");

const DEFAULTS = Object.freeze({
  // ── Desk viewport (Feature 10) ────────────────────────────────────────────
  // The camera restored at boot: world-unit center + zoom factor.
  viewport: Object.freeze({ cx: 0, cy: 0, zoom: 1 }),

  // ── Window bounds ─────────────────────────────────────────────────────────
  // {x,y,width,height} persisted by window-state.js; null → centred default.
  windowBounds: null,

  // ── Parts palette (Feature 40) ────────────────────────────────────────────
  // Whether the left palette panel is open (the toolbar Parts button toggles).
  paletteOpen: false,
});

class SettingsStore {
  /**
   * @param {string} dataDir - the app's userData directory.
   */
  constructor(dataDir) {
    this._file = path.join(dataDir, "settings.json");
  }

  _read() {
    const doc = io.readJSON(this._file);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  }

  /** Current settings: stored values layered over the defaults. */
  get() {
    return { ...DEFAULTS, ...this._read() };
  }

  /**
   * Shallow-merge `patch` into the stored settings and persist. Returns the
   * full merged settings (defaults + stored).
   * @param {object} patch
   * @returns {object}
   */
  set(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      const err = new Error("settings patch must be an object");
      err.code = "INVALID_ARG";
      throw err;
    }
    const next = { ...this._read(), ...patch };
    io.writeJSON(this._file, next);
    return { ...DEFAULTS, ...next };
  }
}

module.exports = { SettingsStore, DEFAULTS };
