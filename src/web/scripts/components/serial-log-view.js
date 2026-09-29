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

// serial-log-view.js — the body of a CONNECTION WINDOW
// (docs/chiphippo-connection-window.md): one monospace stream of everything
// that happened on a connection — the device's log output AND the frames
// going back and forth — in the order it happened, so cause and effect read
// down the page. What each line says is model/connection-stream.js's.
//
// Under the stream, one thin FOOTER row:
//
//   [✓] Log  [✓] Data  [ ] Protocol      [ ] Timestamps      Clear  Save…
//
// The filters and the timestamp column are a VIEW: every line is always
// captured, and a toggle shows or hides it — live, lines already there
// included — by a class on the list, never by rebuilding it. Protocol ERRORS
// are always shown, whatever the filters say: they are rare, and exactly what
// someone is looking for when something is wrong. Both settings are
// remembered per connection (reported through `onViewChange`; main keeps
// them by the connection's name).
//
// A run CLEARS the stream as it begins (main's doing — a push arrives with
// `reset`); after Stop it stays to be read. The partial last line of log text
// sits at the bottom, a log line like any other. The view FOLLOWS the tail
// only while the user is at the bottom: scroll up to read something and new
// lines stop dragging it away.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import {
  FILTERED_KINDS,
  formatEntry,
  streamFile,
} from "../model/connection-stream.js";

/** The DOM keeps at most this many rows, dropping the oldest — main's stream
    keeps the same many (app/serial/connection-stream.js's MAX_ENTRIES, held
    equal by a test). The window never grows with the log: it scrolls. */
export const MAX_ROWS = 2000;

/** How close to the bottom (px) still counts as "at the bottom". */
const TAIL_SLACK = 16;

/** How long a Save… result stays in the footer (ms). */
const NOTE_MS = 5000;

/** What a window shows before it has been told anything. */
export const VIEW_DEFAULTS = Object.freeze({
  log: true,
  data: true,
  protocol: false,
  timestamps: false,
});

export class SerialLogView {
  #list;
  #partial;
  #scroller;
  #empty;
  #note;
  #footer;
  #noteTimer = null;
  #t0 = null;
  #entries = []; // every entry the window holds, for Save…
  #partialText = "";
  #view = { ...VIEW_DEFAULTS };
  #boxes = new Map(); // "log"|"data"|"protocol"|"timestamps" → checkbox
  #onViewChange;
  #onSave;

