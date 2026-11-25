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

// stores/registry.js — the PRIVATE STORES this machine has added (the private
// stores work, .claude/rules/stores.md): pure list arithmetic over settings'
// main-owned `stores`. No filesystem, no network.
//
// The list is MAIN-OWNED for the reason `recentProjects` is: a folder store's
// path is an ALLOWLIST — what main may read and write in the sessions after
// the dialog that chose it — so a renderer that could write the list could
// aim main at any folder on disk. And it holds no secret: a GitHub store says
// which repository, never how to get in (the sign-in is credential-store's).
//
//   { id, name, kind: "folder", where: { path, grant, provider }, added }
//   { id, name, kind: "github", where: { repo, dir? }, added }
//
// `grant` is the folder the dialog handed over — the store folder itself, or
// the one a new store was made INSIDE — which is what a Mac App Store build's
// security-scoped bookmark is held for (bookmark-store.js).
"use strict";

const path = require("node:path");

const {
  FOLDER_PROVIDERS,
  GITHUB_REPO_RE,
  STORE_ID_RE,
  githubDir,
  storeName,
} = require("../../web/scripts/stores/store-format.js");

/** How many stores one machine keeps. */
const MAX_STORES = 20;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** One record held to its shape, or null. */
function sanitizeStore(raw) {
  if (!raw || typeof raw !== "object" || !STORE_ID_RE.test(raw.id ?? "")) {
    return null;
  }
  const name = storeName(raw.name) || raw.id;
  const added = typeof raw.added === "string" && ISO_RE.test(raw.added) ? raw.added : ""; // prettier-ignore
  const where = raw.where && typeof raw.where === "object" ? raw.where : {};
  if (raw.kind === "folder") {
    const p = where.path;
    if (typeof p !== "string" || !p || !path.isAbsolute(p)) return null;
    const grant = typeof where.grant === "string" && path.isAbsolute(where.grant) && isInside(p, where.grant) ? where.grant : p; // prettier-ignore
    const provider = FOLDER_PROVIDERS.includes(where.provider) ? where.provider : "other"; // prettier-ignore
    return { id: raw.id, name, kind: "folder", where: { path: p, grant, provider }, added }; // prettier-ignore
  }
  if (raw.kind === "github") {
    if (!GITHUB_REPO_RE.test(where.repo ?? "")) return null;
    // `dir`: the folder the store is in, for one kept in a repository the
    // user already had; absent, the repository's root.
    const dir = githubDir(where.dir);
    if (dir == null) return null;
    return { id: raw.id, name, kind: "github", where: { repo: where.repo, ...(dir ? { dir } : {}) }, added }; // prettier-ignore
  }
  return null;
}

/** Is `inner` the folder `outer`, or inside it? */
function isInside(inner, outer) {
  const rel = path.relative(path.resolve(outer), path.resolve(inner));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The stored list: every record held to shape, one per id, capped. */
function sanitizeStores(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = sanitizeStore(raw);
    if (s && !out.some((o) => o.id === s.id)) out.push(s);
  }
  return out.slice(0, MAX_STORES);
}

/**
 * The list with `store` in it: a store already there (by id) is REPLACED in
 * place — adding a store again from its link, or from another folder, is the
 * same store found somewhere new. A new one goes last. `{list, added}`;
 * `added` false when the list is full or the record is junk.
 */
function addStore(list, store) {
  const clean = sanitizeStores(list);
  const s = sanitizeStore(store);
  if (!s) return { list: clean, added: false };
  const at = clean.findIndex((o) => o.id === s.id);
  if (at >= 0) {
    const next = [...clean];
    next[at] = { ...s, added: clean[at].added || s.added };
    return { list: next, added: true };
  }
  if (clean.length >= MAX_STORES) return { list: clean, added: false };
  return { list: [...clean, s], added: true };
}

/** The list without store `id`. */
function removeStore(list, id) {
  return sanitizeStores(list).filter((s) => s.id !== id);
}

/** Store `id` from the list, or null. */
function findStore(list, id) {
  return sanitizeStores(list).find((s) => s.id === id) ?? null;
}

/** Rename store `id` on this machine only (the manifest keeps its own). */
function renameStore(list, id, name) {
  const clean = storeName(name);
  if (!clean) return sanitizeStores(list);
  return sanitizeStores(list).map((s) => (s.id === id ? { ...s, name: clean } : s)); // prettier-ignore
}

/**
 * What a share link says about a store (store-format.js `normalizeStoreRef`):
 * where to look, never this machine's path to it.
 */
function storeRefOf(store) {
  const s = sanitizeStore(store);
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    where:
      s.kind === "github"
        ? { repo: s.where.repo, ...(s.where.dir ? { dir: s.where.dir } : {}) }
        : { provider: s.where.provider },
  };
}

/** The folders a Mac App Store build keeps bookmarks for. */
function storeGrants(list) {
  return sanitizeStores(list)
    .filter((s) => s.kind === "folder")
    .map((s) => s.where.grant);
}

module.exports = {
  MAX_STORES,
  addStore,
  findStore,
  isInside,
  removeStore,
  renameStore,
  sanitizeStores,
  storeGrants,
  storeRefOf,
};
