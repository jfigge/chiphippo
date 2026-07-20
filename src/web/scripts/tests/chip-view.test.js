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

// jsdom tests for the DIP chip SVG builder + ChipView shell.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition } from "../model/breadboard.js";

const { buildChipSvg, ChipView, chipBox } =
  await import("../components/chip-view.js");

test("buildChipSvg: legs, body, notch, pin-1 dot, and the part number", () => {
  resetDom();
  const svg = buildChipSvg("7400");
  // One leg per pin (14), split evenly over the two rows.
  assert.equal(svg.querySelectorAll(".part-chip-leg").length, 14);
  assert.equal(svg.querySelectorAll(".part-chip-body").length, 1);
  assert.equal(svg.querySelectorAll(".part-chip-notch").length, 1);
  assert.equal(svg.querySelectorAll(".part-chip-dot").length, 1);
  const label = svg.querySelector(".part-chip-label");
  assert.equal(label.textContent, "7400");
  // No per-pin ids or listeners — the legs are inert decoration.
  for (const leg of svg.querySelectorAll(".part-chip-leg")) {
    assert.equal(leg.id, "");
  }
});

test("buildChipSvg: fault symbols stay OUTSIDE the 180° flip group", () => {
  resetDom();
  const svg = buildChipSvg("7400", { rot: 180 });
  const flipped = svg.querySelector(".part-chip-flipped");
  assert.ok(flipped, "expected the flip group");
  // Smoke has to rise in screen space and the warning triangle has to stay
  // upright, so neither symbol may be caught by the rotation.
  assert.equal(flipped.querySelectorAll(".part-burn, .part-warn").length, 0);
  const status = svg.querySelector(".part-chip-status");
  assert.ok(status.querySelector(".part-warn"));
  assert.ok(status.querySelector(".part-burn"));
  // The hint host exists but is empty until a status arrives.
  assert.equal(status.querySelector("title").textContent, "");
});

test("buildChipSvg: rejects unknown refs", () => {
  resetDom();
  assert.throws(() => buildChipSvg("9999"), { code: "INVALID_REF" });
});

test("ChipView seats at its anchor hole in world px and reports gestures", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);

  const seen = [];
  const view = new ChipView(
    layer,
    { id: "c3", ref: "7400" },
    { onPointerDown: (id) => seen.push(id) },
  );
  const board = { type: "pins-full", x: 10, y: 20 };
  view.updatePlacement(board, "e5");

  const partEl = layer.querySelector(".part-chip");
  assert.ok(partEl);
  assert.equal(partEl.dataset.componentId, "c3");

  // Element origin = board origin + anchor hole + the footprint box offset.
  const pos = holePosition("pins-full", "e5");
  const box = chipBox("DIP-14");
  assert.equal(
    partEl.style.left,
    `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`,
  );
  assert.equal(
    partEl.style.top,
    `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`,
  );

  partEl.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.deepEqual(seen, ["c3"]);

  view.setSelected(true);
  assert.ok(partEl.classList.contains("part--selected"));
  view.remove();
  assert.equal(layer.querySelector(".part-chip"), null);
});
