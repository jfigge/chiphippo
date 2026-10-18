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

// terminal-view.js — the Terminal window's drawing (Feature 420): a header
// naming the adapter and its line, the screen, and the keyboard. Thin: the
// screen is kept by the main renderer (components/terminal-bridge.js), which
// sends the lines that changed; keys and pastes go back as bytes and text.
// Every key is the far end's while the circuit runs — Escape included, which
// sends ESC rather than closing the window — except a ⌘ chord, the app's.

import { t } from "../i18n.js";
import { keyBytes } from "../model/terminal-screen.js";

/** How long a BEL flashes the screen, ms. */
const BELL_MS = 150;

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

export class TerminalView {
  #root;
  #send;
  #title;
  #status;
  #screen;
  #rows = []; // one element per screen line
  #texts = []; // each line's text
  #cursorRow = null; // the line the cursor is drawn in
  #cursor;
  #state = null;
  #bells = 0;

  /**
   * @param {HTMLElement} root
   * @param {{send: (msg: object) => void}} opts
   */
  constructor(root, { send }) {
    this.#root = root;
    this.#send = send;
    root.classList.add("terminal-window");
    const head = el("div", "terminal-head");
    this.#title = el("span", "terminal-title", t("window.terminal"));
    this.#status = el("span", "terminal-status");
    const clear = el("button", "btn terminal-clear", t("terminal.clear"));
    clear.type = "button";
    clear.addEventListener("click", () => this.#send({ kind: "clear" }));
    head.append(this.#title, this.#status, clear);
    this.#screen = el("div", "terminal-screen");
    this.#screen.tabIndex = 0;
    this.#screen.setAttribute("role", "log");
    this.#screen.setAttribute("aria-live", "off");
    this.#cursor = el("span", "terminal-cursor", " ");
    root.append(head, this.#screen);
    document.addEventListener("keydown", (e) => this.#onKey(e));
    // A paste (⌘V, or the Edit menu's Paste) is typed, as a terminal's is.
    document.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text || !this.#state?.running) return;
      e.preventDefault();
      this.#send({ kind: "paste", text });
    });
    this.#screen.focus();
    this.#render();
  }

  /** A message from the main renderer. */
  receive(msg) {
    if (msg?.kind === "state") {
      this.#state = msg;
      this.#render();
    } else if (msg?.kind === "screen") {
      this.#draw(msg);
    }
  }

  #render() {
    const s = this.#state;
    const name = s?.id ?? "";
    this.#title.textContent = s?.line
      ? `${t("window.terminal")} — ${name} · ${s.line}${s.flow === "rtscts" ? " · RTS/CTS" : ""}` // prettier-ignore
      : t("window.terminal");
    document.title = this.#title.textContent;
    const status = !s?.present
      ? t("terminal.gone")
      : s.running
        ? ""
        : t("terminal.stopped");
    this.#status.textContent = status;
    this.#root.classList.toggle("terminal-window--idle", !s?.running);
    this.#screen.style.setProperty("--terminal-columns", String(s?.columns ?? 80)); // prettier-ignore
  }

  #onKey(e) {
    const s = this.#state;
    if (!s?.running || e.isComposing) return;
    // A key on the Clear button presses it.
    if (e.target instanceof HTMLButtonElement) return;
    const bytes = keyBytes(e, s);
    if (!bytes) return;
    e.preventDefault();
    if (bytes.length) this.#send({ kind: "keys", bytes });
  }

  /** Lay the changed lines in, from `from` on, and keep the bottom in view
      when it was there. */
  #draw({ from, lines, count, col, bells }) {
    const atBottom =
      this.#screen.scrollTop + this.#screen.clientHeight >=
      this.#screen.scrollHeight - 4;
    while (this.#rows.length > count) this.#rows.pop().remove();
    this.#texts.length = Math.min(this.#texts.length, count);
    lines.forEach((text, i) => {
      const row = from + i;
      let node = this.#rows[row];
      if (!node) {
        node = el("div", "terminal-line");
        this.#rows[row] = node;
        this.#screen.append(node);
      }
      this.#texts[row] = text;
      node.textContent = text;
    });
    // The cursor stands on the last line, at its column: the line it stood
    // on before gets its whole text back first.
    const row = count - 1;
    if (this.#cursorRow != null && this.#cursorRow !== row) {
      const was = this.#rows[this.#cursorRow];
      if (was) was.textContent = this.#texts[this.#cursorRow] ?? "";
    }
    const last = this.#rows[row];
    if (last) {
      const text = this.#texts[row] ?? "";
      last.textContent = text.slice(0, col);
      this.#cursor.textContent = text[col] ?? " ";
      last.append(this.#cursor, document.createTextNode(text.slice(col + 1)));
      this.#cursorRow = row;
    }
    if (bells > this.#bells) this.#ring();
    this.#bells = bells;
    if (atBottom) this.#screen.scrollTop = this.#screen.scrollHeight;
  }

  #ring() {
    this.#screen.classList.add("terminal-screen--bell");
    setTimeout(() => this.#screen.classList.remove("terminal-screen--bell"), BELL_MS); // prettier-ignore
  }
}
