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

// navigation-guard.js — no window of ours ever LEAVES the page it was loaded
// with. Chromium's default is to navigate a window to whatever is dropped on
// it (a `.chiphippo` dragged from Finder replaced the live desk with the
// file's raw JSON) or to a link a page follows — and every window carries
// the one preload, so a page that got in would hold the whole
// `window.chiphippo` bridge. A reload of the SAME page (the renderer's own
// `location.reload()` teardown, a pinout's query-carrying file) is the one
// navigation allowed; links are the system browser's business, through each
// window's `setWindowOpenHandler`.
//
// `isSameDocument` is pure (no Electron) so it unit-tests under node --test.

/**
 * Whether a navigation from `current` to `target` stays on the same page —
 * same scheme, host and path; query and hash may differ.
 * @param {string} current
 * @param {string} target
 */
function isSameDocument(current, target) {
  let a;
  let b;
  try {
    a = new URL(current);
    b = new URL(target);
  } catch {
    return false;
  }
  return (
    a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
  );
}

/**
 * Harden one webContents as it is created: refuse navigation off its page,
 * refuse <webview>s, and deny window.open until the window installs its own
 * handler (the main and docs windows hand http/mailto links to the system
 * browser; every other window opens nothing).
 * @param {import("electron").WebContents} contents
 */
function guardWebContents(contents) {
  contents.on("will-navigate", (event, url) => {
    if (!isSameDocument(contents.getURL(), url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isSameDocument(contents.getURL(), url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

module.exports = { isSameDocument, guardWebContents };
