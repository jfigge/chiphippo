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
// The application menu's About / Settings items are one-way pushes from main;
// re-dispatch each as a global chiphippo:* CustomEvent the renderer listens
// for (the documented main→renderer broadcast pattern). No payload — the
// renderer opens the matching PopupManager dialog.
for (const [channel, event] of [
  ["menu:show-about", "chiphippo:show-about"],
  ["menu:open-settings", "chiphippo:open-settings"],
  ["menu:schematic-new", "chiphippo:schematic-new"],
  ["menu:schematic-open", "chiphippo:schematic-open"],
  ["menu:schematic-save", "chiphippo:schematic-save"],
  ["menu:schematic-save-as", "chiphippo:schematic-save-as"],
  ["menu:edit-undo", "chiphippo:edit-undo"],
  ["menu:edit-redo", "chiphippo:edit-redo"],
]) {
  ipcRenderer.on(channel, () => {
    window.dispatchEvent(new CustomEvent(event));
  });
}

// ── Memory inspector cross-window relay (Feature 190) ───────────────────────
// Unlike the menu pushes above these carry a payload, so re-dispatch the detail
// verbatim. `memory:inbound` reaches an inspector window (host → inspector);
// `memory:host-inbound` reaches the main renderer (inspector → host). A window
// that main never sends a given channel to simply never fires it.
for (const [channel, event] of [
  ["memory:inbound", "chiphippo:memory-inbound"],
  ["memory:host-inbound", "chiphippo:memory-host-inbound"],
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

  // ── Desk document (Feature 20) ─────────────────────────────────────────────
  // The single persisted desk: boards (+ components/wires from later stages).
  // The renderer keeps the live DeskDoc (model/desk-doc.js) and autosaves the
  // WHOLE serialized document, debounced ~1 s — documents are small; deltas
  // are premature. load() returns a migrated, ready-to-normalize document.
  desk: {
    load: () => ipcRenderer.invoke("desk:load"),
    save: (doc) => ipcRenderer.invoke("desk:save", doc),
    // Named schematic files. open() → {path, doc}|null (Open dialog);
    // saveAs(doc) → path|null (Save-As dialog); write(path, doc) → path
    // (silent re-Save to a known file).
    open: () => ipcRenderer.invoke("desk:open"),
    saveAs: (doc, suggestedPath) =>
      ipcRenderer.invoke("desk:save-as", doc, suggestedPath),
    write: (filePath, doc) => ipcRenderer.invoke("desk:write", filePath, doc),
  },

  // ── Chip pin-assignments window (Feature 100) ──────────────────────────────
  // Double-clicking a chip opens a separate, floating OS window that renders
  // its DIP pinout as a wiring reference. `opts` may carry a `{ pins }` hint so
  // main can size the window to the package.
  openPinout: (ref, opts) => ipcRenderer.invoke("pinout:open", ref, opts),

  // Open a part's external datasheet PDF (from the Settings ▸ Data Sheets
  // folder) in the OS PDF viewer. Used by the pinout window's "open datasheet"
  // button. Resolves to whether a file was opened.
  openDatasheet: (ref) => ipcRenderer.invoke("datasheet:open", ref),

  // ── Memory backing files (Feature 180) ─────────────────────────────────────
  // The byte store behind a memory chip's `.bin`. All I/O is atomic in main;
  // the renderer holds only in-RAM images + byte batches. `load`/`flush` are
  // byte-oriented (the SimController packs 8/16-bit words to byte offsets);
  // each resolves to { ok, ... } or { ok:false, error }. `choose`/`import`/
  // `export` open native dialogs (Feature 190 uses import/export).
  mem: {
    load: (filePath, byteLength) =>
      ipcRenderer.invoke("mem:load", filePath, byteLength),
    flush: (filePath, writes, byteLength) =>
      ipcRenderer.invoke("mem:flush", filePath, writes, byteLength),
    write: (filePath, bytes) =>
      ipcRenderer.invoke("mem:write", filePath, bytes),
    choose: (mode) => ipcRenderer.invoke("mem:choose", mode),
    import: () => ipcRenderer.invoke("mem:import"),
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

  // ── Undo/redo menu state (Feature 200) ─────────────────────────────────────
  // The renderer owns the document history; this pushes the current
  // availability so main can enable/disable Edit ▸ Undo / Redo to match.
  menu: {
    setEditState: (state) => ipcRenderer.invoke("menu:edit-state", state),
  },
});
