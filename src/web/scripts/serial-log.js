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

// serial-log.js — entry point for one connection's floating CONNECTION WINDOW
// (web/serial-log.html; docs/chiphippo-connection-window.md): the device's log
// output and the protocol traffic in one stream. Its own sandboxed renderer,
// like the pinout and memory windows, so it loads its own catalog and text
// size before painting.
//
// The connection id arrives on the query string; the stream so far — and how
// this connection's window was last showing it — is read once
// (`serial.log.read`), and every later entry arrives as `chiphippo:serial-log`
// (a `reset` one when a run begins, or on Clear). Main owns the stream (it
// outlives this window), so closing and reopening loses nothing.
//
// The built-in MOCK's window is this one with its SEND PANEL docked under the
// log (components/mock-panel.js): the read says so by carrying the Mock's
// state, and `chiphippo:serial-mock` keeps it current. The panel's log field
// follows the Log filter — a window not showing log lines has no use for a
// way to write one, and the stream takes the room back.

import * as i18n from "./i18n.js";
import { followFontSize } from "./font-scale.js";
import { SerialLogView } from "./components/serial-log-view.js";
import { MockPanel } from "./components/mock-panel.js";

const bridge = window.chiphippo;
const id = new URLSearchParams(location.search).get("id") ?? "";

await i18n.init();
await followFontSize(bridge);

let snapshot = null;
try {
  snapshot = await bridge?.serial?.log?.read?.(id);
} catch (err) {
  console.error("[serial-log] read failed:", err);
}

let panel = null;
const view = new SerialLogView(document.getElementById("serial-log-root"), {
  view: snapshot?.view,
  onClear: () => bridge?.serial?.log?.clear?.(id),
  onSave: (text) => bridge?.serial?.log?.save?.(id, text),
  onViewChange: (next) => {
    panel?.setLogShown(next.log);
    Promise.resolve(bridge?.serial?.log?.prefs?.(id, next)).catch(() => {});
  },
});
view.setName(snapshot?.name ?? id);
view.reset(snapshot?.entries ?? [], snapshot?.partial ?? "", snapshot?.t0);

// How narrow the window may go is its footer's to say (main only knows a
// floor): once the bundled font is in, and again whenever the text size moves.
const reportMinWidth = () =>
  Promise.resolve(bridge?.serial?.log?.minWidth?.(view.minWidth)).catch(
    () => {},
  );
document.fonts?.ready.then(reportMinWidth);
window.addEventListener("chiphippo:font-size-changed", reportMinWidth);

if (snapshot?.mock) {
  const root = document.getElementById("serial-log-root");
  root.classList.add("serial-log-root--mock");
  panel = new MockPanel(root, { bridge, state: snapshot.mock });
  panel.setLogShown(view.view.log);
  window.addEventListener("chiphippo:serial-mock", (e) => {
    if (e.detail?.id === id) panel.setState(e.detail);
  });
}

window.addEventListener("chiphippo:serial-log", (e) => {
  const detail = e.detail;
  if (!detail || detail.id !== id) return;
  if (detail.reset) {
    view.reset(detail.entries ?? [], detail.partial ?? "", detail.t0);
  } else {
    view.append(detail.entries ?? [], detail.partial ?? "");
  }
});
