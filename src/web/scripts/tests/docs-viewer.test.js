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

// The DocsViewer (Help ▸ Chip Hippo User Guide, Feature 230): a two-pane
// reader fetching Markdown over window.chiphippo.docs.read (never fetch()),
// rendering it through the bundled marked+DOMPurify vendor renderer, and
// handling in-viewer navigation (nav clicks, .md links, #anchors) without
// ever leaving the page.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

// The vendored DOMPurify bundle detects `window` at MODULE-EVAL time (it calls
// DOMPurify.addHook(...) at the top level of markdown-entry.js), so a DOM must
// already be installed before docs-viewer.js (which imports it) is first
// imported — not just before each test's mount, which is too late for a
// module that only evaluates once.
resetDom();
const { DocsViewer, PAGES } = await import("../components/docs-viewer.js");

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A window.chiphippo.docs.read stub serving a fixed page → markdown map. */
function installDocs(pages) {
  const reads = [];
  window.chiphippo = {
    docs: {
      read: (slug) => {
        reads.push(slug);
        return Promise.resolve(pages[slug] ?? `# ${slug}\n`);
      },
    },
  };
  return reads;
}

test("PAGES: every page has a unique slug; only the overview page names a file", () => {
  const slugs = PAGES.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length, "no duplicate slugs");
  const withFile = PAGES.filter((p) => p.file);
  assert.deepEqual(withFile, [
    { slug: "overview", file: "README", title: "Overview" },
  ]);
});

test("mount: fetches the overview page by its file (README), not its slug", async () => {
  resetDom();
  const reads = installDocs({ README: "# Overview\n\nHello." });
  const viewer = new DocsViewer();
  viewer.mount(document.body);
  await settle();

  assert.deepEqual(reads, ["README"]);
  assert.match(
    viewer.element.querySelector(".docs-content").innerHTML,
    /Hello/,
  );
  assert.ok(
    viewer.element
      .querySelector('.docs-nav-item[data-page="overview"]')
      .classList.contains("docs-nav-item--active"),
  );
});

test("nav click loads the clicked page by slug and moves the active state", async () => {
  resetDom();
  const reads = installDocs({
    README: "# Overview\n",
    "getting-started": "# Getting Started\n\nPlace a board.",
  });
  const viewer = new DocsViewer();
  viewer.mount(document.body);
  await settle();

  viewer.element
    .querySelector('.docs-nav-item[data-page="getting-started"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settle();

  assert.deepEqual(reads, ["README", "getting-started"]);
  assert.match(
    viewer.element.querySelector(".docs-content").innerHTML,
    /Place a board/,
  );
  assert.ok(
    viewer.element
      .querySelector('.docs-nav-item[data-page="getting-started"]')
      .classList.contains("docs-nav-item--active"),
  );
  assert.ok(
    !viewer.element
      .querySelector('.docs-nav-item[data-page="overview"]')
      .classList.contains("docs-nav-item--active"),
  );
});

test("an in-content link to another *.md page navigates in-viewer, preventing default", async () => {
  resetDom();
  installDocs({
    README: "See [wiring](wiring.md) for nets.",
    wiring: "# Wiring\n\nUse the W key.",
  });
  const viewer = new DocsViewer();
  viewer.mount(document.body);
  await settle();

  const link = viewer.element.querySelector(
    '.docs-content a[href="wiring.md"]',
  );
  assert.ok(link, "renders the markdown link");
  const event = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  link.dispatchEvent(event);
  await settle();

  assert.equal(event.defaultPrevented, true);
  assert.match(
    viewer.element.querySelector(".docs-content").innerHTML,
    /Use the W key/,
  );
});

test("an external http link is left alone (not intercepted)", async () => {
  resetDom();
  installDocs({ README: "[Chip Hippo](https://chiphippo.com)" });
  const viewer = new DocsViewer();
  viewer.mount(document.body);
  await settle();

  const link = viewer.element.querySelector(".docs-content a[href]");
  const event = new window.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
  });
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});

test("images rewrite images/x.png to docs/images/x.png (resolves relative to docs.html)", async () => {
  resetDom();
  installDocs({ README: "![The desk](images/overview.png)" });
  const viewer = new DocsViewer();
  viewer.mount(document.body);
  await settle();

  const img = viewer.element.querySelector(".docs-content img");
  assert.equal(img.getAttribute("src"), "docs/images/overview.png");
});

test("headings get GitHub-style ids so #anchor links resolve", async () => {
  resetDom();
  installDocs({ README: "## Power & Clocks\n" });
  const viewer = new DocsViewer();
  viewer.mount(document.body);
  await settle();

  const h2 = viewer.element.querySelector(".docs-content h2");
  assert.equal(h2.id, "power-clocks");
});

test("a stale in-flight load never clobbers a newer one (loadToken race guard)", async () => {
  resetDom();
  const gate = {};
  gate.readme = new Promise((resolve) => (gate.resolveReadme = resolve));
  let readCount = 0;
  window.chiphippo = {
    docs: {
      read: (slug) => {
        readCount += 1;
        // The FIRST read (the initial overview mount) hangs until released;
        // every subsequent read resolves immediately — simulating a slow
        // first load overtaken by a fast rapid-click second load.
        if (readCount === 1) return gate.readme.then(() => "# Overview\n");
        return Promise.resolve(`# ${slug}\n\nFast page.`);
      },
    },
  };
  const viewer = new DocsViewer();
  viewer.mount(document.body); // kicks off the slow overview load
  viewer.show("getting-started"); // fast — resolves first
  await settle();
  assert.match(
    viewer.element.querySelector(".docs-content").innerHTML,
    /Fast page/,
  );

  gate.resolveReadme(); // the slow overview load finally resolves...
  await settle();
  // ...but must NOT overwrite the newer getting-started page.
  assert.match(
    viewer.element.querySelector(".docs-content").innerHTML,
    /Fast page/,
  );
});

test("a failed read shows an inline error instead of throwing", async () => {
  resetDom();
  window.chiphippo = {
    docs: { read: () => Promise.reject(new Error("boom")) },
  };
  const viewer = new DocsViewer();
  viewer.mount(document.body);
  await settle();

  const err = viewer.element.querySelector(".docs-error");
  assert.ok(err, "renders a .docs-error node");
  assert.match(err.textContent, /boom/);
});
