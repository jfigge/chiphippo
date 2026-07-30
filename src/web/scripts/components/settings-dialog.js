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
import { t, getLocales } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { LED_COLOR_OPTIONS } from "../catalog/parts.js";
import { buildColorSwatches } from "./color-swatches.js";
import { buildSegmented } from "./segmented-picker.js";
import { DatasheetDownloadDialog } from "./datasheet-download-dialog.js";

/** A line-drawn book glyph for the "browse the datasheet folder" affordance. */
const FOLDER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 ' +
  '2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';

/** A line-drawn tray-and-arrow glyph for the "download the datasheets" action. */
const DOWNLOAD_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
  '<polyline points="7 10 12 15 17 10"/>' +
  '<line x1="12" y1="3" x2="12" y2="15"/></svg>';

/** Appearance ▸ Theme. "System" follows the OS; the other two pin it. The
    choice is persisted like any other setting, and MAIN acts on it — it
    becomes Electron's `nativeTheme.themeSource`, which every window's
    `prefers-color-scheme` (and the native menus/dialogs) then follow. */
const themeOptions = () => [
  { value: "system", label: t("settings.appearance.themeSystem") },
  { value: "light", label: t("settings.appearance.themeLight") },
  { value: "dark", label: t("settings.appearance.themeDark") },
];

/** Appearance ▸ Wire layout — how a NEWLY laid wire is drawn (see
    model/desk-doc.js's WIRE_LAYOUTS). Read at placement time, exactly as the
    default LED colour is: nothing already on the desk changes, and an existing
    wire's layout is its own Properties dialog's business. */
const wireLayoutOptions = () => [
  { value: "direct", label: t("settings.appearance.wireLayoutDirect") },
  { value: "routed", label: t("settings.appearance.wireLayoutRouted") },
];

/** Emit a settings patch for app.js to persist + apply. */
function emitSettings(patch) {
  window.dispatchEvent(
    new CustomEvent("chiphippo:settings-changed", { detail: patch }),
  );
}

/**
 * Announce that the stored API key changed.
 *
 * The key is the one control here that bypasses the settings patch (it goes
 * straight to the OS-encrypted store), so a settings-changed event would never
 * carry it — and whether a key exists is exactly what decides if the toolbar's
 * AI segment is offered. The event says only THAT it changed: the value does
 * not cross the bridge, let alone the app.
 */
