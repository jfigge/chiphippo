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
//
// A CUSTOM chip (?custom=1) is in no catalog this window can load — the user
// designed it, and the open project may carry its own copy — so the app
// window says what to show, through main: this window asks for it
// (`pinout.chip`) and is told again whenever it changes (`pinout:chip`, a
// rename or a port added in the chip designer). In place of the datasheet and
// example buttons it has the one a designed chip needs: open its design
// (`pinout.openDesigner`, relayed to the app window as the example is).

import * as i18n from "./i18n.js";
import { t } from "./i18n.js";
import { followFontSize } from "./font-scale.js";
import { partDef } from "./catalog/index.js";
import {
  buildCustomPinout,
  buildPartPinout,
  buildWirePinout,
  chipDesignerButton,
  datasheetButton,
  exampleButton,
  pinoutHeading,
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

/** Add the "open in the Chip Designer" button to a custom chip's header. */
function addDesignerButton(pinoutEl, partRef) {
  const header = pinoutEl.querySelector(".popup-header");
  if (!header) return;
  header.append(
    chipDesignerButton(() =>
      Promise.resolve(window.chiphippo?.pinout?.openDesigner?.(partRef)).catch(
        (err) => console.error("[pinout] pinout:open-designer failed:", err),
      ),
    ),
  );
}

/** "No pin assignments" — a part this window cannot draw. */
function emptyMessage(partRef) {
  const msg = document.createElement("p");
  msg.className = "pinout-empty";
  msg.textContent = partRef
    ? t("pinout.noAssignments", { ref: partRef })
    : t("pinout.noPart");
  return msg;
}

// This window is its own sandboxed renderer, so it loads its own catalog before
// it builds anything — exactly as app.js does. Top-level await in a module is
// the whole mechanism: nothing below runs until the catalog is in place, so no
// `t()` here can resolve against an empty one.
await i18n.init();
// Settings ▸ Appearance ▸ Editor font size. Awaited beside the catalog and for
// the same reason: this window has no settings UI, it only follows, and it
// should not paint at one size and correct itself at another.
await followFontSize(window.chiphippo);

const root = document.getElementById("pinout-root");
const params = new URLSearchParams(location.search);
const ref = params.get("ref");
const hasPdf = params.get("pdf") === "1";
const hasDemo = params.get("demo") === "1";
// A wire has no catalog def — its ref is just its own id (e.g. "w12"), so it
// carries this flag rather than resolving through partDef.
const isWire = params.get("kind") === "wire";
const isCustom = params.get("custom") === "1";
// Only a `def.can` (oscillator) layout is rotation-dependent — see
// buildCanPinout — but reading it here for every ref is harmless.
const rot = Number(params.get("rot"));
const def = !isWire && !isCustom && ref ? partDef(ref) : null;
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

/** Draw a custom chip as the app window last described it. */
function showCustom(data) {
  const drawn = buildCustomPinout(ref, data);
  if (!drawn) {
    document.title = t("window.pinout");
    root.replaceChildren(emptyMessage(ref));
    return;
  }
  addDesignerButton(drawn, ref);
  document.title = drawn.querySelector(".popup-title")?.textContent ?? "";
  root.replaceChildren(drawn);
}

if (isCustom) {
  // The push first, then the ask: a change made while the ask is in flight
  // arrives after its answer, never before it.
  window.addEventListener("chiphippo:pinout-chip", (e) => {
    if (e.detail?.ref === ref) showCustom(e.detail.chip);
  });
  showCustom(await window.chiphippo?.pinout?.chip?.(ref)?.catch?.(() => null));
} else if (pinout) {
  document.title = isWire ? t("pinout.wireTitle") : pinoutHeading(def);
  // Order is deliberate: the datasheet button is the incumbent and stays at the
  // far right, where a hand already goes. The example button — the one with a
  // consequence — sits inside it.
  if (hasDemo) addExampleButton(pinout, ref);
  if (hasPdf) addDatasheetButton(pinout, ref);
  root.append(pinout);
} else {
  document.title = t("window.pinout");
  root.append(emptyMessage(ref));
}
