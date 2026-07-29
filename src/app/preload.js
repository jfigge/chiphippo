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

// preload.js — runs in the renderer before page content loads and exposes the
// single, narrow window.chiphippo bridge. Every later stage extends THIS
// object (desk.*, boards.*, settings.*, …) and must keep it in lockstep with
// the ipcMain handlers in main.js.
//
// SANDBOX RESTRICTION: this runs in Electron's sandboxed renderer, where
// require() is limited to Electron built-ins ONLY. Never require("../anything")
// here — it crashes the preload in packaged (.asar) builds. Anything from the
// main process must arrive over IPC.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// ── Main → renderer menu pushes ─────────────────────────────────────────────
// The application menu's items are one-way pushes from main; re-dispatch each
// as a global chiphippo:* CustomEvent the renderer listens for (the documented
// main→renderer broadcast pattern). Most carry no payload — the renderer opens
// the matching dialog or acts on the desk it already owns. The one exception is
// File ▸ Open Recent, whose item names the project file it stands for; the
// detail is passed through verbatim, so a payload-free push simply arrives with
// `detail: undefined`.
for (const [channel, event] of [
  ["menu:show-about", "chiphippo:show-about"],
  ["menu:open-settings", "chiphippo:open-settings"],
  ["menu:keyboard-shortcuts", "chiphippo:keyboard-shortcuts"],
  ["menu:project-new", "chiphippo:project-new"],
  ["menu:project-open", "chiphippo:project-open"],
  ["menu:project-open-recent", "chiphippo:project-open-recent"],
  ["menu:project-save", "chiphippo:project-save"],
  ["menu:project-save-as", "chiphippo:project-save-as"],
  ["menu:project-properties", "chiphippo:project-properties"],
  ["menu:desktop-add", "chiphippo:desktop-add"],
  ["menu:desktop-duplicate", "chiphippo:desktop-duplicate"],
  ["menu:desktop-import", "chiphippo:desktop-import"],
  ["menu:desktop-export", "chiphippo:desktop-export"],
  ["menu:desktop-properties", "chiphippo:desktop-properties"],
  ["menu:desktop-delete", "chiphippo:desktop-delete"],
  ["menu:build-guide", "chiphippo:build-guide"],
  ["menu:edit-undo", "chiphippo:edit-undo"],
  ["menu:edit-redo", "chiphippo:edit-redo"],
  ["menu:edit-select-all", "chiphippo:edit-select-all"],
  // Not a menu item: main asking, before a close or a quit, whether anything
  // unsaved needs dealing with first. The renderer answers with closeReply().
  ["app:confirm-close", "chiphippo:confirm-close"],
]) {
  ipcRenderer.on(channel, (_e, detail) => {
    window.dispatchEvent(new CustomEvent(event, { detail }));
  });
}

// ── Memory inspector cross-window relay (Feature 190) ───────────────────────
// Unlike the menu pushes above these carry a payload, so re-dispatch the detail
// verbatim. `memory:inbound` reaches an inspector window (host → inspector);
// `memory:host-inbound` reaches the main renderer (inspector → host). A window
// that main never sends a given channel to simply never fires it.
// `ai:delta` / `ai:done` (Feature 260) carry a payload for the same reason:
// a generation streams, so the panel needs each fragment as it arrives rather
// than one resolved promise at the end. Both detail objects carry the
// `requestId` the `ai:start` invoke returned, so a panel can ignore the tail
// of a request it has already cancelled.
// `demo:host-inbound` (Feature 270) is the memory relay one step simpler: a
// pinout window has only a part ref, so its "open this part's example circuit"
// request reaches the app window — the only side with a project to put a
// desktop in — through main, carrying `{ ref }`.
for (const [channel, event] of [
  ["memory:inbound", "chiphippo:memory-inbound"],
  ["memory:host-inbound", "chiphippo:memory-host-inbound"],
  ["demo:host-inbound", "chiphippo:demo-host-inbound"],
  ["ai:delta", "chiphippo:ai-delta"],
  ["ai:done", "chiphippo:ai-done"],
  // Settings ▸ Data Sheets ▸ Download counts its way through the table one
  // part at a time; a single resolved promise at the end would leave the
  // dialog with nothing to show for the minute it takes.
  ["datasheet:progress", "chiphippo:datasheet-progress"],
]) {
  ipcRenderer.on(channel, (_e, detail) => {
    window.dispatchEvent(new CustomEvent(event, { detail }));
  });
}

