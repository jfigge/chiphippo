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

// demo-machine.mjs — the parts every generated breadboard COMPUTER is built
// from: a doc builder that lays a run of boards and wires holes (one lead per
// hole, the three power-layout rules held by construction), a two-pass 6502/Z80
// assembler just big enough to place a label, and the pin maps of the chips
// those machines are made of. Shared by make-demos.mjs (the 65xx and Ben Eater
// demos in demos/) and demo-computers.mjs (the CPUs' bundled example
// circuits), so the two cannot drift into two builders with two sets of rules.

import { DOC_VERSION } from "../src/web/scripts/model/desk-doc.js";
import {
  partCoverHoles,
  partPinHoles,
  worldOfAddress,
} from "../src/web/scripts/model/occupancy.js";
import {
  nodeOf,
  holesOfNode,
  spec,
} from "../src/web/scripts/model/breadboard.js";

/** The desk's own quantum for a board coordinate (desk-doc.js `boardCoord`, and
    demo-bench.mjs's `q`). A strip's measured height is fractional, so a stack
    that does not round the same way its loader does is a stack that overlaps —
    and `normalizeDocument` DROPS a board overlapping one already loaded. */
const q = (n) => Math.round(n * 100) / 100;

// ── A tiny doc builder: places boards/parts and wires nodes, tracking one lead
//    per hole so wire endpoints never collide (the loader would drop them). ────
export function builder() {
  const boards = [];
  const components = [];
  const wires = [];
  const claimed = new Set(); // every occupied hole/terminal address
  const boardType = new Map();
  let wireSeq = 0;
  let boardSeq = 0;

  const board = (id, type, x, y, group = null) => {
    boards.push({ id, type, x, y, rot: 0, group });
    boardType.set(id, type);
  };
  const brick = (id, kind, ref, x, y, params = {}) =>
    components.push({ id, kind, ref, x, y, params });

  const part = (id, kind, ref, boardId, anchor, params = {}) => {
    components.push({ id, kind, ref, board: boardId, anchor, params });
    for (const { hole } of partPinHoles(ref, anchor, params)) {
      claimed.add(`${boardId}.${hole}`);
    }
    // A 600-mil DIP seated at its real width (anchor row d) stands its body
    // over rows e–g, and those holes are the body's: occupancy.js refuses a
    // lead there, so a wire must never be handed one.
    for (const hole of partCoverHoles(ref, anchor)) {
      claimed.add(`${boardId}.${hole}`);
    }
  };

  /** A free wiring hole on the same node as `boardId`'s pin `hole`. */
  const freeAt = (boardId, hole) => {
    const type = boardType.get(boardId);
    const node = nodeOf(type, hole);
    for (const h of holesOfNode(type, node)) {
      const addr = `${boardId}.${h}`;
      if (!claimed.has(addr)) {
        claimed.add(addr);
        return addr;
      }
    }
    throw new Error(`no free hole on node ${node} of ${boardId}`);
  };

  // Pin → seated hole, per part (for resolving pins to node-holes).
  const holesOfPart = (ref, anchor, params) => {
    const m = new Map();
    for (const { pin, hole } of partPinHoles(ref, anchor, params))
      m.set(pin, hole);
    return m;
  };

  const wire = (from, to, color = "black") => {
    if (claimed.has(from) && !from.includes(".+") && !from.includes(".-")) {
      // a board pin-hole endpoint already used — caller must pass a free hole
    }
    claimed.add(from);
    claimed.add(to);
    wires.push({ id: `w${++wireSeq}`, from, to, color });
  };

  const world = (address) => {
    const pos = worldOfAddress(boards, address);
    if (!pos) throw new Error(`no such hole: ${address}`);
    return pos;
  };

  /**
   * Lay a RUN of breadboards — `rail · pins · rail · pins · rail` — flush, in
   * one group, the rail between two boards SHARED by both. This is the ONLY way
   * to put a board on the desk here (`board` is deliberately not exported), so
   * rule 1 holds by construction rather than by everyone remembering it.
   *
   * The heights are DERIVED (`spec(type).height`), never typed: a rail is 3.50
   * pitch and a pin-board 14.02, so a literal leaves a gap — the strips do not
   * mate, the run comes apart when dragged, and a chip four boards down has
   * nowhere near to reach for power. The run's y quantum is the desk's own
   * (`q`), because `normalizeDocument` drops a board that overlaps its
   * neighbour and `boardRect` is the exact height with no margin.
   *
   * Returns the handle every build wires through: `tie` for a part's power
   * (rule 3), `tap` for a brick's, and `spine` for the rail-to-rail run
   * (rule 2). See CLAUDE.md, "Power layout".
   *
   * `open` leaves the run ending on a PIN-BOARD rather than a rail, for the one
   * case that earns it: a bottom-mounted module (an HD44780 panel) plugs into
   * row a and its body hangs DOWN off the bench, so a rail dovetailed under it
   * is a strip you can neither see nor reach. Rule 1 is about the rails
   * BETWEEN boards and is untouched by this.
   */
  const stack = (count, { x = 0, group = "g1", open = false } = {}) => {
    const pins = [];
    const rails = [];
    let y = 0;
    const strip = (type, into) => {
      const id = `bb${++boardSeq}`;
      board(id, type, x, q(y), group);
      y = q(y + spec(type).height);
      into.push(id);
      return id;
    };
    /** Grow the run downward, the current last rail serving as the new board's
        top one — the shared strip, not a second one stacked against it. */
    const extend = (n, { open: openEnd = false } = {}) => {
      const added = [];
      for (let i = 0; i < n; i++) {
        added.push(strip("pins-full", pins));
        if (!openEnd || i < n - 1) strip("rail-full", rails);
      }
      return added;
    };
    strip("rail-full", rails);
    extend(count, { open });

    /** Which rail a hole faces: rows f–j the strip above, rows a–e the one
        below. The two are one net once `spine` has tied them, so reaching for
        the far one buys nothing and costs a lead over the chip it powers —
        unless the facing side has no rail at all (an `open` run's last board),
        where the other one is not a preference but the only rail there is. */
    const railFor = (boardId, hole) => {
      const i = pins.indexOf(boardId);
      if (i < 0) throw new Error(`${boardId} is not in this run`);
      return "fghij".includes(hole[0])
        ? (rails[i] ?? rails[i + 1])
        : (rails[i + 1] ?? rails[i]);
    };

    /** The free hole of one rail line nearest a world x, claimed. The rails'
        grouped lattice means a column rarely sits exactly over a hole, so the
        caller takes what is nearest. */
    const railNear = (railId, polarity, worldX) => {
      let best = null;
      for (const hole of holesOfNode(boardType.get(railId), polarity) ?? []) {
        const address = `${railId}.${hole}`;
        if (claimed.has(address)) continue;
        const d = Math.abs(world(address).x - worldX);
        if (!best || d < best.d) best = { address, d };
      }
      if (!best) throw new Error(`no free hole on ${railId} rail ${polarity}`);
      claimed.add(best.address);
      return best.address;
    };

    /** RULE 3 — a part's power lead, to the rail on its own side of the trench
        at its own column. The colour is derived from the polarity (a supply
        wire is red and a ground wire black, always), so no call site says it. */
    const tie = (boardId, hole, polarity) => {
      const from = freeAt(boardId, hole);
      const to = railNear(railFor(boardId, hole), polarity, world(from).x);
      wire(from, to, polarity === "+" ? "red" : "black");
      return to;
    };

    /** A desk brick's lead: the rail nearest its y, taken from the RIGHT end —
        the bricks stand off the right of the run, and a rail is one node end to
        end, so hole 1 would run the wire the width of the desk to reach it. */
    const tap = (atY, polarity) => {
      let near = null;
      for (const id of rails) {
        const d = Math.abs(boards.find((b) => b.id === id).y - atY);
        if (!near || d < near.d) near = { id, d };
      }
      const holes = holesOfNode(boardType.get(near.id), polarity) ?? [];
      for (let i = holes.length - 1; i >= 0; i--) {
        const address = `${near.id}.${holes[i]}`;
        if (!claimed.has(address)) {
          claimed.add(address);
          return address;
        }
      }
      throw new Error(`no free hole on ${near.id} rail ${polarity}`);
    };

    /**
     * RULE 2 — tie the run's rails into one supply, as a vertical spine down
     * the END of the boards. Called ONCE, after the last board is laid, which
     * is what lets a build hand its run on to be `extend`ed first.
     *
     * TWO ADJACENT COLUMNS, not one: a middle rail is the bottom end of the
     * segment above it AND the top end of the segment below, so a single column
     * would put two leads in one hole and the loader would drop the second. The
     * spine therefore steps one column per board, leaning the same way all the
     * way down — which is what a real bench looks like, not a compromise.
     *
     * Searched from the RIGHT, so it lands on the end the boards are empty at
     * (parts seat from column 1) and beside the PSU rather than across the desk
     * from it; a blocked pair steps one column left rather than starting over.
     *
     * The two polarities take DIFFERENT columns, `−` to the left of `+`. A rail
     * strip's two lines are one pitch apart, so run down the same columns the
     * supply and the ground wire lie a single pitch from each other over their
     * whole 14-unit length and read as ONE line — which is the one thing a
     * power spine must not look like.
     */
    const spine = () => {
      /** The rightmost column pair, at or left of `from`, free on EVERY rail. */
      const pairAt = (from, polarity) => {
        for (let k = from; k >= 2; k--) {
          const free = rails.every(
            (id) =>
              !claimed.has(`${id}.${polarity}${k}`) &&
              !claimed.has(`${id}.${polarity}${k - 1}`),
          );
          if (free) return k;
        }
        throw new Error(`no free column pair for the ${polarity} spine`);
      };
      let from = spec(boardType.get(rails[0])).railHoles;
      for (const polarity of ["+", "-"]) {
        const col = pairAt(from, polarity);
        for (let i = 0; i + 1 < rails.length; i++) {
          wire(
            `${rails[i]}.${polarity}${col}`,
            `${rails[i + 1]}.${polarity}${col - 1}`,
            polarity === "+" ? "red" : "black",
          );
        }
        from = col - 2; // the next polarity runs clear to the left of this one
      }
    };

    return {
      boards: pins,
      rails,
      right: x + spec("pins-full").width,
      extend,
      railFor,
      tie,
      tap,
      spine,
    };
  };

  return {
    stack,
    brick,
    part,
    freeAt,
    holesOfPart,
    wire,
    claimed,
    doc: () => ({
      version: DOC_VERSION,
      boards,
      components,
      wires,
      buses: [],
      netNames: [],
      annotations: [],
      nextBoardId: boards.length + 1,
      nextGroupId: 2, // the run is `g1`
      nextComponentId: components.length + 1,
      nextPsuId: 2,
      nextClockId: 2,
      nextWireId: wireSeq + 1,
      nextBusId: 1,
      nextAnnotationId: 1,
    }),
  };
}

