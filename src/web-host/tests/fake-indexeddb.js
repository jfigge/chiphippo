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

// fake-indexeddb.js — just enough IndexedDB for persist.js under `node --test`
// (web-boot.test.js): open with an upgrade, object stores, readonly and
// readwrite transactions, and get / put / delete / getAll / getAllKeys. Values
// are structured-cloned in and out, as the real thing does.

/** A request on `tx`: it runs and answers on a microtask (after the caller
    has had the chance to set its handlers), and the transaction counts it. */
function req(tx, run) {
  const r = { result: undefined, error: null, onsuccess: null, onerror: null };
  tx.pending++;
  queueMicrotask(() => {
    try {
      r.result = run();
      r.onsuccess?.({ target: r });
    } catch (err) {
      r.error = err;
      r.onerror?.({ target: r });
    }
    tx.pending--;
    tx.settle();
  });
  return r;
}

class Store {
  constructor(map, tx) {
    this.map = map;
    this.tx = tx;
  }

  get(key) {
    return req(this.tx, () => structuredClone(this.map.get(key)));
  }

  put(value, key) {
    if (this.tx.mode !== "readwrite") throw new Error("ReadOnlyError");
    return req(this.tx, () => (this.map.set(key, structuredClone(value)), key));
  }

  delete(key) {
    if (this.tx.mode !== "readwrite") throw new Error("ReadOnlyError");
    return req(this.tx, () => void this.map.delete(key));
  }

  getAll() {
    return req(this.tx, () =>
      [...this.map.values()].map((v) => structuredClone(v)),
    );
  }

  getAllKeys() {
    return req(this.tx, () => [...this.map.keys()]);
  }
}

class Transaction {
  constructor(db, mode) {
    this.db = db;
    this.mode = mode;
    this.pending = 0;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.done = false;
    // A transaction with no requests completes too.
    setTimeout(() => this.settle(), 0);
  }

  objectStore(name) {
    const map = this.db.stores.get(name);
    if (!map) throw new Error(`NotFoundError: ${name}`);
    return new Store(map, this);
  }

  settle() {
    if (this.done || this.pending > 0) return;
    setTimeout(() => {
      if (this.done || this.pending > 0) return;
      this.done = true;
      this.oncomplete?.();
    }, 0);
  }
}

class Database {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = { contains: (n) => this.stores.has(n) };
  }

  createObjectStore(name) {
    this.stores.set(name, new Map());
  }

  transaction(name, mode = "readonly") {
    return new Transaction(this, mode);
  }
}

/** A fresh, empty IndexedDB; `databases` is shared, so a second open of the
    same name (a "reload") sees what the first wrote. */
export function fakeIndexedDB(databases = new Map()) {
  return {
    databases,
    open(name) {
      const r = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          db = new Database();
          databases.set(name, db);
          r.result = db;
          r.onupgradeneeded?.();
        }
        r.result = db;
        r.onsuccess?.();
      });
      return r;
    },
  };
}
