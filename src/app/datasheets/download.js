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

// download.js — fetch the datasheet PDFs named by ./sources.js into a folder.
//
// The app's SECOND outbound network call (ai/client.js is the first), and in
// main for the same reason: the renderer's CSP is `default-src 'self'` with no
// `connect-src`, so it cannot fetch, and it cannot write a file either. Node's
// global `fetch` again — src/package.json still has no `dependencies` block.
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

"use strict";

const path = require("path");
const io = require("../store/io");
const { DATASHEET_SOURCES } = require("./sources");

/** Per-request ceiling. Long enough for a slow link and a 700 KB scan, short
    enough that one wedged connection can't strand the whole run. */
const REQUEST_TIMEOUT_MS = 45000;

/** A catalog part id, as strict as main's own pinout-ref rule: this becomes a
    FILE NAME, so nothing with a separator or a dot may pass. */
const REF_RE = /^[a-z0-9][a-z0-9-]{1,11}$/i;

/** The first bytes of every PDF ever written. */
const PDF_MAGIC = "%PDF";

/**
 * Fetch one entry into `<dir>/<ref>.pdf`, overwriting whatever was there.
 *
 * Resolves `{ ok: true }` or `{ ok: false, error }` — a single part failing is
 * a line in the summary, never the end of the run. Only an ABORT propagates,
 * because that is the user saying stop rather than one file going wrong.
 *
 * @param {string} ref catalog part id (also the output file name)
 * @param {{url: string, base: string}} source the DATASHEET_SOURCES entry —
 *   the resolved URL, and the library base it must still be inside
 * @param {string} dir the destination folder
 * @param {AbortSignal} signal the run's cancel signal
 */
async function fetchOne(ref, source, dir, signal) {
  if (!REF_RE.test(ref)) return { ok: false, error: "invalid part id" };
  // Defence in depth: the table is hard-coded, but a path that walked out of
  // the library it was declared in — or an absolute URL pasted into a `parts`
  // block — must not be fetched even so. Checked per ENTRY, against its own
  // library, since there is no longer one base every source shares.
  if (!source?.url || !source?.base || !source.url.startsWith(source.base)) {
    return { ok: false, error: "source outside its datasheet library" };
  }

  let res;
  try {
    res = await fetch(source.url, {
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
      redirect: "follow",
    });
  } catch (err) {
    if (signal.aborted) throw err; // the user cancelled — stop the whole run
    const timedOut = err?.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut ? "timed out" : String(err?.message ?? err),
    };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

  let bytes;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, error: String(err?.message ?? err) };
  }
  if (
    bytes.length < PDF_MAGIC.length ||
    bytes.subarray(0, 4).toString("latin1") !== PDF_MAGIC
  ) {
    return { ok: false, error: "the reply was not a PDF" };
  }

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
 * @param {object} opts
 * @param {string} opts.dir destination folder (created if absent)
 * @param {AbortSignal} opts.signal cancels the run between/inside requests
 * @param {(p: {done: number, total: number, ref: string|null, ok?: boolean}) => void} [opts.onProgress]
 *   fires once with `{done: 0, ref: null}` before the first request, then once
 *   per part as it lands — so the dialog can show its total immediately rather
 *   than after the first (possibly slow) fetch.
 * @returns {Promise<{ok: boolean, dir: string, total: number, saved: number,
 *   cancelled: boolean, failures: Array<{ref: string, error: string}>}>}
 */
async function downloadAll({ dir, signal, onProgress } = {}) {
  const entries = Object.entries(DATASHEET_SOURCES);
  const total = entries.length;
  const failures = [];
  let saved = 0;
  let cancelled = false;

  io.ensureDir(dir);
  onProgress?.({ done: 0, total, ref: null });

  for (const [ref, source] of entries) {
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    let result;
    try {
      result = await fetchOne(ref, source, dir, signal);
    } catch {
      cancelled = true; // only an abort reaches here
      break;
    }
    if (result.ok) saved += 1;
    else failures.push({ ref, error: result.error });
    onProgress?.({ done: saved + failures.length, total, ref, ok: result.ok });
  }

  return { ok: true, dir, total, saved, cancelled, failures };
}

module.exports = { downloadAll, REQUEST_TIMEOUT_MS };
