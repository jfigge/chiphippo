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
import * as i18n from "./i18n.js";
import { t } from "./i18n.js";
import { DeskView } from "./components/desk-view.js";
import { ZoomControl } from "./components/zoom-control.js";
import { DeskLock } from "./components/desk-lock.js";
import { DeskController } from "./components/desk-controller.js";
import { SchematicView } from "./components/schematic-view.js";
import { PalettePanel } from "./components/palette-panel.js";
import { ProjectTabs } from "./components/project-tabs.js";
import { ProjectWorkspace } from "./components/project-workspace.js";
import { BuildGuide } from "./components/build-guide.js";
import { ScopeView } from "./components/scope-view.js";
import { AiPanel } from "./components/ai-panel.js";
import { checkConnection, effectiveProvider } from "./ai/connection.js";
import { SimController, SPEEDS } from "./components/sim-controller.js";
import { NetlistCache } from "./components/netlist-cache.js";
import { MemoryBridge } from "./components/memory-bridge.js";
import { NotificationStack } from "./components/notification-stack.js";
import { NetNameMonitor } from "./components/net-name-monitor.js";
import { UpdaterMonitor } from "./components/updater-monitor.js";
import { createWireColorDot } from "./components/wire-color-dot.js";
import { createBusWidthBadge } from "./components/bus-width-badge.js";
import { PopupManager } from "./popup-manager.js";
import { AboutDialog } from "./components/about-dialog.js";
import { SettingsDialog } from "./components/settings-dialog.js";
import { KeyboardShortcutsDialog } from "./components/keyboard-shortcuts.js";
import { DeskDoc } from "./model/desk-doc.js";
import { partDef } from "./catalog/index.js";

/** How long after the last camera change to persist the viewport. */
const VIEWPORT_SAVE_DEBOUNCE_MS = 500;

/** Speed-selector labels (keyed by the SimController multiplier). */
const SPEED_LABELS = { 0.25: "×¼", 1: "×1", 4: "×4" };

/** The platform-correct modifier glyph for tooltips (⌘ on macOS, Ctrl elsewhere). */
const IS_MAC = window.chiphippo?.platform === "darwin";
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** A menu-style accelerator hint ("⇧⌘S" on macOS, "Shift+Ctrl+S" elsewhere) —
    the same accelerators the native File menu registers (main.js). */
const accel = (key, shift = false) =>
  IS_MAC ? `${shift ? "⇧" : ""}⌘${key}` : `${shift ? "Shift+" : ""}Ctrl+${key}`;

/**
 * The modeled duration of one engine tick (a clock half-period), for the logic
 * analyzer's Δ-time readout — the fastest free-running clock at the current
 * speed. Null when there is no periodic clock (manual/step: only Δticks shown).
 */
function tickMsFor(deskDoc, sim) {
  if (!sim) return null;
  const hzList = deskDoc
    .toJSON()
    .components.filter((c) => c.kind === "clock")
    .map((c) => c.params?.hz)
    .filter((hz) => typeof hz === "number" && hz > 0);
  if (!hzList.length) return null;
  return 1000 / (2 * Math.max(...hzList) * sim.speed);
}

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

/** Schematic file icons — the File pill's Save button and the file menu's
    New / Open / Save items. */
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

/** Save As — the floppy left open at the corner a pencil writes into. */
const SAVE_AS_SVG =
  ICON_SVG_OPEN +
  '<path d="M13 19H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9l4 4v3"/>' +
  '<polyline points="7 3 7 8 13 8"/>' +
  '<path d="M19 13a1.8 1.8 0 0 1 2.5 2.5L16.5 20.5l-3.5 1 1-3.5z"/></svg>';

/** Connectivity-probe icon for the Probe toolbar toggle: a probe tip landing
 * on a digital rising edge, with a cable trailing off the handle end. */
const PROBE_SVG =
  ICON_SVG_OPEN +
  '<path d="M3 19h4v-6h5"/>' +
  '<line x1="20" y1="4" x2="13" y2="11"/>' +
  '<path d="M20 4c1-1.5 3-1.5 3 0"/></svg>';

/** Logic-analyzer icon for the Analyzer toolbar toggle: a recorded digital
 * waveform — what the panel draws. */
const ANALYZER_SVG =
  ICON_SVG_OPEN +
  '<polyline points="2 18 6 18 6 6 11 6 11 18 16 18 16 6 22 6"/></svg>';

/** "Fade wires" toggle icon — the effect itself: two tie points joined by a
 * jumper drawn solid off each end and faded away in between. */
const FADE_WIRES_SVG =
  ICON_SVG_OPEN +
  '<path d="M4 7 Q12 19 20 7" opacity=".3"/>' +
  '<path d="M4 7 Q6.24 10.36 8.48 11.84"/>' +
  '<path d="M15.52 11.84 Q17.76 10.36 20 7"/>' +
  '<circle cx="4" cy="7" r="1.8"/>' +
  '<circle cx="20" cy="7" r="1.8"/></svg>';

/** Fit-to-screen ("locate") icon for the toolbar action that frames every
 * board/part/wire on the desk — a crosshair/target glyph. */
const LOCATE_SVG =
  ICON_SVG_OPEN +
  '<circle cx="12" cy="12" r="10"/>' +
  '<line x1="22" y1="12" x2="18" y2="12"/>' +
  '<line x1="6" y1="12" x2="2" y2="12"/>' +
  '<line x1="12" y1="6" x2="12" y2="2"/>' +
  '<line x1="12" y1="22" x2="12" y2="18"/></svg>';

/** Zoom-out-fully glyph the Fit-to-screen button swaps to while hovered with
 * Shift held (⌘⇧F previews as a magnifying glass with a "−"). */
const ZOOM_OUT_SVG =
  ICON_SVG_OPEN +
  '<circle cx="11" cy="11" r="8"/>' +
  '<line x1="21" y1="21" x2="16.65" y2="16.65"/>' +
  '<line x1="8" y1="11" x2="14" y2="11"/></svg>';

/** The AI segment's tooltip while it is available (see `refreshAiReady`). A
    function, not a const: `t()` must never be called at module scope, where the
    catalog is not loaded yet (see i18n.js). */
const aiTitle = () => t("toolbar.ai.title");

/** AI-builder icon: a four-point spark — the app-wide "generated" glyph. */
const AI_SVG =
  ICON_SVG_OPEN +
  '<path d="M12 3 13.8 9.2 20 11 13.8 12.8 12 19 10.2 12.8 4 11 10.2 9.2Z"/>' +
  '<path d="M18.5 3.5 19.2 5.8 21.5 6.5 19.2 7.2 18.5 9.5 17.8 7.2 15.5 6.5 ' +
  '17.8 5.8Z"/></svg>';

/** Schematic-view icon: what the view itself draws — two symbol boxes joined
 * by one orthogonally routed net. */
const SCHEMATIC_SVG =
  ICON_SVG_OPEN +
  '<rect x="2.5" y="3.5" width="7.5" height="6.5" rx="1"/>' +
  '<rect x="14" y="14" width="7.5" height="6.5" rx="1"/>' +
  '<path d="M10 6.75h2.25v10.5H14"/></svg>';

/** Breadboard icon the Schematic toggle swaps to while the diagram is
 * showing: a board's two rows of tie points either side of the trench. */
const BREADBOARD_SVG =
  ICON_SVG_OPEN +
  '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/>' +
  '<line x1="2.5" y1="12" x2="21.5" y2="12"/>' +
  '<line x1="7" y1="8" x2="7.01" y2="8"/>' +
  '<line x1="12" y1="8" x2="12.01" y2="8"/>' +
  '<line x1="17" y1="8" x2="17.01" y2="8"/>' +
  '<line x1="7" y1="16" x2="7.01" y2="16"/>' +
  '<line x1="12" y1="16" x2="12.01" y2="16"/>' +
  '<line x1="17" y1="16" x2="17.01" y2="16"/></svg>';

