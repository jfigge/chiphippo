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

// jsdom tests for the multi-segment display live-view: a chiphippo:sim-state
// event lights each segment of a seg8 / bar8 as an LED between its anode pin
// and the shared cathode (pin 9), burns a segment driven with no series
// resistor, and clears every segment when the sim stops. The engine/resolver
// are proven separately; here we assert the DOM reactions, mirroring
// sim-view.test.js (single LEDs).

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
function publishSim({ netOfPoint, netLevels, strongLevels = new Map() }) {
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: {
        running: true,
        netLevels,
        strongLevels,
        chipStatus: new Map(),
        warnings: [],
        netlist: { netOfPoint: new Map(netOfPoint) },
      },
    }),
  );
}

/** A fresh full board to seat a nine-hole display on (anchor a1 → holes a1…a9). */
function displayDoc() {
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  return doc;
}

const lit = (el, seg) =>
  el.querySelector(`[data-seg="${seg}"]`).classList.contains("part-seg--lit");

test("seg8 lights only the segments whose anode is H over the common cathode", () => {
  resetDom();
  const doc = displayDoc();
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("seg8", "bb1", "a1", { color: "green" });
  const el = surface.querySelector(".part-discrete--seg8");
  assert.ok(el, "seg8 mounted");

  publishSim({
    netOfPoint: [
      ["bb1.a1", "netH"], // pin 1 → segment a's anode
      ["bb1.a3", "netH"], // pin 3 → segment c's anode
      ["bb1.a9", "netGND"], // pin 9 → the shared cathode (K)
    ],
    netLevels: new Map([
      ["netH", H],
      ["netGND", L],
    ]),
    // Nothing STRONGLY driven → fed through a limiting resistor: the safe case.
  });

  assert.ok(lit(el, "a"), "segment a lit");
  assert.ok(lit(el, "c"), "segment c lit");
  assert.ok(!lit(el, "b"), "segment b dark (anode undriven)");
  assert.ok(!lit(el, "g"), "segment g dark");
  assert.ok(!el.classList.contains("part-discrete--burnt"), "not burnt");
});

test("a seg8 segment driven straight across the rails burns (no series R)", () => {
  resetDom();
  const doc = displayDoc();
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("seg8", "bb1", "a1", { color: "red" });
  const el = surface.querySelector(".part-discrete--seg8");

  const strong = new Map([
    ["netH", H],
    ["netGND", L],
  ]);
  publishSim({
    netOfPoint: [
      ["bb1.a1", "netH"], // segment a's anode, driven directly
      ["bb1.a9", "netGND"],
    ],
    netLevels: strong,
    strongLevels: strong,
  });

  const segA = el.querySelector('[data-seg="a"]');
  assert.ok(segA.classList.contains("part-seg--burnt"), "segment a burnt");
  assert.ok(!segA.classList.contains("part-seg--lit"), "burnt never glows");
  assert.ok(
    el.classList.contains("part-discrete--burnt"),
    "the block shows the burn cue",
  );
  assert.equal(el.querySelectorAll(".part-burn-x").length, 2);
});

test("seg8ca (common anode) lights a segment whose cathode is pulled LOW", () => {
  resetDom();
  const doc = displayDoc();
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("seg8ca", "bb1", "a1", { color: "green" });
  const el = surface.querySelector(".part-discrete--seg8ca");
  assert.ok(el, "seg8ca mounted");

  // Common anode: pin 9 (A) → VCC (H); a 74LS47 pulls a segment cathode LOW to
  // light it (the mirror of the common-cathode seg8).
  publishSim({
    netOfPoint: [
      ["bb1.a9", "netA"], // pin 9 → shared anode, tied HIGH
      ["bb1.a1", "netLo"], // pin 1 → segment a's cathode, driven LOW → lit
      ["bb1.a3", "netLo"], // pin 3 → segment c's cathode → lit
      ["bb1.a2", "netHi"], // pin 2 → segment b's cathode HIGH → dark
    ],
    netLevels: new Map([
      ["netA", H],
      ["netLo", L],
      ["netHi", H],
    ]),
    // Nothing STRONGLY driven → fed through a limiting resistor: the safe case.
  });

  assert.ok(lit(el, "a"), "segment a lit (cathode low under the H anode)");
  assert.ok(lit(el, "c"), "segment c lit");
  assert.ok(!lit(el, "b"), "segment b dark (cathode not low)");
  assert.ok(!lit(el, "g"), "segment g dark (cathode undriven)");
  assert.ok(!el.classList.contains("part-discrete--burnt"), "not burnt");
});

test("bar8 lights a driven bar and clears every segment when the sim stops", () => {
  resetDom();
  const doc = displayDoc();
  const { surface, controller } = makeDesk(doc);
  controller.addComponentAt("bar8", "bb1", "a1", { color: "blue" });
  const el = surface.querySelector(".part-discrete--bar8");
  assert.ok(el, "bar8 mounted");

  publishSim({
    netOfPoint: [
      ["bb1.a2", "netH"], // pin 2 → bar s2's anode
      ["bb1.a9", "netGND"], // pin 9 → shared cathode
    ],
    netLevels: new Map([
      ["netH", H],
      ["netGND", L],
    ]),
  });
  assert.ok(lit(el, "s2"), "bar s2 lit");
  assert.ok(!lit(el, "s1"), "bar s1 dark");

  // Stop: a not-running sim-state clears every segment.
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: { running: false, netLevels: new Map(), warnings: [] },
    }),
  );
  assert.ok(!lit(el, "s2"), "cleared on stop");
});

test("bar8iso lights each bar between its OWN anode (row e) and cathode (row f)", () => {
  resetDom();
  const doc = displayDoc();
  const { surface, controller } = makeDesk(doc);
  // A 16-pin DIP straddles the trench: anchor is row e (pin 1 = anode A1).
  controller.addComponentAt("bar8iso", "bb1", "e1", { color: "yellow" });
  const el = surface.querySelector(".part-discrete--bar8iso");
  assert.ok(el, "bar8iso mounted");

  // Bar s1 = anode pin 1 (hole e1) + cathode pin 16 (hole f1, across the
  // trench). Bar s2's anode (e2) is driven H too, but its OWN cathode (f2) is
  // left floating — so an isolated bar array must keep s2 dark.
  publishSim({
    netOfPoint: [
      ["bb1.e1", "netH"], // s1 anode
      ["bb1.f1", "netGND"], // s1 cathode
      ["bb1.e2", "netH"], // s2 anode — high…
      // …but bb1.f2 (s2's own cathode) is absent, so s2 has no return path.
    ],
    netLevels: new Map([
      ["netH", H],
      ["netGND", L],
    ]),
  });
  assert.ok(lit(el, "s1"), "bar s1 lit (anode H over its own cathode L)");
  assert.ok(
    !lit(el, "s2"),
    "bar s2 dark — its cathode floats (each bar is isolated)",
  );

  // Stop clears every bar.
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:sim-state", {
      detail: { running: false, netLevels: new Map(), warnings: [] },
    }),
  );
  assert.ok(!lit(el, "s1"), "cleared on stop");
});
