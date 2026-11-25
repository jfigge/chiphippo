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

// Desktop ▸ Share To… (components/share-to.js) in jsdom: one card, a
// Public | Private switch over ONE set of fields, which side it opens on,
// what each side adds and what it says when it cannot share, the switch held
// while a share is on its way — and the web build's Share to Gallery card
// when there are no private stores.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resetDom } from "./jsdom-setup.js";
import { shareTo } from "../components/share-to.js";
import { preferGalleryTab } from "../components/settings-gallery-panel.js";
import { PopupManager } from "../popup-manager.js";

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const DOC = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../demos/74LS00.json"), "utf8"), // prettier-ignore
).doc;
const STORE = { id: "s-0123456789abcdef", name: "Bench club", kind: "folder", provider: "dropbox" }; // prettier-ignore
const ENTRY = "led-chaser-3fa9c1";
const REV_A = "20261122T100000Z-aaaaaaaaaa";

const card = () => document.querySelector(".share-to-popup");
const title = () => document.querySelector(".popup-title")?.textContent ?? "";
const side = (key) => document.querySelector(`.share-to-switch [data-value="${key}"]`); // prettier-ignore
const btn = (label, root = document) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label && !b.closest(OFF)); // prettier-ignore
/** The labels of the fields showing, top to bottom. */
const shown = () =>
  [...card().querySelectorAll(".gallery-share-field")]
    .filter((f) => !f.closest(OFF))
    .map((f) => f.querySelector(".popup-label").textContent);
const COMMON = ["Title", "Your name", "Description", "Tags"];
/** What is not showing: hidden, or the side the switch is not on. */
const OFF = "[hidden], .share-to-side--off";
const store = () => card().querySelector(".store-save-store");
const inputs = () => [...card().querySelectorAll(".popup-body > .gallery-share-field")].map((f) => f.querySelector("input, textarea")); // prettier-ignore
const notes = () => [...card().querySelectorAll(".share-to-side")].filter((b) => !b.closest(OFF)).map((b) => b.textContent).join(" "); // prettier-ignore

function deps({
  settings = {},
  stores = [STORE],
  storeFrom = null,
  privateEnabled = true,
  share,
} = {}) {
  // prettier-ignore
  const calls = { shared: [], saved: [], opened: [], pictures: 0 };
  const all = { galleryShare: "yes", galleryAuthor: "Ada", ...settings };
  return {
    calls,
    privateEnabled,
    bridge: {
      gallery: { share: share ?? (async (payload) => (calls.shared.push(payload), { ok: true, id: "gates-abcdef", number: 4, key: "a".repeat(64) })) }, // prettier-ignore
      stores: {
        list: async () => stores,
        view: async () => ({ ok: true, entries: [{ id: ENTRY, title: "LED chaser", head: { rev: REV_A }, leaves: [{ rev: REV_A }], revs: [] }] }), // prettier-ignore
        save: async (p) => (calls.saved.push(p), { ok: true, entry: ENTRY, rev: "r2" }), // prettier-ignore
      },
    },
    tabId: "t1",
    desktop: { name: "Gates", description: "", doc: DOC, customChips: [] },
    storeFrom,
    setStoreFrom: () => {},
    openRevision: () => {},
    settings: () => all,
    saveSettings: async (p) => Object.assign(all, p),
    openSettings: (tab) => calls.opened.push(tab),
    isRunning: () => false,
    takePicture: async () => (calls.pictures++, "tok"),
  };
}

test("one card: the switch turns the Store picker on, and the four fields never move", async () => {
  resetDom();
  preferGalleryTab("public");
  const d = deps();
  const run = shareTo(d);
  await settle();
  assert.equal(title(), "Share To");
  assert.equal(side("public").getAttribute("aria-checked"), "true");
  assert.deepEqual(shown(), COMMON);
  assert.equal(store().disabled, true, "the store is greyed on Public");
  assert.ok(btn("Share Publicly", card()));
  assert.equal(btn("Save", card()), undefined);
  assert.match(notes(), /Ready to share/);
  assert.equal(d.calls.pictures, 1, "the picture is taken before the card");
  const before = [...card().querySelector(".popup-body").children];
  side("private").click();
  assert.deepEqual([...card().querySelector(".popup-body").children], before, "nothing added or taken away above the notes"); // prettier-ignore
  assert.deepEqual(shown(), COMMON);
  assert.equal(store().disabled, false);
  assert.ok(btn("Save", card()));
  assert.equal(btn("Share Publicly", card()), undefined);
  assert.match(notes(), /Only people the store is shared with/);
  assert.doesNotMatch(notes(), /Ready to share/);
  btn("Cancel", card()).click();
  assert.deepEqual(await run, { public: null, private: null });

  // The side last shown is the side the next card (and Settings) opens on.
  resetDom();
  const again = shareTo(deps());
  await settle();
  assert.equal(side("private").getAttribute("aria-checked"), "true");
  PopupManager.close();
  await again;
});

test("what is typed stays when the switch is flipped — it is one set of fields", async () => {
  resetDom();
  preferGalleryTab("public");
  const d = deps();
  const run = shareTo(d);
  await settle();
  const [name, , description] = inputs();
  name.value = "NAND sampler";
  name.dispatchEvent(new window.Event("input"));
  description.value = "Four NANDs.";
  description.dispatchEvent(new window.Event("input"));
  side("private").click();
  btn("Save", card()).click();
  await settle();
  assert.equal(d.calls.saved[0].fields.title, "NAND sampler");
  assert.equal(d.calls.saved[0].fields.description, "Four NANDs.");
  PopupManager.close(); // the "Saved" note
  await run;
});

