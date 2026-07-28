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

// column-allocator.js — who owns which columns, and which holes are still free.
//
// Two kinds of bookkeeping that a netlist→board compiler cannot get wrong, and
// which nothing else in the tree does for it:
//
//   COLUMNS.  A pin-board column carries two independent nodes — `c<n>L` (rows
//   a–e) and `c<n>U` (rows f–j) — of five holes each. Two parts sharing a
//   column-half are electrically JOINED, and nothing downstream complains:
//   `canPlacePart` checks hole occupancy, not node sharing, and the resulting
//   document simulates perfectly while computing the wrong thing. So the
//   allocator hands out exclusive column runs and that failure becomes
//   unrepresentable rather than merely detectable.
//
//   HOLES.  One lead per hole. A seated pin already occupies one of its node's
//   five holes, so `freeAt` walks the node for an unclaimed one — you never
//   wire TO a pin, you wire to a free hole electrically common with it. This is
//   `scripts/make-demos.mjs`'s `freeAt` primitive, promoted and given an owner.
//
// Deliberately NOT implemented yet: companion stacking, where a part is seated
// in a column-half another part already owns *because the netlist says their
// pins are the same nets* (an rnet9 under a sw-dip8 buys eight pull-downs for
// zero wires). That is a wire-count optimisation, not a correctness property,
// and sharing a column-half is exactly the thing this module exists to prevent
// by accident — so it needs to be requested explicitly, later, with the net
// equality proven first.

import { holesOfNode, nodeOf, parseHole, spec } from "./breadboard.js";
import { partPinHoles } from "./occupancy.js";

const GRID_ROW_RE = /^([a-j])([1-9]\d*)$/;

/** Rows a–e share the lower node of a column; f–j share the upper. */
const halfOfRow = (row) => (row >= "a" && row <= "e" ? "lower" : "upper");

/**
 * @param {Array<{id:string, type:string}>} boards
 */
export function createAllocator(boards) {
  const info = new Map();
  for (const b of boards) {
    const s = spec(b.type);
    info.set(b.id, {
      type: b.type,
      cols: s?.cols ?? 0,
      // Column ownership per half; a DIP straddles the trench and takes both.
      lower: new Map(), // col → ownerId
      upper: new Map(),
    });
  }
  const claimed = new Set();

  const board = (id) => info.get(id) ?? null;

  /** Is `span` columns free from `start` in every requested half? */
  function runIsFree(b, start, span, halves) {
    if (start < 1 || start + span - 1 > b.cols) return false;
    for (let c = start; c < start + span; c++) {
      for (const h of halves) if (b[h].has(c)) return false;
    }
    return true;
  }

  return {
    /** Column count of a board, or 0 for a rail strip. */
    columns: (boardId) => board(boardId)?.cols ?? 0,

    isClaimed: (address) => claimed.has(address),

    /** Take an address outright. Returns false when it is already taken. */
    claim(address) {
      if (claimed.has(address)) return false;
      claimed.add(address);
      return true;
    },

    /**
     * The first run of `span` free columns, left to right.
     *
     * @param {string} boardId
     * @param {number} span
     * @param {"both"|"lower"|"upper"} half
     * @returns {number|null} the starting column, or null when it will not fit
     */
    reserveColumns(boardId, span, half = "both") {
      const b = board(boardId);
      if (!b || span < 1) return null;
      const halves = half === "both" ? ["lower", "upper"] : [half];
      for (let start = 1; start + span - 1 <= b.cols; start++) {
        if (!runIsFree(b, start, span, halves)) continue;
        for (let c = start; c < start + span; c++) {
          for (const h of halves) b[h].set(c, true);
        }
        return start;
      }
      return null;
    },

    /**
     * Claim every hole a seated part's pins land in. Call this after choosing
     * the anchor so later `freeAt` calls route around the part's own pins.
     *
     * @returns {{ok:true, holes:Map<number,string>}|{ok:false, reason:string}}
     */
    seat(boardId, ref, anchor, params) {
      const b = board(boardId);
      if (!b) return { ok: false, reason: `no board ${boardId}` };
      const pins = partPinHoles(ref, anchor, params);
      if (!pins)
        return { ok: false, reason: `${ref} cannot anchor at ${anchor}` };
      const holes = new Map();
      const taken = [];
      for (const { pin, hole } of pins) {
        if (hole == null) continue; // a bent lead resolves elsewhere
        if (!parseHole(b.type, hole)) {
          return {
            ok: false,
            reason: `${ref} pin ${pin} falls off ${boardId}`,
          };
        }
        const address = `${boardId}.${hole}`;
        if (claimed.has(address)) {
          return { ok: false, reason: `${address} is already occupied` };
        }
        taken.push(address);
        holes.set(pin, hole);
      }
      for (const a of taken) claimed.add(a);
      // Own the columns too, so nothing else lands on these nodes.
      for (const hole of holes.values()) {
        const m = GRID_ROW_RE.exec(hole);
        if (m) b[halfOfRow(m[1])].set(Number(m[2]), true);
      }
      return { ok: true, holes };
    },

    /**
     * A free hole address on the same node as `hole` — the only correct way to
     * attach a wire to a seated pin.
     *
     * @returns {string|null} null when the node's five holes are all spoken for
     */
    freeAt(boardId, hole) {
      const b = board(boardId);
      if (!b) return null;
      const node = nodeOf(b.type, hole);
      if (!node) return null;
      for (const h of holesOfNode(b.type, node)) {
        const address = `${boardId}.${h}`;
        if (!claimed.has(address)) {
          claimed.add(address);
          return address;
        }
      }
      return null;
    },

    /**
     * A free hole on a rail strip's `+` or `-` line. A rail is one continuous
     * node of ~50 holes, which is what makes it the right hub for any net with
     * more members than a column-half can carry.
     */
    freeRail(boardId, polarity) {
      const b = board(boardId);
      if (!b) return null;
      for (let k = 1; ; k++) {
        const hole = `${polarity}${k}`;
        if (!parseHole(b.type, hole)) return null; // walked off the end
        const address = `${boardId}.${hole}`;
        if (!claimed.has(address)) {
          claimed.add(address);
          return address;
        }
      }
    },
  };
}
