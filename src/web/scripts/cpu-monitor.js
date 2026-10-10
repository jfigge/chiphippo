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

// cpu-monitor.js — entry point for the CPU monitor window
// (web/cpu-monitor.html): a live view of one CPU on the desk. Its
// own sandboxed renderer, so it reaches the main renderer only through main's
// relay (window.chiphippo.cpuMonitor.toHost / the chiphippo:cpumonitor-inbound
// event): it announces `ready` and is told everything from then on
// (components/cpu-monitor-bridge.js).

import * as i18n from "./i18n.js";
import { followFontSize } from "./font-scale.js";
import { CpuMonitorView } from "./components/cpu-monitor-view.js";

const bridge = window.chiphippo;

// Its own catalog and text size, before anything is drawn (see pinout.js).
await i18n.init();
await followFontSize(bridge);
document.title = i18n.t("window.cpuMonitor");

const view = new CpuMonitorView(document.getElementById("cpu-monitor-root"), {
  send: (msg) => {
    bridge?.cpuMonitor?.toHost(msg)?.catch?.(() => {});
  },
});

window.addEventListener("chiphippo:cpumonitor-inbound", (e) => {
  // A host that started over (the app window reloaded) asks who is there.
  if (e.detail?.kind === "hello") {
    bridge?.cpuMonitor?.toHost({ kind: "ready" })?.catch?.(() => {});
    return;
  }
  view.receive(e.detail);
});

// Escape closes it, as it does the memory inspector — unless the view used it
// (a typed digit dropped, a selection let go), or the CPU picker has the key
// (there it closes the picker's list).
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (!e.target?.closest?.("select")) window.close();
});

bridge?.cpuMonitor?.toHost({ kind: "ready" })?.catch?.(() => {});
