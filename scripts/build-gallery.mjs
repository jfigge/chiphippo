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

// build-gallery.mjs — write the gallery's published files into
// website/gallery/ (the gallery work, features/chiphippo-gallery-plan.md →
// Phase 2): index.json, one folder per entry (entry.json + the design), and
// lib/ — the shared view the page imports. All of it GENERATED and
// git-ignored; the page itself (index.html, gallery.js) and the seed list are
// committed.
//
// TWO SOURCES OF ENTRIES:
//   · the SEED (website/gallery/seed.json): example desktops the app ships,
//     each named by its demo file and desktop. The design is read from the
//     demos given (`--demos`) — the deploy passes the RELEASE's own copy
//     (website/desktop/demos/), so a seed can never drift from the app that
//     opens it. Its id is fixed in seed.json, so links to it outlive releases;
//   · the GALLERY REPO (`--entries <chiphippo-gallery>/entries`): one folder
//     per published entry — entry.json + design.desktop.chiphippo (+ a
//     thumbnail). Its derived fields are RECOMPUTED here, never copied.
//
// EVERY DESIGN IS VALIDATED (gallery/validate.js) with main's own migrations.
// One that fails is left out and reported; `--strict` (the deploy) fails the
// build instead, so a broken seed is a red deploy rather than a quiet gap.
//
//   node scripts/build-gallery.mjs [--demos DIR] [--entries DIR] [--out DIR]
//     [--app-version X.Y.Z] [--generated YYYY-MM-DD] [--strict]

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ENTRY_ID_RE,
  ENTRY_SCHEMA,
  checkEntryText,
  normalizeEntry,
} from "../src/web/scripts/gallery/entry-format.js";
import { buildIndex } from "../src/web/scripts/gallery/index-format.js";
import { validateSubmission } from "../src/web/scripts/gallery/validate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { migrateDeskDocument } = require("../src/app/store/migrations.js");

/** What the page imports from lib/ — the view and what it reads with. */
export const LIB_FILES = Object.freeze([
  "gallery-view.js",
  "index-format.js",
  "entry-format.js",
]);
const DESIGN_FILE = "design.desktop.chiphippo";
const THUMB_FILE = "thumb.png";

/** One shipped example desktop as a desktop snapshot (the Export shape). */
export function seedSnapshot(seed, demo) {
  const desktops = demo.desktops ?? [{ name: demo.title, doc: demo.doc }];
  const desk = desktops.find((d) => d.name === seed.desktop);
  if (!desk) return null;
  return {
    version: 5,
    kind: "desktop",
    // The desktop it opens as is named for the entry: the app's "already
    // open?" test is the tab's name.
    name: seed.title,
    description: seed.description ?? "",
    doc: desk.doc,
    ...(demo.images ? { images: demo.images } : {}),
  };
}

/** An entry's metadata, the derived block from the validator. */
function entryOf(fields, result, extra) {
  return normalizeEntry({
    schema: ENTRY_SCHEMA,
    kind: "design",
    ...fields,
    ...extra,
    docVersion: result.docVersion,
    derived: result.derived,
  });
}

/**
 * Build the gallery's published files.
 * @param {{seed?: string, demos?: string, entries?: string|null, out?: string,
 *   appVersion?: string, generated?: string}} [opts]
 * @returns {{index: object, problems: Array<{id: string, problems: object[]}>,
 *   written: number}}
 */
