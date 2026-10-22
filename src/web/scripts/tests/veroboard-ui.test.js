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

// veroboard-ui.test.js — the veroboard on screen: the Cut Track tool driven
// through the real controller (a cut is one undo step, refused while
// running), the desk's drawing (holes as one pattern, copper redrawn in
// place), the parts tray's Veroboard folder and Custom size… card, and the 3D
// underside (copper under the holes, real gaps at the cuts) and the credit
// line under a breadboard.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";
import { holePosition, holes } from "../model/breadboard.js";
import { VERO_PRESETS, presetKey } from "../model/vero-presets.js";
import { veroSpec } from "../model/board-types.js";
import { buildScene } from "../scene3d/scene.js";
import { readPalette } from "../scene3d/palette.js";
import { BOARD_ATTRIBUTION, VERO_THICKNESS } from "../scene3d/board-model.js";
import { BOARD_THICKNESS } from "../scene3d/scene-builder.js";
import {
  PITCH_MIN,
  isUnderneath,
  normalizeCamera,
} from "../scene3d/orbit-camera.js";
import { buildBoardSvg } from "../components/breadboard-view.js";
import { customVeroKey } from "../components/vero-custom-dialog.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PalettePanel } = await import("../components/palette-panel.js");

const PEDAL = "vero-92x54";

function makeDesk(deskDoc, world = { x: 0, y: 0 }) {
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: world.x, y: world.y }),
  };
  const states = [];
  const controller = new DeskController({
    viewport,
    deskView,
    deskDoc,
    onCutStateChange: (s) => states.push(s.armed),
  });
  return { viewport, surface, controller, world, states };
}

const key = (k) =>
  new window.KeyboardEvent("keydown", { key: k, bubbles: true });

/** Click the viewport with the "cursor" over hole `hole` of `board`. */
function clickHole(viewport, world, board, hole) {
  const p = holePosition(board.type, hole);
  world.x = board.x + p.x;
  world.y = board.y + p.y;
  viewport.dispatchEvent(
    new window.PointerEvent("pointermove", { bubbles: true, clientX: 0 }),
  );
  viewport.dispatchEvent(
    new window.MouseEvent("click", { bubbles: true, clientX: 0, clientY: 0 }),
  );
}

// ── The Cut Track tool ──────────────────────────────────────────────────────

test("Cut Track: K arms it, a click cuts, a second click restores, Escape puts it away", () => {
  resetDom();
  const doc = new DeskDoc();
  const world = { x: 0, y: 0 };
  const { viewport, controller, states } = makeDesk(doc, world);
  const [board] = controller.addKitAt(PEDAL, 0, 0);

  assert.equal(controller.handleKeyDown(key("k")), true);
  assert.equal(controller.cutToolArmed, true);
  assert.deepEqual(states, [true]);
  assert.ok(viewport.classList.contains("desk-viewport--cutting"));

  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  clickHole(viewport, world, board, "C10");
  assert.deepEqual(doc.getBoard(board.id).cuts, ["C10"]);
  // The copper on the desk is redrawn in place — the board keeps its view —
  // with strip C now two runs, and no mark left on the board.
  const svg = viewport.querySelector(`[data-board-id="${board.id}"] svg`);
  const strips = () => svg.querySelectorAll(".vero-strip").length;
  assert.equal(strips(), 37, "36 strips, one of them in two");
  assert.equal(
    svg.querySelectorAll("circle").length,
    1,
    "only the pattern's hole",
  );
  clickHole(viewport, world, board, "C10");
  assert.equal("cuts" in doc.getBoard(board.id), false, "restored");
  assert.equal(strips(), 36);
  assert.equal(changes, 2, "each click is one edit");

  assert.equal(controller.handleKeyDown(key("Escape")), true);
  assert.equal(controller.cutToolArmed, false);
  assert.ok(!viewport.classList.contains("desk-viewport--cutting"));
});

test("Cut Track: every cut is an undo step, and redo puts it back", () => {
  resetDom();
  const doc = new DeskDoc();
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  const [board] = controller.addKitAt(PEDAL, 0, 0);
  controller.armCutTool();
  clickHole(viewport, world, board, "A2");
  clickHole(viewport, world, board, "B7");
  assert.deepEqual(doc.getBoard(board.id).cuts, ["A2", "B7"]);
  controller.undo();
  assert.deepEqual(doc.getBoard(board.id).cuts, ["A2"]);
  controller.undo();
  assert.equal("cuts" in doc.getBoard(board.id), false);
  controller.redo();
  assert.deepEqual(doc.getBoard(board.id).cuts, ["A2"]);
  // The view shows what the document holds after a restore, too.
  const svg = viewport.querySelector(`[data-board-id="${board.id}"] svg`);
  assert.equal(svg.querySelectorAll(".vero-strip").length, 37);
});

