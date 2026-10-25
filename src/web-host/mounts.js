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

// mounts.js — the visitor's own files, as main sees them in the web build.
//
// Main names a file by PATH, so every file or folder the visitor hands over is
// given one in the virtual filesystem, and what main then writes there is
// carried out to the real thing:
//
//   /Files/<id>/<name>      a file picked through the File System Access API
//                           (Chromium). Kept in storage too, so the recent
//                           list and the startup rule can read it before
//                           anything has asked the browser for permission;
//                           every write goes back to the file itself.
//   /Files/<id>/<folder>/   a picked FOLDER (the datasheet folder, a KiCad
//                           export): its files listed, small ones read, the
//                           rest fetched when something opens them.
//   /Downloads/<id>/…       where a browser WITHOUT that API is told to save:
//                           a file written there is downloaded; a folder's
//                           files are downloaded together as one .zip.
//   /Browser/<name>         (not a mount — plain storage) a project kept in a
//                           browser without the API; see dialogs.js.
//
// The visitor's disk is reached only after a write has landed in memory, so a
// failure there cannot be main's to see; `idle()` hands it to the IPC layer,
// which turns the answer to the call that caused it into that error.

import * as path from "./node/path.js";
import { zipStored } from "./zip.js";
import { t } from "./strings.js";

const TEMP_FILE_RE = /\.chiphippotmp-\d+\.tmp$/;
// A picked folder's files at or under this are read at once (a KiCad
// export's text files, which main reads synchronously); larger ones (a
// datasheet PDF) wait until something opens them.
const EAGER_BYTES = 256 * 1024;
const MOUNT_RE = /^\/(Files|Downloads)\/(\d+)(?:\/|$)/;

function denied(name) {
  return Object.assign(
    new Error(
      t("web.writeDenied", "Chip Hippo was not allowed to change “{name}”.", {
        name,
      }),
    ),
    { code: "EACCES" },
  );
}

async function ensurePermission(handle, mode, ask) {
  if (!handle?.queryPermission) return true;
  let state = await handle.queryPermission({ mode });
  if (state === "prompt" && ask)
    state = await handle.requestPermission({ mode });
  return state === "granted";
}

async function writeHandle(handle, bytes) {
  if (!(await ensurePermission(handle, "readwrite", true)))
    throw denied(handle.name);
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
}

export class Mounts {
  #vfs;
  #persist;
  #download;
  #mounts = new Map(); // id → mount
  #nextId = 1;
  #chain = Promise.resolve();
  #errors = [];

  /**
   * @param {{vfs: import("./vfs.js").Vfs, persist: import("./persist.js").Persist,
   *   download: (name: string, bytes: Uint8Array) => void}} deps
   */
  constructor({ vfs, persist, download }) {
    this.#vfs = vfs;
    this.#persist = persist;
    this.#download = download;
  }

  /** Which paths storage keeps: main's own, the browser's projects, and the
      files picked through the API (not their folders, not the downloads). */
  keep(p) {
    if (p === "/userData" || p.startsWith("/userData/")) return true;
    if (p === "/Browser" || p.startsWith("/Browser/")) return true;
    const m = MOUNT_RE.exec(p);
    if (!m || m[1] !== "Files") return false;
    return this.#mounts.get(Number(m[2]))?.kind === "file";
  }

  // ── Startup ───────────────────────────────────────────────────────────────

