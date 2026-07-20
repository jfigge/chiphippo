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

// jsdom tests for the discrete-part and PSU views.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { buildDiscreteSvg, buildSpanSvg, DiscreteView, discreteBox } =
  await import("../components/discrete-view.js");
const { buildPsuSvg, PsuView } = await import("../components/psu-view.js");

test("buildDiscreteSvg: slide switch knob follows params.pos", () => {
  resetDom();
  const at1 = buildDiscreteSvg("sw-slide", { pos: "1" });
  const at2 = buildDiscreteSvg("sw-slide", { pos: "2" });
  const x1 = Number(at1.querySelector(".part-slide-knob").getAttribute("x"));
  const x2 = Number(at2.querySelector(".part-slide-knob").getAttribute("x"));
  assert.ok(x2 > x1, "knob moves right for pos 2");
});

test("buildDiscreteSvg: LED color class + flip mirrors the cathode flat", () => {
  resetDom();
  const green = buildDiscreteSvg("led", { color: "green" });
  assert.ok(green.querySelector(".part-led-dome--green"));
  const flatRight = Number(
    green.querySelector(".part-led-flat").getAttribute("x"),
  );
  const flipped = buildDiscreteSvg("led", { color: "green", flip: true });
  const flatLeft = Number(
    flipped.querySelector(".part-led-flat").getAttribute("x"),
  );
  assert.ok(flatLeft < flatRight, "flip moves the flat cue to the anchor side");
});

test("buildDiscreteSvg: resistor has two leads and a banded body", () => {
  resetDom();
  const svg = buildDiscreteSvg("resistor", { ohms: 220 });
  assert.equal(svg.querySelectorAll(".part-resistor-lead").length, 2);
  assert.ok(svg.querySelector(".part-resistor-body"));
  assert.ok(svg.querySelectorAll(".part-resistor-band").length >= 1);
});

test("discreteBox rejects unknown refs", () => {
  resetDom();
  assert.throws(() => discreteBox("capacitor"), { code: "INVALID_REF" });
});

test("buildSpanSvg: draws a lead + banded body across any vector", () => {
  resetDom();
  // A vertical span (pin 2 three rows below pin 1).
  const svg = buildSpanSvg("resistor", 0, 3);
  const line = svg.querySelector(".part-span-lead");
  assert.equal(line.getAttribute("x1"), "0");
  assert.equal(line.getAttribute("y1"), "0");
  assert.equal(line.getAttribute("x2"), "0");
  assert.equal(line.getAttribute("y2"), "3"); // the lead reaches pin 2
  assert.ok(svg.querySelector(".part-resistor-body"));
  assert.ok(svg.querySelectorAll(".part-resistor-band").length >= 1);
  assert.ok(svg.classList.contains("part-discrete-svg--rotated"));
  // A widened hit stroke tracks the lead — the only pointer target, so a long
  // span's box doesn't swallow clicks on the holes beneath it.
  const hit = svg.querySelector(".part-span-hit");
  assert.equal(hit.getAttribute("x2"), "0");
  assert.equal(hit.getAttribute("y2"), "3");

  // The body is CENTRED on the pair and rotated to the lead angle.
  const body = svg.querySelector(".part-resistor-body");
  assert.equal(body.getAttribute("y"), "1"); // midpoint 1.5 − half-height 0.5
  assert.match(
    body.parentNode.getAttribute("transform"),
    /^rotate\(90 0 1\.5\)$/, // 90° about the midpoint (0, 1.5)
  );
});

