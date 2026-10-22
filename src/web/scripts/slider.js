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

// slider.js — entry point for a floated slider's OS window (web/slider.html,
// one per part and field — a potentiometer's Position). It reads which from
// the query string and draws a SliderPanel, and reaches the app window ONLY
// through main's relay (window.chiphippo.slider.toHost / the
// chiphippo:slider-inbound event): it announces `ready` to be told what to
// show, then reports each move of the thumb, being pointed at or focused, and
// a tapped Space. The app window owns everything it shows (see
// components/slider-windows.js); closing it is the native frame's ×.

import * as i18n from "./i18n.js";
import { followFontSize } from "./font-scale.js";
import { SliderPanel } from "./components/slider-panel.js";

const bridge = window.chiphippo;
const params = new URLSearchParams(location.search);
const compId = params.get("comp");
const key = params.get("key");

// Its own sandboxed renderer: its own catalog and its own text size first.
await i18n.init();
await followFontSize(bridge);

const tell = (msg) => bridge.slider.toHost(compId, key, msg);

const panel = new SliderPanel(document.getElementById("slider-root"), {
  onSet: (value, seq) => tell({ kind: "set", value, seq }),
  onHover: (on) => tell({ kind: "hover", on }),
  onRunToggle: () => tell({ kind: "run-toggle" }),
});

window.addEventListener("chiphippo:slider-inbound", (e) => {
  const detail = e.detail;
  if (detail?.compId !== compId || detail?.key !== key) return;
  panel.show(detail.msg);
  if (panel.title) document.title = panel.title;
});

tell({ kind: "ready" });
