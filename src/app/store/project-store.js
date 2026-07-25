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
 * project-store.js — projects: a NAMED workspace of several desktops
 * (Feature 240). The main desk is one tab; each sub-desktop is another, so a
 * reference design can be worked out beside the build and pasted into it.
 *
 * A project is an app-managed FOLDER, not a loose set of paths:
 *
 *     userData/projects/<slug>/project.json     the tab list (below)
 *     userData/projects/<slug>/main.chiphippo   one document per tab
 *     userData/projects/<slug>/sub-1.chiphippo
 *
 * The NAME is the identity — "must not match an existing saved project" only
 * means something against a directory the app owns, which is exactly why
 * projects live here rather than wherever the user points a dialog. The
 * renderer names a project (and a tab id); this module alone turns that into a
 * path, and every resolved path is checked to still be inside the projects
 * root — the same discipline mem-store.js applies to a GUID.
 *
 * Tab documents are the ordinary `.chiphippo` JSON, read and written through
 * DeskStore, so a tab file opens as a normal schematic and a normal schematic
 * loads into a tab. The tab LIST is this module's own small file:
 *
 *     { version, name, activeTab, nextSubIndex,
 *       tabs: [ { id, name, kind: "main"|"sub", file } ] }
 */
"use strict";

const fs = require("fs");
const path = require("path");
const io = require("./io");
const { defaultDeskDocument } = require("./migrations");

/** Schema version of `project.json` (bump with a migration, as desk docs do). */
const PROJECT_VERSION = 1;

/** The file every project's tab list lives in. */
const PROJECT_FILE = "project.json";

/** Extension of a tab's document — the same one a named schematic uses. */
const TAB_EXT = ".chiphippo";

/** How long a project name may be (a folder name has to stay sane). */
const MAX_NAME = 64;

function taggedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * A project name reduced to a safe folder name: lowercase, spaces and
 * punctuation collapsed to single hyphens. Two names that differ only in case
 * or spacing collide deliberately — "6502 SBC" and "6502-sbc" are one project
 * as far as a user is concerned, and the uniqueness check should say so.
 */
function slugify(name) {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME);
}

/** Validate a user-supplied project name. Throws INVALID_ARG. */
function checkName(name) {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean) throw taggedError("a project needs a name", "INVALID_ARG");
  if (clean.length > MAX_NAME) {
    throw taggedError(`project name is too long: ${clean}`, "INVALID_ARG");
  }
  if (!slugify(clean)) {
    // Punctuation-only ("***") slugs to nothing — there is no folder to make.
    throw taggedError(`project name must have letters or digits: ${clean}`, "INVALID_ARG"); // prettier-ignore
  }
  return clean;
}

class ProjectStore {
  /**
   * @param {string} dataDir - the app's userData directory.
   * @param {{readFile: Function, writeFile: Function}} deskStore - reads and
   *   writes a tab's `.chiphippo` (migrations included), so this module never
   *   parses a desk document itself.
   */
  constructor(dataDir, deskStore) {
    this._root = path.join(dataDir, "projects");
    this._desk = deskStore;
  }

  /** The projects root (exposed for logging/tests). */
  get root() {
    return this._root;
  }

  /**
   * Resolve a slug to its project folder, refusing anything that would escape
   * the projects root ("..", an absolute path, a separator). Main is the only
   * place a name becomes a path, so this is the one gate that has to hold.
   */
  _dirFor(slug) {
    if (typeof slug !== "string" || !slug || slug !== slugify(slug)) {
      throw taggedError(`bad project id: ${slug}`, "INVALID_ARG");
    }
    const dir = path.resolve(this._root, slug);
    const inside =
      dir.startsWith(path.resolve(this._root) + path.sep) &&
      path.dirname(dir) === path.resolve(this._root);
    if (!inside) throw taggedError(`bad project id: ${slug}`, "INVALID_ARG");
    return dir;
  }

