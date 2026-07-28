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
import { SchematicView } from "./components/schematic-view.js";
import { PalettePanel } from "./components/palette-panel.js";
import { ProjectTabs } from "./components/project-tabs.js";
import { ProjectWorkspace } from "./components/project-workspace.js";
import { BuildGuide } from "./components/build-guide.js";
import { ScopeView } from "./components/scope-view.js";
import { SimController, SPEEDS } from "./components/sim-controller.js";
import { NetlistCache } from "./components/netlist-cache.js";
import { MemoryBridge } from "./components/memory-bridge.js";
import { NotificationStack } from "./components/notification-stack.js";
import { NetNameMonitor } from "./components/net-name-monitor.js";
import { PopupManager } from "./popup-manager.js";
import { AboutDialog } from "./components/about-dialog.js";
import { SettingsDialog } from "./components/settings-dialog.js";
import { KeyboardShortcutsDialog } from "./components/keyboard-shortcuts.js";
import { BUS_WIDTHS as BUS_WIDTH_PRESETS, DeskDoc } from "./model/desk-doc.js";
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

/** The short badge glyph ("8"/"16") the Bus button displays for a bus name,
    derived from the shared model presets; defaults to 8-bit. */
const busWidthShort = (name) =>
  BUS_WIDTH_PRESETS.find((w) => w.name === name)?.bits.toString() ?? "8";

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
  hint.textContent = "Open the parts tray and add a breadboard to get started";

  desk.append(hint);
  return desk;
}

/** The schematic surface (Feature 150) — a sibling of the desk, hidden until
    the Breadboard ⇄ Schematic toggle (or Tab) switches to it. */
function buildSchematicViewport() {
  const view = document.createElement("section");
  view.className = "schematic-viewport";
  view.setAttribute("aria-label", "Schematic");
  view.hidden = true;
  return view;
}

/**
 * Central keyboard shortcuts: desk keys (Esc / Delete via DeskController)
 * first, then Space to toggle Run/Stop (only when no tool is armed), then the
 * app-chrome accelerators (analyzer / palette / run toggle), then cmd/ctrl
 * +, −, 0 for the desk zoom.
 */
