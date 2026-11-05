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

// The app window's half of the gallery (components/gallery-open.js): Browse
// Gallery…'s one-time access question, the checks a design is put through
// before it lands, the revision question — and Settings ▸ Gallery.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resetDom } from "./jsdom-setup.js";
import {
  browseGallery,
  droppedSummary,
  galleryPrepare,
  galleryRevisions,
} from "../components/gallery-open.js";
import {
  buildGalleryPanel,
  galleryAnswers,
} from "../components/settings-gallery-panel.js";
import { el } from "../dom.js";

const DEMOS = join(dirname(fileURLToPath(import.meta.url)), "../../demos");
const nand = () =>
  JSON.parse(readFileSync(join(DEMOS, "74LS00.json"), "utf8")).doc;

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const button = (label) =>
  [...document.querySelectorAll(".popup-dialog button")].find(
    (b) => b.textContent.trim() === label,
  );
const click = (label) => {
  const b = button(label);
  assert.ok(b, `a "${label}" button is showing`);
  b.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
};
const title = () => document.querySelector(".popup-title")?.textContent ?? "";

/** A bridge that records `show`, and the settings it is handed. */
function deps(settings = {}) {
  const calls = { shown: 0, saved: [], opened: [] };
  return {
    calls,
    bridge: { gallery: { show: async () => ((calls.shown += 1), true) } },
    web: false,
    settings: () => settings,
    saveSettings: async (patch) => {
      calls.saved.push(patch);
      Object.assign(settings, patch);
    },
    openSettings: (tab) => calls.opened.push(tab),
  };
}

test("first Browse asks once; Allow is stored and opens the window", async () => {
  resetDom();
  const d = deps();
  const run = browseGallery(d);
  await settle();
  assert.equal(title(), "Browse the gallery?");
  click("Allow");
  assert.equal(await run, true);
  assert.deepEqual(d.calls.saved, [{ galleryAccess: "yes" }]);
  assert.equal(d.calls.shown, 1);
  // …and is never asked again.
  assert.equal(await browseGallery(d), true);
  assert.equal(d.calls.shown, 2);
});

test("Not now is a stored no; the next Browse points at Settings", async () => {
  resetDom();
  const d = deps();
  const run = browseGallery(d);
  await settle();
  click("Not now");
  assert.equal(await run, false);
  assert.deepEqual(d.calls.saved, [{ galleryAccess: "no" }]);
  assert.equal(d.calls.shown, 0);
  const again = browseGallery(d);
  await settle();
  assert.equal(title(), "Gallery access is off");
  click("Open Settings");
  assert.equal(await again, false);
  assert.deepEqual(d.calls.opened, ["gallery"]);
});

test("the web build never asks", async () => {
  resetDom();
  const d = deps();
  assert.equal(await browseGallery({ ...d, web: true }), true);
  assert.deepEqual(d.calls.saved, []);
});

test("what a load check lost, in a line", () => {
  resetDom();
  assert.equal(
    droppedSummary([
      { code: "unknownPart", ref: "74LS9999" },
      { code: "dropped", list: "wires", ids: ["w1", "w2"] },
      { code: "dropped", list: "components", ids: ["c9"] },
    ]),
    "2 parts, 2 wires",
  );
  assert.equal(droppedSummary([]), "");
});

/** An open-entry answer for the NAND bench, as main gives it. */
const nandEntry = (extra = {}) => ({
  ok: true,
  name: "NAND",
  doc: nand(),
  customChips: [],
  pin: "1.5.4",
  engine: "logic",
  ...extra,
});

test("an entry pinned to an older release that loads clean goes straight on", async () => {
  resetDom();
  const prepare = galleryPrepare({
    appVersion: async () => "9.0.0",
    settings: () => ({ spiceLite: { enabled: true } }),
    saveSettings: async () => {},
  });
  assert.equal(await prepare(nandEntry()), true);
  assert.equal(document.querySelector(".popup-title"), null);
});

