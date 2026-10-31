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

// jsdom tests for the net-highlight overlay + the renderer netlist cache.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { NetHighlight } = await import("../components/net-highlight.js");
const { NetlistCache } = await import("../components/netlist-cache.js");

test("NetHighlight draws a dot per hole/terminal, a ring per pin, a stroke per wire", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const highlight = new NetHighlight(layer);

  const net = {
    holes: ["bb1.a1", "bb1.b1"],
    terminals: ["psu1.+"],
    pins: [{ hole: "bb1.a1" }],
    wires: ["w1"],
  };
  const geometry = {
    positionOf: (address) => ({ x: address.length, y: 1 }),
    wireEndpointsOf: () => ({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }),
  };
  highlight.show(net, geometry, false);

  const svg = layer.querySelector(".net-highlight");
  assert.equal(svg.querySelectorAll(".net-highlight-dot").length, 3); // 2 holes + terminal
  assert.equal(svg.querySelectorAll(".net-highlight-pin").length, 1);
  assert.equal(svg.querySelectorAll(".net-highlight-wire").length, 1);
  assert.ok(!svg.classList.contains("net-highlight--pinned"));

  highlight.show(net, geometry, true);
  assert.ok(svg.classList.contains("net-highlight--pinned"));

  highlight.show(null, geometry);
  assert.equal(svg.querySelectorAll("*").length, 0); // cleared
});

test("NetHighlight skips points/wires whose geometry is unresolved", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const highlight = new NetHighlight(layer);
  highlight.show(
    { holes: ["bb1.a1", "bb9.z9"], terminals: [], pins: [], wires: ["w1"] },
    {
      positionOf: (a) => (a === "bb1.a1" ? { x: 1, y: 1 } : null),
      wireEndpointsOf: () => null,
    },
  );
  assert.equal(layer.querySelectorAll(".net-highlight-dot").length, 1);
  assert.equal(layer.querySelectorAll(".net-highlight-wire").length, 0);
});

test("NetlistCache memoizes and invalidates on the two events", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const cache = new NetlistCache(doc);

  const first = cache.get();
  assert.equal(cache.get(), first, "memoized within a turn");

  // A topology change invalidates.
  doc.addWire({ from: "bb1.a1", to: "bb1.f1", color: "red" });
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  const second = cache.get();
  assert.notEqual(second, first);
  assert.equal(cache.netOf("bb1.a1"), cache.netOf("bb1.f1")); // wire joined them
});

test("NetlistCache tracks a held button's transient pressed state", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  doc.addComponent({
    kind: "discrete",
    ref: "sw-push",
    board: "bb1",
    anchor: "b10", // pins b10, b12
  });
  const cache = new NetlistCache(doc);
  assert.notEqual(cache.netOf("bb1.b10"), cache.netOf("bb1.b12"));

  // Press: a part-state event carries the transient bridge.
  window.dispatchEvent(
    new CustomEvent("chiphippo:part-state", {
      detail: { id: "c1", ref: "sw-push", state: { pressed: true } },
    }),
  );
  assert.equal(cache.netOf("bb1.b10"), cache.netOf("bb1.b12"));

  // Release.
  window.dispatchEvent(
    new CustomEvent("chiphippo:part-state", {
      detail: { id: "c1", ref: "sw-push", state: { pressed: false } },
    }),
  );
  assert.notEqual(cache.netOf("bb1.b10"), cache.netOf("bb1.b12"));
});

test("the highlight traces a wire where it is DRAWN: a routed wire's bends, a bus member's leads", async () => {
  resetDom();
  const { WireLayer } = await import("../components/wire-layer.js");
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const routed = doc.addWire({ from: "bb1.a1", to: "bb1.a20", color: "red" });
  doc.setWireRoute(routed.id, [{ x: 10, y: 30 }]);
  const plain = doc.addWire({ from: "bb1.b1", to: "bb1.b20", color: "red" });
  const m1 = doc.addWire({ from: "bb1.c1", to: "bb1.c40", color: "red" });
  const m2 = doc.addWire({ from: "bb1.c2", to: "bb1.c41", color: "red" });
  doc.addBus("D", [m1.id, m2.id]);
  const layer = document.createElement("div");
  document.body.append(layer);
  const wires = new WireLayer(layer, doc, {});
  wires.render();
  // The path each draws in the layer is the one the highlight is handed.
  const drawn = (id) =>
    layer.querySelector(`[data-wire-id="${id}"] path`).getAttribute("d");
  assert.equal(wires.restingPath(routed.id), drawn(routed.id));
  assert.match(wires.restingPath(routed.id), /L/, "straight runs, not a sag");
  assert.equal(wires.restingPath(plain.id), drawn(plain.id));
  assert.equal(wires.restingPath(m2.id), drawn(m2.id), "a member's two leads");
  assert.equal(wires.restingPath("w999"), null);

  const highlight = new NetHighlight(layer);
  highlight.show(
    { holes: [], terminals: [], pins: [], wires: [routed.id] },
    {
      positionOf: () => null,
      wireEndpointsOf: () => ({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }),
      wirePathOf: (id) => wires.restingPath(id),
    },
  );
  assert.equal(
    layer.querySelector(".net-highlight-wire").getAttribute("d"),
    drawn(routed.id),
  );
});

// A wire's highlight is a STROKE along its path and a pin's an outline: only
// a dot is filled. The running level tint once set `fill` on all three, and a
// routed wire's polyline was filled in — a solid polygon across the desk while
// the circuit ran (2026-10-30). Every rule that styles a wire or a pin may set
// `fill` to `none` only.
test("the highlight's wires and pins are never filled, at any level", () => {
  const css = fs.readFileSync(new URL("../../styles/app.css", import.meta.url), "utf8"); // prettier-ignore
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const touched = rules.filter(([, sel]) => /\.net-highlight-(wire|pin)\b/.test(sel)); // prettier-ignore
  assert.ok(touched.length >= 5, "the base rules and the level tints");
  for (const [, sel, body] of touched) {
    for (const [, value] of body.matchAll(/(?:^|;|\s)fill\s*:\s*([^;]+)/g)) {
      assert.equal(value.trim(), "none", `${sel.trim()} fills a wire or a pin`);
    }
  }
});
