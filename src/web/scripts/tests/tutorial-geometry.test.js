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

// The tutorial overlay's arithmetic: where a callout goes, what its brace and
// arrow look like, the spotlight's hole and the fake cursor's timing. All of
// it is stated against rectangles, so a resize is just a different input.

import test from "node:test";
import assert from "node:assert/strict";

import {
  VIEW_MARGIN,
  arrowPath,
  bracePath,
  chooseSide,
  decorationGap,
  easeInOut,
  placeCallout,
  rectPoint,
  spotlightPath,
  travelMs,
  MOVE_MS_MAX,
  MOVE_MS_MIN,
} from "../tutorials/geometry.js";

const VIEW = { width: 1200, height: 800 };
const CARD = { width: 300, height: 100 };
const TRAY = { left: 0, top: 48, width: 232, height: 752 };
const GEAR = { left: 1160, top: 10, width: 28, height: 28 };

/** Does the card at `p` sit wholly inside the window's margins? */
const inside = (p, size = CARD, view = VIEW) =>
  p.x >= VIEW_MARGIN - 1e-9 &&
  p.y >= VIEW_MARGIN - 1e-9 &&
  p.x + size.width <= view.width - VIEW_MARGIN + 1e-9 &&
  p.y + size.height <= view.height - VIEW_MARGIN + 1e-9;

test("a named side that fits is honoured; one that doesn't flips to its opposite", () => {
  const gap = decorationGap("arrow");
  assert.equal(chooseSide(TRAY, CARD, "right", VIEW, gap), "right");
  // The gear sits in the top-right corner: "above" has no room, "below" does.
  assert.equal(chooseSide(GEAR, CARD, "above", VIEW, gap), "below");
});

test("auto takes the side with the most room to spare", () => {
  const gap = decorationGap("ring");
  assert.equal(chooseSide(TRAY, CARD, "auto", VIEW, gap), "right");
  const bottomBar = { left: 300, top: 740, width: 600, height: 40 };
  assert.equal(chooseSide(bottomBar, CARD, "auto", VIEW, gap), "above");
});

test("the callout sits beside its target, clear of the decoration, and on screen", () => {
  const p = placeCallout({
    rect: TRAY,
    size: CARD,
    placement: "right",
    decoration: "brace",
    view: VIEW,
  });
  assert.equal(p.side, "right");
  assert.equal(p.x, TRAY.left + TRAY.width + decorationGap("brace"));
  // Centred on the tray's height.
  assert.equal(p.y, TRAY.top + TRAY.height / 2 - CARD.height / 2);
  assert.ok(inside(p));

  // Under the gear in the corner: centred on it would run off the right
  // edge, so it is pulled back inside.
  const g = placeCallout({
    rect: GEAR,
    size: CARD,
    placement: "below",
    decoration: "arrow",
    view: VIEW,
  });
  assert.equal(g.side, "below");
  assert.ok(inside(g), "clamped into the window");
  assert.equal(g.y, GEAR.top + GEAR.height + decorationGap("arrow"));
});

test("no target centres the callout; inside-top puts it in the target's top band", () => {
  const c = placeCallout({ rect: null, size: CARD, view: VIEW });
  assert.deepEqual(c, { x: 450, y: 350, side: null });
  const desk = { left: 232, top: 80, width: 968, height: 720 };
  const i = placeCallout({
    rect: desk,
    size: CARD,
    placement: "inside-top",
    view: VIEW,
  });
  assert.equal(i.side, null);
  assert.ok(i.y > desk.top && i.y < desk.top + desk.height / 3);
  assert.equal(i.x, desk.left + (desk.width - CARD.width) / 2);
});

test("a resize moves the callout with the window, never off it", () => {
  for (const view of [
    { width: 1200, height: 800 },
    { width: 640, height: 480 },
    { width: 420, height: 300 },
  ]) {
    const rect = { left: view.width - 40, top: 10, width: 28, height: 28 };
    const p = placeCallout({
      rect,
      size: CARD,
      placement: "below",
      decoration: "arrow",
      view,
    });
    assert.ok(inside(p, CARD, view), `inside a ${view.width}×${view.height}`);
  }
});

test("the brace runs the target's whole edge, its tip at the middle, facing the callout", () => {
  const { d, tip } = bracePath(TRAY, "right");
  assert.match(d, /^M /);
  // The tip stands off the right edge, half-way down the tray.
  assert.ok(tip.x > TRAY.left + TRAY.width);
  assert.equal(tip.y, TRAY.top + TRAY.height / 2);
  // It starts at the top and ends at the bottom of the edge.
  const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
  assert.equal(nums[1], TRAY.top);
  assert.equal(nums.at(-1), TRAY.top + TRAY.height);

  const pill = { left: 100, top: 10, width: 120, height: 28 };
  const under = bracePath(pill, "below");
  assert.equal(under.tip.x, 160, "a horizontal brace's tip is mid-width");
  assert.ok(under.tip.y > pill.top + pill.height, "below the pill");
});

test("the arrow runs from the callout's near edge to the target's facing edge", () => {
  const box = { left: 300, top: 300, width: 300, height: 100 };
  const { from, to, d } = arrowPath(TRAY, box, "right");
  assert.equal(from.x, box.left);
  assert.ok(to.x > TRAY.left + TRAY.width && to.x < box.left);
  assert.equal(from.y, to.y, "level when the callout faces the target");
  assert.equal((d.match(/M /g) ?? []).length, 2, "a shaft and a head");
});

test("the spotlight is the window with the target cut out", () => {
  const plain = spotlightPath(VIEW, null);
  assert.equal(plain, "M 0 0 H 1200 V 800 H 0 Z");
  const holed = spotlightPath(VIEW, TRAY);
  assert.ok(holed.startsWith(plain));
  assert.equal((holed.match(/Z/g) ?? []).length, 2, "an outer path and a hole");
});

test("the cursor's moves are eased and take 0.5–1 s", () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
  assert.ok(easeInOut(0.1) < 0.1, "a slow start");
  const near = travelMs({ x: 0, y: 0 }, { x: 10, y: 0 });
  const far = travelMs({ x: 0, y: 0 }, { x: 3000, y: 0 });
  assert.ok(near >= MOVE_MS_MIN && near < far);
  assert.equal(far, MOVE_MS_MAX);
  assert.deepEqual(rectPoint(TRAY, [0.5, 0.5]), { x: 116, y: 424 });
});