/** Build-guide (clipboard-list) icon for the Guide toolbar toggle. */
const GUIDE_SVG =
  ICON_SVG_OPEN +
  '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>' +
  '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 ' +
  '1 2-2h2"/>' +
  '<line x1="12" y1="11" x2="16" y2="11"/>' +
  '<line x1="12" y1="16" x2="16" y2="16"/>' +
  '<line x1="8" y1="11" x2="8.01" y2="11"/>' +
  '<line x1="8" y1="16" x2="8.01" y2="16"/></svg>';

/**
 * The header bar. Returns the elements whose LABELS have to be re-applied when
 * the language changes (`relabelChrome` in init()) rather than just the finished
 * node — Chip Hippo never reloads the window, so a locale change has to be
 * applied to the chrome that is already on screen.
 * @returns {{header: HTMLElement, iconBtn: HTMLElement, settingsBtn: HTMLElement}}
 */
function buildHeader() {
  const header = document.createElement("header");
  header.className = "app-header";
  header.setAttribute("aria-label", t("app.header"));

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
  iconBtn.title = t("app.about");
  iconBtn.setAttribute("aria-label", t("app.about"));
  iconBtn.append(icon);
  iconBtn.addEventListener("click", () => AboutDialog.open());

  const logo = document.createElement("span");
  logo.className = "app-logo";
  logo.textContent = "Chip Hippo";

  brand.append(iconBtn, logo);

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
  actions.setAttribute("aria-label", t("app.actions"));

  const settingsBtn = document.createElement("button");
  settingsBtn.className = "icon-btn header-icon-btn";
  settingsBtn.type = "button";
  settingsBtn.title = t("app.settings");
  settingsBtn.setAttribute("aria-label", t("app.openSettings"));
  settingsBtn.innerHTML = GEAR_SVG;
  settingsBtn.addEventListener("click", () =>
    window.dispatchEvent(new CustomEvent("chiphippo:open-settings")),
  );
  actions.append(settingsBtn);

  header.append(brand, toolbar, actions);
  return { header, iconBtn, settingsBtn };
}

function buildDesk() {
  const desk = document.createElement("section");
  desk.className = "desk-viewport";
  desk.setAttribute("aria-label", t("app.desk"));

  // Inert overlay hint (pointer-events: none) — Feature 30's "add board"
  // flow replaces it.
  const hint = document.createElement("p");
  hint.className = "desk-hint";
  hint.textContent = t("app.deskHint");

  desk.append(hint);
  return desk;
}

/** The schematic surface (Feature 150) — a sibling of the desk, hidden until
    the Breadboard ⇄ Schematic toggle (or Tab) switches to it. */
function buildSchematicViewport() {
  const view = document.createElement("section");
  view.className = "schematic-viewport";
  view.setAttribute("aria-label", t("app.schematic"));
  view.hidden = true;
  return view;
}

/**
 * Central keyboard shortcuts: desk keys (Esc / Delete via DeskController)
 * first, then Space to toggle Run/Stop (only when no tool is armed), then the
 * one FILE accelerator the native menu doesn't own (⇧⌘O, the recent projects),
 * then the app-chrome accelerators (analyzer / palette / run toggle / desk
 * lock), then cmd/ctrl +, −, 0 for the desk zoom.
 */
function bindShortcuts(
  controller,
  sim,
  scopeView,
  togglePalette,
  getActiveView,
  fitActiveView,
  onToggleView,
  onToggleLock,
  onOpenRecent,
) {
  // Option held over a selected part rings the wire ends an Option-drag would
  // carry (Feature 290). Its own listeners rather than a `handleKeyDown` case,
  // because that method's contract is "did I CONSUME this key" and a modifier
  // must not: Option is still a modifier for everything else while it is down.
  // Same trio as the Fit button's Shift-held zoom-out preview, blur included —
  // a modifier released outside the window never fires our own keyup.
  const ridePreview = (on) => controller.setRidePreview(on);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt") ridePreview(true);
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt") ridePreview(false);
  });
  window.addEventListener("blur", () => ridePreview(false));

  window.addEventListener("keydown", (e) => {
    // A dialog/menu owns the keyboard while it's open — its own handlers
    // (native Escape-to-cancel, button activation) must be the only thing
    // that reacts, so no desk/app shortcut leaks through underneath it.
    if (PopupManager.isOpen()) return;
    // Tab flips Breadboard ⇄ Schematic (Feature 150) — not while typing.
    if (
      e.key === "Tab" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      const tag = e.target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        e.target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      onToggleView?.();
      return;
    }
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
        controller.busToolArmed ||
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
    // A — the logic analyzer, on a BARE key like the desk's other tool
    // letters (W wire, B bus, I probe). Cmd/Ctrl+A is not this: it is
    // Select All, which the native Edit menu owns.
    if (
      (e.key === "a" || e.key === "A") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      // prettier-ignore
      const tag = e.target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        e.target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      scopeView.toggle();
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    // ⇧⌘O — the recent projects, the same menu the toolbar's Open segment drops
    // on a secondary click. It sits AHEAD of the typing guard below, beside the
    // ⌘O it shadows: a file action is aimed at the app, not at whatever has
    // focus, and no browser binding claims this chord.
    if (e.shiftKey && (e.key === "o" || e.key === "O")) {
      e.preventDefault();
      onOpenRecent?.();
      return;
    }
    // Cmd/Ctrl+P / +R / +F / +L toggle app chrome — not while typing, where the
    // browser's own bindings must win.
    const tag = e.target?.tagName;
    const typing =
      tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable;
    if (!typing) {
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        togglePalette();
        return;
      }
      if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        sim.toggle();
        return;
      }
      // The desk padlock. It goes through the padlock's own toggle rather than
      // straight to setWheelLocked, so the key and the button drive the one
      // path and the icon can never disagree with the wheel.
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        onToggleLock();
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (e.shiftKey) {
          getActiveView().zoomOutFull();
        } else {
          fitActiveView(); // the desk, or the schematic when it is showing
        }
        return;
      }
    }
    const view = getActiveView();
    if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      view.zoomIn();
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      view.zoomOut();
    } else if (e.key === "0") {
      e.preventDefault();
      view.resetZoom();
    }
  });
}

