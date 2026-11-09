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

// menu-actions.js — the File and Desktop actions, stated ONCE.
//
// The same verbs are offered in several places: the native File and Desktop
// menus (main.js `buildAppMenu`), a secondary click on any segment of the
// toolbar's File pill, a desktop tab's context menu and the tab strip's "+".
// Each used to write its own literal item list, and they drifted — different
// order, different labels ("Properties…" on a tab, "Desktop Properties…" in the
// menu bar), different sets. Every one of them is now drawn from these tables,
// so a label, a position or an availability rule changes in one place.
//
// Dependency-free ES module: main `require()`s it (require(esm), as
// `serial/protocol.js` does `serial-wire.js`), and the renderer imports it. It
// holds no strings, only catalog KEYS — main resolves them with `m()`, the
// renderer with `t()`.
//
// An action is `{ id, labelKey, accelerator?, gate?, danger?, arrival?,
// payload?, event?, submenu?, list? }`, or `SEPARATOR`:
//   · `id` names the action and, unless `event` says otherwise, the push it
//     sends — `menu:<id>` from main, `chiphippo:<id>` in the renderer, the
//     channels app.js `wireProjectMenu` already answers.
//   · `accelerator` is ELECTRON's form ("CmdOrCtrl+Shift+S"); the renderer
//     shows it through `accelHint`.
//   · `gate` names the availability rule (`isEnabled`): "duplicate" (off while
//     the circuit runs) or "delete" (off on the last desktop, and while running).
//   · `arrival` marks the two ways a desktop ARRIVES (New, Import) — the "+"'s
//     own menu.
//   · `list` marks an item whose submenu is a runtime list the caller supplies
//     (Open Recent).

export const SEPARATOR = Object.freeze({ separator: true });

const freeze = (list) =>
  Object.freeze(
    list.map((a) =>
      a === SEPARATOR
        ? a
        : Object.freeze({
            ...a,
            ...(a.submenu ? { submenu: freeze(a.submenu) } : {}),
          }),
    ),
  );

/**
 * FILE — the PROJECT's. Create, then open (by dialog, by name, by picture),
 * then write, then describe, then the read-only build guide.
 */
export const FILE_ACTIONS = freeze([
  { id: "project-new", labelKey: "menu.file.new", accelerator: "CmdOrCtrl+N" },
  SEPARATOR,
  {
    id: "project-open",
    labelKey: "menu.file.open",
    accelerator: "CmdOrCtrl+O",
  },
  { id: "project-open-recent", labelKey: "menu.file.openRecent", list: true },
  {
    id: "project-browse",
    labelKey: "menu.file.browse",
    accelerator: "CmdOrCtrl+Shift+B",
  },
  SEPARATOR,
  {
    id: "project-save",
    labelKey: "menu.file.save",
    accelerator: "CmdOrCtrl+S",
  },
  {
    id: "project-save-as",
    labelKey: "menu.file.saveAs",
    accelerator: "CmdOrCtrl+Shift+S",
  },
  SEPARATOR,
  { id: "project-properties", labelKey: "menu.file.properties" },
  SEPARATOR,
  // The right-docked build guide. Read-only, so always available.
  { id: "build-guide", labelKey: "menu.file.bom", accelerator: "CmdOrCtrl+B" },
]);

/**
 * DESKTOP — the structure inside the project, in the File menu's rhythm:
 * create, then bring in / send out, then share, then describe, then destroy.
 */
export const DESKTOP_ACTIONS = freeze([
  { id: "desktop-add", labelKey: "menu.desktop.new", arrival: true },
  {
    id: "desktop-duplicate",
    labelKey: "menu.desktop.duplicate",
    gate: "duplicate",
  },
  SEPARATOR,
  { id: "desktop-import", labelKey: "menu.desktop.import", arrival: true },
  {
    id: "desktop-export-menu",
    labelKey: "menu.desktop.exportMenu",
    // The snapshot Import reads back, above a rule, then another tool's
    // formats (Feature 390), whose push carries WHICH format.
    submenu: [
      { id: "desktop-export", labelKey: "menu.desktop.exportDesktop" },
      SEPARATOR,
      {
        id: "desktop-export-kicad",
        labelKey: "menu.desktop.exportKicad",
        event: "desktop-export-to",
        payload: "kicad",
      },
      {
        id: "desktop-export-digital",
        labelKey: "menu.desktop.exportDigital",
        event: "desktop-export-to",
        payload: "digital",
      },
    ],
  },
  SEPARATOR,
  // Reads the desktop as Duplicate does, so it follows the same run lock.
  { id: "desktop-share", labelKey: "menu.desktop.share", gate: "duplicate" },
  SEPARATOR,
  { id: "desktop-properties", labelKey: "menu.desktop.properties" },
  SEPARATOR,
  {
    id: "desktop-delete",
    labelKey: "menu.desktop.delete",
    gate: "delete",
    danger: true,
  },
]);

/** The ids that carry an availability rule — main gives these menu-item ids. */
export const GATED_ACTION_IDS = Object.freeze(
  DESKTOP_ACTIONS.filter((a) => a.gate).map((a) => a.id),
);

