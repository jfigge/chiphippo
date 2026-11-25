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

// The Browse window's own wiring (gallery-window.js), booted over a stubbed
// bridge: each entry's picture and text asked of main once per window, an
// Open main refuses redrawing the tab (the Allow… card), the window's Escape
// standing aside for the detail pane's, and a slow load never drawing over
// a newer one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resetDom } from "./jsdom-setup.js";

const EN = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../locales/en.json"), "utf8")); // prettier-ignore
const settle = () => new Promise((r) => setTimeout(r, 0));

const INDEX = {
  schema: 1,
  entries: [
    { id: "a-000001", title: "Blinker", author: "Ada", tags: [], featured: false, derived: { level: "beginner", engine: "logic", autoTags: [], chips: 1, parts: 5 } }, // prettier-ignore
    { id: "b-000002", title: "Siren", author: "Grace", tags: [], featured: false, derived: { level: "beginner", engine: "logic", autoTags: [], chips: 2, parts: 9 } }, // prettier-ignore
  ],
};

let boots = 0;
/** Boot gallery-window.js on the Gallery tab over `gallery` (the bridge's). */
async function boot(gallery) {
  resetDom();
  window.history.replaceState(null, "", "/gallery.html?tab=gallery");
  global.location = window.location;
  document.body.innerHTML = '<div id="gallery-root"></div>';
  let closed = 0;
  window.close = () => closed++;
  window.chiphippo = {
    i18n: { load: async () => ({ active: "en", lang: "en", messages: EN, fallback: EN, locales: ["en"] }) }, // prettier-ignore
    settings: { get: async () => ({ galleryAccess: "yes" }) },
    project: { recent: { details: async () => [], remove: async () => {} } },
    gallery,
  };
  await import(`../gallery-window.js?boot=${++boots}`);
  await settle();
  await settle();
  return { closed: () => closed };
}

const counting = (over = {}) => {
  const asked = { index: 0, thumb: [], themes: [], entry: [], open: [] };
  const gallery = {
    index: async () => (asked.index++, { ok: true, index: INDEX }),
    thumb: async (id, theme) => (asked.thumb.push(id), asked.themes.push(`${theme}:${id}`), { ok: true, url: `data:image/png;base64,${theme}` }), // prettier-ignore
    entry: async (id) => (asked.entry.push(id), { ok: true, entry: { ...INDEX.entries.find((e) => e.id === id), description: "about" } }), // prettier-ignore
    open: async (id) => (asked.open.push(id), true),
    openRecent: async () => {},
    ...over,
  };
  return { gallery, asked };
};

const cards = () => [...document.querySelectorAll("#browse-pane-gallery .gallery-card")]; // prettier-ignore
const search = (text) => {
  const box = document.querySelector("#browse-pane-gallery .gallery-search");
  box.value = text;
  box.dispatchEvent(new window.Event("input"));
};

test("each card's picture is asked of main once, however often the grid redraws", async () => {
  const { gallery, asked } = counting();
  await boot(gallery);
  assert.equal(cards().length, 2);
  assert.deepEqual(asked.thumb.sort(), ["a-000001", "b-000002"]);
  for (const text of ["b", "bl", "bli", "", "s"]) search(text);
  await settle();
  assert.equal(asked.thumb.length, 2, "five redraws, no new downloads");
  // Opening a card's detail reuses its picture; its text is asked once.
  search("");
  cards()[0].click();
  await settle();
  cards()[0].click();
  await settle();
  assert.equal(asked.thumb.length, 2);
  assert.equal(asked.entry.length, 1);
});

test("the pictures follow the window's appearance, swapped in place when it changes", async () => {
  const { gallery, asked } = counting();
  await boot(gallery);
  const srcs = () => [...document.querySelectorAll("#browse-pane-gallery .gallery-card img")].map((i) => i.src); // prettier-ignore
  // No data-theme and no light preference: the dark desk (the app's default).
  assert.deepEqual(asked.themes.sort(), ["dark:a-000001", "dark:b-000002"]);
  assert.deepEqual(srcs(), ["data:image/png;base64,dark", "data:image/png;base64,dark"]); // prettier-ignore
  document.documentElement.dataset.theme = "light";
  await settle();
  await settle();
  assert.deepEqual(asked.themes.slice(2).sort(), ["light:a-000001", "light:b-000002"]); // prettier-ignore
  assert.deepEqual(srcs(), ["data:image/png;base64,light", "data:image/png;base64,light"]); // prettier-ignore
  assert.equal(cards().length, 2, "the grid itself is not redrawn");
  // Back to dark: each picture is already here.
  document.documentElement.dataset.theme = "dark";
  await settle();
  await settle();
  assert.equal(asked.themes.length, 4);
  assert.deepEqual(srcs(), ["data:image/png;base64,dark", "data:image/png;base64,dark"]); // prettier-ignore
});

