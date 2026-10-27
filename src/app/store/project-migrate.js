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
 * A v3 tab's path is data from a FILE, and a file can be shared: so only a
 * regular file of desk-document size is ever read, and — unless the project
 * being upgraded is the app's own working slot — only one in the app's saves
 * folder or beside the project (its folder, or below). A path to a FIFO, a
 * device, a UNC share or anywhere else opens empty with a warning naming it,
 * as a missing file does: reading it could hang main, or hand the network a
 * Windows login.
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

/** The largest desktop file a v3 tab may inline — far past any real desk. */
const MAX_LEGACY_DESK_BYTES = 32 * 1024 * 1024;

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
 * @param {string} [opts.projectDir] - the folder of the project file being
 *   read; a desktop file there (or below) may be inlined. Omitted only for the
 *   app's own working slot, whose paths main itself wrote.
 * @returns {{tabs: Array<object>, warnings: Array<string>, inlined: Set<string>}}
 *   `inlined`: every desktop file whose document was READ into a tab — the
 *   only ones an upgrade may ever delete afterwards.
 */
function migrateLegacyTabs(raw, { deskStore, savesDir, projectDir = null }) {
  const tabs = [];
  const warnings = [];
  const inlined = new Set();
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
    // Where a shared project has no business sending main — asked BEFORE the
    // file is so much as looked for, since even that reaches a UNC share.
    // The user can still import it by hand (Desktop ▸ Import), knowing what
    // it is.
    const outside =
      projectDir != null &&
      !within(savesDir, file) &&
      !within(projectDir, file);
    if (outside) {
      warnings.push(`"${name}" opens empty — its file is not read: ${file}`);
      tabs.push(makeTab(id, name, tab.description, defaultDeskDocument()));
      continue;
    }
    // …and where it really is: a symlink beside the project (or a linked
    // folder on the way) is the same file as its target, so the target is
    // held to the same rule. Asked only once the path passed above, so it
    // reaches no further than looking for the file itself would.
    if (projectDir != null && !withinReal(savesDir, projectDir, file)) {
      warnings.push(`"${name}" opens empty — its file is not read: ${file}`);
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
    if (!isRegularDeskFile(file)) {
      // A FIFO, a device, a socket — or a file far past any desk's size.
      warnings.push(`"${name}" opens empty — its file is not read: ${file}`);
      tabs.push(makeTab(id, name, tab.description, defaultDeskDocument()));
      continue;
    }
    let doc;
    try {
      // A file the USER saved is never quarantined (renamed aside) for
      // failing to parse — it opens empty and stays where it is. An app-kept
      // one (`defaultFile`, in the saves folder) still is: the upgrade
      // deletes those afterwards, and the quarantined copy is all that
      // survives of a corrupt one. Either way the warning says so.
      doc = deskStore.readFile(file, {
        quarantine: tab.defaultFile === true,
        required: true,
      });
      inlined.add(path.resolve(file));
    } catch (err) {
      warnings.push(`"${name}" could not be read (${err.message}).`);
      doc = defaultDeskDocument();
    }
    tabs.push(makeTab(id, name, tab.description, doc));
  }
  return { tabs, warnings, inlined };
}

/** One v4 tab record, with the omit-when-empty description convention. */
function makeTab(id, name, description, doc) {
  const desc = text(description);
  return { id, name, ...(desc ? { description: desc } : {}), doc };
}

/** A regular file (no FIFO, socket or device, a symlink followed) no larger
    than any desk document. Never throws. */
function isRegularDeskFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && st.size <= MAX_LEGACY_DESK_BYTES;
  } catch {
    return false;
  }
}

/** Is `filePath` inside `dir` (or below it)? */
function within(dir, filePath) {
  if (!dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(filePath));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** fs.realpathSync, or null where there is no such path. Never throws. */
function realSafe(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

/** Is `filePath`, links followed, inside the real `savesDir` or the real
    `projectDir`? A path that does not exist is left to the caller's own
    "gone" answer (true here). */
function withinReal(savesDir, projectDir, filePath) {
  const real = realSafe(filePath);
  if (real == null) return true;
  const saves = savesDir ? (realSafe(savesDir) ?? savesDir) : null;
  const dir = realSafe(projectDir) ?? projectDir;
  return within(saves, real) || within(dir, real);
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
  MAX_LEGACY_DESK_BYTES,
  isProjectShape,
  isLegacyProject,
  migrateLegacyTabs,
};
