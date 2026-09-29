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

import fs from "node:fs";
import path from "node:path";

import { SITE_DIR, loadPage } from "./website-page.js";

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

test("every root-relative link lands on a file the site ships", async (t) => {
  // "/chips.html" and "/docs/" are pages the deploy builds into website/; a
  // link to one that isn't there is a 404 nothing else in the suite would see.
  const page = loadPage();
  t.after(page.close);
  const missing = [...page.document.querySelectorAll('a[href^="/"]')]
    .map((a) => a.getAttribute("href").split("#")[0])
    .filter((href) => !href.startsWith("//"))
    .filter((href) => {
      const file = href.endsWith("/") ? `${href}index.html` : href;
      return !fs.existsSync(path.join(SITE_DIR, file));
    });

  assert.deepEqual(missing, []);
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