contextBridge.exposeInMainWorld("chiphippo", {
  // Static platform info — available synchronously from the sandboxed
  // preload's process shim (main's app:platform handler carries the same
  // value over IPC).
  platform: process.platform,
  arch: process.arch,

  // True under `make debug` / --dev (main passes --chiphippo-dev via
  // additionalArguments). Gates dev-only UI like the desk debug HUD.
  isDev: process.argv.includes("--chiphippo-dev"),

  // App version comes from the main process (package.json), over IPC — this
  // also proves the ipcMain <-> preload bridge is wired correctly.
  getVersion: () => ipcRenderer.invoke("app:version"),

  // Read-only app / build metadata for the About dialog (version + runtime
  // versions). Distinct from getVersion() — the About panel wants the fuller
  // picture (Electron / Chromium / Node / platform).
  getAppInfo: () => ipcRenderer.invoke("app:info:get"),

  // The answer to `chiphippo:confirm-close`: true to let the window go, false
  // to stay open. Main waits for this indefinitely — it is a user decision —
  // so every path through the renderer's guard must reply exactly once.
  closeReply: (ok) => ipcRenderer.invoke("app:close-reply", ok === true),

  // ── App settings (Feature 10) ──────────────────────────────────────────────
  // A single preferences document in main (store/settings-store.js): the desk
  // viewport, window bounds, and later stages' keys. `set` shallow-merges a
  // patch; object-valued keys are replaced whole, so send the full object.
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
    // Settings ▸ Data Sheets: open a native folder picker for the external
    // datasheet-PDF directory. Resolves to the chosen path, or null if
    // cancelled — the caller then persists it with set({ datasheetDir }).
    chooseDatasheetDir: () =>
      ipcRenderer.invoke("settings:choose-datasheet-dir"),
  },

  // ── AI circuit builder (Feature 260) ───────────────────────────────────────
  // The user's own connection. Non-secret config (provider, base URL, model)
  // lives in settings; the KEY does not, and never crosses back over this
  // bridge — `key.status` answers whether one is configured and nothing else.
  // A generation streams: `start` resolves with a request id, then
  // `chiphippo:ai-delta` fires per fragment and `chiphippo:ai-done` once.
  ai: {
    providers: () => ipcRenderer.invoke("ai:providers"),
    key: {
      set: (providerId, key) =>
        ipcRenderer.invoke("ai:key:set", providerId, key),
      clear: (providerId) => ipcRenderer.invoke("ai:key:clear", providerId),
      status: (providerId) => ipcRenderer.invoke("ai:key:status", providerId),
    },
    test: (config) => ipcRenderer.invoke("ai:test", config),
    start: (config, system, messages) =>
      ipcRenderer.invoke("ai:start", config, system, messages),
    cancel: (requestId) => ipcRenderer.invoke("ai:cancel", requestId),
  },

  // ── Projects ───────────────────────────────────────────────────────────────
  // THE PROJECT IS THE DOCUMENT: one file holds every desktop's document and
  // every programmed ROM's bytes, so this is the app's only file surface.
  // `boot()` answers with a project on every launch (the unsaved one in the
  // app's saves folder, else the most recent saved one, else a brand-new one).
  // The renderer holds the whole project — name, description, location, tabs,
  // and each tab's `doc` — and hands it back to be written; main owns the
  // saves folder, the native dialogs, the recent list, the ROM images, and
  // which paths may be touched at all (the saves folder, plus whatever a
  // dialog or an opened project established).
  //
  // `save(meta, path, dropDefault)` writes the project file: a null path means
  // "no location yet" → the fixed default project file, and `dropDefault`
  // clears that slot when a project moves out of it. `choosePath` only PICKS a
  // location — the native save dialog asks about replacing an existing file
  // itself, so a refusal comes back as a cancel (null).
  project: {
    boot: () => ipcRenderer.invoke("project:boot"),
    create: () => ipcRenderer.invoke("project:new"),
    open: () => ipcRenderer.invoke("project:open"),
    openRecent: (filePath) =>
      ipcRenderer.invoke("project:open-recent", filePath),
    save: (meta, filePath, dropDefault) =>
      ipcRenderer.invoke("project:save", meta, filePath, dropDefault),
    choosePath: (kind, name, current) =>
      ipcRenderer.invoke("project:choose-path", kind, name, current),
    // The MRU list behind File ▸ Open Recent: `list()` → the last 10 project
    // paths, most recent first; `remove(path)` → the new list. Opening one is
    // `openRecent` above (main allowlists against this list).
    recent: {
      list: () => ipcRenderer.invoke("project:recent:list"),
      remove: (filePath) =>
        ipcRenderer.invoke("project:recent:remove", filePath),
    },
    // A tab switch swaps the whole desk — ask main to close the pinout /
    // memory windows that were pointing at the desk being left behind.
    closeAuxWindows: () => ipcRenderer.invoke("project:closed-aux"),
  },

  // ── Desktop snapshots (Export / Import / Duplicate) ────────────────────────
  // A desktop is structure inside the project file, not a file of its own, so
  // moving one between projects is a SNAPSHOT: `export` picks a path and
  // writes a self-contained `.desktop.chiphippo` (the document plus every
  // programmed ROM's bytes); `import` reads one back. Both COPIES — import and
  // duplicate — come back with freshly minted ROM guids and their own backing
  // files, so no two chips can ever share one. Each resolves to null when its
  // dialog was cancelled.
  desktop: {
    export: (desktop) => ipcRenderer.invoke("desktop:export", desktop),
    import: () => ipcRenderer.invoke("desktop:import"),
    duplicate: (doc) => ipcRenderer.invoke("desktop:duplicate", doc),
  },

  // ── Chip pin-assignments window (Feature 100) ──────────────────────────────
  // A part's "Pin Assignment" context-menu item opens a separate, floating OS
  // window that renders its DIP pinout as a wiring reference. `opts` may carry
  // a `{ pins }` hint so main can size the window to the package.
  openPinout: (ref, opts) => ipcRenderer.invoke("pinout:open", ref, opts),

  // Open a part's external datasheet PDF (from the Settings ▸ Data Sheets
  // folder) in the OS PDF viewer. Used by the pinout window's "open datasheet"
  // button. Resolves to whether a file was opened.
  openDatasheet: (ref) => ipcRenderer.invoke("datasheet:open", ref),

  // ── Downloading the datasheets ─────────────────────────────────────────────
  // Settings ▸ Data Sheets ▸ Download. `download()` fetches every datasheet
  // main's hard-coded table covers into the app's own folder and resolves with
  // `{ dir, total, saved, cancelled, failures }` — the caller then persists
  // `dir` as `datasheetDir` like any other setting. No URL and no path crosses
  // this way: the renderer asks for "the datasheets" and is told where they
  // went. Progress arrives meanwhile as `chiphippo:datasheet-progress` events
  // carrying `{ done, total, ref, ok }`; `cancel()` stops the run in flight.
  datasheets: {
    download: () => ipcRenderer.invoke("datasheet:download"),
    cancel: () => ipcRenderer.invoke("datasheet:download:cancel"),
  },

  // ── Example circuits (Feature 270) ─────────────────────────────────────────
  // The demonstration bench `make demos` builds for every benchable 74xx part,
  // shipped as web/demos/<ref>.json. Two windows, one action: a PINOUT window
  // asks (`open` — it has a ref and nothing else, so main relays the request to
  // the app window as `demo:host-inbound`), and the APP window reads (`read`)
  // the document it is going to make a desktop of. `read` answers null for a
  // part with no example.
  demo: {
    open: (ref) => ipcRenderer.invoke("demo:open", ref),
    read: (ref) => ipcRenderer.invoke("demo:read", ref),
  },

  // ── Memory backing files (Features 180/190) ────────────────────────────────
  // The GUID-keyed byte store behind a non-volatile (ROM/EPROM/EEPROM) chip's
  // `.bin` in the app working folder. All I/O is atomic in main, which alone
  // maps a GUID to a path. `create` makes a fresh noise-filled file (chip
  // added); `load` reads it; `program` copies a picked image to the file's
  // start (the external programmer); `write` overwrites (inspector Save);
  // `delete` removes it (chip deleted); `path` resolves the display path.
  // `pickImage`/`export` open native dialogs. Each resolves to { ok, ... }.
  mem: {
    create: (guid, byteLength) =>
      ipcRenderer.invoke("mem:create", guid, byteLength),
    load: (guid, byteLength) =>
      ipcRenderer.invoke("mem:load", guid, byteLength),
    program: (guid, bytes, byteLength) =>
      ipcRenderer.invoke("mem:program", guid, bytes, byteLength),
    write: (guid, bytes) => ipcRenderer.invoke("mem:write", guid, bytes),
    delete: (guid) => ipcRenderer.invoke("mem:delete", guid),
    path: (guid) => ipcRenderer.invoke("mem:path", guid),
    pickImage: () => ipcRenderer.invoke("mem:pick-image"),
    export: (bytes, suggestedName) =>
      ipcRenderer.invoke("mem:export", bytes, suggestedName),
  },

  // ── Memory inspector window (Feature 190) ──────────────────────────────────
  // `open` spawns/focuses the per-component floating inspector. The two relays
  // are the ONLY channel between the main renderer and an inspector window
  // (each its own sandboxed renderer): `toInspector` sends host → inspector,
  // `toHost` sends inspector → host, both addressed by component id. Inbound
  // messages arrive as `chiphippo:memory-inbound` / `-host-inbound` events.
  memory: {
    open: (compId, ref) => ipcRenderer.invoke("memory:open", compId, ref),
    toInspector: (compId, msg) =>
      ipcRenderer.invoke("memory:to-inspector", compId, msg),
    toHost: (compId, msg) => ipcRenderer.invoke("memory:to-host", compId, msg),
  },

  // ── Native menu state ──────────────────────────────────────────────────────
  // The renderer owns what these items act on, so it is the authority on
  // whether they apply: the document history behind Edit ▸ Undo / Redo
  // (Feature 200), and the tab set + run lock behind Desktop ▸ Duplicate /
  // Delete — which the tab strip already disables, so this is what keeps the
  // two surfaces saying the same thing.
  menu: {
    setEditState: (state) => ipcRenderer.invoke("menu:edit-state", state),
    setDesktopState: (state) => ipcRenderer.invoke("menu:desktop-state", state),
  },

  // ── User guide (Feature 230) ────────────────────────────────────────────────
  // Help ▸ Chip Hippo User Guide opens its own OS window directly from the
  // native menu (main's openDocsWindow) — this bridge exists only so the docs
  // window itself, once open, can fetch one Markdown page's source at a time
  // by slug (never a filesystem path, never fetch(), so it works under
  // file://). Shared with the docs window, same as every other auxiliary
  // window (pinout/memory) — Chip Hippo has one bridge, not a narrow preload
  // per window.
  docs: {
    read: (slug) => ipcRenderer.invoke("docs:read", slug),
  },
});
