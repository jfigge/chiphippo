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
 * tests/datasheet-sources.test.js
 *
 * The datasheet-download table (app/datasheets/sources.js) is hand-written
 * data, and its two failure modes are both SILENT.
 *
 *  - A key that is not a catalog part id downloads a PDF under a name no
 *    pin-assignments window will ever look for. Nothing errors; the button
 *    simply never appears for a part the user just downloaded a sheet for.
 *  - A key main's own `<ref>.pdf` rule would reject is the same thing one step
 *    earlier — the download writes it and the lookup refuses to consider it.
 *
 * So this holds every key against the REAL catalog (imported, not copied) and
 * against the same ref rule main uses, and every value against the one base
 * URL the downloader is allowed to reach.
 *
 * Pure text/data analysis — no Electron process and no network.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { pathToFileURL } = require("url");

const {
  LIBRARIES,
  DATASHEET_SOURCES,
  sourceCount,
} = require("../datasheets/sources");

// The renderer's catalog is ESM; main is CommonJS. A dynamic import is the
// bridge, and it is worth it — a hand-copied id list is exactly the drift this
// test exists to catch.
const CATALOG_URL = pathToFileURL(
  path.join(__dirname, "..", "..", "web", "scripts", "catalog", "index.js"),
).href;

/** Main's own rule for a part ref it will resolve to `<dir>/<ref>.pdf`
    (main.js PINOUT_REF_RE) — restated because a copy that drifts fails here. */
const REF_RE = /^[a-z0-9][a-z0-9-]{1,11}$/i;

test("every source key is a real catalog part id", async () => {
  const { PALETTE_DEFS } = await import(CATALOG_URL);
  const ids = new Set(PALETTE_DEFS.map((def) => def.id));
  const unknown = Object.keys(DATASHEET_SOURCES).filter((ref) => !ids.has(ref));
  assert.deepEqual(
    unknown,
    [],
    `datasheet sources naming no catalog part: ${unknown.join(", ")}`,
  );
});

test("every source key is a ref main will resolve to a PDF path", () => {
  const bad = Object.keys(DATASHEET_SOURCES).filter((ref) => !REF_RE.test(ref));
  assert.deepEqual(bad, [], `part ids main's <ref>.pdf lookup rejects: ${bad}`);
});

test("every source resolves to a PDF inside its own library", () => {
  const offenders = [];
  for (const [ref, source] of Object.entries(DATASHEET_SOURCES)) {
    // A path that walked out of its library, or an absolute URL pasted into a
    // `parts` block, would silently turn the table into a fetch-anything list.
    if (!source.url.startsWith(source.base)) {
      offenders.push(`${ref} → ${source.url} (outside ${source.base})`);
    } else if (!/\.pdf$/i.test(source.url)) {
      offenders.push(`${ref} → ${source.url} (not a .pdf)`);
    }
  }
  assert.deepEqual(offenders, [], `bad sources: ${offenders.join(", ")}`);
});

test("every library declares an https base ending in a slash", () => {
  // `new URL(path, base)` DROPS the last segment of a base with no trailing
  // slash, so ".../documentation" would quietly resolve every part against
  // ".../" instead — 404s that look like the vendor moved their files.
  const offenders = LIBRARIES.filter(
    (lib) => !/^https:\/\/[^/]+\/.*\/$/.test(lib.base),
  ).map((lib) => `${lib.id} → ${lib.base}`);
  assert.deepEqual(offenders, [], `bad library bases: ${offenders.join(", ")}`);
});

test("no part is claimed by two libraries", () => {
  // The flattened lookup would silently keep the LAST block's copy, so a part
  // moved to a new source while its old line stayed behind would download
  // from whichever block happened to come second in the file.
  const seen = new Map();
  const dupes = [];
  for (const lib of LIBRARIES) {
    for (const ref of Object.keys(lib.parts)) {
      if (seen.has(ref)) dupes.push(`${ref} (${seen.get(ref)} + ${lib.id})`);
      else seen.set(ref, lib.id);
    }
  }
  assert.deepEqual(dupes, [], `parts in two libraries: ${dupes.join(", ")}`);
});

test("the table is non-empty and sourceCount agrees with it", () => {
  assert.ok(sourceCount() > 0, "the download would fetch nothing");
  assert.equal(sourceCount(), Object.keys(DATASHEET_SOURCES).length);
});
