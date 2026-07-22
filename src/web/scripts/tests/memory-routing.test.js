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

// The DeskController's memory-chip routing (Features 180 / 190): double-clicking
// a memory chip opens the INSPECTOR (not the pinout), and setMemoryStorage
// binds/clears the file binding in the document (an undoable, stopped-only
// edit).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");

function makeDesk(deskDoc, opts = {}) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  const controller = new DeskController({
    viewport,
    deskView,
    deskDoc,
    ...opts,
  });
  return { surface, controller };
}
const dblclick = (elem) =>
  elem.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));

function memChipId(doc) {
  return doc.toJSON().components.find((c) => c.ref === "rom-8k").id;
}

test("double-clicking a memory chip opens the INSPECTOR, not the pinout", () => {
  resetDom();
  const opened = [];
  const pinouts = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc, {
    onOpenMemory: (id) => opened.push(id),
    onOpenPinout: (ref) => pinouts.push(ref),
  });
  controller.addComponentAt("rom-8k", "bb1", "e5"); // DIP-28 memory
  const id = memChipId(doc);

  dblclick(surface.querySelector(".part-chip"));
  assert.deepEqual(opened, [id], "the inspector opens for this component");
  assert.deepEqual(pinouts, [], "and the pinout window does NOT open");
});

test("setMemoryStorage binds then clears the document binding", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc);
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const id = memChipId(doc);

  controller.setMemoryStorage(id, { path: "/x/rom.bin", mode: "rom" });
  assert.deepEqual(doc.getComponent(id).params.storage, {
    path: "/x/rom.bin",
    mode: "rom",
  });

  controller.setMemoryStorage(id, null);
  assert.equal(
    doc.getComponent(id).params.storage,
    undefined,
    "binding cleared",
  );
});

test("setMemoryStorage is a no-op while editing is locked (running)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc);
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const id = memChipId(doc);

  controller.setEditingLocked(true);
  controller.setMemoryStorage(id, { path: "/x/rom.bin", mode: "rom" });
  assert.equal(
    doc.getComponent(id).params.storage,
    undefined,
    "refused while running",
  );
});
