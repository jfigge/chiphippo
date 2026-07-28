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
  nativeTheme,
  screen,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");

const { parseArgs } = require("./cli-args");
const { SettingsStore } = require("./store/settings-store");
const { DeskStore } = require("./store/desk-store");
const {
  ProjectStore,
  suggestFileName,
  PROJECT_EXT,
  DESKTOP_EXT,
} = require("./store/project-store");
const memStore = require("./store/mem-store");
const { reseatImages } = require("./store/project-images");
const {
  rememberRecent,
  forgetRecent,
  sanitizeRecent,
} = require("./store/recent-files");
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

// ─── Appearance (light / dark) ────────────────────────────────────────────────
// ONE switch for the whole app: the `theme` setting ("system" | "light" |
// "dark") becomes Electron's `nativeTheme.themeSource`, and everything else
// follows from that — every renderer's `prefers-color-scheme` (so theme.css's
// light palette applies in the main window AND in every auxiliary window,
// with no per-window plumbing and no flash of the wrong palette), plus the
// native menus, dialogs, and scrollbars. The renderer never sets a theme
// attribute of its own; it only persists the choice, which lands here.
const THEME_SOURCES = new Set(["system", "light", "dark"]);

/** Apply a theme choice natively. Unknown/absent values mean "system". */
function applyThemeSource(theme) {
  nativeTheme.themeSource = THEME_SOURCES.has(theme) ? theme : "system";
}

/** The chrome colour a new window paints BEFORE its first frame, so a light
    app never flashes a dark rectangle (and vice-versa). Reads the resolved
    theme, i.e. the choice above layered over the OS preference. */
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#1c1c1c" : "#f4f4f4";
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
  if (!_deskStore) _deskStore = new DeskStore();
  return _deskStore;
}

let _projectStore = null;

/** @returns {ProjectStore} — projects and desktops are files; the app's own
    are kept in userData/saves until the user gives them a home. */
function getProjectStore() {
  if (!_projectStore) {
    _projectStore = new ProjectStore(app.getPath("userData"), getDeskStore());
  }
  return _projectStore;
}

// ─── Project files ────────────────────────────────────────────────────────────
// THE PROJECT IS THE DOCUMENT (store/project-store.js): ONE file holds every
// desktop and every programmed ROM's bytes. There are no companion files, so
// there is exactly one kind of path crossing this bridge — a project file,
// wherever the user saved it, or the app's own working slot until they do.
//
// The renderer must never be able to aim that path wherever it likes. Two
// rules keep it honest:
//
//   · anything inside the app's own saves folder is fair game (the app minted
//     it: the default project file);
//   · every other path must be one main itself ESTABLISHED this session —
//     returned by a native dialog, or drawn from the recent-projects list it
//     owns.
//
// So the renderer can only ever ask main to touch a file the user has already
// pointed at, exactly as `desk:write` once checked against the current file.
const PROJECT_FILTERS = [
  { name: "Chip Hippo Project", extensions: ["chiphippo"] },
];
// Export/Import fragments. `.desktop.chiphippo` is the shape written, but the
// dialog filter can only match the trailing extension — which also lets a
// loose `.chiphippo` design be imported as a desktop.
const DESKTOP_FILTERS = [
  { name: "Chip Hippo Desktop", extensions: ["chiphippo", "json"] },
];

/** Paths a dialog (or a project main opened) established this session. */
const establishedPaths = new Set();

/** Remember `filePath` as writable/readable for the rest of the session. */
function establishPath(filePath) {
  if (typeof filePath === "string" && filePath) {
    establishedPaths.add(path.resolve(filePath));
  }
  return filePath;
}

/**
 * Gate every renderer-named path (see the section note). Returns the resolved
 * path; throws INVALID_ARG for anything main has no business touching.
 */
function knownPath(filePath) {
  const store = getProjectStore();
  const resolved =
    typeof filePath === "string" && filePath ? path.resolve(filePath) : "";
  if (
    !resolved ||
    (!store.isInsideSaves(resolved) && !establishedPaths.has(resolved))
  ) {
    const err = new Error(`path was not established by a dialog: ${filePath}`);
    err.code = "INVALID_ARG";
    throw err;
  }
  return resolved;
}

