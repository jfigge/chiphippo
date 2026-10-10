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

// updater.js — auto-update (Feature 280), wrapping electron-updater's
// autoUpdater.
//
// It checks the GitHub Releases feed the Release workflow already publishes
// (the `latest*.yml` uploaded beside each installer), downloads a newer build
// in the background, and lets the renderer offer to restart into it. Every
// lifecycle event is pushed to the renderer on an `updater:*` channel, which
// preload.js re-dispatches as a `chiphippo:updater-*` event — the renderer owns
// the toasts and the Settings ▸ About status line; this module owns none of the
// UI and asks no questions of its own.
//
// WE NEVER RESTART WITHOUT CONSENT. A downloaded update installs on a normal
// quit (`autoInstallOnAppQuit`) or through an explicit, user-clicked
// `quitAndInstall()` — and main calls that only AFTER the unsaved-work guard
// has been answered yes (`updater:install` → the close guard's `installing`
// question). It cannot lean on the ordinary before-quit question instead:
// electron-updater's BaseUpdater spawns the installer before it quits, so on
// Windows and Linux a "Cancel" there came too late to stop the update.
//
// The update check is the app's THIRD outbound call, after the AI builder and
// the datasheet download — and, like both, it is here in main because the
// renderer's CSP forbids it, and it goes exactly one place. No telemetry rides
// along: what leaves is the version being asked about.
"use strict";

const { app } = require("electron");
const { isStoreBuild } = require("./store-build");

// Lazily resolve electron-updater's autoUpdater. Reading the getter eagerly
// constructs the platform updater, which dereferences Electron's own native
// autoUpdater — absent under `node --test`. Deferring it until a check actually
// runs keeps `require("./updater")` (and so `require("./main")`) inert in tests.
function getAutoUpdater() {
  return require("electron-updater").autoUpdater;
}

// How to reach the renderer window. Injected by initUpdater() so this module
// never requires main.js — which requires it, and that would be a cycle.
let getWindow = () => null;

// Whether the check in flight was asked for by the user. electron-updater's
// events carry no caller context, so it is captured when a check starts and
// threaded into every push: the renderer shows "you're up to date" and the
// error toast for an EXPLICIT check and stays silent for the startup one.
//
// Checks are NOT strictly sequential: electron-updater folds a check asked for
// while one is running into that one, so the user's Check for Updates
// pressed during the delayed startup check gets the startup check's answer.
// Overwriting the flag then could relabel either one — so while a check is in
// flight a manual ask only ever RAISES it, and it is reset when that check
// answers (`checkDone`).
let manualCheck = false;
let checkInFlight = false;

/** The check in flight answered: the next one starts from its own ask. */
function checkDone() {
  checkInFlight = false;
}

let wired = false;

