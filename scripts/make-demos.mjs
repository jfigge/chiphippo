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

// make-demos.mjs — generate the loadable demo schematics in demos/. Building a
// multi-chip breadboard computer by hand is error-prone, so this computes every
// hole address from the model, wires the buses, and then SELF-VALIDATES each demo
// by running it through the real simulation engine (asserting the LED actually
// blinks) before writing the .chiphippo file. Runs under plain Node.
//
//   node scripts/make-demos.mjs        (or `make demos`)

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  normalizeDocument,
  DOC_VERSION,
} from "../src/web/scripts/model/desk-doc.js";
import {
  partPinHoles,
  worldOfAddress,
} from "../src/web/scripts/model/occupancy.js";
import {
  nodeOf,
  holesOfNode,
  spec,
} from "../src/web/scripts/model/breadboard.js";
import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { tick } from "../src/web/scripts/sim/engine.js";
import { partPinAddresses } from "../src/web/scripts/model/occupancy.js";
import { emitIntelHex } from "../src/web/scripts/model/hex-format.js";

const H = "H";
const L = "L";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "demos");

/** The desk's own quantum for a board coordinate (desk-doc.js `boardCoord`, and
    demo-bench.mjs's `q`). A strip's measured height is fractional, so a stack
    that does not round the same way its loader does is a stack that overlaps —
    and `normalizeDocument` DROPS a board overlapping one already loaded. */
const q = (n) => Math.round(n * 100) / 100;

