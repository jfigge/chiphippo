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

// demo-computers.mjs — the CPUs' bundled example circuits: a small breadboard
// computer per processor that prints "Hello World" on a character LCD, one
// letter at a time, the moment you press Run.
//
//   W65C02  CPU + AT28C256 ROM ($8000–$FFFF) + W65C22 VIA ($0000–$7FFF),
//           decoded by one 74LS04 on A15
//   Z80A    CPU + AT28C256 ROM ($0000–$7FFF) + W65C22 VIA on the Z80's own
//           I/O space (/IORQ selects it, OUT (n),A writes it) — no glue
//
// Both drive the SAME LCD the same way, off the VIA's ports: PB0–PB7 are the
// data byte, PA7 is RS and PA5 is E, which the program pulses by hand (the
// controller latches on E's falling edge). R/W is strapped low — the program
// only ever writes — and E is pulled down, so the LCD sees no strobe while the
// VIA's ports are still inputs out of reset. A reset button (a 10 kΩ pull-up
// and a push button to ground) holds the CPU and the VIA in reset, so letting
// go of it prints the greeting again.
//
// THE PROGRAM SHIPS IN THE ROM. Unlike demos/65xx-*, whose image is a separate
// .hex to import, an example has to arrive working, so its payload carries the
// ROM's bytes (`images`, guid → base64 — what main's reseatImages speaks) and
// the ROM is flagged `programmed`. Opening the example gives the chip a fresh
// guid and a backing file holding exactly those bytes.
//
// EVERY WIRE IS ROUTED by the desk's own auto-router (model/autoroute.js, the
// toolbar's Auto-route), so the example looks the way a tidy bench does. That
// is the slow step — a minute or two per machine — and so it runs here, in
// `make demos`, and never in the test suite: gate-demos.test.js holds the
// SHIPPED file to a fresh unrouted build by its netlist, which routing cannot
// change.
//
// Neither machine has RAM, so neither program may touch the stack: no JSR, no
// CALL, no interrupts — loops over two tables, and a delay loop in registers
// between letters so the greeting is typed rather than flashed.

import { createHash } from "node:crypto";

import { DeskDoc } from "../src/web/scripts/model/desk-doc.js";
import { partPinAddresses } from "../src/web/scripts/model/occupancy.js";
import { routeDesk, routePlan } from "../src/web/scripts/model/autoroute.js";
import { buildNetlist } from "../src/web/scripts/sim/netlist.js";
import { tick } from "../src/web/scripts/sim/engine.js";
import { H, L } from "../src/web/scripts/sim/levels.js";
import { partDef } from "../src/web/scripts/catalog/index.js";
import { chipBodyBox } from "../src/web/scripts/components/chip-view.js";
import { discreteBox } from "../src/web/scripts/components/discrete-view.js";
import {
  CPU,
  INV,
  LCD,
  MEM28,
  VIA,
  asciiz,
  asm,
  at,
  builder,
  rel,
} from "./demo-machine.mjs";

/** What the screen must say once the program has run. */
export const GREETING = "Hello World";

/** The VIA's port-A bits the program drives: E (PA5) and RS (PA7). */
const LCD_E = 0x20;
const LCD_RS = 0x80;
/** HD44780 set-up, in order: 8-bit bus, 2 lines, 5×8 · display on, no cursor
    · entry mode: increment · clear. NUL-terminated, so no command may be 0. */
const LCD_INIT = [0x38, 0x0c, 0x06, 0x01, 0x00];

/** The 74LS04's first inverter, and the Z80A's pins (catalog/chips-cpu.js). */
const Z80 = {
  A: [30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2, 3, 4, 5], // A0…A15
  D: [14, 15, 12, 8, 7, 9, 10, 13], // D0…D7
  CLK: 6,
  VCC: 11,
  GND: 29,
  INT: 16,
  NMI: 17,
  MREQ: 19,
  IORQ: 20,
  RD: 21,
  WR: 22,
  WAIT: 24,
  BUSRQ: 25,
  RESET: 26,
};

