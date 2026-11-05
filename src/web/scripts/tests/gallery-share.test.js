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

// Share to Gallery (components/gallery-share.js): the card, its checks on
// the fields and the design, the consent setting's three answers, and what
// Share publicly hands the bridge.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { resetDom } from "./jsdom-setup.js";
import {
  checkDesign,
  parseTags,
  shareToGallery,
} from "../components/gallery-share.js";

const DEMOS = join(dirname(fileURLToPath(import.meta.url)), "../../demos");
const nand = () =>
  JSON.parse(readFileSync(join(DEMOS, "74LS00.json"), "utf8")).doc;
const desktop = (doc = nand()) => ({ name: "Gates", description: "Four NANDs.", doc, customChips: [] }); // prettier-ignore

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
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
const inputs = () => [...document.querySelectorAll(".gallery-share-field input, .gallery-share-field textarea")]; // prettier-ignore
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
};

function deps({
  settings = {},
  answer = { ok: true, id: "gates-abcdef" },
  running = false,
  doc,
} = {}) {
  // prettier-ignore
  const calls = { shared: [], saved: [], opened: [] };
  return {
    calls,
    bridge: {
      gallery: {
        share: async (payload) => {
          calls.shared.push(payload);
          return answer;
        },
      },
    },
    desktop: desktop(doc),
    settings: () => ({ galleryShare: "ask", ...settings }),
    saveSettings: async (patch) => calls.saved.push(patch),
    openSettings: (tab) => calls.opened.push(tab),
    isRunning: () => running,
  };
}

test("tags are comma-separated", () => {
  assert.deepEqual(parseTags(" 555, LED flasher ,, timer"), ["555", "LED flasher", "timer"]); // prettier-ignore
  assert.deepEqual(parseTags(""), []);
});

test("the design is judged as the gallery would judge it", () => {
  assert.equal(checkDesign(desktop()).ok, true);
  const empty = checkDesign(desktop({ ...nand(), components: [], wires: [] }));
  assert.equal(empty.ok, false);
  assert.ok(empty.problems.some((p) => p.code === "empty"));
});

test("Share publicly sends the desktop and the four fields, then says it is waiting for review", async () => {
  resetDom();
  const d = deps();
  const run = shareToGallery(d);
  await settle();
  assert.equal(title(), "Share to Gallery");
  // The consent block (Ask) is shown in full.
  assert.equal(document.querySelectorAll(".gallery-share-consent-list li").length, 4); // prettier-ignore
  const [name, author, , tags] = inputs();
  assert.equal(name.value, "Gates");
  // No name yet: Share publicly waits for one.
  assert.equal(button("Share Publicly").disabled, true);
  type(author, "Ada");
  type(tags, "nand, logic gates");
  assert.equal(button("Share Publicly").disabled, false);
  click("Share Publicly");
  await settle();
  assert.equal(d.calls.shared.length, 1);
  const [sent] = d.calls.shared;
  assert.deepEqual(sent.entry, { title: "Gates", author: "Ada", description: "Four NANDs.", tags: ["nand", "logic-gates"] }); // prettier-ignore
  assert.equal(sent.doc.components.length, nand().components.length);
  assert.deepEqual(d.calls.saved, [{ galleryAuthor: "Ada" }]);
  assert.equal(title(), "Sent for review");
  click("OK");
  assert.equal(await run, "gates-abcdef");
});

test("a refusal is said on the card, which stays open", async () => {
  resetDom();
  const d = deps({ settings: { galleryAuthor: "Ada" }, answer: { ok: false, code: "rateLimited" } }); // prettier-ignore
  const run = shareToGallery(d);
  await settle();
  click("Share Publicly");
  await settle();
  assert.equal(title(), "Share to Gallery");
  assert.match(document.querySelector('.gallery-share-problem[role="alert"]').textContent, /Try again in an hour/); // prettier-ignore
  click("Cancel");
  assert.equal(await run, null);
});

test("Share consent: Yes is one line, No points at Settings ▸ Gallery", async () => {
  resetDom();
  const yes = deps({ settings: { galleryShare: "yes", galleryAuthor: "Ada" } });
  const run = shareToGallery(yes);
  await settle();
  assert.equal(document.querySelectorAll(".gallery-share-consent-list").length, 0); // prettier-ignore
  assert.match(document.querySelector(".gallery-share-consent").textContent, /for review/); // prettier-ignore
  click("Cancel");
  await run;

  resetDom();
  const no = deps({ settings: { galleryShare: "no" } });
  const off = shareToGallery(no);
  await settle();
  assert.equal(title(), "Sharing is off");
  click("Open Settings");
  assert.equal(await off, null);
  assert.deepEqual(no.calls.opened, ["gallery"]);
  assert.equal(no.calls.shared.length, 0);
});

test("nothing can be shared while running, or from an empty desktop", async () => {
  for (const d of [
    deps({ running: true, settings: { galleryAuthor: "Ada" } }),
    deps({ settings: { galleryAuthor: "Ada" }, doc: { ...nand(), components: [], wires: [] } }), // prettier-ignore
  ]) {
    resetDom();
    const run = shareToGallery(d);
    await settle();
    assert.equal(button("Share Publicly").disabled, true);
    click("Cancel");
    await run;
    assert.equal(d.calls.shared.length, 0);
  }
});
