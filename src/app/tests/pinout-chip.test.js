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
// What a CUSTOM chip's pin-assignments window is handed (pinout-chip.js): the
// renderer's `customPinoutOf`, held to a shape on its way through main. The
// window's DIP drawing assumes pins 1…N, every one present once, so anything
// else is refused whole rather than drawn with holes in it.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { CUSTOM_REF_RE, sanitizePinoutChip } = require("../pinout-chip");

const pins = (n) =>
  Array.from({ length: n }, (_v, i) => ({
    n: i + 1,
    name: `P${i + 1}`,
    role: "input",
  }));
const chip = (extra = {}) => ({
  marking: "LATCH8",
  description: "Latch",
  package: "DIP-20",
  pins: pins(20),
  ...extra,
});

test("a well-formed pinout passes through unchanged", () => {
  assert.deepEqual(sanitizePinoutChip(chip()), chip());
  assert.ok(
    sanitizePinoutChip(chip({ package: "DIP-14-600", pins: pins(14) })),
  );
});

test("pins arrive in order, whatever order they were sent in", () => {
  const out = sanitizePinoutChip(chip({ pins: pins(20).reverse() }));
  assert.deepEqual(
    out.pins.map((p) => p.n),
    pins(20).map((p) => p.n),
  );
});

test("a pin list that is not exactly 1…N is refused whole", () => {
  const twice = pins(20);
  twice[3] = { ...twice[3], n: 3 };
  assert.equal(sanitizePinoutChip(chip({ pins: twice })), null);
  const beyond = pins(20);
  beyond[19] = { ...beyond[19], n: 21 };
  assert.equal(sanitizePinoutChip(chip({ pins: beyond })), null);
  assert.equal(sanitizePinoutChip(chip({ pins: pins(3) })), null);
  assert.equal(sanitizePinoutChip(chip({ pins: pins(42) })), null);
  assert.equal(sanitizePinoutChip(chip({ pins: pins(15) })), null);
  assert.equal(sanitizePinoutChip(chip({ pins: "1-20" })), null);
});

test("a package that is not a DIP's name is refused", () => {
  assert.equal(sanitizePinoutChip(chip({ package: "../../etc" })), null);
  assert.equal(sanitizePinoutChip(chip({ package: undefined })), null);
  assert.equal(sanitizePinoutChip(null), null);
});

test("text is cut to length, and an unknown role reads as no connection", () => {
  const out = sanitizePinoutChip(
    chip({
      marking: "X".repeat(40),
      description: "d".repeat(400),
      pins: pins(20).map((p, i) =>
        i === 0 ? { ...p, name: "N".repeat(99), role: "<script>" } : p,
      ),
    }),
  );
  assert.equal(out.marking.length, 16);
  assert.equal(out.description.length, 200);
  assert.equal(out.pins[0].name.length, 48);
  assert.equal(out.pins[0].role, "nc");
});

test("a custom ref is the chip designer's id and nothing looser", () => {
  assert.ok(CUSTOM_REF_RE.test("custom-0a1b2c3d"));
  assert.ok(!CUSTOM_REF_RE.test("custom-0A1B2C3D"));
  assert.ok(!CUSTOM_REF_RE.test("custom-0a1b2c3d/.."));
  assert.ok(!CUSTOM_REF_RE.test("74LS00"));
});
