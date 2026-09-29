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

// code-files-dialog.js — a read-only TEXT VIEW of generated source files: one
// tab per file, each a line-numbered listing, with Copy and Save As… for the
// file on show. Generate opens it on a connection's file and the example
// program(s) that use it.
//
// A listing is two <pre>s side by side — the line numbers in a gutter pinned
// to the left edge, the file's text beside it — so a long line scrolls under
// its number rather than wrapping, and the text is ONE run a selection can
// sweep as in any text view. The gutter, like the rest of the card, is out of
// every selection (`user-select: none`), so what is highlighted is exactly
// what is copied.
//
// COPY MEANS THE SELECTION, OR THE WHOLE FILE. The button and the key (⌘C /
// Ctrl+C) both take the part of the selection inside the file on show, or
// the whole file when nothing is selected — so copying it needs no Select All
// first. Select All (⌘A / Ctrl+A, or Edit ▸ Select All) selects that file's
// text and nothing else. The card is modal, so both keys are its own while it
// is up: they are caught on the DOCUMENT (a click on the text can leave the
// focus on <body>, outside the card) and preventDefault'ed, which is what
// stops the native menu's Copy and Select All running after them. A copy
// made from the Edit MENU (no key) still goes through the `copy` event, and
// is held to the same file.
//
// SAVE AS… hands the file on show to the caller's `onSave`, which owns where
// it goes (Generate's remembers where each file was last saved). Without an
// `onSave` there is no Save As.
//
// It knows nothing about Arduino or headers: files in, a popup out. The file
// NAMES are the tabs' labels and are not translated — they are names.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";

const IS_MAC = globalThis.window?.chiphippo?.platform === "darwin";

/** One file as a gutter of line numbers beside its text. */
function listing(text) {
  const body = String(text ?? "").replace(/\n$/, "");
  const count = body.split("\n").length;
  const numbers = Array.from({ length: count }, (_, i) => i + 1).join("\n");
  const code = el("pre", { class: "code-files-code", text: body });
  return {
    code,
    node: el("div", { class: "code-files-listing" }, [
      el("pre", {
        class: "code-files-gutter",
        "aria-hidden": "true",
        text: numbers,
      }),
      code,
    ]),
  };
}

/**
 * The part of the document's selection that lies inside `node`, as text —
 * "" when the selection is empty or elsewhere. A selection that strays past
 * the listing is cut back to it.
 */
function selectionWithin(node) {
  const sel = node.ownerDocument.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0).cloneRange();
  if (!range.intersectsNode(node)) return "";
  const whole = node.ownerDocument.createRange();
  whole.selectNodeContents(node);
  if (range.compareBoundaryPoints(range.START_TO_START, whole) < 0) {
    range.setStart(whole.startContainer, whole.startOffset);
  }
  if (range.compareBoundaryPoints(range.END_TO_END, whole) > 0) {
    range.setEnd(whole.endContainer, whole.endOffset);
  }
  return range.toString();
}

export class CodeFilesDialog {
  static #open = false;

