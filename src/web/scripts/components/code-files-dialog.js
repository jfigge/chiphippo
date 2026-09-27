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

// code-files-dialog.js — a read-only look at generated source files: one tab
// per file, each shown as a line-numbered listing, and a Copy for the file on
// show. Generate's "View files…" opens it on a connection's ChipHippo.h and
// the example sketch that uses it.
//
// A listing is a TABLE, a row per line — the number in one cell, the code in
// the other — so a long line scrolls with its number rather than wrapping
// under it, and the numbers stay out of a selection (`user-select: none`).
// Copy takes the file's own text, never the table's.
//
// It knows nothing about Arduino or headers: files in, a popup out. The file
// NAMES are the tabs' labels and are not translated — they are names.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";

/** One file as a line-numbered table. */
function listing(text) {
  const lines = String(text ?? "")
    .replace(/\n$/, "")
    .split("\n");
  return el(
    "table",
    { class: "code-files-listing" },
    el(
      "tbody",
      {},
      lines.map((line, i) =>
        el("tr", {}, [
          el("td", { class: "code-files-number", text: String(i + 1) }),
          el("td", { class: "code-files-code", text: line }),
        ]),
      ),
    ),
  );
}

export class CodeFilesDialog {
  static #open = false;

  /**
   * @param {object} opts
   * @param {string} opts.title
   * @param {Array<{name: string, text: string}>} opts.files — one tab each,
   *   in order; the first is showing.
   * @param {() => void} [opts.onClose] — however it was dismissed.
   */
  static open({ title, files, onClose }) {
    if (CodeFilesDialog.#open || !files?.length) return;
    CodeFilesDialog.#open = true;

    let active = 0;
    const panels = files.map((f, i) =>
      el(
        "div",
        {
          class: "code-files-panel",
          id: `code-files-panel-${i}`,
          role: "tabpanel",
          hidden: i !== active,
        },
        listing(f.text),
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
      say.textContent = "";
    };

    const copy = el("button", {
      class: "btn popup-btn btn--secondary",
      type: "button",
      text: t("integration.generate.copy"),
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(files[active].text);
          say.textContent = t("integration.generate.copiedFile", {
            name: files[active].name,
          });
        } catch {
          say.textContent = t("integration.generate.copyFailed");
        }
      },
    });

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
        el("div", { class: "code-files-footer" }, [say, copy]),
      ],
      onClose: () => {
        CodeFilesDialog.#open = false;
        onClose?.();
      },
    });
  }
}
