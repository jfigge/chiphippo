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

test("every CD4000 part names its sheet — TI's, bar the one TI never printed", async () => {
  // Unlike the 74LS parts, every CD4000 part has a datasheet a program can
  // fetch — TI's for all but one (the family is TI's, from Harris) — so a CMOS
  // part with no entry is a forgotten line, not a deliberate gap, and it would
  // leave that part's pin window without its PDF button for good, silently.
  // The one exception is NAMED: TI never documented the CD4528B, whose sheet
  // is a second source's (sources.js's hgsemi block says why).
  const NOT_TI = {
    CD4528B: /^https:\/\/wmsc\.lcsc\.com\/.*HGSEMI-CD4528BE[^/]*\.pdf$/,
  };
  const { PALETTE_DEFS } = await import(CATALOG_URL);
  const { familyOf } = await import(
    pathToFileURL(
      path.join(
        __dirname,
        "..",
        "..",
        "web",
        "scripts",
        "catalog",
        "families.js",
      ),
    ).href
  );
  const missing = PALETTE_DEFS.filter(
    (def) => familyOf(def) === "CD4000" && !DATASHEET_SOURCES[def.id],
  ).map((def) => def.id);
  assert.deepEqual(missing, [], `CD4000 parts with no sheet: ${missing}`);
  for (const def of PALETTE_DEFS.filter((d) => familyOf(d) === "CD4000")) {
    assert.match(
      DATASHEET_SOURCES[def.id].url,
      NOT_TI[def.id] ??
        /^https:\/\/www\.ti\.com\/lit\/ds\/symlink\/cd\d+u?b\.pdf$/,
      def.id,
    );
  }
});

test("the CD4000 batch-2 parts download the sheets their feature names", () => {
  // features/done/410-cd4000-batch2.md lists each part's URL, several of them
  // a sibling's (the 4020/4024 are documented in the 4040's sheet, the 4022 in
  // the 4017's, the 4516 in the 4510's). Each was opened and its part number
  // read off it before it went in; this pins the table to that list.
  const TI = "https://www.ti.com/lit/ds/symlink/";
  const wanted = {
    CD4027B: "cd4027b.pdf",
    CD4094B: "cd4094b.pdf",
    CD4028B: "cd4028b.pdf",
    CD4511B: "cd4511b.pdf",
    CD4029B: "cd4029b.pdf",
    CD4510B: "cd4510b.pdf",
    CD4516B: "cd4510b.pdf",
    CD4020B: "cd4040b.pdf",
    CD4024B: "cd4040b.pdf",
    CD4022B: "cd4017b.pdf",
    CD4066B: "cd4066b.pdf",
    CD4051B: "cd4051b.pdf",
    CD4052B: "cd4051b.pdf",
    CD4053B: "cd4051b.pdf",
  };
  for (const [ref, file] of Object.entries(wanted)) {
    assert.equal(DATASHEET_SOURCES[ref]?.url, TI + file, ref);
  }
});
