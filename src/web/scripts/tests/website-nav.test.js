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

// website-nav.test.js — the markup rules website/index.html has to keep
// offering: the banner, the links, and the share card.
//
// The "Other Hippos" dropdown and its light-dismiss script (website/nav.js)
// went in 9f01a4d, which replaced the <details> menu with a plain link to the
// herd; the eight tests that drove that script went with it. What is left
// needs no script at all — every check below reads the shipped HTML the way a
// crawler or a screen reader would.

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPage } from "./website-page.js";

// ── What the markup has to keep offering ────────────────────────────────────

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
