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

// palette-panel.js — the left parts palette: the board selector pinned at the
// top (complete breadboards + loose pin-boards / power rails), then chips,
// discrete parts, and power bricks grouped by function, with a filter box
// matching id/title/blurb. Clicking an entry arms placement mode (reported via
// the constructor callback with the click event, so app.js can pop the LED
// color swatches — the ghost belongs to DeskController).

import { clear, el } from "../dom.js";
import { PALETTE_DEFS } from "../catalog/index.js";
import {
  BREADBOARD_KITS,
  KIT_KEYS,
  STRIP_KIT_KEYS,
} from "../model/board-types.js";
import { canRotate } from "../model/breadboard.js";
import { hasBehavior } from "../sim/chip-eval.js";

/** Every chip group nests one level under this top-level folder. It collapses
    like a group, and no group shares its name. */
const CHIPS_FOLDER = "Chips";

/**
 * Every collapsible section name — the chips folder plus every group in the
 * catalog. The palette opens with ALL of them shut: the full list is long
 * enough that a wall of parts buries the structure, and the filter box is the
 * fast path to a specific one anyway.
 */
function allSections() {
  return new Set([CHIPS_FOLDER, ...PALETTE_DEFS.map((def) => def.group)]);
}

export class PalettePanel {
  #el;
  #list;
  #onPickChip;
  #onPickBoard;
  #filter = "";
  // Every section starts shut, every launch. What the user opens lasts for
  // the session only — deliberately NOT persisted, so the panel always opens
  // in the same known state.
  #collapsed = allSections();

  /**
   * @param {HTMLElement} container - mounted as the desk row's left panel.
   * @param {object} callbacks
   * @param {(ref: string, e: MouseEvent) => void} callbacks.onPickChip
   * @param {(kit: string) => void} callbacks.onPickBoard - a board kit key
   *   (assembled breadboard or loose strip) was picked; app.js arms placement.
   */
  constructor(container, { onPickChip, onPickBoard } = {}) {
    this.#onPickChip = onPickChip;
    this.#onPickBoard = onPickBoard;

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
    // While a filter is active, force everything open so matches stay visible;
    // the remembered collapse state only governs the unfiltered list.
    const filtering = this.#filter.trim() !== "";
    // The board selector is pinned at the very top of the palette; the filter
    // box targets the parts list below, so hide the boards while filtering.
    if (!filtering) this.#appendBoards();

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

  /**
   * The board selector, pinned at the top of the palette: the assembled
   * breadboards (Full / Half / Tiny) then the loose strips (bare pin-boards +
   * power rails). Each entry arms board placement via onPickBoard — the same
   * kit keys the old header split-button used.
   */
  #appendBoards() {
    const item = (key) => {
      const kit = BREADBOARD_KITS[key];
      // A kit made purely of rails can stand on end as a signal bus (R spins
      // the ghost) — flag it in the tooltip, or nobody finds R.
      const rotates = kit.strips.every((s) => canRotate(s.type));
      const hint = rotates ? " (R to rotate)" : "";
      return el(
        "button",
        {
          class: "palette-board-item",
          type: "button",
          title: `${kit.label} — ${kit.tiePoints} tie points${hint}`,
          dataset: { kit: key },
          onClick: () => this.#onPickBoard?.(key),
        },
        [
          el("span", { class: "palette-item-id", text: String(kit.tiePoints) }),
          el("span", { class: "palette-item-title", text: kit.label }),
        ],
      );
    };
    this.#list.append(
      el("div", { class: "palette-boards-header", text: "Boards" }),
      el("div", { class: "palette-boards-items" }, [
        ...KIT_KEYS.map(item),
        ...STRIP_KIT_KEYS.map(item),
      ]),
    );
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
  }
}
