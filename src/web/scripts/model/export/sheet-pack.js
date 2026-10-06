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

// sheet-pack.js — where each part goes on an exported sheet.
//
// The Schematic view already decided the ARRANGEMENT (schematic-layout.js:
// chips in signal-flow columns, switches to the left, lamps to the right, plus
// whatever the user nudged), and an export should read like it. Its absolute
// positions cannot be reused, though: every target draws a part at its own
// size — a KiCad symbol lists every pin where the view collapses a bus to one
// stub, and hangs a net label off each one — so copying coordinates overlaps
// neighbours. So this keeps the ORDER and re-spaces it: parts are clustered
// into the view's columns by x, each column stacked by y, and columns and rows
// laid out edge to edge by each part's REAL extent in the target's units.
// Nothing can overlap by construction, and the sheet still reads left to right
// the way the view does.

import { buildNetlist } from "../../sim/netlist.js";
import { layout } from "../schematic-layout.js";

/** Parts whose view x differs by less than this share a column (pitch units). */
const COLUMN_CLUSTER = 3;

/**
 * The Schematic view's arrangement of a document: component id → its view
 * position (pitch units). Uses the user's `schematicPos` nudges, exactly as the
 * view does.
 *
 * @param {object} doc - a plain desk document.
 * @returns {Map<string, {x:number, y:number}>}
 */
export function viewPositions(doc) {
  const hints = {};
  for (const comp of doc.components ?? []) {
    const pos = comp.schematicPos;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      hints[comp.id] = pos;
    }
  }
  // The view draws from the WIRING netlist (every switch an open contact —
  // app.js's wiringNetlistCache), so its arrangement is the one the user has
  // been looking at, whatever a switch happens to be set to.
  const netlist = buildNetlist(doc, new Map(), { bridges: false });
  const { nodes } = layout(doc, netlist, hints);
  return new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
}

/**
 * Pack parts into columns.
 *
 * @param {string[]} ids - the parts to place, in document order.
 * @param {Map<string,{x:number,y:number}>} view - their view positions; a part
 *   missing from it goes to the end of the last column.
 * @param {(id:string) => {w:number, h:number}} sizeOf - each part's full
 *   extent in target units (symbol, pins, stubs and labels).
 * @param {{colGap:number, rowGap:number, snap?:number}} spacing
 * @returns {Map<string,{x:number,y:number}>} each part's extent's TOP-LEFT,
 *   origin (0,0), snapped to `snap`.
 */
export function packColumns(ids, view, sizeOf, spacing) {
  const snap = spacing.snap ?? 1;
  const up = (v) => Math.ceil(v / snap - 1e-9) * snap;

  const placed = ids
    .map((id, order) => ({ id, order, at: view.get(id) }))
    .sort((a, b) => {
      if (!a.at || !b.at) return a.at ? -1 : b.at ? 1 : a.order - b.order;
      return a.at.x - b.at.x || a.at.y - b.at.y || a.order - b.order;
    });

  const columns = [];
  for (const item of placed) {
    const last = columns[columns.length - 1];
    if (
      last &&
      (!item.at ||
        last.x0 == null ||
        Math.abs(item.at.x - last.x0) < COLUMN_CLUSTER)
    ) {
      last.items.push(item);
    } else {
      columns.push({ x0: item.at?.x ?? null, items: [item] });
    }
  }

  const out = new Map();
  let x = 0;
  for (const column of columns) {
    column.items.sort(
      (a, b) =>
        (a.at?.y ?? Infinity) - (b.at?.y ?? Infinity) || a.order - b.order,
    );
    let y = 0;
    let width = 0;
    for (const item of column.items) {
      const { w, h } = sizeOf(item.id);
      out.set(item.id, { x, y });
      y = up(y + h + spacing.rowGap);
      width = Math.max(width, w);
    }
    x = up(x + width + spacing.colGap);
  }
  return out;
}