// ── The programs ─────────────────────────────────────────────────────────────
// Both are the same three steps, which is the point of having one of each:
// claim the VIA's ports (port A FIRST — see below), send the LCD its set-up
// commands, then type the greeting with a pause after every letter. They are
// assembly LISTINGS, which Prettier would set one byte per line.

// W65C02 — the VIA is zero-page ($0000–$7FFF mirrors it), so every access is
// a 3-cycle `STA zp`. A letter is 51 cycles: half a second at 100 Hz.
const W65_ORB = 0x00;
const W65_ORA = 0x01;
const W65_DDRB = 0x02;
const W65_DDRA = 0x03;
const W65_DELAY = 6; // × 5 cycles of DEY/BNE

// prettier-ignore
const W65C02_PROGRAM = asm(0x8000, [
  // Port A first: RS and E become outputs at 0 — E low, so the LCD is not
  // strobed by whatever port B does next.
  0xa9, LCD_RS | LCD_E,          //  LDA #$A0
  0x85, W65_DDRA,                //  STA DDRA       PA7 (RS), PA5 (E) out
  0xa9, 0xff,                    //  LDA #$FF
  0x85, W65_DDRB,                //  STA DDRB       PB0–7 out → LCD DB0–7

  // ── The LCD's set-up commands (RS = 0) ──
  0xa2, 0x00,                    //  LDX #0
  "init",
  0xbd, at("commands"),          //  LDA commands,X
  0xf0, rel("type"),             //  BEQ type       NUL → set-up done
  0x85, W65_ORB,                 //  STA ORB        the command byte
  0xa9, LCD_E,                   //  LDA #E
  0x85, W65_ORA,                 //  STA ORA        E high
  0xa9, 0x00,                    //  LDA #0
  0x85, W65_ORA,                 //  STA ORA        E low → latched
  0xe8,                          //  INX
  0xd0, rel("init"),             //  BNE init

  // ── The greeting (RS = 1), a letter at a time ──
  "type",
  0xa2, 0x00,                    //  LDX #0
  "letter",
  0xbd, at("greeting"),          //  LDA greeting,X
  0xf0, rel("done"),             //  BEQ done       NUL → finished
  0x85, W65_ORB,                 //  STA ORB        the character
  0xa9, LCD_RS,                  //  LDA #RS
  0x85, W65_ORA,                 //  STA ORA        RS high (set up before E)
  0xa9, LCD_RS | LCD_E,          //  LDA #RS|E
  0x85, W65_ORA,                 //  STA ORA        E high
  0xa9, LCD_RS,                  //  LDA #RS
  0x85, W65_ORA,                 //  STA ORA        E low → latched
  0xa0, W65_DELAY,               //  LDY #DELAY
  "pause",
  0x88,                          //  DEY
  0xd0, rel("pause"),            //  BNE pause
  0xe8,                          //  INX
  0xd0, rel("letter"),           //  BNE letter
  "done",
  0x4c, at("done"),              //  JMP done       nothing left to do

  "commands", ...LCD_INIT,
  "greeting", ...asciiz(GREETING),
]);

// Z80A — the VIA is an I/O device: OUT (n),A puts n on A0–A7, so the port
// number IS the register (RS0–RS3 ← A0–A3). A letter is 129 T-states: about
// half a second at 250 Hz.
const Z80_ORB = 0x00;
const Z80_ORA = 0x01;
const Z80_DDRB = 0x02;
const Z80_DDRA = 0x03;
const Z80_DELAY = 2; // DJNZ passes

