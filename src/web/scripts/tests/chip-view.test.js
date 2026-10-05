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

// jsdom tests for the DIP chip SVG builder + ChipView shell.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { PX_PER_UNIT } from "../desk/desk-geometry.js";
import { holePosition } from "../model/breadboard.js";

const { buildChipSvg, ChipView, chipBodyBox, chipBox, chipSpan } =
  await import("../components/chip-view.js");

test("buildChipSvg: legs, body, notch, pin-1 dot, and the part number", () => {
  resetDom();
  const svg = buildChipSvg("74LS00");
  // One leg per pin (14), split evenly over the two rows.
  assert.equal(svg.querySelectorAll(".part-chip-leg").length, 14);
  assert.equal(svg.querySelectorAll(".part-chip-body").length, 1);
  assert.equal(svg.querySelectorAll(".part-chip-notch").length, 1);
  assert.equal(svg.querySelectorAll(".part-chip-dot").length, 1);
  const label = svg.querySelector(".part-chip-label");
  assert.equal(label.textContent, "74LS00");
  // No per-pin ids or listeners — the legs are inert decoration.
  for (const leg of svg.querySelectorAll(".part-chip-leg")) {
    assert.equal(leg.id, "");
  }
});

test("buildChipSvg: the wide memory packages (DIP-24…40) render, one leg per pin", () => {
  for (const [ref, pins] of [
    ["28C16", 24],
    ["rom-8k", 28],
    ["AS6C1024", 32],
    ["AM27C1024", 40],
  ]) {
    resetDom();
    const svg = buildChipSvg(ref);
    assert.equal(svg.querySelectorAll(".part-chip-leg").length, pins, ref);
    assert.equal(svg.querySelectorAll(".part-chip-body").length, 1, ref);
    assert.equal(svg.querySelector(".part-chip-label").textContent, ref);
    // The footprint box widens with the pin count (a DIP-40 is far longer).
    assert.ok(chipBox("DIP-40").width > chipBox("DIP-14").width);
  }
});

test("a 600-mil chip is drawn six pitches across, its body over rows e, f and g", () => {
  // The span between the pin rows is the board's own: d → h is six pitches,
  // e → f three — measured, so the drawing can never drift from the holes.
  const y = (hole) => holePosition("pins-full", hole).y;
  assert.ok(Math.abs(y("d5") - y("h5") - chipSpan("DIP-28")) < 1e-9);
  assert.ok(Math.abs(y("e5") - y("f5") - chipSpan("DIP-14")) < 1e-9);
  assert.equal(chipSpan("DIP-28"), 6);
  assert.equal(
    chipSpan("DIP-28", "e5"),
    3,
    "the narrow seat an older desk kept",
  );
  assert.equal(chipSpan("DIP-14"), 3);

  // The footprint box: the upper row's legs at the top, the lower's at the
  // bottom; the narrow seat keeps the old 4.2-pitch box exactly.
  assert.deepEqual(
    [chipBox("DIP-28").minY, chipBox("DIP-28").height],
    [-6.6, 7.2],
  );
  assert.deepEqual(
    [chipBox("DIP-28", "e5").minY, chipBox("DIP-28", "e5").height],
    [-3.6, 4.2],
  );
  assert.deepEqual(chipBox("DIP-14"), chipBox("DIP-14", "e5"));

  // The slab stands over every covered row and stops short of both pin rows.
  const body = chipBodyBox("DIP-28", "d5");
  const top = body.minY;
  const bottom = body.minY + body.height;
  for (const row of ["e", "f", "g"]) {
    const local = y(`${row}5`) - y("d5");
    assert.ok(local > top && local < bottom, `row ${row} under the body`);
  }
  for (const row of ["d", "h"]) {
    const local = y(`${row}5`) - y("d5");
    assert.ok(local < top || local > bottom, `row ${row} clear of the body`);
  }

  resetDom();
  const svg = buildChipSvg("HM62256", {}, "d5");
  assert.equal(svg.querySelectorAll(".part-chip-leg").length, 28);
  const slab = svg.querySelector(".part-chip-body");
  assert.equal(Number(slab.getAttribute("y")), top);
  assert.equal(Number(slab.getAttribute("height")), body.height);
  assert.equal(svg.getAttribute("viewBox").split(" ")[3], "7.2");
  // With no anchor yet (a ghost being placed), it is drawn as it will seat.
  assert.equal(buildChipSvg("HM62256").getAttribute("viewBox"), svg.getAttribute("viewBox")); // prettier-ignore
  assert.equal(
    buildChipSvg("HM62256", {}, "e5").getAttribute("viewBox").split(" ")[3],
    "4.2",
  );
});

test("ChipView redraws at the new width when a narrow-seated 600-mil chip moves", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const view = new ChipView(layer, { id: "c1", ref: "HM62256", anchor: "e5" });
  const board = { type: "pins-full", x: 0, y: 0 };
  view.updatePlacement(board, "e5");
  const height = () =>
    layer.querySelector(".part-chip-svg").getAttribute("viewBox").split(" ")[3];
  assert.equal(height(), "4.2");
  view.updatePlacement(board, "d9");
  assert.equal(height(), "7.2");
  const pos = holePosition("pins-full", "d9");
  assert.equal(
    layer.querySelector(".part-chip").style.top,
    `${(pos.y + chipBox("DIP-28", "d9").minY) * PX_PER_UNIT}px`,
  );
  // A flip redraws at the width it is seated at, not the one it started with.
  view.updateParams({ rot: 180 });
  assert.equal(height(), "7.2");
});