/** Push an updater event to the renderer window, if one is alive. */
function pushUpdaterEvent(channel, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Wire autoUpdater once and remember how to reach the renderer window. Safe to
 * call repeatedly — only the first call attaches listeners.
 *
 * @param {() => (import("electron").BrowserWindow | null)} resolveWindow
 */
function initUpdater(resolveWindow) {
  if (resolveWindow) getWindow = resolveWindow;
  if (wired) return;
  wired = true;

  const autoUpdater = getAutoUpdater();

  // Download as soon as an update is found; install only on quit or an
  // explicit quitAndInstall() — never a forced restart. Stable releases only:
  // a pre-release tag is for testing, not for everybody's app to jump onto.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  // Surface electron-updater's own logging rather than swallowing it — an
  // update that fails silently is indistinguishable from one that never ran.
  const at = (level) => (msg) =>
    console[level](`[updater] ${msg && msg.stack ? msg.stack : msg}`);
  autoUpdater.logger = {
    info: at("log"),
    warn: at("warn"),
    error: at("error"),
    debug: () => {},
  };

  autoUpdater.on("checking-for-update", () =>
    pushUpdaterEvent("updater:checking", { manual: manualCheck }),
  );
  autoUpdater.on("update-available", (info) => {
    pushUpdaterEvent("updater:available", {
      version: info?.version,
      manual: manualCheck,
    });
    checkDone();
  });
  autoUpdater.on("update-not-available", () => {
    pushUpdaterEvent("updater:not-available", { manual: manualCheck });
    checkDone();
  });
  // download-progress is deliberately NOT forwarded: there is no live progress
  // bar to feed, so a per-chunk IPC hop plus a DOM dispatch would be work with
  // nothing to show for it. The milestones below are what the UI reacts to.
  autoUpdater.on("update-downloaded", (info) =>
    pushUpdaterEvent("updater:downloaded", { version: info?.version }),
  );
  autoUpdater.on("error", (err) => {
    pushUpdaterEvent("updater:error", {
      message: (err && err.message) || String(err),
      manual: manualCheck,
    });
    checkDone();
  });
}

/**
 * Check for updates. Two builds cannot self-update at all, and both report it
 * honestly as a not-available REASON rather than as an error — "updates come
 * from the App Store" and "this is a dev build" are answers, not failures.
 *
 * @param {{ manual?: boolean }} [opts]
 */
function checkForUpdates({ manual = false } = {}) {
  manualCheck = checkInFlight ? manualCheck || manual === true : manual === true; // prettier-ignore
  // A store build (Mac App Store / Microsoft Store) is updated BY the store,
  // and electron-builder strips the feed from the package, so there is nothing
  // to check. This one guard covers the startup check and every manual one.
  if (isStoreBuild()) {
    pushUpdaterEvent("updater:not-available", {
      manual: manualCheck,
      reason: "store-build",
    });
    return;
  }
  // An unpacked build (`make debug`) has no installer to replace, and
  // electron-updater throws rather than answering.
  if (!app.isPackaged) {
    pushUpdaterEvent("updater:not-available", {
      manual: manualCheck,
      reason: "dev-build",
    });
    return;
  }
  // checkForUpdates() rejects on a network or signature failure, but the
  // "error" event has already fired with the same cause — swallow the
  // rejection so it doesn't also surface as an unhandled promise rejection.
  checkInFlight = true;
  // A check that rejects with no "error" event (or an updater that will not
  // construct) must not leave the flag stuck — it only ever RISES in flight.
  try {
    Promise.resolve(getAutoUpdater().checkForUpdates())
      .catch(() => {})
      .finally(checkDone);
  } catch {
    checkDone();
  }
}

/**
 * Quit and install a downloaded update. User-confirmed only (the Restart toast
 * action / the Settings ▸ About button).
 *
 * It can FAIL without quitting — nothing downloaded, an installer that will
 * not start, Squirrel refusing a signature — and electron-updater says so only
 * through its "error" event. `onFailed` is told then (once, and never after the
 * app has begun to quit), because the caller has already been told "go" by the
 * unsaved-work guard and must take that back while the app stays open.
 *
 * Nor is the "error" event a promise: on macOS the install goes through the
 * native Squirrel updater, which can decline to quit and say nothing at all.
 * So an attempt that has neither quit nor failed by `deadlineMs` is taken as
 * failed — the guard is asked again on a later quit, which is safe; leaving
 * it answered "go" with autosave stopped is not.
 *
 * @param {() => void} [onFailed]
 * @param {{deadlineMs?: number}} [opts]
 */
// The install attempt still waiting to be told whether it quit (one at a
// time: a second Restart click settles the first silently).
let pendingInstall = null;

// How long an install may take to begin quitting before it is given up on.
// Squirrel.Mac re-reads the downloaded zip from electron-updater's local
// proxy first, which takes seconds for a large app — never a minute.
const INSTALL_DEADLINE_MS = 60_000;

function quitAndInstall(onFailed, { deadlineMs = INSTALL_DEADLINE_MS } = {}) {
  pendingInstall?.(); // a second attempt replaces the first
  let autoUpdater = null;
  let settled = false;
  let deadline = null;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (pendingInstall === settle) pendingInstall = null;
    autoUpdater?.removeListener?.("error", failed);
    autoUpdater?.removeListener?.("checking-for-update", settle);
    app.removeListener?.("before-quit", settle);
  };
  function failed() {
    if (settled) return;
    settle();
    onFailed?.();
  }
  pendingInstall = settle;
  try {
    autoUpdater = getAutoUpdater();
    autoUpdater.on?.("error", failed);
    // A NEW check means this attempt is long over — its errors are that
    // check's, never this install's (they would withdraw a close-guard "go"
    // nobody had given).
    autoUpdater.on?.("checking-for-update", settle);
    app.once?.("before-quit", settle);
    deadline = setTimeout(failed, deadlineMs);
    deadline.unref?.();
    // isSilent=false → show the installer UI on Windows. The second argument
    // only counts for a SILENT install; a visible one relaunches per
    // `autoRunAppAfterInstall` (default true), which is what we want anyway.
    autoUpdater.quitAndInstall(false, true);
  } catch {
    // Nothing downloaded yet, or not packaged: no quit is coming.
    failed();
  }
}

module.exports = { initUpdater, checkForUpdates, quitAndInstall };