  /** Bring back the mounts an earlier session made, refreshing each from
      disk where the browser still lets us read it without asking. */
  async load() {
    const next = await this.#persist.getRecord("mount-next");
    if (Number.isInteger(next)) this.#nextId = next;
    for (const [, rec] of await this.#persist.allRecords("mount:")) {
      if (!rec || !Number.isInteger(rec.id)) continue;
      this.#mounts.set(rec.id, { ...rec });
      this.#nextId = Math.max(this.#nextId, rec.id + 1);
    }
    await Promise.all(
      [...this.#mounts.values()].map(async (m) => {
        try {
          if (m.kind === "file") await this.#refresh(m, false);
          else if (m.kind === "dir") await this.#list(m, false);
        } catch (err) {
          console.warn(
            `[web] could not refresh ${m.path}:`,
            err?.message ?? err,
          );
        }
      }),
    );
  }

  start() {
    this.#vfs.onChange((change) => this.#onChange(change));
  }

  // ── Making mounts ─────────────────────────────────────────────────────────

  async #mint(rec) {
    const id = this.#nextId++;
    const mount = { id, ...rec };
    this.#mounts.set(id, mount);
    await this.#persist.setRecord("mount-next", this.#nextId);
    return mount;
  }

  async #save(mount) {
    if (mount.kind !== "file" && mount.kind !== "dir") return;
    const { batch: _batch, files: _files, ...rec } = mount;
    await this.#persist.setRecord(`mount:${mount.id}`, rec);
  }

  /** The mount already holding this handle's file or folder, if any. */
  async #sameEntry(handle, kind) {
    for (const m of this.#mounts.values()) {
      if (m.kind !== kind || !m.handle?.isSameEntry) continue;
      try {
        if (await m.handle.isSameEntry(handle)) return m;
      } catch {
        // a handle whose entry has gone
      }
    }
    return null;
  }

  /**
   * A picked FILE. `read` brings its bytes in (an Open); a Save As target
   * is written by main a moment later and needs none.
   * @returns {Promise<string>} its path
   */
  async mountFile(handle, { read = true } = {}) {
    let mount = await this.#sameEntry(handle, "file");
    if (!mount) {
      const id = this.#nextId;
      mount = await this.#mint({
        kind: "file",
        name: handle.name,
        handle,
        path: `/Files/${id}/${handle.name}`,
      });
      await this.#save(mount);
    }
    this.#vfs.restoreDir(path.dirname(mount.path));
    if (read) await this.#refresh(mount, true);
    return mount.path;
  }

  /** A picked FOLDER. @returns {Promise<string>} its path */
  async mountDir(handle, { mode = "read" } = {}) {
    let mount = await this.#sameEntry(handle, "dir");
    if (!mount) {
      const id = this.#nextId;
      mount = await this.#mint({
        kind: "dir",
        name: handle.name,
        handle,
        mode,
        path: `/Files/${id}/${handle.name}`,
      });
    } else if (mode === "readwrite") {
      mount.mode = "readwrite";
    }
    await this.#save(mount);
    await this.#list(mount, true);
    return mount.path;
  }

  /** A folder given as a FileList (`<input webkitdirectory>`): read-only, and
      for this session only. @returns {string} its path */
  mountFileList(files) {
    const list = [...files];
    const top = (list[0]?.webkitRelativePath ?? "").split("/")[0] || "Folder";
    const id = this.#nextId++;
    const mount = { id, kind: "list", name: top, path: `/Files/${id}/${top}` };
    this.#mounts.set(id, mount);
    this.#vfs.restoreDir(mount.path);
    for (const file of list) {
      const rel =
        file.webkitRelativePath?.split("/").slice(1).join("/") || file.name;
      if (rel.includes("/")) continue; // only the folder's own files
      this.#vfs.registerLazy(`${mount.path}/${rel}`, {
        size: file.size,
        loadSync: null,
        load: async () => new Uint8Array(await file.arrayBuffer()),
      });
      (mount.files ??= new Map()).set(rel, file);
    }
    return mount.path;
  }

  /** Where a browser without the API saves ONE file: it is downloaded as soon
      as it is written. @returns {string} */
  downloadFile(name) {
    const id = this.#nextId++;
    const mount = {
      id,
      kind: "download",
      name,
      path: `/Downloads/${id}/${name}`,
    };
    this.#mounts.set(id, mount);
    this.#vfs.restoreDir(path.dirname(mount.path));
    return mount.path;
  }

  /** …and a FOLDER: what is written into it is downloaded as one .zip. */
  downloadDir(name) {
    const id = this.#nextId++;
    const mount = {
      id,
      kind: "download-dir",
      name,
      path: `/Downloads/${id}/${name}`,
      batch: [],
    };
    this.#mounts.set(id, mount);
    this.#vfs.restoreDir(mount.path);
    return mount.path;
  }

  // ── Reading the visitor's disk ────────────────────────────────────────────

  async #refresh(mount, ask) {
    if (!(await ensurePermission(mount.handle, "read", ask))) return false;
    const file = await mount.handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    this.#vfs.restoreFile(mount.path, bytes, { mtimeMs: file.lastModified });
    return true;
  }

  /**
   * Re-read a picked file from disk before main reads it (Open Recent, which
   * a click asked for, so the browser may ask the visitor too).
   */
  async refreshPath(p, { ask = true } = {}) {
    const mount = this.#mountOf(p);
    if (mount?.kind !== "file" || mount.path !== path.resolve(p)) return false;
    try {
      return await this.#refresh(mount, ask);
    } catch (err) {
      console.warn(`[web] could not re-read ${p}:`, err?.message ?? err);
      return false;
    }
  }

  async #list(mount, ask) {
    if (!(await ensurePermission(mount.handle, mount.mode ?? "read", ask)))
      return false;
    this.#vfs.forget(mount.path);
    this.#vfs.restoreDir(mount.path);
    mount.files = new Map();
    for await (const [name, entry] of mount.handle.entries()) {
      if (entry.kind !== "file") continue;
      const file = await entry.getFile();
      mount.files.set(name, entry);
      const p = `${mount.path}/${name}`;
      if (file.size <= EAGER_BYTES) {
        this.#vfs.restoreFile(p, new Uint8Array(await file.arrayBuffer()), {
          mtimeMs: file.lastModified,
        });
      } else {
        this.#vfs.registerLazy(p, {
          size: file.size,
          loadSync: null,
          load: async () =>
            new Uint8Array(await (await entry.getFile()).arrayBuffer()),
        });
      }
    }
    return true;
  }

  /** A file's contents as a Blob (shell.openPath hands it to a new tab). */
  async blob(p, type) {
    const target = path.resolve(p);
    const mount = this.#mountOf(target);
    const name = path.basename(target);
    if (
      mount &&
      (mount.kind === "dir" || mount.kind === "list") &&
      path.dirname(target) === mount.path
    ) {
      const entry = mount.files?.get(name);
      if (entry) {
        const file = entry.getFile ? await entry.getFile() : entry;
        return type ? new Blob([file], { type }) : file;
      }
    }
    const bytes = await this.#vfs.readFile(target);
    return new Blob([bytes], type ? { type } : {});
  }

  // ── Carrying writes out ───────────────────────────────────────────────────

  #mountOf(p) {
    const m = MOUNT_RE.exec(path.resolve(p));
    return m ? (this.#mounts.get(Number(m[2])) ?? null) : null;
  }

  #queue(task) {
    this.#chain = this.#chain.then(task).catch((err) => {
      this.#errors.push(err);
    });
  }

  #onChange(change) {
    if (change.op !== "write" && change.op !== "rename") return;
    const p = change.path;
    if (TEMP_FILE_RE.test(p)) return;
    const mount = this.#mountOf(p);
    if (!mount) return;
    const bytes = this.#vfs.peek(p);
    if (!bytes) return;
    const data = bytes.slice();
    const name = path.basename(p);
    const inFolder = path.dirname(p) === mount.path;
    switch (mount.kind) {
      case "file":
        if (p === mount.path)
          this.#queue(() => writeHandle(mount.handle, data));
        break;
      case "dir":
        if (inFolder) {
          this.#queue(async () => {
            if (!(await ensurePermission(mount.handle, "readwrite", true)))
              throw denied(mount.name);
            const entry = await mount.handle.getFileHandle(name, {
              create: true,
            });
            mount.files?.set(name, entry);
            await writeHandle(entry, data);
          });
        }
        break;
      case "download":
        if (p === mount.path) this.#queue(() => this.#download(name, data));
        break;
      case "download-dir":
        if (inFolder) {
          mount.batch = mount.batch.filter((f) => f.name !== name);
          mount.batch.push({ name, data });
        }
        break;
      default:
        break;
    }
  }

  /**
   * Resolves once every write so far has reached the visitor's disk (or been
   * downloaded); rejects with the first that could not.
   */
  async idle() {
    for (const mount of this.#mounts.values()) {
      if (mount.kind !== "download-dir" || !mount.batch.length) continue;
      const files = mount.batch;
      mount.batch = [];
      const base = files[0].name.replace(/\.[^.]*$/, "") || mount.name;
      this.#queue(() => this.#download(`${base}.zip`, zipStored(files)));
    }
    await this.#chain;
    if (this.#errors.length) {
      const [first] = this.#errors;
      this.#errors = [];
      throw first;
    }
  }
}