async function init() {
  const bridge = window.chiphippo;

  // Resolve the active language and load its catalog BEFORE anything renders,
  // so the very first `t()` call — in buildHeader, below — resolves against the
  // right catalog rather than painting English and correcting itself. Main
  // decides which language that is (the persisted preference, else the OS
  // locale, else English) because it owns both the setting and the files; this
  // also sets <html lang>. See i18n.js.
  await i18n.init();

  // Load settings BEFORE mounting the desk so the saved viewport applies on
  // the first paint (acceptable to proceed with defaults if the read fails).
  let settings = {};
  try {
    settings = await bridge.settings.get();
  } catch (err) {
    console.error("[renderer] settings:get failed:", err);
  }

  // Projects: there is ALWAYS one, and its active desktop is the document the
  // desk starts on. Read BEFORE anything mounts, so the app opens straight
  // onto that desktop instead of painting a blank desk and swapping it out a
  // moment later. Main decides which project that is (the unsaved one in its
  // saves folder, the most recently used one, or a brand-new one).
  let projectBoot = null;
  try {
    projectBoot = await ProjectWorkspace.boot(bridge);
  } catch (err) {
    console.error("[renderer] project boot failed:", err);
  }

  const app = document.getElementById("app");
  const desk = buildDesk();
  // Main row below the header: the parts palette (left, toggleable) beside
  // the full-bleed desk.
  const main = el("div", { class: "app-main" });
  const header = buildHeader();
  app.append(header.header, main);
  let workspace = null;

  // Desk document (Feature 20): the boards/components/wires of the desktop on
  // screen, held in one in-memory DeskDoc. Anything that mutates it dispatches
  // a global `chiphippo:doc-changed` CustomEvent. The desk is one DESKTOP of
  // the open PROJECT, which is the document: it is written to its one file
  // deliberately (⌘S), never autosaved, so the • in the title is what says the
  // work is only on screen.
  const deskDoc = new DeskDoc(projectBoot?.doc ?? null);
  // ONE netlist cache shared by every consumer (probe, sim, build guide,
  // schematic): a topology change rebuilds the partition once instead of once
  // per consumer, and they can never tint/route/list from divergent nets.
  const netlistCache = new NetlistCache(deskDoc);

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

  // The window title names the project and the desktop on screen. Its • leads
  // the whole thing, and there is only one thing it can stand for now: the
  // project is the document, so its dirty flag covers every desktop's design,
  // the list of desktops, and their names alike.
  const updateTitle = () => {
    const tab = workspace?.activeTab;
    const marker = workspace?.dirty ? "• " : "";
    const project = workspace?.projectName || t("common.untitled");
    document.title = tab
      ? `${marker}${project} — ${tab.name} — Chip Hippo`
      : "Chip Hippo";
  };
  updateTitle();
  window.addEventListener("chiphippo:doc-changed", updateTitle);

  // ── The File and Desktop menus ────────────────────────────────────────────
  // The application menu (main.js `buildAppMenu`) pushes one event per item;
  // every one of them is the workspace's to answer, since it is the only side
  // that knows what is open and what is unsaved. FILE acts on the project —
  // the document — and the toolbar's File pill dispatches the very same
  // events, so the two can't drift. DESKTOP edits the structure inside it, and
  // acts on whichever desktop is on screen. Open Recent is the one push that
  // carries a payload: the project file its item stands for.
  for (const [event, run] of [
    ["chiphippo:project-new", () => workspace?.newProject()],
    ["chiphippo:project-open", () => workspace?.loadProject()],
    ["chiphippo:project-save", () => workspace?.save()],
    ["chiphippo:project-save-as", () => workspace?.saveAs()],
    ["chiphippo:project-properties", () => workspace?.editProjectProperties()],
    ["chiphippo:desktop-add", () => workspace?.addTab()],
    ["chiphippo:desktop-import", () => workspace?.importTab()],
    ["chiphippo:desktop-duplicate", () => activeDesktopAction("duplicateTab")],
    ["chiphippo:desktop-export", () => activeDesktopAction("exportTab")],
    ["chiphippo:desktop-properties", () => activeDesktopAction("editTabProperties")], // prettier-ignore
    ["chiphippo:desktop-delete", () => activeDesktopAction("deleteTab")],
  ]) {
    window.addEventListener(event, () => void run());
  }
  window.addEventListener("chiphippo:project-open-recent", (e) => {
    if (e.detail) void workspace?.openRecentProject(e.detail);
  });

  // A part's EXAMPLE CIRCUIT, asked for from its pin-assignments window. That
  // window has a ref and nothing else — no project, no desk — so main relays
  // the request here, where both live (the memory inspector's host relay is the
  // same pipe). The desktop arrives through the workspace; it is FRAMED here,
  // because framing follows the ACTIVE view and only app.js knows which that
  // is. The fit is camera-only: `make demos` writes every example already
  // centred on the origin, so ⌘F's recentre half finds a zero delta and leaves
  // no undo step behind on a desk nobody has touched. A desktop that was
  // already open is not re-framed — its camera is the user's.
  window.addEventListener("chiphippo:demo-host-inbound", (e) => {
    const ref = e.detail?.ref;
    if (!ref) return;
    void workspace?.openExample(ref).then((res) => {
      if (res === "added") fitActiveView();
    });
  });

  /** A Desktop-menu item aimed at whichever desktop is on screen. */
  function activeDesktopAction(method) {
    const id = workspace?.activeTab?.id;
    if (id) return workspace[method](id);
  }

  // ── Closing the window / quitting ────────────────────────────────────────
  // Main prevents the close and asks HERE, because the unsaved state and the
  // dialog that deals with it both live in the renderer. Desktops are written
  // deliberately, never autosaved, so without this a • on a tab dies with the
  // window. It must reply EXACTLY once, whatever happens: main waits for the
  // answer with no timeout (the user is entitled to think about it), and it
  // LATCHES until the reply comes — so a guard that never answered would leave
  // an app that cannot be closed at all. `confirmClose()` therefore guarantees
  // both that it settles and that it never rejects.
  //
  // The default here used to be `true` — let the close proceed if the guard
  // threw — on the reasoning that a broken guard must not wedge the app. But
  // main's reply latch is per-attempt, so blocking is only ever ONE refused
  // ⌘Q, while proceeding is the project gone: `true` was trading the user's
  // unsaved work for an inconvenience. There is nothing here that can tell a
  // failed question from an answered one, so it has to assume the worst.
  window.addEventListener("chiphippo:confirm-close", async () => {
    let ok = false;
    try {
      ok = workspace ? await workspace.confirmClose() : true;
    } catch (err) {
      console.error("[renderer] close guard failed:", err);
    }
    bridge.closeReply(ok).catch((err) => {
      console.error("[renderer] app:close-reply failed:", err);
    });
  });

  let zoomControl = null;
  let deskLock = null;
  let controller = null;

  // Parts palette (left panel; visibility persists in settings). Any part
  // with a `colors` list (the LED and the segment/bar displays) arms
  // placement directly with the "Default LED color" setting (Settings ▸
  // Appearance) — no placement-time color popover any more. Its color is
  // changed afterward through its own Properties dialog (right-click ▸
  // Properties…); everything else arms its placement ghost directly.
  const palette = new PalettePanel(main, {
    onPickChip: (ref) => {
      if (partDef(ref)?.colors) {
        controller?.armPartPlacement(ref, {
          color: currentSettings.defaultLedColor,
        });
        return;
      }
      controller?.armPartPlacement(ref);
    },
    // The board selector (Full / Half / Tiny + loose strips) lives at the top
    // of the palette; picking one arms board placement, ghost + all.
    onPickBoard: (kit) => controller?.armPlacement(kit),
    // The annotations section (labels + notes) lives at the bottom.
    onPickAnnotation: (kind) => controller?.armAnnotationPlacement(kind),
    // The tray's own header chevron / desk-edge flap. `togglePalette` is
    // declared with the toolbar further below; this closure only runs on a
    // click, long after that.
    onToggle: () => togglePalette(),
    // The tray's own width, dragged on its right edge. Persisted like the open
    // flag — the panel reports, app.js writes.
    width: settings.paletteWidth,
    onWidthChange: (width) => {
      bridge.settings
        .set({ paletteWidth: width })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    },
    // Collapse state is deliberately NOT persisted — the palette opens with
    // every group shut, every launch (see PalettePanel).
  });
  palette.setVisible(settings.paletteOpen === true);

  // The stage: whichever surface is showing (desk or schematic) with the
  // desktop tab strip over it. It sits to the RIGHT of the palette, so the
  // tabs start where the desk does rather than spanning the palette too.
  const stage = el("div", { class: "app-stage" });
  main.append(stage);
  // The tab strip leads the stage (append order IS the layout) and is ALWAYS
  // showing — with no project open it carries the working desk's own tab, so
  // the "+" that adds another desktop is never hidden behind a project that
  // has to be created first. Its callbacks reach the workspace built below.
  const projectTabs = new ProjectTabs(stage, {
    onSelect: (id) => workspace?.selectTab(id),
    onAdd: () => workspace?.addTab(),
    onImport: () => void workspace?.importTab(),
    onProperties: (id) => workspace?.editTabProperties(id),
    onDuplicate: (id) => void workspace?.duplicateTab(id),
    onExport: (id) => void workspace?.exportTab(id),
    onDelete: (id) => workspace?.deleteTab(id),
  });
  stage.append(desk);

  // The schematic surface sits beside the desk (Feature 150); a header toggle
  // (or Tab) swaps which one is visible. Constructed further below, once the
  // controller exists to receive its position-nudge commits.
  const schematicViewport = buildSchematicViewport();
  stage.append(schematicViewport);
  let schematicView = null;
  let mode = "desk";

  // Build guide (Feature 140): a right-docked panel deriving the BOM / wiring
  // list / assembly steps from the live document. Visibility persists like the
  // palette; the desk-tool pill's BOM segment (⌘B), its own close button, and
  // the native File menu all route through onVisibilityChange so the persisted
  // setting — and the segment's armed state — stay in step however it was
  // flipped.
  let guideBtn = null;
  const buildGuide = new BuildGuide(main, {
    deskDoc,
    netlist: netlistCache,
    // The exported BOM file is named after the desktop it was derived from.
    schemaName: () => workspace?.activeTab?.name ?? "desktop",
    onVisibilityChange: (visible) => {
      guideBtn?.classList.toggle("toolbar-btn--active", visible);
      guideBtn?.setAttribute("aria-pressed", String(visible));
      bridge.settings
        .set({ guideOpen: visible })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    },
  });
  buildGuide.setVisible(settings.guideOpen === true);
  // File ▸ Bill Of Materials… (⌘B) — pushed by the native File menu; the
  // toolbar's own BOM segment calls buildGuide.toggle() directly.
  window.addEventListener("chiphippo:build-guide", () => buildGuide.toggle());

  // Logic analyzer (Feature 210): a bottom-docked waveform panel that records
  // the sim-state stream into timing diagrams. Its channel mutations route
  // through the controller (undo/redo), and it stays live while the sim runs.
  let scopeBtn = null;
  const scopeView = new ScopeView(app, {
    deskDoc,
    netlist: netlistCache,
    height: settings.scopeHeight,
    onVisibilityChange: (visible) => {
      scopeBtn?.classList.toggle("toolbar-btn--active", visible);
      scopeBtn?.setAttribute("aria-pressed", String(visible));
      bridge.settings
        .set({ scopeOpen: visible })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    },
    onHeightChange: (height) => {
      bridge.settings
        .set({ scopeHeight: height })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    },
    onAddChannel: (kind, ref) => controller?.addScopeChannel(kind, ref),
    onRemoveChannel: (id) => controller?.removeScopeChannel(id),
    onMoveChannel: (id, index) => controller?.moveScopeChannel(id, index),
    tickMs: () => tickMsFor(deskDoc, sim),
  });
  scopeView.setVisible(settings.scopeOpen === true);

  // The live settings document. Declared here rather than beside the Settings
  // dialog below because the AI panel reads `ai` from it on every send — that
  // is how a Settings change reaches the panel with no wiring between them.
  let currentSettings = settings;
  // The transport's last reported mode, kept because several panels need to
  // know the desk is frozen and `sim` itself is built further down.
  let transportMode = "stopped";

  // AI circuit builder (Feature 260): describe a circuit, get a verified design
  // ARMED as a placement ghost. It hands over a design clip and nothing else —
  // the desk's own atomic paste path does the placing, so a generated circuit
  // rides undo/redo exactly as a pasted one does.
  let aiBtn = null;
  const aiPanel = new AiPanel(app, {
    config: () => currentSettings.ai ?? {},
    height: settings.aiHeight,
    history: settings.aiHistory,
    isLocked: () => transportMode !== "stopped",
    onDesign: (clip) => controller?.armGeneratedDesign(clip),
    onHistoryChange: (entries) => {
      bridge.settings
        .set({ aiHistory: entries })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    },
    onVisibilityChange: (visible) => {
      aiBtn?.classList.toggle("toolbar-btn--active", visible);
      aiBtn?.setAttribute("aria-pressed", String(visible));
      bridge.settings
        .set({ aiOpen: visible })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    },
    onHeightChange: (height) => {
      bridge.settings
        .set({ aiHeight: height })
        .catch((err) => console.error("[renderer] settings:set failed:", err));
    },
  });

  // The AI segment is only offered when there is a connection to ask: a key
  // stored for the chosen provider, a provider this build has an adapter for,
  // and a base URL that could be reached (`ai/connection.js` decides, without
  // a network call — nothing is sent anywhere until the user asks for a
  // build). So the panel's restore waits for that answer rather than firing
  // here: an `aiOpen` remembered from a session that HAD a key must not
  // reopen a panel whose button is now dead, and must not be overwritten
  // either — the key may well come back.
  let aiProviders = null; // main's provider list, read once
  let aiRestored = false; // whether the remembered `aiOpen` has been applied
  const refreshAiReady = async () => {
    let ready = { ok: false, reason: t("toolbar.ai.unreadable") };
    try {
      aiProviders ??= (await bridge.ai?.providers?.()) ?? [];
      const config = currentSettings.ai ?? {};
      // The key is asked about for the provider `checkConnection` will judge —
      // one rule, so the button can never be gated on a key for a provider the
      // Settings panel is not showing.
      const provider = effectiveProvider(config, aiProviders)?.id;
      const status = provider ? await bridge.ai?.key?.status(provider) : null;
      ready = checkConnection(config, aiProviders, status);
    } catch (err) {
      console.error("[renderer] ai readiness check failed:", err);
    }
    if (aiBtn) {
      aiBtn.disabled = !ready.ok;
      aiBtn.title = ready.ok ? aiTitle() : ready.reason;
    }
    if (ready.ok) {
      // First pass only: honour the remembered state, never force the panel
      // open under the user afterwards.
      if (aiRestored === false) aiPanel.setVisible(settings.aiOpen === true);
    } else if (aiPanel.visible) {
      // A key cleared while the panel is open leaves a panel no button can
      // close — so it goes with the connection it belonged to.
      aiPanel.setVisible(false);
    }
    aiRestored = true;
  };
  // Settings ▸ AI changing the provider (a settings patch) or the key itself
  // (which bypasses settings entirely, straight to the OS-encrypted store) are
  // the two ways this answer changes.
  window.addEventListener("chiphippo:ai-key-changed", () => refreshAiReady());

  const deskView = new DeskView(desk, {
    camera: settings.viewport,
    onViewportChange: (camera) => {
      zoomControl?.setZoom(camera.zoom);
      controller?.onViewportChange(camera);
      scheduleViewportSave(camera);
    },
  });

  // Everything ON the desk (boards, chips, wires, placement, hover).
  let wireBtn = null;
  let wireDot = null; // the Wire button's color dot: readout AND picker
  let busBtn = null;
  let busWidth = null; // the Bus button's width badge: readout AND picker
  let probeBtn = null;
  let fadeBtn = null; // the "Fade wires" toggle
  let sim = null; // the SimController (created after the toolbar below)
  let memoryBridge = null; // memory-inspector coordinator (created with sim)
  const onWireStateChange = ({ armed, color }) => {
    wireBtn?.classList.toggle("toolbar-btn--active", armed);
    wireBtn?.setAttribute("aria-pressed", String(armed));
    // The Wire button carries a dot showing the active color — and, uniquely
    // among the pill's readouts, it is the picker for it too
    // (components/wire-color-dot.js). Whatever set the color — a swatch, 1–8 —
    // arrives here, so the dot has one repaint path.
    wireDot?.setColor(color);
  };
  const onBusStateChange = ({ armed }) => {
    busBtn?.classList.toggle("toolbar-btn--active", armed);
    busBtn?.setAttribute("aria-pressed", String(armed));
  };
  const onProbeStateChange = ({ armed }) => {
    probeBtn?.classList.toggle("toolbar-btn--active", armed);
    probeBtn?.setAttribute("aria-pressed", String(armed));
  };
  // Fading the wires is a view preference, so it persists like the panels do —
  // and the button follows whether the toolbar or H flipped it.
  const onWireFadeChange = ({ faded }) => {
    fadeBtn?.classList.toggle("toolbar-btn--active", faded);
    fadeBtn?.setAttribute("aria-pressed", String(faded));
    bridge.settings
      .set({ wiresFaded: faded })
      .catch((err) => console.error("[renderer] settings:set failed:", err));
  };
  controller = new DeskController({
    viewport: desk,
    deskView,
    deskDoc,
    netlist: netlistCache,
    onWireStateChange,
    onBusStateChange,
    // The badge's one repaint path: whatever set the width — a digit key, or
    // the badge's own picker — arrives here.
    onBusNameChange: (name) => busWidth?.setName(name),
    onProbeStateChange,
    onWireFadeChange,
    // Probe context-menu → pin the net as an analyzer channel (and reveal it).
    onAddNetToAnalyzer: (address) => {
      scopeView.addNetChannel(address);
      scopeView.setVisible(true);
    },
    onClockToggle: (id) => sim?.manualToggle(id),
    // A part's (or a wire's) "Pin Assignment" context-menu item → its
    // floating pin/terminal-assignments OS window (`rows` sizes it to the
    // layout; `rot` is a snapshot of the part's placed rotation — only an
    // oscillator can's corner assignment depends on it, see chip-pinout.js's
    // buildCanPinout; `kind: "wire"` routes main to the query flag pinout.js
    // reads instead of resolving `ref` against the catalog — a wire has no
    // catalog def, so `ref` is just its own id, e.g. "w12").
    onOpenPinout: (ref, rows, rot, kind) =>
      bridge
        .openPinout?.(ref, { rows, rot, kind })
        .catch((err) => console.error("[renderer] pinout:open failed:", err)),
    // A memory chip's "Inspect memory…" context-menu item → its hex inspector
    // window.
    onOpenMemory: (id) => memoryBridge?.open(id),
    // "Load image… (program)" on a ROM chip → the in-app external programmer.
    onProgramMemory: (id) => memoryBridge?.program(id),
    // A ROM chip gets a noise-filled backing file on placement, deleted on
    // removal (the byte store lives in main; Feature 190).
    onCreateMemoryFile: (guid, byteLength) =>
      bridge.mem
        ?.create(guid, byteLength)
        .catch((err) => console.error("[renderer] mem:create failed:", err)),
    onRemoveMemoryFile: (guid) =>
      bridge.mem
        ?.delete(guid)
        .catch((err) => console.error("[renderer] mem:delete failed:", err)),
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

  // Edit ▸ Select All (⌘A). "Everything" depends on where the focus is, which
  // is why main pushes rather than running the native role: a TEXT FIELD (the
  // palette search, a Properties dialog, a name prompt) selects its own text,
  // and the DESK selects every board, part and wire — the same set a marquee
  // takes, so ⌘A ⌘C copies the whole desktop.
  //
  // With a dialog open and the focus NOT in a field there is nothing to do:
  // selecting the desk underneath it would act on what the user cannot see.
  window.addEventListener("chiphippo:edit-select-all", () => {
    const target = document.activeElement;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      target.select();
      return;
    }
    if (target?.isContentEditable) {
      document.execCommand("selectAll");
      return;
    }
    if (PopupManager.isOpen()) return;
    controller.selectAll();
  });

  const toolbar = document.getElementById("app-toolbar");

  // Breadboard ⇄ Schematic view toggle (Feature 150): a desk-tool pill segment
  // built further down (between Bill Of Materials and AI). Unlike the panel
  // toggles either side of it this one swaps the whole viewport, so its icon
  // swaps too — it shows the view it would take you TO, the way the
  // Fit/zoom-out segment previews its alternate action.
  let modeBtn = null;

  function setMode(next) {
    mode = next === "schematic" ? "schematic" : "desk";
    const schematic = mode === "schematic";
    desk.hidden = schematic;
    schematicView?.setVisible(schematic);
    if (!modeBtn) return;
    modeBtn.classList.toggle("toolbar-btn--active", schematic);
    modeBtn.innerHTML = schematic ? BREADBOARD_SVG : SCHEMATIC_SVG;
    modeBtn.setAttribute(
      "aria-label",
      schematic ? t("toolbar.mode.breadboard") : t("toolbar.mode.schematic"),
    );
    modeBtn.title = schematic
      ? t("toolbar.mode.breadboardTitle")
      : t("toolbar.mode.schematicTitle");
    modeBtn.setAttribute("aria-pressed", String(schematic));
  }

  // File actions — a PILL, the same shape the desk tools use: one border
  // around a row of borderless segments. They act on the PROJECT, which is the
  // document: one file holds every desktop, so New / Open / Save / Save As
  // mean one thing each. Every file action is its own segment rather than a
  // row hidden behind a ▾: they're peers, and a toolbar's job is to show
  // what's available. Each is icon-only with the name + accelerator in its
  // tooltip, and dispatches the SAME chiphippo:* event the native File menu
  // pushes, so the two can't drift — an MRU list still can't be a BUTTON, but
  // it is what Open's SECONDARY click offers (see below), the same split the
  // tab strip's "+" uses: a primary click does the common thing, a secondary
  // one drops the menu behind it.
  const fileBtn = ({
    icon,
    label,
    title,
    haspopup = false,
    onClick,
    onContextMenu = null,
  }) => {
    const btn = el("button", {
      class: "toolbar-pill-btn toolbar-pill-btn--icon",
      type: "button",
      title,
      "aria-label": label,
      "aria-haspopup": haspopup ? "menu" : null,
      onClick,
      onContextMenu,
    });
    btn.innerHTML = icon;
    return btn;
  };

  /** Every segment fires the File menu's own push — one code path, two UIs. */
  const fileAction = (event) => () =>
    window.dispatchEvent(new CustomEvent(`chiphippo:${event}`));

  const fileNewBtn = fileBtn({
    icon: NEW_SVG,
    label: t("toolbar.file.new"),
    title: t("toolbar.file.newTitle", { accel: accel("N") }),
    onClick: fileAction("project-new"),
  });
  const fileOpenBtn = fileBtn({
    icon: LOAD_SVG,
    label: t("toolbar.file.open"),
    // Two accelerators in one tooltip: the segment's own, and the chord that
    // drops the menu its secondary click does (bindShortcuts).
    title: t("toolbar.file.openTitle", {
      accel: accel("O"),
      recent: accel("O", true),
    }),
    onClick: fileAction("project-open"),
    // Open's secondary click IS File ▸ Open Recent, off main's own MRU list.
    // It goes straight to the workspace rather than through a chiphippo:*
    // push: the native menu bakes its recent list into the menu template, so
    // there is no menu item here to drift from — only the same list, asked for
    // at the moment the card opens.
    onContextMenu: (e) => {
      e.preventDefault();
      void workspace?.openRecentMenu(e.clientX, e.clientY);
    },
  });
  const fileSaveBtn = fileBtn({
    icon: SAVE_SVG,
    label: t("toolbar.file.save"),
    title: t("toolbar.file.saveTitle", { accel: accel("S") }),
    onClick: fileAction("project-save"),
  });
  const fileSaveAsBtn = fileBtn({
    icon: SAVE_AS_SVG,
    label: t("toolbar.file.saveAs"),
    title: t("toolbar.file.saveAsTitle", { accel: accel("S", true) }),
    onClick: fileAction("project-save-as"),
  });
  const filePill = el(
    "div",
    {
      class: "toolbar-pill",
      role: "group",
      "aria-label": t("toolbar.file.group"),
    },
    [fileNewBtn, fileOpenBtn, fileSaveBtn, fileSaveAsBtn],
  );

  // DESKTOP actions have no toolbar button at all: Add / Duplicate / Import /
  // Export / Properties / Delete are the application's **Desktop** menu
  // (main.js `buildAppMenu`) and the tab strip's own context menu — a desktop
  // is reached through its tab, so that is where the things one can do to it
  // belong.
  toolbar.append(
    filePill,
    el("span", { class: "toolbar-divider", "aria-hidden": "true" }),
  );

  // The parts tray has no toolbar button: it carries its own chevron in the
  // header and its own flap on the desk edge (see PalettePanel), both of which
  // route back here so ⌘P, the chevron, and the flap are one code path.
  const togglePalette = () => {
    const on = !palette.visible;
    palette.setVisible(on);
    bridge.settings
      .set({ paletteOpen: on })
      .catch((err) => console.error("[renderer] settings:set failed:", err));
  };

  // ── Desk-tool pill (Wire / Bus / Fade / Probe / Analyzer / Fit) ───────────
  // The six desk tools read as ONE control: a single rounded surface carrying
  // the only border, its segments separated by spacing rather than by borders
  // of their own. Each segment is still an ordinary button with its own state
  // — only the chrome is shared. Built empty here so each tool can append
  // itself where it is defined; the append order IS the layout.
  const toolPill = el("div", {
    class: "toolbar-pill",
    role: "group",
    "aria-label": t("toolbar.tools.group"),
  });
  toolbar.append(toolPill);

  // Wire tool (shortcut W). The dot beside the label shows the active wire
  // color AND opens the eight-swatch picker when clicked — the one pill
  // readout that is also a control. It is a <span> inside this one <button>
  // (a nested <button> is invalid, and the pill has no split seam), so the dot
  // itself stops that click from reaching the toggle; see wire-color-dot.js.
  // Picking a color deliberately does NOT arm the tool — this is the only way
  // to set the pending color without entering it. While the circuit runs the
  // button is disabled, which makes the dot inert for free.
  wireDot = createWireColorDot({
    getColor: () => controller.wireColor,
    onPick: (color) => controller.setWireColor(color),
  });
  wireBtn = el(
    "button",
    {
      class: "toolbar-pill-btn",
      type: "button",
      title: t("toolbar.wire.title"),
      "aria-pressed": "false",
      onClick: () => controller.toggleWireTool(),
    },
    [el("span", { text: t("toolbar.wire.label") }), wireDot.element],
  );
  toolPill.append(wireBtn);
  onWireStateChange({ armed: false, color: controller.wireColor });

  // Bus tool (shortcut B) — lays a multi-bit run of wires in one gesture,
  // riding the active wire color. Its badge shows the active width (2–8 or 16
  // bits) and, like the Wire dot beside it, is also the PICKER for it: it opens
  // the same presets the digit keys offer, without arming the tool.
  busWidth = createBusWidthBadge({
    getName: () => controller.busName,
    onPick: (name) => controller.setBusName(name),
  });
  busWidth.setName(controller.busName);
  busBtn = el(
    "button",
    {
      class: "toolbar-pill-btn",
      type: "button",
      title: t("toolbar.bus.title"),
      "aria-pressed": "false",
      onClick: () => controller.toggleBusTool(),
    },
    [el("span", { text: t("toolbar.bus.label") }), busWidth.element],
  );
  toolPill.append(busBtn);

  // Fade wires: draw every wire as a short stub off each hole, fading out in
  // between, so a heavily wired board stays readable. A selected wire comes
  // back whole. Purely how the desk is drawn, so it stays live while running.
  fadeBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": t("toolbar.fade.label"),
    title: t("toolbar.fade.title"),
    "aria-pressed": "false",
    onClick: () => controller.toggleWiresFaded(),
  });
  fadeBtn.innerHTML = FADE_WIRES_SVG;
  toolPill.append(fadeBtn);
  controller.setWiresFaded(settings.wiresFaded === true);

  // Probe tool: highlight a whole electrical net on hover (shortcut I).
  probeBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": t("toolbar.probe.label"),
    title: t("toolbar.probe.title"),
    "aria-pressed": "false",
    onClick: () => controller.toggleProbe(),
  });
  probeBtn.innerHTML = PROBE_SVG;
  toolPill.append(probeBtn);

  // Logic analyzer: toggle the bottom-docked waveform panel. Like the guide it
  // is a passive viewer, so it stays available while the circuit runs.
  scopeBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": t("toolbar.analyzer.label"),
    title: t("toolbar.analyzer.title", { mod: MOD_KEY }),
    "aria-pressed": String(scopeView.visible),
    onClick: () => scopeView.toggle(),
  });
  scopeBtn.innerHTML = ANALYZER_SVG;
  scopeBtn.classList.toggle("toolbar-btn--active", scopeView.visible);
  toolPill.append(scopeBtn);

  // Fit to screen: recentre the desk on the origin, then frame every
  // board/part/wire on it (find lost parts). It stays available while the
  // circuit runs — the recentre is a document edit, so it alone is skipped.
  // Shift previews the OTHER find-a-lost-part move (zoom out fully, ⌘⇧F): the
  // icon/tooltip swap while hovered+held is a pure preview (no click yet), so
  // it tracks hover and Shift independently and recomputes on either change.
  const getActiveView = () => (mode === "schematic" ? schematicView : deskView);
  // Fit follows the view you are LOOKING at, like zoom-out-full does — but it
  // is not a plain camera call on either: the desk's lives on the controller
  // because it recentres the document as well, and the schematic's is the
  // diagram's own (its symbol positions are derived, so there is nothing to
  // move — fitting IS centring it).
  const fitActiveView = () =>
    mode === "schematic" ? schematicView.fit() : controller.fitToScreen();
  let locateHovered = false;
  let locateShiftHeld = false;
  const updateLocateIcon = () => {
    const zoomOutFull = locateHovered && locateShiftHeld;
    locateBtn.innerHTML = zoomOutFull ? ZOOM_OUT_SVG : LOCATE_SVG;
    locateBtn.setAttribute(
      "aria-label",
      zoomOutFull ? t("toolbar.zoomOut.label") : t("toolbar.fit.label"),
    );
    locateBtn.title = zoomOutFull
      ? t("toolbar.zoomOut.title", { mod: MOD_KEY })
      : t("toolbar.fit.title", { mod: MOD_KEY });
  };
  const locateBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": t("toolbar.fit.label"),
    title: t("toolbar.fit.title", { mod: MOD_KEY }),
    onClick: (e) => {
      if (e.shiftKey) getActiveView().zoomOutFull();
      else fitActiveView();
    },
  });
  locateBtn.innerHTML = LOCATE_SVG;
  locateBtn.addEventListener("pointerenter", () => {
    locateHovered = true;
    updateLocateIcon();
  });
  locateBtn.addEventListener("pointerleave", () => {
    locateHovered = false;
    updateLocateIcon();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Shift" || locateShiftHeld) return;
    locateShiftHeld = true;
    updateLocateIcon();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Shift") return;
    locateShiftHeld = false;
    updateLocateIcon();
  });
  // A Shift held on the way in (window regained focus, or a modifier chord
  // released outside the window) never fires our own keyup — blur is the only
  // reliable place left to drop a stuck preview.
  window.addEventListener("blur", () => {
    if (!locateShiftHeld) return;
    locateShiftHeld = false;
    updateLocateIcon();
  });
  toolPill.append(locateBtn);

  // Bill of materials (⌘B), the pill's last segment: toggle the right-docked
  // build guide — BOM, wiring list, assembly steps. It reads the desk rather
  // than editing it, so like the analyzer it stays available while the circuit
  // runs. Its armed state is set from buildGuide's onVisibilityChange, so the
  // segment tracks the panel however it was closed (its own ×, the native File
  // menu, or this button).
  guideBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": t("toolbar.bom.label"),
    title: t("toolbar.bom.title", { mod: MOD_KEY }),
    "aria-pressed": String(buildGuide.visible),
    onClick: () => buildGuide.toggle(),
  });
  guideBtn.innerHTML = GUIDE_SVG;
  guideBtn.classList.toggle("toolbar-btn--active", buildGuide.visible);
  toolPill.append(guideBtn);

  // Breadboard ⇄ Schematic (Tab). The one segment that swaps the VIEWPORT
  // rather than arming a tool or opening a panel, so its icon shows where it
  // would take you; `setMode` (above) owns both states, and Tab drives the
  // same function, so the key and the button can never disagree. It reads the
  // desk rather than editing it — available while the circuit runs, like the
  // analyzer and the BOM it sits between.
  modeBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": t("toolbar.mode.schematic"),
    title: t("toolbar.mode.schematicTitle"),
    "aria-pressed": "false",
    onClick: () => setMode(mode === "desk" ? "schematic" : "desk"),
  });
  modeBtn.innerHTML = SCHEMATIC_SVG;
  toolPill.append(modeBtn);

  // AI builder: toggle the bottom-docked builder panel. Like the analyzer its
  // armed state comes from the panel's own onVisibilityChange, so the segment
  // tracks the panel however it was closed. It stays available while the
  // circuit runs — the panel itself refuses to build while the desk is frozen,
  // and saying so there is clearer than a dead button here.
  //
  // It is DISABLED, though, until there is a connection to ask at all: the
  // builder is the one tool that cannot work on the user's own machine, so
  // offering it with no API key configured would be offering nothing. It
  // starts disabled and `refreshAiReady` (above) enables it once main has
  // answered, replacing this tooltip with the reason whenever it is off.
  aiBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": t("toolbar.ai.label"),
    title: aiTitle(),
    disabled: true,
    "aria-pressed": String(aiPanel.visible),
    onClick: () => aiPanel.toggle(),
  });
  aiBtn.innerHTML = AI_SVG;
  aiBtn.classList.toggle("toolbar-btn--active", aiPanel.visible);
  toolPill.append(aiBtn);
  refreshAiReady();

  // ── Simulation transport (Feature 90/100): Run/Stop, Pause, Step, speed ──
  const notifications = new NotificationStack(document.body);

  // Surface net-name merge conflicts (Feature 120) as toasts — a name that
  // loses a merge is reported, never silently dropped.
  new NetNameMonitor(netlistCache, notifications);

  // Auto-update: the always-on surface for whatever the updater is doing. It
  // is the only one that survives Settings being closed, which is why it lives
  // here and not in the About panel's own listeners.
  new UpdaterMonitor(notifications);

  // The transport is its own pill (the app's grouping shape), sitting apart
  // from the edit tools. Stopped it holds exactly ONE segment — Run; the
  // moment the circuit runs that segment becomes Stop and Pause / Step /
  // speed unhide beside it, so the pill only ever offers what applies.
  const transportPill = el("div", {
    class: "toolbar-pill toolbar-pill--transport",
    role: "group",
    "aria-label": t("toolbar.transport.group"),
  });
  // The glyph leads each transport label and is NOT part of the translation:
  // ▶ / ⏸ / ⇥ / ■ mean the same thing in every language, so a catalog carrying
  // them would only give six chances to lose one.
  const runBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--run",
    type: "button",
    text: `▶ ${t("toolbar.transport.run")}`,
    title: t("toolbar.transport.runTitle", { mod: MOD_KEY }),
    "aria-pressed": "false",
    onClick: () => sim.toggle(),
  });
  const pauseBtn = el("button", {
    class: "toolbar-pill-btn",
    type: "button",
    text: `⏸ ${t("toolbar.transport.pause")}`,
    title: t("toolbar.transport.pauseTitle"),
    hidden: true,
    onClick: () => sim.togglePause(),
  });
  const stepBtn = el("button", {
    class: "toolbar-pill-btn",
    type: "button",
    text: `⇥ ${t("toolbar.transport.step")}`,
    title: t("toolbar.transport.stepTitle"),
    hidden: true,
    onClick: () => sim.step(),
  });
  const speedBtn = el("button", {
    class: "toolbar-pill-btn",
    type: "button",
    text: "×1",
    title: t("toolbar.transport.speedTitle"),
    hidden: true,
    onClick: () => {
      const i = (SPEEDS.indexOf(sim.speed) + 1) % SPEEDS.length;
      sim.setSpeed(SPEEDS[i]);
      speedBtn.textContent = SPEED_LABELS[SPEEDS[i]];
    },
  });
  transportPill.append(runBtn, pauseBtn, stepBtn, speedBtn);
  toolbar.append(transportPill);

  // Buttons that edit topology are disabled while the circuit runs; the probe,
  // the file actions, and the transport controls stay live. Listed by element
  // rather than queried — the File pill's segments look exactly like the tool
  // pill's, and opening or saving a document is not a topology edit. The parts
  // tray isn't in the list either: showing or hiding a panel edits nothing, and
  // `#enterPlacement` already refuses every pick while the circuit runs (⌘P has
  // always stayed live for the same reason).
  const editButtons = [wireBtn, busBtn];
  const onTransportChange = (mode) => {
    transportMode = mode;
    const stopped = mode === "stopped";
    controller.setEditingLocked(!stopped);
    workspace?.setEditingLocked(!stopped);
    runBtn.textContent = stopped
      ? `▶ ${t("toolbar.transport.run")}`
      : `■ ${t("toolbar.transport.stop")}`;
    runBtn.title = stopped
      ? t("toolbar.transport.runTitle", { mod: MOD_KEY })
      : t("toolbar.transport.stopTitle", { mod: MOD_KEY });
    runBtn.setAttribute("aria-pressed", String(!stopped));
    runBtn.classList.toggle("toolbar-btn--running", !stopped);
    pauseBtn.textContent =
      mode === "paused"
        ? `▶ ${t("toolbar.transport.resume")}`
        : `⏸ ${t("toolbar.transport.pause")}`;
    for (const btn of [pauseBtn, stepBtn, speedBtn]) btn.hidden = stopped;
    for (const btn of editButtons) btn.disabled = !stopped;
  };
  sim = new SimController({
    deskDoc,
    netlist: netlistCache,
    notifications,
    onTransportChange,
  });

  // Projects & tabbed desktops: owns the open project — the document — which
  // desktop is on the desk, and the swap (with its camera and undo history)
  // through the controller's load path, plus every action behind the File and
  // Desktop menus. Built here because it needs the sim to stop across a
  // switch.
  workspace = new ProjectWorkspace({
    bridge,
    deskDoc,
    controller,
    sim,
    tabs: projectTabs,
    getCamera: () => deskView.camera,
    setCamera: (camera) => deskView.setCamera(camera),
    boot: projectBoot,
    onActiveChange: () => updateTitle(),
  });
  updateTitle(); // the booted project names the window

  // Memory-inspector coordinator (Feature 190): bridges inspector windows to the
  // document, the controller (programmer + undo/redo), and the running image.
  memoryBridge = new MemoryBridge({
    deskDoc,
    sim,
    controller,
    bridge,
    notifications,
    // A ROM's bytes travel IN the project file, but they live in a sidecar no
    // signature comparison can see — and re-saving an already-programmed chip
    // leaves the document identical. So the write says so itself.
    onImagesChanged: () => workspace?.markImagesChanged(),
  });

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

  // The desk padlock (top-right): shut, the mouse wheel stops moving the desk.
  // Session-only and open at launch — see DeskLock for why it is not remembered,
  // and DeskView.setWheelLocked for why it locks the wheel and nothing else.
  deskLock = new DeskLock(desk, {
    mod: MOD_KEY,
    onChange: (locked) => deskView.setWheelLocked(locked),
  });

  // The derived schematic (Feature 150): the same document as chip symbols +
  // routed nets. Symbol nudges and the auto-layout reset commit through the
  // controller so they ride the one undo/redo seam.
  schematicView = new SchematicView(schematicViewport, {
    doc: deskDoc,
    netlist: netlistCache,
    onSetSchematicPos: (id, x, y) => controller.setSchematicPos(id, x, y),
    onAutoLayout: () => controller.autoLayoutSchematic(),
  });
  setMode("desk"); // sync the initial toggle state

  bindShortcuts(
    controller,
    sim,
    scopeView,
    togglePalette,
    getActiveView,
    fitActiveView,
    () => setMode(mode === "desk" ? "schematic" : "desk"),
    () => deskLock.toggle(),
    // ⇧⌘O drops the recent-projects menu under the Open segment — the same
    // place a secondary click on it would, so the key and the pointer put the
    // card in one spot rather than two.
    () => {
      const r = fileOpenBtn.getBoundingClientRect();
      void workspace?.openRecentMenu(r.left, r.bottom);
    },
  );

  // ── Changing the language, in place ──────────────────────────────────────
  // Chip Hippo NEVER reloads the window — an unsaved project lives only in
  // memory, so a reload would throw the user's work away to change a label. So
  // a language change is applied to the chrome that is already on screen.
  //
  // Only PERSISTENT chrome needs this. Everything transient — every dialog,
  // context menu, popover, notification and the palette's own part rows — is
  // built when it opens and therefore speaks the current language for free; the
  // native menu bar is main's, and it rebuilds itself off the same setting.
  // What is left is this toolbar, the docked panels, and the window title.
  //
  // Three of these are relabel functions the app ALREADY had, for their own
  // reasons: `setMode`, `updateLocateIcon` and `onTransportChange` each own a
  // button whose label depends on state, so re-running them with the state
  // unchanged is exactly a relabel. `refreshAiReady` is the same for the AI
  // segment, whose tooltip is either the description or the reason it is off.
  const relabelChrome = () => {
    header.header.setAttribute("aria-label", t("app.header"));
    header.iconBtn.title = t("app.about");
    header.iconBtn.setAttribute("aria-label", t("app.about"));
    header.settingsBtn.title = t("app.settings");
    header.settingsBtn.setAttribute("aria-label", t("app.openSettings"));

    desk.setAttribute("aria-label", t("app.desk"));
    hint.textContent = t("app.deskHint");
    schematicViewport.setAttribute("aria-label", t("app.schematic"));

    filePill.setAttribute("aria-label", t("toolbar.file.group"));
    for (const [btn, label, title, params] of [
      [fileNewBtn, "new", "newTitle", { accel: accel("N") }],
      [fileOpenBtn, "open", "openTitle", { accel: accel("O") }],
      [fileSaveBtn, "save", "saveTitle", { accel: accel("S") }],
      [fileSaveAsBtn, "saveAs", "saveAsTitle", { accel: accel("S", true) }],
    ]) {
      btn.setAttribute("aria-label", t(`toolbar.file.${label}`));
      btn.title = t(`toolbar.file.${title}`, params);
    }

    toolPill.setAttribute("aria-label", t("toolbar.tools.group"));
    wireBtn.title = t("toolbar.wire.title");
    wireBtn.querySelector("span:not(.wire-color-dot)").textContent =
      t("toolbar.wire.label");
    busBtn.title = t("toolbar.bus.title");
    busBtn.querySelector("span:not(.bus-width-badge)").textContent =
      t("toolbar.bus.label");
    for (const [btn, key, params] of [
      [fadeBtn, "fade", null],
      [probeBtn, "probe", null],
      [scopeBtn, "analyzer", { mod: MOD_KEY }],
      [guideBtn, "bom", { mod: MOD_KEY }],
    ]) {
      btn.setAttribute("aria-label", t(`toolbar.${key}.label`));
      btn.title = t(`toolbar.${key}.title`, params ?? undefined);
    }
    aiBtn.setAttribute("aria-label", t("toolbar.ai.label"));
    updateLocateIcon(); // Fit / Zoom-out-fully, whichever it is showing
    setMode(mode); // Breadboard ⇄ Schematic, whichever it would go to
    refreshAiReady(); // the description, or the reason the segment is off

    transportPill.setAttribute("aria-label", t("toolbar.transport.group"));
    stepBtn.textContent = `⇥ ${t("toolbar.transport.step")}`;
    stepBtn.title = t("toolbar.transport.stepTitle");
    speedBtn.title = t("toolbar.transport.speedTitle");
    pauseBtn.title = t("toolbar.transport.pauseTitle");
    onTransportChange(transportMode); // Run/Stop + Pause/Resume text and titles

    // The docked panels and the surfaces each own their own chrome, so each
    // re-renders its own rather than app.js reaching into them.
    palette.relocalize();
    projectTabs.relocalize();
    buildGuide.relocalize();
    scopeView.relocalize();
    aiPanel.relocalize();
    zoomControl.relocalize();
    deskLock.relocalize();
    schematicView.relocalize();
    updateTitle();
  };

  // ── Settings (About / Settings dialogs + live application) ────────────────
  // The Settings dialog is deliberately dumb: it broadcasts a patch, and this
  // is where the app persists it (settings.set) and applies it live. Keep the
  // running settings so the dialog opens seeded with the current values.
  // `theme` is deliberately absent from applySettings: main acts on it (it
  // becomes nativeTheme.themeSource), so persisting the patch below IS
  // applying it — for every window at once, not just this one.
  const applySettings = (s) => {
    // The layout a NEW wire gets. Like the default LED colour it is read at
    // placement time, so this only has to keep the controller's copy current.
    controller?.setDefaultWireLayout(s.defaultWireLayout);
    const root = document.documentElement;
    if (s.selectionColor) {
      root.style.setProperty("--color-selection", s.selectionColor);
    } else {
      root.style.removeProperty("--color-selection");
    }
  };
  applySettings(currentSettings);

  window.addEventListener("chiphippo:settings-changed", (e) => {
    const prevLocale = currentSettings.locale ?? "system";
    currentSettings = { ...currentSettings, ...e.detail };
    applySettings(currentSettings);
    // A different provider has a different key, and a base URL can be typed
    // into something unreachable — either changes whether the AI segment has
    // a connection to offer.
    if (e.detail && "ai" in e.detail) refreshAiReady();
    const write = bridge.settings
      .set(e.detail)
      .catch((err) => console.error("[renderer] settings:set failed:", err));
    // A language change is the one setting that needs re-reading rather than
    // just applying: main resolves the catalog FROM the stored preference, so
    // the write has to land before the reload asks for it. It rebuilds its own
    // menu bar off the same write; this window relabels what is on screen.
    if (e.detail && "locale" in e.detail && e.detail.locale !== prevLocale) {
      void write.then(async () => {
        await i18n.init();
        relabelChrome();
        window.dispatchEvent(new CustomEvent("chiphippo:locale-changed"));
      });
    }
  });
  window.addEventListener("chiphippo:show-about", () => AboutDialog.open());
  window.addEventListener("chiphippo:open-settings", () =>
    SettingsDialog.open(currentSettings),
  );
  window.addEventListener("chiphippo:keyboard-shortcuts", () =>
    KeyboardShortcutsDialog.open(),
  );
  // The app version is no longer shown in the header — it lives in the About
  // dialog (the (i) toggle), which fetches it over the IPC bridge.
}

init();