test("Cut Track: nothing to cut on a breadboard, and Run puts the tool away", () => {
  resetDom();
  const doc = new DeskDoc();
  const world = { x: 0, y: 0 };
  const { viewport, controller } = makeDesk(doc, world);
  const strips = controller.addKitAt("full", 0, 0);
  const pins = strips.find((s) => s.type === "pins-full");
  controller.armCutTool();
  let changes = 0;
  window.addEventListener("chiphippo:doc-changed", () => changes++);
  clickHole(viewport, world, pins, "a5");
  assert.equal(changes, 0, "a breadboard hole is no copper to cut");

  controller.setEditingLocked(true);
  assert.equal(controller.cutToolArmed, false, "Run disarms it");
  controller.armCutTool();
  assert.equal(controller.cutToolArmed, false, "and it will not arm running");
  controller.setEditingLocked(false);
});

test("Cut Track arms only with a veroboard on the desk", () => {
  resetDom();
  const doc = new DeskDoc();
  const { controller } = makeDesk(doc);
  assert.equal(controller.hasVeroboard, false);
  controller.handleKeyDown(key("k"));
  assert.equal(controller.cutToolArmed, false, "no copper to cut");
  controller.addKitAt("full", 0, 0);
  controller.armCutTool();
  assert.equal(controller.cutToolArmed, false, "a breadboard has none either");
  controller.addKitAt(PEDAL, 0, 40);
  assert.equal(controller.hasVeroboard, true);
  controller.armCutTool();
  assert.equal(controller.cutToolArmed, true);
});

test("Cut Track and the wire tool take turns: arming one puts the other away", () => {
  resetDom();
  const { controller } = makeDesk(new DeskDoc());
  controller.addKitAt(PEDAL, 0, 0);
  controller.armCutTool();
  controller.armWireTool();
  assert.equal(controller.cutToolArmed, false);
  assert.equal(controller.wireToolArmed, true);
  controller.armCutTool();
  assert.equal(controller.wireToolArmed, false);
  assert.equal(controller.cutToolArmed, true);
});

// ── The desk's drawing ──────────────────────────────────────────────────────

test("the desk draws a veroboard's holes as ONE patterned rect, whatever its size", () => {
  resetDom();
  const sheet = "vero-304.8x431.8";
  const svg = buildBoardSvg(sheet, { cuts: ["A2", "DP170"] });
  assert.equal(svg.querySelectorAll(".vero-holes").length, 1);
  assert.equal(svg.querySelectorAll(".board-hole").length, 0);
  const pattern = svg.querySelector("pattern");
  assert.ok(pattern.id);
  assert.equal(
    svg.querySelector(".vero-holes").getAttribute("fill"),
    `url(#${pattern.id})`,
  );
  // 120 strips: A cut at hole 2 is two runs, DP cut at its LAST hole one —
  // 121 runs.
  assert.equal(svg.querySelectorAll(".vero-strip").length, 121);
  // Two boards never share a pattern id.
  assert.notEqual(buildBoardSvg(PEDAL).querySelector("pattern").id, pattern.id);
});

// ── The parts tray ──────────────────────────────────────────────────────────

test("the tray's Veroboard folder offers every preset by size, then Custom size…", () => {
  resetDom();
  const host = document.createElement("div");
  document.body.append(host);
  const picked = [];
  new PalettePanel(host, { onPickBoard: (k) => picked.push(k) });
  const header = host.querySelector('[data-section="VEROBOARD"]');
  assert.ok(header, "a Veroboard folder");
  assert.equal(header.getAttribute("aria-expanded"), "false", "starts shut");
  const items = [...host.querySelectorAll(".palette-vero-item[data-kit]")];
  assert.deepEqual(
    items.map((b) => b.dataset.kit),
    VERO_PRESETS.map(presetKey),
  );
  for (const [i, p] of VERO_PRESETS.entries()) {
    assert.match(items[i].textContent, new RegExp(`${p.widthMm} × ${p.heightMm} mm`)); // prettier-ignore
  }
  items[0].click();
  assert.deepEqual(picked, ["vero-92x54"]);
  assert.ok(host.querySelector(".palette-vero-custom"), "Custom size…");
});

test("Custom size…: two millimetre figures become one size key, inside the limits", () => {
  assert.equal(customVeroKey("100", "160"), "vero-100x160");
  assert.equal(customVeroKey(" 38,1 ", "214.6"), "vero-38.1x214.6");
  assert.equal(customVeroKey("50.04", "50"), "vero-50x50", "one decimal");
  assert.equal(customVeroKey("5", "50"), null, "too small");
  assert.equal(customVeroKey("600", "50"), null, "too large");
  assert.equal(customVeroKey("wide", "50"), null);
});

// ── The 3D underside ────────────────────────────────────────────────────────

const palette = readPalette();

/** Every triangle of `mesh` in `color`, as three [x, y, z] corners. */
function trianglesIn(mesh, color) {
  const out = [];
  const near = (i) =>
    Math.abs(mesh.colors[i] - color[0]) < 1e-3 &&
    Math.abs(mesh.colors[i + 1] - color[1]) < 1e-3 &&
    Math.abs(mesh.colors[i + 2] - color[2]) < 1e-3;
  for (let v = 0; v < mesh.count; v += 3) {
    if (!near(v * 3)) continue;
    out.push(
      [0, 1, 2].map((k) => [...mesh.positions.slice((v + k) * 3, (v + k) * 3 + 3)]), // prettier-ignore
    );
  }
  return out;
}

