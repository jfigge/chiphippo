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

// vfs.js — the in-memory filesystem main's code runs on in the web build.
//
// Main's stores are SYNCHRONOUS (`openSync`, `renameSync`, `readFileSync`, …)
// and every browser storage API is asynchronous, so the whole of what main can
// see lives here, in memory, and storage happens beside it: persist.js loads
// the persisted trees into this before main starts and writes each change back
// to IndexedDB afterwards; mounts.js mirrors a picked file or folder out to the
// visitor's disk. Both learn of a change through `onChange`, after it has
// happened — a write here is complete the moment it returns, exactly as a
// Node write is.
//
// Three kinds of node: a directory, a file whose bytes are here, and a LAZY
// file — the app's own bundled content (demos, docs, locales, datasheet
// crops), whose name and size are known from the build's manifest and whose
// bytes are fetched the first time something reads them.
//
// Pure — no DOM, no IndexedDB — so web-host/tests/vfs.test.js runs it under
// `node --test`.

import { Buffer } from "./node/buffer.js";
import * as path from "./node/path.js";

const MESSAGES = {
  ENOENT: "no such file or directory",
  EEXIST: "file already exists",
  EISDIR: "illegal operation on a directory",
  ENOTDIR: "not a directory",
  ENOTEMPTY: "directory not empty",
  EBADF: "bad file descriptor",
  EACCES: "permission denied",
  EINVAL: "invalid argument",
};

const ERRNO = {
  ENOENT: -2,
  EEXIST: -17,
  EISDIR: -21,
  ENOTDIR: -20,
  ENOTEMPTY: -39,
  EBADF: -9,
  EACCES: -13,
  EINVAL: -22,
};

/** An error shaped like Node's: `code`, `errno`, `syscall`, `path`. */
export function fsError(code, syscall, p) {
  const err = new Error(
    `${code}: ${MESSAGES[code] ?? "error"}, ${syscall}${p ? ` '${p}'` : ""}`,
  );
  err.code = code;
  err.errno = ERRNO[code];
  err.syscall = syscall;
  if (p) err.path = p;
  return err;
}

const encoder = new TextEncoder();

function toBytes(data, encoding) {
  if (typeof data === "string") {
    return encoding && encoding !== "utf8" && encoding !== "utf-8"
      ? Buffer.from(data, encoding)
      : encoder.encode(data);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(
      data.buffer,
      data.byteOffset,
      data.byteLength,
    ).slice();
  }
  return encoder.encode(String(data));
}

function encodingOf(opts) {
  if (typeof opts === "string") return opts;
  return opts?.encoding ?? null;
}

function decode(bytes, encoding) {
  const buf = Buffer.from(bytes);
  return encoding ? buf.toString(encoding) : buf;
}

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

class Stats {
  constructor(node) {
    this.dev = 1;
    this.ino = node.ino;
    this.mode = (node.type === "dir" ? S_IFDIR : S_IFREG) | node.mode;
    this.nlink = 1;
    this.uid = 0;
    this.gid = 0;
    this.size = node.type === "dir" ? 0 : (node.data?.length ?? node.size ?? 0);
    this.mtimeMs = node.mtimeMs;
    this.mtime = new Date(node.mtimeMs);
    this.ctimeMs = node.mtimeMs;
    this.ctime = this.mtime;
    this.birthtimeMs = node.mtimeMs;
    this.birthtime = this.mtime;
    this._type = node.type;
  }

  isFile() {
    return this._type === "file";
  }

  isDirectory() {
    return this._type === "dir";
  }

  isSymbolicLink() {
    return false;
  }
}

export class Vfs {
  #nodes = new Map();
  #fds = new Map();
  #nextFd = 3;
  #nextIno = 1;
  #listeners = new Set();
  #now;

