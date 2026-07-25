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

// project-tabs.js — the desktop tab strip (Feature 240): one tab per desktop
// in the open project, sitting between the header and the desk. `Main` holds
// the build; each `Sub-Desktop #N` is a bench beside it.
//
// Pure chrome. It renders a tab list it is handed and reports intents to its
// creator through constructor callbacks (the house rule for a parent-owned
// widget) — it never touches the document, the store, or the controller. With
// no project open it isn't in the DOM at all, so the app looks exactly as it
// did before a project existed.
//
// Right-clicking a tab opens the BOARD menu's shape — Properties…, a rule,
// Delete — rather than the part menu's three items. A part's leading Pin
// Assignment is meaningless here (a desktop has no pins at all, not even a
// disabled-today set), so it is dropped along with its separator, exactly as
// a board's menu drops it. Main is the project, so its Delete is disabled.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";

export class ProjectTabs {
  #root;
  #onSelect;
  #onAdd;
  #onProperties;
  #onDelete;
  #tabs = [];
  #activeId = null;
  #dirtyIds = new Set();
  #locked = false; // editing frozen (the circuit is running)

  /**
   * @param {HTMLElement} container - the strip is APPENDED, so the shell
   *   controls where it lands by when it constructs this (between the header
   *   and the desk row, in app.js).
   * @param {object} callbacks
   * @param {(id: string) => void} callbacks.onSelect - a tab was clicked.
   * @param {() => void} callbacks.onAdd - the "+" affordance.
   * @param {(id: string) => void} callbacks.onProperties - Properties… on a
   *   tab (its Name/Description, through the app-wide shared dialog).
   * @param {(id: string) => void} callbacks.onDelete - Delete on a tab.
   */
  constructor(container, { onSelect, onAdd, onProperties, onDelete } = {}) {
    this.#onSelect = onSelect;
    this.#onAdd = onAdd;
    this.#onProperties = onProperties;
    this.#onDelete = onDelete;
    this.#root = el("div", {
      class: "project-tabs",
      role: "tablist",
      "aria-label": "Desktops",
      hidden: true,
    });
    container.append(this.#root);
  }

  /** The strip element (tests + layout). */
  get element() {
    return this.#root;
  }

  /** Whether the strip is currently showing (a project is open). */
  get visible() {
    return !this.#root.hidden;
  }

  /**
   * Show the tabs of the open project — or hide the strip entirely when there
   * is none (`tabs` empty). `tabs` are `{ id, name, description?, kind }`.
   */
  setTabs(tabs, activeId) {
    this.#tabs = Array.isArray(tabs) ? tabs : [];
    this.#activeId = activeId ?? this.#tabs[0]?.id ?? null;
    this.#root.hidden = this.#tabs.length === 0;
    this.#render();
  }

  /** Mark which desktops have unsaved changes (the • on the tab). */
  setDirty(ids) {
    this.#dirtyIds = new Set(ids ?? []);
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
        title: "Add a sub-desktop",
        "aria-label": "Add a sub-desktop",
        onClick: () => this.#onAdd?.(),
      }),
    );
  }

  #tabButton(tab) {
    const active = tab.id === this.#activeId;
    const dirty = this.#dirtyIds.has(tab.id);
    const classes = ["project-tab"];
    if (active) classes.push("project-tab--active");
    if (dirty) classes.push("project-tab--dirty");
    // The tooltip is a desktop's Description's only visible surface — the strip
    // shows the name alone, and the tab is too narrow for anything more.
    const head = dirty ? `${tab.name} — unsaved changes` : tab.name;
    return el(
      "button",
      {
        class: classes.join(" "),
        type: "button",
        role: "tab",
        "aria-selected": String(active),
        title: tab.description ? `${head}\n${tab.description}` : head,
        dataset: { tabId: tab.id },
        onClick: () => {
          if (!active) this.#onSelect?.(tab.id);
        },
        onContextMenu: (e) => {
          e.preventDefault();
          this.#openMenu(tab, e);
        },
      },
      [
        el("span", { class: "project-tab-label", text: tab.name }),
        // A drawn dot, not a "•" glyph — the marker is a shape, so CSS owns
        // its size and color (the title carries the meaning for a reader).
        dirty &&
          el("span", { class: "project-tab-marker", "aria-hidden": "true" }),
      ],
    );
  }

  /** The board menu's two items, in their tab form (see the file note). */
  #openMenu(tab, e) {
    PopupManager.menu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Properties…",
          onSelect: () => this.#onProperties?.(tab.id),
        },
        { separator: true },
        {
          label: "Delete Sub-Desktop",
          danger: true,
          disabled: tab.kind === "main" || this.#locked,
          onSelect: () => this.#onDelete?.(tab.id),
        },
      ],
    });
  }
}
