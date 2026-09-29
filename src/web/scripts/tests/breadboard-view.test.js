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

// jsdom tests for the board SVG builder + BreadboardView shell.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { BOARD_TYPES } from "../model/board-types.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

const { buildBoardSvg, BreadboardView } =
  await import("../components/breadboard-view.js");

/** Expected column-numeral positions: col 1 + every multiple of 5, ×2 rows. */
function expectedColLabels(cols) {
  if (cols === 0) return 0; // a rail strip has no columns to number
  let n = 1;
  for (let c = 5; c <= cols; c += 5) n++;
  return n * 2;
}

for (const [type, s] of Object.entries(BOARD_TYPES)) {
  const pins = s.kind === "pins";
  test(`buildBoardSvg(${type}): hole count, labels, rails, size`, () => {
    resetDom();
    const svg = buildBoardSvg(type);

    // Every tie point is drawn — and none carries an id or listener hook.
    const holes = svg.querySelectorAll(".board-hole");
    assert.equal(holes.length, s.tiePoints);
    for (const hole of holes) assert.equal(hole.id, "");

    // Row letters at both ends of the 10 grid rows — a rail strip has none.
    assert.equal(
      svg.querySelectorAll(".board-row-label").length,
      pins ? 20 : 0,
    );

    // Column numerals above and below.
    assert.equal(
      svg.querySelectorAll(".board-col-label").length,
      expectedColLabels(s.cols),
    );

    // Rail stripes: one per rail (red/blue), none on a pin-board.
    assert.equal(
      svg.querySelectorAll(".board-rail-stripe").length,
      s.rails.length,
    );
    assert.equal(
      svg.querySelectorAll(".board-rail-stripe--plus").length,
      s.rails.filter((r) => r.polarity === "+").length,
    );

    // One body; the trench belongs to the pin-board alone. viewBox + px size
    // match the spec outline.
    assert.equal(svg.querySelectorAll(".board-body").length, 1);
    assert.equal(svg.querySelectorAll(".board-trench").length, pins ? 1 : 0);
    assert.equal(svg.getAttribute("viewBox"), `0 0 ${s.width} ${s.height}`);
    assert.equal(Number(svg.getAttribute("width")), s.width * PX_PER_UNIT);
    assert.equal(Number(svg.getAttribute("height")), s.height * PX_PER_UNIT);
  });
}

test("buildBoardSvg throws on junk types", () => {
  resetDom();
  assert.throws(() => buildBoardSvg("mega"), { code: "INVALID_TYPE" });
});

test("BreadboardView mounts, positions in world px, reports pointerdown", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);

  const seen = [];
  const view = new BreadboardView(
    layer,
    { id: "bb7", type: "pins-tiny", x: 3, y: -2 },
    { onPointerDown: (id) => seen.push(id) },
  );

  const boardEl = layer.querySelector(".board");
  assert.ok(boardEl);
  assert.equal(boardEl.dataset.boardId, "bb7");
  assert.equal(boardEl.style.left, `${3 * PX_PER_UNIT}px`);
  assert.equal(boardEl.style.top, `${-2 * PX_PER_UNIT}px`);

  boardEl.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.deepEqual(seen, ["bb7"]);

  view.setSelected(true);
  assert.ok(boardEl.classList.contains("board--selected"));
  view.setPosition(10, 20);
  assert.equal(boardEl.style.left, `${10 * PX_PER_UNIT}px`);

  view.remove();
  assert.equal(layer.querySelector(".board"), null);
});
