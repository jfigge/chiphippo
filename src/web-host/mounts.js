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
//                           export): its files listed, small ones and those
//                           main reads synchronously read, the rest fetched
//                           when something opens them.
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
// A picked folder's files at or under this are read at once; larger ones (a
// datasheet PDF, a board's 3D models) wait until something opens them.
const EAGER_BYTES = 256 * 1024;
/**
 * …except the files main reads SYNCHRONOUSLY from a picked folder, which are
 * read whatever their size: a browser has no synchronous file read, so one
 * main asks for must already be in memory. That is the KiCad export's two
 * (`app/ipc/export.js` `writeKicadFolder`): the schematic, to see who wrote
 * it, and the `sym-lib-table`, to merge our line into. Everything else main
 * does to a picked folder is an `existsSync` (the `.kicad_pro`, a datasheet
 * PDF) or a write, which a lazy node answers. `storage.test.js` holds main to
 * this list: a new synchronous read there fails until it is added here.
 */
export const MAIN_SYNC_READS = Object.freeze([
  /\.kicad_sch$/,
  /^sym-lib-table$/,
]);

/** Whether main may read a picked folder's file `name` synchronously. */
export function mainReadsSync(name) {
  return MAIN_SYNC_READS.some((re) => re.test(name));
}
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

function changedOnDisk(name) {
  return Object.assign(
    new Error(
      t(
        "web.changedOnDisk",
        "“{name}” was changed outside Chip Hippo, so it was not replaced.",
        { name },
      ),
    ),
    { code: "EEXIST" },
  );
}

/** Whether two byte arrays hold the same bytes. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The calls a write is made under, as a list (`owner` may name one, several
    — an async handler's later write with more than one call out — or none). */
