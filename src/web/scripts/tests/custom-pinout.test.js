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

// A CUSTOM chip's pin-assignments window. The window is a renderer of its own
// with no catalog of the user's chips, so the app window describes the chip
// (`customPinoutOf`), the window draws it as every DIP is drawn — headed by
// its part number, never its opaque ref — with the designer's button where a
// library chip has its datasheet and example; and CustomPinoutSync tells an
// open window again whenever the chip's pinout (not merely its code) moves.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { customPinoutOf, newCustomChip } from "../model/custom-chip.js";
import { datasheetCrop, partDef, setCustomChips } from "../catalog/index.js";

const { buildCustomPinout, chipDesignerButton, pinoutHeading } =
  await import("../components/chip-pinout.js");
const { CustomPinoutSync } =
  await import("../components/custom-pinout-sync.js");

const chip = () => ({
  ...newCustomChip([]),
  name: "NAND2",
  description: "One NAND gate",
});

test("customPinoutOf is the part number, description, package and pins", () => {
  const c = chip();
  const pinout = customPinoutOf(c);
  assert.equal(pinout.marking, "NAND2");
  assert.equal(pinout.description, "One NAND gate");
  assert.equal(pinout.package, "DIP-14");
  assert.equal(pinout.pins.length, 14);
  assert.deepEqual(Object.keys(pinout.pins[0]).sort(), ["n", "name", "role"]);
  const named = pinout.pins.filter((p) => p.role !== "nc").map((p) => p.name);
  assert.deepEqual(named.sort(), ["A", "B", "GND", "VCC", "Y"]);
});

test("a custom chip has no datasheet crop to look for", () => {
  const c = chip();
  setCustomChips([c]);
  assert.equal(datasheetCrop(partDef(c.id)), null);
  assert.equal(datasheetCrop(partDef("74LS00")), "74LS00");
  setCustomChips([]);
});

test("the window draws it as a DIP, headed by its part number", () => {
  resetDom();
  const c = chip();
  const drawn = buildCustomPinout(c.id, customPinoutOf(c));
  assert.equal(
    drawn.querySelector(".popup-title").textContent,
    "NAND2 · One NAND gate",
  );
  assert.ok(!drawn.textContent.includes(c.id), "never the opaque ref");
  assert.equal(drawn.querySelectorAll(".chip-pinout-pin").length, 14);
  assert.equal(drawn.querySelector(".chip-pinout-datasheet"), null);
  // No description: the part number alone.
  const bare = buildCustomPinout(c.id, { ...customPinoutOf(c), description: "" }); // prettier-ignore
  assert.equal(bare.querySelector(".popup-title").textContent, "NAND2");
  assert.equal(buildCustomPinout(c.id, null), null);
  // A library chip's heading is as it always was.
  assert.equal(pinoutHeading(partDef("74LS00")), "74LS00 · Quad 2-input NAND");
});

test("the designer button is a header button that reports a click", () => {
  resetDom();
  let clicks = 0;
  const btn = chipDesignerButton(() => (clicks += 1));
  assert.equal(btn.className, "pinout-header-btn");
  assert.equal(btn.getAttribute("aria-label"), "Open in Chip Designer");
  btn.click();
  assert.equal(clicks, 1);
});

test("CustomPinoutSync sends only the chips whose pinout moved", () => {
  resetDom();
  const sent = [];
  const bridge = { pinout: { updateChips: (list) => sent.push(list) } };
  const a = chip();
  const b = { ...newCustomChip([a]), name: "OTHER" };
  const sync = new CustomPinoutSync({ bridge, chips: [a, b] });

  // The code changes no pin: nothing to tell any window.
  assert.deepEqual(sync.update([{ ...a, code: "// x\n" }, b]), []);
  // A rename does, for that chip alone.
  const renamed = { ...a, name: "NAND3" };
  const changes = sync.update([renamed, b]);
  assert.deepEqual(
    changes.map((c) => c.ref),
    [a.id],
  );
  assert.equal(changes[0].chip.marking, "NAND3");
  // A chip that has gone is sent as null — main closes its window.
  assert.deepEqual(sync.update([renamed]), [{ ref: b.id, chip: null }]);
  // The event the workspace announces drives it.
  window.dispatchEvent(
    new window.CustomEvent("chiphippo:custom-chips-changed", {
      detail: { chips: [{ ...renamed, description: "new words" }] },
    }),
  );
  assert.equal(sent.at(-1)[0].chip.description, "new words");
});
