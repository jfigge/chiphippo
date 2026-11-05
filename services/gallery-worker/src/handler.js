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
// Answers `{ok: true, id}` or `{ok: false, code}` — the codes share.js knows.

import {
  ENTRY_SCHEMA,
  MAX_SNAPSHOT_BYTES,
  checkEntryText,
  entryIdFor,
} from "../../../src/web/scripts/gallery/entry-format.js";
import { wordingProblem } from "./wording.js";

/** The one path the service answers. */
export const SHARE_PATH = "/v1/share";
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

/**
 * Answer one request.
 * @param {Request} request
 * @param {{github: ReturnType<import("./github.js").makeGitHub>,
 *   rate: {get: (k: string) => Promise<string|null>,
 *     put: (k: string, v: string, o: object) => Promise<void>},
 *   salt: string, today?: () => string}} deps
 * @returns {Promise<Response>}
 */
export async function handleRequest(
  request,
  { github, rate, salt, today = () => new Date().toISOString().slice(0, 10) },
) {
  const url = new URL(request.url);
  if (url.pathname !== SHARE_PATH) return refuse(404, "notFound");
  if (request.method !== "POST") return refuse(405, "method");

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
  try {
    if ((await github.openPullCount()) >= MAX_OPEN) return refuse(503, "busy");
    if (await github.branchExists(branch)) return refuse(409, "duplicate");
    await github.openShare({
      branch,
      files: {
        [`entries/${id}/entry.json`]: `${JSON.stringify(entry, null, 2)}\n`,
        [`entries/${id}/design.desktop.chiphippo`]: design,
      },
      message: `Share: ${fields.title}`,
      title: `Share: ${fields.title}`,
      body: pullBody(entry, appVersion),
    });
  } catch (err) {
    if (err.code === "exists") return refuse(409, "duplicate");
    return refuse(502, "unavailable");
  }
  await rate.put(key, String(used + 1), { expirationTtl: RATE_WINDOW_S });
  return answer(200, { ok: true, id });
}