function ownerList(owner) {
  if (owner == null) return [];
  return Array.isArray(owner) ? owner : [owner];
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
  #errors = []; // {err, owners: Set, anyone}
  #owing = new Map(); // owner → writes queued for it and not yet answered
  #settled = new WeakSet(); // owners that have asked `idle` — answered
  #owner;
  #confirmReplace;

  /**
   * @param {{vfs: import("./vfs.js").Vfs, persist: import("./persist.js").Persist,
   *   download: (name: string, bytes: Uint8Array, win?: Window|null) => void,
   *   owner?: () => object|object[]|null,
   *   confirmReplace?: (name: string) => Promise<boolean>}} deps
   *   `owner` names the IPC call a change is made under (ipc.js) — or every
   *   call it may have been, when that cannot be told — so a write the
   *   visitor's disk refuses is answered to THAT call; `confirmReplace`
   *   asks before a picked file changed elsewhere is written over.
   */
  constructor({
    vfs,
    persist,
    download,
    owner = () => null,
    confirmReplace = async () => false,
  }) {
    this.#vfs = vfs;
    this.#persist = persist;
    this.#download = download;
    this.#owner = owner;
    this.#confirmReplace = confirmReplace;
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
      // What storage kept is, as far as it knows, what the disk last held.
      const known = rec.kind === "file" ? this.#vfs.peek(rec.path) : null;
      this.#mounts.set(rec.id, { ...rec, known });
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
    const {
      batch: _batch,
      batchOwner: _batchOwner,
      files: _files,
      known: _known,
      ...rec
    } = mount;
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
    // A Save As target: the picker has just asked whether to replace it.
    else if (mount.diskMtime != null) {
      delete mount.diskMtime;
      mount.known = null;
      await this.#save(mount);
    }
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
      for this session only — filled as a picked folder is (`#fill`).
      @returns {Promise<string>} its path */
  async mountFileList(files) {
    const list = [...files];
    const top = (list[0]?.webkitRelativePath ?? "").split("/")[0] || "Folder";
    const id = this.#nextId++;
    const mount = { id, kind: "list", name: top, path: `/Files/${id}/${top}` };
    this.#mounts.set(id, mount);
    this.#vfs.restoreDir(mount.path);
    mount.files = new Map();
    const found = [];
    for (const file of list) {
      const rel =
        file.webkitRelativePath?.split("/").slice(1).join("/") || file.name;
      if (rel.includes("/")) continue; // only the folder's own files
      mount.files.set(rel, file);
      found.push({ name: rel, file, read: () => file });
    }
    await this.#fill(mount, found);
    return mount.path;
  }

  /** Where a browser without the API saves ONE file: it is downloaded as soon
      as it is written — in `win`, the window that asked (see `download`).
      @returns {string} */
  downloadFile(name, { win = null } = {}) {
    const id = this.#nextId++;
    const mount = {
      id,
      kind: "download",
      name,
      path: `/Downloads/${id}/${name}`,
      win,
    };
    this.#mounts.set(id, mount);
    this.#vfs.restoreDir(path.dirname(mount.path));
    return mount.path;
  }

  /** …and a FOLDER: what is written into it is downloaded as one .zip. */
  downloadDir(name, { win = null } = {}) {
    const id = this.#nextId++;
    const mount = {
      id,
      kind: "download-dir",
      name,
      path: `/Downloads/${id}/${name}`,
      batch: [],
      win,
    };
    this.#mounts.set(id, mount);
    this.#vfs.restoreDir(mount.path);
    return mount.path;
  }

  // ── Reading the visitor's disk ────────────────────────────────────────────

  /**
   * Read a picked file in from disk. Changed there since last seen, what
   * storage keeps is made what this reading saw BEFORE its time is recorded:
   * a later visit the browser does not let re-read the file boots storage's
   * copy and compares the disk with that time — an older copy under the
   * newer time would be written over the file it never saw, unasked.
   * Unchanged, storage already holds it (or the visitor's newer work).
   * Storage refusing it, the older time stays, so a write asks rather than
   * trusts.
   */
  async #refresh(mount, ask) {
    if (!(await ensurePermission(mount.handle, "read", ask))) return false;
    const file = await mount.handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const held = this.#vfs.peek(mount.path);
    this.#vfs.restoreFile(mount.path, bytes, { mtimeMs: file.lastModified });
    if (!held || mount.diskMtime !== file.lastModified) {
      try {
        await this.#persist.store(mount.path);
      } catch (err) {
        console.warn(`[web] could not keep ${mount.path}:`, err?.message);
        return true;
      }
    }
    await this.#knowDisk(mount, file.lastModified, bytes);
    return true;
  }

  /** Remember when the disk's copy was last one we read or wrote, and what
      it held (a rewrite of the same bytes moves the time and nothing else). */
  async #knowDisk(mount, lastModified, bytes) {
    if (!Number.isFinite(lastModified)) return;
    mount.known = bytes;
    if (mount.diskMtime === lastModified) return;
    mount.diskMtime = lastModified;
    await this.#save(mount);
  }

  /**
   * Write a picked file back — unless it changed on disk since this session
   * (or the copy storage kept from an earlier one) last saw it: a visit that
   * booted that kept copy, the browser not yet letting it re-read the file,
   * would otherwise put old work over newer. The visitor is asked; declined,
   * the save fails as a refused write does.
   */
  async #writeFile(mount, data) {
    const { handle } = mount;
    if (!(await ensurePermission(handle, "readwrite", true)))
      throw denied(handle.name);
    if (Number.isFinite(mount.diskMtime) && handle.getFile) {
      const file = await handle.getFile();
      if (
        Number.isFinite(file.lastModified) &&
        file.lastModified > mount.diskMtime &&
        !(await this.#sameAsKnown(mount, file)) &&
        !(await this.#confirmReplace(mount.name))
      )
        throw changedOnDisk(mount.name);
    }
    await writeHandle(handle, data);
    if (handle.getFile)
      await this.#knowDisk(mount, (await handle.getFile()).lastModified, data);
  }

  /** A disk file whose time moved: is it still the bytes last read or
      written (a sync client, an editor saving unchanged)? Only this — the
      rare case — reads it to see. */
  async #sameAsKnown(mount, file) {
    if (!mount.known || mount.known.length !== file.size) return false;
    return sameBytes(mount.known, new Uint8Array(await file.arrayBuffer()));
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

  /** List a picked folder; `ask` is a pick (a dialog just handed it over). */
  async #list(mount, ask) {
    if (!(await ensurePermission(mount.handle, mount.mode ?? "read", ask)))
      return false;
    this.#vfs.forget(mount.path);
    this.#vfs.restoreDir(mount.path);
    mount.files = new Map();
    const found = [];
    for await (const [name, entry] of mount.handle.entries()) {
      if (entry.kind !== "file") continue;
      mount.files.set(name, entry);
      found.push({
        name,
        file: await entry.getFile(),
        read: () => entry.getFile(),
      });
    }
    await this.#fill(mount, found);
    return true;
  }

  /**
   * Put a folder's files in the filesystem: the small ones read, and the
   * ones main reads synchronously (`MAIN_SYNC_READS`); the rest lazy —
   * `fs.promises` fetches them, a synchronous read cannot.
   */
  async #fill(mount, found) {
    for (const { name, file, read } of found) {
      const p = `${mount.path}/${name}`;
      if (file.size <= EAGER_BYTES || mainReadsSync(name)) {
        this.#vfs.restoreFile(p, new Uint8Array(await file.arrayBuffer()), {
          mtimeMs: file.lastModified,
        });
      } else {
        this.#vfs.registerLazy(p, {
          size: file.size,
          loadSync: null,
          load: async () => new Uint8Array(await (await read()).arrayBuffer()),
        });
      }
    }
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

  #queue(task, owner = this.#owner()) {
    // A call already settling (in `idle`) has had its answer: a write tagged
    // to it would be owed, or kept as its failure, for ever. With none of its
    // calls still to ask, a write is one no call can be named for.
    const owners = ownerList(owner).filter((o) => !this.#settled.has(o));
    for (const o of owners) this.#owing.set(o, (this.#owing.get(o) ?? 0) + 1);
    this.#chain = this.#chain.then(task).catch((err) => {
      this.#errors.push({
        err,
        owners: new Set(owners),
        anyone: !owners.length,
      });
    });
  }

  /** Whether `owner` (an IPC call) has a write still out, or refused. */
  owes(owner) {
    return this.#owing.has(owner);
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
        if (p === mount.path) this.#queue(() => this.#writeFile(mount, data));
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
        if (p === mount.path)
          this.#queue(() => this.#download(name, data, mount.win));
        break;
      case "download-dir":
        if (inFolder) {
          mount.batch = mount.batch.filter((f) => f.name !== name);
          mount.batch.push({ name, data });
          mount.batchOwner ??= this.#owner();
        }
        break;
      default:
        break;
    }
  }

  /**
   * Resolves once every write so far has reached the visitor's disk (or been
   * downloaded); rejects with the first that could not — of `owner`'s writes
   * (an IPC call's, ipc.js), or of those no call could be named for. Another
   * call's failure is kept for that call: an autosave's stash that settles
   * first must not take the error of the ⌘S beside it and leave the save
   * answered as a success. A write tagged to several calls (which of them
   * made it could not be told) is answered to each. No `owner`: every
   * failure so far.
   */
  async idle(owner = null) {
    if (owner) this.#settled.add(owner);
    for (const mount of this.#mounts.values()) {
      if (mount.kind !== "download-dir" || !mount.batch.length) continue;
      const files = mount.batch;
      const batchOwner = mount.batchOwner ?? null;
      mount.batch = [];
      mount.batchOwner = null;
      const base = files[0].name.replace(/\.[^.]*$/, "") || mount.name;
      this.#queue(
        () => this.#download(`${base}.zip`, zipStored(files), mount.win),
        batchOwner,
      );
    }
    await this.#chain;
    if (owner) this.#owing.delete(owner);
    const mine = this.#errors.filter(
      (e) => !owner || e.anyone || e.owners.has(owner),
    );
    if (!mine.length) return;
    for (const e of mine) if (owner) e.owners.delete(owner);
    this.#errors = this.#errors.filter(
      (e) => !mine.includes(e) || (owner && !e.anyone && e.owners.size > 0),
    );
    throw mine[0].err;
  }
}