test("a desktop opened from a store opens on Private: the design's own title, words and tags, greyed, and only your name asked", async () => {
  resetDom();
  preferGalleryTab("public");
  const run = shareTo(deps({ storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A } })); // prettier-ignore
  await settle();
  assert.equal(side("private").getAttribute("aria-checked"), "true");
  assert.match(card().textContent, /A new version of “LED chaser”/);
  assert.deepEqual(shown(), [...COMMON, "What changed? (optional)"]);
  const [name, author, description, tags] = inputs();
  assert.equal(name.value, "LED chaser");
  assert.deepEqual([name.disabled, author.disabled, description.disabled, tags.disabled], [true, false, true, true]); // prettier-ignore
  assert.equal(card().querySelector("[data-autofocus]:not(.popup-close)"), author, "the name takes the focus"); // prettier-ignore
  // A press on Private, already on, leaves them greyed.
  side("private").click();
  assert.deepEqual([name.disabled, author.disabled, description.disabled, tags.disabled], [true, false, true, true]); // prettier-ignore
  // On Public the desktop's own words are back, to be edited.
  side("public").click();
  assert.equal(name.value, "Gates");
  assert.equal(name.disabled, false);
  assert.deepEqual(shown(), COMMON);
  PopupManager.close();
  await run;
});

test("Public shares from the card; the switch is held while it is on its way", async () => {
  resetDom();
  preferGalleryTab("public");
  let answer;
  const d = deps({ share: () => new Promise((r) => (answer = () => r({ ok: true, id: "gates-abcdef", number: 4, key: "a".repeat(64) }))) }); // prettier-ignore
  const run = shareTo(d);
  await settle();
  btn("Share Publicly", card()).click();
  await settle();
  assert.equal(side("private").disabled, true);
  answer();
  await settle();
  assert.equal(title(), "Sent for review");
  PopupManager.close();
  assert.deepEqual(await run, { public: "gates-abcdef", private: null });
});

test("no store yet, or sharing switched off: that side says so instead of the fields, and points at Settings ▸ Gallery", async () => {
  resetDom();
  preferGalleryTab("private");
  const d = deps({ stores: [], settings: { galleryShare: "no" } });
  const run = shareTo(d);
  await settle();
  assert.equal(d.calls.pictures, 0, "no store, no picture");
  assert.match(notes(), /Add a private store first/);
  assert.deepEqual(shown(), COMMON, "the fields stay where they are");
  assert.ok(
    inputs().every((f) => f.disabled),
    "greyed",
  );
  assert.equal(store().disabled, true);
  assert.equal(btn("Save", card()), undefined);
  side("public").click();
  assert.match(notes(), /Share consent is set to No/);
  assert.ok(inputs().every((f) => f.disabled));
  assert.equal(btn("Share Publicly", card()), undefined);
  btn("Open Settings", card()).click();
  await run;
  assert.deepEqual(d.calls.opened, ["gallery"]);
});

test("without the private stores (the web build) it is Share to Gallery's own card", async () => {
  resetDom();
  const run = shareTo(deps({ privateEnabled: false }));
  await settle();
  assert.equal(title(), "Share to Gallery");
  assert.equal(document.querySelector(".share-to-switch"), null);
  PopupManager.close();
  assert.deepEqual(await run, { public: null, private: null });
});

test("on a linked desktop, another store can only take a new design, and coming back offers the version again", async () => {
  resetDom();
  const OTHER = { ...STORE, id: "s-fedcba9876543210", name: "Robotics" };
  const run = shareTo(deps({ stores: [STORE, OTHER], storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A } })); // prettier-ignore
  await settle();
  const [version, fresh] = card().querySelectorAll(".store-save-mode input");
  assert.equal(version.checked, true);
  store().value = OTHER.id;
  store().dispatchEvent(new window.Event("change"));
  assert.equal(fresh.checked, true);
  assert.equal(version.disabled, true);
  assert.equal(inputs()[0].disabled, false, "a new design's title is asked");
  store().value = STORE.id;
  store().dispatchEvent(new window.Event("change"));
  assert.equal(version.checked, true);
  assert.equal(inputs()[0].disabled, true);
  PopupManager.close();
  await run;
});

test("flipping off a new version to Public judges what was TYPED, not the entry's words it showed", async () => {
  resetDom();
  preferGalleryTab("public");
  const d = deps({ storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A } });
  let answer;
  d.bridge.stores.view = () => new Promise((r) => (answer = r));
  const run = shareTo(d);
  await settle();
  // While the entry is still being read, a tag that cannot be used is typed…
  const tags = inputs()[3];
  tags.value = "not a tag!";
  tags.dispatchEvent(new window.Event("input"));
  // …then the entry arrives (its own good tags shown, greyed) and Public is picked.
  answer({ ok: true, entries: [{ id: ENTRY, title: "LED chaser", tags: ["555"], head: { rev: REV_A }, leaves: [{ rev: REV_A }], revs: [] }] }); // prettier-ignore
  await settle();
  side("public").click();
  assert.equal(tags.value, "not a tag!");
  assert.equal(
    btn("Share Publicly", card()).disabled,
    true,
    "the typed tag is judged",
  );
  PopupManager.close();
  await run;
});

test("a public share that FAILS after Cancel is said — silence would read as sent", async () => {
  resetDom();
  preferGalleryTab("public");
  let answer;
  const d = deps({ share: () => new Promise((r) => (answer = r)) });
  const run = shareTo(d);
  await settle();
  btn("Share Publicly", card()).click();
  await settle();
  btn("Cancel", card()).click();
  await settle();
  answer({ ok: false, code: "unavailable" });
  await settle();
  assert.equal(title(), "Not sent");
  PopupManager.close();
  await run;
});
