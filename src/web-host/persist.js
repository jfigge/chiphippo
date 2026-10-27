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
  #writing = 0; // flushes started and not yet finished
  #failed = new Map(); // path → op, a batch the database refused
  #failure = null; // the error that refused it
  #holds = new Set(); // gates a flush waits behind (hold())
  #generation = 0; // changes heard so far — a call's `since` (idle)
  #changedAt = new Map(); // path → the change that last touched it

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
    this.#changedAt.set(p, ++this.#generation);
    this.#pending.set(p, op);
    if (this.#timer == null) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#flush().catch(() => {});
      }, 0);
    }
  }

  #flush() {
    if (!this.#pending.size && !this.#failed.size) return this.#flushing;
    this.#writing++;
    this.#flushing = this.#flushing
      .catch(() => {})
      .then(() => this.#write())
      .finally(() => {
        this.#writing--;
      });
    return this.#flushing;
  }

  // One transaction: what is pending when it RUNS (a hold may have kept it
  // back a while, and anything changed meanwhile rides along), plus whatever
  // the last one could not write. A failure puts the batch back for the next
  // flush and is answered to the callers that are waiting now — never to a
  // later one that wrote nothing.
  async #write() {
    while (this.#holds.size) await Promise.all(this.#holds);
    for (const [p, op] of this.#failed)
      if (!this.#pending.has(p)) this.#pending.set(p, op);
    this.#failed.clear();
    if (!this.#pending.size) return;
    const batch = [...this.#pending];
    this.#pending.clear();
    try {
      const tx = this.#db.transaction(FILES, "readwrite");
      const store = tx.objectStore(FILES);
      const stored = [];
      for (const [p, op] of batch) {
        const meta = this.#vfs.meta(p);
        if (op === "delete" || !meta) {
          store.delete(p);
          stored.push([p, false]);
        } else if (meta.type === "dir") {
          store.put({ type: "dir" }, p);
          stored.push([p, true]);
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
          stored.push([p, true]);
        }
      }
      await done(tx);
      for (const [p, kept] of stored) {
        if (kept) this.#stored.add(p);
        else this.#stored.delete(p);
      }
      for (const [p] of batch)
        if (!this.#pending.has(p)) this.#changedAt.delete(p);
    } catch (err) {
      for (const [p, op] of batch) this.#failed.set(p, op);
      this.#failure = err;
      console.error("[web] storage write failed:", err);
      throw err;
    }
  }

  /** Whether anything is still on its way to the database — queued, held,
      in a transaction, or waiting to be tried again. */
  get busy() {
    return (
      this.#pending.size > 0 ||
      this.#timer != null ||
      this.#writing > 0 ||
      this.#failed.size > 0
    );
  }

  /** How many changes storage has heard of: an IPC call notes it as it
      starts, and asks `idle(since)` about only what changed after. */
  get generation() {
    return this.#generation;
  }

  /**
   * Resolves once everything changed so far is in the database; rejects with
   * the storage error if the write failed (a full disk, a revoked quota). A
   * failed batch is tried again by the next flush, so one refusal does not
   * poison every later answer: an idle() with nothing new to write still
   * retries what is left over, but resolves whatever that retry meets.
   *
   * `since` (a `generation`) asks about the changes made after it instead —
   * an IPC call's, however the flush went: one the timer already tried and
   * the database refused is still that call's failure, though nothing is
   * pending or in flight by the time the call asks.
   */
  idle(since = null) {
    const wrote = this.#pending.size > 0 || this.#writing > 0;
    if (this.#timer != null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const flushed = this.#flush();
    if (since == null) return wrote ? flushed : flushed.catch(() => {});
    return flushed.then(
      () => {},
      () => {
        for (const p of this.#failed.keys())
          if ((this.#changedAt.get(p) ?? 0) > since) throw this.#failure;
      },
    );
  }

  /**
   * Store `p` as the filesystem holds it now — a file put in place quietly
   * (a mount bringing newer bytes in from disk) that storage must keep too.
   * Resolves once the database holds it; rejects if it refused.
   */
  store(p) {
    const since = this.#generation;
    this.#touch(p, "put");
    return this.idle(since);
  }

  /**
   * Keep the database as it is until the returned release is called: a call
   * whose write to the visitor's disk is still out may yet be undone (ipc.js),
   * and a slot it deleted must not leave storage meanwhile. Writes queue up
   * behind the hold and go together when it lifts.
   * @returns {() => void}
   */
  hold() {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this.#holds.add(gate);
    return () => {
      if (!this.#holds.delete(gate)) return;
      release();
      // what was kept back goes now, not at the next change
      if (this.#pending.size && this.#timer == null)
        this.#timer = setTimeout(() => {
          this.#timer = null;
          this.#flush().catch(() => {});
        }, 0);
    };
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
