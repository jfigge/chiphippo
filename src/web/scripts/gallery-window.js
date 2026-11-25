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
//     ONLY WHILE GALLERY ACCESS IS ON (Jason, 2026-11-22): with it off — or
//     never answered — the tab is not there at all, and nothing here offers
//     to turn it on; that is Settings ▸ Gallery's. The web build is always
//     on. Read again whenever the window comes forward, and main refusing a
//     read (access withdrawn meanwhile) takes the tab away too.
//
//   · ONE TAB PER PRIVATE STORE (the private stores, desktop app only),
//     after these two, named for the store, in the order Settings ▸
//     Gallery ▸ Private lists them (the order they were added — a manual
//     order may come later; nothing here reorders them). Each is drawn by the
//     same GalleryView over what main reads from it (`stores.view`), each
//     entry's revisions listed in its detail; Open hands a revision to the
//     app window (`stores.open`). The strip scrolls sideways when the tabs
//     outgrow the window. The list is read again whenever the window comes
//     forward (a store added in Settings appears, one removed goes).
//
// Main checks the MRU list and the access setting on every call; this window
// only draws.

import * as i18n from "./i18n.js";
import { t, formatDate } from "./i18n.js";
import { el } from "./dom.js";
import { followFontSize } from "./font-scale.js";
import { GalleryView } from "./gallery/gallery-view.js";
import { normalizeIndex } from "./gallery/index-format.js";
import { entryPageUrl, normalizeEntry } from "./gallery/entry-format.js";
import { RecentProjectsView } from "./components/recent-projects-view.js";
import { STORE_ID_RE } from "./stores/store-format.js";
import { isWeb } from "./web-flavour.js";
import { storeError } from "./components/store-setup.js";

const bridge = window.chiphippo;

await i18n.init();
await followFontSize(bridge);
document.title = t("browse.title");

// A tab per private store, only while main says the stores are on.
const storesOn = (await bridge.stores?.status?.().catch(() => null))?.enabled === true; // prettier-ignore
/** The tabs, in order: the two fixed ones, then one per store
    (`store:<id>`), kept in step with the stores by `syncStoreTabs`. */
const TABS = ["recent", "gallery"];

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
/** Make one tab and its pane (not yet in the document). */
function makeTab(key, label) {
  const id = `browse-pane-${key.replace(":", "-")}`;
  panes[key] = el("div", { class: "browse-pane", role: "tabpanel", id });
  tabButtons[key] = el("button", {
    class: "browse-tab",
    type: "button",
    role: "tab",
    "aria-controls": id,
    text: label,
    onClick: () => show(key),
  });
}
for (const key of TABS) makeTab(key, t(`browse.tab.${key}`));
tabList.append(...TABS.map((k) => tabButtons[k]));
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
/** Each load's number: an answer that is not the latest's is dropped (a
    slow index read landing after a refusal drew a grid that could read
    nothing). */
let galleryLoads = 0;

// Each entry's picture and full text, asked of main ONCE for the window's
// life: the grid redraws every card on each keystroke in Search and each
// filter, and main's fetch keeps no HTTP cache, so without this every redraw
// downloaded every card's PNG again (and handed it over as base64).
const thumbs = new Map();
const entries = new Map();
const once = (cache, id, ask) => {
  if (!cache.has(id)) {
    const asked = ask();
    cache.set(id, asked);
    // A failure is not kept: the next redraw (or opening) asks again.
    Promise.resolve(asked).then(
      (value) => value == null && cache.delete(id),
      () => cache.delete(id),
    );
  }
  return cache.get(id);
};

// The appearance the window is drawn in, which picks each entry's picture
// (thumb.png on the light desk, thumb-dark.png on the dark one). theme.css's
// rule, read back: an explicit `data-theme` (the web build sets one for a
// chosen Light or Dark), else prefers-color-scheme — which in the desktop
// app IS Settings ▸ Appearance ▸ Theme (nativeTheme.themeSource).
const darkQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
const appearance = () =>
  document.documentElement.dataset.theme ??
  (darkQuery?.matches === false ? "light" : "dark");
