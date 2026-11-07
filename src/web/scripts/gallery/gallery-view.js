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

// gallery-view.js — THE gallery's grid, written once (the gallery work,
// features/chiphippo-gallery-plan.md → Phase 2): cards, search, filters and a
// detail pane, the same code on chiphippo.com/gallery/ and (Phase 3) in the
// app's Browse window (its Gallery tab). Plain DOM, no framework, and no I/O of its own:
// what differs between the two homes is handed in —
//
//   · `source` — where the index and the thumbnails come from. The website
//     fetches them; the app cannot (its CSP has no connect-src), so main
//     fetches and hands them over;
//   · `say(key, params)` — the words. The website passes English; the app
//     passes its `t()` over `gallery.*`;
//   · `actions` — the buttons on an entry: links on the website (Open in
//     browser, Download), handlers in the app.
//
// The filtering is pure (`filterEntries`, `tagsOf`) and tested without a DOM.

/** Every tag an index's entries carry (their own and the derived), sorted. */
export function tagsOf(entries) {
  const tags = new Set();
  for (const e of entries ?? []) {
    for (const tag of [...(e.tags ?? []), ...(e.derived?.autoTags ?? [])]) {
      tags.add(tag);
    }
  }
  return [...tags].sort();
}

/**
 * The entries a search and the filters leave. The query matches the title,
 * the author and any tag, case-blind, every word of it; an empty filter is no
 * filter. Featured entries first, then the index's own order.
 * @param {object[]} entries - index summaries (index-format.js).
 * @param {{query?: string, tag?: string, level?: string, engine?: string}} f
 */
