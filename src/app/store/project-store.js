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
 * (Feature 240), so a reference design can be worked out beside the build and
 * pasted into it.
 *
 * EVERY DESKTOP IS THE SAME. There is no privileged "main" desk and no
 * lesser "sub-desktop": a project is simply N peers, any of which can be
 * renamed, worked on, or deleted. The ONE rule is that a project must keep at
 * least one — deleting the last desktop would leave a project with nothing to
 * open, so `removeTab` refuses it (v2; see `_normalize`).
 *
 * A project is an app-managed FOLDER, not a loose set of paths:
 *
 *     userData/projects/<slug>/project.json        the tab list (below)
 *     userData/projects/<slug>/desktop-1.chiphippo one document per tab
 *     userData/projects/<slug>/desktop-2.chiphippo
 *
 * A PROJECT IS NOT NAMED UNTIL IT IS SAVED. Adding a desktop must never stop
 * to ask for a name, so a project starts life UNTITLED in the one reserved
 * working folder — `userData/projects/__working/`, which is to a project
 * exactly what `desk.json` is to a schematic: the always-there working set,
 * not one of the user's saved things. `list()` never reports it, and
 * `saveAs(slug, name)` is the moment it becomes a real project: the name is
 * checked for uniqueness and the folder is MOVED to its slug, documents and
 * all. There is only ever one working project — starting another replaces it.
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
 *     { version, name, activeTab, nextIndex,
 *       tabs: [ { id, name, description?, file } ] }
 *
 * A tab's `description` is the second half of the Name/Description pair every
 * object in the app carries, and is optional in the same omit-when-empty way.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const io = require("./io");
const { defaultDeskDocument } = require("./migrations");

/**
 * Schema version of `project.json` (bump with a migration, as desk docs do).
 * v2 dropped the `kind: "main"|"sub"` split — see `_normalize`.
 */
const PROJECT_VERSION = 2;

/** The file every project's tab list lives in. */
const PROJECT_FILE = "project.json";

/** Extension of a tab's document — the same one a named schematic uses. */
const TAB_EXT = ".chiphippo";

/** How long a project name may be (a folder name has to stay sane). */
const MAX_NAME = 64;

/**
 * The one UNNAMED project's folder. An underscore never survives `slugify`,
 * so no name a user can type will ever resolve to this slug — the working
 * project can't be collided with, listed, or opened by name.
 */
const WORKING_SLUG = "__working";

