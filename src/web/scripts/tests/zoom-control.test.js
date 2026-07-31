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

// jsdom tests for the desk zoom cluster (components/zoom-control.js).
//
// The cluster is pure chrome, so what is worth pinning is the one piece of
// plumbing that can silently go missing: Option on a click has to reach the
// callback as `{fine: true}`. The click handlers used to discard the MouseEvent
// entirely, and a dropped modifier looks exactly like a working coarse step.
//
// SHIFT IS PINNED AS *NOT* THE MODIFIER, which is the more valuable half. Shift
// is the conventional fine-adjust and the obvious thing for someone to "restore"
// here, but it cannot work: the cluster lives inside `.desk-viewport`, and
// `DeskController.#onViewportPointerDown` rubber-bands a marquee on any
// shift-press there without checking the target — capturing the pointer on the
// viewport, so the release retargets and NO `click` is ever generated. That
// failure is invisible to a jsdom test (which dispatches `click` directly and
// so never meets the marquee), so the assertion below is the only warning left.
//
// The end-to-end fine step (the readout moving by one point) is proved over a
// real DeskView at the bottom, since that is the behaviour the user asked for
// and neither half alone demonstrates it.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { ZoomControl } = await import("../components/zoom-control.js");
const { DeskView } = await import("../components/desk-view.js");

/** The cluster wired to recording callbacks, as app.js wires it. */
function mount() {
  resetDom();
  const viewport = document.createElement("section");
  viewport.className = "desk-viewport";
  document.body.append(viewport);

  const calls = [];
  const control = new ZoomControl(viewport, {
    onZoomIn: (opts) => calls.push(["in", opts]),
    onZoomOut: (opts) => calls.push(["out", opts]),
    onReset: (opts) => calls.push(["reset", opts]),
  });

  const [outBtn, readout, inBtn] = viewport.querySelectorAll(
    ".desk-zoom-btn, .desk-zoom-readout",
  );
  return { control, calls, outBtn, readout, inBtn };
}

function click(btn, init = {}) {
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, ...init }));
}

test("a plain click reports the coarse step", () => {
  const { calls, outBtn, inBtn } = mount();

  click(inBtn);
  click(outBtn);

  assert.deepEqual(calls, [
    ["in", { fine: false }],
    ["out", { fine: false }],
  ]);
});

test("an Option-click reports the fine step", () => {
  const { calls, outBtn, inBtn } = mount();

  click(inBtn, { altKey: true });
  click(outBtn, { altKey: true });

  assert.deepEqual(calls, [
    ["in", { fine: true }],
    ["out", { fine: true }],
  ]);
});

test("Shift is NOT the fine step — the desk's marquee eats it", () => {
  const { calls, outBtn, inBtn } = mount();

  click(inBtn, { shiftKey: true });
  click(outBtn, { shiftKey: true });

  // Shift must stay the coarse step. In the real app a shift-press on this
  // button never becomes a click at all (the viewport captures the pointer for
  // a marquee), so binding the fine step to Shift makes the buttons look BROKEN
  // rather than coarse — see the file header.
  assert.deepEqual(calls, [
    ["in", { fine: false }],
    ["out", { fine: false }],
  ]);
});

test("the readout still resets, modifier or no modifier", () => {
  const { calls, readout } = mount();

  click(readout);
  click(readout, { altKey: true });

  // Reset takes no options — 100% is 100% however you ask for it.
  assert.deepEqual(calls, [
    ["reset", undefined],
    ["reset", undefined],
  ]);
});

test("Option-clicking + / − moves the readout by exactly one point", () => {
  resetDom();
  const viewport = document.createElement("section");
  viewport.className = "desk-viewport";
  document.body.append(viewport);

  const deskView = new DeskView(viewport, {
    camera: { cx: 0, cy: 0, zoom: 1 },
  });
  const control = new ZoomControl(viewport, {
    onZoomIn: (opts) => deskView.zoomIn(opts),
    onZoomOut: (opts) => deskView.zoomOut(opts),
    onReset: () => deskView.resetZoom(),
  });
  const sync = () => control.setZoom(deskView.camera.zoom);
  sync();

  const [outBtn, readout, inBtn] = viewport.querySelectorAll(
    ".desk-zoom-btn, .desk-zoom-readout",
  );
  assert.equal(readout.textContent, "100%");

  for (const expected of ["101%", "102%", "103%"]) {
    click(inBtn, { altKey: true });
    sync();
    assert.equal(readout.textContent, expected);
  }

  click(outBtn, { altKey: true });
  sync();
  assert.equal(readout.textContent, "102%");

  // ...and the coarse step is untouched: 102% × 1.15 ≈ 117%.
  click(inBtn);
  sync();
  assert.equal(readout.textContent, "117%");
});
