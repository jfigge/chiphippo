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

/**
 * docs-viewer.js — User-guide viewer (the Help → Chip Hippo User Guide window)
 *
 * A self-contained two-pane reader: a left-hand contents list and a right-hand
 * pane that renders one bundled help page (src/web/docs/*.md) at a time. It is
 * mounted into a host element by the standalone docs window (docs-window.js /
 * docs.html) — it is NOT a modal popup, so the guide can stay open beside the
 * desk while the user keeps working.
 *
 * Markdown text is fetched from the main process over IPC
 * (window.chiphippo.docs.read) rather than fetch(), so it works under file://
 * in both `make debug` and a packaged build. The bundled marked + DOMPurify
 * renderer (renderMarkdown) turns it into sanitized HTML; styling comes from
 * styles/docs.css.
 *
 * Post-processing after render:
 *   - image src `images/x.png` → `docs/images/x.png` so it resolves relative
 *     to docs.html in the docs window;
 *   - heading ids are generated GitHub-style so in-page `#anchor` links
 *     resolve (marked no longer emits header ids by default);
 *   - links to other `*.md` pages become in-viewer navigation; external
 *     (http) links keep DOMPurify's target=_blank and open in the system
 *     browser (main's setWindowOpenHandler).
 *
 * Usage:
 *   import { DocsViewer } from "./components/docs-viewer.js";
 *   new DocsViewer().mount(document.getElementById("docs-root"));
 */

"use strict";

import renderMarkdown from "../vendor/markdown.js";

/**
 * Contents list, in display order. `slug` is the stable identity used for the
 * active-state and internal navigation; `file` is the markdown basename under
 * docs/ (defaults to slug — only the index page differs: README.md → overview).
 * Keep this array in sync with the copy in scripts/build-docs.mjs (order +
 * titles) — the two are hand-duplicated, not shared, since one runs in the
 * sandboxed renderer and the other under plain Node.
 */
export const PAGES = [
  { slug: "overview", file: "README", title: "Overview" },
  { slug: "getting-started", title: "Getting Started" },
  { slug: "the-desk", title: "The Desk & Breadboards" },
  { slug: "components", title: "Chips & Components" },
  { slug: "wiring", title: "Wiring, Nets & Buses" },
  { slug: "power-and-clocks", title: "Power & Clock Sources" },
  { slug: "chip-library", title: "The 74xx Chip Library" },
  { slug: "simulation", title: "Running a Simulation" },
  { slug: "probing", title: "Probing & Net Names" },
  { slug: "memory", title: "Memory Chips & the Inspector" },
  { slug: "logic-analyzer", title: "Logic Analyzer & Timing" },
  { slug: "build-guide", title: "Build Guide, Wiring List & BOM" },
  { slug: "schematic-view", title: "Schematic View" },
  { slug: "files-and-undo", title: "Files, Autosave & Undo" },
  { slug: "settings", title: "Settings" },
  { slug: "keyboard-shortcuts", title: "Keyboard Shortcuts" },
];

/** Map a doc filename (no extension) to its page slug, for resolving *.md links. */
const FILE_TO_SLUG = Object.fromEntries(
  PAGES.map((p) => [(p.file ?? p.slug).toLowerCase(), p.slug]),
);

