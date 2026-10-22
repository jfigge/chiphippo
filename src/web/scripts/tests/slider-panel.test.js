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

// A floated slider's window (components/slider-panel.js, in web/slider.html):
// it shows what the app window tells it and reports every move, numbered, so
// a reply to an older move never drags the thumb back; its keys, wheel and
// Space; and being pointed at or focused.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { SliderPanel } from "../components/slider-panel.js";

const state = (over = {}) => ({
  kind: "state",
  title: "Potentiometer",
  label: "Position",
  min: 0,
  max: 100,
  step: 1,
  valuePercent: false,
  value: 50,
  ends: ["50k", "50k"],
  seq: 0,
  ...over,
});

function panel() {
  resetDom();
  const root = document.createElement("div");
  document.body.append(root);
  const sets = [];
  const hovers = [];
  let toggles = 0;
  const p = new SliderPanel(root, {
    onSet: (value, seq) => sets.push([value, seq]),
    onHover: (on) => hovers.push(on),
    onRunToggle: () => toggles++,
  });
  const slider = () => root.querySelector(".properties-range-input");
  const ends = () =>
    [".properties-range-end--start", ".properties-range-end--end"].map(
      (sel) => root.querySelector(sel).textContent,
    );
  return { p, root, sets, hovers, toggles: () => toggles, slider, ends };
}

const drag = (slider, value) => {
  slider.value = String(value);
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
};

test("it shows the label, the slider and its ends, and titles the window", () => {
  const { p, root, slider, ends } = panel();
  p.show(state());
  assert.equal(root.querySelector(".slider-label").textContent, "Position");
  assert.equal(slider().value, "50");
  assert.equal(slider().getAttribute("aria-label"), "Position");
  assert.deepEqual(ends(), ["50k", "50k"]);
  assert.equal(slider().getAttribute("aria-valuetext"), "50k – 50k");
  assert.equal(p.title, "Potentiometer — Position");
  assert.equal(document.activeElement, slider(), "the knob has the keys");
});

test("every move is reported, numbered, and an echo of an older one leaves the thumb be", () => {
  const { p, sets, slider, ends } = panel();
  p.show(state());
  drag(slider(), 20);
  drag(slider(), 30);
  assert.deepEqual(sets, [
    [20, 1],
    [30, 2],
  ]);
  // The answer to move 1 arrives after move 2 was made: the thumb stays.
  p.show(state({ value: 20, ends: ["20k", "80k"], seq: 1 }));
  assert.equal(slider().value, "30");
  // The answer to move 2.
  p.show(state({ value: 30, ends: ["30k", "70k"], seq: 2 }));
  assert.equal(slider().value, "30");
  assert.deepEqual(ends(), ["30k", "70k"]);
  // A change made elsewhere (an undo) answers the last move and moves it.
  p.show(state({ value: 50, ends: ["50k", "50k"], seq: 2 }));
  assert.equal(slider().value, "50");
});

test("a slider with no ends keeps its percentage in step", () => {
  const { p, root, slider } = panel();
  p.show(state({ ends: null, max: 200, value: 20 }));
  const readout = () => root.querySelector(".properties-range-value").textContent; // prettier-ignore
  assert.equal(readout(), "10%");
  p.show(state({ ends: null, max: 200, value: 150 }));
  assert.equal(slider().value, "150");
  assert.equal(readout(), "75%");
});

test("Shift+arrows and Page keys step 10, the wheel 1 a notch, clamped", () => {
  const { p, sets, slider } = panel();
  p.show(state());
  const key = (k, opts = {}) =>
    slider().dispatchEvent(
      new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }), // prettier-ignore
    );
  const last = () => sets.at(-1)[0];
  key("PageUp");
  assert.equal(last(), 60);
  key("ArrowLeft", { shiftKey: true });
  assert.equal(last(), 50);
  key("ArrowUp", { shiftKey: true });
  assert.equal(last(), 60);
  key("PageDown");
  key("PageDown");
  assert.equal(last(), 40);
  const wheel = (deltaY) =>
    window.dispatchEvent(
      new window.WheelEvent("wheel", { deltaY, cancelable: true }),
    );
  wheel(-100);
  assert.equal(last(), 41, "up raises it");
  wheel(100);
  wheel(100);
  assert.equal(last(), 39);
  for (let i = 0; i < 6; i++) key("PageDown");
  assert.equal(last(), 0);
  const count = sets.length;
  key("PageDown");
  assert.equal(sets.length, count, "nothing past the end");
});

test("a tapped Space is passed on; a chord is not", () => {
  const { p, toggles } = panel();
  p.show(state());
  const up = (opts = {}) =>
    window.dispatchEvent(
      new window.KeyboardEvent("keyup", {
        key: " ",
        cancelable: true,
        ...opts,
      }),
    );
  up();
  assert.equal(toggles(), 1);
  up({ metaKey: true });
  assert.equal(toggles(), 1);
});

test("pointed at or focused, it says so — once", () => {
  const { hovers } = panel();
  const html = document.documentElement;
  html.dispatchEvent(new window.PointerEvent("pointerenter"));
  window.dispatchEvent(new window.FocusEvent("focus"));
  html.dispatchEvent(new window.PointerEvent("pointerleave"));
  assert.deepEqual(hovers, [true], "still focused");
  window.dispatchEvent(new window.FocusEvent("blur"));
  assert.deepEqual(hovers, [true, false]);
});
