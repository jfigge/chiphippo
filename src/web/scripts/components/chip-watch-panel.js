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

// chip-watch-panel.js — the chip debugger's watch panel: every pin-backed
// variable (the module's ports) and every internal one (its regs and wires)
// of the chip in view, filled in automatically — there is nothing to add by
// hand — and refreshed as the user steps. A value a queued non-blocking
// assignment is about to change shows the value it will take beside it.

import { el } from "../dom.js";
import { t } from "../i18n.js";

const KIND_ORDER = { input: 0, output: 1, reg: 2, wire: 3 };

export class ChipWatchPanel {
  #root;
  #unitSelect;
  #body;
  #onUnit;

  /** @param {{onUnit?: (unit: number) => void}} [opts] */
  constructor({ onUnit } = {}) {
    this.#onUnit = onUnit;
    this.#unitSelect = el("select", {
      class: "cd-select cd-watch-unit",
      "aria-label": t("chipdesign.watch.unit"),
      hidden: true,
    });
    this.#unitSelect.addEventListener("change", () =>
      this.#onUnit?.(Number(this.#unitSelect.value)),
    );
    this.#body = el("tbody");
    this.#root = el(
      "section",
      { class: "cd-watch", "aria-label": t("chipdesign.watch.title") },
      [
        // prettier-ignore
        el("div", { class: "cd-section-head" }, [
        el("h3", { class: "cd-subhead", text: t("chipdesign.watch.title") }),
        this.#unitSelect,
      ]),
        el("div", { class: "cd-watch-scroll" }, [
          el("table", { class: "cd-watch-table" }, [
            el("thead", {}, [
              el("tr", {}, [
                el("th", { text: t("chipdesign.watch.name") }),
                el("th", { text: t("chipdesign.watch.kind") }),
                el("th", { text: t("chipdesign.watch.value") }),
              ]),
            ]),
            this.#body,
          ]),
        ]),
      ],
    );
  }

  get element() {
    return this.#root;
  }

  /**
   * @param {object|null} tab - the focused tab's view (chip-debugger.js).
   */
  render(tab) {
    const rows = [...(tab?.watch ?? [])].sort(
      (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
    );
    this.#body.replaceChildren(
      ...rows.map((r) =>
        el("tr", { class: `cd-watch-row cd-watch-row--${r.kind}` }, [
          el("td", { class: "cd-watch-name", text: r.name }),
          el("td", { class: "cd-watch-kind", text: t(`chipdesign.watch.kind_${r.kind}`) }), // prettier-ignore
          el("td", { class: "cd-watch-value" }, [
            el("span", { text: r.value }),
            r.decimal != null
              ? el("span", {
                  class: "cd-watch-decimal",
                  text: ` (${r.decimal})`,
                })
              : null,
            r.pending
              ? el("span", {
                  class: "cd-watch-pending",
                  text: ` → ${r.pending}`,
                  title: t("chipdesign.watch.pending"),
                })
              : null,
          ]),
        ]),
      ),
    );
    if (!rows.length) {
      this.#body.append(
        el("tr", {}, [
          el("td", { class: "cd-watch-empty", colSpan: 3, text: t("chipdesign.watch.empty") }), // prettier-ignore
        ]),
      );
    }
    const units = tab?.units ?? 1;
    this.#unitSelect.hidden = units <= 1;
    if (units > 1) {
      if (this.#unitSelect.options.length !== units) {
        this.#unitSelect.replaceChildren(
          ...Array.from(
            { length: units },
            (_v, u) =>
            el("option", { value: String(u), text: t("chipdesign.form.unit", { n: u + 1 }) }), // prettier-ignore
          ),
        );
      }
      this.#unitSelect.value = String(tab.unit ?? 0);
      // A paused chip shows the unit it is executing.
      this.#unitSelect.disabled = tab.state === "paused";
    }
  }
}
