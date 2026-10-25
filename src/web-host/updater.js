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

// updater.js — main's updater (app/updater.js) for the web build, which
// scripts/build-web.mjs puts in its place. Same six functions, same `updater:*`
// pushes, so Settings ▸ About, the Help menu's Check for Updates… and the
// "Restart to update" toast work unchanged.
//
// On the web an update is a new deploy. The service worker (sw.js) holds the
// release the tab is running; the browser looks for a newer sw.js on every
// load (and `checkForUpdates` asks it to look now). A newer one installs
// beside the old — the whole release fetched and cached — and waits: that is
// "downloaded". Restart tells it to take over and reloads the tab, once the
// close guard has dealt with anything unsaved.

let getWindow = () => null;
let registration = null;
let downloaded = null;
let watching = false;

function push(channel, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** The version a waiting service worker carries (sw.js answers its own). */
function versionOf(worker) {
  return new Promise((resolve) => {
    if (!worker) {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data?.version ?? null);
    };
    worker.postMessage({ type: "version" }, [channel.port2]);
  });
}

async function announceWaiting() {
  const worker = registration?.waiting;
  if (!worker) return false;
  downloaded = (await versionOf(worker)) ?? "";
  push("updater:downloaded", { version: downloaded || undefined });
  return true;
}

function watch() {
  if (watching || !registration) return;
  watching = true;
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    // The very first install (nothing controls the tab yet) is not an update.
    if (!worker || !globalThis.navigator.serviceWorker.controller) return;
    void versionOf(worker).then((version) =>
      push("updater:available", {
        version: version ?? undefined,
        manual: false,
      }),
    );
    worker.addEventListener("statechange", () => {
      // "installed" with a page already controlled = a new release, waiting.
      if (
        worker.state === "installed" &&
        globalThis.navigator.serviceWorker.controller
      ) {
        void announceWaiting();
      }
    });
  });
  // One that finished installing while no tab was open is waiting already.
  void announceWaiting();
}

/** host-entry.js: the service worker this tab is running under. */
export function setRegistration(reg) {
  registration = reg ?? null;
  watch();
}

export function initUpdater(resolveWindow) {
  if (resolveWindow) getWindow = resolveWindow;
  watch();
}

export function checkForUpdates({ manual = false } = {}) {
  if (!registration) {
    // Served without a service worker (`make web-serve` over plain http on a
    // LAN address, a browser that refuses one): every reload IS the update.
    push("updater:not-available", { manual, reason: "dev-build" });
    return;
  }
  push("updater:checking", { manual });
  Promise.resolve(registration.update())
    .then(async () => {
      if (registration.installing) {
        push("updater:available", { version: undefined, manual });
        return;
      }
      if (await announceWaiting()) return;
      push("updater:not-available", { manual });
    })
    .catch((err) => {
      push("updater:error", { message: String(err?.message ?? err), manual });
    });
}

export async function readyToInstall() {
  return Boolean(registration?.waiting);
}

export function downloadedVersion() {
  return downloaded;
}

export function installBlocked() {
  return false;
}

export function quitAndInstall(onFailed) {
  const waiting = registration?.waiting;
  if (!waiting) {
    onFailed?.();
    return;
  }
  const sw = globalThis.navigator.serviceWorker;
  const deadline = setTimeout(() => onFailed?.(), 10_000);
  sw.addEventListener(
    "controllerchange",
    () => {
      clearTimeout(deadline);
      globalThis.location.reload();
    },
    { once: true },
  );
  waiting.postMessage({ type: "skip-waiting" });
}
