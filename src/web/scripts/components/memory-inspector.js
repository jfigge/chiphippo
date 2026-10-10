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

// memory-inspector.js — the virtualized hex + ASCII grid at the heart of the
// memory inspector window (Feature 190). It OWNS a working byte buffer and
// draws it 16 bytes per row (offset gutter · hex columns · ASCII sidebar), with
// ONLY the visible rows in the DOM (a fixed pool of row elements repositioned +
// refilled on scroll — a 32 KiB image is 2048 rows). Cells are editable when
// the sim is STOPPED; while it RUNS the grid is read-only and tints the bytes
// the circuit wrote. It is a pure DOM widget: the window (memory.js) owns file
// I/O + the toolbar and drives this through setBytes / applyChanges /
// setEditable / gotoAddress / fillRange, receiving edits via the `onEdit`
// callback.

import { t } from "../i18n.js";
import { el } from "../dom.js";

/** Bytes per row (the canonical hex-dump width). */
const ROW_BYTES = 16;
/** Row height in px at the shipped font size — applied inline, so the layout
 *  needs no matching CSS. This is the ONE place the app's text size feeds
 *  ARITHMETIC rather than layout: the grid is virtualized, so `#rowH` decides
 *  how many rows exist, which one a scroll offset lands on, and how tall the
 *  spacer is. A row that doesn't match its own measure doesn't merely look
 *  wrong — rows overlap or vanish as you scroll, which in a window showing ROM
 *  bytes reads as corrupted data. Hence a measured field rather than a
 *  constant; see `#syncRowH`. */
const BASE_ROW_H = 22;
const BASE_FONT_PX = 13;
/** Extra rows rendered above/below the viewport so scrolling never flashes. */
const OVERSCAN = 6;

