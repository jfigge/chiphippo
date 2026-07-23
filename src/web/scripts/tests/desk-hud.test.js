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

// jsdom tests for DeskHud: the debug overlay renders the camera + cursor, and —
// because it is always mounted but off by default — does NO layout-forcing
// pointermove work while hidden.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { DeskHud } = await import("../components/desk-hud.js");

/** A stub DeskView counting how often the (layout-forcing) reader is called. */
function stubDeskView() {
  const view = {
    camera: { cx: 0, cy: 0, zoom: 1 },
    reads: 0,
    worldFromEvent() {
      view.reads++;
      return { x: 1, y: 2 };
    },
  };
  return view;
}

test("a hidden HUD does no worldFromEvent read on pointermove", () => {
  resetDom();
  const container = document.createElement("div");
  const deskView = stubDeskView();
  const hud = new DeskHud(container, deskView);
  hud.setVisible(false);

  container.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true }),
  );
  assert.equal(deskView.reads, 0, "no layout-forcing read while hidden");

  hud.setVisible(true);
  container.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true }),
  );
  assert.equal(deskView.reads, 1, "reads again once visible");
});

test("the readout renders the camera and the cursor when visible", () => {
  resetDom();
  const container = document.createElement("div");
  const hud = new DeskHud(container, stubDeskView());
  hud.setVisible(true);
  hud.update({ cx: 4, cy: 6, zoom: 1.5 });
  container.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true }),
  );
  const text = container.querySelector(".desk-hud").textContent;
  assert.match(text, /center 4\.0, 6\.0/);
  assert.match(text, /zoom 150%/);
  assert.match(text, /cursor 1\.0, 2\.0/);
});
