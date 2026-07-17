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
 * migrations.js — desk-document schema migrations, keyed on `version`.
 *
 * Currently a stub: version 1 is the first schema, so MIGRATIONS is empty.
 * When version 2 lands, add `1: (doc) => ({ ...transformed, version: 2 })`
 * and bump DESK_DOC_VERSION — load() then upgrades old documents in memory
 * (persisted lazily by the next autosave). A document from a NEWER app
 * version is returned untouched (never downgraded); the renderer's
 * normalizeDocument treats unknown fields defensively.
 */
"use strict";

const DESK_DOC_VERSION = 1;

/** A fresh, empty desk document (main's copy of the renderer's shape). */
function defaultDeskDocument() {
  return {
    version: DESK_DOC_VERSION,
    boards: [],
    components: [],
    wires: [],
    nextBoardId: 1,
    nextComponentId: 1,
    nextPsuId: 1,
    nextWireId: 1,
  };
}

/** version → one-step upgrade fn returning the doc at version + 1. */
const MIGRATIONS = {};

/**
 * Bring a loaded document up to DESK_DOC_VERSION. Junk (null / non-object /
 * array) becomes the default document; missing top-level fields are filled
 * from the defaults before any migration step runs.
 *
 * @param {*} raw The parsed desk.json contents (or null when absent).
 * @returns {object} A document at DESK_DOC_VERSION (or newer, untouched).
 */
function migrateDeskDocument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultDeskDocument();
  }
  let doc = { ...defaultDeskDocument(), ...raw };
  if (!Number.isInteger(doc.version) || doc.version < 1) {
    doc.version = DESK_DOC_VERSION;
  }
  while (doc.version < DESK_DOC_VERSION) {
    const step = MIGRATIONS[doc.version];
    if (!step) break; // gap in the chain — hand over as-is (defensive)
    doc = step(doc);
  }
  return doc;
}

module.exports = { DESK_DOC_VERSION, defaultDeskDocument, migrateDeskDocument };