export function buildGallery({
  seed = join(ROOT, "website/gallery/seed.json"),
  demos = join(ROOT, "src/web/demos"),
  entries = null,
  out = join(ROOT, "website/gallery"),
  appVersion = JSON.parse(readFileSync(join(ROOT, "src/package.json"), "utf8")).version, // prettier-ignore
  generated = new Date().toISOString().slice(0, 10),
} = {}) {
  const published = []; // {entry, design, thumb}
  const problems = [];
  const ids = new Set();
  const take = (id, entry, design, thumb, result) => {
    if (!result.ok || !entry) {
      problems.push({ id, problems: result.problems.length ? result.problems : [{ code: "badEntry" }] }); // prettier-ignore
      return;
    }
    if (ids.has(entry.id)) {
      problems.push({ id, problems: [{ code: "duplicateId" }] });
      return;
    }
    ids.add(entry.id);
    published.push({ entry, design, thumb });
  };

  // ── The seed ──
  const seedList = JSON.parse(readFileSync(seed, "utf8"));
  for (const s of seedList.entries ?? []) {
    const demoPath = join(demos, s.demo);
    const snapshot = existsSync(demoPath)
      ? seedSnapshot(s, JSON.parse(readFileSync(demoPath, "utf8")))
      : null;
    if (!snapshot) {
      problems.push({ id: s.id, problems: [{ code: "noSuchDemo", demo: s.demo, desktop: s.desktop }] }); // prettier-ignore
      continue;
    }
    const design = JSON.stringify(snapshot);
    const result = validateSubmission(design, { migrate: migrateDeskDocument });
    const text = checkEntryText({ ...s, author: seedList.author });
    if (text.problems.length) result.problems.push(...text.problems);
    result.ok &&= text.problems.length === 0;
    const entry = entryOf(text.value, result, {
      id: s.id,
      created: s.created ?? seedList.created ?? generated,
      source: "seed",
      featured: s.featured === true,
      appVersion,
    });
    take(s.id, entry, design, null, result);
  }

  // ── The gallery repo ──
  if (entries && existsSync(entries)) {
    for (const id of readdirSync(entries).sort()) {
      const dir = join(entries, id);
      if (!ENTRY_ID_RE.test(id) || !existsSync(join(dir, "entry.json")))
        continue;
      let raw;
      try {
        raw = JSON.parse(readFileSync(join(dir, "entry.json"), "utf8"));
      } catch {
        problems.push({ id, problems: [{ code: "notJson", file: "entry.json" }] }); // prettier-ignore
        continue;
      }
      const design = existsSync(join(dir, DESIGN_FILE))
        ? readFileSync(join(dir, DESIGN_FILE), "utf8")
        : null;
      const result = validateSubmission(design, { migrate: migrateDeskDocument }); // prettier-ignore
      const text = checkEntryText(raw);
      if (text.problems.length) result.problems.push(...text.problems);
      result.ok &&= text.problems.length === 0;
      // The folder IS the id: an entry.json naming another is refused.
      if (raw.id !== id) {
        result.problems.push({ code: "idMismatch", folder: id, id: raw.id });
        result.ok = false;
      }
      const entry = entryOf(text.value, result, {
        id,
        created: raw.created,
        source: raw.source === "maintainer" ? "maintainer" : "shared",
        featured: raw.featured === true,
        appVersion: raw.appVersion || appVersion,
      });
      const thumb = existsSync(join(dir, THUMB_FILE)) ? join(dir, THUMB_FILE) : null; // prettier-ignore
      take(id, entry, design, thumb, result);
    }
  }

  // ── Write ── (the generated parts only: index.html, gallery.js and
  // seed.json are the committed page, and are never touched here)
  mkdirSync(out, { recursive: true });
  for (const sub of ["entries", "lib"]) rmSync(join(out, sub), { recursive: true, force: true }); // prettier-ignore
  const index = buildIndex(
    published.map((p) => p.entry),
    { generated },
  );
  writeFileSync(join(out, "index.json"), `${JSON.stringify(index)}\n`);
  for (const { entry, design, thumb } of published) {
    const dir = join(out, "entries", entry.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "entry.json"), `${JSON.stringify(entry, null, 2)}\n`); // prettier-ignore
    writeFileSync(join(dir, DESIGN_FILE), design);
    if (thumb) copyFileSync(thumb, join(dir, THUMB_FILE));
  }
  mkdirSync(join(out, "lib"), { recursive: true });
  for (const file of LIB_FILES) {
    copyFileSync(join(ROOT, "src/web/scripts/gallery", file), join(out, "lib", file)); // prettier-ignore
  }
  return { index, problems, written: published.length };
}

const IS_MAIN =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (IS_MAIN) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const opts = {};
  for (const [flag, key] of [
    ["demos", "demos"],
    ["entries", "entries"],
    ["out", "out"],
  ]) {
    // prettier-ignore
    if (arg(flag)) opts[key] = resolve(arg(flag));
  }
  if (arg("app-version")) opts.appVersion = arg("app-version");
  if (arg("generated")) opts.generated = arg("generated");
  const { problems, written } = buildGallery(opts);
  for (const p of problems) {
    console.error(`gallery: ${p.id} left out — ${JSON.stringify(p.problems)}`);
  }
  console.log(`gallery: ${written} entries written`);
  if (problems.length && process.argv.includes("--strict")) process.exit(1);
}
