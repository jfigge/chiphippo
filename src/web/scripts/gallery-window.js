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

// gallery-window.js — the Browse Gallery window (gallery.html; the gallery
// work, behind the `gallery` feature flag). The grid the website draws
// (gallery/gallery-view.js), over what MAIN reads from the gallery — this
// window's CSP has no connect-src, so the index, each entry and each
// thumbnail (a data: URL) come over the bridge — in the app's own words.
//
// Its one action is Open: main hands the entry to the app window
// (`gallery:open` → `gallery:host-inbound`), which owns the project the
// design lands in. Main checks the flag and the Gallery access setting on
// every call; this window only draws.

import * as i18n from "./i18n.js";
import { t } from "./i18n.js";
import { followFontSize } from "./font-scale.js";
import { GalleryView } from "./gallery/gallery-view.js";
import { normalizeIndex } from "./gallery/index-format.js";
import { normalizeEntry } from "./gallery/entry-format.js";

const bridge = window.chiphippo;

await i18n.init();
await followFontSize(bridge);
document.title = t("gallery.title");

/** A bridge answer's value, or a throw the view reports as its failure. */
const answered = async (call, pick) => {
  const res = await call;
  if (!res?.ok) throw new Error(res?.code ?? "unavailable");
  return pick(res);
};

const view = new GalleryView({
  root: document.getElementById("gallery-root"),
  source: {
    index: () =>
      answered(bridge.gallery.index(), (res) => normalizeIndex(res.index)),
    entry: (id) =>
      answered(bridge.gallery.entry(id), (res) => normalizeEntry(res.entry)),
    thumbUrl: async (entry) => {
      const res = await bridge.gallery.thumb(entry.id);
      return res?.ok ? res.url : null;
    },
  },
  say: (key, params) => t(`gallery.${key}`, params),
  actions: [
    {
      id: "open",
      label: t("gallery.open"),
      onClick: (entry) => void bridge.gallery.open(entry.id),
    },
  ],
});
await view.load();

// Escape closes the window, as the guide's does.
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.target.closest?.("input")) {
    event.preventDefault();
    window.close();
  }
});
