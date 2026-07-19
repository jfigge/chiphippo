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

// jsdom tests for the wire overlay (components/wire-layer.js).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition } from "../model/breadboard.js";

const { WireLayer } = await import("../components/wire-layer.js");

function deskWithWire() {
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0); // bb1
  doc.addBoard("tiny", 100, 0); // bb2
  doc.addWire({ from: "bb1.a1", to: "bb1.a5", color: "green" });
  return doc;
}

test("renders one .wire group per wire with color + geometry", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  doc.addWire({ from: "bb1.j1", to: "bb2.a1", color: "red" }); // cross-board

  new WireLayer(layer, doc, {});
  const groups = layer.querySelectorAll(".wire");
  assert.equal(groups.length, 2);

  const [w1] = groups;
  assert.equal(w1.dataset.wireId, "w1");
  assert.equal(
    w1.style.getPropertyValue("--wire-color"),
    "var(--color-wire-green)",
  );
  // Path endpoints land exactly on the hole centers (world px).
  const a = holePosition("full", "a1");
  const d = w1.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.startsWith(`M ${a.x * PX_PER_UNIT} ${a.y * PX_PER_UNIT} `), d);
  // Hit + outline + core + two caps per wire.
  assert.equal(w1.querySelectorAll("path").length, 3);
  assert.equal(w1.querySelectorAll(".wire-cap").length, 2);
});

test("re-renders on chiphippo:doc-changed (add + recolor)", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  new WireLayer(layer, doc, {});
  assert.equal(layer.querySelectorAll(".wire").length, 1);

  doc.addWire({ from: "bb1.b1", to: "bb1.b5", color: "blue" });
  doc.recolorWire("w1", "purple");
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));

  const groups = layer.querySelectorAll(".wire");
  assert.equal(groups.length, 2);
  assert.equal(
    groups[0].style.getPropertyValue("--wire-color"),
    "var(--color-wire-purple)",
  );
});

test("selection class survives a re-render; click reports the id", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  const clicks = [];
  const wires = new WireLayer(layer, doc, {
    onSelect: (id) => clicks.push(id),
  });

  wires.setSelected("w1");
  assert.ok(layer.querySelector(".wire").classList.contains("wire--selected"));
  window.dispatchEvent(new CustomEvent("chiphippo:doc-changed"));
  assert.ok(layer.querySelector(".wire").classList.contains("wire--selected"));
  wires.setSelected(null);
  assert.ok(!layer.querySelector(".wire").classList.contains("wire--selected"));

  layer
    .querySelector(".wire")
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.deepEqual(clicks, ["w1"]);
});

test("board-drag overrides shift wire endpoints live", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire();
  const wires = new WireLayer(layer, doc, {});

  const a = holePosition("full", "a1");
  wires.render(new Map([["bb1", { x: 50, y: 7 }]]));
  const d = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(
    d.startsWith(`M ${(50 + a.x) * PX_PER_UNIT} ${(7 + a.y) * PX_PER_UNIT} `),
    d,
  );
});

test("setEndpointDrag pins one end to a cursor point; null restores the doc", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = deskWithWire(); // w1: bb1.a1 → bb1.a5
  const wires = new WireLayer(layer, doc, {});

  // Drag the `to` end to an arbitrary world-px point over an illegal spot.
  wires.setEndpointDrag({
    wireId: "w1",
    end: "to",
    world: { x: 999, y: 0 },
    legal: false,
  });
  const group = layer.querySelector(".wire");
  const d = group.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.endsWith("999 0"), d); // the bezier ends at the dragged point
  assert.ok(group.classList.contains("wire--dragging"));
  assert.ok(group.classList.contains("wire-preview--illegal"));
  // The dragged end's cap follows too.
  const caps = group.querySelectorAll(".wire-cap");
  assert.equal(caps[1].getAttribute("cx"), "999");

  // Clearing the drag redraws from the document (back on hole a5).
  wires.setEndpointDrag(null);
  const a5 = holePosition("full", "a5");
  const restored = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(
    restored.endsWith(`${a5.x * PX_PER_UNIT} ${a5.y * PX_PER_UNIT}`),
    restored,
  );
  assert.ok(!layer.querySelector(".wire").classList.contains("wire--dragging"));
});

test("setPreview shows, retints, and hides the rubber band", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const wires = new WireLayer(layer, new DeskDoc(null), {});

  wires.setPreview({
    from: { x: 0, y: 0 },
    to: { x: 100, y: 0 },
    color: "red",
    legal: true,
  });
  const preview = layer.querySelector(".wire-preview");
  assert.ok(preview);
  assert.ok(!preview.classList.contains("wire-preview--illegal"));

  wires.setPreview({
    from: { x: 0, y: 0 },
    to: { x: 50, y: 0 },
    color: "red",
    legal: false,
  });
  assert.ok(preview.classList.contains("wire-preview--illegal"));

  wires.setPreview(null);
  assert.equal(layer.querySelector(".wire-preview"), null);
});

test("resolves PSU terminal endpoints (and drag overrides)", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  doc.addPsu(80, 10);
  doc.addWire({ from: "psu1.+", to: "bb1.t+1", color: "red" });

  const wires = new WireLayer(layer, doc, {});
  // psu1.+ terminal sits at (80+2, 10+4) pitch units.
  let d = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.startsWith(`M ${82 * PX_PER_UNIT} ${14 * PX_PER_UNIT} `), d);

  wires.render(new Map([["psu1", { x: 100, y: 10 }]]));
  d = layer.querySelector(".wire-core").getAttribute("d");
  assert.ok(d.startsWith(`M ${102 * PX_PER_UNIT} ${14 * PX_PER_UNIT} `), d);
});
