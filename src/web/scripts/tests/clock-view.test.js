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

// jsdom tests for ClockView (Feature 100): the SVG carries a rate badge and
// out/gnd terminals; setLevel toggles the pulse-lamp class that tracks the
// live output; updateParams re-badges when the rate changes.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { ClockView, buildClockSvg } =
  await import("../components/clock-view.js");

test("buildClockSvg renders the rate badge, wave, lamp, and terminals", () => {
  resetDom();
  const svg = buildClockSvg({ hz: 2 });
  assert.equal(svg.querySelector(".part-clock-badge").textContent, "2 Hz");
  assert.ok(svg.querySelector(".part-clock-lamp"));
  assert.ok(svg.querySelector(".part-clock-wave"));
  assert.ok(svg.querySelector(".part-clock-terminal--out"));
  assert.ok(svg.querySelector(".part-clock-terminal--gnd"));
});

test("a manual clock badges MAN", () => {
  resetDom();
  const svg = buildClockSvg({ hz: "manual" });
  assert.equal(svg.querySelector(".part-clock-badge").textContent, "MAN");
});

test("setLevel toggles the pulse-lamp class; updateParams re-badges", () => {
  resetDom();
  const layer = document.createElement("div");
  const view = new ClockView(layer, {
    id: "clk1",
    x: 0,
    y: 0,
    params: { hz: 1 },
  });
  const elem = layer.querySelector(".part-clock");
  assert.ok(elem);
  assert.ok(!elem.classList.contains("part-clock--high"));

  view.setLevel(true);
  assert.ok(elem.classList.contains("part-clock--high"));
  view.setLevel(false);
  assert.ok(!elem.classList.contains("part-clock--high"));

  view.updateParams({ hz: 5 });
  assert.equal(elem.querySelector(".part-clock-badge").textContent, "5 Hz");
});
