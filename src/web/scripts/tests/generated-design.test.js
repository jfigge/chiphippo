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

// The transaction seam (Feature 260): a compiled circuit reaching the desk.
//
// The two properties that matter are the ones a user would notice going wrong:
// a generated circuit is ONE undo step no matter how many boards, parts and
// wires it carries, and a refusal leaves the desk byte-identical rather than
// half-built. Both come from riding pasteDesign rather than a second
// transaction path — which is exactly why this is worth pinning.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { compileNetlist, designClipOf } from "../model/autobuild.js";

const { DeskController } = await import("../components/desk-controller.js");

const SPEC = {
  title: "counter on a bar",
  parts: [
    { id: "CTR", ref: "74LS161" },
    { id: "BAR", ref: "bar8" },
    { id: "CLK", ref: "clock" },
  ],
  nets: [
    {
      name: "RUN",
      members: ["CTR.CLR", "CTR.LOAD", "CTR.ENP", "CTR.ENT", "VCC"],
    },
    { name: "CLOCK", members: ["CLK.out", "CTR.CLK"] },
    { name: "Q0", members: ["CTR.QA", "BAR.1"] },
    { name: "Q1", members: ["CTR.QB", "BAR.2"] },
    { name: "BARGND", members: ["BAR.K", "GND"] },
  ],
};

function makeDesk(deskDoc) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  return new DeskController({ viewport, deskView, deskDoc });
}

/** The compiled circuit, as the clip the desk places. */
function clipFor(spec = SPEC) {
  const out = compileNetlist(spec);
  assert.equal(out.ok, true, out.ok ? "" : JSON.stringify(out.errors));
  const clip = designClipOf(out.document);
  assert.ok(clip, "the document converts to a clip");
  return { out, clip };
}

test("designClipOf carries the whole build — boards, bricks, parts and wiring", () => {
  const { out, clip } = clipFor();
  assert.equal(clip.boards.length, out.document.boards.length, "every board");
  const bricks = out.document.components.filter((c) => c.board == null);
  const parts = out.document.components.filter((c) => c.board != null);
  assert.equal(clip.bricks.length, bricks.length, "PSU and clock come along");
  assert.equal(clip.parts.length, parts.length, "and everything seated");
  // Every wire travels: both ends are on captured owners by construction.
  assert.equal(clip.wires.length, out.document.wires.length, "no wire is cut");
});

test("a generated design lands as exactly ONE undo step", () => {
  resetDom();
  const deskDoc = new DeskDoc(null);
  const controller = makeDesk(deskDoc);
  const { out, clip } = clipFor();

  const before = deskDoc.toJSON();
  assert.equal(before.boards.length, 0, "an empty desk to start");
  assert.equal(controller.canUndo, false);

  const landed = controller.applyGeneratedDesign(clip);
  assert.ok(landed, "it landed");
  assert.equal(
    deskDoc.boards.length,
    out.document.boards.length,
    "all the boards arrived",
  );
  assert.equal(
    deskDoc.components.length,
    out.document.components.length,
    "and all the parts",
  );
  assert.equal(
    deskDoc.wires.length,
    out.document.wires.length,
    "and the wiring",
  );

  // The whole circuit — three boards, five components, seventeen-odd wires —
  // is one step. Not one per entity.
  assert.equal(controller.canUndo, true);
  controller.undo();
  assert.deepEqual(
    deskDoc.toJSON(),
    before,
    "one undo removes the entire circuit",
  );
  assert.equal(controller.canUndo, false, "and there is nothing behind it");
});

test("redo puts the whole circuit back", () => {
  resetDom();
  const deskDoc = new DeskDoc(null);
  const controller = makeDesk(deskDoc);
  const { clip } = clipFor();

  controller.applyGeneratedDesign(clip);
  const placed = deskDoc.toJSON();
  controller.undo();
  controller.redo();
  assert.deepEqual(deskDoc.toJSON(), placed);
});

test("a refused design leaves the desk byte-identical", () => {
  resetDom();
  const deskDoc = new DeskDoc(null);
  const controller = makeDesk(deskDoc);
  const { clip } = clipFor();

  // Fill the desk first, then demand an exact placement that collides with it.
  controller.applyGeneratedDesign(clip);
  const before = deskDoc.toJSON();
  const historyBefore = controller.canUndo;

  const refused = controller.applyGeneratedDesign(clip, {
    at: { dx: 0, dy: 0 },
  });
  assert.equal(refused, null, "the document refused it");
  assert.deepEqual(deskDoc.toJSON(), before, "nothing changed at all");
  assert.equal(controller.canUndo, historyBefore, "and no undo step was cut");
});

test("without an explicit spot it finds one clear of what is already there", () => {
  resetDom();
  const deskDoc = new DeskDoc(null);
  const controller = makeDesk(deskDoc);
  const { out, clip } = clipFor();

  controller.applyGeneratedDesign(clip);
  const first = deskDoc.boards.length;
  // A second copy must not overlap the first — the search moves it clear.
  const second = controller.applyGeneratedDesign(clip);
  assert.ok(second, "a second circuit fits on the desk");
  assert.equal(deskDoc.boards.length, first + out.document.boards.length);
  // Two separate undo steps, one per circuit.
  controller.undo();
  assert.equal(deskDoc.boards.length, first);
});

test("arming a design shows a ghost rather than committing it", () => {
  resetDom();
  const deskDoc = new DeskDoc(null);
  const controller = makeDesk(deskDoc);
  const { clip } = clipFor();

  assert.equal(controller.armGeneratedDesign(clip), true);
  assert.equal(deskDoc.boards.length, 0, "nothing is on the desk yet");
  assert.equal(controller.canUndo, false, "and no undo step was cut");
  assert.ok(
    document.querySelector(".design-ghost"),
    "a ghost is tracking the cursor",
  );

  controller.cancelPlacement();
  assert.equal(deskDoc.boards.length, 0, "Esc throws it away cleanly");
});

test("an empty clip is refused rather than half-handled", () => {
  resetDom();
  const controller = makeDesk(new DeskDoc(null));
  assert.equal(controller.armGeneratedDesign(null), false);
  assert.equal(controller.armGeneratedDesign({ boards: [] }), false);
  assert.equal(controller.applyGeneratedDesign(null), null);
  assert.equal(designClipOf({ boards: [] }), null);
});
