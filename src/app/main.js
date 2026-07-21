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

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");

const { parseArgs } = require("./cli-args");
const { SettingsStore } = require("./store/settings-store");
const { DeskStore } = require("./store/desk-store");
const {
  DEFAULT_BOUNDS,
  resolveWindowBounds,
  trackWindowState,
} = require("./window-state");

const {
  dev: isDev,
  hotReload: isHotReload,
  devTools: isDevTools,
} = parseArgs(process.argv);

// Any dev-ish launch gets the dev renderer flag (gates the desk debug HUD).
const isDevLike = isDev || isHotReload || isDevTools;

// ── App icon ──────────────────────────────────────────────────────────────────
// Resolved once at startup; used for the macOS dock and every BrowserWindow (so
// a `make debug` run shows the Chip Hippo icon, not the default Electron one).
// macOS expects the artwork inside the system "safe area" — a rounded square
// filling ~80% of the canvas with a TRANSPARENT border on every side — so the
// dock renders it at native visual weight; we use the pre-padded
// `chiphippo-mac-icon.png` on darwin. Windows gets the multi-resolution
// `chiphippo-icon.ico` (the shell picks a purpose-rendered size instead of
// blurrily downscaling one bitmap); Linux keeps the edge-to-edge logo, which is
// designed to fill its canvas. All are regenerated from the SVGs by `make icons`.
const APP_ICON_PATH = path.join(
  __dirname,
  "..",
  "web",
  process.platform === "darwin"
    ? "chiphippo-mac-icon.png"
    : process.platform === "win32"
      ? "chiphippo-icon.ico"
      : "chiphippo-logo.png",
);
const appIcon = nativeImage.createFromPath(APP_ICON_PATH);

// Set the dock icon synchronously before whenReady() — safe in modern Electron
// and eliminates the brief Electron-default-icon flash during launch.
if (process.platform === "darwin" && app.dock && !appIcon.isEmpty()) {
  app.dock.setIcon(appIcon);
}

// ── Main-process error conventions ────────────────────────────────────────────
/** Run `fn`, logging (not throwing) on failure — for best-effort reads/writes. */
function safeCall(channel, fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.error(`[main] ${channel} error:`, err && err.message);
    return fallback;
  }
}

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

/** Read-only metadata for the About dialog (version + runtime versions). */
function collectAppInfo() {
  return {
    version: resolveAppVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
  };
}

// ─── Storage ──────────────────────────────────────────────────────────────────
// Built lazily on first use so app.getPath("userData") is resolvable (it
// honours a --user-data-dir override once Electron has processed it).
let _settingsStore = null;

/** @returns {SettingsStore} */
function getSettingsStore() {
  if (!_settingsStore) {
    _settingsStore = new SettingsStore(app.getPath("userData"));
  }
  return _settingsStore;
}

let _deskStore = null;

/** @returns {DeskStore} */
function getDeskStore() {
  if (!_deskStore) _deskStore = new DeskStore(app.getPath("userData"));
  return _deskStore;
}

// ─── Chip pin-assignments windows (Feature 100) ───────────────────────────────
// Double-clicking a chip opens a small, floating OS window rendering its DIP
// pinout (web/pinout.html) so it stays visible while the user wires. One window
// per chip ref (re-opening focuses it). The window floats above the app by
// default; right-clicking it toggles that via a native menu, and the choice is
// persisted as a de-facto global preference (`settings.pinoutFloat`) that every
// open pinout follows and a future settings dialog will bind to.
const pinoutWindows = new Map(); // part ref → BrowserWindow
// Catalog ids: chips ("7400"), discretes ("sw-slide", "led"), bricks ("psu").
const PINOUT_REF_RE = /^[a-z0-9][a-z0-9-]{1,11}$/i;

/** The persisted float-above preference (defaults true). */
function pinoutFloatPref() {
  return (
    safeCall(
      "pinout:float",
      () => getSettingsStore().get().pinoutFloat,
      true,
    ) !== false
  );
}

/** Open (or focus) the pin-assignments window for a part ref. */
function openPinoutWindow(ref, opts = {}) {
  if (typeof ref !== "string" || !PINOUT_REF_RE.test(ref)) return;
  const existing = pinoutWindows.get(ref);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }
  // `rows` is the renderer's layout row count (DIP wraps to pins/2; discretes
  // and bricks list every pin/terminal). Clamp defensively.
  const rows = Math.min(12, Math.max(2, Number(opts.rows) || 8));
  const win = new BrowserWindow({
    width: 400,
    height: 150 + rows * 30,
    minWidth: 300,
    minHeight: 220,
    alwaysOnTop: pinoutFloatPref(),
    backgroundColor: "#1c1c1c",
    icon: appIcon,
    title: "Pin assignments",
    fullscreenable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "..", "web", "pinout.html"), {
    query: { ref },
  });
  // Right-click anywhere in the window → native float-above toggle.
  win.webContents.on("context-menu", () => showPinoutMenu(win));
  win.on("closed", () => {
    if (pinoutWindows.get(ref) === win) pinoutWindows.delete(ref);
  });
  pinoutWindows.set(ref, win);
}

