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

// entry-format.js — ONE gallery entry's metadata (`entries/<id>/entry.json`),
// the shape everything in the gallery work hangs off
// (features/chiphippo-gallery-plan.md → Phase 1). Pure and DOM-free: the app,
// the web build, the CI scripts and the Worker all read it.
//
//   {
//     schema: 1,
//     id: "four-bit-counter-3fa9c1",      // slug + 6 hex of the content hash
//     kind: "design" | "challenge",
//     title, author, description, tags,  // what the sharer wrote
//     created: "2026-10-31",
//     source: "seed" | "maintainer" | "shared",
//     featured: false,
//     appVersion: "1.5.4",               // the PIN: the release it was validated on
//     docVersion: 15,                    // the desk schema it was saved at
//     derived: { engine, chips, parts, wires, families, level, autoTags },
//   }
//
// THE SHARER WRITES FOUR FIELDS (title, author, description, tags) and
// nothing else: `derived` is computed from the design (derive.js), `id`,
// `created`, `source`, `featured` and the pin by the gallery's CI. A field
// that is derived is never trusted from a client, so it is never READ from
// one — `checkEntryText` takes exactly the four.
//
// Reading is LENIENT (`normalizeEntry`: an index written by a newer gallery
// may carry fields this build does not know; they are dropped, and an entry
// with no usable id or title is no entry). Writing is STRICT (`checkEntryText`
// names each problem, for the Share dialog and the Worker to refuse with).

/** The entry schema this build writes and reads. */
export const ENTRY_SCHEMA = 1;

export const ENTRY_KINDS = Object.freeze(["design", "challenge"]);
export const ENTRY_SOURCES = Object.freeze(["seed", "maintainer", "shared"]);
/** Which engine a design needs: Spice Lite when it places a Spice-only part. */
export const ENGINES = Object.freeze(["logic", "spice"]);
export const LEVELS = Object.freeze(["beginner", "intermediate", "advanced"]);

export const MAX_TITLE = 80;
export const MAX_AUTHOR = 40;
export const MAX_DESCRIPTION = 1000;
export const MAX_TAG = 24;
export const MAX_TAGS = 8;
/** The largest design file the gallery takes, in bytes (as UTF-8) — here,
    in the dependency-free module, so main can hold a download to it. */
export const MAX_SNAPSHOT_BYTES = 512 * 1024;
/** The ROM bytes one design may carry, decoded. */
export const MAX_ROM_BYTES = 256 * 1024;
/** How long an id's slug may be (before its `-<6 hex>`). */
const MAX_SLUG = 40;

/** An entry id: a lowercase slug, then six hex digits of the content hash. */
export const ENTRY_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}$/;
const TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FAMILY_RE = /^[A-Za-z0-9]{1,16}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Control characters (a line break included) never belong in a one-line
// field; a description keeps its line breaks and loses the rest.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_NEWLINE_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** One line of text: controls out, runs of white space one space, trimmed. */
const oneLine = (v) =>
  typeof v === "string" ? v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim() : ""; // prettier-ignore

/** A paragraph: line breaks kept (\r\n → \n), other controls out, trimmed. */
const paragraph = (v) =>
  typeof v === "string"
    ? v.replace(/\r\n?/g, "\n").replace(CONTROL_BUT_NEWLINE_RE, " ").trim()
    : "";

/** A tag as the gallery spells it: lowercase words joined by `-`. */
export function normalizeTag(raw) {
  return oneLine(raw)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The slug an id starts with: the title in lowercase ASCII words joined by
 * `-` (accents folded), at most 40 characters, "design" when nothing is left.
 */
export function slugify(title) {
  const slug = oneLine(title)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG)
    .replace(/-+$/, "");
  return slug || "design";
}

/**
 * An entry's id: `slugify(title)` + the first six hex digits of its content
 * hash (`hashHex`, the gallery's sha256 of the design file).
 */
export function entryIdFor(title, hashHex) {
  const hex = String(hashHex ?? "")
    .toLowerCase()
    .replace(/^sha256-/, "");
  if (!/^[0-9a-f]{6}/.test(hex)) throw new Error("entryIdFor: needs a hex hash"); // prettier-ignore
  return `${slugify(title)}-${hex.slice(0, 6)}`;
}

/**
 * The four fields a sharer writes, held to the gallery's rules. Returns the
 * cleaned values and every problem found, each `{code, ...args}` (a catalog
 * key's arguments when the UI says it): titleMissing, titleTooLong,
 * authorMissing, authorTooLong, descriptionTooLong, tooManyTags, badTag.
 * @param {{title?: unknown, author?: unknown, description?: unknown,
 *   tags?: unknown}} raw - anything; a non-object reads as no fields
 * @returns {{value: {title: string, author: string, description: string,
 *   tags: string[]}, problems: object[]}}
 */
