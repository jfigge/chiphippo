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

// jsdom tests for the desk padlock (components/desk-lock.js) and the wheel lock
// it drives (DeskView.setWheelLocked).
//
// The two are tested TOGETHER, over a real DeskView, because the contract is not
// "the button toggles a flag" — it is that a mouse wheel stops moving the desk,
// and that every deliberate way of moving it still does.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { DeskLock } = await import("../components/desk-lock.js");
const { DeskView } = await import("../components/desk-view.js");

/** A desk with its padlock, wired the way app.js wires them. */
function mount() {
  const viewport = document.createElement("section");
  viewport.className = "desk-viewport";
  document.body.append(viewport);
  const deskView = new DeskView(viewport, {
    camera: { cx: 0, cy: 0, zoom: 1 },
  });
  const lock = new DeskLock(viewport, {
    onChange: (locked) => deskView.setWheelLocked(locked),
  });
  return { viewport, deskView, lock, button: viewport.querySelector(".desk-lock") }; // prettier-ignore
}

/** A wheel event over the desk; returns whether anything called preventDefault. */
function wheel(viewport, init = {}) {
  const e = new window.WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaX: 0,
    deltaY: 120,
    clientX: 100,
    clientY: 100,
    ...init,
  });
  viewport.dispatchEvent(e);
  return e.defaultPrevented;
}

const click = (node) =>
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

test("the padlock starts OPEN, and the wheel pans the desk", () => {
  resetDom();
  const { viewport, deskView, lock, button } = mount();

  assert.equal(lock.locked, false, "open at launch, every launch");
  assert.equal(button.getAttribute("aria-pressed"), "false");

  const before = deskView.camera;
  assert.ok(wheel(viewport), "the desk always claims the wheel event");
  assert.notDeepEqual(deskView.camera, before, "an unlocked desk pans");
});

test("shut, the wheel no longer moves the desk — panned or zoomed", () => {
  resetDom();
  const { viewport, deskView, lock, button } = mount();
  click(button);
  assert.equal(lock.locked, true);

  const parked = deskView.camera;
  assert.ok(wheel(viewport), "still claimed, so it cannot fall through");
  assert.deepEqual(deskView.camera, parked, "a locked desk does not drift");

  // ctrl+wheel is the pinch/zoom stream — locked out too, and still claimed, or
  // it would reach the browser as page zoom.
  assert.ok(wheel(viewport, { ctrlKey: true, deltaY: -300 }));
  assert.deepEqual(deskView.camera, parked, "nor does it zoom");
});

test("clicking again opens it, and the wheel works as before", () => {
  resetDom();
  const { viewport, deskView, lock, button } = mount();
  click(button);
  click(button);
  assert.equal(lock.locked, false);
  assert.equal(button.getAttribute("aria-pressed"), "false");

  const before = deskView.camera;
  wheel(viewport);
  assert.notDeepEqual(deskView.camera, before, "panning is back");
});

test("a locked desk still moves every way the user ASKS it to", () => {
  resetDom();
  const { deskView, button } = mount();
  click(button);

  // The lock is on ONE INPUT, not on the camera: the zoom cluster, the keyboard
  // and Fit all drive these, and a desk that ignored them would be a bug, not a
  // stricter lock.
  const zoomed = deskView.camera.zoom;
  deskView.zoomIn();
  assert.notEqual(deskView.camera.zoom, zoomed, "the zoom cluster still works");

  const at = deskView.camera;
  deskView.setCamera({ cx: 40, cy: 12, zoom: 1 });
  assert.notDeepEqual(deskView.camera, at, "and so does a commanded camera");
});

test("the icon changes SHAPE with the state, not just its tint", () => {
  resetDom();
  const { button, lock } = mount();
  const open = button.innerHTML;
  assert.ok(open.includes("<svg"), "an inline icon, not a glyph");

  lock.setLocked(true);
  assert.notEqual(button.innerHTML, open, "a shut shackle is a different path");
  assert.ok(button.classList.contains("desk-lock--locked"));
  assert.equal(button.getAttribute("aria-pressed"), "true");

  // setLocked is the MIRROR — it must not report back, or app.js's own callback
  // would loop through it.
  let reports = 0;
  const other = new DeskLock(document.body, { onChange: () => reports++ });
  other.setLocked(true);
  assert.equal(reports, 0);
});

test("the label says what a CLICK would do, and follows the state", () => {
  resetDom();
  const { button, lock } = mount();
  assert.match(button.title, /^Lock the desk/);
  assert.equal(button.getAttribute("aria-label"), button.title);

  lock.setLocked(true);
  assert.match(button.title, /^Unlock the desk/);
  assert.equal(button.getAttribute("aria-label"), button.title);
});

test("the label names its accelerator, on the platform's own glyph", () => {
  resetDom();
  const viewport = document.createElement("section");
  document.body.append(viewport);
  const lock = new DeskLock(viewport, { mod: "Ctrl" });
  const button = viewport.querySelector(".desk-lock");
  assert.match(button.title, /\(Ctrl\+L\)$/);
  lock.setLocked(true);
  assert.match(button.title, /\(Ctrl\+L\)$/, "in both states");
});

test("toggle() is the keyboard's path and the click's — one, and it reports", () => {
  resetDom();
  const { viewport, deskView, lock, button } = mount();
  const seen = [];
  const watched = new DeskLock(document.body, {
    onChange: (v) => seen.push(v),
  });

  // What Cmd/Ctrl+L calls. It must do everything a click does, or the key and
  // the button would drift apart — the icon saying one thing, the wheel another.
  assert.equal(lock.toggle(), true, "returns the new state");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  const parked = deskView.camera;
  wheel(viewport);
  assert.deepEqual(deskView.camera, parked, "the wheel really is locked out");

  lock.toggle();
  assert.equal(button.getAttribute("aria-pressed"), "false");
  wheel(viewport);
  assert.notDeepEqual(deskView.camera, parked, "and let back in");

  watched.toggle();
  watched.toggle();
  assert.deepEqual(seen, [true, false], "every toggle reports, in order");
});
