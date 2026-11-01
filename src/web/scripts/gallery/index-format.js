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

// index-format.js — the gallery's INDEX (`/gallery/index.json`): the one file
// the website and the app fetch to draw the grid, search and filter. Pure.
//
// BUILT AT DEPLOY, NEVER COMMITTED (features/chiphippo-gallery-plan.md →
// 1.2): `scripts/build-gallery.mjs` reads every `entries/*/entry.json` and
// writes this — two open submissions each editing a committed index would
// conflict, and an index derived from the entries can never disagree with
// them.
//
//   { schema: 1, generated: "2026-10-31", entries: [ <summary>, … ] }
//
// A summary is an entry minus its description (the detail page fetches the
// entry itself), newest first. The same convention is what a COLLECTION
// publishes (Phase 8), so a reader never asks whose index it holds.

import { normalizeEntry } from "./entry-format.js";

export const INDEX_SCHEMA = 1;

/** An entry's line in the index: everything the grid draws. */
export function indexEntry(entry) {
  const e = normalizeEntry(entry);
  if (!e) return null;
  const { description, schema, ...summary } = e;
  return summary;
}

/** Newest first; one day's entries by id, so the order is total. */
const byNewest = (a, b) =>
  b.created.localeCompare(a.created) || a.id.localeCompare(b.id);

/**
 * The index for a set of entries: each held to the entry shape (one that
 * fails is left out), one per id (the first), newest first.
 * @param {object[]} entries
 * @param {{generated?: string}} [opts] - the build's date (YYYY-MM-DD).
 */
export function buildIndex(entries, { generated = "" } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of entries ?? []) {
    const line = indexEntry(raw);
    if (!line || seen.has(line.id)) continue;
    seen.add(line.id);
    out.push(line);
  }
  return { schema: INDEX_SCHEMA, generated, entries: out.sort(byNewest) };
}

/**
 * An index as READ (the website's fetch, main's): lenient — an entry this
 * build cannot read is skipped, never the whole index; anything that is not
 * an index at all is an empty one.
 */
export function normalizeIndex(raw) {
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  return buildIndex(list, {
    generated: typeof raw?.generated === "string" ? raw.generated : "",
  });
}
