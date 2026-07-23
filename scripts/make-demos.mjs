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

import { normalizeDocument, DOC_VERSION } from "../src/web/scripts/model/desk-doc.js";
import { partPinHoles } from "../src/web/scripts/model/occupancy.js";
import { nodeOf, holesOfNode, formatAddress } from "../src/web/scripts/model/breadboard.js";
import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { tick } from "../src/web/scripts/sim/engine.js";
import { partPinAddresses } from "../src/web/scripts/model/occupancy.js";
import { emitIntelHex } from "../src/web/scripts/model/hex-format.js";

const H = "H";
const L = "L";
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "demos");

// ── A tiny doc builder: places boards/parts and wires nodes, tracking one lead
//    per hole so wire endpoints never collide (the loader would drop them). ────
function builder() {
  const boards = [];
  const components = [];
  const wires = [];
  const claimed = new Set(); // every occupied hole/terminal address
  const boardType = new Map();
  let wireSeq = 0;

  const board = (id, type, x, y) => {
    boards.push({ id, type, x, y, rot: 0, group: null });
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
    for (const { pin, hole } of partPinHoles(ref, anchor, params)) m.set(pin, hole);
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

  return {
    board,
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
      nextGroupId: 1,
      nextComponentId: components.length + 1,
      nextPsuId: 2,
      nextClockId: 2,
      nextWireId: wireSeq + 1,
      nextBusId: 1,
      nextAnnotationId: 1,
    }),
  };
}

// ── The 65xx blink computer ──────────────────────────────────────────────────
// W65C02 + 8K ROM (high half, $8000–$FFFF) + W65C22 VIA (low half, $0000–$7FFF)
// split by a single 74LS04 inverter on A15; PB0 → resistor → LED → GND. A tiny
// stack-free program toggles PB0 in a loop, so the LED blinks. Each chip sits on
// its own pin-board (no packing) with shared power rails; buses are wired
// pin-to-pin. The program lives in the ROM's .bin — ship the .hex and Import it.

// CPU pins (see catalog/chips-io.js "w65c02").
const CPU = {
  A: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25], // A0…A15
  D: [33, 32, 31, 30, 29, 28, 27, 26], // D0…D7
  RWB: 34, PHI2: 37, RESB: 40, BE: 36, RDY: 2, IRQB: 4, NMIB: 6, SOB: 38,
  VCC: 8, GND: 21,
};
// ROM pins (rom-8k): A0…A12, Q0…Q7, CE, OE, VCC, GND.
const ROM = {
  A: [1, 2, 3, 4, 5, 6, 7, 8, 21, 22, 23, 24, 25],
  Q: [9, 10, 11, 12, 13, 17, 18, 19],
  CE: 26, OE: 27, VCC: 28, GND: 14,
};
// VIA pins (w65c22).
const VIA = {
  RS: [38, 37, 36, 35], // RS0…RS3 ← A0…A3
  D: [33, 32, 31, 30, 29, 28, 27, 26], // D0…D7
  PB0: 10, RWB: 22, PHI2: 25, CS1: 24, CS2B: 23, RESB: 34, VDD: 20, VSS: 1,
};
// 74LS04 hex inverter — inverter #1: 1A=1 (in) → 1Y=2 (out); GND=7, VCC=14.
const INV = { A: 1, Y: 2, GND: 7, VCC: 14 };

const BLINK_PROGRAM = [
  0xa9, 0xff, //        LDA #$FF
  0x8d, 0x02, 0x00, //  STA $0002   ; VIA DDRB = all outputs
  0xa9, 0x01, //        LDA #$01
  0x8d, 0x00, 0x00, //  STA $0000   ; VIA ORB  = A  (PB0 → LED)  [loop target $8007]
  0x49, 0x01, //        EOR #$01     ; toggle bit 0
  0x4c, 0x07, 0x80, //  JMP $8007
];

