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

// Main's gallery reader (app/gallery/sources.js + client.js): one host, ids
// only, a closed list of files, a size cap, and coded failures.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GALLERY_BASE,
  entryFileUrl,
  galleryBase,
  indexUrl,
} = require("../gallery/sources");
const {
  MAX_INDEX_BYTES,
  MAX_THUMB_BYTES,
  fetchDesign,
  fetchEntry,
  fetchIndex,
  fetchThumb,
} = require("../gallery/client");
const {
  MAX_SNAPSHOT_BYTES,
} = require("../../web/scripts/gallery/entry-format.js");

const ID = "four-bit-counter-3fa9c1";

test("an entry's file is on the gallery's one host", () => {
  assert.equal(
    entryFileUrl(ID, "entry.json"),
    `${GALLERY_BASE}entries/${ID}/entry.json`,
  );
  assert.ok(GALLERY_BASE.startsWith("https://chiphippo.com/"));
});

test("the web build reads the gallery beside its own page", () => {
  const where = { web: true, pageUrl: "https://chiphippo.com/desktop/index.html?features=gallery" }; // prettier-ignore
  assert.equal(galleryBase(where), "https://chiphippo.com/gallery/");
  assert.equal(
    galleryBase({ web: true, pageUrl: "http://localhost:8080/desktop/" }),
    "http://localhost:8080/gallery/",
  );
  assert.equal(galleryBase({ web: true }), GALLERY_BASE);
});

test("nothing but an entry id and a published file name makes an address", () => {
  for (const id of [
    "../x-3fa9c1",
    "a/b-3fa9c1",
    "x-3fa9c1?y",
    "%2e%2e-3fa9c1",
    "",
    null,
  ]) {
    assert.equal(entryFileUrl(id, "entry.json"), null, String(id));
  }
  assert.equal(entryFileUrl(ID, "../../index.html"), null);
  assert.equal(entryFileUrl(ID, "secrets.json"), null);
});

/** A fetch that answers `status` with `body`, recording what it was asked. */
function fakeFetch(status, body, headers = {}) {
  const asked = [];
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  const fn = async (url, opts) => {
    asked.push({ url, opts });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  };
  fn.asked = asked;
  return fn;
}

const code = async (p) =>
  (
    await p.then(
      () => ({}),
      (e) => e,
    )
  ).code;

test("a design is fetched from its one address, without credentials", async () => {
  const fetch = fakeFetch(200, JSON.stringify({ kind: "desktop", doc: {} }));
  const raw = await fetchDesign(ID, { fetch });
  assert.equal(raw.kind, "desktop");
  assert.equal(
    fetch.asked[0].url,
    entryFileUrl(ID, "design.desktop.chiphippo"),
  );
  assert.equal(fetch.asked[0].opts.credentials, "omit");
});

test("the index and an entry come from their own addresses", async () => {
  const index = fakeFetch(200, JSON.stringify({ entries: [] }));
  assert.deepEqual(await fetchIndex({ fetch: index }), { entries: [] });
  assert.equal(index.asked[0].url, indexUrl());
  const entry = fakeFetch(200, JSON.stringify({ id: ID }));
  assert.deepEqual(await fetchEntry(ID, { fetch: entry }), { id: ID });
  assert.equal(entry.asked[0].url, entryFileUrl(ID, "entry.json"));
});

test("a thumbnail is a PNG data: URL, none when it is missing, refused when not a PNG", async () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
  ]);
  const url = await fetchThumb(ID, { fetch: fakeFetch(200, png) });
  assert.equal(url, `data:image/png;base64,${png.toString("base64")}`);
  assert.equal(await fetchThumb(ID, { fetch: fakeFetch(404, "") }), null);
  assert.equal(await code(fetchThumb(ID, { fetch: fakeFetch(200, "<svg/>") })), "invalid"); // prettier-ignore
  const big = Buffer.alloc(MAX_THUMB_BYTES + 1);
  png.copy(big);
  assert.equal(await code(fetchThumb(ID, { fetch: fakeFetch(200, big) })), "tooBig"); // prettier-ignore
});

test("every failure is coded", async () => {
  assert.equal(await code(fetchDesign("../nope", { fetch: fakeFetch(200, "{}") })), "invalid"); // prettier-ignore
  assert.equal(await code(fetchDesign(ID, { fetch: fakeFetch(404, "") })), "missing"); // prettier-ignore
  assert.equal(await code(fetchDesign(ID, { fetch: fakeFetch(503, "") })), "unavailable"); // prettier-ignore
  assert.equal(await code(fetchDesign(ID, { fetch: fakeFetch(200, "<html>") })), "invalid"); // prettier-ignore
  assert.equal(await code(fetchDesign(ID, { fetch: fakeFetch(200, "[]") })), "invalid"); // prettier-ignore
  assert.equal(
    await code(fetchDesign(ID, { fetch: fakeFetch(200, "{}", { "content-length": String(MAX_SNAPSHOT_BYTES + 1) }) })), // prettier-ignore
    "tooBig",
  );
  assert.equal(
    await code(fetchDesign(ID, { fetch: fakeFetch(200, `"${"x".repeat(MAX_SNAPSHOT_BYTES)}"`) })), // prettier-ignore
    "tooBig",
  );
  assert.equal(
    await code(fetchIndex({ fetch: fakeFetch(200, "x".repeat(MAX_INDEX_BYTES + 1)) })), // prettier-ignore
    "tooBig",
  );
  const offline = async () => {
    throw new TypeError("fetch failed");
  };
  assert.equal(await code(fetchDesign(ID, { fetch: offline })), "unavailable");
});

test("a request that hangs is given up", async () => {
  const hang = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const err = await fetchDesign(ID, { fetch: hang, timeoutMs: 10 }).catch((e) => e); // prettier-ignore
  assert.equal(err.code, "unavailable");
});

test("only a loopback address may stand in for the site, and only when asked", () => {
  assert.equal(galleryBase({ devBase: "http://127.0.0.1:8099/gallery" }), "http://127.0.0.1:8099/gallery/"); // prettier-ignore
  assert.equal(galleryBase({ devBase: "http://localhost:8099/gallery/" }), "http://localhost:8099/gallery/"); // prettier-ignore
  for (const bad of [
    "https://evil.example/gallery/",
    "http://127.0.0.1.evil.example/",
    "file:///etc/",
  ]) {
    // prettier-ignore
    assert.equal(galleryBase({ devBase: bad }), GALLERY_BASE, bad);
  }
});
