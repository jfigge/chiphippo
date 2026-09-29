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

// designators.js — reference designators (U1, R3, SW2…) for an exported desk.
//
// Chip Hippo never needed them: on the desk a part is where it sits, and the
// document calls it `c7`. Every schematic tool in the world names parts this
// way instead, and an export is read beside a PCB and a parts drawer, so the
// exporters mint them — DERIVED, never stored. The same desk always gets the
// same names (document order within each prefix, which is creation order and
// survives unrelated edits), and the export report quotes the same names the
// exported file does.
//
// A part the user already NAMED like a designator (`U5`, via Properties…) keeps
// that name if nothing else claims it: someone who wrote it on the chip meant
// it. Every other part is numbered around the names already taken.

/** A user-given name that reads as a designator with this prefix. */
const namedAs = (name, prefix) => new RegExp(`^${prefix}\\d{1,4}$`).test(name);

/**
 * The prefix a part is known by on a schematic. Chips are U (a module like the
 * HD44780 panel is a DISPLAY, and is named as one); the bench supply and the
 * clock brick are connectors on a real board, which is what they become.
 *
 * @param {{kind?:string, ref:string}} comp
 * @returns {string}
 */
export function designatorPrefix(comp) {
  const ref = comp.ref;
  if (comp.kind === "chip") return "U";
  if (comp.kind === "psu" || comp.kind === "clock") return "J";
  if (ref === "resistor") return "R";
  if (ref === "rnet9") return "RN";
  if (ref === "led") return "D";
  if (ref.startsWith("sw-")) return "SW";
  if (ref.startsWith("osc-")) return "X";
  if (/^(seg8|bar8|lcd)/.test(ref)) return "DS";
  return "U";
}

/**
 * Every component's designator.
 *
 * @param {Array<{id:string, kind?:string, ref:string, name?:string}>} components
 *   in document order.
 * @returns {Map<string, string>} component id → designator.
 */
export function assignDesignators(components) {
  const out = new Map();
  const taken = new Set();

  // A name the user gave that reads as a designator for THIS kind of part
  // wins, first come first served.
  for (const comp of components) {
    const name = typeof comp.name === "string" ? comp.name.trim() : "";
    if (!namedAs(name, designatorPrefix(comp)) || taken.has(name)) continue;
    out.set(comp.id, name);
    taken.add(name);
  }

  const next = new Map(); // prefix → next number to try
  for (const comp of components) {
    if (out.has(comp.id)) continue;
    const prefix = designatorPrefix(comp);
    let n = next.get(prefix) ?? 1;
    while (taken.has(`${prefix}${n}`)) n += 1;
    const name = `${prefix}${n}`;
    out.set(comp.id, name);
    taken.add(name);
    next.set(prefix, n + 1);
  }
  return out;
}
