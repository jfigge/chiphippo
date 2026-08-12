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

// jsdom tests for the About + Settings dialogs (renderer PopupManager modals).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";
import { applyCatalog } from "../i18n.js";

/** A shipped catalog, read the same way jsdom-setup reads en.json. */
const catalog = (lang) =>
  JSON.parse(
    fs.readFileSync(new URL(`../../locales/${lang}.json`, import.meta.url), "utf8"), // prettier-ignore
  );
const EN = catalog("en");
const DE = catalog("de");
const LOCALES = [
  { code: "en", nativeName: "English" },
  { code: "de", nativeName: "Deutsch" },
];

const { PopupManager } = await import("../popup-manager.js");
const { SettingsDialog } = await import("../components/settings-dialog.js");
const { AboutDialog } = await import("../components/about-dialog.js");

test("SettingsDialog: the language picker leads Appearance and emits a locale", () => {
  // The languages a catalog ships for reach the picker on the loaded catalog
  // payload (main's own table), so the harness installs them the same way.
  resetDom({
    locales: [
      { code: "en", nativeName: "English" },
      { code: "de", nativeName: "Deutsch" },
    ],
  });
  SettingsDialog.open({ locale: "de" });

  const panel = document.querySelector('.settings-panel[data-panel="appearance"]'); // prettier-ignore
  assert.equal(
    panel.firstElementChild.querySelector(".settings-label").textContent,
    "Language",
    "language is the FIRST row of the Appearance panel",
  );

  const select = panel.querySelector("#set-language");
  assert.deepEqual(
    [...select.options].map((o) => o.value),
    ["system", "en", "de"],
    "System leads, then one option per shipped catalog",
  );
  assert.deepEqual(
    [...select.options].map((o) => o.textContent),
    ["System", "English", "Deutsch"],
    "a language names itself, untranslated",
  );
  assert.equal(select.value, "de", "seeded from the stored preference");

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  select.value = "en";
  select.dispatchEvent(new window.Event("change"));
  assert.deepEqual(patches, [{ locale: "en" }]);

  PopupManager.close();
});

test("SettingsDialog: an absent locale preference shows System", () => {
  resetDom({ locales: [] });
  SettingsDialog.open({});
  assert.equal(document.querySelector("#set-language").value, "system");
  PopupManager.close();
});

test("SettingsDialog: the theme picker follows Language, seeds, and emits", () => {
  resetDom();
  SettingsDialog.open({ theme: "light" });

  // `.settings-panel` qualified: the NAV ITEM carries the same data-panel.
  const panel = document.querySelector('.settings-panel[data-panel="appearance"]'); // prettier-ignore

  // Scoped to the THEME group: Appearance carries more than one segmented
  // picker now (Wire layout is the other).
  const themeGroup = panel.querySelector('.segmented-picker[aria-label="Theme"]'); // prettier-ignore
  const segments = [...themeGroup.querySelectorAll(".segmented-option")];
  assert.deepEqual(
    segments.map((b) => b.textContent),
    ["System", "Light", "Dark"],
  );
  assert.deepEqual(
    segments.filter((b) => b.classList.contains("segmented-option--active")),
    [segments[1]],
    "seeded from the passed theme",
  );

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  segments[2].click();
  assert.deepEqual(patches, [{ theme: "dark" }]);
  assert.equal(segments[2].getAttribute("aria-checked"), "true");
  assert.equal(segments[1].getAttribute("aria-checked"), "false");

  PopupManager.close();
});

/** The chosen segment of one named picker (Theme, Wire layout, …). */
const activeSegment = (label) =>
  document.querySelector(
    `.segmented-picker[aria-label="${label}"] .segmented-option--active`,
  );

test("SettingsDialog: an absent or junk theme falls back to System", () => {
  resetDom();
  SettingsDialog.open({});
  assert.equal(activeSegment("Theme").textContent, "System");
  PopupManager.close();

  resetDom();
  SettingsDialog.open({ theme: "solarized" });
  assert.equal(activeSegment("Theme").textContent, "System");
  PopupManager.close();
});

