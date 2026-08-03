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

test("the rate badge has a LINE OF ITS OWN: clear of the wave and the pads", () => {
  // It used to share the wave's baseline, and the two collided at every rate
  // the app has ever offered — "2 Hz" drew as ⎍2⎍Hz. jsdom measures no text, so
  // the check is on the BAND the badge sits in: below everything in the top row
  // and above the terminal pads. Both bounds are read off the drawing rather
  // than typed, so moving the wave or the pads re-checks the badge for free.
  resetDom();
  const svg = buildClockSvg({ hz: 100 });
  const num = (el, attr) => Number(el.getAttribute(attr));

  // The wave path's lowest point, straight out of its `d`.
  const d = svg.querySelector(".part-clock-wave").getAttribute("d");
  const waveBottom = Math.max(
    ...[...d.matchAll(/[ML]\s*[\d.]+\s+([\d.]+)/g)].map((m) => Number(m[1])),
  );
  const lamp = svg.querySelector(".part-clock-lamp");
  const topRowBottom = Math.max(waveBottom, num(lamp, "cy") + num(lamp, "r"));
  const padTop = Math.min(
    ...[...svg.querySelectorAll(".part-clock-terminal")].map(
      (c) => num(c, "cy") - num(c, "r"),
    ),
  );

  const badge = svg.querySelector(".part-clock-badge");
  const baseline = num(badge, "y");
  assert.ok(
    baseline > topRowBottom,
    `badge baseline ${baseline} must clear the lamp/wave row (${topRowBottom})`,
  );
  assert.ok(
    baseline <= padTop,
    `badge baseline ${baseline} must sit above the terminal pads (${padTop})`,
  );
  // ...and centred in the body, so the longest rate string ("100 Hz") stays
  // inside it however wide the glyphs measure.
  assert.equal(baseline, 3.2);
  assert.equal(num(badge, "x"), 4);
  assert.equal(badge.getAttribute("text-anchor"), "middle");
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
