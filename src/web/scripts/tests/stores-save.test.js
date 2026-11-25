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

// Desktop ▸ Share To… ▸ Private (components/store-save.js, in share-to.js's
// card) in jsdom: a new
// design, the next version of a linked one, the card waiting for that link to
// be read (and saying when it can't), the "behind" choice, and a Cancel while
// a save is on its way.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resetDom } from "./jsdom-setup.js";
import { shareTo } from "../components/share-to.js";
import { PopupManager } from "../popup-manager.js";

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const card = () => document.querySelector(".share-to-popup");
/** Share To… on its Private side (a linked desktop opens there itself). */
const saveToStore = async (deps) => {
  const run = shareTo({ ...deps, privateEnabled: true });
  await settle();
  document.querySelector('.share-to-switch [data-value="private"]')?.click();
  return (await run).private;
};
const btn = (label, root = document) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === label); // prettier-ignore
const STORE = { id: "s-0123456789abcdef", name: "Bench club", kind: "folder", provider: "dropbox" }; // prettier-ignore
const ENTRY = "led-chaser-3fa9c1";
const REV_A = "20261122T100000Z-aaaaaaaaaa";
const REV_B = "20261122T110000Z-bbbbbbbbbb";
// A real design (the 74LS00's example), so the gallery's own check passes.
const DOC = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../demos/74LS00.json"), "utf8"), // prettier-ignore
).doc;

/** The dialog's world: a bridge whose save answers what the test says. */
function world({ view, save, storeFrom = null, stores = [STORE] } = {}) {
  const sent = [];
  const linked = [];
  const opened = [];
  const settings = { galleryAuthor: "Ann" };
  const deps = {
    bridge: {
      stores: {
        list: async () => stores,
        view: view ?? (async () => ({ ok: true, entries: [{ id: ENTRY, title: "LED chaser", head: { rev: REV_A }, leaves: [{ rev: REV_A }], revs: [] }] })), // prettier-ignore
        save: async (payload) => (sent.push(payload), save ? save(payload) : { ok: true, entry: ENTRY, rev: REV_B }), // prettier-ignore
      },
    },
    tabId: "t1",
    desktop: { name: "Desktop 1", description: "", doc: DOC, customChips: [] },
    storeFrom,
    setStoreFrom: (tab, from) => linked.push([tab, from]),
    openRevision: (ref) => opened.push(ref),
    settings: () => settings,
    saveSettings: async (p) => Object.assign(settings, p),
    openSettings: () => {},
    isRunning: () => false,
    takePicture: async () => "tok",
  };
  return { deps, sent, linked, opened };
}

test("a new design: its title, your name, saved — and the desktop linked to what it wrote", async () => {
  resetDom();
  const w = world();
  const done = saveToStore(w.deps);
  await settle();
  const title = card().querySelector(
    ".popup-body > .gallery-share-field .properties-text-input",
  );
  title.value = "LED chaser";
  title.dispatchEvent(new window.Event("input"));
  btn("Save", card()).click();
  await settle();
  assert.equal(w.sent[0].entry, null);
  assert.equal(w.sent[0].fields.title, "LED chaser");
  assert.equal(w.sent[0].thumbToken, "tok");
  assert.deepEqual(w.linked, [["t1", { store: STORE.id, entry: ENTRY, rev: REV_B }]]); // prettier-ignore
  assert.deepEqual(await done, { entry: ENTRY, rev: REV_B });
  PopupManager.close(); // the "Saved" note
});

test("a linked desktop: Save waits for its entry to be read, then saves the next version from it", async () => {
  resetDom();
  let answer;
  const w = world({ storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A }, view: () => new Promise((r) => (answer = r)) }); // prettier-ignore
  void saveToStore(w.deps);
  await settle();
  const save = btn("Save", card());
  assert.equal(
    save.disabled,
    true,
    "not until the card knows what it is saving",
  );
  answer({ ok: true, entries: [{ id: ENTRY, title: "LED chaser", head: { rev: REV_A }, leaves: [{ rev: REV_A }], revs: [] }] }); // prettier-ignore
  await settle();
  assert.equal(save.disabled, false);
  assert.match(card().textContent, /A new version of “LED chaser”/);
  save.click();
  await settle();
  assert.equal(w.sent[0].entry, ENTRY);
  assert.equal(w.sent[0].base, REV_A);
  PopupManager.close();
});

