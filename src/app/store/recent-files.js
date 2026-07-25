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
 * recent-files.js — the pure list arithmetic behind the "Open Recent" menu:
 * the last MAX_RECENT schematic files the user opened or saved, most recent
 * first. No filesystem, no Electron — main.js owns reading/writing the list
 * (it lives in settings.json as `recentFiles`) and the existence checks; this
 * module only decides what the list becomes.
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
