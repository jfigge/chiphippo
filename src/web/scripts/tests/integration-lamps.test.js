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
// jsdom tests for components/integration-lamps.js — the TX/RX/LG activity
// pill beside the zoom cluster. A lamp is only honest if it goes OUT again, so
// what is pinned here is the flash (lit on a report, dark after it, kept lit
// by a burst), that a hidden pill lights nothing, and that clicking any lamp
// hands the pill's rect to whoever opens a connection window.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { IntegrationLamps } = await import("../components/integration-lamps.js");

function mount() {
  const win = resetDom();
  const viewport = win.document.createElement("div");
  win.document.body.append(viewport);
  const logs = [];
  const lamps = new IntegrationLamps(viewport, {
    onOpen: (rect) => logs.push(rect),
  });
  const lamp = (kind) => viewport.querySelector(`.integration-lamp--${kind}`);
  const on = (kind) => lamp(kind).classList.contains("integration-lamp--on");
  return { win, viewport, lamps, lamp, on, logs };
}

test("three lamps, TX · RX · LG, in a pill hidden until a run uses the link", () => {
  const { viewport, lamps } = mount();
  const root = viewport.querySelector(".integration-lamps");
  assert.equal(root, lamps.element);
  assert.deepEqual(
    [...root.querySelectorAll(".integration-lamp-label")].map(
      (n) => n.textContent,
    ),
    ["TX", "RX", "LG"],
  );
  assert.equal(root.hidden, true);
  assert.equal(lamps.active, false);
  lamps.setActive(true);
  assert.equal(root.hidden, false);
  assert.equal(lamps.active, true);
});

test("every lamp is a button, with a translated tooltip saying what a click does", () => {
  const { lamp } = mount();
  for (const kind of ["tx", "rx", "lg"]) {
    assert.equal(lamp(kind).tagName, "BUTTON");
    assert.match(lamp(kind).title, /open a connection window/);
    assert.doesNotMatch(lamp(kind).title, /integration\./, "not a raw key");
  }
});

test("a flash lights one lamp and it goes out on its own", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { lamps, on } = mount();
  lamps.setActive(true);
  lamps.flash("tx");
  assert.equal(on("tx"), true);
  assert.equal(on("rx"), false);
  t.mock.timers.tick(119);
  assert.equal(on("tx"), true);
  t.mock.timers.tick(1);
  assert.equal(on("tx"), false);
});

test("a burst keeps a lamp lit: each report restarts its flash", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { lamps, on } = mount();
  lamps.setActive(true);
  lamps.flash("rx");
  t.mock.timers.tick(100);
  lamps.flash("rx");
  t.mock.timers.tick(100);
  assert.equal(on("rx"), true, "still lit 200 ms after the first report");
  t.mock.timers.tick(20);
  assert.equal(on("rx"), false);
});

test("a hidden pill lights nothing, and hiding it puts every lamp out", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { lamps, on } = mount();
  lamps.flash("lg");
  assert.equal(on("lg"), false, "not running — no flash");
  lamps.setActive(true);
  lamps.flash("lg");
  lamps.flash("tx");
  lamps.setActive(false);
  assert.equal(on("lg"), false);
  assert.equal(on("tx"), false);
  lamps.flash("nonsense"); // an unknown kind is ignored, not thrown
});

test("clicking any lamp opens a connection window, anchored on the pill", () => {
  const { lamp, lamps, logs } = mount();
  lamps.setActive(true);
  for (const kind of ["tx", "rx", "lg"]) lamp(kind).click();
  assert.equal(logs.length, 3);
  assert.equal(typeof logs[0].left, "number", "a DOMRect to anchor a menu on");
});
