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

// client.js — main's one way to read the gallery (sources.js says where).
// Behind the `gallery` feature flag and, on the desktop, the Gallery access
// setting; main.js checks both before calling in here.
//
// EVERY READ IS CAPPED, then parsed. A body is read as bytes, refused past
// the cap its kind allows (a `content-length` over it is refused before a
// byte is read), and only then parsed — a server that sends more than the
// gallery publishes is not the gallery answering. Every failure is a CODED
// error, so the renderer can say which one without parsing a message:
//   "invalid" (not an id / not what the file should hold), "missing" (404),
//   "unavailable" (any other status, the network, a timeout), "tooBig".
"use strict";

const { entryFileUrl, indexUrl } = require("./sources");
const {
  MAX_SNAPSHOT_BYTES,
} = require("../../web/scripts/gallery/entry-format.js");

/** How long one request may take, ms. */
const TIMEOUT_MS = 15_000;
/** The caps, bytes: the index, one entry's metadata, one thumbnail. */
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_THUMB_BYTES = 512 * 1024;
/** What a thumbnail must start with: the PNG signature. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * GET `url`, capped at `max` bytes. Resolves to the body's bytes.
 * @param {string|null} url
 * @param {number} max
 * @param {{fetch?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<Buffer>}
 */
async function fetchCapped(
  url,
  max,
  { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {},
) {
  if (!url) throw coded("invalid", "not a gallery entry id");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: abort.signal, credentials: "omit" });
    if (res.status === 404) throw coded("missing", "no such gallery file");
    if (!res.ok) {
      throw coded("unavailable", `the gallery answered ${res.status}`);
    }
    const length = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > max) {
      throw coded("tooBig", "larger than the gallery publishes");
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > max) {
      throw coded("tooBig", "larger than the gallery publishes");
    }
    return bytes;
  } catch (err) {
    if (err.code) throw err;
    throw coded("unavailable", err.message || "the gallery could not be reached"); // prettier-ignore
  } finally {
    clearTimeout(timer);
  }
}

/** Parse bytes as a JSON object (never an array or a scalar), or "invalid". */
function jsonObject(bytes, what) {
  try {
    const raw = JSON.parse(bytes.toString("utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  } catch {
    /* falls through */
  }
  throw coded("invalid", `that is not ${what}`);
}

/**
 * The gallery's index (the grid's data), parsed — the renderer holds it to
 * its shape (gallery/index-format.js `normalizeIndex`).
 * @param {{fetch?: typeof fetch, where?: object, timeoutMs?: number}} [opts]
 */
async function fetchIndex(opts = {}) {
  const bytes = await fetchCapped(indexUrl(opts.where), MAX_INDEX_BYTES, opts);
  return jsonObject(bytes, "a gallery index");
}

/** One entry's metadata (`entry.json`), parsed. */
async function fetchEntry(id, opts = {}) {
  const url = entryFileUrl(id, "entry.json", opts.where);
  return jsonObject(await fetchCapped(url, MAX_ENTRY_BYTES, opts), "an entry");
}

/** One entry's design file (a desktop snapshot), parsed. */
async function fetchDesign(id, opts = {}) {
  const url = entryFileUrl(id, "design.desktop.chiphippo", opts.where);
  return jsonObject(await fetchCapped(url, MAX_SNAPSHOT_BYTES, opts), "a design"); // prettier-ignore
}

/**
 * One entry's thumbnail as a `data:` URL — the renderer's CSP takes images
 * from itself and `data:` only. Null when the entry has none (404); a body
 * that is not a PNG is "invalid".
 */
async function fetchThumb(id, opts = {}) {
  let bytes;
  try {
    bytes = await fetchCapped(entryFileUrl(id, "thumb.png", opts.where), MAX_THUMB_BYTES, opts); // prettier-ignore
  } catch (err) {
    if (err.code === "missing") return null;
    throw err;
  }
  if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw coded("invalid", "that is not a PNG");
  }
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

module.exports = {
  fetchIndex,
  fetchEntry,
  fetchDesign,
  fetchThumb,
  TIMEOUT_MS,
  MAX_INDEX_BYTES,
  MAX_ENTRY_BYTES,
  MAX_THUMB_BYTES,
};
