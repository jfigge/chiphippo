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

// protocol-doc-button.js — the book icon that opens the SERIAL PROTOCOL
// reference: top right of the two cards that are about a board's serial link
// (Settings ▸ Serial I/O and the Generate card), left of their close (×),
// through `PopupManager.dialog`'s `headerActions`.
//
// The reference is a USER-GUIDE PAGE (src/web/docs/serial-protocol.md), not a
// window of its own: one Markdown source is the in-app guide, the website and
// the PDF, and the protocol document is normative for the code as well — so
// there is exactly one copy of it anywhere. The button asks main to open the
// guide ON that page (`docs:open`), which turns a guide already open rather
// than opening a second. It never closes the card it sits on: the guide is a
// separate OS window, read beside the settings it explains.

import { el } from "../dom.js";
import { t } from "../i18n.js";

/** The guide page the button opens — a slug `docs-pages.js` lists. */
export const PROTOCOL_PAGE = "serial-protocol";

/** An open book, line-drawn — a reference to read, where the Serial I/O tab's
    own circled "?" already means "click again to delete". */
const BOOK_SVG =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
  'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/>' +
  '<path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>';

/**
 * The header button. Pure DOM + the bridge it is handed.
 * @param {object} [bridge] - window.chiphippo (its `docs.open`).
 * @returns {HTMLButtonElement}
 */
export function protocolDocButton(bridge) {
  const label = t("integration.protocolDoc");
  const btn = el("button", {
    class: "popup-header-btn",
    type: "button",
    title: label,
    "aria-label": label,
    onClick: () => {
      Promise.resolve(bridge?.docs?.open?.(PROTOCOL_PAGE)).catch((err) =>
        console.error("[renderer] docs:open failed:", err),
      );
    },
  });
  btn.innerHTML = BOOK_SVG;
  return btn;
}