/** The gallery's view while one is drawn — told when the appearance changes. */
let galleryView = null;
let drawnIn = appearance();
const appearanceChanged = () => {
  const now = appearance();
  if (now === drawnIn) return;
  drawnIn = now;
  galleryView?.refreshThumbs();
};
darkQuery?.addEventListener?.("change", appearanceChanged);
new window.MutationObserver(appearanceChanged).observe(
  document.documentElement,
  {
    attributes: true,
    attributeFilter: ["data-theme"],
  },
);

/** Draw the gallery tab — or, refused (access switched off meanwhile),
    take the tab away. */
async function loadGallery() {
  const load = ++galleryLoads;
  const index = await bridge.gallery.index();
  if (load !== galleryLoads) return;
  panes.gallery.replaceChildren();
  galleryView = null;
  if (index?.code === "refused") {
    galleryLoaded = false;
    setGalleryOn(false);
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
        once(entries, id, () =>
          answered(bridge.gallery.entry(id), (res) =>
            normalizeEntry(res.entry),
          ),
        ),
      // Cached per appearance, so switching back is instant.
      thumbUrl: (entry) => {
        const theme = appearance();
        return once(thumbs, `${theme}:${entry.id}`, async () => {
          const res = await bridge.gallery.thumb(entry.id, theme);
          return res?.ok ? res.url : null;
        });
      },
    },
    say: (key, params) => t(`gallery.${key}`, params),
    actions: [
      {
        id: "open",
        label: t("gallery.open"),
        // Refused (access switched to No since the grid was drawn): the tab
        // goes — not a press that does nothing.
        onClick: (entry) =>
          void Promise.resolve(bridge.gallery.open(entry.id)).then((ok) => {
            if (ok === false) {
              galleryLoaded = false;
              setGalleryOn(false);
            }
          }),
      },
      // The design's own link — the gallery page opened on it — to send
      // to someone (entry-format.js `entryPageUrl`).
      {
        id: "link",
        label: t("gallery.copyLink"),
        copy: (entry) => entryPageUrl(entry.id),
      },
      // A mail to the maintainer naming the entry (main writes it; see
      // app/gallery/sources.js `reportUrl`) — what App Store Review
      // Guideline 1.2 asks of a window showing what users published.
      {
        id: "report",
        label: t("gallery.report"),
        quiet: true,
        onClick: (entry) => void bridge.gallery.report(entry.id),
      },
    ],
  });
  galleryView = view;
  await view.load();
}

// ── Private stores ───────────────────────────────────────────────────────────
/** Each store tab's latest load (a slow read landing after a newer one
    started — a Refresh, the tab shown again — is dropped). */
const storeLoads = new Map();
const storeThumbs = new Map();
/** The store tabs drawn from a read that ARRIVED: shown again, they keep
    their search, scroll and open detail — Refresh reads afresh. */
const storeLoaded = new Set();

/** One revision's line in an entry's detail: when, who, what changed, and
    Open — the newest marked, and another version made alongside marked. */
function revisionList(id, entry) {
  const leaves = new Set(entry.leaves.map((r) => r.rev));
  return el("section", { class: "browse-store-revs" }, [
    el("h3", { class: "browse-store-revs-title", text: t("stores.browse.revisions", { count: entry.revs.length }) }), // prettier-ignore
    entry.forked &&
      el("p", { class: "browse-store-fork", text: t("stores.browse.forked", { count: entry.leaves.length }) }), // prettier-ignore
    el(
      "ol",
      { class: "browse-store-rev-list" },
      entry.revs.map((rev) =>
        el("li", { class: "browse-store-rev" }, [
          el("span", { class: "browse-store-rev-when", text: formatDate(Date.parse(rev.at), { dateStyle: "medium", timeStyle: "short" }) }), // prettier-ignore
          el("span", { class: "browse-store-rev-who", text: rev.author || t("stores.browse.someone") }), // prettier-ignore
          rev.rev === entry.head.rev
            ? el("span", { class: "browse-store-rev-tag", text: t("stores.browse.latest") }) // prettier-ignore
            : leaves.has(rev.rev) && el("span", { class: "browse-store-rev-tag browse-store-rev-tag--fork", text: t("stores.browse.otherVersion") }), // prettier-ignore
          rev.note && el("span", { class: "browse-store-rev-note", text: rev.note }), // prettier-ignore
          el("button", {
            class: "gallery-action browse-store-rev-open",
            type: "button",
            text: t("gallery.open"),
            // Each "Open" says which version it opens.
            "aria-label": t("stores.browse.openVersion", {
              when: formatDate(Date.parse(rev.at), { dateStyle: "medium", timeStyle: "short" }), // prettier-ignore
              who: rev.author || t("stores.browse.someone"),
            }),
            onClick: () => void bridge.stores.open(id, entry.id, rev.rev),
          }),
        ]),
      ),
    ),
  ]);
}

