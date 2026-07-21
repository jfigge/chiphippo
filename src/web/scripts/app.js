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

import { el } from "./dom.js";
import { DeskView } from "./components/desk-view.js";
import { ZoomControl } from "./components/zoom-control.js";
import { DeskHud } from "./components/desk-hud.js";
import { DeskController } from "./components/desk-controller.js";
import { BoardToolbar } from "./components/board-toolbar.js";
import { PalettePanel } from "./components/palette-panel.js";
import { SimController, SPEEDS } from "./components/sim-controller.js";
import { NotificationStack } from "./components/notification-stack.js";
import { PopupManager } from "./popup-manager.js";
import { AboutDialog } from "./components/about-dialog.js";
import { SettingsDialog } from "./components/settings-dialog.js";
import { DeskDoc, WIRE_COLORS, emptyDocument } from "./model/desk-doc.js";
import { partDef } from "./catalog/index.js";

/** How long after the last camera change to persist the viewport. */
const VIEWPORT_SAVE_DEBOUNCE_MS = 500;

/** How long after the last document change to persist the desk. */
const DOC_SAVE_DEBOUNCE_MS = 1000;

/** Speed-selector labels (keyed by the SimController multiplier). */
const SPEED_LABELS = { 0.25: "×¼", 1: "×1", 4: "×4" };

/** The system (settings) gear icon for the top-right header action. */
const GEAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="3"/>' +
  '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06' +
  "-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A" +
  "1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l" +
  ".06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1" +
  ".65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l" +
  ".06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.6" +
  "5 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-." +
  "06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-." +
  '09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

/** Schematic file icons for the header toolbar (New / Load / Save). */
const ICON_SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
const NEW_SVG =
  ICON_SVG_OPEN +
  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
  '<polyline points="14 2 14 8 20 8"/>' +
  '<line x1="12" y1="18" x2="12" y2="12"/>' +
  '<line x1="9" y1="15" x2="15" y2="15"/></svg>';
const LOAD_SVG =
  ICON_SVG_OPEN +
  '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 ' +
  '0 0 1 2 2z"/></svg>';
const SAVE_SVG =
  ICON_SVG_OPEN +
  '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>' +
  '<polyline points="17 21 17 13 7 13 7 21"/>' +
  '<polyline points="7 3 7 8 15 8"/></svg>';

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

  // The icon is a button that opens the About dialog (the app-name affordance).
  const iconBtn = document.createElement("button");
  iconBtn.className = "app-header-icon-btn";
  iconBtn.type = "button";
  iconBtn.title = "About Chip Hippo";
  iconBtn.setAttribute("aria-label", "About Chip Hippo");
  iconBtn.append(icon);
  iconBtn.addEventListener("click", () => AboutDialog.open());

  const logo = document.createElement("span");
  logo.className = "app-logo";
  logo.textContent = "Chip Hippo";

  const subtitle = document.createElement("span");
  subtitle.className = "app-subtitle";
  subtitle.textContent = "TTL Breadboard Designer";

  brand.append(iconBtn, logo, subtitle);

  // Empty toolbar slot — later stages mount desk tools (add board, …).
  const toolbar = document.createElement("div");
  toolbar.className = "app-header-toolbar";
  toolbar.id = "app-toolbar";

  // Right-aligned action panel: the system (settings) icon. Opening Settings
  // goes through the same chiphippo:open-settings event the menu uses, so the
  // dialog is seeded with the current settings in one place (app.js).
  const actions = document.createElement("div");
  actions.className = "header-icon-panel";
  actions.setAttribute("role", "toolbar");
  actions.setAttribute("aria-label", "Application actions");

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "icon-btn header-icon-btn";
  settingsBtn.type = "button";
  settingsBtn.title = "Settings";
  settingsBtn.setAttribute("aria-label", "Open settings");
  settingsBtn.innerHTML = GEAR_SVG;
  settingsBtn.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("chiphippo:open-settings")),
  );
  actions.append(settingsBtn);

  header.append(brand, toolbar, actions);
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