test("SettingsDialog: the wire-layout picker seeds, emits, and falls back", () => {
  resetDom();
  SettingsDialog.open({ defaultWireLayout: "routed" });
  const group = document.querySelector('.segmented-picker[aria-label="Wire layout"]'); // prettier-ignore
  const segments = [...group.querySelectorAll(".segmented-option")];
  assert.deepEqual(
    segments.map((b) => b.textContent),
    ["Direct", "Routed"],
  );
  assert.equal(activeSegment("Wire layout").textContent, "Routed");

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  segments[0].click();
  assert.deepEqual(patches, [{ defaultWireLayout: "direct" }]);
  PopupManager.close();

  // Absent or junk falls back to Direct — the application default.
  resetDom();
  SettingsDialog.open({ defaultWireLayout: "orthogonal" });
  assert.equal(activeSegment("Wire layout").textContent, "Direct");
  PopupManager.close();
});

test("SettingsDialog: the font-size picker seeds, emits a NUMBER, and repairs", () => {
  resetDom();
  SettingsDialog.open({ fontSize: 16 });
  const group = document.querySelector('.segmented-picker[aria-label="Editor font size"]'); // prettier-ignore
  const segments = [...group.querySelectorAll(".segmented-option")];
  assert.deepEqual(
    segments.map((b) => b.textContent),
    ["11", "12", "13", "14", "16", "18"],
  );
  assert.equal(activeSegment("Editor font size").textContent, "16");

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  segments[5].click();
  // A NUMBER, not the string the DOM would round-trip: the whole type scale is
  // derived from this value as a px length.
  assert.deepEqual(patches, [{ fontSize: 18 }]);
  assert.equal(typeof patches[0].fontSize, "number");
  PopupManager.close();

  // Absent falls back to the shipped 13 …
  resetDom();
  SettingsDialog.open({});
  assert.equal(activeSegment("Editor font size").textContent, "13");
  PopupManager.close();

  // … but an off-ladder value is REPAIRED toward what it asked for rather than
  // reset, so a hand-edited settings.json keeps its intent.
  resetDom();
  SettingsDialog.open({ fontSize: 15 });
  assert.equal(activeSegment("Editor font size").textContent, "16");
  PopupManager.close();
});

test("SettingsDialog: Language stays the Appearance panel's first row", () => {
  // The font-size row went in UNDER Language and its hint; the language picker
  // has to lead, since it is the one control a user who cannot read the current
  // language needs to find first.
  resetDom();
  SettingsDialog.open({});
  const panel = document.querySelector('.settings-panel[data-panel="appearance"]'); // prettier-ignore
  assert.equal(
    panel.firstElementChild.querySelector(".settings-label").textContent,
    "Language",
  );
  const labels = [...panel.querySelectorAll(".settings-label")].map(
    (l) => l.textContent,
  );
  assert.deepEqual(labels.slice(0, 3), [
    "Language",
    "Editor font size",
    "Theme",
  ]);
  PopupManager.close();
});

test("SettingsDialog: a row's note is disclosed by its (i), not shown permanently", () => {
  resetDom();
  SettingsDialog.open({});
  const panel = document.querySelector('.settings-panel[data-panel="appearance"]'); // prettier-ignore

  // Nothing explanatory is on screen until it is asked for.
  const notes = [...panel.querySelectorAll(".settings-note")];
  assert.ok(notes.length >= 3, "Language, Editor font size and Wire layout");
  assert.ok(
    notes.every((n) => n.hasAttribute("hidden")),
    "every note starts closed",
  );

  // The (i) sits beside the label it documents, inside the same row.
  const fontRow = [...panel.querySelectorAll(".settings-row")].find(
    (r) => r.querySelector(".settings-label")?.textContent === "Editor font size", // prettier-ignore
  );
  const info = fontRow.querySelector(".settings-label-group .info-btn");
  assert.ok(info, "the (i) is a sibling of the label, not inside it");
  assert.equal(info.getAttribute("aria-expanded"), "false");

  const note = document.getElementById(info.getAttribute("aria-controls"));
  assert.ok(fontRow.contains(note), "the note is positioned against its row");
  info.dispatchEvent(new window.Event("click"));
  assert.ok(!note.hasAttribute("hidden"), "the (i) opens it");
  assert.equal(info.getAttribute("aria-expanded"), "true");
  assert.match(note.textContent, /scale with the desk zoom/);

  info.dispatchEvent(new window.Event("click"));
  assert.ok(note.hasAttribute("hidden"), "and closes it again");
  assert.equal(info.getAttribute("aria-expanded"), "false");
  PopupManager.close();
});

