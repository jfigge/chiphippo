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

// store-format.js — a PRIVATE STORE's layout (the private stores work,
// .claude/rules/stores.md): a folder tree on a platform the user already has
// — a folder their Google Drive, Dropbox, OneDrive or iCloud client syncs, or
// a private GitHub repository — that they and the friends they share it with
// keep designs in. Pure and dependency-free: main require()s it (as it does
// entry-format.js), the renderer imports it.
//
//   chiphippo-store.json                     {format, id, name, created}
//   entries/<entry>/entry.json               title, author, description, tags
//   entries/<entry>/revs/<rev>.desktop.chiphippo   the design (a snapshot)
//   entries/<entry>/revs/<rev>.png           its board's picture (optional)
//   entries/<entry>/revs/<rev>.json          {author, note, at, base, …}
//
// NOTHING IN A STORE IS EVER EDITED, ONLY ADDED. Two people never write the
// same file, so a sync client never makes a "conflicted copy" and a GitHub
// push never needs a merge. A change to a design is a new REVISION naming the
// one it was made from (`base`); the newest revision with nothing built on it
// is the head, and two of those (two friends saving from the same revision)
// is a FORK the reader is shown, never silently resolved.
//
// A revision's meta file is written LAST, as its commit mark: a design whose
// meta has not arrived (a sync still under way, a save cut off) is no
// revision yet, and an entry with no revision is no entry.
//
// Every name a store holds is built here and read back here
// (`parseStorePath`); anything else a folder carries — `.DS_Store`, a sync
// client's `foo (1).json`, a stray file — is not part of the store at all.

import {
  ENTRY_ID_RE,
  MAX_AUTHOR,
  MAX_DESCRIPTION,
  MAX_TAG,
  MAX_TAGS,
  MAX_TITLE,
  normalizeDerived,
  normalizeTag,
} from "../gallery/entry-format.js";

/** The store layout this build writes and reads. */
export const STORE_FORMAT = 1;
/** The file that makes a folder a store. */
export const STORE_FILE = "chiphippo-store.json";
/** A store's id: minted once, when it is made; what a share link names. */
export const STORE_ID_RE = /^s-[0-9a-f]{16}$/;
/** A revision: its UTC time to the second, then 10 hex of its design's hash. */
export const REV_RE = /^\d{8}T\d{6}Z-[0-9a-f]{10}$/;
/** Where a store can live. */
export const STORE_KINDS = Object.freeze(["folder", "github"]);
/** The cloud a FOLDER store is synced by — only what the friend is told. */
export const FOLDER_PROVIDERS = Object.freeze([
  "gdrive",
  "dropbox",
  "onedrive",
  "icloud",
  "other",
]);
/** The folder inside a repository a store lives in — "" for the repository's
    root (a repository Chip Hippo made), else plain names joined by "/"
    (a repository the user already had, the store kept out of the way of
    what else is in it). Never "." or "..", never a leading or trailing "/". */
export const GITHUB_DIR_RE =
  /^(?:(?!\.\.?(?:\/|$))[A-Za-z0-9._-]{1,64})(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9._-]{1,64}){0,3}$/;

/** A store folder name held to GITHUB_DIR_RE, "" when there is none (the
    root), or null when it is not one. */
export function githubDir(raw) {
  if (raw == null || raw === "") return "";
  const dir = String(raw)
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!dir) return "";
  return dir.length <= 120 && GITHUB_DIR_RE.test(dir) ? dir : null;
}

/** A GitHub repository, `owner/name`, by GitHub's own rules. */
export const GITHUB_REPO_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

export const MAX_STORE_NAME = 60;
export const MAX_NOTE = 500;
/** The most of each a reader takes from one store (a hand-filled folder
    must not make the Browse window read for minutes). */
export const MAX_STORE_ENTRIES = 500;
export const MAX_ENTRY_REVS = 200;
/** The largest of each small file a reader reads. */
export const MAX_META_BYTES = 16 * 1024;
export const MAX_THUMB_BYTES = 512 * 1024;
/** The longest share link worth reading. */
export const MAX_LINK_LENGTH = 1024;