// prettier-ignore
const Z80_PROGRAM = asm(0x0000, [
  0x3e, LCD_RS | LCD_E,          //  LD A,$A0
  0xd3, Z80_DDRA,                //  OUT (DDRA),A   PA7 (RS), PA5 (E) out
  0x3e, 0xff,                    //  LD A,$FF
  0xd3, Z80_DDRB,                //  OUT (DDRB),A   PB0–7 out → LCD DB0–7

  // ── The LCD's set-up commands (RS = 0) ──
  0x21, at("commands"),          //  LD HL,commands
  "init",
  0x7e,                          //  LD A,(HL)
  0xb7,                          //  OR A
  0x28, rel("type"),             //  JR Z,type      NUL → set-up done
  0xd3, Z80_ORB,                 //  OUT (ORB),A    the command byte
  0x3e, LCD_E,                   //  LD A,E
  0xd3, Z80_ORA,                 //  OUT (ORA),A    E high
  0xaf,                          //  XOR A
  0xd3, Z80_ORA,                 //  OUT (ORA),A    E low → latched
  0x23,                          //  INC HL
  0x18, rel("init"),             //  JR init

  // ── The greeting (RS = 1), a letter at a time ──
  "type",
  0x21, at("greeting"),          //  LD HL,greeting
  "letter",
  0x7e,                          //  LD A,(HL)
  0xb7,                          //  OR A
  0x28, rel("done"),             //  JR Z,done      NUL → finished
  0xd3, Z80_ORB,                 //  OUT (ORB),A    the character
  0x3e, LCD_RS,                  //  LD A,RS
  0xd3, Z80_ORA,                 //  OUT (ORA),A    RS high (set up before E)
  0x3e, LCD_RS | LCD_E,          //  LD A,RS|E
  0xd3, Z80_ORA,                 //  OUT (ORA),A    E high
  0x3e, LCD_RS,                  //  LD A,RS
  0xd3, Z80_ORA,                 //  OUT (ORA),A    E low → latched
  0x06, Z80_DELAY,               //  LD B,DELAY
  "pause",
  0x10, rel("pause"),            //  DJNZ pause
  0x23,                          //  INC HL
  0x18, rel("letter"),           //  JR letter
  "done",
  0x76,                          //  HALT           nothing left to do

  "commands", ...LCD_INIT,
  "greeting", ...asciiz(GREETING),
]);

/** The 32 KiB ROM image: the program at offset 0 (and, for the 6502, its
    reset vector at $FFFC — offset $7FFC of a ROM covering $8000–$FFFF). The
    rest is $FF, as an erased EEPROM reads. */
function romImage(program, resetVector = null) {
  const img = new Uint8Array(32768).fill(0xff);
  img.set(program, 0);
  if (resetVector != null) {
    img[0x7ffc] = resetVector & 0xff;
    img[0x7ffd] = resetVector >> 8;
  }
  return img;
}

// ── The machines ─────────────────────────────────────────────────────────────

/** The two examples, keyed by the CPU they belong to. `guid` is the ROM's
    backing-file id INSIDE the shipped payload only — opening the example
    reseats it onto a fresh one, so it never names a real file. */
export const COMPUTERS = Object.freeze({
  W65C02: Object.freeze({
    file: "hello-w65c02.chiphippo",
    hz: 100,
    guid: "c0de6502-0000-4000-8000-000000000001",
    caption: [
      "W65C02 — Hello World",
      "A W65C02 runs the program in the AT28C256 ROM ($8000–$FFFF); the W65C22 VIA ($0000–$7FFF) drives the LCD.",
      "The 74LS04 turns A15 into the ROM's chip enable. Press Run: the greeting is typed a letter every half second.",
      "Hold the reset button to stop the CPU; let go and it starts again from the reset vector at $FFFC.",
    ],
  }),
  Z80A: Object.freeze({
    file: "hello-z80a.chiphippo",
    hz: 250,
    guid: "c0de0080-0000-4000-8000-000000000001",
    caption: [
      "Z80A — Hello World",
      "A Z80A runs the program in the AT28C256 ROM ($0000–$7FFF); the W65C22 VIA sits in the Z80's I/O space.",
      "/IORQ selects the VIA and OUT (n),A writes register n. Press Run: the greeting is typed a letter every half second.",
      "Hold the reset button to stop the CPU; let go and it starts again from $0000.",
    ],
  }),
});

/**
 * The half both machines share, hung off a run whose last two boards are the
 * VIA's and the LCD's: the VIA on the bus side is the caller's; this seats the
 * LCD, wires it to the VIA's ports, and adds E's pull-down and the reset
 * button with its pull-up. Returns the reset node's hole for the CPU's reset
 * pin and the VIA's.
 */
