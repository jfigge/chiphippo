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

// jsdom tests for the Feature 90 live-view wiring in DeskController: a
// chiphippo:sim-state event lights LEDs by anode/cathode level, badges chips
// by power status, and clears both when the sim stops. Also covers the
// editing lock (Run freezes placement/wire tools but keeps the probe live).
// The engine/resolver are proven separately; here we assert the DOM reactions.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { H, L } from "../sim/levels.js";

const { DeskController } = await import("../components/desk-controller.js");

function makeDesk(deskDoc) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc });
  return { viewport, surface, controller };
}

/** Dispatch a running sim-state with a hand-built netlist + levels. */
function publishSim({ netOfPoint, netLevels, chipStatus = new Map() }) {
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: {
        running: true,
        netLevels,
        chipStatus,
        warnings: [],
        netlist: { netOfPoint: new Map(netOfPoint) },
      },
    }),
  );
}

test("an LED lights when its anode net is H and its cathode net is L", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  // Default polarity: anode = pin 1 (anchor hole a1), cathode = pin 2 (a2).
  controller.addComponentAt("led", "bb1", "a1", { color: "red" });
  const ledEl = surface.querySelector(".part-discrete--led");

  publishSim({
    netOfPoint: [
      ["bb1.a1", "netA"],
      ["bb1.a2", "netK"],
    ],
    netLevels: new Map([
      ["netA", H],
      ["netK", L],
    ]),
  });
  assert.ok(ledEl.classList.contains("part-discrete--lit"));
});

test("a reverse-biased LED (anode L, cathode H) stays dark", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("led", "bb1", "a1", { color: "green" });
  const ledEl = surface.querySelector(".part-discrete--led");

  publishSim({
    netOfPoint: [
      ["bb1.a1", "netA"],
      ["bb1.a2", "netK"],
    ],
    netLevels: new Map([
      ["netA", L],
      ["netK", H],
    ]),
  });
  assert.ok(!ledEl.classList.contains("part-discrete--lit"));
});

test("polarity flip swaps which levels light the LED", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  // Flipped: anode = pin 2 (a2), cathode = pin 1 (a1).
  controller.addComponentAt("led", "bb1", "a1", { color: "red", flip: true });
  const ledEl = surface.querySelector(".part-discrete--led");

  // a1 = H, a2 = L would light an UNflipped LED — but flipped it's reversed.
  publishSim({
    netOfPoint: [
      ["bb1.a1", "netA"],
      ["bb1.a2", "netK"],
    ],
    netLevels: new Map([
      ["netA", H],
      ["netK", L],
    ]),
  });
  assert.ok(!ledEl.classList.contains("part-discrete--lit"));

  // Reverse the levels: now the flipped anode (a2) is H, cathode (a1) is L.
  publishSim({
    netOfPoint: [
      ["bb1.a1", "netA"],
      ["bb1.a2", "netK"],
    ],
    netLevels: new Map([
      ["netA", L],
      ["netK", H],
    ]),
  });
  assert.ok(ledEl.classList.contains("part-discrete--lit"));
});

test("chip status badges apply per status and clear when the sim stops", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("7400", "bb1", "e5");
  const chipEl = surface.querySelector(".part-chip");

  for (const status of ["unpowered", "underpowered", "damaged"]) {
    publishSim({
      netOfPoint: [],
      netLevels: new Map(),
      chipStatus: new Map([["c1", { status }]]),
    });
    assert.ok(
      chipEl.classList.contains(`part-chip--${status}`),
      `expected part-chip--${status}`,
    );
    // Exactly one status class at a time.
    const badges = ["unpowered", "underpowered", "damaged"].filter((s) =>
      chipEl.classList.contains(`part-chip--${s}`),
    );
    assert.deepEqual(badges, [status]);
  }

  // A not-running sim-state (Stop) clears every badge.
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: {
        running: false,
        netLevels: new Map(),
        chipStatus: new Map(),
        warnings: [],
        netlist: null,
      },
    }),
  );
  for (const s of ["unpowered", "underpowered", "damaged"]) {
    assert.ok(!chipEl.classList.contains(`part-chip--${s}`));
  }
});

test("editing lock freezes placement/wire but keeps the probe live", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("full", 0, 0);
  const { viewport, controller } = makeDesk(doc);

  controller.setEditingLocked(true);
  assert.ok(viewport.classList.contains("desk-viewport--running"));

  // Placement and wiring are rejected while locked.
  controller.armPlacement("tiny");
  assert.ok(!controller.placementArmed);
  controller.armWireTool();
  assert.ok(!controller.wireToolArmed);

  // The 'w' shortcut is inert; the probe 'i' shortcut still toggles.
  assert.equal(
    controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "w" })),
    false,
  );
  assert.ok(!controller.wireToolArmed);
  assert.equal(
    controller.handleKeyDown(new window.KeyboardEvent("keydown", { key: "i" })),
    true,
  );
  assert.ok(controller.probeArmed);

  // Unlocking restores the tools.
  controller.disarmProbe();
  controller.setEditingLocked(false);
  assert.ok(!viewport.classList.contains("desk-viewport--running"));
  controller.armWireTool();
  assert.ok(controller.wireToolArmed);
});
