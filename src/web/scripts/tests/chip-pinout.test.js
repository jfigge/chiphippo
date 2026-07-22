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

const { buildChipPinout, buildPartPinout } =
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