function hangLcd(b, st, { cpuB, viaB, lcdB, viaAt, firstId }) {
  let n = firstId;
  const id = () => `c${n++}`;

  // The LCD: its header along row a, the module hanging down off the bench
  // (the run ends OPEN here — see make-demos.mjs buildLcd).
  const lcdId = id();
  b.part(lcdId, "discrete", "lcd16x2", lcdB, LCD_ANCHOR, { color: "green" });
  const lcd = b.holesOfPart("lcd16x2", LCD_ANCHOR);
  const lcdAt = (pin) => b.freeAt(lcdB, lcd.get(pin));

  // Reset: R (10 kΩ) along row a from a column tied to +5 into column r+3,
  // the button bridging r+3 to r+5 on row b, and r+5 tied to ground — the
  // eater-io button, on the CPU's board beside the CPU.
  const r = RESET_COL;
  b.part(id(), "discrete", "resistor", cpuB, `a${r}`, { ohms: 10000 });
  b.part(id(), "discrete", "sw-push", cpuB, `b${r + 3}`);
  st.tie(cpuB, `c${r}`, "+");
  st.tie(cpuB, `c${r + 5}`, "-");

  // E's pull-down: a 10 kΩ standing from row a of the VIA's PA5 column to the
  // ground line of the rail below. Out of reset the VIA's ports are inputs,
  // and a floating E would strobe the LCD with whatever the bus was doing.
  const pa5 = b.holesOfPart("W65C22", VIA_ANCHOR).get(VIA.PA[5]);
  const pullCol = Number(pa5.slice(1));
  const pull = bentToRail(b, viaB, `a${pullCol}`, "-", { ohms: 10000 });
  b.part(id(), "discrete", "resistor", viaB, `a${pullCol}`, pull);

  // Port B → the data bus; PA7 → RS; PA5 → E; R/W strapped to write.
  for (let i = 0; i < 8; i++) {
    b.wire(viaAt(VIA.PB[i]), lcdAt(LCD.DB[i]), "blue");
  }
  b.wire(viaAt(VIA.PA[7]), lcdAt(LCD.RS), "white");
  b.wire(viaAt(VIA.PA[5]), lcdAt(LCD.E), "white");
  st.tie(lcdB, lcd.get(LCD.RW), "-");
  st.tie(lcdB, lcd.get(LCD.VDD), "+");
  st.tie(lcdB, lcd.get(LCD.VSS), "-");
  // V0 is the contrast trimmer on a real board; to ground is full contrast.
  st.tie(lcdB, lcd.get(LCD.V0), "-");
  st.tie(lcdB, lcd.get(LCD.A), "+"); // backlight (its own 100 Ω is on-module)
  st.tie(lcdB, lcd.get(LCD.K), "-");

  return { lcdId, resetHole: () => b.freeAt(cpuB, `e${r + 3}`) };
}

/** Where everything sits, in columns. The 40- and 28-pin parts stand in from
    the left edge rather than against it, so the router has a way round
    BOTH ends of every chip; the 600-mil parts seat at their real width (pins
    in rows d and h). The LCD's DB0 lands under the VIA's PB0, so the data
    bus drops straight down. */
const CHIP_COL = 12;
const WIDE = `d${CHIP_COL}`;
const INV_ANCHOR = `e${CHIP_COL + 24}`;
const RESET_COL = CHIP_COL + 27;
const LCD_ANCHOR = `a${CHIP_COL + 3}`;
const VIA_ANCHOR = WIDE;

/**
 * A resistor standing on end from `hole` (row a) down onto one line of the
 * rail below — the bend that line is at, found by trying the two a rail's
 * lines can be (2.76 and 3.76 pitch, the strip's measured geometry) rather
 * than assuming which polarity is nearer.
 */
function bentToRail(b, boardId, hole, polarity, params) {
  for (const dy of [2.76, 3.76]) {
    const trial = { ...params, rot: 90, end: { dx: 0, dy } };
    const comp = {
      id: "probe",
      kind: "discrete",
      ref: "resistor",
      board: boardId,
      anchor: hole,
      params: trial,
    };
    const pins = partPinAddresses(b.doc(), comp) ?? [];
    const end = pins.find((p) => p.pin === 2)?.address ?? "";
    const point = end.split(".")[1] ?? "";
    if (point.startsWith(polarity) && !b.claimed.has(end)) {
      b.claimed.add(end);
      return trial;
    }
  }
  throw new Error(`no ${polarity} rail line below ${boardId}.${hole}`);
}