  /**
   * Resolve a tab's document path. A tab `file` is minted by this module (never
   * by the renderer), but it arrives back over IPC, so it is re-checked: a bare
   * `.chiphippo` file name directly inside the project folder.
   */
  _tabPath(slug, file) {
    const dir = this._dirFor(slug);
    if (
      typeof file !== "string" ||
      !file.endsWith(TAB_EXT) ||
      path.basename(file) !== file
    ) {
      throw taggedError(`bad tab file: ${file}`, "INVALID_ARG");
    }
    return path.join(dir, file);
  }

  /**
   * Every saved project as `{ id, name, tabs }`, newest-modified first — what
   * the "Load project" picker lists, and what the uniqueness check reads.
   */
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this._root, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return []; // no projects yet
      throw err;
    }
    const out = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = io.readJSON(path.join(this._root, entry.name, PROJECT_FILE));
      if (!meta) continue; // not a project folder (or a corrupt file, quarantined)
      out.push({
        id: entry.name,
        name: typeof meta.name === "string" ? meta.name : entry.name,
        tabs: Array.isArray(meta.tabs) ? meta.tabs.length : 0,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Does a project with this NAME already exist? (the uniqueness rule) */
  exists(name) {
    const slug = slugify(name);
    return slug ? fs.existsSync(path.join(this._root, slug, PROJECT_FILE)) : false; // prettier-ignore
  }

  /**
   * Create a project. The Main tab adopts `mainDoc` — the desk the user is
   * looking at right now, so making a project never discards their work — and
   * `subCount` sub-desktops start empty.
   *
   * Throws NAME_TAKEN when the name is already a saved project: the caller
   * offers to load that one instead rather than silently merging into it.
   *
   * @param {string} name
   * @param {object|null} mainDoc - the document for the Main tab.
   * @param {{subCount?: number}} [opts]
   * @returns {object} the project meta (as `load` returns it).
   */
  create(name, mainDoc = null, { subCount = 1 } = {}) {
    const clean = checkName(name);
    const slug = slugify(clean);
    if (this.exists(clean)) {
      throw taggedError(`a project named "${clean}" already exists`, "NAME_TAKEN"); // prettier-ignore
    }
    const dir = this._dirFor(slug);
    io.ensureDir(dir);
    const meta = {
      version: PROJECT_VERSION,
      name: clean,
      activeTab: "t1",
      nextSubIndex: 1,
      tabs: [{ id: "t1", name: "Main", kind: "main", file: `main${TAB_EXT}` }],
    };
    this._desk.writeFile(
      path.join(dir, `main${TAB_EXT}`),
      mainDoc ?? defaultDeskDocument(),
    );
    for (let i = 0; i < Math.max(0, subCount); i += 1)
      this._appendSub(meta, dir);
    io.writeJSON(path.join(dir, PROJECT_FILE), meta);
    return { id: slug, ...meta };
  }

  /**
   * Append one sub-desktop to `meta` (in memory) and write its empty document.
   * The visible number comes from `nextSubIndex`, which only ever counts up —
   * deleting "Sub-Desktop #2" never makes the next one #2 again, so a name in a
   * note or a screenshot keeps meaning the same desk.
   */
  _appendSub(meta, dir) {
    const index = meta.nextSubIndex;
    meta.nextSubIndex = index + 1;
    const tab = {
      id: `t${meta.tabs.length + 1}-${index}`,
      name: `Sub-Desktop #${index}`,
      kind: "sub",
      file: `sub-${index}${TAB_EXT}`,
    };
    meta.tabs.push(tab);
    // A real empty desk document, not `{}` — the file a new desktop starts
    // from should read back as exactly what the renderer will show.
    this._desk.writeFile(path.join(dir, tab.file), defaultDeskDocument());
    return tab;
  }

  /**
   * Load a project's tab list. Returns null when there is no such project —
   * the renderer treats that as "no project active" rather than an error, so a
   * project deleted outside the app just drops the session back to the plain
   * working desk.
   */
  load(slug) {
    const dir = this._dirFor(slug);
    const meta = io.readJSON(path.join(dir, PROJECT_FILE));
    if (!meta || !Array.isArray(meta.tabs) || meta.tabs.length === 0) {
      return null;
    }
    return { id: slug, ...meta };
  }

  /**
   * Persist the tab list — the "automatically saved when changes happen" half
   * of a project. Only the fields this module owns are written, so a renderer
   * patch can never smuggle a path in: tab `file` names are re-derived from
   * what is already on disk, never taken from the caller.
   */
  saveMeta(slug, meta) {
    const dir = this._dirFor(slug);
    const current = io.readJSON(path.join(dir, PROJECT_FILE));
    if (!current) throw taggedError(`no project ${slug}`, "NOT_FOUND");
    const known = new Map((current.tabs ?? []).map((t) => [t.id, t]));
    const tabs = [];
    for (const tab of meta?.tabs ?? []) {
      const existing = known.get(tab?.id);
      if (!existing) continue; // a tab this store never minted
      tabs.push({
        ...existing,
        name:
          typeof tab.name === "string" && tab.name.trim()
            ? tab.name.trim()
            : existing.name,
      });
    }
    if (tabs.length === 0) throw taggedError("a project needs a tab", "INVALID_ARG"); // prettier-ignore
    const next = {
      ...current,
      name: typeof meta?.name === "string" && meta.name.trim() ? meta.name.trim() : current.name, // prettier-ignore
      activeTab: tabs.some((t) => t.id === meta?.activeTab)
        ? meta.activeTab
        : tabs[0].id,
      tabs,
    };
    io.writeJSON(path.join(dir, PROJECT_FILE), next);
    return { id: slug, ...next };
  }

  /** Add one sub-desktop; returns the updated meta (with the new tab last). */
  addTab(slug) {
    const dir = this._dirFor(slug);
    const meta = io.readJSON(path.join(dir, PROJECT_FILE));
    if (!meta) throw taggedError(`no project ${slug}`, "NOT_FOUND");
    const tab = this._appendSub(meta, dir);
    meta.activeTab = tab.id;
    io.writeJSON(path.join(dir, PROJECT_FILE), meta);
    return { id: slug, ...meta };
  }

  /**
   * Remove a sub-desktop and its document. The MAIN tab can never be removed —
   * it is the project. Throws NOT_FOUND / INVALID_ARG.
   */
  removeTab(slug, tabId) {
    const dir = this._dirFor(slug);
    const meta = io.readJSON(path.join(dir, PROJECT_FILE));
    if (!meta) throw taggedError(`no project ${slug}`, "NOT_FOUND");
    const tab = (meta.tabs ?? []).find((t) => t.id === tabId);
    if (!tab) throw taggedError(`no tab ${tabId}`, "NOT_FOUND");
    if (tab.kind === "main") {
      throw taggedError("the main desktop cannot be removed", "INVALID_ARG");
    }
    meta.tabs = meta.tabs.filter((t) => t.id !== tabId);
    if (meta.activeTab === tabId) meta.activeTab = meta.tabs[0].id;
    io.writeJSON(path.join(dir, PROJECT_FILE), meta);
    try {
      fs.unlinkSync(this._tabPath(slug, tab.file));
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // already gone is fine
    }
    return { id: slug, ...meta };
  }

  /** Read a tab's document (migrated); an empty desk when it's missing. */
  readTab(slug, file) {
    return this._desk.readFile(this._tabPath(slug, file));
  }

  /** Write a tab's document. Returns the path written (for logging). */
  writeTab(slug, file, doc) {
    return this._desk.writeFile(this._tabPath(slug, file), doc);
  }
}

module.exports = { ProjectStore, slugify, PROJECT_VERSION, PROJECT_FILE };
