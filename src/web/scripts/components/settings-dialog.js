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
          el("nav", { class: "settings-nav", role: "tablist" }, [
            el("button", {
              class: "settings-nav-item settings-nav-item--active",
              type: "button",
              role: "tab",
              "aria-selected": "true",
              "data-panel": "general",
              text: "General",
            }),
          ]),
          el("div", { class: "settings-panels" }, [
            el(
              "section",
              {
                class: "settings-panel",
                role: "tabpanel",
                "data-panel": "general",
              },
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
          ]),
        ]),
      ],
    );

    PopupManager.open({ element, onMaskClick: () => PopupManager.close() });
    window.addEventListener(
      "chiphippo:popup-closed",
      () => {
        SettingsDialog.#open = false;
      },
      { once: true },
    );
  }
}
