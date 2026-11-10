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

// recent-projects-view.js — the Browse window's RECENT PROJECTS tab: the
// projects File ▸ Open Recent lists, as pictures of their boards.
//
// The gallery's own card, reused (`.gallery-grid` / `.gallery-card` and the
// striped `gallery-thumb--empty` placeholder), so the two tabs read as one
// window. What differs is what a card is for: a recent project is opened by
// clicking it — there is no detail pane, since there is nothing more to say
// about a file of your own — and it carries a × that drops it from the list
// (the list only, never the file), exactly as the menu's × does.
//
// Pure view: it reads through `source` and acts through `onOpen`/`onRemove`,
// so it knows nothing of the bridge (gallery-window.js hands both in).

import { el } from "../dom.js";

/**
 * @typedef {{path: string, name: string, savedAt: number|null,
 *   missing: boolean, thumb: string|null, desktops: number|null}} RecentProject
 */

/**
 * Which projects a search shows: every word of the query somewhere in the
 * name or the path, case-insensitively.
 * @param {RecentProject[]} projects
 * @param {string} query
 */
export function filterRecent(projects, query) {
  const words = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return projects;
  return projects.filter((p) => {
    const text = `${p.name}\n${p.path}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export class RecentProjectsView {
  #root;
  #load;
  #say;
  #formatDate;
  #onOpen;
  #onRemove;
  #projects = [];
  /** Each refresh's number, so an older answer landing late is dropped. */
  #reads = 0;
  /** Paths removed here → the read number current when they were: a read
      begun BEFORE the removal still lists the path, and must not draw it
      back. A read begun after it is main's word, and clears the note. */
  #removed = new Map();
  #query = "";
  #grid;
  #status;
  #search;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root
   * @param {() => Promise<RecentProject[]>} opts.load - the list, read fresh.
   * @param {(key: string, params?: object) => string} opts.say - `browse.*`.
   * @param {(ms: number) => string} opts.formatDate
   * @param {(project: RecentProject) => void} opts.onOpen
   * @param {(project: RecentProject) => void} opts.onRemove
   */
  constructor({ root, load, say, formatDate, onOpen, onRemove }) {
    this.#root = root;
    this.#load = load;
    this.#say = say;
    this.#formatDate = formatDate;
    this.#onOpen = onOpen;
    this.#onRemove = onRemove;
    this.#build();
  }

  /** What is drawn now (for a test). */
  get shown() {
    return filterRecent(this.#projects, this.#query);
  }

  /** Read the list again and draw it. Resolves once it is drawn. */
  async refresh() {
    const read = ++this.#reads;
    let list;
    try {
      list = await this.#load();
    } catch (err) {
      console.error("[browse] the recent projects could not be read:", err);
      list = [];
    }
    if (read !== this.#reads) return; // a newer read is on its way
    for (const [path, at] of this.#removed) {
      if (at < read) this.#removed.delete(path);
    }
    this.#projects = (Array.isArray(list) ? list : []).filter(
      (p) => !this.#removed.has(p?.path),
    );
    this.#render();
  }

  #build() {
    this.#root.classList.add("gallery-view", "browse-recent");
    const controls = el("div", { class: "gallery-controls" });
    this.#search = el("input", {
      class: "gallery-search",
      type: "search",
      placeholder: this.#say("search"),
      "aria-label": this.#say("search"),
    });
    this.#search.addEventListener("input", () => {
      this.#query = this.#search.value;
      this.#render();
    });
    controls.append(this.#search);
    this.#status = el("p", { class: "gallery-status", role: "status" });
    this.#grid = el("ul", { class: "gallery-grid" });
    this.#root.append(controls, this.#status, this.#grid);
  }

  #render() {
    const shown = this.shown;
    this.#status.hidden = shown.length > 0;
    if (!shown.length) {
      this.#status.textContent = this.#projects.length
        ? this.#say("noMatch")
        : this.#say("empty");
    }
    this.#grid.replaceChildren(...shown.map((p) => this.#card(p)));
  }

  #card(project) {
    const thumb = el("span", {
      class: "gallery-card-thumb gallery-thumb--empty",
    });
    if (project.thumb) {
      const img = el("img", { alt: "", loading: "lazy" });
      img.addEventListener("load", () =>
        thumb.classList.remove("gallery-thumb--empty"),
      );
      img.addEventListener("error", () => img.remove());
      img.src = project.thumb;
      thumb.append(img);
    }
    const meta = project.missing
      ? this.#say("missing")
      : [
          project.savedAt != null
            ? this.#say("saved", { date: this.#formatDate(project.savedAt) })
            : "",
          project.desktops ? this.#say("desktops", { count: project.desktops }) : "", // prettier-ignore
        ]
          .filter(Boolean)
          .join(" · ");
    const card = el(
      "button",
      {
        class: `gallery-card${project.missing ? " gallery-card--missing" : ""}`,
        type: "button",
        title: project.path,
        onClick: () => this.#onOpen(project),
      },
      [
        thumb,
        el("span", { class: "gallery-card-title", text: project.name }),
        el("span", { class: "gallery-card-author", text: meta }),
      ],
    );
    const remove = el("button", {
      class: "browse-card-remove",
      type: "button",
      text: "×",
      title: this.#say("remove", { name: project.name }),
      "aria-label": this.#say("remove", { name: project.name }),
      onClick: () => {
        this.#removed.set(project.path, this.#reads);
        this.#projects = this.#projects.filter((p) => p !== project);
        this.#render();
        this.#onRemove(project);
      },
    });
    return el("li", { class: "gallery-card-item browse-card-item" }, [
      card,
      remove,
    ]);
  }
}