  /**
   * @param {HTMLElement} root
   * @param {object} [opts]
   * @param {() => void} [opts.onClear]
   * @param {(text: string) => Promise<{ok: boolean, path?: string,
   *   error?: string}|null>} [opts.onSave] - write the stream's text to a
   *   file the user picks; null when they cancelled
   * @param {(view: object) => void} [opts.onViewChange]
   * @param {object} [opts.view] - the remembered filters and timestamps
   */
  constructor(root, { onClear, onSave, onViewChange, view } = {}) {
    this.#onViewChange = onViewChange;
    this.#onSave = onSave;
    this.#list = el("div", { class: "serial-log-lines" });
    this.#partial = el("div", {
      class: "serial-log-line serial-log-line--log serial-log-partial",
      hidden: true,
    });
    // A blank window reads as broken; this says what will arrive, and where
    // from, until something does.
    this.#empty = el("p", {
      class: "serial-log-empty",
      text: t("integration.log.empty"),
    });
    this.#scroller = el("div", { class: "serial-log-scroll" }, [
      this.#empty,
      this.#list,
      this.#partial,
    ]);
    const toggle = (key, label, title) => {
      const box = el("input", {
        type: "checkbox",
        onChange: (e) => this.#setView({ [key]: e.target.checked }),
      });
      this.#boxes.set(key, box);
      return el("label", { class: "serial-log-toggle", title }, [box, label]);
    };
    this.#note = el("span", { class: "serial-log-note", role: "status" });
    // The checkboxes hold the left edge together; the note takes the slack
    // between them and the two buttons, which hold the right.
    const footer = el("div", { class: "serial-log-footer" }, [
      ...FILTERED_KINDS.map((kind) =>
        toggle(
          kind,
          t(`integration.log.filter.${kind}`),
          t(`integration.log.filterTitle.${kind}`),
        ),
      ),
      toggle(
        "timestamps",
        t("integration.log.timestamps"),
        t("integration.log.timestampsTitle"),
      ),
      el("span", { class: "serial-log-gap" }, [this.#note]),
      el("button", {
        type: "button",
        class: "settings-action serial-log-clear",
        text: t("common.clear"),
        onClick: () => onClear?.(),
      }),
      el("button", {
        type: "button",
        class: "settings-action serial-log-save",
        text: t("integration.log.save"),
        onClick: () => void this.#save(),
      }),
    ]);
    this.#footer = footer;
    root.replaceChildren(this.#scroller, footer);
    this.#applyView({ ...VIEW_DEFAULTS, ...(view ?? {}) });
  }

  /** The connection's name, titling the window. */
  setName(name) {
    document.title = name;
  }

  /** Replace everything (the window opening, a run starting, a Clear). */
  reset(entries, partial, t0 = null) {
    this.#list.replaceChildren();
    this.#entries = [];
    this.#t0 = t0;
    this.append(entries, partial);
  }

  /** Add entries at the bottom, following the tail only if already there. */
  append(entries, partial) {
    const s = this.#scroller;
    const atBottom =
      s.scrollHeight - s.scrollTop - s.clientHeight <= TAIL_SLACK;
    for (const entry of entries ?? []) {
      const row = this.#row(entry);
      if (!row) continue;
      this.#list.append(row);
      this.#entries.push(entry);
    }
    const excess = this.#list.childElementCount - MAX_ROWS;
    for (let i = 0; i < excess; i++) this.#list.firstElementChild?.remove();
    if (excess > 0) this.#entries.splice(0, excess);
    this.#partialText = partial ?? "";
    this.#fill(this.#partial, {
      kind: "log",
      time: "",
      prefix: "",
      text: this.#partialText,
    });
    this.#partial.hidden = !this.#partialText;
    this.#empty.hidden = this.#entries.length > 0 || !!this.#partialText;
    if (atBottom) s.scrollTop = s.scrollHeight;
  }

  /**
   * The narrowest the window can be with its footer whole: every checkbox and
   * button at its own width, the slack between them closed up. The font size
   * and the language both move it, so it is measured rather than typed.
   */
  get minWidth() {
    const style = getComputedStyle(this.#footer);
    const px = (v) => parseFloat(v) || 0;
    const items = [...this.#footer.children];
    let width =
      px(style.paddingLeft) +
      px(style.paddingRight) +
      px(style.columnGap) * Math.max(0, items.length - 1);
    for (const item of items) {
      if (item.classList.contains("serial-log-gap")) continue;
      width += item.getBoundingClientRect().width;
    }
    return Math.ceil(width);
  }

  /** The filters and timestamps as they are now. */
  get view() {
    return { ...this.#view };
  }

  /** Every row's text (prefix and all), for tests. */
  get lines() {
    return [...this.#list.children].map((row) =>
      [...row.children]
        .map((c) => c.textContent)
        .filter(Boolean)
        .join(" "),
    );
  }

  // ── Rows ─────────────────────────────────────────────────────────────────

  #row(entry) {
    const line = formatEntry(entry, this.#t0);
    if (!line.kind) return null;
    const row = el("div", {});
    this.#fill(row, line);
    // Hover a data line to see the bytes as they went on the wire.
    if (line.raw) row.title = line.raw;
    return row;
  }

  #fill(row, line) {
    row.className = [
      "serial-log-line",
      `serial-log-line--${line.kind}`,
      line.dir ? `serial-log-line--${line.dir}` : "",
      row === this.#partial ? "serial-log-partial" : "",
    ]
      .filter(Boolean)
      .join(" ");
    row.replaceChildren(
      el("span", { class: "serial-log-time", text: line.time }),
      el("span", { class: "serial-log-prefix", text: line.prefix }),
      el("span", { class: "serial-log-text", text: line.text }),
    );
  }

  // ── The footer ───────────────────────────────────────────────────────────

  #setView(patch) {
    this.#applyView({ ...this.#view, ...patch });
    this.#onViewChange?.(this.view);
  }

  /** A class on the scroller — so a toggle is instant, whatever the length,
      and reaches the partial line too. */
  #applyView(view) {
    this.#view = { ...view };
    for (const [key, box] of this.#boxes) box.checked = this.#view[key];
    for (const kind of FILTERED_KINDS) {
      this.#scroller.classList.toggle(
        `serial-log--hide-${kind}`,
        !this.#view[kind],
      );
    }
    this.#scroller.classList.toggle("serial-log--times", this.#view.timestamps);
  }

  async #save() {
    const text = streamFile(this.#entries, {
      t0: this.#t0,
      partial: this.#partialText,
    });
    let r = null;
    try {
      r = await this.#onSave?.(text);
    } catch (err) {
      r = { ok: false, error: String(err?.message ?? err) };
    }
    if (!r) return; // the Save panel was cancelled
    this.#say(
      r.ok
        ? t("integration.log.saved", { path: r.path ?? "" })
        : t("integration.log.saveFailed", { error: r.error ?? "" }),
    );
  }

  #say(text) {
    this.#note.textContent = text;
    this.#note.title = text;
    clearTimeout(this.#noteTimer);
    this.#noteTimer = setTimeout(() => {
      this.#note.textContent = "";
      this.#note.title = "";
    }, NOTE_MS);
  }
}
