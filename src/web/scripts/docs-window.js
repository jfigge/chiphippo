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
 * docs-window.js — Bootstrap for the standalone user-guide window (docs.html).
 *
 * Mounts the DocsViewer into the page and wires Escape to close the window. The
 * window is created in the main process (openDocsWindow in main.js) and is
 * fully independent of the main window, so the guide stays readable while the
 * user works on the desk.
 */

"use strict";

import { DocsViewer } from "./components/docs-viewer.js";
import { followFontSize } from "./font-scale.js";

// Settings ▸ Appearance ▸ Editor font size, before the guide paints: this is
// the most text-heavy window in the app, so correcting the size after mounting
// would reflow the whole page in front of the reader.
await followFontSize(window.chiphippo);

const root = document.getElementById("docs-root");
new DocsViewer().mount(root);

// Escape closes the help window (Cmd/Ctrl+W is handled natively by the menu).
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    window.close();
  }
});
