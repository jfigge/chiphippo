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
// and no writes. Its TWO bridge uses are both optional header buttons, each
// flagged by main on the query string because only main can see the file
// behind it: "open datasheet PDF" (?pdf=1 — the user's datasheet folder holds
// a <ref>.pdf) calls window.chiphippo.openDatasheet, and "open the example
// circuit" (?demo=1 — the app bundles a demonstration bench for this part)
// calls window.chiphippo.demo.open. The second is the one action here with a
// consequence: it adds a desktop to the open project, which is why it does not
// do so itself — this window has no project, so main relays the request to the
// app window. Main owns the window itself (float-above default + the
// right-click toggle).

import { partDef } from "./catalog/index.js";
import {
  buildPartPinout,
  buildWirePinout,
  datasheetButton,
  exampleButton,
} from "./components/chip-pinout.js";
import { ROTATIONS } from "./model/breadboard.js";

/**
 * Add the "open the example circuit" button to a pinout's header, LEFT of the
 * datasheet button. Shown only when main flagged (via ?demo=1) that this part
 * has a bundled demonstration bench; clicking it asks main to relay the request
 * to the app window. This window deliberately learns nothing back: it has no
 * project, no desk and no handshake — it knows a ref, and that is the whole
 * message.
 */
function addExampleButton(pinoutEl, partRef) {
  const header = pinoutEl.querySelector(".popup-header");
  if (!header) return;
  header.append(
    exampleButton(() =>
      Promise.resolve(window.chiphippo?.demo?.open?.(partRef)).catch((err) =>
        console.error("[pinout] demo:open failed:", err),
      ),
    ),
  );
}

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
const hasDemo = params.get("demo") === "1";
// A wire has no catalog def — its ref is just its own id (e.g. "w12"), so it
// carries this flag rather than resolving through partDef.
const isWire = params.get("kind") === "wire";
// Only a `def.can` (oscillator) layout is rotation-dependent — see
// buildCanPinout — but reading it here for every ref is harmless.
const rot = Number(params.get("rot"));
const def = !isWire && ref ? partDef(ref) : null;
const pinout = isWire
  ? buildWirePinout()
  : def
    ? buildPartPinout(def, ROTATIONS.includes(rot) ? rot : 0)
    : null;

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
  document.title = isWire ? "Wire" : `${def.id} · ${def.title}`;
  // Order is deliberate: the datasheet button is the incumbent and stays at the
  // far right, where a hand already goes. The example button — the one with a
  // consequence — sits inside it.
  if (hasDemo) addExampleButton(pinout, ref);
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