/**
 * Central keyboard shortcuts: desk keys (Esc / Delete via DeskController)
 * first, then Space to toggle Run/Stop (only when no tool is armed), then
 * cmd/ctrl +, −, 0 for the desk zoom.
 */
function bindShortcuts(deskView, controller, sim) {
  window.addEventListener("keydown", (e) => {
    if (controller.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }
    // Space runs/stops the circuit — but not while typing, and not when a
    // placement/wire tool is armed (it may want the key for its own gesture).
    if (e.key === " " || e.code === "Space") {
      const tag = e.target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        e.target?.isContentEditable
      ) {
        return;
      }
      if (
        controller.placementArmed ||
        controller.wireToolArmed ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        return;
      }
      e.preventDefault();
      sim.toggle();
      return;
    }
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
  // Main row below the header: the parts palette (left, toggleable) beside
  // the full-bleed desk.
  const main = el("div", { class: "app-main" });
  app.append(buildHeader(), main);

  // Desk document (Feature 20): the persisted boards/components/wires, held
  // in one in-memory DeskDoc. Anything that mutates it dispatches a global
  // `chiphippo:doc-changed` CustomEvent, which triggers the debounced
  // whole-document autosave below. Feature 30 renders it.
  let deskDoc;
  try {
    deskDoc = new DeskDoc(await bridge.desk.load());
  } catch (err) {
    console.error("[renderer] desk:load failed:", err);
    deskDoc = new DeskDoc(null);
  }
  let docSaveTimer = null;
  window.addEventListener("chiphippo:doc-changed", () => {
    clearTimeout(docSaveTimer);
    docSaveTimer = setTimeout(() => {
      bridge.desk
        .save(deskDoc.toJSON())
        .catch((err) => console.error("[renderer] desk:save failed:", err));
    }, DOC_SAVE_DEBOUNCE_MS);
  });

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

  // ── Schematic files (New / Open / Save / Save As) ─────────────────────────
  // The working document is desk.json (autosaved above); these map it to a
  // named file. New/Open rewrite the working file and reload so the whole
  // scene rebuilds cleanly (the app's one guaranteed teardown path); Save /
  // Save As just write a file. Dirty is the live document vs `savedDocJson` —
  // the snapshot as last written to the file (persisted so it survives the
  // reload and across sessions).
  let currentFile = settings.currentFile ?? null;
  let savedDocJson = settings.savedDoc ?? JSON.stringify(deskDoc.toJSON());
  const fileName = (p) => (p ? p.split(/[\\/]/).pop() : "Untitled");
  const isDirty = () => JSON.stringify(deskDoc.toJSON()) !== savedDocJson;
  const updateTitle = () => {
    document.title = `${isDirty() ? "• " : ""}${fileName(currentFile)} — Chip Hippo`;
  };
  updateTitle();
  window.addEventListener("chiphippo:doc-changed", updateTitle);

  const confirmDiscard = () =>
    new Promise((resolve) => {
      if (!isDirty()) return resolve(true);
      PopupManager.confirm({
        title: "Discard unsaved changes?",
        message: `"${fileName(currentFile)}" has unsaved changes that will be lost.`,
        confirmLabel: "Discard",
        confirmClass: "btn--danger",
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });

  // New/Open write the working desk.json + the new baseline, then reload.
  // Cancel the debounced autosaves first so the OLD in-memory doc can't land
  // on the freshly written working file after the awaits.
  const reloadWith = async (doc, file) => {
    clearTimeout(docSaveTimer);
    clearTimeout(saveTimer);
    await bridge.desk.save(doc);
    await bridge.settings.set({
      currentFile: file,
      savedDoc: JSON.stringify(doc),
    });
    window.location.reload();
  };

  const newSchematic = async () => {
    if (!(await confirmDiscard())) return;
    await reloadWith(emptyDocument(), null);
  };

  const openSchematic = async () => {
    if (!(await confirmDiscard())) return;
    let res;
    try {
      res = await bridge.desk.open();
    } catch (err) {
      console.error("[renderer] desk:open failed:", err);
      return;
    }
    if (!res) return; // cancelled
    await reloadWith(res.doc, res.path);
  };

  const saveAsSchematic = async () => {
    const json = deskDoc.toJSON();
    let path;
    try {
      path = await bridge.desk.saveAs(json, currentFile);
    } catch (err) {
      console.error("[renderer] desk:save-as failed:", err);
      return;
    }
    if (!path) return; // cancelled
    currentFile = path;
    savedDocJson = JSON.stringify(json);
    await bridge.settings.set({ currentFile: path, savedDoc: savedDocJson });
    updateTitle();
  };

  const saveSchematic = async () => {
    if (!currentFile) return saveAsSchematic();
    const json = deskDoc.toJSON();
    try {
      await bridge.desk.write(currentFile, json);
    } catch (err) {
      console.error("[renderer] desk:write failed:", err);
      return;
    }
    savedDocJson = JSON.stringify(json);
    await bridge.settings.set({ savedDoc: savedDocJson });
    updateTitle();
  };

  window.addEventListener("chiphippo:schematic-new", newSchematic);
  window.addEventListener("chiphippo:schematic-open", openSchematic);
  window.addEventListener("chiphippo:schematic-save", saveSchematic);
  window.addEventListener("chiphippo:schematic-save-as", saveAsSchematic);

  let zoomControl = null;
  let hud = null;
  let controller = null;

  // Parts palette (left panel; visibility persists in settings). A part with a
  // `colors` list (the LED and the segment displays) opens the color swatch
  // popover first; everything else arms its placement ghost directly.
  const palette = new PalettePanel(main, {
    onPickChip: (ref, e) => {
      const colors = partDef(ref)?.colors;
      if (colors) {
        PopupManager.menu({
          x: e?.clientX ?? 0,
          y: e?.clientY ?? 0,
          items: colors.map((color) => ({
            label: `Color: ${color}`,
            onSelect: () => controller?.armPartPlacement(ref, { color }),
          })),
        });
        return;
      }
      controller?.armPartPlacement(ref);
    },
    // Collapse state is deliberately NOT persisted — the palette opens with
    // every group shut, every launch (see PalettePanel).
  });
  palette.setVisible(settings.paletteOpen === true);
  main.append(desk);

  const deskView = new DeskView(desk, {
    camera: settings.viewport,
    onViewportChange: (camera) => {
      zoomControl?.setZoom(camera.zoom);
      hud?.update(camera);
      controller?.onViewportChange(camera);
      scheduleViewportSave(camera);
    },
  });

  // Everything ON the desk (boards, chips, wires, placement, hover).
  let wireBtn = null;
  let swatchStrip = null;
  let probeBtn = null;
  let sim = null; // the SimController (created after the toolbar below)
  const onWireStateChange = ({ armed, color }) => {
    wireBtn?.classList.toggle("toolbar-btn--active", armed);
    wireBtn?.setAttribute("aria-pressed", String(armed));
    swatchStrip
      ?.querySelectorAll(".wire-swatch")
      .forEach((s) =>
        s.classList.toggle("wire-swatch--active", s.dataset.color === color),
      );
  };
  const onProbeStateChange = ({ armed }) => {
    probeBtn?.classList.toggle("toolbar-btn--active", armed);
    probeBtn?.setAttribute("aria-pressed", String(armed));
  };
  controller = new DeskController({
    viewport: desk,
    deskView,
    deskDoc,
    onWireStateChange,
    onProbeStateChange,
    onReplaceChip: (id) => sim?.replaceChip(id),
    onClockToggle: (id) => sim?.manualToggle(id),
    // Double-click any part → open its floating pin/terminal-assignments OS
    // window (`rows` sizes it to the layout).
    onOpenPinout: (ref, rows) =>
      bridge
        .openPinout?.(ref, { rows })
        .catch((err) => console.error("[renderer] pinout:open failed:", err)),
    // Undo/redo availability drives the native Edit-menu enable state.
    onHistoryChange: (state) =>
      bridge.menu
        ?.setEditState(state)
        .catch((err) =>
          console.error("[renderer] menu:edit-state failed:", err),
        ),
  });

  // Edit ▸ Undo / Redo (⌘Z / ⇧⌘Z), pushed from the native menu. A focused text
  // field keeps its own editing (the document isn't touched while typing).
  const inTextField = () => {
    const t = document.activeElement;
    return (
      t &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
    );
  };
  window.addEventListener("chiphippo:edit-undo", () => {
    if (!inTextField()) controller.undo();
  });
  window.addEventListener("chiphippo:edit-redo", () => {
    if (!inTextField()) controller.redo();
  });

  const toolbar = document.getElementById("app-toolbar");

  // Schematic file actions (New / Load / Save) — icon buttons at the head of
  // the toolbar, dispatching the SAME events the File menu pushes.
  const schematicBtn = (label, svg, event) => {
    const b = el("button", {
      class: "toolbar-icon-btn",
      type: "button",
      title: label,
      "aria-label": label,
      onClick: () => window.dispatchEvent(new CustomEvent(event)),
    });
    b.innerHTML = svg;
    return b;
  };
  toolbar.append(
    schematicBtn("New schematic", NEW_SVG, "chiphippo:schematic-new"),
    schematicBtn("Load schematic…", LOAD_SVG, "chiphippo:schematic-open"),
    schematicBtn("Save schematic", SAVE_SVG, "chiphippo:schematic-save"),
    el("span", { class: "toolbar-divider", "aria-hidden": "true" }),
  );

  const partsBtn = el("button", {
    class: "toolbar-btn",
    type: "button",
    text: "Parts",
    title: "Show or hide the parts palette",
    "aria-pressed": String(palette.visible),
    onClick: () => {
      const on = !palette.visible;
      palette.setVisible(on);
      partsBtn.setAttribute("aria-pressed", String(on));
      partsBtn.classList.toggle("toolbar-btn--active", on);
      bridge.settings
        .set({ paletteOpen: on })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    },
  });
  partsBtn.classList.toggle("toolbar-btn--active", palette.visible);
  toolbar.append(partsBtn);

  new BoardToolbar(toolbar, {
    onAddBoard: (type) => controller.armPlacement(type),
  });

  // Wire tool: toggle button (shortcut W) + the next-color swatch strip.
  wireBtn = el("button", {
    class: "toolbar-btn",
    type: "button",
    text: "Wire",
    title: "Wire tool — click two free holes to connect them (W)",
    "aria-pressed": "false",
    onClick: () => controller.toggleWireTool(),
  });
  swatchStrip = el(
    "div",
    { class: "wire-swatches", "aria-label": "Next wire color" },
    WIRE_COLORS.map((color) => {
      const swatch = el("button", {
        class: "wire-swatch",
        type: "button",
        title: `Wire color: ${color}`,
        "aria-label": `Wire color: ${color}`,
        dataset: { color },
        onClick: () => {
          controller.setWireColor(color);
          controller.armWireTool();
        },
      });
      // Custom properties need setProperty (Object.assign can't set them).
      swatch.style.setProperty("--wire-color", `var(--color-wire-${color})`);
      return swatch;
    }),
  );
  toolbar.append(wireBtn, swatchStrip);
  onWireStateChange({ armed: false, color: controller.wireColor });

  // Probe tool: highlight a whole electrical net on hover (shortcut I).
  probeBtn = el("button", {
    class: "toolbar-btn",
    type: "button",
    text: "Probe",
    title: "Connectivity probe — hover to highlight a net, click to pin (I)",
    "aria-pressed": "false",
    onClick: () => controller.toggleProbe(),
  });
  toolbar.append(probeBtn);

  // ── Simulation transport (Feature 90/100): Run/Stop, Pause, Step, speed ──
  const notifications = new NotificationStack(document.body);

  // The transport cluster sits apart from the edit tools (right of the strip).
  const runBtn = el("button", {
    class: "toolbar-btn toolbar-btn--run",
    type: "button",
    text: "▶ Run",
    title: "Run the circuit (Space)",
    "aria-pressed": "false",
    onClick: () => sim.toggle(),
  });
  const pauseBtn = el("button", {
    class: "toolbar-btn toolbar-btn--transport",
    type: "button",
    text: "⏸ Pause",
    title: "Pause / resume the clock",
    hidden: true,
    onClick: () => sim.togglePause(),
  });
  const stepBtn = el("button", {
    class: "toolbar-btn toolbar-btn--transport",
    type: "button",
    text: "⇥ Step",
    title: "Advance one clock half-period",
    hidden: true,
    onClick: () => sim.step(),
  });
  const speedBtn = el("button", {
    class: "toolbar-btn toolbar-btn--transport",
    type: "button",
    text: "×1",
    title: "Clock speed (click to cycle ¼ / 1 / 4)",
    hidden: true,
    onClick: () => {
      const i = (SPEEDS.indexOf(sim.speed) + 1) % SPEEDS.length;
      sim.setSpeed(SPEEDS[i]);
      speedBtn.textContent = SPEED_LABELS[SPEEDS[i]];
    },
  });
  toolbar.append(runBtn, pauseBtn, stepBtn, speedBtn);

  // Buttons that edit topology are disabled while the circuit runs; the probe
  // and the transport controls stay live. The Add-board split lives in its own
  // wrapper, so gather every editing button by element.
  const editButtons = () => [
    partsBtn,
    wireBtn,
    ...swatchStrip.querySelectorAll(".wire-swatch"),
    ...toolbar.querySelectorAll(".toolbar-split button"),
  ];
  const onTransportChange = (mode) => {
    const stopped = mode === "stopped";
    controller.setEditingLocked(!stopped);
    runBtn.textContent = stopped ? "▶ Run" : "■ Stop";
    runBtn.title = stopped
      ? "Run the circuit (Space)"
      : "Stop and return to editing (Space)";
    runBtn.setAttribute("aria-pressed", String(!stopped));
    runBtn.classList.toggle("toolbar-btn--running", !stopped);
    pauseBtn.textContent = mode === "paused" ? "▶ Resume" : "⏸ Pause";
    for (const btn of [pauseBtn, stepBtn, speedBtn]) btn.hidden = stopped;
    for (const btn of editButtons()) btn.disabled = !stopped;
  };
  sim = new SimController({ deskDoc, notifications, onTransportChange });

  // The empty-desk hint disappears once the desk has boards.
  const hint = desk.querySelector(".desk-hint");
  const updateHint = () => {
    hint.hidden = deskDoc.boards.length > 0;
  };
  updateHint();
  window.addEventListener("chiphippo:doc-changed", updateHint);

  zoomControl = new ZoomControl(desk, {
    onZoomIn: () => deskView.zoomIn(),
    onZoomOut: () => deskView.zoomOut(),
    onReset: () => deskView.resetZoom(),
  });
  zoomControl.setZoom(deskView.camera.zoom);

  bindShortcuts(deskView, controller, sim);

  // The desk hub is always mounted but hidden until the "Show desk hub"
  // setting turns it on (applySettings below sets the initial visibility).
  hud = new DeskHud(desk, deskView);

  // ── Settings (About / Settings dialogs + live application) ────────────────
  // The Settings dialog is deliberately dumb: it broadcasts a patch, and this
  // is where the app persists it (settings.set) and applies it live. Keep the
  // running settings so the dialog opens seeded with the current values.
  let currentSettings = settings;
  const applySettings = (s) => {
    hud?.setVisible(s.showDeskHub === true);
    const root = document.documentElement;
    if (s.selectionColor) {
      root.style.setProperty("--color-selection", s.selectionColor);
    } else {
      root.style.removeProperty("--color-selection");
    }
  };
  applySettings(currentSettings);

  window.addEventListener("chiphippo:settings-changed", (e) => {
    currentSettings = { ...currentSettings, ...e.detail };
    applySettings(currentSettings);
    bridge.settings
      .set(e.detail)
      .catch((err) => console.error("[renderer] settings:set failed:", err));
  });
  window.addEventListener("chiphippo:show-about", () => AboutDialog.open());
  window.addEventListener("chiphippo:open-settings", () =>
    SettingsDialog.open(currentSettings),
  );
  // The app version is no longer shown in the header — it lives in the About
  // dialog (the (i) toggle), which fetches it over the IPC bridge.
}

init();
