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
import { LED_COLOR_OPTIONS } from "../catalog/parts.js";
import { buildColorSwatches } from "./color-swatches.js";

/** A line-drawn book glyph for the "browse the datasheet folder" affordance. */
const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 ' +
  '2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

/** A line-drawn trash-can glyph for the "clear the datasheet folder" action. */
const TRASH_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="3 6 5 6 21 6"/>' +
  '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 ' +
  '2 0 0 1 2 2v2"/>' +
  '<line x1="10" y1="11" x2="10" y2="17"/>' +
  '<line x1="14" y1="11" x2="14" y2="17"/></svg>';

/** Appearance ▸ Theme. "System" follows the OS; the other two pin it. The
    choice is persisted like any other setting, and MAIN acts on it — it
    becomes Electron's `nativeTheme.themeSource`, which every window's
    `prefers-color-scheme` (and the native menus/dialogs) then follow. */
const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * A segmented picker — the settings-dialog form of the toolbar's pill: one
 * bordered track holding borderless segments, the chosen one filled. Generic
 * over `{ value, label }` options, so the next either/or setting reuses it.
 */
function buildSegmented({ options, value, ariaLabel, onPick }) {
  const buttons = options.map((opt) =>
    el("button", {
      class: `settings-segment${opt.value === value ? " settings-segment--active" : ""}`,
      type: "button",
      role: "radio",
      "aria-checked": String(opt.value === value),
      "data-value": opt.value,
      text: opt.label,
      onClick: () => {
        for (const b of buttons) {
          const on = b.getAttribute("data-value") === opt.value;
          b.classList.toggle("settings-segment--active", on);
          b.setAttribute("aria-checked", String(on));
        }
        onPick?.(opt.value);
      },
    }),
  );
  return el(
    "div",
    {
      class: "settings-segmented",
      role: "radiogroup",
      "aria-label": ariaLabel,
    },
    buttons,
  );
}

/** Emit a settings patch for app.js to persist + apply. */
function emitSettings(patch) {
  window.dispatchEvent(
    new CustomEvent("chiphippo:settings-changed", { detail: patch }),
  );
}

/**
 * Build the AI panel's rows once the provider list has arrived.
 *
 * The list comes from MAIN (`ai:providers`, projected from `app/ai/
 * providers.js`) rather than being restated here, so adding a third adapter
 * needs no renderer change and the picker can never offer one that does not
 * exist. That is also why this is built asynchronously: everything in the
 * panel — the placeholders, the key label — is the CHOSEN provider's data.
 *
 * @param {object} settings the current settings document.
 * @param {Array} providers `[{id, label, defaultBaseUrl, defaultModel, keyLabel}]`.
 * @returns {HTMLElement[]} the panel's children.
 */
