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

// stores/service.js — the private stores as main serves them (the private
// stores work, .claude/rules/stores.md): one store's view for the Browse
// window, a revision's design and picture, and a SAVE — over whichever
// backend the store lives on (folder.js, github.js), which only lists, reads
// and adds. Everything a store means is store-format.js's; this is the I/O
// around it.
//
// THE FILES NEVER CHANGE (the layout is append-only), so whatever was read
// once is kept for the session: a second Browse of a GitHub store reads only
// what is new since — the tree, and the metas it had not seen.
//
// A SAVE writes the entry's metadata (a new entry only), the design, its
// picture, and LAST the revision's meta — the mark that makes it a revision
// (store-format.js). It is checked against the store as read NOW: a save from
// a revision someone has since built on is refused as "behind" unless the
// user chose to save alongside (`fork: true`) — a fork is never made without
// being asked.
"use strict";

const {
  MAX_SNAPSHOT_BYTES,
  entryIdFor,
} = require("../../web/scripts/gallery/entry-format.js");
const {
  MAX_META_BYTES,
  MAX_THUMB_BYTES,
  STORE_FILE,
  buildStoreView,
  entryPath,
  normalizeManifest,
  normalizeRevMeta,
  makeRevMeta,
  makeStoreEntry,
  pathsToRead,
  revIdFor,
  revPath,
  revTime,
  saveVerdict,
} = require("../../web/scripts/stores/store-format.js");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The last moment a revision id can name (`YYYY` is four digits). */
const LAST_REV_TIME = Date.UTC(9999, 11, 31, 23, 59, 59);

/** Run `fn` with a backend's grant held throughout, when it has one to
    hold (a folder: one bookmark proof for a whole view or save). */
const held = (backend, fn) => (typeof backend.within === "function" ? backend.within(fn) : fn()); // prettier-ignore

const coded = (code, message = code) => Object.assign(new Error(message), { code }); // prettier-ignore

/** How many files a folder store reads at once. */
const READ_AT_ONCE = 8;

/** Run `fn` over `items`, at most `limit` at a time; the first throw wins. */
async function eachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)); // prettier-ignore
}

const parseJSON = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

class StoreService {
  /**
   * @param {object} deps
   * @param {(store: object) => object} deps.backendFor - the store's backend.
   * @param {(data: string|Buffer) => string} deps.sha256Hex
   * @param {(bytes: number) => string} deps.randomHex
   * @param {() => number} [deps.now]
   */
  constructor({ backendFor, sha256Hex, randomHex, now = Date.now }) {
    this._backendFor = backendFor;
    this._sha = sha256Hex;
    this._random = randomHex;
    this._now = now;
    /** store id → Map(rel → parsed JSON), the session's reads. */
    this._cache = new Map();
    /** store id → the last save's promise (one save at a time per store). */
    this._queue = new Map();
  }

  _files(store) {
    let files = this._cache.get(store.id);
    if (!files) this._cache.set(store.id, (files = new Map()));
    return files;
  }

  /** Forget what was read (a store removed, or re-added somewhere new). */
  forget(id) {
    this._cache.delete(id);
  }

  /**
   * The store as the Browse window draws it: `{manifest, entries}`, each
   * entry with its revisions, head and leaves (store-format.js
   * `buildStoreView`). Throws a code ("missing", "noAccess", …).
   */
  view(store) {
    const backend = this._backendFor(store);
    return held(backend, () => this._view(store, backend));
  }

