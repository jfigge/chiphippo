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

// project-doc.js — the open PROJECT as the renderer holds it: its name, its
// description, and its desktops, each carrying a whole desk document.
//
// This is `desk-doc.js` one level up, and it stands in the same relation to
// `app/store/project-store.js` that DeskDoc does to DeskStore: pure, DOM-free
// arithmetic over the shape, with main keeping its own independent guard on
// what may be written to a file. The duplication is deliberate — main must not
// trust a renderer meta, and as CommonJS it could not import this anyway.
//
// A desktop is STRUCTURE INSIDE THE DOCUMENT, not a file: adding, renaming,
// duplicating, importing and deleting one are ordinary unsaved changes, and
// nothing reaches disk until the project is saved. That is why every function
// here returns a NEW meta rather than mutating: the workspace assigns the
// result, and the one dirty test (`projectSignature`) is a plain comparison
// against the last-saved string.
//
// Documents are shared BY REFERENCE. They are the largest thing in a project
// and nothing here reads inside one — a tab's `doc` is opaque payload, and the
// only module that interprets it is DeskDoc.

/** Schema version of a project, matching app/store/project-store.js. */
export const PROJECT_VERSION = 4;

/** How long a project or desktop name may be (it suggests a file name). */
import { tf } from "../i18n.js";

const MAX_NAME = 64;

/** Trim a user-supplied string field, or "" for anything that isn't one. */
const text = (value) =>
  typeof value === "string" ? value.trim().slice(0, MAX_NAME) : "";

/** A tab record with the omit-when-empty description convention. */
function makeTab(id, name, description, doc) {
  const desc = text(description);
  return { id, name, ...(desc ? { description: desc } : {}), doc };
}

/**
 * Bring a project — as main hands it over, or as a test builds it — to the
 * shape everything here expects. Returns null when there is no project in it
 * at all (a project without a desktop is not a project).
 *
 * @param {object} raw
 * @returns {object|null} `{version, name, description, activeTab, nextIndex,
 *   tabs, location}`.
 */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tabs)) return null;
  const ids = new Set();
  const tabs = [];
  for (const tab of raw.tabs) {
    if (!tab || typeof tab !== "object") continue;
    const id = text(tab.id);
    const doc = tab.doc;
    if (!id || ids.has(id) || !doc || typeof doc !== "object") continue;
    ids.add(id);
    tabs.push(makeTab(id, text(tab.name) || id, tab.description, doc));
  }
  if (tabs.length === 0) return null;
  return {
    version: PROJECT_VERSION,
    name: text(raw.name),
    description: typeof raw.description === "string" ? raw.description : "",
    activeTab: tabs.some((t) => t.id === raw.activeTab)
      ? raw.activeTab
      : tabs[0].id,
    nextIndex: nextIndexFor(raw, tabs),
    tabs,
    location: typeof raw.location === "string" && raw.location ? raw.location : null, // prettier-ignore
  };
}

/** The desktop counter, never below what the ids already claim. */
function nextIndexFor(raw, tabs) {
  const highest = tabs.reduce((max, tab) => {
    const n = /^t(\d+)$/.exec(tab.id);
    return n ? Math.max(max, Number(n[1])) : max;
  }, 0);
  return Number.isInteger(raw.nextIndex) && raw.nextIndex > highest
    ? raw.nextIndex
    : highest + 1;
}

/** The tab with this id, or null. */
export function findDesktop(meta, id) {
  return meta?.tabs.find((tab) => tab.id === id) ?? null;
}

/** The tab on the desk. */
export function activeDesktop(meta) {
  return findDesktop(meta, meta?.activeTab);
}

/**
 * The next free desktop index. `nextIndex` only ever counts UP — deleting
 * "Desktop 2" never makes the next one Desktop 2 again, so a name in a note or
 * a screenshot keeps meaning the same desk.
 */
function mintIndex(meta) {
  const ids = new Set(meta.tabs.map((tab) => tab.id));
  let index = Number.isInteger(meta.nextIndex) && meta.nextIndex > 0 ? meta.nextIndex : 1; // prettier-ignore
  while (ids.has(`t${index}`)) index += 1;
  return index;
}

