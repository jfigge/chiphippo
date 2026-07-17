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

// board-toolbar.js — the header's Add-board split-button: the main button
// arms placement with the last-used size; the arrow opens a size menu
// (Full / Half / Tiny) via the popup manager. Reports through the
// constructor callback (house rule) — arming/ghosting is DeskController's.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";
import { BOARD_TYPES, BOARD_TYPE_KEYS } from "../model/board-types.js";

export class BoardToolbar {
  #lastType = "full";
  #mainBtn;
  #onAddBoard;

  /**
   * @param {HTMLElement} container - the header toolbar slot.
   * @param {object} callbacks
   * @param {(type: string) => void} callbacks.onAddBoard
   */
  constructor(container, { onAddBoard }) {
    this.#onAddBoard = onAddBoard;

    this.#mainBtn = el("button", {
      class: "toolbar-btn",
      type: "button",
      text: this.#mainLabel(),
      title: "Add a breadboard to the desk (Esc cancels placement)",
      onClick: () => this.#onAddBoard?.(this.#lastType),
    });
    const arrow = el("button", {
      class: "toolbar-btn toolbar-btn--arrow",
      type: "button",
      text: "▾",
      "aria-label": "Choose a board size",
      title: "Choose a board size",
      onClick: () => {
        const rect = arrow.getBoundingClientRect();
        PopupManager.menu({
          x: rect.left,
          y: rect.bottom + 4,
          items: BOARD_TYPE_KEYS.map((key) => ({
            label: `${BOARD_TYPES[key].label} (${BOARD_TYPES[key].tiePoints} tie points)`,
            onSelect: () => {
              this.#lastType = key;
              this.#mainBtn.textContent = this.#mainLabel();
              this.#onAddBoard?.(key);
            },
          })),
        });
      },
    });

    container.append(
      el("div", { class: "toolbar-split" }, [this.#mainBtn, arrow]),
    );
  }

  #mainLabel() {
    return `Add ${BOARD_TYPES[this.#lastType].label}`;
  }
}