// ── A tiny doc builder: places boards/parts and wires nodes, tracking one lead
//    per hole so wire endpoints never collide (the loader would drop them). ────
function builder() {
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
const at = (label) => ({ abs: label });
const rel = (label) => ({ rel: label });

function asm(org, items) {
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
const asciiz = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);

// ── The 65xx blink computer ──────────────────────────────────────────────────
// W65C02 + 8K ROM (high half, $8000–$FFFF) + W65C22 VIA (low half, $0000–$7FFF)
// split by a single 74LS04 inverter on A15; PB0 → resistor → LED → GND. A tiny
// stack-free program toggles PB0 in a loop, so the LED blinks. Each chip sits on
// its own pin-board (no packing) with shared power rails; buses are wired
// pin-to-pin. The program lives in the ROM's .bin — ship the .hex and Import it.

// CPU pins (see catalog/chips-io.js "W65C02").
const CPU = {
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
const ROM = {
  A: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25],
  Q: [9, 10, 11, 12, 13, 17, 18, 19],
  CE: 26,
  OE: 27,
  VCC: 28,
  GND: 14,
};
// VIA pins (W65C22).
const VIA = {
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
const INV = { A: 1, Y: 2, GND: 7, VCC: 14 };
// HD44780 character-LCD module — the same 16 pins whatever the panel size.
const LCD = {
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

const BLINK_PROGRAM = [
  0xa9,
  0xff, //        LDA #$FF
  0x8d,
  0x02,
  0x00, //  STA $0002   ; VIA DDRB = all outputs
  0xa9,
  0x01, //        LDA #$01
  0x8d,
  0x00,
  0x00, //  STA $0000   ; VIA ORB  = A  (PB0 → LED)  [loop target $8007]
  0x49,
  0x01, //        EOR #$01     ; toggle bit 0
  0x4c,
  0x07,
  0x80, //  JMP $8007
];

function buildBlink() {
  const b = builder();
  // One RUN of strips — rail · pins · rail · pins · rail — a pin-board per chip
  // with a shared rail between each pair, so every chip has power beside it.
  const st = b.stack(4);
  const [cpuB, romB, viaB, outB] = st.boards;

  b.brick("psu1", "psu", "psu", st.right + 6, 0, { volts: 5 });
  b.brick("clk1", "clock", "clock", st.right + 6, 12, { hz: 2 });

  b.part("c1", "chip", "W65C02", cpuB, "e3");
  b.part("c2", "chip", "rom-8k", romB, "e3");
  b.part("c3", "chip", "W65C22", viaB, "e3");
  b.part("c4", "chip", "74LS04", outB, "e3");
  b.part("c5", "discrete", "resistor", outB, "a30", { ohms: 330 });
  b.part("c6", "discrete", "led", outB, "a40", { color: "red" });

  const cpu = b.holesOfPart("W65C02", "e3");
  const rom = b.holesOfPart("rom-8k", "e3");
  const via = b.holesOfPart("W65C22", "e3");
  const inv = b.holesOfPart("74LS04", "e3");
  const res = b.holesOfPart("resistor", "a30", { ohms: 330 });
  const led = b.holesOfPart("led", "a40", { color: "red" });

  const cpuAt = (pin) => b.freeAt(cpuB, cpu.get(pin));
  const romAt = (pin) => b.freeAt(romB, rom.get(pin));
  const viaAt = (pin) => b.freeAt(viaB, via.get(pin));
  const invAt = (pin) => b.freeAt(outB, inv.get(pin));
  const resAt = (pin) => b.freeAt(outB, res.get(pin));
  const ledAt = (pin) => b.freeAt(outB, led.get(pin));

  // Power: the bricks tap the near rail; every chip reaches the rail beside it.
  b.wire("psu1.+", st.tap(0, "+"), "red");
  b.wire("psu1.-", st.tap(0, "-"), "black");
  b.wire("clk1.gnd", st.tap(12, "-"), "black");
  for (const [pinV, pinG, id, holes] of [
    [CPU.VCC, CPU.GND, cpuB, cpu],
    [ROM.VCC, ROM.GND, romB, rom],
    [VIA.VDD, VIA.VSS, viaB, via],
    [INV.VCC, INV.GND, outB, inv],
  ]) {
    st.tie(id, holes.get(pinV), "+");
    st.tie(id, holes.get(pinG), "-");
  }

  // Address bus: A0–A12 → ROM; A0–A3 → VIA RS0–RS3.
  for (let i = 0; i < 13; i++)
    b.wire(cpuAt(CPU.A[i]), romAt(ROM.A[i]), "green");
  for (let i = 0; i < 4; i++)
    b.wire(cpuAt(CPU.A[i]), viaAt(VIA.RS[i]), "green");

  // Data bus: CPU ↔ ROM ↔ VIA (all three share each Dk net via ROM Qk's node).
  for (let i = 0; i < 8; i++) {
    b.wire(cpuAt(CPU.D[i]), romAt(ROM.Q[i]), "blue");
    b.wire(romAt(ROM.Q[i]), viaAt(VIA.D[i]), "blue");
  }

  // Decode: /A15 from the inverter drives ROM /CE and VIA CS1; A15 → VIA CS2B.
  b.wire(cpuAt(CPU.A[15]), invAt(INV.A), "yellow"); // A15 → inverter in
  b.wire(cpuAt(CPU.A[15]), viaAt(VIA.CS2B), "yellow"); // A15 → VIA CS2B
  b.wire(invAt(INV.Y), romAt(ROM.CE), "orange"); // /A15 → ROM /CE
  b.wire(invAt(INV.Y), viaAt(VIA.CS1), "orange"); // /A15 → VIA CS1
  st.tie(romB, rom.get(ROM.OE), "-"); // ROM /OE tied low

  // Control: RWB, PHI2 (fanned CPU→VIA), and the active-low inputs tied high.
  b.wire(cpuAt(CPU.RWB), viaAt(VIA.RWB), "white");
  b.wire("clk1.out", cpuAt(CPU.PHI2), "purple");
  b.wire(cpuAt(CPU.PHI2), viaAt(VIA.PHI2), "purple");
  for (const pin of [CPU.RESB, CPU.BE, CPU.RDY, CPU.IRQB, CPU.NMIB, CPU.SOB]) {
    st.tie(cpuB, cpu.get(pin), "+");
  }
  st.tie(viaB, via.get(VIA.RESB), "+");

  // Output: PB0 → resistor → LED → GND (the resistor makes the LED read as lit).
  b.wire(viaAt(VIA.PB[0]), resAt(1), "white");
  b.wire(resAt(2), ledAt(1), "white"); // resistor → LED anode
  st.tie(outB, led.get(2), "-"); // LED cathode → GND

  st.spine();
  // The address to probe for the blink (VIA PB0's hole).
  const pb0 = `${viaB}.${via.get(VIA.PB[0])}`;
  return { doc: b.doc(), pb0 };
}

// ── The 65xx "HELLO" LCD computer ────────────────────────────────────────────
// W65C02 + 8K ROM ($8000–$FFFF) + an HD44780 16×2 LCD mapped to low memory
// ($0000–$7FFF). A 74LS04 splits ROM (/A15) from the LCD; a 74LS08 makes the
// LCD strobe E = /A15 AND PHI2, so any write to low memory pulses E and latches
// a byte. RS = A0 (0 = instruction, 1 = data), RW = RWB. A stack-free program
// runs the init sequence and writes "HI". Program lives in the ROM's .bin.
const AND = { A: 1, B: 2, Y: 3, GND: 7, VCC: 14 }; // 74LS08 gate #1

const LCD_PROGRAM = [
  0xa9,
  0x38,
  0x8d,
  0x00,
  0x00, //  LDA #$38 / STA $0000  function set (8-bit, 2-line)
  0xa9,
  0x0c,
  0x8d,
  0x00,
  0x00, //  LDA #$0C / STA $0000  display on
  0xa9,
  0x01,
  0x8d,
  0x00,
  0x00, //  LDA #$01 / STA $0000  clear
  0xa9,
  0x06,
  0x8d,
  0x00,
  0x00, //  LDA #$06 / STA $0000  entry mode (increment)
  0xa9,
  0x48,
  0x8d,
  0x01,
  0x00, //  LDA #'H' / STA $0001  data
  0xa9,
  0x49,
  0x8d,
  0x01,
  0x00, //  LDA #'I' / STA $0001  data
  0x4c,
  0x1e,
  0x80, //              JMP $801E             done (self-loop)
];

function buildLcd() {
  const b = builder();
  // One run of strips, a rail between each pair of boards — except the last,
  // which the run leaves OPEN. A real 1602A carries its header along its TOP
  // edge, so its 14-unit body hangs DOWN off the row it plugs into: seated on
  // row a of the bottom board it overhangs the bench exactly as a real one
  // does, with its own wiring holes (rows b–e) above it and clear. A rail
  // dovetailed under it would be a strip nothing could see or reach, so the
  // run simply ends on the pin-board; the module's own supply leads then take
  // the rail ABOVE, which is the only one there is.
  const st = b.stack(4, { open: true });
  const [cpuB, romB, decB, lcdB] = st.boards;

  b.brick("psu1", "psu", "psu", st.right + 6, 0, { volts: 5 });
  b.brick("clk1", "clock", "clock", st.right + 6, 12, { hz: 5 });

  b.part("c1", "chip", "W65C02", cpuB, "e3");
  b.part("c2", "chip", "rom-8k", romB, "e3");
  b.part("c3", "chip", "74LS04", decB, "e3");
  b.part("c4", "chip", "74LS08", decB, "e20");
  b.part("c5", "discrete", "lcd16x2", lcdB, "a10");

  const cpu = b.holesOfPart("W65C02", "e3");
  const rom = b.holesOfPart("rom-8k", "e3");
  const inv = b.holesOfPart("74LS04", "e3");
  const and = b.holesOfPart("74LS08", "e20");
  const lcdPins = b.holesOfPart("lcd16x2", "a10");
  const cpuAt = (pin) => b.freeAt(cpuB, cpu.get(pin));
  const romAt = (pin) => b.freeAt(romB, rom.get(pin));
  const invAt = (pin) => b.freeAt(decB, inv.get(pin));
  const andAt = (pin) => b.freeAt(decB, and.get(pin));
  const lcdAt = (pin) => b.freeAt(lcdB, lcdPins.get(pin));

  // Power: the bricks tap the near rail; every part reaches the rail beside it.
  b.wire("psu1.+", st.tap(0, "+"), "red");
  b.wire("psu1.-", st.tap(0, "-"), "black");
  b.wire("clk1.gnd", st.tap(12, "-"), "black");
  for (const [pinV, pinG, id, holes] of [
    [CPU.VCC, CPU.GND, cpuB, cpu],
    [ROM.VCC, ROM.GND, romB, rom],
    [INV.VCC, INV.GND, decB, inv],
    [AND.VCC, AND.GND, decB, and],
  ]) {
    st.tie(id, holes.get(pinV), "+");
    st.tie(id, holes.get(pinG), "-");
  }
  st.tie(lcdB, lcdPins.get(LCD.VDD), "+");
  st.tie(lcdB, lcdPins.get(LCD.VSS), "-");

  // Address: A0–A12 → ROM; A0 → LCD RS.
  for (let i = 0; i < 13; i++)
    b.wire(cpuAt(CPU.A[i]), romAt(ROM.A[i]), "green");
  b.wire(cpuAt(CPU.A[0]), lcdAt(LCD.RS), "green");

  // Data bus: CPU ↔ ROM ↔ LCD DB0–DB7.
  for (let i = 0; i < 8; i++) {
    b.wire(cpuAt(CPU.D[i]), romAt(ROM.Q[i]), "blue");
    b.wire(romAt(ROM.Q[i]), lcdAt(LCD.DB[i]), "blue");
  }

  // Decode: /A15 → ROM /CE and one AND input; PHI2 → the other AND input;
  // E = /A15 AND PHI2 → LCD E. RW = RWB.
  b.wire(cpuAt(CPU.A[15]), invAt(INV.A), "yellow");
  b.wire(invAt(INV.Y), romAt(ROM.CE), "orange");
  b.wire(invAt(INV.Y), andAt(AND.A), "orange");
  st.tie(romB, rom.get(ROM.OE), "-");
  b.wire("clk1.out", cpuAt(CPU.PHI2), "purple");
  b.wire(cpuAt(CPU.PHI2), andAt(AND.B), "purple");
  b.wire(andAt(AND.Y), lcdAt(LCD.E), "white");
  b.wire(cpuAt(CPU.RWB), lcdAt(LCD.RW), "white");

  // Active-low CPU control inputs tied high.
  for (const pin of [CPU.RESB, CPU.BE, CPU.RDY, CPU.IRQB, CPU.NMIB, CPU.SOB]) {
    st.tie(cpuB, cpu.get(pin), "+");
  }
  st.spine();
  return { doc: b.doc() };
}

// ── The Ben Eater 65C02 computer — the CPU + ROM + RAM core ──────────────────
// Step one of the machine in Ben Eater's schematic (PCB layout by Tim Sanders):
// W65C02 + AT28C256 EEPROM + 62256 SRAM, address-decoded by ONE 74xx00 quad
// NAND, exactly as he does it. The VIA, the LCD, the buttons and the 24 bus
// LEDs hang off this core and come next — none of them change a wire here.
//
//   $0000–$3FFF  RAM   (A15=0, A14=0)
//   $4000–$7FFF  VIA   (A15=0, A14=1 — decoded here, wired when the VIA lands)
//   $8000–$FFFF  ROM   (A15=1)
//
// The four NAND gates ARE the whole decoder:
//   G1  NAND(A15, A15) = /A15         → ROM /CE
//   G2  NAND(A14, A14) = /A14
//   G3  NAND(/A15, /A14)              → RAM /CE   (low iff A15=0 and A14=0)
//   G4  NAND(/A15,  A14)              → VIA /CS2B (low iff A15=0 and A14=1)
//
// ROM and RAM share ONE pin map (`MEM28`) because the AT28C256 and the 62256
// are pin-for-pin identical — the reason a real board takes either in the same
// socket, and worth seeing stated once rather than typed twice.
const MEM28 = {
  A: [10, 9, 8, 7, 6, 5, 4, 3, 25, 24, 21, 23, 2, 26, 1], // A0…A14
  DQ: [11, 12, 13, 15, 16, 17, 18, 19], // DQ0…DQ7
  CE: 20,
  OE: 22,
  WE: 27,
  VCC: 28,
  GND: 14,
};
// 74LS00 quad 2-input NAND, gate n = { A, B, Y }.
const NAND = [
  { A: 1, B: 2, Y: 3 },
  { A: 4, B: 5, Y: 6 },
  { A: 9, B: 10, Y: 8 },
  { A: 12, B: 13, Y: 11 },
];
const NAND_PWR = { GND: 7, VCC: 14 };

// Prove the core end to end: fetch from ROM, keep data in RAM, and — the whole
// reason RAM is here — run a SUBROUTINE, whose return address the CPU pushes
// onto a stack that lives in the RAM chip at $01FF.
//
//        LDX #$FF / TXS          ; stack pointer → $01FF
//        LDA #$00 / STA $0200    ; RAM counter := 0
//   loop JSR bump                ; push return address to RAM
//        LDA $0200 / CMP #$05
//        BNE loop
//        JMP *                   ; halt
//   bump INC $0200               ; read-modify-write in RAM
//        RTS                     ; pull return address back out of RAM
const CORE_PROGRAM = [
  0xa2, 0xff, 0x9a, 0xa9, 0x00, 0x8d, 0x00, 0x02, 0x20, 0x15, 0x80, 0xad, 0x00,
  0x02, 0xc9, 0x05, 0xd0, 0xf6, 0x4c, 0x12, 0x80, 0xee, 0x00, 0x02, 0x60,
];

/**
 * The core, as a stage rather than a finished document: it seats and wires the
 * CPU, ROM, RAM and decoder and hands back everything a later stage needs to
 * hang I/O off it (Feature-less staging — `eater-core` and `eater-io` are the
 * SAME machine, one with its peripherals and one without, so their shared half
 * is built once and can never drift apart).
 *
 * Boards bb1–bb5 are the core's; a stage that adds more continues from bb6.
 */
function eaterCore({ tieIrq = true } = {}) {
  const b = builder();
  // One run of strips, a shared rail between each pair of boards. A stage that
  // adds more calls `st.extend`, which grows the SAME run downward rather than
  // standing a second stack beside it.
  const st = b.stack(4);
  const [cpuB, romB, ramB, decB] = st.boards;

  b.brick("psu1", "psu", "psu", st.right + 6, 0, { volts: 5 });
  b.brick("clk1", "clock", "clock", st.right + 6, 12, { hz: 2 });

  b.part("c1", "chip", "W65C02", cpuB, "e3");
  b.part("c2", "chip", "AT28C256", romB, "e3");
  b.part("c3", "chip", "HM62256", ramB, "e3");
  b.part("c4", "chip", "74LS00", decB, "e3");

  const cpu = b.holesOfPart("W65C02", "e3");
  const rom = b.holesOfPart("AT28C256", "e3");
  const ram = b.holesOfPart("HM62256", "e3");
  const dec = b.holesOfPart("74LS00", "e3");
  const cpuAt = (pin) => b.freeAt(cpuB, cpu.get(pin));
  const romAt = (pin) => b.freeAt(romB, rom.get(pin));
  const ramAt = (pin) => b.freeAt(ramB, ram.get(pin));
  const decAt = (pin) => b.freeAt(decB, dec.get(pin));

  // Power: the bricks tap the near rail; every chip reaches the rail beside it.
  b.wire("psu1.+", st.tap(0, "+"), "red");
  b.wire("psu1.-", st.tap(0, "-"), "black");
  b.wire("clk1.gnd", st.tap(12, "-"), "black");
  for (const [pinV, pinG, id, holes] of [
    [CPU.VCC, CPU.GND, cpuB, cpu],
    [MEM28.VCC, MEM28.GND, romB, rom],
    [MEM28.VCC, MEM28.GND, ramB, ram],
    [NAND_PWR.VCC, NAND_PWR.GND, decB, dec],
  ]) {
    st.tie(id, holes.get(pinV), "+");
    st.tie(id, holes.get(pinG), "-");
  }

  // Address bus: A0–A14 to BOTH memories (A15 is decode only, never addressing).
  for (let i = 0; i < 15; i++) {
    b.wire(cpuAt(CPU.A[i]), romAt(MEM28.A[i]), "green");
    b.wire(cpuAt(CPU.A[i]), ramAt(MEM28.A[i]), "green");
  }

  // Data bus: CPU ↔ ROM ↔ RAM. Only ever one driver — the decode below makes
  // ROM and RAM mutually exclusive, and a written RAM floats its own outputs.
  for (let i = 0; i < 8; i++) {
    b.wire(cpuAt(CPU.D[i]), romAt(MEM28.DQ[i]), "blue");
    b.wire(romAt(MEM28.DQ[i]), ramAt(MEM28.DQ[i]), "blue");
  }

  // Decode — one 74LS00, four gates (see the map above).
  b.wire(cpuAt(CPU.A[15]), decAt(NAND[0].A), "yellow"); // G1: A15 → /A15
  b.wire(decAt(NAND[0].A), decAt(NAND[0].B), "yellow");
  b.wire(cpuAt(CPU.A[14]), decAt(NAND[1].A), "yellow"); // G2: A14 → /A14
  b.wire(decAt(NAND[1].A), decAt(NAND[1].B), "yellow");
  b.wire(decAt(NAND[0].Y), decAt(NAND[2].A), "orange"); // G3: /A15 · /A14
  b.wire(decAt(NAND[1].Y), decAt(NAND[2].B), "orange");
  b.wire(decAt(NAND[0].Y), decAt(NAND[3].A), "orange"); // G4: /A15 · A14
  // G4's second input jumpers A14 across from G2's, on the decoder's own board,
  // rather than reaching back for a fifth hole on the CPU's A14 node — a bus is
  // tapped once and daisy-chained from there, on a real board and here.
  b.wire(decAt(NAND[1].A), decAt(NAND[3].B), "orange");
  // G4's output is the VIA select and stays spare until the VIA arrives.

  b.wire(decAt(NAND[0].Y), romAt(MEM28.CE), "orange"); // /A15 → ROM /CE
  b.wire(decAt(NAND[2].Y), ramAt(MEM28.CE), "orange"); // G3   → RAM /CE

  // Read/write strapping, as a real board straps it: both /OE tied low (a
  // deselected part floats on /CE alone, and a RAM mid-write floats on /WE), the
  // EEPROM's /WE tied high because the CIRCUIT never programs it, and the RAM's
  // /WE straight off the CPU's R/W̄.
  st.tie(romB, rom.get(MEM28.OE), "-");
  st.tie(romB, rom.get(MEM28.WE), "+");
  st.tie(ramB, ram.get(MEM28.OE), "-");
  b.wire(cpuAt(CPU.RWB), ramAt(MEM28.WE), "white");

  // Clock and the active-low control inputs tied high. IRQB is the one that
  // may NOT be hard-tied once a peripheral is present: the VIA's is open-drain,
  // so it has to be able to pull the line down against a WEAK hold — which is
  // what R1 on the schematic is. A stage adding one takes IRQB off this list
  // and pulls it up through a resistor instead.
  b.wire("clk1.out", cpuAt(CPU.PHI2), "purple");
  const held = tieIrq
    ? [CPU.RESB, CPU.BE, CPU.RDY, CPU.IRQB, CPU.NMIB, CPU.SOB]
    : [CPU.RESB, CPU.BE, CPU.RDY, CPU.NMIB, CPU.SOB];
  for (const pin of held) st.tie(cpuB, cpu.get(pin), "+");

  // The run is handed BACK rather than closed off with `spine()`: a stage that
  // extends it has to add its boards before the rails are tied, or the last
  // segment of the spine would stop where the core happened to end.
  return { b, st, cpuB, cpu, cpuAt, rom, romAt, ram, ramAt, dec, decAt };
}

/** Step one on its own: the core, with nothing hung off it. */
function buildEaterCore() {
  const { b, st } = eaterCore();
  st.spine();
  return { doc: b.doc() };
}

// ── Step two: the VIA, the LCD and the buttons ───────────────────────────────
// The core plus its I/O, which is where the machine stops being an exercise and
// starts being Ben Eater's computer: a W65C22 at $6000 driving a 16×2 HD44780
// off its two ports, and five buttons on PA0–PA4.
//
//   PB0–PB7  → LCD DB0–DB7      the data byte
//   PA7 → RS   PA6 → RW   PA5 → E    the strobe the program pulses by hand
//   PA0–PA4  ← SW1–SW5, each pulled up and shorted to GND when pressed
//
// The VIA's chip select is the decoder's SPARE gate finally used: G4 goes low
// for $4000–$7FFF, and CS1 takes A13, narrowing the part to $6000–$7FFF. Not a
// wire of the core changes — the promise step one made.
const VIA_PORTB = [0x00, 0x60]; // $6000  ORB/IRB
const VIA_PORTA = [0x01, 0x60]; // $6001  ORA/IRA
const VIA_DDRB = [0x02, 0x60]; // $6002
const VIA_DDRA = [0x03, 0x60]; // $6003
const LCD_E = 0x20; // PA5
const LCD_RS = 0x80; // PA7  (PA6 = RW, held low — we only ever write)
const BUTTONS = 0x1f; // PA0–PA4
const GREETING = "Hello, world!";

// Write A to the LCD: byte onto port B, then RS/RW/E on port A with E pulsed
// high and back down — the controller latches on E's FALLING edge.
const lcdWrite = (label, rs) => [
  label,
  0x8d,
  ...VIA_PORTB, //        STA PORTB
  0xa9,
  rs,
  0x8d,
  ...VIA_PORTA, // LDA #rs      / STA PORTA   E low
  0xa9,
  rs | LCD_E,
  0x8d,
  ...VIA_PORTA, // LDA #rs|E / STA PORTA   E high
  0xa9,
  rs,
  0x8d,
  ...VIA_PORTA, // LDA #rs      / STA PORTA   E low → latch
  0x60, //                      RTS
];

// This is an assembly LISTING, and Prettier would set it one byte per line —
// which turns a readable program into 200 lines of hex with the mnemonics
// scattered across them. The directive has to sit alone on its own line.
// prettier-ignore
const IO_PROGRAM = asm(0x8000, [
  // ── Bring the VIA up ──
  0xa2, 0xff,                    //  LDX #$FF
  0x9a,                          //  TXS            stack → $01FF, in the SRAM
  // PORT A FIRST, and the order is load-bearing rather than tidy. Out of reset
  // DDRA is 0, so PA5/PA6 float — and a floating TTL input reads HIGH, which to
  // the LCD is "RW=1, E=1": a read, so it drives the data bus. Bring port B up
  // first and the VIA starts driving those same eight lines against it (a real
  // conflict on DB5, which is how this was found). Setting DDRA first pulls RW
  // and E low, since ORA resets to 0, taking the LCD off the bus BEFORE
  // anything else gets on it — the same reason you claim a peripheral's control
  // lines before its data lines on real hardware.
  0xa9, 0xe0,                    //  LDA #$E0
  0x8d, ...VIA_DDRA,             //  STA DDRA       PA5–7 out; PA0–4 in (buttons)
  0xa9, 0xff,                    //  LDA #$FF
  0x8d, ...VIA_DDRB,             //  STA DDRB       PB0–7 out → the LCD data bus

  // ── HD44780 init: function set · display on · entry mode · clear ──
  0xa9, 0x38, 0x20, at("cmd"),   //  LDA #$38 / JSR cmd   8-bit, 2 lines, 5×8
  0xa9, 0x0c, 0x20, at("cmd"),   //  LDA #$0C / JSR cmd   display on, no cursor
  0xa9, 0x06, 0x20, at("cmd"),   //  LDA #$06 / JSR cmd   entry mode: increment
  0xa9, 0x01, 0x20, at("cmd"),   //  LDA #$01 / JSR cmd   clear

  // ── Print the greeting ──
  0xa2, 0x00,                    //  LDX #$00
  "print",
  0xbd, at("message"),           //  LDA message,X
  0xf0, rel("poll"),             //  BEQ poll       NUL terminator → done
  0x20, at("chr"),               //  JSR chr
  0xe8,                          //  INX
  0xd0, rel("print"),            //  BNE print

  // ── Then poll the buttons for ever ──
  "poll",
  0xad, ...VIA_PORTA,            //  LDA PORTA      IRA — PA0–4 read the buttons
  0x29, BUTTONS,                 //  AND #$1F
  0x49, BUTTONS,                 //  EOR #$1F       active-low → a 1 per press
  0x8d, 0x00, 0x02,              //  STA $0200      live button state, in RAM
  0xf0, rel("poll"),             //  BEQ poll       nothing down
  0xa2, 0x00,                    //  LDX #$00
  "scan",                        //                 find the lowest bit set
  0x4a,                          //  LSR A
  0xb0, rel("hit"),              //  BCS hit
  0xe8,                          //  INX
  0xd0, rel("scan"),             //  BNE scan       X is 1..4 here, never 0
  "hit",
  0x8a,                          //  TXA
  0x18,                          //  CLC
  0x69, 0x31,                    //  ADC #'1'       → '1'…'5'
  0x20, at("chr"),               //  JSR chr
  "wait",                        //                 hold until let go, so one
  0xad, ...VIA_PORTA,            //  LDA PORTA      press prints one digit
  0x29, BUTTONS,                 //  AND #$1F
  0x49, BUTTONS,                 //  EOR #$1F
  0xd0, rel("wait"),             //  BNE wait
  0x4c, at("poll"),              //  JMP poll

  // ── The two LCD writes: a command (RS=0) and a character (RS=1) ──
  ...lcdWrite("cmd", 0x00),
  ...lcdWrite("chr", LCD_RS),

  "message",
  ...asciiz(GREETING),
]);

function buildEaterIo() {
  // IRQB is pulled up rather than tied: the VIA's is open-drain (see eaterCore).
  const core = eaterCore({ tieIrq: false });
  const { b, st, cpuB, cpuAt, ramAt, decAt } = core;

  // The core's run grows DOWNWARD by three more boards — its own last rail
  // serves the first of them, so there is a rail between every pair the whole
  // way down and nothing has to reach for one five boards up. The run ends
  // open, on the LCD's board: see buildLcd for why a hanging module gets no
  // rail under it.
  const [viaB, btnB, lcdB] = st.extend(3, { open: true });

  b.part("c5", "chip", "W65C22", viaB, "e3");
  // R1 — the IRQ pull-up, on the CPU's own board beside it.
  b.part("c6", "discrete", "resistor", cpuB, "a30", { ohms: 3300 });
  // SW1–SW5 with their pull-ups (R6–R10). Per button: the resistor lies along
  // row a from the rail side into column `c+3`, and the button sits on row b of
  // that SAME column — one node, two holes — and shorts it to ground. So the
  // pin reads high through the resistor until a press pulls it hard low.
  const BTN_COLS = [3, 11, 19, 27, 35];
  BTN_COLS.forEach((c, i) => {
    b.part(`c${7 + i}`, "discrete", "resistor", btnB, `a${c}`, {
      ohms: 10000,
    });
    b.part(`c${12 + i}`, "discrete", "sw-push", btnB, `b${c + 3}`);
  });
  b.part("c17", "discrete", "lcd16x2", lcdB, "a10", { color: "green" });

  const via = b.holesOfPart("W65C22", "e3");
  const lcd = b.holesOfPart("lcd16x2", "a10");
  const viaAt = (pin) => b.freeAt(viaB, via.get(pin));
  const lcdAt = (pin) => b.freeAt(lcdB, lcd.get(pin));

  st.tie(viaB, via.get(VIA.VDD), "+");
  st.tie(viaB, via.get(VIA.VSS), "-");
  st.tie(viaB, via.get(VIA.RESB), "+");

  // R1: CPU IRQB ── R ── +5, with the VIA's open-drain IRQB on the same node.
  b.wire(cpuAt(CPU.IRQB), b.freeAt(cpuB, "a30"), "yellow");
  st.tie(cpuB, "a33", "+");
  b.wire(viaAt(VIA.IRQB), b.freeAt(cpuB, "a30"), "yellow");

  // The VIA on the bus: data carries on from the RAM (CPU → ROM → RAM → VIA),
  // RS0–RS3 take A0–A3, and the register select is the decoder's spare gate.
  for (let i = 0; i < 8; i++) {
    b.wire(ramAt(MEM28.DQ[i]), viaAt(VIA.D[i]), "blue");
  }
  for (let i = 0; i < 4; i++) {
    b.wire(cpuAt(CPU.A[i]), viaAt(VIA.RS[i]), "green");
  }
  b.wire(cpuAt(CPU.A[13]), viaAt(VIA.CS1), "yellow"); // A13 → $6000, not $4000
  b.wire(decAt(NAND[3].Y), viaAt(VIA.CS2B), "orange"); // G4 → /CS2
  b.wire(cpuAt(CPU.RWB), viaAt(VIA.RWB), "white");
  b.wire(cpuAt(CPU.PHI2), viaAt(VIA.PHI2), "purple");

  // Port B is the LCD's data bus; three of port A are its control lines.
  for (let i = 0; i < 8; i++) {
    b.wire(viaAt(VIA.PB[i]), lcdAt(LCD.DB[i]), "blue");
  }
  b.wire(viaAt(VIA.PA[7]), lcdAt(LCD.RS), "white");
  b.wire(viaAt(VIA.PA[6]), lcdAt(LCD.RW), "white");
  b.wire(viaAt(VIA.PA[5]), lcdAt(LCD.E), "white");
  st.tie(lcdB, lcd.get(LCD.VDD), "+");
  st.tie(lcdB, lcd.get(LCD.VSS), "-");
  // V0 is the contrast tap — a trimmer (RV1) on the schematic. There is no
  // analog here for a divider to divide, so it goes to ground: full contrast.
  st.tie(lcdB, lcd.get(LCD.V0), "-");
  st.tie(lcdB, lcd.get(LCD.A), "+"); // backlight
  st.tie(lcdB, lcd.get(LCD.K), "-");

  // The five buttons onto PA0–PA4.
  BTN_COLS.forEach((c, i) => {
    st.tie(btnB, `a${c}`, "+"); // pull-up to +5
    b.wire(b.freeAt(btnB, `a${c + 3}`), viaAt(VIA.PA[i]), "green");
    st.tie(btnB, `b${c + 5}`, "-"); // press → GND
  });

  st.spine();
  return { doc: b.doc() };
}

/**
 * Run the core and prove all three chips did their job: the CPU fetched from
 * ROM, counted in RAM, and pushed a return address onto a stack that is only
 * anywhere at all because the RAM chip is decoded and wired.
 */
function validateEaterCore(doc) {
  const netlist = buildNetlist(doc);
  const romImg = romImageWith(CORE_PROGRAM, 32768);
  const ramImg = new Uint8Array(32768);
  const images = new Map([
    ["c2", romImg],
    ["c3", ramImg],
  ]);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  for (let i = 0; i < 900; i++) {
    const r = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", i % 2 === 0 ? H : L]]),
      images,
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    // The engine REPORTS writes and never applies them — that is the renderer's
    // job, and its rule is followed here: a write lands in the volatile SRAM,
    // and one aimed at the non-volatile EEPROM is dropped on the floor.
    for (const w of r.memWrites) {
      if (w.compId === "c3") ramImg[w.addr] = w.value;
    }
  }
  const counter = ramImg[0x0200];
  if (counter !== 5) {
    throw new Error(
      `core: RAM $0200 should have counted to 5, got ${counter} — ` +
        `the CPU never ran, or RAM is mis-decoded`,
    );
  }
  // JSR at $8008 pushes the address of its last operand byte, $800A: high byte
  // to $01FF, low byte to $01FE. Finding it there proves the stack is REALLY in
  // the RAM chip (the CPU has no memory of its own to fake it with).
  if (ramImg[0x01ff] !== 0x80 || ramImg[0x01fe] !== 0x0a) {
    throw new Error(
      `core: expected the return address $800A on the stack at $01FE/$01FF, ` +
        `got $${ramImg[0x01ff].toString(16)}${ramImg[0x01fe].toString(16)}`,
    );
  }
}

/**
 * Run the whole machine and read the SCREEN. Twice, because the buttons are the
 * half a static document cannot state: a push button's pressed-ness is
 * transient runtime state (`sw-push` keeps nothing in params), so it arrives as
 * `buildNetlist`'s `partStates` — which is exactly how the app supplies it when
 * you hold one down.
 *
 * @param {object} doc
 * @param {string|null} pressId - a button component to hold down, or null.
 * @returns {{text: string, on: boolean}} the top line, trimmed of its padding.
 */
function runEaterIo(doc, pressId = null) {
  const states = pressId ? new Map([[pressId, { pressed: true }]]) : new Map();
  const netlist = buildNetlist(doc, states);
  const images = new Map([
    ["c2", romImageWith(IO_PROGRAM, 32768)],
    ["c3", new Uint8Array(32768)],
  ]);
  const ram = images.get("c3");
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  for (let i = 0; i < 1800; i++) {
    const r = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", i % 2 === 0 ? H : L]]),
      images,
      partStates: states,
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    for (const w of r.memWrites) if (w.compId === "c3") ram[w.addr] = w.value;
  }
  const lcd = state.get("c17");
  if (!lcd) throw new Error("eater-io: the LCD controller never ran");
  const text = String.fromCharCode(...lcd.ddram.subarray(0, 16)).replace(
    /\s+$/,
    "",
  );
  return { text, on: lcd.displayOn === true };
}

function validateEaterIo(doc) {
  // ① Untouched: the CPU brings the VIA up and prints through it.
  const idle = runEaterIo(doc);
  if (!idle.on || idle.text !== GREETING) {
    throw new Error(
      `eater-io: expected the display on showing "${GREETING}", got ` +
        `displayOn=${idle.on} text="${idle.text}"`,
    );
  }
  // ② Holding SW3 must print '3' — which proves the WHOLE input path in one
  //    character: the pull-up holds PA2 high, the press pulls it low against
  //    that pull, the VIA reads it back on IRA, and the program's bit scan
  //    turned the right one into the right digit. A wrong digit means the
  //    buttons are wired to the wrong port pins, which nothing else notices.
  const held = runEaterIo(doc, "c14"); // c12 + 2 = SW3 on PA2
  if (held.text !== `${GREETING}3`) {
    throw new Error(
      `eater-io: holding SW3 should have printed "${GREETING}3", ` +
        `got "${held.text}"`,
    );
  }
}

function validateLcd(doc) {
  const netlist = buildNetlist(doc);
  const images = new Map([["c2", romImageWith(LCD_PROGRAM)]]);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  for (let i = 0; i < 600; i++) {
    const r = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: new Map([["clk1", i % 2 === 0 ? H : L]]),
      images,
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
  }
  const lcd = state.get("c5");
  if (!lcd) throw new Error("lcd: controller never ran");
  const text = String.fromCharCode(lcd.ddram[0], lcd.ddram[1]);
  if (!lcd.displayOn || text !== "HI") {
    throw new Error(
      `lcd: expected display on with "HI", got displayOn=${lcd.displayOn} text="${text}"`,
    );
  }
}

// ── Validation: run the demo through the engine and confirm the LED blinks ────
function romImageWith(program, size = 8192) {
  const img = new Uint8Array(size);
  img.set(program, 0x0000); // program at $8000 (ROM offset 0)
  // The reset vector is $FFFC, which lands at the ROM's last-but-four byte
  // whatever its size: an 8K part mirrored eight times through $8000–$FFFF
  // sees $1FFC, a 32K part covering it exactly sees $7FFC.
  img[size - 4] = 0x00; // reset vector low  → $8000
  img[size - 3] = 0x80; // reset vector high
  return img;
}

function validateBlink(doc, pb0) {
  const netlist = buildNetlist(doc);
  const net = netlist.netOfPoint.get(pb0);
  if (!net) throw new Error("blink: PB0 net not found — wiring is broken");
  // The LED (c6): anode = pin 1, cathode = pin 2 (unflipped). It LIGHTS when the
  // anode net is H and the cathode net is L, and is over-driven ("burnt") when
  // BOTH those levels are STRONG (a resistor keeps the anode a weak pull → lit).
  const ledComp = doc.components.find((c) => c.id === "c6");
  const ledPins = partPinAddresses(doc, ledComp);
  const anode = ledPins.find((p) => p.pin === 1).address;
  const cathode = ledPins.find((p) => p.pin === 2).address;
  const netAnode = netlist.netOfPoint.get(anode);
  const netCathode = netlist.netOfPoint.get(cathode);

  const images = new Map([["c2", romImageWith(BLINK_PROGRAM)]]);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  const seen = new Set();
  let litSeen = false;
  let offSeen = false;
  for (let i = 0; i < 400; i++) {
    const phase = new Map([["clk1", i % 2 === 0 ? H : L]]);
    const r = tick({
      document: doc,
      netlist,
      warmStart: warm,
      state,
      prevPinLevels: prev,
      clockPhase: phase,
      images,
    });
    warm = r.netLevels;
    state = r.state;
    prev = r.pinLevels;
    seen.add(r.netLevels.get(net));
    const conducting =
      r.netLevels.get(netAnode) === H && r.netLevels.get(netCathode) === L;
    const unlimited =
      r.strongLevels.get(netAnode) === H &&
      r.strongLevels.get(netCathode) === L;
    if (conducting && !unlimited) litSeen = true;
    if (!conducting) offSeen = true;
  }
  if (!(seen.has(H) && seen.has(L))) {
    throw new Error(
      `blink: PB0 never toggled (levels seen: ${[...seen].join(",")})`,
    );
  }
  if (!litSeen) throw new Error("blink: the LED never lit (over-driven?)");
  if (!offSeen) throw new Error("blink: the LED never turned off");
}

/** Assert the doc survives the loader with nothing dropped. */
function assertClean(doc, label) {
  const norm = normalizeDocument(doc);
  const drops = [
    ["boards", doc.boards.length, norm.boards.length],
    ["components", doc.components.length, norm.components.length],
    ["wires", doc.wires.length, norm.wires.length],
  ];
  for (const [what, before, after] of drops) {
    if (before !== after) {
      throw new Error(`${label}: loader dropped ${before - after} ${what}`);
    }
  }
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const blink = buildBlink();
  assertClean(blink.doc, "65xx-blink");
  validateBlink(blink.doc, blink.pb0);
  writeFileSync(
    join(OUT_DIR, "65xx-blink.chiphippo"),
    JSON.stringify(blink.doc, null, 2) + "\n",
  );
  // The .hex is the WHOLE ROM image — program AND the reset vector at $1FFC —
  // so importing it into the ROM reproduces exactly what was validated above.
  writeFileSync(
    join(OUT_DIR, "65xx-blink.hex"),
    emitIntelHex(romImageWith(BLINK_PROGRAM)) + "\n",
  );
  console.log(
    `demos: 65xx-blink.chiphippo (${blink.doc.components.length} parts, ` +
      `${blink.doc.wires.length} wires) + .hex — validated: LED blinks`,
  );

  const lcd = buildLcd();
  assertClean(lcd.doc, "65xx-lcd");
  validateLcd(lcd.doc);
  writeFileSync(
    join(OUT_DIR, "65xx-lcd.chiphippo"),
    JSON.stringify(lcd.doc, null, 2) + "\n",
  );
  writeFileSync(
    join(OUT_DIR, "65xx-lcd.hex"),
    emitIntelHex(romImageWith(LCD_PROGRAM)) + "\n",
  );
  console.log(
    `demos: 65xx-lcd.chiphippo (${lcd.doc.components.length} parts, ` +
      `${lcd.doc.wires.length} wires) + .hex — validated: LCD shows "HI"`,
  );

  const core = buildEaterCore();
  assertClean(core.doc, "eater-core");
  validateEaterCore(core.doc);
  writeFileSync(
    join(OUT_DIR, "eater-core.chiphippo"),
    JSON.stringify(core.doc, null, 2) + "\n",
  );
  writeFileSync(
    join(OUT_DIR, "eater-core.hex"),
    emitIntelHex(romImageWith(CORE_PROGRAM, 32768)) + "\n",
  );
  console.log(
    `demos: eater-core.chiphippo (${core.doc.components.length} parts, ` +
      `${core.doc.wires.length} wires) + .hex — validated: counts in RAM, ` +
      `JSR/RTS through a stack in RAM`,
  );

  const io = buildEaterIo();
  assertClean(io.doc, "eater-io");
  validateEaterIo(io.doc);
  writeFileSync(
    join(OUT_DIR, "eater-io.chiphippo"),
    JSON.stringify(io.doc, null, 2) + "\n",
  );
  writeFileSync(
    join(OUT_DIR, "eater-io.hex"),
    emitIntelHex(romImageWith(IO_PROGRAM, 32768)) + "\n",
  );
  console.log(
    `demos: eater-io.chiphippo (${io.doc.components.length} parts, ` +
      `${io.doc.wires.length} wires) + .hex — validated: LCD prints ` +
      `"${GREETING}", a held button prints its digit`,
  );
}

main();
