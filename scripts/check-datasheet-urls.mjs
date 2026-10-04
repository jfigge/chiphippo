#!/usr/bin/env node
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

// Ask every datasheet URL the app would download whether it still answers with
// a PDF (Feature 400).
//
// The table in src/app/datasheets/sources.js is hand-written and VERIFIED —
// each entry was opened and its part number read off it — but a vendor can
// move a file at any time, and the in-app download only finds out when a user
// presses the button. This finds out first. It is deliberately NOT part of
// `make test`: the suite makes no network calls, and must not go red because a
// vendor's server is slow or down this afternoon.
//
// Each UNIQUE URL is requested once (several parts share a sheet), with the
// same checks the downloader makes — a 2xx, and a body that starts `%PDF`, so
// a host answering a missing file with a friendly HTML page reads as the
// failure it is. A failure names the URL and every part that uses it; the fix
// is a verified replacement in sources.js, never a guess.
//
// Usage: node scripts/check-datasheet-urls.mjs [--strict]
//   --strict  exit 1 when any URL fails (the default reports and exits 0)

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DATASHEET_SOURCES } = require("../src/app/datasheets/sources.js");

const TIMEOUT_MS = 45000;

/** url → the parts that name it, in table order. */
const byUrl = new Map();
for (const { ref, url } of Object.values(DATASHEET_SOURCES)) {
  if (!byUrl.has(url)) byUrl.set(url, []);
  byUrl.get(url).push(ref);
}

async function check(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    const head = Buffer.from(await res.arrayBuffer()).subarray(0, 4);
    return head.toString("latin1") === "%PDF"
      ? null
      : "the reply was not a PDF";
  } catch (err) {
    return err?.name === "TimeoutError"
      ? "timed out"
      : String(err?.message ?? err);
  }
}

const failed = [];
let n = 0;
for (const [url, refs] of byUrl) {
  n += 1;
  const error = await check(url);
  const tag = `[${n}/${byUrl.size}]`;
  if (error) {
    failed.push({ url, refs, error });
    console.log(`${tag} FAIL ${url} — ${error} (${refs.join(", ")})`);
  } else {
    console.log(`${tag} ok   ${url}`);
  }
}

console.log(
  `\n${byUrl.size - failed.length} of ${byUrl.size} datasheet URLs answer ` +
    `with a PDF (${Object.keys(DATASHEET_SOURCES).length} parts).`,
);
if (failed.length) {
  console.log("Failing — find a verified replacement in sources.js:");
  for (const { url, refs, error } of failed) {
    console.log(`  ${refs.join(", ")}: ${url} (${error})`);
  }
}
if (process.argv.includes("--strict") && failed.length) process.exit(1);