/** The share link's two forms: the app's own scheme, and the web page a
    mail client will make clickable (website/store/). */
export const LINK_SCHEME = "chiphippo://store/add";
export const LINK_PAGE = "https://chiphippo.com/store/";

// Control characters never belong in a one-line field — nor the bidi
// controls, which would let a friend's name reorder the text around it.
const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const CONTROL_BUT_NEWLINE_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const oneLine = (v) =>
  typeof v === "string" ? v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim() : ""; // prettier-ignore
const paragraph = (v) =>
  typeof v === "string"
    ? v.replace(/\r\n?/g, "\n").replace(CONTROL_BUT_NEWLINE_RE, " ").trim()
    : "";
/** `text` cut to `max` UTF-16 units — never through the middle of a pair
    (an emoji cut in half is a lone surrogate, U+FFFD once encoded). */
const cut = (text, max) => {
  const out = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
};
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoOr = (v, fallback = "") =>
  typeof v === "string" && ISO_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : fallback; // prettier-ignore
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const plainObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** A store's name, held to one line and its length. */
export function storeName(raw) {
  return cut(oneLine(raw), MAX_STORE_NAME);
}

// ── The manifest ─────────────────────────────────────────────────────────────

/** The manifest a new store is made with. */
export function makeManifest({ id, name, created }) {
  if (!STORE_ID_RE.test(id ?? "")) throw new Error("makeManifest: bad id");
  return {
    format: STORE_FORMAT,
    id,
    name: storeName(name) || "Designs",
    created: isoOr(created, new Date(0).toISOString()),
  };
}

/**
 * A manifest as READ — null when it is none (no id, junk). A store written
 * by a NEWER layout is still read: what this build cannot follow in it is
 * ignored, and `newer` says so.
 */
export function normalizeManifest(raw) {
  if (!plainObject(raw) || !STORE_ID_RE.test(raw.id ?? "")) return null;
  const format = Number.isInteger(raw.format) && raw.format > 0 ? raw.format : STORE_FORMAT; // prettier-ignore
  return {
    format,
    id: raw.id,
    name: storeName(raw.name) || raw.id,
    created: isoOr(raw.created),
    newer: format > STORE_FORMAT,
  };
}

// ── Names ────────────────────────────────────────────────────────────────────

const EXT = Object.freeze({
  design: ".desktop.chiphippo",
  thumb: ".png",
  meta: ".json",
});

/** An entry's metadata file. */
export function entryPath(entry) {
  if (!ENTRY_ID_RE.test(entry ?? "")) throw new Error("entryPath: bad entry");
  return `entries/${entry}/entry.json`;
}

/** One of a revision's files: `part` is "design" | "thumb" | "meta". */
export function revPath(entry, rev, part) {
  if (!ENTRY_ID_RE.test(entry ?? "")) throw new Error("revPath: bad entry");
  if (!REV_RE.test(rev ?? "")) throw new Error("revPath: bad rev");
  if (!EXT[part]) throw new Error("revPath: bad part");
  return `entries/${entry}/revs/${rev}${EXT[part]}`;
}

/**
 * What a path inside a store is — `{kind: "manifest"}`, `{kind: "entry",
 * entry}`, `{kind: "rev", entry, rev, part}` — or null for anything that is
 * not part of the store. Forward slashes, relative to the store's root.
 */
export function parseStorePath(rel) {
  if (typeof rel !== "string") return null;
  if (rel === STORE_FILE) return { kind: "manifest" };
  let m = /^entries\/([^/]+)\/entry\.json$/.exec(rel);
  if (m) return ENTRY_ID_RE.test(m[1]) ? { kind: "entry", entry: m[1] } : null;
  m = /^entries\/([^/]+)\/revs\/([^/]+?)(\.desktop\.chiphippo|\.png|\.json)$/.exec(rel); // prettier-ignore
  if (!m || !ENTRY_ID_RE.test(m[1]) || !REV_RE.test(m[2])) return null;
  const part = Object.keys(EXT).find((k) => EXT[k] === m[3]);
  return { kind: "rev", entry: m[1], rev: m[2], part };
}

