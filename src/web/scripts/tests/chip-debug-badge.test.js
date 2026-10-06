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

// A custom chip the debugger could stop wears a red badge on the desk
// (`part-chip--armed`), driven by the `chiphippo:chip-debug` broadcast. A chip
// REDRAWN in between — its code edited, an undo, a rotate — must come back
// wearing it, from the last broadcast the controller kept.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { newCustomChip } from "../model/custom-chip.js";
import { setCustomChips } from "../catalog/index.js";

const { DeskController } = await import("../components/desk-controller.js");

test("a redrawn custom chip keeps the debugger's badge", () => {
  resetDom();
  const chip = newCustomChip([]);
  setCustomChips([chip]);
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
  });
  const comp = controller.addComponentAt(chip.id, "bb1", "e5");
  const badge = () =>
    surface
      .querySelector(".part-chip--custom")
      .classList.contains("part-chip--armed");

  const debug = (armed) =>
    window.dispatchEvent(
      new window.CustomEvent("chiphippo:chip-debug", {
        detail: { armed: [[comp.id, armed]], pausedChips: [] },
      }),
    );
  // A line breakpoint in its design.
  debug({ lines: true, settled: false });
  assert.ok(badge(), "armed by a line breakpoint");
  controller.refreshCustomChips([chip.id]); // its code edited elsewhere
  assert.ok(badge(), "…and still armed once redrawn");
  // Break on Settled alone arms it too; nothing at all does not.
  debug({ lines: false, settled: true });
  controller.refreshCustomChips([chip.id]);
  assert.ok(badge());
  debug({ lines: false, settled: false });
  controller.refreshCustomChips([chip.id]);
  assert.ok(!badge());
  setCustomChips([]);
});