test("a linked entry that can't be read is SAID, and the save is a new design", async () => {
  resetDom();
  const w = world({ storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A }, view: async () => ({ ok: false, code: "unavailable" }) }); // prettier-ignore
  void saveToStore(w.deps);
  await settle();
  assert.match(card().textContent, /saved as a new design/);
  assert.equal(
    card().querySelector(
      ".popup-body > .gallery-share-field .properties-text-input",
    ).disabled,
    false,
  );
  PopupManager.close();
});

test("behind: who saved first is said, Save steps aside, and Save Mine Alongside sends a fork", async () => {
  resetDom();
  const w = world({
    storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A },
    save: (p) => (p.fork ? { ok: true, entry: ENTRY, rev: REV_B } : { ok: false, code: "behind", head: { rev: REV_B, author: "Bob", at: "2026-11-22T11:00:00.000Z" } }), // prettier-ignore
  });
  void saveToStore(w.deps);
  await settle();
  btn("Save", card()).click();
  await settle();
  const behind = card().querySelector(".store-save-behind");
  assert.equal(behind.hidden, false);
  assert.equal(behind.getAttribute("role"), "alert");
  assert.match(behind.textContent, /Bob saved a newer version/);
  assert.equal(btn("Save", card()).hidden, true);
  assert.equal(document.activeElement, btn("Open Theirs", card()));
  btn("Save Mine Alongside", card()).click();
  await settle();
  assert.equal(w.sent.at(-1).fork, true);
  PopupManager.close();
});

test("Cancel while a save is on its way: the save still lands and is said — and closes nothing else", async () => {
  resetDom();
  let finish;
  const w = world({ save: () => new Promise((r) => (finish = r)) });
  void saveToStore(w.deps);
  await settle();
  const title = card().querySelector(
    ".popup-body > .gallery-share-field .properties-text-input",
  );
  title.value = "Gates";
  title.dispatchEvent(new window.Event("input"));
  btn("Save", card()).click();
  await settle();
  btn("Cancel", card()).click();
  await settle();
  // Another card opens meanwhile — it must survive the save landing.
  PopupManager.notify({ title: "Something else", message: "still here" });
  finish({ ok: true, entry: "gates-000000", rev: REV_B });
  await settle();
  assert.deepEqual(w.linked, [["t1", { store: STORE.id, entry: "gates-000000", rev: REV_B }]]); // prettier-ignore
  assert.match(document.querySelector(".popup-title").textContent, /Something else/); // prettier-ignore
  PopupManager.close();
  await settle();
  assert.match(document.querySelector(".popup-title").textContent, /Saved/);
  PopupManager.close();
});

test("a fork that fails leaves the choice standing — the card is never left with only Cancel", async () => {
  resetDom();
  let tries = 0;
  const w = world({
    storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A },
    save: (p) => {
      if (!p.fork) return { ok: false, code: "behind", head: { rev: REV_B, author: "Bob", at: "2026-11-22T11:00:00.000Z" } }; // prettier-ignore
      tries += 1;
      return tries === 1 ? { ok: false, code: "unavailable" } : { ok: true, entry: ENTRY, rev: REV_B }; // prettier-ignore
    },
  });
  void saveToStore(w.deps);
  await settle();
  btn("Save", card()).click();
  await settle();
  btn("Save Mine Alongside", card()).click();
  await settle();
  // Failed: said, and Save Mine Alongside is there to press again.
  assert.match([...card().querySelectorAll(".gallery-share-problem[role=alert]")].find((p) => !p.hidden && !p.closest("[hidden], .share-to-side--off")).textContent, /did not work/); // prettier-ignore
  const again = btn("Save Mine Alongside", card());
  assert.ok(again && !again.disabled && !card().querySelector(".store-save-behind").hidden); // prettier-ignore
  again.click();
  await settle();
  assert.equal(tries, 2);
  assert.deepEqual(w.linked.at(-1), ["t1", { store: STORE.id, entry: ENTRY, rev: REV_B }]); // prettier-ignore
  PopupManager.close();
});

