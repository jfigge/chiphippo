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

// download.js — fetch the datasheet PDFs named by ./sources.js into a folder.
//
// The app's SECOND outbound network call (ai/client.js is the first), and in
// main for the same reason: the renderer's CSP is `default-src 'self'` with no
// `connect-src`, so it cannot fetch, and it cannot write a file either. Node's
// global `fetch` again, for the same reason as the AI client: no HTTP package.
//
// SEQUENTIAL, not parallel. The whole point of the run is the `n/TOTAL`
// counter, and a counter that jumps 3 → 7 → 5 is worse than one that takes a
// few more seconds; sequential also means one polite request at a time to a
// university web server that is doing us a favour.
//
// A 200 IS NOT A PDF. A misconfigured host answers a missing file with a
// friendly HTML page and status 200, which would land as `74LS00.pdf` and open
// as garbage in the OS viewer — a corrupt file the user has no way to explain.
// So every body is checked for the `%PDF` magic before it is written, and a
// body that fails is a REPORTED failure, never a saved file.
//
// AND THE TABLE IS THE ONLY SAY IN WHERE IT GOES. A redirect is followed by
// hand, and only to a host the table itself names (the source's own, or
// another library's) over https when the source was — so a library whose
// site is taken over cannot bounce the run to a host of its choosing. A body
// is read against MAX_PDF_BYTES, never trusting a Content-Length, and a
// shared sheet's bytes are kept only until the last part naming it is saved.

"use strict";

const path = require("path");
const io = require("../store/io");
const { DATASHEET_SOURCES } = require("./sources");

/** Per-request ceiling. Long enough for a slow link and a 700 KB scan, short
    enough that one wedged connection can't strand the whole run. */
const REQUEST_TIMEOUT_MS = 45000;

/** A catalog part id, as strict as main's own pinout-ref rule: this becomes a
    FILE NAME, so nothing with a separator or a dot may pass. */
const REF_RE = /^[a-z0-9][a-z0-9-]{1,23}$/i;

/** The largest datasheet saved — far past any real one (the biggest scans
    are a few MB) — so a host streaming without end cannot fill the memory. */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

/** How many redirects one request may take. */
const MAX_REDIRECTS = 5;

/** The first bytes of every PDF ever written. */
const PDF_MAGIC = "%PDF";

/**
 * Fetch one source's PDF into memory. Resolves `{ ok: true, bytes }` or
 * `{ ok: false, error }` — one URL failing is a line in the summary, never the
 * end of the run. Only an ABORT propagates, because that is the user saying
 * stop rather than one file going wrong.
 *
 * @param {{url: string, base: string}} source the DATASHEET_SOURCES entry —
 *   the resolved URL, and the library base it must still be inside
 * @param {AbortSignal} signal the run's cancel signal
 * @param {typeof fetch} fetchImpl the fetch to use (the global one, bar tests)
 */
async function fetchPdf(source, signal, fetchImpl, hosts = null) {
  // Defence in depth: the table is hard-coded, but a path that walked out of
  // the library it was declared in — or an absolute URL pasted into a `parts`
  // block — must not be fetched even so. Checked per ENTRY, against its own
  // library, since there is no longer one base every source shares.
  if (!source?.url || !source?.base || !source.url.startsWith(source.base)) {
    return { ok: false, error: "source outside its datasheet library" };
  }
  const allowed = hosts ?? new Set([hostOf(source.url)]);
  const secure = source.url.startsWith("https:");
  let url = source.url;
  let res;
  let bytes;
  try {
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(url, {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
        redirect: "manual",
      });
      const location = redirectOf(res);
      if (!location) break;
      res.body?.cancel?.().catch?.(() => {});
      let next;
      try {
        next = new URL(location, url);
      } catch {
        return { ok: false, error: "a redirect to nowhere" };
      }
      if (
        hop >= MAX_REDIRECTS ||
        !allowed.has(next.host) ||
        (secure && next.protocol !== "https:")
      ) {
        return { ok: false, error: `redirected away to ${next.host}` };
      }
      url = next.href;
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    bytes = await readCapped(res, MAX_PDF_BYTES);
  } catch (err) {
    if (signal.aborted) throw err; // the user cancelled — stop the whole run
    const timedOut = err?.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut ? "timed out" : String(err?.message ?? err),
    };
  }
  if (
    bytes.length < PDF_MAGIC.length ||
    bytes.subarray(0, 4).toString("latin1") !== PDF_MAGIC
  ) {
    return { ok: false, error: "the reply was not a PDF" };
  }
  return { ok: true, bytes };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** A 3xx's Location, or null. */
