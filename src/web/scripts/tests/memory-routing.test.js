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

// The DeskController's memory-chip lifecycle (Feature 190): double-clicking a
// memory chip opens the INSPECTOR (not the pinout); placing a non-volatile ROM
// mints a backing-file GUID + creates its file; a volatile SRAM gets neither;
// removing a ROM deletes its file; and setMemoryProgrammed flags the chip.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");

const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
const chipId = (doc, ref) =>
  doc.toJSON().components.find((c) => c.ref === ref).id;

test("double-clicking a memory chip opens the INSPECTOR, not the pinout", () => {
  resetDom();
  const opened = [];
  const pinouts = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc, {
    onOpenMemory: (id) => opened.push(id),
    onOpenPinout: (ref) => pinouts.push(ref),
    onCreateMemoryFile: () => {},
  });
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const id = chipId(doc, "rom-8k");

  dblclick(surface.querySelector(".part-chip"));
  assert.deepEqual(opened, [id], "the inspector opens for this component");
  assert.deepEqual(pinouts, [], "and the pinout window does NOT open");
});

test("placing a ROM mints a GUID + creates its backing file", () => {
  resetDom();
  const created = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc, {
    onCreateMemoryFile: (guid, byteLength) => created.push([guid, byteLength]),
  });
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const comp = doc.getComponent(chipId(doc, "rom-8k"));

  assert.ok(GUID_RE.test(comp.params.storage.guid), "a GUID is stored");
  assert.deepEqual(
    created,
    [[comp.params.storage.guid, 8192]],
    "its file is created",
  );
  assert.notEqual(
    comp.params.programmed,
    true,
    "a fresh ROM is not yet programmed",
  );
});

test("placing a volatile SRAM gets NO GUID and NO file", () => {
  resetDom();
  const created = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc, {
    onCreateMemoryFile: (...a) => created.push(a),
  });
  controller.addComponentAt("ram-8k", "bb1", "e5");
  const comp = doc.getComponent(chipId(doc, "ram-8k"));

  assert.equal(comp.params.storage, undefined, "SRAM carries no backing file");
  assert.deepEqual(created, [], "and creates no file");
});

test("removing a ROM deletes its backing file", () => {
  resetDom();
  const removed = [];
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc, {
    onCreateMemoryFile: () => {},
    onRemoveMemoryFile: (guid) => removed.push(guid),
  });
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const id = chipId(doc, "rom-8k");
  const guid = doc.getComponent(id).params.storage.guid;

  controller.removeComponent(id);
  assert.deepEqual(removed, [guid], "its file is deleted with it");
});

test("setMemoryProgrammed flags a ROM (and only a memory chip)", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc, { onCreateMemoryFile: () => {} });
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const id = chipId(doc, "rom-8k");

  controller.setMemoryProgrammed(id, true);
  assert.equal(doc.getComponent(id).params.programmed, true);
  controller.setMemoryProgrammed(id, false);
  assert.equal(doc.getComponent(id).params.programmed, undefined, "cleared");
});