test("choosing another store after 'someone saved first' puts that answer away and brings Save back", async () => {
  resetDom();
  const other = { ...STORE, id: "s-9999999999999999", name: "Other" };
  const w = world({
    stores: [STORE, other],
    storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A },
    save: () => ({ ok: false, code: "behind", head: { rev: REV_B, author: "Bob", at: "2026-11-22T11:00:00.000Z" } }), // prettier-ignore
  });
  void saveToStore(w.deps);
  await settle();
  btn("Save", card()).click();
  await settle();
  assert.equal(card().querySelector(".store-save-behind").hidden, false);
  const pick = card().querySelector(".store-save-store");
  pick.value = other.id;
  pick.dispatchEvent(new window.Event("change"));
  assert.equal(card().querySelector(".store-save-behind").hidden, true);
  assert.equal(btn("Save", card()).hidden, false);
  PopupManager.close();
});

test("a lost link is said whenever its own store is picked — also when it was read while another store was picked", async () => {
  resetDom();
  const other = { ...STORE, id: "s-9999999999999999", name: "Other" };
  let answer;
  const w = world({ stores: [STORE, other], storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A }, view: () => new Promise((r) => (answer = r)) }); // prettier-ignore
  void saveToStore(w.deps);
  await settle();
  const pick = card().querySelector(".store-save-store");
  const note = () => [...card().querySelectorAll(".gallery-share-verdict")].find((n) => /saved as a new design/.test(n.textContent)); // prettier-ignore
  // The answer lands while another store is picked…
  pick.value = other.id;
  pick.dispatchEvent(new window.Event("change"));
  answer({ ok: false, code: "unavailable" });
  await settle();
  assert.notEqual(note()?.hidden, false, "not said over another store");
  // …and is said once the desktop's own store is picked again.
  pick.value = STORE.id;
  pick.dispatchEvent(new window.Event("change"));
  assert.equal(note()?.hidden, false, "said on the desktop's own store");
  pick.value = other.id;
  pick.dispatchEvent(new window.Event("change"));
  assert.equal(note().hidden, true, "another store is a new design anyway");
  pick.value = STORE.id;
  pick.dispatchEvent(new window.Event("change"));
  assert.equal(note().hidden, false);
  PopupManager.close();
});

test("Cancel while a save is on its way, and it does NOT land: that is said too — silence would read as saved", async () => {
  for (const answer of [
    { ok: false, code: "unavailable" },
    { ok: false, code: "behind", head: { rev: REV_B, author: "Bob" } },
  ]) {
    // prettier-ignore
    resetDom();
    let finish;
    const w = world({ save: () => new Promise((r) => (finish = r)) });
    void saveToStore(w.deps);
    await settle();
    const title = card().querySelector(".popup-body > .gallery-share-field .properties-text-input"); // prettier-ignore
    title.value = "Gates";
    title.dispatchEvent(new window.Event("input"));
    btn("Save", card()).click();
    await settle();
    btn("Cancel", card()).click();
    await settle();
    finish(answer);
    await settle();
    assert.match(document.querySelector(".popup-title")?.textContent ?? "", /Not saved/, answer.code); // prettier-ignore
    assert.match(document.body.textContent, /was not saved to “Bench club”/);
    assert.deepEqual(w.linked, [], "nothing linked");
    PopupManager.close();
  }
});

test("a lost link ticks 'A new design' — and 'behind' with no head named still opens theirs (the entry's newest)", async () => {
  resetDom();
  const lost = world({ storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A }, view: async () => ({ ok: false, code: "unavailable" }) }); // prettier-ignore
  void saveToStore(lost.deps);
  await settle();
  assert.equal(card().querySelector('input[name="store-save-mode"][value="new"]').checked, true); // prettier-ignore
  PopupManager.close();
  await settle();

  resetDom();
  const w = world({
    storeFrom: { store: STORE.id, entry: ENTRY, rev: REV_A },
    save: () => ({ ok: false, code: "behind" }), // an older main: no head
  });
  void saveToStore(w.deps);
  await settle();
  btn("Save", card()).click();
  await settle();
  btn("Open Theirs", card()).click();
  await settle();
  assert.deepEqual(w.opened, [{ store: STORE.id, entry: ENTRY, rev: REV_A }]);
});