test("SettingsDialog: Escape closes an open note, NOT the dialog under it", () => {
  // The note lives inside a native modal <dialog>, where Escape is the
  // browser's close-request for the whole card. If the note did not take that
  // key first, reading a note and dismissing it would throw Settings away.
  resetDom();
  SettingsDialog.open({});
  const panel = document.querySelector('.settings-panel[data-panel="appearance"]'); // prettier-ignore
  const info = panel.querySelector(".info-btn");
  const note = document.getElementById(info.getAttribute("aria-controls"));
  info.dispatchEvent(new window.Event("click"));
  assert.ok(!note.hasAttribute("hidden"));

  const esc = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(esc);
  assert.ok(note.hasAttribute("hidden"), "Escape closed the note");
  assert.equal(info.getAttribute("aria-expanded"), "false");
  assert.ok(esc.defaultPrevented, "and swallowed the dialog's close-request");
  assert.ok(
    document.querySelector(".settings-popup"),
    "so Settings is still open",
  );

  // With the note shut, the key is nobody's but the dialog's again.
  const again = new window.KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(again);
  assert.equal(again.defaultPrevented, false, "the next Escape passes through");
  PopupManager.close();
});

test("SettingsDialog: a click outside an open note closes it", () => {
  resetDom();
  SettingsDialog.open({});
  const panel = document.querySelector('.settings-panel[data-panel="appearance"]'); // prettier-ignore
  const info = panel.querySelector(".info-btn");
  const note = document.getElementById(info.getAttribute("aria-controls"));
  info.dispatchEvent(new window.Event("click"));
  assert.ok(!note.hasAttribute("hidden"));

  // Inside the note is not outside it — reading does not dismiss.
  note.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.ok(!note.hasAttribute("hidden"), "a click IN the note keeps it open");

  panel.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.ok(note.hasAttribute("hidden"), "a click outside closes it");
  PopupManager.close();
});

test("SettingsDialog: every (i) is labelled by the row it documents", () => {
  // The button carries no text, so its accessible name is the only thing
  // telling one (i) from the four others on the same panel.
  resetDom();
  SettingsDialog.open({});
  const panel = document.querySelector('.settings-panel[data-panel="appearance"]'); // prettier-ignore
  const names = [...panel.querySelectorAll(".info-btn")].map((b) =>
    b.getAttribute("aria-label"),
  );
  assert.deepEqual(names, [
    "More about Language",
    "More about Editor font size",
    "More about Wire layout",
  ]);
  assert.ok(
    [...panel.querySelectorAll(".info-btn")].every(
      (b) => b.getAttribute("title") === b.getAttribute("aria-label"),
    ),
    "the tooltip says what the screen reader says",
  );
  PopupManager.close();
});

test("SettingsDialog: the colour input seeds from selectionColor and emits on input", () => {
  resetDom();
  SettingsDialog.open({ selectionColor: "#ff8800" });
  const input = document.querySelector("#set-selection-color");
  assert.equal(input.value, "#ff8800");

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  input.value = "#00ccff";
  input.dispatchEvent(new window.Event("input"));
  assert.deepEqual(patches, [{ selectionColor: "#00ccff" }]);

  PopupManager.close();
});

test("SettingsDialog: the default-LED-color swatches seed and emit on click", () => {
  resetDom();
  SettingsDialog.open({ defaultLedColor: "blue" });
  const swatches = [...document.querySelectorAll(".color-swatch")];
  assert.deepEqual(
    swatches.map((b) => b.dataset.color),
    ["red", "green", "blue", "yellow", "white"],
  );
  const selected = document.querySelector(".color-swatch--selected");
  assert.equal(selected.dataset.color, "blue", "seeded from defaultLedColor");

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  const white = swatches.find((b) => b.dataset.color === "white");
  white.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(patches, [{ defaultLedColor: "white" }]);
  assert.equal(
    white.classList.contains("color-swatch--selected"),
    true,
    "the ring moves to the clicked swatch",
  );

  PopupManager.close();
});

test("SettingsDialog: Appearance is the first, default-visible tab", () => {
  resetDom();
  SettingsDialog.open({});
  const dialog = document.querySelector(".settings-popup");
  assert.ok(dialog, "the settings dialog mounted");
  const appearance = dialog.querySelector(
    '[data-panel="appearance"].settings-panel',
  );
  const appearanceTab = dialog.querySelector(
    '.settings-nav-item[data-panel="appearance"]',
  );
  assert.ok(!appearance.hidden, "Appearance panel starts visible");
  assert.equal(appearanceTab.getAttribute("aria-selected"), "true");
  PopupManager.close();
});

