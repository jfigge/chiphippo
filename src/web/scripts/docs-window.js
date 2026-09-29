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

/**
 * docs-window.js — Bootstrap for the standalone user-guide window (docs.html).
 *
 * Mounts the DocsViewer into the page and wires Escape to close the window. The
 * window is created in the main process (openDocsWindow in main.js) and is
 * fully independent of the main window, so the guide stays readable while the
 * user works on the desk.
 */

"use strict";

import { DocsViewer, PAGES } from "./components/docs-viewer.js";
import { followFontSize } from "./font-scale.js";

/** A page slug the contents list has, or undefined (→ the overview). */
const knownPage = (slug) =>
  PAGES.some((p) => p.slug === slug) ? slug : undefined;

// The page to open on: main names one (`?page=`) when the window was opened
// FOR a page — Settings ▸ Serial I/O's and the Generate card's protocol
// button. Asked again while open, main pushes `docs:show` instead; listened
// for BEFORE the await below, so one arriving while this window is still
// loading changes the page it opens on rather than being lost.
let viewer = null;
let page = knownPage(new URLSearchParams(window.location.search).get("page"));
window.addEventListener("chiphippo:docs-show", (e) => {
  const asked = knownPage(e.detail);
  if (!asked) return;
  if (viewer) viewer.show(asked);
  else page = asked;
});

// Settings ▸ Appearance ▸ Editor font size, before the guide paints: this is
// the most text-heavy window in the app, so correcting the size after mounting
// would reflow the whole page in front of the reader.
await followFontSize(window.chiphippo);

const root = document.getElementById("docs-root");
viewer = new DocsViewer().mount(root, page);

// Escape closes the help window (Cmd/Ctrl+W is handled natively by the menu).
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    window.close();
  }
});
