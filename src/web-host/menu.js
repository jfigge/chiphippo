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

// menu.js — Electron's Menu and MenuItem for the web build: the application
// menu main builds (buildAppMenu), its accelerators answered in every window
// of ours, its HELP menu opened from the header's book button, and a context
// menu (the pin-assignments window's float toggle) drawn where the click was.
//
// There is no menu BAR (Jason, 2026-10-25): the page's own toolbar, tab strip
// and gear already carry File, Desktop and Settings, so of the template only
// the accelerators and the Help menu are used. Both are main's own, labels and
// all, so they speak the visitor's language and offer exactly what main offers
// — less what a page cannot do: the window ROLES (minimize, zoom, close, hide,
// services, quit), the clipboard roles (the browser's own keys already work),
// and Toggle Developer Tools (the browser has its own). An item a web page
// cannot carry out is left out rather than shown dead.

import { ctx } from "./context.js";
import {
  acceleratorLabel,
  matchesAccelerator,
  parseAccelerator,
} from "./accelerators.js";
import { BrowserWindow, getAppWindow } from "./windows.js";
import { process } from "./node/globals.js";
import { t } from "./strings.js";

const isMac = () => process.platform === "darwin";

// Roles a page can carry out, and how.
const ROLE_ACTIONS = {
  selectAll: (win) => win?.webContents?.selectAll(),
  undo: (win) => win?.webContents?.domWindow?.document?.execCommand?.("undo"),
  redo: (win) => win?.webContents?.domWindow?.document?.execCommand?.("redo"),
};

// The developer-tools item's chord: the browser's own, left to the browser.
const BROWSER_OWNED = new Set(["alt+cmdorctrl+i", "cmdorctrl+alt+i"]);

let applicationMenu = null;

export class MenuItem {
  #enabled;
  #checked;
  #visible;

  constructor(opts = {}) {
    this.id = opts.id ?? null;
    this.label = opts.label ?? "";
    this.type = opts.type ?? (opts.submenu ? "submenu" : "normal");
    this.role = opts.role ?? null;
    this.accelerator = opts.accelerator ?? null;
    this.toolTip = opts.toolTip ?? "";
    this.click = typeof opts.click === "function" ? opts.click : null;
    this.#enabled = opts.enabled !== false;
    this.#checked = opts.checked === true;
    this.#visible = opts.visible !== false;
    this.submenu =
      opts.submenu instanceof Menu
        ? opts.submenu
        : Array.isArray(opts.submenu)
          ? Menu.buildFromTemplate(opts.submenu)
          : null;
  }

  get enabled() {
    return this.#enabled;
  }

  set enabled(v) {
    this.#enabled = Boolean(v);
  }

  get checked() {
    return this.#checked;
  }

  set checked(v) {
    this.#checked = Boolean(v);
  }

  get visible() {
    return this.#visible;
  }

  set visible(v) {
    this.#visible = Boolean(v);
  }

  /** Whether the web build can carry this item out at all. */
  get supported() {
    if (this.type === "separator") return true;
    const accel = String(this.accelerator ?? "").toLowerCase();
    if (BROWSER_OWNED.has(accel)) return false;
    if (this.role && this.type !== "submenu")
      return Boolean(ROLE_ACTIONS[this.role]);
    if (this.type === "submenu")
      return Boolean(this.submenu?.shownItems().length);
    return true;
  }

  /** Run the item, as Electron would on a click or its accelerator. */
  activate(win, event = {}) {
    if (!this.#enabled) return;
    if (this.type === "checkbox") this.#checked = !this.#checked;
    if (this.click) {
      try {
        this.click(this, win ?? getAppWindow(), event);
      } catch (err) {
        console.error("[web] menu item failed:", err);
      }
      return;
    }
    if (this.role) ROLE_ACTIONS[this.role]?.(win ?? getAppWindow());
  }
}

export class Menu {
  constructor() {
    this.items = [];
  }