function announceKeyChange() {
  window.dispatchEvent(new CustomEvent("chiphippo:ai-key-changed"));
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
    placeholder: t("settings.ai.keyPlaceholder"),
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
      status.textContent = t("settings.ai.noSecureStore");
      keyInput.disabled = true;
      return;
    }
    keyInput.disabled = false;
    status.textContent = s?.configured
      ? t("settings.ai.keyStored", { provider: label })
      : t("settings.ai.keyMissing", { provider: label });
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
    text: t("settings.ai.apiKey"),
  });

  /** Placeholders show what an empty field falls back to. */
  const showDefaults = () => {
    const p = chosen();
    baseUrl.placeholder = p?.defaultBaseUrl ?? "";
    model.placeholder = p?.defaultModel ?? "";
    keyLabel.textContent = p?.keyLabel ?? t("settings.ai.apiKey");
  };

  const picker = buildSegmented({
    options: providers.map((p) => ({ value: p.id, label: p.label })),
    value: config.provider,
    ariaLabel: t("settings.ai.provider"),
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
    class: "settings-action",
    type: "button",
    text: t("settings.ai.saveKey"),
    onClick: async () => {
      const value = keyInput.value.trim();
      if (!value) return;
      const r = await bridge?.key?.set(config.provider, value);
      keyInput.value = "";
      if (r && r.ok === false) {
        result.textContent = r.error ?? t("settings.ai.keyStoreFailed");
        return;
      }
      result.textContent = "";
      refreshStatus();
      announceKeyChange();
    },
  });
  const clearKey = el("button", {
    // Destructive, and irreversibly so: the key is write-only from here (it is
    // never read back into this window), so forgetting it means pasting it
    // again from wherever the user got it.
    class: "settings-action settings-action--danger",
    type: "button",
    text: t("settings.ai.clearKey"),
    onClick: async () => {
      await bridge?.key?.clear(config.provider);
      keyInput.value = "";
      result.textContent = "";
      refreshStatus();
      announceKeyChange();
    },
  });
  const testBtn = el("button", {
    class: "settings-action",
    type: "button",
    text: t("settings.ai.testConnection"),
    onClick: async () => {
      testBtn.disabled = true;
      result.textContent = t("settings.ai.testing");
      let r;
      try {
        r = await bridge?.test({ ...config });
      } catch (err) {
        r = { ok: false, error: String(err?.message ?? err) };
      }
      testBtn.disabled = false;
      result.textContent = r?.ok
        ? t("settings.ai.connected")
        : (r?.error ?? t("settings.ai.testFailed"));
    },
  });

  showDefaults();
  refreshStatus();

  return [
    el("div", { class: "settings-row" }, [
      el("label", { class: "settings-label", text: t("settings.ai.provider") }),
      picker,
    ]),
    el("div", { class: "settings-row settings-row--stack" }, [
      el("label", {
        class: "settings-label",
        for: "set-ai-base-url",
        text: t("settings.ai.baseUrl"),
      }),
      baseUrl,
    ]),
    el("div", { class: "settings-row settings-row--stack" }, [
      el("label", {
        class: "settings-label",
        for: "set-ai-model",
        text: t("settings.ai.model"),
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
    el("p", { class: "settings-hint", text: t("settings.ai.hint") }),
    // Said HERE, where the connection is set up, because this is where the
    // builder is first met — long before a design lands on the desk.
    el("p", { class: "settings-hint", text: t("settings.ai.experimental") }),
  ];
}

/** Settings ▸ About ▸ "Check automatically". An either/or, so the app's own
    either/or control — the same segmented track Theme and Wire layout use,
    rather than a checkbox this dialog has nowhere else. */
const autoUpdateOptions = () => [
  { value: true, label: t("settings.about.autoOn") },
  { value: false, label: t("settings.about.autoOff") },
];

/**
 * Build the About panel: the version, whether to check for updates
 * automatically, and an on-demand check.
 *
 * It is the one panel with LIVE state — a check reports itself over the
 * `chiphippo:updater-*` broadcasts, which arrive whether the check started
 * here, in the Help menu, or on its own at launch. Those listeners belong to
 * the dialog's OPEN lifetime, not to the session (the app-wide toasts are the
 * always-on surface), so this hands back a `dispose` for the close path.
 *
 * @param {object} settings the current settings document.
 * @returns {{ rows: HTMLElement[], dispose: () => void }}
 */
function buildAboutPanel(settings) {
  // The status line under the button. Blank until something happens: an
  // untouched panel has nothing to report, and a stale line from the last time
  // the dialog was open would be a claim about now.
  const status = el("p", {
    class: "settings-hint",
    role: "status",
    "aria-live": "polite",
    text: "",
  });
  const say = (text) => {
    status.textContent = text;
  };

  const version = el("span", {
    class: "settings-folder-path settings-folder-path--empty",
    text: t("settings.about.readingVersion"),
  });

  const checkBtn = el("button", {
    class: "settings-action",
    type: "button",
    text: t("settings.about.check"),
    onClick: () => {
      say(t("settings.about.checking"));
      window.chiphippo?.updater?.check?.();
    },
  });

  // Only ever shown once an update has actually been downloaded — restarting
  // is not something to offer before there is anything to restart INTO.
  const restartBtn = el("button", {
    class: "settings-action",
    type: "button",
    text: t("settings.about.restart"),
    hidden: true,
    onClick: () => window.chiphippo?.updater?.install?.(),
  });

  const autoPicker = buildSegmented({
    options: autoUpdateOptions(),
    value: settings.autoUpdateCheck === true,
    // Deliberately fuller than the visible label beside it: the row's own text
    // reads "Check automatically", which only makes sense next to the heading.
    ariaLabel: t("settings.about.autoAria"),
    onPick: (autoUpdateCheck) => emitSettings({ autoUpdateCheck }),
  });

  const autoRow = el("div", { class: "settings-row" }, [
    el("label", { class: "settings-label", text: t("settings.about.autoLabel") }), // prettier-ignore
    autoPicker,
  ]);
  const actionRow = el("div", { class: "settings-row settings-row--stack" }, [
    el("div", { class: "settings-folder-actions" }, [checkBtn, restartBtn]),
    status,
  ]);
  const hint = el("p", {
    class: "settings-hint",
    text: t("settings.about.hint"),
  });

  // Every lifecycle event, one handler each, so they can all be removed again.
  const onChecking = () => say(t("settings.about.checking"));
  const onAvailable = (e) => {
    const v = e.detail?.version;
    say(
      v
        ? t("settings.about.availableVersion", { version: v })
        : t("settings.about.available"),
    );
  };
  const onNotAvailable = (e) => {
    // "store-build" / "dev-build" are ANSWERS, not failures: this build cannot
    // update itself, and saying so beside the version is the honest report.
    // Neither can reach here in practice — the panel hides its controls for
    // both below — but the check can also come from the Help menu.
    say(
      e.detail?.reason === "store-build"
        ? t("settings.about.storeBuild")
        : e.detail?.reason === "dev-build"
          ? t("settings.about.devBuild")
          : t("settings.about.upToDate"),
    );
  };
  const onDownloaded = (e) => {
    const v = e.detail?.version;
    say(
      v
        ? t("settings.about.readyVersion", { version: v })
        : t("settings.about.ready"),
    );
    restartBtn.hidden = false;
  };
  const onError = () => say(t("settings.about.error"));

  const LISTENERS = [
    ["chiphippo:updater-checking", onChecking],
    ["chiphippo:updater-available", onAvailable],
    ["chiphippo:updater-not-available", onNotAvailable],
    ["chiphippo:updater-downloaded", onDownloaded],
    ["chiphippo:updater-error", onError],
  ];
  for (const [event, fn] of LISTENERS) window.addEventListener(event, fn);

  // The version — and, with it, whether this build updates itself at all.
  // A store build is told BY MAIN (`distribution`), which is the only side
  // where `process.mas` is unambiguous; a store delivers its own updates, so
  // every control here would be a button that can't do anything.
  Promise.resolve(window.chiphippo?.getAppInfo?.() ?? null).then(
    (info) => {
      version.textContent = info?.version
        ? `Chip Hippo ${info.version}`
        : "Chip Hippo";
      version.classList.remove("settings-folder-path--empty");
      if (info?.distribution === "store") {
        autoRow.hidden = true;
        actionRow.hidden = true;
        hint.textContent = t("settings.about.storeHint");
      }
    },
    (err) => {
      console.error("[renderer] app:info:get failed:", err);
      version.textContent = "Chip Hippo";
    },
  );

  return {
    rows: [
      el("div", { class: "settings-row settings-row--stack" }, [
        el("label", { class: "settings-label", text: t("settings.about.version") }), // prettier-ignore
        el("div", { class: "settings-folder-input" }, [version]),
      ]),
      autoRow,
      actionRow,
      hint,
    ],
    dispose: () => {
      for (const [event, fn] of LISTENERS)
        window.removeEventListener(event, fn);
    },
  };
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

  /**
   * The settings this dialog is showing, patched as it emits.
   *
   * `open()` is handed a snapshot, and a card that changes a setting then has
   * to be rebuilt (see `#relabel`) must not rebuild from the state it opened
   * in — the Language row would spring back to the language just left.
   */
  static #settings = {};

  /** Which panel is showing, so a rebuild puts the user back on it. */
  static #tab = "appearance";

  /** True across a language rebuild, so `open()` keeps the tab rather than
      starting over on Appearance the way a fresh open should. */
  static #relabelling = false;

  /** Emit a settings patch for app.js to persist + apply — and keep our own
      copy current, since a rebuild is seeded from it. */
  static #emit(patch) {
    SettingsDialog.#settings = { ...SettingsDialog.#settings, ...patch };
    emitSettings(patch);
  }

  /**
   * Rebuild the whole card in the language just chosen.
   *
   * THE ONE DIALOG THAT HAS TO RELOCALIZE ITSELF. Every other transient
   * surface in the app — menus, popovers, notifications, the other dialogs —
   * is built when it opens and therefore speaks the current language for free.
   * This one is different for exactly one reason: the Language picker is
   * INSIDE it, so it is the only card that can still be on screen when the
   * language changes, and leaving it in the old one makes the setting look
   * like it did nothing.
   *
   * Closing and reopening rather than re-labelling in place, because the header
   * title, the nav rail, every row and the asynchronously-built AI panel are all
   * `t()` at build time — re-labelling would be a second, hand-maintained copy
   * of the whole card that could silently fall behind it. `PopupManager.close()`
   * runs `onClose` synchronously (dropping this listener and clearing the open
   * guard) before the queue is drained, so the reopen mounts cleanly; it is the
   * same close-then-open the Download button already uses.
   */
  static #relabel() {
    // MOUNTED, not merely open: `PopupManager.open` QUEUES a popup raised
    // behind another rather than stacking it, so the guard alone can be true
    // for a card that is not on screen — and `close()` would then dismiss
    // somebody else's popup and leave this one to mount in the old language.
    // Unreachable today (the picker that fires this is in this card, so the
    // card is showing), which is exactly why it is worth stating.
    if (!SettingsDialog.#open) return;
    if (!document.querySelector(".settings-popup")) return;
    const settings = SettingsDialog.#settings;
    SettingsDialog.#relabelling = true;
    try {
      PopupManager.close();
      SettingsDialog.open(settings);
    } finally {
      SettingsDialog.#relabelling = false;
    }
  }

  /**
   * Show the Settings dialog, seeded from `settings` (a no-op when already
   * open). @param {object} settings the current settings document.
   */
  static open(settings = {}) {
    if (SettingsDialog.#open) return;
    SettingsDialog.#open = true;
    SettingsDialog.#settings = { ...settings };
    // A fresh open starts on Appearance; a language rebuild resumes where the
    // user was.
    if (!SettingsDialog.#relabelling) SettingsDialog.#tab = "appearance";

    // The UI language. A <select> rather than a segmented track: eight choices
    // is past what one bordered row can show, and unlike Theme these are not an
    // either/or the user is comparing. "System" leads, then one row per shipped
    // catalog IN ITS OWN LANGUAGE — a language names itself the same way
    // whatever the UI is currently speaking, which is the whole reason a picker
    // is usable when you have accidentally set one you cannot read.
    //
    // The list comes off the loaded catalog payload (main's own table), so a
    // language cannot be offered here with no catalog behind it.
    const languageSelect = el(
      "select",
      {
        class: "settings-select",
        id: "set-language",
        onChange: (e) => SettingsDialog.#emit({ locale: e.target.value }),
      },
      [
        el("option", {
          value: "system",
          text: t("settings.appearance.languageSystem"),
          selected: (settings.locale ?? "system") === "system",
        }),
        ...getLocales().map((loc) =>
          el("option", {
            value: loc.code,
            text: loc.nativeName,
            selected: settings.locale === loc.code,
          }),
        ),
      ],
    );

    const themePicker = buildSegmented({
      options: themeOptions(),
      value: themeOptions().some((o) => o.value === settings.theme)
        ? settings.theme
        : "system",
      ariaLabel: t("settings.appearance.theme"),
      onPick: (theme) => SettingsDialog.#emit({ theme }),
    });

    const selColor = el("input", {
      class: "settings-color",
      type: "color",
      id: "set-selection-color",
      value: settings.selectionColor || themeSelectionColor(),
      onInput: (e) => SettingsDialog.#emit({ selectionColor: e.target.value }),
    });

    const wireLayoutPicker = buildSegmented({
      options: wireLayoutOptions(),
      value: wireLayoutOptions().some(
        (o) => o.value === settings.defaultWireLayout,
      )
        ? settings.defaultWireLayout
        : "direct",
      ariaLabel: t("settings.appearance.wireLayout"),
      onPick: (defaultWireLayout) =>
        SettingsDialog.#emit({ defaultWireLayout }),
    });

    const ledColorSwatches = buildColorSwatches({
      colors: LED_COLOR_OPTIONS,
      value: settings.defaultLedColor || "red",
      ariaLabel: t("settings.appearance.ledColor"),
      onPick: (color) => SettingsDialog.#emit({ defaultLedColor: color }),
    });

    // ── Data Sheets panel: the external datasheet-PDF folder ────────────────
    const hasDir =
      typeof settings.datasheetDir === "string" && settings.datasheetDir;
    const folderPath = el("span", {
      class: `settings-folder-path${hasDir ? "" : " settings-folder-path--empty"}`,
      text: hasDir ? settings.datasheetDir : t("settings.datasheets.noFolder"),
      title: hasDir ? settings.datasheetDir : "",
    });
    const clearBtn = el("button", {
      class: "settings-action settings-action--danger",
      type: "button",
      // A WORD, not a glyph: it sits beside Browse… and reads as its peer, the
      // same shape the AI tab's "Clear key" already uses.
      text: t("common.clear"),
      title: t("settings.datasheets.clearTitle"),
      hidden: !hasDir,
      onClick: () => {
        folderPath.textContent = t("settings.datasheets.noFolder");
        folderPath.title = "";
        folderPath.classList.add("settings-folder-path--empty");
        clearBtn.hidden = true;
        SettingsDialog.#emit({ datasheetDir: null });
      },
    });
    const browseBtn = el("button", {
      class: "settings-action",
      type: "button",
      title: t("settings.datasheets.browseTitle"),
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
    // The glyph is markup, the label is text — so the icon goes in as HTML and
    // the word is APPENDED as a node rather than interpolated into the template
    // it used to share. A translation is user-visible text, and text that has
    // been through innerHTML is text that could carry markup.
    browseBtn.innerHTML = FOLDER_SVG;
    browseBtn.append(el("span", { text: t("common.browse") }));

    // Fill the app's own datasheet folder from the web and point the setting
    // above at it. This CLOSES the settings dialog first: PopupManager queues
    // a second popup rather than stacking it, so the progress window would
    // otherwise sit invisibly behind this one until it was dismissed.
    const downloadBtn = el("button", {
      class: "settings-action",
      type: "button",
      title: t("settings.datasheets.downloadTitle"),
      onClick: () => {
        PopupManager.close();
        DatasheetDownloadDialog.open();
      },
    });
    downloadBtn.innerHTML = DOWNLOAD_SVG;
    downloadBtn.append(el("span", { text: t("common.download") }));

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
      [el("p", { class: "settings-hint", text: t("settings.ai.loading") })],
    );
    Promise.resolve(window.chiphippo?.ai?.providers?.() ?? []).then(
      (providers) => {
        aiPanel.replaceChildren(
          ...(Array.isArray(providers) && providers.length
            ? buildAiRows(settings, providers)
            : [
                el("p", {
                  class: "settings-hint",
                  text: t("settings.ai.noProviders"),
                }),
              ]),
        );
      },
      (err) => {
        console.error("[renderer] ai:providers failed:", err);
      },
    );

    // Built before the panel map because it also hands back the teardown for
    // the updater listeners it attaches, which onClose below has to run.
    const about = buildAboutPanel(settings);

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
            el("label", {
              class: "settings-label",
              for: "set-language",
              text: t("settings.appearance.language"),
            }),
            languageSelect,
          ]),
          el("p", {
            class: "settings-hint",
            text: t("settings.appearance.languageHint"),
          }),
          el("div", { class: "settings-row" }, [
            el("label", {
              class: "settings-label",
              text: t("settings.appearance.theme"),
            }),
            themePicker,
          ]),
          el("div", { class: "settings-row" }, [
            el("label", {
              class: "settings-label",
              for: "set-selection-color",
              text: t("settings.appearance.selectionColor"),
            }),
            selColor,
          ]),
          el("div", { class: "settings-row" }, [
            el("label", {
              class: "settings-label",
              text: t("settings.appearance.ledColor"),
            }),
            ledColorSwatches,
          ]),
          el("div", { class: "settings-row" }, [
            el("label", {
              class: "settings-label",
              text: t("settings.appearance.wireLayout"),
            }),
            wireLayoutPicker,
          ]),
          el("p", {
            class: "settings-hint",
            text: t("settings.appearance.wireLayoutHint"),
          }),
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
              text: t("settings.datasheets.folder"),
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
            text: t("settings.datasheets.folderHint"),
          }),
          el("div", { class: "settings-row settings-row--stack" }, [
            el("label", {
              class: "settings-label",
              text: t("settings.datasheets.auto"),
            }),
            el("div", { class: "settings-folder-actions" }, [downloadBtn]),
          ]),
          el("p", {
            class: "settings-hint",
            text: t("settings.datasheets.autoHint"),
          }),
        ],
      ),
      ai: aiPanel,
      about: el(
        "section",
        {
          class: "settings-panel",
          role: "tabpanel",
          "data-panel": "about",
          hidden: true,
        },
        about.rows,
      ),
    };

    // Left nav rail — one item per panel; clicking switches the visible panel.
    const TABS = [
      { key: "appearance", label: t("settings.nav.appearance") },
      { key: "datasheets", label: t("settings.nav.datasheets") },
      { key: "ai", label: t("settings.nav.ai") },
      { key: "about", label: t("settings.nav.about") },
    ];
    const navItems = TABS.map(({ key, label }) =>
      el("button", {
        class: "settings-nav-item",
        type: "button",
        role: "tab",
        "aria-selected": "false",
        "data-panel": key,
        text: label,
        onClick: () => select(key),
      }),
    );

    const select = (key) => {
      // Remembered on the class, not just in this closure: a language change
      // rebuilds the card and has to put the user back on the panel they were
      // reading.
      SettingsDialog.#tab = key;
      for (const item of navItems) {
        const on = item.getAttribute("data-panel") === key;
        item.classList.toggle("settings-nav-item--active", on);
        item.setAttribute("aria-selected", String(on));
      }
      for (const [panelKey, panel] of Object.entries(panels)) {
        panel.hidden = panelKey !== key;
      }
    };
    // Apply the starting panel through the same one path a click takes, so the
    // nav rail and the panels cannot disagree about which is showing.
    select(panels[SettingsDialog.#tab] ? SettingsDialog.#tab : "appearance");

    const body = [
      el("nav", { class: "settings-nav", role: "tablist" }, navItems),
      el("div", { class: "settings-panels" }, [
        panels.appearance,
        panels.datasheets,
        panels.ai,
        panels.about,
      ]),
    ];

    // The Language picker is in THIS card, so this is the one dialog that can
    // still be on screen when the language changes. app.js fires this only once
    // the new catalog is loaded, so the rebuild below reads the new one.
    const onLocaleChanged = () => SettingsDialog.#relabel();
    window.addEventListener("chiphippo:locale-changed", onLocaleChanged);

    // onClose fires only when THIS popup closes (not when a popup it was queued
    // behind closes), so the guard never resets while the dialog is still up.
    PopupManager.dialog({
      title: t("settings.title"),
      closeAriaLabel: t("settings.close"),
      className: "settings-popup",
      bodyClass: "settings-popup-body",
      body,
      onClose: () => {
        // The About panel's updater listeners live for exactly as long as the
        // dialog does — the app-wide toasts are the always-on surface, and a
        // status line writing into a card that has been thrown away is a leak
        // that grows by one set every time Settings is opened.
        about.dispose();
        window.removeEventListener("chiphippo:locale-changed", onLocaleChanged);
        SettingsDialog.#open = false;
      },
    });
  }
}
