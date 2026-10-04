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

/**
 * Our chip → the Digital library file that models it.
 *
 * Digital's library has no 4000-series folder, but six CD4000 parts have a
 * PIN-FOR-PIN twin in it: the 74HC4002/4017/4075/7266 (the HC "40xx" parts
 * were made as drop-ins for the CMOS originals) and the hex inverters, whose
 * pinout the CD4069UB/CD40106B share with the 7404/7414. Pin tables are held
 * to the library like every other mapping, and the CLI test runs each bench
 * against our engine — which is what proves the FUNCTION matches, since a pin
 * table only says which pins are inputs. The other 33 have no twin there
 * (DIGITAL_UNSUPPORTED).
 */
export const DIGITAL_FILES = Object.freeze({
  ...Object.fromEntries(
    (
      "00 01 02 03 04 05 08 10 11 14 20 27 30 32 47 74 76 83 85 86 90 107 " +
      "112 125 138 139 148 151 153 157 161 164 165 173 174 175 181 193 244 " +
      "245 257 273 283 573 595"
    )
      .split(" ")
      .map((n) => [`74LS${n}`, `74${n}.dig`]),
  ),
  CD4002B: "744002.dig",
  CD4017B: "744017.dig",
  CD4069UB: "7404.dig",
  CD4075B: "744075.dig",
  CD4077B: "747266.dig",
  CD40106B: "7414.dig",
});

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
 * processors and their peripherals, the character LCDs, the timers and the
 * capacitors.
 */
export const DIGITAL_UNSUPPORTED = Object.freeze({
  "74LS73": "noDigitalModel",
  "74LS75": "noDigitalModel",
  "74LS169": "noDigitalModel",
  "74LS240": "noDigitalModel",
  "74LS259": "noDigitalModel",
  "74LS279": "noDigitalModel",
  "74LS533": "noDigitalModel",
  // The CD4000 parts with no pin-for-pin twin in Digital's library (v0.31
  // has no 4000-series folder; the six that do are in DIGITAL_FILES, and no
  // MSI part — the 4094, 4511, 4029, 4510 — is among them). The 4000
  // series' pinouts are not the 74xx ones, so a 74xx file of the same
  // FUNCTION cannot stand in: its pins would be wired to the wrong nets.
  CD4001B: "noDigitalModel",
  CD4025B: "noDigitalModel",
  CD4078B: "noDigitalModel",
  CD4011B: "noDigitalModel",
  CD4012B: "noDigitalModel",
  CD4023B: "noDigitalModel",
  CD4068B: "noDigitalModel",
  CD4093B: "noDigitalModel",
  CD4081B: "noDigitalModel",
  CD4082B: "noDigitalModel",
  CD4073B: "noDigitalModel",
  CD4071B: "noDigitalModel",
  CD4072B: "noDigitalModel",
  CD4030B: "noDigitalModel",
  CD4070B: "noDigitalModel",
  CD4049UB: "noDigitalModel",
  CD4050B: "noDigitalModel",
  CD4013B: "noDigitalModel",
  CD4040B: "noDigitalModel",
  CD4027B: "noDigitalModel",
  CD4022B: "noDigitalModel",
  CD4020B: "noDigitalModel",
  CD4024B: "noDigitalModel",
  CD4029B: "noDigitalModel",
  CD4510B: "noDigitalModel",
  CD4516B: "noDigitalModel",
  CD4094B: "noDigitalModel",
  CD4028B: "noDigitalModel",
  CD4511B: "noDigitalModel",
  CD4066B: "noDigitalModel",
  CD4051B: "noDigitalModel",
  CD4052B: "noDigitalModel",
  CD4053B: "noDigitalModel",
  // The RC-timed parts: Digital's library has none of them, and Digital is a
  // logic simulator with no capacitor for one to read anyway.
  CD4047B: "noDigitalModel",
  CD4060B: "noDigitalModel",
  CD4098B: "noDigitalModel",
  CD4538B: "noDigitalModel",
  NE555: "noDigitalModel",
  // A capacitor joins no net here either, so leaving it out changes nothing
  // electrically — the report just says it went.
  "cap-ceramic": "capacitor",
  "cap-electrolytic": "capacitor",
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
