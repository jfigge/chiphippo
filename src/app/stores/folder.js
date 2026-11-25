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

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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
/** The most names read from one `revs` folder. */
const MAX_REV_NAMES = 50 * MAX_ENTRY_REVS;

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
    this._grant = access;
    /** Inside `within`: the grant is already held, so each file's read does
        not take it again (a Mac App Store build re-proves a bookmark — a
        synchronous read of the folder — every time it is taken). */
    this._held = false;
  }

  /** Run with the folder's grant held, as `_access` does — once, however
      many files `fn` reads. */
  _access(fn) {
    return this._held ? fn() : this._grant(fn);
  }

  /** Run `fn` (async) with the grant held throughout: a whole view or save
      takes it ONCE (StoreService). */
  within(fn) {
    if (this._held) return fn();
    return this._grant(async () => {
      this._held = true;
      try {
        return await fn();
      } finally {
        this._held = false;
      }
    });
  }

  /** `rel` as an absolute path inside the root — or a throw. */
  _resolve(rel) {
    if (rel !== STORE_FILE && !parseStorePath(rel)) throw fail("invalid", `not a store path: ${rel}`); // prettier-ignore
    const full = path.resolve(this.root, ...rel.split("/"));
    if (!full.startsWith(withSep(this.root))) throw fail("invalid");
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
    let realRoot;
    try {
      realRoot = await fs.promises.realpath(this.root);
    } catch (err) {
      // A virtual drive that cannot resolve paths at all (Windows answers
      // EISDIR — ERROR_INVALID_FUNCTION — on some cloud drives): no link can
      // be followed there either, and `_resolve` has held the text inside.
      if (NO_REALPATH.has(err?.code)) return true;
      return false;
    }
    let dir = path.dirname(full);
    for (;;) {
      try {
        const real = await fs.promises.realpath(dir);
        return real === realRoot || real.startsWith(withSep(realRoot));
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
      for (const entry of await newestEntries(entriesDir)) {
        const entryJson = `entries/${entry}/entry.json`;
        if (!parseStorePath(entryJson)) continue;
        const dir = path.join(entriesDir, entry);
        if (await isFileHere(path.join(dir, "entry.json"))) out.push(entryJson);
        const revsDir = path.join(dir, "revs");
        if (!(await isDirHere(revsDir))) continue;
        // Newest first BEFORE the cap (a directory lists in no set order):
        // a cut must drop the oldest revisions, never the head.
        // A `revs` folder someone filled by hand is read no further than
        // MAX_REV_NAMES names (no store the app writes comes near it).
        // Only a COMPLETE revision (its design and its meta both here) counts
        // toward the cap, as store-format.js `groupPaths` counts — files
        // that never completed cannot push a real revision out of view.
        const names =
          (await readdirCapped(revsDir, MAX_REV_NAMES, { strict: true, stream: true })) // prettier-ignore
            .filter((f) => parseStorePath(`entries/${entry}/revs/${f}`));
        const parts = new Map();
        for (const f of names) {
          const p = parseStorePath(`entries/${entry}/revs/${f}`);
          if (!parts.has(p.rev)) parts.set(p.rev, new Set());
          parts.get(p.rev).add(p.part);
        }
        const whole = [...parts.keys()]
          .filter(
            (rev) => parts.get(rev).has("design") && parts.get(rev).has("meta"),
          ) // prettier-ignore
          .sort((a, b) => b.localeCompare(a))
          .slice(0, MAX_ENTRY_REVS);
        const keep = new Set(whole);
        for (const f of names) {
          if (keep.has(parseStorePath(`entries/${entry}/revs/${f}`).rev)) out.push(`entries/${entry}/revs/${f}`); // prettier-ignore
        }
      }
      return out;
    });
  }

  /** One file's bytes, or null when it is not there (or is not a plain file
      inside the store); over `max`, a throw. The file is OPENED without
      following a link (`O_NOFOLLOW`) or waiting on a pipe (`O_NONBLOCK`),
      and the open file must be the very one found at a path inside the store
      — so a folder swapped for a symlink between the check and the read
      reads nothing from outside. */
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
      if (!stat.isFile()) return null;
      if (stat.size > max) throw fail("tooBig");
      let fh;
      try {
        fh = await fs.promises.open(full, READ_FLAGS);
      } catch (err) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR" || err?.code === "ELOOP") return null; // prettier-ignore
        throw fail(fsCode(err), err?.message);
      }
      try {
        const open = await fh.stat();
        if (!open.isFile() || !(await this._contained(full))) return null;
        const here = await fs.promises.lstat(full).catch(() => null);
        if (!here || here.ino !== open.ino || here.dev !== open.dev)
          return null;
        if (open.size > max) throw fail("tooBig");
        // Read to one byte past the cap: a file still growing is refused.
        const buf = Buffer.alloc(Math.min(open.size, max) + 1);
        let got = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
          if (!bytesRead) break;
          got += bytesRead;
          if (got >= buf.length) break;
        }
        if (got > max) throw fail("tooBig");
        // Grown since it was opened (still being written or synced): not
        // whole yet — read as not there, and asked again next time.
        if (got > open.size) return null;
        return buf.subarray(0, got);
      } finally {
        await fh.close().catch(() => {});
      }
    });
  }

  /** Add one file; anything already at that name — a file, a folder, a
      symlink, dangling or not — is never written over ("exists"). The bytes
      go to a temp file first and are HARD-LINKED in (atomic, and a link
      never replaces what is there); a filesystem with no hard links gets an
      exclusive create at the name itself. Checked inside the store after,
      too: a folder swapped for a symlink meanwhile is undone and refused. */
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
        await writeNew(full, data);
      } catch (err) {
        if (err?.code === "exists") throw err;
        throw fail(fsCode(err), err?.message);
      }
      if (!(await this._contained(full))) {
        await fs.promises.unlink(full).catch(() => {});
        throw fail("invalid", "outside the store");
      }
      return true;
    });
  }
}

