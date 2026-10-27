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
const { isPortable, isStoreBuild, selfUpdates } = require("./store-build");

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
// Whether the last "error" belonged to a CHECK in flight — read by an install
// attempt's own error listener, which runs after initUpdater's (that one
// settles the check first). A check's failure is not the install's.
let errorWasCheck = false;
// The version downloaded last (`downloadedVersion`), and whether Squirrel
// has failed it since — refused it, or a wait for it ran out: a Restart then
// answers at once (`readyToInstall`, `installBlocked`) until a new download
// gives Squirrel another one to take.
let downloaded = null;
let squirrelRefused = false;
// The download a check started (`autoDownload`) while it is under way, and
// whether that check was asked for: the check answers (`checkDone`) as soon
// as it finds the update, so its download's failure is still the failure
// the user who pressed Check is waiting to hear about.
let downloading = null; // {manual} | null

/** The check in flight answered: the next one starts from its own ask. */
function checkDone() {
  checkInFlight = false;
}

// macOS installs through Electron's native Squirrel updater, which takes the
// download from electron-updater and has it ready some seconds later. Asked to
// install before then, electron-updater hangs a listener on the native
// "update-downloaded" that quits and installs WHENEVER it fires — one nothing
// can take back, so an attempt this module gave up on (its deadline) would
// still restart the app minutes later, unasked. So on macOS the wait is ours,
// on a listener we remove: electron-updater is only asked once Squirrel has
// the update, and then installs at once. Whether Squirrel HAS it is
// electron-updater's own record — `squirrelDownloadedUpdate`, the flag its
// MacUpdater.quitAndInstall decides on — read only when it is a boolean: an
// updater without it is asked straight away, as before.

