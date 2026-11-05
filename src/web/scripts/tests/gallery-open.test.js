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

test("Settings ▸ Gallery: two answers, access left out on the web", () => {
  resetDom();
  assert.deepEqual(galleryAnswers({}), { access: "no", share: "ask" });
  assert.deepEqual(galleryAnswers({ galleryAccess: "yes", galleryShare: "no" }), { access: "yes", share: "no" }); // prettier-ignore
  const emitted = [];
  const rowWithNote = ({ label, control }) =>
    el("div", { class: "row", "data-label": label }, [control]);
  const { rows } = buildGalleryPanel({}, (p) => emitted.push(p), { rowWithNote }); // prettier-ignore
  assert.deepEqual(rows.map((r) => r.dataset.label), ["Gallery access", "Share consent"]); // prettier-ignore
  [...rows[0].querySelectorAll("button")].find((b) => b.textContent === "Yes").click(); // prettier-ignore
  assert.deepEqual(emitted, [{ galleryAccess: "yes" }]);
  const web = buildGalleryPanel({}, () => {}, { rowWithNote, web: true });
  assert.deepEqual(
    web.rows.map((r) => r.dataset.label),
    ["Share consent"],
  );
});
