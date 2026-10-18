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

// terminal.js — entry point for a Terminal window (web/terminal.html,
// Feature 420): one USB-serial adapter's far end. Its own sandboxed
// renderer, so it reaches the main renderer only through main's relay
// (window.chiphippo.terminal.toHost / the chiphippo:terminal-inbound event):
// it announces `ready` and is sent everything from then on
// (components/terminal-bridge.js).

import * as i18n from "./i18n.js";
import { followFontSize } from "./font-scale.js";
import { TerminalView } from "./components/terminal-view.js";

const bridge = window.chiphippo;
const compId = new URLSearchParams(location.search).get("comp") ?? "";

// Its own catalog and text size, before anything is drawn (see pinout.js).
await i18n.init();
await followFontSize(bridge);
document.title = i18n.t("window.terminal");

const toHost = (msg) => {
  bridge?.terminal?.toHost(compId, msg)?.catch?.(() => {});
};

const view = new TerminalView(document.getElementById("terminal-root"), {
  send: toHost,
});

window.addEventListener("chiphippo:terminal-inbound", (e) => {
  if (e.detail?.compId !== compId) return;
  view.receive(e.detail.msg);
});

toHost({ kind: "ready" });