function buildBlink() {
  const b = builder();
  // Boards: one shared rail strip (both + and − rails) + a pin-board per chip.
  b.board("bb1", "rail-full", 0, 0); // power rails
  b.board("bb2", "pins-full", 0, 4); // CPU
  b.board("bb3", "pins-full", 0, 20); // ROM
  b.board("bb4", "pins-full", 0, 36); // VIA
  b.board("bb5", "pins-full", 0, 52); // inverter + LED

  b.brick("psu1", "psu", "psu", 70, 0, { volts: 5 });
  b.brick("clk1", "clock", "clock", 70, 12, { hz: 2 });

  b.part("c1", "chip", "w65c02", "bb2", "e3");
  b.part("c2", "chip", "rom-8k", "bb3", "e3");
  b.part("c3", "chip", "w65c22", "bb4", "e3");
  b.part("c4", "chip", "74LS04", "bb5", "e3");
  b.part("c5", "discrete", "resistor", "bb5", "a30", { ohms: 330 });
  b.part("c6", "discrete", "led", "bb5", "a40", { color: "red" });

  const cpu = b.holesOfPart("w65c02", "e3");
  const rom = b.holesOfPart("rom-8k", "e3");
  const via = b.holesOfPart("w65c22", "e3");
  const inv = b.holesOfPart("74LS04", "e3");
  const res = b.holesOfPart("resistor", "a30", { ohms: 330 });
  const led = b.holesOfPart("led", "a40", { color: "red" });

  const cpuAt = (pin) => b.freeAt("bb2", cpu.get(pin));
  const romAt = (pin) => b.freeAt("bb3", rom.get(pin));
  const viaAt = (pin) => b.freeAt("bb4", via.get(pin));
  const invAt = (pin) => b.freeAt("bb5", inv.get(pin));
  const resAt = (pin) => b.freeAt("bb5", res.get(pin));
  const ledAt = (pin) => b.freeAt("bb5", led.get(pin));
  const plus = () => b.freeAt("bb1", "+1");
  const minus = () => b.freeAt("bb1", "-1");

  // Power: PSU → rails; every chip's VCC/GND → rails.
  b.wire("psu1.+", plus(), "red");
  b.wire("psu1.-", minus(), "black");
  b.wire("clk1.gnd", minus(), "black");
  for (const [pinV, pinG, id, holes] of [
    [CPU.VCC, CPU.GND, "bb2", cpu],
    [ROM.VCC, ROM.GND, "bb3", rom],
    [VIA.VDD, VIA.VSS, "bb4", via],
    [INV.VCC, INV.GND, "bb5", inv],
  ]) {
    b.wire(b.freeAt(id, holes.get(pinV)), plus(), "red");
    b.wire(b.freeAt(id, holes.get(pinG)), minus(), "black");
  }

  // Address bus: A0–A12 → ROM; A0–A3 → VIA RS0–RS3.
  for (let i = 0; i < 13; i++) b.wire(cpuAt(CPU.A[i]), romAt(ROM.A[i]), "green");
  for (let i = 0; i < 4; i++) b.wire(cpuAt(CPU.A[i]), viaAt(VIA.RS[i]), "green");

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
  b.wire(romAt(ROM.OE), minus(), "black"); // ROM /OE tied low

  // Control: RWB, PHI2 (fanned CPU→VIA), and the active-low inputs tied high.
  b.wire(cpuAt(CPU.RWB), viaAt(VIA.RWB), "white");
  b.wire("clk1.out", cpuAt(CPU.PHI2), "purple");
  b.wire(cpuAt(CPU.PHI2), viaAt(VIA.PHI2), "purple");
  for (const pin of [CPU.RESB, CPU.BE, CPU.RDY, CPU.IRQB, CPU.NMIB, CPU.SOB]) {
    b.wire(cpuAt(pin), plus(), "red");
  }
  b.wire(viaAt(VIA.RESB), plus(), "red");

  // Output: PB0 → resistor → LED → GND (the resistor makes the LED read as lit).
  b.wire(viaAt(VIA.PB0), resAt(1), "white");
  b.wire(resAt(2), ledAt(1), "white"); // resistor → LED anode
  b.wire(ledAt(2), minus(), "black"); // LED cathode → GND

  // The address to probe for the blink (VIA PB0's hole).
  const pb0 = `bb4.${via.get(VIA.PB0)}`;
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
  0xa9, 0x38, 0x8d, 0x00, 0x00, //  LDA #$38 / STA $0000  function set (8-bit, 2-line)
  0xa9, 0x0c, 0x8d, 0x00, 0x00, //  LDA #$0C / STA $0000  display on
  0xa9, 0x01, 0x8d, 0x00, 0x00, //  LDA #$01 / STA $0000  clear
  0xa9, 0x06, 0x8d, 0x00, 0x00, //  LDA #$06 / STA $0000  entry mode (increment)
  0xa9, 0x48, 0x8d, 0x01, 0x00, //  LDA #'H' / STA $0001  data
  0xa9, 0x49, 0x8d, 0x01, 0x00, //  LDA #'I' / STA $0001  data
  0x4c, 0x1e, 0x80, //              JMP $801E             done (self-loop)
];

