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

// The connectivity probe (components/probe-inspector.js) shows, and NAMES,
// the net as the BUILD wired it: a closed switch must not carry the highlight
// or a name from one side of its contact onto the other — onto the rail and
// every pin on it. Its level tint is still the live net's.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { ProbeInspector } = await import("../components/probe-inspector.js");
const { NetlistCache } = await import("../components/netlist-cache.js");
const { PopupManager } = await import("../popup-manager.js");

/** A full kit with a slide switch at a10…a12 thrown onto the + rail. */
function bench() {
  const doc = new DeskDoc(null);
  doc.addKit("full", 0, 0); // bb1 rail · bb2 pins · bb3 rail
  doc.addComponent({
    kind: "discrete",
    ref: "sw-slide",
    board: "bb2",
    anchor: "a10",
    params: { pos: "1" },
  });
  doc.addWire({ from: "bb2.b10", to: "bb1.+1" });
  return doc;
}

function mount(doc, { levels = new Map() } = {}) {
  resetDom();
  const overlay = document.createElement("div");
  const viewport = document.createElement("div");
  const ring = document.createElement("div");
  document.body.append(overlay, viewport, ring);
  const live = new NetlistCache(doc);
  let at = null;
  const named = [];
  const probe = new ProbeInspector({
    doc,
    overlay,
    viewport,
    ring,
    simOverlay: { levelOfNet: (netId) => levels.get(netId) ?? null },
    hitTest: () => (at ? { address: at, x: 0, y: 0 } : null),
    addressWorld: () => ({ x: 0, y: 0 }),
    onNameNet: (address, name, stale) => named.push({ address, name, stale }),
    onClearNetNames: () => {},
    coordinate: {
      cancelPlacement() {},
      disarmWireTool() {},
      deselect() {},
      hideHover() {},
    },
    netlist: new NetlistCache(doc, { bridges: false }),
    liveNetlist: live,
  });
  probe.arm();
  return {
    probe,
    live,
    named,
    overlay,
    status: () => viewport.querySelector(".net-status").textContent,
    point: (address) => {
      at = address;
      probe.trackMove({ x: 0, y: 0 });
    },
    dots: () => overlay.querySelectorAll(".net-highlight-dot").length,
  };
}

test("the probe shows the wired net — the switch's closed contact stops it", () => {
  const h = mount(bench());
  h.point("bb2.c11"); // the common's column
  assert.equal(h.dots(), 5, "the five holes of a11's column, not the rail");
  assert.doesNotMatch(h.status(), /rail/);
});

test("naming at the common names its own net, and asks to drop nothing past the switch", () => {
  const doc = bench();
  doc.nameNet("bb1.+5", "VCC");
  const h = mount(doc);
  h.point("bb2.c11");
  h.probe.onContextMenu({ x: 0, y: 0 }, { clientX: 0, clientY: 0 });
  const items = [...document.querySelectorAll(".popup-menu-item")].map((b) =>
    b.textContent.trim(),
  );
  assert.deepEqual(items, ["Name this net…"], "unnamed here, VCC or not");
  document.querySelector(".popup-menu-item").click();
  const input = document.querySelector(".popup-input, dialog input");
  input.value = "IN_A";
  const ok = [...document.querySelectorAll("dialog button")].find(
    (b) =>
      b.textContent.trim() === "OK" || b.classList.contains("btn--primary"),
  );
  ok.click();
  assert.deepEqual(h.named, [{ address: "bb2.c11", name: "IN_A", stale: [] }]);
  PopupManager.close();
});

test("the tint is the live net's level", () => {
  const doc = bench();
  const live = new NetlistCache(doc);
  const levels = new Map([[live.netOf("bb1.+25"), "H"]]);
  const h = mount(doc, { levels });
  h.point("bb2.c11");
  assert.match(h.status(), /^H · /, "the common sits on the rail's level");
});
