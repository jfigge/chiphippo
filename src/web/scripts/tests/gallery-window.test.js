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
    settings: { get: async () => ({}) },
    project: { recent: { details: async () => [], remove: async () => {} } },
    gallery,
  };
  await import(`../gallery-window.js?boot=${++boots}`);
  await settle();
  await settle();
  return { closed: () => closed };
}

const counting = (over = {}) => {
  const asked = { index: 0, thumb: [], entry: [], open: [] };
  const gallery = {
    index: async () => (asked.index++, { ok: true, index: INDEX }),
    thumb: async (id) => (asked.thumb.push(id), { ok: true, url: "data:image/png;base64,AAAA" }), // prettier-ignore
    entry: async (id) => (asked.entry.push(id), { ok: true, entry: { ...INDEX.entries.find((e) => e.id === id), description: "about" } }), // prettier-ignore
    open: async (id) => (asked.open.push(id), true),
    askAccess: async () => {},
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

test("an Open main refuses (access withdrawn) redraws the tab: the Allow… card", async () => {
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
  assert.ok(document.querySelector("#browse-pane-gallery .browse-access"), "the Allow… card"); // prettier-ignore
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
    settings: { get: async () => ({}) },
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
  assert.ok(document.querySelector("#browse-pane-gallery .browse-access"));
  answers[0]({ ok: true, index: INDEX }); // the slow first read lands last
  await settle();
  await settle();
  assert.ok(document.querySelector("#browse-pane-gallery .browse-access"), "still the Allow… card"); // prettier-ignore
  assert.equal(cards().length, 0);
});
