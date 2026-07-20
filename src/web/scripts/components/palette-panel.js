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
import { hasBehavior } from "../sim/chip-eval.js";

/** Every chip group nests one level under this top-level folder. Its collapse
    state is remembered alongside the group names (no group shares this name). */
const CHIPS_FOLDER = "Chips";

export class PalettePanel {
  #el;
  #list;
  #onPickChip;
  #onCollapseChange;
  #filter = "";
  #collapsed;

  /**
   * @param {HTMLElement} container - mounted as the desk row's left panel.
   * @param {object} callbacks
   * @param {(ref: string) => void} callbacks.onPickChip
   * @param {(groups: string[]) => void} [callbacks.onCollapseChange] - fired
   *   with the current collapsed-group names whenever the user toggles one, so
   *   the host can persist them.
   * @param {string[]} [callbacks.collapsedGroups] - group names to start
   *   collapsed (restored from settings).
   */
  constructor(
    container,
    { onPickChip, onCollapseChange, collapsedGroups } = {},
  ) {
    this.#onPickChip = onPickChip;
    this.#onCollapseChange = onCollapseChange;
    this.#collapsed = new Set(collapsedGroups ?? []);

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
    // While a filter is active, force everything open so matches stay visible;
    // the remembered collapse state only governs the unfiltered list.
    const filtering = this.#filter.trim() !== "";

    // Chip groups nest under one top-level "Chips" folder; discrete/power
    // groups stay at the top level. A group is a chip group when its members
    // are chips (the catalog stamps `kind: "chip"`).
    const chipGroups = [];
    const topGroups = [];
    for (const entry of groups) {
      (entry[1][0]?.kind === "chip" ? chipGroups : topGroups).push(entry);
    }

    // Chips lead the catalog, so the folder renders first, then the rest.
    if (chipGroups.length > 0) {
      const collapsed = !filtering && this.#collapsed.has(CHIPS_FOLDER);
      this.#list.append(
        this.#sectionHeader("palette-folder", CHIPS_FOLDER, collapsed),
      );
      const body = el("div", {
        class: "palette-folder-groups",
        hidden: collapsed,
      });
      for (const [group, members] of chipGroups) {
        this.#appendGroup(body, group, members, filtering);
      }
      this.#list.append(body);
    }
    for (const [group, members] of topGroups) {
      this.#appendGroup(this.#list, group, members, filtering);
    }
  }

  /** A collapsible section header (folder or group), keyed by `name`. The caret
      glyph is a CSS pseudo-element, so textContent stays exactly `name`. */
  #sectionHeader(baseClass, name, collapsed) {
    return el(
      "button",
      {
        class: collapsed ? `${baseClass} ${baseClass}--collapsed` : baseClass,
        type: "button",
        "aria-expanded": collapsed ? "false" : "true",
        onClick: () => this.#toggleGroup(name),
      },
      [
        el("span", { class: "palette-group-caret", "aria-hidden": true }),
        el("span", { class: "palette-group-label", text: name }),
      ],
    );
  }

  /** Append one group's header + item list to `container`. */
  #appendGroup(container, group, members, filtering) {
    const collapsed = !filtering && this.#collapsed.has(group);
    container.append(
      this.#sectionHeader("palette-group", group, collapsed),
      el(
        "div",
        { class: "palette-group-items", hidden: collapsed },
        members.map((def) =>
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
              // "sim-ready" badge for chips whose behavior is defined —
              // combinational (Feature 80) or sequential (Feature 100).
              hasBehavior(def) &&
                el("span", {
                  class: "palette-item-badge",
                  text: "sim",
                  title: "Behavior defined — ready for the simulator",
                }),
            ],
          ),
        ),
      ),
    );
  }

  #toggleGroup(group) {
    if (this.#collapsed.has(group)) this.#collapsed.delete(group);
    else this.#collapsed.add(group);
    this.#render();
    this.#onCollapseChange?.([...this.#collapsed]);
  }
}
