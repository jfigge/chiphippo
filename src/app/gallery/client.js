// client.js — main's one way to read the gallery (sources.js says where).
// Behind the `gallery` feature flag and, on the desktop, the Gallery access
// setting (Phase 3); main.js checks both before calling in here.
//
// A DESIGN is read as text first, capped at the size the gallery itself
// accepts (`MAX_SNAPSHOT_BYTES`): a server that sends more is not the gallery
// answering, and nothing past the cap is parsed. Every failure is a CODED
// error, so the renderer can say which one without parsing a message:
//   "invalid" (not an id / not a design), "missing" (404), "unavailable" (any
//   other status, the network, a timeout), "tooBig".
"use strict";

const { entryFileUrl } = require("./sources");
const {
  MAX_SNAPSHOT_BYTES,
} = require("../../web/scripts/gallery/entry-format.js");

/** How long one request may take, ms. */
const TIMEOUT_MS = 15_000;

const coded = (code, message) => Object.assign(new Error(message), { code });

/**
 * Read one entry's design file and parse it.
 * @param {string} id
 * @param {{fetch?: typeof fetch, where?: object, timeoutMs?: number}} [opts]
 * @returns {Promise<object>} the parsed snapshot JSON.
 */
async function fetchDesign(id, { fetch = globalThis.fetch, where, timeoutMs = TIMEOUT_MS } = {}) {
  const url = entryFileUrl(id, "design.desktop.chiphippo", where);
  if (!url) throw coded("invalid", "not a gallery entry id");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(url, { signal: abort.signal, credentials: "omit" });
    if (res.status === 404) throw coded("missing", "no such gallery entry");
    if (!res.ok) throw coded("unavailable", `the gallery answered ${res.status}`);
    const length = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_SNAPSHOT_BYTES) {
      throw coded("tooBig", "the design is larger than the gallery takes");
    }
    text = await res.text();
  } catch (err) {
    if (err.code) throw err;
    throw coded("unavailable", err.message || "the gallery could not be reached");
  } finally {
    clearTimeout(timer);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) {
    throw coded("tooBig", "the design is larger than the gallery takes");
  }
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  } catch {
    /* falls through */
  }
  throw coded("invalid", "that entry holds no design");
}

module.exports = { fetchDesign, TIMEOUT_MS };
