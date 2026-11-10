/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

// The Keyboard Shortcuts sheet says a Shift chord in the order the menus do
// (menu-actions.js `accelHint`): Ctrl+Shift off a Mac — never Shift+Ctrl.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

test("Shift chords read Ctrl first, as the menus and tooltips say them", async () => {
  resetDom(); // no platform: not a Mac
  const { KeyboardShortcutsDialog } = await import("../components/keyboard-shortcuts.js"); // prettier-ignore
  const { PopupManager } = await import("../popup-manager.js");
  KeyboardShortcutsDialog.open();
  const keys = [...document.querySelectorAll(".shortcuts-keys")].map((k) => k.textContent); // prettier-ignore
  assert.ok(keys.includes("Ctrl+Shift+B"), "Browse Projects");
  assert.ok(keys.includes("Ctrl+Shift+S"), "Save As");
  assert.ok(!keys.some((k) => k.startsWith("Shift+Ctrl")), keys.join(" | "));
  PopupManager.close();
});
