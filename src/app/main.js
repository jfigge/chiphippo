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
  safeStorage,
  screen,
  shell,
} = require("electron");
const path = require("path");
const fs = require("fs");

const { parseArgs } = require("./cli-args");
const { CloseGuard } = require("./close-guard");
const i18n = require("./i18n");
const updater = require("./updater");
const { isStoreBuild, distribution } = require("./store-build");
const { CredentialStore } = require("./store/credential-store");
const aiClient = require("./ai/client");
const aiProviders = require("./ai/providers");
const { SettingsStore } = require("./store/settings-store");
const { DeskStore } = require("./store/desk-store");
const {
  ProjectStore,
  suggestFileName,
  nameFromFile,
  PROJECT_EXT,
  DESKTOP_EXT,
} = require("./store/project-store");
const memStore = require("./store/mem-store");
const datasheetDownload = require("./datasheets/download");
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
    // Which channel produced this build — "store" for a Mac App Store package
    // (which updates itself through the store), "direct" for a download from
    // chiphippo.com. It rides here rather than on a bridge flag of its own
    // because main is where `process.mas` is unambiguously true, and because
    // Settings ▸ About already asks for this object before it draws anything.
    distribution: distribution(),
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

// ─── Language ─────────────────────────────────────────────────────────────────
// Main resolves the active locale for the WHOLE app (app/i18n.js): it owns the
// filesystem the catalogs live on and the OS locale they default from, and every
// window is served from file:// under a CSP that forbids fetching anything — so
// this is the only route a catalog can travel. Each renderer asks once, at
// startup, over `i18n:load`.
//
// Main also renders user-facing text ITSELF in three places no renderer's t()
// can reach — the application menu, the native dialogs' file-type filters, and
// each auxiliary window's title bar — so it keeps the resolved catalog to hand
// and reads those through `m()`.
//
// The payload is CACHED because the menu is rebuilt on every recent-list change
// and each rebuild reads ~30 labels; `settings:set` drops the cache when the
// preference moves, which is also what makes a language change reach the menu
// bar with no restart.
let _catalog = null;

/** The active catalog payload (settings.locale → OS locale → English). */
function activeCatalog() {
  if (!_catalog) {
    let requested = "system";
    try {
      requested = getSettingsStore().get().locale ?? "system";
    } catch {
      // A settings read that fails must not take the menu bar with it.
    }
    _catalog = i18n.loadCatalog({
      requested,
      systemLocale: app.getLocale?.() ?? "en",
    });
  }
  return _catalog;
}

/**
 * A native-UI label: the active catalog's string for `key`, falling back to the
 * English catalog and then to `fallback`. Every user-facing literal main renders
 * goes through this — `app/tests/no-hardcoded-native-strings.test.js` is what
 * keeps it that way.
 * @param {string} key
 * @param {string} fallback
 * @param {object} [params]
 * @returns {string}
 */
function m(key, fallback, params) {
  return i18n.label(activeCatalog(), key, fallback, params);
}

/**
 * Forget the resolved catalog and re-render everything main drew with it. Called
 * when `settings.locale` changes: the MENU BAR is the visible half (it is built
 * from `m()` calls), and an already-open auxiliary window keeps the title it was
 * given — retitling a window whose CONTENT is a pin map is not worth a second
 * bookkeeping path, and the next one it opens is correct.
 */
