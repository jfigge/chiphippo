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
// the two-item menu (**New Desktop** · **Import Desktop…**), the same
// primary-does-the-common-thing / right-click-offers-the-rest split a tab
// itself has. Those two items live here rather than in a tab's own menu
// because they are how a desktop ARRIVES: neither belongs to any tab.
//
// There is NO per-tab dirty marker. A desktop is not a file and cannot be
// saved on its own — the project is the document — so a dot no action could
// clear would be a lie. The one dirty marker is the window title's.
//
// Right-clicking a tab opens the BOARD menu's shape — Properties…, a rule,
// Delete — rather than the part menu's three items. A part's leading Pin
// Assignment is meaningless here (a desktop has no pins at all, not even a
// disabled-today set), so it is dropped along with its separator, exactly as
// a board's menu drops it. Duplicate and Export join it as the two other
// things one can do to a whole desktop; as everywhere else, an item that
// doesn't apply stays PRESENT but disabled — and there is no per-tab
// branching at all: the only desktop that can't be deleted is the LAST one,
// whichever it is.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";

export class ProjectTabs {
  #root;
  #onSelect;
  #onAdd;
  #onImport;
  #onProperties;
  #onDelete;
  #onDuplicate;
  #onExport;
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
   * @param {(id: string) => void} callbacks.onExport - Export Desktop….
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
      onDelete,
    } = {},
  ) {
    this.#onSelect = onSelect;
    this.#onAdd = onAdd;
    this.#onImport = onImport;
    this.#onProperties = onProperties;
    this.#onDuplicate = onDuplicate;
    this.#onExport = onExport;
    this.#onDelete = onDelete;
    this.#root = el("div", {
      class: "project-tabs",
      role: "tablist",
      "aria-label": "Desktops",
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
        title: "New desktop (right-click to import one)",
        "aria-label": "New desktop",
        onClick: () => this.#onAdd?.(),
        onContextMenu: (e) => {
          e.preventDefault();
          this.#openAddMenu(e);
        },
      }),
    );
  }

  /**
   * The "+"'s SECONDARY-click menu: the two ways another desktop arrives, with
   * the primary click's own action leading it, exactly as a right-click
   * anywhere else in the app offers what a plain click already did plus the
   * rest. Both are ADDITIONS that land you on the new desk — an import can no
   * more replace what is on screen than a new desktop can.
   */
  #openAddMenu(e) {
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "New Desktop", onSelect: () => this.#onAdd?.() },
        { label: "Import Desktop…", onSelect: () => this.#onImport?.() },
      ],
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

  /** The board menu's shape, in its tab form (see the file note). */
  #openMenu(tab, e) {
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          // The universal Name/Description pair, nothing else: a desktop is
          // not a file, so it has no Location to show.
          label: "Properties…",
          onSelect: () => this.#onProperties?.(tab.id),
        },
        {
          label: "Duplicate Desktop",
          disabled: this.#locked,
          onSelect: () => this.#onDuplicate?.(tab.id),
        },
        {
          // A snapshot, with no link back — read-only, so it stays available
          // while the circuit runs.
          label: "Export Desktop…",
          onSelect: () => this.#onExport?.(tab.id),
        },
        { separator: true },
        {
          label: "Delete Desktop",
          danger: true,
          // Every desktop is deletable; a project just can't run out of them.
          disabled: this.#tabs.length <= 1 || this.#locked,
          onSelect: () => this.#onDelete?.(tab.id),
        },
      ],
    });
  }
}
