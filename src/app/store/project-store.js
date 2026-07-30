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
 * project-store.js — THE PROJECT IS THE DOCUMENT. One file holds the whole
 * design: every desktop, and every ROM image those desktops were programmed
 * with.
 *
 *     <name>.chiphippo
 *     {
 *       version, name, description?, activeTab, nextIndex,
 *       tabs:   [ { id, name, description?, doc } ],   // doc = a desk document
 *       images: { <rom-guid>: <base64> }               // programmed ROMs only
 *     }
 *
 * Up to v3 a project was a list of PATHS — one `.desktop.chiphippo` per tab,
 * anywhere on disk — and the ROM bytes were not in it at all. Two file
 * lifetimes had to be kept referentially consistent, which is where the
 * app-kept flags, the orphan collection, and the eager write-through all came
 * from; and it could not do the one thing a real file was for, since a project
 * carried to another machine had a dead path per tab and no ROM contents.
 * v4 inlines the lot. `project-migrate.js` brings a v3 file forward.
 *
 * WHAT IS LEFT HERE is only the shape of that one file:
 *
 *   · `newProject()` — a blank project, ONE desktop, written to the working
 *     slot so the next launch finds it.
 *   · `read` / `write` — the file, whole. Reading HYDRATES the memory cache
 *     from `images`; writing COLLECTS it back (project-images.js). Nothing
 *     outside the file is needed to open a design.
 *   · the working slot — an UNSAVED project (blank name, blank location) lives
 *     in the one fixed `saves/default.chiphippo`, which is to a project
 *     exactly what desk.json once was to a schematic: the always-there slot
 *     the app boots onto. `location` is never STORED — it IS the path, so it
 *     cannot disagree with reality, and it reads back blank for that file.
 *   · desktop SNAPSHOTS — the `.desktop.chiphippo` interchange fragment behind
 *     Export/Import. A snapshot is a copy with no retained link, so unlike the
 *     v3 desktop file it can never dangle.
 *
 * This module does not own dialogs, the MRU list, or the decision of which
 * path to write to — main.js does, and it is the only caller.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const io = require("./io");
const { defaultDeskDocument, migrateDeskDocument } = require("./migrations");
const {
  isProjectShape,
  isLegacyProject,
  migrateLegacyTabs,
} = require("./project-migrate");
const { collectImages, hydrateImages } = require("./project-images");

/**
 * Schema version of a project file. v4 is the single-file redesign: every
 * desktop's document and every programmed ROM's bytes moved INTO the file, so
 * a project has no companion files at all. v3 (paths per tab) is migrated on
 * read; the v1/v2 folder projects never left the app's own directory and are
 * not migrated.
 */
const PROJECT_VERSION = 4;

/** The app's own folder for files the user hasn't chosen a home for yet. */
const SAVES_DIR = "saves";

/** The memory cache `images` hydrates into (Feature 180's `.bin` sidecars). */
const MEMORY_DIR = "memory";

/** The project IS the document, so it takes the plain extension. */
const PROJECT_EXT = ".chiphippo";

/** The interchange fragment behind Export/Import — a snapshot, never a link. */
const DESKTOP_EXT = ".desktop.chiphippo";

/** v3's project extension. Still readable; never written. */
const LEGACY_PROJECT_EXT = ".project.chiphippo";

/** The one fixed file an UNSAVED (blank-name, blank-location) project lives in. */
const DEFAULT_PROJECT_FILE = `default${PROJECT_EXT}`;
const LEGACY_DEFAULT_PROJECT_FILE = `default${LEGACY_PROJECT_EXT}`;

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
 * opens with, never a path. Spaces survive ("6502 SBC.chiphippo" reads better
 * than a slug); only what an OS would choke on is stripped.
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

/**
 * A file name reduced to a display name — Save As names an untitled project
 * from the file the user picked, so there is no separate "name this project"
 * dialog to sit in front of the save panel.
 */
function nameFromFile(filePath) {
  const base = path.basename(String(filePath ?? ""));
  for (const ext of [DESKTOP_EXT, LEGACY_PROJECT_EXT, PROJECT_EXT, ".json"]) {
    if (base.toLowerCase().endsWith(ext)) return base.slice(0, -ext.length);
  }
  return base;
}

/** Trim a user-supplied string field, or "" for anything that isn't one. */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

