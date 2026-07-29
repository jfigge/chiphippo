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

// jsdom tests for the Bus button's width badge (components/bus-width-badge.js):
// the second readout that is also its own picker.
//
// Every test mounts the badge INSIDE a real <button> with its own click
// handler, exactly as app.js does — because the contract this module exists to
// hold is that clicking the badge opens the picker WITHOUT toggling the bus
// tool the badge sits inside. app.js itself is mounted by no test.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { createBusWidthBadge } =
  await import("../components/bus-width-badge.js");
const { PopupManager } = await import("../popup-manager.js");
const { BUS_WIDTHS } = await import("../model/desk-doc.js");
const { el } = await import("../dom.js");

/** The badge inside a Bus-button stand-in; `toggles` counts the tool toggles. */
function mountBadge({ name = "D[7:0]", onPick = () => {} } = {}) {
  const toggles = [];
  const badge = createBusWidthBadge({ getName: () => name, onPick });
  badge.setName(name);
  const button = el("button", { onClick: () => toggles.push(1) }, [
    el("span", { text: "Bus" }),
    badge.element,
  ]);
  document.body.append(button);
  return { badge, button, toggles };
}

const options = () => [
  ...document.querySelectorAll(".popup-popover .bus-width-option"),
];

const click = (node) =>
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

test("the badge opens one circled option per preset, in BUS_WIDTHS order", () => {
  resetDom();
  const { badge } = mountBadge();
  click(badge.element);

  assert.ok(
    document.querySelector(".popup-popover"),
    "it opens as a popover, not a menu card",
  );
  assert.deepEqual(
    options().map((b) => b.dataset.name),
    BUS_WIDTHS.map((w) => w.name),
  );
  // Each shows its bit count — 2…8 then 16, the same glyph as the badge.
  assert.deepEqual(
    options().map((b) => b.textContent),
    ["2", "3", "4", "5", "6", "7", "8", "16"],
  );
  PopupManager.close();
});

test("clicking the badge never toggles the bus tool it sits inside", () => {
  resetDom();
  const { badge, toggles } = mountBadge();
  click(badge.element);

  assert.deepEqual(toggles, [], "the button's own handler did not run");
  assert.equal(PopupManager.isOpen(), true, "and the picker did open");
  PopupManager.close();
});

test("a DISABLED Bus button (the circuit is running) makes the badge dead", () => {
  resetDom();
  const { badge, button, toggles } = mountBadge();
  button.disabled = true; // what app.js does while the sim runs
  click(badge.element);

  // A disabled button suppresses its own activation, NOT clicks on its
  // descendants — the click really does arrive at the badge.
  assert.equal(PopupManager.isOpen(), false, "no picker while running");
  assert.deepEqual(toggles, [], "and still no toggle");
});

test("the current width is the ringed one, and takes focus", () => {
  resetDom();
  const { badge } = mountBadge({ name: "D[3:0]" }); // 4-bit
  click(badge.element);

  const selected = options().filter((b) =>
    b.classList.contains("bus-width-option--selected"),
  );
  assert.equal(selected.length, 1, "exactly one is ringed");
  assert.equal(selected[0].textContent, "4");
  assert.equal(selected[0].getAttribute("aria-pressed"), "true");
  assert.equal(
    selected[0].dataset.autofocus,
    "true",
    "the popover opens where the keyboard already is",
  );
  PopupManager.close();
});

test("picking a width closes the popover FIRST, then reports its bus name", () => {
  resetDom();
  const picked = [];
  const openWhilePicking = [];
  const { badge } = mountBadge({
    onPick: (name) => {
      picked.push(name);
      openWhilePicking.push(PopupManager.isOpen());
    },
  });
  click(badge.element);
  click(options().find((b) => b.textContent === "16"));

  assert.deepEqual(
    picked,
    ["D[15:0]"],
    "the NAME, which is what the tool parses",
  );
  assert.deepEqual(
    openWhilePicking,
    [false],
    "closed before the callback, so anything it opens is not queued behind it",
  );
  assert.equal(document.querySelector(".popup-popover"), null);
});

test("picking the width it already is still closes, and still reports", () => {
  resetDom();
  const picked = [];
  const { badge } = mountBadge({
    name: "D[7:0]",
    onPick: (n) => picked.push(n),
  });
  click(badge.element);
  click(options().find((b) => b.textContent === "8"));

  assert.deepEqual(picked, ["D[7:0]"], "the click answered the question");
  assert.equal(PopupManager.isOpen(), false);
});

test("dismissing the popover without picking reports nothing", () => {
  resetDom();
  const picked = [];
  const { badge } = mountBadge({ onPick: (n) => picked.push(n) });
  click(badge.element);
  document
    .querySelector("dialog")
    .dispatchEvent(new window.Event("cancel", { cancelable: true }));

  assert.equal(PopupManager.isOpen(), false);
  assert.deepEqual(picked, []);
});

test("the popover is anchored under the badge", () => {
  resetDom();
  const { badge } = mountBadge();
  // jsdom gives every element a zero rect, so the anchor is stubbed — this is
  // the only way to see that the popover follows the BADGE, not the origin.
  badge.element.getBoundingClientRect = () => ({
    left: 200,
    top: 30,
    right: 218,
    bottom: 48,
    width: 18,
    height: 18,
  });
  click(badge.element);

  const card = document.querySelector(".popup-popover");
  assert.equal(card.style.left, "200px");
  assert.equal(card.style.top, "54px", "the badge's bottom edge plus the gap");
  PopupManager.close();
});

test("setName repaints the glyph and its tooltip", () => {
  resetDom();
  const { badge } = mountBadge();
  badge.setName("D[5:0]");

  assert.equal(badge.element.textContent, "6");
  assert.match(badge.element.title, /D\[5:0\]/);

  // A name that is no preset still reads as something — the 8-bit default.
  badge.setName("A[0:11]");
  assert.equal(badge.element.textContent, "8");
});

test("the picker reads the CURRENT width at click time, not at construction", () => {
  resetDom();
  let name = "D[7:0]";
  const badge = createBusWidthBadge({ getName: () => name, onPick: () => {} });
  document.body.append(el("button", {}, [badge.element]));

  name = "D[15:0]"; // e.g. a digit key moved it while the popover was shut
  click(badge.element);
  const selected = options().find((b) =>
    b.classList.contains("bus-width-option--selected"),
  );
  assert.equal(selected.textContent, "16");
  PopupManager.close();
});
