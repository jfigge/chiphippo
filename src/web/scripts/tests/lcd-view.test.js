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

// jsdom tests for the HD44780 character-LCD modules. The static drawing is an
// ordinary discrete SVG (PCB, bezel opening, glass, the 16-way header printed
// where it plugs in) sized straight from the def's datasheet geometry; LcdView
// adds the live canvas over the glass. Covered here: the drawing's parts and
// scale, the hit rect's clearance from the next hole row (a wiring regression),
// seating maths, canvas sizing, the framebuffer paint, the per-colour dot cache,
// and the shared fault classes.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { framebufferOf, hd44780Unit } from "../sim/hd44780.js";
import { partDef } from "../catalog/index.js";

const { LcdView } = await import("../components/lcd-view.js");
const { buildDiscreteSvg, discreteBox } =
  await import("../components/discrete-view.js");

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

const mount = (ref, params = {}) => {
  const layer = document.createElement("div");
  const view = new LcdView(layer, { id: "c1", ref, params });
  return { layer, view };
};

test("the module draws its PCB, glass and 16-way header, to datasheet scale", () => {
  resetDom();
  for (const [ref, badge] of [
    ["lcd16x2", "16×2"],
    ["lcd20x4", "20×4"],
  ]) {
    const svg = buildDiscreteSvg(ref, { color: "green" });
    assert.ok(svg.querySelector(".part-lcd-body"), ref);
    assert.ok(svg.querySelector(".part-lcd-window"), ref);
    assert.ok(svg.querySelector(".part-lcd-panel"), ref);
    assert.ok(svg.querySelector(".part-lcd-header"), ref);
    // One hole per pin, on the 0.1-in pitch — this is what plugs into the board.
    assert.equal(svg.querySelectorAll(".part-lcd-hole").length, 16, ref);
    assert.equal(svg.querySelector(".part-lcd-size").textContent, badge);
    assert.equal(svg.querySelectorAll(".part-display-hit").length, 1, ref);
    // The old brick's 16 wireable pads are gone: the pins ARE holes now.
    assert.equal(svg.querySelectorAll(".part-lcd-terminal").length, 0, ref);
    // The viewBox is the module outline, so the drawing is the real thing at
    // the desk's own scale rather than a hand-picked rectangle.
    const box = partDef(ref).characterDisplay.body;
    assert.equal(
      svg.getAttribute("viewBox"),
      `${box.minX} ${box.minY} ${box.width} ${box.height}`,
    );
    assert.equal(discreteBox(ref), box);
  }
});

// Both modules carry their header along the TOP edge, so both hang below the
// row they plug into and both are seated on row a, wiring holes in b–e. The
// nearest of those sits UNDER the module's own PCB, which overhangs its header
// by 0.98 units — short of the next row's hole centres, but inside the holes —
// so a full-body hit rect would swallow the click that was meant for a wire.
// The rect has to stand off the hole row.
test("the hit rect clears the hole row on the header side", () => {
  resetDom();
  for (const [ref, wiringSide] of [
    ["lcd16x2", +1], // body hangs DOWN; wiring holes are ABOVE it (-y)
    ["lcd20x4", +1],
  ]) {
    const hit = buildDiscreteSvg(ref, { color: "green" }).querySelector(
      ".part-display-hit",
    );
    const y = Number(hit.getAttribute("y"));
    const bottom = y + Number(hit.getAttribute("height"));
    const edge = wiringSide < 0 ? bottom : y;
    // Half a pitch of clearance, on the correct side of the header.
    assert.equal(Math.abs(edge), 0.5, ref);
    assert.equal(Math.sign(edge), wiringSide, ref);
  }
});

test("the module seats by its body box, like every other discrete", () => {
  resetDom();
  const { layer, view } = mount("lcd16x2");
  const board = { id: "bb1", type: "pins-full", x: 10, y: 20, rot: 0 };
  view.updatePlacement(board, "j1");
  const box = partDef("lcd16x2").characterDisplay.body;
  const el = layer.querySelector(".part-discrete");
  // Board origin + pin 1's hole + the box offset (holePosition puts row j's
  // column 1 at local 1,1 on a pin-board).
  assert.equal(el.style.left, `${(10 + 1 + box.minX) * 10}px`);
  assert.equal(el.style.top, `${(20 + 1 + box.minY) * 10}px`);
});

