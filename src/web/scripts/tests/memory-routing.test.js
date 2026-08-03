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

// The DeskController's memory-chip lifecycle (Feature 190): a memory chip's
// context menu carries an "Inspect memory…" item that opens the INSPECTOR
// (separate from its "Pin Assignment" item, which opens the pinout); placing
// a non-volatile ROM mints a backing-file GUID + creates its file; a volatile
// SRAM gets neither; removing a ROM deletes its file; and setMemoryProgrammed
// flags the chip.

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
const chipId = (doc, ref) =>
  doc.toJSON().components.find((c) => c.ref === ref).id;

/** Right-click a part and pick a context-menu item by its exact label. */
const pickMenuItem = (elem, label) => {
  elem.dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }),
  );
  const item = [...document.querySelectorAll(".popup-menu-item")].find(
    (b) => b.textContent.trim() === label,
  );
  assert.ok(item, `"${label}" is in the context menu`);
  item.click();
};

test('a memory chip\'s Properties dialog "Inspect memory…" action opens the INSPECTOR, not the pinout', () => {
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

  // The context menu's own items are always Pin Assignment / Properties… /
  // Delete Component — memory actions live inside the Properties dialog.
  pickMenuItem(surface.querySelector(".part-chip"), "Properties…");
  const action = [...document.querySelectorAll(".properties-action")].find(
    (b) => b.textContent.trim() === "Inspect memory…",
  );
  assert.ok(action, '"Inspect memory…" is a Properties dialog action');
  action.click();

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

test("setMemoryProgrammed records which file a ROM was loaded from", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc, { onCreateMemoryFile: () => {} });
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const id = chipId(doc, "rom-8k");
  const guid = doc.getComponent(id).params.storage.guid;
  const storage = () => doc.getComponent(id).params.storage;

  // A load records the file, and never disturbs the guid that names the
  // backing store (the patch merges shallowly, so storage goes over whole).
  controller.setMemoryProgrammed(id, true, { source: "/roms/blink.bin" });
  assert.deepEqual(storage(), { guid, source: "/roms/blink.bin" });

  // A hand-edit in the inspector KEEPS the file and marks it: it is still
  // where the bytes came from, they have just moved on from it.
  controller.setMemoryProgrammed(id, true, { edited: true });
  assert.deepEqual(storage(), {
    guid,
    source: "/roms/blink.bin",
    edited: true,
  });

  // Loading again clears the mark — these ARE that file's bytes once more.
  controller.setMemoryProgrammed(id, true, { source: "/roms/other.bin" });
  assert.deepEqual(storage(), { guid, source: "/roms/other.bin" });

  // Un-programming drops both: the chip holds noise, and noise came from
  // nowhere.
  controller.setMemoryProgrammed(id, false);
  assert.deepEqual(storage(), { guid });
});

test("a program lands the flag and the file label in ONE undo step", () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { controller } = makeDesk(doc, { onCreateMemoryFile: () => {} });
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const id = chipId(doc, "rom-8k");

  let changes = 0;
  const count = () => (changes += 1);
  window.addEventListener("chiphippo:doc-changed", count);
  try {
    controller.setMemoryProgrammed(id, true, { source: "/roms/blink.bin" });
  } finally {
    window.removeEventListener("chiphippo:doc-changed", count);
  }
  assert.equal(changes, 1, "one edit, so ⌘Z takes back both halves together");
});

test('setMemoryProgrammed refreshes the chip\'s own "unprogrammed" warning triangle immediately', () => {
  resetDom();
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const { surface, controller } = makeDesk(doc, {
    onCreateMemoryFile: () => {},
  });
  controller.addComponentAt("rom-8k", "bb1", "e5");
  const id = chipId(doc, "rom-8k");
  const chipEl = surface.querySelector(".part-chip");

  // A fresh placement is unprogrammed — the design-time warning shows with
  // no Run/Stop involved at all.
  assert.ok(chipEl.classList.contains("part-chip--unprogrammed"));

  // Programming it (the in-app programmer, or an inspector Save) must clear
  // the badge on the already-mounted view, not just in the doc.
  controller.setMemoryProgrammed(id, true);
  assert.ok(!chipEl.classList.contains("part-chip--unprogrammed"));

  // Clearing it again (a fresh, never-programmed replacement) restores it.
  controller.setMemoryProgrammed(id, false);
  assert.ok(chipEl.classList.contains("part-chip--unprogrammed"));
});