/**
 * A revision's id: `at` (a Date or ms) in UTC to the second, then ten hex of
 * the design's hash — so revisions sort by time, and two saved in the same
 * second are told apart by what they hold.
 */
export function revIdFor(at, hashHex) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) throw new Error("revIdFor: bad time");
  const hex = String(hashHex ?? "").toLowerCase();
  if (!/^[0-9a-f]{10}/.test(hex)) throw new Error("revIdFor: needs a hex hash");
  const stamp = d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${hex.slice(0, 10)}`;
}

/** When a revision was made (ms), read off its id. */
export function revTime(rev) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(rev ?? "");
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

// ── An entry, a revision ─────────────────────────────────────────────────────

/** An entry.json as READ (lenient: cut, never refused), or null. */
export function normalizeStoreEntry(raw, entry) {
  if (!plainObject(raw) || raw.id !== entry || !ENTRY_ID_RE.test(entry ?? "")) {
    return null;
  }
  const title = cut(oneLine(raw.title), MAX_TITLE);
  if (!title) return null;
  const tags = [];
  for (const t of Array.isArray(raw.tags) ? raw.tags : []) {
    const tag = normalizeTag(t);
    if (tag && tag.length <= MAX_TAG && /^[a-z0-9-]+$/.test(tag) && !tags.includes(tag)) tags.push(tag); // prettier-ignore
  }
  return {
    id: entry,
    title,
    author: cut(oneLine(raw.author), MAX_AUTHOR),
    description: cut(paragraph(raw.description), MAX_DESCRIPTION),
    tags: tags.slice(0, MAX_TAGS),
    created: isoOr(raw.created),
  };
}

/** The entry.json a new entry is written with. */
export function makeStoreEntry({
  id,
  title,
  author,
  description,
  tags,
  created,
}) {
  const e = normalizeStoreEntry({ id, title, author, description, tags, created }, id); // prettier-ignore
  if (!e) throw new Error("makeStoreEntry: needs an id and a title");
  return { schema: 1, ...e };
}

/** A revision's meta as READ, or null — its own name must be its `rev`. */
export function normalizeRevMeta(raw, rev) {
  if (!plainObject(raw) || raw.rev !== rev || !REV_RE.test(rev ?? "")) return null; // prettier-ignore
  return {
    rev,
    base: REV_RE.test(raw.base ?? "") && raw.base !== rev ? raw.base : null,
    author: cut(oneLine(raw.author), MAX_AUTHOR),
    note: cut(paragraph(raw.note), MAX_NOTE),
    at: isoOr(raw.at, new Date(revTime(rev)).toISOString()),
    appVersion: typeof raw.appVersion === "string" && VERSION_RE.test(raw.appVersion) ? raw.appVersion : "", // prettier-ignore
    docVersion: Number.isInteger(raw.docVersion) && raw.docVersion > 0 ? raw.docVersion : 0, // prettier-ignore
    derived: normalizeDerived(raw.derived),
  };
}

/** The meta a new revision is written with. */
export function makeRevMeta(fields) {
  const meta = normalizeRevMeta(fields, fields?.rev);
  if (!meta) throw new Error("makeRevMeta: bad rev");
  return { schema: 1, ...meta };
}

// ── Reading a whole store ────────────────────────────────────────────────────

/**
 * The files a reader must READ to draw a store, given every path it holds:
 * each entry's entry.json and each revision's meta whose design is there
 * (newest revisions first, within the caps).
 * @param {string[]} paths
 * @returns {string[]}
 */
export function pathsToRead(paths) {
  const { entries } = groupPaths(paths);
  const out = [];
  for (const [entry, g] of entries) {
    if (!g.entryFile) continue;
    const revs = [...g.revs.values()].filter((r) => r.design && r.meta);
    if (!revs.length) continue;
    out.push(entryPath(entry));
    for (const r of revs) out.push(revPath(entry, r.rev, "meta"));
  }
  return out;
}

/** Every path grouped by entry: `{entries: Map(entry → {entryFile, revs})}`,
    newest entries (by their newest revision) first, within the caps. */
function groupPaths(paths) {
  const all = new Map();
  for (const rel of Array.isArray(paths) ? paths : []) {
    const p = parseStorePath(rel);
    if (!p || p.kind === "manifest") continue;
    let g = all.get(p.entry);
    if (!g) all.set(p.entry, (g = { entryFile: false, revs: new Map() }));
    if (p.kind === "entry") {
      g.entryFile = true;
      continue;
    }
    let r = g.revs.get(p.rev);
    if (!r) g.revs.set(p.rev, (r = { rev: p.rev, design: false, thumb: false, meta: false })); // prettier-ignore
    r[p.part] = true;
  }
  // Only what can BE shown counts toward the caps: a revision is its design
  // and its meta (the commit mark), an entry its entry.json and at least one
  // such revision — so files that never complete (a save cut off, or junk
  // named like revisions) can never push real ones out of view.
  for (const [entry, g] of all) {
    for (const [rev, r] of g.revs) if (!r.design || !r.meta) g.revs.delete(rev);
    if (!g.entryFile || !g.revs.size) all.delete(entry);
  }
  const newest = (g) => [...g.revs.keys()].sort().at(-1) ?? "";
  const ordered = [...all.entries()]
    .sort(([, a], [, b]) => newest(b).localeCompare(newest(a)))
    .slice(0, MAX_STORE_ENTRIES)
    .map(([entry, g]) => {
      const revs = [...g.revs.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, MAX_ENTRY_REVS);
      return [entry, { ...g, revs: new Map(revs) }];
    });
  return { entries: new Map(ordered) };
}

/**
 * A whole store as the Browse window draws it.
 *
 * @param {object} opts
 * @param {string[]} opts.paths - every path the store holds.
 * @param {(rel: string) => unknown} opts.read - a file `pathsToRead` named,
 *   PARSED (undefined/null when it could not be read).
 * @returns {{entries: object[]}} each entry `{id, title, author, description,
 *   tags, created, derived, featured: false, revs, head, leaves, forked}`,
 *   `revs` newest first (each its meta + `thumb`), newest head first.
 */
export function buildStoreView({ paths, read }) {
  const { entries } = groupPaths(paths);
  const out = [];
  for (const [entry, g] of entries) {
    if (!g.entryFile) continue;
    const info = normalizeStoreEntry(read(entryPath(entry)), entry);
    if (!info) continue;
    const revs = [];
    for (const r of g.revs.values()) {
      if (!r.design || !r.meta) continue;
      const meta = normalizeRevMeta(read(revPath(entry, r.rev, "meta")), r.rev);
      if (meta) revs.push({ ...meta, thumb: r.thumb });
    }
    if (!revs.length) continue;
    const { head, leaves } = headOf(revs);
    if (!head) continue;
    out.push({
      ...info,
      // The gallery grid's fields (gallery-view.js): the head's
      author: head.author || info.author,
      derived: head.derived,
      created: info.created || head.at,
      featured: false,
      revs,
      head,
      leaves,
      forked: leaves.length > 1,
    });
  }
  out.sort((a, b) => b.head.rev.localeCompare(a.head.rev));
  return { entries: out };
}

/**
 * An entry's head and its LEAVES (the revisions nothing is built on, newest
 * first): the head is the newest leaf. A base this reader cannot see (not yet
 * synced, or past the caps) does not make its child a leaf of anything — it
 * is simply not an ancestor here.
 * @param {{rev: string, base: string|null}[]} revs
 */
export function headOf(revs) {
  // A base counts only when it sorts BEFORE the revision naming it (a rev's
  // id starts with its time, so: made earlier, and within one second the
  // lower id): a store anyone can write to may hold a cycle — A naming B
  // and B naming A — and only one direction of a pair can ever count, so a
  // cycle never hides both. The app always stamps a revision at least a
  // second after its base (service.js), so a real link always counts.
  const built = new Set(
    revs.filter((r) => r.base && r.base < r.rev).map((r) => r.base),
  );
  const newestFirst = [...revs].sort((a, b) => b.rev.localeCompare(a.rev));
  // The newest revision is always a leaf: nothing sorts after it, so
  // nothing can count it as a base — an entry is never headless.
  const leaves = newestFirst.filter((r) => !built.has(r.rev));
  return { head: leaves[0] ?? null, leaves };
}

/**
 * What a save from revision `base` will be, against the entry as read now:
 *   · "new"     — no entry yet (or none to name);
 *   · "next"    — nothing is built on `base` yet (it is the head, or the
 *                 other leaf of a fork): the save simply follows it;
 *   · "behind"  — someone has saved a revision BUILT ON `base`: saving now
 *                 makes a fork, so the user is asked first.
 * @param {{revs: object[], head: object}|null} entry
 * @param {string|null} base
 */
export function saveVerdict(entry, base) {
  if (!entry?.head) return "new";
  if (!base) return "behind";
  const leaves = entry.leaves ?? [entry.head];
  return leaves.some((r) => r.rev === base) ? "next" : "behind";
}

// ── The share link ───────────────────────────────────────────────────────────

const b64url = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64url = (text) => {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(bin, (c) => c.charCodeAt(0)),
  );
};

/**
 * Where a store is, as a share link carries it — `{id, name, kind, where}`
 * held to shape, or null. NO SECRET IS EVER IN ONE: `where` says where to
 * look (`{repo}` for GitHub, `{provider}` for a synced folder), and the
 * platform's own sharing decides whether the friend can look there.
 */
export function normalizeStoreRef(raw) {
  if (!plainObject(raw) || !STORE_ID_RE.test(raw.id ?? "")) return null;
  const name = storeName(raw.name) || raw.id;
  const where = plainObject(raw.where) ? raw.where : {};
  if (raw.kind === "github") {
    if (!GITHUB_REPO_RE.test(where.repo ?? "")) return null;
    const dir = githubDir(where.dir);
    if (dir == null) return null;
    return { id: raw.id, name, kind: "github", where: { repo: where.repo, ...(dir ? { dir } : {}) } }; // prettier-ignore
  }
  if (raw.kind === "folder") {
    const provider = FOLDER_PROVIDERS.includes(where.provider) ? where.provider : "other"; // prettier-ignore
    return { id: raw.id, name, kind: "folder", where: { provider } };
  }
  return null;
}

/**
 * The link that adds a store: the web page's form (what a mail client makes
 * clickable — `web: true`, the default) or the app's own scheme. The store is
 * in the FRAGMENT, so the page's server never sees it.
 */
export function storeLink(ref, { web = true } = {}) {
  const clean = normalizeStoreRef(ref);
  if (!clean) return null;
  const payload = b64url(JSON.stringify({ v: 1, ...clean }));
  return `${web ? LINK_PAGE : LINK_SCHEME}#${payload}`;
}

