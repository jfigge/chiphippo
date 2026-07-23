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

// jsdom smoke tests for ScopeView (Feature 210): recording the sim-state stream
// into waveforms, the empty state, and the Run-resets-the-trace behavior. The
// pure recording/decoding is covered by scope-recorder.test.js; this exercises
// the DOM/render pipeline (gutter rows + SVG lane building) end to end.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { ScopeView } = await import("../components/scope-view.js");
const { DeskDoc } = await import("../model/desk-doc.js");

/** A sim-state broadcast where one address carries `level`. */
function simEvent(mode, address, netId, level) {
  return new window.CustomEvent("chiphippo:sim-state", {
    detail: {
      mode,
      running: mode !== "stopped",
      netLevels: level == null ? new Map() : new Map([[netId, level]]),
      netlist: { netOfPoint: new Map([[address, netId]]) },
    },
  });
}

function makeView() {
  const doc = new DeskDoc(null);
  const netlist = {
    netOf: (a) => (a === "bb1.f12" ? "net1" : null),
    nameOf: (id) => (id === "net1" ? "CLK" : null),
  };
  const view = new ScopeView(document.body, {
    deskDoc: doc,
    netlist,
    onAddChannel: (kind, ref) => doc.addScopeChannel(kind, ref),
    onRemoveChannel: (id) => doc.removeScopeChannel(id),
    onMoveChannel: (id, i) => doc.moveScopeChannel(id, i),
    tickMs: () => 50,
  });
  return { doc, view };
}

test("empty state shows until a channel exists", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  assert.equal(view.element.querySelector(".scope-empty").hidden, false);
  assert.equal(view.element.querySelector(".scope-body").hidden, true);
});

test("records a net channel into a stepped waveform", () => {
  resetDom();
  const { doc, view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12"); // routed through onAddChannel → doc
  assert.equal(doc.scopeChannels.length, 1);

  // Feed four running ticks: L, H, H, L.
  for (const lvl of ["L", "H", "H", "L"]) {
    window.dispatchEvent(simEvent("running", "bb1.f12", "net1", lvl));
  }
  view.setVisible(true); // force a synchronous render

  const svg = view.element.querySelector(".scope-svg");
  // One column per tick × 10px.
  assert.equal(svg.getAttribute("width"), "40", "four ticks recorded");
  const path = svg.querySelector("path");
  assert.ok(path, "a waveform path was drawn");
  // The step path visits both the high and low rails (a transition happened).
  assert.ok(path.getAttribute("d").split("L").length > 3, "multi-segment step");

  // The gutter shows the net's Feature-120 name.
  assert.equal(
    view.element.querySelector(".scope-chan-name").textContent,
    "CLK",
  );
});

test("a fresh Run resets the recorded trace", () => {
  resetDom();
  const { view } = makeView();
  view.setVisible(true);
  view.addNetChannel("bb1.f12");

  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "H"));
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "L"));
  window.dispatchEvent(simEvent("stopped", "bb1.f12", "net1", null)); // keeps trace
  view.setVisible(true);
  assert.equal(
    view.element.querySelector(".scope-svg").getAttribute("width"),
    "20",
    "trace retained after Stop",
  );

  // Next Run starts over (transition stopped → running resets the ring).
  window.dispatchEvent(simEvent("running", "bb1.f12", "net1", "H"));
  view.setVisible(true);
  assert.equal(
    view.element.querySelector(".scope-svg").getAttribute("width"),
    "10",
    "one fresh column after re-Run",
  );
});
