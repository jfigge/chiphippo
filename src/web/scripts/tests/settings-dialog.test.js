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

test("SettingsDialog: opens seeded, and a toggle broadcasts a patch", () => {
  resetDom();
  SettingsDialog.open({ showDeskHub: false, selectionColor: null });

  const dialog = document.querySelector(".settings-popup");
  assert.ok(dialog, "the settings dialog mounted");
  const checkbox = dialog.querySelector("#set-show-hub");
  assert.equal(checkbox.checked, false, "seeded from the passed settings");

  const patches = [];
  window.addEventListener("chiphippo:settings-changed", (e) =>
    patches.push(e.detail),
  );
  checkbox.checked = true;
  checkbox.dispatchEvent(new window.Event("change"));
  assert.deepEqual(patches, [{ showDeskHub: true }], "emits a shallow patch");

  PopupManager.close();
});

test("SettingsDialog: the colour input seeds from selectionColor and emits on input", () => {
  resetDom();
  SettingsDialog.open({ showDeskHub: false, selectionColor: "#ff8800" });
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
