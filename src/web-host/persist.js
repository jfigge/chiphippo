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

// persist.js — what survives a reload in the web build: every file main keeps
// (settings, the working slot, ROM sidecars, the chip library, credentials)
// and every project kept in the browser, held in IndexedDB and loaded back into
// the in-memory filesystem (vfs.js) before main starts.
//
// Writes follow the filesystem, never lead it: a change lands in memory first
// (main's synchronous store code needs it there at once) and is written to the
// database moments later, coalesced per path, the newest bytes winning. `idle()`
// is the promise the IPC layer awaits before it answers a renderer, so a save
// the renderer is told succeeded is a save the database holds.

const DB_NAME = "chiphippo";
const DB_VERSION = 1;
const FILES = "files";
const RECORDS = "records";

// io.js's temp-file names: written, renamed into place a moment later, and
// worth nothing on their own.
const TEMP_FILE_RE = /\.chiphippotmp-\d+\.tmp$/;

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () =>
      reject(tx.error ?? new Error("storage transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}

/** Open (creating on first use) the one database the web build keeps. */
export async function openDatabase(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) throw new Error("this browser has no IndexedDB");
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains(FILES)) db.createObjectStore(FILES);
    if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
  };
  return request(req);
}

export class Persist {
  #db;
  #vfs;
  #keep;
  #pending = new Map(); // path → "put" | "delete"
  #stored = new Set(); // every path the database holds
  #timer = null;
  #flushing = Promise.resolve();

  /**
   * @param {IDBDatabase} db
   * @param {import("./vfs.js").Vfs} vfs
   * @param {(path: string) => boolean} keep - which paths are stored.
   */
  constructor(db, vfs, keep) {
    this.#db = db;
    this.#vfs = vfs;
    this.#keep = (p) => keep(p) && !TEMP_FILE_RE.test(p);
  }

  /** Bring every stored file and folder back into the filesystem. */
  async load() {
    const tx = this.#db.transaction(FILES, "readonly");
    const store = tx.objectStore(FILES);
    const [keys, values] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
    ]);
    // Folders first, so a file's parent exists however the keys sort.
    const entries = keys.map((k, i) => [String(k), values[i]]);
    for (const [p] of entries) this.#stored.add(p);
    for (const [p, rec] of entries)
      if (rec?.type === "dir") this.#vfs.restoreDir(p);
    for (const [p, rec] of entries) {
      if (rec?.type !== "file") continue;
      this.#vfs.restoreFile(p, rec.data ?? new Uint8Array(0), {
        mode: rec.mode,
        mtimeMs: rec.mtimeMs,
      });
    }
  }

  /** Start following the filesystem. */
  start() {
    this.#vfs.onChange((change) => {
      if (change.op === "rename") {
        this.#touchTree(change.from, "delete");
        this.#touchTree(change.path, "put");
      } else if (change.op === "unlink" || change.op === "rmdir") {
        this.#touch(change.path, "delete");
      } else {
        this.#touch(change.path, "put");
      }
    });
  }

  #touchTree(root, op) {
    if (op === "delete") {
      // Whatever was stored under a path that has gone, children included.
      for (const p of [...this.#knownUnder(root)]) this.#touch(p, "delete");
      this.#touch(root, "delete");
      return;
    }
    for (const entry of this.#vfs.entriesUnder(root))
      this.#touch(entry.path, "put");
  }

  /** Paths a rename may have left behind: everything queued or on file. */
  #knownUnder(root) {
    const under = new Set();
    for (const p of [...this.#pending.keys(), ...this.#stored]) {
      if (p.startsWith(`${root}/`)) under.add(p);
    }
    return under;
  }

  #touch(p, op) {
    if (!this.#keep(p)) return;
    this.#pending.set(p, op);
    if (this.#timer == null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#flush();
      }, 0);
    }
  }

  #flush() {
    if (!this.#pending.size) return this.#flushing;
    const batch = [...this.#pending];
    this.#pending.clear();
    this.#flushing = this.#flushing
      .catch(() => {})
      .then(async () => {
        const tx = this.#db.transaction(FILES, "readwrite");
        const store = tx.objectStore(FILES);
        for (const [p, op] of batch) {
          const meta = this.#vfs.meta(p);
          if (op === "delete" || !meta) {
            store.delete(p);
            this.#stored.delete(p);
          } else if (meta.type === "dir") {
            store.put({ type: "dir" }, p);
            this.#stored.add(p);
          } else {
            const data = this.#vfs.peek(p);
            if (!data) continue; // a lazy node: nothing of ours to keep
            store.put(
              {
                type: "file",
                data: data.slice(),
                mode: meta.mode,
                mtimeMs: meta.mtimeMs,
              },
              p,
            );
            this.#stored.add(p);
          }
        }
        await done(tx);
      })
      .catch((err) => {
        console.error("[web] storage write failed:", err);
        throw err;
      });
    return this.#flushing;
  }

  /** Whether anything is still on its way to the database. */
  get busy() {
    return this.#pending.size > 0 || this.#timer != null;
  }

  /**
   * Resolves once everything changed so far is in the database; rejects with
   * the storage error if the write failed (a full disk, a revoked quota).
   */
  idle() {
    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    return this.#flush();
  }

  // ── Records: small values the host keeps beside the files ─────────────────

  async getRecord(key) {
    const tx = this.#db.transaction(RECORDS, "readonly");
    return request(tx.objectStore(RECORDS).get(key));
  }

  async setRecord(key, value) {
    const tx = this.#db.transaction(RECORDS, "readwrite");
    tx.objectStore(RECORDS).put(value, key);
    await done(tx);
  }

  async deleteRecord(key) {
    const tx = this.#db.transaction(RECORDS, "readwrite");
    tx.objectStore(RECORDS).delete(key);
    await done(tx);
  }

  async allRecords(prefix) {
    const tx = this.#db.transaction(RECORDS, "readonly");
    const store = tx.objectStore(RECORDS);
    const [keys, values] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
    ]);
    return keys
      .map((k, i) => [String(k), values[i]])
      .filter(([k]) => !prefix || k.startsWith(prefix));
  }
}
