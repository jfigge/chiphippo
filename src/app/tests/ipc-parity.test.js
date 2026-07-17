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
 * tests/ipc-parity.test.js
 *
 * Guards the cardinal IPC rule (CLAUDE.md → keep main.js handlers and
 * preload.js in lockstep): every request/response channel registered with
 * `ipcMain.handle(...)` must have a matching `ipcRenderer.invoke(...)`
 * exposure in preload.js, and vice-versa. A rename on one side silently
 * breaks the feature with no runtime signal, so this static check fails the
 * build instead of shipping a dead channel.
 *
 * It also asserts every channel follows the documented naming convention:
 * colon-separated `area:noun[:verb]` segments, each lowercase and
 * hyphen-delimited (catches a camelCase / underscore regression).
 *
 * Pure text analysis — no Electron process is started. Ported from Port
 * Hippo (src/app/tests/ipc-parity.test.js).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const APP_DIR = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(APP_DIR, file), "utf8");

// Collect every channel string passed as the first argument to `fnPattern(...)`.
function channelsFor(source, fnPattern) {
  const re = new RegExp(`${fnPattern}\\(\\s*["']([^"']+)["']`, "g");
  const out = [];
  let match;
  while ((match = re.exec(source)) !== null) out.push(match[1]);
  return out;
}

// The main-process IPC surface currently lives entirely in main.js; when a
// stage splits handlers into ipc/*.js modules, add each new file here.
const mainProcessSource = ["main.js"].map(read).join("\n");

const handlers = channelsFor(mainProcessSource, "ipcMain\\.handle");
const invokes = channelsFor(read("preload.js"), "ipcRenderer\\.invoke");

// Channels whose value is ALSO exposed on the bridge synchronously (from the
// sandboxed preload's process shim), so they need no invoke: app:platform
// mirrors `window.chiphippo.platform`. The handler stays registered so the
// value remains reachable over IPC; exempt it from the orphan-handler check.
const SYNC_MIRRORED = new Set(["app:platform"]);

test("no IPC channel is handled more than once", () => {
  const seen = new Set();
  const dupes = [];
  for (const channel of handlers) {
    if (seen.has(channel)) dupes.push(channel);
    seen.add(channel);
  }
  assert.deepEqual(dupes, [], `duplicate ipcMain.handle channels: ${dupes}`);
});

test("every ipcMain.handle channel is invoked from preload, and vice-versa", () => {
  const handlerSet = new Set(handlers);
  const invokeSet = new Set(invokes);

  const orphanHandlers = [...handlerSet].filter(
    (c) => !invokeSet.has(c) && !SYNC_MIRRORED.has(c),
  );
  const orphanInvokes = [...invokeSet].filter((c) => !handlerSet.has(c));

  assert.deepEqual(
    orphanHandlers,
    [],
    `ipcMain.handle channels with no preload invoke: ${orphanHandlers.join(", ")}`,
  );
  assert.deepEqual(
    orphanInvokes,
    [],
    `preload invoke channels with no handler: ${orphanInvokes.join(", ")}`,
  );
});

test("every channel follows the area:noun:verb naming convention", () => {
  // Two or more colon-separated segments; each lowercase, starting with a
  // letter, hyphens only between alphanumerics (no camelCase, no underscore).
  const SEGMENT = "[a-z][a-z0-9]*(?:-[a-z0-9]+)*";
  const CONVENTION = new RegExp(`^${SEGMENT}(?::${SEGMENT})+$`);

  const offenders = [...new Set([...handlers, ...invokes])].filter(
    (channel) => !CONVENTION.test(channel),
  );
  assert.deepEqual(
    offenders,
    [],
    `channels off-convention (want lowercase, hyphenated, colon-separated): ${offenders.join(", ")}`,
  );
});
