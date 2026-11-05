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

// handler.js — the gallery's submission service (the gallery work, Phase 5):
// ONE request, `POST /v1/share` `{entry, design, appVersion}` from the app's
// Share to Gallery (src/app/gallery/share.js), turned into a pull request in
// the private chiphippo-gallery-submission repo for Jason to review. Pure
// apart from what it is handed (`github`, the `rate` store, `salt`), so the
// whole of it runs under `node --test`.
//
// IN ORDER, cheapest first, and nothing is written until all have passed:
//   · the size of the request, then its shape;
//   · the four fields, by the gallery's own rules (`checkEntryText`), then a
//     short word list (wording.js);
//   · the design: within the gallery's cap, JSON, a desktop snapshot. ONLY
//     its shape — the full validation (does it load whole?) needs the
//     catalog and the migrations, and runs in the submission repo's CI on
//     the RELEASED app's code, where Jason sees its verdict on the PR. The
//     app ran the same check before it let the share go;
//   · the rate limit: RATE_LIMIT shares an hour from one address, counted
//     against a salted hash of it that expires with the hour — the address
//     itself is never stored;
//   · the review queue: MAX_OPEN shares waiting, and the next is refused;
//   · the id (`entryIdFor`: the title's slug + the design's hash), so the
//     same design with the same title cannot wait twice.
//
// Answers `{ok: true, id, number, key}` or `{ok: false, code}` — the codes
// share.js knows. `number` is the pull request's and `key` its STATUS KEY
// (`statusKey`): an HMAC of both under the salt, so the sharer — and only the
// sharer — can ask later what became of it (`handleStatus`, `POST /v1/status`),
// and the service still keeps nothing.
//
// The web build calls from https://chiphippo.com, so every answer carries the
// CORS headers for that origin (`ALLOWED_ORIGINS`) and a preflight is
// answered; the desktop app's requests come from main and carry no origin.

import {
  ENTRY_ID_RE,
  ENTRY_SCHEMA,
  MAX_SNAPSHOT_BYTES,
  checkEntryText,
  entryIdFor,
} from "../../../src/web/scripts/gallery/entry-format.js";
import { wordingProblem } from "./wording.js";

/** The two paths the service answers: a share, and what became of one. */
export const SHARE_PATH = "/v1/share";
export const STATUS_PATH = "/v1/status";
/** The pages that may call it from a browser — the web build's site. */
export const ALLOWED_ORIGINS = Object.freeze([
  "https://chiphippo.com",
  "https://www.chiphippo.com",
]);
/** How long a status answer is reused, s — a review takes days, not minutes. */
export const STATUS_CACHE_S = 300;
/** The longest reviewer's note passed on, in characters. */
export const MAX_NOTE = 2000;
/** A request's largest body: the design at its cap, plus the fields. */
export const MAX_BODY_BYTES = MAX_SNAPSHOT_BYTES + 16 * 1024;
/** Shares one address may make in RATE_WINDOW_S. */
export const RATE_LIMIT = 5;
export const RATE_WINDOW_S = 3600;
/** Shares waiting for review before the next is refused. */
export const MAX_OPEN = 50;

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const bytesOf = (text) => new TextEncoder().encode(text).length;

/** A JSON answer. */
export function answer(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }, // prettier-ignore
  });
}

/** A refusal, by code. */
export const refuse = (status, code) => answer(status, { ok: false, code });

/** A share's status key: HMAC-SHA256 of its id and pull request, as hex. */
export async function statusKey(salt, id, number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`status:${salt}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); // prettier-ignore
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}#${number}`)); // prettier-ignore
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join(""); // prettier-ignore
}

/** Do two strings match, in time that doesn't say how much of them did? */
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false; // prettier-ignore
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** sha256 of a text, as hex. */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); // prettier-ignore
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""); // prettier-ignore
}

/** Is this text a desktop snapshot's SHAPE? (Not whether it loads — CI's.) */
export function looksLikeDesktop(text) {
  try {
    const raw = JSON.parse(text);
    return (
      Boolean(raw) &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      raw.kind === "desktop" &&
      Boolean(raw.doc) &&
      typeof raw.doc === "object" &&
      !Array.isArray(raw.doc)
    );
  } catch {
    return false;
  }
}

/**
 * Text a sharer wrote, made inert for the pull request's Markdown: every
 * punctuation mark Markdown or GitHub reads (an @-mention, a #-reference, a
 * link, a heading) escaped, so it shows as typed and pings nobody.
 */
