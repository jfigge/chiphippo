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

// jsdom tests for PopupManager: a second popup opened over an active one is
// QUEUED, and each popup's onClose fires only when THAT popup closes — so a
// dialog queued behind another does not reset its open-guard prematurely.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { PopupManager } = await import("../popup-manager.js");
const { el } = await import("../dom.js");

test("onClose fires only for the popup that closes, never for a queued one", () => {
  resetDom();
  let aClosed = 0;
  let bClosed = 0;
  PopupManager.open({ element: el("div"), onClose: () => aClosed++ });
  PopupManager.open({ element: el("div"), onClose: () => bClosed++ }); // queued

  PopupManager.close(); // closes A, then mounts the queued B
  assert.equal(aClosed, 1, "A's guard reset when A closed");
  assert.equal(
    bClosed,
    0,
    "B's guard did NOT reset while B is now the active popup",
  );

  PopupManager.close(); // closes B
  assert.equal(bClosed, 1, "B's guard resets only when B itself closes");
});