// ── Most recently used PROJECTS ──────────────────────────────────────────────
// Every project the user saves or opens lands at the head of
// settings.recentProjects (store/recent-files.js caps it at 10 and
// de-duplicates). The list is both the Open Recent menu and the allowlist for
// `project:open-recent`. Desktops have no such list — a desktop is reached
// through the project that owns it.

/** The persisted MRU list, sanitized (never the frozen defaults array). */
function recentProjects() {
  return sanitizeRecent(
    safeCall("project:recent", () => getSettingsStore().get().recentProjects, []), // prettier-ignore
  );
}

/** Move `filePath` to the head of the MRU list. Returns the new list. */
function rememberProject(filePath) {
  const current = recentProjects();
  const next = rememberRecent(current, filePath);
  // The project file is written whenever its tab list changes (a rename, a
  // switch), so this runs often and usually changes nothing: leaving early
  // keeps that off settings.json and off the menu rebuild below.
  if (
    next.length === current.length &&
    next.every((p, i) => p === current[i])
  ) {
    return current;
  }
  safeCall("project:recent:remember", () =>
    getSettingsStore().set({ recentProjects: next }),
  );
  // File ▸ Open Recent is part of the menu template, so the list
  // changing means rebuilding it (a no-op before the menu is first installed).
  safeCall("project:recent:menu", () => refreshAppMenu());
  return next;
}

/** Drop `filePath` from the MRU list. Returns the new list. */
function forgetProject(filePath) {
  const next = forgetRecent(recentProjects(), filePath);
  safeCall("project:recent:forget", () =>
    getSettingsStore().set({ recentProjects: next }),
  );
  safeCall("project:recent:menu", () => refreshAppMenu());
  return next;
}

/**
 * THE STARTUP RULE. The app always opens onto a project:
 *
 *   ① the app's saves folder holds the fixed default project file → that is
 *     the session's project (it is the unsaved one, still without a name);
 *   ② otherwise the project was saved somewhere, so the most recent one that
 *     is still on disk opens;
 *   ③ otherwise (a first run, or every remembered project has gone) a brand-new
 *     project is created — blank name, blank location, one empty desktop.
 */
function bootProject() {
  const store = getProjectStore();
  store.ensureSaves();
  // First launch after the single-file redesign: the slot may still hold a v3
  // project pointing at desktop files. Inline it before anything looks for it.
  // Its warnings ride out on the meta below — the upgraded file cannot carry
  // them, so this is the only chance to tell the user a desktop came back
  // empty because its v3 file had already gone.
  const upgraded = safeCall("project:boot:upgrade", () =>
    store.upgradeLegacyDefault(),
  );
  if (store.hasDefaultProject()) {
    const meta = safeCall("project:boot", () =>
      store.read(store.defaultProjectPath),
    );
    if (meta) {
      establishPath(store.defaultProjectPath);
      if (upgraded?.length) meta.warnings = upgraded;
      return meta;
    }
  }
  for (const filePath of recentProjects()) {
    if (
      !safeCall("project:boot:exists", () => fs.existsSync(filePath), false)
    ) {
      continue;
    }
    const meta = safeCall("project:boot:recent", () => store.read(filePath));
    if (meta) {
      rememberProject(filePath);
      establishPath(filePath);
      return meta;
    }
  }
  establishPath(store.defaultProjectPath);
  return store.newProject();
}

/** Show the Open dialog for a PROJECT file; read it. Returns the meta|null. */
async function openProjectDialog() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const opts = {
    properties: ["openFile"],
    filters: PROJECT_FILTERS,
    defaultPath: getProjectStore().savesDir,
  };
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths?.[0]) return null;
  return adoptProject(path.resolve(result.filePaths[0]));
}

/**
 * Read a project file the user chose (a dialog, or the recent list) and make
 * it the session's project: it goes to the head of the MRU list, and the
 * working slot the project it replaces may have been living in is ABANDONED,
 * so the next launch opens THIS project rather than the one just left.
 *
 * (The renderer's guard has already offered to save that project; a project
 * that took the offer is no longer in the slot, so there is nothing here to
 * throw away.)
 *
 * A file that is NOT a project — a loose design, an exported desktop — opens
 * as a project of one desktop with no location, so Save As is what gives it a
 * home. It is therefore not remembered as a recent PROJECT.
 */
