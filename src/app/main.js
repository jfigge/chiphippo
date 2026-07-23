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
  dialog,
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
const memStore = require("./store/mem-store");
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

// ─── Named schematic files (Open / Save As) ───────────────────────────────────
// The working document lives in userData/desk.json (autosaved); these let the
// user Open/Save named `.chiphippo` files anywhere. The renderer then makes the
// chosen file the working document (see app.js).
const SCHEMATIC_FILTERS = [
  { name: "Chip Hippo Schematic", extensions: ["chiphippo", "json"] },
];

/** Show the Open dialog; read + migrate the choice. Returns {path, doc}|null. */
async function openSchematicDialog() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const opts = { properties: ["openFile"], filters: SCHEMATIC_FILTERS };
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths?.[0]) return null;
  const filePath = result.filePaths[0];
  return { path: filePath, doc: getDeskStore().readFile(filePath) };
}

/** Show the Save-As dialog; write `doc` to the choice. Returns the path|null. */
async function saveSchematicDialog(doc, suggestedPath) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const opts = {
    defaultPath:
      typeof suggestedPath === "string" && suggestedPath
        ? suggestedPath
        : "schematic.chiphippo",
    filters: SCHEMATIC_FILTERS,
  };
  const result = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return null;
  return getDeskStore().writeFile(result.filePath, doc);
}

// ─── Datasheet folder + PDFs ──────────────────────────────────────────────────
// The user can point Settings ▸ Data Sheets at a folder of manufacturer
// datasheet PDFs; a pinout window then offers to open `<folder>/<partId>.pdf`
// in the OS PDF viewer. The folder path lives in settings (`datasheetDir`).

/** Native folder picker for the datasheet directory. Returns the chosen
    absolute path, or null when cancelled. */
async function chooseDatasheetDir() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const opts = { properties: ["openDirectory", "createDirectory"] };
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths?.[0]) return null;
  return result.filePaths[0];
}

/** Natively open a part's external datasheet PDF (no-op when none is on file).
    Returns whether a file was handed to the OS. */
async function openDatasheetPdf(ref) {
  const file = datasheetPdfPath(ref);
  if (!file) return false;
  const err = await shell.openPath(file); // "" on success, else a message
  if (err) console.error("[main] datasheet:open error:", err);
  return !err;
}

// ─── Chip pin-assignments windows (Feature 100) ───────────────────────────────
// Double-clicking a chip opens a small, floating OS window rendering its DIP
// pinout (web/pinout.html) so it stays visible while the user wires. One window
// per chip ref (re-opening focuses it). The window floats above the app by
// default; right-clicking it toggles that via a native menu, and the choice is
// persisted as a de-facto global preference (`settings.pinoutFloat`) that every
// open pinout follows and a future settings dialog will bind to.
const pinoutWindows = new Map(); // part ref → BrowserWindow
// Catalog ids: chips ("74LS00"), discretes ("sw-slide", "led"), bricks ("psu").
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

/**
 * Absolute path to a part's external datasheet PDF, or null when none is on
 * file. Reads the user's `datasheetDir` setting and looks for `<dir>/<ref>.pdf`
 * (see the Settings ▸ Data Sheets folder). A missing/blank folder, a bad ref,
 * or an absent file all yield null.
 * @param {string} ref - a catalog id (e.g. "74LS00").
 * @returns {string|null}
 */
function datasheetPdfPath(ref) {
  if (typeof ref !== "string" || !PINOUT_REF_RE.test(ref)) return null;
  const dir = safeCall(
    "datasheet:dir",
    () => getSettingsStore().get().datasheetDir,
    null,
  );
  if (typeof dir !== "string" || !dir) return null;
  const file = path.join(dir, `${ref}.pdf`);
  return safeCall("datasheet:exists", () => fs.existsSync(file), false)
    ? file
    : null;
}

