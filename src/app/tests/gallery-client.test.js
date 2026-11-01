// Main's gallery reader (app/gallery/sources.js + client.js): one host, ids
// only, a closed list of files, a size cap, and coded failures.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  GALLERY_BASE,
  entryFileUrl,
  galleryBase,
} = require("../gallery/sources");
const { fetchDesign } = require("../gallery/client");
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
  for (const id of ["../x-3fa9c1", "a/b-3fa9c1", "x-3fa9c1?y", "%2e%2e-3fa9c1", "", null]) { // prettier-ignore
    assert.equal(entryFileUrl(id, "entry.json"), null, String(id));
  }
  assert.equal(entryFileUrl(ID, "../../index.html"), null);
  assert.equal(entryFileUrl(ID, "secrets.json"), null);
});

/** A fetch that answers `status` with `body`, recording what it was asked. */
function fakeFetch(status, body, headers = {}) {
  const asked = [];
  const fn = async (url, opts) => {
    asked.push({ url, opts });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      text: async () => body,
    };
  };
  fn.asked = asked;
  return fn;
}

test("a design is fetched from its one address, without credentials", async () => {
  const fetch = fakeFetch(200, JSON.stringify({ kind: "desktop", doc: {} }));
  const raw = await fetchDesign(ID, { fetch });
  assert.equal(raw.kind, "desktop");
  assert.equal(fetch.asked[0].url, entryFileUrl(ID, "design.desktop.chiphippo"));
  assert.equal(fetch.asked[0].opts.credentials, "omit");
});

test("every failure is coded", async () => {
  const code = async (p) => (await p.then(() => null, (e) => e)).code;
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
