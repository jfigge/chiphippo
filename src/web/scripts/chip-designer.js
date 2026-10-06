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

// chip-designer.js — entry point for the chip designer window
// (web/chip-designer.html): the one window that designs custom chips while
// the circuit is stopped and debugs them while it runs. Its own sandboxed
// renderer, so it reaches the main renderer only through main's relay
// (window.chiphippo.chipDesign.toHost / the chiphippo:chipdesign-inbound
// event): it announces `ready` and is told everything from then on.

import * as i18n from "./i18n.js";
import { followFontSize } from "./font-scale.js";
import { ChipDesignerView } from "./components/chip-designer-view.js";

const bridge = window.chiphippo;

// Its own catalog and text size, before anything is drawn (see pinout.js).
await i18n.init();
await followFontSize(bridge);

// Where its dividers were left — a preference of the window's own, kept in
// settings like the parts tray's width (an older settings file has none).
const settings = await Promise.resolve(bridge?.settings?.get?.()).catch(
  () => null,
);

const view = new ChipDesignerView(
  document.getElementById("chip-designer-root"),
  {
    send: (msg) => {
      bridge?.chipDesign?.toHost(msg)?.catch?.(() => {});
    },
    layout: {
      leftWidth: settings?.chipDesignerLeftWidth ?? null,
      headerHeight: settings?.chipDesignerHeaderHeight ?? null,
    },
    onLayout: (patch) => {
      Promise.resolve(bridge?.settings?.set?.(patch)).catch(() => {});
    },
  },
);

window.addEventListener("chiphippo:chipdesign-inbound", (e) => {
  // A host that started over (the app window reloaded) asks who is there.
  if (e.detail?.kind === "hello") {
    bridge?.chipDesign?.toHost({ kind: "ready" })?.catch?.(() => {});
    return;
  }
  view.receive(e.detail);
});

bridge?.chipDesign?.toHost({ kind: "ready" })?.catch?.(() => {});
