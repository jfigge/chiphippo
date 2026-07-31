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
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";

const isMac = window.chiphippo?.platform === "darwin";
const MOD = isMac ? "⌘" : "Ctrl";
const SHIFT = isMac ? "⇧" : "Shift";
const ALT = isMac ? "⌥" : "Alt";

/**
 * Grouped shortcut rows — the single source of truth this dialog renders.
 *
 * A function, not a constant: every description is a `t()` lookup, and `t()`
 * must never run at module scope (see i18n.js). The KEYS are not catalog text —
 * a keyboard's own glyphs (⌘, Tab, Esc, W) are the same in every language, and
 * the modifier already varies by PLATFORM rather than by locale.
 */
const shortcutGroups = () => [
  {
    title: t("shortcuts.group.file"),
    rows: [
      { desc: t("shortcuts.file.new"), keys: `${MOD}+N` },
      { desc: t("shortcuts.file.open"), keys: `${MOD}+O` },
      { desc: t("shortcuts.file.openRecent"), keys: `${SHIFT}+${MOD}+O` },
      { desc: t("shortcuts.file.save"), keys: `${MOD}+S` },
      { desc: t("shortcuts.file.saveAs"), keys: `${SHIFT}+${MOD}+S` },
      { desc: t("shortcuts.file.bom"), keys: `${MOD}+B` },
    ],
  },
  {
    title: t("shortcuts.group.tools"),
    rows: [
      { desc: t("shortcuts.tools.wire"), keys: "W" },
      { desc: t("shortcuts.tools.bus"), keys: "B" },
      { desc: t("shortcuts.tools.probe"), keys: "P" },
      { desc: t("shortcuts.tools.putAway"), keys: "M" },
      { desc: t("shortcuts.tools.rotate"), keys: "R" },
      { desc: t("shortcuts.tools.flip"), keys: "F" },
    ],
  },
  {
    title: t("shortcuts.group.wireBus"),
    rows: [
      { desc: t("shortcuts.wireBus.color"), keys: "1–8" },
      { desc: t("shortcuts.wireBus.width"), keys: "1–8" },
    ],
  },
  {
    title: t("shortcuts.group.edit"),
    rows: [
      { desc: t("shortcuts.edit.selectAll"), keys: `${MOD}+A` },
      { desc: t("shortcuts.edit.copy"), keys: `${MOD}+C` },
      { desc: t("shortcuts.edit.paste"), keys: `${MOD}+V` },
      { desc: t("shortcuts.edit.delete"), keys: "Delete" },
      { desc: t("shortcuts.edit.undo"), keys: `${MOD}+Z` },
      { desc: t("shortcuts.edit.redo"), keys: `${SHIFT}+${MOD}+Z` },
      { desc: t("shortcuts.edit.cancel"), keys: "Esc" },
    ],
  },
  {
    title: t("shortcuts.group.view"),
    rows: [
      { desc: t("shortcuts.view.toggleView"), keys: "Tab" },
      { desc: t("shortcuts.view.fadeWires"), keys: "H" },
      { desc: t("shortcuts.view.palette"), keys: `${MOD}+P` },
      { desc: t("shortcuts.view.analyzer"), keys: "A" },
      { desc: t("shortcuts.view.fit"), keys: `${MOD}+F` },
      { desc: t("shortcuts.view.zoomOut"), keys: `${SHIFT}+${MOD}+F` },
      {
        desc: t("shortcuts.view.fontSize"),
        keys: `${MOD}+ / ${MOD}- / ${MOD}0`,
      },
      // Beside the text size above, because the pair IS the distinction: that
      // one resizes the app's own text, this one zooms the circuit.
      {
        desc: t("shortcuts.view.zoom"),
        keys: `${ALT}${MOD}+ / ${ALT}${MOD}- / ${ALT}${MOD}0`,
      },
      { desc: t("shortcuts.view.lockDesk"), keys: `${MOD}+L` },
    ],
  },
  {
    title: t("shortcuts.group.simulation"),
    rows: [
      {
        desc: t("shortcuts.simulation.run"),
        keys: t("shortcuts.simulation.runKeys", { mod: MOD }),
      },
    ],
  },
];

export class KeyboardShortcutsDialog {
  static #open = false;

  /** Show the Keyboard Shortcuts dialog (a no-op when one is already open). */
  static open() {
    if (KeyboardShortcutsDialog.#open) return;
    KeyboardShortcutsDialog.#open = true;

    const groups = shortcutGroups().map(({ title, rows }) =>
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
      title: t("shortcuts.title"),
      closeAriaLabel: t("shortcuts.close"),
      className: "shortcuts-popup",
      bodyClass: "shortcuts-body",
      body: groups,
      onClose: () => {
        KeyboardShortcutsDialog.#open = false;
      },
    });
  }
}
