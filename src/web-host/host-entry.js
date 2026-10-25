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

// host-entry.js — the web build's MAIN PROCESS, started by the app's tab.
//
// The Electron app splits into main (Node: windows, files, the network) and a
// sandboxed renderer that reaches it only through `window.chiphippo`. The web
// build keeps that split exactly: main's own code (src/app/main.js and all it
// requires) runs here, in the tab, against browser stand-ins for Electron and
// Node (electron.js, node/*), and every renderer — the tab's page and each
// popup — talks to it through the same preload.js over the same channels.
// See .claude/rules/web.md.
//
// Startup, in order: one tab at a time → the build's version → the shipped
// content's manifest → storage loaded into the in-memory filesystem → the
// visitor's files re-read → main started → the app window bound to this tab →
// renderers let in → the service worker.

import { ctx, download } from "./context.js";
import { openDatabase, Persist } from "./persist.js";
import { Mounts } from "./mounts.js";
import { Dialogs } from "./dialogs.js";
import { registerBundle, prefetchCatalogs } from "./bundle.js";
import {
  attachRenderer,
  closeAllPopups,
  domWindowFor,
  getAppWindow,
} from "./windows.js";
import { dispatch } from "./ipc.js";
import { handleAccelerator, toggleHelpMenu } from "./menu.js";
import { app } from "./electron.js";
import { setRegistration } from "./updater.js";
import { electronEvent } from "./events.js";
import { t } from "./strings.js";

const LOCK_NAME = "chiphippo-app";

/** Hold the app for this tab for as long as it is open — Electron's
    single-instance lock. Resolves false when another tab has it. */
function takeLock() {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return Promise.resolve(true);
  return new Promise((resolve) => {
    locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        // Held until the tab goes.
        return new Promise(() => {});
      })
      .catch(() => resolve(true));
  });
}

/** A page with nothing but a sentence on it (and, for a stale tab, a way on). */
function stop(message, { retry = false } = {}) {
  const doc = ctx.page.document;
  const box = doc.createElement("div");
  box.className = "webhost-stop";
  const p = doc.createElement("p");
  p.textContent = message;
  box.append(p);
  if (retry) {
    const btn = doc.createElement("button");
    btn.className = "btn popup-btn btn--primary";
    btn.type = "button";
    btn.textContent = t("web.tryAgain", "Try Again");
    btn.addEventListener("click", () => ctx.page.location.reload());
    box.append(btn);
  }
  doc.getElementById("app")?.replaceChildren();
  doc.body.append(box);
}

async function readBuild() {
  try {
    const res = await fetch(new URL("version.json", ctx.baseUrl), {
      cache: "no-cache",
    });
    if (res.ok) ctx.build = { ...ctx.build, ...(await res.json()) };
  } catch {
    // offline with no cache: the version reads as 0.0.0
  }
}

/** Resolves once main has created the app window (inside whenReady). */
function appWindowBound() {
  return new Promise((resolve) => {
    const check = () =>
      getAppWindow() ? resolve(getAppWindow()) : setTimeout(check, 0);
    check();
  });
}

// ── What a renderer gets when it connects ───────────────────────────────────

const host = {
  /**
   * A page's preload connecting. `port.deliver(channel, args)` is how pushes
   * reach it. Returns its end of the connection, or null for a page that is
   * no window of ours.
   */
  attach(domWindow, port) {
    const link = attachRenderer(domWindow, port);
    if (!link) return null;
    const sender = () => link.webContents;
    return {
      invoke: (channel, args) => dispatch(sender(), channel, args),
      keydown: (e) => handleAccelerator(sender()?.browserWindow ?? null, e),
      contextmenu: ({ x, y }) => {
        const wc = sender();
        if (!wc) return false;
        wc.lastContextPoint = { x, y };
        if (!wc.listenerCount("context-menu")) return false;
        wc.emit("context-menu", electronEvent(), { x, y });
        return true;
      },
    };
  },
};

// ── Startup ─────────────────────────────────────────────────────────────────

async function boot() {
  const page = ctx.page;
  ctx.singleInstance = await takeLock();
  await readBuild();

  const { vfs } = ctx;
  let persist;
  try {
    const db = await openDatabase();
    let mounts = null;
    persist = new Persist(db, vfs, (p) => mounts?.keep(p) ?? false);
    mounts = new Mounts({ vfs, persist, download });
    ctx.persist = persist;
    ctx.mounts = mounts;
    await persist.load();
    await mounts.load();
    persist.start();
    mounts.start();
  } catch (err) {
    console.error("[web] storage unavailable:", err);
    stop(
      t(
        "web.noStorage",
        "Chip Hippo needs this browser's storage to keep your work, and it isn't available here (a private window can refuse it).",
      ),
      { retry: true },
    );
    return;
  }

  if (!ctx.singleInstance) {
    stop(
      t(
        "web.otherTab",
        "Chip Hippo is already open in another tab or window. Close it there, then try again.",
      ),
      {
        retry: true,
      },
    );
    return;
  }

  try {
    const bundled = await registerBundle(vfs, ctx.baseUrl);
    await prefetchCatalogs(vfs, bundled);
  } catch (err) {
    console.error("[web] the build manifest could not be read:", err);
    stop(
      t(
        "web.offline",
        "Chip Hippo could not load. Check the connection and try again.",
      ),
      { retry: true },
    );
    return;
  }
  ctx.dialogs = new Dialogs({
    vfs,
    mounts: ctx.mounts,
    download,
    windowOf: domWindowFor,
  });

  // Main itself. Its module body registers nothing until `whenReady`.
  require("../app/main.js");
  app._ready();
  await appWindowBound();

  // Renderers in: the tab's own preload has been waiting for this.
  page.__chiphippoHost = host;
  page.dispatchEvent(new Event("chiphippo-host-ready"));

  // Leaving: a project with changes its file does not have asks first (the
  // browser's own question — a page may ask nothing of its own), and so does
  // a write still on its way to storage. Popups go with the tab.
  page.addEventListener("beforeunload", (e) => {
    const unsaved = page.document.title.startsWith("• ");
    if (unsaved || persist.busy) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  page.addEventListener("pagehide", () => closeAllPopups());
  // The header's book button (app.js, web only): main's Help menu under it.
  page.addEventListener("chiphippo:web-help-menu", (e) =>
    toggleHelpMenu(e.detail?.anchor),
  );

  registerServiceWorker();
}

function registerServiceWorker() {
  const sw = globalThis.navigator?.serviceWorker;
  const off = new URL(ctx.page.location.href).searchParams.has("nosw");
  if (!sw || !globalThis.isSecureContext || off) return;
  sw.register("sw.js", { scope: "./" })
    .then((reg) => setRegistration(reg))
    .catch((err) =>
      console.warn("[web] no service worker:", err?.message ?? err),
    );
}

boot().catch((err) => {
  console.error("[web] startup failed:", err);
  stop(
    t("web.failed", "Chip Hippo could not start: {message}", {
      message: String(err?.message ?? err),
    }),
    {
      retry: true,
    },
  );
});