test("SettingsDialog: opening twice does not stack a second dialog", () => {
  resetDom();
  SettingsDialog.open({});
  SettingsDialog.open({}); // guarded — no-op while one is open
  assert.equal(document.querySelectorAll(".settings-popup").length, 1);
  PopupManager.close();
  // After close the guard resets, so it can open again.
  SettingsDialog.open({});
  assert.equal(document.querySelectorAll(".settings-popup").length, 1);
  PopupManager.close();
});

test("SettingsDialog: the Data Sheets tab switches panels", () => {
  resetDom();
  SettingsDialog.open({});
  const dialog = document.querySelector(".settings-popup");
  assert.deepEqual(
    [...dialog.querySelectorAll(".settings-nav-item")].map(
      (b) => b.textContent,
    ),
    ["Appearance", "Data Sheets", "AI", "About"],
  );

  const appearance = dialog.querySelector(
    '[data-panel="appearance"].settings-panel',
  );
  const sheets = dialog.querySelector(
    '[data-panel="datasheets"].settings-panel',
  );
  assert.ok(!appearance.hidden, "Appearance panel starts visible");
  assert.ok(sheets.hidden, "Data Sheets panel starts hidden");

  const sheetsTab = dialog.querySelector(
    '.settings-nav-item[data-panel="datasheets"]',
  );
  sheetsTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.ok(appearance.hidden, "Appearance hides after switching");
  assert.ok(!sheets.hidden, "Data Sheets shows after switching");
  assert.equal(sheetsTab.getAttribute("aria-selected"), "true");

  PopupManager.close();
});

// ── A language change rebuilds the card ─────────────────────────────────────
// The Language picker is IN this dialog, so it is the ONE card that can still
// be on screen when the language changes. Every other transient surface is
// built when it opens and speaks the current language for free; leaving this
// one in the language just left makes the setting look like it did nothing.

/** app.js's half of the handshake: it loads the new catalog and only THEN
    announces it, so the rebuild reads the language it is being told about. */
function switchToGerman(window) {
  applyCatalog({
    active: "de",
    lang: "de",
    messages: DE,
    fallback: EN,
    locales: LOCALES,
  });
  window.dispatchEvent(new window.CustomEvent("chiphippo:locale-changed"));
}

test("SettingsDialog: a language change rebuilds the card in the new language", (t) => {
  const window = resetDom({ locales: LOCALES });
  t.after(() => {
    PopupManager.close();
    applyCatalog({ active: "en", lang: "en", messages: EN, fallback: EN, locales: LOCALES }); // prettier-ignore
  });
  SettingsDialog.open({ locale: "en" });
  assert.equal(
    document.querySelector(".popup-title").textContent,
    EN.settings.title,
  );

  // Pick German the way a user does — the dialog emits, app.js persists and
  // reloads the catalog, then announces.
  const select = document.querySelector("#set-language");
  select.value = "de";
  select.dispatchEvent(new window.Event("change"));
  switchToGerman(window);

  // ONE card, not two: the rebuild closes before it reopens, so nothing is
  // left queued behind a card the user can no longer see.
  assert.equal(document.querySelectorAll(".settings-popup").length, 1);
  assert.equal(
    document.querySelector(".popup-title").textContent,
    DE.settings.title,
    "the header title is rebuilt, not just the panels",
  );
  assert.deepEqual(
    [...document.querySelectorAll(".settings-nav-item")].map(
      (b) => b.textContent,
    ),
    [
      DE.settings.nav.appearance,
      DE.settings.nav.datasheets,
      DE.settings.nav.ai,
      DE.settings.nav.about,
    ],
    "and so is the nav rail",
  );
  assert.equal(
    document.querySelector('[data-panel="appearance"] .settings-label')
      .textContent,
    DE.settings.appearance.language,
    "and so are the rows",
  );

  // THE ONE THAT MATTERS: the picker still shows the language just chosen. A
  // rebuild from the snapshot `open()` was handed would spring back to the
  // language being left, which reads as the setting refusing to take.
  assert.equal(document.querySelector("#set-language").value, "de");
});

