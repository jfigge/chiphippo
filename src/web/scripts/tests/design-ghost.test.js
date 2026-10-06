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

// The design-paste ghost (⌘V of a marquee-copied board, a generated circuit)
// draws each chip at the width it will LAND at: a 600-mil part saved before
// wide seating sits narrow (rows e/f) and is pasted narrow, so its ghost must
// be the narrow drawing too — not the wide one a fresh placement would take.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc, normalizeDocument } from "../model/desk-doc.js";
import { designClipOf } from "../model/autobuild.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";

const { DeskController } = await import("../components/desk-controller.js");
const { chipBox } = await import("../components/chip-view.js");

function ghostHeightFor(anchor) {
  resetDom();
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
    deskDoc: new DeskDoc(null),
  });
  const doc = normalizeDocument({
    version: 14,
    boards: [{ id: "bb1", type: "pins-full", x: 0, y: 0 }],
    components: [
      { id: "c1", kind: "chip", ref: "HM62256", board: "bb1", anchor, params: {} }, // prettier-ignore
    ],
    wires: [],
  });
  assert.equal(doc.components.length, 1);
  assert.equal(controller.armGeneratedDesign(designClipOf(doc)), true);
  const svg = document.querySelector(".design-ghost .part-ghost svg");
  assert.ok(svg, "the chip is in the ghost");
  return Number(svg.getAttribute("height"));
}

test("a design ghost draws each chip at the width it was copied at", () => {
  const narrow = chipBox("DIP-28", "e5").height * PX_PER_UNIT;
  const wide = chipBox("DIP-28", "d5").height * PX_PER_UNIT;
  assert.notEqual(narrow, wide);
  assert.equal(ghostHeightFor("e5"), narrow, "a narrow seat pastes narrow");
  assert.equal(ghostHeightFor("d5"), wide, "a wide seat pastes wide");
});
