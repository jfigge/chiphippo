// gallery.js — the gallery page's own script: the shared grid
// (lib/gallery-view.js, copied from src/web/scripts/gallery/ by
// scripts/build-gallery.mjs) over this site's index.json, in English.

import { GalleryView } from "./lib/gallery-view.js";
import { normalizeIndex } from "./lib/index-format.js";
import { normalizeEntry } from "./lib/entry-format.js";

// While the gallery is behind the app's `gallery` feature flag, the web app
// opens a design only when the flag is in its address too.
const APP_FLAGS = "features=gallery";

const WORDS = {
  loading: "Loading the gallery…",
  failed: "The gallery could not be loaded. Try again in a moment.",
  empty: "Nothing matches.",
  search: "Search the gallery",
  allTags: "All tags",
  allLevels: "All levels",
  allEngines: "Both engines",
  "level.beginner": "Beginner",
  "level.intermediate": "Intermediate",
  "level.advanced": "Advanced",
  "engine.logic": "Logic",
  "engine.spice": "Spice Lite",
  by: "by {author}",
  facts: "{chips} chips · {parts} parts",
  close: "Close",
};

const say = (key, params = {}) =>
  (WORDS[key] ?? key).replace(/\{(\w+)\}/g, (_m, k) => String(params[k] ?? ""));

const json = async (url) => {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
};

const entryUrl = (id, file) => `entries/${encodeURIComponent(id)}/${file}`;

const view = new GalleryView({
  root: document.getElementById("gallery"),
  source: {
    index: async () => normalizeIndex(await json("index.json")),
    entry: async (id) => normalizeEntry(await json(entryUrl(id, "entry.json"))),
    thumbUrl: (entry) => entryUrl(entry.id, "thumb.png"),
  },
  say,
  actions: [
    {
      id: "open",
      label: "Open in browser",
      href: (entry) => `/desktop/?${APP_FLAGS}&gallery=${encodeURIComponent(entry.id)}`,
    },
    {
      id: "download",
      label: "Download",
      href: (entry) => entryUrl(entry.id, "design.desktop.chiphippo"),
      download: (entry) => `${entry.id}.desktop.chiphippo`,
    },
  ],
});
void view.load();
