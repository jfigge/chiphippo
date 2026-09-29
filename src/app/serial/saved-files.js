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
 * saved-files.js — where Generate's Save As… last put each file, so the next
 * Save As of that file opens there. Pure: the `settings.codegenSaves` value
 * in, a new one out; ipc/serial.js reads and writes it.
 *
 * Keyed CONNECTION → SCOPE → FILE NAME → path. The connection is the board.
 * The SCOPE is the design the file was generated from — an opaque string the
 * renderer builds from the project's path and the desktop's id — because one
 * board serves many designs (a sketch folder per circuit), and a default
 * carried from one design to another is an invitation to click Replace over
 * the wrong one's file. The renderer names the scope and never the path:
 * every path in here is one a Save panel returned.
 *
 * Kept only for connections that exist (ipc/serial.js prunes it whenever the
 * connection list is written), and each connection keeps the MAX_SCOPES
 * designs it saved for most recently — an object's keys keep insertion
 * order, so re-inserting a scope on every save is what makes the order
 * recency.
 */
"use strict";

const MAX_SCOPES = 20;

const isRecord = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** The stored value, or an empty one for anything that isn't a record. */
function savesOf(all) {
  return isRecord(all) ? all : {};
}

/** The path `name` was last saved to for this connection and design, or null. */
function savedPath(all, id, scope, name) {
  const p = savesOf(all)[id]?.[scope]?.[name];
  return typeof p === "string" && p ? p : null;
}

/** `all` with `filePath` recorded as where `name` was just saved. */
function rememberSaved(all, id, scope, name, filePath) {
  const saves = savesOf(all);
  const scopes = isRecord(saves[id]) ? { ...saves[id] } : {};
  const files = isRecord(scopes[scope]) ? scopes[scope] : {};
  delete scopes[scope]; // re-inserted last: the most recent
  scopes[scope] = { ...files, [name]: filePath };
  const keys = Object.keys(scopes);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_SCOPES))) {
    delete scopes[old];
  }
  return { ...saves, [id]: scopes };
}

/** `all` without the connections `isLive` no longer knows. */
function forgetDeleted(all, isLive) {
  return Object.fromEntries(
    Object.entries(savesOf(all)).filter(([id]) => isLive(id)),
  );
}

module.exports = { MAX_SCOPES, savedPath, rememberSaved, forgetDeleted };
