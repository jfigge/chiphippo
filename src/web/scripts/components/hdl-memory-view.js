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

// hdl-memory-view.js — the chip debugger's view of one ARRAY in a custom
// chip's code (`reg [7:0] mem [0:32767];`): its words in rows, each row's
// first index in a gutter, the words a queued non-blocking write is about to
// change marked with the value they will take.
//
// The words are not the debugger's to send — a 32K memory riding every step
// to this window would be most of the traffic for a few dozen words on
// screen — so the view ASKS for the rows it shows (`request(from, count)`,
// answered through `receive`), again whenever it scrolls and whenever the
// state it shows moves on (`refresh`). Only the visible rows are in the DOM:
// a pool of row elements repositioned as it scrolls, the memory inspector's
// arrangement (memory-inspector.js), and like it the row height follows the
// app's text size, since the scroll arithmetic depends on it.

import { el } from "../dom.js";
import { t } from "../i18n.js";

/** Row height at the shipped text size (13 px) — scaled with `--font-size`. */
const BASE_ROW_H = 18;
const BASE_FONT_PX = 13;
/** Rows drawn past the visible ones, so scrolling never shows a gap. */
const OVERSCAN = 4;
/** Rows assumed visible when nothing has been laid out (a test, a hidden
    panel). */
const FALLBACK_ROWS = 12;

/** Words per row: a narrow word fits eight, a wide one four. */
const perRowFor = (w) => (w <= 16 ? 8 : 4);

export class HdlMemoryView {
  #request;
  #root;
  #scroll;
  #canvas;
  #pool = [];
  #rowH = BASE_ROW_H;
  #shape = null; // {lo, hi, w}
  #perRow = 8;
  #words = new Map(); // index → hex
  #pending = new Map(); // index → hex
  #req = 0;

  /**
   * @param {object} opts
   * @param {(from: number, count: number, req: number) => void} opts.request
   *   - ask for `count` words from index `from` (the array's own numbering);
   *   the answer comes back through `receive` with the same `req`.
   */
  constructor({ request }) {
    this.#request = request;
    this.#canvas = el("div", { class: "cd-memory-canvas" });
    this.#scroll = el("div", { class: "cd-memory-scroll" }, [this.#canvas]);
    this.#scroll.addEventListener("scroll", () => {
      this.#paint();
      this.#ask();
    });
    this.#root = el(
      "div",
      { class: "cd-memory", "aria-label": t("chipdesign.watch.memoryLabel") },
      [this.#scroll],
    );
    this.#syncRowH();
  }

  get element() {
    return this.#root;
  }

  /**
   * The array this view shows: its index range and word width. A new shape
   * forgets what was known and starts from the top.
   * @param {{lo: number, hi: number, w: number}} shape
   */
  setShape(shape) {
    const same =
      this.#shape &&
      this.#shape.lo === shape.lo &&
      this.#shape.hi === shape.hi &&
      this.#shape.w === shape.w;
    if (same) return;
    this.#shape = { lo: shape.lo, hi: shape.hi, w: shape.w };
    this.#perRow = perRowFor(shape.w);
    this.#words.clear();
    this.#pending.clear();
    this.#scroll.scrollTop = 0;
    this.#paint();
  }

  /** The state on show moved on (a step, a new pass): ask again for the
      rows in view. */
  refresh() {
    this.#ask();
  }

  /** Re-measure the row height for the app's text size, and redraw. */
  refreshMetrics() {
    const before = this.#rowH;
    this.#syncRowH();
    if (before !== this.#rowH) this.#paint();
  }

  /**
   * An answer to a request: `{from, words, pending}` (memoryWords in
   * model/chip-debug.js). Only the latest request's answer is taken — an
   * older one describes a state the view has moved past.
   * @param {object|null} range
   * @param {number} req
   */
  receive(range, req) {
    if (req !== this.#req || !range) return;
    for (let k = 0; k < range.words.length; k++) {
      this.#words.set(range.from + k, range.words[k]);
      this.#pending.delete(range.from + k);
    }
    for (const [index, hex] of range.pending ?? []) this.#pending.set(index, hex); // prettier-ignore
    this.#paint();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  #syncRowH() {
    const px = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        "--font-size",
      ),
    );
    this.#rowH =
      Number.isFinite(px) && px > 0
        ? Math.round((px * BASE_ROW_H) / BASE_FONT_PX)
        : BASE_ROW_H;
  }

  #totalRows() {
    if (!this.#shape) return 0;
    return Math.ceil((this.#shape.hi - this.#shape.lo + 1) / this.#perRow);
  }

  #visibleRows() {
    const h = this.#scroll.clientHeight;
    return (h > 0 ? Math.ceil(h / this.#rowH) : FALLBACK_ROWS) + OVERSCAN;
  }

  #firstRow() {
    return Math.max(0, Math.floor(this.#scroll.scrollTop / this.#rowH) - 1);
  }

  /** Ask for the words of the rows in view. */
  #ask() {
    if (!this.#shape) return;
    const from = this.#shape.lo + this.#firstRow() * this.#perRow;
    const count = this.#visibleRows() * this.#perRow;
    this.#req += 1;
    this.#request(from, count, this.#req);
  }

  #ensurePool(n) {
    while (this.#pool.length < n) {
      const gutter = el("span", { class: "cd-memory-index" });
      const cells = [];
      const row = el("div", { class: "cd-memory-row" }, [gutter]);
      for (let c = 0; c < 8; c++) {
        const cell = el("span", { class: "cd-memory-word" });
        cells.push(cell);
        row.append(cell);
      }
      this.#canvas.append(row);
      this.#pool.push({ row, gutter, cells });
    }
  }

  #paint() {
    const total = this.#totalRows();
    this.#canvas.style.height = `${total * this.#rowH}px`;
    this.#ensurePool(this.#visibleRows());
    const first = this.#firstRow();
    const digits = this.#shape ? Math.max(1, Math.ceil(Math.log2(Math.max(2, Math.abs(this.#shape.hi) + 1)) / 4)) : 1; // prettier-ignore
    const wordDigits = this.#shape ? Math.ceil(this.#shape.w / 4) : 1;
    this.#pool.forEach((p, i) => {
      const r = first + i;
      if (r >= total) {
        p.row.hidden = true;
        return;
      }
      p.row.hidden = false;
      p.row.style.top = `${r * this.#rowH}px`;
      p.row.style.height = `${this.#rowH}px`;
      const base = this.#shape.lo + r * this.#perRow;
      p.gutter.textContent = base.toString(16).toUpperCase().padStart(digits, "0"); // prettier-ignore
      p.cells.forEach((cell, c) => {
        const index = base + c;
        if (c >= this.#perRow || index > this.#shape.hi) {
          cell.hidden = true;
          return;
        }
        cell.hidden = false;
        const hex = this.#words.get(index) ?? "·".repeat(wordDigits);
        const next = this.#pending.get(index);
        cell.textContent = hex;
        cell.classList.toggle("cd-memory-word--pending", next != null);
        cell.title = next != null ? t("chipdesign.watch.memoryNext", { index, value: next }) : `[${index}]`; // prettier-ignore
      });
    });
  }
}
