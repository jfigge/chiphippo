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
  return guidePageButton(bridge, PROTOCOL_PAGE, t("integration.protocolDoc"));
}

/**
 * The same book button, opening the guide on any page — the export report
 * card (Feature 390) points at "Exporting to Other Tools" with it.
 * @param {object} [bridge] - window.chiphippo (its `docs.open`).
 * @param {string} page - a slug `docs-pages.js` lists.
 * @param {string} label - the button's tooltip and accessible name.
 * @returns {HTMLButtonElement}
 */
export function guidePageButton(bridge, page, label) {
  const btn = el("button", {
    class: "popup-header-btn",
    type: "button",
    title: label,
    "aria-label": label,
    onClick: () => {
      Promise.resolve(bridge?.docs?.open?.(page)).catch((err) =>
        console.error("[renderer] docs:open failed:", err),
      );
    },
  });
  btn.innerHTML = BOOK_SVG;
  return btn;
}