test("one that would lose parts says so first; Cancel leaves it", async () => {
  resetDom();
  const doc = nand();
  doc.components.find((c) => c.ref === "74LS00").ref = "74LS9999";
  const prepare = galleryPrepare({
    appVersion: async () => "9.0.0",
    settings: () => ({}),
    saveSettings: async () => {},
  });
  const run = prepare(nandEntry({ doc }));
  await settle();
  assert.equal(title(), "This design may not open whole");
  assert.match(document.querySelector(".popup-message").textContent, /1\.5\.4.*9\.0\.0.*1 part/); // prettier-ignore
  click("Cancel");
  assert.equal(await run, false);
});

test("a Spice Lite design on the logic engine offers the switch", async () => {
  resetDom();
  const saved = [];
  const prepare = galleryPrepare({
    appVersion: async () => "1.5.4",
    settings: () => ({ spiceLite: { enabled: false } }),
    saveSettings: async (patch) => saved.push(patch),
  });
  const run = prepare(nandEntry({ engine: "spice" }));
  await settle();
  assert.equal(title(), "This design uses Spice Lite");
  click("Turn On Spice Lite");
  assert.equal(await run, true);
  assert.equal(saved[0].spiceLite.enabled, true);
  // "Open Without" opens it and changes nothing.
  saved.length = 0;
  const again = prepare(nandEntry({ engine: "spice" }));
  await settle();
  click("Open Without");
  assert.equal(await again, true);
  assert.deepEqual(saved, []);
});

test("the revision question: Update is the answer Enter gives; dismissing keeps both", async () => {
  resetDom();
  const ask = { gcid: "gc-0123456789ab", id: "custom-0000c0de", name: "SHARED", from: 1, to: 2 }; // prettier-ignore
  const run = galleryRevisions()([ask]);
  await settle();
  assert.equal(title(), "A newer SHARED");
  assert.ok(button("Update").hasAttribute("data-autofocus"));
  assert.ok(!button("Keep Both").hasAttribute("data-autofocus"));
  click("Update");
  assert.deepEqual(await run, { "gc-0123456789ab": "update" });
  const again = galleryRevisions()([ask]);
  await settle();
  click("Keep Both");
  assert.deepEqual(await again, { "gc-0123456789ab": "keep" });
});

test("Settings ▸ Gallery: two answers and the shares, access left out on the web", () => {
  resetDom();
  assert.deepEqual(galleryAnswers({}), { access: "no", share: "ask" });
  assert.deepEqual(galleryAnswers({ galleryAccess: "yes", galleryShare: "no" }), { access: "yes", share: "no" }); // prettier-ignore
  const emitted = [];
  const rowWithNote = ({ label, control }) =>
    el("div", { class: "row", "data-label": label }, [control]);
  const { rows } = buildGalleryPanel({}, (p) => emitted.push(p), { rowWithNote }); // prettier-ignore
  const labels = (list) => list.filter((r) => r.dataset.label).map((r) => r.dataset.label); // prettier-ignore
  assert.deepEqual(labels(rows), ["Gallery access", "Share consent", "Your shares"]); // prettier-ignore
  [...rows[0].querySelectorAll("button")].find((b) => b.textContent === "Yes").click(); // prettier-ignore
  assert.deepEqual(emitted, [{ galleryAccess: "yes" }]);
  const web = buildGalleryPanel({}, () => {}, { rowWithNote, web: true });
  assert.deepEqual(labels(web.rows), ["Share consent", "Your shares"]);
});