function redirectOf(res) {
  if (!(res?.status >= 300 && res.status < 400)) return null;
  return res.headers?.get?.("location") ?? null;
}

/** A body, refused once it passes `max` bytes (whatever it declared). */
async function readCapped(res, max) {
  const tooLarge = () => new Error("the file is too large to be a datasheet");
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  const reader = res.body?.getReader?.();
  if (!reader) {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > max) throw tooLarge();
    return whole;
  }
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > max) {
      reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

/**
 * Write one part's copy as `<dir>/<ref>.pdf`, overwriting whatever was there.
 * Resolves `{ ok: true, bytes: <length> }` or `{ ok: false, error }`.
 */
function savePdf(ref, bytes, dir) {
  if (!REF_RE.test(ref)) return { ok: false, error: "invalid part id" };
  try {
    io.atomicWrite(path.join(dir, `${ref}.pdf`), bytes);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  return { ok: true, bytes: bytes.length };
}

/**
 * Download every datasheet in the table into `dir`, reporting progress.
 *
 * Existing files are REPLACED (the button's contract: press it again and you
 * get a fresh set) — atomically, so a failed write can never leave a truncated
 * PDF behind the old good one.
 *
 * A SHARED SHEET IS FETCHED ONCE. A vendor routinely documents a family of
 * parts in one PDF (TI's CD4001B sheet is the 4002B's and the 4025B's too), so
 * each URL is fetched the first time a part names it and its bytes are saved
 * under every part that does — each part still gets its own `<ref>.pdf`,
 * because that is what the pinout window asks the folder for. Progress counts
 * PARTS, and a URL that fails fails every part sharing it, each reported by
 * name.
 *
 * @param {object} opts
 * @param {string} opts.dir destination folder (created if absent)
 * @param {AbortSignal} opts.signal cancels the run between/inside requests
 * @param {(p: {done: number, total: number, ref: string|null, ok?: boolean}) => void} [opts.onProgress]
 *   fires once with `{done: 0, ref: null}` before the first request, then once
 *   per part as it lands — so the dialog can show its total immediately rather
 *   than after the first (possibly slow) fetch.
 * @param {object} [opts.sources] the table to walk (DATASHEET_SOURCES; tests
 *   hand in their own).
 * @param {typeof fetch} [opts.fetch] the fetch to use (the global one; tests
 *   hand in a stub, so no test reaches the network).
 * @returns {Promise<{ok: boolean, dir: string, total: number, saved: number,
 *   cancelled: boolean, failures: Array<{ref: string, error: string}>}>}
 */
async function downloadAll({
  dir,
  signal,
  onProgress,
  sources = DATASHEET_SOURCES,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  const entries = Object.entries(sources);
  const total = entries.length;
  const failures = [];
  const fetched = new Map(); // url → the one fetchPdf result every part shares
  // How many parts still to come name each URL: a shared sheet's bytes are
  // let go of once the last of them is saved, not held to the end of the run.
  const uses = new Map();
  for (const [, source] of entries)
    uses.set(source?.url, (uses.get(source?.url) ?? 0) + 1);
  // Where a redirect may go: any host the table itself names.
  const hosts = new Set(
    entries.map(([, source]) => hostOf(source?.url)).filter(Boolean),
  );
  let saved = 0;
  let cancelled = false;
  const runSignal = signal ?? new AbortController().signal;

  io.ensureDir(dir);
  onProgress?.({ done: 0, total, ref: null });

  for (const [ref, source] of entries) {
    if (runSignal.aborted) {
      cancelled = true;
      break;
    }
    let got = fetched.get(source?.url);
    if (!got) {
      try {
        got = await fetchPdf(source, runSignal, fetchImpl, hosts);
      } catch {
        cancelled = true; // only an abort reaches here
        break;
      }
      if (source?.url) fetched.set(source.url, got);
    }
    const result = got.ok ? savePdf(ref, got.bytes, dir) : got;
    const left = (uses.get(source?.url) ?? 1) - 1;
    uses.set(source?.url, left);
    if (left <= 0) fetched.delete(source?.url);
    if (result.ok) saved += 1;
    else failures.push({ ref, error: result.error });
    onProgress?.({ done: saved + failures.length, total, ref, ok: result.ok });
  }

  return { ok: true, dir, total, saved, cancelled, failures };
}

module.exports = { downloadAll, REQUEST_TIMEOUT_MS, MAX_PDF_BYTES };