  static buildFromTemplate(template) {
    const menu = new Menu();
    for (const entry of template ?? []) {
      menu.append(entry instanceof MenuItem ? entry : new MenuItem(entry));
    }
    return menu;
  }

  static setApplicationMenu(menu) {
    applicationMenu = menu;
  }

  static getApplicationMenu() {
    return applicationMenu;
  }

  append(item) {
    this.items.push(item);
  }

  insert(pos, item) {
    this.items.splice(pos, 0, item);
  }

  getMenuItemById(id) {
    for (const item of this.items) {
      if (item.id === id) return item;
      const inner = item.submenu?.getMenuItemById(id);
      if (inner) return inner;
    }
    return null;
  }

  /** The items the web build shows: supported and visible, with no rule at
      either end or two in a row. */
  shownItems() {
    const out = [];
    for (const item of this.items) {
      if (!item.visible || !item.supported) continue;
      if (
        item.type === "separator" &&
        (!out.length || out[out.length - 1].type === "separator")
      ) {
        continue;
      }
      out.push(item);
    }
    while (out.length && out[out.length - 1].type === "separator") out.pop();
    return out;
  }

  /** A context menu, in `window`'s page, where its last right-click was. */
  popup({ window: win, x, y, callback } = {}) {
    const target = win ?? BrowserWindow.getFocusedWindow();
    const dom = target?.webContents?.domWindow ?? ctx.page;
    const at =
      Number.isFinite(x) && Number.isFinite(y)
        ? { x, y }
        : (target?.webContents?.lastContextPoint ?? { x: 40, y: 40 });
    openDropdown(dom.document, this, at, target, { onClose: callback });
  }

