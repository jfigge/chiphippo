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
// menu main builds (buildAppMenu) drawn as a menu bar along the top of the
// tab, its accelerators answered in every window of ours, and a context menu
// (the pin-assignments window's float toggle) drawn where the click was.
//
// The menu is main's own template, labels and all, so it speaks the visitor's
// language and offers exactly what main offers — less what a page cannot do:
// the window ROLES (minimize, zoom, close, hide, services, quit), the
// clipboard roles (the browser's own keys already work), and Toggle Developer
// Tools (the browser has its own). An item a web page cannot carry out is
// left out rather than shown dead, and a menu left empty goes with it.

import { EventEmitter } from "./events.js";
import { ctx } from "./context.js";
import {
  acceleratorLabel,
  matchesAccelerator,
  parseAccelerator,
} from "./accelerators.js";
import { BrowserWindow, getAppWindow } from "./windows.js";
import { process } from "./node/globals.js";

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
const changes = new EventEmitter();

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
    changes.emit("change");
  }

  get checked() {
    return this.#checked;
  }

  set checked(v) {
    this.#checked = Boolean(v);
    changes.emit("change");
  }

  get visible() {
    return this.#visible;
  }

  set visible(v) {
    this.#visible = Boolean(v);
    changes.emit("change");
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
    changes.emit("change");
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
  { onClose, level = 0, parentClose } = {},
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
    if (!e.target.closest?.(".webhost-menu, .webhost-menubar-item")) closeAll();
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
  const x = Math.max(
    0,
    Math.min(at.x, (view?.innerWidth ?? 0) - box.width - 4),
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

// ── The menu bar ─────────────────────────────────────────────────────────────

let bar = null;
let redrawQueued = false;

function drawMenuBar() {
  redrawQueued = false;
  const doc = ctx.page?.document;
  if (!doc?.body) return;
  const tops =
    applicationMenu?.shownItems().filter((i) => i.type === "submenu") ?? [];
  if (!bar) {
    bar = el(doc, "nav", "webhost-menubar");
    bar.setAttribute("role", "menubar");
    doc.body.prepend(bar);
    doc.body.classList.add("webhost-has-menubar");
  }
  let active = null; // the top-level item whose card is open
  bar.replaceChildren();
  for (const top of tops) {
    const btn = el(doc, "button", "webhost-menubar-item", top.label);
    btn.type = "button";
    btn.setAttribute("role", "menuitem");
    btn.setAttribute("aria-haspopup", "menu");
    const show = () => {
      closeDropdowns();
      const box = btn.getBoundingClientRect();
      btn.classList.add("webhost-menubar-item--open");
      active = btn;
      openDropdown(
        doc,
        top.submenu,
        { x: box.left, y: box.bottom },
        getAppWindow(),
        {
          onClose: () => {
            btn.classList.remove("webhost-menubar-item--open");
            if (active === btn) active = null;
          },
        },
      );
    };
    btn.addEventListener("click", () => {
      if (active === btn) closeDropdowns();
      else show();
    });
    // Moving along the bar with a card open opens the next one, as a
    // native menu bar does.
    btn.addEventListener("pointerenter", () => {
      if (active && active !== btn) show();
    });
    bar.append(btn);
  }
}

changes.on("change", () => {
  if (redrawQueued) return;
  redrawQueued = true;
  queueMicrotask(drawMenuBar);
});

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