test("SettingsDialog: a rebuild keeps the panel the user was reading", (t) => {
  const window = resetDom({ locales: LOCALES });
  t.after(() => {
    PopupManager.close();
    applyCatalog({ active: "en", lang: "en", messages: EN, fallback: EN, locales: LOCALES }); // prettier-ignore
  });
  SettingsDialog.open({});
  document
    .querySelector('.settings-nav-item[data-panel="datasheets"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  switchToGerman(window);

  const sheetsTab = document.querySelector(
    '.settings-nav-item[data-panel="datasheets"]',
  );
  assert.equal(
    sheetsTab.getAttribute("aria-selected"),
    "true",
    "the rebuilt nav rail is still on Data Sheets",
  );
  assert.ok(
    !document.querySelector('[data-panel="datasheets"].settings-panel').hidden,
    "and so is the panel — a rebuild must not dump the user back on Appearance",
  );
  assert.ok(
    document.querySelector('[data-panel="appearance"].settings-panel').hidden,
  );

  // A FRESH open starts over on Appearance, as it always did — the resumed
  // panel belongs to the rebuild, not to the dialog for ever after.
  PopupManager.close();
  SettingsDialog.open({});
  assert.ok(
    !document.querySelector('[data-panel="appearance"].settings-panel').hidden,
  );
});

test("SettingsDialog: a language change after it closes does not reopen it", (t) => {
  const window = resetDom({ locales: LOCALES });
  t.after(
    () =>
    applyCatalog({ active: "en", lang: "en", messages: EN, fallback: EN, locales: LOCALES }), // prettier-ignore
  );
  SettingsDialog.open({});
  PopupManager.close();

  // The listener belongs to the dialog's OPEN lifetime — the same rule the
  // About panel's updater listeners follow. A leaked one would put the card
  // back on screen out of nowhere, and leak another every time Settings opened.
  switchToGerman(window);
  assert.equal(document.querySelectorAll(".settings-popup").length, 0);
});

test("SettingsDialog: the datasheet folder seeds from settings and Clear resets it", () => {
  resetDom();
  SettingsDialog.open({ datasheetDir: "/data/sheets" });
  const path = document.querySelector(".settings-folder-path");
  assert.equal(path.textContent, "/data/sheets", "seeded with the saved path");
  assert.ok(!path.classList.contains("settings-folder-path--empty"));

  const clear = document.querySelector(".settings-action--danger");
  assert.ok(!clear.hidden, "Clear is offered when a folder is set");
  assert.equal(
    clear.textContent,
    "Clear",
    "it says so, rather than drawing it",
  );

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  clear.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(patches, [{ datasheetDir: null }], "Clear emits a null dir");
  assert.equal(path.textContent, "No folder selected");
  assert.ok(clear.hidden, "Clear hides once there is no folder");

  PopupManager.close();
});

test("SettingsDialog: with no datasheet folder, Clear is hidden and path is empty", () => {
  resetDom();
  SettingsDialog.open({});
  const path = document.querySelector(".settings-folder-path");
  assert.equal(path.textContent, "No folder selected");
  assert.ok(path.classList.contains("settings-folder-path--empty"));
  assert.ok(document.querySelector(".settings-action--danger").hidden);
  PopupManager.close();
});

// ── The AI tab (Feature 260) ────────────────────────────────────────────────
// Its rows are built from the provider list MAIN answers with, so the bridge
// is stubbed rather than the list restated here — that IS the thing under test.

const AI_PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-opus-5",
    keyLabel: "API key",
  },
  {
    id: "openai-compat",
    label: "OpenAI-compatible",
    defaultBaseUrl: "http://localhost:11434",
    defaultModel: "llama3.1",
    keyLabel: "API key (blank for a local server)",
  },
];

/** Install a fake `window.chiphippo.ai`, recording every call it receives. */
function stubAiBridge({
  status = { configured: false, encryptionAvailable: true },
} = {}) {
  const calls = { set: [], clear: [], test: [] };
  window.chiphippo = {
    ai: {
      providers: async () => AI_PROVIDERS,
      key: {
        status: async () => status,
        set: async (...a) => (calls.set.push(a), { ok: true }),
        clear: async (...a) => (calls.clear.push(a), { ok: true }),
      },
      test: async (...a) => (calls.test.push(a), { ok: true }),
    },
  };
  return calls;
}

