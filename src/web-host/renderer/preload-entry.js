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

// preload-entry.js — the web build's preload, loaded as the first script of
// every page (scripts/build-web.mjs puts it there). It runs app/preload.js
// itself — the same bridge, channel for channel — and then does what the
// Electron shell would have done around the page: hands keys the page let go
// by to the application menu, and a right-click to a window whose main side
// wants it (the pin-assignments window's menu).

import { connection } from "./electron.js";

// What the page can count on here, for the few places the web differs
// (src/web/scripts/web-flavour.js reads it).
Object.defineProperty(window, "chiphippoWeb", {
  value: Object.freeze({
    fsAccess: typeof window.showOpenFilePicker === "function",
    serial: Boolean(window.navigator?.serial),
  }),
  enumerable: true,
});

require("../../app/preload.js");

const keyInfo = (e) => ({
  key: e.key,
  code: e.code,
  metaKey: e.metaKey,
  ctrlKey: e.ctrlKey,
  altKey: e.altKey,
  shiftKey: e.shiftKey,
  repeat: e.repeat,
  defaultPrevented: e.defaultPrevented,
});

// Registered once the page's own scripts have registered theirs, so a page
// that handles a chord itself (preventDefault) keeps it — the order a native
// menu takes a key equivalent in.
window.addEventListener(
  "load",
  () => {
    window.addEventListener("keydown", (e) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey || e.altKey)) return;
      const link = connectionNow();
      if (link?.keydown(keyInfo(e))) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    window.addEventListener("contextmenu", (e) => {
      if (e.defaultPrevented) return;
      const link = connectionNow();
      if (link?.contextmenu({ x: e.clientX, y: e.clientY })) e.preventDefault();
    });
  },
  { once: true },
);

let resolved = null;
connection.then((link) => {
  resolved = link;
});

/** The connection if it is up — a key needs an answer synchronously. */
function connectionNow() {
  return resolved;
}
