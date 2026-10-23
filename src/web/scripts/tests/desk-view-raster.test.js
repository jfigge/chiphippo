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

// jsdom tests for the re-raster after a zoom (components/desk-view.js
// #scheduleReraster). `.desk-surface` keeps `will-change: transform` so a pan
// or a pinch is cheap, and Chromium then keeps the bitmap it has through a
// scale change — zoomed in, the parts' small print was the old pixels
// stretched. So once the zoom settles the hint is dropped for one painted
// frame and comes back, and the layer is rasterized again at the scale on
// screen. What is pinned: it happens after a zoom, once, after the LAST step
// of a stream, and never for a camera move that keeps the scale.
//
// No compositor runs under jsdom, so the blur itself cannot be seen here; the
// inline `will-change` going `auto` and back is the whole observable.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { DeskView } = await import("../components/desk-view.js");

/** desk-view.js's RERASTER_SETTLE_MS. */
const SETTLE = 200;
/** One frame: node has no requestAnimationFrame, so nextFrame is a 16 ms timer. */
const FRAME = 16;

function mount(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  resetDom();
  const viewport = document.createElement("section");
  document.body.append(viewport);
  const deskView = new DeskView(viewport, {
    camera: { cx: 0, cy: 0, zoom: 1 },
  });
  const hint = () => deskView.surface.style.willChange;
  return { viewport, deskView, hint };
}

test("a zoom drops the hint for one frame once it settles, then restores the stylesheet's", (t) => {
  const { deskView, hint } = mount(t);
  deskView.zoomIn();
  assert.equal(hint(), "", "nothing while the zoom may still be moving");
  t.mock.timers.tick(SETTLE - 1);
  assert.equal(hint(), "");
  t.mock.timers.tick(1);
  assert.equal(hint(), "auto", "settled: the layer is let go");
  t.mock.timers.tick(FRAME);
  assert.equal(hint(), "auto", "still let go through the frame that paints it");
  t.mock.timers.tick(FRAME);
  assert.equal(hint(), "", "and the stylesheet's will-change is back");
  t.mock.timers.tick(10 * SETTLE);
  assert.equal(hint(), "", "once — nothing repeats while the camera is still");
});

test("a stream of zoom steps re-rasters once, after the last of them", (t) => {
  const { deskView, hint } = mount(t);
  deskView.zoomIn();
  t.mock.timers.tick(SETTLE - 50);
  deskView.zoomIn(); // the next wheel step restarts the wait
  t.mock.timers.tick(SETTLE - 50);
  assert.equal(hint(), "", "not mid-stream");
  t.mock.timers.tick(50);
  assert.equal(hint(), "auto");
  t.mock.timers.tick(FRAME); // one tick per frame: a timer set inside a
  t.mock.timers.tick(FRAME); // tick() waits for the next tick() to run
  assert.equal(hint(), "");
});

test("a pan, and a camera set at the same zoom, never re-raster", (t) => {
  const { viewport, deskView, hint } = mount(t);
  const send = (type, x) =>
    viewport.dispatchEvent(
      new window.PointerEvent(type, { bubbles: true, button: 1, pointerId: 3, clientX: x, clientY: 0 }), // prettier-ignore
    );
  send("pointerdown", 0);
  send("pointermove", 40);
  send("pointerup", 40);
  assert.notEqual(deskView.camera.cx, 0, "it did pan");
  deskView.setCamera({ cx: 12, cy: -4, zoom: 1 });
  t.mock.timers.tick(10 * SETTLE);
  assert.equal(hint(), "", "the scale never changed, so neither did the layer");
});

test("dispose cancels a re-raster still waiting to happen", (t) => {
  const { deskView, hint } = mount(t);
  deskView.zoomIn();
  deskView.dispose();
  t.mock.timers.tick(10 * SETTLE);
  assert.equal(hint(), "");
});
