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

// ui.js — the few cards the web host puts up itself: what a NATIVE dialog
// would have been on the desktop (a message box, a browser without the File
// System Access API being asked where to keep a project) and the one-click
// "continue" a browser demands before it opens a picker or a window that no
// click led to directly.
//
// They borrow the app's own popup classes (app.css's `.popup-dialog` /
// `.popup` / `.btn`), so a host card looks like every PopupManager card; every
// page that can show one loads app.css.

import { t } from "./strings.js";

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on"))
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const child of [children].flat(Infinity)) {
    if (child) node.append(child);
  }
  return node;
}

export { el };

/**
 * A modal card in `doc`. Resolves with the `value` of the button pressed, or
 * `cancel` for Escape / a click on the backdrop.
 *
 * @param {Document} doc
 * @param {{title?: string, message?: string, note?: string,
 *   content?: Node|Node[], buttons: Array<{label: string, value: any,
 *   primary?: boolean, danger?: boolean}>, cancel?: any,
 *   onOpen?: (card: {close: (value: any) => void, dialog: HTMLDialogElement}) => void}} opts
 */
export function modal(
  doc,
  { title, message, note, content, buttons, cancel = null, onOpen },
) {
  return new Promise((resolve) => {
    let settled = false;
    const dialog = el(doc, "dialog", { class: "popup-dialog webhost-dialog" });
    const close = (value) => {
      if (settled) return;
      settled = true;
      try {
        dialog.close();
      } catch {
        // already closed
      }
      dialog.remove();
      resolve(value);
    };
    const footer = el(
      doc,
      "div",
      { class: "popup-footer" },
      buttons.map((b) =>
        el(doc, "button", {
          class: `btn popup-btn${b.primary ? " btn--primary" : " btn--secondary"}${b.danger ? " btn--danger" : ""}`,
          type: "button",
          text: b.label,
          onClick: () => close(b.value),
        }),
      ),
    );
    const card = el(doc, "div", { class: "popup popup-confirm webhost-card" }, [
      title &&
        el(doc, "div", { class: "popup-header" }, [
          el(doc, "span", { class: "popup-title", text: title }),
        ]),
      el(doc, "div", { class: "popup-body" }, [
        message && el(doc, "p", { class: "popup-message", text: message }),
        note && el(doc, "p", { class: "popup-note", text: note }),
        content,
      ]),
      footer,
    ]);
    dialog.append(card);
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(cancel);
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) close(cancel);
    });
    doc.body.append(dialog);
    dialog.showModal();
    onOpen?.({ close, dialog });
    const primary = footer.querySelector(".btn--primary");
    if (primary && !onOpen) primary.focus();
  });
}

/** A message box: Electron's `dialog.showMessageBox`, as a card. */
export async function messageBox(doc, opts = {}) {
  const labels =
    Array.isArray(opts.buttons) && opts.buttons.length
      ? opts.buttons
      : [t("common.ok", "OK")];
  const defaultId = Number.isInteger(opts.defaultId) ? opts.defaultId : 0;
  const cancelId = Number.isInteger(opts.cancelId)
    ? opts.cancelId
    : labels.length - 1;
  const response = await modal(doc, {
    title: opts.title || opts.message,
    message: opts.title ? opts.message : undefined,
    note: opts.detail,
    buttons: labels.map((label, i) => ({
      label,
      value: i,
      primary: i === defaultId,
    })),
    cancel: cancelId,
  });
  return { response, checkboxChecked: false };
}

/**
 * The click a browser wants before it will open a picker or a window: the
 * action is retried from inside a click on the card's button. Resolves with
 * the action's result, or `null` when the card is dismissed; REJECTS with the
 * action's own failure. A cancel inside the action (a picker's AbortError) is
 * the action's to answer as `null` — anything else read as one would be a
 * Save As that failed after the visitor chose a file, saying nothing.
 */
export function continueWith(doc, { title, message, action, label }) {
  return new Promise((resolve, reject) => {
    let ran = false;
    modal(doc, {
      title,
      message,
      buttons: [
        { label: t("common.cancel", "Cancel"), value: "cancel" },
        {
          label: label ?? t("web.continue", "Continue"),
          value: "go",
          primary: true,
        },
      ],
      cancel: "cancel",
      onOpen: ({ close, dialog }) => {
        const go = dialog.querySelector(".btn--primary");
        go?.focus();
        // Run the action INSIDE the click, which is the whole point.
        go?.addEventListener(
          "click",
          (e) => {
            e.stopImmediatePropagation();
            ran = true;
            close("go");
            const failed = (err) => {
              console.error("[web] action failed:", err);
              reject(err);
            };
            try {
              Promise.resolve(action()).then(resolve, failed);
            } catch (err) {
              failed(err);
            }
          },
          { capture: true },
        );
      },
    }).then((value) => {
      if (!ran && value !== "go") resolve(null);
    });
  });
}

/** A short-lived note in the corner of `doc` (a toast the host raises). */
export function toast(doc, text, { ms = 6000 } = {}) {
  const node = el(doc, "div", { class: "webhost-toast", role: "status", text });
  doc.body.append(node);
  setTimeout(() => node.remove(), ms);
  return node;
}