function adoptProject(filePath) {
  const store = getProjectStore();
  const meta = store.read(filePath);
  if (!meta) return null;
  if (meta.location) rememberProject(filePath);
  if (path.resolve(filePath) !== path.resolve(store.defaultProjectPath)) {
    safeCall("project:drop-default", () => store.removeDefaultProject());
  }
  establishPath(filePath);
  return meta;
}

/**
 * Open a project the user picked from the MRU menu — the one read of a
 * renderer-named path that no dialog mediated, so it is allowed ONLY for a
 * path already on the list. A file that has since been moved or deleted comes
 * back as `{ ok:false, code:"missing" }` so the renderer can offer to forget it.
 * @param {string} filePath
 */
function openRecentProject(filePath) {
  const wanted = typeof filePath === "string" ? path.resolve(filePath) : "";
  if (!wanted || !recentProjects().includes(wanted)) {
    return { ok: false, code: "unknown", error: "not a recent project" };
  }
  if (!safeCall("project:recent:exists", () => fs.existsSync(wanted), false)) {
    return { ok: false, code: "missing", error: "file not found" };
  }
  try {
    const project = adoptProject(wanted);
    if (!project) {
      return { ok: false, code: "error", error: "not a project file" };
    }
    return { ok: true, project };
  } catch (err) {
    return { ok: false, code: "error", error: err.message };
  }
}

/**
 * The Save-As location picker, for a project OR a desktop. It does NOT write
 * anything — it only settles on a path, which the renderer then saves to.
 *
 * Replacing an existing file is the NATIVE dialog's question, not ours: every
 * platform's own save panel asks it (`showOverwriteConfirmation` is how the
 * Linux one is told to), and a second prompt on top would be asking the user
 * the same thing twice. A cancelled replace simply comes back as a cancelled
 * dialog.
 *
 * The renderer passes a NAME, never a path — main composes the suggestion, so
 * path arithmetic stays on this side of the bridge:
 *
 *   · no current file, or one the APP minted (a GUID desktop, the default
 *     project file) → `<saves>/<name>.<kind>.chiphippo`. A GUID was never
 *     meant to be seen, so Save As offers the object's own name instead.
 *   · a file the user chose → that same file, as any Save As does.
 *
 * @param {"project"|"desktop"} kind - which extension/filter to offer.
 * @param {string} name - the project's / desktop's display name.
 * @param {string} [current] - the file it is saved in now, if any.
 * @returns {Promise<string|null>} the chosen path, or null when cancelled.
 */
async function chooseSavePath(kind, name, current) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const store = getProjectStore();
  const isProject = kind === "project";
  const ext = isProject ? PROJECT_EXT : DESKTOP_EXT;
  const from = typeof current === "string" && current ? path.resolve(current) : ""; // prettier-ignore
  // The working slot's file name was never meant to be seen, so a project
  // still living in it is offered its own name instead. An export has no
  // "current file" at all — it is always a fresh copy.
  const appKept = !from || from === path.resolve(store.defaultProjectPath);
  const defaultPath = appKept
    ? path.join(store.savesDir, suggestFileName(name, ext, isProject ? "project" : "desktop")) // prettier-ignore
    : from;
  const opts = {
    defaultPath,
    filters: isProject ? PROJECT_FILTERS : DESKTOP_FILTERS,
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };
  const result = win
    ? await dialog.showSaveDialog(win, opts)
    : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return null;
  return establishPath(path.resolve(result.filePath));
}

// ── Export / Import one desktop ──────────────────────────────────────────────
// A desktop is not a file any more, so moving one between projects (or between
// machines) is a SNAPSHOT: Export writes a self-contained
// `.desktop.chiphippo` — the document plus every programmed ROM's bytes — and
// Import reads one back as a new tab. There is no retained link either way, so
// unlike v3's desktop file a snapshot can never dangle.