/** Let the provider fetch + the key-status read settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

test("SettingsDialog: the AI tab builds its picker from main's provider list", async () => {
  resetDom();
  stubAiBridge();
  SettingsDialog.open({
    ai: { provider: "openai-compat", baseUrl: "", model: "" },
  });
  await flush();

  const panel = document.querySelector('.settings-panel[data-panel="ai"]');
  assert.ok(panel.hidden, "the AI panel starts hidden");
  const segments = [...panel.querySelectorAll(".segmented-option")];
  assert.deepEqual(
    segments.map((b) => b.textContent),
    ["Anthropic", "OpenAI-compatible"],
    "the picker is the list main sent, not a renderer constant",
  );
  assert.equal(
    segments.find((b) => b.classList.contains("segmented-option--active"))
      .textContent,
    "OpenAI-compatible",
    "seeded from settings.ai.provider",
  );
  // Empty fields advertise the chosen provider's fallbacks.
  assert.equal(
    panel.querySelector("#set-ai-base-url").placeholder,
    "http://localhost:11434",
  );
  assert.equal(panel.querySelector("#set-ai-model").placeholder, "llama3.1");

  PopupManager.close();
});

test("SettingsDialog: an AI field emits the WHOLE ai object, on change not per keystroke", async () => {
  resetDom();
  stubAiBridge();
  SettingsDialog.open({
    ai: { provider: "anthropic", baseUrl: "", model: "" },
  });
  await flush();

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  const model = document.querySelector("#set-ai-model");
  model.value = "claude-sonnet-5";
  model.dispatchEvent(new window.Event("input"));
  assert.deepEqual(patches, [], "typing alone writes nothing to disk");

  model.dispatchEvent(new window.Event("change"));
  assert.deepEqual(patches, [
    {
      ai: { provider: "anthropic", baseUrl: "", model: "claude-sonnet-5" },
    },
  ]);

  // settings.set shallow-merges, so an object-valued setting must be whole —
  // emitting only the changed field would erase the provider and base URL.
  document
    .querySelectorAll(".settings-panel[data-panel='ai'] .segmented-option")[1]
    .click();
  assert.deepEqual(patches[1], {
    ai: {
      provider: "openai-compat",
      baseUrl: "",
      model: "claude-sonnet-5",
    },
  });

  PopupManager.close();
});

test("SettingsDialog: the API key bypasses the settings patch entirely", async () => {
  resetDom();
  const calls = stubAiBridge();
  SettingsDialog.open({
    ai: { provider: "anthropic", baseUrl: "", model: "" },
  });
  await flush();

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  const key = document.querySelector("#set-ai-key");
  assert.equal(key.type, "password");
  key.value = "sk-secret";
  [...document.querySelectorAll(".settings-action")]
    .find((b) => b.textContent === "Save key")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await flush();

  assert.deepEqual(calls.set, [["anthropic", "sk-secret"]], "went to main");
  assert.deepEqual(patches, [], "and NEVER through settings.json");
  assert.equal(key.value, "", "the field does not keep the key around");

  PopupManager.close();
});

test("SettingsDialog: with no OS credential store the key field is disabled and says why", async () => {
  resetDom();
  stubAiBridge({ status: { configured: false, encryptionAvailable: false } });
  SettingsDialog.open({});
  await flush();

  const panel = document.querySelector('.settings-panel[data-panel="ai"]');
  assert.equal(panel.querySelector("#set-ai-key").disabled, true);
  assert.match(
    [...panel.querySelectorAll(".settings-hint")]
      .map((p) => p.textContent)
      .join(" "),
    /no secure credential store/i,
  );

  PopupManager.close();
});

// ── Settings ▸ About (auto-update) ──────────────────────────────────────────
// The About panel is the only one with LIVE state: a check reports itself over
// the chiphippo:updater-* broadcasts, which arrive whether the check started
// here, from the Help menu, or on its own at launch.

/** Install a fake bridge whose getAppInfo answers with `info`. */
function stubAppInfo(info) {
  const calls = { check: 0, install: 0 };
  window.chiphippo = {
    getAppInfo: async () => info,
    updater: {
      check: async () => (calls.check += 1),
      install: async () => (calls.install += 1),
    },
  };
  return calls;
}

/** The About panel's status line (the only `role="status"` in the dialog). */
const aboutStatus = () =>
  document.querySelector('.settings-panel[data-panel="about"] [role="status"]');

const fire = (name, detail) =>
  window.dispatchEvent(new window.CustomEvent(name, { detail }));