/**
 * The bricks every machine stands beside its run: 5 V and the clock. The
 * supply feeds the THIRD rail, the one between the VIA and the LCD, rather
 * than the top one: the backlight is the biggest draw on the bench, and fed
 * from the top its current crossed three spine wires, which Spice Lite's wire
 * resistance (spice/sag.js) put a millivolt under the rail. The clock feeds
 * the rail beside the CPU it drives.
 */
function bricks(b, st, hz) {
  const { boards } = b.doc();
  const railY = (i) => boards.find((bd) => bd.id === st.rails[i]).y;
  b.brick("psu1", "psu", "psu", st.right + 6, railY(2) - 2, { volts: 5 });
  // Where make-demos.mjs stands it relative to its rail: high enough that
  // its leads leave below the label rather than across it.
  b.brick("clk1", "clock", "clock", st.right + 6, railY(1) - 5.5, { hz });
  b.wire("psu1.+", st.tap(railY(2), "+"), "red");
  b.wire("psu1.-", st.tap(railY(2), "-"), "black");
  b.wire("clk1.vcc", st.tap(railY(1), "+"), "red");
  b.wire("clk1.gnd", st.tap(railY(1), "-"), "black");
}

/** The ROM with its program in it: a guid the payload's `images` keys, and
    the `programmed` flag that makes a save carry the bytes. */
const romParams = (guid) => ({
  storage: { guid, source: "Hello World example" },
  programmed: true,
});

function buildW65C02() {
  const spec = COMPUTERS.W65C02;
  const b = builder();
  const st = b.stack(4, { open: true });
  const [cpuB, romB, viaB, lcdB] = st.boards;
  bricks(b, st, spec.hz);

  b.part("c1", "chip", "W65C02", cpuB, WIDE);
  b.part("c2", "chip", "AT28C256", romB, WIDE, romParams(spec.guid));
  b.part("c3", "chip", "74LS04", romB, INV_ANCHOR);
  b.part("c4", "chip", "W65C22", viaB, VIA_ANCHOR);

  const cpu = b.holesOfPart("W65C02", WIDE);
  const rom = b.holesOfPart("AT28C256", WIDE);
  const inv = b.holesOfPart("74LS04", INV_ANCHOR);
  const via = b.holesOfPart("W65C22", VIA_ANCHOR);
  const cpuAt = (pin) => b.freeAt(cpuB, cpu.get(pin));
  const romAt = (pin) => b.freeAt(romB, rom.get(pin));
  const invAt = (pin) => b.freeAt(romB, inv.get(pin));
  const viaAt = (pin) => b.freeAt(viaB, via.get(pin));

  for (const [vcc, gnd, board, holes] of [
    [CPU.VCC, CPU.GND, cpuB, cpu],
    [MEM28.VCC, MEM28.GND, romB, rom],
    [INV.VCC, INV.GND, romB, inv],
    [VIA.VDD, VIA.VSS, viaB, via],
  ]) {
    st.tie(board, holes.get(vcc), "+");
    st.tie(board, holes.get(gnd), "-");
  }

  // Address: A0–A14 → the ROM, and A0–A3 on from the ROM to the VIA's
  // register select — a bus is tapped once and daisy-chained.
  for (let i = 0; i < 15; i++) {
    b.wire(cpuAt(CPU.A[i]), romAt(MEM28.A[i]), "green");
  }
  for (let i = 0; i < 4; i++) {
    b.wire(romAt(MEM28.A[i]), viaAt(VIA.RS[i]), "green");
  }
  // Data: CPU → ROM → VIA.
  for (let i = 0; i < 8; i++) {
    b.wire(cpuAt(CPU.D[i]), romAt(MEM28.DQ[i]), "blue");
    b.wire(romAt(MEM28.DQ[i]), viaAt(VIA.D[i]), "blue");
  }

  // Decode: A15 high is the ROM (its /CE is /A15, from the inverter); A15 low
  // is the VIA (/CS2B straight off A15, CS1 strapped high).
  b.wire(cpuAt(CPU.A[15]), invAt(INV.A), "yellow");
  b.wire(invAt(INV.Y), romAt(MEM28.CE), "orange");
  b.wire(invAt(INV.A), viaAt(VIA.CS2B), "yellow");
  st.tie(viaB, via.get(VIA.CS1), "+");
  // The EEPROM is only ever read: /OE low, /WE high.
  st.tie(romB, rom.get(MEM28.OE), "-");
  st.tie(romB, rom.get(MEM28.WE), "+");

  // Control: R/W̄ and PHI2 to the VIA; the clock into the CPU; the CPU's
  // other active-low inputs held high.
  b.wire(cpuAt(CPU.RWB), viaAt(VIA.RWB), "white");
  b.wire("clk1.out", cpuAt(CPU.PHI2), "purple");
  b.wire(cpuAt(CPU.PHI2), viaAt(VIA.PHI2), "purple");
  for (const pin of [CPU.BE, CPU.RDY, CPU.IRQB, CPU.NMIB, CPU.SOB]) {
    st.tie(cpuB, cpu.get(pin), "+");
  }

  const { lcdId, resetHole } = hangLcd(b, st, {
    cpuB,
    viaB,
    lcdB,
    viaAt,
    firstId: 5,
  });
  b.wire(cpuAt(CPU.RESB), resetHole(), "yellow");
  b.wire(viaAt(VIA.RESB), resetHole(), "yellow");

  st.spine();
  return {
    doc: b.doc(),
    romId: "c2",
    lcdId,
    image: romImage(W65C02_PROGRAM, 0x8000),
  };
}

