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

// docs-pages.js — THE user guide's contents list, in one place.
//
// The same argument as heading-slug.js beside it, one field over: ONE Markdown
// source (src/web/docs/*.md) drives THREE outputs — the in-app viewer
// (components/docs-viewer.js), the hosted website and the PDF (both through
// scripts/build-docs.mjs) — so WHICH PAGES EXIST, in what order, under what
// titles, cannot be a per-renderer decision. Dependency-free (no DOM, no
// imports) so the sandboxed renderer loads it over file:// and a plain Node
// build script imports it by path, exactly as the slug rule is shared.
//
// IT WAS TWO COPIES, kept in step by a comment in each asking the next author
// to remember. They never disagreed — but the failure was silent by
// construction and asymmetric: a page added to the viewer's copy alone ships
// in the app and is missing from the website and the PDF; added to the build
// script's alone, it is on the website and nowhere in the app. Neither throws,
// neither is visible from the side you edited, and the guide is the one part of
// the product nobody re-reads end to end. The reason given for the split — one
// runs in the renderer, the other under plain Node — is the same reason the
// slug rule was said not to be shareable, and it was not true there either.

/**
 * Contents list, in display order. `slug` is the stable identity used for the
 * active-state and internal navigation; `file` is the markdown basename under
 * docs/ (defaults to slug — only the index page differs: README.md → overview).
 */
export const PAGES = Object.freeze([
  { slug: "overview", file: "README", title: "Overview" },
  { slug: "getting-started", title: "Getting Started" },
  { slug: "the-desk", title: "The Desk & Breadboards" },
  { slug: "components", title: "Chips & Components" },
  { slug: "wiring", title: "Wiring, Nets & Buses" },
  { slug: "power-and-clocks", title: "Power & Clock Sources" },
  { slug: "chip-library", title: "The Chip Library" },
  { slug: "simulation", title: "Running a Simulation" },
  { slug: "probing", title: "Probing & Net Names" },
  { slug: "memory", title: "Memory Chips & the Inspector" },
  { slug: "logic-analyzer", title: "Logic Analyzer & Timing" },
  { slug: "build-guide", title: "Build Guide & BOM" },
  { slug: "schematic-view", title: "Schematic View" },
  { slug: "ai-builder", title: "AI Circuit Builder" },
  { slug: "files-and-undo", title: "Files, Saving & Undo" },
  { slug: "projects-and-desktops", title: "Projects & Desktops" },
  { slug: "settings", title: "Settings" },
  { slug: "keyboard-shortcuts", title: "Keyboard Shortcuts" },
]);
