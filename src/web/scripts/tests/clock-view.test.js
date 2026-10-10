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

test("a free-running clock carries its own pause button, top right; a manual one does not", () => {
  resetDom();
  const svg = buildClockSvg({ hz: 2 });
  const button = svg.querySelector(".part-clock-pause");
  assert.ok(button, "free-running: there is a timer to pause");
  assert.ok(button.querySelector(".part-clock-pause-glyph--pause"));
  assert.ok(button.querySelector(".part-clock-pause-glyph--resume"));

  // Top right: the lamp's mirror image, clear of the wave and the rate badge.
  const num = (el, attr) => Number(el.getAttribute(attr));
  const disc = button.querySelector(".part-clock-pause-disc");
  const lamp = svg.querySelector(".part-clock-lamp");
  assert.equal(num(disc, "cy"), num(lamp, "cy"), "level with the lamp");
  assert.equal(num(disc, "cx"), 8 - num(lamp, "cx"), "mirrors it");
  const d = svg.querySelector(".part-clock-wave").getAttribute("d");
  const waveRight = Math.max(
    ...[...d.matchAll(/[ML]\s*([\d.]+)\s+[\d.]+/g)].map((m) => Number(m[1])),
  );
  assert.ok(num(disc, "cx") - num(disc, "r") > waveRight, "clear of the wave");
  // The badge's em box (its 0.99-unit font above the baseline) — a bound no
  // glyph of it reaches, so the disc sitting on or above it is clear.
  const badgeTop = num(svg.querySelector(".part-clock-badge"), "y") - 0.99;
  assert.ok(num(disc, "cy") + num(disc, "r") <= badgeTop, "above the badge");
  assert.ok(num(disc, "cx") + num(disc, "r") < 8, "inside the body");

  assert.equal(
    buildClockSvg({ hz: "manual" }).querySelector(".part-clock-pause"),
    null,
    "manual: it moves on a click, so there is nothing to pause",
  );
});

test("setPaused picks the glyph by class and says what a click would do", () => {
  resetDom();
  const layer = document.createElement("div");
  const view = new ClockView(layer, {
    id: "clk1",
    x: 0,
    y: 0,
    params: { hz: 1 },
  });
  const elem = layer.querySelector(".part-clock");
  const hint = () =>
    elem.querySelector(".part-clock-pause > title").textContent;
  assert.ok(!elem.classList.contains("part-clock--paused"));
  assert.match(hint(), /^Pause this clock/, "the catalog's words, not a key");

  view.setPaused(true);
  assert.ok(elem.classList.contains("part-clock--paused"));
  assert.equal(hint(), "Resume this clock");

  // A rate change mid-run rebuilds the SVG; the hint must survive it.
  view.updateParams({ hz: 5 });
  assert.equal(hint(), "Resume this clock");

  view.setPaused(false);
  assert.ok(!elem.classList.contains("part-clock--paused"));
  assert.match(hint(), /^Pause this clock/);
});

test("the wave glyph is its own wave under Spice Lite, the square otherwise", () => {
  // The digital engine runs every clock square, so that is what the brick
  // says until Spice Lite is on.
  resetDom();
  const d = (svg) => svg.querySelector(".part-clock-wave").getAttribute("d");
  const square = d(buildClockSvg({ hz: 2 }));
  assert.equal(d(buildClockSvg({ hz: 2, wave: "sine" })), square);
  assert.equal(d(buildClockSvg({ hz: 2, wave: "trapezoid" })), square);
  const shapes = new Set([square]);
  for (const wave of [
    "pwm",
    "triangle",
    "trapezoid",
    "ramp-up",
    "ramp-down",
    "sine",
  ]) {
    shapes.add(
      d(buildClockSvg({ hz: 2, wave, duty: 25 }, { spiceLite: true })),
    );
  }
  assert.equal(shapes.size, 7, "seven waves, seven glyphs");
  // A manual clock is square whatever it was set to.
  assert.equal(d(buildClockSvg({ hz: "manual", wave: "sine" }, { spiceLite: true })), square); // prettier-ignore

  const layer = document.createElement("div");
  const view = new ClockView(layer, { id: "clk1", x: 0, y: 0, params: { hz: 1, wave: "triangle" } }); // prettier-ignore
  const glyph = () => d(layer.querySelector(".part-clock svg"));
  assert.equal(glyph(), square);
  view.setSpiceLite(true);
  assert.notEqual(glyph(), square);
  view.setSpiceLite(false);
  assert.equal(glyph(), square);
});

test("a PWM's glyph is drawn at its pulse width, in both engines", () => {
  // A level, so the digital engine runs it too — and the brick says so.
  resetDom();
  const d = (params, spiceLite = false) =>
    buildClockSvg(params, { spiceLite })
      .querySelector(".part-clock-wave")
      .getAttribute("d");
  const quarter = d({ hz: 2, wave: "pwm", duty: 25 });
  assert.equal(quarter, d({ hz: 2, wave: "pwm", duty: 25 }, true));
  assert.notEqual(quarter, d({ hz: 2 }), "not the square");
  assert.notEqual(quarter, d({ hz: 2, wave: "pwm", duty: 75 }), "its width");
  // HIGH (y 1.0) for a quarter of each 1.2-wide period.
  assert.equal(quarter, "M 2.3 2.0 L 2.3 1.0 L 2.600 1.0 L 2.600 2.0 L 3.5 2.0 L 3.5 1.0 L 3.800 1.0 L 3.800 2.0 L 4.7 2.0"); // prettier-ignore
  // A manual clock is square, whatever its wave.
  assert.equal(d({ hz: "manual", wave: "pwm", duty: 25 }), d({ hz: 2 }));
});
