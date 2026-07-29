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

// jsdom tests for the Wire button's color dot (components/wire-color-dot.js):
// the readout that is also the picker.
//
// Every test mounts the dot INSIDE a real <button> with its own click handler,
// exactly as app.js does — because the contract this module exists to hold is
// that clicking the dot opens the picker WITHOUT toggling the wire tool the dot
// sits inside. app.js itself is mounted by no test, which is why the dot lives
// here rather than there.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { createWireColorDot } = await import("../components/wire-color-dot.js");
const { PopupManager } = await import("../popup-manager.js");
const { WIRE_COLORS } = await import("../model/desk-doc.js");
const { el } = await import("../dom.js");

/** The dot inside a Wire-button stand-in; `toggles` counts the tool toggles. */
function mountDot({ color = "red", onPick = () => {} } = {}) {
  const toggles = [];
  const dot = createWireColorDot({ getColor: () => color, onPick });
  const button = el("button", { onClick: () => toggles.push(1) }, [
    el("span", { text: "Wire" }),
    dot.element,
  ]);
  document.body.append(button);
  return { dot, button, toggles };
}

const swatches = () => [
  ...document.querySelectorAll(".popup-popover .color-swatch"),
];

const click = (node) =>
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

test("the dot opens a swatch per wire color, in WIRE_COLORS order", () => {
  resetDom();
  const { dot } = mountDot();
  click(dot.element);

  assert.ok(
    document.querySelector(".popup-popover"),
    "it opens as a popover, not a menu card",
  );
  assert.deepEqual(
    swatches().map((b) => b.dataset.color),
    [...WIRE_COLORS],
  );
  PopupManager.close();
});

test("clicking the dot never toggles the wire tool it sits inside", () => {
  resetDom();
  const { dot, toggles } = mountDot();
  click(dot.element);

  assert.deepEqual(toggles, [], "the button's own handler did not run");
  assert.equal(PopupManager.isOpen(), true, "and the picker did open");
  PopupManager.close();
});

test("a DISABLED Wire button (the circuit is running) makes the dot dead", () => {
  resetDom();
  const { dot, button, toggles } = mountDot();
  button.disabled = true; // what app.js does while the sim runs
  click(dot.element);

  // Measured, not assumed: a disabled button suppresses its own activation,
  // NOT clicks on its descendants — the click really does arrive here.
  assert.equal(PopupManager.isOpen(), false, "no picker while running");
  assert.deepEqual(toggles, [], "and still no toggle");
});

test("the current color is the ringed one, and takes focus", () => {
  resetDom();
  const { dot } = mountDot({ color: "green" });
  click(dot.element);

  const selected = swatches().filter((b) =>
    b.classList.contains("color-swatch--selected"),
  );
  assert.equal(selected.length, 1, "exactly one is ringed");
  assert.equal(selected[0].dataset.color, "green");
  assert.equal(selected[0].getAttribute("aria-pressed"), "true");
  assert.equal(
    selected[0].dataset.autofocus,
    "true",
    "the popover opens where the keyboard already is",
  );
  PopupManager.close();
});

test("picking a color closes the popover FIRST, then reports it", () => {
  resetDom();
  const picked = [];
  const openWhilePicking = [];
  const { dot } = mountDot({
    onPick: (color) => {
      picked.push(color);
      openWhilePicking.push(PopupManager.isOpen());
    },
  });
  click(dot.element);
  click(swatches().find((b) => b.dataset.color === "blue"));

  assert.deepEqual(picked, ["blue"]);
  assert.deepEqual(
    openWhilePicking,
    [false],
    "closed before the callback, so anything it opens is not queued behind it",
  );
  assert.equal(document.querySelector(".popup-popover"), null);
});

test("picking the color it already is still closes, and still reports", () => {
  resetDom();
  const picked = [];
  const { dot } = mountDot({ color: "red", onPick: (c) => picked.push(c) });
  click(dot.element);
  click(swatches().find((b) => b.dataset.color === "red"));

  assert.deepEqual(picked, ["red"], "the click answered the question");
  assert.equal(PopupManager.isOpen(), false);
});

test("dismissing the popover without picking reports nothing", () => {
  resetDom();
  const picked = [];
  const { dot } = mountDot({ onPick: (c) => picked.push(c) });
  click(dot.element);
  document
    .querySelector("dialog")
    .dispatchEvent(new window.Event("cancel", { cancelable: true }));

  assert.equal(PopupManager.isOpen(), false);
  assert.deepEqual(picked, []);
});

test("the popover is anchored under the dot", () => {
  resetDom();
  const { dot } = mountDot();
  // jsdom gives every element a zero rect, so the anchor is stubbed — this is
  // the only way to see that the popover follows the DOT and not the origin.
  dot.element.getBoundingClientRect = () => ({
    left: 120,
    top: 30,
    right: 132,
    bottom: 44,
    width: 12,
    height: 12,
  });
  click(dot.element);

  const card = document.querySelector(".popup-popover");
  assert.equal(card.style.left, "120px");
  assert.equal(card.style.top, "50px", "the dot's bottom edge plus the gap");
  PopupManager.close();
});

test("setColor repaints the dot and its tooltip", () => {
  resetDom();
  const { dot } = mountDot();
  dot.setColor("purple");

  assert.equal(
    dot.element.style.getPropertyValue("--wire-color"),
    "var(--color-wire-purple)",
  );
  assert.match(dot.element.title, /purple/);
});