/**
 * Read a share link — either form, pasted with stray white space or angle
 * brackets around it — back into a store ref, or null.
 */
export function parseStoreLink(text) {
  if (typeof text !== "string" || text.length > MAX_LINK_LENGTH) return null;
  const link = text.trim().replace(/^<|>$/g, "");
  const m = /^(?:chiphippo:\/\/store\/add\/?|https:\/\/(?:www\.)?chiphippo\.com\/store\/?(?:index\.html)?)#([A-Za-z0-9_-]+)$/i.exec(link); // prettier-ignore
  if (!m) return null;
  try {
    const raw = JSON.parse(unb64url(m[1]));
    if (raw?.v !== 1) return null;
    return normalizeStoreRef(raw);
  } catch {
    return null;
  }
}

// ── Where a desktop came from ────────────────────────────────────────────────

/**
 * A desktop's link back to the store revision it was opened from (or last
 * saved as) — `{store, entry, rev}` held to shape, or null. Kept on the
 * project's tab (omit-when-absent), so Save to Store… knows which entry it
 * revises and from which revision, across a save and a reopen.
 */
export function normalizeStoreFrom(raw) {
  if (!plainObject(raw)) return null;
  const { store, entry, rev } = raw;
  if (!STORE_ID_RE.test(store ?? "") || !ENTRY_ID_RE.test(entry ?? "") || !REV_RE.test(rev ?? "")) return null; // prettier-ignore
  return { store, entry, rev };
}
