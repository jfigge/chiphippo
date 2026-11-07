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

// project-tabs.js — the desktop tab strip: one tab per desktop in the open
// project, sitting between the header and the desk. Every desktop is the
// same — peers, not a build plus its benches — so every tab gets the same
// menu, and any of them can be renamed or deleted.
//
// Pure chrome. It renders a tab list it is handed and reports intents to its
// creator through constructor callbacks (the house rule for a parent-owned
// widget) — it never touches the document, the store, or the controller.
//
// THE STRIP IS ALWAYS THERE, because there is always a project: the app boots
// onto one, so the strip always has at least one desktop to show, and the
// "+" beside them is the route to another. A PRIMARY click on it does the
// obvious thing — adds a desktop, no questions — and its SECONDARY click drops
// the two ways a desktop ARRIVES (**New Desktop** · **Import Desktop…**).
//
// There is NO per-tab dirty marker. A desktop is not a file and cannot be
// saved on its own — the project is the document — so a dot no action could
// clear would be a lie. The one dirty marker is the window title's.
//
// Right-clicking a tab drops the DESKTOP MENU itself, aimed at that tab: the
// same items, order, wording and availability as the menu bar's Desktop menu,
// because both are drawn from the one table (model/menu-actions.js). The "+"
// menu is that table's arrivals. As everywhere else, an item that doesn't
// apply stays PRESENT but disabled, and there is no per-tab branching: the
// only desktop that can't be deleted is the LAST one, whichever it is.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { DESKTOP_ACTIONS, toPopupItems } from "../model/menu-actions.js";

const IS_MAC = globalThis.window?.chiphippo?.platform === "darwin";

export class ProjectTabs {
  #root;
  #onSelect;
  #onAdd;
  #onImport;
  #onProperties;
  #onDelete;
  #onDuplicate;
  #onExport;
  #onExportTo;
  #onShare;
  #tabs = [];
  #activeId = null;
  #locked = false; // editing frozen (the circuit is running)

