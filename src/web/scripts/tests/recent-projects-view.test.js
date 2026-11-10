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

// recent-projects-view.test.js — the Browse window's Recent Projects tab: a
// card per recent project (its picture or the placeholder, when it was saved,
// how many desktops), a click that opens it, a × that drops it from the list,
// a search, and a missing file said as such.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { t } from "../i18n.js";

const { RecentProjectsView, filterRecent } =
  await import("../components/recent-projects-view.js");

const PROJECTS = [
  {
    path: "/home/clock.chiphippo",
    name: "clock",
    savedAt: 1_700_000_000_000,
    missing: false,
    thumb: "data:image/png;base64,AAAA",
    desktops: 3,
  },
  {
    path: "/home/old/adder.chiphippo",
    name: "adder",
    savedAt: null,
    missing: true,
    thumb: null,
    desktops: null,
  },
];

async function mount(projects = PROJECTS) {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const opened = [];
  const removed = [];
  const view = new RecentProjectsView({
    root,
    load: async () => projects,
    say: (key, params) => t(`browse.recent.${key}`, params),
    formatDate: () => "1 Jan",
    onOpen: (p) => opened.push(p.path),
    onRemove: (p) => removed.push(p.path),
  });
  await view.refresh();
  return { root, view, opened, removed };
}

const cards = (root) => [...root.querySelectorAll(".gallery-card")];

test("a card per recent project, with its picture, date and desktops", async () => {
  const { root } = await mount();
  const [clock, adder] = cards(root);
  assert.equal(clock.querySelector(".gallery-card-title").textContent, "clock");
  assert.equal(
    clock.querySelector(".gallery-card-author").textContent,
    "Saved 1 Jan · 3 desktops",
  );
  assert.equal(clock.querySelector("img").getAttribute("src"), "data:image/png;base64,AAAA"); // prettier-ignore
  assert.equal(clock.title, "/home/clock.chiphippo", "the path on hover");
  // No picture: the gallery's striped placeholder. Gone: said so.
  assert.ok(adder.querySelector(".gallery-thumb--empty"));
  assert.equal(adder.querySelector("img"), null);
  assert.ok(adder.classList.contains("gallery-card--missing"));
  assert.equal(
    adder.querySelector(".gallery-card-author").textContent,
    "File not found",
  );
});

test("a click opens the project; the × drops it from the list only", async () => {
  const { root, opened, removed } = await mount();
  cards(root)[0].click();
  assert.deepEqual(opened, ["/home/clock.chiphippo"]);
  root.querySelectorAll(".browse-card-remove")[1].click();
  assert.deepEqual(removed, ["/home/old/adder.chiphippo"]);
  assert.equal(cards(root).length, 1);
});

test("an empty list says how a project gets there", async () => {
  const { root } = await mount([]);
  const status = root.querySelector(".gallery-status");
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, t("browse.recent.empty"));
});

test("the search matches every word in the name or the path", () => {
  assert.deepEqual(filterRecent(PROJECTS, "old add").map((p) => p.name), ["adder"]); // prettier-ignore
  assert.deepEqual(filterRecent(PROJECTS, "CLOCK").map((p) => p.name), ["clock"]); // prettier-ignore
  assert.equal(filterRecent(PROJECTS, "  ").length, 2);
  assert.deepEqual(filterRecent(PROJECTS, "zzz"), []);
});

test("a read begun before a removal never draws the removed card back; one begun after is main's word", async () => {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const answers = [];
  const view = new RecentProjectsView({
    root,
    load: () => new Promise((resolve) => answers.push(resolve)),
    say: (key, params) => t(`browse.recent.${key}`, params),
    formatDate: () => "1 Jan",
    onOpen: () => {},
    onRemove: () => {},
  });
  const first = view.refresh();
  answers.shift()(PROJECTS);
  await first;
  // The window comes forward (a refresh starts), THEN the × is clicked.
  const stale = view.refresh();
  root.querySelectorAll(".browse-card-remove")[0].click();
  answers.shift()(PROJECTS); // read before main dropped it
  await stale;
  assert.deepEqual(cards(root).map((c) => c.title), ["/home/old/adder.chiphippo"]); // prettier-ignore
  // Opened again later, it is back on main's list — and shown.
  const later = view.refresh();
  answers.shift()(PROJECTS);
  await later;
  assert.equal(cards(root).length, 2);
  // An older answer landing after a newer one is dropped.
  const a = view.refresh();
  const b = view.refresh();
  answers[1]([PROJECTS[1]]);
  await b;
  answers[0](PROJECTS);
  await a;
  assert.equal(cards(root).length, 1, "the newer read's list stands");
});
