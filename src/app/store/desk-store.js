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
 * desk-store.js — persistence for the single desk document (one per app for
 * now; named project files are backlog). Lives at userData/desk.json; writes
 * are atomic (io.js) and load() runs the schema migrations, so a first run
 * (or a quarantined corrupt file) yields the default empty desk.
 *
 * The renderer owns the live document (model/desk-doc.js) and autosaves the
 * whole thing, debounced — documents are small; deltas are premature.
 */
"use strict";

const path = require("path");
const io = require("./io");
const { migrateDeskDocument } = require("./migrations");

class DeskStore {
  /**
   * @param {string} dataDir - the app's userData directory.
   */
  constructor(dataDir) {
    this._file = path.join(dataDir, "desk.json");
  }

  /**
   * The persisted document, migrated to the current schema — or the default
   * empty desk when the file is absent (first run) or was corrupt.
   */
  load() {
    return migrateDeskDocument(io.readJSON(this._file));
  }

  /**
   * Persist a document (the renderer sends its serialized DeskDoc). Returns
   * the document; throws code INVALID_ARG on junk.
   * @param {object} doc
   */
  save(doc) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      const err = new Error("desk document must be an object");
      err.code = "INVALID_ARG";
      throw err;
    }
    io.writeJSON(this._file, doc);
    return doc;
  }
}

module.exports = { DeskStore };
