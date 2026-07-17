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

const { buildDiscreteSvg, DiscreteView, discreteBox } =
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

test("discreteBox rejects unknown refs", () => {
  resetDom();
  assert.throws(() => discreteBox("resistor"), { code: "INVALID_REF" });
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
  view.updatePlacement({ type: "full", x: 0, y: 0 }, "b10");
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
