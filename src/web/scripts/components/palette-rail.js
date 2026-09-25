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

// palette-rail.js — what the parts tray shuts down TO: a narrow strip on the
// desk's left edge holding the tray's reopen chevron and one icon per
// top-level section (Boards · Chips · Components · Memory · Annotations ·
// Signals), in the order the tray lists them. A shut tray is still one click
// from any shelf in it.
//
// Each icon sits level with its section's header as a shut tray lists it (the
// tray opens with every section shut), so closing the tray leaves each icon
// where its label was. That is layout, so it lives in app.css; this module's
// part is only to mark the one row that stands for a catalog GROUP header
// rather than a folder's, since that header's text is a size smaller.
//
// A thin view: it owns no tray state. An icon reports its section's IDENTITY
// through `onOpen`, and PalettePanel decides what opening there means (which
// sections shut, whether the filter goes). The chevron is the panel's own
// button, handed in so the one control keeps one owner for its labels.
//
// The glyphs are palette-icons.js's, shared with the open tray's section
// headers, and sized off the base text size (`--palette-icon` in app.css), so
// they follow Settings ▸ Appearance ▸ Editor font size (and ⌘= / ⌘−) with no
// code of their own.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { SECTION_ICONS } from "./palette-icons.js";

export class PaletteRail {
  #el;
  /** @type {{key: string, button: HTMLButtonElement}[]} */
  #buttons;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.toggle - the tray's reopen chevron. The panel
   *   builds and labels it; the strip only gives it its place, on the line the
   *   tray header's own chevron sits on.
   * @param {{id: string, key: string, group?: boolean}[]} opts.sections -
   *   the top-level entries in tray order: `id` is the section's IDENTITY
   *   (what `onOpen` hands back), `key` names its icon and its
   *   `palette.rail.*` label, and `group` marks a catalog group's header
   *   (smaller text, so a shorter row) rather than a folder's.
   * @param {(id: string) => void} opts.onOpen - an icon was clicked.
   */
  constructor({ toggle, sections, onOpen }) {
    this.#buttons = sections.map(({ id, key, group }) => {
      const button = el("button", {
        class: group
          ? "palette-rail-btn palette-rail-btn--group"
          : "palette-rail-btn",
        type: "button",
        dataset: { section: id },
        onClick: () => onOpen?.(id),
      });
      button.innerHTML = SECTION_ICONS[key];
      return { key, button };
    });
    this.#el = el("nav", { class: "palette-rail" }, [
      el("div", { class: "palette-rail-head" }, [toggle]),
      el(
        "div",
        { class: "palette-rail-sections" },
        this.#buttons.map(({ button }) => button),
      ),
    ]);
    this.relocalize();
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

  /** Re-label in the current language. The chevron is the panel's to label. */
  relocalize() {
    this.#el.setAttribute("aria-label", t("palette.rail.label"));
    for (const { key, button } of this.#buttons) {
      const label = t(`palette.rail.${key}`);
      button.title = label;
      button.setAttribute("aria-label", label);
    }
  }
}