/** Is (x, z) inside the triangle's footprint? */
function covers(tri, x, z) {
  const [a, b, c] = tri.map((p) => [p[0], p[2]]);
  const sign = (p, q, r) =>
    (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = sign([x, z], a, b);
  const d2 = sign([x, z], b, c);
  const d3 = sign([x, z], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function veroScene(type, cuts = []) {
  const doc = new DeskDoc();
  const [board] = doc.addKit(type, 0, 0);
  if (cuts.length) doc.setCuts(board.id, cuts);
  return { scene: buildScene(doc.toJSON(), palette), board: doc.getBoard(board.id) }; // prettier-ignore
}

test("3D: the copper lies under the sheet, under every top-side hole, with a real gap at a cut", () => {
  const { scene, board } = veroScene(PEDAL, ["C10"]);
  const copper = trianglesIn(scene.mesh, palette.veroCopper);
  assert.ok(copper.length > 0);
  for (const tri of copper) {
    for (const p of tri) assert.ok(p[1] < -VERO_THICKNESS + 1e-9, "below it");
  }
  const at = (hole) => {
    const p = holePosition(board.type, hole);
    return [board.x + p.x, board.y + p.y];
  };
  // Copper under every uncut hole of strip C, none under the cut.
  for (const hole of ["C1", "C9", "C11", "C21", "D10"]) {
    assert.ok(
      copper.some((t) => covers(t, ...at(hole))),
      `copper at ${hole}`,
    );
  }
  assert.ok(!copper.some((t) => covers(t, ...at("C10"))), "no copper at C10");
  // The top's holes and the copper's agree, hole for hole.
  const top = trianglesIn(scene.mesh, palette.boardHole).filter((t) =>
    t.every((p) => p[1] > 0),
  );
  for (const hole of holes(PEDAL).slice(0, 40)) {
    assert.ok(
      top.some((t) => covers(t, ...at(hole))),
      `top hole ${hole}`,
    );
  }
});

test("3D: solder under every hole a lead or a wire is in", () => {
  const doc = new DeskDoc();
  const [board] = doc.addKit(PEDAL, 0, 0);
  doc.addComponent({
    kind: "discrete",
    ref: "resistor",
    board: board.id,
    anchor: "B4",
    params: {},
  });
  const scene = buildScene(doc.toJSON(), palette);
  const solder = trianglesIn(scene.mesh, palette.chipLeg).filter((t) =>
    t.every((p) => p[1] < -VERO_THICKNESS),
  );
  const at = (hole) => {
    const p = holePosition(PEDAL, hole);
    return [board.x + p.x, board.y + p.y];
  };
  assert.ok(solder.some((t) => covers(t, ...at("B4"))));
  assert.ok(solder.some((t) => covers(t, ...at("E4"))));
  assert.ok(
    !solder.some((t) => covers(t, ...at("C4"))),
    "none where nothing is",
  );
});

test("3D: a breadboard's pin-board carries the credit underneath; a veroboard and a rail do not", () => {
  const credit = (scene) => scene.labels.filter((l) => l.text === BOARD_ATTRIBUTION); // prettier-ignore
  const doc = new DeskDoc();
  doc.addKit("full", 0, 0); // rail · pin-board · rail
  const labels = credit(buildScene(doc.toJSON(), palette));
  assert.equal(labels.length, 1, "one, under the pin-board");
  const [label] = labels;
  assert.ok(label.center[1] < -BOARD_THICKNESS, "on the underside");
  // Its face looks down: right × up is −y.
  const [r, u] = [label.right, label.up];
  assert.ok(r[2] * u[0] - r[0] * u[2] < 0, "read from below");
  assert.equal(label.color, palette.boardLabel, "the board's own printing");
  assert.deepEqual(credit(veroScene("vero-100x160").scene), [], "not a veroboard"); // prettier-ignore
  assert.equal(BOARD_ATTRIBUTION, "Designed by Jason, coded by Claude");
});

test("3D: a 12 × 17 in sheet builds inside a vertex budget", () => {
  const sheet = "vero-304.8x431.8";
  const t0 = Date.now();
  const { scene } = veroScene(sheet, ["A2", "B9"]);
  const s = veroSpec(sheet);
  // Two quads per hole (top, underside), a quad per run, the slab and legs.
  assert.ok(scene.mesh.count < s.tiePoints * 12 + 5000, `${scene.mesh.count} vertices`); // prettier-ignore
  assert.ok(Date.now() - t0 < 5000, "and builds in reasonable time");
});

test("3D: the camera can go under the desk", () => {
  assert.ok(PITCH_MIN < 0, "below the horizon");
  const below = normalizeCamera({ pitch: -0.9, yaw: 0.3, distance: 50 });
  assert.equal(below.pitch, -0.9, "kept, not clamped back above the desk");
  assert.equal(isUnderneath(below), true);
  assert.equal(isUnderneath(normalizeCamera({ pitch: 0.9 })), false);
});
