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

// annotate-toolbar.js — the header's Annotate split-button (Feature 120): the
// main button arms placement of the last-used kind; the arrow opens a menu of
// the annotation kinds (Label / Note). Reports through the constructor
// callback (house rule) — arming/ghosting is DeskController's, like
// BoardToolbar.

import { el } from "../dom.js";
import { PopupManager } from "../popup-manager.js";

const KINDS = [
  { kind: "label", label: "Add label", hint: "a one-line caption" },
  { kind: "note", label: "Add note", hint: "a multi-line note box" },
];

export class AnnotateToolbar {
  #lastKind = "label";
  #mainBtn;
  #onAdd;

  /**
   * @param {HTMLElement} container - the header toolbar slot.
   * @param {object} callbacks
   * @param {(kind: "label"|"note") => void} callbacks.onAdd
   */
  constructor(container, { onAdd }) {
    this.#onAdd = onAdd;

    this.#mainBtn = el("button", {
      class: "toolbar-btn",
      type: "button",
      text: this.#mainLabel(),
      title: "Drop a label or note on the desk (Esc cancels placement)",
      onClick: () => this.#onAdd?.(this.#lastKind),
    });
    const arrow = el("button", {
      class: "toolbar-btn toolbar-btn--arrow",
      type: "button",
      text: "▾",
      "aria-label": "Choose an annotation kind",
      title: "Choose an annotation kind",
      onClick: () => {
        const rect = arrow.getBoundingClientRect();
        PopupManager.menu({
          x: rect.left,
          y: rect.bottom + 4,
          items: KINDS.map(({ kind, label, hint }) => ({
            label: `${label} — ${hint}`,
            onSelect: () => {
              this.#lastKind = kind;
              this.#mainBtn.textContent = this.#mainLabel();
              this.#onAdd?.(kind);
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
    return KINDS.find((k) => k.kind === this.#lastKind).label;
  }
}