test("a picture that failed is asked for again; one that came is not", async () => {
  let fail = true;
  const { gallery, asked } = counting({
    thumb: async (id) => (asked.thumb.push(id), fail ? { ok: false, code: "unavailable" } : { ok: true, url: "data:image/png;base64,AAAA" }), // prettier-ignore
  });
  await boot(gallery);
  assert.equal(asked.thumb.length, 2);
  fail = false;
  search("x");
  search("");
  await settle();
  assert.equal(asked.thumb.length, 4, "failures are not kept");
  search("x");
  search("");
  await settle();
  assert.equal(asked.thumb.length, 4, "successes are");
});

test("an Open main refuses (access withdrawn) takes the Gallery tab away, back to Recent", async () => {
  let refused = false;
  const { gallery, asked } = counting();
  gallery.index = async () => (asked.index++, refused ? { ok: false, code: "refused" } : { ok: true, index: INDEX }); // prettier-ignore
  gallery.open = async () => ((refused = true), false);
  await boot(gallery);
  cards()[0].click();
  await settle();
  document.querySelector('#browse-pane-gallery [data-action="open"]').click();
  await settle();
  await settle();
  const tab = (key) => document.querySelector(`[aria-controls="browse-pane-${key}"]`); // prettier-ignore
  assert.equal(tab("gallery").hidden, true, "the tab is gone");
  assert.equal(tab("recent").getAttribute("aria-selected"), "true");
  assert.equal(document.querySelector(".browse-access"), null, "no card offering to turn it on"); // prettier-ignore
  assert.equal(cards().length, 0);
});

test("Escape in the detail goes back to the grid; with no detail open it closes the window", async () => {
  const { gallery } = counting();
  const win = await boot(gallery);
  cards()[0].click();
  await settle();
  const esc = () => new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); // prettier-ignore
  document.querySelector(".gallery-detail-close").dispatchEvent(esc());
  assert.equal(document.querySelector(".gallery-detail").hidden, true);
  assert.equal(win.closed(), 0, "the window stays");
  document.body.dispatchEvent(esc());
  assert.equal(win.closed(), 1);
});

test("a slow index read never draws over a newer answer", async () => {
  const answers = [];
  const { gallery } = counting({ index: () => new Promise((r) => answers.push(r)) }); // prettier-ignore
  gallery.open = async () => false;
  // First load in flight (slow); boot returns before it lands.
  resetDom();
  window.history.replaceState(null, "", "/gallery.html?tab=gallery");
  global.location = window.location;
  document.body.innerHTML = '<div id="gallery-root"></div>';
  window.chiphippo = {
    i18n: { load: async () => ({ active: "en", lang: "en", messages: EN, fallback: EN, locales: ["en"] }) }, // prettier-ignore
    settings: { get: async () => ({ galleryAccess: "yes" }) },
    project: { recent: { details: async () => [] } },
    gallery,
  };
  await import(`../gallery-window.js?boot=${++boots}`);
  await settle();
  assert.equal(answers.length, 1);
  // The tab is shown again (access just asked for): a second load starts and
  // answers "refused" at once.
  window.dispatchEvent(new window.CustomEvent("chiphippo:browse-tab", { detail: "recent" })); // prettier-ignore
  window.dispatchEvent(new window.CustomEvent("chiphippo:browse-tab", { detail: "gallery" })); // prettier-ignore
  await settle();
  assert.equal(answers.length, 2);
  answers[1]({ ok: false, code: "refused" });
  await settle();
  const galleryTab = () => document.querySelector('[aria-controls="browse-pane-gallery"]'); // prettier-ignore
  assert.equal(galleryTab().hidden, true, "refused: the tab is gone");
  answers[0]({ ok: true, index: INDEX }); // the slow first read lands last
  await settle();
  await settle();
  assert.equal(galleryTab().hidden, true, "still gone");
  assert.equal(cards().length, 0);
});