function buildZ80A() {
  const spec = COMPUTERS.Z80A;
  const b = builder();
  const st = b.stack(4, { open: true });
  const [cpuB, romB, viaB, lcdB] = st.boards;
  bricks(b, st, spec.hz);

  b.part("c1", "chip", "Z80A", cpuB, WIDE);
  b.part("c2", "chip", "AT28C256", romB, WIDE, romParams(spec.guid));
  b.part("c3", "chip", "W65C22", viaB, VIA_ANCHOR);

  const cpu = b.holesOfPart("Z80A", WIDE);
  const rom = b.holesOfPart("AT28C256", WIDE);
  const via = b.holesOfPart("W65C22", VIA_ANCHOR);
  const cpuAt = (pin) => b.freeAt(cpuB, cpu.get(pin));
  const romAt = (pin) => b.freeAt(romB, rom.get(pin));
  const viaAt = (pin) => b.freeAt(viaB, via.get(pin));

  for (const [vcc, gnd, board, holes] of [
    [Z80.VCC, Z80.GND, cpuB, cpu],
    [MEM28.VCC, MEM28.GND, romB, rom],
    [VIA.VDD, VIA.VSS, viaB, via],
  ]) {
    st.tie(board, holes.get(vcc), "+");
    st.tie(board, holes.get(gnd), "-");
  }

  for (let i = 0; i < 15; i++) {
    b.wire(cpuAt(Z80.A[i]), romAt(MEM28.A[i]), "green");
  }
  for (let i = 0; i < 4; i++) {
    b.wire(romAt(MEM28.A[i]), viaAt(VIA.RS[i]), "green");
  }
  for (let i = 0; i < 8; i++) {
    b.wire(cpuAt(Z80.D[i]), romAt(MEM28.DQ[i]), "blue");
    b.wire(romAt(MEM28.DQ[i]), viaAt(VIA.D[i]), "blue");
  }

  // Decode, such as it is: the ROM is the low 32 K (/CE straight off A15)
  // and answers reads (/OE ← /RD); the VIA is the I/O space (/CS2B ← /IORQ,
  // CS1 strapped high), written when /WR is low (R/W̄ ← /WR). The Z80 keeps
  // memory and I/O apart by itself, which is why there is no glue chip.
  b.wire(cpuAt(Z80.A[15]), romAt(MEM28.CE), "yellow");
  b.wire(cpuAt(Z80.RD), romAt(MEM28.OE), "orange");
  st.tie(romB, rom.get(MEM28.WE), "+");
  b.wire(cpuAt(Z80.IORQ), viaAt(VIA.CS2B), "orange");
  st.tie(viaB, via.get(VIA.CS1), "+");
  b.wire(cpuAt(Z80.WR), viaAt(VIA.RWB), "white");

  // The clock runs the CPU and is the VIA's PHI2; every active-low input the
  // program does not use is held high.
  b.wire("clk1.out", cpuAt(Z80.CLK), "purple");
  b.wire(cpuAt(Z80.CLK), viaAt(VIA.PHI2), "purple");
  for (const pin of [Z80.INT, Z80.NMI, Z80.WAIT, Z80.BUSRQ]) {
    st.tie(cpuB, cpu.get(pin), "+");
  }

  const { lcdId, resetHole } = hangLcd(b, st, {
    cpuB,
    viaB,
    lcdB,
    viaAt,
    firstId: 4,
  });
  b.wire(cpuAt(Z80.RESET), resetHole(), "yellow");
  b.wire(viaAt(VIA.RESB), resetHole(), "yellow");

  st.spine();
  return {
    doc: b.doc(),
    romId: "c2",
    lcdId,
    image: romImage(Z80_PROGRAM),
  };
}

