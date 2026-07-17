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

// main.js — Electron main process for Chip Hippo.
//
// Owns all native I/O and exposes it to the sandboxed renderer only through
// the window.chiphippo bridge (preload.js). Stage 00 is a bare shell: the
// hardened BrowserWindow, hot reload under --hot-reload, the single-instance
// lock, and the first two IPC handlers. Later stages add stores, autosave and
// the rest of the bridge here — keep every ipcMain handler in lockstep with
// preload.js.
"use strict";

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const { parseArgs } = require("./cli-args");

const {
  dev: isDev,
  hotReload: isHotReload,
  devTools: isDevTools,
} = parseArgs(process.argv);

/**
 * Resolve the app's own version. In a packaged build app.getVersion() returns
 * the productName version, but when running unpackaged (make debug) it falls
 * back to Electron's version — so prefer the package.json value.
 */
function resolveAppVersion() {
  try {
    return require("../package.json").version;
  } catch {
    return app.getVersion();
  }
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
// Every channel registered here must have a matching window.chiphippo.* export
// in preload.js (the ipc-parity test enforcing this lands in Feature 20).
function registerIpc() {
  // Mirrors the bridge's synchronous `platform` value so main stays the
  // authoritative source for platform info reachable over IPC.
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("app:version", () => resolveAppVersion());
}

// ─── Hot reload (dev only) ────────────────────────────────────────────────────
function installHotReload(win) {
  const webDir = path.join(__dirname, "..", "web");
  let timer = null;
  try {
    fs.watch(webDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
      }, 120);
    });
  } catch (err) {
    console.error("[main] hot-reload watcher failed:", err && err.message);
  }
}

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#1c1c1c", // matches --color-base in theme.css
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Window-open hardening: the renderer never opens windows of its own — pass
  // external links to the system browser and deny everything else.
  win.webContents.setWindowOpenHandler(({ url }) => {
    let scheme = "";
    try {
      scheme = new URL(url).protocol;
    } catch {
      return { action: "deny" };
    }
    if (scheme === "http:" || scheme === "https:" || scheme === "mailto:") {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  win.loadFile(path.join(__dirname, "..", "web", "index.html"));

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev || isDevTools) win.webContents.openDevTools({ mode: "bottom" });
  if (isHotReload) installHotReload(win);

  mainWindow = win;
  return win;
}

/** Show and focus the window (the single-instance / dock-activate path). */
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ─── Single-instance lock ──────────────────────────────────────────────────────
// A second launch focuses the running window and exits. Skipped under
// --hot-reload, whose self-relaunch would race the lock.
const gotSingleInstanceLock = isHotReload || app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  bootstrap();
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
function bootstrap() {
  app.whenReady().then(() => {
    registerIpc();
    createWindow();

    app.on("activate", () => {
      // macOS: clicking the dock re-shows (or recreates) the window.
      showWindow();
    });
  });

  // Chip Hippo is a foreground document app: closing the last window quits
  // (the normal Electron default), except on macOS where the app stays active
  // in the dock until an explicit Quit.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