// ── A two-pass assembler, just big enough to place a label ───────────────────
// The blink and LCD programs below are straight-line and hand-assembled, which
// is fine for a dozen bytes. Anything with subroutines and loops is not: a jump
// target is a byte you cannot check by reading, and one wrong branch offset is
// a ROM that runs somewhere else. So a program is written as a flat list of
// opcode bytes with `at()`/`rel()` standing in for an address, and the labels
// are resolved here rather than counted by hand.
//
//   asm(0x8000, [0x20, at("lcd_cmd"), ..., "lcd_cmd", 0x8d, 0x00, 0x60, 0x60])
//
// A bare string DEFINES a label at the current address; `at` emits its 16-bit
// little-endian address, `rel` the signed 8-bit displacement a branch takes.
export const at = (label) => ({ abs: label });
export const rel = (label) => ({ rel: label });

export function asm(org, items) {
  const labels = new Map();
  const width = (it) => (typeof it === "number" ? 1 : it.abs != null ? 2 : 1);
  let pc = org;
  for (const it of items) {
    if (typeof it === "string") {
      if (labels.has(it)) throw new Error(`asm: duplicate label ${it}`);
      labels.set(it, pc);
    } else pc += width(it);
  }
  const addr = (name) => {
    const a = labels.get(name);
    if (a == null) throw new Error(`asm: undefined label ${name}`);
    return a;
  };
  const out = [];
  pc = org;
  for (const it of items) {
    if (typeof it === "string") continue;
    if (typeof it === "number") {
      out.push(it & 0xff);
    } else if (it.abs != null) {
      const a = addr(it.abs);
      out.push(a & 0xff, (a >> 8) & 0xff);
    } else {
      // A branch is relative to the byte AFTER its own operand.
      const delta = addr(it.rel) - (pc + 1);
      if (delta < -128 || delta > 127) {
        throw new Error(`asm: branch to ${it.rel} out of range (${delta})`);
      }
      out.push(delta & 0xff);
    }
    pc += width(it);
  }
  return out;
}

