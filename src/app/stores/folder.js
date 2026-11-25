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

// stores/folder.js — a private store in a FOLDER (the private stores work,
// .claude/rules/stores.md): the backend that needs no sign-in, because the
// folder's own sync client — Google Drive for desktop, Dropbox, OneDrive,
// iCloud Drive, Syncthing, a network share — does the syncing and the sharing.
//
// A backend does three things and no more: LIST the store's paths, READ one
// file (capped), ADD one file. It never edits or deletes: the layout is
// append-only (store-format.js), which is what keeps two machines writing to
// one synced folder from ever making a conflicted copy. Every path is one
// store-format.js built, and is resolved INSIDE the store's root or refused.
//
// A Mac App Store build reaches the folder through its bookmark: every call
// runs inside `access(fn)` (main hands in the bookmark store's `withAccess`
// for the folder the dialog granted).
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const io = require("../store/io");
const {
  MAX_ENTRY_REVS,
  MAX_STORE_ENTRIES,
  STORE_FILE,
  STORE_ID_RE,
  makeManifest,
  normalizeManifest,
  parseStorePath,
} = require("../../web/scripts/stores/store-format.js");

/** A coded failure: the codes the Add-store and Save cards have words for. */
const fail = (code, message = code) => Object.assign(new Error(message), { code }); // prettier-ignore

/** The most directory entries one listing step reads (a hand-filled folder
    must not hang the Browse window). */
const MAX_DIR_ITEMS = 4 * MAX_STORE_ENTRIES;

class FolderBackend {
  /**
   * @param {string} root - the store's folder (absolute).
   * @param {{access?: (fn: Function) => unknown}} [opts]
   */
  constructor(root, { access = (fn) => fn() } = {}) {
    if (typeof root !== "string" || !path.isAbsolute(root)) {
      throw fail("invalid", "a folder store needs an absolute path");
    }
    this.root = path.resolve(root);
    this._access = access;
  }

  /** `rel` as an absolute path inside the root — or a throw. */
  _resolve(rel) {
    if (rel !== STORE_FILE && !parseStorePath(rel)) throw fail("invalid", `not a store path: ${rel}`); // prettier-ignore
    const full = path.resolve(this.root, ...rel.split("/"));
    if (!full.startsWith(this.root + path.sep)) throw fail("invalid");
    return full;
  }

  /** The store's manifest, or null (no store here, or one unreadable). */
  async manifest() {
    const bytes = await this.read(STORE_FILE, { max: 16 * 1024 });
    if (!bytes) return null;
    try {
      return normalizeManifest(JSON.parse(bytes.toString("utf8")));
    } catch {
      return null;
    }
  }

  /**
   * Is `full` (a path `_resolve` built) really inside the store? The text
   * check in `_resolve` is not enough in a folder a friend can write to: a
   * SYMLINK there — a file, or a folder on the way — could lead anywhere on
   * this computer. So the deepest folder on the way that exists is resolved
   * for real and must lie under the root's real path.
   */
  async _contained(full) {
    const realRoot = await fs.promises.realpath(this.root);
    let dir = path.dirname(full);
    for (;;) {
      try {
        const real = await fs.promises.realpath(dir);
        return real === realRoot || real.startsWith(realRoot + path.sep);
      } catch (err) {
        if (err?.code !== "ENOENT") return false;
        if (dir === this.root || dir === path.dirname(dir)) return false;
        dir = path.dirname(dir);
      }
    }
  }

