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

// jsdom tests for the chip pin-assignments dialog: the DIP layout (left column
// 1…N/2, right column N…N/2+1), the role-colored names, and power pins.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { chipDef, partDef } from "../catalog/index.js";

const { buildChipPinout, buildPartPinout, datasheetButton } =
  await import("../components/chip-pinout.js");

test("a 14-pin chip lays out 7 mirrored rows with numbers and names", () => {
  resetDom();
  const el = buildChipPinout(chipDef("74LS00"));
  assert.match(el.querySelector(".popup-title").textContent, /^74LS00 · /);
  assert.equal(
    el.querySelector(".chip-pinout-sub").textContent,
    "DIP-14 · pin assignments",
  );

  const rows = el.querySelectorAll(".chip-pinout-row");
  assert.equal(rows.length, 7);

  // Row 1: left pin 1 (1A) faces right pin 14 (VCC).
  const left = rows[0].querySelector(".chip-pinout-pin--left");
  const right = rows[0].querySelector(".chip-pinout-pin--right");
  assert.equal(left.querySelector(".chip-pinout-num").textContent, "1");
  assert.equal(left.querySelector(".chip-pinout-label").textContent, "1A");
  assert.equal(right.querySelector(".chip-pinout-num").textContent, "14");
  assert.equal(right.querySelector(".chip-pinout-label").textContent, "VCC");

  // Last row: left pin 7 (GND) faces right pin 8 (3Y).
  const lastLeft = rows[6].querySelector(".chip-pinout-pin--left");
  assert.equal(lastLeft.querySelector(".chip-pinout-num").textContent, "7");
  assert.equal(lastLeft.querySelector(".chip-pinout-label").textContent, "GND");
});

test("a 40-pin memory lays out 20 rows with io/output data pins", () => {
  resetDom();
  const el = buildChipPinout(chipDef("AM27C1024"));
  assert.equal(
    el.querySelector(".chip-pinout-sub").textContent,
    "DIP-40 · pin assignments",
  );
  assert.equal(el.querySelectorAll(".chip-pinout-row").length, 20);
  // The read-only EPROM's data pins carry the output role.
  assert.ok(el.querySelector(".chip-pinout-name--output"));

  // A writable SRAM exposes bidirectional io data pins.
  resetDom();
  const ram = buildChipPinout(chipDef("HM62256"));
  assert.equal(ram.querySelectorAll(".chip-pinout-row").length, 14);
  assert.ok(ram.querySelector(".chip-pinout-name--io"));
});

test("power/ground/output pins carry their role classes", () => {
  resetDom();
  const el = buildChipPinout(chipDef("74LS00"));
  const nameFor = (label) =>
    [...el.querySelectorAll(".chip-pinout-name")].find(
      (n) => n.querySelector(".chip-pinout-label").textContent === label,
    );
  assert.ok(nameFor("VCC").classList.contains("chip-pinout-name--vcc"));
  assert.ok(nameFor("GND").classList.contains("chip-pinout-name--gnd"));
  assert.ok(nameFor("1Y").classList.contains("chip-pinout-name--output"));
  assert.ok(nameFor("1A").classList.contains("chip-pinout-name--input"));
});

test("every pin appears exactly once across the columns", () => {
  resetDom();
  for (const id of ["74LS74", "74LS161", "74LS138"]) {
    const el = buildChipPinout(chipDef(id));
    const nums = [...el.querySelectorAll(".chip-pinout-num")]
      .map((n) => Number(n.textContent))
      .sort((a, b) => a - b);
    const count = chipDef(id).pins.length;
    assert.deepEqual(
      nums,
      Array.from({ length: count }, (_, i) => i + 1),
      `${id} lists every pin once`,
    );
  }
});

// ── buildChipPinout: a flipped (rot 180) DIP layout ─────────────────────────

/** The (num, name) pair drawn on one side of a `.chip-pinout-row`. */
function rowSide(row, side) {
  const cell = row.querySelector(`.chip-pinout-pin--${side}`);
  return {
    num: Number(cell.querySelector(".chip-pinout-num").textContent),
    name: cell.querySelector(".chip-pinout-label").textContent,
  };
}