  /**
   * @param {HTMLElement} container - the strip is APPENDED, so the shell
   *   controls where it lands by when it constructs this (between the header
   *   and the desk row, in app.js).
   * @param {object} callbacks
   * @param {(id: string) => void} callbacks.onSelect - a tab was clicked.
   * @param {() => void} callbacks.onAdd - New Desktop: the "+"'s own click,
   *   and the leading item of its secondary-click menu.
   * @param {() => void} callbacks.onImport - Import Desktop…, from that menu.
   * @param {(id: string) => void} callbacks.onProperties - Properties… on a
   *   tab (its Name/Description, through the app-wide shared dialog).
   * @param {(id: string) => void} callbacks.onDuplicate - Duplicate.
   * @param {(id: string) => void} callbacks.onExport - Export ▸ Chip Hippo
   *   Desktop… (the snapshot).
   * @param {(id: string, format: string) => void} callbacks.onExportTo -
   *   Export ▸ one of another tool's formats (Feature 390).
   * @param {((id: string) => void)|null} [callbacks.onShare] - Share to
   *   Gallery…; absent, the menu has no such row.
   * @param {(id: string) => void} callbacks.onDelete - Delete on a tab.
   */
  constructor(
    container,
    {
      onSelect,
      onAdd,
      onImport,
      onProperties,
      onDuplicate,
      onExport,
      onExportTo,
      onShare = null,
      onDelete,
    } = {},
  ) {
    this.#onSelect = onSelect;
    this.#onAdd = onAdd;
    this.#onImport = onImport;
    this.#onProperties = onProperties;
    this.#onDuplicate = onDuplicate;
    this.#onExport = onExport;
    this.#onExportTo = onExportTo;
    this.#onShare = onShare;
    this.#onDelete = onDelete;
    this.#root = el("div", {
      class: "project-tabs",
      role: "tablist",
      "aria-label": t("tabs.label"),
    });
    container.append(this.#root);
    // The "+" is the strip's whole reason for always being here, so it exists
    // from construction — before the workspace has handed over any tabs.
    this.#render();
  }

  /** The strip element (tests + layout). */
  get element() {
    return this.#root;
  }

  /**
   * Show the open project's desktops on the strip — `{ id, name,
   * description?, doc }` records, and which one is active.
   */
  setTabs(tabs, activeId) {
    this.#tabs = Array.isArray(tabs) ? tabs : [];
    this.#activeId = activeId ?? this.#tabs[0]?.id ?? null;
    this.#render();
  }

  /** Show that a desk switch is waiting (on the Stop's kept edits being
      written): what is clicked now waits its turn, so say so. */
  setBusy(busy) {
    this.#root.classList.toggle("project-tabs--busy", busy === true);
    this.#root.setAttribute("aria-busy", busy === true ? "true" : "false");
  }

  /** Freeze the destructive affordances while the circuit runs. */
  setEditingLocked(locked) {
    this.#locked = locked === true;
    this.#render();
  }

  #render() {
    this.#root.replaceChildren(
      ...this.#tabs.map((tab) => this.#tabButton(tab)),
      el("button", {
        class: "project-tab-add",
        type: "button",
        text: "+",
        title: t("tabs.addTitle"),
        "aria-label": t("tabs.add"),
        onClick: () => this.#onAdd?.(),
        onContextMenu: (e) => {
          e.preventDefault();
          this.#openAddMenu(e);
        },
      }),
    );
  }

  /**
   * The "+"'s SECONDARY-click menu: the Desktop menu's two ARRIVALS, with the
   * primary click's own action leading it. Both land you on the new desk — an
   * import can no more replace what is on screen than a new desktop can.
   */
  #openAddMenu(e) {
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: this.#menuItems(null, { arrivalsOnly: true }),
    });
  }

  #tabButton(tab) {
    const active = tab.id === this.#activeId;
    const classes = ["project-tab"];
    if (active) classes.push("project-tab--active");
    // The tooltip is a desktop's Description's only visible surface — the strip
    // shows the name alone, and the tab is too narrow for anything more.
    return el(
      "button",
      {
        class: classes.join(" "),
        type: "button",
        role: "tab",
        "aria-selected": String(active),
        title: tab.description ? `${tab.name}\n${tab.description}` : tab.name,
        dataset: { tabId: tab.id },
        onClick: () => {
          if (!active) this.#onSelect?.(tab.id);
        },
        onContextMenu: (e) => {
          e.preventDefault();
          this.#openMenu(tab, e);
        },
      },
      [el("span", { class: "project-tab-label", text: tab.name })],
    );
  }

  /**
   * Re-render in the new language (see app.js's `relabelChrome`). Every tab is
   * drawn from the project's own records, so a redraw is the whole job — the
   * two context menus are built when they open and need nothing.
   */
  relocalize() {
    this.#root.setAttribute("aria-label", t("tabs.label"));
    this.#render();
  }

  /** A tab's menu: the Desktop menu, aimed at this tab (see the file note). */
  #openMenu(tab, e) {
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: this.#menuItems(tab.id),
    });
  }

  /**
   * The Desktop menu's items as this strip offers them: each action of the one
   * table mapped onto this widget's callback, `id` the tab it acts on.
   * Availability is the table's rule over the strip's own state — the same
   * `{canDelete, canDuplicate}` the workspace pushes to the menu bar.
   */
  #menuItems(id, { arrivalsOnly = false } = {}) {
    const all = {
      "desktop-add": this.#onAdd && (() => this.#onAdd()),
      "desktop-import": this.#onImport && (() => this.#onImport()),
      "desktop-duplicate": this.#onDuplicate && (() => this.#onDuplicate(id)), // prettier-ignore
      "desktop-export": this.#onExport && (() => this.#onExport(id)),
      "desktop-export-kicad": this.#onExportTo && (() => this.#onExportTo(id, "kicad")), // prettier-ignore
      "desktop-export-digital": this.#onExportTo && (() => this.#onExportTo(id, "digital")), // prettier-ignore
      "desktop-share": this.#onShare && (() => this.#onShare(id)),
      "desktop-properties": this.#onProperties && (() => this.#onProperties(id)), // prettier-ignore
      "desktop-delete": this.#onDelete && (() => this.#onDelete(id)),
    };
    const handlers = {};
    for (const action of DESKTOP_ACTIONS) {
      if (!action.id || (arrivalsOnly && !action.arrival)) continue;
      if (all[action.id]) handlers[action.id] = all[action.id];
    }
    if (!arrivalsOnly) {
      for (const sub of DESKTOP_ACTIONS.flatMap((a) => a.submenu ?? [])) {
        if (sub.id && all[sub.id]) handlers[sub.id] = all[sub.id];
      }
    }
    return toPopupItems(DESKTOP_ACTIONS, {
      label: t,
      handlers,
      state: {
        canDelete: this.#tabs.length > 1 && !this.#locked,
        canDuplicate: this.#tabs.length > 0 && !this.#locked,
      },
      isMac: IS_MAC,
    });
  }
}