test("with Gallery access off — or never answered — there is no Gallery tab, and nothing offers to turn it on", async () => {
  for (const stored of [{ galleryAccess: "no" }, {}]) {
    const { gallery, asked } = counting();
    resetDom();
    window.history.replaceState(null, "", "/gallery.html?tab=gallery");
    global.location = window.location;
    document.body.innerHTML = '<div id="gallery-root"></div>';
    window.chiphippo = {
      i18n: { load: async () => ({ active: "en", lang: "en", messages: EN, fallback: EN, locales: ["en"] }) }, // prettier-ignore
      settings: { get: async () => stored },
      project: { recent: { details: async () => [], remove: async () => {} } },
      gallery,
    };
    await import(`../gallery-window.js?boot=${++boots}`);
    await settle();
    await settle();
    const tab = (key) => document.querySelector(`[aria-controls="browse-pane-${key}"]`); // prettier-ignore
    assert.equal(tab("gallery").hidden, true, JSON.stringify(stored));
    assert.equal(tab("recent").getAttribute("aria-selected"), "true", "asked for the Gallery, opened on Recent"); // prettier-ignore
    assert.equal(asked.index, 0, "the gallery is never read");
    assert.equal(document.querySelector(".browse-access"), null);
    // Access switched on in Settings: the tab is back when the window comes forward.
    stored.galleryAccess = "yes";
    window.dispatchEvent(new window.Event("focus"));
    await settle();
    assert.equal(tab("gallery").hidden, false);
  }
});

test("each private store has its own tab, after the fixed two, in the stores' own order", async () => {
  const { gallery } = counting();
  let stores = [
    { id: "s-1111111111111111", name: "Bench club", kind: "folder", path: "/x/Bench club" }, // prettier-ignore
    { id: "s-2222222222222222", name: "Lab", kind: "github", repo: "ann/site", dir: "chiphippo" }, // prettier-ignore
  ];
  const viewed = [];
  resetDom();
  window.history.replaceState(null, "", "/gallery.html?tab=stores:s-2222222222222222"); // prettier-ignore
  global.location = window.location;
  document.body.innerHTML = '<div id="gallery-root"></div>';
  window.chiphippo = {
    i18n: { load: async () => ({ active: "en", lang: "en", messages: EN, fallback: EN, locales: ["en"] }) }, // prettier-ignore
    settings: { get: async () => ({ galleryAccess: "yes" }) },
    project: { recent: { details: async () => [], remove: async () => {} } },
    gallery,
    stores: {
      status: async () => ({ enabled: true }),
      list: async () => stores,
      view: async (id) => (viewed.push(id), { ok: true, entries: [] }),
      thumb: async () => ({ ok: false }),
      open: async () => true,
    },
  };
  await import(`../gallery-window.js?boot=${++boots}`);
  await settle();
  await settle();
  const labels = () => [...document.querySelectorAll(".browse-tab")].filter((b) => !b.hidden).map((b) => b.textContent); // prettier-ignore
  assert.deepEqual(labels(), [
    "Recent Projects",
    "Gallery",
    "Bench club",
    "Lab",
  ]);
  const selected = () => document.querySelector('.browse-tab[aria-selected="true"]').textContent; // prettier-ignore
  assert.equal(selected(), "Lab", "opened on the store it was asked for");
  assert.deepEqual(viewed, ["s-2222222222222222"]);
  assert.equal(document.querySelector(".browse-tab[title='ann/site/chiphippo']").textContent, "Lab"); // prettier-ignore
  // Brought forward after Settings removed Lab and added another: the tabs
  // follow, the order kept, and the window goes back to Recent.
  stores = [stores[0], { id: "s-3333333333333333", name: "Club 2", kind: "folder", path: "/y" }]; // prettier-ignore
  window.dispatchEvent(new window.Event("focus"));
  await settle();
  await settle();
  assert.deepEqual(labels(), ["Recent Projects", "Gallery", "Bench club", "Club 2"]); // prettier-ignore
  assert.equal(selected(), "Recent Projects");
  // A push naming a store opens its tab.
  window.dispatchEvent(new window.CustomEvent("chiphippo:browse-tab", { detail: "stores:s-1111111111111111" })); // prettier-ignore
  await settle();
  await settle();
  assert.equal(selected(), "Bench club");
});