export function checkEntryText(raw) {
  // Whatever arrived (`{"entry": null}`, a string, a list) is read as no
  // fields at all — answered with problems, never a throw.
  const fields = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}; // prettier-ignore
  const problems = [];
  const title = oneLine(fields.title);
  if (!title) problems.push({ code: "titleMissing" });
  else if (title.length > MAX_TITLE) problems.push({ code: "titleTooLong", max: MAX_TITLE }); // prettier-ignore
  const author = oneLine(fields.author);
  if (!author) problems.push({ code: "authorMissing" });
  else if (author.length > MAX_AUTHOR) problems.push({ code: "authorTooLong", max: MAX_AUTHOR }); // prettier-ignore
  const description = paragraph(fields.description);
  if (description.length > MAX_DESCRIPTION) {
    problems.push({ code: "descriptionTooLong", max: MAX_DESCRIPTION });
  }
  const tags = [];
  for (const raw of Array.isArray(fields.tags) ? fields.tags : []) {
    const tag = normalizeTag(raw);
    if (!tag) continue;
    if (tag.length > MAX_TAG || !TAG_RE.test(tag)) {
      problems.push({ code: "badTag", tag: oneLine(raw) });
    } else if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  if (tags.length > MAX_TAGS) problems.push({ code: "tooManyTags", max: MAX_TAGS }); // prettier-ignore
  return { value: { title, author, description, tags }, problems };
}

const pick = (list, v, fallback) => (list.includes(v) ? v : fallback);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

/** The derived block, as read: every field present, junk at its default. */
export function normalizeDerived(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const words = (v) =>
    Array.isArray(v) ? [...new Set(v.map(normalizeTag).filter((t) => TAG_RE.test(t)))] : []; // prettier-ignore
  return {
    engine: pick(ENGINES, d.engine, "logic"),
    chips: count(d.chips),
    parts: count(d.parts),
    wires: count(d.wires),
    // A family keeps the catalog's spelling ("74LS", "CD4000"), not a tag's.
    families: Array.isArray(d.families)
      ? [...new Set(d.families.filter((f) => typeof f === "string" && FAMILY_RE.test(f)))] // prettier-ignore
      : [],
    level: pick(LEVELS, d.level, "beginner"),
    autoTags: words(d.autoTags),
  };
}

/**
 * An entry as READ (the index, an entry.json): the known fields only, each
 * held to its shape; null when there is no entry — no valid id, or no title.
 * Text over its limit is CUT here, never refused: it was accepted by whatever
 * wrote it, and a reader's job is to show it.
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.id !== "string" || !ENTRY_ID_RE.test(raw.id)) return null;
  const title = oneLine(raw.title).slice(0, MAX_TITLE);
  if (!title) return null;
  const tags = [];
  for (const t of Array.isArray(raw.tags) ? raw.tags : []) {
    const tag = normalizeTag(t);
    if (TAG_RE.test(tag) && tag.length <= MAX_TAG && !tags.includes(tag)) tags.push(tag); // prettier-ignore
  }
  return {
    schema: ENTRY_SCHEMA,
    id: raw.id,
    kind: pick(ENTRY_KINDS, raw.kind, "design"),
    title,
    author: oneLine(raw.author).slice(0, MAX_AUTHOR),
    description: paragraph(raw.description).slice(0, MAX_DESCRIPTION),
    tags: tags.slice(0, MAX_TAGS),
    created: typeof raw.created === "string" && DATE_RE.test(raw.created) ? raw.created : "", // prettier-ignore
    source: pick(ENTRY_SOURCES, raw.source, "shared"),
    featured: raw.featured === true,
    appVersion: typeof raw.appVersion === "string" && VERSION_RE.test(raw.appVersion) ? raw.appVersion : "", // prettier-ignore
    docVersion: count(raw.docVersion),
    derived: normalizeDerived(raw.derived),
  };
}

/**
 * Compare two `x.y.z` versions: negative when `a` is older, 0 when equal,
 * positive when newer. A malformed one counts as 0.0.0 (older than any).
 */
export function compareVersions(a, b) {
  const parts = (v) =>
    typeof v === "string" && VERSION_RE.test(v) ? v.split(".").map(Number) : [0, 0, 0]; // prettier-ignore
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * Text a sharer wrote, made inert for GitHub Markdown (the share's pull
 * request, the submission check's review comment): every
 * punctuation mark Markdown or GitHub reads (an @-mention, a #-reference, a
 * link, a heading — `#` or a setext `===` underline) escaped, so it shows as
 * typed and pings nobody.
 */
export function inert(text) {
  return String(text).replace(/[\\`*_{}[\]()<>#+\-.!|~@:=]/g, (c) => `\\${c}`);
}