/** The push an action sends (without the `menu:`/`chiphippo:` prefix). */
export function actionEvent(action) {
  return action.event ?? action.id;
}

/**
 * Whether an action is available, from the ONE state both menus are fed:
 * `{ canDelete, canDuplicate }` (project-workspace.js `#pushMenuState`).
 */
export function isEnabled(action, state = {}) {
  if (action.gate === "delete") return state.canDelete !== false;
  if (action.gate === "duplicate") return state.canDuplicate !== false;
  return true;
}

/**
 * The shape every OBJECT's context menu takes (a part, a wire, a board, a
 * bus, a note, a signal, an Output/Input, a net): no rules between ordinary
 * items, the destructive ones (`danger`) last, in the order given, behind ONE
 * rule. The File and Desktop menus are not built this way — their rules are
 * the table's own (above), stated where each group is.
 * @param {Array<object>} items - popup items; any `{separator}` is dropped.
 * @returns {Array<object>}
 */
export function dangerLast(items) {
  const plain = items.filter((item) => item && !item.separator);
  const safe = plain.filter((item) => !item.danger);
  const danger = plain.filter((item) => item.danger);
  return safe.length && danger.length
    ? [...safe, { separator: true }, ...danger]
    : [...safe, ...danger];
}

/**
 * Drop separators that would lead, trail or double up once some actions have
 * been left out — a menu must never start or end on a rule.
 */
export function tidySeparators(items, isSeparator = (i) => i?.separator) {
  const out = [];
  for (const item of items) {
    if (isSeparator(item)) {
      if (out.length && !isSeparator(out[out.length - 1])) out.push(item);
    } else {
      out.push(item);
    }
  }
  while (out.length && isSeparator(out[out.length - 1])) out.pop();
  return out;
}

/**
 * A menu-style hint for an Electron accelerator: "⇧⌘S" on macOS,
 * "Shift+Ctrl+S" elsewhere — the form app.js's `accel` already shows.
 */
export function accelHint(accelerator, isMac) {
  if (!accelerator) return undefined;
  const parts = accelerator.split("+");
  const key = parts.pop();
  const shift = parts.includes("Shift");
  return isMac
    ? `${shift ? "⇧" : ""}⌘${key}`
    : `${shift ? "Shift+" : ""}Ctrl+${key}`;
}

/**
 * The renderer's form: `PopupManager.menu` items.
 *
 * @param {readonly object[]} actions
 * @param {object} opts
 * @param {(key: string) => string} opts.label - `t`.
 * @param {Record<string, (action: object) => void>} opts.handlers - one per
 *   action id this menu offers. An action with NO handler is left out (the
 *   "+" menu passes only the arrivals), and the rules re-tidied.
 * @param {object} [opts.state] - `{ canDelete, canDuplicate }`.
 * @param {Record<string, {items: object[], emptyLabel?: string}>} [opts.lists]
 *   - the runtime submenu of each `list` action, already in popup form.
 * @param {boolean} [opts.isMac]
 */
export function toPopupItems(actions, opts) {
  const { label, handlers = {}, state = {}, lists = {}, isMac = false } = opts;
  const items = [];
  for (const action of actions) {
    if (action === SEPARATOR) {
      items.push({ separator: true });
      continue;
    }
    const base = {
      label: label(action.labelKey),
      accelerator: accelHint(action.accelerator, isMac),
      disabled: !isEnabled(action, state),
      danger: action.danger || undefined,
    };
    if (action.list) {
      const list = lists[action.id];
      if (!list) continue;
      items.push({ ...base, submenu: list.items, emptyLabel: list.emptyLabel });
    } else if (action.submenu) {
      const sub = toPopupItems(action.submenu, opts);
      if (sub.length) items.push({ ...base, submenu: sub });
    } else {
      const run = handlers[action.id];
      if (!run) continue;
      items.push({ ...base, onSelect: () => run(action) });
    }
  }
  return tidySeparators(items);
}

/**
 * Main's form: an Electron `Menu` template.
 *
 * @param {readonly object[]} actions
 * @param {object} opts
 * @param {(key: string) => string} opts.label - main's `m`.
 * @param {(channel: string, payload?: unknown) => void} opts.send - pushes
 *   `menu:<event>` to the app window.
 * @param {Record<string, object[]>} [opts.lists] - the runtime submenu of
 *   each `list` action, already in template form.
 */
export function toElectronTemplate(actions, opts) {
  const { label, send, lists = {} } = opts;
  return tidySeparators(
    actions.map((action) => {
      if (action === SEPARATOR) return { type: "separator" };
      const item = { label: label(action.labelKey) };
      if (action.gate) item.id = action.id;
      if (action.accelerator) item.accelerator = action.accelerator;
      if (action.list) item.submenu = lists[action.id] ?? [];
      else if (action.submenu) {
        item.submenu = toElectronTemplate(action.submenu, opts);
      } else {
        const channel = `menu:${actionEvent(action)}`;
        item.click = () =>
          action.payload === undefined
            ? send(channel)
            : send(channel, action.payload);
      }
      return item;
    }),
    (i) => i?.type === "separator",
  );
}
