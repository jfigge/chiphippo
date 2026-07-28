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

// keyboard-shortcuts.js — the "Keyboard Shortcuts" help modal, opened from the
// application menu (Help ▸ Keyboard Shortcuts, CmdOrCtrl+K — menu:keyboard-
// shortcuts → chiphippo:keyboard-shortcuts). A renderer PopupManager modal
// styled like AboutDialog/SettingsDialog: a header + close button over a
// scrollable body of grouped shortcut rows. SHORTCUT_GROUPS is a plain data
// catalogue — it doesn't read any live state, so it can never go stale.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";

const isMac = window.chiphippo?.platform === "darwin";
const MOD = isMac ? "⌘" : "Ctrl";
const SHIFT = isMac ? "⇧" : "Shift";

/** Grouped shortcut rows — the single source of truth this dialog renders. */
const SHORTCUT_GROUPS = [
  {
    title: "File",
    rows: [
      { desc: "New project", keys: `${MOD}+N` },
      { desc: "Open a project", keys: `${MOD}+O` },
      { desc: "Save", keys: `${MOD}+S` },
      { desc: "Save As…", keys: `${SHIFT}+${MOD}+S` },
      { desc: "Bill of materials (build guide)", keys: `${MOD}+B` },
    ],
  },
  {
    title: "Tools",
    rows: [
      { desc: "Wire tool", keys: "W" },
      { desc: "Bus tool", keys: "B" },
      { desc: "Probe tool", keys: "P" },
      { desc: "Put away the wire / bus / probe tool", keys: "M" },
      { desc: "Rotate a part / stand a rail on end", keys: "R" },
      { desc: "Flip LED polarity while placing", keys: "F" },
    ],
  },
  {
    title: "Wire & bus (while that tool is armed)",
    rows: [
      {
        desc: "Wire color — 1 Red 2 Black 3 Blue 4 Green 5 Yellow 6 Orange 7 White 8 Purple",
        keys: "1–8",
      },
      { desc: "Bus width — 1 for 8-bit, 2 for 16-bit", keys: "1–2" },
    ],
  },
  {
    title: "Edit",
    rows: [
      { desc: "Copy the selected component", keys: `${MOD}+C` },
      { desc: "Paste a duplicate", keys: `${MOD}+V` },
      { desc: "Delete the selection", keys: "Delete" },
      { desc: "Undo", keys: `${MOD}+Z` },
      { desc: "Redo", keys: `${SHIFT}+${MOD}+Z` },
      { desc: "Cancel the current tool / deselect", keys: "Esc" },
    ],
  },
  {
    title: "View",
    rows: [
      { desc: "Breadboard ⇄ Schematic", keys: "Tab" },
      { desc: "Fade wires to a stub at each end", keys: "H" },
      { desc: "Toggle the parts palette", keys: `${MOD}+P` },
      { desc: "Toggle the logic analyzer", keys: `${MOD}+A` },
      { desc: "Fit to screen", keys: `${MOD}+F` },
      {
        desc: "Zoom all the way out (find a lost part)",
        keys: `${SHIFT}+${MOD}+F`,
      },
      { desc: "Zoom in / out / reset", keys: `${MOD}+ / ${MOD}- / ${MOD}0` },
    ],
  },
  {
    title: "Simulation",
    rows: [{ desc: "Run / Stop the circuit", keys: `Space or ${MOD}+R` }],
  },
];

export class KeyboardShortcutsDialog {
  static #open = false;

  /** Show the Keyboard Shortcuts dialog (a no-op when one is already open). */
  static open() {
    if (KeyboardShortcutsDialog.#open) return;
    KeyboardShortcutsDialog.#open = true;

    const groups = SHORTCUT_GROUPS.map(({ title, rows }) =>
      el("section", { class: "shortcuts-group" }, [
        el("h3", { class: "shortcuts-group-title", text: title }),
        el(
          "ul",
          { class: "shortcuts-list" },
          rows.map(({ desc, keys }) =>
            el("li", { class: "shortcuts-row" }, [
              el("span", { class: "shortcuts-desc", text: desc }),
              el("kbd", { class: "shortcuts-keys", text: keys }),
            ]),
          ),
        ),
      ]),
    );

    PopupManager.dialog({
      title: "Keyboard Shortcuts",
      closeAriaLabel: "Close keyboard shortcuts",
      className: "shortcuts-popup",
      bodyClass: "shortcuts-body",
      body: groups,
      onClose: () => {
        KeyboardShortcutsDialog.#open = false;
      },
    });
  }
}