test("buildChipPinout: rot 180 turns the DIP a half lap — bar8iso's K8/A1 swap corners", () => {
  resetDom();
  const def = partDef("bar8iso");

  // rot 0 (default): pin 1 (A1) top-left, pin 16 (K1) top-right; pin 8 (A8)
  // bottom-left, pin 9 (K8) bottom-right.
  let rows = buildChipPinout(def).querySelectorAll(".chip-pinout-row");
  assert.deepEqual(rowSide(rows[0], "left"), { num: 1, name: "A1" });
  assert.deepEqual(rowSide(rows[0], "right"), { num: 16, name: "K1" });
  assert.deepEqual(rowSide(rows[7], "left"), { num: 8, name: "A8" });
  assert.deepEqual(rowSide(rows[7], "right"), { num: 9, name: "K8" });

  // rot 180 — the SAME physical flip R applies (see desk-doc.js): K8 (pin 9)
  // is now top-left, A1 (pin 1) is now bottom-right, per the feature request.
  rows = buildChipPinout(def, 180).querySelectorAll(".chip-pinout-row");
  assert.deepEqual(rowSide(rows[0], "left"), { num: 9, name: "K8" });
  assert.deepEqual(rowSide(rows[0], "right"), { num: 8, name: "A8" });
  assert.deepEqual(rowSide(rows[7], "left"), { num: 16, name: "K1" });
  assert.deepEqual(rowSide(rows[7], "right"), { num: 1, name: "A1" });
});

test("buildPartPinout: a real chip's dialog ignores rot — its pin-1 marking is fixed", () => {
  resetDom();
  const unflipped = buildPartPinout(chipDef("74LS00"));
  const flipped = buildPartPinout(chipDef("74LS00"), 180);
  const numsOf = (el) =>
    [...el.querySelectorAll(".chip-pinout-num")].map((n) => n.textContent);
  assert.deepEqual(numsOf(flipped), numsOf(unflipped));

  // bar8iso, a package-footprint DISCRETE (kind !== "chip"), does react.
  const barFlipped = buildPartPinout(partDef("bar8iso"), 180);
  const barUnflipped = buildPartPinout(partDef("bar8iso"));
  assert.notDeepEqual(numsOf(barFlipped), numsOf(barUnflipped));
});

// ── buildCanPinout: an oscillator can's corner labels track its rotation ────

test("buildCanPinout: a full-can's (non-square) corner assignment rotates with the part", () => {
  resetDom();
  const def = partDef("osc-full");
  const detailsAt = (rot) =>
    [...buildPartPinout(def, rot).querySelectorAll(".part-pinout-detail")].map(
      (n) => n.textContent,
    );

  // rot 0 — the canonical bottom-left → bottom-right → top-right → top-left
  // winding, pin 1 (NC) anchored at bottom-left.
  assert.deepEqual(detailsAt(0), [
    "bottom-left corner (the anchor, pin 1)",
    "bottom-right corner",
    "top-right corner",
    "top-left corner",
  ]);
  // A non-square can's 90°/270° swap which physical corner every pin sits
  // at (unlike a square half-can, where the same 4 labels merely relabel).
  assert.deepEqual(detailsAt(90), [
    "top-left corner (the anchor, pin 1)",
    "bottom-left corner",
    "bottom-right corner",
    "top-right corner",
  ]);
  // 180° — the rotation an already-placed full-can actually steps through
  // (see desk-doc.js rotateComponent): pin 1 lands where pin 3 sat at rot 0.
  assert.deepEqual(detailsAt(180), [
    "top-right corner (the anchor, pin 1)",
    "top-left corner",
    "bottom-left corner",
    "bottom-right corner",
  ]);
  assert.deepEqual(detailsAt(270), [
    "bottom-right corner (the anchor, pin 1)",
    "top-right corner",
    "top-left corner",
    "bottom-left corner",
  ]);
  // No rot argument defaults to the canonical rot-0 layout.
  assert.deepEqual(
    [...buildPartPinout(def).querySelectorAll(".part-pinout-detail")].map(
      (n) => n.textContent,
    ),
    detailsAt(0),
  );
});

