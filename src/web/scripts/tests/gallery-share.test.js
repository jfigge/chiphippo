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
  MAX_SHARES,
  checkDesign,
  parseTags,
  rememberShare,
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

const KEY = "a".repeat(64);

function deps({
  settings = {},
  answer = { ok: true, id: "gates-abcdef", number: 4, key: KEY },
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
  // The name is kept for next time, and the share for Settings ▸ Gallery.
  const [saved] = d.calls.saved;
  assert.equal(saved.galleryAuthor, "Ada");
  assert.deepEqual(saved.galleryShares.map(({ at, ...s }) => s), [{ id: "gates-abcdef", number: 4, key: KEY, title: "Gates", status: "waiting", note: "" }]); // prettier-ignore
  assert.match(saved.galleryShares[0].at, /^\d{4}-\d{2}-\d{2}$/);
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

test("today's shares used up: the card says to try again tomorrow", async () => {
  resetDom();
  const d = deps({ settings: { galleryAuthor: "Ada" }, answer: { ok: false, code: "dailyLimit" } }); // prettier-ignore
  const run = shareToGallery(d);
  await settle();
  click("Share Publicly");
  await settle();
  assert.match(document.querySelector('.gallery-share-problem[role="alert"]').textContent, /Try again tomorrow/); // prettier-ignore
  click("Cancel");
  assert.equal(await run, null);
});

test("a share call that throws is said as unavailable, and the button can be pressed again", async () => {
  resetDom();
  const d = deps({ settings: { galleryAuthor: "Ada" } });
  d.bridge.gallery.share = async () => {
    throw new Error("the bridge went away");
  };
  const run = shareToGallery(d);
  await settle();
  click("Share Publicly");
  await settle();
  assert.equal(title(), "Share to Gallery");
  assert.ok(document.querySelector('.gallery-share-problem[role="alert"]').textContent.length > 0); // prettier-ignore
  const send = [...document.querySelectorAll("button")].find((b) => b.textContent === "Share Publicly"); // prettier-ignore
  assert.ok(send && !send.disabled, "not stuck on Sending…");
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

test("the shares list: newest first, one line a design, capped, keyless kept out", () => {
  const one = { id: "a-111111", number: 1, key: KEY, title: "A", at: "2026-11-01" }; // prettier-ignore
  const two = { id: "b-222222", number: 2, key: KEY, title: "B", at: "2026-11-02" }; // prettier-ignore
  const list = rememberShare(rememberShare([], one), two);
  assert.deepEqual(
    list.map((s) => s.id),
    ["b-222222", "a-111111"],
  );
  assert.equal(list[0].status, "waiting");
  // Shared again (the same id) moves to the top rather than doubling.
  assert.deepEqual(rememberShare(list, { ...one, number: 3 }).map((s) => [s.id, s.number]), [["a-111111", 3], ["b-222222", 2]]); // prettier-ignore
  // An older service gave no key: nothing could be asked, so nothing is kept.
  assert.deepEqual(rememberShare(list, { id: "c-333333", title: "C" }), list);
  let long = [];
  for (let i = 0; i < MAX_SHARES + 3; i++) long = rememberShare(long, { ...one, id: `x-${String(i).padStart(6, "0")}` }); // prettier-ignore
  assert.equal(long.length, MAX_SHARES);
});