  closePopup() {
    closeDropdowns();
  }
}

// ── Drawing a menu ───────────────────────────────────────────────────────────

const open = new Set(); // every dropdown on screen

function closeDropdowns() {
  for (const close of [...open]) close();
}

function el(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Draw `menu` as a card at `at` (client px) in `doc`. Items run against
 * `win`. A submenu opens as a sibling card beside its row.
 */
function openDropdown(
  doc,
  menu,
  at,
  win,
  { onClose, level = 0, parentClose, align = "left", anchor = null } = {},
) {
  const card = el(doc, "div", "popup-menu webhost-menu");
  card.setAttribute("role", "menu");
  let child = null;
  const close = () => {
    child?.();
    child = null;
    card.remove();
    open.delete(close);
    if (level === 0) {
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("keydown", onKey, true);
      onClose?.();
    }
  };
  const closeAll = parentClose ?? close;
  const outside = (e) => {
    // A press on the button that opened the card is that button's to answer
    // (it toggles the card shut), not an outside click.
    if (anchor?.contains(e.target)) return;
    if (!e.target.closest?.(".webhost-menu")) closeAll();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeAll();
    }
  };
  const items = menu.shownItems();
  // The tick column only where a card has something to tick.
  const ticks = items.some((i) => i.type === "checkbox");
  for (const item of items) {
    if (item.type === "separator") {
      card.append(el(doc, "div", "popup-menu-separator"));
      continue;
    }
    const row = el(doc, "button", "popup-menu-item webhost-menu-item");
    row.type = "button";
    row.setAttribute(
      "role",
      item.type === "checkbox" ? "menuitemcheckbox" : "menuitem",
    );
    if (item.type === "checkbox")
      row.setAttribute("aria-checked", String(item.checked));
    row.disabled = !item.enabled;
    if (item.toolTip) row.title = item.toolTip;
    if (ticks) {
      row.append(
        el(
          doc,
          "span",
          "webhost-menu-check",
          item.type === "checkbox" && item.checked ? "✓" : "",
        ),
      );
    }
    row.append(el(doc, "span", "popup-menu-label", item.label));
    if (item.submenu) {
      row.append(el(doc, "span", "popup-menu-chevron", "›"));
      const openSub = () => {
        child?.();
        const box = row.getBoundingClientRect();
        child = openDropdown(
          doc,
          item.submenu,
          { x: box.right, y: box.top },
          win,
          {
            level: level + 1,
            parentClose: closeAll,
          },
        );
      };
      row.addEventListener("pointerenter", openSub);
      row.addEventListener("click", openSub);
    } else {
      const accel = acceleratorLabel(item.accelerator, isMac());
      if (accel) row.append(el(doc, "span", "popup-menu-accel", accel));
      row.addEventListener("pointerenter", () => {
        child?.();
        child = null;
      });
      row.addEventListener("click", () => {
        closeAll();
        item.activate(win);
      });
    }
    card.append(row);
  }
  doc.body.append(card);
  // Keep the card on screen.
  const view = doc.defaultView;
  const box = card.getBoundingClientRect();
  const left = align === "right" ? at.x - box.width : at.x;
  const x = Math.max(
    0,
    Math.min(left, (view?.innerWidth ?? 0) - box.width - 4),
  );
  const y = Math.max(
    0,
    Math.min(at.y, (view?.innerHeight ?? 0) - box.height - 4),
  );
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  open.add(close);
  if (level === 0) {
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("keydown", onKey, true);
  }
  return close;
}

// ── The Help menu ───────────────────────────────────────────────────────────

let closeHelp = null;

/**
 * Main's Help menu as the web build shows it. On a Mac main keeps About in the
 * app-name menu, which has no place here, so it joins Help (found by its own
 * catalog label — the template carries no id for it).
 */
function helpMenu() {
  const tops = applicationMenu?.items ?? [];
  const help = tops.find((i) => i.role === "help" && i.submenu)?.submenu;
  if (!help) return null;
  const items = [...help.items];
  const aboutLabel = t("menu.app.about", "About Chip Hippo");
  if (!items.some((i) => i.label === aboutLabel)) {
    const about = tops
      .flatMap((i) => i.submenu?.items ?? [])
      .find((i) => i.label === aboutLabel);
    if (about) items.push(new MenuItem({ type: "separator" }), about);
  }
  const menu = new Menu();
  menu.items = items;
  return menu;
}

/**
 * Open (or, open already, shut) the Help menu under `anchor` — the header's
 * book button, which asks with `chiphippo:web-help-menu` (app.js). The card
 * hangs from the button's right edge, as the button sits at the header's.
 * @param {HTMLElement} anchor
 */
export function toggleHelpMenu(anchor) {
  if (closeHelp) {
    closeHelp();
    return;
  }
  const menu = helpMenu();
  if (!menu || !anchor?.ownerDocument) return;
  closeDropdowns();
  const box = anchor.getBoundingClientRect();
  anchor.setAttribute("aria-expanded", "true");
  closeHelp = openDropdown(
    anchor.ownerDocument,
    menu,
    { x: box.right, y: box.bottom + 4 },
    getAppWindow(),
    {
      align: "right",
      anchor,
      onClose: () => {
        closeHelp = null;
        anchor.setAttribute("aria-expanded", "false");
      },
    },
  );
}

// ── Accelerators ─────────────────────────────────────────────────────────────

/** Every enabled item with an accelerator, depth first. */
function* acceleratedItems(menu) {
  for (const item of menu?.shownItems() ?? []) {
    if (item.submenu) yield* acceleratedItems(item.submenu);
    else if (item.accelerator && item.enabled) yield item;
  }
}

/**
 * A keydown in one of our windows that the page itself let go by (it was not
 * `defaultPrevented`): if it is an enabled menu item's chord, the item runs
 * and the key is consumed, as a native menu consumes it.
 * @returns {boolean} whether it was a menu chord
 */
export function handleAccelerator(win, e) {
  if (e.defaultPrevented || e.repeat) return false;
  for (const item of acceleratedItems(applicationMenu)) {
    if (matchesAccelerator(parseAccelerator(item.accelerator, isMac()), e)) {
      closeDropdowns();
      item.activate(win);
      return true;
    }
  }
  return false;
}
