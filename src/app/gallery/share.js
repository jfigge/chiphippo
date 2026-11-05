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

// share.js — Share to Gallery's one request (the gallery work, Phase 5):
// POST a desktop snapshot and the four fields its sharer wrote to the
// gallery's submission service (sources.js says where), which opens a pull
// request for it to be reviewed. Behind the `gallery` feature flag and the
// Share consent setting; main.js checks both, and the user's press of Share
// publicly, before calling in here.
//
// WHAT IS SENT is exactly what the Share dialog says: the design (the
// `.desktop.chiphippo` snapshot Export writes), the title, name, description
// and tags, and the version of the app. No settings, no paths, no machine
// identity — the service sees an IP address, as any server does, and keeps
// only a salted hash of it for its rate limit.
//
// Every failure is a CODED error, as client.js's are, so the renderer can say
// which one without parsing a message:
//   "invalid" (the service would not take it), "tooBig", "wording" (a field
//   the service's word check refused), "duplicate" (that design, with that
//   title, is already waiting for review), "rateLimited", "busy" (too many
//   shares waiting), "unavailable" (any other status, the network, a timeout).
"use strict";

const { shareUrl } = require("./sources");

/** How long a share may take, ms — the service writes to GitHub before it answers. */
const TIMEOUT_MS = 30_000;
/** The largest answer read back — it is a few dozen bytes of JSON. */
const MAX_ANSWER_BYTES = 16 * 1024;

/** The codes the service answers with that this client passes on as they are. */
const SHARE_CODES = Object.freeze([
  "invalid",
  "tooBig",
  "wording",
  "duplicate",
  "rateLimited",
  "busy",
  "unavailable",
]);

/** The code an answer without one of its own means, by HTTP status. */
const STATUS_CODES = Object.freeze({
  400: "invalid",
  409: "duplicate",
  413: "tooBig",
  422: "wording",
  429: "rateLimited",
  503: "busy",
});

const coded = (code, message) => Object.assign(new Error(message), { code });

/** The answer's JSON object, or null when it is not one (or too long). */
async function answerOf(res) {
  try {
    const text = await res.text();
    if (text.length > MAX_ANSWER_BYTES) return null;
    const raw = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Send one design for review.
 * @param {{design: string, entry: {title: string, author: string,
 *   description: string, tags: string[]}, appVersion: string}} share -
 *   `design` is the snapshot's JSON text; `entry` already passed
 *   `checkEntryText`.
 * @param {{where?: object, fetch?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<{id: string}>} the entry id the share was given.
 */
async function shareDesign(
  { design, entry, appVersion },
  { where, fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {},
) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(shareUrl(where), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entry, design, appVersion }),
      signal: abort.signal,
      credentials: "omit",
    });
    const answer = await answerOf(res);
    if (res.ok && answer?.ok === true && typeof answer.id === "string") {
      return { id: answer.id };
    }
    const code = SHARE_CODES.includes(answer?.code)
      ? answer.code
      : (STATUS_CODES[res.status] ?? "unavailable");
    throw coded(code, `the gallery's submission service answered ${res.status}`); // prettier-ignore
  } catch (err) {
    if (err.code) throw err;
    throw coded("unavailable", err.message || "the gallery could not be reached"); // prettier-ignore
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { shareDesign, SHARE_CODES, TIMEOUT_MS };