  async _view(store, backend) {
    const paths = await backend.list();
    const files = this._files(store);
    const want = [STORE_FILE, ...pathsToRead(paths)].filter((p) => !files.has(p)); // prettier-ignore
    // Only what PARSED is kept: a file read while its sync client is still
    // writing it is half a file now and whole on the next look, so a failure
    // is asked again then rather than remembered for the session.
    // A null is a file that can never be a meta (too big, or binary): that
    // IS remembered, so it is not fetched again on every look.
    const keep = (rel, text) => {
      if (text === null) return void files.set(rel, null);
      const parsed = parseJSON(text);
      if (parsed != null) files.set(rel, parsed);
    };
    if (want.length) {
      if (typeof backend.readMany === "function") {
        let got;
        try {
          got = await backend.readMany(want);
        } catch (err) {
          // What arrived before the failure is true, and kept; the view
          // itself fails (never shown from half the metas).
          for (const [rel, text] of err.partial ?? []) keep(rel, text);
          throw err;
        }
        for (const [rel, text] of got) keep(rel, text);
      } else {
        // A folder: on a cloud drive that fetches files on demand each read
        // may be a download, so a few go at once.
        await eachLimited(want, READ_AT_ONCE, async (rel) => {
          try {
            const bytes = await backend.read(rel, { max: MAX_META_BYTES });
            if (bytes) keep(rel, bytes.toString("utf8"));
          } catch (err) {
            // Too big to be a meta: not one, and it never will be.
            if (err.code === "tooBig") files.set(rel, null);
            else throw err;
          }
        });
      }
    }
    // The manifest as READ (normalizeManifest): `newer` is derived from its
    // format, never taken from the file.
    const manifest = normalizeManifest(files.get(STORE_FILE));
    if (!manifest || manifest.id !== store.id) throw coded(files.get(STORE_FILE) ? "wrongStore" : "missing"); // prettier-ignore
    const view = buildStoreView({ paths, read: (rel) => files.get(rel) });
    return { manifest, entries: view.entries, paths };
  }

  /** One revision's design, parsed: `{raw, meta}`. */
  async design(store, entry, rev) {
    const backend = this._backendFor(store);
    const bytes = await backend.read(revPath(entry, rev, "design"), { max: MAX_SNAPSHOT_BYTES }); // prettier-ignore
    if (!bytes) throw coded("missing");
    const raw = parseJSON(bytes.toString("utf8"));
    if (!raw || typeof raw !== "object") throw coded("invalid");
    let meta = this._files(store).get(revPath(entry, rev, "meta")) ?? null;
    if (!meta) {
      const m = await backend.read(revPath(entry, rev, "meta"), { max: MAX_META_BYTES }).catch(() => null); // prettier-ignore
      meta = m ? parseJSON(m.toString("utf8")) : null;
    }
    // Held to shape, as the view's metas are: a friend's file is untrusted.
    return { raw, meta: normalizeRevMeta(meta, rev) };
  }

  /** One revision's picture as a data: URL, or null. */
  async thumb(store, entry, rev) {
    const bytes = await this._backendFor(store).read(revPath(entry, rev, "thumb"), { max: MAX_THUMB_BYTES }); // prettier-ignore
    if (!bytes || !bytes.subarray(0, 8).equals(PNG_MAGIC)) return null;
    return `data:image/png;base64,${bytes.toString("base64")}`;
  }

