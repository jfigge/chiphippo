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
// Electron's own native autoUpdater — Squirrel, on macOS.
const native = new EventEmitter();
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return { app, autoUpdater: native };
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

/** A macOS attempt while Squirrel does (not) have the update yet. */
const squirrel = (has) => {
  autoUpdater.squirrelDownloadedUpdate = has;
};
test.afterEach(() => {
  delete autoUpdater.squirrelDownloadedUpdate; // an updater without the flag
});

test("macOS: an attempt given up on before Squirrel has the update leaves nothing armed", async () => {
  squirrel(false);
  let failed = 0;
  const installs = autoUpdater.installs;
  const waiting = native.listenerCount("update-downloaded");
  updater.quitAndInstall(() => failed++, { deadlineMs: 5, platform: "darwin" });
  assert.equal(autoUpdater.installs, installs, "not asked before Squirrel is ready"); // prettier-ignore
  assert.equal(native.listenerCount("update-downloaded"), waiting + 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(failed, 1, "given up on");
  assert.equal(native.listenerCount("update-downloaded"), waiting, "its wait taken back"); // prettier-ignore
  native.emit("update-downloaded"); // Squirrel, minutes later
  assert.equal(autoUpdater.installs, installs, "and no restart nobody asked for"); // prettier-ignore
});

test("macOS: an attempt still waiting when Squirrel is ready installs then", () => {
  squirrel(false);
  let failed = 0;
  const installs = autoUpdater.installs;
  updater.quitAndInstall(() => failed++, { deadlineMs: 1000, platform: "darwin" }); // prettier-ignore
  native.emit("update-downloaded");
  assert.equal(autoUpdater.installs, installs + 1);
  app.emit("before-quit");
  assert.equal(failed, 0);
});

test("macOS: a check started during the wait for Squirrel fails the attempt, out loud", () => {
  squirrel(false);
  let failed = 0;
  const installs = autoUpdater.installs;
  const waiting = native.listenerCount("update-downloaded");
  updater.quitAndInstall(() => failed++, { deadlineMs: 1000, platform: "darwin" }); // prettier-ignore
  autoUpdater.emit("checking-for-update"); // Help ▸ Check for Updates, meanwhile
  assert.equal(failed, 1, "the close guard's go is withdrawn");
  assert.equal(native.listenerCount("update-downloaded"), waiting, "the wait taken back"); // prettier-ignore
  native.emit("update-downloaded");
  assert.equal(autoUpdater.installs, installs, "and nothing installs later");
});

test("macOS: with the update already Squirrel's, Restart installs at once", () => {
  squirrel(true);
  const installs = autoUpdater.installs;
  const waiting = native.listenerCount("update-downloaded");
  updater.quitAndInstall(() => {}, { platform: "darwin" });
  assert.equal(autoUpdater.installs, installs + 1);
  assert.equal(native.listenerCount("update-downloaded"), waiting, "no wait of ours"); // prettier-ignore
  app.emit("before-quit");
});

test("Restart waits for Squirrel BEFORE anything is asked: ready at once off macOS or once it has the update", async () => {
  let waited = 0;
  const onWait = () => waited++;
  assert.equal(await updater.readyToInstall({ platform: "linux", onWait }), true); // prettier-ignore
  squirrel(true);
  assert.equal(await updater.readyToInstall({ platform: "darwin", onWait }), true); // prettier-ignore
  assert.equal(waited, 0, "nothing to wait for");
  squirrel(false);
  const listening = native.listenerCount("update-downloaded");
  const first = updater.readyToInstall({ platform: "darwin", onWait });
  const second = updater.readyToInstall({ platform: "darwin", onWait }); // a second Restart
  assert.equal(native.listenerCount("update-downloaded"), listening + 1, "one wait, joined"); // prettier-ignore
  assert.equal(waited, 2, "each press is told why nothing happens yet");
  native.emit("update-downloaded");
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(native.listenerCount("update-downloaded"), listening, "taken back"); // prettier-ignore
});

test("a wait for Squirrel that runs out, or an install error meanwhile, is a no — and leaves nothing armed", async () => {
  autoUpdater.emit("update-downloaded", { version: "9.9.9" }); // fresh
  squirrel(false);
  const listening = native.listenerCount("update-downloaded");
  const erroring = autoUpdater.listenerCount("error");
  assert.equal(await updater.readyToInstall({ platform: "darwin", waitMs: 5 }), false); // prettier-ignore
  assert.equal(native.listenerCount("update-downloaded"), listening);
  assert.equal(updater.installBlocked(), true, "running out counts: waiting again would run out again"); // prettier-ignore
  // Squirrel refuses the download: said at once, not at the deadline — and
  // as an install's failure, never a "check failed" (no check is running).
  autoUpdater.emit("update-downloaded", { version: "9.9.9" });
  assert.equal(updater.installBlocked(), false, "a new download clears it");
  pushed.length = 0;
  const refused = updater.readyToInstall({ platform: "darwin", waitMs: 60_000 }); // prettier-ignore
  autoUpdater.emit("error", new Error("code signature"));
  assert.equal(await refused, false);
  assert.equal(native.listenerCount("update-downloaded"), listening);
  assert.equal(autoUpdater.listenerCount("error"), erroring, "taken back");
  assert.deepEqual(pushed.map((p) => [p.channel, p.payload.manual]), [["updater:error", false]]); // prettier-ignore
  await blockedUntilFetchedAgain();
});

/** After Squirrel failed the download, Restart answers no AT ONCE — no wait,
    no check of its own (whose progress would talk over the wait) — until a
    new download (Check for Updates) gives Squirrel another to take. */
async function blockedUntilFetchedAgain() {
  let waited = 0;
  const checks = autoUpdater.checks.length;
  assert.equal(updater.installBlocked(), true);
  assert.equal(await updater.readyToInstall({ platform: "darwin", onWait: () => waited++ }), false); // prettier-ignore
  assert.equal(waited, 0, "no wait");
  assert.equal(autoUpdater.checks.length, checks, "and no check started");
  autoUpdater.emit("update-downloaded", { version: "9.9.10" }); // fetched again
  assert.equal(updater.downloadedVersion(), "9.9.10");
  const again = updater.readyToInstall({ platform: "darwin", onWait: () => waited++ }); // prettier-ignore
  assert.equal(waited, 1, "waiting again");
  native.emit("update-downloaded");
  assert.equal(await again, true);
}

test("a refusal BEFORE Restart is remembered: the Restart says so at once rather than waiting it out", async () => {
  autoUpdater.emit("update-downloaded", { version: "9.9.9" });
  squirrel(false);
  pushed.length = 0;
  autoUpdater.emit("error", new Error("code signature")); // no wait, no check
  assert.equal(pushed.at(-1).payload.manual, false, "an install's, not a check's"); // prettier-ignore
  await blockedUntilFetchedAgain();
});

test("a manual check's DOWNLOAD failing is said as that check's failure — not another check's", async () => {
  updater.checkForUpdates({ manual: true });
  autoUpdater.emit("update-available", { version: "9.9.11" }); // the check answers…
  pushed.length = 0;
  autoUpdater.emit("error", new Error("download failed")); // …then the download fails
  assert.equal(pushed.at(-1).payload.manual, true);
  // The startup check's download failing stays quiet.
  updater.checkForUpdates({ manual: false });
  autoUpdater.emit("update-available", { version: "9.9.11" });
  autoUpdater.emit("error", new Error("download failed"));
  assert.equal(pushed.at(-1).payload.manual, false);
  autoUpdater.checks.splice(0).forEach((resolve) => resolve());
  await new Promise((r) => setImmediate(r));
  // A manual download under way, and a startup check failing beside it: the
  // check's failure is quiet, the download's still the manual one's.
  updater.checkForUpdates({ manual: true });
  autoUpdater.emit("update-available", { version: "9.9.12" });
  updater.checkForUpdates({ manual: false });
  autoUpdater.emit("error", new Error("offline")); // the startup check's
  assert.equal(pushed.at(-1).payload.manual, false, "the check's: quiet");
  autoUpdater.emit("error", new Error("download failed"));
  assert.equal(pushed.at(-1).payload.manual, true, "the manual download's: said"); // prettier-ignore
  autoUpdater.checks.splice(0).forEach((resolve) => resolve());
  await new Promise((r) => setImmediate(r));
});

test("a quit the user cancels, or a check's error, leaves the wait for Squirrel waiting — and no check starts during it", async () => {
  autoUpdater.emit("update-downloaded", { version: "9.9.9" }); // fresh: nothing refused
  squirrel(false);
  updater.checkForUpdates({ manual: true }); // already running
  const waiting = updater.readyToInstall({ platform: "darwin", waitMs: 60_000 }); // prettier-ignore
  let answer = null;
  void waiting.then((ok) => (answer = ok));
  app.emit("before-quit"); // …and then Cancel on the unsaved-work question
  pushed.length = 0;
  autoUpdater.emit("error", new Error("offline")); // the check's
  assert.equal(
    pushed.at(-1).payload.manual,
    true,
    "a check's own failure, said",
  );
  // Help ▸ Check during the wait would re-serve the download Squirrel is
  // taking: it does not start, and is told why.
  const checks = autoUpdater.checks.length;
  updater.checkForUpdates({ manual: true });
  assert.equal(autoUpdater.checks.length, checks, "no check started");
  assert.equal(pushed.at(-1).channel, "updater:preparing");
  await new Promise((r) => setImmediate(r));
  assert.equal(answer, null, "still waiting");
  native.emit("update-downloaded");
  assert.equal(await waiting, true, "and the Restart goes ahead when it is ready"); // prettier-ignore
  autoUpdater.checks.splice(0).forEach((resolve) => resolve());
  await new Promise((r) => setImmediate(r));
});

test("an error from a check already running is not blamed on the install", async () => {
  let failed = 0;
  updater.checkForUpdates({ manual: false });
  updater.quitAndInstall(() => failed++, { deadlineMs: 5, platform: "linux" });
  autoUpdater.emit("error", new Error("offline"));
  assert.equal(failed, 0, "the check's");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(failed, 1, "the install still answers to its deadline");
  autoUpdater.checks.splice(0).forEach((resolve) => resolve());
  await new Promise((r) => setImmediate(r));
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

test("a package manager's copy never checks: it answers why, and asks the feed nothing", async () => {
  await new Promise((r) => setImmediate(r));
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { PACKAGE_MARKER } = require("../store-build");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chiphippo-pkg-"));
  fs.writeFileSync(path.join(dir, PACKAGE_MARKER), "");
  const had = process.resourcesPath;
  try {
    process.resourcesPath = dir;
    pushed.length = 0;
    const checks = autoUpdater.checks.length;
    updater.checkForUpdates({ manual: true });
    assert.equal(
      autoUpdater.checks.length,
      checks,
      "no check reached the feed",
    );
    assert.deepEqual(pushed.at(-1), {
      channel: "updater:not-available",
      payload: { manual: true, reason: "package-managed" },
    });
  } finally {
    process.resourcesPath = had;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
