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

// palette-panel.js — the left parts palette: chips, discrete parts, and
// power bricks grouped by function, with a filter box matching
// id/title/blurb. Clicking an entry arms placement mode (reported via the
// constructor callback with the click event, so app.js can pop the LED
// color swatches — the ghost belongs to DeskController).

import { clear, el } from "../dom.js";
import { PALETTE_DEFS } from "../catalog/index.js";

export class PalettePanel {
  #el;
  #list;
  #onPickChip;
  #filter = "";

  /**
   * @param {HTMLElement} container - mounted as the desk row's left panel.
   * @param {object} callbacks
   * @param {(ref: string) => void} callbacks.onPickChip
   */
  constructor(container, { onPickChip } = {}) {
    this.#onPickChip = onPickChip;

    const filterInput = el("input", {
      class: "palette-filter",
      type: "search",
      placeholder: "Filter chips…",
      "aria-label": "Filter chips",
      onInput: (e) => {
        this.#filter = e.target.value;
        this.#render();
      },
    });

    this.#list = el("div", { class: "palette-list" });
    this.#el = el(
      "aside",
      { class: "palette-panel", "aria-label": "Parts palette", hidden: true },
      [el("div", { class: "palette-header" }, [filterInput]), this.#list],
    );
    container.append(this.#el);
    this.#render();
  }

  get element() {
    return this.#el;
  }

  get visible() {
    return !this.#el.hidden;
  }

  setVisible(on) {
    this.#el.hidden = !on;
  }

  #matches(def) {
    const q = this.#filter.trim().toLowerCase();
    if (!q) return true;
    return [def.id, def.title, def.blurb].some((s) =>
      s.toLowerCase().includes(q),
    );
  }

  #render() {
    clear(this.#list);
    const defs = PALETTE_DEFS.filter((def) => this.#matches(def));
    if (defs.length === 0) {
      this.#list.append(
        el("p", { class: "palette-empty", text: "No matching parts." }),
      );
      return;
    }
    // Group by function, preserving catalog order of first appearance.
    const groups = new Map();
    for (const def of defs) {
      if (!groups.has(def.group)) groups.set(def.group, []);
      groups.get(def.group).push(def);
    }
    for (const [group, members] of groups) {
      this.#list.append(
        el("h3", { class: "palette-group", text: group }),
        ...members.map((def) =>
          el(
            "button",
            {
              class: "palette-item",
              type: "button",
              title: def.blurb,
              dataset: { ref: def.id },
              onClick: (e) => this.#onPickChip?.(def.id, e),
            },
            [
              el("span", { class: "palette-item-id", text: def.id }),
              el("span", { class: "palette-item-title", text: def.title }),
            ],
          ),
        ),
      );
    }
  }
}