/**
 * Export ONE desktop. Picks a path, then writes the snapshot.
 * @returns {Promise<{path: string}|null>} null when cancelled.
 */
async function exportDesktop({ name, description, doc }) {
  const chosen = await chooseSavePath("desktop", name, null);
  if (!chosen) return null;
  return { path: getProjectStore().writeDesktopSnapshot(chosen, { name, description, doc }) }; // prettier-ignore
}

/**
 * Import a desktop snapshot as a NEW desktop. Every memory chip on it is
 * reseated onto a fresh GUID and a fresh backing file (`reseatImages`), so
 * importing the same snapshot twice can never leave two chips sharing one
 * file — the reason Import is a copy and not a link.
 *
 * @returns {Promise<{name: string, description: string, doc: object}|null>}
 */
async function importDesktop() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const opts = { properties: ["openFile"], filters: DESKTOP_FILTERS };
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths?.[0]) return null;
  const filePath = establishPath(path.resolve(result.filePaths[0]));
  const snapshot = getProjectStore().readDesktopSnapshot(filePath);
  if (!snapshot) {
    throw Object.assign(new Error("that file holds no desktop"), {
      code: "INVALID_ARG",
    });
  }
  reseatImages(snapshot.doc, memoryDir(), snapshot.images);
  return {
    name: snapshot.name,
    description: snapshot.description,
    doc: snapshot.doc,
  };
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
// A part's "Pin Assignment" context-menu item opens a small, floating OS
// window rendering its DIP pinout (web/pinout.html) so it stays visible while
// the user wires. One window
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
    backgroundColor: windowBackground(),
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
  if (opts.kind === "wire") query.kind = "wire";
  if (datasheetPdfPath(ref)) query.pdf = "1";
  // The part's placed rotation, a snapshot as of THIS open — only an
  // oscillator can's pinout is rotation-dependent (pinout.js/chip-pinout.js
  // ignore it otherwise), but main has no catalog access to gate on that here.
  if ([0, 90, 180, 270].includes(opts.rot)) query.rot = String(opts.rot);
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
    // The dialog's filter offers "All files" too, so this can't rely on the
    // extension alone — every other path into a memory chip's image (create/
    // load/program/writeAll in mem-store.js) caps at MAX_BYTES; an unbounded
    // read here was the one exception, risking a hang/OOM on a large pick.
    const { size } = fs.statSync(filePath);
    if (size > memStore.MAX_BYTES) {
      return {
        ok: false,
        error: `file is too large (${size} bytes, max ${memStore.MAX_BYTES})`,
      };
    }
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
    backgroundColor: windowBackground(),
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

// ─── User guide (Feature 230) ───────────────────────────────────────────────────
// One Markdown source (src/web/docs/*.md) drives the in-app guide here, the
// hosted website (scripts/build-docs.mjs), and the PDF (scripts/build-pdf.mjs) —
// see docs-viewer.js's PAGES for the page list, kept in sync by hand with the
// copy in build-docs.mjs. The guide window is a true singleton (unlike pinout/
// memory, which are keyed per ref/component) and carries no document state, so
// it is NOT closed by closeAuxWindows() on New/Open — only when the app itself
// is shutting down.
let docsWindow = null;
const DOCS_DIR = path.join(__dirname, "..", "web", "docs");
const DOCS_SLUG_RE = /^[a-zA-Z0-9-]+$/;

/**
 * Read one guide page's raw Markdown by slug (e.g. "getting-started", or
 * "README" for the overview page). Two layers of validation, defense in
 * depth: a strict slug pattern (no dots/slashes possible) AND a path.relative
 * containment check, so no crafted slug can ever escape DOCS_DIR.
 */
function readDocsPage(slug) {
  if (typeof slug !== "string" || !DOCS_SLUG_RE.test(slug)) {
    throw new Error(`invalid docs page: ${slug}`);
  }
  const filePath = path.join(DOCS_DIR, `${slug}.md`);
  if (path.relative(DOCS_DIR, filePath).startsWith("..")) {
    throw new Error(`docs page outside docs dir: ${slug}`);
  }
  return fs.promises.readFile(filePath, "utf8");
}