test("the canvas covers the active area and models its character grid", () => {
  resetDom();
  for (const [ref, cols, rows] of [
    ["lcd16x2", 16, 2],
    ["lcd20x4", 20, 4],
  ]) {
    const { layer } = mount(ref);
    const canvas = layer.querySelector(".part-lcd-screen");
    assert.ok(canvas, ref);
    // The buffer drops its own TRAILING inter-character gap, exactly as the
    // real active area does — 6 dots per cell, less one, times 3 device px.
    assert.equal(canvas.width, (cols * 6 - 1) * 3, ref);
    assert.equal(canvas.height, (rows * 9 - 1) * 3, ref);
    // …and it sits over the glass, not over the whole module.
    const { body, screen } = partDef(ref).characterDisplay;
    assert.equal(canvas.style.left, `${(screen.x - body.minX) * 10}px`);
    assert.equal(canvas.style.width, `${screen.width * 10}px`);
  }
});

test("renderFramebuffer paints lit dots when on, blanks when off/null", () => {
  resetDom();
  const { layer, view } = mount("lcd16x2");
  const canvas = layer.querySelector(".part-lcd-screen");

  // Build a state showing 'A' at cell 0 with the display on.
  const u = unit();
  let s = u.state0();
  s = xfer(u, s, "L", 0x0c); // display on
  s = xfer(u, s, "H", 0x41); // 'A'
  const fb = framebufferOf(s, { cols: 16, rows: 2 });

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

// The dot colour is cached (it costs a getComputedStyle per paint otherwise),
// and the cache has to be keyed on the COLOUR: a green module recoloured blue
// goes from dark-on-tint to light-on-blue, and a cache that outlived the change
// would keep painting the old module's dots on the new module's field.
test("recolouring the module re-resolves the lit-dot colour", () => {
  resetDom();
  const { layer, view } = mount("lcd16x2", { color: "green" });
  const canvas = layer.querySelector(".part-lcd-screen");
  const u = unit();
  let s = u.state0();
  s = xfer(u, s, "L", 0x0c);
  s = xfer(u, s, "H", 0x41);
  const fb = framebufferOf(s, { cols: 16, rows: 2 });

  // jsdom's getComputedStyle does not resolve custom properties, so stand one
  // in that answers with the property NAME — which is the thing under test:
  // whether a recoloured module goes back for its own colour's token.
  const real = globalThis.getComputedStyle;
  const asked = [];
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (prop) => {
      asked.push(prop);
      return `TOKEN${prop}`;
    },
  });
  try {
    const fillStyleAfter = (color) => {
      view.updateParams({ color });
      canvas.__ctx.ops.length = 0;
      view.renderFramebuffer(fb);
      return canvas.__ctx.fillStyle;
    };
    assert.equal(fillStyleAfter("green"), "TOKEN--color-lcd-dot-green");
    assert.equal(fillStyleAfter("blue"), "TOKEN--color-lcd-dot-blue");
    assert.deepEqual(asked, [
      "--color-lcd-dot-green",
      "--color-lcd-dot-blue", // blue is negative-mode: light dots on blue
    ]);
  } finally {
    globalThis.getComputedStyle = real;
  }
  // …and the panel tint follows too.
  assert.equal(
    layer
      .querySelector(".part-discrete-svg")
      .style.getPropertyValue("--lcd-screen"),
    "var(--color-lcd-screen-blue)",
  );
});

test("setStatus mirrors the shared discrete fault classes", () => {
  resetDom();
  const { layer, view } = mount("lcd16x2");
  const elem = layer.querySelector(".part-discrete");
  view.setStatus("damaged");
  assert.ok(elem.classList.contains("part-discrete--damaged"));
  view.setStatus("unpowered");
  assert.ok(elem.classList.contains("part-discrete--unpowered"));
  assert.ok(!elem.classList.contains("part-discrete--damaged"));
  view.setStatus(null);
  assert.ok(!elem.classList.contains("part-discrete--unpowered"));
});
