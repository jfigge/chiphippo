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

// app.js — renderer entry point: mounts the app shell.
//
// The shell is a header bar (brand + empty toolbar slot) above the infinite
// desk (DeskView: pan/zoom camera + dot grid, Feature 10). The saved viewport
// is loaded BEFORE DeskView mounts so the restored camera paints first —
// no flash of the default view. Boards arrive with Features 20–30.

import { DeskView } from "./components/desk-view.js";
import { ZoomControl } from "./components/zoom-control.js";
import { DeskHud } from "./components/desk-hud.js";

/** How long after the last camera change to persist the viewport. */
const VIEWPORT_SAVE_DEBOUNCE_MS = 500;

function buildHeader() {
  const header = document.createElement("header");
  header.className = "app-header";
  header.setAttribute("aria-label", "Application header");

  const brand = document.createElement("div");
  brand.className = "app-header-brand";

  const icon = document.createElement("img");
  icon.className = "app-header-icon";
  icon.src = "chiphippo-icon.svg";
  icon.width = 28;
  icon.height = 28;
  icon.alt = "";
  icon.setAttribute("aria-hidden", "true");
  icon.draggable = false;

  const logo = document.createElement("span");
  logo.className = "app-logo";
  logo.textContent = "Chip Hippo";

  const subtitle = document.createElement("span");
  subtitle.className = "app-subtitle";
  subtitle.textContent = "TTL Breadboard Designer";

  brand.append(icon, logo, subtitle);

  // Empty toolbar slot — later stages mount desk tools (add board, …).
  const toolbar = document.createElement("div");
  toolbar.className = "app-header-toolbar";
  toolbar.id = "app-toolbar";

  const meta = document.createElement("div");
  meta.className = "app-header-meta";

  const version = document.createElement("span");
  version.className = "app-header-version";
  version.id = "app-version";
  meta.append(version);

  header.append(brand, toolbar, meta);
  return header;
}

function buildDesk() {
  const desk = document.createElement("section");
  desk.className = "desk-viewport";
  desk.setAttribute("aria-label", "Desk");

  // Inert overlay hint (pointer-events: none) — Feature 30's "add board"
  // flow replaces it.
  const hint = document.createElement("p");
  hint.className = "desk-hint";
  hint.textContent = "Add a breadboard to get started";

  desk.append(hint);
  return desk;
}

/** Central keyboard shortcuts: cmd/ctrl +, −, 0 drive the desk zoom. */
function bindZoomShortcuts(deskView) {
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      deskView.zoomIn();
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      deskView.zoomOut();
    } else if (e.key === "0") {
      e.preventDefault();
      deskView.resetZoom();
    }
  });
}

async function init() {
  const bridge = window.chiphippo;

  // Load settings BEFORE mounting the desk so the saved viewport applies on
  // the first paint (acceptable to proceed with defaults if the read fails).
  let settings = {};
  try {
    settings = await bridge.settings.get();
  } catch (err) {
    console.error("[renderer] settings:get failed:", err);
  }

  const app = document.getElementById("app");
  const desk = buildDesk();
  app.append(buildHeader(), desk);

  // Debounced viewport persistence: every pan step emits a change, so writes
  // coalesce until the camera settles.
  let saveTimer = null;
  const scheduleViewportSave = (camera) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      bridge.settings
        .set({ viewport: camera })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    }, VIEWPORT_SAVE_DEBOUNCE_MS);
  };

  let zoomControl = null;
  let hud = null;
  const deskView = new DeskView(desk, {
    camera: settings.viewport,
    onViewportChange: (camera) => {
      zoomControl?.setZoom(camera.zoom);
      hud?.update(camera);
      scheduleViewportSave(camera);
    },
  });

  zoomControl = new ZoomControl(desk, {
    onZoomIn: () => deskView.zoomIn(),
    onZoomOut: () => deskView.zoomOut(),
    onReset: () => deskView.resetZoom(),
  });
  zoomControl.setZoom(deskView.camera.zoom);

  bindZoomShortcuts(deskView);

  if (bridge.isDev) hud = new DeskHud(desk, deskView);

  // Prove the IPC bridge end-to-end: the version comes from the main
  // process's package.json over window.chiphippo.getVersion().
  try {
    const version = await bridge.getVersion();
    document.getElementById("app-version").textContent = `v${version}`;
  } catch (err) {
    console.error("[renderer] app:version failed:", err);
  }
}

init();