test("Settings ▸ Gallery ▸ Your shares: Check status asks after each, and keeps the note as text", async () => {
  resetDom();
  const key = "b".repeat(64);
  const settings = {
    galleryShares: [
      { id: "blinker-abcdef", number: 3, key, title: "Blinker", at: "2026-11-02", status: "waiting", note: "" }, // prettier-ignore
      { id: "clock-123456", number: 2, key, title: "Clock", at: "2026-11-01", status: "waiting", note: "" }, // prettier-ignore
      { id: "gone-654321", number: 1, key, title: "Gone", at: "2026-10-30" },
      { title: "no id or key — dropped" },
    ],
  };
  const answers = {
    3: { ok: true, status: "declined", note: "Needs a <b>resistor</b>." },
    2: { ok: true, status: "accepted", note: "" },
    1: { ok: false, code: "notFound" },
  };
  const asked = [];
  const emitted = [];
  const rowWithNote = ({ label, control }) =>
    el("div", { class: "row", "data-label": label }, [control]);
  const { rows } = buildGalleryPanel(settings, (p) => emitted.push(p), {
    rowWithNote,
    shareStatus: async (share) => {
      asked.push(share);
      return answers[share.number];
    },
  });
  for (const row of rows) document.body.append(row);
  const items = () => [...document.querySelectorAll(".settings-gallery-share")];
  assert.deepEqual(items().map((li) => li.querySelector(".settings-gallery-share-title").textContent), ["Blinker", "Clock", "Gone"]); // prettier-ignore
  assert.ok(items().every((li) => li.querySelector(".settings-gallery-share-status").textContent === "Waiting for review")); // prettier-ignore
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Check status").click(); // prettier-ignore
  await settle();
  assert.deepEqual(asked.map((a) => Object.keys(a).sort().join()), ["id,key,number", "id,key,number", "id,key,number"]); // prettier-ignore
  const statuses = items().map((li) => li.querySelector(".settings-gallery-share-status").textContent); // prettier-ignore
  assert.deepEqual(statuses, ["Not accepted", "Accepted", "Not found"]);
  const note = items()[0].querySelector(".settings-gallery-share-note p");
  assert.equal(note.textContent, "Needs a <b>resistor</b>.");
  assert.equal(note.querySelector("b"), null, "the reviewer's note is text, never markup"); // prettier-ignore
  const [{ galleryShares }] = emitted;
  assert.deepEqual(galleryShares.map((s) => [s.id, s.status]), [["blinker-abcdef", "declined"], ["clock-123456", "accepted"], ["gone-654321", "notFound"]]); // prettier-ignore
});

test("Settings ▸ Gallery ▸ Your shares: nothing yet, and a check that can't get through", async () => {
  resetDom();
  const rowWithNote = ({ label, control }) =>
    el("div", { class: "row", "data-label": label }, [control]);
  const empty = buildGalleryPanel({}, () => {}, { rowWithNote, shareStatus: async () => ({ ok: true }) }); // prettier-ignore
  for (const row of empty.rows) document.body.append(row);
  assert.equal(document.querySelector(".settings-gallery-shares-empty").textContent, "Nothing shared from here yet."); // prettier-ignore
  assert.equal([...document.querySelectorAll("button")].find((b) => b.textContent === "Check status").disabled, true); // prettier-ignore
  resetDom();
  const share = { id: "blinker-abcdef", number: 3, key: "b".repeat(64), title: "Blinker", at: "2026-11-02", status: "accepted", note: "" }; // prettier-ignore
  const emitted = [];
  const down = buildGalleryPanel({ galleryShares: [share] }, (p) => emitted.push(p), { rowWithNote, shareStatus: async () => ({ ok: false, code: "unavailable" }) }); // prettier-ignore
  for (const row of down.rows) document.body.append(row);
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Check status").click(); // prettier-ignore
  await settle();
  assert.equal(document.querySelector(".settings-gallery-share-status").textContent, "Accepted", "what was known is kept"); // prettier-ignore
  const problem = document.querySelector(".settings-gallery-shares-problem");
  assert.equal(problem.hidden, false);
  assert.match(problem.textContent, /couldn't be reached/);
  assert.deepEqual(emitted[0].galleryShares, [share]);
});