  /**
   * Save one design to a store.
   *
   * @param {object} store - a registry record.
   * @param {object} save
   * @param {string} save.design - the snapshot's JSON text (already capped).
   * @param {{title, author, description, tags}} save.fields - checked.
   * @param {string|null} save.entry - the entry this revises; null for a new one.
   * @param {string|null} save.base - the revision it was made from.
   * @param {boolean} [save.fork] - save even when someone saved after `base`.
   * @param {string} [save.note]
   * @param {object} [save.derived]
   * @param {Buffer|null} [save.thumb] - the board's picture (a PNG).
   * @param {{appVersion: string, docVersion: number}} save.app
   * @returns {Promise<{entry: string, rev: string}>}
   */
  save(store, save) {
    const prior = this._queue.get(store.id) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this._save(store, save));
    this._queue.set(store.id, run);
    return run.finally(() => {
      if (this._queue.get(store.id) === run) this._queue.delete(store.id);
    });
  }

  async _save(
    store,
    {
      design,
      fields,
      entry = null,
      base = null,
      fork = false,
      note = "",
      derived = null,
      thumb = null,
      app = {},
    },
  ) {
    // prettier-ignore
    const backend = this._backendFor(store);
    return held(backend, () => this._saveWith(store, backend, { design, fields, entry, base, fork, note, derived, thumb, app })); // prettier-ignore
  }

  async _saveWith(
    store,
    backend,
    { design, fields, entry, base, fork, note, derived, thumb, app },
  ) {
    // prettier-ignore
    const { manifest, entries, paths } = await this._view(store, backend);
    if (manifest.newer) throw coded("newer");
    // The entry's id is a slug and a hash, as the gallery's are; both it and
    // a revision's carry a random salt, so the same design saved twice — a
    // double press, two friends each saving one untouched demo into a synced
    // folder — is two revisions (or two entries), never one file written
    // twice on two machines (a sync client's "conflicted copy").
    const hash = this._sha(design);
    const revHash = this._sha(`${hash}:${base ?? ""}:${this._random(8)}`);
    // Always stamped a second AFTER its base: a friend whose clock runs
    // ahead made the base "later" than now here, and `headOf` counts a base
    // only when it sorts before its child — else a false fork, the wrong
    // head, and a later save from the base a silent fork.
    // Never past the last second a revision id can name (a base stamped
    // 9999-12-31 by a broken or hostile clock would make every later id
    // invalid, and the entry impossible to save to).
    const baseAt = entry && base ? revTime(base) : NaN;
    const at = Number.isFinite(baseAt) ? Math.min(Math.max(this._now(), baseAt + 1000), LAST_REV_TIME) : this._now(); // prettier-ignore
    let entryId = entry;
    if (entryId) {
      const found = entries.find((e) => e.id === entryId);
      if (!found) throw coded("missing");
      if (saveVerdict(found, base) === "behind" && !fork) {
        const err = coded("behind");
        err.head = { rev: found.head.rev, author: found.head.author, at: found.head.at }; // prettier-ignore
        throw err;
      }
    } else {
      entryId = entryIdFor(
        fields.title,
        this._sha(`${hash}:${this._random(8)}`),
      );
      // Taken also by an entry.json with no revision yet — a friend's save
      // still syncing, or one of ours cut off after its first file — which
      // the view leaves out; reusing its id would fail on "exists" forever.
      const taken = (id) =>
        entries.some((e) => e.id === id) ||
        paths.includes(entryPath(id)) ||
        this._files(store).has(entryPath(id));
      for (let n = 0; taken(entryId); n += 1) {
        if (n > 5) throw coded("unavailable", "no free entry id");
        entryId = entryIdFor(fields.title, this._random(3));
      }
    }
    const rev = revIdFor(at, revHash);
    const iso = new Date(at).toISOString();
    const message = (what) => `${what}: ${entryId} ${rev}`;
    if (!entry) {
      // Claimed between the read and this write (a friend's save landing):
      // another id, a few times, rather than a refused save.
      for (let n = 0; ; n += 1) {
        const text = `${JSON.stringify(makeStoreEntry({ id: entryId, ...fields, created: iso }), null, 2)}\n`; // prettier-ignore
        try {
          await backend.add(entryPath(entryId), text, { message: message("New design") }); // prettier-ignore
          break;
        } catch (err) {
          if (err.code !== "exists" || n >= 3) throw err;
          entryId = entryIdFor(fields.title, this._random(3));
        }
      }
    }
    await backend.add(revPath(entryId, rev, "design"), design, { message: message("Design") }); // prettier-ignore
    if (
      thumb &&
      thumb.length <= MAX_THUMB_BYTES &&
      thumb.subarray(0, 8).equals(PNG_MAGIC)
    ) {
      // A picture that will not go is not worth losing the save over.
      await backend.add(revPath(entryId, rev, "thumb"), thumb, { message: message("Picture") }).catch(() => {}); // prettier-ignore
    }
    const meta = makeRevMeta({
      rev,
      base: entry ? base : null,
      author: fields.author,
      note,
      at: iso,
      appVersion: app.appVersion,
      docVersion: app.docVersion,
      derived,
    });
    await backend.add(revPath(entryId, rev, "meta"), `${JSON.stringify(meta, null, 2)}\n`, { message: message("Revision") }); // prettier-ignore
    return { entry: entryId, rev };
  }
}

module.exports = { StoreService };
