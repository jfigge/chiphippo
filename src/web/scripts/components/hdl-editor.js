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

// hdl-editor.js — the chip designer's code editor: a plain <textarea> laid
// exactly over a <pre> that draws the same text coloured (the classic
// transparent-textarea editor — the app takes no framework and no editor
// library, and a textarea is what makes typing, selection, undo, IME and
// accessibility the platform's rather than ours).
//
// The colours come from hdl/highlight.js, which reads the very token stream
// the compiler does. On top of them it draws what the designer and debugger
// need: diagnostics underlined (a marker in the gutter too), the statement
// the debugger is paused at, and the LINKED references — every use of the pin
// the pointer is over on the package. The other half of that linking is here
// as well: `onHover` reports the identifier under the pointer, found by
// arithmetic on a monospace grid rather than by any per-token DOM, since the
// textarea sits on top of everything and receives the pointer.
//
// The GUTTER sets breakpoints: clicking a line's number asks for one on that
// line (`onToggleBreakpoint`), and F9 does the same for the caret's line
// while the code is editable (debugging gives F9 to To Settled). The
// editor only draws what it is told (`setBreakpoints`) — a solid red circle
// where the number was, or a hollow one on a line nothing can stop at.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { highlightRuns, runAt } from "../hdl/highlight.js";

/** The indent Tab inserts — two spaces, the Verilog convention. */
const INDENT = "  ";

export class HdlEditor {
  #root;
  #gutter;
  #code;
  #input;
  #lineMark;
  #runs = [];
  #names = { pins: [], signals: [] };
  #diagnostics = [];
  #current = null; // {start, end, line} the debugger is paused at
  #linked = null; // {name, bit} lit from the package
  #breakpoints = new Set(); // lines with a breakpoint
  #reachable = new Set(); // lines a breakpoint can stop at
  #charW = 0;
  #lineH = 0;
  #hovered = null;
  #onInput;
  #onHover;
  #onToggleBreakpoint;

