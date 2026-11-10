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

// gallery-window.js — the BROWSE window (gallery.html): two tabs over one
// window, opened from File ▸ Browse Projects… and the File pill's Browse
// segment.
//
//   · RECENT PROJECTS (the default) — the projects Open Recent lists, as
//     pictures of their boards (components/recent-projects-view.js). Main reads
//     the list, the dates and the pictures; a click hands the path to the app
//     window (`browse:open-recent`), which opens it as Open Recent does.
//   · GALLERY — the grid the website draws (gallery/gallery-view.js), over
//     what MAIN reads from the gallery. This window's CSP has no connect-src,
//     so the index, each entry and each thumbnail (a data: URL) come over the
//     bridge. Its Open hands the entry to the app window (`gallery:open`).
//     Without Gallery access, main refuses every read, and the tab says why
//     with an Allow… that asks the app window to put the question.
//
// Main checks the MRU list and the access setting on every call; this window
// only draws.

import * as i18n from "./i18n.js";
import { t, formatDate } from "./i18n.js";
import { el } from "./dom.js";
import { followFontSize } from "./font-scale.js";
import { GalleryView } from "./gallery/gallery-view.js";
import { normalizeIndex } from "./gallery/index-format.js";
import { normalizeEntry } from "./gallery/entry-format.js";
import { RecentProjectsView } from "./components/recent-projects-view.js";

const bridge = window.chiphippo;
const TABS = ["recent", "gallery"];

await i18n.init();
await followFontSize(bridge);
document.title = t("browse.title");

/** A bridge answer's value, or a throw the view reports as its failure. */
const answered = async (call, pick) => {
  const res = await call;
  if (!res?.ok) throw new Error(res?.code ?? "unavailable");
  return pick(res);
};

const root = document.getElementById("gallery-root");
const tabList = el("div", {
  class: "browse-tabs",
  role: "tablist",
  "aria-label": t("browse.title"),
});
const panes = {};
const tabButtons = {};
for (const key of TABS) {
  panes[key] = el("div", {
    class: "browse-pane",
    role: "tabpanel",
    id: `browse-pane-${key}`,
  });
  tabButtons[key] = el("button", {
    class: "browse-tab",
    type: "button",
    role: "tab",
    "aria-controls": `browse-pane-${key}`,
    text: t(`browse.tab.${key}`),
    onClick: () => show(key),
  });
  tabList.append(tabButtons[key]);
}
root.append(tabList, ...TABS.map((k) => panes[k]));

// ── Recent projects ──────────────────────────────────────────────────────────
const recentRoot = el("div");
panes.recent.append(recentRoot);
const recent = new RecentProjectsView({
  root: recentRoot,
  load: () => bridge.project.recent.details(),
  say: (key, params) => t(`browse.recent.${key}`, params),
  formatDate: (ms) => formatDate(ms, { dateStyle: "medium", timeStyle: "short" }), // prettier-ignore
  onOpen: (project) => void bridge.gallery.openRecent(project.path),
  onRemove: (project) => void bridge.project.recent.remove(project.path),
});

// ── Gallery ──────────────────────────────────────────────────────────────────
let galleryLoaded = false;

/** Draw the gallery tab — or, refused, the card asking for access. */
async function loadGallery() {
  const index = await bridge.gallery.index();
  panes.gallery.replaceChildren();
  if (index?.code === "refused") {
    galleryLoaded = false;
    panes.gallery.append(
      el("section", { class: "browse-access" }, [
        el("h2", { class: "browse-access-title", text: t("browse.access.title") }), // prettier-ignore
        el("p", { class: "browse-access-message", text: t("browse.access.message") }), // prettier-ignore
        el("button", {
          class: "gallery-action",
          type: "button",
          text: t("browse.access.allow"),
          onClick: () => void bridge.gallery.askAccess(),
        }),
      ]),
    );
    return;
  }
  // Only an index that ARRIVED is kept: one that could not be read (offline,
  // the site down) is drawn as its error now and asked for again the next
  // time the tab is shown, rather than for as long as the window is open.
  galleryLoaded = index?.ok === true;
  const galleryRoot = el("div");
  panes.gallery.append(galleryRoot);
  const view = new GalleryView({
    root: galleryRoot,
    source: {
      // The index just read, then (on a reload) a fresh one.
      index: () => answered(Promise.resolve(index), (res) => normalizeIndex(res.index)), // prettier-ignore
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
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
let current = null;

/** Show a tab. The Recent list is read again every time it is shown (a save
    or an open in the app window changes it); the gallery once, unless it was
    refused or failed — then again, since access may have been given (or the
    network come back) meanwhile. */
function show(key) {
  const which = TABS.includes(key) ? key : TABS[0];
  current = which;
  for (const k of TABS) {
    const on = k === which;
    panes[k].hidden = !on;
    tabButtons[k].setAttribute("aria-selected", String(on));
    tabButtons[k].classList.toggle("browse-tab--active", on);
    tabButtons[k].tabIndex = on ? 0 : -1;
  }
  if (which === "recent") void recent.refresh();
  else if (!galleryLoaded) void loadGallery();
}

// Arrow keys move along the tabs, as a tab list's should.
tabList.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const step = event.key === "ArrowRight" ? 1 : -1;
  const next = TABS[(TABS.indexOf(current) + step + TABS.length) % TABS.length];
  show(next);
  tabButtons[next].focus();
});

// Main names the tab: in the address when it opens the window, by push when
// it brings an open one forward.
show(new URLSearchParams(location.search).get("tab") ?? "recent");
window.addEventListener("chiphippo:browse-tab", (e) => show(e.detail));
// Coming back to the window (after a save in the app window, say) shows the
// recent list as it is now.
window.addEventListener("focus", () => {
  if (current === "recent") void recent.refresh();
});

// Escape closes the window, as the guide's does.
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.target.closest?.("input")) {
    event.preventDefault();
    window.close();
  }
});