  /** Every store path the folder holds (store-format.js names only). A
      symlink is never part of a store, and is passed over. */
  list() {
    return this._access(async () => {
      const entriesDir = path.join(this.root, "entries");
      const out = [];
      try {
        const st = await fs.promises.lstat(path.join(this.root, STORE_FILE));
        if (!st.isFile()) throw Object.assign(new Error("not a file"), { code: "ENOENT" }); // prettier-ignore
        out.push(STORE_FILE);
      } catch (err) {
        throw fail(fsCode(err, "missing"), "the folder holds no store");
      }
      // `entries` (and each `revs`) must be a real folder, not a symlink to
      // one elsewhere; one that cannot be read is said ("denied"), not shown
      // as empty.
      if (!(await isDirHere(entriesDir))) return out;
      for (const entry of await readdirCapped(entriesDir, MAX_DIR_ITEMS, {
        strict: true,
      })) {
        // prettier-ignore
        const entryJson = `entries/${entry}/entry.json`;
        if (!parseStorePath(entryJson)) continue;
        const dir = path.join(entriesDir, entry);
        if (await isFileHere(path.join(dir, "entry.json"))) out.push(entryJson);
        const revsDir = path.join(dir, "revs");
        if (!(await isDirHere(revsDir))) continue;
        // Newest first BEFORE the cap (a directory lists in no set order):
        // a cut must drop the oldest revisions, never the head.
        const revs = (await readdirCapped(revsDir, Infinity, { strict: true }))
          .filter((f) => parseStorePath(`entries/${entry}/revs/${f}`))
          .sort((a, b) => b.localeCompare(a))
          .slice(0, 3 * MAX_ENTRY_REVS);
        for (const f of revs) out.push(`entries/${entry}/revs/${f}`);
      }
      return out;
    });
  }

  /** One file's bytes, or null when it is not there (or is not a plain file
      inside the store); over `max`, a throw. */
  async read(rel, { max }) {
    const full = this._resolve(rel);
    return this._access(async () => {
      let stat;
      try {
        stat = await fs.promises.lstat(full);
      } catch (err) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
        throw fail(fsCode(err), err?.message);
      }
      if (!stat.isFile() || !(await this._contained(full))) return null;
      if (stat.size > max) throw fail("tooBig");
      const bytes = await fs.promises.readFile(full);
      if (bytes.length > max) throw fail("tooBig");
      return bytes;
    });
  }

  /** Add one file; anything already at that name — a file, a folder, a
      symlink, dangling or not — is never written over ("exists"). */
  async add(rel, data) {
    const full = this._resolve(rel);
    return this._access(async () => {
      try {
        await fs.promises.lstat(full);
        throw fail("exists");
      } catch (err) {
        if (err.code === "exists") throw err;
        if (err?.code !== "ENOENT") throw fail(fsCode(err), err?.message);
      }
      if (!(await this._contained(full))) throw fail("invalid", "outside the store"); // prettier-ignore
      try {
        io.atomicWrite(full, data);
      } catch (err) {
        throw fail(fsCode(err), err?.message);
      }
      return true;
    });
  }
}

/** The store code a filesystem failure means. */
function fsCode(err, otherwise = "unavailable") {
  if (err?.code === "EACCES" || err?.code === "EPERM") return "denied";
  if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return otherwise === "unavailable" ? "missing" : otherwise; // prettier-ignore
  return otherwise === "missing" ? "unavailable" : otherwise;
}