/** A NUL-terminated run of bytes for a string constant. */
export const asciiz = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);

// CPU pins (see catalog/chips-io.js "W65C02").
export const CPU = {
  A: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25], // A0…A15
  D: [33, 32, 31, 30, 29, 28, 27, 26], // D0…D7
  RWB: 34,
  PHI2: 37,
  RESB: 40,
  BE: 36,
  RDY: 2,
  IRQB: 4,
  NMIB: 6,
  SOB: 38,
  VCC: 8,
  GND: 21,
};
// ROM pins (rom-8k): A0…A12, Q0…Q7, CE, OE, VCC, GND.
export const ROM = {
  A: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25],
  Q: [9, 10, 11, 12, 13, 17, 18, 19],
  CE: 26,
  OE: 27,
  VCC: 28,
  GND: 14,
};
// VIA pins (W65C22).
export const VIA = {
  PA: [2, 3, 4, 5, 6, 7, 8, 9], // PA0…PA7
  PB: [10, 11, 12, 13, 14, 15, 16, 17], // PB0…PB7
  RS: [38, 37, 36, 35], // RS0…RS3 ← A0…A3
  D: [33, 32, 31, 30, 29, 28, 27, 26], // D0…D7
  RWB: 22,
  PHI2: 25,
  CS1: 24,
  CS2B: 23,
  RESB: 34,
  IRQB: 21,
  VDD: 20,
  VSS: 1,
};
// 74LS04 hex inverter — inverter #1: 1A=1 (in) → 1Y=2 (out); GND=7, VCC=14.
export const INV = { A: 1, Y: 2, GND: 7, VCC: 14 };
// HD44780 character-LCD module — the same 16 pins whatever the panel size.
export const LCD = {
  VSS: 1,
  VDD: 2,
  V0: 3, // contrast — a pot on a real board, tied to GND here (no analog sim)
  RS: 4,
  RW: 5,
  E: 6,
  DB: [7, 8, 9, 10, 11, 12, 13, 14], // DB0…DB7
  A: 15, // backlight anode / cathode
  K: 16,
};

// ROM and RAM share ONE pin map (`MEM28`) because the AT28C256 and the 62256
// are pin-for-pin identical — the reason a real board takes either in the same
// socket, and worth seeing stated once rather than typed twice.
export const MEM28 = {
  A: [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1], // A0…A14
  DQ: [11, 12, 13, 15, 16, 17, 18, 19], // DQ0…DQ7
  CE: 20,
  OE: 22,
  WE: 27,
  VCC: 28,
  GND: 14,
};
