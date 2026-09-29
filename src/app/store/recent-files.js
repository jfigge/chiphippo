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
 * recent-files.js — the pure list arithmetic behind the "Open Recent" menu:
 * the last MAX_RECENT PROJECT files the user opened or saved, most recent
 * first. No filesystem, no Electron — main.js owns reading/writing the list
 * (it lives in settings.json as `recentProjects`) and the existence checks;
 * this module only decides what the list becomes.
 *
 * Every function returns a NEW array and never mutates its input, so the
 * frozen DEFAULTS array in settings-store.js is safe to pass in.
 */
"use strict";

/** How many files the Open Recent menu remembers. */
const MAX_RECENT = 10;

/** Drop anything that isn't a non-empty string, and de-duplicate. */
function sanitizeRecent(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry) continue;
    if (!out.includes(entry)) out.push(entry);
  }
  return out.slice(0, MAX_RECENT);
}

/**
 * `filePath` becomes the most recent entry: a path already in the list moves
 * to the front rather than being duplicated, and the list is capped at
 * MAX_RECENT. A junk path leaves the list alone (sanitized).
 * @param {Array<string>} list
 * @param {string} filePath
 * @returns {Array<string>}
 */
function rememberRecent(list, filePath) {
  const clean = sanitizeRecent(list);
  if (typeof filePath !== "string" || !filePath) return clean;
  return [filePath, ...clean.filter((p) => p !== filePath)].slice(
    0,
    MAX_RECENT,
  );
}

/**
 * Drop `filePath` from the list (the × on a menu entry, or the "that file is
 * gone — remove it?" prompt). Unknown paths are a no-op.
 * @param {Array<string>} list
 * @param {string} filePath
 * @returns {Array<string>}
 */
function forgetRecent(list, filePath) {
  return sanitizeRecent(list).filter((p) => p !== filePath);
}

module.exports = { MAX_RECENT, sanitizeRecent, rememberRecent, forgetRecent };