/** Is `file` a plain file (not a symlink, not a folder)? */
async function isFileHere(file) {
  try {
    return (await fs.promises.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/** Is `dir` a real folder (not a symlink, not a file)? */
async function isDirHere(dir) {
  try {
    return (await fs.promises.lstat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** A directory's names (none when it is not there), at most `max` — never
    a symlink's. `strict`: a folder that is there but cannot be read throws
    its code rather than reading as empty. */
async function readdirCapped(dir, max, { strict = false } = {}) {
  let items;
  try {
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (strict && err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw fail(fsCode(err), err?.message); // prettier-ignore
    return [];
  }
  return items
    .filter((d) => !d.isSymbolicLink())
    .map((d) => d.name)
    .slice(0, max);
}

// Separators, what Windows refuses in a name, and control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

/** A store's name as a folder name: no separators or characters Windows
    refuses, trimmed, never empty. */
function folderNameFor(name) {
  const clean = String(name ?? "")
    .replace(UNSAFE_NAME_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 60);
  // "Synth.app" would make a folder macOS shows as a (broken) program — and
  // one findStoreFolder refuses (`isPackage`), so no one could ever join or
  // restore it: its last dot becomes a space.
  const safe = isPackage(clean) ? clean.replace(/\.([^.]*)$/, " $1") : clean;
  return safe || "Chip Hippo designs";
}

/**
 * Make a NEW store inside `parent`: a folder named for it (" 2", " 3"… when
 * the name is taken) holding its manifest. Answers the store folder's path.
 */
function makeFolderStore(
  parent,
  { id, name, created },
  { access = (fn) => fn() } = {},
) {
  if (!STORE_ID_RE.test(id ?? "")) throw fail("invalid");
  return access(() => {
    const base = folderNameFor(name);
    let dir = path.join(parent, base);
    for (let n = 2; fs.existsSync(dir); n += 1) {
      if (n > 99) throw fail("invalid", "no free folder name");
      dir = path.join(parent, `${base} ${n}`);
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      io.atomicWrite(path.join(dir, STORE_FILE), `${JSON.stringify(makeManifest({ id, name, created }), null, 2)}\n`); // prettier-ignore
    } catch (err) {
      throw fail(err?.code === "EACCES" || err?.code === "EPERM" ? "denied" : "unavailable", err?.message); // prettier-ignore
    }
    return dir;
  });
}

/**
 * The store folder a friend picked, for a link naming store `expectId`: the
 * folder itself when it is one, else the one store just inside it (a sync
 * client's shared-folders place, picked instead of the share). With
 * `expectId`, only that store; a folder holding another is `wrongStore`.
 * Answers `{path, manifest}`, or throws `missing` / `wrongStore`.
 */
async function findStoreFolder(
  dir,
  { expectId = null, access = (fn) => fn() } = {},
) {
  // prettier-ignore
  return access(async () => {
    if (isPackage(dir)) throw fail("missing");
    const here = await readManifest(dir);
    if (here) {
      if (expectId && here.id !== expectId) throw fail("wrongStore");
      return { path: path.resolve(dir), manifest: here };
    }
    let names;
    try {
      // Folders only, never a symlink or a package (a `.app` someone put in
      // a shared folder is a program, and Show Folder would launch it) —
      // and asynchronously, a few at a time: a cloud drive's root may hold
      // hundreds of folders each answering slowly.
      names = (await fs.promises.readdir(dir, { withFileTypes: true }))
        .filter((d) => !d.isSymbolicLink() && !d.isFile() && !isPackage(d.name)) // prettier-ignore
        .map((d) => d.name)
        .slice(0, MAX_SCAN);
    } catch (err) {
      throw fail(fsCode(err, "missing"));
    }
    const found = [];
    for (let i = 0; i < names.length; i += 8) {
      const batch = names.slice(i, i + 8).map(async (name) => {
        const sub = path.join(dir, name);
        const m = await readManifest(sub);
        if (m && (!expectId || m.id === expectId)) found.push({ path: path.resolve(sub), manifest: m }); // prettier-ignore
      });
      await Promise.all(batch);
    }
    if (found.length === 1) return found[0];
    throw fail(found.length ? "ambiguous" : "missing");
  });
}

/** How many folders inside a picked one are looked into for a store. */
const MAX_SCAN = 200;

/** A macOS package — a folder Finder treats as one thing, and opens by
    running it (`.app`) or installing it — is never a store. */
const PACKAGE_RE = /\.(?:app|pkg|mpkg|bundle|framework|plugin|kext|prefpane|appex|xpc|saver|qlgenerator|mdimporter|workflow|action)$/i; // prettier-ignore
const isPackage = (name) => PACKAGE_RE.test(path.basename(String(name)));

/** A folder's manifest — a plain file, not a symlink — or null. */
async function readManifest(dir) {
  try {
    const file = path.join(dir, STORE_FILE);
    const st = await fs.promises.lstat(file);
    if (!st.isFile() || st.size > 16 * 1024) return null;
    return normalizeManifest(JSON.parse(await fs.promises.readFile(file, "utf8"))); // prettier-ignore
  } catch {
    return null;
  }
}

module.exports = {
  FolderBackend,
  findStoreFolder,
  folderNameFor,
  isPackage,
  makeFolderStore,
};