test("buildChipSvg: fault symbols stay OUTSIDE the 180° flip group", () => {
  resetDom();
  const svg = buildChipSvg("74LS00", { rot: 180 });
  const flipped = svg.querySelector(".part-chip-flipped");
  assert.ok(flipped, "expected the flip group");
  // Smoke has to rise in screen space and the warning triangle has to stay
  // upright, so neither symbol may be caught by the rotation.
  assert.equal(flipped.querySelectorAll(".part-burn, .part-warn").length, 0);
  const status = svg.querySelector(".part-chip-status");
  assert.ok(status.querySelector(".part-warn"));
  assert.ok(status.querySelector(".part-burn"));
  // The hint host exists but is empty until a status arrives.
  assert.equal(status.querySelector("title").textContent, "");
});

test("buildChipSvg: rejects unknown refs", () => {
  resetDom();
  assert.throws(() => buildChipSvg("9999"), { code: "INVALID_REF" });
});

test("ChipView seats at its anchor hole in world px and reports gestures", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);

  const seen = [];
  const view = new ChipView(
    layer,
    { id: "c3", ref: "74LS00" },
    { onPointerDown: (id) => seen.push(id) },
  );
  const board = { type: "pins-full", x: 10, y: 20 };
  view.updatePlacement(board, "e5");

  const partEl = layer.querySelector(".part-chip");
  assert.ok(partEl);
  assert.equal(partEl.dataset.componentId, "c3");

  // Element origin = board origin + anchor hole + the footprint box offset.
  const pos = holePosition("pins-full", "e5");
  const box = chipBox("DIP-14");
  assert.equal(
    partEl.style.left,
    `${(board.x + pos.x + box.minX) * PX_PER_UNIT}px`,
  );
  assert.equal(
    partEl.style.top,
    `${(board.y + pos.y + box.minY) * PX_PER_UNIT}px`,
  );

  partEl.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  assert.deepEqual(seen, ["c3"]);

  view.setSelected(true);
  assert.ok(partEl.classList.contains("part--selected"));
  view.remove();
  assert.equal(layer.querySelector(".part-chip"), null);
});

test("ChipView flags an unprogrammed ROM at design time, no sim status needed", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);

  const view = new ChipView(layer, {
    id: "c1",
    ref: "rom-8k",
    params: { storage: { guid: "g1" }, programmed: false },
  });
  const partEl = layer.querySelector(".part-chip");
  assert.ok(partEl.classList.contains("part-chip--unprogrammed"));
  assert.equal(
    partEl.querySelector(".part-chip-status > title").textContent,
    "Not programmed — no image is loaded, so this chip reads random noise.",
  );

  // Programming the chip (a Save/Load in the memory inspector) clears it
  // live, with no sim state involved at all.
  view.updateParams({ storage: { guid: "g1" }, programmed: true });
  assert.ok(!partEl.classList.contains("part-chip--unprogrammed"));
  assert.equal(
    partEl.querySelector(".part-chip-status > title").textContent,
    "",
  );
});

test("ChipView never flags a volatile SRAM or a non-memory chip as unprogrammed", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);

  const sram = new ChipView(layer, {
    id: "c1",
    ref: "AS6C1024",
    params: {},
  });
  assert.ok(
    !sram.element.classList.contains("part-chip--unprogrammed"),
    "SRAM is run-volatile, never file-backed — nothing to program",
  );

  const gate = new ChipView(layer, { id: "c2", ref: "74LS00", params: {} });
  assert.ok(!gate.element.classList.contains("part-chip--unprogrammed"));
});

test("ChipView: a burn fault (reversed/damaged) wins over the unprogrammed hint, not both at once", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);

  const view = new ChipView(layer, {
    id: "c1",
    ref: "rom-8k",
    params: { storage: { guid: "g1" }, programmed: false },
  });
  const partEl = layer.querySelector(".part-chip");
  assert.ok(partEl.classList.contains("part-chip--unprogrammed"));

  view.setStatus("damaged", 12);
  assert.ok(partEl.classList.contains("part-chip--damaged"));
  assert.ok(
    !partEl.classList.contains("part-chip--unprogrammed"),
    "the burn overlay already covers it — don't also show the triangle",
  );
  assert.equal(
    partEl.querySelector(".part-chip-status > title").textContent,
    "Damaged — 12 V is over this part's 5 V, and it let the smoke out. " +
      "Stopping the simulation restores it.",
  );

  // Stopping the sim clears the engine status; the design-time warning
  // reappears since the chip is still, in fact, unprogrammed.
  view.setStatus(null);
  assert.ok(!partEl.classList.contains("part-chip--damaged"));
  assert.ok(partEl.classList.contains("part-chip--unprogrammed"));
});

test("a fault's hover hint states the volts the chip saw and its family's rating", () => {
  resetDom();
  const layer = document.createElement("div");
  document.body.append(layer);
  const title = () =>
    layer.querySelector(".part-chip-status > title").textContent;

  // The hint is the Properties card's own sentence, never a fixed English
  // string: a 74LS part on 3 V says 3 V and its 5 V rating…
  const ls = new ChipView(layer, { id: "c1", ref: "74LS00", params: {} });
  ls.setStatus("underpowered", 3);
  assert.match(title(), /3 V/);
  assert.match(title(), /5 V/);
  ls.remove();

  // …and a CD4000 part burnt on 18+ V states the CMOS range.
  const cmos = new ChipView(layer, { id: "c2", ref: "CD4011B", params: {} });
  cmos.setStatus("damaged", 20);
  assert.match(title(), /20 V/);
  assert.match(title(), /3–18 V/);
  assert.doesNotMatch(title(), /replace/i, "Stop restores a burnt chip");

  // No status, no hint.
  cmos.setStatus(null);
  assert.equal(title(), "");
});