/** Open (or focus) the singleton Chip Hippo User Guide window. */
function openDocsWindow() {
  if (docsWindow && !docsWindow.isDestroyed()) {
    docsWindow.show();
    docsWindow.focus();
    return true;
  }
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 560,
    minHeight: 400,
    // A reference window, not a floating aid — stays behind the main window
    // like the memory inspector, not always-on-top like a pinout diagram.
    backgroundColor: windowBackground(),
    icon: appIcon,
    title: "Chip Hippo User Guide",
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
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
  win.loadFile(path.join(__dirname, "..", "web", "docs.html")).catch(() => {});
  win.on("closed", () => {
    if (docsWindow === win) docsWindow = null;
  });
  docsWindow = win;
  return true;
}

// ─── Application menu ──────────────────────────────────────────────────────────
// The About and Settings items PUSH to the renderer (menu:show-about /
// menu:open-settings); the preload re-dispatches each as a chiphippo:* event
// and the renderer opens the corresponding PopupManager dialog. Everything
// else is a standard Electron role.
function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/** The last Undo/Redo availability the renderer reported (see
 *  setEditMenuState) — replayed whenever the menu is rebuilt, since a fresh
 *  template starts with both disabled. */
let editMenuState = { canUndo: false, canRedo: false };

/**
 * File ▸ Open Recent's items, from main's own MRU list. An empty
 * list still renders one (disabled) row rather than an empty card, matching
 * the renderer's `emptyLabel` menus.
 */