/** A name no other desktop is using ("Clock module copy", then "… copy 2"). */
function uniqueName(meta, base) {
  const taken = new Set(meta.tabs.map((tab) => tab.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Put one more desktop in the project, at `at` (default: the end), and make it
 * the active one — the point of adding a desktop is to work on it.
 *
 * @returns {{meta: object, tab: object}}
 */
function insertDesktop(meta, { doc, name, description }, at = -1) {
  const index = mintIndex(meta);
  const tab = makeTab(
    `t${index}`,
    uniqueName(
      meta,
      text(name) ||
        tf("workspace.defaultDesktopName", "Desktop {n}", { n: index }),
    ),
    description,
    doc,
  );
  const tabs = [...meta.tabs];
  tabs.splice(at < 0 ? tabs.length : at, 0, tab);
  return {
    meta: { ...meta, tabs, nextIndex: index + 1, activeTab: tab.id },
    tab,
  };
}

/** Add a blank desktop: the next "Desktop N", at the end of the strip. */
export function addDesktop(meta, doc) {
  return insertDesktop(meta, { doc });
}

/**
 * Add a desktop imported from a snapshot. `doc` has already been reseated by
 * main (fresh ROM guids and backing files), so an import can never share
 * memory with the desktop it came from.
 */
export function importDesktop(meta, { name, description, doc }) {
  return insertDesktop(meta, { doc, name, description });
}

/**
 * Copy one desktop, landing the copy directly after its source (where a tab
 * strip puts a duplicate). `doc` is the reseated copy main answered with.
 */
export function duplicateDesktop(meta, id, doc) {
  const source = findDesktop(meta, id);
  if (!source) return null;
  const at = meta.tabs.indexOf(source) + 1;
  return insertDesktop(
    meta,
    { doc, name: `${source.name} copy`, description: source.description },
    at,
  );
}

/**
 * Remove a desktop. Any of them can go EXCEPT the last one — a project with no
 * desktops has nothing to open — so this returns null rather than emptying it.
 * Removing the active desktop lands on its neighbour.
 */
export function removeDesktop(meta, id) {
  const index = meta.tabs.findIndex((tab) => tab.id === id);
  if (index < 0 || meta.tabs.length <= 1) return null;
  const tabs = meta.tabs.filter((tab) => tab.id !== id);
  const activeTab =
    meta.activeTab === id
      ? tabs[Math.min(index, tabs.length - 1)].id
      : meta.activeTab;
  return { ...meta, tabs, activeTab };
}

/** Put another desktop on the desk. */
export function setActiveDesktop(meta, id) {
  if (!findDesktop(meta, id)) return meta;
  return { ...meta, activeTab: id };
}

/**
 * Replace one desktop's document — the active desk being stashed on the way
 * out of a tab switch, or on the way into a save.
 */
export function setDesktopDoc(meta, id, doc) {
  if (!findDesktop(meta, id)) return meta;
  return {
    ...meta,
    tabs: meta.tabs.map((tab) => (tab.id === id ? { ...tab, doc } : tab)),
  };
}

/**
 * One Properties-dialog field on a desktop. A desktop must keep a NAME: an
 * empty one is refused rather than stored, so the strip can never render a
 * blank tab. Returns null when nothing changed, so the caller can skip the
 * commit the live-applying dialog would otherwise fire per keystroke.
 */
export function setDesktopField(meta, id, key, value) {
  const tab = findDesktop(meta, id);
  if (!tab) return null;
  const next = text(value);
  if (key === "name") {
    if (!next || next === tab.name) return null;
    return setDesktopTab(meta, id, { ...tab, name: next });
  }
  if (key === "description") {
    if (next === (tab.description ?? "")) return null;
    const { description: _drop, ...rest } = tab;
    void _drop;
    return setDesktopTab(
      meta,
      id,
      next ? { ...rest, description: next } : rest,
    );
  }
  return null; // Location is read-only: Export is what writes a desktop out
}

function setDesktopTab(meta, id, replacement) {
  return {
    ...meta,
    tabs: meta.tabs.map((tab) => (tab.id === id ? replacement : tab)),
  };
}

/**
 * One Properties-dialog field on the PROJECT itself. Its name may be blanked —
 * an unnamed project is a real state (the working slot) — and its description
 * is free text, so it is not length-capped the way a name is.
 */
export function setProjectField(meta, key, value) {
  if (key === "name") {
    const next = text(value);
    if (next === (meta.name ?? "")) return null;
    return { ...meta, name: next };
  }
  if (key === "description") {
    const next = typeof value === "string" ? value.trim() : "";
    if (next === (meta.description ?? "")) return null;
    return { ...meta, description: next };
  }
  return null; // Location is read-only: Save As is what changes it
}

/**
 * The project exactly as its FILE holds it — which is the whole document, so
 * this is what both the save and the dirty test are built on.
 */
export function projectForFile(meta) {
  return {
    name: meta.name ?? "",
    description: meta.description ?? "",
    activeTab: meta.activeTab,
    nextIndex: meta.nextIndex,
    tabs: meta.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      ...(tab.description ? { description: tab.description } : {}),
      doc: tab.doc,
    })),
  };
}

/**
 * The one dirty test: the whole project, minus which desktop is on screen.
 * Moving between tabs is not a change to keep or throw away — and neither is
 * panning, which is why a camera is never in a project file.
 */
export function projectSignature(meta) {
  const { activeTab: _active, ...rest } = projectForFile(meta);
  void _active;
  return JSON.stringify(rest);
}