function reloadCatalog() {
  _catalog = null;
  refreshAppMenu();
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

let _credentialStore = null;

/** @returns {CredentialStore} — the user's own AI key, OS-encrypted. */
function getCredentialStore() {
  if (!_credentialStore) {
    _credentialStore = new CredentialStore(
      app.getPath("userData"),
      safeStorage,
    );
  }
  return _credentialStore;
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
//
// The filter NAMES are shown in the dialog's file-type dropdown, so they are
// localized — which is why these are functions rather than the module-level
// constants they used to be: a `const` is evaluated at require time, long before
// `app` is ready and the settings store can say which language to speak.
const projectFilters = () => [
  { name: m("dialog.filter.project", "Chip Hippo Project"), extensions: ["chiphippo"] }, // prettier-ignore
];
// Export/Import fragments. `.desktop.chiphippo` is the shape written, but the
// dialog filter can only match the trailing extension — which also lets a
// loose `.chiphippo` design be imported as a desktop.
const desktopFilters = () => [
  { name: m("dialog.filter.desktop", "Chip Hippo Desktop"), extensions: ["chiphippo", "json"] }, // prettier-ignore
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
 * A stamped working slot was found: the last session did not finish. RESTORE it
 * — and say so — rather than asking.
 *
 * There is deliberately no "restore or discard?" question at launch, and the
 * reason is that the answer costs nothing either way. Restored work arrives
 * UNSAVED (`restored` below), so the • is showing and every existing route back
 * still works: ⌘Z, or closing without saving, which under this design really
 * does return the file to what it held. A modal in front of the user's own desk
 * would be asking them to make an irreversible-looking choice about a reversible
 * thing, with the destructive button one mis-click away.
 *
 * The one variable is whether the file it belongs to is still there:
 *   · present → restore, and the project keeps that file as its home;
 *   · gone (moved, deleted, an unplugged volume) → restore as an UNTITLED
 *     project, so Save As is what re-homes it. Better an unhomed copy of the
 *     work than nothing.
 * Either way the warning names what happened, because the alternative is a
 * desk that silently disagrees with the file the title bar points at.
 *
 * @returns {object|null} the meta to boot onto, or null if the slot is unreadable.
 */
function recoveryBoot(peeked, upgraded) {
  const store = getProjectStore();
  const target = peeked.recoveryFor;
  const meta = safeCall("project:boot:recovery", () =>
    store.read(store.defaultProjectPath),
  );
  if (!meta) return null;
  establishPath(store.defaultProjectPath);
  const name = peeked.name || nameFromFile(target);
  const exists = safeCall("project:boot:recovery-stat", () =>
    fs.existsSync(target), false); // prettier-ignore
  if (exists) {
    // `read` reports no location for the slot — true of the FILE it read, but
    // the point of a recovery is that it belongs to another one.
    meta.location = path.resolve(target);
    rememberProject(target);
    establishPath(target);
  } else {
    meta.location = null; // no home any more; Save As is the way back
  }
  // The FACTS, not the sentence. The notice is shown by the renderer, which is
  // where `t()` and the dialog both live — main's own `m()` is for text main
  // renders itself (the menu bar, window titles, native dialog filters), and a
  // message crossing the bridge to be displayed is not that.
  meta.restored = { name, path: target, homeless: !exists };
  if (upgraded?.length) {
    meta.warnings = [...upgraded, ...(meta.warnings ?? [])];
  }
  return meta;
}

/**
 * THE STARTUP RULE. The app always opens onto a project:
 *
 *   ① the app's saves folder holds the fixed default project file → that is
 *     the session's project (it is the unsaved one, still without a name), or,
 *     when it is STAMPED as a recovery copy, the project it belongs to plus an
 *     offer to restore it (see `recoveryBoot`);
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
  // A RECOVERY copy in the slot means we went away without finishing (a save
  // and a clean quit both drop it). Peek rather than read: the renderer has to
  // be able to ASK before anything is hydrated, or a recovery the user then
  // discards would already have overwritten the real project's ROM files.
  const peeked = safeCall("project:boot:peek", () => store.peekRecovery());
  if (peeked?.recoveryFor) {
    const recovered = recoveryBoot(peeked, upgraded);
    if (recovered) return recovered;
    // Its own file has gone AND the recovery is unreadable: nothing to offer.
    safeCall("project:boot:recovery-drop", () => store.removeDefaultProject());
  } else if (store.hasDefaultProject()) {
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
    filters: projectFilters(),
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
    filters: isProject ? projectFilters() : desktopFilters(),
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
  const opts = { properties: ["openFile"], filters: desktopFilters() };
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

// ── Downloading the datasheets ────────────────────────────────────────────────
// Settings ▸ Data Sheets ▸ Download fetches the PDFs named by
// datasheets/sources.js into the app's OWN folder under userData, then the
// renderer points `datasheetDir` at it. The folder is app-owned rather than
// user-chosen deliberately: the download replaces what it finds, and a button
// that overwrites files must only ever be pointed at a directory the app made.
// A user who keeps their own collection elsewhere still has Browse…, and the
// setting is a plain path either way — nothing downstream knows or cares which
// of the two it came from.

/** The folder the Download button fills (a sibling of memory/ under userData). */
function datasheetDir() {
  return path.join(app.getPath("userData"), "datasheets");
}

/** The run in flight, or null. One at a time: a second press while the first
    is going would race two writers onto the same files. */
let datasheetRun = null;

/**
 * Download every datasheet in the table, pushing `datasheet:progress` to the
 * asking window as each lands. Resolves with the run's summary.
 */
async function startDatasheetDownload(sender) {
  if (datasheetRun)
    return { ok: false, error: "a download is already running" };
  const controller = new AbortController();
  datasheetRun = { controller };
  const send = (payload) => {
    if (sender && !sender.isDestroyed())
      sender.send("datasheet:progress", payload);
  };
  try {
    return await datasheetDownload.downloadAll({
      dir: datasheetDir(),
      signal: controller.signal,
      onProgress: send,
    });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    datasheetRun = null;
  }
}

/** Stop the run in flight. Returns whether there was one to stop. */
function cancelDatasheetDownload() {
  if (!datasheetRun) return false;
  datasheetRun.controller.abort();
  return true;
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
// The narrowest a pin-assignments window may be dragged — every one of them,
// whatever it lists. Below this the pin rows stop reading as rows (see the
// window's own sizing below).
const PINOUT_MIN_WIDTH = 500;

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
  // Parts with a committed datasheet crop (web/datasheets/<sheet>.png) get a
  // wider, taller default window so the diagram + truth table are legible
  // without an immediate resize; it stays freely resizable.
  //
  // The crop is named by the CATALOG, which is the renderer's (`sheet`) — the
  // ref for nearly every part, but not always: both character-LCD modules show
  // the ONE controller sheet, HD44780. Validated exactly like a ref, since it
  // becomes a path here; anything else falls back to the ref, which is what
  // every caller predating this sent.
  const sheet =
    typeof opts.sheet === "string" && PINOUT_REF_RE.test(opts.sheet)
      ? opts.sheet
      : ref;
  const hasDatasheet = fs.existsSync(
    path.join(__dirname, "..", "web", "datasheets", `${sheet}.png`),
  );
  // PINOUT_MIN_WIDTH is the floor for every pinout window, crop or no crop, and
  // the plain default sits ON it: a pin line is `badge · name · role` against a
  // right-aligned detail, so a window narrow enough to wrap that reads as two
  // unrelated columns rather than one row.
  const win = new BrowserWindow({
    width: hasDatasheet ? 640 : PINOUT_MIN_WIDTH,
    height: 150 + rows * 30 + (hasDatasheet ? 430 : 0),
    minWidth: PINOUT_MIN_WIDTH,
    minHeight: 220,
    alwaysOnTop: pinoutFloatPref(),
    backgroundColor: windowBackground(),
    icon: appIcon,
    title: m("window.pinout", "Pin assignments"),
    fullscreenable: false,
    webPreferences: {
      // The pinout page is otherwise bridge-free, but it needs the narrow
      // window.chiphippo surface for its two header buttons: opening a part's
      // external datasheet PDF (datasheet:open) when the user has a datasheet
      // folder configured, and importing its example circuit (demo:open).
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // When the user's datasheet folder holds a `<ref>.pdf`, tell the page to show
  // the "open datasheet" button (it invokes datasheet:open back into main); and
  // when this part has a bundled example circuit, the button that imports it.
  // Both are settled HERE, once, because the window is cached per ref — for the
  // PDF that means a datasheet folder changed mid-session leaves an open window
  // stale, but the example flag cannot go stale at all: web/demos/ is inside the
  // app bundle and does not change while the app runs.
  const query = { ref };
  if (opts.kind === "wire") query.kind = "wire";
  if (datasheetPdfPath(ref)) query.pdf = "1";
  if (demoDocPath(ref)) query.demo = "1";
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

// ─── Example circuits (Feature 270) ───────────────────────────────────────────
// `make demos` builds a demonstration bench for every benchable 74xx part and
// ships one document per part as web/demos/<ref>.json — the SAME desktop the
// group project in demos/ holds, written in the same pass. A pin-assignments
// window offers to open its part's example as a desktop of its own.
//
// TWO channels, because there are two windows and only one of them can use the
// bytes. A PINOUT window has a ref and nothing else — no project, no desk — so
// it asks (`demo:open`) and main RELAYS the request to the app window, the way
// a memory inspector reaches its host below. The APP window then READS the
// document (`demo:read`) itself. So the document crosses the bridge exactly
// once, into the window that is going to hold it.
const DEMOS_DIR = path.join(__dirname, "..", "web", "demos");

/**
 * Absolute path to a part's bundled example circuit, or null when it has none —
 * the Memory/Interface chips (a RAM or a CPU cannot be demonstrated by flipping
 * switches at it), every discrete, every brick, and a wire. Two layers of
 * validation as `readDocsPage` has: the ref pattern forbids a dot or a
 * separator outright, AND the resolved path is proved to be inside DEMOS_DIR.
 */
function demoDocPath(ref) {
  if (typeof ref !== "string" || !PINOUT_REF_RE.test(ref)) return null;
  const file = path.join(DEMOS_DIR, `${ref}.json`);
  if (path.relative(DEMOS_DIR, file).startsWith("..")) return null;
  return safeCall("demo:exists", () => fs.existsSync(file), false)
    ? file
    : null;
}

/**
 * One example circuit's payload (`{ ref, title, doc }`), or null when the part
 * has none. The document is handed over VERBATIM: it is first-party, built by
 * the same tree that ships it, and main deliberately keeps its document
 * knowledge to migrations.js and project-images.js — the renderer canonicalizes
 * it through DeskDoc on the way in, exactly as it does every desktop that
 * arrives from a file. A corrupt file throws, which reaches the renderer as a
 * rejected invoke and is reported there.
 */
async function readDemoDoc(ref) {
  const file = demoDocPath(ref);
  if (!file) return null;
  return JSON.parse(await fs.promises.readFile(file, "utf8"));
}

/**
 * A pinout window asking for its part's example. Main answers only "yes, that
 * exists" and pushes the ref to the app window; it never carries the document.
 * The app window is raised first — the click came from a small, always-on-top
 * reference window sitting over the very desk the new desktop appears on.
 */
function requestDemoImport(ref) {
  if (!demoDocPath(ref)) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendToMain("demo:host-inbound", { ref });
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
      { name: m("dialog.filter.memImage", "Memory image"), extensions: ["bin", "hex", "rom", "dat"] }, // prettier-ignore
      { name: m("dialog.filter.allFiles", "All files"), extensions: ["*"] },
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
      { name: m("dialog.filter.binImage", "Binary image"), extensions: ["bin"] }, // prettier-ignore
      { name: m("dialog.filter.intelHex", "Intel HEX"), extensions: ["hex"] },
      { name: m("dialog.filter.allFiles", "All files"), extensions: ["*"] },
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
    title: m("window.memory", "Memory inspector"),
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
    // The same key the Help menu item uses, so the title bar and the item that
    // opened it always read alike.
    title: m("menu.help.userGuide", "Chip Hippo User Guide"),
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

/** The last Desktop-menu availability the renderer reported (see
 *  setDesktopMenuState). Replayed on a rebuild for the same reason. The
 *  template's own defaults are the PERMISSIVE ones — a project always has at
 *  least one desktop to act on, and the renderer corrects this the moment it
 *  knows better. */
let desktopMenuState = { canDelete: true, canDuplicate: true };

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
    return [
      { label: m("menu.file.noRecent", "No recent projects"), enabled: false },
    ];
  }
  return items;
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const about = {
    label: m("menu.app.about", "About Chip Hippo"),
    click: () => sendToMain("menu:show-about"),
  };
  const settings = {
    label: m("menu.app.settings", "Settings…"),
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
      label: m("menu.file.new", "New Project"),
      accelerator: "CmdOrCtrl+N",
      click: () => sendToMain("menu:project-new"),
    },
    {
      label: m("menu.file.open", "Open…"),
      accelerator: "CmdOrCtrl+O",
      click: () => sendToMain("menu:project-open"),
    },
    {
      label: m("menu.file.openRecent", "Open Recent"),
      submenu: recentProjectItems(),
    },
    { type: "separator" },
    {
      label: m("menu.file.save", "Save"),
      accelerator: "CmdOrCtrl+S",
      click: () => sendToMain("menu:project-save"),
    },
    {
      label: m("menu.file.saveAs", "Save As…"),
      accelerator: "CmdOrCtrl+Shift+S",
      click: () => sendToMain("menu:project-save-as"),
    },
    { type: "separator" },
    {
      label: m("menu.file.properties", "Project Properties…"),
      click: () => sendToMain("menu:project-properties"),
    },
    { type: "separator" },
    {
      // The right-docked build guide (BOM / wiring list / assembly steps).
      // Read-only, so it stays available while the circuit runs.
      label: m("menu.file.bom", "Bill Of Materials…"),
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
  //
  // Two of them are not always available, and the tab strip disables exactly
  // the same two — so they carry ids and take their enabled state from the
  // renderer over `menu:desktop-state`, the way Edit ▸ Undo/Redo does. Without
  // that the menu would offer what the strip forbids, and a menu item that
  // silently does nothing is worse than one that is greyed out.
  const desktopItems = [
    {
      label: m("menu.desktop.new", "New Desktop"),
      click: () => sendToMain("menu:desktop-add"),
    },
    {
      id: "desktop-duplicate",
      label: m("menu.desktop.duplicate", "Duplicate Desktop"),
      click: () => sendToMain("menu:desktop-duplicate"),
    },
    { type: "separator" },
    {
      label: m("menu.desktop.import", "Import Desktop…"),
      click: () => sendToMain("menu:desktop-import"),
    },
    {
      label: m("menu.desktop.export", "Export Desktop…"),
      click: () => sendToMain("menu:desktop-export"),
    },
    { type: "separator" },
    {
      label: m("menu.desktop.properties", "Desktop Properties…"),
      click: () => sendToMain("menu:desktop-properties"),
    },
    {
      id: "desktop-delete",
      label: m("menu.desktop.delete", "Delete Desktop"),
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
    template.push({ label: m("menu.file.title", "File"), submenu: fileItems });
  } else {
    template.push({
      label: m("menu.file.title", "File"),
      submenu: [
        ...fileItems,
        { type: "separator" },
        settings,
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }
  template.push({
    label: m("menu.desktop.title", "Desktop"),
    submenu: desktopItems,
  });

  // Undo / Redo drive the DOCUMENT history (Feature 200), not text-field
  // editing — each pushes to the renderer, which owns the snapshot stack and
  // reports availability back over menu:edit-state (see setEditMenuState). They
  // start disabled; the renderer enables them once there is something to do.
  // Select All is the same shape and for the same reason (see its own note):
  // what "everything" means depends on where the focus is, and only the
  // renderer knows. Cut/Copy/Paste stay native roles — text is text.
  template.push({
    label: m("menu.edit.title", "Edit"),
    submenu: [
      {
        id: "edit-undo",
        label: m("menu.edit.undo", "Undo"),
        accelerator: "CmdOrCtrl+Z",
        enabled: false,
        click: () => sendToMain("menu:edit-undo"),
      },
      {
        id: "edit-redo",
        label: m("menu.edit.redo", "Redo"),
        accelerator: "Shift+CmdOrCtrl+Z",
        enabled: false,
        click: () => sendToMain("menu:edit-redo"),
      },
      { type: "separator" },
      // Cut / Copy / Paste stay native ROLES: Electron supplies the OS's own
      // localized label for each, which is better than anything this catalog
      // could say — they are the platform's words, not the app's.
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { type: "separator" },
      {
        // NOT `role: "selectAll"`: on the desk, "everything" means every
        // board, part and wire — a selection the renderer owns — and the
        // native role would instead run the DOM's own select-all and
        // highlight the page. So it pushes, and the renderer decides from
        // where the focus is: a text field selects its text, the desk selects
        // its contents.
        //
        // An AUXILIARY window (pinout, memory inspector, docs) has no desk and
        // no listener, so there the native command is exactly right — and it
        // must go to THAT window, not the main one `sendToMain` would reach.
        label: m("menu.edit.selectAll", "Select All"),
        accelerator: "CmdOrCtrl+A",
        click: (_item, focusedWindow) => {
          if (focusedWindow && focusedWindow !== mainWindow) {
            focusedWindow.webContents.selectAll();
            return;
          }
          sendToMain("menu:edit-select-all");
        },
      },
    ],
  });
  // View ▸ Toggle Developer Tools. A custom item (not the built-in role) so the
  // panel always docks along the BOTTOM of the window — matching the dev-launch
  // auto-open — and so the accelerator is the familiar Option+Cmd+I (Alt+Ctrl+I
  // off macOS). Targets the focused window, falling back to the main one.
  template.push({
    label: m("menu.view.title", "View"),
    submenu: [
      {
        label: m("menu.view.devTools", "Toggle Developer Tools"),
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
    label: m("menu.window.title", "Window"),
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      { role: "close" },
      ...(isMac ? [{ type: "separator" }, { role: "front" }] : []),
    ],
  });
  const shortcuts = {
    label: m("menu.help.shortcuts", "Keyboard Shortcuts"),
    accelerator: "CmdOrCtrl+K",
    click: () => sendToMain("menu:keyboard-shortcuts"),
  };
  // The guide itself is English-only (one Markdown source drives the in-app
  // viewer, the website and the PDF), so the ITEM is localized but the pages it
  // opens are not — see CLAUDE.md's "User guide & docs".
  const userGuide = {
    label: m("menu.help.userGuide", "Chip Hippo User Guide"),
    accelerator: "CmdOrCtrl+/",
    click: () => openDocsWindow(),
  };
  // On-demand update check. Triggered directly here — the updater pushes its
  // result to the renderer, which owns the toast and the About status line, so
  // this needs no round trip through the window. OMITTED ENTIRELY in a store
  // build: the App Store delivers its own updates and the in-app updater is
  // disabled, and a menu item that can only ever answer "not from here" is
  // worse than no menu item (see store-build.js).
  const checkUpdates = isStoreBuild()
    ? []
    : [
        {
          label: m("menu.help.checkUpdates", "Check for Updates…"),
          click: () => updater.checkForUpdates({ manual: true }),
        },
      ];
  // A separator only where there is something under it to separate — in a
  // store build the whole tail is gone, and a menu must not end on a rule.
  const updateItems = checkUpdates.length
    ? [{ type: "separator" }, ...checkUpdates]
    : [];
  template.push({
    // The ROLE stays (on macOS it is what gives the menu its Help-search
    // integration), but the label is ours: Electron localizes a role's own title
    // from the OS language, which is independent of `settings.locale` — so
    // without this the bar reads German with one English title in it.
    role: "help",
    label: m("menu.help.title", "Help"),
    submenu: isMac
      ? [userGuide, { type: "separator" }, shortcuts, ...updateItems]
      : [
          userGuide,
          { type: "separator" },
          about,
          { type: "separator" },
          shortcuts,
          ...updateItems,
        ],
  });

  return Menu.buildFromTemplate(template);
}

/**
 * Rebuild and install the application menu. File ▸ Open Recent is
 * baked into the template, so the MRU list changing means a whole new menu —
 * and a fresh template starts from its own defaults, hence replaying both
 * states the renderer last reported.
 */
function refreshAppMenu() {
  Menu.setApplicationMenu(buildAppMenu());
  setEditMenuState(editMenuState);
  setDesktopMenuState(desktopMenuState);
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

/**
 * Enable/disable the two Desktop items that are not always available, so the
 * menu bar and the tab strip say the SAME thing about them:
 *
 *   · Delete Desktop — off on the last remaining desktop (a project cannot run
 *     out of them);
 *   · Duplicate Desktop — off while the circuit runs (editing is frozen).
 *
 * The renderer is the authority, exactly as it is for Undo/Redo: it owns the
 * tab set and the run lock and pushes this whenever either changes.
 */
function setDesktopMenuState({ canDelete = true, canDuplicate = true } = {}) {
  desktopMenuState = {
    canDelete: Boolean(canDelete),
    canDuplicate: Boolean(canDuplicate),
  };
  const menu = Menu.getApplicationMenu();
  const del = menu?.getMenuItemById("desktop-delete");
  const dup = menu?.getMenuItemById("desktop-duplicate");
  if (del) del.enabled = desktopMenuState.canDelete;
  if (dup) dup.enabled = desktopMenuState.canDuplicate;
}

/** The native right-click menu for a pinout window (float toggle + close). */
function showPinoutMenu(win) {
  const floating = win.isAlwaysOnTop();
  Menu.buildFromTemplate([
    {
      label: m("menu.pinout.float", "Float above other windows"),
      type: "checkbox",
      checked: floating,
      click: () => setPinoutFloat(!floating),
    },
    { type: "separator" },
    { label: m("menu.pinout.close", "Close window"), role: "close" },
  ]).popup({ window: win });
}

/**
 * Push the chosen UI text size to every window BUT the one that asked for it.
 * Settings ▸ Appearance ▸ Editor font size is one thing the whole app agrees
 * on, like the theme — but the theme rides `nativeTheme.themeSource` and this
 * has no such native mechanism, so it is a plain fan-out.
 *
 * The sender is skipped because it applied the size the moment it emitted the
 * patch; telling it again would only be a second path to the same pixel.
 * `getAllWindows` rather than the pinout/memory/docs registries, so a window
 * type added later follows for free.
 */
function broadcastFontSize(size, sender) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents === sender) continue;
    win.webContents.send("settings:font-size", { size });
  }
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
    const next = closeGuard.reply(ok);
    if (next === "stay") return false;
    setImmediate(() => {
      if (next === "quit") app.quit();
      else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    });
    return true;
  });

  // App settings (Feature 10): the desk viewport + window bounds live here;
  // later stages add their own keys. Writes are atomic (store/io.js).
  ipcMain.handle("settings:get", () => getSettingsStore().get());
  ipcMain.handle("settings:set", (event, patch) => {
    const next = getSettingsStore().set(patch);
    // Appearance holds the three settings main itself acts on. `theme` becomes
    // the native theme source, which every window (and the native chrome)
    // follows; `locale` decides which catalog main answers `i18n:load` with AND
    // which language its own menu bar speaks, so a change re-resolves both.
    if (patch && Object.hasOwn(patch, "theme")) applyThemeSource(next.theme);
    if (patch && Object.hasOwn(patch, "locale")) reloadCatalog();
    // `fontSize` is the third, and the only one with nothing native to ride:
    // there is no font-size equivalent of `nativeTheme.themeSource`, so main
    // fans it out by hand. Doing it HERE rather than in the renderer means
    // whichever window writes the key, every window follows.
    if (patch && Object.hasOwn(patch, "fontSize")) {
      broadcastFontSize(next.fontSize, event.sender);
    }
    return next;
  });
  // Settings ▸ Data Sheets: pick the external datasheet-PDF folder (native
  // directory dialog); the renderer persists the chosen path via settings:set.
  ipcMain.handle("settings:choose-datasheet-dir", () => chooseDatasheetDir());

  // ── Language ───────────────────────────────────────────────────────────────
  // Every window asks for its catalog ONCE at startup: it is sandboxed, served
  // from file://, and its CSP forbids fetching anything, so main is the only
  // side that can read the bundled JSON — the same rule that puts every other
  // file read here. `load` answers with the ACTIVE catalog plus the English one
  // as a fallback, so a key missing from a translation still renders.
  //
  // The shipped-language LIST rides along on the same payload rather than
  // getting a channel of its own: it comes from the very table the reader
  // resolves against (app/i18n.js's LOCALES), so a language cannot appear in
  // the Settings picker with no catalog behind it — and one round trip at
  // startup means the picker can be built SYNCHRONOUSLY when the dialog opens,
  // instead of the default panel filling in a moment late.
  ipcMain.handle("i18n:load", () => ({
    ...activeCatalog(),
    locales: i18n.LOCALES,
  }));

  // Auto-update (Feature 280). The updater itself lives in updater.js; these two are the
  // renderer's way in — Settings ▸ About's Check button and the Restart action
  // on the "update ready" toast. Neither answers with a result: the check's
  // outcome arrives on the `updater:*` push channels the same way whether it
  // was asked for here or from the Help menu (which calls checkForUpdates
  // directly), so there is one path to the status line rather than two.
  ipcMain.handle("updater:check", () => {
    updater.checkForUpdates({ manual: true });
    return null;
  });
  ipcMain.handle("updater:install", () => {
    updater.quitAndInstall();
    return null;
  });

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
  // working slot startup looks in first.
  //
  // A save to a REAL path always empties the slot, and that is one rule rather
  // than a caller's option: the slot exists to hold what is not in a project's
  // file, so the moment its file has everything there is nothing to hold. It
  // covers both cases that used to be a `dropDefault` flag — Save As moving a
  // project out of the slot, and a Save superseding a recovery copy stashed
  // there — and neither can now be forgotten at a call site.
  ipcMain.handle("project:save", (_event, meta, filePath) => {
    const store = getProjectStore();
    const target = filePath ? knownPath(filePath) : store.defaultProjectPath;
    store.write(target, meta);
    if (filePath) {
      rememberProject(target);
      if (target !== path.resolve(store.defaultProjectPath)) {
        // prettier-ignore
        safeCall("project:save:drop-default", () =>
          store.removeDefaultProject(),
        );
      }
    }
    return { ok: true, path: target };
  });

  // ── Crash recovery ────────────────────────────────────────────────────────
  // The other half of the slot's job, and only two verbs: `write` stashes the
  // open project there WITHOUT touching its own file, stamped with the path it
  // belongs to, and `clear` throws that stash away once its file has everything
  // (a save) or the session ended properly (a clean quit). Reading one back is
  // not a channel at all — `bootProject` restores it outright, since restored
  // work arrives unsaved and needs no question (see `recoveryBoot`).
  ipcMain.handle("project:recovery:write", (_event, meta, location) => {
    const store = getProjectStore();
    const target = location ? knownPath(location) : null;
    if (!target) {
      // No file of its own: the slot IS its home, so this is a plain save and
      // must not be stamped — a stamp would turn its own home into a question
      // at the next launch. `project:save` is the channel for that.
      const err = new Error("a recovery copy needs the project's own path");
      err.code = "INVALID_ARG";
      throw err;
    }
    store.writeRecovery(meta, target);
    return { ok: true };
  });
  ipcMain.handle("project:recovery:clear", () => {
    const store = getProjectStore();
    safeCall("project:recovery:clear", () => store.removeDefaultProject());
    return { ok: true };
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

  // AI circuit builder (Feature 260). The renderer cannot make a network call
  // — its CSP is `default-src 'self'` with no `connect-src` — so the whole
  // outbound path lives here, exactly as filesystem I/O does.
  //
  // The KEY NEVER COMES BACK. `ai:key:set` writes it OS-encrypted;
  // `ai:key:status` answers whether one is there and nothing more. That is the
  // reason it does not ride `settings:set`: a settings patch is written to a
  // plaintext file AND handed back in full on every `settings:get`.
  //
  // The provider LIST is data, not a renderer constant: the Settings tab builds
  // its picker from whatever `ai/providers.js` declares, so adding a third
  // adapter needs no renderer change and the two can never drift.
  ipcMain.handle("ai:providers", () =>
    Object.values(aiProviders.PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      defaultBaseUrl: p.defaultBaseUrl,
      defaultModel: p.defaultModel,
      keyLabel: p.keyLabel,
    })),
  );
  ipcMain.handle("ai:key:set", (_event, providerId, key) =>
    getCredentialStore().set(providerId, key),
  );
  ipcMain.handle("ai:key:clear", (_event, providerId) =>
    getCredentialStore().clear(providerId),
  );
  ipcMain.handle("ai:key:status", (_event, providerId) =>
    getCredentialStore().status(providerId),
  );
  // Begin a generation. Returns a request id immediately; the answer streams
  // back as one-way `ai:delta` pushes and lands with `ai:done`, so a long
  // generation shows progress and stays cancellable.
  ipcMain.handle("ai:start", (_event, config, system, messages) => {
    const provider = config?.provider;
    const { requestId, done } = aiClient.start({
      config,
      apiKey: getCredentialStore().get(provider) ?? "",
      system: String(system ?? ""),
      messages: Array.isArray(messages) ? messages : [],
      onDelta: (delta) => sendToMain("ai:delta", { requestId, ...delta }),
    });
    done.then(
      (result) => sendToMain("ai:done", { requestId, ...result }),
      (err) =>
        sendToMain("ai:done", {
          requestId,
          ok: false,
          error: String(err?.message ?? err),
        }),
    );
    return { ok: true, requestId };
  });
  // Settings ▸ AI's "Test connection": one tiny request, so a wrong key or an
  // unreachable base URL is found where it is fixed rather than on first use.
  ipcMain.handle("ai:test", (_event, config) =>
    aiClient.test({
      config,
      apiKey: getCredentialStore().get(config?.provider) ?? "",
    }),
  );
  ipcMain.handle("ai:cancel", (_event, requestId) => ({
    ok: aiClient.cancel(String(requestId ?? "")),
  }));

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

  // Settings ▸ Data Sheets ▸ Download: fetch every datasheet the hard-coded
  // table covers into the app's own folder. The renderer names no URL and no
  // path — it asks for "the datasheets" and is told where they landed, then
  // persists that as `datasheetDir` like any other setting. Progress arrives
  // as one-way `datasheet:progress` pushes so the dialog can count them in.
  ipcMain.handle("datasheet:download", (event) =>
    startDatasheetDownload(event.sender),
  );
  ipcMain.handle("datasheet:download:cancel", () => ({
    ok: cancelDatasheetDownload(),
  }));

  // Example circuits (Feature 270). `demo:open` is the PINOUT window's — it has
  // only a ref, so main relays the request to the app window; `demo:read` is the
  // APP window's, handing over the document it is about to make a desktop of.
  // Split so the bytes cross the bridge once, into the window that uses them.
  ipcMain.handle("demo:open", (_event, ref) => requestDemoImport(ref));
  ipcMain.handle("demo:read", (_event, ref) => readDemoDoc(ref));

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
  // Desktop menu state: the renderer owns the tab set and the run lock, and
  // pushes them so the menu bar and the tab strip agree about what is
  // available (Delete on the last desktop, Duplicate while running).
  ipcMain.handle("menu:desktop-state", (_event, state) => {
    setDesktopMenuState(state);
    return true;
  });
}

// ─── Hot reload (dev only) ────────────────────────────────────────────────────
// A MESSAGE CATALOG NEEDS MAIN'S CACHE DROPPED, NOT JUST A WINDOW RELOAD.
// `locales/` sits under the watched tree, so editing one already triggers a
// reload — but the renderer cannot read a catalog itself (file:// + a CSP with no
// connect-src): it asks main over `i18n:load`, and main resolves the catalog ONCE
// and holds it for the life of the process (activeCatalog). So a string added
// mid-session kept rendering as its raw dotted key however many times the window
// reloaded, which reads exactly like a bug in the code that asked for it rather
// than like stale state. Dropping the cache before the reload also re-renders
// main's OWN menu bar, which is built from the same catalog.
function installHotReload(win) {
  const webDir = path.join(__dirname, "..", "web");
  let timer = null;
  let catalogChanged = false;
  try {
    const watcher = fs.watch(webDir, { recursive: true }, (_type, filename) => {
      // Flagged per EVENT, not read off the last one: the timer coalesces a burst
      // (an editor's save is several events), so whichever arrives last says
      // nothing about whether a catalog was among them.
      if (filename?.startsWith("locales")) catalogChanged = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (catalogChanged) {
          catalogChanged = false;
          reloadCatalog(); // main re-reads it on the reload's own i18n:load
        }
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
    if (closeGuard.allows() || !canAskRenderer(win)) return;
    event.preventDefault();
    askBeforeClose(win);
  });

  // A renderer that dies mid-question will never reply — release the latch so
  // the next close is not silently refused for ever (see askBeforeClose).
  watchRendererForClose(win);

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // THE CONFIRMATION AUTHORISED THIS CLOSE AND NO OTHER. On macOS the app
    // outlives its last window, so without this a "discard" answered here would
    // still be latched when the dock re-opens one — and that window's every
    // later close and ⌘Q would skip the guard entirely, throwing an unsaved
    // project away with no question asked.
    closeGuard.closed();
    // Abandon any generation still streaming. There is nobody left to deliver
    // it to (`sendToMain` no-ops on a destroyed window), and on macOS the app
    // lives on after its last window closes — so without this an in-flight
    // request would keep running, and keep spending the user's tokens, for a
    // panel that no longer exists.
    aiClient.cancelAll();
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

/** The handshake's own state machine (close-guard.js) — three flags and their
    transitions, kept out of here so they can be tested without Electron. */
const closeGuard = new CloseGuard();

/** Is there a live renderer to put the question to? */
function canAskRenderer(win) {
  return Boolean(
    win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed(), // prettier-ignore
  );
}

/**
 * Put the question to the renderer (once).
 *
 * The guard's `pending` is a LATCH with exactly one key — the reply — and that
 * is what makes a renderer that never answers unrecoverable rather than merely
 * slow: every later close is prevented and no question is ever re-asked, so the
 * app cannot be closed at all. There is no timeout to fall back on,
 * deliberately (see the section note), so the latch has to be released by the
 * only other thing that ends the wait: the renderer going away.
 * `watchRendererForClose` below does that; the renderer's own guarantee that it
 * always replies is in `ProjectWorkspace#askUnsaved`.
 */
function askBeforeClose(win, { quitting = false } = {}) {
  if (!closeGuard.ask({ quitting })) return;
  win.webContents.send("app:confirm-close");
}

/**
 * Release the close latch if the renderer we are waiting on dies.
 *
 * A crashed or destroyed renderer will never send `app:close-reply`, and with
 * the latch still set `askBeforeClose` would decline to ask anyone else — so
 * the window could not be closed even though there was no longer a question
 * out. Clearing it puts us back in the state the section note describes:
 * nobody to ask, so the close simply proceeds (`canAskRenderer` is false by
 * then, so `win.on("close")` stops preventing).
 *
 * Note this does NOT cover the case it was written for — a renderer that is
 * alive and simply failed to answer. Main cannot see that from here, which is
 * exactly why the guarantee lives on the renderer side; this is the backstop
 * for the failure main CAN see.
 */
function watchRendererForClose(win) {
  const release = () => closeGuard.rendererGone();
  win.webContents.on("render-process-gone", release);
  win.webContents.on("destroyed", release);
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

    // Auto-update (Feature 280): point the updater at the live window so a manual check
    // (Help ▸ Check for Updates… / Settings ▸ About) has somewhere to report,
    // then run a delayed silent check — but ONLY if the user has opted in.
    // The default is off, so a fresh install makes no outbound call of its own
    // until asked to, and the delay keeps the check off the launch path, where
    // the desk is still being built. A store or dev build no-ops either way.
    updater.initUpdater(() => mainWindow);
    const autoCheck = safeCall(
      "settings:auto-update",
      () => getSettingsStore().get().autoUpdateCheck === true,
      false,
    );
    if (autoCheck) {
      setTimeout(() => updater.checkForUpdates({ manual: false }), 10000);
    }

    app.on("activate", () => {
      // macOS: clicking the dock re-shows (or recreates) the window.
      showWindow();
    });
  });

  // ⌘Q / Quit. Prevented BEFORE any window starts closing, so answering "no"
  // leaves the app exactly as it was rather than half torn down (the auxiliary
  // windows close in the same sequence).
  app.on("before-quit", (event) => {
    if (closeGuard.allows() || !canAskRenderer(mainWindow)) return;
    event.preventDefault();
    askBeforeClose(mainWindow, { quitting: true });
  });

  // Chip Hippo is a foreground document app: closing the last window quits
  // (the normal Electron default), except on macOS where the app stays active
  // in the dock until an explicit Quit.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
