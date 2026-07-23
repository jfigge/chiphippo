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

// settings-dialog.js — the app Settings modal, opened from the top-right system
// (gear) icon or the application menu (menu:open-settings →
// chiphippo:open-settings). A renderer PopupManager modal, styled like the Rest
// Hippo settings dialog: a fixed master-detail card — a left nav rail of panels
// beside a single-column panel, a header with a close button, and pill-slider
// toggles.
//
// The dialog is deliberately dumb: it reads the current settings passed to
// open() and, on any change, broadcasts a `chiphippo:settings-changed`
// CustomEvent with a patch — app.js owns persistence (settings.set) and
// applying the change live. Add a new control to the panel + a case in app.js's
// applySettings; nothing else needs to know.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";

/** A close "×" glyph for the header button. */
const CLOSE_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
  'aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

/** A line-drawn book glyph for the "browse the datasheet folder" affordance. */
const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 ' +
  '2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

/** The effective selection-border colour when none is stored (theme default). */
function themeSelectionColor() {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-selection")
    .trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : "#d0d0d0";
}

export class SettingsDialog {
  static #open = false;

  /** Emit a settings patch for app.js to persist + apply. */
  static #emit(patch) {
    window.dispatchEvent(
      new CustomEvent("chiphippo:settings-changed", { detail: patch }),
    );
  }

  /**
   * Show the Settings dialog, seeded from `settings` (a no-op when already
   * open). @param {object} settings the current settings document.
   */
  static open(settings = {}) {
    if (SettingsDialog.#open) return;
    SettingsDialog.#open = true;

    const showHub = el("input", {
      class: "settings-toggle",
      type: "checkbox",
      id: "set-show-hub",
      checked: Boolean(settings.showDeskHub),
      onChange: (e) => SettingsDialog.#emit({ showDeskHub: e.target.checked }),
    });

    const selColor = el("input", {
      class: "settings-color",
      type: "color",
      id: "set-selection-color",
      value: settings.selectionColor || themeSelectionColor(),
      onInput: (e) => SettingsDialog.#emit({ selectionColor: e.target.value }),
    });

    const closeBtn = el("button", {
      class: "popup-close",
      type: "button",
      title: "Close",
      "aria-label": "Close settings",
      onClick: () => PopupManager.close(),
    });
    closeBtn.innerHTML = CLOSE_SVG;

    // ── Data Sheets panel: the external datasheet-PDF folder ────────────────
    const hasDir =
      typeof settings.datasheetDir === "string" && settings.datasheetDir;
    const folderPath = el("span", {
      class: `settings-folder-path${hasDir ? "" : " settings-folder-path--empty"}`,
      text: hasDir ? settings.datasheetDir : "No folder selected",
      title: hasDir ? settings.datasheetDir : "",
    });
    const clearBtn = el("button", {
      class: "settings-folder-clear",
      type: "button",
      text: "Clear",
      hidden: !hasDir,
      onClick: () => {
        folderPath.textContent = "No folder selected";
        folderPath.title = "";
        folderPath.classList.add("settings-folder-path--empty");
        clearBtn.hidden = true;
        SettingsDialog.#emit({ datasheetDir: null });
      },
    });
    const browseBtn = el("button", {
      class: "settings-folder-browse",
      type: "button",
      title: "Choose the datasheet folder",
      onClick: async () => {
        let dir;
        try {
          dir = await window.chiphippo?.settings?.chooseDatasheetDir?.();
        } catch (err) {
          console.error("[renderer] choose datasheet dir failed:", err);
          return;
        }
        if (!dir) return; // cancelled
        folderPath.textContent = dir;
        folderPath.title = dir;
        folderPath.classList.remove("settings-folder-path--empty");
        clearBtn.hidden = false;
        SettingsDialog.#emit({ datasheetDir: dir });
      },
    });
    browseBtn.innerHTML = `${FOLDER_SVG}<span>Browse…</span>`;

    const panels = {
      general: el(
        "section",
        { class: "settings-panel", role: "tabpanel", "data-panel": "general" },
        [
          el("div", { class: "settings-row settings-row--toggle" }, [
            el("label", {
              class: "settings-label",
              for: "set-show-hub",
              text: "Show desk hub",
            }),
            showHub,
          ]),
          el("div", { class: "settings-row" }, [
            el("label", {
              class: "settings-label",
              for: "set-selection-color",
              text: "Selection border colour",
            }),
            selColor,
          ]),
        ],
      ),
      datasheets: el(
        "section",
        {
          class: "settings-panel",
          role: "tabpanel",
          "data-panel": "datasheets",
          hidden: true,
        },
        [
          el("div", { class: "settings-row settings-row--stack" }, [
            el("label", {
              class: "settings-label",
              text: "Datasheet folder",
            }),
            el("div", { class: "settings-folder" }, [
              folderPath,
              el("div", { class: "settings-folder-actions" }, [
                clearBtn,
                browseBtn,
              ]),
            ]),
          ]),
          el("p", {
            class: "settings-hint",
            text:
              "Point this at a folder of manufacturer datasheet PDFs named " +
              "after each chip (e.g. 74LS00.pdf). When a matching PDF is " +
              "found, a chip's pin-assignments window shows a button to open " +
              "it.",
          }),
        ],
      ),
    };

    // Left nav rail — one item per panel; clicking switches the visible panel.
    const TABS = [
      { key: "general", label: "General" },
      { key: "datasheets", label: "Data Sheets" },
    ];
    const navItems = TABS.map(({ key, label }, i) =>
      el("button", {
        class:
          "settings-nav-item" + (i === 0 ? " settings-nav-item--active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": String(i === 0),
        "data-panel": key,
        text: label,
        onClick: () => select(key),
      }),
    );

    const select = (key) => {
      for (const item of navItems) {
        const on = item.getAttribute("data-panel") === key;
        item.classList.toggle("settings-nav-item--active", on);
        item.setAttribute("aria-selected", String(on));
      }
      for (const [panelKey, panel] of Object.entries(panels)) {
        panel.hidden = panelKey !== key;
      }
    };

    const element = el(
      "div",
      {
        class: "popup settings-popup",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Settings",
      },
      [
        el("div", { class: "popup-header" }, [
          el("span", { class: "popup-title", text: "Settings" }),
          closeBtn,
        ]),
        el("div", { class: "popup-body settings-popup-body" }, [
          el("nav", { class: "settings-nav", role: "tablist" }, navItems),
          el("div", { class: "settings-panels" }, [
            panels.general,
            panels.datasheets,
          ]),
        ]),
      ],
    );

    // onClose fires only when THIS popup closes (not when a popup it was queued
    // behind closes), so the guard never resets while the dialog is still up.
    PopupManager.open({
      element,
      onMaskClick: () => PopupManager.close(),
      onClose: () => {
        SettingsDialog.#open = false;
      },
    });
  }
}
