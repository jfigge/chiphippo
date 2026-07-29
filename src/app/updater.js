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
// `quitAndInstall()` — and even then the quit runs main's ordinary
// before-quit guard, so an unsaved project is still asked about first.
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
// Checks are effectively sequential, so one flag is enough.
let manualCheck = false;

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
  autoUpdater.on("update-available", (info) =>
    pushUpdaterEvent("updater:available", {
      version: info?.version,
      manual: manualCheck,
    }),
  );
  autoUpdater.on("update-not-available", () =>
    pushUpdaterEvent("updater:not-available", { manual: manualCheck }),
  );
  // download-progress is deliberately NOT forwarded: there is no live progress
  // bar to feed, so a per-chunk IPC hop plus a DOM dispatch would be work with
  // nothing to show for it. The milestones below are what the UI reacts to.
  autoUpdater.on("update-downloaded", (info) =>
    pushUpdaterEvent("updater:downloaded", { version: info?.version }),
  );
  autoUpdater.on("error", (err) =>
    pushUpdaterEvent("updater:error", {
      message: (err && err.message) || String(err),
      manual: manualCheck,
    }),
  );
}

/**
 * Check for updates. Two builds cannot self-update at all, and both report it
 * honestly as a not-available REASON rather than as an error — "updates come
 * from the App Store" and "this is a dev build" are answers, not failures.
 *
 * @param {{ manual?: boolean }} [opts]
 */
function checkForUpdates({ manual = false } = {}) {
  manualCheck = manual === true;
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
  Promise.resolve(getAutoUpdater().checkForUpdates()).catch(() => {});
}

/**
 * Quit and install a downloaded update. User-confirmed only (the Restart toast
 * action / the Settings ▸ About button). A no-op when nothing is downloaded.
 */
function quitAndInstall() {
  try {
    // isSilent=false → show the installer UI on Windows; isForceRunAfter=true
    // → relaunch once the update is applied.
    getAutoUpdater().quitAndInstall(false, true);
  } catch {
    /* nothing downloaded yet, or not packaged — nothing to do */
  }
}

module.exports = { initUpdater, checkForUpdates, quitAndInstall };