/** What a filesystem that cannot resolve real paths answers `realpath`. */
const NO_REALPATH = new Set(["EISDIR", "EINVAL", "ENOTSUP", "ENOSYS", "UNKNOWN"]); // prettier-ignore

/** A read never follows a link at the file itself, nor waits on a pipe. */
const READ_FLAGS =
  fs.constants.O_RDONLY |
  (fs.constants.O_NOFOLLOW ?? 0) |
  (fs.constants.O_NONBLOCK ?? 0);

/** What a filesystem with no hard links answers `link` with. */
// EISDIR is libuv's word for Windows' ERROR_INVALID_FUNCTION, which a FAT32 /
// exFAT volume — and Google Drive for desktop's drive — answers a hard link.
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK", "EISDIR", "EINVAL", "UNKNOWN"]); // prettier-ignore

/** A folder path with exactly one trailing separator (a drive root such as
    G:\ already has one). */
const withSep = (dir) => (dir.endsWith(path.sep) ? dir : dir + path.sep);

/** Write `data` as a NEW file at `full` — never over anything (a throw
    coded "exists"). */
async function writeNew(full, data) {
  await fs.promises.mkdir(path.dirname(full), { recursive: true });
  const exists = () => Object.assign(new Error("exists"), { code: "exists" });
  const tmp = `${full}.chiphippotmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`; // prettier-ignore
  const writeTo = async (file) => {
    const fh = await fs.promises.open(file, "wx");
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
  };
  try {
    await writeTo(tmp);
    try {
      await fs.promises.link(tmp, full);
    } catch (err) {
      if (err?.code === "EEXIST") throw exists();
      if (!NO_HARD_LINKS.has(err?.code)) throw err;
      try {
        await writeTo(full);
      } catch (e) {
        if (e?.code === "EEXIST") throw exists();
        // A create that failed partway (a full disk) leaves no half file at
        // the name, which append-only could never replace.
        await fs.promises.unlink(full).catch(() => {});
        throw e;
      }
    }
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
  // Inside the write's own grant (a sandboxed build's access ends with it).
  await sweepStaleTemps(path.dirname(full));
}

/** This app's own temp files (a save cut off between writing and linking)
    left in a store folder over an hour: removed, best-effort — nothing else
    in a store is ever deleted, and these are never part of one. */
const OWN_TEMP_RE = /\.chiphippotmp-\d+-[0-9a-f]{8}\.tmp$/;
async function sweepStaleTemps(dir) {
  try {
    // No further than a `revs` listing goes (MAX_REV_NAMES).
    for (const name of await readdirCapped(dir, MAX_REV_NAMES, {
      stream: true,
    })) {
      if (!OWN_TEMP_RE.test(name)) continue;
      const file = path.join(dir, name);
      const st = await fs.promises.lstat(file);
      if (st.isFile() && Date.now() - st.mtimeMs > 3600_000) await fs.promises.unlink(file); // prettier-ignore
    }
  } catch {
    /* best-effort */
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

/** The `entries` folder's names, at most `MAX_DIR_ITEMS`: a directory lists
    in no set order, so past the cap the NEWEST folders are kept (by their
    time on disk), never whichever the filesystem happened to list first. */
async function newestEntries(entriesDir) {
  const names = await readdirCapped(entriesDir, Infinity, { strict: true });
  if (names.length <= MAX_DIR_ITEMS) return names;
  // A few at a time: on a cloud drive each stat may be a round trip.
  const timed = [];
  for (let i = 0; i < names.length; i += 32) {
    timed.push(
      ...(await Promise.all(
        names.slice(i, i + 32).map(async (name) => {
          const st = await fs.promises.lstat(path.join(entriesDir, name)).catch(() => null); // prettier-ignore
          return { name, at: st?.isDirectory() ? st.mtimeMs : -Infinity };
        }),
      )),
    );
  }
  return timed
    .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
    .slice(0, MAX_DIR_ITEMS)
    .map((t) => t.name);
}

/** A directory's names (none when it is not there), at most `max` — never
    a symlink's. `strict`: a folder that is there but cannot be read throws
    its code rather than reading as empty. */
async function readdirCapped(
  dir,
  max,
  { strict = false, stream = false } = {},
) {
  let items;
  try {
    if (stream) {
      // Read name by name, stopping at the cap: a huge folder is never held
      // whole in memory.
      items = [];
      const handle = await fs.promises.opendir(dir);
      try {
        for await (const d of handle) {
          if (!(await isLinkHere(dir, d))) items.push(d);
          if (items.length >= max) break;
        }
      } finally {
        await handle.close().catch(() => {});
      }
      return items.map((d) => d.name);
    }
    items = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (strict && err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw fail(fsCode(err), err?.message); // prettier-ignore
    return [];
  }
  // The re-checks (Windows only — every OneDrive file is a reparse point) a
  // batch at a time, as `newestEntries` stats.
  const kept = [];
  for (let i = 0; i < items.length && kept.length < max; i += 32) {
    const batch = items.slice(i, i + 32);
    const links = await Promise.all(batch.map((d) => isLinkHere(dir, d)));
    batch.forEach((d, k) => links[k] || kept.push(d.name));
  }
  return kept.slice(0, max);
}

/**
 * Is directory entry `d` (in `dir`) really a symbolic link? On Windows a
 * listing marks EVERY reparse point as a link — and OneDrive's Files
 * On-Demand and Dropbox's online-only files are reparse points that `lstat`
 * reads as plain files and folders. So a listing's "link" is asked again,
 * and only a real one (lstat's, as the rest of this file reads) is dropped.
 */
async function isLinkHere(dir, d) {
  if (!d.isSymbolicLink()) return false;
  if (process.platform !== "win32") return true;
  try {
    return (await fs.promises.lstat(path.join(dir, d.name))).isSymbolicLink();
  } catch {
    return true;
  }
}

/** Is `file` a real folder by lstat (never followed)? */
async function isDirAt(file) {
  try {
    return (await fs.promises.lstat(file)).isDirectory();
  } catch {
    return false;
  }
}

// Separators, what Windows refuses in a name, and control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

const WINDOWS_RESERVED_RE =
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

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
  // A name Windows keeps for a device (CON, NUL, COM1…, with or without an
  // extension) can be no folder there — and the store is shared with them.
  if (WINDOWS_RESERVED_RE.test(safe)) return `${safe} store`;
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
    // The folder is MADE, not found: a name something else took meanwhile
    // (a sync client bringing a folder of that name) is stepped past, and
    // the manifest is created exclusively — never written over one.
    for (let n = 1; n <= 99; n += 1) {
      const dir = path.join(parent, n === 1 ? base : `${base} ${n}`);
      try {
        fs.mkdirSync(dir);
      } catch (err) {
        if (err?.code === "EEXIST") continue;
        throw fail(err?.code === "EACCES" || err?.code === "EPERM" ? "denied" : "unavailable", err?.message); // prettier-ignore
      }
      try {
        fs.writeFileSync(path.join(dir, STORE_FILE), `${JSON.stringify(makeManifest({ id, name, created }), null, 2)}\n`, { flag: "wx" }); // prettier-ignore
      } catch (err) {
        throw fail(err?.code === "EACCES" || err?.code === "EPERM" ? "denied" : "unavailable", err?.message); // prettier-ignore
      }
      return dir;
    }
    throw fail("invalid", "no free folder name");
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
      const listed = await fs.promises.readdir(dir, { withFileTypes: true });
      names = [];
      for (const d of listed) {
        if (names.length >= MAX_SCAN) break;
        if (d.isFile() || isPackage(d.name) || (await isLinkHere(dir, d))) continue; // prettier-ignore
        // On Windows a placeholder FILE is listed as a "link", so neither
        // isFile() nor isLinkHere drops it: only a real folder is a candidate.
        if (d.isSymbolicLink() && !(await isDirAt(path.join(dir, d.name)))) continue; // prettier-ignore
        names.push(d.name);
      }
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
  MAX_DIR_ITEMS,
  FolderBackend,
  findStoreFolder,
  folderNameFor,
  isPackage,
  makeFolderStore,
};