/** Draw store `id`'s tab: Refresh, then its grid. */
async function loadStore(id) {
  const key = `store:${id}`;
  const pane = panes[key];
  if (!pane) return;
  const load = (storeLoads.get(id) ?? 0) + 1;
  storeLoads.set(id, load);
  storeLoaded.delete(id);
  const refresh = el("button", {
    class: "gallery-action browse-store-refresh",
    type: "button",
    text: t("stores.browse.refresh"),
    onClick: () => void loadStore(id),
  });
  const status = el("p", { class: "gallery-status browse-store-status", role: "status", hidden: true }); // prettier-ignore
  const gridRoot = el("div");
  pane.replaceChildren(
    el("div", { class: "browse-store-bar" }, [refresh]),
    status,
    gridRoot,
  );
  const res = await bridge.stores.view(id);
  if (storeLoads.get(id) !== load || panes[key] !== pane) return;
  if (!res?.ok) {
    status.textContent = storeError(res?.code);
    status.hidden = false;
    return;
  }
  storeLoaded.add(id);
  const view = new GalleryView({
    root: gridRoot,
    source: {
      index: async () => ({ entries: res.entries }),
      entry: async (entryId) => res.entries.find((e) => e.id === entryId) ?? null, // prettier-ignore
      thumbUrl: (entry) => {
        if (!entry.head?.thumb) return null;
        const at = `${id}/${entry.id}/${entry.head.rev}`;
        return once(storeThumbs, at, async () => {
          const r = await bridge.stores.thumb(id, entry.id, entry.head.rev);
          return r?.ok ? r.url : null;
        });
      },
    },
    // The gallery's words, but for the search box and the empty grid.
    say: (word, params) =>
      word === "search" || word === "empty"
        ? t(`stores.browse.${word}`)
        : t(`gallery.${word}`, params),
    actions: [
      {
        id: "open",
        label: t("stores.browse.openLatest"),
        onClick: (entry) => void bridge.stores.open(id, entry.id, entry.head.rev), // prettier-ignore
      },
    ],
    detail: (entry) => revisionList(id, entry),
  });
  await view.load();
}

/**
 * Bring the store tabs into step with the stores this computer has added:
 * one after the fixed tabs per store, in the list's own order; a store gone
 * takes its tab with it (back to Recent if it was showing); a rename
 * relabels its tab in place.
 */