/** The printable glyph for a byte in the ASCII column ('.' for control bytes). */
function printable(v) {
  return v >= 0x20 && v <= 0x7e ? String.fromCharCode(v) : ".";
}
/** The raw char for an editable ASCII cell (empty when the byte isn't typeable). */
function printableRaw(v) {
  return v >= 0x20 && v <= 0x7e ? String.fromCharCode(v) : "";
}
const hex2 = (v) => v.toString(16).padStart(2, "0").toUpperCase();
const hex6 = (v) => v.toString(16).padStart(6, "0").toUpperCase();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class MemoryInspector {
  #root;
  #scroll;
  #canvas;
  #header;
  #bytes = new Uint8Array(0);
  #editable = false;
  #written = new Set(); // addresses written during the current run (live tint)
  #selStart = -1;
  #selEnd = -1;
  #pool = []; // reused row elements: { el, off, hex[16], asc[16] }
  #editing = null; // active inline editor: { addr, kind, cellEl, input }
  #column = "hex"; // the column last clicked: what a key typed on the grid means
  #onEdit;
  #onSelect;
  #fallbackRows;
  #rowH = BASE_ROW_H;

  /**
   * @param {HTMLElement} container
   * @param {object} [opts]
   * @param {(change: object) => void} [opts.onEdit] - a user edit while stopped:
   *   `{ type:"byte", addr, value }` or `{ type:"fill", start, end, value }`.
   * @param {(range: {start:number,end:number}|null) => void} [opts.onSelect]
   * @param {number} [opts.fallbackRows] - rows to render when the viewport has
   *   no measured height yet (jsdom / pre-layout); defaults to 24.
   */
  constructor(container, { onEdit, onSelect, fallbackRows = 24 } = {}) {
    this.#onEdit = onEdit;
    this.#onSelect = onSelect;
    this.#fallbackRows = fallbackRows;
    this.#syncRowH();
    this.#build(container);
  }

  /**
   * Re-measure the row height against the app's current text size and redraw.
   * The window calls this when Settings ▸ Appearance ▸ Editor font size moves
   * (`chiphippo:font-size-changed`) — the CSS follows on its own, but the
   * virtualization arithmetic above has to be told.
   */
  refreshMetrics() {
    const before = this.#rowH;
    this.#syncRowH();
    if (this.#rowH !== before) this.#paint();
  }

  /**
   * Read `--font-size` off the document root and scale the row to it. Falls
   * back to the shipped 22 when there is no computed value to read — which is
   * every `node --test` run, since jsdom parses no stylesheet, so the tests see
   * exactly the geometry they always have.
   */
  #syncRowH(root = document.documentElement) {
    const px = parseFloat(
      getComputedStyle(root).getPropertyValue("--font-size"),
    );
    this.#rowH =
      Number.isFinite(px) && px > 0
        ? Math.round((px * BASE_ROW_H) / BASE_FONT_PX)
        : BASE_ROW_H;
  }

  // ── Public API (driven by the window) ──────────────────────────────────────

  /** The current image length in bytes. */
  get length() {
    return this.#bytes.length;
  }

  /** Replace the whole buffer (reload / import); clears run tint + selection. */
  setBytes(bytes) {
    this.#bytes =
      bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes ?? []);
    this.#written.clear();
    this.#selStart = this.#selEnd = -1;
    this.#endEdit(false);
    this.#paint();
  }

  /** A defensive copy of the working buffer (for Save / Export). */
  getBytes() {
    return Uint8Array.from(this.#bytes);
  }

  /** Read-only + live while running; editable while stopped. */
  setEditable(editable) {
    this.#editable = Boolean(editable);
    this.#root.classList.toggle("mem-inspector--editable", this.#editable);
    if (!this.#editable) this.#endEdit(false);
    this.#paint();
  }

  /** Apply the engine's live byte writes: mutate + tint the changed cells. */
  applyChanges(changes) {
    for (const [addr, value] of changes ?? []) {
      if (addr >= 0 && addr < this.#bytes.length) {
        this.#bytes[addr] = value & 0xff;
        this.#written.add(addr);
      }
    }
    this.#paint();
  }

  /** Scroll to + select a byte (Go-to-address). */
  gotoAddress(addr) {
    if (this.#bytes.length === 0) return;
    const a = clamp(Math.floor(addr) || 0, 0, this.#bytes.length - 1);
    this.#setSelection(a, a);
    const row = Math.floor(a / ROW_BYTES);
    this.#scroll.scrollTop = Math.max(0, row * this.#rowH - this.#rowH * 2);
    this.#paint();
  }

  /** Fill an inclusive address range with a byte value (a stopped edit). */
  fillRange(start, end, value) {
    if (this.#bytes.length === 0) return;
    const lo = clamp(Math.min(start, end) | 0, 0, this.#bytes.length - 1);
    const hi = clamp(Math.max(start, end) | 0, 0, this.#bytes.length - 1);
    const v = value & 0xff;
    for (let a = lo; a <= hi; a++) this.#bytes[a] = v;
    this.#onEdit?.({ type: "fill", start: lo, end: hi, value: v });
    this.#paint();
  }

  /** The current inclusive selection, or null. */
  get selection() {
    if (this.#selStart < 0) return null;
    return {
      start: Math.min(this.#selStart, this.#selEnd),
      end: Math.max(this.#selStart, this.#selEnd),
    };
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  #build(container) {
    this.#root = el("div", { class: "mem-inspector" });

    // Column header: the offset gutter label + 00..0F + ASCII.
    this.#header = el("div", { class: "mem-header" });
    this.#header.append(
      el("span", { class: "mem-off mem-head-off", text: t("memory.offset") }),
    );
    for (let c = 0; c < ROW_BYTES; c++) {
      this.#header.append(
        el("span", { class: "mem-hx mem-head-hx", text: hex2(c) }),
      );
    }
    // ASCII is a standard's name, not a word — the same in every language.
    this.#header.append(el("span", { class: "mem-asc-head", text: "ASCII" }));

    // Scroll viewport → tall spacer canvas → absolutely-positioned rows.
    // Focusable, so a selected byte can be typed over with no editor open.
    this.#scroll = el("div", { class: "mem-grid-scroll", tabindex: "0" });
    this.#canvas = el("div", { class: "mem-grid-canvas" });
    this.#scroll.append(this.#canvas);
    this.#scroll.addEventListener("scroll", () => this.#paint());
    this.#scroll.addEventListener("keydown", this.#onGridKeyDown);
    this.#canvas.addEventListener("mousedown", this.#onCellMouseDown);

    this.#root.append(this.#header, this.#scroll);
    container.append(this.#root);
  }

  #totalRows() {
    return Math.ceil(this.#bytes.length / ROW_BYTES);
  }

  #visibleRowCount() {
    const h = this.#scroll.clientHeight;
    const rows = h > 0 ? Math.ceil(h / this.#rowH) : this.#fallbackRows;
    return rows + OVERSCAN;
  }

  /** Grow the row pool to `n` reusable rows (never shrinks — pooling is cheap). */
  #ensurePool(n) {
    while (this.#pool.length < n) {
      const row = el("div", { class: "mem-row" });
      row.style.position = "absolute";
      row.style.left = "0";
      row.style.right = "0";
      const off = el("span", { class: "mem-off" });
      const hex = [];
      const asc = [];
      row.append(off);
      for (let c = 0; c < ROW_BYTES; c++) {
        const h = el("span", { class: "mem-hx" });
        hex.push(h);
        row.append(h);
      }
      const sep = el("span", { class: "mem-asc-sep", "aria-hidden": "true" });
      row.append(sep);
      for (let c = 0; c < ROW_BYTES; c++) {
        const a = el("span", { class: "mem-asc" });
        asc.push(a);
        row.append(a);
      }
      this.#canvas.append(row);
      this.#pool.push({ el: row, off, hex, asc });
    }
  }

  /** Reposition + refill the pool to cover the current scroll offset. */
  #paint() {
    const total = this.#totalRows();
    this.#canvas.style.height = `${total * this.#rowH}px`;
    this.#ensurePool(this.#visibleRowCount());
    const first = Math.max(
      0,
      Math.floor(this.#scroll.scrollTop / this.#rowH) -
        Math.floor(OVERSCAN / 2),
    );
    // The pool is REUSED: scrolled far enough, the cell holding an inline edit
    // is about to show another address, and refilling it would wipe the input
    // out from under the user (half-committing it on the blur, or leaving the
    // edit pointing at a cell that now shows a different byte). End the edit
    // first — keeping a COMPLETE value, dropping a half-typed one.
    if (
      this.#editing &&
      this.#addrOfCell(this.#editing.cellEl, first) !== this.#editing.addr
    ) {
      this.#endEdit(this.#editComplete());
      return; // #endEdit repainted
    }
    for (let i = 0; i < this.#pool.length; i++) {
      const row = this.#pool[i];
      const rowIndex = first + i;
      if (rowIndex >= total) {
        row.el.style.display = "none";
        continue;
      }
      row.el.style.display = "";
      row.el.style.height = `${this.#rowH}px`;
      row.el.style.top = `${rowIndex * this.#rowH}px`;
      this.#fillRow(row, rowIndex);
    }
  }

  #fillRow(row, rowIndex) {
    const base = rowIndex * ROW_BYTES;
    row.off.textContent = hex6(base);
    for (let c = 0; c < ROW_BYTES; c++) {
      const addr = base + c;
      const hx = row.hex[c];
      const asc = row.asc[c];
      if (
        addr < this.#bytes.length &&
        !(this.#editing && this.#editing.addr === addr)
      ) {
        const v = this.#bytes[addr];
        hx.textContent = hex2(v);
        asc.textContent = printable(v);
        hx.dataset.addr = String(addr);
        asc.dataset.addr = String(addr);
        hx.dataset.kind = "hex";
        asc.dataset.kind = "ascii";
        hx.style.visibility = asc.style.visibility = "";
        const written = this.#written.has(addr);
        const sel = this.#inSelection(addr);
        hx.className = `mem-hx${written ? " mem-cell--written" : ""}${sel ? " mem-cell--sel" : ""}`;
        asc.className = `mem-asc${written ? " mem-cell--written" : ""}${sel ? " mem-cell--sel" : ""}`;
      } else if (!(this.#editing && this.#editing.addr === addr)) {
        hx.textContent = "";
        asc.textContent = "";
        delete hx.dataset.addr;
        delete asc.dataset.addr;
        hx.style.visibility = asc.style.visibility = "hidden";
        hx.className = "mem-hx";
        asc.className = "mem-asc";
      }
    }
  }

  /** The address `cell` will show once the pool covers rows from `first`
      (null when it is no pool cell). */
  #addrOfCell(cell, first) {
    for (let i = 0; i < this.#pool.length; i++) {
      const row = this.#pool[i];
      const c = row.hex.includes(cell) ? row.hex.indexOf(cell) : row.asc.indexOf(cell); // prettier-ignore
      if (c >= 0) return (first + i) * ROW_BYTES + c;
    }
    return null;
  }

  /** Whether the inline edit holds a whole value: two hex digits, or one
      character. */
  #editComplete() {
    const ed = this.#editing;
    return ed.kind === "hex"
      ? /^[0-9a-f]{2}$/i.test(ed.input.value)
      : ed.input.value.length === 1;
  }

  #inSelection(addr) {
    if (this.#selStart < 0) return false;
    const lo = Math.min(this.#selStart, this.#selEnd);
    const hi = Math.max(this.#selStart, this.#selEnd);
    return addr >= lo && addr <= hi;
  }

  #setSelection(start, end) {
    this.#selStart = start;
    this.#selEnd = end;
    this.#onSelect?.(this.selection);
  }

  // ── Cell interaction ────────────────────────────────────────────────────────

  #onCellMouseDown = (e) => {
    const cell = e.target.closest?.("[data-addr]");
    if (!cell) return;
    const addr = Number(cell.dataset.addr);
    if (!Number.isInteger(addr)) return;
    if (e.shiftKey && this.#selStart >= 0) {
      this.#setSelection(this.#selStart, addr);
      this.#paint();
      return;
    }
    this.#setSelection(addr, addr);
    this.#column = cell.dataset.kind === "ascii" ? "ascii" : "hex";
    if (this.#editable) {
      // The press must not move focus itself: the grid is focusable (so a
      // selected byte can be typed over), and Chromium's default mousedown
      // focus would land on it AFTER the editor took focus — blurring, and
      // so closing, the editor the click just opened.
      e.preventDefault();
      this.#beginEdit(addr, this.#column, cell);
    } else {
      this.#paint();
    }
  };

  /**
   * A key on the grid with no editor open: a hex digit typed with a byte
   * selected starts editing THAT byte (the selection's first), the digit its
   * first — so a run of bytes can be typed straight in.
   */
  #onGridKeyDown = (e) => {
    if (!this.#editable || this.#editing || this.#selStart < 0) return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    // The column last clicked decides what a key means: a hex digit there,
    // any printable character in the ASCII column.
    const ascii = this.#column === "ascii";
    if (ascii ? !/^[\x20-\x7e]$/.test(e.key) : !/^[0-9a-f]$/i.test(e.key)) return; // prettier-ignore
    e.preventDefault();
    const addr = Math.min(this.#selStart, this.#selEnd);
    if (ascii) {
      // One character IS the byte: write it and move on, as typing in an
      // open ASCII editor does.
      this.#editAt(addr, "ascii", e.key);
      this.#advance();
    } else {
      this.#editAt(addr, "hex", e.key.toUpperCase());
    }
  };

  /** Open the editor on `addr`'s cell (scrolled into view), optionally with
      its first character already typed. */
  #editAt(addr, kind, typed = null) {
    this.#setSelection(addr, addr);
    this.#reveal(addr);
    const cls = kind === "hex" ? "mem-hx" : "mem-asc";
    const cell = this.#canvas.querySelector(`.${cls}[data-addr="${addr}"]`);
    if (!cell) return;
    this.#beginEdit(addr, kind, cell);
    if (typed != null) {
      this.#editing.input.value = typed;
      this.#editing.input.setSelectionRange?.(1, 1);
    }
  }

  /** Scroll `addr`'s row into view if it is not, then repaint. */
  #reveal(addr) {
    const top = Math.floor(addr / ROW_BYTES) * this.#rowH;
    const h = this.#scroll.clientHeight;
    if (h > 0) {
      if (top < this.#scroll.scrollTop) this.#scroll.scrollTop = top;
      else if (top + this.#rowH > this.#scroll.scrollTop + h) {
        this.#scroll.scrollTop = top + this.#rowH - h;
      }
    }
    this.#paint();
  }

  #beginEdit(addr, kind, cellEl) {
    this.#endEdit(this.#editing ? this.#editComplete() : false);
    const input = el("input", {
      class: "mem-cell-edit",
      type: "text",
      maxLength: kind === "hex" ? 2 : 1,
    });
    input.value =
      kind === "hex"
        ? hex2(this.#bytes[addr])
        : printableRaw(this.#bytes[addr]);
    cellEl.textContent = "";
    cellEl.append(input);
    this.#editing = { addr, kind, cellEl, input };
    input.focus();
    input.select?.();
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        this.#endEdit(true);
        this.#scroll.focus(); // typing on goes on from the selection
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.#endEdit(false);
        this.#scroll.focus();
      }
    });
    // TYPE-THROUGH, as a hex editor does: a byte's last digit (or an ASCII
    // cell's one character) writes it and moves the editor to the next byte,
    // so a run of values is typed with no clicks between them. A character
    // that is not a hex digit never lands in a hex cell.
    input.addEventListener("input", () => {
      if (this.#editing?.input !== input) return;
      if (kind === "hex") {
        const clean = input.value.replace(/[^0-9a-f]/gi, "").toUpperCase();
        if (clean !== input.value) input.value = clean;
        if (clean.length === 2) this.#advance();
      } else if (input.value.length === 1) {
        this.#advance();
      }
    });
    // Only THIS editor's blur ends it: an editor removed as the next one
    // opens may report its blur after that one is up.
    // ONE rule for leaving an editor any way but Enter or Escape — another
    // cell, a click elsewhere, a scroll: a WHOLE byte is written, a
    // half-typed one is dropped. (Enter writes what is there: "4" is $04.)
    input.addEventListener("blur", () => {
      if (this.#editing?.input === input) this.#endEdit(this.#editComplete());
    });
  }

  /** Write the byte being edited and open the editor on the next one (the
      last byte of the image just writes). */
  #advance() {
    const { addr, kind } = this.#editing;
    this.#endEdit(true);
    if (addr + 1 < this.#bytes.length) this.#editAt(addr + 1, kind);
    else this.#scroll.focus();
  }

  #endEdit(commit) {
    const ed = this.#editing;
    if (!ed) return;
    this.#editing = null;
    let value = null;
    if (commit) {
      if (ed.kind === "hex") {
        // Hex digits only: parseInt would read "4z" as 4 and write it.
        if (/^[0-9a-f]{1,2}$/i.test(ed.input.value)) {
          value = Number.parseInt(ed.input.value, 16);
        }
      } else if (ed.input.value.length) {
        value = ed.input.value.charCodeAt(0) & 0xff;
      }
    }
    if (value != null && value !== this.#bytes[ed.addr]) {
      this.#bytes[ed.addr] = value;
      this.#onEdit?.({ type: "byte", addr: ed.addr, value });
    }
    this.#paint();
  }
}
