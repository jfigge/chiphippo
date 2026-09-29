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

// file-base.js — the file NAME an export is written under, from a desktop's
// name. Main re-checks every name against the same shape
// (app/ipc/export.js's FILE_BASE) before writing anything, so the two sides
// must agree on it: word characters, spaces, dots and hyphens, starting with
// a word character, at most 60 characters.

/**
 * @param {string} name - the desktop's name.
 * @returns {string} a safe base name, never empty.
 */
export function safeFileBase(name) {
  const text = String(name ?? "")
    .replace(/[^\w .-]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[. -]+/, "")
    .slice(0, 60)
    .trim();
  return text || "chiphippo";
}
