/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * project-store.js — projects: a workspace of desktops, and the FILES they are
 * kept in.
 *
 * THERE IS ALWAYS A PROJECT. The app opens onto one from its very first
 * launch, so there is no second "working desk" mode beside it: every document
 * on screen is a desktop of the open project.
 *
 * A PROJECT IS A FILE, NOT A FOLDER, and so is every desktop in it:
 *
 *     <name>.project.chiphippo    the tab list (below), wherever the user put it
 *     <name>.desktop.chiphippo    one document per desktop, ditto
 *
 * Neither has to live anywhere in particular — the user picks with a Save As
 * dialog. Until they do, the app keeps the file for them in its own SAVES
 * directory (`userData/saves/`):
 *
 *   · a brand-new desktop is minted as `<guid>.desktop.chiphippo` there. Any
 *     desktop whose file is IN that folder is the app's to clean up — the
 *     minted one, and equally one the user saved into it — so Save As, Open,
 *     and deleting a desktop all remove the file they leave behind there,
 *     while a file anywhere else is the user's and is never touched. That is
 *     what the `defaultFile` flag reports, and it is DERIVED from the path on
 *     the way out (`_normalize`), so it cannot drift from where the file is.
 *   · an unsaved PROJECT has a BLANK name and a BLANK location, and lives in
 *     the ONE fixed default project file, `saves/default.project.chiphippo`.
 *     It is to a project exactly what desk.json used to be to a schematic: the
 *     always-there working slot. Saving the project under a name moves it out
 *     and deletes the default file; starting a new project takes the slot over.
 *
 * That is also the whole of the startup rule (main.js's `bootProject`): if the
 * default project file exists it IS the session's project; if it doesn't, the
 * last project the user saved or opened is (the MRU list), and failing that a
 * brand-new one is created.
 *
 * The project file itself:
 *
 *     { version, name, description?, activeTab, nextIndex,
 *       tabs: [ { id, name, description?, file, defaultFile? } ] }
 *
 * `file` is an absolute path — a desktop can be anywhere. The one exception is
 * a `defaultFile` desktop, whose STORED path is REBASED onto this machine's
 * saves directory when it is read, so a project file carried to another
 * machine (or a different --user-data-dir) still finds its app-kept desktops.
 *
 * A tab's `description` is the second half of the Name/Description pair every
 * object in the app carries, and is optional in the same omit-when-empty way.
 *
 * This module owns the SHAPE of those files and the saves directory. It does
 * not own dialogs, the MRU list, or the decision of which path to write to —
 * main.js does, and it is the only caller.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const io = require("./io");
const { defaultDeskDocument } = require("./migrations");

/**
 * Schema version of a project file. v3 is the file-based redesign: projects
 * and desktops became real files at user-chosen paths, so the folder-per-
 * project layout (and its slug ids) is gone. Nothing migrates a v1/v2 folder
 * project — they never left the app's own directory.
 */
const PROJECT_VERSION = 3;

/** The app's own folder for files the user hasn't chosen a home for yet. */
const SAVES_DIR = "saves";

/** Extensions. Both end in `.chiphippo`, so one filter matches either. */
const PROJECT_EXT = ".project.chiphippo";
const DESKTOP_EXT = ".desktop.chiphippo";

/** The one fixed file an UNSAVED (blank-name, blank-location) project lives in. */
const DEFAULT_PROJECT_FILE = `default${PROJECT_EXT}`;

/** A minted desktop file name: a GUID, so two of them can never collide. */
const TEMP_DESKTOP_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.desktop\.chiphippo$/i;

/** How long a name may be (it becomes a suggested file name). */
const MAX_NAME = 64;

/** What no file name should carry: the control range and the path/shell set.
    (A control character is exactly what has to be stripped out of a name that
    becomes a file name, hence the disable.) */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_RE = /[\x00-\x1f<>:"\\/|?*]+/g;

function taggedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * A display name reduced to a safe file name — the DEFAULT a Save As dialog
 * opens with, never a path. Spaces survive ("6502 SBC.project.chiphippo" reads
 * better than a slug); only what an OS would choke on is stripped.
 */
function suggestFileName(name, ext, fallback = "untitled") {
  const clean = String(name ?? "")
    .replace(UNSAFE_FILENAME_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, MAX_NAME)
    .trim();
  return `${clean || fallback}${ext}`;
}

/** Trim a user-supplied string field, or "" for anything that isn't one. */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

class ProjectStore {
  /**
   * @param {string} dataDir - the app's userData directory.
   * @param {{readFile: Function, writeFile: Function}} deskStore - reads and
   *   writes a desktop's document (migrations included), so this module never
   *   parses a desk document itself.
   */
  constructor(dataDir, deskStore) {
    this._saves = path.join(dataDir, SAVES_DIR);
    this._desk = deskStore;
  }

  /** The app's saves directory (created on demand — see `ensureSaves`). */
  get savesDir() {
    return this._saves;
  }

  /** Where an unsaved project (blank name, blank location) is kept. */
  get defaultProjectPath() {
    return path.join(this._saves, DEFAULT_PROJECT_FILE);
  }

  /** Create the saves directory if this is the app's first run. */
  ensureSaves() {
    io.ensureDir(this._saves);
    return this._saves;
  }

  /** Is `filePath` inside the app's own saves directory? */
  isInsideSaves(filePath) {
    if (typeof filePath !== "string" || !filePath) return false;
    const resolved = path.resolve(filePath);
    const root = path.resolve(this._saves);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  /** Is `filePath` one of the GUID desktop files the app mints? (Save As
      suggests a real name instead of showing a GUID back to the user.) */
  isTempDesktop(filePath) {
    return (
      this.isInsideSaves(filePath) &&
      TEMP_DESKTOP_RE.test(path.basename(String(filePath)))
    );
  }

  /** Is the unsaved project's fixed file on disk? (the startup question) */
  hasDefaultProject() {
    return fs.existsSync(this.defaultProjectPath);
  }

  /**
   * A brand-new project: BLANK name, BLANK location, exactly one desktop
   * ("Desktop 1", in a freshly minted GUID file). Its home until it is saved
   * is the fixed default project file, which this writes — so the next launch
   * finds it there.
   *
   * @returns {object} the meta, `location: null`.
   */
  newProject() {
    this.ensureSaves();
    // There is ONE working slot, and this takes it over: whatever unsaved
    // project was in it is abandoned, app-kept desktop files and all (the
    // caller has already offered to save it).
    this.discardDefaultProject();
    const meta = {
      version: PROJECT_VERSION,
      name: "",
      description: "",
      activeTab: null,
      nextIndex: 1,
      tabs: [],
    };
    const only = this._appendTab(meta);
    meta.activeTab = only.id;
    this.write(this.defaultProjectPath, meta);
    return { ...meta, location: null };
  }

  /**
   * Add one desktop to a project the renderer is holding. The document file is
   * written straight away (an empty desk, so the file a new desktop starts
   * from reads back as exactly what the desk shows); the PROJECT file is not —
   * a project is saved deliberately, so adding a desktop makes it dirty.
   *
   * @param {object} meta - the live project meta from the renderer.
   * @returns {object} the meta with the new tab appended and active.
   */
  addTab(meta) {
    this.ensureSaves();
    const next = this._normalize(meta);
    if (!next) throw taggedError("a project needs a desktop", "INVALID_ARG");
    next.location = meta?.location ?? null;
    const tab = this._appendTab(next);
    next.activeTab = tab.id;
    return next;
  }

  /**
   * Append one desktop to `meta` (in memory) and write its document.
   *
   * The visible number comes from `nextIndex`, which only ever counts up —
   * deleting "Desktop 2" never makes the next one Desktop 2 again, so a name
   * in a note or a screenshot keeps meaning the same desk.
   */
  _appendTab(meta, doc = defaultDeskDocument()) {
    const ids = new Set(meta.tabs.map((t) => t.id));
    let index = Number.isInteger(meta.nextIndex) ? meta.nextIndex : 1;
    while (ids.has(`t${index}`)) index += 1;
    meta.nextIndex = index + 1;
    const tab = {
      id: `t${index}`,
      name: `Desktop ${index}`,
      file: path.join(this._saves, `${randomUUID()}${DESKTOP_EXT}`),
      defaultFile: true,
    };
    meta.tabs.push(tab);
    this._desk.writeFile(tab.file, doc);
    return tab;
  }

  /**
   * Read a project file. Returns null when the path holds no project (missing,
   * corrupt, or some other JSON) — the caller falls back rather than failing.
   *
   * `location` is BLANK for the fixed default file: that project has never
   * been given a home, which is exactly what the Properties dialog shows.
   */
  read(filePath) {
    const meta = this._normalize(io.readJSON(filePath));
    if (!meta) return null;
    const resolved = path.resolve(filePath);
    meta.location =
      resolved === path.resolve(this.defaultProjectPath) ? null : resolved;
    return meta;
  }

  /**
   * Write a project file. The caller decides WHERE (its location, or the fixed
   * default file for a project that has none); only the fields this module
   * owns are written, so `location` — which is the path itself — never becomes
   * a stored field that could disagree with reality.
   */
  write(filePath, meta) {
    const clean = this._normalize(meta);
    if (!clean) throw taggedError("a project needs a desktop", "INVALID_ARG");
    io.ensureDir(path.dirname(filePath));
    io.writeJSON(filePath, {
      version: PROJECT_VERSION,
      name: clean.name,
      ...(clean.description ? { description: clean.description } : {}),
      activeTab: clean.activeTab,
      nextIndex: clean.nextIndex,
      tabs: clean.tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        ...(tab.description ? { description: tab.description } : {}),
        file: tab.file,
        ...(tab.defaultFile ? { defaultFile: true } : {}),
      })),
    });
    return filePath;
  }

  /** Bring a stored (or renderer-supplied) project to the current shape. */
  _normalize(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.tabs)) {
      return null;
    }
    const ids = new Set();
    const tabs = [];
    for (const tab of raw.tabs) {
      if (!tab || typeof tab !== "object") continue;
      const file = text(tab.file);
      const id = text(tab.id);
      if (!file || !id || ids.has(id)) continue;
      ids.add(id);
      // The STORED flag means "the app was keeping this one", which is what
      // says to rebase it onto THIS machine's saves directory — a project file
      // that travelled still finds its app-kept desktops.
      const resolved =
        tab.defaultFile === true
          ? path.join(this._saves, path.basename(file))
          : path.resolve(file);
      // The flag handed OUT is derived from where the file actually is, so it
      // can never drift from the truth: a desktop the user saved into the
      // app's own folder is app-kept too, whatever the file says.
      const appKept = this.isInsideSaves(resolved);
      tabs.push({
        id,
        name: text(tab.name) || id,
        ...(text(tab.description)
          ? { description: text(tab.description) }
          : {}),
        file: resolved,
        ...(appKept ? { defaultFile: true } : {}),
      });
    }
    if (tabs.length === 0) return null;
    const highest = tabs.reduce((max, tab) => {
      const n = /^t(\d+)$/.exec(tab.id);
      return n ? Math.max(max, Number(n[1])) : max;
    }, 0);
    return {
      version: PROJECT_VERSION,
      name: text(raw.name).slice(0, MAX_NAME),
      description: text(raw.description),
      activeTab: tabs.some((t) => t.id === raw.activeTab)
        ? raw.activeTab
        : tabs[0].id,
      nextIndex:
        Number.isInteger(raw.nextIndex) && raw.nextIndex > highest
          ? raw.nextIndex
          : highest + 1,
      tabs,
    };
  }

  /** Read a desktop's document (migrated); an empty desk when it's missing. */
  readTab(filePath) {
    return this._desk.readFile(filePath);
  }

  /** Write a desktop's document. Returns the path written. */
  writeTab(filePath, doc) {
    io.ensureDir(path.dirname(filePath));
    return this._desk.writeFile(filePath, doc);
  }

  /**
   * Delete a desktop's file — when the desktop is removed from its project,
   * or when Save As / Open has given it a home somewhere else.
   *
   * THE LOCATION DECIDES, and nothing else: a file inside the app's own saves
   * folder is the app's to clean up (whether it is the GUID one minted when
   * the desktop was added, or one the user saved into that folder), and a file
   * anywhere else is the user's and is left exactly where it is. A path
   * outside is not an error — it is simply not ours — so callers can hand over
   * any desktop's file and let this decide.
   *
   * @returns {boolean} whether a file was deleted.
   */
  removeDesktopFile(filePath) {
    if (typeof filePath !== "string" || !this.isInsideSaves(filePath)) {
      return false; // the user's own file: not ours to remove
    }
    const resolved = path.resolve(filePath);
    if (resolved.endsWith(PROJECT_EXT)) {
      // A project file is not a desktop; removing one is a different act with
      // a different method (removeDefaultProject), so refuse it here.
      throw taggedError(`not a desktop file: ${filePath}`, "INVALID_ARG");
    }
    try {
      fs.unlinkSync(resolved);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false; // already gone is fine
      throw err;
    }
  }

  /**
   * Drop the fixed default project file, and NOTHING else — the project that
   * lived in the working slot has been saved somewhere real, so its desktops
   * (app-kept files included) belong to it and go on being used. Startup then
   * falls through to the MRU list.
   *
   * @returns {boolean} whether a file was deleted.
   */
  removeDefaultProject() {
    try {
      fs.unlinkSync(this.defaultProjectPath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * A project's unsaved changes are being THROWN AWAY (the leave/quit guard's
   * "Discard"). Anything the reloaded project won't have is now garbage, so
   * every desktop in the live `meta` that the project ON DISK does not list
   * has its file removed — subject to the one rule that governs every desktop
   * file: only inside the app's own saves folder.
   *
   * That is exactly the desktops ADDED since the project was last saved. A
   * desktop the user saved somewhere of their own keeps its file, as always;
   * one still in the app's folder would otherwise sit there forever, pointed
   * at by nothing.
   *
   * The comparison is against the FILE, never against anything the renderer
   * remembers, so a desktop that is genuinely still in the project can never
   * be swept up by a stale idea of what was saved.
   *
   * @param {object} meta - the live project, as the renderer holds it.
   * @param {string|null} filePath - where the project is saved; null for the
   *   unsaved one, whose file is the fixed default project file.
   * @returns {Array<string>} the files removed.
   */
  discardChanges(meta, filePath) {
    const onDisk = this.read(filePath || this.defaultProjectPath);
    const kept = new Set((onDisk?.tabs ?? []).map((tab) => tab.file));
    const removed = [];
    for (const tab of meta?.tabs ?? []) {
      const file = typeof tab?.file === "string" ? path.resolve(tab.file) : "";
      if (!file || kept.has(file)) continue;
      if (safeCall(() => this.removeDesktopFile(file))) removed.push(file);
    }
    return removed;
  }

  /**
   * ABANDON whatever is in the working slot — the unsaved project the user
   * discarded when they started or opened another one. The default project
   * file goes, and so do the desktop files the APP was keeping for it: nothing
   * else ever pointed at them, so leaving them behind is pure litter. A
   * desktop the USER saved somewhere is theirs and is left alone.
   *
   * @returns {boolean} whether there was a working project to abandon.
   */
  discardDefaultProject() {
    const meta = this._normalize(io.readJSON(this.defaultProjectPath));
    for (const tab of meta?.tabs ?? []) {
      // A file outside the saves folder is the user's, and removeDesktopFile
      // leaves it alone — so every tab can simply be handed over.
      safeCall(() => this.removeDesktopFile(tab.file));
    }
    return this.removeDefaultProject();
  }
}

/** Best-effort cleanup: a file that can't be removed is not worth failing a
    New Project over (it is litter, not data). */
function safeCall(fn) {
  try {
    return fn();
  } catch (err) {
    console.error("[store] project cleanup:", err && err.message);
    return null;
  }
}

module.exports = {
  ProjectStore,
  suggestFileName,
  PROJECT_VERSION,
  PROJECT_EXT,
  DESKTOP_EXT,
  DEFAULT_PROJECT_FILE,
  SAVES_DIR,
};