test("buildSpanSvg: an LED spans with a centred dome and cathode cue", () => {
  resetDom();
  // Diagonal span: 3 across, 4 down (length 5, angle ~53°).
  const svg = buildSpanSvg("led", 3, 4, { color: "green", flip: false });
  assert.ok(svg.querySelector(".part-led-dome--green"));
  assert.ok(svg.querySelector(".part-span-lead"));
  assert.ok(svg.querySelector(".part-span-hit"));
  // The dome sits over the MIDPOINT (1.5, 2), lifted 1 unit off the leads.
  const dome = svg.querySelector(".part-led-dome");
  assert.equal(dome.getAttribute("cx"), "1.5");
  assert.equal(dome.getAttribute("cy"), "1");
  // …and the whole body is rotated to the lead angle about that midpoint.
  assert.match(dome.parentNode.getAttribute("transform"), /^rotate\(53\./);

  // Flipping mirrors the cathode flat to the other side of the midpoint.
  const flatX = (flip) =>
    Number(
      buildSpanSvg("led", 3, 4, { color: "red", flip })
        .querySelector(".part-led-flat")
        .getAttribute("x"),
    );
  assert.ok(flatX(true) < flatX(false));
});

/** A rotated resistor view, drawn but not yet spanned. */
function rotatedResistor(layer, end = { dx: 0, dy: -3 }) {
  return new DiscreteView(
    layer,
    { id: "r1", ref: "resistor", params: { ohms: 10000, rot: 90, end } },
    {},
  );
}

test("DiscreteView.updateSpanWorld renders + positions a rotated resistor", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const view = rotatedResistor(layer);
  // No horizontal SVG is built for a rotated resistor at construction…
  assert.equal(layer.querySelector(".part-resistor-body"), null);
  // …until updateSpanWorld draws the span and seats the element. Pin 1 sits at
  // j10 (world 10, 1) and the lead bends 3 up onto the rail strip above.
  view.updateSpanWorld({ x: 10, y: 1 }, { x: 10, y: -2 });
  assert.ok(layer.querySelector(".part-span-lead"));
  assert.ok(layer.querySelector(".part-discrete-svg--rotated"));
  assert.notEqual(view.element.style.left, "");
});

test("DiscreteView.setFloating cues a lost lead without moving the part", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const view = rotatedResistor(layer);
  // The same span whether or not the far strip is still there — the bend is
  // geometry, so pulling a rail away changes the CUE, never the position.
  view.updateSpanWorld({ x: 10, y: 1 }, { x: 10, y: -2 });
  const { left, top } = view.element.style;
  const lead = () => layer.querySelector(".part-span-lead").getAttribute("y2");
  assert.equal(lead(), "-3");

  assert.ok(!view.element.classList.contains("part-discrete--floating"));
  view.setFloating(true);
  assert.ok(view.element.classList.contains("part-discrete--floating"));
  assert.deepEqual(
    [view.element.style.left, view.element.style.top],
    [left, top],
  );
  assert.equal(lead(), "-3");

  view.setFloating(false);
  assert.ok(!view.element.classList.contains("part-discrete--floating"));
});

test("DiscreteView: seats in world px; cap press emits chiphippo:part-state", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);

  const view = new DiscreteView(
    layer,
    { id: "c5", ref: "sw-push", params: {} },
    {},
  );
  view.updatePlacement({ type: "pins-full", x: 0, y: 0 }, "b10");
  const partEl = layer.querySelector(".part-discrete");
  assert.ok(partEl);

  const events = [];
  window.addEventListener("chiphippo:part-state", (e) => events.push(e.detail));
  const cap = partEl.querySelector(".part-button-cap");
  cap.dispatchEvent(
    new window.MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
    }),
  );
  assert.ok(partEl.classList.contains("part-discrete--pressed"));
  cap.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  assert.ok(!partEl.classList.contains("part-discrete--pressed"));
  assert.deepEqual(
    events.map((d) => d.state.pressed),
    [true, false],
  );
  assert.equal(events[0].id, "c5");
});

test("DiscreteView.updateParams rebuilds the SVG (slider flip)", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const view = new DiscreteView(
    layer,
    { id: "c1", ref: "sw-slide", params: { pos: "1" } },
    {},
  );
  const before = Number(
    layer.querySelector(".part-slide-knob").getAttribute("x"),
  );
  view.updateParams({ pos: "2" });
  const after = Number(
    layer.querySelector(".part-slide-knob").getAttribute("x"),
  );
  assert.ok(after > before);
});

test("PsuView: badge shows volts, terminals render, position in world px", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);

  const view = new PsuView(
    layer,
    { id: "psu1", x: 10, y: 20, params: { volts: 12 } },
    {},
  );
  const partEl = layer.querySelector(".part-psu");
  assert.equal(partEl.querySelector(".part-psu-badge").textContent, "12 V");
  assert.equal(partEl.querySelectorAll(".part-psu-terminal").length, 2);
  assert.equal(partEl.style.left, "100px"); // 10 pitch × PX_PER_UNIT
  assert.equal(partEl.style.top, "200px");

  view.updateParams({ volts: 3 });
  assert.equal(partEl.querySelector(".part-psu-badge").textContent, "3 V");
});

test("buildPsuSvg coerces junk volts to the default badge", () => {
  resetDom();
  const svg = buildPsuSvg({ volts: 9 });
  assert.equal(svg.querySelector(".part-psu-badge").textContent, "5 V");
});
