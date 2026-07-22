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

// pinout.js — entry point for the standalone pin-assignments OS window
// (web/pinout.html). Reads the part ref from the query string, renders its
// pin/terminal map via the shared buildPartPinout (chip / discrete / brick),
// and titles the window. A sandboxed reference view with no electrical logic
// and no writes; its ONE bridge use is the optional "open datasheet PDF"
// header button (shown when main flags ?pdf=1 because the user's datasheet
// folder holds a <ref>.pdf), which calls window.chiphippo.openDatasheet. Main
// owns the window itself (float-above default + the right-click toggle).

import { partDef } from "./catalog/index.js";
import { buildPartPinout, datasheetButton } from "./components/chip-pinout.js";

/**
 * Add the "open datasheet PDF" button to a pinout's header (top-right). Shown
 * only when main flagged (via ?pdf=1) that the user's datasheet folder holds a
 * `<ref>.pdf`; clicking it asks main to open that PDF natively.
 */
function addDatasheetButton(pinoutEl, partRef) {
  const header = pinoutEl.querySelector(".popup-header");
  if (!header) return;
  header.append(
    datasheetButton(() =>
      Promise.resolve(window.chiphippo?.openDatasheet?.(partRef)).catch((err) =>
        console.error("[pinout] datasheet:open failed:", err),
      ),
    ),
  );
}

const root = document.getElementById("pinout-root");
const params = new URLSearchParams(location.search);
const ref = params.get("ref");
const hasPdf = params.get("pdf") === "1";
const def = ref ? partDef(ref) : null;
const pinout = def ? buildPartPinout(def) : null;

// Escape closes the floating window — the same reflex as dismissing an in-app
// modal, even though this is its own OS window (Electron routes window.close()
// to the BrowserWindow). The native frame's close button still works too.
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    window.close();
  }
});

if (pinout) {
  document.title = `${def.id} · ${def.title}`;
  if (hasPdf) addDatasheetButton(pinout, ref);
  root.append(pinout);
} else {
  document.title = "Pin assignments";
  const msg = document.createElement("p");
  msg.className = "pinout-empty";
  msg.textContent = ref
    ? `No pin assignments for “${ref}”.`
    : "No part selected.";
  root.append(msg);
}