function bindShortcuts(
  controller,
  sim,
  scopeView,
  togglePalette,
  getActiveView,
  onToggleView,
) {
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
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    // Cmd/Ctrl+A / +P / +R toggle app-chrome panels — not while typing (Cmd+A
    // in particular used to be the native "select all" menu role; freeing it
    // for the analyzer meant removing that role in main.js, so a text field's
    // own native select-all still works, but this shortcut must stay out of
    // its way).
    const tag = e.target?.tagName;
    const typing =
      tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable;
    if (!typing) {
      if (e.key === "a" || e.key === "A") {
        e.preventDefault();
        scopeView.toggle();
        return;
      }
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
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        if (e.shiftKey) {
          getActiveView().zoomOutFull();
        } else {
          controller.fitToScreen();
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
  app.append(buildHeader(), main);
  let workspace = null;

  // Desk document (Feature 20): the boards/components/wires of the desktop on
  // screen, held in one in-memory DeskDoc. Anything that mutates it dispatches
  // a global `chiphippo:doc-changed` CustomEvent. The desk is a DESKTOP of the
  // open project, and a desktop is a document: it is written to its own file
  // deliberately (⌘S), never autosaved, so the • on its tab is what says the
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

  // ── Desktop files (New / Open / Save / Save As) ───────────────────────────
  // Every one of them acts on the ACTIVE DESKTOP of the open project, which
  // owns its own file: New empties it, Open loads a design into it (and the
  // desktop adopts that file), Save writes it back to its Location, Save As
  // gives it a new one. The workspace owns all of it — this is only the wiring
  // from the toolbar and the native File menu, which dispatch the same events.
  const newSchematic = () => workspace?.newActiveTab();
  const openSchematic = () => workspace?.loadIntoActiveTab();
  // Both report whether the desktop actually reached a file — `false` for a
  // cancelled dialog or a failed write — so a caller that saves on the user's
  // behalf before doing something destructive can abort instead of discarding
  // work that was never written.
  const saveSchematic = async () => (await workspace?.saveActiveTab()) === true;
  const saveAsSchematic = async () =>
    (await workspace?.saveActiveTabAs()) === true;

  // The window title names the project and the desktop on screen. Its •
  // leads the whole thing, so it stands for anything unsaved: the desktop's
  // own design (the same marker its tab carries) or the project's list of
  // desktops and their names.
  const updateTitle = () => {
    const tab = workspace?.activeTab;
    const marker =
      workspace?.activeDirty || workspace?.projectDirty ? "• " : "";
    const project = workspace?.projectName || "Untitled";
    document.title = tab
      ? `${marker}${project} — ${tab.name} — Chip Hippo`
      : "Chip Hippo";
  };
  updateTitle();
  window.addEventListener("chiphippo:doc-changed", updateTitle);

  window.addEventListener("chiphippo:schematic-new", newSchematic);
  window.addEventListener("chiphippo:schematic-open", openSchematic);
  window.addEventListener("chiphippo:schematic-save", saveSchematic);
  window.addEventListener("chiphippo:schematic-save-as", saveAsSchematic);

  // ── The Project menu ──────────────────────────────────────────────────────
  // The application's Project menu (main.js `buildAppMenu`) pushes one event
  // per item; every one of them is the workspace's to answer, since it is the
  // only side that knows what is open and what is unsaved. Open Recent is the
  // one that carries a payload — the project file its item stands for.
  for (const [event, run] of [
    ["chiphippo:project-new", () => workspace?.newProject()],
    ["chiphippo:project-open", () => workspace?.loadProject()],
    ["chiphippo:project-save", () => workspace?.saveProject()],
    ["chiphippo:project-save-as", () => workspace?.saveProjectAs()],
    ["chiphippo:project-properties", () => workspace?.editProjectProperties()],
    ["chiphippo:project-add-tab", () => workspace?.addTab()],
  ]) {
    window.addEventListener(event, () => void run());
  }
  window.addEventListener("chiphippo:project-open-recent", (e) => {
    if (e.detail) void workspace?.openRecentProject(e.detail);
  });

  // ── Closing the window / quitting ────────────────────────────────────────
  // Main prevents the close and asks HERE, because the unsaved state and the
  // dialog that deals with it both live in the renderer. Desktops are written
  // deliberately, never autosaved, so without this a • on a tab dies with the
  // window. It must reply EXACTLY once, whatever happens: main waits for the
  // answer with no timeout (the user is entitled to think about it), so a
  // guard that threw would leave an app that cannot be quit — hence letting
  // the close proceed on an error rather than blocking it.
  window.addEventListener("chiphippo:confirm-close", async () => {
    let ok = true;
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
  let hud = null;
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
    onProperties: (id) => workspace?.editTabProperties(id),
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
  let wireDot = null; // the active-color dot displayed inside the Wire button
  let busBtn = null;
  let busWidthLabel = null; // the "8"/"16" badge displayed inside the Bus button
  let probeBtn = null;
  let fadeBtn = null; // the "Fade wires" toggle
  let sim = null; // the SimController (created after the toolbar below)
  let memoryBridge = null; // memory-inspector coordinator (created with sim)
  const onWireStateChange = ({ armed, color }) => {
    wireBtn?.classList.toggle("toolbar-btn--active", armed);
    wireBtn?.setAttribute("aria-pressed", String(armed));
    // The Wire button carries a dot showing the active color — a readout, not
    // a picker (1–8 set it while the tool is armed).
    wireDot?.style.setProperty("--wire-color", `var(--color-wire-${color})`);
    if (wireDot) wireDot.title = `Wire color: ${color} (1–8 to change)`;
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
    // Keeps the Bus button's width badge ("8"/"16") in sync with the 1/2
    // keyboard shortcut that sets it.
    onBusNameChange: (name) => {
      if (busWidthLabel) busWidthLabel.textContent = busWidthShort(name);
    },
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

  const toolbar = document.getElementById("app-toolbar");

  // Breadboard ⇄ Schematic view toggle (Feature 150) — leads the toolbar.
  // Hidden for now: the schematic still works and Tab still toggles it, but the
  // toolbar entry point is held back. Flip SHOW_SCHEMATIC_TOGGLE to re-enable.
  const SHOW_SCHEMATIC_TOGGLE = false;
  const modeBtn = el("button", {
    class: "toolbar-btn",
    type: "button",
    text: "▧ Schematic",
    title: "Show the logical schematic (Tab)",
    "aria-pressed": "false",
    onClick: () => setMode(mode === "desk" ? "schematic" : "desk"),
  });
  if (SHOW_SCHEMATIC_TOGGLE) {
    toolbar.append(modeBtn, el("span", { class: "toolbar-divider" }));
  }

  function setMode(next) {
    mode = next === "schematic" ? "schematic" : "desk";
    const schematic = mode === "schematic";
    desk.hidden = schematic;
    schematicView?.setVisible(schematic);
    modeBtn.classList.toggle("toolbar-btn--active", schematic);
    modeBtn.textContent = schematic ? "▦ Breadboard" : "▧ Schematic";
    modeBtn.title = schematic
      ? "Back to the breadboard (Tab)"
      : "Show the logical schematic (Tab)";
    modeBtn.setAttribute("aria-pressed", String(schematic));
  }

  // Schematic file actions — a PILL just right of the Projects button, the same
  // shape the desk tools use: one border around a row of borderless segments.
  // Every file action is its own segment rather than a row hidden behind a ▾:
  // they're peers, and a toolbar's job is to show what's available. Each is
  // icon-only with the name + accelerator in its tooltip, so five of them cost
  // about what the old Save + ▾ pair did. Every one dispatches the SAME
  // chiphippo:* event the native File menu pushes, so the two can't drift —
  // except Open Recent, which is toolbar-only and drops its own menu.
  const fileBtn = ({ icon, label, title, haspopup = false, onClick }) => {
    const btn = el("button", {
      class: "toolbar-pill-btn toolbar-pill-btn--icon",
      type: "button",
      title,
      "aria-label": label,
      "aria-haspopup": haspopup ? "menu" : null,
      onClick,
    });
    btn.innerHTML = icon;
    return btn;
  };

  const fileNewBtn = fileBtn({
    icon: NEW_SVG,
    label: "New Desktop",
    title: `New Desktop (${accel("N")}) — start over on an empty desk`,
    onClick: () => newSchematic(),
  });
  const fileOpenBtn = fileBtn({
    icon: LOAD_SVG,
    label: "Open",
    title: `Open… (${accel("O")}) — load a saved design`,
    onClick: () => openSchematic(),
  });
  const fileSaveBtn = fileBtn({
    icon: SAVE_SVG,
    label: "Save",
    title: `Save (${accel("S")}) — write the design back to its file`,
    onClick: () =>
      window.dispatchEvent(new CustomEvent("chiphippo:schematic-save")),
  });
  const fileSaveAsBtn = fileBtn({
    icon: SAVE_AS_SVG,
    label: "Save As",
    title: `Save As… (${accel("S", true)}) — write the design to a new file`,
    onClick: () => saveAsSchematic(),
  });
  const filePill = el(
    "div",
    { class: "toolbar-pill", role: "group", "aria-label": "File" },
    [fileNewBtn, fileOpenBtn, fileSaveBtn, fileSaveAsBtn],
  );

  // PROJECT actions have no toolbar button at all: New / Load / Open Recent /
  // Save / Save As / Properties / Add Desktop are the application's **Project**
  // menu (main.js `buildAppMenu`), which pushes to the workspace exactly as the
  // File menu pushes here.
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
    "aria-label": "Desk tools",
  });
  toolbar.append(toolPill);

  // Wire tool (shortcut W). The dot beside the label DISPLAYS the active wire
  // color — it is not a picker: the color is chosen with 1–8 while the tool is
  // armed, or on an already-placed wire through its Properties dialog.
  wireDot = el("span", { class: "wire-swatch-dot", "aria-hidden": "true" });
  wireBtn = el(
    "button",
    {
      class: "toolbar-pill-btn",
      type: "button",
      title: "Wire tool — click two free holes to connect them (W)",
      "aria-pressed": "false",
      onClick: () => controller.toggleWireTool(),
    },
    [el("span", { text: "Wire" }), wireDot],
  );
  toolPill.append(wireBtn);
  onWireStateChange({ armed: false, color: controller.wireColor });

  // Bus tool (shortcut B) — lays a multi-bit run of wires in one gesture,
  // riding the active wire color. The "8"/"16" badge likewise DISPLAYS the
  // active width (8-bit D[7:0] / 16-bit D[15:0]), which 1/2 set while armed.
  busWidthLabel = el("span", {
    class: "bus-width-badge",
    text: busWidthShort(controller.busName),
  });
  busBtn = el(
    "button",
    {
      class: "toolbar-pill-btn",
      type: "button",
      title: "Bus tool — lay a multi-bit run of wires in one gesture (B)",
      "aria-pressed": "false",
      onClick: () => controller.toggleBusTool(),
    },
    [el("span", { text: "Bus" }), busWidthLabel],
  );
  toolPill.append(busBtn);

  // Fade wires: draw every wire as a short stub off each hole, fading out in
  // between, so a heavily wired board stays readable. A selected wire comes
  // back whole. Purely how the desk is drawn, so it stays live while running.
  fadeBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": "Fade wires",
    title:
      "Fade wires — draw only a stub at each end so the board stays readable (H)",
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
    "aria-label": "Probe",
    title: "Connectivity probe — hover to highlight a net, click to pin (P)",
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
    "aria-label": "Analyzer",
    title: `Logic analyzer — record and view signal waveforms over time (${MOD_KEY}+A)`,
    "aria-pressed": String(scopeView.visible),
    onClick: () => scopeView.toggle(),
  });
  scopeBtn.innerHTML = ANALYZER_SVG;
  scopeBtn.classList.toggle("toolbar-btn--active", scopeView.visible);
  toolPill.append(scopeBtn);

  // Fit to screen: frame every board/part/wire on the desk (find lost parts).
  // A passive camera move, so it stays available while the circuit runs.
  // Shift previews the OTHER find-a-lost-part move (zoom out fully, ⌘⇧F): the
  // icon/tooltip swap while hovered+held is a pure preview (no click yet), so
  // it tracks hover and Shift independently and recomputes on either change.
  const getActiveView = () => (mode === "schematic" ? schematicView : deskView);
  let locateHovered = false;
  let locateShiftHeld = false;
  const updateLocateIcon = () => {
    const zoomOutFull = locateHovered && locateShiftHeld;
    locateBtn.innerHTML = zoomOutFull ? ZOOM_OUT_SVG : LOCATE_SVG;
    locateBtn.setAttribute(
      "aria-label",
      zoomOutFull ? "Zoom out fully" : "Fit to screen",
    );
    locateBtn.title = zoomOutFull
      ? `Zoom all the way out — find a lost part (${MOD_KEY}+Shift+F)`
      : `Fit to screen — frame every board, part, and wire (${MOD_KEY}+F)`;
  };
  const locateBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--icon",
    type: "button",
    "aria-label": "Fit to screen",
    title: `Fit to screen — frame every board, part, and wire (${MOD_KEY}+F)`,
    onClick: (e) => {
      if (e.shiftKey) getActiveView().zoomOutFull();
      else controller.fitToScreen();
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
    "aria-label": "Bill Of Materials",
    title: `Bill Of Materials — parts list, wiring list, and assembly steps (${MOD_KEY}+B)`,
    "aria-pressed": String(buildGuide.visible),
    onClick: () => buildGuide.toggle(),
  });
  guideBtn.innerHTML = GUIDE_SVG;
  guideBtn.classList.toggle("toolbar-btn--active", buildGuide.visible);
  toolPill.append(guideBtn);

  // ── Simulation transport (Feature 90/100): Run/Stop, Pause, Step, speed ──
  const notifications = new NotificationStack(document.body);

  // Surface net-name merge conflicts (Feature 120) as toasts — a name that
  // loses a merge is reported, never silently dropped.
  new NetNameMonitor(netlistCache, notifications);

  // The transport is its own pill (the app's grouping shape), sitting apart
  // from the edit tools. Stopped it holds exactly ONE segment — Run; the
  // moment the circuit runs that segment becomes Stop and Pause / Step /
  // speed unhide beside it, so the pill only ever offers what applies.
  const transportPill = el("div", {
    class: "toolbar-pill toolbar-pill--transport",
    role: "group",
    "aria-label": "Simulation transport",
  });
  const runBtn = el("button", {
    class: "toolbar-pill-btn toolbar-pill-btn--run",
    type: "button",
    text: "▶ Run",
    title: `Run the circuit (Space or ${MOD_KEY}+R)`,
    "aria-pressed": "false",
    onClick: () => sim.toggle(),
  });
  const pauseBtn = el("button", {
    class: "toolbar-pill-btn",
    type: "button",
    text: "⏸ Pause",
    title: "Pause / resume the clock",
    hidden: true,
    onClick: () => sim.togglePause(),
  });
  const stepBtn = el("button", {
    class: "toolbar-pill-btn",
    type: "button",
    text: "⇥ Step",
    title: "Advance one clock half-period",
    hidden: true,
    onClick: () => sim.step(),
  });
  const speedBtn = el("button", {
    class: "toolbar-pill-btn",
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
    const stopped = mode === "stopped";
    controller.setEditingLocked(!stopped);
    workspace?.setEditingLocked(!stopped);
    runBtn.textContent = stopped ? "▶ Run" : "■ Stop";
    runBtn.title = stopped
      ? `Run the circuit (Space or ${MOD_KEY}+R)`
      : `Stop and return to editing (Space or ${MOD_KEY}+R)`;
    runBtn.setAttribute("aria-pressed", String(!stopped));
    runBtn.classList.toggle("toolbar-btn--running", !stopped);
    pauseBtn.textContent = mode === "paused" ? "▶ Resume" : "⏸ Pause";
    for (const btn of [pauseBtn, stepBtn, speedBtn]) btn.hidden = stopped;
    for (const btn of editButtons) btn.disabled = !stopped;
  };
  sim = new SimController({
    deskDoc,
    netlist: netlistCache,
    notifications,
    onTransportChange,
  });

  // Projects & tabbed desktops: owns which desktop is on the desk, swapping
  // the document (and its camera, baseline, and undo history) through the
  // controller's load path, and every project/desktop file action behind the
  // Projects menu and the File pill. Built here because it needs the sim to
  // stop across a switch.
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

  bindShortcuts(controller, sim, scopeView, togglePalette, getActiveView, () =>
    setMode(mode === "desk" ? "schematic" : "desk"),
  );

  // The desk hub is always mounted but hidden until the "Show desk hub"
  // setting turns it on (applySettings below sets the initial visibility).
  hud = new DeskHud(desk, deskView);

  // ── Settings (About / Settings dialogs + live application) ────────────────
  // The Settings dialog is deliberately dumb: it broadcasts a patch, and this
  // is where the app persists it (settings.set) and applies it live. Keep the
  // running settings so the dialog opens seeded with the current values.
  // `theme` is deliberately absent from applySettings: main acts on it (it
  // becomes nativeTheme.themeSource), so persisting the patch below IS
  // applying it — for every window at once, not just this one.
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
  window.addEventListener("chiphippo:keyboard-shortcuts", () =>
    KeyboardShortcutsDialog.open(),
  );
  // The app version is no longer shown in the header — it lives in the About
  // dialog (the (i) toggle), which fetches it over the IPC bridge.
}

init();