function buildAiRows(settings, providers) {
  const bridge = window.chiphippo?.ai;
  // A patch replaces the `ai` object whole (the object-valued-setting
  // convention), so every control emits the WHOLE config, not its own field.
  let config = {
    provider: providers.some((p) => p.id === settings.ai?.provider)
      ? settings.ai.provider
      : providers[0].id,
    baseUrl: settings.ai?.baseUrl ?? "",
    model: settings.ai?.model ?? "",
  };
  const emit = (patch) => {
    config = { ...config, ...patch };
    emitSettings({ ai: { ...config } });
  };
  const chosen = () => providers.find((p) => p.id === config.provider);

  const status = el("p", { class: "settings-hint", text: "" });
  const keyInput = el("input", {
    class: "settings-text-input",
    type: "password",
    id: "set-ai-key",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Paste a key to store it",
  });
  const result = el("p", { class: "settings-hint", text: "" });

  /** Re-read whether a key is stored. The key itself never comes back. */
  const refreshStatus = async () => {
    const label = chosen()?.label ?? config.provider;
    let s;
    try {
      s = await bridge?.key?.status(config.provider);
    } catch {
      s = null;
    }
    if (s && s.encryptionAvailable === false) {
      status.textContent =
        "This system has no secure credential store, so a key cannot be " +
        "saved. Point the base URL at a local server that needs no key.";
      keyInput.disabled = true;
      return;
    }
    keyInput.disabled = false;
    status.textContent = s?.configured
      ? `A key is stored for ${label}. It is encrypted by the OS and is never read back into this window.`
      : `No key stored for ${label}.`;
  };

  const baseUrl = el("input", {
    class: "settings-text-input",
    type: "text",
    id: "set-ai-base-url",
    spellcheck: false,
    value: config.baseUrl,
    // Commit on change (blur/Enter), never per keystroke — a half-typed URL
    // is not a setting, and this is written to disk.
    onChange: (e) => emit({ baseUrl: e.target.value.trim() }),
  });
  const model = el("input", {
    class: "settings-text-input",
    type: "text",
    id: "set-ai-model",
    spellcheck: false,
    value: config.model,
    onChange: (e) => emit({ model: e.target.value.trim() }),
  });

  const keyLabel = el("label", {
    class: "settings-label",
    for: "set-ai-key",
    text: "API key",
  });

  /** Placeholders show what an empty field falls back to. */
  const showDefaults = () => {
    const p = chosen();
    baseUrl.placeholder = p?.defaultBaseUrl ?? "";
    model.placeholder = p?.defaultModel ?? "";
    keyLabel.textContent = p?.keyLabel ?? "API key";
  };

  const picker = buildSegmented({
    options: providers.map((p) => ({ value: p.id, label: p.label })),
    value: config.provider,
    ariaLabel: "AI provider",
    onPick: (provider) => {
      emit({ provider });
      showDefaults();
      result.textContent = "";
      refreshStatus();
    },
  });

  // The key is the ONE control that bypasses the settings patch entirely: it
  // goes straight to main's OS-encrypted store, because settings.json is
  // plaintext and is handed back to this window in full on every read.
  const saveKey = el("button", {
    class: "settings-folder-browse",
    type: "button",
    text: "Save key",
    onClick: async () => {
      const value = keyInput.value.trim();
      if (!value) return;
      const r = await bridge?.key?.set(config.provider, value);
      keyInput.value = "";
      if (r && r.ok === false) {
        result.textContent = r.error ?? "The key could not be stored.";
        return;
      }
      result.textContent = "";
      refreshStatus();
    },
  });
  const clearKey = el("button", {
    class: "settings-folder-browse",
    type: "button",
    text: "Clear key",
    onClick: async () => {
      await bridge?.key?.clear(config.provider);
      keyInput.value = "";
      result.textContent = "";
      refreshStatus();
    },
  });
  const testBtn = el("button", {
    class: "settings-folder-browse",
    type: "button",
    text: "Test connection",
    onClick: async () => {
      testBtn.disabled = true;
      result.textContent = "Testing…";
      let r;
      try {
        r = await bridge?.test({ ...config });
      } catch (err) {
        r = { ok: false, error: String(err?.message ?? err) };
      }
      testBtn.disabled = false;
      result.textContent = r?.ok
        ? "Connected."
        : (r?.error ?? "The connection could not be tested.");
    },
  });

  showDefaults();
  refreshStatus();

  return [
    el("div", { class: "settings-row" }, [
      el("label", { class: "settings-label", text: "Provider" }),
      picker,
    ]),
    el("div", { class: "settings-row settings-row--stack" }, [
      el("label", {
        class: "settings-label",
        for: "set-ai-base-url",
        text: "Base URL",
      }),
      baseUrl,
    ]),
    el("div", { class: "settings-row settings-row--stack" }, [
      el("label", {
        class: "settings-label",
        for: "set-ai-model",
        text: "Model",
      }),
      model,
    ]),
    el("div", { class: "settings-row settings-row--stack" }, [
      keyLabel,
      keyInput,
      el("div", { class: "settings-folder-actions" }, [
        clearKey,
        saveKey,
        testBtn,
      ]),
      status,
      result,
    ]),
    el("p", {
      class: "settings-hint",
      text:
        "Chip Hippo uses your own connection — nothing is sent anywhere until " +
        "you ask it to build something, and the key is stored encrypted by " +
        "the operating system, never in settings.json. Leave Base URL and " +
        "Model blank to use the shown defaults.",
    }),
  ];
}

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
    emitSettings(patch);
  }

  /**
   * Show the Settings dialog, seeded from `settings` (a no-op when already
   * open). @param {object} settings the current settings document.
   */
  static open(settings = {}) {
    if (SettingsDialog.#open) return;
    SettingsDialog.#open = true;

    const themePicker = buildSegmented({
      options: THEME_OPTIONS,
      value: THEME_OPTIONS.some((o) => o.value === settings.theme)
        ? settings.theme
        : "system",
      ariaLabel: "Theme",
      onPick: (theme) => SettingsDialog.#emit({ theme }),
    });

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

    const ledColorSwatches = buildColorSwatches({
      colors: LED_COLOR_OPTIONS,
      value: settings.defaultLedColor || "red",
      ariaLabel: "Default LED color",
      onPick: (color) => SettingsDialog.#emit({ defaultLedColor: color }),
    });

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
      title: "Clear the datasheet folder",
      "aria-label": "Clear the datasheet folder",
      hidden: !hasDir,
      onClick: () => {
        folderPath.textContent = "No folder selected";
        folderPath.title = "";
        folderPath.classList.add("settings-folder-path--empty");
        clearBtn.hidden = true;
        SettingsDialog.#emit({ datasheetDir: null });
      },
    });
    clearBtn.innerHTML = TRASH_SVG;
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

    // The AI panel is filled in once main answers with the provider list, so
    // the dialog itself stays synchronous. It is never the open tab, so the
    // placeholder is not something a user normally sees.
    const aiPanel = el(
      "section",
      {
        class: "settings-panel",
        role: "tabpanel",
        "data-panel": "ai",
        hidden: true,
      },
      [el("p", { class: "settings-hint", text: "Loading providers…" })],
    );
    Promise.resolve(window.chiphippo?.ai?.providers?.() ?? []).then(
      (providers) => {
        aiPanel.replaceChildren(
          ...(Array.isArray(providers) && providers.length
            ? buildAiRows(settings, providers)
            : [
                el("p", {
                  class: "settings-hint",
                  text: "No AI providers are available in this build.",
                }),
              ]),
        );
      },
      (err) => {
        console.error("[renderer] ai:providers failed:", err);
      },
    );

    const panels = {
      appearance: el(
        "section",
        {
          class: "settings-panel",
          role: "tabpanel",
          "data-panel": "appearance",
        },
        [
          el("div", { class: "settings-row" }, [
            el("label", { class: "settings-label", text: "Theme" }),
            themePicker,
          ]),
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
          el("div", { class: "settings-row" }, [
            el("label", {
              class: "settings-label",
              text: "Default LED color",
            }),
            ledColorSwatches,
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
              el("div", { class: "settings-folder-input" }, [folderPath]),
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
      ai: aiPanel,
    };

    // Left nav rail — one item per panel; clicking switches the visible panel.
    const TABS = [
      { key: "appearance", label: "Appearance" },
      { key: "datasheets", label: "Data Sheets" },
      { key: "ai", label: "AI" },
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

    const body = [
      el("nav", { class: "settings-nav", role: "tablist" }, navItems),
      el("div", { class: "settings-panels" }, [
        panels.appearance,
        panels.datasheets,
        panels.ai,
      ]),
    ];

    // onClose fires only when THIS popup closes (not when a popup it was queued
    // behind closes), so the guard never resets while the dialog is still up.
    PopupManager.dialog({
      title: "Settings",
      closeAriaLabel: "Close settings",
      className: "settings-popup",
      bodyClass: "settings-popup-body",
      body,
      onClose: () => {
        SettingsDialog.#open = false;
      },
    });
  }
}
