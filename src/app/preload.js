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

  // ── App settings (Feature 10) ──────────────────────────────────────────────
  // A single preferences document in main (store/settings-store.js): the desk
  // viewport, window bounds, and later stages' keys. `set` shallow-merges a
  // patch; object-valued keys are replaced whole, so send the full object.
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },
});