/** Electron's own native autoUpdater (Squirrel on macOS). */
function nativeUpdater() {
  return require("electron").autoUpdater;
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
    downloading = { manual: manualCheck };
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
  autoUpdater.on("update-downloaded", (info) => {
    downloaded = info?.version ?? null;
    squirrelRefused = false;
    downloading = null;
    pushUpdaterEvent("updater:downloaded", { version: info?.version });
  });
  autoUpdater.on("error", (err) => {
    errorWasCheck = checkInFlight;
    // A check's own failure is not its download's (one can overlap the
    // other): only a non-check error ends — and is — the download.
    const download = errorWasCheck ? null : downloading;
    if (!errorWasCheck) downloading = null;
    // Squirrel refusing the download it was handed (macOS: a signature, a
    // disk) — recorded whenever it happens, not only while a Restart waits:
    // it starts taking the download the moment it lands, so most refusals
    // come long before anyone presses Restart (`readyToInstall`).
    if (
      !errorWasCheck &&
      !download &&
      downloaded != null &&
      autoUpdater.squirrelDownloadedUpdate === false
    ) {
      squirrelRefused = true;
    }
    // `manual` only for a CHECK's own failure — its search, or the download
    // it started: the flag outlives the check that set it, so an install's
    // error (Squirrel refusing the download, which electron-updater may
    // report twice) would otherwise say "check failed" — and replace the
    // install-failed toast and its Restart.
    pushUpdaterEvent("updater:error", {
      message: (err && err.message) || String(err),
      manual: (manualCheck && errorWasCheck) || download?.manual === true,
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
  // A Restart waiting for Squirrel: a check now would have electron-updater
  // re-serve the download it is still taking (closing the proxy Squirrel is
  // reading from) — so none starts, and an asked-for one is told why.
  if (readyWait) {
    if (manual) pushUpdaterEvent("updater:preparing");
    return;
  }
  manualCheck = checkInFlight ? manualCheck || manual === true : manual === true; // prettier-ignore
  // A store build (Mac App Store / Microsoft Store) is updated BY the store,
  // and electron-builder strips the feed from the package, so there is nothing
  // to check; a package manager's copy (the AUR's) is updated by pacman, and
  // replacing its files from here would fight it. This one guard covers the
  // startup check and every manual one.
  // A Windows portable copy cannot replace itself (store-build.js): it is
  // told so, never handed the installer.
  if (!selfUpdates()) {
    pushUpdaterEvent("updater:not-available", {
      manual: manualCheck,
      reason: isStoreBuild()
        ? "store-build"
        : isPortable()
          ? "portable"
          : "package-managed",
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
 * it answered "go" with autosave stopped is not. And a failed attempt leaves
 * nothing armed behind it: on macOS, until Squirrel has the update, the wait
 * is this module's own (see `nativeUpdater`), so giving up takes it back.
 *
 * @param {() => void} [onFailed]
 * @param {{deadlineMs?: number, platform?: string}} [opts]
 */
// The install attempt still waiting to be told whether it quit (one at a
// time: a second Restart click settles the first silently).
let pendingInstall = null;

// How long an install may take to begin quitting before it is given up on.
// Squirrel.Mac re-reads the downloaded zip from electron-updater's local
// proxy first, which takes seconds for a large app — never a minute.
const INSTALL_DEADLINE_MS = 60_000;

// How long Restart waits for Squirrel to have the update before it gives up.
// Nothing is at stake while it waits — the unsaved-work question has not been
// asked, autosave runs, the app is the app — so it can be generous.
const SQUIRREL_WAIT_MS = 5 * 60_000;

// The wait under way, joined by a second Restart rather than stacked.
let readyWait = null;

/**
 * Resolve TRUE once an install would start at once — always, but on macOS
 * while Squirrel is still taking the download from electron-updater — or
 * FALSE if it does not get there in `waitMs` or the updater reports an error
 * meanwhile (not a check's) — and at once once Squirrel has failed this
 * download (`squirrelRefused`): main then says so and points at Check for
 * Updates, which downloads it again and hands Squirrel a fresh one. No
 * retry of our own: a check started under the wait announces its own
 * progress ("available", "ready") over the "preparing" it is waiting on,
 * and a check that finds nothing leaves the wait to run out (2026-10-12).
 *
 * Restart waits HERE, before main asks about unsaved work: asked first, the
 * "go" stood while Squirrel took its time — autosave stopped, the recovery
 * copy dropped, the window looking as ever — and anything done meanwhile was
 * lost to the restart, or to a quit that no longer asked (2026-10-11).
 * `onWait` is told when there IS a wait, so the window can say so.
 *
 * @param {{waitMs?: number, platform?: string, onWait?: () => void}} [opts]
 * @returns {Promise<boolean>}
 */
function readyToInstall({
  waitMs = SQUIRREL_WAIT_MS,
  platform = process.platform,
  onWait,
} = {}) {
  let autoUpdater = null;
  try {
    autoUpdater = getAutoUpdater();
  } catch {
    return Promise.resolve(false);
  }
  if (platform !== "darwin" || autoUpdater.squirrelDownloadedUpdate !== false) {
    return Promise.resolve(true);
  }
  const native = nativeUpdater();
  if (!native) return Promise.resolve(true);
  if (squirrelRefused) return Promise.resolve(false);
  onWait?.();
  // A second Restart joins the wait.
  readyWait ??= new Promise((resolve) => {
    let timer = null;
    const done = (ok) => {
      clearTimeout(timer);
      native.removeListener?.("update-downloaded", ready);
      autoUpdater.removeListener?.("error", failed);
      readyWait = null;
      resolve(ok);
    };
    const ready = () => done(true);
    // Squirrel refusing the download (a signature, a disk) comes back through
    // electron-updater's "error": no update is coming, so say so now rather
    // than at the deadline. A check's own failure is not this wait's.
    const failed = () => {
      if (errorWasCheck) return;
      squirrelRefused = true;
      done(false);
    };
    native.once?.("update-downloaded", ready);
    autoUpdater.on?.("error", failed);
    // No before-quit ending: a quit the user then cancels (the unsaved-work
    // question) leaves the app open and this Restart still wanted; a quit
    // that goes through ends the process, and the wait with it. Running out
    // counts as Squirrel failing it: waiting again would run out again. (If
    // it finishes after all, `squirrelDownloadedUpdate` says so first.)
    timer = setTimeout(() => {
      squirrelRefused = true;
      done(false);
    }, waitMs);
  });
  return readyWait;
}

/** The version downloaded last, or null. */
function downloadedVersion() {
  return downloaded;
}

/** Whether Squirrel has failed the download (refused it, or its wait ran
    out): a Restart cannot install it until a new download. */
function installBlocked() {
  return squirrelRefused;
}

function quitAndInstall(
  onFailed,
  { deadlineMs = INSTALL_DEADLINE_MS, platform = process.platform } = {},
) {
  pendingInstall?.(); // a second attempt replaces the first
  let autoUpdater = null;
  let native = null;
  let waiting = false; // on macOS, for Squirrel: our wait, nothing installing
  let settled = false;
  let deadline = null;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (pendingInstall === settle) pendingInstall = null;
    autoUpdater?.removeListener?.("error", onError);
    autoUpdater?.removeListener?.("checking-for-update", onCheck);
    native?.removeListener?.("update-downloaded", install);
    app.removeListener?.("before-quit", settle);
  };
  function failed() {
    if (settled) return;
    settle();
    onFailed?.();
  }
  // An error from a check that was already running is that check's; this
  // attempt's own failure still has the deadline.
  function onError() {
    if (!errorWasCheck) failed();
  }
  // A NEW check means this attempt is long over — its errors are that
  // check's, never this install's (they would withdraw a close-guard "go"
  // nobody had given). But while the wait for Squirrel is OURS, nothing is
  // installing: ending it quietly would leave the guard's "go" standing with
  // the app open and autosave stopped. That attempt failed, and says so.
  function onCheck() {
    if (waiting) failed();
    else settle();
  }
  function install() {
    if (settled) return;
    waiting = false;
    try {
      // isSilent=false → show the installer UI on Windows. The second argument
      // only counts for a SILENT install; a visible one relaunches per
      // `autoRunAppAfterInstall` (default true), which is what we want anyway.
      autoUpdater.quitAndInstall(false, true);
    } catch {
      // Nothing downloaded yet, or not packaged: no quit is coming.
      failed();
    }
  }
  pendingInstall = settle;
  try {
    autoUpdater = getAutoUpdater();
    autoUpdater.on?.("error", onError);
    autoUpdater.on?.("checking-for-update", onCheck);
    app.once?.("before-quit", settle);
    deadline = setTimeout(failed, deadlineMs);
    deadline.unref?.();
  } catch {
    failed();
    return;
  }
  if (platform === "darwin" && autoUpdater.squirrelDownloadedUpdate === false) {
    native = nativeUpdater();
    native?.once?.("update-downloaded", install);
    if (native) {
      waiting = true;
      return;
    }
  }
  install();
}

module.exports = {
  initUpdater,
  checkForUpdates,
  readyToInstall,
  downloadedVersion,
  installBlocked,
  quitAndInstall,
};
