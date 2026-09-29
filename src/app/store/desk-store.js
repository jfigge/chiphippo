/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * desk-store.js — persistence for ONE desk document: read it from a file,
 * write it to a file, migrations included. Nothing more — there is no
 * privileged "working" document any more (there is always a project, and every
 * document on screen is one of its desktops, so project-store.js owns which
 * file a document belongs to).
 *
 * Writes are atomic (io.js) and a read runs the schema migrations, so a
 * missing or quarantined-corrupt file yields the default empty desk rather
 * than an error: a desktop whose file has gone opens empty instead of
 * refusing to open at all.
 *
 * The renderer owns the live document (model/desk-doc.js) and sends the whole
 * thing — documents are small; deltas are premature.
 */
"use strict";

const io = require("./io");
const { migrateDeskDocument } = require("./migrations");

class DeskStore {
  /**
   * Read a schematic file, migrated to the current schema so an older
   * `.chiphippo` still opens. Returns the default empty desk when the file is
   * absent or corrupt.
   * @param {string} filePath
   */
  readFile(filePath) {
    return migrateDeskDocument(io.readJSON(filePath));
  }

  /**
   * Write a document to a schematic file. Throws code INVALID_ARG on a junk
   * document or path. Returns the path written.
   * @param {string} filePath
   * @param {object} doc
   */
  writeFile(filePath, doc) {
    if (typeof filePath !== "string" || !filePath) {
      const err = new Error("schematic path must be a non-empty string");
      err.code = "INVALID_ARG";
      throw err;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      const err = new Error("desk document must be an object");
      err.code = "INVALID_ARG";
      throw err;
    }
    io.writeJSON(filePath, doc);
    return filePath;
  }
}

module.exports = { DeskStore };