test("SettingsDialog: About shows the version and checks on demand", async () => {
  resetDom();
  const calls = stubAppInfo({ version: "1.2.3", distribution: "direct" });
  SettingsDialog.open({});
  await flush();

  const panel = document.querySelector('.settings-panel[data-panel="about"]');
  assert.ok(panel.hidden, "the About panel starts hidden");
  assert.match(panel.textContent, /Chip Hippo 1\.2\.3/);
  assert.equal(aboutStatus().textContent, "", "nothing claimed until asked");

  const check = [...panel.querySelectorAll(".settings-action")].find(
    (b) => b.textContent === "Check for updates",
  );
  check.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(calls.check, 1);
  assert.match(aboutStatus().textContent, /Checking for updates/i);

  PopupManager.close();
});

test("SettingsDialog: About tracks the updater broadcasts and offers Restart", async () => {
  resetDom();
  const calls = stubAppInfo({ version: "1.2.3", distribution: "direct" });
  SettingsDialog.open({});
  await flush();

  const panel = document.querySelector('.settings-panel[data-panel="about"]');
  const restart = [...panel.querySelectorAll(".settings-action")].find(
    (b) => b.textContent === "Restart to update",
  );
  assert.ok(restart.hidden, "nothing to restart INTO until one is downloaded");

  fire("chiphippo:updater-available", { version: "1.3.0", manual: true });
  assert.match(aboutStatus().textContent, /1\.3\.0 is available/);

  fire("chiphippo:updater-downloaded", { version: "1.3.0" });
  assert.match(aboutStatus().textContent, /1\.3\.0 is ready to install/);
  assert.ok(!restart.hidden, "and now there is");

  restart.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(calls.install, 1);

  // "store-build" / "dev-build" are ANSWERS, not failures.
  fire("chiphippo:updater-not-available", {
    manual: true,
    reason: "dev-build",
  });
  assert.match(
    aboutStatus().textContent,
    /only available in installed builds/i,
  );
  fire("chiphippo:updater-not-available", { manual: true });
  assert.match(aboutStatus().textContent, /latest version/i);

  PopupManager.close();
});

test("SettingsDialog: About drops its updater listeners when the dialog closes", async () => {
  resetDom();
  stubAppInfo({ version: "1.2.3", distribution: "direct" });
  SettingsDialog.open({});
  await flush();
  const status = aboutStatus();

  PopupManager.close();
  // The panel is detached but still reachable from here — if the listeners
  // outlived the dialog they would keep writing into it, one more set every
  // time Settings was opened.
  fire("chiphippo:updater-checking", {});
  assert.equal(status.textContent, "", "the closed panel is no longer written");
});

test("SettingsDialog: About auto-check seeds and emits", async () => {
  resetDom();
  stubAppInfo({ version: "1.2.3", distribution: "direct" });
  SettingsDialog.open({ autoUpdateCheck: true });
  await flush();

  const group = document.querySelector(
    '.segmented-picker[aria-label="Check for updates automatically"]',
  );
  const segments = [...group.querySelectorAll(".segmented-option")];
  assert.deepEqual(
    segments.map((b) => b.textContent),
    ["On", "Off"],
  );
  assert.equal(
    segments.find((b) => b.classList.contains("segmented-option--active"))
      .textContent,
    "On",
  );

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  segments[1].click();
  assert.deepEqual(patches, [{ autoUpdateCheck: false }]);

  // THE ONE THAT MATTERS FOR A BOOLEAN PICKER: the segment clicked has to light
  // up. The active state used to be re-derived by matching each button's
  // `data-value` ATTRIBUTE against the chosen value — and `el()` renders a
  // `false` prop as a MISSING attribute and `true` as an empty one, so neither
  // segment ever matched: clicking left the whole track blank. It read as a
  // setting that would not stay set, though it was stored correctly all along.
  assert.equal(
    segments.find((b) => b.classList.contains("segmented-option--active"))
      ?.textContent,
    "Off",
  );
  assert.deepEqual(
    segments.map((b) => b.getAttribute("aria-checked")),
    ["false", "true"],
  );
  assert.deepEqual(
    segments.map((b) => b.getAttribute("data-value")),
    ["true", "false"],
    "a boolean option still round-trips as an attribute (through dataset)",
  );

  PopupManager.close();

  // Absent means off — an update check is an outbound call, so it is opt-in.
  resetDom();
  stubAppInfo({ version: "1.2.3", distribution: "direct" });
  SettingsDialog.open({});
  await flush();
  assert.equal(activeSegment("Check for updates automatically").textContent, "Off"); // prettier-ignore
  PopupManager.close();
});

