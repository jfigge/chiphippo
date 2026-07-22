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

// jsdom tests for LcdView (HD44780): the static SVG carries a bezel, green
// panel, size badge, and 16 numbered terminal pads; renderFramebuffer paints
// lit dots onto the canvas (recorded by the jsdom 2d-context stub) and blanks
// it when the display is off; updateParams resizes the canvas for 16×2 vs 20×4;
// setStatus mirrors the chip fault classes.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { framebufferOf } from "../sim/hd44780.js";
import { hd44780Unit } from "../sim/hd44780.js";

const { LcdView, buildLcdSvg } = await import("../components/lcd-view.js");

const RS = 4;
const E = 6;
const DB = [7, 8, 9, 10, 11, 12, 13, 14];
const unit = () => hd44780Unit({ rs: RS, rw: 5, e: E, db: DB });

/** A tiny helper to run one command/data byte through the unit (E falling). */
function xfer(u, s, rs, data) {
  const m = (e) => {
    const map = new Map([
      [RS, rs],
      [5, "L"],
      [E, e],
    ]);
    for (let i = 0; i < 8; i++) map.set(DB[i], (data >> i) & 1 ? "H" : "L");
    return map;
  };
  return u.step(s, m("L"), m("H"));
}

test("buildLcdSvg renders bezel, panel, size badge, and 16 numbered pads", () => {
  resetDom();
  const svg = buildLcdSvg({ size: "20x4" });
  assert.ok(svg.querySelector(".part-lcd-body"));
  assert.ok(svg.querySelector(".part-lcd-panel"));
  assert.equal(svg.querySelector(".part-lcd-size").textContent, "20×4");
  assert.equal(svg.querySelectorAll(".part-lcd-terminal").length, 16);
  assert.equal(svg.querySelectorAll(".part-lcd-terminal-label").length, 16);
});

test("mount + updateParams sizes the canvas for the chosen grid", () => {
  resetDom();
  const layer = document.createElement("div");
  const view = new LcdView(layer, {
    id: "lcd1",
    x: 0,
    y: 0,
    params: { size: "16x2" },
  });
  const canvas = layer.querySelector(".part-lcd-screen");
  assert.ok(canvas);
  const w16 = canvas.width;
  view.updateParams({ size: "20x4" });
  assert.ok(canvas.width > w16, "20×4 is wider than 16×2");
  assert.equal(layer.querySelector(".part-lcd-size").textContent, "20×4");
});

test("renderFramebuffer paints lit dots when on, blanks when off/null", () => {
  resetDom();
  const layer = document.createElement("div");
  const view = new LcdView(layer, {
    id: "lcd1",
    x: 0,
    y: 0,
    params: { size: "16x2" },
  });
  const canvas = layer.querySelector(".part-lcd-screen");

  // Build a state showing 'A' at cell 0 with the display on.
  const u = unit();
  let s = u.state0();
  s = xfer(u, s, "L", 0x0c); // display on
  s = xfer(u, s, "H", 0x41); // 'A'
  const fb = framebufferOf(s, { size: "16x2" });

  view.renderFramebuffer(fb);
  const fills = canvas.__ctx.ops.filter((o) => o[0] === "fillRect").length;
  assert.ok(fills > 0, "lit dots are drawn");

  // Null (not running / off) clears without drawing dots.
  canvas.__ctx.ops.length = 0;
  view.renderFramebuffer(null);
  assert.equal(
    canvas.__ctx.ops.filter((o) => o[0] === "fillRect").length,
    0,
    "a blank screen draws no dots",
  );
  assert.ok(
    canvas.__ctx.ops.some((o) => o[0] === "clearRect"),
    "the canvas is cleared",
  );
});

test("setStatus mirrors the chip fault classes", () => {
  resetDom();
  const layer = document.createElement("div");
  const view = new LcdView(layer, {
    id: "lcd1",
    x: 0,
    y: 0,
    params: { size: "16x2" },
  });
  const elem = layer.querySelector(".part-lcd");
  view.setStatus("damaged");
  assert.ok(elem.classList.contains("part-lcd--damaged"));
  view.setStatus("unpowered");
  assert.ok(elem.classList.contains("part-lcd--unpowered"));
  assert.ok(!elem.classList.contains("part-lcd--damaged"));
  view.setStatus(null);
  assert.ok(!elem.classList.contains("part-lcd--unpowered"));
});