async function syncStoreTabs() {
  if (!storesOn) return;
  let stores;
  try {
    stores = (await bridge.stores.list()) ?? [];
  } catch {
    return;
  }
  const want = stores.map((st) => `store:${st.id}`);
  for (const key of TABS.filter((k) => k.startsWith("store:"))) {
    if (want.includes(key)) continue;
    tabButtons[key].remove();
    panes[key].remove();
    storeLoaded.delete(key.slice(6));
    delete tabButtons[key];
    delete panes[key];
    TABS.splice(TABS.indexOf(key), 1);
    if (current === key) show("recent");
  }
  for (const st of stores) {
    const key = `store:${st.id}`;
    if (!tabButtons[key]) {
      makeTab(key, st.name);
      tabButtons[key].hidden = false;
      panes[key].hidden = true;
      tabButtons[key].setAttribute("aria-selected", "false");
      tabButtons[key].tabIndex = -1;
      TABS.push(key);
    }
    tabButtons[key].textContent = st.name;
    tabButtons[key].title = st.kind === "github" ? (st.dir ? `${st.repo}/${st.dir}` : st.repo) : (st.path ?? ""); // prettier-ignore
  }
  // The list's order, after the two fixed tabs.
  TABS.splice(2, TABS.length - 2, ...want);
  tabList.append(...want.map((k) => tabButtons[k]));
  root.append(...want.map((k) => panes[k]));
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
let current = null;

/** Is Gallery access on? Settings ▸ Gallery's answer (main checks it again
    on every read); the web build is always on. */
async function galleryAccessOn() {
  if (isWeb()) return true;
  try {
    return (await bridge.settings.get())?.galleryAccess === "yes";
  } catch {
    return false;
  }
}

/** Show or take away the Gallery tab. Taken away while showing, the window
    goes back to Recent Projects. */
function setGalleryOn(on) {
  tabButtons.gallery.hidden = !on;
  if (!on) {
    galleryLoaded = false;
    galleryView = null;
    panes.gallery.replaceChildren();
    if (current === "gallery") show("recent");
  }
}

/** The tabs a press or an arrow key can reach now. */
const shownTabs = () => TABS.filter((k) => !tabButtons[k].hidden);

/** Show a tab. The Recent list is read again every time it is shown (a save
    or an open in the app window changes it); the gallery once, unless it was
    refused or failed — then again, since access may have been given (or the
    network come back) meanwhile. */
function show(key) {
  // Main names a store as "stores:<id>"; the tab's own key is "store:<id>".
  const [base, sub] = String(key ?? "").split(":");
  const asked = base === "stores" || base === "store" ? (STORE_ID_RE.test(sub ?? "") ? `store:${sub}` : null) : base; // prettier-ignore
  const which = shownTabs().includes(asked) ? asked : TABS[0];
  current = which;
  for (const k of TABS) {
    const on = k === which;
    panes[k].hidden = !on;
    tabButtons[k].setAttribute("aria-selected", String(on));
    tabButtons[k].classList.toggle("browse-tab--active", on);
    tabButtons[k].tabIndex = on ? 0 : -1;
  }
  // A tab scrolled out of sight in a long strip is brought into it.
  tabButtons[which].scrollIntoView?.({ block: "nearest", inline: "nearest" });
  if (which === "recent") void recent.refresh();
  // A store is read when its tab is first shown (or its last read failed);
  // after that its Refresh reads it again — a friend's save arrives through
  // their sync, not through this window.
  else if (which.startsWith("store:") && !storeLoaded.has(which.slice(6)))
    void loadStore(which.slice(6));
  else if (!galleryLoaded) void loadGallery();
}

// Arrow keys move along the tabs, as a tab list's should.
tabList.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const step = event.key === "ArrowRight" ? 1 : -1;
  const tabs = shownTabs();
  const next = tabs[(tabs.indexOf(current) + step + tabs.length) % tabs.length];
  show(next);
  tabButtons[next].focus();
});

// Main names the tab: in the address when it opens the window, by push when
// it brings an open one forward.
// The Gallery tab only with access on — asked BEFORE the first tab is shown,
// so a window opened on it without access opens on Recent instead.
setGalleryOn(await galleryAccessOn());
await syncStoreTabs();
show(new URLSearchParams(location.search).get("tab") ?? "recent");
// Brought forward on a store just added (Settings' Browse), the list is read
// first, so that store has its tab.
window.addEventListener("chiphippo:browse-tab", async (e) => {
  if (String(e.detail ?? "").startsWith("stores:")) await syncStoreTabs();
  show(e.detail);
});
// Coming back to the window (after a save in the app window, say) shows the
// recent list as it is now.
window.addEventListener("focus", () => {
  if (current === "recent") void recent.refresh();
  // Gallery access may have been changed in Settings meanwhile.
  void galleryAccessOn().then((on) => {
    if (on !== !tabButtons.gallery.hidden) setGalleryOn(on);
  });
  // …and the stores may have been added, removed or renamed there.
  void syncStoreTabs();
});

// Escape closes the window, as the guide's does.
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return; // the gallery's detail closed instead
  if (event.key === "Escape" && !event.target.closest?.("input")) {
    event.preventDefault();
    window.close();
  }
});
