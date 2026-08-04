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

// website-page.js — load the REAL website/index.html into a fresh jsdom and run
// one of the site's own scripts against it. The helper behind
// website-downloads.test.js and website-hero-carousel.test.js.
//
// Deliberately NOT jsdom-setup.js's `resetDom()`. That one installs a window on
// Node's globals and loads locales/en.json, because the app's components read
// bare `document` and call `t()`. The website is a different program: two plain
// IIFEs on a static page with no bridge, no catalog and no module system. What
// they need is the actual shipped markup — the ids, the fallback links, the slide
// list — since the markup IS half of what each script is asserted against. A
// hand-built fixture would let index.html drop `#dl-list-mac` and every test
// here keep passing.
//
// The scripts are IIFEs, so they are eval'd into the window rather than
// imported. Nothing is installed on Node's globals, so these tests can run in
// any order beside the component ones.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
// src/web/scripts/tests → repo root → website/
export const SITE_DIR = path.resolve(TESTS_DIR, "../../../..", "website");

const read = (file) => fs.readFileSync(path.join(SITE_DIR, file), "utf8");

/**
 * Load website/index.html into a fresh jsdom.
 *
 * @param {{fetch?: Function}} [opts] `fetch` is installed on the window before
 *   any script runs — downloads.js calls it on the same tick.
 * @returns {{dom: JSDOM, window: Window, document: Document, run: Function,
 *            close: Function}}
 */
export function loadPage(opts = {}) {
  const dom = new JSDOM(read("index.html"), {
    url: "https://chiphippo.com/",
    runScripts: "outside-only",
  });
  if (opts.fetch) dom.window.fetch = opts.fetch;
  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    /** Run one of the site's scripts by filename, e.g. run("downloads.js"). */
    run(file) {
      dom.window.eval(read(file));
    },
    /** Always call this — hero-carousel.js leaves an auto-advance interval. */
    close() {
      dom.window.close();
    },
  };
}

/** A `fetch` stub that resolves `data` as JSON, counting its calls. */
export function jsonFetch(data) {
  const stub = () => {
    stub.calls++;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
    });
  };
  stub.calls = 0;
  return stub;
}

/** Let the fetch promise chain settle (and optionally the retry backoff). */
export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** The rows of one download card, as readable strings. */
export function cardRows(document, id) {
  return [...document.querySelectorAll("#" + id + " > *")].map((n) => {
    if (n.classList.contains("dl-sep")) return "── " + n.textContent;
    const badge = n.querySelector(".dl-arch");
    return (
      n.querySelector(".dl-label").textContent +
      (badge ? " [" + badge.textContent + "]" : " [no-badge]")
    );
  });
}