  /**
   * @param {object} opts
   * @param {string} opts.title
   * @param {Array<{name: string, text: string}>} opts.files — one tab each,
   *   in order; the first is showing.
   * @param {(file: {name: string, text: string}) =>
   *   Promise<{ok: boolean, path?: string, error?: string}|null>} [opts.onSave]
   *   — Save As… for the file on show; null is the Save panel cancelled.
   * @param {() => void} [opts.onClose] — however it was dismissed.
   */
  static open({ title, files, onSave, onClose }) {
    if (CodeFilesDialog.#open || !files?.length) return;
    CodeFilesDialog.#open = true;

    let active = 0;
    const listings = files.map((f) => listing(f.text));
    const panels = listings.map((l, i) =>
      el(
        "div",
        {
          class: "code-files-panel",
          id: `code-files-panel-${i}`,
          role: "tabpanel",
          "aria-labelledby": `code-files-tab-${i}`,
          tabindex: "0",
          hidden: i !== active,
        },
        l.node,
      ),
    );
    const say = el("p", { class: "code-files-result", role: "status" });
    const tabs = files.map((f, i) =>
      el("button", {
        class: "code-files-tab",
        type: "button",
        role: "tab",
        id: `code-files-tab-${i}`,
        "aria-controls": `code-files-panel-${i}`,
        "aria-selected": String(i === active),
        text: f.name,
        onClick: () => show(i),
      }),
    );
    const show = (i) => {
      active = i;
      tabs.forEach((tab, n) =>
        tab.setAttribute("aria-selected", String(n === i)),
      );
      panels.forEach((panel, n) => (panel.hidden = n !== i));
      // A selection in the file just left would otherwise sit there unseen.
      document.getSelection()?.removeAllRanges();
      say.textContent = "";
    };

    // The keys are the viewer's only while it is ON SCREEN — not while it
    // waits in PopupManager's queue behind another card.
    const showing = () => panels[0].isConnected;

    const selectAll = () => {
      if (!showing()) return;
      const range = document.createRange();
      range.selectNodeContents(listings[active].code);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    };

    /** What Copy takes: the selection in the file on show, or the file.
        A selection of ALL its text is the file itself — the listing drops
        the final newline, and a copy must not. */
    const copyText = () => {
      const { code } = listings[active];
      const part = selectionWithin(code);
      return part && part !== code.textContent ? part : files[active].text;
    };

    const copy = async () => {
      const file = files[active];
      const text = copyText();
      try {
        await navigator.clipboard.writeText(text);
        say.textContent =
          text === file.text
            ? t("integration.generate.copiedFile", { name: file.name })
            : t("integration.generate.copiedSelection");
      } catch {
        say.textContent = t("integration.generate.copyFailed");
      }
    };

    const onKeyDown = (e) => {
      if (!showing()) return;
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === "a") {
        e.preventDefault();
        selectAll();
      } else if (key === "c") {
        e.preventDefault();
        void copy();
      }
    };
    // Edit ▸ Copy clicked in the menu: the native copy, held to the file.
    const onCopyEvent = (e) => {
      if (!showing() || !e.clipboardData) return;
      if (!selectionWithin(listings[active].code)) return;
      e.clipboardData.setData("text/plain", copyText());
      e.preventDefault();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("copy", onCopyEvent, true);
    // Edit ▸ Select All clicked in the menu arrives as this push.
    window.addEventListener("chiphippo:edit-select-all", selectAll);

    const copyBtn = el("button", {
      class: "btn popup-btn btn--secondary",
      type: "button",
      text: t("integration.generate.copy"),
      onClick: () => void copy(),
    });
    const saveBtn = onSave
      ? el("button", {
          class: "btn popup-btn btn--primary",
          type: "button",
          text: t("integration.generate.saveAs"),
          onClick: async () => {
            const file = files[active];
            let r = null;
            try {
              r = await onSave(file);
            } catch (err) {
              r = { ok: false, error: String(err?.message ?? err) };
            }
            if (!r) return; // the Save panel was cancelled
            say.textContent = r.ok
              ? t("integration.generate.saved", { path: r.path ?? "" })
              : t("integration.generate.failed", { error: r.error ?? "" });
          },
        })
      : null;

    PopupManager.dialog({
      title,
      closeAriaLabel: t("common.close"),
      className: "code-files-popup",
      bodyClass: "code-files-body",
      body: [
        el(
          "div",
          {
            class: "code-files-tabs",
            role: "tablist",
            "aria-label": t("integration.generate.files"),
          },
          tabs,
        ),
        el("div", { class: "code-files-panels" }, panels),
        el(
          "div",
          { class: "code-files-footer" },
          saveBtn ? [say, copyBtn, saveBtn] : [say, copyBtn],
        ),
      ],
      onClose: () => {
        CodeFilesDialog.#open = false;
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("copy", onCopyEvent, true);
        window.removeEventListener("chiphippo:edit-select-all", selectAll);
        onClose?.();
      },
    });
  }
}
