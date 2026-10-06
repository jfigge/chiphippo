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
// variable (the module's ports) and every internal one (its regs, integers,
// wires and arrays) of the chip in view, filled in automatically — there is
// nothing to add by hand — and refreshed as the user steps. A value a queued
// non-blocking assignment is about to change shows the value it will take
// beside it; an inout shows what the chip drives onto its pins beside the
// level they are at. An ARRAY is one row with its shape and a toggle that
// opens its words below it (hdl-memory-view.js), which the view asks for as
// it shows them.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { HdlMemoryView } from "./hdl-memory-view.js";

const KIND_ORDER = { input: 0, inout: 1, output: 2, reg: 3, integer: 4, memory: 5, wire: 6 }; // prettier-ignore

export class ChipWatchPanel {
  #root;
  #unitSelect;
  #body;
  #onUnit;
  #onMemoryRange;
  #open = new Set(); // "compId:name" of the arrays whose words are shown
  #views = new Map(); // "compId:name" → HdlMemoryView (kept across redraws)

  /**
   * @param {object} [opts]
   * @param {(unit: number) => void} [opts.onUnit]
   * @param {(compId: string, slot: number, from: number, count: number,
   *   req: number) => void} [opts.onMemoryRange] - ask the host for words of
   *   an array (answered through `memoryRange`).
   */
  constructor({ onUnit, onMemoryRange } = {}) {
    this.#onUnit = onUnit;
    this.#onMemoryRange = onMemoryRange;
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
    const shown = new Set();
    this.#body.replaceChildren(
      ...rows.flatMap((r) => {
        if (r.memory) return this.#memoryRows(tab, r, shown);
        return [
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
              r.drives != null
                ? el("span", {
                    class: "cd-watch-drives",
                    text: ` ${t("chipdesign.watch.drives", { value: r.drives })}`, // prettier-ignore
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
        ];
      }),
    );
    // A view not on screen any more (another chip, the array gone) is let
    // go; one still shown asks again for its words — the state moved on.
    for (const key of [...this.#views.keys()]) {
      if (!shown.has(key)) this.#views.delete(key);
      // Re-homed in the new table: back to where its reader had scrolled.
      else this.#views.get(key).view.reattached();
    }
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

  /** An answer to an array's request (the host's `memory-range`). */
  memoryRange(msg) {
    for (const [key, entry] of this.#views) {
      if (entry.compId === msg?.compId && entry.slot === msg.slot) {
        entry.view.receive(msg.range, msg.req);
        return key;
      }
    }
    return null;
  }

  /** The app's text size moved: the memory views' rows follow it. */
  refreshMetrics() {
    for (const { view } of this.#views.values()) view.refreshMetrics();
  }

  /** An array's row — and, when it is open, the row holding its words. */
  #memoryRows(tab, r, shown) {
    const key = `${tab.compId}:${r.name}`;
    const open = this.#open.has(key);
    const toggle = el("button", {
      type: "button",
      class: "cd-watch-toggle",
      "aria-expanded": open ? "true" : "false",
      text: t(open ? "chipdesign.watch.hideWords" : "chipdesign.watch.showWords"), // prettier-ignore
    });
    toggle.addEventListener("click", () => {
      if (this.#open.has(key)) this.#open.delete(key);
      else this.#open.add(key);
      this.render(tab);
    });
    const m = r.memory;
    const pending = m.pendingCount
      ? el("span", {
          class: "cd-watch-pending",
          text: ` → ${t("chipdesign.watch.memoryPending", { count: m.pendingCount })}`, // prettier-ignore
          title: m.pendingWords.map(([index, v]) => `[${index}] ← ${v}`).join("\n"), // prettier-ignore
        })
      : null;
    const head = el("tr", { class: "cd-watch-row cd-watch-row--memory" }, [
      el("td", { class: "cd-watch-name", text: r.name }),
      el("td", { class: "cd-watch-kind", text: t("chipdesign.watch.kind_memory") }), // prettier-ignore
      el("td", { class: "cd-watch-value" }, [el("span", { text: r.value }), pending, " ", toggle]), // prettier-ignore
    ]);
    if (!open) return [head];
    shown.add(key);
    let entry = this.#views.get(key);
    if (!entry || entry.slot !== m.slot) {
      const compId = tab.compId;
      const slot = m.slot;
      entry = {
        compId,
        slot,
        view: new HdlMemoryView({
          request: (from, count, req) =>
            this.#onMemoryRange?.(compId, slot, from, count, req),
        }),
      };
      this.#views.set(key, entry);
    }
    entry.view.setShape(m);
    return [
      head,
      el("tr", { class: "cd-watch-memory-row" }, [
        el("td", { colSpan: 3 }, [entry.view.element]),
      ]),
    ];
  }
}