/** What an unsaved project is called until the user names it. */
const WORKING_NAME = "Untitled";

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
    const known = slug === WORKING_SLUG || slug === slugify(slug);
    if (typeof slug !== "string" || !slug || !known) {
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
      // The working project is not one of the user's saved projects, any more
      // than desk.json is one of their files.
      if (entry.name === WORKING_SLUG) continue;
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
   * Start the UNTITLED working project — what New Project does, and what
   * adding a desktop with no project open does, WITHOUT stopping to ask for a
   * name.
   *
   * A NEW PROJECT IS ALWAYS EXACTLY ONE DESKTOP, whose document is `firstDoc`
   * (normally the desk the user is looking at right now, so this never
   * discards their work). There is no way to ask for more: a project grows
   * one desktop at a time through `addTab`, so "new" can only ever mean a
   * single desk, its numbering starting over at 1.
   *
   * There is exactly one working slot, so this REPLACES whatever was in it —
   * the same thing New does to `desk.json`. Callers guard the work first.
   *
   * @param {object|null} firstDoc - the document for that one desktop.
   * @returns {object} the project meta (as `load` returns it), `untitled` set.
   */
  createUntitled(firstDoc = null) {
    const dir = this._dirFor(WORKING_SLUG);
    fs.rmSync(dir, { recursive: true, force: true });
    io.ensureDir(dir);
    const meta = {
      version: PROJECT_VERSION,
      name: WORKING_NAME,
      untitled: true,
      activeTab: null,
      nextIndex: 1,
      tabs: [],
    };
    const only = this._appendTab(meta, dir, firstDoc ?? defaultDeskDocument());
    meta.activeTab = only.id;
    io.writeJSON(path.join(dir, PROJECT_FILE), meta);
    return { id: WORKING_SLUG, ...meta };
  }

  /**
   * NAME a project — the moment an untitled one becomes the user's, and the
   * only place a name is ever required. The whole folder MOVES to the new
   * slug (documents and all), so nothing is copied and nothing can be left
   * behind half-saved.
   *
   * Throws NAME_TAKEN when the name is already a saved project: the caller
   * asks for a different one rather than merging into it — there is work on
   * this desk that opening the other project would throw away.
   *
   * @param {string} slug - the project to name (normally the working one).
   * @param {string} name
   * @returns {object} the meta, under its NEW id.
   */
  saveAs(slug, name) {
    const clean = checkName(name);
    const target = slugify(clean);
    const from = this._dirFor(slug);
    const to = this._dirFor(target);
    const meta = this._readMeta(from);
    if (!meta) throw taggedError(`no project ${slug}`, "NOT_FOUND");
    // A project keeping its own slug (a case-only rename) is not a collision.
    if (from !== to && this.exists(clean)) {
      throw taggedError(`a project named "${clean}" already exists`, "NAME_TAKEN"); // prettier-ignore
    }
    if (from !== to) fs.renameSync(from, to);
    delete meta.untitled;
    meta.name = clean;
    io.writeJSON(path.join(to, PROJECT_FILE), meta);
    return { id: target, ...meta };
  }

  /**
   * Append one desktop to `meta` (in memory) and write its document.
   * The visible number comes from `nextIndex`, which only ever counts up —
   * deleting "Desktop 2" never makes the next one Desktop 2 again, so a name
   * in a note or a screenshot keeps meaning the same desk. It is also stepped
   * past anything already taken, so a project carried forward from v1 (whose
   * ids and files were spelled differently) can never collide with one.
   */
  _appendTab(meta, dir, doc = defaultDeskDocument()) {
    const ids = new Set(meta.tabs.map((t) => t.id));
    const files = new Set(meta.tabs.map((t) => t.file));
    let index = meta.nextIndex;
    while (ids.has(`t${index}`) || files.has(`desktop-${index}${TAB_EXT}`)) {
      index += 1;
    }
    meta.nextIndex = index + 1;
    const tab = {
      id: `t${index}`,
      name: `Desktop ${index}`,
      file: `desktop-${index}${TAB_EXT}`,
    };
    meta.tabs.push(tab);
    // A real empty desk document, not `{}` — the file a new desktop starts
    // from should read back as exactly what the renderer will show.
    this._desk.writeFile(path.join(dir, tab.file), doc);
    return tab;
  }

  /**
   * Bring a stored project forward to the current shape (v1 → v2), in memory:
   * the next write puts it on disk. v1 gave one tab a privileged
   * `kind: "main"` that could never be deleted and numbered the rest as
   * sub-desktops; every desktop is now a peer, so the kinds go and the
   * counter is whatever `nextSubIndex` had reached.
   *
   * NAMES AND FILES ARE LEFT ALONE. They are the user's — a project whose
   * first tab reads `Main` keeps reading `Main` (and can now be renamed, or
   * deleted, like any other) rather than being silently re-labelled.
   */
  _normalize(meta) {
    if (!meta || !Array.isArray(meta.tabs) || meta.tabs.length === 0) {
      return null;
    }
    const { nextSubIndex, ...rest } = meta;
    return {
      ...rest,
      version: PROJECT_VERSION,
      nextIndex: Number.isInteger(meta.nextIndex)
        ? meta.nextIndex
        : Number.isInteger(nextSubIndex)
          ? nextSubIndex
          : meta.tabs.length + 1,
      tabs: meta.tabs.map(({ kind, ...tab }) => tab),
    };
  }

  /** Read + normalize a project's own file. Null when it isn't one. */
  _readMeta(dir) {
    return this._normalize(io.readJSON(path.join(dir, PROJECT_FILE)));
  }

  /**
   * Load a project's tab list. Returns null when there is no such project —
   * the renderer treats that as "no project active" rather than an error, so a
   * project deleted outside the app just drops the session back to the plain
   * working desk.
   */
  load(slug) {
    const meta = this._readMeta(this._dirFor(slug));
    return meta ? { id: slug, ...meta } : null;
  }

  /**
   * Persist the tab list — the "automatically saved when changes happen" half
   * of a project. Only the fields this module owns are written, so a renderer
   * patch can never smuggle a path in: tab `file` names are re-derived from
   * what is already on disk, never taken from the caller. A tab's editable
   * fields are exactly its `name` and `description`.
   */
  saveMeta(slug, meta) {
    const dir = this._dirFor(slug);
    const current = this._readMeta(dir);
    if (!current) throw taggedError(`no project ${slug}`, "NOT_FOUND");
    const known = new Map((current.tabs ?? []).map((t) => [t.id, t]));
    const tabs = [];
    for (const tab of meta?.tabs ?? []) {
      const existing = known.get(tab?.id);
      if (!existing) continue; // a tab this store never minted
      const next = {
        ...existing,
        name:
          typeof tab.name === "string" && tab.name.trim()
            ? tab.name.trim()
            : existing.name,
      };
      // The description is optional and omit-when-empty (the convention the
      // desk document's own Name/Description pair follows): an empty string
      // CLEARS it, an absent key leaves whatever is stored.
      if (typeof tab.description === "string") {
        const text = tab.description.trim();
        if (text) next.description = text;
        else delete next.description;
      }
      tabs.push(next);
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

  /** Add one desktop; returns the updated meta (with the new tab last). */
  addTab(slug) {
    const dir = this._dirFor(slug);
    const meta = this._readMeta(dir);
    if (!meta) throw taggedError(`no project ${slug}`, "NOT_FOUND");
    const tab = this._appendTab(meta, dir);
    meta.activeTab = tab.id;
    io.writeJSON(path.join(dir, PROJECT_FILE), meta);
    return { id: slug, ...meta };
  }

  /**
   * Remove a desktop and its document. ANY desktop can go — they are peers —
   * except the LAST one: a project with no desktops has nothing to open.
   * Throws NOT_FOUND / INVALID_ARG.
   */
  removeTab(slug, tabId) {
    const dir = this._dirFor(slug);
    const meta = this._readMeta(dir);
    if (!meta) throw taggedError(`no project ${slug}`, "NOT_FOUND");
    const tab = meta.tabs.find((t) => t.id === tabId);
    if (!tab) throw taggedError(`no tab ${tabId}`, "NOT_FOUND");
    if (meta.tabs.length <= 1) {
      throw taggedError("a project needs at least one desktop", "INVALID_ARG");
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

module.exports = {
  ProjectStore,
  slugify,
  PROJECT_VERSION,
  PROJECT_FILE,
  WORKING_SLUG,
  WORKING_NAME,
};
