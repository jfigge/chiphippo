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
import { SimController } from "./components/sim-controller.js";
import { NotificationStack } from "./components/notification-stack.js";
import { PopupManager } from "./popup-manager.js";
import { DeskDoc, WIRE_COLORS } from "./model/desk-doc.js";
import { LED_COLORS } from "./catalog/parts.js";

/** How long after the last camera change to persist the viewport. */
const VIEWPORT_SAVE_DEBOUNCE_MS = 500;

/** How long after the last document change to persist the desk. */
const DOC_SAVE_DEBOUNCE_MS = 1000;

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

  let zoomControl = null;
  let hud = null;
  let controller = null;

  // Parts palette (left panel; visibility persists in settings). An LED
  // pick opens the color swatch popover first; everything else arms its
  // placement ghost directly.
  const palette = new PalettePanel(main, {
    onPickChip: (ref, e) => {
      if (ref === "led") {
        PopupManager.menu({
          x: e?.clientX ?? 0,
          y: e?.clientY ?? 0,
          items: LED_COLORS.map((color) => ({
            label: `LED color: ${color}`,
            onSelect: () => controller?.armPartPlacement("led", { color }),
          })),
        });
        return;
      }
      controller?.armPartPlacement(ref);
    },
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
  });

  const toolbar = document.getElementById("app-toolbar");
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

  // ── Simulation (Feature 90): Run/Stop + the notification stack ──────────
  const notifications = new NotificationStack(document.body);

  // The Run/Stop toggle sits apart from the edit tools (right of the strip).
  const runBtn = el("button", {
    class: "toolbar-btn toolbar-btn--run",
    type: "button",
    text: "▶ Run",
    title: "Run the circuit (Space)",
    "aria-pressed": "false",
    onClick: () => sim.toggle(),
  });
  toolbar.append(runBtn);

  // Buttons that edit topology are disabled while the circuit runs; the probe
  // and the Run/Stop toggle stay live. The Add-board split lives in its own
  // wrapper, so gather every editing button by element.
  const editButtons = () => [
    partsBtn,
    wireBtn,
    ...swatchStrip.querySelectorAll(".wire-swatch"),
    ...toolbar.querySelectorAll(".toolbar-split button"),
  ];
  const onRunStateChange = (running) => {
    controller.setEditingLocked(running);
    runBtn.textContent = running ? "■ Stop" : "▶ Run";
    runBtn.title = running
      ? "Stop and return to editing (Space)"
      : "Run the circuit (Space)";
    runBtn.setAttribute("aria-pressed", String(running));
    runBtn.classList.toggle("toolbar-btn--running", running);
    for (const btn of editButtons()) btn.disabled = running;
  };
  sim = new SimController({ deskDoc, notifications, onRunStateChange });

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
