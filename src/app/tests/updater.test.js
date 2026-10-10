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

// The updater's two pieces of bookkeeping, with Electron and electron-updater
// stood in for (Module._load): which install attempt a failure belongs to,
// and whether a check's answer is a MANUAL one.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const app = Object.assign(new EventEmitter(), { isPackaged: true });
const autoUpdater = Object.assign(new EventEmitter(), {
  installs: 0,
  checks: [],
  quitAndInstall() {
    this.installs += 1;
  },
  checkForUpdates() {
    return new Promise((resolve) => this.checks.push(resolve));
  },
});
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return { app };
  if (request === "electron-updater") return { autoUpdater };
  return realLoad.call(this, request, ...rest);
};
const updater = require("../updater");
const pushed = [];
updater.initUpdater(() => ({
  isDestroyed: () => false,
  webContents: { send: (channel, payload) => pushed.push({ channel, payload }) }, // prettier-ignore
}));
test.after(() => {
  Module._load = realLoad;
});

test("an install that errors withdraws its go — once, and only its own", () => {
  let failed = 0;
  updater.quitAndInstall(() => failed++);
  autoUpdater.emit("error", new Error("signature"));
  autoUpdater.emit("error", new Error("again"));
  assert.equal(failed, 1, "told once");
  assert.equal(autoUpdater.listenerCount("error"), 1, "only initUpdater's own listener left"); // prettier-ignore
});

test("a later check's error is never blamed on an install that quit or moved on", () => {
  let failed = 0;
  updater.quitAndInstall(() => failed++);
  autoUpdater.emit("checking-for-update"); // a new check: the attempt is over
  autoUpdater.emit("error", new Error("offline"));
  assert.equal(failed, 0);
  updater.quitAndInstall(() => failed++);
  app.emit("before-quit"); // it quit
  autoUpdater.emit("error", new Error("late"));
  assert.equal(failed, 0);
});

test("a second Restart replaces the first attempt rather than stacking", () => {
  let first = 0;
  let second = 0;
  updater.quitAndInstall(() => first++);
  updater.quitAndInstall(() => second++);
  autoUpdater.emit("error", new Error("refused"));
  assert.deepEqual([first, second], [0, 1]);
  assert.equal(autoUpdater.listenerCount("error"), 1);
});

test("an install that neither quits nor errors is given up on at its deadline", async () => {
  let failed = 0;
  updater.quitAndInstall(() => failed++, { deadlineMs: 5 }); // Squirrel, silent
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(failed, 1);
  assert.equal(autoUpdater.listenerCount("error"), 1, "its listener is gone");
  // …while one that quit in time is never blamed.
  updater.quitAndInstall(() => failed++, { deadlineMs: 5 });
  app.emit("before-quit");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(failed, 1);
});

test("a manual check folded into a running startup one is answered as manual", async () => {
  pushed.length = 0;
  updater.checkForUpdates({ manual: false }); // the delayed startup check
  updater.checkForUpdates({ manual: true }); // the user, meanwhile
  autoUpdater.emit("update-not-available");
  assert.equal(
    pushed.at(-1).payload.manual,
    true,
    "the user's ask is answered",
  );
  autoUpdater.checks.splice(0).forEach((resolve) => resolve());
  await new Promise((r) => setImmediate(r));
  // The next check starts from its own ask.
  updater.checkForUpdates({ manual: false });
  autoUpdater.emit("update-not-available");
  assert.equal(pushed.at(-1).payload.manual, false);
  autoUpdater.checks.splice(0).forEach((resolve) => resolve());
});