// ─── Application menu ──────────────────────────────────────────────────────────
// The About and Settings items PUSH to the renderer (menu:show-about /
// menu:open-settings); the preload re-dispatches each as a chiphippo:* event
// and the renderer opens the corresponding PopupManager dialog. Everything
// else is a standard Electron role.
function sendToMain(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel);
  }
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const about = {
    label: "About Chip Hippo",
    click: () => sendToMain("menu:show-about"),
  };
  const settings = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => sendToMain("menu:open-settings"),
  };

  const template = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        about,
        { type: "separator" },
        settings,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  } else {
    template.push({
      label: "File",
      submenu: [settings, { type: "separator" }, { role: "quit" }],
    });
  }

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  });
  template.push({
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { role: "close" },
      ...(isMac ? [{ type: "separator" }, { role: "front" }] : []),
    ],
  });
  template.push({
    role: "help",
    submenu: isMac ? [] : [about],
  });

  return Menu.buildFromTemplate(template);
}

/** The native right-click menu for a pinout window (float toggle + close). */
function showPinoutMenu(win) {
  const floating = win.isAlwaysOnTop();
  Menu.buildFromTemplate([
    {
      label: "Float above other windows",
      type: "checkbox",
      checked: floating,
      click: () => setPinoutFloat(!floating),
    },
    { type: "separator" },
    { label: "Close window", role: "close" },
  ]).popup({ window: win });
}

/** Toggle float on EVERY open pinout window + persist the global default. */
function setPinoutFloat(on) {
  safeCall("pinout:set-float", () =>
    getSettingsStore().set({ pinoutFloat: on }),
  );
  for (const w of pinoutWindows.values()) {
    if (!w.isDestroyed()) w.setAlwaysOnTop(on);
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
  // Read-only app / build metadata for the About dialog.
  ipcMain.handle("app:info:get", () => collectAppInfo());

  // App settings (Feature 10): the desk viewport + window bounds live here;
  // later stages add their own keys. Writes are atomic (store/io.js).
  ipcMain.handle("settings:get", () => getSettingsStore().get());
  ipcMain.handle("settings:set", (_event, patch) =>
    getSettingsStore().set(patch),
  );

  // Desk document (Feature 20): load runs the schema migrations; the
  // renderer autosaves the whole document, debounced (~1 s).
  ipcMain.handle("desk:load", () => getDeskStore().load());
  ipcMain.handle("desk:save", (_event, doc) => getDeskStore().save(doc));

  // Chip pin-assignments window (Feature 100): double-clicking a chip opens a
  // separate floating OS window rendering its pinout as a wiring reference.
  ipcMain.handle("pinout:open", (_event, ref, opts) => {
    openPinoutWindow(ref, opts);
    return true;
  });
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
  // Restore the last position/size when it still fits on a connected display;
  // otherwise fall back to the centred default (resolveWindowBounds decides).
  const displays = safeCall(
    "window:displays",
    () =>
      screen
        .getAllDisplays()
        .map((d) => ({ bounds: d.bounds, workArea: d.workArea })),
    [],
  );
  const savedBounds = safeCall(
    "window:bounds",
    () => getSettingsStore().get().windowBounds,
    null,
  );
  const bounds = resolveWindowBounds(savedBounds, displays, DEFAULT_BOUNDS);

  const win = new BrowserWindow({
    ...bounds, // x/y only when restored; width/height always
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#1c1c1c", // matches --color-base in theme.css
    icon: appIcon, // Windows/Linux window icon (macOS uses the dock icon)
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Visible to the sandboxed preload via process.argv — gates dev-only UI.
      additionalArguments: isDevLike ? ["--chiphippo-dev"] : [],
    },
  });

  // Persist position/size as the user moves/resizes (debounced) and on close.
  trackWindowState(win, {
    save: (b) =>
      safeCall("window:save-bounds", () =>
        getSettingsStore().set({ windowBounds: b }),
      ),
  });

  // Disable Chromium's built-in pinch/ctrl-wheel visual zoom — the desk owns
  // those gestures (DeskView zooms the camera, not the page).
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

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
    Menu.setApplicationMenu(buildAppMenu());
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