export function filterEntries(
  entries,
  { query = "", tag = "", level = "", engine = "" } = {},
) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const kept = (entries ?? []).filter((e) => {
    const tags = [...(e.tags ?? []), ...(e.derived?.autoTags ?? [])];
    if (tag && !tags.includes(tag)) return false;
    if (level && e.derived?.level !== level) return false;
    if (engine && e.derived?.engine !== engine) return false;
    const hay = [e.title, e.author, ...tags].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return [
    ...kept.filter((e) => e.featured),
    ...kept.filter((e) => !e.featured),
  ];
}

const LEVELS = ["beginner", "intermediate", "advanced"];
const ENGINES = ["logic", "spice"];

/** An element with a class and (optionally) text. */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class GalleryView {
  #root;
  #doc;
  #source;
  #say;
  #actions;
  #entries = [];
  #filters = { query: "", tag: "", level: "", engine: "" };
  #grid;
  #status;
  #detail;
  #tagSelect;

  /**
   * @param {{root: HTMLElement,
   *   source: {index: () => Promise<{entries: object[]}>,
   *            thumbUrl: (entry: object) => string|null|Promise<string|null>},
   *   say: (key: string, params?: object) => string,
   *   actions: Array<{id: string, label: string,
   *                   href?: (entry: object) => string,
   *                   download?: (entry: object) => string,
   *                   onClick?: (entry: object) => void}>}} opts
   */
  constructor({ root, source, say, actions = [] }) {
    this.#root = root;
    this.#doc = root.ownerDocument;
    this.#source = source;
    this.#say = say;
    this.#actions = actions;
    this.#build();
  }

  /** Fetch the index and draw it. Resolves when the grid is drawn. */
  async load() {
    this.#status.textContent = this.#say("loading");
    this.#status.hidden = false;
    try {
      const index = await this.#source.index();
      this.#entries = Array.isArray(index?.entries) ? index.entries : [];
    } catch (err) {
      console.error("[gallery] the index could not be read:", err);
      this.#entries = [];
      this.#status.textContent = this.#say("failed");
      return;
    }
    this.#fillTags();
    this.#render();
  }

  /** What is drawn now (for a test, and the app's window title). */
  get shown() {
    return filterEntries(this.#entries, this.#filters);
  }

  #build() {
    const d = this.#doc;
    this.#root.classList.add("gallery-view");
    const controls = el(d, "div", "gallery-controls");
    const search = el(d, "input", "gallery-search");
    search.type = "search";
    search.placeholder = this.#say("search");
    search.setAttribute("aria-label", this.#say("search"));
    search.addEventListener("input", () => {
      this.#filters.query = search.value;
      this.#render();
    });
    this.#tagSelect = this.#select("tag", this.#say("allTags"), []);
    controls.append(
      search,
      this.#tagSelect,
      this.#select("level", this.#say("allLevels"), LEVELS.map((l) => [l, this.#say(`level.${l}`)])), // prettier-ignore
      this.#select("engine", this.#say("allEngines"), ENGINES.map((e) => [e, this.#say(`engine.${e}`)])), // prettier-ignore
    );
    this.#status = el(d, "p", "gallery-status");
    this.#status.setAttribute("role", "status");
    this.#grid = el(d, "ul", "gallery-grid");
    this.#detail = el(d, "section", "gallery-detail");
    this.#detail.hidden = true;
    this.#root.append(controls, this.#status, this.#grid, this.#detail);
  }

  #select(key, allLabel, options) {
    const select = el(
      this.#doc,
      "select",
      `gallery-filter gallery-filter-${key}`,
    );
    select.setAttribute("aria-label", allLabel);
    this.#options(select, allLabel, options);
    select.addEventListener("change", () => {
      this.#filters[key] = select.value;
      this.#render();
    });
    return select;
  }

  #options(select, allLabel, options) {
    const all = el(this.#doc, "option", null, allLabel);
    all.value = "";
    select.replaceChildren(all);
    for (const [value, label] of options) {
      const o = el(this.#doc, "option", null, label);
      o.value = value;
      select.append(o);
    }
  }

  #fillTags() {
    const tags = tagsOf(this.#entries);
    this.#options(
      this.#tagSelect,
      this.#say("allTags"),
      tags.map((t) => [t, t]),
    );
    if (!tags.includes(this.#filters.tag)) this.#filters.tag = "";
    this.#tagSelect.value = this.#filters.tag;
  }

  #render() {
    const shown = this.shown;
    this.#status.hidden = shown.length > 0;
    if (!shown.length) this.#status.textContent = this.#say("empty");
    this.#grid.replaceChildren(...shown.map((e) => this.#card(e)));
  }

  #card(entry) {
    const d = this.#doc;
    const li = el(d, "li", "gallery-card-item");
    const card = el(d, "button", "gallery-card");
    card.type = "button";
    card.dataset.id = entry.id;
    if (entry.featured) card.classList.add("gallery-card--featured");
    card.append(
      this.#thumb(entry, "gallery-card-thumb"),
      el(d, "span", "gallery-card-title", entry.title),
      el(
        d,
        "span",
        "gallery-card-author",
        this.#say("by", { author: entry.author }),
      ),
      this.#badges(entry),
    );
    card.addEventListener("click", () => this.#open(entry));
    li.append(card);
    return li;
  }

  #badges(entry) {
    const d = this.#doc;
    const row = el(d, "span", "gallery-badges");
    row.append(
      el(d, "span", "gallery-badge", this.#say(`level.${entry.derived?.level ?? "beginner"}`)), // prettier-ignore
      el(d, "span", "gallery-badge", this.#say(`engine.${entry.derived?.engine ?? "logic"}`)), // prettier-ignore
    );
    for (const tag of entry.tags ?? []) {
      row.append(el(d, "span", "gallery-badge gallery-badge--tag", tag));
    }
    return row;
  }

  /** A thumbnail, or the placeholder when there is none (or it fails). */
  #thumb(entry, className) {
    const box = el(this.#doc, "span", `${className} gallery-thumb--empty`);
    void Promise.resolve(this.#source.thumbUrl(entry)).then((url) => {
      if (!url) return;
      const img = el(this.#doc, "img");
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("load", () => box.classList.remove("gallery-thumb--empty")); // prettier-ignore
      img.addEventListener("error", () => img.remove());
      img.src = url;
      box.append(img);
    });
    return box;
  }

  #open(entry) {
    const d = this.#doc;
    const close = el(d, "button", "gallery-detail-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", this.#say("close"));
    close.addEventListener("click", () => {
      this.#detail.hidden = true;
      this.#grid.querySelector(`[data-id="${entry.id}"]`)?.focus();
    });
    const facts = el(d, "p", "gallery-detail-facts",
      this.#say("facts", { chips: entry.derived?.chips ?? 0, parts: entry.derived?.parts ?? 0 })); // prettier-ignore
    const actions = el(d, "div", "gallery-detail-actions");
    for (const action of this.#actions) {
      const button = el(
        d,
        action.href ? "a" : "button",
        "gallery-action",
        action.label,
      );
      button.dataset.action = action.id;
      if (action.href) {
        button.href = action.href(entry);
        if (action.download)
          button.setAttribute("download", action.download(entry));
      } else {
        button.type = "button";
        button.addEventListener("click", () => action.onClick?.(entry));
      }
      actions.append(button);
    }
    this.#detail.replaceChildren(
      close,
      this.#thumb(entry, "gallery-detail-thumb"),
      el(d, "h2", "gallery-detail-title", entry.title),
      el(
        d,
        "p",
        "gallery-detail-author",
        this.#say("by", { author: entry.author }),
      ),
      this.#badges(entry),
      facts,
      el(d, "p", "gallery-detail-description"),
      actions,
    );
    this.#detail.dataset.id = entry.id;
    this.#detail.hidden = false;
    void this.#description(entry);
    close.focus();
  }

  /** The description is not in the index: the entry itself is fetched. */
  async #description(entry) {
    if (typeof this.#source.entry !== "function") return;
    try {
      const full = await this.#source.entry(entry.id);
      if (this.#detail.dataset.id !== entry.id) return;
      const box = this.#detail.querySelector(".gallery-detail-description");
      if (box) box.textContent = full?.description ?? "";
    } catch (err) {
      console.error("[gallery] the entry could not be read:", err);
    }
  }
}
