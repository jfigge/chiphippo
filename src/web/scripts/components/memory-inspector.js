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

import { el } from "../dom.js";

/** Bytes per row (the canonical hex-dump width). */
const ROW_BYTES = 16;
/** Row height in px — applied inline so the layout needs no matching CSS. */
const ROW_H = 22;
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
  #onEdit;
  #onSelect;
  #fallbackRows;

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
    this.#build(container);
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
    this.#scroll.scrollTop = Math.max(0, row * ROW_H - ROW_H * 2);
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
      el("span", { class: "mem-off mem-head-off", text: "Offset" }),
    );
    for (let c = 0; c < ROW_BYTES; c++) {
      this.#header.append(
        el("span", { class: "mem-hx mem-head-hx", text: hex2(c) }),
      );
    }
    this.#header.append(el("span", { class: "mem-asc-head", text: "ASCII" }));

    // Scroll viewport → tall spacer canvas → absolutely-positioned rows.
    this.#scroll = el("div", { class: "mem-grid-scroll" });
    this.#canvas = el("div", { class: "mem-grid-canvas" });
    this.#scroll.append(this.#canvas);
    this.#scroll.addEventListener("scroll", () => this.#paint());
    this.#canvas.addEventListener("mousedown", this.#onCellMouseDown);

    this.#root.append(this.#header, this.#scroll);
    container.append(this.#root);
  }

  #totalRows() {
    return Math.ceil(this.#bytes.length / ROW_BYTES);
  }

  #visibleRowCount() {
    const h = this.#scroll.clientHeight;
    const rows = h > 0 ? Math.ceil(h / ROW_H) : this.#fallbackRows;
    return rows + OVERSCAN;
  }

  /** Grow the row pool to `n` reusable rows (never shrinks — pooling is cheap). */
  #ensurePool(n) {
    while (this.#pool.length < n) {
      const row = el("div", { class: "mem-row" });
      row.style.position = "absolute";
      row.style.left = "0";
      row.style.right = "0";
      row.style.height = `${ROW_H}px`;
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
    this.#canvas.style.height = `${total * ROW_H}px`;
    this.#ensurePool(this.#visibleRowCount());
    const first = Math.max(
      0,
      Math.floor(this.#scroll.scrollTop / ROW_H) - Math.floor(OVERSCAN / 2),
    );
    for (let i = 0; i < this.#pool.length; i++) {
      const row = this.#pool[i];
      const rowIndex = first + i;
      if (rowIndex >= total) {
        row.el.style.display = "none";
        continue;
      }
      row.el.style.display = "";
      row.el.style.top = `${rowIndex * ROW_H}px`;
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
    if (this.#editable) {
      this.#beginEdit(
        addr,
        cell.dataset.kind === "ascii" ? "ascii" : "hex",
        cell,
      );
    } else {
      this.#paint();
    }
  };

  #beginEdit(addr, kind, cellEl) {
    this.#endEdit(false);
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
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        this.#endEdit(false);
      }
    });
    input.addEventListener("blur", () => this.#endEdit(true));
  }

  #endEdit(commit) {
    const ed = this.#editing;
    if (!ed) return;
    this.#editing = null;
    let value = null;
    if (commit) {
      if (ed.kind === "hex") {
        const v = Number.parseInt(ed.input.value, 16);
        if (!Number.isNaN(v)) value = v & 0xff;
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