  /** @param {{now?: () => number}} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
    this.#nodes.set("/", this.#dirNode());
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────

  /**
   * Hear about every change after it lands: `{op: "write"|"unlink"|"mkdir"|
   * "rmdir", path}` and, for a rename, `{op: "rename", from, path}`.
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(change) {
    for (const fn of this.#listeners) {
      try {
        fn(change);
      } catch (err) {
        console.error("[vfs] change listener failed:", err);
      }
    }
  }

  /** Every path under `prefix` (itself included), files and directories. */
  entriesUnder(prefix) {
    const root = path.resolve(prefix);
    const out = [];
    for (const [p, node] of this.#nodes) {
      if (p === root || p.startsWith(root === "/" ? "/" : `${root}/`)) {
        out.push({ path: p, type: node.type, lazy: Boolean(node.lazy) });
      }
    }
    return out;
  }

  /**
   * Put a file in place WITHOUT announcing it (storage restoring what it
   * kept, a mount bringing a file in). Parents are created as needed.
   */
  restoreFile(p, data, { mode = 0o644, mtimeMs } = {}) {
    const target = path.resolve(p);
    this.#mkdirp(path.dirname(target));
    const existing = this.#nodes.get(target);
    this.#nodes.set(target, {
      type: "file",
      data: toBytes(data),
      mode,
      ino: existing?.ino ?? this.#nextIno++,
      mtimeMs: mtimeMs ?? this.#now(),
    });
  }

  /** A directory, created quietly (as `restoreFile`). */
  restoreDir(p) {
    this.#mkdirp(path.resolve(p));
  }

  /**
   * A bundled file known by name and size whose bytes are fetched on first
   * read: `loadSync()` for a synchronous read, `load()` for `fs.promises`.
   */
  registerLazy(p, { size = 0, loadSync, load }) {
    const target = path.resolve(p);
    this.#mkdirp(path.dirname(target));
    this.#nodes.set(target, {
      type: "file",
      data: null,
      size,
      lazy: { loadSync, load },
      mode: 0o444,
      ino: this.#nextIno++,
      mtimeMs: this.#now(),
    });
  }

  /** Drop a tree quietly (a mount going away). */
  forget(p) {
    const root = path.resolve(p);
    for (const key of [...this.#nodes.keys()]) {
      if (key === root || key.startsWith(`${root}/`)) this.#nodes.delete(key);
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  #dirNode() {
    return {
      type: "dir",
      mode: 0o755,
      ino: this.#nextIno++,
      mtimeMs: this.#now(),
    };
  }

  #mkdirp(dir) {
    const created = [];
    let p = path.resolve(dir);
    const chain = [];
    while (!this.#nodes.has(p)) {
      chain.push(p);
      const parent = path.dirname(p);
      if (parent === p) break;
      p = parent;
    }
    const anchor = this.#nodes.get(p);
    if (anchor && anchor.type !== "dir") throw fsError("ENOTDIR", "mkdir", p);
    for (const d of chain.reverse()) {
      this.#nodes.set(d, this.#dirNode());
      created.push(d);
    }
    return created;
  }

  #node(p) {
    return this.#nodes.get(path.resolve(p));
  }

  #parentDir(target, syscall) {
    const parent = this.#nodes.get(path.dirname(target));
    if (!parent) throw fsError("ENOENT", syscall, target);
    if (parent.type !== "dir") throw fsError("ENOTDIR", syscall, target);
  }

  /** A lazy node's bytes, fetched (synchronously) the first time. */
  #bytes(node, p, syscall) {
    if (node.data) return node.data;
    if (!node.lazy?.loadSync) throw fsError("EACCES", syscall, p);
    const bytes = node.lazy.loadSync();
    if (!bytes) throw fsError("ENOENT", syscall, p);
    node.data = toBytes(bytes);
    return node.data;
  }

  #fd(fd, syscall) {
    const entry = this.#fds.get(fd);
    if (!entry) throw fsError("EBADF", syscall);
    return entry;
  }

  // ── The Node surface (fs.js maps `fs.*` onto these) ─────────────────────────

  existsSync(p) {
    try {
      return this.#nodes.has(path.resolve(String(p)));
    } catch {
      return false;
    }
  }

  statSync(p, opts) {
    const target = path.resolve(String(p));
    const node = this.#nodes.get(target);
    if (!node) {
      if (opts?.throwIfNoEntry === false) return undefined;
      throw fsError("ENOENT", "stat", target);
    }
    return new Stats(node);
  }

  lstatSync(p, opts) {
    return this.statSync(p, opts);
  }

  realpathSync(p) {
    const target = path.resolve(String(p));
    if (!this.#nodes.has(target)) throw fsError("ENOENT", "realpath", target);
    return target;
  }

  mkdirSync(p, opts = {}) {
    const target = path.resolve(String(p));
    const existing = this.#nodes.get(target);
    if (existing) {
      if (opts.recursive && existing.type === "dir") return undefined;
      throw fsError("EEXIST", "mkdir", target);
    }
    let created;
    if (opts.recursive) {
      created = this.#mkdirp(target);
    } else {
      this.#parentDir(target, "mkdir");
      this.#nodes.set(target, this.#dirNode());
      created = [target];
    }
    for (const d of created) this.#emit({ op: "mkdir", path: d });
    return opts.recursive ? created[0] : undefined;
  }

  readdirSync(p, opts = {}) {
    const target = path.resolve(String(p));
    const node = this.#nodes.get(target);
    if (!node) throw fsError("ENOENT", "scandir", target);
    if (node.type !== "dir") throw fsError("ENOTDIR", "scandir", target);
    const prefix = target === "/" ? "/" : `${target}/`;
    const names = [];
    for (const [key, child] of this.#nodes) {
      if (key === target || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue;
      names.push(
        opts.withFileTypes
          ? {
              name: rest,
              isFile: () => child.type === "file",
              isDirectory: () => child.type === "dir",
              isSymbolicLink: () => false,
            }
          : rest,
      );
    }
    names.sort((a, b) => {
      const x = typeof a === "string" ? a : a.name;
      const y = typeof b === "string" ? b : b.name;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return names;
  }

  readFileSync(p, opts) {
    if (typeof p === "number") {
      const entry = this.#fd(p, "read");
      return decode(
        this.#bytes(entry.node, entry.path, "read"),
        encodingOf(opts),
      );
    }
    const target = path.resolve(String(p));
    const node = this.#nodes.get(target);
    if (!node) throw fsError("ENOENT", "open", target);
    if (node.type === "dir") throw fsError("EISDIR", "read", target);
    return decode(this.#bytes(node, target, "open"), encodingOf(opts));
  }

  async readFile(p, opts) {
    const target = path.resolve(String(p));
    const node = this.#nodes.get(target);
    if (!node) throw fsError("ENOENT", "open", target);
    if (node.type === "dir") throw fsError("EISDIR", "read", target);
    if (!node.data && node.lazy?.load) {
      const bytes = await node.lazy.load();
      if (!bytes) throw fsError("ENOENT", "open", target);
      node.data = toBytes(bytes);
    }
    return decode(this.#bytes(node, target, "open"), encodingOf(opts));
  }

  writeFileSync(p, data, opts) {
    const bytes = toBytes(data, encodingOf(opts));
    if (typeof p === "number") {
      const entry = this.#fd(p, "write");
      if (!entry.writable) throw fsError("EBADF", "write");
      entry.node.data = bytes;
      entry.node.mtimeMs = this.#now();
      entry.dirty = true;
      return;
    }
    const target = path.resolve(String(p));
    const existing = this.#nodes.get(target);
    if (existing?.type === "dir") throw fsError("EISDIR", "open", target);
    this.#parentDir(target, "open");
    this.#nodes.set(target, {
      type: "file",
      data: bytes,
      mode: existing?.mode ?? (opts?.mode ?? 0o644) & 0o7777,
      ino: existing?.ino ?? this.#nextIno++,
      mtimeMs: this.#now(),
    });
    this.#emit({ op: "write", path: target });
  }

  openSync(p, flags = "r", mode = 0o644) {
    const target = path.resolve(String(p));
    const read =
      typeof flags === "number" ? (flags & 3) === 0 : /^r(?!\+)/.test(flags);
    let node = this.#nodes.get(target);
    if (read) {
      if (!node) throw fsError("ENOENT", "open", target);
    } else {
      if (node?.type === "dir") throw fsError("EISDIR", "open", target);
      this.#parentDir(target, "open");
      const truncate = typeof flags === "string" && flags.startsWith("w");
      if (!node || truncate) {
        node = {
          type: "file",
          data: node && !truncate ? node.data : new Uint8Array(0),
          mode: node?.mode ?? mode & 0o7777,
          ino: node?.ino ?? this.#nextIno++,
          mtimeMs: this.#now(),
        };
        this.#nodes.set(target, node);
      }
    }
    const fd = this.#nextFd++;
    this.#fds.set(fd, {
      path: target,
      node,
      writable: !read,
      dirty: !read,
    });
    return fd;
  }

  closeSync(fd) {
    const entry = this.#fd(fd, "close");
    this.#fds.delete(fd);
    // A write through a descriptor is one change, announced once it is done:
    // the atomic-write path opens a temp file, writes, fsyncs and closes, and
    // only then renames it into place.
    if (entry.dirty && this.#nodes.get(entry.path) === entry.node) {
      this.#emit({ op: "write", path: entry.path });
    }
  }

  fsyncSync(fd) {
    this.#fd(fd, "fsync");
  }

  fchmodSync(fd, mode) {
    const entry = this.#fd(fd, "fchmod");
    entry.node.mode = mode & 0o7777;
  }

  fstatSync(fd) {
    return new Stats(this.#fd(fd, "fstat").node);
  }

  readSync(
    fd,
    buffer,
    offset = 0,
    length = buffer.length - offset,
    position = null,
  ) {
    const entry = this.#fd(fd, "read");
    if (entry.node.type === "dir") throw fsError("EISDIR", "read");
    const bytes = this.#bytes(entry.node, entry.path, "read");
    const from = position ?? entry.position ?? 0;
    const n = Math.max(0, Math.min(length, bytes.length - from));
    buffer.set(bytes.subarray(from, from + n), offset);
    if (position == null) entry.position = from + n;
    return n;
  }

  renameSync(from, to) {
    const a = path.resolve(String(from));
    const b = path.resolve(String(to));
    const node = this.#nodes.get(a);
    if (!node) throw fsError("ENOENT", "rename", a);
    if (a === b) return;
    const existing = this.#nodes.get(b);
    if (existing?.type === "dir" && node.type !== "dir") {
      throw fsError("EISDIR", "rename", b);
    }
    this.#parentDir(b, "rename");
    if (node.type === "dir") {
      const moves = [];
      for (const [key, child] of this.#nodes) {
        if (key === a || key.startsWith(`${a}/`)) {
          moves.push([key, `${b}${key.slice(a.length)}`, child]);
        }
      }
      for (const [key] of moves) this.#nodes.delete(key);
      for (const [, next, child] of moves) this.#nodes.set(next, child);
    } else {
      this.#nodes.delete(a);
      this.#nodes.set(b, node);
      node.mtimeMs = this.#now();
    }
    this.#emit({ op: "rename", from: a, path: b });
  }

  unlinkSync(p) {
    const target = path.resolve(String(p));
    const node = this.#nodes.get(target);
    if (!node) throw fsError("ENOENT", "unlink", target);
    if (node.type === "dir") throw fsError("EISDIR", "unlink", target);
    this.#nodes.delete(target);
    this.#emit({ op: "unlink", path: target });
  }

  rmdirSync(p) {
    const target = path.resolve(String(p));
    const node = this.#nodes.get(target);
    if (!node) throw fsError("ENOENT", "rmdir", target);
    if (node.type !== "dir") throw fsError("ENOTDIR", "rmdir", target);
    if (this.readdirSync(target).length)
      throw fsError("ENOTEMPTY", "rmdir", target);
    this.#nodes.delete(target);
    this.#emit({ op: "rmdir", path: target });
  }

  /** A file's bytes as they stand, or null (storage and mounts read this). */
  peek(p) {
    const node = this.#node(p);
    return node?.type === "file" ? node.data : null;
  }

  /** A node's mode and mtime, or null (what storage keeps beside the bytes). */
  meta(p) {
    const node = this.#node(p);
    return node
      ? { type: node.type, mode: node.mode, mtimeMs: node.mtimeMs }
      : null;
  }
}
