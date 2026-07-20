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

// jsdom tests for the net-highlight overlay + the renderer netlist cache.

import test from "node:test";
import assert from "node:assert/strict";

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