/** GitHub-style heading slug: lowercased, punctuation stripped, spaces → hyphens. */
function slugifyHeading(text) {
  return (text ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export class DocsViewer {
  /** @type {HTMLElement} */
  #el;
  /** @type {HTMLElement} */
  #navEl;
  /** @type {HTMLElement} */
  #contentEl;

  // Slug of the page currently shown.
  #currentPage = "overview";

  // Monotonic load counter — a newer load() invalidates an in-flight older one
  // so rapid nav clicks can't race a stale page into the pane.
  #loadToken = 0;

  // Heading id to scroll to once the next page finishes rendering (set when an
  // internal link carried an #anchor).
  #pendingAnchor = null;

  constructor() {
    this.#el = this.#build();
    this.#bindEvents();
  }

  /** Root DOM element. */
  get element() {
    return this.#el;
  }

  /**
   * Append the viewer to a host element and show the initial page.
   * @param {HTMLElement} host
   * @param {string} [slug]
   * @returns {this}
   */
  mount(host, slug) {
    host.appendChild(this.#el);
    this.show(slug);
    return this;
  }

  /**
   * Navigate to a page (defaults to the current/initial page).
   * @param {string} [slug]
   */
  show(slug) {
    this.#loadPage(slug ?? this.#currentPage);
  }

  // ── Build ──────────────────────────────────────────────────────────────────

  #build() {
    const el = document.createElement("div");
    el.className = "docs-layout";

    const nav = PAGES.map(
      (p) =>
        `<button class="docs-nav-item" type="button" data-page="${p.slug}">${p.title}</button>`,
    ).join("");

    el.innerHTML = `
      <nav class="docs-nav" aria-label="User guide contents">
        <span class="docs-nav-title">Contents</span>
        ${nav}
      </nav>
      <article class="docs-content" tabindex="0"></article>
    `;

    this.#navEl = el.querySelector(".docs-nav");
    this.#contentEl = el.querySelector(".docs-content");
    return el;
  }

  #bindEvents() {
    // Contents-list navigation.
    this.#navEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".docs-nav-item");
      if (btn) this.#loadPage(btn.dataset.page);
    });

    // In-content links: same-page anchors and other doc pages stay in the
    // viewer; everything else (http links) falls through to DOMPurify's
    // target=_blank, which the main process opens in the system browser.
    this.#contentEl.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (!a || !this.#contentEl.contains(a)) return;
      const href = a.getAttribute("href") ?? "";

      if (href.startsWith("#")) {
        e.preventDefault();
        this.#scrollToAnchor(href.slice(1));
        return;
      }

      const m = /([^/]+)\.md(?:#(.+))?$/i.exec(href);
      if (!m) return; // not a doc link — let it open externally
      const slug = FILE_TO_SLUG[m[1].toLowerCase()];
      if (!slug) return; // unknown .md target — leave as-is
      e.preventDefault();
      this.#loadPage(slug, m[2] ?? null);
    });
  }

  // ── Page loading ─────────────────────────────────────────────────────────────

  /**
   * Load and render a page by slug, optionally scrolling to an #anchor.
   * @param {string} slug
   * @param {string|null} [anchor]
   */
  async #loadPage(slug, anchor = null) {
    const page = PAGES.find((p) => p.slug === slug);
    if (!page) return;

    this.#currentPage = slug;
    this.#pendingAnchor = anchor;
    this.#markActive(slug);

    const token = ++this.#loadToken;
    let md;
    try {
      md = await window.chiphippo.docs.read(page.file ?? page.slug);
    } catch (err) {
      if (token !== this.#loadToken) return;
      this.#contentEl.innerHTML = "";
      const p = document.createElement("p");
      p.className = "docs-error";
      p.textContent = `Couldn't load this page: ${err?.message ?? err}`;
      this.#contentEl.appendChild(p);
      return;
    }
    if (token !== this.#loadToken) return; // superseded by a newer load

    this.#contentEl.innerHTML = renderMarkdown(md);
    this.#postProcess();

    if (this.#pendingAnchor) this.#scrollToAnchor(this.#pendingAnchor);
    else this.#contentEl.scrollTop = 0;
  }

  /** Mark the active contents entry. */
  #markActive(slug) {
    this.#navEl.querySelectorAll(".docs-nav-item").forEach((btn) => {
      btn.classList.toggle("docs-nav-item--active", btn.dataset.page === slug);
    });
  }

  /**
   * Rewrite image sources to the bundled docs path and give every heading a
   * stable id so in-page anchors resolve.
   */
  #postProcess() {
    for (const img of this.#contentEl.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      if (src.startsWith("images/")) img.setAttribute("src", `docs/${src}`);
    }
    for (const h of this.#contentEl.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      if (!h.id) h.id = slugifyHeading(h.textContent);
    }
  }

  /** Scroll a heading (by id) into view within the content pane. */
  #scrollToAnchor(id) {
    const target =
      this.#contentEl.querySelector(`#${CSS.escape(id)}`) ??
      [...this.#contentEl.querySelectorAll("h1,h2,h3,h4,h5,h6")].find(
        (h) => h.id === id,
      );
    if (target) target.scrollIntoView({ block: "start" });
  }
}
