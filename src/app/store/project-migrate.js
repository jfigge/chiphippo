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
 * project-migrate.js — bringing an OLD project forward to the one-file shape.
 *
 * Up to v3 a project file was a list of PATHS: one `.desktop.chiphippo` per
 * tab, anywhere on disk, plus a `defaultFile` flag for the ones the app was
 * keeping in its own saves folder. v4 inlines every one of those documents,
 * so a project is a single file (see project-store.js). This module is the
 * one-way bridge between the two.
 *
 * It is deliberately NON-DESTRUCTIVE. A desktop file the user saved somewhere
 * of their own is READ and left exactly where it is — orphaned afterwards,
 * but theirs. Only the caller (`bootProject`, upgrading the app's own working
 * slot in place) removes anything, and only the app-kept files this reports.
 *
 * A tab whose file has gone — the dangling absolute path v4 exists to abolish,
 * and the reason a v3 project could never be shared — opens as an EMPTY
 * desktop plus a warning naming the file, rather than failing the whole load.
 *
 * It also handles the other legacy shape: a bare desk document (a loose
 * `.chiphippo` design, or a `.desktop.chiphippo` export) opened as a project.
 * That becomes a project of exactly one desktop — the same answer Import
 * gives, and the compatibility story for anyone holding loose files.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const { defaultDeskDocument } = require("./migrations");

/** Trim a user-supplied string field, or "" for anything that isn't one. */
function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Does this parsed JSON look like a PROJECT file (v3 or v4), as against a
 * desk document? A project is the only shape with a `tabs` array.
 */
function isProjectShape(raw) {
  return !!raw && typeof raw === "object" && Array.isArray(raw.tabs);
}

/**
 * Is this a v3 project? The structural tell is a tab that names a FILE instead
 * of carrying a document — not merely a tab with no `doc`, which in a v4 file
 * is simply a broken entry for `_normalize` to drop.
 */
function isLegacyProject(raw) {
  return (
    isProjectShape(raw) &&
    raw.tabs.some(
      (tab) =>
        tab &&
        typeof tab === "object" &&
        !tab.doc &&
        typeof tab.file === "string" &&
        tab.file,
    )
  );
}

/**
 * Inline a v3 project's desktop files, producing v4 tabs.
 *
 * @param {object} raw - the parsed v3 project file.
 * @param {object} opts
 * @param {{readFile: Function}} opts.deskStore - reads a desktop document
 *   (schema migrations included), so this module never parses one itself.
 * @param {string} opts.savesDir - this machine's app saves folder; an app-kept
 *   desktop's stored path is rebased onto it, exactly as v3's reader did, so a
 *   project file that travelled still finds the files the app was keeping.
 * @returns {{tabs: Array<object>, warnings: Array<string>,
 *   appKeptFiles: Array<string>}}
 */
function migrateLegacyTabs(raw, { deskStore, savesDir }) {
  const tabs = [];
  const warnings = [];
  const appKeptFiles = [];
  for (const tab of raw?.tabs ?? []) {
    if (!tab || typeof tab !== "object") continue;
    const id = text(tab.id);
    if (!id) continue;
    const name = text(tab.name) || id;
    // A v4 tab may already be sitting in a part-migrated file; keep its doc.
    if (tab.doc && typeof tab.doc === "object") {
      tabs.push(makeTab(id, name, tab.description, tab.doc));
      continue;
    }
    const stored = text(tab.file);
    const file =
      tab.defaultFile === true && stored
        ? path.join(savesDir, path.basename(stored))
        : stored && path.resolve(stored);
    if (!file) {
      warnings.push(`"${name}" named no file and opens empty.`);
      tabs.push(makeTab(id, name, tab.description, defaultDeskDocument()));
      continue;
    }
    if (!existsSafe(file)) {
      // The dangling path. Say WHICH file, because the user may still have it
      // somewhere and can import it back into the project by hand.
      warnings.push(`"${name}" opens empty — its file is gone: ${file}`);
      tabs.push(makeTab(id, name, tab.description, defaultDeskDocument()));
      continue;
    }
    let doc;
    try {
      doc = deskStore.readFile(file);
    } catch (err) {
      warnings.push(`"${name}" could not be read (${err.message}).`);
      doc = defaultDeskDocument();
    }
    if (isInside(file, savesDir)) appKeptFiles.push(file);
    tabs.push(makeTab(id, name, tab.description, doc));
  }
  return { tabs, warnings, appKeptFiles };
}

/** One v4 tab record, with the omit-when-empty description convention. */
function makeTab(id, name, description, doc) {
  const desc = text(description);
  return { id, name, ...(desc ? { description: desc } : {}), doc };
}

/** Is `filePath` inside `dir`? (the app-kept test, path-only) */
function isInside(filePath, dir) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** fs.existsSync that can never throw the load. */
function existsSafe(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

module.exports = {
  isProjectShape,
  isLegacyProject,
  migrateLegacyTabs,
};