export function inert(text) {
  return String(text).replace(/[\\`*_{}[\]()<>#+\-.!|~@:]/g, (c) => `\\${c}`);
}

/** The pull request's description: what Jason reviews beside the files. */
export function pullBody(entry, appVersion) {
  const lines = [
    `**Title:** ${inert(entry.title)}`,
    `**By:** ${inert(entry.author)}`,
    `**Tags:** ${entry.tags.length ? entry.tags.map(inert).join(", ") : "none"}`,
    `**Shared from:** Chip Hippo ${appVersion}`,
    "",
  ];
  if (entry.description) {
    lines.push(
      ...entry.description.split("\n").map((l) => `> ${inert(l)}`),
      "",
    );
  }
  lines.push(
    "Merge to publish it (the publish workflow copies it to chiphippo-gallery); close to turn it down.",
  );
  return lines.join("\n");
}

/** The CORS headers an answer to `origin` carries (none for another). */
function corsHeaders(origin) {
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

/**
 * Answer one request.
 * @param {Request} request
 * @param {{github: ReturnType<import("./github.js").makeGitHub>,
 *   rate: {get: (k: string) => Promise<string|null>,
 *     put: (k: string, v: string, o: object) => Promise<void>},
 *   salt: string, owner?: string, today?: () => string,
 *   cache?: {get: (k: string) => Promise<object|null>,
 *     put: (k: string, v: object) => Promise<void>}}} deps - `owner` is
 *   the reviewer's login (the submission repo's owner), whose comments are
 *   a share's reviewer's note; `cache` reuses status answers.
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, deps) {
  const url = new URL(request.url);
  const known = url.pathname === SHARE_PATH || url.pathname === STATUS_PATH;
  let res;
  if (!known) res = refuse(404, "notFound");
  else if (request.method === "OPTIONS")
    res = new Response(null, { status: 204 }); // prettier-ignore
  else if (request.method !== "POST") res = refuse(405, "method");
  else if (url.pathname === STATUS_PATH)
    res = await handleStatus(request, deps); // prettier-ignore
  else res = await handleShare(request, deps);
  for (const [name, value] of Object.entries(
    corsHeaders(request.headers.get("origin")),
  )) {
    // prettier-ignore
    res.headers.set(name, value);
  }
  return res;
}

/** `POST /v1/share`: one design, turned into a pull request. */
async function handleShare(
  request,
  { github, rate, salt, today = () => new Date().toISOString().slice(0, 10) },
) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return refuse(413, "tooBig"); // prettier-ignore
  const text = await request.text();
  if (bytesOf(text) > MAX_BODY_BYTES) return refuse(413, "tooBig");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(400, "invalid");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refuse(400, "invalid"); // prettier-ignore

  const { value: fields, problems } = checkEntryText(raw.entry);
  if (problems.length) return refuse(400, "invalid");
  if (wordingProblem(fields)) return refuse(422, "wording");

  const design = raw.design;
  if (typeof design !== "string") return refuse(400, "invalid");
  if (bytesOf(design) > MAX_SNAPSHOT_BYTES) return refuse(413, "tooBig");
  if (!looksLikeDesktop(design)) return refuse(400, "invalid");
  const appVersion = typeof raw.appVersion === "string" && VERSION_RE.test(raw.appVersion) ? raw.appVersion : "unknown"; // prettier-ignore

  const address = request.headers.get("cf-connecting-ip") ?? "";
  const key = `share:${await sha256Hex(`${salt}:${address}`)}`;
  const used = Number(await rate.get(key)) || 0;
  if (used >= RATE_LIMIT) return refuse(429, "rateLimited");

  const id = entryIdFor(fields.title, await sha256Hex(design));
  const branch = `share/${id}`;
  const entry = {
    schema: ENTRY_SCHEMA,
    id,
    kind: "design",
    ...fields,
    created: today(),
    source: "shared",
  };
  let number;
  try {
    if ((await github.openPullCount()) >= MAX_OPEN) return refuse(503, "busy");
    if (await github.branchExists(branch)) return refuse(409, "duplicate");
    ({ number } = await github.openShare({
      branch,
      files: {
        [`entries/${id}/entry.json`]: `${JSON.stringify(entry, null, 2)}\n`,
        [`entries/${id}/design.desktop.chiphippo`]: design,
      },
      message: `Share: ${fields.title}`,
      title: `Share: ${fields.title}`,
      body: pullBody(entry, appVersion),
    }));
  } catch (err) {
    if (err.code === "exists") return refuse(409, "duplicate");
    return refuse(502, "unavailable");
  }
  await rate.put(key, String(used + 1), { expirationTtl: RATE_WINDOW_S });
  return answer(200, { ok: true, id, number, key: await statusKey(salt, id, number) }); // prettier-ignore
}

/**
 * The reviewer's note on a share: the LATEST comment its reviewer left on the
 * pull request (the check's comments are a bot's, so never this), trimmed and
 * capped; "" when there is none. Shown to the sharer as plain text.
 */
export function reviewerNote(comments, owner) {
  if (!owner || !Array.isArray(comments)) return "";
  const own = comments.filter((c) => typeof c?.author === "string" && c.author.toLowerCase() === owner.toLowerCase() && typeof c.body === "string" && c.body.trim()); // prettier-ignore
  const last = own.at(-1);
  return last ? last.body.trim().slice(0, MAX_NOTE) : "";
}

/**
 * `POST /v1/status` `{id, number, key}`: what became of one share —
 * `{ok: true, status: "waiting" | "accepted" | "declined", note}`. Only with
 * the key the share was answered with, so nobody else learns whether a
 * design was turned down. Reused for STATUS_CACHE_S, so asking again and
 * again costs GitHub nothing.
 */
async function handleStatus(
  request,
  { github, salt, owner = "", cache = null },
) {
  const text = await request.text();
  if (bytesOf(text) > 4096) return refuse(413, "tooBig");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse(400, "invalid");
  }
  const { id, number, key } = raw ?? {};
  if (typeof id !== "string" || !ENTRY_ID_RE.test(id)) return refuse(400, "invalid"); // prettier-ignore
  if (!Number.isInteger(number) || number < 1) return refuse(400, "invalid");
  if (!sameText(key, await statusKey(salt, id, number))) return refuse(403, "forbidden"); // prettier-ignore

  const cacheKey = `status:${id}#${number}`;
  const kept = await cache?.get(cacheKey).catch(() => null);
  if (kept) return answer(200, kept);
  let pull;
  try {
    pull = await github.pullStatus(number);
  } catch {
    return refuse(502, "unavailable");
  }
  // The key names the pull request; its branch must be this share's.
  if (!pull || pull.head !== `share/${id}`) return refuse(404, "notFound");
  const body = {
    ok: true,
    status: pull.merged ? "accepted" : pull.open ? "waiting" : "declined",
    note: reviewerNote(pull.comments, owner),
  };
  await cache?.put(cacheKey, body).catch(() => {});
  return answer(200, body);
}