class ProjectStore {
  /**
   * @param {string} dataDir - the app's userData directory.
   * @param {{readFile: Function, writeFile: Function}} deskStore - reads a
   *   desktop document from a legacy v3 file (migrations included), so this
   *   module never parses one itself.
   */
  constructor(dataDir, deskStore) {
    this._saves = path.join(dataDir, SAVES_DIR);
    this._memory = path.join(dataDir, MEMORY_DIR);
    this._desk = deskStore;
  }

  /** The app's saves directory (created on demand — see `ensureSaves`). */
  get savesDir() {
    return this._saves;
  }

  /** The memory cache `images` is hydrated into / collected from. */
  get memoryDir() {
    return this._memory;
  }

  /** Where an unsaved project (blank name, blank location) is kept. */
  get defaultProjectPath() {
    return path.join(this._saves, DEFAULT_PROJECT_FILE);
  }

  /** v3's working slot, upgraded in place on the first launch after v4. */
  get legacyDefaultProjectPath() {
    return path.join(this._saves, LEGACY_DEFAULT_PROJECT_FILE);
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

  /** Is the unsaved project's fixed file on disk? (the startup question) */
  hasDefaultProject() {
    return existsSafe(this.defaultProjectPath);
  }

  /**
   * A brand-new project: BLANK name, BLANK location, exactly one desktop
   * ("Desktop 1", an empty desk). Its home until it is saved is the fixed
   * default project file, which this writes — so the next launch finds it
   * there, and a force-quit before the first save still opens onto it.
   *
   * @returns {object} the meta, `location: null`.
   */
  newProject() {
    this.ensureSaves();
    // There is ONE working slot, and this takes it over. Nothing but the file
    // itself has to go now: a project has no companion files to collect.
    this.removeDefaultProject();
    const meta = {
      version: PROJECT_VERSION,
      name: "",
      description: "",
      activeTab: "t1",
      nextIndex: 2,
      tabs: [{ id: "t1", name: "Desktop 1", doc: defaultDeskDocument() }],
    };
    this.write(this.defaultProjectPath, meta);
    return { ...meta, location: null };
  }

  /**
   * Read a project file, WHOLE — every desktop's document with it, and the
   * memory cache refilled from its `images` so a ROM's backing file is there
   * before the renderer has seen the project.
   *
   * Three shapes come through here: a v4 project, a v3 project (inlined by
   * project-migrate.js), and a bare desk document or desktop snapshot (a loose
   * `.chiphippo` / `.desktop.chiphippo`), which becomes a project of one
   * desktop. Returns null only when the file holds none of them.
   *
   * `location` is BLANK for the fixed default file: that project has never
   * been given a home, which is exactly what the Properties dialog shows.
   * `warnings` (when present) is what the migration could not bring across —
   * neither field is ever stored.
   */
  read(filePath) {
    const raw = io.readJSON(filePath);
    if (!raw || typeof raw !== "object") return null;
    let meta = null;
    let warnings = [];
    const wasProject = isProjectShape(raw);
    if (wasProject) {
      if (isLegacyProject(raw)) {
        const upgraded = migrateLegacyTabs(raw, {
          deskStore: this._desk,
          savesDir: this._saves,
        });
        warnings = upgraded.warnings;
        meta = this._normalize({ ...raw, tabs: upgraded.tabs }, true);
      } else {
        meta = this._normalize(raw, true);
      }
    } else {
      // Not a project at all: a loose design, or an exported desktop.
      const snapshot = this._asSnapshot(raw, nameFromFile(filePath));
      if (snapshot) meta = this._normalize(projectOf(snapshot), true);
    }
    if (!meta) return null;
    hydrateImages(raw.images, this._memory);
    const resolved = path.resolve(filePath);
    // A project knows where it lives — EXCEPT in the working slot, which is
    // what "no location" means. A loose design is not a project file at all,
    // so it has no location either: Save As is what gives the project a home,
    // and nothing can overwrite the design that was imported.
    meta.location =
      !wasProject || resolved === path.resolve(this.defaultProjectPath)
        ? null
        : resolved;
    if (warnings.length) meta.warnings = warnings;
    return meta;
  }

  /**
   * Write a project file. The caller decides WHERE (its location, or the fixed
   * default file for a project that has none); only the fields this module
   * owns are written, so `location` — which is the path itself — never becomes
   * a stored field that could disagree with reality.
   *
   * Every programmed ROM's bytes are collected out of the memory cache and
   * written INTO the file, which is what makes it self-contained.
   */
  write(filePath, meta, { recoveryFor = null } = {}) {
    const clean = this._normalize(meta);
    if (!clean) throw taggedError("a project needs a desktop", "INVALID_ARG");
    const images = collectImages(clean, this._memory);
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
        doc: tab.doc,
      })),
      ...(Object.keys(images).length ? { images } : {}),
      // Only ever in the working slot, and only when the project it belongs to
      // has a file of its own (see `writeRecovery`).
      ...(recoveryFor ? { recoveryFor } : {}),
    });
    return filePath;
  }

  /**
   * Stash the open project in the working slot as a RECOVERY copy, without
   * touching the file it belongs to.
   *
   * `recoveryFor` is the path of that file, and it is what makes the slot mean
   * something different from its usual job. Normally the slot IS an unsaved
   * project's home; stamped, it is a copy of a project that has a home already,
   * holding work that is not in it yet. So the stamp is also the CRASH FLAG:
   * the slot is dropped by a save and by a clean quit, which leaves "a stamped
   * slot exists at startup" meaning exactly "we went away without finishing".
   * No timestamps to compare — mtimes are the one thing cloud sync and a
   * corrected clock will both lie about.
   *
   * ROM bytes ride along like any other write, so a recovered project is whole.
   */
  writeRecovery(meta, recoveryFor) {
    this.ensureSaves();
    return this.write(this.defaultProjectPath, meta, { recoveryFor });
  }

  /**
   * What the working slot is, WITHOUT reading it properly: null when there is
   * no slot, `{recoveryFor, name}` when it holds a recovery copy, and
   * `{recoveryFor: null, name}` when it is an ordinary unsaved project.
   *
   * Deliberately does not go through `read`, which HYDRATES the file's ROM
   * images into the memory cache. Startup has to know whether a recovery is
   * waiting before it can ask about it, and a recovery the user then DISCARDS
   * must not have overwritten the real project's ROM files on the way past.
   */
  peekRecovery() {
    const raw = io.readJSON(this.defaultProjectPath);
    if (!raw || typeof raw !== "object") return null;
    const recoveryFor =
      typeof raw.recoveryFor === "string" && raw.recoveryFor
        ? raw.recoveryFor
        : null;
    return { recoveryFor, name: typeof raw.name === "string" ? raw.name : "" };
  }

  /**
   * Bring a stored (or renderer-supplied) project to the current shape.
   *
   * `fromDisk` runs each desktop's document through the schema migrations, so
   * an older desk inside a project file comes forward. It is deliberately NOT
   * done on the way out: a write must store what the renderer holds, never a
   * re-derived version of it.
   */
  _normalize(raw, fromDisk = false) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.tabs)) {
      return null;
    }
    const ids = new Set();
    const tabs = [];
    for (const tab of raw.tabs) {
      if (!tab || typeof tab !== "object") continue;
      const id = text(tab.id);
      if (!id || ids.has(id)) continue;
      const doc = tab.doc;
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) continue;
      ids.add(id);
      tabs.push({
        id,
        name: text(tab.name) || id,
        ...(text(tab.description)
          ? { description: text(tab.description) }
          : {}),
        doc: fromDisk ? migrateDeskDocument(doc) : doc,
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

  // ── Desktop snapshots (Export / Import) ──────────────────────────────────
  //
  // A `.desktop.chiphippo` is a SNAPSHOT — one desktop, its ROM images with
  // it, and no link back to the project it came from. That is the whole point:
  // a copy cannot dangle, which is what the v3 desktop file could not promise.

  /**
   * Read a desktop snapshot for Import. Accepts a snapshot, a bare desk
   * document (a loose `.chiphippo` design), or a whole project — from which
   * the ACTIVE desktop is taken, since importing "a project" into a tab can
   * only mean one of its desks.
   *
   * @returns {{name: string, description: string, doc: object,
   *   images: object|null}|null}
   */
  readDesktopSnapshot(filePath) {
    const raw = io.readJSON(filePath);
    if (!raw || typeof raw !== "object") return null;
    if (isProjectShape(raw)) {
      const meta = this.read(filePath); // migrates + hydrates, whatever it is
      const tab = meta?.tabs.find((t) => t.id === meta.activeTab);
      if (!tab) return null;
      return {
        name: tab.name,
        description: tab.description ?? "",
        doc: tab.doc,
        // `read` has already hydrated the cache, so a reseat finds the files.
        images: null,
      };
    }
    return this._asSnapshot(raw, nameFromFile(filePath));
  }

  /**
   * Write one desktop out as a self-contained snapshot: its document, and the
   * bytes of every programmed ROM on it.
   */
  writeDesktopSnapshot(filePath, { name, description, doc }) {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw taggedError("a desktop needs a document", "INVALID_ARG");
    }
    const images = collectImages({ doc }, this._memory);
    io.ensureDir(path.dirname(filePath));
    io.writeJSON(filePath, {
      version: PROJECT_VERSION,
      kind: "desktop",
      name: text(name) || "Desktop",
      ...(text(description) ? { description: text(description) } : {}),
      doc,
      ...(Object.keys(images).length ? { images } : {}),
    });
    return filePath;
  }

  /** A parsed file as a desktop snapshot: the explicit shape, or a bare doc. */
  _asSnapshot(raw, fallbackName) {
    if (raw.kind === "desktop" && raw.doc && typeof raw.doc === "object") {
      return {
        name: text(raw.name) || fallbackName || "Desktop",
        description: text(raw.description),
        doc: migrateDeskDocument(raw.doc),
        images:
          raw.images && typeof raw.images === "object" ? raw.images : null,
      };
    }
    // A loose desk document. `migrateDeskDocument` answers with the default
    // empty desk for junk, which would silently import a blank tab — so only
    // a shape that actually looks like a desk gets through.
    if (!Array.isArray(raw.boards) && !Array.isArray(raw.components)) {
      return null;
    }
    return {
      name: fallbackName || "Desktop",
      description: "",
      doc: migrateDeskDocument(raw),
      images: null,
    };
  }

  // ── The working slot ─────────────────────────────────────────────────────

  /**
   * Drop the fixed default project file — the project that lived in the
   * working slot has been saved somewhere real (or replaced). There is nothing
   * else to clean up: a v4 project has no companion files.
   *
   * @returns {boolean} whether a file was deleted.
   */
  removeDefaultProject() {
    return unlinkSafe(this.defaultProjectPath);
  }

  /**
   * FIRST LAUNCH AFTER v4: the working slot may still be a v3
   * `default.project.chiphippo` pointing at app-kept desktop files. Inline it
   * into `default.chiphippo`, then — and only then — remove the v3 file and
   * the desktop files it alone pointed at. A desktop the user had saved
   * somewhere of their own is read and LEFT WHERE IT IS.
   *
   * The warnings come back rather than being written: they belong to this ONE
   * migration, and the upgraded file has nothing to say about a desktop whose
   * v3 path had already gone. Startup hands them to the renderer, which is the
   * only chance the user gets to be told.
   *
   * @returns {Array<string>|null} the migration's warnings (possibly empty),
   *   or null when there was nothing to upgrade.
   */
  upgradeLegacyDefault() {
    const legacy = this.legacyDefaultProjectPath;
    if (!existsSafe(legacy)) return null;
    const raw = io.readJSON(legacy);
    const meta = this.read(legacy);
    if (!meta) {
      unlinkSafe(legacy); // not a project at all; the slot is simply empty
      return null;
    }
    this.write(this.defaultProjectPath, meta);
    unlinkSafe(legacy);
    for (const tab of raw?.tabs ?? []) {
      const stored = typeof tab?.file === "string" ? tab.file : "";
      if (!stored) continue;
      const file =
        tab.defaultFile === true
          ? path.join(this._saves, path.basename(stored))
          : path.resolve(stored);
      // The location decides, exactly as it always did: inside the app's own
      // folder it was the app's to keep, and anywhere else it is the user's.
      if (this.isInsideSaves(file)) unlinkSafe(file);
    }
    return meta.warnings ?? [];
  }
}

/** A one-desktop project around a snapshot (a loose design opened as one). */
function projectOf(snapshot) {
  return {
    version: PROJECT_VERSION,
    name: snapshot.name,
    description: "",
    activeTab: "t1",
    nextIndex: 2,
    tabs: [
      {
        id: "t1",
        name: snapshot.name || "Desktop 1",
        ...(snapshot.description ? { description: snapshot.description } : {}),
        doc: snapshot.doc,
      },
    ],
  };
}

/** fs.existsSync that can never throw a load. */
function existsSafe(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** Delete a file; missing is not an error. Returns whether one went. */
function unlinkSafe(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    console.error("[store] project cleanup:", err && err.message);
    return false;
  }
}

module.exports = {
  ProjectStore,
  suggestFileName,
  nameFromFile,
  PROJECT_VERSION,
  PROJECT_EXT,
  DESKTOP_EXT,
  LEGACY_PROJECT_EXT,
  DEFAULT_PROJECT_FILE,
  SAVES_DIR,
};