test("SettingsDialog: a rebuild keeps an About change, not just an Appearance one", async (t) => {
  const window = resetDom({ locales: LOCALES });
  t.after(() => {
    PopupManager.close();
    applyCatalog({ active: "en", lang: "en", messages: EN, fallback: EN, locales: LOCALES }); // prettier-ignore
  });
  stubAppInfo({ version: "1.2.3", distribution: "direct" });
  SettingsDialog.open({ locale: "en", autoUpdateCheck: false });
  await flush();

  document
    .querySelector('.settings-nav-item[data-panel="about"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  document
    .querySelectorAll(
      '.settings-panel[data-panel="about"] .segmented-option',
    )[0]
    .click();

  // The About panel used to emit through the module-level helper, which tells
  // app.js but not the dialog — so a rebuild reseeded it from the snapshot
  // `open()` was handed, and the setting sprang back to the value being left.
  // The Language picker is in this same card, so that is a reachable sequence,
  // not a hypothetical one.
  switchToGerman(window);
  await flush();
  assert.equal(
    document.querySelector(
      '.settings-panel[data-panel="about"] .segmented-option--active',
    ).textContent,
    DE.settings.about.autoOn,
  );
});

test("SettingsDialog: a store build offers no update controls at all", async () => {
  resetDom();
  stubAppInfo({ version: "1.2.3", distribution: "store" });
  SettingsDialog.open({});
  await flush();

  const panel = document.querySelector('.settings-panel[data-panel="about"]');
  assert.match(panel.textContent, /Chip Hippo 1\.2\.3/, "the version remains");
  for (const row of panel.querySelectorAll(".settings-row")) {
    const isVersion = row.textContent.includes("Version");
    assert.equal(
      row.hidden,
      !isVersion,
      "every row but the version is hidden in a store build",
    );
  }
  assert.match(panel.textContent, /delivered through the App Store/i);

  PopupManager.close();
});

test("AboutDialog: mounts with the product name and closes cleanly", () => {
  resetDom();
  AboutDialog.open();
  const dialog = document.querySelector(".about-dialog");
  assert.ok(dialog);
  assert.match(dialog.querySelector(".about-name").textContent, /Chip Hippo/);
  PopupManager.close();
  assert.equal(document.querySelector(".about-dialog"), null);
});

// App Store Review Guideline 1.5 asks the APP to carry a contact route, not
// merely the store listing's Support URL — its absence is what got 1.0.0
// rejected. So this is a COMPLIANCE test, not a cosmetic one: it fails if the
// only way to reach a human is taken back out of the card.
test("AboutDialog: carries a support contact route", () => {
  resetDom();
  AboutDialog.open();

  const link = document.querySelector(".about-support-link");
  assert.ok(link, "the About card offers a contact link");
  assert.match(
    link.getAttribute("href"),
    /^mailto:.+@.+\..+/,
    "it is a mailto",
  );
  assert.equal(
    link.textContent,
    link.getAttribute("href").replace("mailto:", ""),
    "the address is READABLE too — a machine with no mail client still needs it",
  );
  assert.equal(
    link.getAttribute("target"),
    "_blank",
    "target=_blank is what routes it to setWindowOpenHandler → shell.openExternal",
  );

  PopupManager.close();
});

test("AboutDialog: the support LABEL is catalog text, the address is not", () => {
  resetDom();
  applyCatalog({ active: "de", lang: "de", messages: DE, fallback: EN, locales: LOCALES }); // prettier-ignore
  AboutDialog.open();

  assert.equal(
    document.querySelector(".about-support-label").textContent,
    DE.about.support,
    "the label follows the active catalog",
  );
  assert.equal(
    document.querySelector(".about-support-link").textContent,
    "hippoherd@gmail.com",
    "the address is an identity — the same characters in every language",
  );

  PopupManager.close();
  applyCatalog({ active: "en", lang: "en", messages: EN, fallback: EN, locales: LOCALES }); // prettier-ignore
});

test("AboutDialog: the (i) toggle reveals the build popover", () => {
  resetDom();
  AboutDialog.open();
  const build = document.querySelector(".about-build");
  const info = document.querySelector(".info-btn");
  assert.ok(build.hasAttribute("hidden"), "build details start hidden");
  info.dispatchEvent(new window.Event("click"));
  assert.ok(!build.hasAttribute("hidden"), "the (i) button reveals them");
  assert.equal(info.getAttribute("aria-expanded"), "true");
  PopupManager.close();
});
