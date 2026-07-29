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

import { resetDom } from "./jsdom-setup.js";

const { PopupManager } = await import("../popup-manager.js");
const { SettingsDialog } = await import("../components/settings-dialog.js");
const { AboutDialog } = await import("../components/about-dialog.js");

test("SettingsDialog: the theme picker leads Appearance, seeds, and emits", () => {
  resetDom();
  SettingsDialog.open({ theme: "light" });

  // `.settings-panel` qualified: the NAV ITEM carries the same data-panel.
  const panel = document.querySelector('.settings-panel[data-panel="appearance"]'); // prettier-ignore
  assert.equal(
    panel.firstElementChild.querySelector(".settings-label").textContent,
    "Theme",
    "the theme picker is the FIRST row of the Appearance panel",
  );

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
    ["Appearance", "Data Sheets", "AI"],
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

test("AboutDialog: mounts with the product name and closes cleanly", () => {
  resetDom();
  AboutDialog.open();
  const dialog = document.querySelector(".about-dialog");
  assert.ok(dialog);
  assert.match(dialog.querySelector(".about-name").textContent, /Chip Hippo/);
  PopupManager.close();
  assert.equal(document.querySelector(".about-dialog"), null);
});

test("AboutDialog: the (i) toggle reveals the build popover", () => {
  resetDom();
  AboutDialog.open();
  const build = document.querySelector(".about-build");
  const info = document.querySelector(".about-info-btn");
  assert.ok(build.hasAttribute("hidden"), "build details start hidden");
  info.dispatchEvent(new window.Event("click"));
  assert.ok(!build.hasAttribute("hidden"), "the (i) button reveals them");
  assert.equal(info.getAttribute("aria-expanded"), "true");
  PopupManager.close();
});
