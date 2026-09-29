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

// digital-parts.js — which catalog parts the Digital export can place, and as
// what (Feature 390).
//
// CHIPS are Digital's own DIL models, named by library FILE (`7400.dig`) —
// Digital resolves the name against its bundled library, as its own examples
// do. Every entry here was checked against that library pin by pin: the power
// pins and every pin's direction agree with our catalog
// (tests/export-digital.test.js holds them to the extracted table in
// digital-lib.js, so a mapping to a chip pinned differently cannot land).
//
// Everything else becomes one of Digital's built-in elements (digital.js
// decides which), except the parts Digital has nothing honest for. Those are
// named in DIGITAL_UNSUPPORTED with the reason the export report gives, and a
// test requires every palette part to be exactly one of the two — so a new
// part cannot slip out of an export unannounced.

/** Our 74xx part → the Digital library file that models it. */
export const DIGITAL_FILES = Object.freeze(
  Object.fromEntries(
    (
      "00 01 02 03 04 05 08 10 11 14 20 27 30 32 47 74 76 83 85 86 90 107 " +
      "112 125 138 139 148 151 153 157 161 164 165 173 174 175 181 193 244 " +
      "245 257 273 283 573 595"
    )
      .split(" ")
      .map((n) => [`74LS${n}`, `74${n}.dig`]),
  ),
);

/**
 * The open-collector parts. Our engine models them as ordinary push-pull
 * gates (their catalog blurbs say so); Digital models them as they are, so
 * the export adds the pull-up a real one needs and says it did.
 */
export const DIGITAL_OPEN_COLLECTOR = Object.freeze([
  "74LS01",
  "74LS03",
  "74LS05",
]);

/** Non-chip parts Digital has an element for (see digital.js). */
export const DIGITAL_ELEMENTS = Object.freeze([
  "psu",
  "clock",
  "osc-full",
  "osc-half",
  "resistor",
  "rnet9",
  "led",
  "bar8",
  "bar8iso",
  "seg8cc",
  "seg8ca",
  "sw-slide",
  "sw-push",
  "sw-toggle",
  "sw-dip1",
  "sw-dip2",
  "sw-dip4",
  "sw-dip8",
]);

/**
 * The parts that do not come across, each with the report's reason code
 * (`export.reason.<code>`): a 74xx part Digital's library lacks, the memory
 * chips (their contents live in files the export does not carry), the
 * processors and their peripherals, and the character LCDs.
 */
export const DIGITAL_UNSUPPORTED = Object.freeze({
  "74LS73": "noDigitalModel",
  "74LS75": "noDigitalModel",
  "74LS169": "noDigitalModel",
  "74LS240": "noDigitalModel",
  "74LS259": "noDigitalModel",
  "74LS279": "noDigitalModel",
  "74LS533": "noDigitalModel",
  "rom-8k": "memory",
  "ram-8k": "memory",
  "28C16": "memory",
  HM62256: "memory",
  AT28C256: "memory",
  AS6C1024: "memory",
  AM27C1024: "memory",
  W65C02: "processor",
  Z80A: "processor",
  W65C21: "processor",
  W65C22: "processor",
  lcd16x2: "lcd",
  lcd20x4: "lcd",
});
