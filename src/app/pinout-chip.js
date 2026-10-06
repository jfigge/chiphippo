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

// pinout-chip.js — what a CUSTOM chip's pin-assignments window is handed to
// draw, held to its shape on the way through main.
//
// A library part's pinout window resolves its ref against the catalog it
// loads itself. A chip the user designed is in no catalog that window has, so
// the app window says what it shows — the part number, the description, the
// package and the pins (the renderer's `customPinoutOf`) — and main carries
// it there. Main knows nothing of what a pin MEANS; it holds every field to a
// type and a length, and the pins to exactly 1…N, which is all the window's
// DIP drawing assumes. Anything else is refused whole (null), never repaired.

"use strict";

/** A custom chip's ref (model/custom-chip.js `CUSTOM_ID_RE`). */
const CUSTOM_REF_RE = /^custom-[0-9a-f]{8}$/;
/** A custom package: footprints.js's `packageName`, 4…40 pins. */
const PACKAGE_RE = /^DIP-\d{1,2}(?:-(?:300|600))?$/;
const PIN_ROLES = new Set(["input", "output", "io", "vcc", "gnd", "nc"]);
const MIN_PINS = 4;
const MAX_PINS = 40;
/** A pin name is a port name (≤ 32) with a bit number and unit prefix. */
const MAX_PIN_NAME = 48;
const MAX_MARKING = 16;
const MAX_DESCRIPTION = 200;

const text = (value, max) =>
  typeof value === "string" ? value.slice(0, max) : "";

/**
 * A custom chip's pinout as the window may be handed it, or null.
 * @param {unknown} raw
 * @returns {{marking: string, description: string, package: string,
 *   pins: Array<{n: number, name: string, role: string}>}|null}
 */
function sanitizePinoutChip(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.package !== "string" || !PACKAGE_RE.test(raw.package)) {
    return null;
  }
  const list = raw.pins;
  if (!Array.isArray(list)) return null;
  const count = list.length;
  if (count < MIN_PINS || count > MAX_PINS || count % 2) return null;
  const byNumber = new Map();
  for (const pin of list) {
    if (!pin || typeof pin !== "object") return null;
    const { n } = pin;
    if (!Number.isInteger(n) || n < 1 || n > count || byNumber.has(n)) {
      return null;
    }
    byNumber.set(n, {
      n,
      name: text(pin.name, MAX_PIN_NAME),
      role: PIN_ROLES.has(pin.role) ? pin.role : "nc",
    });
  }
  return {
    marking: text(raw.marking, MAX_MARKING),
    description: text(raw.description, MAX_DESCRIPTION),
    package: raw.package,
    pins: [...byNumber.values()].sort((a, b) => a.n - b.n),
  };
}

module.exports = { CUSTOM_REF_RE, sanitizePinoutChip };
