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

// stable-uuid.js — a UUID that is a pure function of its inputs.
//
// A KiCad schematic identifies every symbol, pin, wire and label by UUID, and
// its PCB links each footprint back to its symbol by that UUID. So the export
// must NOT mint random ones: re-exporting a desktop into a folder where the
// user has already laid out a board would re-key every symbol, and "Update
// PCB from Schematic" would treat each part as deleted and re-added. Deriving
// the UUID from the desktop and the component id keeps it identical across
// exports, while a part genuinely added to the desk gets a new one — exactly
// the difference the PCB needs to see. It also makes the whole file
// byte-deterministic, which is what lets a test compare two exports.
//
// Four FNV-1a 32-bit hashes with different seeds give 128 bits. This is a
// deterministic IDENTIFIER, not a security property; collisions within one
// schematic are what matter, and at 122 bits they are not a practical concern.

const FNV_PRIME = 0x01000193;
const SEEDS = [0x811c9dc5, 0x2c1b3c6d, 0x297a2d39, 0x6b43a9b5];

function fnv1a(text, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/**
 * @param {...(string|number)} parts - what the id stands for, e.g.
 *   `stableUuid("sym", tabId, compId)`.
 * @returns {string} `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
 */
export function stableUuid(...parts) {
  const text = parts.map(String).join("\u0000");
  const hex = SEEDS.map((seed) =>
    fnv1a(text, seed).toString(16).padStart(8, "0"),
  ).join("");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}
