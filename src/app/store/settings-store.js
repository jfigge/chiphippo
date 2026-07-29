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

/**
 * settings-store.js — App-wide preferences. A single JSON document under
 * userData; `get()` returns the stored values layered over the frozen
 * DEFAULTS, `set(patch)` shallow-merges a patch and persists atomically.
 * Object-valued keys (like `viewport`) are replaced whole by a patch, not
 * deep-merged — callers write the full object.
 */
"use strict";

const path = require("path");
const io = require("./io");

const DEFAULTS = Object.freeze({
  // ── Desk viewport (Feature 10) ────────────────────────────────────────────
  // The camera restored at boot: world-unit center + zoom factor.
  viewport: Object.freeze({ cx: 0, cy: 0, zoom: 1 }),

  // ── Window bounds ─────────────────────────────────────────────────────────
  // {x,y,width,height} persisted by window-state.js; null → centred default.
  windowBounds: null,

  // ── Parts palette (Feature 40) ────────────────────────────────────────────
  // Whether the left palette panel is open (the palette flap / chevron and ⌘P
  // toggle it). Open by default — the tray is how parts reach the desk, so a
  // first launch shows it rather than hiding it behind the drawer pull.
  // Which groups are collapsed is NOT stored: the palette opens with every
  // group shut on every launch, and what the user opens lasts the session.
  paletteOpen: true,

  // How wide that tray is, in CSS px — written by its draggable right edge
  // (the renderer clamps it to [180, half the window], and the panel's
  // `max-width: 50vw` re-caps a width saved on a wider display). Unlike the
  // collapse state this IS remembered: it is a working preference about how
  // much of the desk a permanent left column may take, not a transient one.
  paletteWidth: 232,

  // ── Pin-assignments window (Feature 100) ──────────────────────────────────
  // Whether a chip's pin-out window floats above the main app. A de-facto
  // global preference: the window's right-click menu toggles it, every open
  // pinout window follows, and a future settings dialog binds to it.
  pinoutFloat: true,

  // ── Settings dialog ────────────────────────────────────────────────────────
  // Light / dark appearance: "system" (follow the OS, the default), "light",
  // or "dark". Main applies it as Electron's `nativeTheme.themeSource`, which
  // is what every renderer's `prefers-color-scheme` — and the native menus and
  // dialogs — then follow, so there is ONE switch for the whole app.
  theme: "system",

  // Whether the desk hub (the camera/cursor readout overlay) is shown. Off by
  // default — the Settings dialog's "Show desk hub" toggle drives it.
  showDeskHub: false,

  // The selection-border colour (`#rrggbb`), or null to use the theme accent.
  // Applied by the renderer as the `--color-selection` custom property.
  // Defaults to the house orange (the `--color-wire-orange` value): the theme
  // accent is monochrome, so an outline drawn in it reads as one more grey
  // line on the desk.
  selectionColor: "#d0804a",

  // The color a newly placed LED gets (Settings ▸ Appearance ▸ "Default LED
  // color") — one of catalog/parts.js's LED_COLOR_OPTIONS. Only the default
  // for NEW LEDs; an already-placed LED's color is changed through its own
  // Properties dialog (right-click ▸ Properties…).
  defaultLedColor: "red",

  // ── Desk drawing ──────────────────────────────────────────────────────────
  // Whether wires are faded back to a short stub at each end (the toolbar's
  // "Fade wires" toggle, or H) so a heavily wired board stays readable. A
  // selected wire is always drawn whole.
  wiresFaded: false,

  // How a NEWLY laid wire is drawn (Settings ▸ Appearance ▸ "Wire layout") —
  // "direct" (the sagging hole-to-hole curve, the default) or "routed" (a
  // straight run the user bends by dragging waypoints into it). Only the
  // default for new wires: an existing one's layout is changed through its own
  // Properties dialog, and the AI builder ignores this setting outright — a
  // generated circuit is always direct.
  defaultWireLayout: "direct",

  // ── Panels (Build guide / Logic analyzer) ──────────────────────────────────
  // Whether the right-docked build guide is shown.
  guideOpen: false,

  // Whether the bottom-docked logic analyzer is shown, and its height in CSS
  // px. The panel's draggable top edge writes the height (the renderer clamps
  // it to half the window); the toolbar / close button writes the open flag.
  scopeOpen: false,
  scopeHeight: 280,

  // The bottom-docked AI builder panel — same two keys, same reasons.
  aiOpen: false,
  aiHeight: 280,

  // The prompts the user has asked the AI builder for, newest first, capped at
  // MAX_HISTORY (web/scripts/ai/prompt-history.js). Deliberately here and not
  // in the project file: what you have asked for before is yours, not the
  // design's, so arrowing back through it works the same in every project —
  // including a brand-new one, where a per-project list would always be empty.
  aiHistory: Object.freeze([]),

  // ── Data sheets ────────────────────────────────────────────────────────────
  // An external directory of manufacturer datasheet PDFs. When it is set and a
  // `<dir>/<partId>.pdf` exists, the pin-assignments window shows a button that
  // opens that PDF natively. null → no directory (the default).
  datasheetDir: null,

  // ── AI circuit builder (Feature 260) ───────────────────────────────────────
  // The NON-SECRET half of the user's own AI connection: which provider, where
  // it lives, and which model. The API key is deliberately absent — it lives
  // OS-encrypted in store/credential-store.js, because this file is plaintext
  // and is handed back to the renderer in full on every `settings:get`.
  // An object-valued key is replaced whole, so a caller sends the whole thing.
  ai: {
    provider: "anthropic", // "anthropic" | "openai-compat"
    baseUrl: "", // blank → the provider's own default
    model: "", // blank → the provider's own default
  },

  // ── Recent projects ────────────────────────────────────────────────────────
  // The last 10 PROJECT files saved or opened, most recent first. Main owns
  // the list (store/recent-files.js does the arithmetic) and it does two jobs:
  // it is the Projects ▸ Open Recent menu, and it is the ALLOWLIST that
  // project:open-recent checks a path against, so the renderer can never ask
  // main to read an arbitrary file. It is also where startup looks when the
  // app's saves folder holds no unsaved (default) project — the head of this
  // list is then the project the session opens with.
  //
  // There is deliberately no equivalent for DESKTOP files: a desktop is
  // reached through the project that owns it, never from a recent list.
  recentProjects: Object.freeze([]),
});

class SettingsStore {
  /**
   * @param {string} dataDir - the app's userData directory.
   */
  constructor(dataDir) {
    this._file = path.join(dataDir, "settings.json");
  }

  _read() {
    const doc = io.readJSON(this._file);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  }

  /** Current settings: stored values layered over the defaults. */
  get() {
    return { ...DEFAULTS, ...this._read() };
  }

  /**
   * Shallow-merge `patch` into the stored settings and persist. Returns the
   * full merged settings (defaults + stored).
   * @param {object} patch
   * @returns {object}
   */
  set(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      const err = new Error("settings patch must be an object");
      err.code = "INVALID_ARG";
      throw err;
    }
    const next = { ...this._read(), ...patch };
    io.writeJSON(this._file, next);
    return { ...DEFAULTS, ...next };
  }
}

module.exports = { SettingsStore, DEFAULTS };
