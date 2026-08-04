/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// website-nav.test.js — dismissing the nav dropdown (website/nav.js), and the
// markup rules the header depends on.
//
// <details> gives the menu its no-JS behaviour and costs nothing under the
// page's script-src 'self' CSP, but it has no light-dismiss and no Escape: the
// card stayed over the page until its own summary was clicked again. Everything
// below is about letting go, not about opening.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPage } from "./website-page.js";

/** Open the first nav dropdown and return it plus its summary. */
function opened(page) {
  const menu = page.document.querySelector(".nav-dropdown");
  const summary = menu.querySelector("summary");
  menu.open = true;
  return { menu, summary };
}

const click = (page, node) =>
  node.dispatchEvent(
    new page.window.MouseEvent("click", { bubbles: true, cancelable: true }),
  );

const press = (page, key) =>
  page.document.dispatchEvent(
    new page.window.KeyboardEvent("keydown", { key, bubbles: true }),
  );

// ── Light dismiss ───────────────────────────────────────────────────────────

test("clicking anywhere outside closes the menu", async (t) => {
  const page = loadPage();
  t.after(page.close);
  page.run("nav.js");
  const { menu } = opened(page);

  click(page, page.document.querySelector(".hero h1"));

  assert.equal(menu.open, false);
});

test("a click the page swallows still closes the menu", async (t) => {
  // The listener is registered in the CAPTURE phase for this: a menu that
  // outlives the click that should have dismissed it is the whole bug, and
  // whether some other handler stops propagation is not its business.
  const page = loadPage();
  t.after(page.close);
  page.run("nav.js");
  const { menu } = opened(page);

  const elsewhere = page.document.querySelector(".hero h1");
  elsewhere.addEventListener("click", (e) => e.stopPropagation());
  click(page, elsewhere);

  assert.equal(menu.open, false);
});

test("clicking inside the menu leaves it open", async (t) => {
  // That click is the visitor using it — the link navigates, and closing the
  // card out from under the pointer first would be its own bug.
  const page = loadPage();
  t.after(page.close);
  page.run("nav.js");
  const { menu } = opened(page);

  click(page, menu.querySelector(".nav-dropdown-item"));

  assert.equal(menu.open, true);
});

test("the summary still toggles the menu itself", async (t) => {
  // The one thing the dismissal must NOT do. It listens in the capture phase,
  // so it sees the summary click before the browser acts on it — treat that as
  // an "outside" click and it would slam the menu shut a moment before the
  // native toggle opened it, and the menu would never open at all.
  const page = loadPage();
  t.after(page.close);
  page.run("nav.js");
  const menu = page.document.querySelector(".nav-dropdown");
  const summary = menu.querySelector("summary");
  assert.equal(menu.open, false);

  click(page, summary);
  assert.equal(menu.open, true, "the native toggle must still open it");

  click(page, summary);
  assert.equal(menu.open, false, "and must still close it");
});

// ── Keyboard ────────────────────────────────────────────────────────────────

test("Escape closes the menu and puts focus back on its summary", async (t) => {
  const page = loadPage();
  t.after(page.close);
  page.run("nav.js");
  const { menu, summary } = opened(page);

  press(page, "Escape");

  assert.equal(menu.open, false);
  assert.equal(page.document.activeElement, summary, "focus must not be lost");
});

test("another key does nothing", async (t) => {
  const page = loadPage();
  t.after(page.close);
  page.run("nav.js");
  const { menu } = opened(page);

  press(page, "a");

  assert.equal(menu.open, true);
});

test("tabbing out of the menu closes it", async (t) => {
  const page = loadPage();
  t.after(page.close);
  page.run("nav.js");
  const { menu } = opened(page);

  menu.dispatchEvent(
    new page.window.FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: page.document.querySelector(".nav-logo"),
    }),
  );

  assert.equal(menu.open, false);
});

test("moving focus WITHIN the menu leaves it open", async (t) => {
  const page = loadPage();
  t.after(page.close);
  page.run("nav.js");
  const { menu } = opened(page);

  menu.dispatchEvent(
    new page.window.FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: menu.querySelector(".nav-dropdown-item"),
    }),
  );

  assert.equal(menu.open, true);
});

// ── What the markup has to keep offering ────────────────────────────────────

test("the menu still works with nav.js blocked", async (t) => {
  // The reason dismissal lives in a separate file and the menu does not: with
  // no script at all it is a plain <details> that opens and closes on its own
  // summary. Nothing here may depend on the script existing.
  const page = loadPage();
  t.after(page.close);
  const menu = page.document.querySelector(".nav-dropdown");

  assert.equal(menu.tagName, "DETAILS");
  assert.ok(menu.querySelector("summary"), "a <details> needs its summary");
  assert.ok(
    menu.querySelectorAll(".nav-dropdown-item").length >= 1,
    "the links are in the markup, not built by script",
  );
});

test("the pre-release banner is not a live region", async (t) => {
  // It is in the markup from the first byte, so role="alert" interrupted every
  // screen reader on load with something that was never news.
  const page = loadPage();
  t.after(page.close);
  const banner = page.document.querySelector(".prerelease-banner");

  assert.ok(banner, "the banner is static markup, not built by a script");
  assert.equal(banner.getAttribute("role"), null);
  assert.equal(banner.getAttribute("aria-live"), null);
});

test("every external link carries rel=noopener", async (t) => {
  const page = loadPage();
  t.after(page.close);
  const bad = [...page.document.querySelectorAll("a[href]")]
    .filter((a) => /^https?:/.test(a.getAttribute("href")))
    .filter((a) => !(a.getAttribute("rel") || "").includes("noopener"))
    .map((a) => a.getAttribute("href"));

  assert.deepEqual(bad, []);
});

test("every in-page link points at an element that exists", async (t) => {
  // A dead #fragment renders as an ordinary link that goes nowhere, which is
  // exactly as invisible as the bugs this whole suite exists to catch.
  const page = loadPage();
  t.after(page.close);
  const dead = [...page.document.querySelectorAll('a[href^="#"]')]
    .map((a) => a.getAttribute("href").slice(1))
    .filter((id) => id && !page.document.getElementById(id));

  assert.deepEqual(dead, []);
});

test("the share card names an absolute image with its real size", async (t) => {
  // A crawler resolves og:image against nothing, so a relative path silently
  // produces a preview with no picture in it.
  const page = loadPage();
  t.after(page.close);
  const meta = (p) =>
    page.document.querySelector(`meta[property="${p}"], meta[name="${p}"]`)
      ?.content;

  const src = meta("og:image");
  assert.match(src, /^https:\/\/chiphippo\.com\//);
  assert.equal(meta("twitter:card"), "summary_large_image");
  assert.ok(meta("og:image:alt"), "a share image needs a description too");

  // The declared size must be the file's real size, or a client reserves the
  // wrong space and the preview reflows when the image lands.
  const file = src.replace("https://chiphippo.com/", "");
  const img = [...page.document.querySelectorAll("img")].find((i) =>
    (i.getAttribute("src") || "").endsWith(file),
  );
  assert.ok(img, `${file} should be a real image on the page`);
  assert.equal(meta("og:image:width"), img.getAttribute("width"));
  assert.equal(meta("og:image:height"), img.getAttribute("height"));
});