test("buildCanPinout: a square half-can rotates the same way, one quarter-turn per step", () => {
  resetDom();
  const def = partDef("osc-half");
  const detailsAt = (rot) =>
    [...buildPartPinout(def, rot).querySelectorAll(".part-pinout-detail")].map(
      (n) => n.textContent,
    );
  assert.deepEqual(detailsAt(90), [
    "top-left corner (the anchor, pin 1)",
    "bottom-left corner",
    "bottom-right corner",
    "top-right corner",
  ]);
});

// ── buildPartPinout: discretes + desk bricks ────────────────────────────────

test("buildPartPinout routes a chip to the DIP layout", () => {
  resetDom();
  const el = buildPartPinout(partDef("74LS00"));
  assert.ok(el.querySelector(".chip-pinout-dip"), "chip → DIP diagram");
});

test("a chip includes a datasheet figure pointing at its committed crop", () => {
  resetDom();
  const el = buildChipPinout(chipDef("74LS595"));
  const img = el.querySelector(".chip-pinout-datasheet img");
  assert.ok(img, "chip pinout carries a datasheet figure");
  // The <id> is URL-encoded into the relative path make datasheets writes to.
  assert.equal(img.getAttribute("src"), "datasheets/74LS595.png");
});

test("discretes and bricks carry no datasheet figure", () => {
  resetDom();
  for (const id of ["led", "psu", "clock"]) {
    const el = buildPartPinout(partDef(id));
    assert.equal(
      el.querySelector(".chip-pinout-datasheet"),
      null,
      `${id} has no datasheet figure`,
    );
  }
});

test("a discrete (LED) renders a linear pin list with roles + offsets", () => {
  resetDom();
  const el = buildPartPinout(partDef("led"));
  assert.ok(!el.querySelector(".chip-pinout-dip"), "no DIP diagram");
  const lines = el.querySelectorAll(".part-pinout-list .part-pinout-line");
  assert.equal(lines.length, 2);
  const labels = [...el.querySelectorAll(".chip-pinout-label")].map(
    (n) => n.textContent,
  );
  assert.deepEqual(labels, ["A", "K"]); // anode, cathode
  assert.ok(el.querySelector(".chip-pinout-name--anode"), "anode role class");
  assert.ok(el.querySelector(".chip-pinout-name--cathode"), "cathode role");
  // Pin 1 sits at the anchor hole; pin 2 one hole along.
  const details = [...el.querySelectorAll(".part-pinout-detail")].map(
    (n) => n.textContent,
  );
  assert.deepEqual(details, ["anchor hole", "+1 hole"]);
});

test("a desk brick (PSU) renders its terminal map", () => {
  resetDom();
  const el = buildPartPinout(partDef("psu"));
  const lines = el.querySelectorAll(".part-pinout-line");
  assert.equal(lines.length, 2);
  const tags = [...el.querySelectorAll(".chip-pinout-num")].map(
    (n) => n.textContent,
  );
  assert.deepEqual(tags, ["+", "-"]);
  assert.ok(el.querySelector(".chip-pinout-name--vcc"), "+ is power");
  assert.ok(el.querySelector(".chip-pinout-name--gnd"), "− is ground");
});

test("a clock renders out/gnd terminals", () => {
  resetDom();
  const el = buildPartPinout(partDef("clock"));
  const tags = [...el.querySelectorAll(".chip-pinout-num")].map(
    (n) => n.textContent,
  );
  assert.deepEqual(tags, ["out", "gnd"]);
});

// ── datasheetButton: the "open datasheet PDF" header affordance ──────────────

test("datasheetButton builds an accessible book button that fires its callback", () => {
  resetDom();
  let clicks = 0;
  const btn = datasheetButton(() => clicks++);
  assert.equal(btn.tagName, "BUTTON");
  assert.ok(btn.classList.contains("pinout-datasheet-btn"));
  assert.equal(btn.getAttribute("aria-label"), "Open the datasheet PDF");
  assert.ok(btn.querySelector("svg"), "carries the line-drawn document glyph");
  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(clicks, 1, "clicking invokes the open callback");
});
