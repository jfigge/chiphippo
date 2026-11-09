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

// default-names.js — the number in the name a Properties card offers as its
// Name field's PLACEHOLDER ("Clock source 1", "Wire 3"): what the subject
// would go by if it were given no name of its own. Most subjects on a desk
// carry no stored name at all (a part, a wire), so nothing is minted here —
// the placeholder is a suggestion the user may type over or leave.
//
// The number is the subject's place among its own kind, counted in id order
// (ids only ever grow, so the oldest is 1). A part is counted among parts of
// the SAME ref, so the second resistor is "Resistor 2" whatever else is on the
// desk. Pure and DOM-free; the caller supplies the words.

/** The trailing number of an id — `c12` → 12, `clk3` → 3 — or null. */
export function idNumber(id) {
  const m = /(\d+)$/.exec(String(id ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * The 1-based place of `item` among `items` that `sameKind` accepts, in id
 * order. An item not in the list counts as the next one (a subject being
 * created). Never less than 1.
 * @template T
 * @param {Iterable<T & {id: string}>} items
 * @param {T & {id: string}} item
 * @param {(other: T) => boolean} [sameKind]
 * @returns {number}
 */
export function defaultOrdinal(items, item, sameKind = () => true) {
  const peers = [...items]
    .filter((other) => other && sameKind(other))
    .map((other) => other.id);
  if (!peers.includes(item.id)) peers.push(item.id);
  peers.sort((a, b) => (idNumber(a) ?? 0) - (idNumber(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)); // prettier-ignore
  return peers.indexOf(item.id) + 1;
}

/** A part's place among the parts of its own ref. */
export const partOrdinal = (components, comp) =>
  defaultOrdinal(components, comp, (other) => other.ref === comp.ref);