/** Open (or focus) the pin-assignments window for a part ref. */
function openPinoutWindow(ref, opts = {}) {
  if (typeof ref !== "string" || !PINOUT_REF_RE.test(ref)) return false;
  const existing = pinoutWindows.get(ref);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return true;
  }
  // `rows` is the renderer's layout row count (DIP wraps to pins/2; discretes
  // and bricks list every pin/terminal). Clamp defensively.
  const rows = Math.min(12, Math.max(2, Number(opts.rows) || 8));
  // Parts with a committed datasheet crop (make datasheets → web/datasheets/
  // <ref>.png) get a wider, taller default window so the diagram + truth table
  // are legible without an immediate resize; it stays freely resizable.
  const hasDatasheet = fs.existsSync(
    path.join(__dirname, "..", "web", "datasheets", `${ref}.png`),
  );
  const win = new BrowserWindow({
    width: hasDatasheet ? 640 : 400,
    height: 150 + rows * 30 + (hasDatasheet ? 430 : 0),
    minWidth: 300,
    minHeight: 220,
    alwaysOnTop: pinoutFloatPref(),
    backgroundColor: "#1c1c1c",
    icon: appIcon,
    title: "Pin assignments",
    fullscreenable: false,
    webPreferences: {
      // The pinout page is otherwise bridge-free, but it needs the narrow
      // window.chiphippo surface to open a part's external datasheet PDF
      // (datasheet:open) when the user has a datasheet folder configured.
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // When the user's datasheet folder holds a `<ref>.pdf`, tell the page to show
  // the "open datasheet" button (it invokes datasheet:open back into main).
  const query = { ref };
  if (datasheetPdfPath(ref)) query.pdf = "1";
  win
    .loadFile(path.join(__dirname, "..", "web", "pinout.html"), { query })
    .catch(() => {});
  // Right-click anywhere in the window → native float-above toggle.
  win.webContents.on("context-menu", () => showPinoutMenu(win));
  win.on("closed", () => {
    if (pinoutWindows.get(ref) === win) pinoutWindows.delete(ref);
  });
  pinoutWindows.set(ref, win);
  return true;
}

// ─── Memory backing files + inspector windows (Features 180 / 190) ─────────────
// Only NON-VOLATILE memory chips (ROM / EPROM / EEPROM) are file-backed; each
// keeps a `.bin` sidecar in the app working folder keyed by a per-chip GUID (the
// document stores only that GUID). All file I/O is here in main over the
// byte-oriented mem-store; main is the only place that maps a GUID to a real
// path, so a bad/hostile GUID can never escape the memory folder. The inspector
// is a separate floating OS window per component (like the pinout), and because
// it is its own renderer it talks to the main renderer only THROUGH main — the
// two `memory:to-*` relays below are that pipe.
const memoryWindows = new Map(); // component id → BrowserWindow
const MEM_COMP_RE = /^c[0-9]{1,6}$/i; // component ids are `c<n>`
// A crypto.randomUUID() the renderer minted for a memory chip. Anchored so a
// value with path separators / `..` can never reach the filesystem.
const MEM_GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The folder holding every memory chip's `.bin` sidecar (under userData). */
function memoryDir() {
  return path.join(app.getPath("userData"), "memory");
}

/** Resolve a chip GUID to its backing-file path, or throw on a bad GUID. */
function memoryPath(guid) {
  if (!MEM_GUID_RE.test(String(guid))) {
    const err = new Error(`invalid memory guid: ${guid}`);
    err.code = "INVALID_ARG";
    throw err;
  }
  return path.join(memoryDir(), `${guid}.bin`);
}

/** Run `fn(path)` for a GUID, returning { ok, ...} / { ok:false, error }. */
function withMemoryPath(guid, fn) {
  try {
    return { ok: true, ...(fn(memoryPath(guid)) || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Open a `.bin`/`.hex` image for the external programmer — returns its RAW
    bytes; the renderer decides bin-vs-hex by extension and parses HEX itself. */
async function pickMemoryImage() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const opts = {
    properties: ["openFile"],
    filters: [
      { name: "Memory image", extensions: ["bin", "hex", "rom", "dat"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const r = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths?.[0]) return null;
  const filePath = r.filePaths[0];
  try {
    return {
      ok: true,
      name: path.basename(filePath),
      bytes: fs.readFileSync(filePath),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Export image bytes to a chosen file (the renderer builds the payload, raw
    `.bin` OR Intel-HEX text as bytes, and picks the suggested extension). */
async function exportMemoryFile(bytes, suggestedName) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const opts = {
    defaultPath:
      typeof suggestedName === "string" && suggestedName
        ? suggestedName
        : "memory.bin",
    filters: [
      { name: "Binary image", extensions: ["bin"] },
      { name: "Intel HEX", extensions: ["hex"] },
      { name: "All files", extensions: ["*"] },
    ],
  };
  const r = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  try {
    memStore.writeAll(r.filePath, bytes);
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Open (or focus) the memory-inspector window for a component id. */
function openMemoryWindow(compId, ref) {
  if (!MEM_COMP_RE.test(String(compId)) || !PINOUT_REF_RE.test(String(ref))) {
    return false;
  }
  const existing = memoryWindows.get(compId);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return true;
  }
  const win = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 480,
    minHeight: 320,
    // An editor you type into, so it does NOT float over the app by default.
    backgroundColor: "#1c1c1c",
    icon: appIcon,
    title: "Memory inspector",
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win
    .loadFile(path.join(__dirname, "..", "web", "memory.html"), {
      query: { comp: compId, ref },
    })
    .catch(() => {});
  win.on("closed", () => {
    if (memoryWindows.get(compId) === win) memoryWindows.delete(compId);
  });
  memoryWindows.set(compId, win);
  return true;
}

/** Relay a message from the main renderer to a component's inspector window. */
function relayToInspector(compId, msg) {
  const win = memoryWindows.get(compId);
  if (win && !win.isDestroyed()) {
    win.webContents.send("memory:inbound", { compId, msg });
  }
}

/** Relay a message from an inspector window back to the main renderer. */
function relayToHost(compId, msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("memory:host-inbound", { compId, msg });
  }
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

  // Schematic file operations — each pushes to the renderer, which owns the
  // document (New/Open reload the working desk; Save/Save As write a file).
  const schematicItems = [
    {
      label: "New Schematic",
      accelerator: "CmdOrCtrl+N",
      click: () => sendToMain("menu:schematic-new"),
    },
    {
      label: "Open Schematic…",
      accelerator: "CmdOrCtrl+O",
      click: () => sendToMain("menu:schematic-open"),
    },
    { type: "separator" },
    {
      label: "Save",
      accelerator: "CmdOrCtrl+S",
      click: () => sendToMain("menu:schematic-save"),
    },
    {
      label: "Save As…",
      accelerator: "CmdOrCtrl+Shift+S",
      click: () => sendToMain("menu:schematic-save-as"),
    },
  ];

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
    template.push({ label: "File", submenu: schematicItems });
  } else {
    template.push({
      label: "File",
      submenu: [
        ...schematicItems,
        { type: "separator" },
        settings,
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  // Undo / Redo drive the DOCUMENT history (Feature 200), not text-field
  // editing — each pushes to the renderer, which owns the snapshot stack and
  // reports availability back over menu:edit-state (see setEditMenuState). They
  // start disabled; the renderer enables them once there is something to do.
  template.push({
    label: "Edit",
    submenu: [
      {
        id: "edit-undo",
        label: "Undo",
        accelerator: "CmdOrCtrl+Z",
        enabled: false,
        click: () => sendToMain("menu:edit-undo"),
      },
      {
        id: "edit-redo",
        label: "Redo",
        accelerator: "Shift+CmdOrCtrl+Z",
        enabled: false,
        click: () => sendToMain("menu:edit-redo"),
      },
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

/**
 * Enable/disable Edit ▸ Undo / Redo to match the renderer's history state
 * (Feature 200). The renderer is the authority — it pushes this whenever undo
 * availability changes.
 */
function setEditMenuState({ canUndo = false, canRedo = false } = {}) {
  const menu = Menu.getApplicationMenu();
  const undo = menu?.getMenuItemById("edit-undo");
  const redo = menu?.getMenuItemById("edit-redo");
  if (undo) undo.enabled = Boolean(canUndo);
  if (redo) redo.enabled = Boolean(canRedo);
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

/**
 * Close every auxiliary window (pinout diagrams + memory inspectors). The main
 * renderer rebuilds the whole scene by reloading on New/Open (the app's one
 * teardown path), which orphans these separate OS windows: a pinout points at a
 * chip that may be gone, and — worse — an open inspector's Save would recreate
 * a `.bin` for a chip the reload just removed. Each window's own `closed`
 * handler prunes its map entry.
 */
function closeAuxWindows() {
  for (const w of [...pinoutWindows.values(), ...memoryWindows.values()]) {
    if (!w.isDestroyed()) w.close();
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
  // Settings ▸ Data Sheets: pick the external datasheet-PDF folder (native
  // directory dialog); the renderer persists the chosen path via settings:set.
  ipcMain.handle("settings:choose-datasheet-dir", () => chooseDatasheetDir());

  // Desk document (Feature 20): load runs the schema migrations; the
  // renderer autosaves the whole document, debounced (~1 s).
  ipcMain.handle("desk:load", () => getDeskStore().load());
  ipcMain.handle("desk:save", (_event, doc) => getDeskStore().save(doc));

  // Named schematic files (Open / Save As / Save). `desk:open` and
  // `desk:save-as` show a native dialog and return null when cancelled;
  // `desk:write` overwrites a known path (a re-Save with no prompt).
  ipcMain.handle("desk:open", () => openSchematicDialog());
  ipcMain.handle("desk:save-as", (_event, doc, suggestedPath) =>
    saveSchematicDialog(doc, suggestedPath),
  );
  ipcMain.handle("desk:write", (_event, filePath, doc) =>
    getDeskStore().writeFile(filePath, doc),
  );

  // Chip pin-assignments window (Feature 100): double-clicking a chip opens a
  // separate floating OS window rendering its pinout as a wiring reference.
  ipcMain.handle("pinout:open", (_event, ref, opts) =>
    openPinoutWindow(ref, opts),
  );

  // Open a part's external datasheet PDF from the configured folder (Settings ▸
  // Data Sheets) in the OS PDF viewer. Requested by the pinout window's
  // "open datasheet" button; a no-op (returns false) when no PDF is on file.
  ipcMain.handle("datasheet:open", (_event, ref) => openDatasheetPdf(ref));

  // Memory backing files (Features 180/190): the byte-oriented, GUID-keyed store
  // behind a ROM chip's `.bin` in the app working folder. Each resolves the
  // GUID to a path (rejecting a bad one) and returns { ok, ... } /
  // { ok:false, error } so the renderer can surface a failure.
  ipcMain.handle("mem:create", (_event, guid, byteLength) =>
    withMemoryPath(guid, (p) => memStore.create(p, byteLength)),
  );
  ipcMain.handle("mem:load", (_event, guid, byteLength) =>
    withMemoryPath(guid, (p) => ({ bytes: memStore.load(p, byteLength) })),
  );
  ipcMain.handle("mem:program", (_event, guid, bytes, byteLength) =>
    withMemoryPath(guid, (p) => memStore.program(p, bytes, byteLength)),
  );
  ipcMain.handle("mem:write", (_event, guid, bytes) =>
    withMemoryPath(guid, (p) => {
      memStore.writeAll(p, bytes);
    }),
  );
  ipcMain.handle("mem:delete", (_event, guid) =>
    withMemoryPath(guid, (p) => memStore.remove(p)),
  );
  // The chip's backing-file path (for the inspector's display / copy affordance).
  ipcMain.handle("mem:path", (_event, guid) =>
    withMemoryPath(guid, (p) => ({ path: p })),
  );
  // The external programmer's file picker (a `.bin`/`.hex` image → raw bytes).
  ipcMain.handle("mem:pick-image", () => pickMemoryImage());
  // Export the current image to a user-chosen file (raw `.bin` or Intel-HEX
  // text — the renderer builds the payload + picks the suggested extension).
  ipcMain.handle("mem:export", (_event, bytes, suggestedName) =>
    exportMemoryFile(bytes, suggestedName),
  );

  // Memory inspector window + cross-window relay (Feature 190): the inspector
  // is its own OS window per component and reaches the main renderer only
  // through these two relays (host ⇄ inspector, addressed by component id).
  ipcMain.handle("memory:open", (_event, compId, ref) =>
    openMemoryWindow(compId, ref),
  );
  ipcMain.handle("memory:to-inspector", (_event, compId, msg) => {
    relayToInspector(compId, msg);
    return true;
  });
  ipcMain.handle("memory:to-host", (_event, compId, msg) => {
    relayToHost(compId, msg);
    return true;
  });

  // Undo/redo menu state (Feature 200): the renderer owns the document history
  // and pushes the current availability so Edit ▸ Undo / Redo match.
  ipcMain.handle("menu:edit-state", (_event, state) => {
    setEditMenuState(state);
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

  // Any top-level navigation of the main frame is a full scene rebuild (New /
  // Open reload the working desk; hot-reload; a manual reload). Close the
  // orphaned pinout / inspector windows so a stale inspector can't write a
  // `.bin` for a chip the reload removed. did-navigate is main-frame only and
  // skips in-page navigations; the initial load is a harmless no-op (maps
  // empty).
  win.webContents.on("did-navigate", () => closeAuxWindows());

  win.loadFile(path.join(__dirname, "..", "web", "index.html")).catch(() => {});

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // Close the orphaned pinout/inspector windows so they don't outlive the
    // desk they belong to — and, on Windows/Linux, so `window-all-closed` can
    // actually fire and quit the app instead of hanging on a stray inspector.
    closeAuxWindows();
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
