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