const BUILDERS = { W65C02: buildW65C02, Z80A: buildZ80A };

/** The caption: one label per line above the run, the heading in the desk's
    own colour and the rest muted (demo-bench.mjs `caption`'s convention). */
function addCaption(doc, lines) {
  const top = Math.min(...doc.boards.map((bd) => bd.y));
  doc.annotations = lines.map((text, i) => ({
    id: `an${i + 1}`,
    kind: "label",
    x: 0,
    y: top - 2 - (lines.length - i) * 1.8,
    text,
    ...(i === 0 ? {} : { color: "#808080" }),
  }));
  doc.nextAnnotationId = lines.length + 1;
  return doc;
}

/**
 * One machine, UNROUTED: every part seated and every wire's two ends — the
 * whole circuit, which is all a netlist sees. Fast, so it is what the tests
 * rebuild to hold the shipped file to.
 */
export function buildComputer(ref) {
  const spec = COMPUTERS[ref];
  const build = BUILDERS[ref];
  if (!spec || !build) throw new Error(`${ref}: no example computer`);
  const built = build();
  addCaption(built.doc, spec.caption);
  return { ref, title: partDef(ref).title, spec, ...built };
}

/** The view layer's part outlines, for the router — the same injection the
    desk makes (desk-controller.js `partBodyBox`), so a wire is kept off a
    part's real body, the LCD's overhang included. */
function partBodyBox(comp) {
  try {
    const def = partDef(comp.ref);
    if (!def) return null;
    if (def.rotatable && comp.params?.rot === 90) return null;
    if (comp.kind === "chip") {
      return def.package ? chipBodyBox(def.package, comp.anchor) : null;
    }
    return discreteBox(comp.ref, comp.params?.rot, comp.params);
  } catch {
    return null;
  }
}

/**
 * Route every wire with the desk's own auto-router and apply the plan the way
 * the toolbar does (`DeskDoc.applyRoutes`). Refuses a wire it could not place
 * — an example is meant to look built — and proves the circuit is unchanged.
 */
export function routeComputer(doc, label) {
  const desk = new DeskDoc(doc);
  const result = routeDesk(desk.toJSON(), { bodyBox: partBodyBox });
  if (result.skipped.length) {
    const what = result.skipped.map((s) => `${s.wireId}:${s.reason}`);
    throw new Error(`${label}: the router left wires alone (${what})`);
  }
  desk.applyRoutes(routePlan(result));
  const routed = desk.toJSON();
  if (netSignature(routed) !== netSignature(doc)) {
    throw new Error(`${label}: routing changed the circuit`);
  }
  return routed;
}

/** The circuit as a PARTITION: which connection points share a net, never
    what the nets happen to be numbered — two documents with the same one are
    the same circuit, however their wires are drawn. */
