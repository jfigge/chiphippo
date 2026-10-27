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

// context.js — the one place the web host's pieces find each other: the
// filesystem, storage, the visitor's files, the dialogs and the page the app
// window IS (the tab the visitor opened). host-entry.js fills it in, in order,
// before main's code starts; everything Electron-shaped reads it.

import { vfs } from "./node/fs.js";

export const ctx = {
  vfs,
  /** @type {import("./persist.js").Persist|null} */
  persist: null,
  /** @type {import("./mounts.js").Mounts|null} */
  mounts: null,
  /** @type {import("./dialogs.js").Dialogs|null} */
  dialogs: null,
  /** The tab's own window — the app window's page. */
  page: globalThis.window ?? null,
  /** Where the site lives (a relative path in the app resolves against it). */
  baseUrl: globalThis.location
    ? new URL(".", globalThis.location.href).href
    : "http://localhost/",
  /** Whether another tab already holds the app (see host-entry.js). */
  singleInstance: true,
  /** The build's version, compiled in (scripts/build-web.mjs `define`) — no
      fetch on the boot path; version.json stays for anything outside. */
  build: {
    /* global __CHIPHIPPO_VERSION__ -- replaced by esbuild's `define` */
    version:
      typeof __CHIPHIPPO_VERSION__ === "string"
        ? __CHIPHIPPO_VERSION__
        : "0.0.0",
  },
};

/** Save `bytes` as a download named `name`, from the app's tab. */
export function download(name, bytes) {
  const doc = ctx.page?.document;
  if (!doc) return;
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  const a = doc.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