function recentProjectItems() {
  const items = recentProjects().map((filePath) => ({
    label: path.basename(filePath),
    toolTip: filePath,
    click: () => sendToMain("menu:project-open-recent", filePath),
  }));
  if (items.length === 0) {
    return [{ label: "No recent projects", enabled: false }];
  }
  return items;
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

  // FILE — the PROJECT, because the project IS the document now. One file
  // holds every desktop, so there is one New, one Open, one Save, one Save As,
  // and the two-level menu (a Project menu beside a File menu, running the
  // same four verbs at two levels) is gone with the second file. Same items,
  // same order, same wording as the toolbar's File pill, so the two can't
  // drift. Each is a one-way push: the renderer owns the open project, so it
  // is the only side that knows what is unsaved and what to ask about.
  //
  // Open Recent is baked into the template from main's own MRU list, so the
  // menu is rebuilt (refreshAppMenu) whenever that list changes; its click
  // carries the path, the one menu push with a payload.
  const fileItems = [
    {
      label: "New Project",
      accelerator: "CmdOrCtrl+N",
      click: () => sendToMain("menu:project-new"),
    },
    {
      label: "Open…",
      accelerator: "CmdOrCtrl+O",
      click: () => sendToMain("menu:project-open"),
    },
    { label: "Open Recent", submenu: recentProjectItems() },
    { type: "separator" },
    {
      label: "Save",
      accelerator: "CmdOrCtrl+S",
      click: () => sendToMain("menu:project-save"),
    },
    {
      label: "Save As…",
      accelerator: "CmdOrCtrl+Shift+S",
      click: () => sendToMain("menu:project-save-as"),
    },
    { type: "separator" },
    {
      label: "Project Properties…",
      click: () => sendToMain("menu:project-properties"),
    },
    { type: "separator" },
    {
      // The right-docked build guide (BOM / wiring list / assembly steps).
      // Read-only, so it stays available while the circuit runs.
      label: "Bill Of Materials…",
      accelerator: "CmdOrCtrl+B",
      click: () => sendToMain("menu:build-guide"),
    },
  ];

  // DESKTOP — structure INSIDE the open document, not file operations. Adding,
  // duplicating and deleting a desktop change the project the same way moving
  // a chip does: they are unsaved changes, and nothing reaches disk until the
  // project is saved. Export/Import are the interchange route a desktop's own
  // Save As / Open used to be — snapshots, with no link retained either way.
  // Every item acts on the ACTIVE desktop; the tab strip's context menu
  // mirrors them for a desktop that is not on screen.
  const desktopItems = [
    { label: "New Desktop", click: () => sendToMain("menu:desktop-add") },
    {
      label: "Duplicate Desktop",
      click: () => sendToMain("menu:desktop-duplicate"),
    },
    { type: "separator" },
    {
      label: "Import Desktop…",
      click: () => sendToMain("menu:desktop-import"),
    },
    {
      label: "Export Desktop…",
      click: () => sendToMain("menu:desktop-export"),
    },
    { type: "separator" },
    {
      label: "Desktop Properties…",
      click: () => sendToMain("menu:desktop-properties"),
    },
    {
      label: "Delete Desktop",
      click: () => sendToMain("menu:desktop-delete"),
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
    template.push({ label: "File", submenu: fileItems });
  } else {
    template.push({
      label: "File",
      submenu: [
        ...fileItems,
        { type: "separator" },
        settings,
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push({ label: "Desktop", submenu: desktopItems });

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
    ],
  });
  // View ▸ Toggle Developer Tools. A custom item (not the built-in role) so the
  // panel always docks along the BOTTOM of the window — matching the dev-launch
  // auto-open — and so the accelerator is the familiar Option+Cmd+I (Alt+Ctrl+I
  // off macOS). Targets the focused window, falling back to the main one.
  template.push({
    label: "View",
    submenu: [
      {
        label: "Toggle Developer Tools",
        accelerator: "Alt+CmdOrCtrl+I",
        click: (_item, focusedWindow) => {
          const win = focusedWindow || mainWindow;
          if (!win || win.isDestroyed()) return;
          const wc = win.webContents;
          if (wc.isDevToolsOpened()) wc.closeDevTools();
          else wc.openDevTools({ mode: "bottom" });
        },
      },
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
  const shortcuts = {
    label: "Keyboard Shortcuts",
    accelerator: "CmdOrCtrl+K",
    click: () => sendToMain("menu:keyboard-shortcuts"),
  };
  const userGuide = {
    label: "Chip Hippo User Guide",
    accelerator: "CmdOrCtrl+/",
    click: () => openDocsWindow(),
  };
  template.push({
    role: "help",
    submenu: isMac
      ? [userGuide, { type: "separator" }, shortcuts]
      : [
          userGuide,
          { type: "separator" },
          about,
          { type: "separator" },
          shortcuts,
        ],
  });

  return Menu.buildFromTemplate(template);
}

/**
 * Rebuild and install the application menu. File ▸ Open Recent is
 * baked into the template, so the MRU list changing means a whole new menu —
 * and a fresh template starts with Undo/Redo disabled, hence replaying the
 * edit state the renderer last reported.
 */
function refreshAppMenu() {
  Menu.setApplicationMenu(buildAppMenu());
  setEditMenuState(editMenuState);
}

/**
 * Enable/disable Edit ▸ Undo / Redo to match the renderer's history state
 * (Feature 200). The renderer is the authority — it pushes this whenever undo
 * availability changes.
 */
function setEditMenuState({ canUndo = false, canRedo = false } = {}) {
  editMenuState = { canUndo: Boolean(canUndo), canRedo: Boolean(canRedo) };
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

  // The renderer's answer to `app:confirm-close`: `true` to go ahead (it has
  // saved or discarded whatever was unsaved), `false` to stay. Resuming is
  // deferred to the next tick so this reply reaches the renderer before the
  // teardown it triggers.
  ipcMain.handle("app:close-reply", (_event, ok) => {
    closePending = false;
    if (!ok) {
      quitRequested = false; // a cancelled quit is not a pending one
      return false;
    }
    closeConfirmed = true;
    const quitting = quitRequested;
    setImmediate(() => {
      if (quitting) app.quit();
      else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });
    return true;
  });

  // App settings (Feature 10): the desk viewport + window bounds live here;
  // later stages add their own keys. Writes are atomic (store/io.js).
  ipcMain.handle("settings:get", () => getSettingsStore().get());
  ipcMain.handle("settings:set", (_event, patch) => {
    const next = getSettingsStore().set(patch);
    // Appearance is the one setting main itself acts on: `theme` becomes the
    // native theme source, which every window (and the native chrome) follows.
    if (patch && Object.hasOwn(patch, "theme")) applyThemeSource(next.theme);
    return next;
  });
  // Settings ▸ Data Sheets: pick the external datasheet-PDF folder (native
  // directory dialog); the renderer persists the chosen path via settings:set.
  ipcMain.handle("settings:choose-datasheet-dir", () => chooseDatasheetDir());

  // Projects: the session's project, and the one file it lives in. The
  // renderer holds the project — name, description, tabs, and every desktop's
  // document — and hands the whole thing back to be written; main owns the
  // saves folder, the dialogs, the recent list, the ROM images that travel in
  // the file, and — through `knownPath` — which paths may be touched at all.
  //
  // `project:boot` always answers with a project: the unsaved one in the saves
  // folder, else the most recent saved one, else a brand-new one.
  ipcMain.handle("project:boot", () => bootProject());
  ipcMain.handle("project:new", () => {
    const store = getProjectStore();
    establishPath(store.defaultProjectPath);
    return store.newProject();
  });
  ipcMain.handle("project:open", () => openProjectDialog());
  ipcMain.handle("project:open-recent", (_event, filePath) =>
    openRecentProject(filePath),
  );
  // Write the project file, WHOLE — every desktop's document, and every
  // programmed ROM's bytes collected out of the memory cache. `filePath` null
  // means "it has no location yet" → the fixed default project file, the
  // working slot startup looks in first. `dropDefault` is the other half of
  // Save As: a project that HAD no location and now has a real one leaves that
  // slot empty.
  ipcMain.handle("project:save", (_event, meta, filePath, dropDefault) => {
    const store = getProjectStore();
    const target = filePath ? knownPath(filePath) : store.defaultProjectPath;
    store.write(target, meta);
    if (filePath) {
      rememberProject(target);
      if (
        dropDefault === true &&
        target !== path.resolve(store.defaultProjectPath)
      ) {
        // prettier-ignore
        safeCall("project:save:drop-default", () =>
          store.removeDefaultProject(),
        );
      }
    }
    return { ok: true, path: target };
  });
  // The Save-As location picker for a project or a desktop export — it chooses
  // a path, it does not write. Replacing an existing file is the native
  // dialog's own question; declining it reads back as a plain cancel.
  ipcMain.handle("project:choose-path", (_event, kind, name, current) =>
    chooseSavePath(kind, name, current),
  );

  // Desktops move between projects as SNAPSHOTS, never as links: export writes
  // a self-contained `.desktop.chiphippo`, import reads one back, and both
  // copies (import and duplicate) get their own freshly minted ROM guids and
  // backing files so no two chips can ever share one.
  ipcMain.handle("desktop:export", (_event, desktop) =>
    exportDesktop(desktop ?? {}),
  );
  ipcMain.handle("desktop:import", () => importDesktop());
  ipcMain.handle("desktop:duplicate", (_event, doc) => {
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw Object.assign(new Error("a desktop needs a document"), {
        code: "INVALID_ARG",
      });
    }
    reseatImages(doc, memoryDir(), null);
    return { doc };
  });

  // Most recently used PROJECTS (File ▸ Open Recent): the list, and one
  // entry forgotten (its × / the "that file is gone" prompt). Opening one goes
  // through `project:open-recent` above, which allowlists against this list.
  ipcMain.handle("project:recent:list", () => recentProjects());
  ipcMain.handle("project:recent:remove", (_event, filePath) =>
    forgetProject(typeof filePath === "string" ? path.resolve(filePath) : ""),
  );
  // Switching tabs replaces the whole desk, which orphans the auxiliary
  // windows exactly as New/Open does — a pinout or memory inspector would be
  // pointing at a chip that is no longer on the desk (worse, an inspector's
  // Save would write a `.bin` for a chip on another desktop).
  ipcMain.handle("project:closed-aux", () => {
    closeAuxWindows();
    return true;
  });

  // Chip pin-assignments window (Feature 100): a part's "Pin Assignment"
  // context-menu item opens a separate floating OS window rendering its
  // pinout as a wiring reference.
  ipcMain.handle("pinout:open", (_event, ref, opts) =>
    openPinoutWindow(ref, opts),
  );

  // Open a part's external datasheet PDF from the configured folder (Settings ▸
  // Data Sheets) in the OS PDF viewer. Requested by the pinout window's
  // "open datasheet" button; a no-op (returns false) when no PDF is on file.
  ipcMain.handle("datasheet:open", (_event, ref) => openDatasheetPdf(ref));

  // User guide (Feature 230): the docs window fetches one Markdown page's raw
  // source at a time by slug — never the filesystem path, never fetch().
  ipcMain.handle("docs:read", (_event, slug) => readDocsPage(slug));

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
    const watcher = fs.watch(webDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
      }, 120);
    });
    // Otherwise this FSWatcher outlives the window it was watching for.
    win.once("closed", () => {
      clearTimeout(timer);
      watcher.close();
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
    backgroundColor: windowBackground(), // --color-base of the live theme
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

  // Closing the window loses every desktop that is only in the renderer, so
  // ask first (see the close/quit guard above). `before-quit` covers ⌘Q; this
  // covers the window's own button, and on macOS the two are not the same
  // event at all.
  win.on("close", (event) => {
    if (closeConfirmed || !canAskRenderer(win)) return;
    event.preventDefault();
    askBeforeClose(win);
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // Close the orphaned pinout/inspector windows so they don't outlive the
    // desk they belong to — and, on Windows/Linux, so `window-all-closed` can
    // actually fire and quit the app instead of hanging on a stray inspector.
    closeAuxWindows();
    // The guide carries no document state (unlike pinout/inspector windows),
    // so it survives New/Open — but it must not outlive the app itself.
    if (docsWindow && !docsWindow.isDestroyed()) docsWindow.close();
  });

  if (isDev || isDevTools) win.webContents.openDevTools({ mode: "bottom" });
  if (isHotReload) installHotReload(win);

  mainWindow = win;
  return win;
}

// ─── Close / quit guard ───────────────────────────────────────────────────────
// Main owns the lifecycle; the RENDERER owns the unsaved state and the dialog
// that asks about it (`chiphippo:confirm-close` → `app:close-reply`). So a
// close or a quit is prevented ONCE, the renderer is asked, and the answer
// resumes or abandons it. A project is written deliberately (⌘S), never
// autosaved, so this is the only thing standing between an unsaved design and
// the window going away.
//
// There is deliberately NO timeout on the answer: the user may sit on that
// dialog for as long as they like, and an app that quits out from under a
// question is worse than one that waits. If the renderer is gone or crashed
// there is nobody to ask, so the close simply proceeds.

/** The renderer has answered "yes, go" — the next close/quit is let through. */
let closeConfirmed = false;

/** A question is already out; a second close must not stack another dialog. */
let closePending = false;

/** The close came from a QUIT (⌘Q / menu), not from the window's own button. */
let quitRequested = false;

/** Is there a live renderer to put the question to? */
function canAskRenderer(win) {
  return Boolean(
    win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed(), // prettier-ignore
  );
}

/** Put the question to the renderer (once). */
function askBeforeClose(win) {
  if (closePending) return;
  closePending = true;
  win.webContents.send("app:confirm-close");
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
    // Before the first window exists, so it opens already in the right
    // palette rather than repainting into it.
    applyThemeSource(
      safeCall(
        "settings:theme",
        () => getSettingsStore().get().theme,
        "system",
      ),
    );
    refreshAppMenu();
    createWindow();

    app.on("activate", () => {
      // macOS: clicking the dock re-shows (or recreates) the window.
      showWindow();
    });
  });

  // ⌘Q / Quit. Prevented BEFORE any window starts closing, so answering "no"
  // leaves the app exactly as it was rather than half torn down (the auxiliary
  // windows close in the same sequence).
  app.on("before-quit", (event) => {
    if (closeConfirmed || !canAskRenderer(mainWindow)) return;
    event.preventDefault();
    quitRequested = true;
    askBeforeClose(mainWindow);
  });

  // Chip Hippo is a foreground document app: closing the last window quits
  // (the normal Electron default), except on macOS where the app stays active
  // in the dock until an explicit Quit.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
