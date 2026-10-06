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

// A placed CUSTOM chip's Properties card. Its Name and Description are not the
// component's own — they ARE the design's part number and description, the two
// fields the chip designer leads with — so an edit on either side shows on the
// other: the card writes through to the design (ProjectWorkspace.putCustomChip
// in the app; a stand-in here that does what it does — re-register the chips
// and announce them), and follows the design while it is open.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { newCustomChip } from "../model/custom-chip.js";
import { partDef, setCustomChips } from "../catalog/index.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

/** The workspace's putCustomChip, as far as the card can tell. */
function designs(initial) {
  let chips = [initial];
  const puts = [];
  const put = (chip) => {
    puts.push(chip);
    chips = chips.map((c) => (c.id === chip.id ? chip : c));
    setCustomChips(chips);
    window.dispatchEvent(
      new window.CustomEvent("chiphippo:custom-chips-changed", {
        detail: { chips },
      }),
    );
    return { ok: true };
  };
  setCustomChips(chips);
  return { put, puts };
}

function mount() {
  resetDom();
  const chip = { ...newCustomChip([]), name: "LATCH8", description: "Latch" };
  const store = designs(chip);
  const doc = new DeskDoc(null);
  doc.addBoard("pins-full", 0, 0);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const controller = new DeskController({
    viewport,
    deskView: {
      surface,
      camera: { cx: 0, cy: 0, zoom: 1 },
      worldFromEvent: () => ({ x: 0, y: 0 }),
    },
    deskDoc: doc,
    putCustomChip: store.put,
  });
  const comp = controller.addComponentAt(chip.id, "bb1", "e5");
  return { chip, store, doc, surface, controller, comp };
}

function openProperties(surface) {
  PopupManager.close();
  surface.querySelector(".part-chip--custom").dispatchEvent(
    new window.MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    }),
  );
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();
  const [name, description] = document.querySelectorAll(
    ".properties-text-input, .properties-textarea",
  );
  return { name, description };
}

const commit = (box, value) => {
  box.value = value;
  box.dispatchEvent(new window.Event("change"));
};

test("the card's Name and Description are the design's part number and description", () => {
  const { surface, doc, comp } = mount();
  const { name, description } = openProperties(surface);
  assert.equal(name.value, "LATCH8");
  assert.equal(description.value, "Latch");
  // Held to what a part number may be, as the designer's box is.
  assert.equal(name.maxLength, 16);
  assert.equal(description.maxLength, 200);
  // Nothing was written onto the component itself.
  assert.equal(doc.getComponent(comp.id).name, undefined);
  PopupManager.close();
  setCustomChips([]);
});

test("an edit on the card is an edit of the design", () => {
  const { surface, doc, comp, chip, store } = mount();
  const { name, description } = openProperties(surface);
  commit(name, "  REG8 ");
  assert.equal(
    store.puts.at(-1).name,
    "REG8",
    "trimmed, as the designer trims",
  );
  assert.equal(partDef(chip.id).marking, "REG8");
  assert.equal(name.value, "REG8", "the box shows what was stored");
  commit(description, "An eight-bit\nregister");
  assert.equal(store.puts.at(-1).description, "An eight-bit register");
  assert.equal(description.value, "An eight-bit register");
  // The component's own name is untouched — the design is what changed.
  assert.equal(doc.getComponent(comp.id).name, undefined);
  PopupManager.close();
  setCustomChips([]);
});

test("a part number the designer would refuse is refused here too", () => {
  const { surface, store } = mount();
  openProperties(surface);
  const box = () => document.querySelector(".properties-text-input");
  commit(box(), "no spaces allowed");
  assert.equal(store.puts.length, 0);
  assert.equal(box().value, "LATCH8", "put back as it is");
  assert.match(
    document.querySelector(".properties-field-error").textContent,
    /Up to 16 letters/,
  );
  PopupManager.close();
  setCustomChips([]);
});

test("a change made in the designer shows on the open card", () => {
  const { surface, chip, store } = mount();
  const { name, description } = openProperties(surface);
  store.put({ ...partDef(chip.id).customChip, name: "U74", description: "Now" }); // prettier-ignore
  assert.equal(name.value, "U74");
  assert.equal(description.value, "Now");
  // A change to something else (the code) leaves text being typed alone.
  description.value = "half-typed";
  store.put({ ...partDef(chip.id).customChip, code: "// edited\n" });
  assert.equal(description.value, "half-typed");
  PopupManager.close();
  // Closed, the card stops following.
  store.put({ ...partDef(chip.id).customChip, name: "GONE" });
  assert.equal(name.value, "U74");
  setCustomChips([]);
});

test("while the circuit runs the design cannot change, so the pair is greyed", () => {
  const { surface, controller } = mount();
  controller.setEditingLocked(true);
  const { name, description } = openProperties(surface);
  assert.equal(name.disabled, true);
  assert.equal(description.disabled, true);
  PopupManager.close();
  setCustomChips([]);
});