function buildLcd() {
  const b = builder();
  b.board("bb1", "rail-full", 0, 0);
  b.board("bb2", "pins-full", 0, 4); // CPU
  b.board("bb3", "pins-full", 0, 20); // ROM
  b.board("bb4", "pins-full", 0, 36); // 74LS04 + 74LS08 decode

  b.brick("psu1", "psu", "psu", 70, 0, { volts: 5 });
  b.brick("clk1", "clock", "clock", 70, 12, { hz: 5 });
  b.brick("lcd1", "lcd", "lcd", 34, 40, { size: "16x2" });

  b.part("c1", "chip", "w65c02", "bb2", "e3");
  b.part("c2", "chip", "rom-8k", "bb3", "e3");
  b.part("c3", "chip", "74LS04", "bb4", "e3");
  b.part("c4", "chip", "74LS08", "bb4", "e20");

  const cpu = b.holesOfPart("w65c02", "e3");
  const rom = b.holesOfPart("rom-8k", "e3");
  const inv = b.holesOfPart("74LS04", "e3");
  const and = b.holesOfPart("74LS08", "e20");
  const cpuAt = (pin) => b.freeAt("bb2", cpu.get(pin));
  const romAt = (pin) => b.freeAt("bb3", rom.get(pin));
  const invAt = (pin) => b.freeAt("bb4", inv.get(pin));
  const andAt = (pin) => b.freeAt("bb4", and.get(pin));
  const plus = () => b.freeAt("bb1", "+1");
  const minus = () => b.freeAt("bb1", "-1");
  const lcd = (t) => formatAddress("lcd1", t);

  // Power.
  b.wire("psu1.+", plus(), "red");
  b.wire("psu1.-", minus(), "black");
  b.wire("clk1.gnd", minus(), "black");
  for (const [pinV, pinG, id, holes] of [
    [CPU.VCC, CPU.GND, "bb2", cpu],
    [ROM.VCC, ROM.GND, "bb3", rom],
    [INV.VCC, INV.GND, "bb4", inv],
    [AND.VCC, AND.GND, "bb4", and],
  ]) {
    b.wire(b.freeAt(id, holes.get(pinV)), plus(), "red");
    b.wire(b.freeAt(id, holes.get(pinG)), minus(), "black");
  }
  b.wire(lcd("VDD"), plus(), "red");
  b.wire(lcd("VSS"), minus(), "black");

  // Address: A0–A12 → ROM; A0 → LCD RS.
  for (let i = 0; i < 13; i++) b.wire(cpuAt(CPU.A[i]), romAt(ROM.A[i]), "green");
  b.wire(cpuAt(CPU.A[0]), lcd("RS"), "green");

  // Data bus: CPU ↔ ROM ↔ LCD DB0–DB7.
  for (let i = 0; i < 8; i++) {
    b.wire(cpuAt(CPU.D[i]), romAt(ROM.Q[i]), "blue");
    b.wire(romAt(ROM.Q[i]), lcd(`DB${i}`), "blue");
  }

  // Decode: /A15 → ROM /CE and one AND input; PHI2 → the other AND input;
  // E = /A15 AND PHI2 → LCD E. RW = RWB.
  b.wire(cpuAt(CPU.A[15]), invAt(INV.A), "yellow");
  b.wire(invAt(INV.Y), romAt(ROM.CE), "orange");
  b.wire(invAt(INV.Y), andAt(AND.A), "orange");
  b.wire(romAt(ROM.OE), minus(), "black");
  b.wire("clk1.out", cpuAt(CPU.PHI2), "purple");
  b.wire(cpuAt(CPU.PHI2), andAt(AND.B), "purple");
  b.wire(andAt(AND.Y), lcd("E"), "white");
  b.wire(cpuAt(CPU.RWB), lcd("RW"), "white");

  // Active-low CPU control inputs tied high.
  for (const pin of [CPU.RESB, CPU.BE, CPU.RDY, CPU.IRQB, CPU.NMIB, CPU.SOB]) {
    b.wire(cpuAt(pin), plus(), "red");
  }
  return { doc: b.doc() };
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
  const lcd = state.get("lcd1");
  if (!lcd) throw new Error("lcd: controller never ran");
  const text = String.fromCharCode(lcd.ddram[0], lcd.ddram[1]);
  if (!lcd.displayOn || text !== "HI") {
    throw new Error(
      `lcd: expected display on with "HI", got displayOn=${lcd.displayOn} text="${text}"`,
    );
  }
}

// ── Validation: run the demo through the engine and confirm the LED blinks ────
function romImageWith(program) {
  const img = new Uint8Array(8192);
  img.set(program, 0x0000); // program at $8000 (ROM offset 0)
  img[0x1ffc] = 0x00; // reset vector low  → $8000
  img[0x1ffd] = 0x80; // reset vector high
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
      r.strongLevels.get(netAnode) === H && r.strongLevels.get(netCathode) === L;
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
}

main();