  /**
   * @param {object} [opts]
   * @param {(text: string) => void} [opts.onInput] - the user changed the text.
   * @param {(run: {name: string, bit: number|null, cls: string}|null) => void}
   *   [opts.onHover] - the identifier under the pointer changed.
   * @param {(line: number) => void} [opts.onToggleBreakpoint] - a line's
   *   number was clicked (or F9 pressed on it).
   * @param {string} [opts.label] - the textarea's accessible name.
   */
  constructor({ onInput, onHover, onToggleBreakpoint, label = "" } = {}) {
    this.#onInput = onInput;
    this.#onHover = onHover;
    this.#onToggleBreakpoint = onToggleBreakpoint;
    this.#gutter = el("div", { class: "hdl-editor-gutter", "aria-hidden": "true" }); // prettier-ignore
    // One listener for every number: a row is rebuilt on each render.
    this.#gutter.addEventListener("click", (e) => {
      const row = e.target.closest?.(".hdl-editor-lineno");
      const line = Number(row?.dataset.line);
      if (Number.isInteger(line) && line > 0) this.#onToggleBreakpoint?.(line);
    });
    this.#code = el("pre", { class: "hdl-editor-code", "aria-hidden": "true" });
    this.#lineMark = el("div", { class: "hdl-editor-line", hidden: true });
    this.#input = el("textarea", {
      class: "hdl-editor-input",
      spellcheck: false,
      autocomplete: "off",
      autocapitalize: "off",
      wrap: "off",
      "aria-label": label,
    });
    this.#input.setAttribute("autocorrect", "off");
    this.#input.addEventListener("input", () => {
      this.#render();
      this.#onInput?.(this.#input.value);
    });
    this.#input.addEventListener("scroll", () => this.#syncScroll());
    this.#input.addEventListener("keydown", (e) => this.#onKeyDown(e));
    this.#input.addEventListener("mousemove", (e) => this.#onMouseMove(e));
    this.#input.addEventListener("mouseleave", () => this.#hover(null));
    const stack = el("div", { class: "hdl-editor-stack" }, [
      this.#lineMark,
      this.#code,
      this.#input,
    ]);
    this.#root = el("div", { class: "hdl-editor" }, [this.#gutter, stack]);
  }

  get element() {
    return this.#root;
  }

  get value() {
    return this.#input.value;
  }

  /** Replace the text (keeping the caret where it was, as far as it goes). */
  setValue(text) {
    const value = String(text ?? "");
    if (value === this.#input.value) return;
    const { selectionStart, selectionEnd } = this.#input;
    this.#input.value = value;
    const at = Math.min(selectionStart ?? 0, value.length);
    this.#input.setSelectionRange(at, Math.min(selectionEnd ?? at, value.length)); // prettier-ignore
    this.#render();
  }

  /** Read-only while the circuit runs (the debugger shows, never edits). */
  setReadOnly(on) {
    if (this.#input.readOnly === Boolean(on)) return;
    this.#input.readOnly = Boolean(on);
    this.#root.classList.toggle("hdl-editor--readonly", Boolean(on));
    this.#renderGutter(this.#input.value); // F9 is the gutter's only while editable
  }

  /** Is the user typing in it right now? */
  get focused() {
    return document.activeElement === this.#input;
  }

  /** The names it colours as pins (ports) and as the body's own signals. */
  setNames({ pins = [], signals = [] } = {}) {
    this.#names = { pins, signals };
    this.#render();
  }

  /** Underline these (compiler diagnostics on this body). */
  setDiagnostics(list) {
    this.#diagnostics = (list ?? []).filter((d) => d.line > 0);
    this.#render();
  }

  /** Mark the statement the debugger is paused at (null: none), and bring
      it into view. */
  setCurrent(loc) {
    this.#current = loc ?? null;
    this.#render();
    if (loc) this.#reveal(loc.line);
  }

  /**
   * The lines with a breakpoint, and the lines a breakpoint can stop at — one
   * on any other line is drawn hollow.
   * @param {Iterable<number>} lines
   * @param {Iterable<number>} reachable
   */
  setBreakpoints(lines, reachable) {
    const next = new Set(lines ?? []);
    const can = new Set(reachable ?? []);
    const same = (a, b) => a.size === b.size && [...a].every((n) => b.has(n));
    if (same(next, this.#breakpoints) && same(can, this.#reachable)) return;
    this.#breakpoints = next;
    this.#reachable = can;
    this.#renderGutter(this.#input.value);
  }

  /** Light every reference to a pin (from a hover on the package). */
  setLinked(name, bit = null) {
    const next = name ? { name, bit } : null;
    if (JSON.stringify(next) === JSON.stringify(this.#linked)) return;
    this.#linked = next;
    this.#render();
  }

  /** Put the caret on a line (a diagnostic clicked). */
  goToLine(line) {
    const lines = this.#input.value.split("\n");
    let offset = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) {
      offset += lines[i].length + 1;
    }
    this.#input.focus();
    this.#input.setSelectionRange(offset, offset);
    this.#reveal(line);
  }

  /** Re-measure the monospace grid (after a font-size change). */
  refreshMetrics() {
    this.#charW = 0;
    this.#lineH = 0;
    this.#render();
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  #render() {
    const text = this.#input.value;
    this.#runs = highlightRuns(text, this.#names);
    // Decorations over the token colours: a diagnostic's range, the paused
    // statement, a linked pin's references.
    const deco = [];
    for (const d of this.#diagnostics) {
      const end = d.end > d.start ? d.end : d.start + 1;
      deco.push({ start: d.start, end, cls: `hdl-tok--${d.severity === "warning" ? "warn" : "error"}` }); // prettier-ignore
    }
    if (this.#current) {
      deco.push({ start: this.#current.start, end: this.#current.end, cls: "hdl-tok--current" }); // prettier-ignore
    }
    if (this.#linked) {
      for (const r of this.#runs) {
        if (r.name !== this.#linked.name) continue;
        if (this.#linked.bit != null && r.bit != null && r.bit !== this.#linked.bit) continue; // prettier-ignore
        deco.push({ start: r.start, end: r.end, cls: "hdl-tok--linked" });
      }
    }
    // Cut the text at every boundary any run or decoration has.
    const cuts = new Set([0, text.length]);
    for (const r of this.#runs) cuts.add(r.start).add(r.end);
    for (const d of deco) cuts.add(Math.min(d.start, text.length)).add(Math.min(d.end, text.length)); // prettier-ignore
    const points = [...cuts].sort((a, b) => a - b);
    const frag = document.createDocumentFragment();
    let ri = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a === b) continue;
      while (ri < this.#runs.length && this.#runs[ri].end <= a) ri++;
      const run = this.#runs[ri] && this.#runs[ri].start <= a ? this.#runs[ri] : null; // prettier-ignore
      const classes = [];
      if (run) classes.push(`hdl-tok--${run.cls}`);
      for (const d of deco) if (d.start <= a && d.end >= b) classes.push(d.cls);
      const piece = text.slice(a, b);
      frag.append(classes.length ? el("span", { class: classes.join(" "), text: piece }) : document.createTextNode(piece)); // prettier-ignore
    }
    // A trailing newline needs something after it, or the last line has no
    // height and the overlay drifts from the textarea.
    frag.append(document.createTextNode("\n"));
    this.#code.replaceChildren(frag);
    this.#renderGutter(text);
    this.#placeLineMark();
    this.#syncScroll();
  }

  #renderGutter(text) {
    const lines = text.split("\n").length;
    const marked = new Map();
    for (const d of this.#diagnostics) {
      if (marked.get(d.line) !== "error") marked.set(d.line, d.severity === "warning" ? "warn" : "error"); // prettier-ignore
    }
    const rows = [];
    for (let n = 1; n <= lines; n++) {
      const mark = marked.get(n);
      const bp = this.#breakpoints.has(n)
        ? this.#reachable.has(n)
          ? "break"
          : "break-idle"
        : null;
      rows.push(
        el("div", {
          class: [
            "hdl-editor-lineno",
            mark ? `hdl-editor-lineno--${mark}` : "",
            this.#current?.line === n ? "hdl-editor-lineno--current" : "",
            bp ? `hdl-editor-lineno--${bp}` : "",
          ]
            .filter(Boolean)
            .join(" "),
          text: String(n),
          title: this.#onToggleBreakpoint
            ? t(bp === "break" ? "chipdesign.code.breakpointRemove" : bp ? "chipdesign.code.breakpointIdle" : this.#input.readOnly ? "chipdesign.code.breakpointAddClick" : "chipdesign.code.breakpointAdd") // prettier-ignore
            : null,
          dataset: { line: String(n) },
        }),
      );
    }
    this.#gutter.replaceChildren(...rows);
  }

  #placeLineMark() {
    if (!this.#current) {
      this.#lineMark.hidden = true;
      return;
    }
    this.#measure();
    this.#lineMark.hidden = false;
    this.#lineMark.style.top = `${(this.#current.line - 1) * this.#lineH + this.#padTop()}px`; // prettier-ignore
    this.#lineMark.style.height = `${this.#lineH}px`;
  }

  #syncScroll() {
    const { scrollTop, scrollLeft } = this.#input;
    this.#code.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    this.#lineMark.style.transform = `translateY(${-scrollTop}px)`;
    this.#gutter.scrollTop = scrollTop;
  }

  #reveal(line) {
    this.#measure();
    if (!this.#lineH) return;
    const top = (line - 1) * this.#lineH;
    const view = this.#input.clientHeight;
    if (
      top < this.#input.scrollTop ||
      top + this.#lineH > this.#input.scrollTop + view
    ) {
      // prettier-ignore
      this.#input.scrollTop = Math.max(0, top - view / 3);
    }
  }

  // ── Pointer → identifier ────────────────────────────────────────────────

  #padTop() {
    return parseFloat(getComputedStyle(this.#input).paddingTop) || 0;
  }

  #measure() {
    if (this.#charW && this.#lineH) return;
    const style = getComputedStyle(this.#input);
    const probe = el("span", { text: "0".repeat(40) });
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};`;
    document.body.append(probe);
    this.#charW = probe.getBoundingClientRect().width / 40 || 0;
    probe.remove();
    this.#lineH = parseFloat(style.lineHeight) || 0;
  }

  #onMouseMove(e) {
    this.#measure();
    if (!this.#charW || !this.#lineH) return;
    const rect = this.#input.getBoundingClientRect();
    const style = getComputedStyle(this.#input);
    const x = e.clientX - rect.left - (parseFloat(style.paddingLeft) || 0) + this.#input.scrollLeft; // prettier-ignore
    const y = e.clientY - rect.top - this.#padTop() + this.#input.scrollTop;
    const line = Math.floor(y / this.#lineH);
    const col = Math.floor(x / this.#charW);
    const lines = this.#input.value.split("\n");
    if (
      line < 0 ||
      line >= lines.length ||
      col < 0 ||
      col >= lines[line].length
    ) {
      // prettier-ignore
      this.#hover(null);
      return;
    }
    let offset = col;
    for (let i = 0; i < line; i++) offset += lines[i].length + 1;
    const run = runAt(this.#runs, offset);
    this.#hover(run?.name ? run : null);
  }

  #hover(run) {
    const key = run ? `${run.start}` : null;
    if (key === this.#hovered) return;
    this.#hovered = key;
    this.#onHover?.(run ? { name: run.name, bit: run.bit ?? null, cls: run.cls } : null); // prettier-ignore
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  #onKeyDown(e) {
    // F9 sets a breakpoint on the caret's line — while editable only: while
    // debugging (read-only) F9 is the debugger bar's To Settled, and the key
    // bubbles on to it.
    if (
      e.key === "F9" &&
      !this.#input.readOnly &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      e.preventDefault();
      const caret = this.#input.selectionStart ?? 0;
      const line = this.#input.value.slice(0, caret).split("\n").length;
      this.#onToggleBreakpoint?.(line);
      return;
    }
    if (this.#input.readOnly) return;
    const ta = this.#input;
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) return; // no outdent: keep Shift+Tab for focus order
      this.#insert(INDENT);
      return;
    }
    if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Keep the line's indentation.
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.slice(before.lastIndexOf("\n") + 1);
      const indent = /^[ \t]*/.exec(line)[0];
      e.preventDefault();
      this.#insert(`\n${indent}`);
    }
  }

  /** Insert at the caret the way typing would (undoable where the platform
      supports it). */
  #insert(text) {
    const ta = this.#input;
    ta.focus();
    const ok = typeof document.execCommand === "function" && document.execCommand("insertText", false, text); // prettier-ignore
    if (!ok) {
      const { selectionStart: a, selectionEnd: b } = ta;
      ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
      ta.setSelectionRange(a + text.length, a + text.length);
      ta.dispatchEvent(new Event("input"));
    }
  }
}