export function netSignature(doc) {
  const nets = new Map();
  for (const [point, net] of buildNetlist(doc).netOfPoint) {
    if (!nets.has(net)) nets.set(net, []);
    nets.get(net).push(point);
  }
  return [...nets.values()]
    .map((points) => points.sort().join(","))
    .sort()
    .join("|");
}

/**
 * Run a machine through the real engine and READ ITS SCREEN, one clock edge
 * at a time as the app does. Proves three things: every chip is powered and
 * none is in trouble; the screen ends up reading the greeting; and it got
 * there a letter at a time, at least a few hundred milliseconds of clock
 * apart — which is the whole of "slowly".
 *
 * @returns {string} what was proved.
 */
export function validateComputer({ doc, image, romId, lcdId, spec }, label) {
  const netlist = buildNetlist(doc);
  const images = new Map([[romId, image]]);
  let warm = new Map();
  let state = new Map();
  let prev = new Map();
  const shown = [];
  let text = "";
  const maxEdges = spec.hz * 2 * 20; // twenty seconds of clock
  for (let i = 0; i < maxEdges && text !== GREETING; i++) {
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
    for (const [id, { status }] of r.chipStatus) {
      if (status !== "ok") throw new Error(`${label}: ${id} is ${status}`);
    }
    if (r.warnings.length) {
      const said = r.warnings.map((w) => w.type).join(", ");
      throw new Error(`${label}: the engine warns (${said}) at edge ${i}`);
    }
    if (r.memWrites.length) {
      throw new Error(`${label}: the program wrote memory, but there is none`);
    }
    const lcd = state.get(lcdId);
    if (!lcd) continue;
    // Everything up to the cursor: the address counter is where the next
    // letter goes, so a typed space counts as typed.
    const now = String.fromCharCode(...lcd.ddram.subarray(0, lcd.ac & 0x3f));
    if (now !== text) {
      text = now;
      shown.push({ text, edge: i });
    }
  }
  const lcd = state.get(lcdId);
  if (text !== GREETING || !lcd?.displayOn) {
    throw new Error(
      `${label}: expected the display on reading "${GREETING}", got ` +
        `displayOn=${lcd?.displayOn} text="${text}"`,
    );
  }
  // A letter at a time: each step adds exactly one character, and no two
  // arrive closer than a quarter of a second of clock.
  const steps = shown.filter((s) => s.text.length > 0);
  const minGap = (spec.hz * 2) / 4;
  steps.forEach((s, k) => {
    if (s.text !== GREETING.slice(0, k + 1)) {
      throw new Error(`${label}: the screen jumped to "${s.text}"`);
    }
    if (k > 0 && s.edge - steps[k - 1].edge < minGap) {
      throw new Error(`${label}: "${s.text}" came too fast to watch`);
    }
  });
  const seconds = (steps.at(-1).edge / (spec.hz * 2)).toFixed(1);
  return `"${GREETING}" typed in ${seconds} s at ${spec.hz} Hz`;
}

/** An image as main's reseat reads one: base64. */
const base64 = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * The bundled example's payload (model/example-desktops.js reads it): the one
 * desktop, and the ROM's bytes keyed by the guid its params name.
 */
export function examplePayload(built, doc) {
  return {
    ref: built.ref,
    title: built.title,
    doc,
    images: { [built.spec.guid]: base64(built.image) },
  };
}

/**
 * The same machine as a PROJECT for demos/ (File ▸ Open…), in the v5 shape a
 * saved project takes: the desktop, plus its ROM's bytes as a content-
 * addressed blob (app/store/project-images.js), which the open hydrates.
 */
export function exampleProject(built, doc) {
  const key = `sha256-${createHash("sha256").update(built.image).digest("hex")}`;
  return {
    version: 5,
    name: `${built.ref} Hello World`,
    description: built.spec.caption[1],
    activeTab: "t1",
    nextIndex: 2,
    tabs: [{ id: "t1", name: `${built.ref} Hello World`, doc }],
    images: { [built.spec.guid]: { blob: key } },
    blobs: { [key]: base64(built.image) },
  };
}
